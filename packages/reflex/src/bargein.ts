import type { VadFrameResult } from './vad.js';

export type BargeInOpts = {
  minProbability?: number;
  minSustainedMs?: number;
};

/**
 * Detects barge-in: user speech that starts while the agent is speaking.
 * Requires a short sustain window to avoid false triggers from the agent's
 * own audio bleeding back through the mic.
 */
export class BargeInDetector {
  private readonly minProb: number;
  private readonly minSustainedMs: number;
  private firstSustainedAtMs: number | null = null;
  private active = false;

  constructor(opts: BargeInOpts = {}) {
    this.minProb = opts.minProbability ?? 0.6;
    this.minSustainedMs = opts.minSustainedMs ?? 80;
  }

  observe(result: VadFrameResult, agentSpeaking: boolean): boolean {
    if (!agentSpeaking) {
      this.reset();
      return false;
    }
    if (result.probability >= this.minProb) {
      if (this.firstSustainedAtMs === null) {
        this.firstSustainedAtMs = result.atMs;
      } else if (result.atMs - this.firstSustainedAtMs >= this.minSustainedMs) {
        if (!this.active) {
          this.active = true;
          return true;
        }
      }
    } else {
      this.firstSustainedAtMs = null;
    }
    return false;
  }

  reset(): void {
    this.firstSustainedAtMs = null;
    this.active = false;
  }
}
