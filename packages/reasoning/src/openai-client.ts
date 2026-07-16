import type { Logger } from '@oasis-echo/telemetry';
import { PERSONA_RULES, type DialogueState } from '@oasis-echo/types';
import { CircuitBreaker } from './circuit-breaker.js';
import { PiiRedactor } from './redaction.js';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';

export type OpenAIOpts = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
  redactor?: PiiRedactor;
  systemPrompt?: string;
  temperature?: number;
  assistantPrefill?: boolean;
};

const DEFAULT_SYSTEM = PERSONA_RULES;
const DEFAULT_REASONING_POLICY =
  'Reasoning policy: Do not output internal thinking, scratchpad, analysis logs, "Thought", "Thinking Process", "[Start thinking]", or similar hidden reasoning. ' +
  'By default, answer directly and only provide the final response. If the user explicitly asks for reasoning, include only a concise user-facing rationale in the final answer, not private chain-of-thought.';

/**
 * Streaming reasoner for OpenAI's Chat Completions API — and any
 * OpenAI-compatible endpoint (LM Studio, Together, OpenRouter, vLLM,
 * LocalAI, Groq, Fireworks, DeepSeek, Mistral, etc.).
 *
 * Config via env:
 *   OPENAI_API_KEY     required (use "none" for local servers that ignore auth)
 *   OPENAI_BASE_URL    defaults to https://api.openai.com/v1
 *   OPENAI_MODEL       defaults to gpt-4o-mini
 *
 * Same Reasoner interface as Anthropic/Ollama — PII redaction runs
 * before egress and is rehydrated as tokens stream back.
 */
export class OpenAIReasoner implements Reasoner {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly redactor: PiiRedactor;
  private readonly systemPrompt: string;
  private readonly temperature: number;
  private readonly assistantPrefill: boolean;
  private readonly breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 30_000 });

  constructor(opts: OpenAIOpts = {}) {
    const apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY missing');
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = opts.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger;
    this.redactor = opts.redactor ?? new PiiRedactor();
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.temperature = opts.temperature ?? 0.7;
    this.assistantPrefill = opts.assistantPrefill ?? shouldUseAssistantPrefill(this.baseUrl);
  }

  get circuitStatus(): string {
    return this.breaker.status;
  }

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
    model?: string;
  }): AsyncIterable<ReasoningStreamEvent> {
    if (!this.breaker.canAttempt()) {
      throw new Error(`circuit ${this.breaker.status}: openai unavailable`);
    }

    const { text: redactedUser, redactions } = this.redactor.redact(input.userText);
    const messages = this.buildMessages(input.state, redactedUser);
    const model = input.model ?? this.model;

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), this.timeoutMs);
    const signal = composeSignals(input.signal, timeoutCtl.signal);

    try {
      const fetchPromise = fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: this.temperature,
        }),
        signal,
      });
      let res: Response | null = null;
      for await (const event of waitWithHeartbeats(fetchPromise, signal)) {
        if (event.type === 'value') {
          res = event.value;
        } else {
          yield event;
        }
      }
      if (!res) throw new Error('openai: missing response');

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.body) throw new Error('openai: missing response body');

      let outChars = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        let completion: OpenAIChatCompletion | null = null;
        for await (const event of waitWithHeartbeats(res.json() as Promise<OpenAIChatCompletion>, signal)) {
          if (event.type === 'value') {
            completion = event.value;
          } else {
            yield event;
          }
        }
        if (!completion) throw new Error('openai: missing JSON completion');
        const rawMessage = completion.choices?.[0]?.message?.content ?? '';
        const message = shouldUseLocalConsoleFilter(this.baseUrl)
          ? stripLocalConsoleEcho(rawMessage)
          : rawMessage;
        if (message) {
          outChars += message.length;
          yield { type: 'token', text: this.redactor.rehydrate(message, redactions) };
        }
        const usage = completion.usage;
        this.breaker.recordSuccess();
        yield {
          type: 'done',
          stopReason: completion.choices?.[0]?.finish_reason ?? 'stop',
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? Math.ceil(outChars / 4),
        };
        return;
      }

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal.aborted) break;
        buf += decoder.decode(value, { stream: true });
        // SSE framing: lines starting with "data: "; events separated
        // by blank lines. Terminator is a "data: [DONE]" line.
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            this.breaker.recordSuccess();
            yield { type: 'done', stopReason: stopReason ?? 'stop', inputTokens, outputTokens: outputTokens || Math.ceil(outChars / 4) };
            return;
          }
          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(payload) as OpenAIStreamChunk;
          } catch (err) {
            this.logger?.warn('openai parse error', { line: payload.slice(0, 120), error: String(err) });
            continue;
          }
          const choice = parsed.choices?.[0];
          const reasoningDelta = choice?.delta?.reasoning_content ?? '';
          if (reasoningDelta) {
            yield {
              type: 'token',
              text: `<think>${this.redactor.rehydrate(reasoningDelta, redactions)}</think>`,
            };
          }
          const delta = choice?.delta?.content ?? '';
          if (delta) {
            outChars += delta.length;
            yield { type: 'token', text: this.redactor.rehydrate(delta, redactions) };
          }
          if (choice?.finish_reason) stopReason = choice.finish_reason;
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
            outputTokens = parsed.usage.completion_tokens ?? outputTokens;
          }
        }
      }

      this.breaker.recordSuccess();
      yield {
        type: 'done',
        stopReason: stopReason ?? 'stream_end',
        inputTokens,
        outputTokens: outputTokens || Math.ceil(outChars / 4),
      };
    } catch (err) {
      const isAbort = input.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) {
        this.breaker.recordFailure();
        this.logger?.error('openai stream failed', { error: String(err) });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildMessages(
    state: DialogueState,
    userText: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: DEFAULT_REASONING_POLICY },
    ];
    if (state.summary.length > 0) {
      msgs.push({ role: 'system', content: `Conversation so far:\n${state.summary}` });
    }
    for (const turn of state.turns.slice(-6)) {
      msgs.push({ role: 'user', content: turn.userText });
      if (turn.agentText) msgs.push({ role: 'assistant', content: turn.agentText });
    }
    msgs.push({ role: 'user', content: shouldUseNoThinkDirective(this.baseUrl) ? `${userText}\n/no_think` : userText });
    if (this.assistantPrefill) {
      // LM Studio reasoning models can stream only `reasoning_content`
      // unless generation is prefixed into the assistant response.
      msgs.push({ role: 'assistant', content: ' ' });
    }
    return msgs;
  }
}

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

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

