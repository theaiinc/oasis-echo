import { describe, expect, it } from 'vitest';
import { MockTts } from '@oasis-echo/coordinator';
import { MockReasoner } from '@oasis-echo/reasoning';
import { Metrics } from '@oasis-echo/telemetry';
import { Pipeline } from '../src/pipeline.js';

describe('Pipeline', () => {
  it('runs a reflex turn without calling the reasoner', async () => {
    const metrics = new Metrics();
    let reasonerCalls = 0;
    const reasoner = new MockReasoner();
    const origStream = reasoner.stream.bind(reasoner);
    reasoner.stream = (input) => {
      reasonerCalls++;
      return origStream(input);
    };
    const p = new Pipeline({
      sessionId: 't',
      reasoner,
      tts: new MockTts(),
      metrics,
    });
    const chunks: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    const turn = await p.handleTurn('hello');
    expect(turn.tier).toBe('reflex');
    expect(turn.intent).toBe('greeting');
    expect(reasonerCalls).toBe(0);
    expect(chunks.join('')).toContain('Hi');
  });

  it('runs a local coordinator turn for smalltalk', async () => {
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner(),
      tts: new MockTts(),
    });
    const turn = await p.handleTurn('sure thing');
    expect(['reflex', 'local']).toContain(turn.tier);
  });

  it('escalates complex questions through the reasoner', async () => {
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner({ tokens: ['This ', 'is ', 'a ', 'cloud ', 'answer.'] }),
      tts: new MockTts(),
    });
    const chunks: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    const turn = await p.handleTurn('why is the sky blue');
    expect(turn.tier).toBe('escalated');
    const joined = chunks.join('');
    expect(joined).toContain('cloud answer');
  });

  it('plays a filler chunk first when the reasoner is slow', async () => {
    const slow = new Pipeline({
      sessionId: 's',
      reasoner: new MockReasoner({
        tokens: ['Slow ', 'answer.'],
        delayMs: 800, // first token at ~800ms, past the 600ms threshold
      }),
      tts: new MockTts(),
    });
    const events: Array<{ text: string; filler: boolean }> = [];
    slow.bus.on('tts.chunk', (e) =>
      void events.push({ text: e.text, filler: e.filler === true }),
    );
    await slow.handleTurn('why is gravity a thing');
    const fillerCount = events.filter((e) => e.filler).length;
    expect(fillerCount).toBeGreaterThan(0);
    expect(events.map((e) => e.text).join(' ').toLowerCase()).toContain('slow');
  });

  it('skips the filler entirely when the reasoner is fast', async () => {
    const fast = new Pipeline({
      sessionId: 'f',
      reasoner: new MockReasoner({
        tokens: ['Fast ', 'answer.'],
        delayMs: 10, // first token well before the 600ms threshold
      }),
      tts: new MockTts(),
    });
    const events: Array<{ text: string; filler: boolean }> = [];
    fast.bus.on('tts.chunk', (e) =>
      void events.push({ text: e.text, filler: e.filler === true }),
    );
    await fast.handleTurn('why is gravity a thing');
    const fillerCount = events.filter((e) => e.filler).length;
    expect(fillerCount).toBe(0);
    expect(events.map((e) => e.text).join(' ').toLowerCase()).toContain('fast answer');
  });

  it('emits route.decision and turn.complete events', async () => {
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner(),
      tts: new MockTts(),
    });
    const decisions: string[] = [];
    const completions: string[] = [];
    p.bus.on('route.decision', (e) => void decisions.push(e.decision.kind));
    p.bus.on('turn.complete', (e) => void completions.push(e.turn.tier));
    await p.handleTurn('why is gravity a thing');
    expect(decisions.length).toBeGreaterThan(0);
    expect(completions).toContain('escalated');
  });

  it('barge-in aborts the turn mid-flight', async () => {
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner({
        tokens: ['slow ', 'slow ', 'slow ', 'slow ', 'slow ', 'slow ', 'slow.'],
        delayMs: 30,
      }),
      tts: new MockTts(),
    });
    const promise = p.handleTurn('why is gravity a thing');
    await new Promise((r) => setTimeout(r, 40));
    const interrupted = await p.bargeIn();
    expect(interrupted).toBe(true);
    const turn = await promise;
    expect(turn.tier).toBe('escalated');
    expect(turn.interrupted).toBe(true);
  });

  it('records metrics', async () => {
    const metrics = new Metrics();
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner(),
      tts: new MockTts(),
      metrics,
    });
    await p.handleTurn('hello');
    const snap = metrics.snapshot();
    const turnCounter = snap.counters.find((c) => c.name === 'turns_total');
    expect(turnCounter?.value).toBeGreaterThan(0);
    expect(snap.histograms.find((h) => h.name === 'ttfa_ms')).toBeTruthy();
  });

  it('updates dialogue state across turns', async () => {
    const p = new Pipeline({
      sessionId: 't',
      reasoner: new MockReasoner(),
      tts: new MockTts(),
    });
    await p.handleTurn('hello');
    await p.handleTurn('schedule a meeting');
    const snap = p.state.snapshot();
    expect(snap.turns.length).toBe(2);
    expect(snap.phase).not.toBe('idle');
  });
});
