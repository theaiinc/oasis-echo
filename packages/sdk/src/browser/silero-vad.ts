/**
 * Voice activity from Silero VAD v5 (onnxruntime-web, WASM), fed the same
 * 16 kHz mic audio the server's STT gets (`AudioStreamUpload.onPcm`). Unlike
 * `EnergyVad` it tells speech from loud non-speech, so a noisy room — and,
 * after the noise filter, most of a café's chatter — doesn't hold a turn open.
 * Same callbacks as `EnergyVad`, so the session can use either.
 *
 * Measured on a 75 s recording in a noisy room (experiments/noise/eval.mjs):
 * on the raw mic it heard one unbroken 31 s "utterance"; after DeepFilterNet
 * it found the speaker's pauses, ending turns every 5–10 s.
 *
 * `onnxruntime-web/wasm` (the CPU-only build) is imported on `load()`, so
 * pages that don't use this don't need it (the demo page maps it to
 * /vendor/onnxruntime-web; a bundler bundles it).
 */

import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';

export type SileroVadOpts = {
  /** `silero_vad_v5.onnx`. */
  modelUrl: string;
  /** onnxruntime-web's `ort-wasm-simd-threaded.wasm`. */
  ortWasmUrl: string;
  /** Called per frame: false while the agent speaks, so its voice doesn't count. */
  isListening?: () => boolean;
  onStart: () => void;
  onEnd: () => void;
  /** The started utterance had too little speech in it (a cough, a door): drop it. Default: `onEnd`. */
  onCancel?: () => void;
  /** Speech probability that counts as speech. Default 0.5. */
  positiveThreshold?: number;
  /** Below this it counts as a pause. Default 0.35. */
  negativeThreshold?: number;
  /** Speech this long starts an utterance. Default 96 ms (3 frames). */
  startMs?: number;
  /** A pause this long ends it. Default 700 ms. */
  endSilenceMs?: number;
  /** An utterance with less speech than this is dropped (`onCancel`). Default 250 ms. */
  minSpeechMs?: number;
  /** Longest utterance before it is cut. Default 20 s. */
  maxUtteranceMs?: number;
};

const FRAME = 512; // samples at 16 kHz: 32 ms, the size Silero v5 takes
const FRAME_MS = 32;

type Ort = typeof import('onnxruntime-web/wasm');

export class SileroVad {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;
  private state: Tensor | null = null;
  private sr: Tensor | null = null;
  private readonly pending = new Float32Array(FRAME);
  private pendingLen = 0;
  private readonly queue: Float32Array[] = [];
  private running = false;
  private stopped = false;

  private speaking = false;
  private speechRun = 0;
  private silenceRun = 0;
  private speechMs = 0;
  private utteranceMs = 0;

  constructor(private readonly opts: SileroVadOpts) {}

  get active(): boolean {
    return this.speaking;
  }

  /** Load the runtime and the model. Throws if either can't be fetched. */
  async load(): Promise<void> {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.wasmPaths = { wasm: this.opts.ortWasmUrl };
    // Threads need a cross-origin-isolated page; one thread runs a frame in well under 1 ms.
    ort.env.wasm.numThreads = 1;
    this.session = await ort.InferenceSession.create(this.opts.modelUrl, { executionProviders: ['wasm'] });
    this.ort = ort;
    this.resetModel();
  }

  /** 16 kHz mono samples, any block size. */
  push(samples: Float32Array): void {
    if (this.stopped || !this.session) return;
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(FRAME - this.pendingLen, samples.length - i);
      this.pending.set(samples.subarray(i, i + n), this.pendingLen);
      this.pendingLen += n;
      i += n;
      if (this.pendingLen === FRAME) {
        this.queue.push(this.pending.slice());
        this.pendingLen = 0;
      }
    }
    // Inference is async; frames are run one at a time, in order. A backlog
    // (a background tab) is trimmed so the VAD catches up instead of lagging.
    if (this.queue.length > 30) this.queue.splice(0, this.queue.length - 30);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.speaking = false;
    void this.session?.release().catch(() => {});
    this.session = null;
  }

  private resetModel(): void {
    const ort = this.ort!;
    this.state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && this.session && !this.stopped) {
        const frame = this.queue.shift()!;
        const out = await this.session.run({
          input: new this.ort!.Tensor('float32', frame, [1, FRAME]),
          state: this.state!,
          sr: this.sr!,
        });
        this.state = out.stateN as Tensor;
        this.frame((out.output as Tensor).data[0] as number);
      }
    } catch {
      // A failed run leaves the state as it was; the next frame tries again.
    } finally {
      this.running = false;
    }
  }

  /** One speech probability (exposed for tests). */
  frame(p: number): void {
    const listening = this.opts.isListening?.() ?? true;
    const on = this.opts.positiveThreshold ?? 0.5;
    const off = this.opts.negativeThreshold ?? 0.35;
    if (!this.speaking) {
      this.speechRun = listening && p >= on ? this.speechRun + FRAME_MS : 0;
      if (this.speechRun >= (this.opts.startMs ?? 96)) {
        this.speaking = true;
        this.speechMs = this.speechRun;
        this.utteranceMs = this.speechRun;
        this.silenceRun = 0;
        this.opts.onStart();
      }
      return;
    }
    this.utteranceMs += FRAME_MS;
    if (p >= on) this.speechMs += FRAME_MS;
    this.silenceRun = p < off ? this.silenceRun + FRAME_MS : 0;
    const ended =
      !listening ||
      this.silenceRun >= (this.opts.endSilenceMs ?? 700) ||
      this.utteranceMs >= (this.opts.maxUtteranceMs ?? 20_000);
    if (!ended) return;
    this.speaking = false;
    this.speechRun = 0;
    if (this.speechMs < (this.opts.minSpeechMs ?? 250)) (this.opts.onCancel ?? this.opts.onEnd)();
    else this.opts.onEnd();
  }
}
