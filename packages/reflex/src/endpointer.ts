import type { VadFrameResult } from './vad.js';

export type EndpointerEvent =
  | { type: 'speech.start'; atMs: number }
  | { type: 'speech.end'; atMs: number; durationMs: number };

export type EndpointerOpts = {
  silenceHoldMs?: number;
  minSpeechMs?: number;
};

/**
 * Converts VAD frame results into speech.start / speech.end events.
 * Debounces with a hangover window so brief pauses inside a phrase
 * don't cut off the utterance prematurely.
 */
export class Endpointer {
  private readonly silenceHoldMs: number;
  private readonly minSpeechMs: number;
  private inSpeech = false;
  private speechStartedAtMs = 0;
  private lastSpeechAtMs = 0;

  constructor(opts: EndpointerOpts = {}) {
    this.silenceHoldMs = opts.silenceHoldMs ?? 350;
    this.minSpeechMs = opts.minSpeechMs ?? 120;
  }

  feed(result: VadFrameResult): EndpointerEvent | null {
    if (result.speech) {
      this.lastSpeechAtMs = result.atMs;
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechStartedAtMs = result.atMs;
        return { type: 'speech.start', atMs: result.atMs };
      }
      return null;
    }

    if (this.inSpeech && result.atMs - this.lastSpeechAtMs >= this.silenceHoldMs) {
      const durationMs = this.lastSpeechAtMs - this.speechStartedAtMs;
      this.inSpeech = false;
      if (durationMs < this.minSpeechMs) return null;
      return { type: 'speech.end', atMs: this.lastSpeechAtMs, durationMs };
    }

    return null;
  }

  reset(): void {
    this.inSpeech = false;
    this.speechStartedAtMs = 0;
    this.lastSpeechAtMs = 0;
  }
}
