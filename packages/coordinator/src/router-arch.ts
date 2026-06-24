import { type Intent, type RouterOutput, type DialogueState } from '@oasis-echo/types';
import { alwaysEscalate, type Router } from './router.js';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * ArchRouter — ultra-fast pure classifier using katanemo/Arch-Router-1.5B
 * running on LM Studio via OpenAI-compatible chat completions API.
 *
 * This model is a 1.5B parameter GGUF that outputs JUST an intent label
 * in <100ms inference time. It does NOT generate replies or fillers —
 * it only decides WHAT the user wants. The three-tier pipeline then
 * routes to the appropriate handler.
 *
 * Three-tier flow:
 *   1. ArchRouter classifies intent (fast, <500ms)
 *   2. Smalltalk/greeting/etc → OllamaRouter (qwen3:4b) → TTS
 *   3. Complex/question/command → play filler → reasoner → TTS
 *
 * Benefits over OllamaRouter alone:
 *   - No thinking tokens leaked (Arch-Router doesn't generate prose)
 *   - 10x faster than qwen3:4b for classification
 *   - Dedicated router doesn't compete with reasoner for VRAM
 */
export type ArchRouterOpts = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
  fallback?: Router;
};

/**
 * Intents that can be handled locally by the SLM (qwen3:4b) without
 * needing the full reasoner pipeline.
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

export class ArchRouter implements Router {
  private readonly baseUrl: string; // e.g. http://localhost:1234/v1
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly fallback: Router;

  constructor(opts: ArchRouterOpts = {}) {
    // LM Studio serves OpenAI-compatible API; the baseUrl should
    // include the /v1 prefix, e.g. http://localhost:1234/v1
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:1234/v1').replace(/\/+$/, '');
    this.model = opts.model ?? 'arch-router-1.5b.gguf';
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.logger = opts.logger;
    this.fallback = opts.fallback ?? alwaysEscalate;
  }

  /** Kick the model into VRAM so the first real route isn't cold. */
  async warm(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 1,
          temperature: 0.1,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      this.logger?.info('arch-router warm');
      if (!this.keepAliveTimer) {
        this.keepAliveTimer = setInterval(() => {
          this.warm().catch(() => {});
        }, 20 * 60 * 1000);
        if (typeof this.keepAliveTimer.unref === 'function') {
          this.keepAliveTimer.unref();
        }
      }
    } catch (err) {
      this.logger?.warn('arch-router warm failed', { error: String(err) });
    }
  }

  private keepAliveTimer: NodeJS.Timeout | null = null;

  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    const startedAt = Date.now();
    try {
      const intent = await this.classify(input.text, input.state);
      const ms = Date.now() - startedAt;

      if (LOCAL_INTENTS.has(intent)) {
        this.logger?.debug('arch-router local', { intent, ms });
        return {
          intent,
          confidence: 0.85,
          decision: { kind: 'local', intent },
        };
      }

      this.logger?.debug('arch-router escalate', { intent, ms });
      return {
        intent,
        confidence: 0.85,
        decision: {
          kind: 'escalate',
          intent,
          reason:
            intent === 'command_tool'
              ? 'tool-needed'
              : intent === 'question_simple'
              ? 'factual-lookup'
              : 'complex-reasoning',
        },
      };
    } catch (err) {
      this.logger?.warn('arch-router failed, using fallback', {
        error: String(err),
        ms: Date.now() - startedAt,
      });
      return this.fallback.route(input);
    }
  }

  /**
   * Classify via LM Studio's OpenAI-compatible chat completions API.
   * The model outputs just one intent word — no prose, no thinking.
   */
  private async classify(text: string, state: DialogueState): Promise<Intent> {
    const allowed = state.allowedIntents.join(', ');
    const examples = [
      '  user: "hello" → greeting',
      '  user: "how are you" → smalltalk',
      '  user: "yes" → confirm',
      '  user: "no" → deny',
      '  user: "what time is it" → question_simple',
      '  user: "send an email" → command_tool',
      '  user: "stop" → stop',
    ].join('\n');

    const systemPrompt = [
      'You are an intent classifier. Output ONLY ONE word from the allowed list.',
      '',
      `Allowed: ${allowed}`,
      '',
      examples,
      '',
      'Instructions:',
      '  - greeting: "hi", "hey", "hello", "good morning", bare openers',
      '  - smalltalk: "how are you", "what\'s up", social check-ins, pleasantries',
      '  - confirm: "yes", "yeah", "sure", "okay", "correct"',
      '  - deny: "no", "nope", "nah", "not really"',
      '  - cancel: "cancel", "forget it", "never mind"',
      '  - stop/wait: "stop", "wait", "hold on", "pause"',
      '  - backchannel: "uh huh", "mm-hmm", "go on", "I see"',
      '  - question_simple: factual lookup, "what time", "when is", "who is"',
      '  - question_complex: explanation, "why does", "how does", "explain"',
      '  - command_tool: action, "email", "search", "schedule", "send", "find"',
      '  - command_local: device command, "next", "pause", "volume up"',
      '  - unknown: anything else',
    ].join('\n');

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User: "${text}"\nIntent:` },
        ],
        max_tokens: 8,
        temperature: 0.1,
        top_p: 0.9,
        stream: false,
        stop: ['\n', '  '],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`arch-router ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (data.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    const matched = this.matchIntent(raw, state.allowedIntents);

    if (!matched) {
      throw new Error(
        `arch-router: unmatched "${raw}", allowed=[${state.allowedIntents.join(',')}]`,
      );
    }

    return matched;
  }

  /** Match raw model output to a known intent (supports partial prefix matches). */
  private matchIntent(raw: string, allowed: readonly Intent[]): Intent | null {
    if (allowed.includes(raw as Intent)) return raw as Intent;
    for (const a of allowed) {
      if (a.startsWith(raw) || raw.startsWith(a)) return a;
    }
    return null;
  }
}
