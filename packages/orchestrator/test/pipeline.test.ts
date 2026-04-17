import { describe, expect, it } from 'vitest';
import { MockTts } from '@oasis-echo/coordinator';
import { MockReasoner } from '@oasis-echo/reasoning';
import { Metrics } from '@oasis-echo/telemetry';
import { Pipeline } from '../src/pipeline.js';

function decode(pcm: Int16Array): string {
  return new TextDecoder().decode(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

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
    p.bus.on('tts.chunk', (e) => void chunks.push(decode(e.pcm)));
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
    p.bus.on('tts.chunk', (e) => void chunks.push(decode(e.pcm)));
    const turn = await p.handleTurn('why is the sky blue');
    expect(turn.tier).toBe('escalated');
    const joined = chunks.join('');
    expect(joined.toLowerCase()).toContain('think');
    expect(joined).toContain('cloud answer');
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
