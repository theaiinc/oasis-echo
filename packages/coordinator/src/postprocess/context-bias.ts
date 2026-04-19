import type { PostProcessContext, PostProcessStage, PostProcessStepResult } from './types.js';
import { detectTopicChange } from './context-gate.js';
import { extractSalientTokens, isStopword, soundex, type SalientToken } from './phonetic.js';
import { levenshtein } from './phrases.js';

export type ContextBiasOpts = {
  /** Reject candidates whose weight is below this threshold. Default 0.5. */
  minCandidateWeight?: number;
  /**
   * Max token-window size to fold into a single candidate. Needs to be
   * big enough to catch multi-syllable names that STT shatters into
   * several English-looking tokens (e.g. "Shinkansen" → "same can send
   * trans" = 4 tokens). Default 4.
   */
  maxWindowSize?: number;
  /** Minimum length of the concatenated window chars. Default 3. */
  minWindowChars?: number;
  /**
   * For LOW-weight candidates, additionally require the edit distance
   * to be within this fraction of the candidate length. Strong-prior
   * candidates (proper nouns, code identifiers, backticked) bypass
   * this check — for those, Soundex agreement is enough. Default 0.5.
   */
  maxRelativeDistance?: number;
  /**
   * Weight at or above which we trust Soundex alone (no Levenshtein).
   * Default 2.0 — covers proper-noun, code-identifier, backticked.
   */
  strongPriorWeight?: number;
};

type Swap = { from: string; to: string; via: SalientToken['kind']; dist: number };

/**
 * Context-biased STT correction. Uses the agent's last utterance as a
 * vocabulary hint: for each 1-2 token window in the user's transcript
 * that looks phonetically close to a salient token from the agent
 * (name, code identifier, proper noun, rare word), swap the window to
 * that token. Gated by:
 *
 *   - agent context must be present
 *   - topic-change detector must NOT have fired
 *   - Soundex codes must match exactly
 *   - edit distance must be small relative to candidate length
 *
 * The stage preserves the agent's original casing on the candidate so
 * "seetell" → "Seattle", not "seattle" — important for names and
 * case-sensitive identifiers.
 */
export class ContextBiasStage implements PostProcessStage {
  readonly name = 'context-bias';
  private readonly minCandidateWeight: number;
  private readonly maxWindowSize: number;
  private readonly minWindowChars: number;
  private readonly maxRelDist: number;
  private readonly strongPriorWeight: number;

  constructor(opts: ContextBiasOpts = {}) {
    this.minCandidateWeight = opts.minCandidateWeight ?? 0.5;
    this.maxWindowSize = opts.maxWindowSize ?? 4;
    this.minWindowChars = opts.minWindowChars ?? 3;
    this.maxRelDist = opts.maxRelativeDistance ?? 0.5;
    this.strongPriorWeight = opts.strongPriorWeight ?? 2.0;
  }

  shouldRun(ctx: PostProcessContext): boolean {
    if (!ctx.agentContext?.lastUtterance?.trim()) return false;
    if (!ctx.text.trim()) return false;
    return !detectTopicChange(ctx.text, ctx.agentContext).changed;
  }

  run(ctx: PostProcessContext): PostProcessStepResult {
    const salient = extractSalientTokens(ctx.agentContext!.lastUtterance!).filter(
      (s) => s.weight >= this.minCandidateWeight,
    );
    if (salient.length === 0) {
      return { text: ctx.text, changed: false, info: { reason: 'no-salient' } };
    }

    // Index by Soundex code. Multiple salient tokens can share a code
    // ("fair" and "far"); we'll pick the highest-weighted / closest.
    const byCode = new Map<string, SalientToken[]>();
    for (const s of salient) {
      if (!s.code) continue;
      const arr = byCode.get(s.code) ?? [];
      arr.push(s);
      byCode.set(s.code, arr);
    }

    // Tokenize user text preserving whitespace and punctuation.
    const parts = ctx.text.split(/(\s+)/);
    const wordIdx: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.trim()) wordIdx.push(i);
    }

    const consumed = new Set<number>();
    const swaps: Swap[] = [];

    // Try larger windows first — a 2-token window that matches should
    // shadow the 1-token matches inside it.
    for (let size = this.maxWindowSize; size >= 1; size--) {
      for (let w = 0; w + size <= wordIdx.length; w++) {
        const winIdx = wordIdx.slice(w, w + size);
        if (winIdx.some((i) => consumed.has(i))) continue;
        const surfaces = winIdx.map((i) => stripBare(parts[i]!));
        if (surfaces.some((s) => s === '')) continue;
        if (surfaces.every((s) => isStopword(s))) continue;
        const origJoined = surfaces.join('');
        const concat = origJoined.toLowerCase();
        if (concat.length < this.minWindowChars) continue;
        const concatCode = soundex(concat);
        if (!concatCode) continue;
        const candidates = byCode.get(concatCode);
        if (!candidates || candidates.length === 0) continue;

        let best: { cand: SalientToken; dist: number } | null = null;
        for (const cand of candidates) {
          // Skip only if the user already wrote the candidate verbatim
          // (case + spelling). A lowercase/spaced variant still swaps
          // so we can restore the agent's canonical form.
          if (origJoined === cand.surface) continue;
          const candLower = cand.surface.toLowerCase();
          const dist = levenshtein(concat, candLower);
          // For strong-prior candidates (proper nouns, code identifiers,
          // backticked tokens), Soundex agreement is enough — multi-syllable
          // names shattered by STT produce huge edit distances at the
          // character level but still preserve the phonetic signature.
          if (cand.weight < this.strongPriorWeight) {
            const maxAbs = Math.max(
              2,
              Math.floor(Math.max(concat.length, candLower.length) * this.maxRelDist),
            );
            if (dist > maxAbs) continue;
          }
          if (
            !best ||
            cand.weight > best.cand.weight ||
            (cand.weight === best.cand.weight && dist < best.dist)
          ) {
            best = { cand, dist };
          }
        }
        if (!best) continue;

        // Perform the swap in-place: first-in-window replaced with the
        // agent-spelling (preserving leading punctuation), middle and
        // last tokens (plus any whitespace between) collapsed.
        const first = winIdx[0]!;
        const last = winIdx[winIdx.length - 1]!;
        const firstTok = parts[first]!;
        const lastTok = parts[last]!;
        const leadingPunct = firstTok.match(/^[^A-Za-z0-9_$]+/)?.[0] ?? '';
        const trailingPunct = lastTok.match(/[^A-Za-z0-9_$]+$/)?.[0] ?? '';
        parts[first] = leadingPunct + best.cand.surface + trailingPunct;
        for (let k = first + 1; k <= last; k++) parts[k] = '';
        for (const i of winIdx) consumed.add(i);
        swaps.push({
          from: surfaces.join(' '),
          to: best.cand.surface,
          via: best.cand.kind,
          dist: best.dist,
        });
      }
    }

    if (swaps.length === 0) {
      return { text: ctx.text, changed: false };
    }
    // Collapse any double-spaces produced by blanked tokens.
    const result = parts.join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
    if (result === ctx.text) {
      return { text: ctx.text, changed: false };
    }
    return { text: result, changed: true, info: { swaps } };
  }
}

function stripBare(t: string): string {
  return t.replace(/[^A-Za-z0-9_$]/g, '');
}
