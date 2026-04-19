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
  async addCorrection(original: string, corrected: string): Promise<CorrectionAnalysis> {
    const analysis = analyzeDiff(original, corrected);
    for (const { wrong, right } of analysis.wordPairs) {
      if (wrong.length > 1 && right.length > 0 && wrong.toLowerCase() !== right.toLowerCase()) {
        this.data.wordRules[wrong.toLowerCase()] = right;
      }
    }
    if (analysis.addAsPhrase) {
      const trimmed = corrected.trim();
      if (trimmed.length > 0 && !this.data.phrases.includes(trimmed)) {
        this.data.phrases.push(trimmed);
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
 *   - If only one word differs, extract it as a word-level rule.
 *     (This also generalizes to other phrasings of the same typo.)
 *   - Always also index the corrected text as a canonical phrase so
 *     fuzzy matcher can snap to it on future noisy transcripts.
 *
 * Single-word diff heuristic: tokenize both sides, align at shared
 * token boundaries, and accept if exactly one token pair mismatches
 * with the surrounding tokens identical.
 */
export function analyzeDiff(original: string, corrected: string): CorrectionAnalysis {
  const origTokens = tokenize(original);
  const corrTokens = tokenize(corrected);

  const pairs: Array<{ wrong: string; right: string }> = [];
  if (origTokens.length === corrTokens.length && origTokens.length > 0) {
    const mismatches: number[] = [];
    for (let i = 0; i < origTokens.length; i++) {
      if (origTokens[i]!.toLowerCase() !== corrTokens[i]!.toLowerCase()) mismatches.push(i);
    }
    if (mismatches.length === 1) {
      const i = mismatches[0]!;
      const wrong = origTokens[i]!;
      const right = corrTokens[i]!;
      // Skip single-character tokens: too aggressive to promote to a
      // global rule (e.g. "a" → "an" would rewrite every lone "a").
      if (wrong.length > 1 && right.length > 0) {
        pairs.push({ wrong, right });
      }
    }
  }

  // Always add as a phrase unless the corrected sentence is a single
  // word (in which case the word-rule is enough).
  const addAsPhrase = corrTokens.length >= 2;

  return { wordPairs: pairs, addAsPhrase };
}

function tokenize(s: string): string[] {
  return s
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
