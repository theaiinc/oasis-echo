import { describe, expect, it } from 'vitest';
import { pickContinuationFiller, pickFirstFiller } from '../src/filler.js';

describe('pickFirstFiller', () => {
  it('returns a short natural opener', () => {
    const f = pickFirstFiller();
    expect(f).toMatch(/hmm|well|okay|right|uh|yeah|alright|let.?s see|let me see|good question|oh,/i);
    expect(f.length).toBeLessThan(32);
  });

  it('avoids phrases in the recent set on first pick', () => {
    // Run many fresh picks with the same starting recent set.
    // Each call should prefer a phrase not already in recent.
    const picks: string[] = [];
    for (let i = 0; i < 20; i++) {
      const recent = new Set(['Hmm.', 'Well.', 'Okay.']);
      picks.push(pickFirstFiller(recent));
    }
    // Every pick should come from outside the initial recent set.
    for (const p of picks) {
      expect(['Hmm.', 'Well.', 'Okay.']).not.toContain(p);
    }
  });

  it('still returns something when all phrases are recent', () => {
    // With every first-beat exhausted, the function should still yield
    // a phrase rather than crash.
    const recent = new Set([
      'Hmm.',
      'Well.',
      'Okay.',
      'Right.',
      'Uh, okay.',
      'Mm, alright.',
      'Let me see.',
    ]);
    expect(pickFirstFiller(recent)).toBeTruthy();
  });
});

describe('pickContinuationFiller', () => {
  it('returns a reason-appropriate chained filler', () => {
    const used = new Set<string>();
    const f = pickContinuationFiller('complex-reasoning', used);
    expect(f.length).toBeGreaterThan(10);
  });

  it('never picks the same phrase twice in one turn', () => {
    const used = new Set<string>();
    const a = pickContinuationFiller('complex-reasoning', used);
    const b = pickContinuationFiller('complex-reasoning', used);
    // a and b are chains — split and confirm no overlap.
    const partsA = new Set(a.split(/\s*[.!?]\s*/).filter((p) => p));
    const partsB = b.split(/\s*[.!?]\s*/).filter((p) => p);
    for (const p of partsB) {
      expect(partsA.has(p)).toBe(false);
    }
  });

  it('respects the recent set across turns', () => {
    const recent = new Set(['Let me think about that for a moment.']);
    const used = new Set<string>();
    const f = pickContinuationFiller('complex-reasoning', used, recent);
    expect(f).not.toContain('Let me think about that for a moment.');
  });

  it('falls back for unknown reasons', () => {
    expect(pickContinuationFiller('nonexistent', new Set())).toBeTruthy();
  });
});
