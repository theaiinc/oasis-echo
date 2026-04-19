import type { Logger } from '@oasis-echo/telemetry';
import {
  PERSONA_RULES,
  type DialogueState,
  type Intent,
  type RouterOutput,
} from '@oasis-echo/types';
import {
  alwaysEscalate,
  buildRouterPrompt,
  parseRouterJson,
  toRouterOutput,
  type Router,
} from './router.js';

/**
 * Intents the SLM is allowed to handle end-to-end with its own reply.
 * For these, we trust the SLM's kind="local"|"escalate" call and its
 * generated reply. For anything else (question_*, command_*), we
 * force escalation regardless of SLM self-assessment so real content
 * goes through the reasoner.
 *
 * `unknown` is included: when the SLM can't confidently classify but
 * does produce a reply, let that reply through. The pipeline still
 * honors an explicit kind="escalate" from the SLM (that's how the
 * `alwaysEscalate` fallback behaves on timeouts — intent=unknown +
 * kind=escalate + no reply → pipeline escalates properly).
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
  'unknown',
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
          keep_alive: '30m',
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      this.logger?.info('slm router warm');
      // Re-pin every 20 minutes so the model doesn't drop out of VRAM
      // during long idle periods (default Ollama eviction is 5m).
      if (!this.keepAliveTimer) {
        this.keepAliveTimer = setInterval(() => {
          this.warm().catch(() => {});
        }, 20 * 60 * 1000);
        // Don't block process exit on the keepalive timer.
        if (typeof this.keepAliveTimer.unref === 'function') {
          this.keepAliveTimer.unref();
        }
      }
    } catch (err) {
      this.logger?.warn('slm router warm failed', { error: String(err) });
    }
  }

  private keepAliveTimer: NodeJS.Timeout | null = null;

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
                'You output STRICT JSON only — no prose, no markdown fences. Follow the exact schema the user describes.',
                '',
                'The `reply` field (used when kind="local") must follow the persona below:',
                '',
                PERSONA_RULES,
              ].join('\n'),
            },
            { role: 'user', content: prompt },
          ],
          stream: false,
          // Keep the router model hot in VRAM for 30 minutes so
          // follow-up turns don't hit a cold-reload timeout.
          keep_alive: '30m',
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
