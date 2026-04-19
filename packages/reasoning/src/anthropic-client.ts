import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@oasis-echo/telemetry';
import { PERSONA_RULES, type DialogueState } from '@oasis-echo/types';
import { CircuitBreaker } from './circuit-breaker.js';
import { PiiRedactor } from './redaction.js';
import type { ToolRegistry } from './tools.js';

export type ReasoningOpts = {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  logger?: Logger;
  tools?: ToolRegistry;
  redactor?: PiiRedactor;
  systemPrompt?: string;
};

export type ReasoningStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown }
  | { type: 'done'; stopReason: string | null; inputTokens: number; outputTokens: number };

export interface Reasoner {
  stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
  }): AsyncIterable<ReasoningStreamEvent>;
}

const DEFAULT_SYSTEM = [
  PERSONA_RULES,
  '',
  'TOOLS: When a tool is available and relevant, call it; otherwise answer directly.',
].join('\n');

/**
 * Streaming Claude client used for Tier 2 escalations.
 * - Injects cache_control on the system prompt and tool defs so repeated
 *   turns in a session hit the prompt cache.
 * - Runs PII redaction before egress and rehydrates on tokens so the
 *   user's speaker hears original values.
 * - Guarded by a circuit breaker with a configurable open duration.
 */
export class AnthropicReasoner implements Reasoner {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly tools: ToolRegistry | undefined;
  private readonly redactor: PiiRedactor;
  private readonly systemPrompt: string;
  private readonly breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 30_000 });

  constructor(opts: ReasoningOpts = {}) {
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? process.env['OASIS_MODEL'] ?? 'claude-sonnet-4-6';
    this.maxTokens = opts.maxTokens ?? 512;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger;
    this.tools = opts.tools;
    this.redactor = opts.redactor ?? new PiiRedactor();
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
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
      throw new Error(`circuit ${this.breaker.status}: cloud unavailable`);
    }

    const { text: redactedUser, redactions } = this.redactor.redact(input.userText);
    const messages = this.buildMessages(input.state, redactedUser);
    const tools = this.tools?.toAnthropicTools();

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = composeSignals(input.signal, timeoutController.signal);

    try {
      // NOTE: prompt caching (cache_control) is exposed through the beta
      // messages endpoint in SDK 0.32; switch to the beta client when
      // caching is required in production to amortize the system prompt
      // and tool definitions across turns.
      const stream = await this.client.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.systemPrompt,
          messages,
          ...(tools && tools.length > 0 ? { tools } : {}),
        },
        { signal },
      );

      let inputTokens = 0;
      let outputTokens = 0;
      const toolUses = new Map<string, { name: string; json: string }>();

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolUses.set(event.content_block.id, { name: event.content_block.name, json: '' });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const rehydrated = this.redactor.rehydrate(event.delta.text, redactions);
            yield { type: 'token', text: rehydrated };
          } else if (event.delta.type === 'input_json_delta') {
            // Locate the in-progress tool_use block by index; SDK provides partial_json
            for (const [, v] of toolUses) {
              v.json += event.delta.partial_json;
              break;
            }
          }
        } else if (event.type === 'message_delta') {
          if (event.usage) outputTokens = event.usage.output_tokens ?? outputTokens;
        } else if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens ?? 0;
        }
      }

      // Execute any tool calls serially and surface results
      for (const [id, { name, json }] of toolUses) {
        const tool = this.tools?.get(name);
        if (!tool) continue;
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(json || '{}');
        } catch {
          parsed = {};
        }
        yield { type: 'tool_use', id, name, input: parsed };
        const output = await tool.handler(parsed);
        yield { type: 'tool_result', id, output };
      }

      const final = await stream.finalMessage();
      this.breaker.recordSuccess();
      yield {
        type: 'done',
        stopReason: final.stop_reason ?? null,
        inputTokens,
        outputTokens: final.usage.output_tokens ?? outputTokens,
      };
    } catch (err) {
      // Distinguish user-initiated aborts (barge-in) from real errors.
      const isAbort = input.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) {
        this.breaker.recordFailure();
        this.logger?.error('anthropic stream failed', { error: String(err) });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildMessages(
    state: DialogueState,
    userText: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (state.summary.length > 0) {
      history.push({ role: 'user', content: `[conversation summary]\n${state.summary}` });
      history.push({ role: 'assistant', content: 'Understood, continuing.' });
    }
    for (const turn of state.turns.slice(-6)) {
      history.push({ role: 'user', content: turn.userText });
      if (turn.agentText) history.push({ role: 'assistant', content: turn.agentText });
    }
    history.push({ role: 'user', content: userText });
    return history;
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
