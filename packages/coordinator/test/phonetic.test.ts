import { describe, expect, it } from 'vitest';
import {
  extractSalientTokens,
  isStopword,
  phoneticMatches,
  soundex,
} from '../src/postprocess/phonetic.js';

describe('soundex', () => {
  it('codes homophones to the same string', () => {
    expect(soundex('Seattle')).toBe(soundex('seetell'));
    expect(soundex('seattle')).toBe('S340');
  });

  it('handles empty and numeric inputs', () => {
    expect(soundex('')).toBe('');
    expect(soundex('12345')).toBe('');
  });

  it('groups useState-style identifiers', () => {
    expect(soundex('useState')).toBe(soundex('usestate'));
  });

  it('groups teh / the', () => {
    expect(soundex('teh')).toBe(soundex('the'));
  });

  it('keeps distinct words apart when they really differ', () => {
    expect(soundex('apple')).not.toBe(soundex('orange'));
  });

  it('pads short codes to 4 chars', () => {
    const code = soundex('A');
    expect(code).toHaveLength(4);
  });
});

describe('phoneticMatches', () => {
  it('returns true for homophones', () => {
    expect(phoneticMatches('Seattle', 'seetell')).toBe(true);
  });
  it('returns false when either input has no code', () => {
    expect(phoneticMatches('', 'anything')).toBe(false);
    expect(phoneticMatches('123', '456')).toBe(false);
  });
});

describe('isStopword', () => {
  it('recognizes common stopwords', () => {
    expect(isStopword('the')).toBe(true);
    expect(isStopword('THE')).toBe(true);
    expect(isStopword('Seattle')).toBe(false);
  });
});

describe('extractSalientTokens', () => {
  it('flags mid-sentence capitalized words as proper nouns', () => {
    const tokens = extractSalientTokens('Should I book a flight to Seattle?');
    const seattle = tokens.find((t) => t.surface === 'Seattle');
    expect(seattle).toBeDefined();
    expect(seattle?.kind).toBe('proper-noun');
    expect(seattle?.weight).toBeGreaterThanOrEqual(2);
  });

  it('does NOT flag the first word of a sentence as a proper noun', () => {
    const tokens = extractSalientTokens('Seattle is beautiful.');
    const seattle = tokens.find((t) => t.surface === 'Seattle');
    // First-of-sentence capitalization is ambiguous — treated as content at best.
    expect(seattle?.kind).not.toBe('proper-noun');
  });

  it('flags backticked identifiers at the highest weight', () => {
    const tokens = extractSalientTokens('Use `useState` for local state.');
    const us = tokens.find((t) => t.surface === 'useState');
    expect(us).toBeDefined();
    expect(us?.kind).toBe('backticked');
    expect(us?.weight).toBeGreaterThanOrEqual(3);
  });

  it('flags camelCase tokens as code identifiers', () => {
    const tokens = extractSalientTokens('then call getUserProfile with the id.');
    const id = tokens.find((t) => t.surface === 'getUserProfile');
    expect(id).toBeDefined();
    expect(id?.kind).toBe('code-identifier');
  });

  it('flags snake_case and $-prefixed identifiers', () => {
    const tokens = extractSalientTokens('set the user_id and then $scope apply');
    const snake = tokens.find((t) => t.surface === 'user_id');
    expect(snake?.kind).toBe('code-identifier');
    const dollar = tokens.find((t) => t.surface.startsWith('$scope'));
    expect(dollar?.kind).toBe('code-identifier');
  });

  it('ignores stopwords and emits rare-word kind for uncommon vocab', () => {
    const tokens = extractSalientTokens('The subcontractor is onboarding.');
    expect(tokens.find((t) => t.surface.toLowerCase() === 'the')).toBeUndefined();
    const rare = tokens.find((t) => t.surface === 'subcontractor');
    expect(rare?.kind).toBe('rare-word');
  });

  it('returns empty on empty input', () => {
    expect(extractSalientTokens('')).toEqual([]);
    expect(extractSalientTokens('   ')).toEqual([]);
  });

  it('de-duplicates repeated tokens', () => {
    const tokens = extractSalientTokens('Seattle Seattle Seattle.');
    const count = tokens.filter((t) => t.surface.toLowerCase() === 'seattle').length;
    expect(count).toBe(1);
  });
});
