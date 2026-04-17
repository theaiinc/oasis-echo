import type { RouterOutput } from '@oasis-echo/types';

export type GuardrailResult =
  | { ok: true; output: RouterOutput }
  | { ok: false; reason: string; fallback: RouterOutput };

export type GuardrailOpts = {
  minConfidence?: number;
  maxReplyChars?: number;
};

/**
 * Validates router output before it reaches TTS. Forces an escalation
 * when confidence is low, reply is suspiciously long, or the decision
 * shape is malformed.
 */
export class Guardrail {
  private readonly minConfidence: number;
  private readonly maxReplyChars: number;

  constructor(opts: GuardrailOpts = {}) {
    this.minConfidence = opts.minConfidence ?? 0.55;
    this.maxReplyChars = opts.maxReplyChars ?? 400;
  }

  check(output: RouterOutput): GuardrailResult {
    if (output.confidence < this.minConfidence && output.decision.kind === 'local') {
      return {
        ok: false,
        reason: `confidence ${output.confidence.toFixed(2)} below ${this.minConfidence}`,
        fallback: {
          intent: output.intent,
          confidence: output.confidence,
          decision: {
            kind: 'escalate',
            intent: output.intent,
            reason: 'low-confidence',
            filler: 'Let me double-check that.',
          },
        },
      };
    }

    if (output.decision.kind === 'local' && output.decision.reply) {
      if (output.decision.reply.length > this.maxReplyChars) {
        return {
          ok: false,
          reason: 'reply exceeds max length',
          fallback: {
            intent: output.intent,
            confidence: output.confidence,
            decision: {
              kind: 'escalate',
              intent: output.intent,
              reason: 'reply-too-long',
              filler: 'One moment.',
            },
          },
        };
      }
    }

    return { ok: true, output };
  }
}
