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
};

const DEFAULT_SYSTEM = PERSONA_RULES;

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
      throw new Error(`circuit ${this.breaker.status}: openai unavailable`);
    }

    const { text: redactedUser, redactions } = this.redactor.redact(input.userText);
    const messages = this.buildMessages(input.state, redactedUser);

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), this.timeoutMs);
    const signal = composeSignals(input.signal, timeoutCtl.signal);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          temperature: this.temperature,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.body) throw new Error('openai: missing response body');

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buf = '';
      let outChars = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;

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

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: { content?: string };
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
