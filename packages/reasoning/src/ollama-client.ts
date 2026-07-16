import type { Logger } from '@oasis-echo/telemetry';
import { PERSONA_RULES, type DialogueState } from '@oasis-echo/types';
import { CircuitBreaker } from './circuit-breaker.js';
import { PiiRedactor } from './redaction.js';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';
import type { ToolRegistry } from './tools.js';

export type OllamaOpts = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
  redactor?: PiiRedactor;
  systemPrompt?: string;
  /**
   * Appended to the base system prompt. Used by the app server to
   * inject the catalogue of MCP tools so the model knows what's
   * available + the expected `<tool_call>` emission format.
   */
  systemPromptSuffix?: string;
  temperature?: number;
  /**
   * Optional tool registry. When provided, the reasoner detects
   * `<tool_call>...</tool_call>` blocks in the model's free-text output,
   * executes the tool via the registry, then makes a second model call
   * with the result fed back so the reply streams to TTS normally.
   */
  tools?: ToolRegistry;
  /**
   * Max recursion depth when the model emits back-to-back tool calls.
   * Default 3 — enough for a read-then-summarize flow without allowing
   * runaway loops.
   */
  maxToolRounds?: number;
};

const DEFAULT_SYSTEM = PERSONA_RULES;

/** Chars of prefix to inspect before deciding "is this a tool call?". */
const TOOL_SNIFF_CHARS = 40;
const TOOL_TAG_OPEN = '<tool_call>';
const TOOL_TAG_CLOSE = '</tool_call>';

/**
 * Streaming client for a local Ollama server (http://localhost:11434).
 * Implements the shared Reasoner interface so it slots into the
 * pipeline identically to the Anthropic client.
 *
 * Uses the /api/chat endpoint with stream=true. Runs redaction before
 * egress and rehydrates the tokens as they stream, same as the cloud
 * path. Guarded by a circuit breaker.
 */
