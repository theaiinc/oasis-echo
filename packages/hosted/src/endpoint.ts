/**
 * When to answer after the user goes quiet, from what they said: soon after a
 * question or a finished sentence, later when the words trail off mid-thought.
 */

/** Words a sentence doesn't end on (English and Vietnamese), and trailing fillers. */
const TRAILING = /(?:^|[\s,])(and|but|or|so|because|cause|the|a|an|to|of|with|for|in|on|at|from|my|your|our|their|um+|uh+|er+|hmm+|like|if|when|that|which|then|is|are|was|were|và|nhưng|thì|là|của|để|với|mà|nên|vì|hoặc|hay|ờ+|ừm+|à+)\s*[.,…-]*$/iu;

/** Milliseconds of quiet to wait (counted from the last speech) before answering `text`. */
export function endpointMs(text: string): number {
  const t = text.trim();
  if (/(\.\.\.|…|,|-)$/.test(t) || TRAILING.test(t)) return 1800;
  if (/[?？]$/.test(t)) return 300;
  // Whisper ends almost everything with a full stop, mid-thought too ("I want to check
  // the" came back as "I want to check, though."), so a full stop alone is weak evidence.
  if (/[.!。！]$/.test(t)) return 1000;
  return 1100;
}

/**
 * Is the user talking? Judged on 30 ms windows against the room's own noise floor,
 * not per network frame: the page sends ~43 samples at a time, and judging each alone
 * against a fixed level let every click or hiss spike count as speech, so the server
 * never saw a pause at all (every turn fell back to the page's 2.2 s end).
 */
export class SpeechGate {
  private window: number[] = [];
  private floor = 0.004;
  private loudRun = 0;
  /** Time of the last window that was speech, in ms of audio since the start. */
  lastSpeechMs = 0;
  /** Any speech yet. */
  spoke = false;
  private audioMs = 0;

  constructor(private readonly opts: { windowSamples?: number; minLevel?: number; ratio?: number; confirmWindows?: number } = {}) {}

  /** Feed 16 kHz samples; returns true when a window confirmed speech. */
  push(samples: Float32Array): boolean {
    const size = this.opts.windowSamples ?? 480;
    let speech = false;
    for (let i = 0; i < samples.length; i++) {
      this.window.push(samples[i]!);
      if (this.window.length < size) continue;
      let sum = 0;
      for (const v of this.window) sum += v * v;
      const rms = Math.sqrt(sum / this.window.length);
      this.window = [];
      this.audioMs += (size / 16_000) * 1000;
      const loud = rms > Math.max(this.opts.minLevel ?? 0.015, this.floor * (this.opts.ratio ?? 3));
      if (loud) {
        this.loudRun++;
        // A lone loud window is a click; speech holds for a couple.
        if (this.loudRun >= (this.opts.confirmWindows ?? 2)) {
          this.spoke = true;
          this.lastSpeechMs = this.audioMs;
          speech = true;
        }
      } else {
        this.loudRun = 0;
        // Track the room: fall quickly to quieter levels, rise slowly.
        this.floor = rms < this.floor ? this.floor * 0.7 + rms * 0.3 : this.floor * 0.98 + rms * 0.02;
      }
    }
    return speech;
  }

  /** Milliseconds of audio since the last speech. */
  get quietMs(): number {
    return this.audioMs - this.lastSpeechMs;
  }

  reset(): void {
    this.window = [];
    this.loudRun = 0;
    this.lastSpeechMs = this.audioMs;
    this.spoke = false;
  }
}
