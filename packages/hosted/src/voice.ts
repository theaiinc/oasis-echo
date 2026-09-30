import { KokoroTts, WhisperStreamingStt, type StreamingTts, type TtsChunk } from '@oasis-echo/coordinator';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * The server's voice, shared by every call: one Kokoro model (speaking) and
 * one Whisper model (listening, optional), loaded once. Each call gets its
 * own Whisper buffer on top of the shared model.
 */

/** Kokoro for everyone, with at most `concurrent` syntheses at a time so a busy moment slows speech rather than the box. */
export class SharedVoice implements StreamingTts {
  private readonly kokoro: KokoroTts;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly ready: Promise<void>;
  private readonly clips = new Map<string, { audio: string; sampleRate: number }>();

  /** Fixed lines (fillers, apologies, progress notes) synthesized once, so they play at once instead of after seconds of synthesis. */
  private readonly phrases = new Map<string, TtsChunk[]>();

  constructor(opts: { voice?: string; concurrent?: number; logger?: Logger; phrases?: string[] } = {}) {
    this.kokoro = new KokoroTts({ voice: opts.voice ?? 'af_heart', dtype: 'q8', ...(opts.logger ? { logger: opts.logger } : {}) });
    this.concurrent = opts.concurrent ?? 2;
    this.ready = this.kokoro.warm().then(() => this.primeBackchannels()).catch((err) => {
      opts.logger?.error('kokoro warm failed', { error: String(err) });
    });
    // After the backchannels, in the background: a call can start before these are ready.
    void this.ready.then(async () => {
      const started = Date.now();
      for (const phrase of new Set(opts.phrases ?? [])) {
        try {
          const chunks: TtsChunk[] = [];
          for await (const chunk of this.kokoro.synthesize(phrase)) chunks.push(chunk);
          this.phrases.set(phrase.trim(), chunks);
        } catch (err) {
          opts.logger?.warn('phrase prime failed', { phrase, error: String(err) });
        }
      }
      opts.logger?.info('phrases ready', { count: this.phrases.size, ms: Date.now() - started });
    });
  }

  private readonly concurrent: number;

  async *synthesize(text: string, opts: { signal?: AbortSignal; voice?: string; speed?: number } = {}): AsyncIterable<TtsChunk> {
    const ready = this.phrases.get(text.trim());
    if (ready) {
      yield* ready;
      return;
    }
    await this.acquire();
    try {
      yield* this.kokoro.synthesize(text, opts);
    } finally {
      this.release();
    }
  }

  /** A short "mm-hmm" style clip, for the page to play while you are still talking. */
  backchannel(): { text: string; audio: string; sampleRate: number } | null {
    const phrases = [...this.clips.keys()];
    if (!phrases.length) return null;
    const text = phrases[Math.floor(Math.random() * phrases.length)]!;
    return { text, ...this.clips.get(text)! };
  }

  private async primeBackchannels(): Promise<void> {
    for (const phrase of ['uh huh', 'yeah', 'right', 'I see', 'got it', 'okay', 'mm hmm']) {
      const parts: Int16Array[] = [];
      let sampleRate = 0;
      for await (const chunk of this.kokoro.synthesize(phrase)) {
        if (!chunk.pcm) continue;
        sampleRate = chunk.sampleRate;
        parts.push(chunk.pcm);
      }
      if (!parts.length) continue;
      const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { pcm.set(p, at); at += p.length; }
      this.clips.set(phrase, { audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'), sampleRate });
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

/** Whisper loaded once; `newListener()` gives a call its own buffer on it. */
export class SharedEars {
  private model: Promise<unknown> | null = null;

  constructor(private readonly logger?: Logger, private readonly modelId = 'Xenova/whisper-base.en') {}

  newListener(): WhisperStreamingStt {
    return new WhisperStreamingStt({
      modelId: this.modelId,
      ...(this.logger ? { logger: this.logger } : {}),
      loader: async () => ({
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => {
          this.model ??= import('@huggingface/transformers' as string).then((m: { pipeline: (...a: unknown[]) => Promise<unknown> }) => m.pipeline(task, model, opts));
          return this.model;
        },
      }),
    });
  }
}
