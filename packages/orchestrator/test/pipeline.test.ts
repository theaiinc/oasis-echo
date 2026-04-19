import { describe, expect, it } from 'vitest';
import { PassthroughTts, type Router } from '@oasis-echo/coordinator';
import type {
  Reasoner,
  ReasoningStreamEvent,
} from '@oasis-echo/reasoning';
import { Metrics } from '@oasis-echo/telemetry';
import type { DialogueState, Intent } from '@oasis-echo/types';
import { Pipeline } from '../src/pipeline.js';

/**
 * Inline test-only reasoner. Lets each test specify the exact tokens
 * and per-token delay — no mock implementation is shipped in the
 * production bundle, so tests define their own fakes.
 */
class FakeReasoner implements Reasoner {
  constructor(private readonly opts: { tokens: string[]; delayMs?: number }) {}
  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
  }): AsyncIterable<ReasoningStreamEvent> {
    const delay = this.opts.delayMs ?? 5;
    for (const tok of this.opts.tokens) {
      if (input.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, delay));
      yield { type: 'token', text: tok };
    }
    yield {
      type: 'done',
      stopReason: 'stop',
      inputTokens: 0,
      outputTokens: this.opts.tokens.length,
    };
  }
}

/** Predictable test router — always escalates to the given intent. */
function makeRouter(intent: Intent, reason: string): Router {
  return {
    async route() {
      return {
        intent,
        confidence: 0.9,
        decision: { kind: 'escalate', intent, reason },
      };
    },
  };
}

const escalateComplex = makeRouter('question_complex', 'complex-reasoning');

describe('Pipeline', () => {
  it('runs a reflex turn without calling the reasoner', async () => {
    const metrics = new Metrics();
    let reasonerCalls = 0;
    const reasoner = new FakeReasoner({ tokens: ['unused'] });
    const origStream = reasoner.stream.bind(reasoner);
    reasoner.stream = (input) => {
      reasonerCalls++;
      return origStream(input);
    };
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner,
      tts: new PassthroughTts(),
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

  it('escalates complex questions through the reasoner', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['This ', 'is ', 'a ', 'cloud ', 'answer.'] }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: ['Slow ', 'answer.'],
        delayMs: 800, // first token past the 600ms filler threshold
      }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: ['Fast ', 'answer.'],
        delayMs: 10,
      }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['Hi.'] }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: ['slow ', 'slow ', 'slow ', 'slow ', 'slow ', 'slow ', 'slow.'],
        delayMs: 30,
      }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['ok.'] }),
      tts: new PassthroughTts(),
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
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['reply.'] }),
      tts: new PassthroughTts(),
    });
    await p.handleTurn('hello');
    await p.handleTurn('schedule a meeting');
    const snap = p.state.snapshot();
    expect(snap.turns.length).toBe(2);
    expect(snap.phase).not.toBe('idle');
  });
});
