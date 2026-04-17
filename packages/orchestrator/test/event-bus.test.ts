import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  it('delivers to typed handlers', async () => {
    const bus = new EventBus();
    const hits: string[] = [];
    bus.on('vad.start', (e) => void hits.push(`start:${e.atMs}`));
    await bus.emit({ type: 'vad.start', atMs: 123 });
    expect(hits).toEqual(['start:123']);
  });

  it('delivers to wildcard handlers', async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.onAny((e) => void types.push(e.type));
    await bus.emit({ type: 'vad.start', atMs: 0 });
    await bus.emit({ type: 'vad.end', atMs: 10, durationMs: 10 });
    expect(types).toEqual(['vad.start', 'vad.end']);
  });

  it('supports unsubscribing', async () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('vad.start', () => void count++);
    await bus.emit({ type: 'vad.start', atMs: 0 });
    off();
    await bus.emit({ type: 'vad.start', atMs: 1 });
    expect(count).toBe(1);
  });
});
