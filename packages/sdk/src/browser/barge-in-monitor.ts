import { speechBand } from './energy-vad.js';

export type BargeInMonitorOpts = {
  /** User voice must exceed baseline × this multiplier. Default 1.6. */
  baselineMultiplier?: number;
  /** Absolute minimum RMS delta above silence required to trigger. Default 6. */
  absoluteFloor?: number;
  /** How long (ms) signal must stay above threshold before ducking the agent. Default 120. */
  holdMs?: number;
  /**
   * After ducking, the sound must stay above threshold for this much of the
   * confirm window (ms) to count as the user talking. Default 450.
   */
  confirmMs?: number;
  /** How long (ms) to wait for that confirmation before un-ducking. Default 900. */
  confirmWindowMs?: number;
  /**
   * Called with true when a possible interruption starts (lower the agent's
   * volume) and false when it turned out to be noise or the agent stopped.
   */
  onDuck?: (ducked: boolean) => void;
  /**
   * Grace window after `isActive()` flips to true — during this period
   * the monitor observes-but-does-not-fire so the adaptive baseline can
   * stabilize around the actual agent-audio-bleed level. Without this,
   * the very first audio frames blow past the still-zero baseline and
   * trigger a false-positive interrupt right as the agent starts
   * speaking. Default 600ms.
   */
  graceMs?: number;
  /** FFT size for the AnalyserNode. Default 512. */
  fftSize?: number;
  /** Called when sustained signal above threshold is detected. */
  onBargeIn: () => void;
  /**
   * Boolean callback — return true whenever the monitor should be ACTIVE
   * (typically "agent is speaking"). When it returns false, the monitor
   * idles and resets its baseline.
   */
  isActive: () => boolean;
};

/**
 * Adaptive volume-monitor barge-in detector.
 *
 * Two stages, so a clatter, cough or door doesn't cut the agent off: a short
 * burst over the threshold only ducks the agent (`onDuck(true)`); it counts as
 * an interruption (`onBargeIn`) once the sound has stayed up for `confirmMs`
 * of the next `confirmWindowMs`, like someone actually talking. Otherwise the
 * volume comes back (`onDuck(false)`). Levels are read in the speech band.
 *
 * Builds a moving baseline of ambient RMS while agent TTS is playing
 * (that's the agent's own audio bleeding back through the mic + AEC
 * residual). User voice has to exceed that baseline by a multiplier
 * AND clear an absolute floor AND hold above threshold for `holdMs`.
 *
 * Runs off a `requestAnimationFrame` loop reading from an existing
 * `AnalyserNode`. Caller is responsible for routing mic → analyser.
 */
export class BargeInMonitor {
  private multiplier: number;
  private absoluteFloor: number;
  private readonly defaults: { multiplier: number; absoluteFloor: number; confirmMs: number };
  private readonly holdMs: number;
  private confirmMs: number;
  private readonly confirmWindowMs: number;
  private readonly onDuck: ((ducked: boolean) => void) | undefined;
  private readonly graceMs: number;
  private readonly fftSize: number;
  private readonly onBargeIn: () => void;
  private readonly isActive: () => boolean;

  private running = false;
  private analyser: AnalyserNode | null = null;
  private band: AudioNode | null = null;
  /** When the agent was ducked for a possible interruption (0: not ducked). */
  private duckedAt = 0;
  /** Time above threshold since ducking. */
  private aboveFor = 0;
  private lastFrame = 0;
  /** Last time the level was above threshold (dips between syllables are tolerated). */
  private lastAboveAt = 0;
  // Typed against a plain ArrayBuffer view — DOM AnalyserNode requires
  // `Uint8Array<ArrayBuffer>` specifically, not `Uint8Array<ArrayBufferLike>`.
  private buf: Uint8Array<ArrayBuffer> | null = null;
  private aboveSince = 0;
  private bgRms = 0;
  /** Set to performance.now() when isActive transitions false → true. */
  private activeSince = 0;

