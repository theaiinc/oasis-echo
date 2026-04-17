import { describe, expect, it } from 'vitest';
import { Guardrail } from '../src/guardrail.js';

describe('Guardrail', () => {
  it('passes a confident local decision', () => {
    const g = new Guardrail({ minConfidence: 0.5 });
    const res = g.check({
      intent: 'greeting',
      confidence: 0.9,
      decision: { kind: 'local', intent: 'greeting', reply: 'Hi' },
    });
    expect(res.ok).toBe(true);
  });

  it('escalates low-confidence local decisions', () => {
    const g = new Guardrail({ minConfidence: 0.7 });
    const res = g.check({
      intent: 'smalltalk',
      confidence: 0.4,
      decision: { kind: 'local', intent: 'smalltalk', reply: 'ok' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fallback.decision.kind).toBe('escalate');
    }
  });

  it('escalates oversized replies', () => {
    const g = new Guardrail({ maxReplyChars: 10 });
    const res = g.check({
      intent: 'smalltalk',
      confidence: 0.9,
      decision: { kind: 'local', intent: 'smalltalk', reply: 'x'.repeat(50) },
    });
    expect(res.ok).toBe(false);
  });

  it('leaves escalations untouched', () => {
    const g = new Guardrail();
    const res = g.check({
      intent: 'question_complex',
      confidence: 0.3,
      decision: { kind: 'escalate', intent: 'question_complex', reason: 'complex' },
    });
    expect(res.ok).toBe(true);
  });
});
