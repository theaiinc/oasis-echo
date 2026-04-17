import { describe, expect, it } from 'vitest';
import { reflexClassify } from '../src/reflex-intent.js';

describe('reflexClassify', () => {
  it('classifies greetings', () => {
    const out = reflexClassify('hello');
    expect(out?.intent).toBe('greeting');
    expect(out?.decision.kind).toBe('reflex');
  });

  it('classifies confirmations', () => {
    expect(reflexClassify('yes')?.intent).toBe('confirm');
    expect(reflexClassify('yeah')?.intent).toBe('confirm');
    expect(reflexClassify('correct')?.intent).toBe('confirm');
  });

  it('classifies denials and cancellations', () => {
    expect(reflexClassify('no')?.intent).toBe('deny');
    expect(reflexClassify('nevermind')?.intent).toBe('cancel');
    expect(reflexClassify('stop')?.intent).toBe('stop');
  });

  it('returns null for novel phrases', () => {
    expect(reflexClassify('what is the capital of france')).toBeNull();
    expect(reflexClassify('schedule a meeting for tomorrow at 3pm')).toBeNull();
  });

  it('rejects long inputs', () => {
    expect(reflexClassify('yes '.repeat(20))).toBeNull();
  });
});
