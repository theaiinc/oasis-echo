import type { AudioFrame } from '@oasis-echo/types';

export type VadFrameResult = {
  speech: boolean;
  probability: number;
  atMs: number;
};

/**
 * Voice Activity Detection interface. Real implementations plug in
 * here: Silero-VAD over ONNX Runtime on the NPU for production, or
 * equivalent native code. No implementation ships in this repo —
 * the browser client currently does its own VAD via the Web Audio
 * API's AnalyserNode for barge-in detection.
 */
export interface Vad {
  process(frame: AudioFrame): VadFrameResult;
  reset(): void;
}
