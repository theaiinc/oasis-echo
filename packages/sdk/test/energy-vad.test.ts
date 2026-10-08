import { describe, expect, it } from 'vitest';
import { EnergyVad } from '../src/browser/energy-vad.js';

describe('EnergyVad', () => {
  it('starts on sustained speech above the room, ends after quiet', () => {
    const events: string[] = [];
    const vad = new EnergyVad({ onStart: () => events.push('start'), onEnd: () => events.push('end') });
    let t = 0;
    for (let i = 0; i < 20; i++) vad.frame(0.004, (t += 30)); // quiet room
    vad.frame(0.2, (t += 30)); // a click is not speech
    vad.frame(0.004, (t += 30));
    expect(events).toEqual([]);
    for (let i = 0; i < 8; i++) vad.frame(0.1, (t += 30)); // talking
    expect(events).toEqual(['start']);
    for (let i = 0; i < 20; i++) vad.frame(0.1, (t += 30));
    for (let i = 0; i < 40; i++) vad.frame(0.004, (t += 30)); // 1.2 s quiet
    expect(events).toEqual(['start', 'end']);
  });

  it("ignores the agent's own voice while it speaks", () => {
    const events: string[] = [];
    let listening = false;
    const vad = new EnergyVad({ isListening: () => listening, onStart: () => events.push('start'), onEnd: () => events.push('end') });
    let t = 0;
    for (let i = 0; i < 30; i++) vad.frame(0.1, (t += 30));
    expect(events).toEqual([]);
    listening = true;
    for (let i = 0; i < 8; i++) vad.frame(0.1, (t += 30));
    expect(events).toEqual(['start']);
  });
});

describe('EnergyVad with background noise', () => {
  it('drops steady noise that never dips, then ignores that level', () => {
    const events: string[] = [];
    const vad = new EnergyVad({ onStart: () => events.push('start'), onEnd: () => events.push('end'), onCancel: () => events.push('cancel') });
    let t = 0;
    for (let i = 0; i < 20; i++) vad.frame(0.004, (t += 30)); // quiet room
    for (let i = 0; i < 120; i++) vad.frame(0.05 + (i % 3) * 0.002, (t += 30)); // a TV comes on: 3.6 s, no gaps
    expect(events).toEqual(['start', 'cancel']);
    expect(vad.noiseFloor).toBeGreaterThan(0.04);
    for (let i = 0; i < 60; i++) vad.frame(0.05, (t += 30)); // the TV keeps going
    expect(events).toEqual(['start', 'cancel']);
    // Talking over it, with gaps between words, still counts.
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 8; i++) vad.frame(0.25, (t += 30));
      for (let i = 0; i < 3; i++) vad.frame(0.05, (t += 30));
    }
    expect(events).toEqual(['start', 'cancel', 'start']);
  });

  it('keeps a long turn with natural gaps', () => {
    const events: string[] = [];
    const vad = new EnergyVad({ onStart: () => events.push('start'), onEnd: () => events.push('end'), onCancel: () => events.push('cancel') });
    let t = 0;
    for (let i = 0; i < 20; i++) vad.frame(0.004, (t += 30));
    for (let w = 0; w < 30; w++) { // ~8 s of words with short gaps
      for (let i = 0; i < 7; i++) vad.frame(0.1, (t += 30));
      vad.frame(0.005, (t += 30)); vad.frame(0.005, (t += 30));
    }
    expect(events).toEqual(['start']);
  });
});
