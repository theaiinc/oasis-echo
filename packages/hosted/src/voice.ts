import { KokoroTts, WhisperStreamingStt, type StreamingTts, type TtsChunk } from '@oasis-echo/coordinator';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Logger } from '@oasis-echo/telemetry';

/**
 * The server's voice, shared by every call: one Kokoro model (speaking) and
 * one Whisper model (listening, optional), loaded once. Each call gets its
 * own Whisper buffer on top of the shared model.
 */

/** Short "mm-hmm" clips the page may play while the user is still talking. */
export const BACKCHANNELS = ['uh huh', 'yeah', 'right', 'I see', 'got it', 'okay', 'mm hmm'];

/** Phrases synthesized ahead of time (at image build), as stored on disk. */
type BakedFile = { voice: string; phrases: Record<string, Array<{ text: string; sampleRate: number; final: boolean; pcm?: string }>> };

/** Synthesize `phrases` with `voice` and write them where SharedVoice can load them. */
export async function bakePhrases(file: string, phrases: string[], voice = 'af_heart'): Promise<number> {
  const kokoro = new KokoroTts({ voice, dtype: 'q8' });
  await kokoro.warm();
  const out: BakedFile = { voice, phrases: {} };
  for (const phrase of new Set(phrases.map((p) => p.trim()).filter(Boolean))) {
    const chunks: BakedFile['phrases'][string] = [];
    for await (const c of kokoro.synthesize(phrase)) {
      chunks.push({ text: c.text, sampleRate: c.sampleRate, final: c.final, ...(c.pcm ? { pcm: Buffer.from(c.pcm.buffer, c.pcm.byteOffset, c.pcm.byteLength).toString('base64') } : {}) });
    }
    out.phrases[phrase] = chunks;
  }
  await writeFile(file, JSON.stringify(out));
  return Object.keys(out.phrases).length;
}

/** Kokoro for everyone, with at most `concurrent` syntheses at a time so a busy moment slows speech rather than the box. */
export class SharedVoice implements StreamingTts {
  private readonly kokoro: KokoroTts;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly ready: Promise<void>;
  private readonly clips = new Map<string, { audio: string; sampleRate: number }>();

  /** Fixed lines (fillers, apologies, backchannels, progress notes) ready to play at once instead of after seconds of synthesis. */
  private readonly phrases = new Map<string, TtsChunk[]>();

  constructor(opts: { voice?: string; concurrent?: number; logger?: Logger; phrases?: string[]; bakedFile?: string } = {}) {
    const voice = opts.voice ?? 'af_heart';
    this.kokoro = new KokoroTts({ voice, dtype: 'q8', ...(opts.logger ? { logger: opts.logger } : {}) });
    this.concurrent = opts.concurrent ?? 2;
    // Baked phrases load in well under a second; only what they lack is synthesized, in the background.
    const baked = opts.bakedFile ? this.loadBaked(opts.bakedFile, voice, opts.logger) : 0;
    this.ready = this.kokoro.warm().then(() => this.primeBackchannels()).catch((err) => {
      opts.logger?.error('kokoro warm failed', { error: String(err) });
    });
    void this.ready.then(async () => {
      const started = Date.now();
      let made = 0;
      for (const phrase of new Set(opts.phrases ?? [])) {
        if (this.phrases.has(phrase.trim())) continue;
        try {
          await this.phrase(phrase);
          made++;
        } catch (err) {
          opts.logger?.warn('phrase prime failed', { phrase, error: String(err) });
        }
      }
      opts.logger?.info('phrases ready', { count: this.phrases.size, baked, synthesized: made, ms: Date.now() - started });
    });
  }

  private readonly concurrent: number;

  private loadBaked(file: string, voice: string, logger?: Logger): number {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as BakedFile;
      if (data.voice !== voice) return 0;
      for (const [phrase, chunks] of Object.entries(data.phrases)) {
        this.phrases.set(phrase, chunks.map((c) => {
          if (!c.pcm) return { text: c.text, sampleRate: c.sampleRate, final: c.final };
          const bytes = Buffer.from(c.pcm, 'base64');
          return { text: c.text, sampleRate: c.sampleRate, final: c.final, pcm: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2) };
        }));
      }
      return this.phrases.size;
    } catch (err) {
      logger?.warn('baked phrases not loaded', { file, error: String(err) });
      return 0;
    }
  }

  /** A fixed line's audio, from the cache or synthesized once and cached. */
  private async phrase(text: string): Promise<TtsChunk[]> {
    const key = text.trim();
    const have = this.phrases.get(key);
    if (have) return have;
    const chunks: TtsChunk[] = [];
    for await (const chunk of this.kokoro.synthesize(key)) chunks.push(chunk);
    this.phrases.set(key, chunks);
    return chunks;
  }

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
    for (const phrase of BACKCHANNELS) {
      const parts = (await this.phrase(phrase)).filter((c) => c.pcm).map((c) => c.pcm!);
      if (!parts.length) continue;
      const sampleRate = (await this.phrase(phrase)).find((c) => c.pcm)!.sampleRate;
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
