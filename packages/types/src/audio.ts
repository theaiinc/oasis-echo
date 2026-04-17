export const SAMPLE_RATE_HZ = 16_000;
export const FRAME_DURATION_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE_HZ * FRAME_DURATION_MS) / 1000;

export type AudioFrame = {
  readonly pcm: Int16Array;
  readonly sampleRate: number;
  readonly capturedAtMs: number;
  readonly sequence: number;
};

export type AudioChunk = {
  readonly pcm: Int16Array;
  readonly sampleRate: number;
  readonly durationMs: number;
};
