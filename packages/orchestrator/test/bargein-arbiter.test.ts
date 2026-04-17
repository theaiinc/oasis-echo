import { describe, expect, it } from 'vitest';
import { BargeInArbiter } from '../src/bargein-arbiter.js';
import { EventBus } from '../src/event-bus.js';

describe('BargeInArbiter', () => {
  it('reports not speaking before any turn', () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    expect(a.isSpeaking).toBe(false);
  });

  it('begins and ends a turn cleanly', () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    const sig = a.beginTurn('t1', () => {});
    expect(a.isSpeaking).toBe(true);
    expect(sig.aborted).toBe(false);
    a.endTurn('t1');
    expect(a.isSpeaking).toBe(false);
  });

  it('aborts signal and flushes on barge-in', async () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    let flushed = false;
    const sig = a.beginTurn('t1', () => {
      flushed = true;
    });
    const result = await a.bargeIn(1234);
    expect(result).toBe(true);
    expect(sig.aborted).toBe(true);
    expect(flushed).toBe(true);
    expect(a.isSpeaking).toBe(false);
  });

  it('emits a bargein event on the bus', async () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    const events: string[] = [];
    bus.on('bargein', (e) => void events.push(e.interruptedTurnId));
    a.beginTurn('t-abc', () => {});
    await a.bargeIn(1);
    expect(events).toEqual(['t-abc']);
  });

  it('returns false when nothing is speaking', async () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    expect(await a.bargeIn(0)).toBe(false);
  });

  it('aborts the prior turn when a new turn begins', () => {
    const bus = new EventBus();
    const a = new BargeInArbiter(bus);
    const sig1 = a.beginTurn('t1', () => {});
    a.beginTurn('t2', () => {});
    expect(sig1.aborted).toBe(true);
  });
});
