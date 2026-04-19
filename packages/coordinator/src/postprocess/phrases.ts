import type { PostProcessContext, PostProcessStage, PostProcessStepResult } from './types.js';

export type PhraseMatcherOpts = {
  /** Canonical phrases to snap noisy transcripts to. */
  phrases: readonly string[];
  /** Minimum combined similarity (0..1) to accept a snap. Default 0.78. */
  similarityThreshold?: number;
  /** Only attempt matching when text is at most this many words. Default 12. */
  maxInputWords?: number;
};

/**
 * Fuzzy phrase matcher: given a list of known canonical phrases
 * (command names, domain nouns, product names), snaps a noisy input
 * to the closest one. Uses a combined metric:
 *
 *   score = 0.6 × char-Levenshtein similarity  +  0.4 × token Jaccard
 *
 * Both normalized to [0,1]. Works well for short phrases (1-12 words).
 * Cost: O(N · L) where N = # phrases, L = string length. Designed for
 * small N (≤ a few hundred); for larger catalogs, swap in an embedding
 * ANN index with the same interface.
 */
export class PhraseMatcherStage implements PostProcessStage {
  readonly name = 'phrases';
  private readonly phrases: readonly string[];
  private readonly normalizedPhrases: string[];
  private readonly threshold: number;
  private readonly maxInputWords: number;

  constructor(opts: PhraseMatcherOpts) {
    this.phrases = opts.phrases;
    this.normalizedPhrases = opts.phrases.map(normalize);
    this.threshold = opts.similarityThreshold ?? 0.78;
    this.maxInputWords = opts.maxInputWords ?? 12;
  }

  shouldRun(ctx: PostProcessContext): boolean {
    if (this.phrases.length === 0) return false;
    const words = ctx.text.trim().split(/\s+/).length;
    return words <= this.maxInputWords;
  }

  run(ctx: PostProcessContext): PostProcessStepResult {
    const normInput = normalize(ctx.text);
    let best = { idx: -1, score: 0 };
    for (let i = 0; i < this.normalizedPhrases.length; i++) {
      const score = combinedSimilarity(normInput, this.normalizedPhrases[i]!);
      if (score > best.score) best = { idx: i, score };
    }
    if (best.idx < 0 || best.score < this.threshold) {
      return { text: ctx.text, changed: false, info: { bestScore: best.score } };
    }
    const matched = this.phrases[best.idx]!;
    return {
      text: matched,
      changed: matched !== ctx.text,
      info: { matched, similarity: round3(best.score) },
    };
  }
}

/* -----------------------------------------------------------------
 * Similarity helpers
 * ----------------------------------------------------------------- */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ').trim();
}

export function combinedSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const lev = normalizedLevenshtein(a, b);
  const jac = tokenJaccard(a, b);
  return 0.6 * lev + 0.4 * jac;
}

/** Levenshtein with O(n) space. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,       // deletion
        curr[j - 1]! + 1,   // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export function normalizedLevenshtein(a: string, b: string): number {
  const d = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - d / max;
}

export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