  constructor(opts: BargeInMonitorOpts) {
    this.multiplier = opts.baselineMultiplier ?? 1.6;
    this.absoluteFloor = opts.absoluteFloor ?? 6;
    this.holdMs = opts.holdMs ?? 120;
    this.confirmMs = opts.confirmMs ?? 450;
    this.confirmWindowMs = opts.confirmWindowMs ?? 900;
    this.onDuck = opts.onDuck;
    this.defaults = { multiplier: this.multiplier, absoluteFloor: this.absoluteFloor, confirmMs: this.confirmMs };
    this.graceMs = opts.graceMs ?? 600;
    this.fftSize = opts.fftSize ?? 512;
    this.onBargeIn = opts.onBargeIn;
    this.isActive = opts.isActive;
  }

  /** Attach to a MediaStreamAudioSourceNode and begin the rAF loop. */
  start(source: AudioNode): void {
    if (this.running) return;
    const ctx = source.context;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    this.band = speechBand(ctx, source);
    this.band.connect(analyser);
    this.analyser = analyser;
    this.buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.unduck();
    try { this.analyser?.disconnect(); } catch { /* ignore */ }
    try { this.band?.disconnect(); } catch { /* ignore */ }
    this.band = null;
    this.analyser = null;
    this.buf = null;
  }

  /**
   * On a headset (Bluetooth or wired) the agent's voice doesn't reach the mic,
   * so a quieter, shorter sound can count as the user talking. On a loudspeaker
   * the defaults stay strict, since the agent's own voice bleeds back.
   */
  setHeadset(on: boolean): void {
    const d = this.defaults;
    this.absoluteFloor = on ? Math.max(3, d.absoluteFloor * 0.6) : d.absoluteFloor;
    this.multiplier = on ? Math.max(1.3, d.multiplier * 0.85) : d.multiplier;
    this.confirmMs = on ? Math.round(d.confirmMs * 0.7) : d.confirmMs;
  }

  /** Expose the analyser in case the host wants to share it elsewhere. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  private unduck(): void {
    if (!this.duckedAt) return;
    this.duckedAt = 0;
    this.aboveFor = 0;
    this.onDuck?.(false);
  }

  private tick = (): void => {
    if (!this.running) return;
    const analyser = this.analyser;
    const buf = this.buf;
    if (!analyser || !buf) return;
    if (!this.isActive()) {
      this.unduck();
      this.aboveSince = 0;
      this.bgRms = 0;
      this.activeSince = 0;
      this.lastFrame = 0;
      requestAnimationFrame(this.tick);
      return;
    }
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 0;
    this.lastFrame = now;
    // Record when we first become active so the grace window below can
    // be measured against it.
    if (this.activeSince === 0) this.activeSince = now;
    analyser.getByteTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const d = buf[i]! - 128;
      sumSq += d * d;
    }
    this.level(Math.sqrt(sumSq / buf.length), now, dt);
    requestAnimationFrame(this.tick);
  };

  /** One level reading while the agent speaks (exposed for tests). */
  level(rms: number, now: number, dt: number): void {
    if (this.activeSince === 0) this.activeSince = now;
    const thresh = Math.max(this.absoluteFloor, this.bgRms * this.multiplier);
    const above = rms > thresh;

    // Stage 2: ducked, waiting to see whether it's really the user talking.
    if (this.duckedAt) {
      if (above) this.aboveFor += dt;
      if (this.aboveFor >= this.confirmMs) {
        this.duckedAt = 0;
        this.aboveFor = 0;
        this.aboveSince = 0;
        this.onBargeIn();
      } else if (now - this.duckedAt >= this.confirmWindowMs) {
        this.unduck(); // a blip of noise: carry on
        this.aboveSince = 0;
      }
      return;
    }

    // Stage 1: a short burst over the threshold ducks the agent. During grace we
    // only observe, so the baseline can adapt to the first agent-audio bleed.
    const inGrace = now - this.activeSince < this.graceMs;
    if (above) {
      this.lastAboveAt = now;
      if (this.aboveSince === 0) this.aboveSince = now;
      else if (now - this.aboveSince >= this.holdMs && !inGrace) {
        this.duckedAt = now;
        this.aboveFor = now - this.aboveSince;
        this.onDuck?.(true);
      }
    } else if (this.aboveSince && now - this.lastAboveAt < 80) {
      // A dip between syllables: keep counting, and keep it out of the baseline.
    } else {
      this.aboveSince = 0;
      // Only update baseline when BELOW threshold so user voice doesn't
      // pull the baseline up and hide itself.
      this.bgRms = this.bgRms === 0 ? rms : this.bgRms * 0.88 + rms * 0.12;
    }
  }

}
