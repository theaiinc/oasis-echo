import { promises as fs } from 'node:fs';

/**
 * Persistent record of user corrections. Feeds two post-process
 * stages:
 *
 *   - wordRules → RuleStage.phoneticFixes (exact word substitution)
 *   - phrases   → PhraseMatcherStage.phrases (fuzzy snap targets)
 *
 * On each correction, the diff analyzer below decides which bucket
 * it lands in. Both buckets compose — a single-word fix also adds
 * the corrected sentence as a phrase, so the same mistake in a
 * different phrasing still snaps.
 */
export type CorrectionFile = {
  version: 1;
  wordRules: Record<string, string>;
  phrases: string[];
  history: Array<{ original: string; corrected: string; atMs: number }>;
};

export type CorrectionAnalysis = {
  /** Word-level substitution pairs extracted from the diff. */
  wordPairs: Array<{ wrong: string; right: string }>;
  /** Whether the corrected text should also be added as a canonical phrase. */
  addAsPhrase: boolean;
};

export class CorrectionStore {
  private data: CorrectionFile = { version: 1, wordRules: {}, phrases: [], history: [] };
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly onChange?: () => void,
  ) {}

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(content) as CorrectionFile;
      if (parsed.version === 1 && parsed.wordRules && parsed.phrases) {
        this.data = {
          version: 1,
          wordRules: parsed.wordRules,
          phrases: parsed.phrases,
          history: parsed.history ?? [],
        };
      }
    } catch {
      // Missing file = fresh start. Any other error (malformed JSON etc.)
      // also resets to defaults rather than crashing the server.
    }
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Current word-level phonetic fixes. Pass into RuleStage. */
  wordRules(): Record<string, string> {
    return { ...this.data.wordRules };
  }

  /** Current canonical phrases. Pass into PhraseMatcherStage. */
  phrases(): readonly string[] {
    return this.data.phrases.slice();
  }

  history(): ReadonlyArray<{ original: string; corrected: string; atMs: number }> {
    return this.data.history.slice();
  }

  /**
   * Record a user correction. Analyzes the diff and updates the
   * appropriate bucket(s). Persists to disk asynchronously and
   * notifies the `onChange` callback so callers can rebuild their
   * live post-process pipeline.
   */
  async addCorrection(
    original: string,
    corrected: string,
    options: { phraseOnly?: boolean } = {},
  ): Promise<CorrectionAnalysis> {
    const analysis = analyzeDiff(original, corrected);
    for (const { wrong, right } of options.phraseOnly ? [] : analysis.wordPairs) {
      if (wrong.length > 1 && right.length > 0 && wrong.toLowerCase() !== right.toLowerCase()) {
        this.data.wordRules[wrong.toLowerCase()] = right;
      }
    }
    // Only fall back to indexing the WHOLE sentence as a fuzzy phrase
    // match when no targeted span could be isolated — once analyzeDiff
    // finds a clean "this part is what was wrong" pair, that's a much
    // more useful, reusable rule than a snap-target against one exact
    // sentence that will essentially never recur verbatim.
    if (options.phraseOnly || analysis.wordPairs.length === 0) {
      if (analysis.addAsPhrase) {
        const trimmed = corrected.trim();
        if (trimmed.length > 0 && !this.data.phrases.includes(trimmed)) {
          this.data.phrases.push(trimmed);
        }
      }
    }
    this.data.history.push({ original, corrected, atMs: Date.now() });
    await this.persist();
    this.onChange?.();
    return analysis;
  }

  /** Remove a specific word rule. Returns true if one was found. */
  async removeWordRule(wrong: string): Promise<boolean> {
    const key = wrong.toLowerCase();
    if (!(key in this.data.wordRules)) return false;
    delete this.data.wordRules[key];
    await this.persist();
    this.onChange?.();
    return true;
  }

  /** Remove a specific phrase. Returns true if one was found. */
  async removePhrase(phrase: string): Promise<boolean> {
    const idx = this.data.phrases.indexOf(phrase);
    if (idx < 0) return false;
    this.data.phrases.splice(idx, 1);
    await this.persist();
    this.onChange?.();
    return true;
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // Best-effort. If disk is full or path is bad, the in-memory
      // copy still works for the rest of the session.
    }
  }
}

