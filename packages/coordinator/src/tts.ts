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
 * Splits a stream of LLM tokens into speakable chunks so downstream TTS can
 * begin synthesis at the first safe punctuation boundary without waiting for
 * the full reply. Sentence boundaries always flush; comma-like clause
 * boundaries flush only after enough words have accumulated to avoid tiny,
 * awkward fragments such as "The answer is,".
 */
export class SentenceChunker {
  private buffer = '';
  private readonly sentenceBoundary = /[.!?]+[\s"')\]]*(?=\s|$)/g;
  private readonly clauseBoundary = /[,;:][\s"')\]]*(?=\s|$)/g;
  private readonly minClauseWords = 10;
  private readonly minClauseChars = 80;
  private readonly minPhraseWords = 28;
  private readonly minPhraseChars = 190;

  feed(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];
    while (true) {
      const end = this.findBoundary();
      if (end === null) break;
      const sentence = this.buffer.slice(0, end).trim();
      if (isSpeakableChunk(sentence)) out.push(sentence);
      this.buffer = this.buffer.slice(end);
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return isSpeakableChunk(rest) ? rest : null;
  }

  flushPhraseIfReady(): string | null {
    const candidate = this.buffer.trim();
    if (
      (candidate.length >= this.minPhraseChars ||
        countWords(candidate) >= this.minPhraseWords) &&
      !endsOnWeakBoundary(candidate) &&
      isSpeakableChunk(candidate)
    ) {
      this.buffer = '';
      return candidate;
    }
    return null;
  }

  private findBoundary(): number | null {
    this.sentenceBoundary.lastIndex = 0;
    const sentence = this.sentenceBoundary.exec(this.buffer);

    this.clauseBoundary.lastIndex = 0;
    let clause: RegExpExecArray | null;
    while ((clause = this.clauseBoundary.exec(this.buffer))) {
      const end = clause.index + clause[0].length;
      if (sentence && sentence.index < clause.index) {
        return sentence.index + sentence[0].length;
      }
      const candidate = this.buffer.slice(0, end).trim();
      if (
        countWords(candidate) >= this.minClauseWords ||
        candidate.length >= this.minClauseChars
      ) {
        return end;
      }
    }

    return sentence ? sentence.index + sentence[0].length : null;
  }
}

export function sanitizeMarkdownForSpeech(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
        .replace(/```/g, ''),
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isSpeakableChunk(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function endsOnWeakBoundary(text: string): boolean {
  const lastWord = text
    .trim()
    .toLowerCase()
    .match(/[a-z0-9]+$/)?.[0];
  if (!lastWord) return true;
  return new Set([
    'a',
    'an',
    'and',
    'as',
    'at',
    'because',
    'but',
    'by',
    'for',
    'from',
    'if',
    'in',
    'into',
    'like',
    'of',
    'on',
    'or',
    'that',
    'the',
    'to',
    'while',
    'which',
    'with',
  ]).has(lastWord);
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
    const speechText = sanitizeMarkdownForSpeech(text);
    if (!speechText) return;
    const chunker = new SentenceChunker();
    const sentences = chunker.feed(speechText);
    const flushed = chunker.flush();
    if (flushed) sentences.push(flushed);
    const all = sentences.length > 0 ? sentences : [speechText];
    for (let i = 0; i < all.length; i++) {
      if (opts.signal?.aborted) return;
      yield { text: all[i] ?? '', sampleRate: this.sampleRate, final: i === all.length - 1 };
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
