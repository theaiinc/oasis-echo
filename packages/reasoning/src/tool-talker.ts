import type { Logger } from '@oasis-echo/telemetry';
import type { DialogueState } from '@oasis-echo/types';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';
import type { ToolRegistry } from './tools.js';

/**
 * A fast conversational model (OpenAI-compatible chat completions) that can
 * call tools: the live voice of a call. It streams its words so speech starts
 * at the first sentence; when it calls a tool it runs the handler, feeds the
 * result back and keeps talking (up to `maxToolRounds`). A handler that
 * starts slow work (asking an expert) should return at once with what the
 * talker needs to say next, e.g. how long the expert usually takes.
 *
 * `context()` is read every turn and given to the model as a system note:
 * what is running in the background, how long it has been, what is known.
 */
export type ToolTalkerOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Used for a turn when `model` fails or hasn't started answering within
   * `firstTokenMs` (e.g. a free model first, a cheap one behind it). After
   * three failures in a row `model` is skipped for `skipMs`.
   */
  fallbackModel?: string;
  firstTokenMs?: number;
  skipMs?: number;
  systemPrompt: string;
  tools?: ToolRegistry;
  context?: () => string | undefined;
  maxToolRounds?: number;
  timeoutMs?: number;
  temperature?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export class ToolTalker implements Reasoner {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private failures = 0;
  private skipUntil = 0;

  constructor(private readonly opts: ToolTalkerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  async *stream(input: { userText: string; state: DialogueState; signal?: AbortSignal; allowTools?: boolean }): AsyncIterable<ReasoningStreamEvent> {
    const messages = this.messages(input.state, input.userText);
    const tools = input.allowTools === false ? [] : (this.opts.tools?.list() ?? []);
    const toolSpecs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    let inputTokens = 0;
    let outputTokens = 0;
    for (let round = 0; ; round++) {
      const canCall = toolSpecs.length > 0 && round < (this.opts.maxToolRounds ?? 3);
      const body = {
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: this.opts.temperature ?? 0.6,
        ...(canCall ? { tools: toolSpecs, tool_choice: 'auto' } : {}),
      };
      const chunks = await this.open(body, input.signal);

      let text = '';
      const calls: ToolCall[] = [];
      let finish: string | null = null;
      for await (const chunk of chunks) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: 'token', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (calls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          inputTokens += chunk.usage.prompt_tokens ?? 0;
          outputTokens += chunk.usage.completion_tokens ?? 0;
        }
      }
      const called = calls.filter((c) => c.function.name);
      if (!called.length || !canCall) {
        yield { type: 'done', stopReason: finish === 'length' ? 'length' : 'stop', inputTokens, outputTokens };
        return;
      }
      messages.push({ role: 'assistant', content: text || null, tool_calls: called });
      for (const call of called) {
        const tool = this.opts.tools?.get(call.function.name);
        let parsed: unknown = {};
        try { parsed = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
        yield { type: 'tool_use', id: call.id, name: call.function.name, input: parsed };
        let output: unknown;
        try {
          output = tool ? await tool.handler(parsed) : { error: `no tool ${call.function.name}` };
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }
        yield { type: 'tool_result', id: call.id, output };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
  }

  /**
   * The streamed completion from the first model that starts answering in
   * time: `model`, or `fallbackModel` when it errors or is slow to begin.
   */
  private async open(body: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>> {
    const primary = this.opts.model;
    const fallback = this.opts.fallbackModel;
    const tryPrimary = !fallback || Date.now() >= this.skipUntil;
    if (tryPrimary) {
      const firstTokenMs = fallback ? (this.opts.firstTokenMs ?? 4000) : (this.opts.timeoutMs ?? 30_000);
      try {
        const started = await this.start(primary, body, signal, firstTokenMs);
        this.failures = 0;
        return started;
      } catch (err) {
        if (signal?.aborted || !fallback) throw err;
        if (++this.failures >= 3) {
          this.skipUntil = Date.now() + (this.opts.skipMs ?? 5 * 60_000);
          this.failures = 0;
        }
        this.opts.logger?.warn('talker falling back', { model: primary, fallback, error: String(err) });
      }
    }
    return this.start(fallback!, body, signal, this.opts.timeoutMs ?? 30_000);
  }

  /** Starts a stream and waits for its first chunk (so a slow model can be abandoned before anything is said). */
  private async start(model: string, body: Record<string, unknown>, signal: AbortSignal | undefined, firstChunkMs: number): Promise<AsyncIterable<StreamChunk>> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const overall = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 30_000);
    const firstTimer = setTimeout(() => ctl.abort(), firstChunkMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ model, ...body }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`talker ${model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const it = sseJson(res.body, ctl.signal)[Symbol.asyncIterator]();
      // Wait for something to say (or a tool call), not keep-alives or reasoning.
      const buffered: StreamChunk[] = [];
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        buffered.push(next.value);
        const d = next.value.choices?.[0];
        if (d?.delta?.content || d?.delta?.tool_calls?.length || d?.finish_reason) break;
      }
      clearTimeout(firstTimer);
      const rest = { [Symbol.asyncIterator]: () => it };
      return (async function* () {
        try {
          yield* buffered;
          yield* rest;
        } finally {
          clearTimeout(overall);
          signal?.removeEventListener('abort', onAbort);
        }
      })();
    } catch (err) {
      clearTimeout(firstTimer);
      clearTimeout(overall);
      signal?.removeEventListener('abort', onAbort);
      throw ctl.signal.aborted && !signal?.aborted ? new Error(`talker ${model}: no answer within ${firstChunkMs} ms`) : err;
    }
  }

  private messages(state: DialogueState, userText: string): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: this.opts.systemPrompt }];
    const context = this.opts.context?.();
    if (context) msgs.push({ role: 'system', content: context });
    if (state.summary) msgs.push({ role: 'system', content: `Conversation so far:\n${state.summary}` });
    for (const turn of state.turns.slice(-8)) {
      if (turn.userText) msgs.push({ role: 'user', content: turn.userText });
      if (turn.agentText) msgs.push({ role: 'assistant', content: turn.agentText });
    }
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }
}

type StreamChunk = {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

async function* sseJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data) as StreamChunk; } catch { /* partial or keep-alive line */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