/**
 * Decide how to classify a correction.
 *
 * Trims the longest common prefix and suffix (token-wise,
 * case-insensitive) off both sides to isolate the smallest span that
 * actually changed, then promotes THAT span to a reusable word/phrase
 * rule — regardless of whether the replacement changed the token count
 * (e.g. "P, N, L" → "PNL" merges three tokens into one; a strict
 * same-length one-token-mismatch check would miss this entirely and
 * only be able to fall back to matching the whole sentence verbatim,
 * which essentially never recurs). Falls back to indexing the whole
 * corrected sentence as a fuzzy phrase-match target only when no clean
 * span could be isolated (empty span on either side — a pure
 * insertion/deletion rather than a replacement — or an unrelated,
 * sprawling rewrite).
 */
export function analyzeDiff(original: string, corrected: string): CorrectionAnalysis {
  const origTokens = tokenize(original);
  const corrTokens = tokenize(corrected);

  const pairs: Array<{ wrong: string; right: string }> = [];

  const maxCommon = Math.min(origTokens.length, corrTokens.length);
  let prefixLen = 0;
  while (
    prefixLen < maxCommon &&
    origTokens[prefixLen]!.toLowerCase() === corrTokens[prefixLen]!.toLowerCase()
  ) {
    prefixLen++;
  }
  let suffixLen = 0;
  const maxSuffix = maxCommon - prefixLen;
  while (
    suffixLen < maxSuffix &&
    origTokens[origTokens.length - 1 - suffixLen]!.toLowerCase() ===
      corrTokens[corrTokens.length - 1 - suffixLen]!.toLowerCase()
  ) {
    suffixLen++;
  }

  const wrongSpan = origTokens.slice(prefixLen, origTokens.length - suffixLen);
  const rightSpan = corrTokens.slice(prefixLen, corrTokens.length - suffixLen);

  // A changed span is only a plausible "this is always mis-heard" rule
  // when BOTH sides are non-empty (an actual replacement, not context-
  // dependent insertion/deletion) and short enough that it looks like a
  // word/name/term rather than an unrelated rewrite of most of the
  // sentence.
  const MAX_SPAN_WORDS = 6;
  if (
    wrongSpan.length > 0 &&
    rightSpan.length > 0 &&
    wrongSpan.length <= MAX_SPAN_WORDS &&
    rightSpan.length <= MAX_SPAN_WORDS
  ) {
    const wrong = stripEdgePunctuation(wrongSpan.join(' '));
    const right = stripEdgePunctuation(rightSpan.join(' '));
    // Skip single-character spans: too aggressive to promote to a
    // global rule (e.g. "a" → "an" would rewrite every lone "a").
    if (wrong.length > 1 && right.length > 0 && wrong.toLowerCase() !== right.toLowerCase()) {
      pairs.push({ wrong, right });
    }
  }

  // Always add as a phrase unless the corrected sentence is a single
  // word (in which case the word-rule is enough). The caller decides
  // whether to actually use this — CorrectionStore.addCorrection skips
  // it when a targeted pair above was already found.
  const addAsPhrase = corrTokens.length >= 2;

  return { wordPairs: pairs, addAsPhrase };
}

function tokenize(s: string): string[] {
  return s
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Strip leading/trailing punctuation so a taught rule matches cleanly
 *  against a `\b`-anchored regex (see RuleStage) — a trailing comma or
 *  period left in place means the boundary right after it never fires,
 *  since punctuation-to-whitespace isn't a word-boundary transition. */
function stripEdgePunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}
