import type { TtsDirectives } from './types.js';

export type ChunkPlaybackPlan = {
  /** Absolute `AudioContext.currentTime` at which to start this chunk. */
  startAt: number;
  /** Absolute time at which this chunk will end (used to advance the queue head). */
  endAt: number;
  /** Playback-rate multiplier to apply to the buffer source. */
  playbackRate: number;
  /** Linear gain multiplier to apply. */
  gain: number;
};

export type ScheduleOpts = {
  /** `audioContext.currentTime` at scheduling moment. */
  ctxTime: number;
  /** Running tail of the playback queue (previous chunk's `endAt`). */
  queueEndsAt: number;
  /** Duration (seconds) of the raw PCM buffer, before any rate change. */
  chunkDurationSec: number;
  /** Emotion directives for the owning turn. Optional — omit for neutral. */
  directives?: TtsDirectives;
  /**
   * Extra gain factor composed on top of the emotion gain (e.g. a per-chunk
   * filler ducking level). 1 = no extra adjustment.
   */
  extraGain?: number;
};

/**
 * Pure function that turns a chunk's duration + the current queue head +
 * optional emotion directives into a concrete playback plan. Used by the
 * browser `AudioPlayer` (and any Node adapter) so the scheduling math
 * lives in one well-tested place.
 */
export function scheduleChunk(opts: ScheduleOpts): ChunkPlaybackPlan {
  const dir = opts.directives;
  const rate = dir && typeof dir.playbackRate === 'number' ? dir.playbackRate : 1;
  const emoGain = dir && typeof dir.gain === 'number' ? dir.gain : 1;
  const gain = emoGain * (opts.extraGain ?? 1);
  const extraSilenceSec =
    dir && typeof dir.interChunkSilenceMs === 'number'
      ? dir.interChunkSilenceMs / 1000
      : 0;
  const effectiveDuration = opts.chunkDurationSec / (rate || 1);
  const startAt = Math.max(opts.ctxTime, opts.queueEndsAt + extraSilenceSec);
  const endAt = startAt + effectiveDuration;
  return { startAt, endAt, playbackRate: rate, gain };
}

/**
 * Decode a base64 PCM payload the server sends in tts.chunk events into
 * a Float32Array at [-1, 1]. Works in both browsers (global `atob`) and
 * Node 20+ (global `atob` available).
 */
export function decodeBase64Pcm16(base64: string): Float32Array {
  const bin = globalThis.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}
