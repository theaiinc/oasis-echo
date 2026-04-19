import { resampleTo16k } from './mic-capture.js';

export type EmotionDetectorOpts = {
  /** HuggingFace model id. Default: onnx-community SER 8-class. */
  modelId?: string;
  /** ONNX quantization level. Default 'q8' (~91MB). */
  dtype?: 'q8' | 'q4' | 'fp16' | 'fp32';
  /** Top-1 confidence floor. Below this, detect returns null. Default 0.7. */
  minConfidence?: number;
  /** Required margin over the #2 prediction. Default 0.15. */
  minMargin?: number;
  /**
   * Which raw classifier labels are considered informative. By default
   * we drop SAD/NEUTRAL/CALM because the acted-speech training data
   * causes them to over-fire on casual conversational English. Text
   * emotion detection on the server catches meaning-driven cases.
   * Pass an empty set to accept all labels.
   */
  informativeLabels?: Set<string>;
  /**
   * Import hook — pass a custom loader to override the transformers.js
   * location (useful to pin a specific CDN in production). Default
   * dynamic-imports `@huggingface/transformers`.
   */
  loader?: () => Promise<{ pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown> }>;
};

export type EmotionResult = {
  label: string;
  confidence: number;
  top3: Array<{ label: string; score: number }>;
};

const DEFAULT_MODEL = 'onnx-community/Speech-Emotion-Classification-ONNX';
const DEFAULT_INFORMATIVE = new Set([
  'HAP', 'happy', 'happiness',
  'SUR', 'surprise', 'surprised',
  'ANG', 'angry',
  'FEA', 'fear', 'fearful',
  'DIS', 'disgust',
]);

type ClassifyFn = (
  input: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<Array<{ label: string; score: number }>>;

/**
 * Browser-side Speech Emotion Recognition wrapper around transformers.js.
 *
 * Lifecycle:
 *   1. `preload()` on voice-on so the ~91MB ONNX downloads in parallel
 *      with the user's first utterance instead of blocking it.
 *   2. `classify(pcm, sourceRate)` at turn-commit time. Applies the
 *      confidence floor + margin gate + informative-label filter before
 *      returning — falsy return = "no usable signal".
 */
export class EmotionDetector {
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly minConfidence: number;
  private readonly minMargin: number;
  private readonly informative: Set<string>;
  private readonly loader: NonNullable<EmotionDetectorOpts['loader']>;

  private loadPromise: Promise<ClassifyFn | null> | null = null;
  private pipeline: ClassifyFn | null = null;
  private loadFailed = false;

  constructor(opts: EmotionDetectorOpts = {}) {
    this.modelId = opts.modelId ?? DEFAULT_MODEL;
    this.dtype = opts.dtype ?? 'q8';
    this.minConfidence = opts.minConfidence ?? 0.7;
    this.minMargin = opts.minMargin ?? 0.15;
    this.informative = opts.informativeLabels ?? DEFAULT_INFORMATIVE;
    this.loader =
      opts.loader ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((): Promise<any> =>
        import(/* @vite-ignore */ '@huggingface/transformers' as string));
  }

  /** Start (or observe) the model-load. Safe to call repeatedly. */
  preload(): Promise<ClassifyFn | null> {
    if (this.pipeline) return Promise.resolve(this.pipeline);
    if (this.loadFailed) return Promise.resolve(null);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const lib = await this.loader();
          const p = (await lib.pipeline('audio-classification', this.modelId, {
            dtype: this.dtype,
          })) as ClassifyFn;
          this.pipeline = p;
          return p;
        } catch (err) {
          this.loadFailed = true;
          // eslint-disable-next-line no-console
          console.warn('[emotion] pipeline load failed', err);
          return null;
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * Classify a PCM snapshot. Returns `null` when:
   *   - the pipeline failed to load
   *   - `timeoutMs` elapses first
   *   - the top-1 label isn't in the informative set
   *   - the top-1 confidence or margin is below the gates
   */
  async classify(
    pcm: Float32Array,
    sourceRate: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<EmotionResult | null> {
    const pipeline = await Promise.race<ClassifyFn | null>([
      this.preload(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 2000)),
    ]);
    if (!pipeline) return null;
    const resampled = resampleTo16k(pcm, sourceRate);
    let preds: Array<{ label: string; score: number }> | null = null;
    try {
      preds = await Promise.race<Array<{ label: string; score: number }> | null>([
        pipeline(resampled, { sampling_rate: 16000 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 2000)),
      ]);
    } catch {
      return null;
    }
    if (!Array.isArray(preds) || preds.length === 0) return null;
    const top = preds[0]!;
    const second = preds[1] ?? { score: 0 };
    if (this.informative.size > 0 && !this.informative.has(top.label)) return null;
    if (typeof top.score !== 'number' || top.score < this.minConfidence) return null;
    if (top.score - (second.score || 0) < this.minMargin) return null;
    return { label: top.label, confidence: top.score, top3: preds.slice(0, 3) };
  }
}
