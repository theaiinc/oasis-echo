import { describe, expect, it } from 'vitest';
import { endpointMs } from '../src/endpoint.js';

describe('endpointMs', () => {
  it('answers soonest after a question, soon after a finished sentence', () => {
    expect(endpointMs('Can you hear me?')).toBe(300);
    expect(endpointMs('Bạn có nghe mình không?')).toBe(300);
    expect(endpointMs("That's all for today.")).toBe(800);
  });

  it('waits longer when the words trail off mid-thought', () => {
    for (const t of ['I want to check the', 'So I was thinking and', 'Let me see, um.', 'Mình muốn hỏi về dự án và', 'Well...', 'The thing is,']) {
      expect(endpointMs(t), t).toBe(1800);
    }
  });

  it('uses a middle wait otherwise', () => {
    expect(endpointMs('okay thanks')).toBe(900);
  });
});
