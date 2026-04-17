import { describe, expect, it } from 'vitest';
import { pickFiller } from '../src/filler.js';

describe('pickFiller', () => {
  it('returns a reason-appropriate filler', () => {
    expect(pickFiller('tool-needed', 0)).toMatch(/check|moment|looking/i);
    expect(pickFiller('complex-reasoning', 0)).toMatch(/think/i);
  });

  it('rotates across the pool', () => {
    const a = pickFiller('tool-needed', 0);
    const b = pickFiller('tool-needed', 1);
    const c = pickFiller('tool-needed', 2);
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('falls back for unknown reasons', () => {
    expect(pickFiller('nonexistent', 0)).toBeTruthy();
  });
});
