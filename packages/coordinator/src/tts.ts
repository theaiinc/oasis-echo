export type TtsChunk = {
  /** The text being spoken in this chunk — always present so the UI
   *  can render it regardless of whether audio is present. */
  text: string;
  /** Synthesized PCM. Optional — only present when a real audio backend
   *  (Kokoro, Piper, ElevenLabs…) is active. When absent, the client
   *  falls back to browser speechSynthesis on the text. */
  pcm?: Int16Array;
  /** Sample rate of `pcm` when present, or nominal when absent. */
  sampleRate: number;
  final: boolean;
};

export interface StreamingTts {
  synthesize(
    text: string,
    opts?: {
      signal?: AbortSignal;
      voice?: string;
      /** Playback rate, 1.0 = natural. Lower = slower/more hesitant. */
      speed?: number;
    },
  ): AsyncIterable<TtsChunk>;
}

/**
 * Splits a stream of LLM tokens into sentence-sized chunks so downstream
 * TTS can begin synthesis at the first punctuation boundary without
 * waiting for the full reply.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly boundary = /([.!?]+[\s"')\]]*)(?=\s|$)/;

  feed(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];
    while (true) {
      const m = this.boundary.exec(this.buffer);
      if (!m) break;
      const end = m.index + m[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      if (sentence.length > 0) out.push(sentence);
      this.buffer = this.buffer.slice(end);
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }
}

/**
 * Passthrough TTS — splits text into sentences and emits them as
 * text-only chunks (no PCM). The browser client receives them via SSE
 * and voices each sentence through `speechSynthesis`. Used when the
 * server is configured with `OASIS_TTS_BACKEND=web-speech` (the
 * fallback path; Kokoro is the preferred local backend).
 */
export class PassthroughTts implements StreamingTts {
  constructor(private readonly sampleRate = 22_050) {}

  async *synthesize(
    text: string,
    opts: { signal?: AbortSignal; voice?: string; speed?: number } = {},
  ): AsyncIterable<TtsChunk> {
    const chunker = new SentenceChunker();
    const sentences = chunker.feed(text);
    const flushed = chunker.flush();
    if (flushed) sentences.push(flushed);
    const all = sentences.length > 0 ? sentences : [text];
    for (let i = 0; i < all.length; i++) {
      if (opts.signal?.aborted) return;
      yield { text: all[i] ?? '', sampleRate: this.sampleRate, final: i === all.length - 1 };
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
