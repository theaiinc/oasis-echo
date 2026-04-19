import type { Logger } from '@oasis-echo/telemetry';
import { SentenceChunker, type StreamingTts, type TtsChunk } from './tts.js';

/**
 * Server-side Kokoro-82M TTS. Loads a small ONNX model via
 * @huggingface/transformers and emits real PCM per sentence. About
 * 80–170MB download on first run (cached to ~/.cache/huggingface);
 * subsequent runs warm start in ~1s.
 *
 * Quality is dramatically better than browser speechSynthesis —
 * Kokoro is near-ElevenLabs at a fraction of the cost and runs
 * locally on CPU. On Apple Silicon, q8 quantization is a good
 * speed/quality balance.
 */
export type KokoroOpts = {
  modelId?: string;
  voice?: string;
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  speed?: number;
  logger?: Logger;
};

export class KokoroTts implements StreamingTts {
  private readonly modelId: string;
  private readonly voice: string;
  private readonly dtype: KokoroOpts['dtype'];
  private readonly speed: number;
  private readonly logger: Logger | undefined;
  private tts: unknown | null = null;
  private loadPromise: Promise<unknown> | null = null;
  private loadedAtMs = 0;

  constructor(opts: KokoroOpts = {}) {
    this.modelId = opts.modelId ?? 'onnx-community/Kokoro-82M-v1.0-ONNX';
    this.voice = opts.voice ?? 'af_heart';
    this.dtype = opts.dtype ?? 'q8';
    this.speed = opts.speed ?? 1.0;
    this.logger = opts.logger;
  }

  /** Kick off the model download/load in the background. */
  async warm(): Promise<void> {
    await this.ensureLoaded();
  }

  get isReady(): boolean {
    return this.tts !== null;
  }

  get loadedMs(): number {
    return this.loadedAtMs;
  }

  private async ensureLoaded(): Promise<unknown> {
    if (this.tts) return this.tts;
    if (this.loadPromise) return this.loadPromise;
    const started = Date.now();
    this.logger?.info('kokoro loading', { modelId: this.modelId, dtype: this.dtype });
    this.loadPromise = (async () => {
      const mod = await import('kokoro-js');
      const tts = await mod.KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype ?? 'q8',
        device: 'cpu',
      });
      this.tts = tts;
      this.loadedAtMs = Date.now() - started;
      this.logger?.info('kokoro ready', { loadMs: this.loadedAtMs });
      return tts;
    })();
    return this.loadPromise;
  }

  async *synthesize(
    text: string,
    opts: { signal?: AbortSignal; voice?: string; speed?: number } = {},
  ): AsyncIterable<TtsChunk> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (opts.signal?.aborted) return;
    const tts = (await this.ensureLoaded()) as {
      generate: (
        t: string,
        o: { voice: string; speed: number },
      ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    };

    // Synthesize the whole input as ONE audio blob so the caller can
    // glue a filler to the first sentence and get seamless playback
    // with no internal gap. The pipeline already chunks at sentence
    // boundaries before calling us, so we don't need to split again.
    const result = await tts.generate(trimmed, {
      voice: opts.voice ?? this.voice,
      speed: opts.speed ?? this.speed,
    });
    if (opts.signal?.aborted) return;
    yield {
      text: trimmed,
      pcm: floatToInt16(result.audio),
      sampleRate: result.sampling_rate,
      final: true,
    };
  }
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+[\s"')\]]*/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0].trim());
    lastIdx = m.index + m[0].length;
  }
  const rest = text.slice(lastIdx).trim();
  if (rest.length > 0) out.push(rest);
  return out.length > 0 ? out : [text];
}

function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
