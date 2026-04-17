export type TtsChunk = {
  pcm: Int16Array;
  sampleRate: number;
  final: boolean;
};

export interface StreamingTts {
  synthesize(text: string, opts?: { signal?: AbortSignal; voice?: string }): AsyncIterable<TtsChunk>;
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
 * Mock TTS that emits one PCM chunk per sentence, with a payload that
 * encodes the rendered text for assertions. Used in tests and the
 * text-mode demo so the full pipeline stays exercised.
 */
export class MockTts implements StreamingTts {
  constructor(private readonly sampleRate = 22_050) {}

  async *synthesize(
    text: string,
    opts: { signal?: AbortSignal; voice?: string } = {},
  ): AsyncIterable<TtsChunk> {
    const chunker = new SentenceChunker();
    const sentences = chunker.feed(text);
    const flushed = chunker.flush();
    if (flushed) sentences.push(flushed);
    const all = sentences.length > 0 ? sentences : [text];
    for (let i = 0; i < all.length; i++) {
      if (opts.signal?.aborted) return;
      const payload = new TextEncoder().encode(all[i] ?? '');
      const pcm = new Int16Array(payload.buffer, payload.byteOffset, Math.floor(payload.byteLength / 2));
      yield { pcm, sampleRate: this.sampleRate, final: i === all.length - 1 };
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
