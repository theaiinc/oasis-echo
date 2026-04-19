import { decodeBase64Pcm16, scheduleChunk } from '../directives.js';
import type { TtsDirectives } from '../types.js';

export type AudioPlayerOpts = {
  /**
   * AudioContext to use. One is created lazily if omitted. Passing your
   * own lets you share the same context with mic capture (cheaper) and
   * survive Safari's autoplay policy if you've already resumed it.
   */
  audioContext?: AudioContext;
  /**
   * Optional master output. Defaults to the context's destination.
   * Useful when routing through a WebRTC loopback for AEC.
   */
  destinationNode?: AudioNode;
  /** Fires whenever the last queued chunk finishes playing. */
  onEnd?: () => void;
};

export type PlayPcmOpts = {
  /** The turnId owning this chunk — links to `setDirectives(turnId, ...)`. */
  turnId?: string;
  /** True for filler / backchannel chunks (skips emotion adaptation). */
  filler?: boolean;
  /** Extra linear gain factor composed with emotion gain. Default 1. */
  gain?: number;
};

/**
 * Thin wrapper around Web Audio that applies per-turn emotion directives
 * (playback rate, gain, inter-chunk silence) when playing back PCM chunks
 * the server broadcasts via `tts.chunk` events.
 *
 * One player per session. Call `setDirectives(turnId, directives)` when
 * an `emotion.directives` event arrives; the matching tts chunks for
 * that turn will apply them automatically.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private readonly ctxProvided: AudioContext | null;
  private readonly destinationNode: AudioNode | null;
  private readonly onEnd?: () => void;
  private readonly directivesByTurn = new Map<string, TtsDirectives>();
  private queueEndsAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  constructor(opts: AudioPlayerOpts = {}) {
    this.ctxProvided = opts.audioContext ?? null;
    this.destinationNode = opts.destinationNode ?? null;
    if (opts.onEnd) this.onEnd = opts.onEnd;
  }

  /** Ensure the AudioContext exists and is running. Call in response to a
   *  user gesture in browsers that enforce autoplay policy. */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.ctxProvided ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Record directives for a turn so subsequent chunks apply them. */
  setDirectives(turnId: string, directives: TtsDirectives): void {
    this.directivesByTurn.set(turnId, directives);
  }

  /** Forget directives for a finished/abandoned turn. Call this on
   *  `turn.complete` and `bargein` so the map doesn't grow forever. */
  forgetDirectives(turnId: string): void {
    this.directivesByTurn.delete(turnId);
  }

  /**
   * Play a base64 PCM chunk. Applies the directives registered for its
   * owning turn unless the chunk is a filler.
   */
  playPcm(base64: string, sampleRate: number, opts: PlayPcmOpts = {}): AudioBufferSourceNode {
    const ctx = this.ensureContext();
    const dest = this.destinationNode ?? ctx.destination;
    const float = decodeBase64Pcm16(base64);
    const buffer = ctx.createBuffer(1, float.length, sampleRate);
    buffer.getChannelData(0).set(float);
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const dir =
      opts.turnId && !opts.filler ? this.directivesByTurn.get(opts.turnId) : undefined;
    const plan = scheduleChunk({
      ctxTime: ctx.currentTime,
      queueEndsAt: this.queueEndsAt,
      chunkDurationSec: buffer.duration,
      ...(dir ? { directives: dir } : {}),
      ...(opts.gain !== undefined ? { extraGain: opts.gain } : {}),
    });

    if (plan.playbackRate !== 1) src.playbackRate.value = plan.playbackRate;

    let target: AudioNode = dest;
    if (plan.gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = plan.gain;
      g.connect(dest);
      target = g;
    }
    src.connect(target);

    this.queueEndsAt = plan.endAt;
    src.start(plan.startAt);
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0) this.onEnd?.();
    };
    return src;
  }

  /** Stop all currently-playing and queued audio. */
  stopAll(): void {
    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.activeSources.clear();
    this.queueEndsAt = 0;
  }

  /** Read-only snapshot of queue depth — useful for debugging overlaps. */
  get activeCount(): number {
    return this.activeSources.size;
  }
}
