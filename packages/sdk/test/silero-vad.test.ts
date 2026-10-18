import { describe, expect, it } from 'vitest';
import { SileroVad } from '../src/browser/silero-vad.js';

// `frame(p)` takes one 32 ms speech probability, as the model would give it.
const make = (events: string[], opts: { listening?: () => boolean } = {}) =>
  new SileroVad({
    modelUrl: '',
    ortWasmUrl: '',
    ...(opts.listening ? { isListening: opts.listening } : {}),
    onStart: () => events.push('start'),
    onEnd: () => events.push('end'),
    onCancel: () => events.push('cancel'),
  });
const run = (vad: SileroVad, p: number, frames: number) => {
  for (let i = 0; i < frames; i++) vad.frame(p);
};

describe('SileroVad', () => {
  it('starts on speech, rides out short pauses, ends after a long one', () => {
    const events: string[] = [];
    const vad = make(events);
    run(vad, 0.05, 30); // a noisy room the model doesn't take for speech
    run(vad, 0.9, 2); // 64 ms: too short to start
    run(vad, 0.05, 2);
    expect(events).toEqual([]);
    run(vad, 0.9, 20);
    expect(events).toEqual(['start']);
    run(vad, 0.1, 10); // 320 ms between words
    run(vad, 0.9, 20);
    expect(events).toEqual(['start']);
    run(vad, 0.1, 22); // 704 ms
    expect(events).toEqual(['start', 'end']);
  });

  it('treats an in-between probability as still talking', () => {
    const events: string[] = [];
    const vad = make(events);
    run(vad, 0.9, 10);
    run(vad, 0.4, 40); // above the pause threshold: a trailing, quieter word
    expect(events).toEqual(['start']);
  });

  it('drops an utterance with too little speech in it', () => {
    const events: string[] = [];
    const vad = make(events);
    run(vad, 0.9, 3); // 96 ms: starts
    run(vad, 0.1, 30);
    expect(events).toEqual(['start', 'cancel']);
  });

  it("ignores speech while the agent talks and ends the user's turn when it starts", () => {
    const events: string[] = [];
    let listening = false;
    const vad = make(events, { listening: () => listening });
    run(vad, 0.9, 30);
    expect(events).toEqual([]);
    listening = true;
    run(vad, 0.9, 20);
    listening = false;
    vad.frame(0.9);
    expect(events).toEqual(['start', 'end']);
  });

  it('cuts an utterance that never pauses at the longest length, then carries on in a new one', () => {
    const events: string[] = [];
    const vad = make(events);
    run(vad, 0.9, Math.ceil(20_000 / 32));
    expect(events).toEqual(['start', 'end']);
    run(vad, 0.9, 5);
    expect(events).toEqual(['start', 'end', 'start']);
  });
});
