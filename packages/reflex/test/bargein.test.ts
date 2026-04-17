import { describe, expect, it } from 'vitest';
import { BargeInDetector } from '../src/bargein.js';

describe('BargeInDetector', () => {
  it('does not trigger when agent is silent', () => {
    const d = new BargeInDetector({ minProbability: 0.5, minSustainedMs: 50 });
    expect(d.observe({ speech: true, probability: 0.9, atMs: 0 }, false)).toBe(false);
    expect(d.observe({ speech: true, probability: 0.9, atMs: 100 }, false)).toBe(false);
  });

  it('triggers once speech is sustained past threshold while agent speaks', () => {
    const d = new BargeInDetector({ minProbability: 0.5, minSustainedMs: 80 });
    expect(d.observe({ speech: true, probability: 0.9, atMs: 0 }, true)).toBe(false);
    expect(d.observe({ speech: true, probability: 0.9, atMs: 50 }, true)).toBe(false);
    expect(d.observe({ speech: true, probability: 0.9, atMs: 100 }, true)).toBe(true);
  });

  it('does not re-trigger while already active', () => {
    const d = new BargeInDetector({ minProbability: 0.5, minSustainedMs: 50 });
    d.observe({ speech: true, probability: 0.9, atMs: 0 }, true);
    d.observe({ speech: true, probability: 0.9, atMs: 100 }, true);
    expect(d.observe({ speech: true, probability: 0.9, atMs: 200 }, true)).toBe(false);
  });
});
