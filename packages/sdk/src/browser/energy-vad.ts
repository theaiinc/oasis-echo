/**
 * Voice activity from the mic's loudness alone, for when the browser's
 * SpeechRecognition can't be used to notice speech (Chrome on Android
 * reports "network" when it can't reach Google's speech service; some
 * browsers have none). Tracks the room's noise floor and calls `onStart`
 * when the level rises well above it, `onEnd` after `endSilenceMs` of quiet.
 *
 * Background noise: the level is measured in the speech band only (a fan's
 * hum or traffic rumble barely counts), and steady noise is told apart from
 * talking by its lack of gaps — speech always dips between words, a TV or a
 * running tap doesn't. When an "utterance" never dips for `noiseCheckMs`, the
 * noise floor is raised to that level and the utterance is dropped
 * (`onCancel`), so the room's noise can't hold the turn open forever.
 */
export type EnergyVadOpts = {
  /** Called on each frame: false while the agent speaks, so its voice doesn't count. */
  isListening?: () => boolean;
  onStart: () => void;
  onEnd: () => void;
  /** The started utterance was steady noise, not speech: drop it. Default: `onEnd`. */
  onCancel?: () => void;
  /** Level above the noise floor, as a ratio, that counts as speech. Default 3. */
  ratio?: number;
  /** Absolute RMS floor for speech (0–1), in the speech band. Default 0.01. */
  minRms?: number;
  /** Speech must last this long to start an utterance. Default 150 ms. */
  startMs?: number;
  /** Quiet this long ends it. Default 900 ms. */
  endSilenceMs?: number;
  /** Longest utterance before it is cut. Default 20 s. */
  maxUtteranceMs?: number;
  /** An utterance with no dip below the threshold for this long is noise. Default 3000 ms. */
  noiseCheckMs?: number;
  frameMs?: number;
};

/** Speech band used for the level: below it is hum and rumble, above it hiss. */
export const SPEECH_BAND_HZ = { low: 250, high: 3800 } as const;

/** mic → high-pass → low-pass, so a level reading covers the speech band only. */
export function speechBand(ctx: BaseAudioContext, source: AudioNode): AudioNode {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = SPEECH_BAND_HZ.low;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = SPEECH_BAND_HZ.high;
  source.connect(hp);
  hp.connect(lp);
  return lp;
}

export class EnergyVad {
  private analyser: AnalyserNode | null = null;
  private band: AudioNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private floor = 0.005;
  private speaking = false;
  private loudSince = 0;
  private quietSince = 0;
  private startedAt = 0;
  /** Since when the level has stayed above the threshold without a dip. */
  private unbrokenSince = 0;
  /** Lowest level seen during the current unbroken stretch. */
  private unbrokenMin = Infinity;

  constructor(private readonly opts: EnergyVadOpts) {}

  get active(): boolean {
    return this.speaking;
  }

  /** The current noise floor (exposed for tests and diagnostics). */
  get noiseFloor(): number {
    return this.floor;
  }

  start(ctx: AudioContext, source: AudioNode): void {
    this.stop();
    const band = speechBand(ctx, source);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    band.connect(analyser);
    this.band = band;
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
    try { this.band?.disconnect(); } catch { /* already gone */ }
    this.analyser = null;
    this.band = null;
    this.speaking = false;
  }

  /** One level reading (exposed for tests). */
  frame(rms: number, now: number): void {
    const listening = this.opts.isListening?.() ?? true;
    const threshold = Math.max(this.opts.minRms ?? 0.01, this.floor * (this.opts.ratio ?? 3));
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
        this.unbrokenSince = this.loudSince;
        this.unbrokenMin = rms;
        this.opts.onStart();
      }
      return;
    }
    if (loud) {
      this.quietSince = 0;
      if (!this.unbrokenSince) { this.unbrokenSince = now; this.unbrokenMin = rms; }
      this.unbrokenMin = Math.min(this.unbrokenMin, rms);
    } else {
      if (!this.quietSince) this.quietSince = now;
      this.unbrokenSince = 0;
    }
    // No gap between words for this long: it's the room, not someone talking. Treat
    // that level as the new floor (so it stops counting as speech) and drop the utterance.
    if (this.unbrokenSince && now - this.unbrokenSince >= (this.opts.noiseCheckMs ?? 3000)) {
      this.floor = Math.max(this.floor, this.unbrokenMin);
      this.speaking = false;
      this.loudSince = 0;
      this.unbrokenSince = 0;
      (this.opts.onCancel ?? this.opts.onEnd)();
      return;
    }
    const quietFor = this.quietSince ? now - this.quietSince : 0;
    if (quietFor >= (this.opts.endSilenceMs ?? 900) || now - this.startedAt >= (this.opts.maxUtteranceMs ?? 20_000) || !listening) {
      this.speaking = false;
      this.loudSince = 0;
      this.unbrokenSince = 0;
      this.opts.onEnd();
    }
  }
}
