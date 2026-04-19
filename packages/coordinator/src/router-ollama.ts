import type { Logger } from '@oasis-echo/telemetry';
import type { DialogueState, Intent, RouterOutput } from '@oasis-echo/types';
import {
  alwaysEscalate,
  buildRouterPrompt,
  parseRouterJson,
  toRouterOutput,
  type Router,
} from './router.js';

/**
 * Intents the SLM is allowed to handle end-to-end with its own reply.
 * Everything else is forced to escalate to the reasoner regardless of
 * what the SLM's self-assessment says — this gives the tiered stack
 * predictable routing even when router and reasoner share a model.
 */
const SMALLTALK_INTENTS: ReadonlySet<Intent> = new Set([
  'greeting',
  'smalltalk',
  'backchannel',
  'confirm',
  'deny',
  'cancel',
  'stop',
  'wait',
]);

export type OllamaRouterOpts = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** If the router call fails, fall through to this (usually a regex
   *  or always-escalate router) so we never block a turn. */
  fallback?: Router;
};

/**
 * SLM-backed coordinator router. Uses Ollama's `format: 'json'`
 * constrained decoding to produce a routing decision in ≤200 tokens:
 *
 *   { intent, confidence, kind: "local"|"escalate", reply?, filler?, reason? }
 *
 * When the SLM returns `kind: "local"` with a `reply`, the whole turn
 * completes with a single Ollama call — no separate reasoning pass.
 * When it returns `kind: "escalate"`, the pipeline forwards to the
 * reasoning engine just as before. This is the Tier-1 design from the
 * SAD: the coordinator handles the simple turns, the big model only
 * sees the hard ones.
 */
export class OllamaRouter implements Router {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly fallback: Router | undefined;

  constructor(opts: OllamaRouterOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'gemma4:e2b';
    // First call is often slow (model load); give it room, but the
    // fallback still kicks in after this point if the SLM is broken.
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.logger = opts.logger;
    this.fallback = opts.fallback;
  }

  /** Kick the model into VRAM so the first real route isn't cold. */
  async warm(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'ok' }],
          stream: false,
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      this.logger?.info('slm router warm');
    } catch (err) {
      this.logger?.warn('slm router warm failed', { error: String(err) });
    }
  }

  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    const prompt = buildRouterPrompt(input.text, input.state);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: [
                // Output format — strict.
                'You output STRICT JSON only — no prose, no markdown fences. Follow the exact schema the user describes.',
                '',
                // Personality — applied to the `reply` field when kind=local.
                'PERSONALITY (shapes the "reply" field when kind="local"):',
                'You are a curious, warm conversational partner — not a chatbot assistant.',
                'You react with genuine interest. You ask natural follow-up questions.',
                'You use casual, contemporary speech. You match the user\'s energy.',
                'AVOID these clichés: "That sounds interesting.", "That sounds like...", "How can I assist you today?", "Is there anything else I can help you with?", "That\'s a great question.".',
                'Instead: react with a specific observation, then ask a concrete follow-up.',
                'Keep replies to one or two short sentences — this is spoken conversation, not text.',
              ].join('\n'),
            },
            { role: 'user', content: prompt },
          ],
          stream: false,
          // Disable "thinking" mode — reasoning models like gemma4
          // otherwise spend all num_predict tokens on invisible
          // internal reasoning and return an empty content field.
          think: false,
          // NOTE: Ollama's `format: 'json'` constrained decoding is
          // broken for gemma4:e2b (returns empty). Rely on the system
          // prompt + extractJson regex instead.
          options: {
            temperature: 0.2,
            num_predict: 400,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`ollama ${res.status}: ${body.slice(0, 120)}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      const raw = data.message?.content ?? '';
      const parsed = parseRouterJson(raw, input.state.allowedIntents);
      if (!parsed) {
        throw new Error(`router parse failed: ${raw.slice(0, 120)}`);
      }

      // Intent-based policy override: smalltalk-like intents stay
      // local (SLM's reply is used directly); everything else
      // escalates to the reasoner, regardless of the SLM's own
      // confidence. This gives predictable tiering even when the
      // router and reasoner share a model.
      const intent = parsed.intent as Intent;
      if (!SMALLTALK_INTENTS.has(intent)) {
        const coerced = {
          ...parsed,
          kind: 'escalate' as const,
          reason:
            parsed.reason ??
            (intent === 'command_tool'
              ? 'tool-needed'
              : intent === 'question_simple'
              ? 'factual-lookup'
              : 'complex-reasoning'),
        };
        this.logger?.debug('slm route (forced escalate)', {
          intent,
          ms: Date.now() - startedAt,
        });
        return toRouterOutput(coerced);
      }

      this.logger?.debug('slm route', {
        intent: parsed.intent,
        kind: parsed.kind,
        ms: Date.now() - startedAt,
      });
      return toRouterOutput(parsed);
    } catch (err) {
      this.logger?.warn('slm router failed, using fallback', {
        error: String(err),
        ms: Date.now() - startedAt,
      });
      return (this.fallback ?? alwaysEscalate).route(input);
    }
  }
}
