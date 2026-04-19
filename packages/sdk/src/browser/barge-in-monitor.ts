export type BargeInMonitorOpts = {
  /** User voice must exceed baseline × this multiplier. Default 1.6. */
  baselineMultiplier?: number;
  /** Absolute minimum RMS delta above silence required to trigger. Default 6. */
  absoluteFloor?: number;
  /** How long (ms) signal must stay above threshold before firing. Default 100. */
  holdMs?: number;
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
 * Builds a moving baseline of ambient RMS while agent TTS is playing
 * (that's the agent's own audio bleeding back through the mic + AEC
 * residual). User voice has to exceed that baseline by a multiplier
 * AND clear an absolute floor AND hold above threshold for `holdMs`.
 *
 * Runs off a `requestAnimationFrame` loop reading from an existing
 * `AnalyserNode`. Caller is responsible for routing mic → analyser.
 */
export class BargeInMonitor {
  private readonly multiplier: number;
  private readonly absoluteFloor: number;
  private readonly holdMs: number;
  private readonly graceMs: number;
  private readonly fftSize: number;
  private readonly onBargeIn: () => void;
  private readonly isActive: () => boolean;

  private running = false;
  private analyser: AnalyserNode | null = null;
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
    this.holdMs = opts.holdMs ?? 100;
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
    source.connect(analyser);
    this.analyser = analyser;
    this.buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    try { this.analyser?.disconnect(); } catch { /* ignore */ }
    this.analyser = null;
    this.buf = null;
  }

  /** Expose the analyser in case the host wants to share it elsewhere. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  private tick = (): void => {
    if (!this.running) return;
    const analyser = this.analyser;
    const buf = this.buf;
    if (!analyser || !buf) return;
    if (!this.isActive()) {
      this.aboveSince = 0;
      this.bgRms = 0;
      this.activeSince = 0;
      requestAnimationFrame(this.tick);
      return;
    }
    const now = performance.now();
    // Record when we first become active so the grace window below can
    // be measured against it.
    if (this.activeSince === 0) this.activeSince = now;
    analyser.getByteTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const d = buf[i]! - 128;
      sumSq += d * d;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    const thresh = Math.max(this.absoluteFloor, this.bgRms * this.multiplier);
    const inGrace = now - this.activeSince < this.graceMs;
    if (rms > thresh) {
      if (this.aboveSince === 0) {
        this.aboveSince = now;
      } else if (now - this.aboveSince > this.holdMs && !inGrace) {
        // Hold satisfied AND we're past the grace window — fire.
        // During grace we deliberately observe-but-don't-fire so the
        // baseline has a chance to adapt to whatever audio bleed the
        // first agent-TTS frames are producing.
        this.aboveSince = 0;
        this.onBargeIn();
      }
    } else {
      this.aboveSince = 0;
      // Only update baseline when BELOW threshold so user voice doesn't
      // pull the baseline up and hide itself.
      this.bgRms = this.bgRms === 0 ? rms : this.bgRms * 0.88 + rms * 0.12;
    }
    requestAnimationFrame(this.tick);
  };
}
