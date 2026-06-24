import { type Intent, type RouterOutput, type DialogueState } from '@oasis-echo/types';
import { alwaysEscalate, buildRouterPrompt, type Router } from './router.js';
import { ArchRouter, type ArchRouterOpts } from './router-arch.js';
import { OllamaRouter, type OllamaRouterOpts } from './router-ollama.js';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * Intents that can be handled locally by the SLM without needing the
 * full reasoner pipeline.
 */
const LOCAL_INTENTS: ReadonlySet<Intent> = new Set([
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

export type ThreeTierRouterOpts = {
  archBaseUrl?: string;
  archModel?: string;
  archTimeoutMs?: number;
  slmBaseUrl?: string;
  slmModel?: string;
  slmTimeoutMs?: number;
  logger?: Logger;
  fallback?: Router;
};

/**
 * ThreeTierRouter — composes ArchRouter (pure classifier) and
 * OllamaRouter (SLM reply generator) into a single Router.
 *
 * Flow:
 *   1. Arch-Router-1.5B classifies the intent (<500ms, ~200MB VRAM)
 *   2. If LOCAL_INTENT (smalltalk/greeting/confirm/etc):
 *        → OllamaRouter generates a quick reply (1-2s) → TTS
 *   3. If NOT local (question/complex/command):
 *        → Return escalate immediately with a filler
 *        → Reasoner handles the full response
 *        → No SLM call needed for 70%+ of queries
 *
 * Key benefits over single-model OllamaRouter:
 *   - Architecture: Dedicated 1.5B classifier is 10x faster per
 *     classification and never outputs prose/thinking tokens
 *   - Accuracy: Arch-Router-1.5B is fine-tuned for intent
 *     classification vs qwen3:4b which is a general-purpose model
 *   - VRAM: Arch-Router-1.5B lives in ~200MB and stays queriable
 *     at all times without competing with the reasoner or SLM
 *   - Filler latency: Complex queries skip the SLM call entirely,
 *     meaning fillers fire 1-2s sooner
 */
export class ThreeTierRouter implements Router {
  private readonly archRouter: ArchRouter;
  private readonly slmRouter: OllamaRouter;
  private readonly logger: Logger | undefined;
  private readonly fallback: Router;

  constructor(opts: ThreeTierRouterOpts = {}) {
    // Build ArchRouter options — conditionally set optional fields to
    // satisfy exactOptionalPropertyTypes: true.
    const archBaseUrl = opts.archBaseUrl ?? 'http://localhost:11434';
    const archModel = opts.archModel ?? 'arch-router';
    const archTimeoutMs = opts.archTimeoutMs ?? 3000;
    const archLogger = opts.logger;
    this.archRouter = new ArchRouter(
      Object.assign(
        { baseUrl: archBaseUrl, model: archModel, timeoutMs: archTimeoutMs },
        archLogger ? { logger: archLogger } : {},
      ) as ArchRouterOpts,
    );

    const slmBaseUrl = opts.slmBaseUrl ?? 'http://localhost:11434';
    const slmModel = opts.slmModel ?? 'gemma4:e2b';
    const slmLogger = opts.logger;
    this.slmRouter = new OllamaRouter(
      Object.assign(
        { baseUrl: slmBaseUrl, model: slmModel, fallback: alwaysEscalate },
        slmLogger ? { logger: slmLogger } : {},
        opts.slmTimeoutMs !== undefined ? { timeoutMs: opts.slmTimeoutMs } : {},
      ) as OllamaRouterOpts,
    );
    this.logger = opts.logger;
    this.fallback = opts.fallback ?? alwaysEscalate;
  }

  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    const startedAt = Date.now();
    try {
      // Step 1: Quick classification with Arch-Router-1.5B
      const archOutput = await this.archRouter.route(input);
      const classifyMs = Date.now() - startedAt;

      // Step 2: If NOT a local intent, escalate immediately with filler
      if (!LOCAL_INTENTS.has(archOutput.intent)) {
        this.logger?.debug('three-tier escalate (bypass slm)', {
          intent: archOutput.intent,
          classifyMs,
        });
        return archOutput; // already has kind: 'escalate' from ArchRouter
      }

      // Step 3: Local intent → SLM generates quick reply
      this.logger?.debug('three-tier local → slm-reply', {
        intent: archOutput.intent,
        classifyMs,
      });
      const slmOutput = await this.slmRouter.route(input);
      const totalMs = Date.now() - startedAt;

      this.logger?.debug('three-tier slm reply', {
        intent: slmOutput.intent,
        kind: slmOutput.decision.kind,
        totalMs,
      });

      // If the SLM unexpectedly escalated, respect that decision but
      // log it — smalltalk shouldn't need the reasoner.
      if (slmOutput.decision.kind === 'escalate') {
        this.logger?.warn('three-tier: slm escalated a local intent', {
          intent: archOutput.intent,
          totalMs,
        });
      }

      return slmOutput;
    } catch (err) {
      this.logger?.warn('three-tier router failed, using fallback', {
        error: String(err),
        ms: Date.now() - startedAt,
      });
      return this.fallback.route(input);
    }
  }

  /** Warm both sub-routers in parallel. */
  async warm(): Promise<void> {
    await Promise.all([
      this.archRouter.warm?.() ?? Promise.resolve(),
      this.slmRouter.warm(),
    ]);
  }
}
