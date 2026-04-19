/**
 * Phonetic coding + salient-token extraction for context-aware STT
 * correction. Kept deliberately simple — Soundex groups homophones
 * well enough for "seetell" → "Seattle" or "new state" → "useState".
 *
 * If this proves too coarse in practice, swap in Double Metaphone
 * with the same exported interface; the stages downstream don't care.
 */

export type SalientToken = {
  /** Original surface form, preserving case (e.g. "Seattle", "useState"). */
  surface: string;
  /** Soundex code of the surface. '' if the token has no codeable letters. */
  code: string;
  /** Higher = more likely mis-heard and worth biasing toward. */
  weight: number;
  /** Why it was flagged. Useful for debugging traces. */
  kind: 'proper-noun' | 'code-identifier' | 'backticked' | 'rare-word' | 'content';
};

/**
 * Basic Soundex. Returns a 4-char code of the form `[A-Z]\d{3}`. Vowels
 * (and H, W) separate consonants but don't contribute a digit. Adjacent
 * identical codes collapse.
 */
export function soundex(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return '';
  const out: string[] = [letters[0]!];
  let lastCode = code(letters[0]!);
  for (let i = 1; i < letters.length && out.length < 4; i++) {
    const ch = letters[i]!;
    const c = code(ch);
    if (c === '') {
      // H and W don't contribute but also don't reset adjacency;
      // other vowels reset so the next consonant is emitted even if
      // its code equals lastCode.
      if (ch !== 'H' && ch !== 'W') lastCode = '';
      continue;
    }
    if (c !== lastCode) out.push(c);
    lastCode = c;
  }
  return (out.join('') + '000').slice(0, 4);
}

function code(ch: string): string {
  switch (ch) {
    case 'B':
    case 'F':
    case 'P':
    case 'V':
      return '1';
    case 'C':
    case 'G':
    case 'J':
    case 'K':
    case 'Q':
    case 'S':
    case 'X':
    case 'Z':
      return '2';
    case 'D':
    case 'T':
      return '3';
    case 'L':
      return '4';
    case 'M':
    case 'N':
      return '5';
    case 'R':
      return '6';
    default:
      return '';
  }
}

export function phoneticMatches(a: string, b: string): boolean {
  const sa = soundex(a);
  const sb = soundex(b);
  return sa !== '' && sa === sb;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'into', 'onto',
  'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'we', 'us', 'our', 'they', 'them', 'their',
  'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'having',
  'can', 'could', 'would', 'should', 'shall', 'will', 'may', 'might', 'must',
  'not', 'no', 'yes', 'yeah', 'yep', 'nope',
  'what', 'when', 'where', 'why', 'how', 'who', 'which',
  'also', 'just', 'only', 'very', 'really', 'any', 'some',
  'one', 'two', 'three', 'four', 'five',
  'about', 'over', 'than', 'then', 'there', 'here',
]);

const COMMON_WORDS = new Set([
  ...STOPWORDS,
  // High-frequency content words we don't flag as "rare" — mis-hearing
  // these is unlikely because STT has strong priors for them.
  'make', 'makes', 'made', 'making', 'take', 'takes', 'took', 'taking',
  'get', 'gets', 'got', 'getting', 'go', 'goes', 'went', 'going',
  'see', 'sees', 'saw', 'seen', 'seeing',
  'know', 'knows', 'knew', 'known', 'knowing',
  'think', 'thinks', 'thought', 'thinking',
  'want', 'wants', 'wanted', 'wanting',
  'need', 'needs', 'needed', 'needing',
  'like', 'likes', 'liked', 'liking',
  'look', 'looks', 'looked', 'looking',
  'give', 'gives', 'gave', 'given', 'giving',
  'find', 'finds', 'found', 'finding',
  'tell', 'tells', 'told', 'telling',
  'ask', 'asks', 'asked', 'asking',
  'work', 'works', 'worked', 'working',
  'call', 'calls', 'called', 'calling',
  'try', 'tries', 'tried', 'trying',
  'use', 'uses', 'used', 'using',
  'say', 'says', 'said', 'saying',
  'come', 'comes', 'came', 'coming',
  'good', 'bad', 'new', 'old', 'big', 'small', 'long', 'short', 'right', 'wrong',
  'first', 'last', 'next', 'same', 'other', 'another',
  'thing', 'things', 'way', 'ways', 'time', 'times', 'day', 'days',
  'year', 'years', 'week', 'weeks', 'hour', 'hours', 'minute', 'minutes',
]);

export function isStopword(t: string): boolean {
  return STOPWORDS.has(t.toLowerCase());
}

/**
 * Pull out the tokens from an utterance that are worth biasing toward
 * on the next user turn. Weights:
 *
 *   - backticked (`useState`)            → 3.0
 *   - code identifier (useState, foo_bar) → 2.5
 *   - proper noun (capitalized mid-text)  → 2.0
 *   - rare content word                   → 1.0
 *   - common content word                 → 0.3 (kept, but low priority)
 *
 * The first token of a sentence is NOT treated as a proper noun just
 * because it's capitalized — that's almost always an article or pronoun.
 */
export function extractSalientTokens(text: string): SalientToken[] {
  if (!text.trim()) return [];
  const out: SalientToken[] = [];
  const seen = new Set<string>();

  // Backticked tokens: `useState`, `npm install`.
  const backtickRe = /`([^`]+)`/g;
  for (let m = backtickRe.exec(text); m; m = backtickRe.exec(text)) {
    const content = m[1]!;
    for (const piece of content.split(/\s+/)) {
      const clean = piece.replace(/^[^A-Za-z0-9_$]+|[^A-Za-z0-9_$]+$/g, '');
      if (clean.length < 2) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ surface: clean, code: soundex(clean), weight: 3.0, kind: 'backticked' });
    }
  }

  // Split into sentences; first-word-of-sentence capitalization is
  // ambiguous, so we don't flag it as a proper noun.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const raw = words[i]!;
      const stripped = raw.replace(/^[^A-Za-z0-9_$]+|[^A-Za-z0-9_$]+$/g, '');
      if (stripped.length < 2) continue;
      const key = stripped.toLowerCase();
      if (seen.has(key)) continue;

      let kind: SalientToken['kind'] | null = null;
      let weight = 0;

      // Code identifiers: camelCase or contains underscore / $ / digits.
      const isCamel = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(stripped);
      const hasUnderscore = /_/.test(stripped);
      const hasDollar = /\$/.test(stripped);
      const hasDigit = /\d/.test(stripped);
      if (isCamel || hasUnderscore || hasDollar || (hasDigit && /[A-Za-z]/.test(stripped))) {
        kind = 'code-identifier';
        weight = 2.5;
      } else if (i > 0 && /^[A-Z]/.test(stripped) && /[a-z]/.test(stripped)) {
        // Mid-sentence capitalized → likely proper noun.
        kind = 'proper-noun';
        weight = 2.0;
      } else if (stripped.length >= 4 && !COMMON_WORDS.has(key)) {
        kind = 'rare-word';
        weight = 1.0;
      } else if (stripped.length >= 3 && !STOPWORDS.has(key)) {
        kind = 'content';
        weight = 0.3;
      }

      if (kind === null) continue;
      const sx = soundex(stripped);
      if (!sx) continue;
      seen.add(key);
      out.push({ surface: stripped, code: sx, weight, kind });
    }
  }

  return out;
}
