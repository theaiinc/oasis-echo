import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDiff, CorrectionStore } from '../src/postprocess/corrections.js';

/* -----------------------------------------------------------------
 * Diff analyzer — classifies a correction into word rules + phrases
 * ----------------------------------------------------------------- */
describe('analyzeDiff', () => {
  it('extracts a word pair for a single-word substitution', () => {
    const out = analyzeDiff('schedule a meting', 'schedule a meeting');
    expect(out.wordPairs).toEqual([{ wrong: 'meting', right: 'meeting' }]);
    expect(out.addAsPhrase).toBe(true);
  });

  it('does not extract a word pair when two words differ', () => {
    const out = analyzeDiff('send a email', 'send an email');
    // Different word counts won't line up; pairs stay empty.
    expect(out.wordPairs).toEqual([]);
    expect(out.addAsPhrase).toBe(true);
  });

  it('extracts a multi-word span pair by trimming the common prefix/suffix', () => {
    // "turn"/"the" are shared context; only the middle span changed.
    // A same-length-only heuristic would miss this (2 tokens mismatch
    // on each side), but the prefix/suffix trim isolates it cleanly.
    const out = analyzeDiff('turn off the lights', 'turn on the monitor');
    expect(out.wordPairs).toEqual([{ wrong: 'off the lights', right: 'on the monitor' }]);
  });

  it('extracts a span pair even when the token count changes', () => {
    // The real motivating case: "P, N, L" collapses into "PNL" — a
    // strict same-token-count check can never match this, since three
    // tokens become one, but prefix/suffix trimming isolates the
    // changed middle regardless of how many tokens are on each side.
    const out = analyzeDiff(
      'the keyword is P, N, L, A to Z',
      'the keyword is PNL, A to Z',
    );
    expect(out.wordPairs).toEqual([{ wrong: 'P, N, L', right: 'PNL' }]);
  });

  it('strips leading/trailing punctuation from an extracted span', () => {
    // The trailing sentence comma (attached to the token by the simple
    // whitespace tokenizer) gets stripped along with it — an inherent
    // limit of not being punctuation-aware, acceptable for a
    // best-effort learned rule.
    const out = analyzeDiff('call the p.n.l., today', 'call the PNL, today');
    expect(out.wordPairs).toEqual([{ wrong: 'p.n.l', right: 'PNL' }]);
  });

  it('does not extract a pair for a pure insertion (nothing replaced)', () => {
    const out = analyzeDiff('turn on lights', 'turn on the lights');
    expect(out.wordPairs).toEqual([]);
    expect(out.addAsPhrase).toBe(true);
  });

  it('does not extract a pair when the changed span is too long', () => {
    // Shared "start"/"end" trims to a 7-word replacement span — over
    // the 6-word cap, so this reads as an unrelated rewrite rather
    // than a plausible "this word/phrase is always mis-heard" rule.
    const out = analyzeDiff('start a b end', 'start w1 w2 w3 w4 w5 w6 w7 end');
    expect(out.wordPairs).toEqual([]);
    expect(out.addAsPhrase).toBe(true);
  });

  it('treats single-word corrections as word rules, not phrases', () => {
    const out = analyzeDiff('meting', 'meeting');
    expect(out.wordPairs).toEqual([{ wrong: 'meting', right: 'meeting' }]);
    expect(out.addAsPhrase).toBe(false);
  });

  it('returns empty pairs when no diff', () => {
    const out = analyzeDiff('hello world', 'hello world');
    expect(out.wordPairs).toEqual([]);
  });
});

/* -----------------------------------------------------------------
 * CorrectionStore — JSON-backed persistence + live change hook
 * ----------------------------------------------------------------- */
describe('CorrectionStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oasis-corr-'));
    file = join(dir, 'corrections.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when file is absent', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    expect(store.wordRules()).toEqual({});
    expect(store.phrases()).toEqual([]);
  });

  it('persists a single-word correction as a word rule', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('meting', 'meeting');
    expect(store.wordRules()).toEqual({ meting: 'meeting' });
    expect(store.phrases()).toEqual([]);
  });

  it('persists a multi-word correction as a phrase', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('send a email', 'send an email');
    expect(store.phrases()).toEqual(['send an email']);
  });

  it('can persist review feedback as a phrase without a global word rule', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('schedule a meting', 'schedule a meeting', { phraseOnly: true });
    expect(store.wordRules()).toEqual({});
    expect(store.phrases()).toEqual(['schedule a meeting']);
  });

  it('promotes the targeted span only, not the whole sentence, when one is found', async () => {
    // Once analyzeDiff isolates "meting" -> "meeting" as a clean
    // targeted span, adding the whole sentence as a phrase too would
    // just be redundant clutter that will essentially never match
    // anything else verbatim.
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('schedule a meting', 'schedule a meeting');
    expect(store.wordRules()).toEqual({ meting: 'meeting' });
    expect(store.phrases()).toEqual([]);
  });

  it('survives a reload from disk', async () => {
    const s1 = new CorrectionStore(file);
    await s1.load();
    await s1.addCorrection('teh', 'the');
    await s1.addCorrection('turn on lights', 'turn on the lights');

    const s2 = new CorrectionStore(file);
    await s2.load();
    expect(s2.wordRules()).toEqual({ teh: 'the' });
    expect(s2.phrases()).toContain('turn on the lights');
  });

  it('fires onChange after each mutation', async () => {
    let changes = 0;
    const store = new CorrectionStore(file, () => changes++);
    await store.load();
    await store.addCorrection('a', 'b');
    await store.addCorrection('schedule meeting', 'schedule a meeting');
    expect(changes).toBe(2);
  });

  it('removes word rules and phrases by key', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('meting', 'meeting');
    await store.addCorrection('send a email', 'send an email');
    expect(await store.removeWordRule('meting')).toBe(true);
    expect(store.wordRules()).toEqual({});
    expect(await store.removePhrase('send an email')).toBe(true);
    expect(store.phrases()).toEqual([]);
    expect(await store.removeWordRule('nonexistent')).toBe(false);
  });

  it('deduplicates phrase insertions', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('send email', 'send an email');
    await store.addCorrection('send a email', 'send an email');
    expect(store.phrases()).toEqual(['send an email']);
  });

  it('tracks history', async () => {
    const store = new CorrectionStore(file);
    await store.load();
    await store.addCorrection('a', 'b');
    const h = store.history();
    expect(h).toHaveLength(1);
    expect(h[0]?.original).toBe('a');
    expect(h[0]?.corrected).toBe('b');
  });

  it('is resilient to malformed JSON on disk', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{not json at all');
    const store = new CorrectionStore(file);
    await store.load();
    expect(store.wordRules()).toEqual({});
    expect(store.phrases()).toEqual([]);
  });
});
