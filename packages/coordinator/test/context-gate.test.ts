import { describe, expect, it } from 'vitest';
import { classifyQuestion, detectTopicChange } from '../src/postprocess/context-gate.js';

describe('detectTopicChange', () => {
  it('returns no-change when there is no agent context', () => {
    expect(detectTopicChange('hello', undefined).changed).toBe(false);
  });

  it('returns no-change when the reply fits a yes-no question', () => {
    const r = detectTopicChange('yes please', {
      lastUtterance: 'Do you want coffee?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(false);
  });

  it('flags an explicit topic-change marker', () => {
    const r = detectTopicChange('by the way, what time is it', {
      lastUtterance: 'Do you want coffee?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('explicit-marker');
  });

  it('flags "actually" as a topic change', () => {
    const r = detectTopicChange('actually, never mind about that', {
      lastUtterance: 'Should I book the flight?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(true);
  });

  it('flags a yes-no question answered with an unrelated short reply', () => {
    const r = detectTopicChange('pizza', {
      lastUtterance: 'Should I book the flight?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('yes-no-mismatch');
  });

  it('does NOT flag long free-form replies as yes-no mismatches', () => {
    const r = detectTopicChange(
      'well I think it depends on the price and the timing and who else is going',
      {
        lastUtterance: 'Should I book the flight?',
        pendingQuestion: { kind: 'yes-no' },
      },
    );
    // Long reply → not short enough to be a mismatch signal.
    expect(r.changed).toBe(false);
  });

  it('accepts a choice-question reply when one option is mentioned', () => {
    const r = detectTopicChange('coffee please', {
      lastUtterance: 'coffee or tea?',
      pendingQuestion: { kind: 'choice', options: ['coffee', 'tea'] },
    });
    expect(r.changed).toBe(false);
  });

  it('flags a choice-question reply when no option is mentioned', () => {
    const r = detectTopicChange('water', {
      lastUtterance: 'coffee or tea?',
      pendingQuestion: { kind: 'choice', options: ['coffee', 'tea'] },
    });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('choice-mismatch');
  });
});

describe('classifyQuestion', () => {
  it('classifies yes-no auxiliary-led questions', () => {
    expect(classifyQuestion('Do you want coffee?')).toEqual({ kind: 'yes-no' });
    expect(classifyQuestion('Is it ready?')).toEqual({ kind: 'yes-no' });
    expect(classifyQuestion('Can you help me?')).toEqual({ kind: 'yes-no' });
  });

  it('classifies "A or B" as a choice', () => {
    const r = classifyQuestion('coffee or tea?');
    expect(r?.kind).toBe('choice');
    expect(r?.options).toEqual(['coffee', 'tea']);
  });

  it('classifies wh-questions as open', () => {
    expect(classifyQuestion('What time is it?')).toEqual({ kind: 'open' });
    expect(classifyQuestion('Where is the station?')).toEqual({ kind: 'open' });
  });

  it('returns undefined for statements (no question mark)', () => {
    expect(classifyQuestion('I think so.')).toBeUndefined();
    expect(classifyQuestion('Okay.')).toBeUndefined();
  });

  it('uses only the last sentence for classification', () => {
    // Statement followed by a yes-no question.
    const r = classifyQuestion("Here's the plan. Do you agree?");
    expect(r?.kind).toBe('yes-no');
  });
});
