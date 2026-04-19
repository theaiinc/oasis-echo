import type { Logger } from '@oasis-echo/telemetry';

/**
 * Streaming speech-to-text via `@huggingface/transformers` (Whisper).
 *
 * Whisper isn't truly streaming — it processes fixed-length audio
 * windows. This wrapper gives the illusion of streaming by keeping a
 * rolling buffer and re-transcribing the tail every `partialEveryMs`.
 * Emits progressively longer partials; the final full utterance arrives
 * when the caller invokes `transcribeAll()`.
 *
 * Input: `Float32Array` samples in `[-1, 1]` at 16 kHz mono.
 */

export type WhisperStreamingSttOpts = {
  /**
   * HuggingFace model id. Default `Xenova/whisper-base.en` (~74M params,
   * ~100MB q8). `whisper-tiny.en` is ~40MB and faster but has
   * noticeably worse accuracy on conversational English — it
   * hallucinates "You" / "Thank you" etc on non-speech segments and
   * swaps common words on real speech. Base is the sweet spot.
   */
  modelId?: string;
  /** ONNX dtype. Default 'q8'. */
  dtype?: 'q4' | 'q8' | 'fp16' | 'fp32';
  /** Max seconds of audio to keep in the rolling buffer. Default 30. */
  maxBufferSeconds?: number;
  /**
   * How often to produce a partial once there's enough audio. Default
   * 900ms — Whisper needs a beat between inferences on a busy CPU,
   * and partials landing any faster than this just replace each other
   * in the UI before the user can read them anyway.
   */
  partialEveryMs?: number;
  /**
   * Minimum buffered audio before we bother running Whisper. Default
   * 1.2s — Whisper hallucinates severely on windows shorter than ~1s
   * of actual speech (common outputs: "You", "Thank you.", "Yeah.").
   * Waiting for enough context keeps the first partial honest.
   */
  minBufferSeconds?: number;
  /**
   * Hook for injecting a custom transformers.js loader. Default
   * dynamic-imports `@huggingface/transformers`.
   */
  loader?: () => Promise<{
    pipeline: (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>;
  }>;
  logger?: Logger;
};

// Backwards-compat alias retained so existing imports don't break.
export type { WhisperStreamingSttOpts as StreamingSttOpts };

type AsrFn = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<{ text: string } | Array<{ text?: string }>>;

const SAMPLE_RATE = 16000;

/**
 * One instance per active session / WebSocket connection. Not thread-
 * safe — caller serializes feed() / transcribeTail() calls.
 */
export class WhisperStreamingStt {
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly maxBufferSamples: number;
  private readonly partialEveryMs: number;
  private readonly minBufferSamples: number;
  private readonly loader: NonNullable<WhisperStreamingSttOpts['loader']>;
  private readonly logger: Logger | undefined;

  private buffer = new Float32Array(0);
  private lastPartialAt = 0;
  private lastPartialText = '';

  private pipelinePromise: Promise<AsrFn | null> | null = null;
  private pipeline: AsrFn | null = null;
  private loadFailed = false;

  constructor(opts: WhisperStreamingSttOpts = {}) {
    this.modelId = opts.modelId ?? 'Xenova/whisper-base.en';
    this.dtype = opts.dtype ?? 'q8';
    this.maxBufferSamples = (opts.maxBufferSeconds ?? 30) * SAMPLE_RATE;
    this.partialEveryMs = opts.partialEveryMs ?? 900;
    this.minBufferSamples = (opts.minBufferSeconds ?? 1.2) * SAMPLE_RATE;
    this.logger = opts.logger;
    this.loader =
      opts.loader ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((): Promise<any> =>
        import(/* @vite-ignore */ '@huggingface/transformers' as string));
  }

  /**
   * Begin loading the model. Safe to call repeatedly; first call kicks
   * off the download+init, subsequent calls just observe.
   */
  preload(): Promise<AsrFn | null> {
    if (this.pipeline) return Promise.resolve(this.pipeline);
    if (this.loadFailed) return Promise.resolve(null);
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        try {
          const lib = await this.loader();
          const p = (await lib.pipeline('automatic-speech-recognition', this.modelId, {
            dtype: this.dtype,
          })) as AsrFn;
          this.pipeline = p;
          this.logger?.info('streaming-stt ready', {
            modelId: this.modelId,
            dtype: this.dtype,
          });
          return p;
        } catch (err) {
          this.loadFailed = true;
          this.logger?.warn('streaming-stt load failed', { error: String(err) });
          return null;
        }
      })();
    }
    return this.pipelinePromise;
  }

  /** Append PCM (Float32, 16kHz mono, range [-1, 1]) to the rolling buffer. */
  feed(samples: Float32Array): void {
    if (!samples.length) return;
    // Concatenate and cap at maxBufferSamples.
    const needed = this.buffer.length + samples.length;
    if (needed <= this.maxBufferSamples) {
      const merged = new Float32Array(needed);
      merged.set(this.buffer, 0);
      merged.set(samples, this.buffer.length);
      this.buffer = merged;
    } else {
      // Overflow — drop head. Helps cap worst-case memory without an
      // explicit ring buffer.
      const keepFromExisting = Math.max(
        0,
        this.maxBufferSamples - samples.length,
      );
      const merged = new Float32Array(keepFromExisting + samples.length);
      if (keepFromExisting > 0) {
        merged.set(this.buffer.subarray(this.buffer.length - keepFromExisting), 0);
      }
      merged.set(samples, keepFromExisting);
      this.buffer = merged;
    }
  }

  /** Duration of buffered audio in seconds. */
  get bufferSeconds(): number {
    return this.buffer.length / SAMPLE_RATE;
  }

  /**
   * Try to produce a partial transcription. Returns `null` if:
   *   - not enough audio buffered, OR
   *   - model not loaded yet, OR
   *   - it's been less than `partialEveryMs` since the last partial AND
   *     `force` is false.
   * Returns the newly produced transcript otherwise.
   */
  async partial(force = false): Promise<string | null> {
    if (this.buffer.length < this.minBufferSamples) return null;
    const now = Date.now();
    if (!force && now - this.lastPartialAt < this.partialEveryMs) return null;
    const pipe = await this.preload();
    if (!pipe) return null;
    this.lastPartialAt = now;
    const text = await this.runOnce(pipe, this.buffer);
    this.lastPartialText = text;
    return text;
  }

  /** Best available transcript of the entire buffer. Always runs a fresh inference. */
  async transcribeAll(): Promise<string> {
    if (this.buffer.length < this.minBufferSamples) {
      return this.lastPartialText;
    }
    const pipe = await this.preload();
    if (!pipe) return this.lastPartialText;
    const text = await this.runOnce(pipe, this.buffer);
    this.lastPartialText = text;
    return text;
  }

  /** Drop the rolling buffer — start fresh for a new utterance. */
  reset(): void {
    this.buffer = new Float32Array(0);
    this.lastPartialAt = 0;
    this.lastPartialText = '';
  }

  private async runOnce(pipe: AsrFn, samples: Float32Array): Promise<string> {
    // English-only variants of Whisper (`*.en`) REJECT the `language` +
    // `task` options — the generation config is fixed. Multilingual
    // variants require them. Detect from the model id.
    const isEnglishOnly = /\.en(?:$|-|_)/i.test(this.modelId) || /whisper-tiny\.en$/i.test(this.modelId);
    const genOpts: Record<string, unknown> = {
      return_timestamps: false,
      condition_on_previous_text: false,
    };
    if (!isEnglishOnly) {
      genOpts['language'] = 'en';
      genOpts['task'] = 'transcribe';
    }
    try {
      const result = await pipe(samples, genOpts);
      if (Array.isArray(result)) {
        return result.map((r) => r.text ?? '').join(' ').trim();
      }
      return String(result?.text ?? '').trim();
    } catch (err) {
      this.logger?.warn('streaming-stt inference failed', { error: String(err) });
      return this.lastPartialText;
    }
  }
}
