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
  archRouter?: WarmableRouter;
  slmRouter?: WarmableRouter;
};

type WarmableRouter = Router & { warm?: () => Promise<void> };

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
  private readonly archRouter: WarmableRouter;
  private readonly slmRouter: WarmableRouter;
  private readonly logger: Logger | undefined;
  private readonly fallback: Router;

  constructor(opts: ThreeTierRouterOpts = {}) {
    // Build ArchRouter options — conditionally set optional fields to
    // satisfy exactOptionalPropertyTypes: true.
    if (opts.archRouter) {
      this.archRouter = opts.archRouter;
    } else {
      const archBaseUrl = opts.archBaseUrl ?? 'http://localhost:1234/v1';
      const archModel = opts.archModel ?? 'arch-router-1.5b.gguf';
      const archTimeoutMs = opts.archTimeoutMs ?? 3000;
      const archLogger = opts.logger;
      this.archRouter = new ArchRouter(
        Object.assign(
          { baseUrl: archBaseUrl, model: archModel, timeoutMs: archTimeoutMs },
          archLogger ? { logger: archLogger } : {},
        ) as ArchRouterOpts,
      );
    }

    if (opts.slmRouter) {
      this.slmRouter = opts.slmRouter;
    } else {
      const slmBaseUrl = opts.slmBaseUrl ?? 'http://localhost:11434';
      const slmModel = opts.slmModel ?? 'qwen3:4b';
      const slmLogger = opts.logger;
      this.slmRouter = new OllamaRouter(
        Object.assign(
          { baseUrl: slmBaseUrl, model: slmModel, fallback: alwaysEscalate },
          slmLogger ? { logger: slmLogger } : {},
          opts.slmTimeoutMs !== undefined ? { timeoutMs: opts.slmTimeoutMs } : {},
        ) as OllamaRouterOpts,
      );
    }
    this.logger = opts.logger;
    this.fallback = opts.fallback ?? alwaysEscalate;
  }

  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    const startedAt = Date.now();
    try {
      const hearingCheck = this.hearingCheckReply(input.text);
      if (hearingCheck) {
        return {
          intent: 'smalltalk',
          confidence: 0.95,
          decision: {
            kind: 'local',
            intent: 'smalltalk',
            reply: hearingCheck,
          },
        };
      }

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

      if (archOutput.intent === 'unknown') {
        const questionFallback = this.substantiveQuestionFallback(input.text, input.state);
        if (questionFallback) {
          this.logger?.warn('three-tier: unknown classifier result looked like a substantive question; escalating', {
            classifyMs,
            text: input.text,
          });
          return questionFallback;
        }
      }

      // Step 3: Local intent → SLM generates quick reply
      this.logger?.debug('three-tier local → slm-reply', {
        intent: archOutput.intent,
        classifyMs,
      });
      let slmOutput: RouterOutput;
      try {
        slmOutput = await this.slmRouter.route(input);
      } catch (err) {
        this.logger?.warn('three-tier: slm failed for local intent, using local fallback', {
          intent: archOutput.intent,
          error: String(err),
        });
        return this.localFallback(archOutput.intent, input.text);
      }
      const totalMs = Date.now() - startedAt;

      this.logger?.debug('three-tier slm reply', {
        intent: slmOutput.intent,
        kind: slmOutput.decision.kind,
        totalMs,
      });

      // If the SLM unexpectedly escalated, do not send a local greeting
      // or social check-in to the big reasoner. Keep the turn immediate
      // with a short deterministic fallback.
      if (slmOutput.decision.kind === 'escalate') {
        this.logger?.warn('three-tier: slm escalated a local intent', {
          intent: archOutput.intent,
          totalMs,
        });
        if (archOutput.intent === 'unknown') {
          const questionFallback = this.substantiveQuestionFallback(input.text, input.state);
          if (questionFallback) return questionFallback;
        }
        return this.localFallback(archOutput.intent, input.text);
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
      this.slmRouter.warm?.() ?? Promise.resolve(),
    ]);
  }

  private hearingCheckReply(text: string): string | null {
    const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ');
    if (
      /\b(can|could|do|did)\s+(you|u)\s+(hear|hears|heard)\s+(me|my)\b/.test(
        normalized,
      ) ||
      /\b(are|r)\s+(you|u)\s+(hearing|listening)\b/.test(normalized)
    ) {
      return 'Yes, I can hear you.';
    }
    return null;
  }

  private substantiveQuestionFallback(text: string, state: DialogueState): RouterOutput | null {
    const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s'?]/gu, ' ');
    const compact = normalized.replace(/\s+/g, ' ').trim();
    if (!compact) return null;
    if (/\b(how are you|how you doing|what'?s up|what is up|you doing okay)\b/.test(compact)) {
      return null;
    }
    const tokens = compact.split(' ').filter(Boolean);
    if (tokens.length < 4) return null;
    const hasQuestionShape =
      text.includes('?') ||
      /\b(what|why|when|where|who|which|how|do|does|did|can|could|would|is|are|was|were|remember|recommend|latest|current|new)\b/.test(
        compact,
      );
    if (!hasQuestionShape) return null;

    const complexIntent =
      /\b(why|explain|how does|how do|reason|compare|difference|plan|analyze)\b/.test(compact);
    const preferredIntent: Intent = complexIntent ? 'question_complex' : 'question_simple';
    const fallbackIntent: Intent = preferredIntent === 'question_complex'
      ? 'question_simple'
      : 'question_complex';
    const intent = state.allowedIntents.includes(preferredIntent)
      ? preferredIntent
      : state.allowedIntents.includes(fallbackIntent)
      ? fallbackIntent
      : null;
    if (!intent) return null;

    return {
      intent,
      confidence: 0.55,
      decision: {
        kind: 'escalate',
        intent,
        reason: 'substantive-question-fallback',
        filler: this.questionFallbackFiller(compact),
      },
    };
  }

  private questionFallbackFiller(normalizedText: string): string {
    if (/\b(apple tv|animation|anime|series|show|movie)\b/.test(normalizedText)) {
      return 'Apple TV shows, checking.';
    }
    if (/\b(time|date|weather)\b/.test(normalizedText)) {
      return 'Checking that now.';
    }
    return 'Let me think.';
  }

  private localFallback(intent: Intent, text: string): RouterOutput {
    const lower = text.toLowerCase();
    const reply =
      intent === 'greeting'
        ? "Hey, I'm listening."
        : intent === 'smalltalk' || /\b(how are you|how you doing|what'?s up)\b/.test(lower)
        ? "I'm doing well. What can I help with?"
        : intent === 'confirm'
        ? 'Okay.'
        : intent === 'deny' || intent === 'cancel' || intent === 'stop'
        ? 'No problem.'
        : intent === 'wait'
        ? "Okay, I'll wait."
        : "I'm here. What would you like to do?";
    return {
      intent,
      confidence: 0.7,
      decision: { kind: 'local', intent, reply },
    };
  }
}