function shouldUseAssistantPrefill(baseUrl: string): boolean {
  const explicit = process.env['OASIS_OPENAI_ASSISTANT_PREFILL'];
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;

  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function shouldUseNoThinkDirective(baseUrl: string): boolean {
  const explicit = process.env['OASIS_OPENAI_NO_THINK'];
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;

  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function shouldUseLocalConsoleFilter(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function stripLocalConsoleEcho(raw: string): string {
  let text = raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  const noThinkIndex = text.lastIndexOf('/no_think');
  if (noThinkIndex !== -1) {
    text = text.slice(noThinkIndex + '/no_think'.length);
  } else if (text.includes('(truncated)')) {
    text = text.slice(text.lastIndexOf('(truncated)') + '(truncated)'.length);
  } else if (/^\s*loading model/i.test(text) || /\bavailable commands:\b/i.test(text)) {
    // If the local server only returned its CLI banner/prompt echo, do
    // not let that reach TTS. A later retry after warmup will answer.
    return '';
  }

  text = text
    .replace(/^\s*(?:>?\s*assistant\s*:)?\s*/i, '')
    .replace(/^\s*assistant\s*/i, '')
    .trim();

  return text;
}

async function* waitWithHeartbeats<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): AsyncIterable<{ type: 'value'; value: T } | { type: 'heartbeat'; atMs: number }> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  while (!settled) {
    await sleep(1_000);
    if (signal.aborted) break;
    if (!settled) yield { type: 'heartbeat', atMs: Date.now() };
  }
  if (error !== undefined) throw error;
  if (settled) yield { type: 'value', value: value as T };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