export class OllamaReasoner implements Reasoner {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly redactor: PiiRedactor;
  private readonly systemPrompt: string;
  private readonly temperature: number;
  private readonly tools: ToolRegistry | undefined;
  private readonly maxToolRounds: number;
  private readonly breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 10_000 });

  constructor(opts: OllamaOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? process.env['OLLAMA_MODEL'] ?? 'gemma4:e4b';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.logger = opts.logger;
    this.redactor = opts.redactor ?? new PiiRedactor();
    const base = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.systemPrompt = opts.systemPromptSuffix
      ? `${base}\n\n${opts.systemPromptSuffix}`
      : base;
    this.temperature = opts.temperature ?? 0.6;
    this.tools = opts.tools;
    this.maxToolRounds = opts.maxToolRounds ?? 3;
  }

  get circuitStatus(): string {
    return this.breaker.status;
  }

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
    allowTools?: boolean;
    model?: string;
  }): AsyncIterable<ReasoningStreamEvent> {
    if (!this.breaker.canAttempt()) {
      throw new Error(`circuit ${this.breaker.status}: ollama unavailable`);
    }

    const { text: redactedUser, redactions } = this.redactor.redact(input.userText);
    const messages = this.buildMessages(input.state, redactedUser);

    yield* this.streamRound({
      messages,
      redactions,
      signal: input.signal,
      model: input.model,
      // Speculation pre-compute passes `allowTools: false` to skip
      // tool calls on partial text; everything else defaults to true
      // (i.e. tools are enabled whenever a registry is present).
      round: input.allowTools === false ? this.maxToolRounds : 0,
    });
  }

  /**
   * One Ollama `/api/chat` round. When `round < maxToolRounds` and a
   * tool registry is configured, sniffs the first `TOOL_SNIFF_CHARS` of
   * the response for a `<tool_call>...</tool_call>` block. If found,
   * executes the tool and recurses with the result appended to the
   * conversation. Otherwise streams tokens through to the caller.
   */
  private async *streamRound(ctx: {
    messages: ChatMessage[];
    redactions: Parameters<PiiRedactor['rehydrate']>[1];
    signal: AbortSignal | undefined;
    model: string | undefined;
    round: number;
  }): AsyncIterable<ReasoningStreamEvent> {
    const allowTool = !!this.tools && ctx.round < this.maxToolRounds;

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), this.timeoutMs);
    const signal = composeSignals(ctx.signal, timeoutCtl.signal);

    // Mode machine:
    //   sniffing      — buffering early chars to decide if this is a tool call
    //   buffering_tc  — collecting the rest of a confirmed tool-call block
    //   streaming     — passing tokens straight through to the consumer
    let mode: 'sniffing' | 'buffering_tc' | 'streaming' = 'sniffing';
    let buf = '';
    let outChars = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason: string | null = null;
    let toolCallText = '';
    // Ollama's native tool-call path. When the model supports it (and
    // gemma4 does), structured `tool_calls` come back in the stream
    // BEFORE any prose. We'll prefer this to the text-sniff fallback.
    let nativeToolCall: { name: string; arguments: Record<string, unknown> } | null = null;

    // Build the Ollama-format tools array. Only include tools that were
    // registered BEFORE this reasoner was created (stable per-session)
    // so we don't recompute it on every turn.
    const ollamaTools = allowTool ? buildOllamaTools(this.tools!) : undefined;

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ctx.model ?? this.model,
          messages: ctx.messages,
          stream: true,
          // Keep the reasoner model hot in VRAM for 30 minutes so
          // follow-up turns don't hit a cold-reload timeout.
          keep_alive: '30m',
          // Reasoning models (gemma4, qwen3) consume num_predict on
          // invisible chain-of-thought when `think` is enabled, which
          // makes the streamed response look empty. For voice replies
          // we just want the final content.
          think: false,
          options: {
            temperature: this.temperature,
            // Give the model room to produce 2-4 informative sentences
            // (~120 tokens) without hitting a premature length cap.
            num_predict: 400,
          },
          ...(ollamaTools ? { tools: ollamaTools } : {}),
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.body) throw new Error('ollama: missing response body');

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let raw = '';

      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal.aborted) break;
        raw += decoder.decode(value, { stream: true });
        // NDJSON: one JSON object per line.
        let nl: number;
        while ((nl = raw.indexOf('\n')) !== -1) {
          const line = raw.slice(0, nl).trim();
          raw = raw.slice(nl + 1);
          if (!line) continue;
          let parsed: OllamaChunk;
          try {
            parsed = JSON.parse(line) as OllamaChunk;
          } catch (err) {
            this.logger?.warn('ollama parse error', { line: line.slice(0, 120), error: String(err) });
            continue;
          }

          // Ollama emits structured tool_calls in a SINGLE chunk when
          // the model uses native function-calling. Prefer this over
          // any text content that might also be present.
          const calls = parsed.message?.tool_calls;
          if (calls && calls.length > 0 && !nativeToolCall) {
            const first = calls[0]!;
            const argRaw = first.function?.arguments;
            let args: Record<string, unknown> = {};
            if (typeof argRaw === 'string') {
              try { args = JSON.parse(argRaw) as Record<string, unknown>; } catch { /* ignore */ }
            } else if (argRaw && typeof argRaw === 'object') {
              args = argRaw as Record<string, unknown>;
            }
            nativeToolCall = { name: first.function?.name ?? '', arguments: args };
            // The same chunk may also carry an empty content — skip the
            // text handling below so we don't flush a bogus token.
            continue;
          }

          const delta = parsed.message?.content ?? '';
          if (delta) {
            outChars += delta.length;
            if (mode === 'sniffing') {
              buf += delta;
              const trimmed = buf.trimStart();
              if (allowTool && isToolCallPrefix(trimmed)) {
                mode = 'buffering_tc';
                toolCallText = trimmed;
              } else if (buf.length >= TOOL_SNIFF_CHARS) {
                // Commit to streaming mode — flush the buffer and
                // forward every subsequent delta as-is.
                mode = 'streaming';
                yield { type: 'token', text: this.redactor.rehydrate(buf, ctx.redactions) };
                buf = '';
              }
              // else: keep buffering silently until we have enough to decide
            } else if (mode === 'buffering_tc') {
              toolCallText += delta;
              if (toolCallText.includes(TOOL_TAG_CLOSE)) {
                // Stop reading — abort the upstream so we don't pay for
                // any trailing tokens the model emits after </tool_call>.
                try { reader.cancel().catch(() => undefined); } catch { /* ignore */ }
                break outer;
              }
            } else {
              yield { type: 'token', text: this.redactor.rehydrate(delta, ctx.redactions) };
            }
          }

          if (parsed.done) {
            doneReason = parsed.done_reason ?? 'stop';
            inputTokens = parsed.prompt_eval_count ?? 0;
            outputTokens = parsed.eval_count ?? Math.ceil(outChars / 4);
            this.breaker.recordSuccess();
            break outer;
          }
        }
      }
    } catch (err) {
      // A user-initiated barge-in surfaces as AbortError here — that's
      // not an ollama failure, so don't count it toward the breaker.
      const isAbort = ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) {
        this.breaker.recordFailure();
        this.logger?.error('ollama stream failed', { error: String(err) });
      } else {
        this.logger?.debug('ollama stream aborted', { reason: 'bargein-or-cancel' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Expose a snippet of the first-round model output so we can see
    // if the reasoner ignored the tool-call format (common with small
    // models) versus something else.
    if (ctx.round === 0) {
      const preview = (toolCallText || buf).replace(/\s+/g, ' ').slice(0, 120);
      this.logger?.info('ollama round-0 output', {
        mode,
        allowTool: !!this.tools,
        nativeToolCall: nativeToolCall?.name ?? null,
        preview,
      });
    }

    // Native Ollama tool call wins over everything else.
    if (nativeToolCall && this.tools) {
      yield* this.executeToolCall({
        call: nativeToolCall,
        priorAssistant: {
          role: 'assistant',
          content: '',
          tool_calls: [nativeToolCall],
        },
        ctx,
        native: true,
      });
      return;
    }

    // Stream ended. Decide what to do based on the mode we ended in.
    if (mode === 'buffering_tc' && this.tools) {
      const call = parseToolCall(toolCallText);
      if (call && this.tools.get(call.name)) {
        yield* this.executeToolCall({
          call,
          priorAssistant: { role: 'assistant', content: toolCallText },
          ctx,
          native: false,
        });
        return;
      }
      // Malformed text-format tool call. Do NOT emit the raw text to
      // TTS (speaking "<tool_call>…" aloud sounds broken). Instead
      // retry by re-invoking the model without the tool registry, so
      // it falls back to a plain natural-language answer.
      this.logger?.warn('ollama tool-call parse/lookup failed; retrying without tools', {
        parsed: call?.name ?? null,
        snippet: toolCallText.slice(0, 120),
      });
      const nextMessages: ChatMessage[] = [
        ...ctx.messages,
        { role: 'assistant', content: toolCallText },
        {
          role: 'user',
          content:
            'Your previous reply was malformed. Answer the user directly in 1-2 short sentences. ' +
            'Do not emit tool calls or JSON — speak plainly.',
        },
      ];
      // Recurse at max round so tool calling is suppressed (maxToolRounds check).
      yield* this.streamRound({
        messages: nextMessages,
        redactions: ctx.redactions,
        signal: ctx.signal,
        model: ctx.model,
        round: this.maxToolRounds,
      });
      return;
    } else if (mode === 'sniffing' && buf) {
      // Stream finished before we had enough to commit — flush buffer.
      yield { type: 'token', text: this.redactor.rehydrate(buf, ctx.redactions) };
    }

    yield {
      type: 'done',
      stopReason: doneReason ?? 'stream_end',
      inputTokens,
      outputTokens: outputTokens || Math.ceil(outChars / 4),
    };
  }

  /**
   * Run a tool call via the registry and recurse with its result fed
   * back into the conversation, so the next Ollama round can stream
   * a natural-language reply using the tool output as grounding.
   *
   * Shared by both the native `message.tool_calls` path and the
   * text-sniff `<tool_call>` fallback.
   */
  private async *executeToolCall(opts: {
    call: { name: string; arguments: Record<string, unknown> };
    priorAssistant: ChatMessage;
    ctx: {
      messages: ChatMessage[];
      redactions: Parameters<PiiRedactor['rehydrate']>[1];
      signal: AbortSignal | undefined;
      model: string | undefined;
      round: number;
    };
    /**
     * True when Ollama emitted the call via its native `tool_calls`
     * field, false when we parsed it from a free-text `<tool_call>`
     * block. Controls how the tool result is fed back — the native
     * path follows Ollama's proper role:tool/tool_name convention, the
     * fallback path pastes the result inline as a user message.
     */
    native: boolean;
  }): AsyncIterable<ReasoningStreamEvent> {
    const { call, priorAssistant, ctx, native } = opts;
    // Gemma (and some other Ollama models) occasionally call a tool by
    // its unqualified name (`web_search`) even though we registered it
    // namespaced (`oasis_cognition__web_search`). Fall back to a suffix
    // match so we still execute cleanly.
    let tool = this.tools?.get(call.name);
    let resolvedName = call.name;
    if (!tool && this.tools) {
      const match = this.tools
        .list()
        .find((t) => t.name === call.name
          || t.name.endsWith(`__${call.name}`)
          || t.name.split('__').pop() === call.name);
      if (match) {
        tool = match;
        resolvedName = match.name;
        this.logger?.info('ollama tool name resolved by suffix', {
          requested: call.name,
          resolved: resolvedName,
        });
      }
    }
    if (!tool) {
      this.logger?.warn('ollama tool not found', { name: call.name });
      return;
    }
    let output: unknown;
    try {
      output = await tool.handler(call.arguments);
      this.logger?.info('ollama tool executed', {
        round: ctx.round,
        name: resolvedName,
        ok: true,
      });
    } catch (err) {
      this.logger?.warn('ollama tool failed', {
        round: ctx.round,
        name: resolvedName,
        error: String(err),
      });
      output = { error: String(err) };
    }
    yield { type: 'tool_use', id: `${ctx.round}`, name: resolvedName, input: call.arguments };
    yield { type: 'tool_result', id: `${ctx.round}`, output };

    // Ollama's native path: an assistant message with the original
    // `tool_calls`, immediately followed by a `role:tool` message
    // carrying the result. No extra user message — tacking on a
    // synthetic user turn here seemed to trigger Gemma's safety-trained
    // "I don't have access to real-time data" refusal even when the
    // tool result contained the answer verbatim. Relying on Ollama's
    // native completion after role:tool lets the model treat the result
    // as ground truth.
    //
    // Text-sniff fallback path: Gemma invented its own `<tool_call>`
    // block so there's no structured call to reference. We inline the
    // result as a user message and prod the model to ground on it.
    const resultStr = safeStringify(output);
    const nextMessages: ChatMessage[] = native
      ? [
          ...ctx.messages,
          priorAssistant,
          {
            role: 'tool',
            tool_name: resolvedName,
            content: resultStr,
          },
        ]
      : [
          ...ctx.messages,
          priorAssistant,
          {
            role: 'user',
            content:
              `The tool \`${resolvedName}\` returned the following real-time result — ` +
              `TREAT IT AS GROUND TRUTH and ground your answer in it.\n\n` +
              `<tool_result>\n${resultStr}\n</tool_result>\n\n` +
              `Now answer my original question in 1-3 short sentences using the data above. ` +
              `Do NOT say "I don't have access to real-time data" — you just got it. ` +
              `Do NOT call another tool.`,
          },
        ];
    yield* this.streamRound({
      messages: nextMessages,
      redactions: ctx.redactions,
      signal: ctx.signal,
      model: ctx.model,
      round: ctx.round + 1,
    });
  }

  private buildMessages(
    state: DialogueState,
    userText: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.systemPrompt },
    ];
    if (state.summary.length > 0) {
      msgs.push({ role: 'system', content: `Conversation so far:\n${state.summary}` });
    }
    for (const turn of state.turns.slice(-6)) {
      msgs.push({ role: 'user', content: turn.userText });
      if (turn.agentText) msgs.push({ role: 'assistant', content: turn.agentText });
    }
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }
}

type OllamaToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

type OllamaChunk = {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Ollama-native: names the tool that produced the result. */
  tool_name?: string;
};

/**
 * Convert our internal ToolRegistry to the OpenAI-style function tool
 * array Ollama accepts. Only a minimal subset of JSON Schema makes it
 * through (type, properties, required) which is what Ollama checks.
 */
function buildOllamaTools(registry: ToolRegistry): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> {
  return registry.list().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Permissive "does the stream start with a tool call?" check.
 * Accepts the preferred `<tool_call>` tag plus two common
 * model-invented variants (back-ticked, upper-cased).
 */
function isToolCallPrefix(s: string): boolean {
  const low = s.toLowerCase();
  if (low.startsWith(TOOL_TAG_OPEN)) return true;
  if (low.startsWith('```tool_call') || low.startsWith('```tool')) return true;
  if (low.startsWith('tool_call:') || low.startsWith('tool_call ')) return true;
  return false;
}

/**
 * Extract `{name, arguments}` from a buffered string that we believe
 * contains a tool call. Handles the canonical tagged form first,
 * falls back to a best-effort regex that finds the innermost JSON
 * object — tolerant of models that forget the close tag.
 */
export function parseToolCall(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  // Strip any leading code-fence decorations.
  const stripped = raw
    .replace(/^```(?:tool_call|tool|json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^tool_call[:\s]*/i, '')
    .trim();

  // Canonical tagged form.
  const tagMatch = /<tool_call>([\s\S]*?)<\/tool_call>/i.exec(stripped);
  const body = tagMatch ? tagMatch[1]!.trim() : stripped;

  // Body should be a JSON object like {"name":"x","arguments":{...}}.
  const jsonMatch = /\{[\s\S]*\}/.exec(body);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { name?: string; arguments?: unknown; args?: unknown };
    const name = parsed.name;
    if (!name || typeof name !== 'string') return null;
    const args = (parsed.arguments ?? parsed.args ?? {}) as unknown;
    if (args && typeof args === 'object') {
      return { name, arguments: args as Record<string, unknown> };
    }
    return { name, arguments: {} };
  } catch {
    return null;
  }
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    // Cap at 2000 chars so huge tool outputs (e.g. whole page text) don't
    // explode the next round's prompt size.
    return (s ?? '').slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
}

function composeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
