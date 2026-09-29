/**
 * Voice activity from the mic's loudness alone, for when the browser's
 * SpeechRecognition can't be used to notice speech (Chrome on Android
 * reports "network" when it can't reach Google's speech service; some
 * browsers have none). Tracks the room's noise floor and calls `onStart`
 * when the level rises well above it, `onEnd` after `endSilenceMs` of quiet.
 */
export type EnergyVadOpts = {
  /** Called on each frame: false while the agent speaks, so its voice doesn't count. */
  isListening?: () => boolean;
  onStart: () => void;
  onEnd: () => void;
  /** Level above the noise floor, as a ratio, that counts as speech. Default 3. */
  ratio?: number;
  /** Absolute RMS floor for speech (0–1). Default 0.012. */
  minRms?: number;
  /** Speech must last this long to start an utterance. Default 150 ms. */
  startMs?: number;
  /** Quiet this long ends it. Default 900 ms. */
  endSilenceMs?: number;
  /** Longest utterance before it is cut. Default 20 s. */
  maxUtteranceMs?: number;
  frameMs?: number;
};

export class EnergyVad {
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private floor = 0.005;
  private speaking = false;
  private loudSince = 0;
  private quietSince = 0;
  private startedAt = 0;

  constructor(private readonly opts: EnergyVadOpts) {}

  get active(): boolean {
    return this.speaking;
  }

  start(ctx: AudioContext, source: AudioNode): void {
    this.stop();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    this.analyser = analyser;
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      this.frame(Math.sqrt(sum / buf.length), performance.now());
    }, this.opts.frameMs ?? 30);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.analyser?.disconnect(); } catch { /* already gone */ }
    this.analyser = null;
    this.speaking = false;
  }

  /** One level reading (exposed for tests). */
  frame(rms: number, now: number): void {
    const listening = this.opts.isListening?.() ?? true;
    const threshold = Math.max(this.opts.minRms ?? 0.012, this.floor * (this.opts.ratio ?? 3));
    const loud = rms > threshold;
    if (!this.speaking) {
      // The floor follows the room while nobody talks.
      if (!loud) this.floor = this.floor * 0.95 + rms * 0.05;
      if (!listening || !loud) { this.loudSince = 0; return; }
      if (!this.loudSince) this.loudSince = now;
      if (now - this.loudSince >= (this.opts.startMs ?? 150)) {
        this.speaking = true;
        this.startedAt = now;
        this.quietSince = 0;
        this.opts.onStart();
      }
      return;
    }
    if (loud) this.quietSince = 0;
    else if (!this.quietSince) this.quietSince = now;
    const quietFor = this.quietSince ? now - this.quietSince : 0;
    if (quietFor >= (this.opts.endSilenceMs ?? 900) || now - this.startedAt >= (this.opts.maxUtteranceMs ?? 20_000) || !listening) {
      this.speaking = false;
      this.loudSince = 0;
      this.opts.onEnd();
    }
  }
}
