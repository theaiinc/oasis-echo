import { describe, expect, it } from 'vitest';
import { BargeInMonitor } from '../src/browser/barge-in-monitor.js';

function monitor() {
  const events: string[] = [];
  // Like VoiceSession: once interrupted, the agent stops speaking and the monitor idles.
  const m = new BargeInMonitor({
    isActive: () => !events.includes('bargein'),
    graceMs: 0,
    onBargeIn: () => events.push('bargein'),
    onDuck: (d) => events.push(d ? 'duck' : 'unduck'),
  });
  return { m, events };
}

describe('BargeInMonitor', () => {
  it('a short noise only ducks the agent, then restores it', () => {
    const { m, events } = monitor();
    let t = 0;
    for (let i = 0; i < 20; i++) m.level(2, (t += 16), 16); // agent bleed baseline
    for (let i = 0; i < 12; i++) m.level(30, (t += 16), 16); // ~190 ms clatter
    for (let i = 0; i < 70; i++) m.level(2, (t += 16), 16);
    expect(events).toEqual(['duck', 'unduck']);
  });

  it('the user talking over the agent interrupts it', () => {
    const { m, events } = monitor();
    let t = 0;
    for (let i = 0; i < 20; i++) m.level(2, (t += 16), 16);
    for (let i = 0; i < 50 && !events.includes('bargein'); i++) m.level(i % 6 === 5 ? 4 : 30, (t += 16), 16); // ~800 ms of speech
    expect(events).toEqual(['duck', 'bargein']);
  });
});
