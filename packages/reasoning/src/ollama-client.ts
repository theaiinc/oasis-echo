import type { Logger } from '@oasis-echo/telemetry';
import type { DialogueState } from '@oasis-echo/types';
import { CircuitBreaker } from './circuit-breaker.js';
import { PiiRedactor } from './redaction.js';
import type { Reasoner, ReasoningStreamEvent } from './anthropic-client.js';

export type OllamaOpts = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
  redactor?: PiiRedactor;
  systemPrompt?: string;
  temperature?: number;
};

const DEFAULT_SYSTEM = [
  'You are a curious, warm conversational partner — not a chatbot assistant.',
  'React with genuine interest. Ask natural follow-up questions when appropriate.',
  'Use casual, contemporary speech. Match the user\'s energy.',
  'AVOID these clichés: "That sounds interesting.", "That sounds like…", "How can I assist you today?", "Is there anything else I can help you with?", "That\'s a great question.".',
  'Instead react with a specific observation, then ask a concrete follow-up when natural.',
  'Respond in one or two short sentences — this is spoken conversation, not text.',
  'Prefer direct answers; avoid preambles like "Sure" or "Certainly".',
  'PII has been replaced with placeholders like <EMAIL_1>; do not speculate about them.',
].join(' ');

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
  private readonly breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 10_000 });

  constructor(opts: OllamaOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? process.env['OLLAMA_MODEL'] ?? 'gemma4:e4b';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.logger = opts.logger;
    this.redactor = opts.redactor ?? new PiiRedactor();
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.temperature = opts.temperature ?? 0.6;
  }

  get circuitStatus(): string {
    return this.breaker.status;
  }

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
  }): AsyncIterable<ReasoningStreamEvent> {
    if (!this.breaker.canAttempt()) {
      throw new Error(`circuit ${this.breaker.status}: ollama unavailable`);
    }

    const { text: redactedUser, redactions } = this.redactor.redact(input.userText);
    const messages = this.buildMessages(input.state, redactedUser);

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), this.timeoutMs);
    const signal = composeSignals(input.signal, timeoutCtl.signal);

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          // Reasoning models (gemma4, qwen3) consume num_predict on
          // invisible chain-of-thought when `think` is enabled, which
          // makes the streamed response look empty. For voice replies
          // we just want the final content.
          think: false,
          options: { temperature: this.temperature },
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
      let buf = '';
      let outChars = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal.aborted) break;
        buf += decoder.decode(value, { stream: true });
        // NDJSON: one JSON object per line.
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: OllamaChunk;
          try {
            parsed = JSON.parse(line) as OllamaChunk;
          } catch (err) {
            this.logger?.warn('ollama parse error', { line: line.slice(0, 120), error: String(err) });
            continue;
          }
          const delta = parsed.message?.content ?? '';
          if (delta) {
            outChars += delta.length;
            yield { type: 'token', text: this.redactor.rehydrate(delta, redactions) };
          }
          if (parsed.done) {
            this.breaker.recordSuccess();
            yield {
              type: 'done',
              stopReason: parsed.done_reason ?? 'stop',
              inputTokens: parsed.prompt_eval_count ?? 0,
              outputTokens: parsed.eval_count ?? Math.ceil(outChars / 4),
            };
            return;
          }
        }
      }

      this.breaker.recordSuccess();
      yield {
        type: 'done',
        stopReason: 'stream_end',
        inputTokens: 0,
        outputTokens: Math.ceil(outChars / 4),
      };
    } catch (err) {
      // A user-initiated barge-in surfaces as AbortError here — that's
      // not an ollama failure, so don't count it toward the breaker.
      const isAbort = input.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
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

type OllamaChunk = {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
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
