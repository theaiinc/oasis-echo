import { describe, expect, it } from 'vitest';
import { Endpointer } from '../src/endpointer.js';

describe('Endpointer', () => {
  it('fires speech.start on first voiced frame', () => {
    const ep = new Endpointer();
    const ev = ep.feed({ speech: true, probability: 0.9, atMs: 0 });
    expect(ev?.type).toBe('speech.start');
  });

  it('holds through brief silence without ending', () => {
    const ep = new Endpointer({ silenceHoldMs: 300, minSpeechMs: 100 });
    ep.feed({ speech: true, probability: 0.9, atMs: 0 });
    ep.feed({ speech: true, probability: 0.9, atMs: 200 });
    const brief = ep.feed({ speech: false, probability: 0.1, atMs: 300 });
    expect(brief).toBeNull();
  });

  it('fires speech.end after hangover', () => {
    const ep = new Endpointer({ silenceHoldMs: 300, minSpeechMs: 100 });
    ep.feed({ speech: true, probability: 0.9, atMs: 0 });
    ep.feed({ speech: true, probability: 0.9, atMs: 400 });
    const end = ep.feed({ speech: false, probability: 0.1, atMs: 800 });
    expect(end?.type).toBe('speech.end');
    if (end?.type === 'speech.end') {
      expect(end.durationMs).toBe(400);
    }
  });

  it('suppresses utterances shorter than minSpeechMs', () => {
    const ep = new Endpointer({ silenceHoldMs: 200, minSpeechMs: 500 });
    ep.feed({ speech: true, probability: 0.9, atMs: 0 });
    ep.feed({ speech: true, probability: 0.9, atMs: 100 });
    const end = ep.feed({ speech: false, probability: 0.1, atMs: 400 });
    expect(end).toBeNull();
  });
});
