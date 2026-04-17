import type { AudioFrame } from '@oasis-echo/types';

export type VadFrameResult = {
  speech: boolean;
  probability: number;
  atMs: number;
};

export interface Vad {
  process(frame: AudioFrame): VadFrameResult;
  reset(): void;
}

/**
 * Energy-based VAD used as a test/fallback implementation.
 * Production replaces this with Silero-VAD via ONNX on the NPU.
 */
export class EnergyVad implements Vad {
  private readonly threshold: number;
  private baseline = 0;

  constructor(opts: { threshold?: number } = {}) {
    this.threshold = opts.threshold ?? 0.02;
  }

  process(frame: AudioFrame): VadFrameResult {
    let sumSq = 0;
    for (let i = 0; i < frame.pcm.length; i++) {
      const s = frame.pcm[i]! / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, frame.pcm.length));
    this.baseline = this.baseline * 0.95 + rms * 0.05;
    const probability = Math.min(1, rms / (this.threshold + this.baseline));
    return {
      speech: rms > this.threshold + this.baseline,
      probability,
      atMs: frame.capturedAtMs,
    };
  }

  reset(): void {
    this.baseline = 0;
  }
}
