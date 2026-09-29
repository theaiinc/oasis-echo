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
