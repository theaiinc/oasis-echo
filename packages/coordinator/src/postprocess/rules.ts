import type { PostProcessContext, PostProcessStage, PostProcessStepResult } from './types.js';

export type RuleStageOpts = {
  /** Filler words to strip. Case-insensitive, word-boundary match. */
  fillers?: readonly string[];
  /**
   * Phonetic / transcription corrections, exact word match (case-insensitive).
   * e.g. { 'gonna': 'going to', 'wanna': 'want to', 'cuz': 'because' }
   */
  phoneticFixes?: Record<string, string>;
  /** Collapse immediately-repeated words: "the the cat" → "the cat". */
  collapseRepeats?: boolean;
  /** Trim duplicate punctuation / multi-spaces and tidy edges. */
  normalizeWhitespace?: boolean;
};

const DEFAULT_FILLERS = [
  'uh', 'um', 'uhh', 'umm', 'erm', 'err',
  'like', 'you know', 'i mean',
  'sort of', 'kind of',
];

/**
 * Fast, synchronous rule-based cleanup. Runs first and unconditionally.
 * Cost: ~microseconds per turn.
 */
export class RuleStage implements PostProcessStage {
  readonly name = 'rules';
  private readonly fillerPattern: RegExp | null;
  private readonly phoneticEntries: Array<[RegExp, string]>;
  private readonly collapseRepeats: boolean;
  private readonly normalizeWs: boolean;

  constructor(opts: RuleStageOpts = {}) {
    const fillers = opts.fillers ?? DEFAULT_FILLERS;
    this.fillerPattern =
      fillers.length > 0
        ? new RegExp(`(^|[\\s,;.!?])(?:${fillers.map(escapeRegex).join('|')})(?=[\\s,;.!?]|$)`, 'gi')
        : null;

    this.phoneticEntries = Object.entries(opts.phoneticFixes ?? {}).map(
      ([wrong, right]) => [new RegExp(`\\b${escapeRegex(wrong)}\\b`, 'gi'), right],
    );
    this.collapseRepeats = opts.collapseRepeats !== false;
    this.normalizeWs = opts.normalizeWhitespace !== false;
  }

  shouldRun(): boolean {
    return true;
  }

  run(ctx: PostProcessContext): PostProcessStepResult {
    const original = ctx.text;
    let text = ctx.text;

    if (this.fillerPattern) {
      // Replace with the captured leading delimiter so we don't merge words.
      text = text.replace(this.fillerPattern, (_m, lead: string) => lead ?? ' ');
    }

    for (const [re, right] of this.phoneticEntries) {
      text = text.replace(re, right);
    }

    if (this.collapseRepeats) {
      // "the the the" / "the,  the" → "the". Word-bounded, case-insensitive.
      text = text.replace(/\b(\w+)(?:[\s,]+\1\b)+/gi, '$1');
    }

    if (this.normalizeWs) {
      text = text
        .replace(/\s+([,;.!?])/g, '$1') // no space before punctuation
        .replace(/([,;.!?])(?=\S)/g, '$1 ') // ensure space after
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    return { text, changed: text !== original };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
