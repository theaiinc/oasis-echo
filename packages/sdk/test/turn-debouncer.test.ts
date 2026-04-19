import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TurnDebouncer } from '../src/turn-debouncer.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TurnDebouncer', () => {
  it('commits after the silence window elapses', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('hello there');
    vi.advanceTimersByTime(999);
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onCommit).toHaveBeenCalledWith('hello there');
  });

  it('accumulates multiple final fragments into one commit', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('hello');
    vi.advanceTimersByTime(500);
    deb.onFinal('there friend');
    vi.advanceTimersByTime(1001);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('hello there friend');
  });

  it('interim events cancel the pending commit', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('cold but what if');
    vi.advanceTimersByTime(500);
    deb.onInterim('I cannot go');
    vi.advanceTimersByTime(5000); // timer was cancelled; nothing fires
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('doubles the silence window when the tail is an incomplete-thought fragment', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({
      silenceMs: 1000,
      incompleteTailMultiplier: 2,
      onCommit,
    });
    deb.onFinal('cold but what if');
    // Regular timeout would have fired by now — but tail is "what if".
    vi.advanceTimersByTime(1500);
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600); // total 2100 ms, past the 2000 extended deadline
    expect(onCommit).toHaveBeenCalledWith('cold but what if');
  });

  it('uses normal window when tail is complete', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('cold but what if I cannot go');
    vi.advanceTimersByTime(1050);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('flush() commits immediately and resets buffer', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('something');
    deb.flush();
    expect(onCommit).toHaveBeenCalledWith('something');
    deb.flush();
    expect(onCommit).toHaveBeenCalledOnce(); // buffer emptied, no double
  });

  it('cancel() discards the buffer without committing', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('something');
    deb.cancel();
    vi.advanceTimersByTime(5000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('emits state changes', () => {
    const states: string[] = [];
    const deb = new TurnDebouncer({
      silenceMs: 1000,
      onCommit: () => {},
      onStateChange: (s) => states.push(s.kind),
    });
    deb.onInterim('hel');
    deb.onFinal('hello');
    vi.advanceTimersByTime(1100);
    // listening (interim) → pausing (scheduled) → idle (committed)
    expect(states).toEqual(['listening', 'pausing', 'idle']);
  });

  it('ignores empty onFinal', () => {
    const onCommit = vi.fn();
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit });
    deb.onFinal('   ');
    vi.advanceTimersByTime(5000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('getBuffer reflects the accumulated text', () => {
    const deb = new TurnDebouncer({ silenceMs: 1000, onCommit: () => {} });
    deb.onFinal('hi');
    expect(deb.getBuffer()).toBe('hi');
    deb.onFinal('there');
    expect(deb.getBuffer()).toBe('hi there');
  });
});
