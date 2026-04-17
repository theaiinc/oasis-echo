import { describe, expect, it } from 'vitest';
import { DialogueStateStore } from '../src/state.js';

describe('DialogueStateStore', () => {
  it('starts in idle with matching allowed intents', () => {
    const s = new DialogueStateStore({ sessionId: 's1' });
    expect(s.phase).toBe('idle');
    expect(s.allowedIntents).toContain('greeting');
    expect(s.allowedIntents).not.toContain('confirm');
  });

  it('transitions idle → collecting on a tool command', () => {
    const s = new DialogueStateStore({ sessionId: 's1' });
    const res = s.applyIntent('command_tool');
    expect(res.transitioned).toBe(true);
    expect(s.phase).toBe('collecting');
  });

  it('transitions collecting → confirming → executing on confirm', () => {
    const s = new DialogueStateStore({ sessionId: 's1' });
    s.applyIntent('command_tool');
    s.applyIntent('command_tool');
    expect(s.phase).toBe('confirming');
    expect(s.allowedIntents).toContain('confirm');
    s.applyIntent('confirm');
    expect(s.phase).toBe('executing');
  });

  it('does not transition on disallowed intent', () => {
    const s = new DialogueStateStore({ sessionId: 's1' });
    const res = s.applyIntent('backchannel');
    expect(res.transitioned).toBe(false);
    expect(s.phase).toBe('idle');
  });

  it('stores and reads slots', () => {
    const s = new DialogueStateStore({ sessionId: 's1' });
    s.setSlot('account', '1234');
    expect(s.getSlot('account')).toBe('1234');
  });
});
