import { describe, expect, it } from 'vitest';
import { PassthroughTts, type Router } from '@oasis-echo/coordinator';
import type {
  Reasoner,
  ReasoningStreamEvent,
} from '@oasis-echo/reasoning';
import { Metrics } from '@oasis-echo/telemetry';
import type { DialogueState, Intent } from '@oasis-echo/types';
import type { FillerAdvisor } from '../src/filler-advisor.js';
import { Pipeline } from '../src/pipeline.js';

/**
 * Inline test-only reasoner. Lets each test specify the exact tokens
 * and per-token delay — no mock implementation is shipped in the
 * production bundle, so tests define their own fakes.
 */
class FakeReasoner implements Reasoner {
  readonly models: Array<string | undefined> = [];

  constructor(private readonly opts: { tokens: string[]; delayMs?: number }) {}

  async *stream(input: {
    userText: string;
    state: DialogueState;
    signal?: AbortSignal;
    model?: string;
  }): AsyncIterable<ReasoningStreamEvent> {
    this.models.push(input.model);
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
const escalateMedium = makeRouter('question_simple', 'factual-lookup');

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

  it('uses the medium reasoner model for factual/simple escalations only', async () => {
    const mediumReasoner = new FakeReasoner({ tokens: ['Fast ', 'answer.'] });
    const medium = new Pipeline({
      sessionId: 't',
      router: escalateMedium,
      reasoner: mediumReasoner,
      tts: new PassthroughTts(),
      mediumReasonerModel: 'Qwen_Qwen3-4B-GGUF',
    });
    await medium.handleTurn('what is Apple TV Plus');
    expect(mediumReasoner.models).toEqual(['Qwen_Qwen3-4B-GGUF']);

    const complexReasoner = new FakeReasoner({ tokens: ['Deep ', 'answer.'] });
    const complex = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: complexReasoner,
      tts: new PassthroughTts(),
      mediumReasonerModel: 'Qwen_Qwen3-4B-GGUF',
    });
    await complex.handleTurn('why do transformers generalize');
    expect(complexReasoner.models).toEqual([undefined]);
  });

  it('routes literal leading thought output to thinking events instead of TTS', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: ['thought', '\nI should reason privately. Res', 'ponse: Clean answer.'],
      }),
      tts: new PassthroughTts(),
    });
    const chunks: string[] = [];
    const thinking: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    p.bus.on('think.token', (e) => void thinking.push(e.token));

    const turn = await p.handleTurn('why do rainbows form');

    expect(thinking.join('')).toContain('I should reason privately');
    expect(chunks.join(' ')).toContain('Clean answer');
    expect(chunks.join(' ')).not.toContain('thought');
    expect(turn.agentText).toBe('Clean answer.');
  });

  it('routes markdown-wrapped Gemma thought output away from TTS', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          '**Th',
          'ought:** I should reason privately before speaking. ',
          '**Answer:** Clean Gemma answer.',
        ],
      }),
      tts: new PassthroughTts(),
    });
    const chunks: string[] = [];
    const thinking: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    p.bus.on('think.token', (e) => void thinking.push(e.token));

    const turn = await p.handleTurn('answer with gemma');

    expect(thinking.join('')).toContain('I should reason privately');
    expect(chunks.join(' ')).toContain('Clean Gemma answer');
    expect(chunks.join(' ').toLowerCase()).not.toContain('thought');
    expect(turn.agentText).toBe('Clean Gemma answer.');
  });

  it('routes Gemma start-thinking blocks away from TTS', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          '[Start thinking]\n\nThinking Process:\n\n1. Analyze privately. ',
          '2. Work out the answer. ',
          '[End thinking]\n\nFinal Answer: Two plus two is four.',
        ],
      }),
      tts: new PassthroughTts(),
    });
    const chunks: string[] = [];
    const thinking: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    p.bus.on('think.token', (e) => void thinking.push(e.token));

    const turn = await p.handleTurn('what is two plus two');

    expect(thinking.join('')).toContain('Analyze privately');
    expect(chunks.join(' ')).toContain('Two plus two is four.');
    expect(chunks.join(' ').toLowerCase()).not.toContain('thinking');
    expect(chunks.join(' ').toLowerCase()).not.toContain('process');
    expect(turn.agentText).toBe('Two plus two is four.');
  });

  it('keeps internal answers inside Gemma start/end thinking blocks out of TTS', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          '[Start thinking]\n\nThe user asks a simple arithmetic question. ',
          'Constraint: one short sentence. ',
          'Answer: Four. ',
          '[End thinking]\n\nTwo plus two equals four.',
        ],
      }),
      tts: new PassthroughTts(),
    });
    const chunks: string[] = [];
    const thinking: string[] = [];
    p.bus.on('tts.chunk', (e) => void chunks.push(e.text));
    p.bus.on('think.token', (e) => void thinking.push(e.token));

    const turn = await p.handleTurn('what is two plus two');

    expect(thinking.join('')).toContain('Constraint: one short sentence');
    expect(chunks.join(' ')).toBe('Two plus two equals four.');
    expect(chunks.join(' ')).not.toContain('Answer: Four');
    expect(turn.agentText).toBe('Two plus two equals four.');
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

  it('continues fillers until a speakable clause arrives', async () => {
    const slow = new Pipeline({
      sessionId: 's',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          'This ',
          'answer ',
          'takes ',
          'a ',
          'while ',
          'before ',
          'the ',
          'first ',
          'safe ',
          'clause,',
          ' then finishes.',
        ],
        delayMs: 180,
      }),
      tts: new PassthroughTts(),
    });
    const events: Array<{ text: string; filler: boolean }> = [];
    slow.bus.on('tts.chunk', (e) =>
      void events.push({ text: e.text, filler: e.filler === true }),
    );

    await slow.handleTurn('explain a delayed answer');

    const fillerCount = events.filter((e) => e.filler).length;
    expect(fillerCount).toBeGreaterThan(3);
    expect(events.map((e) => e.text).join(' ')).toContain(
      'This answer takes a while before the first safe clause,',
    );
  });

  it('uses non-blocking thinking-aware filler advice when it arrives before the next filler', async () => {
    const advisor: FillerAdvisor = {
      async advise(input) {
        if (input.thinking.includes('wing shape')) {
          return 'Wings and lift, thinking.';
        }
        return null;
      },
    };
    const slow = new Pipeline({
      sessionId: 's',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          '<think>wing shape and lift matter</think>',
          'Birds ',
          'fly ',
          'because ',
          'their ',
          'wings ',
          'create ',
          'lift ',
          'over ',
          'light ',
          'bodies.',
        ],
        delayMs: 180,
      }),
      tts: new PassthroughTts(),
      fillerAdvisor: advisor,
    });
    const fillers: string[] = [];
    slow.bus.on('tts.chunk', (e) => {
      if (e.filler === true) fillers.push(e.text);
    });

    await slow.handleTurn('why do birds fly');

    expect(fillers).toContain('Wings and lift, thinking.');
  });

  it('streams a phrase chunk before punctuation or reasoner completion', async () => {
    const slow = new Pipeline({
      sessionId: 's',
      router: escalateComplex,
      reasoner: new FakeReasoner({
        tokens: [
          'Birds ',
          'fly ',
          'because ',
          'their ',
          'lightweight ',
          'bodies ',
          'and ',
          'powerful ',
          'wings ',
          'create ',
          'lift ',
          'while ',
          'feathers ',
          'shape ',
          'airflow ',
          'over ',
          'each ',
          'wing ',
          'and ',
          'the ',
          'rest ',
          'of ',
          'the ',
          'body ',
          'stays ',
          'balanced ',
          'through ',
          'small ',
          'adjustments ',
          'as ',
          'the ',
          'air ',
          'moves ',
          'continues.',
        ],
        delayMs: 80,
      }),
      tts: new PassthroughTts(),
    });
    const order: string[] = [];
    slow.bus.on('tts.chunk', (e) => {
      if (e.filler !== true) order.push(`tts:${e.text}`);
    });
    slow.bus.on('llm.done', () => void order.push('done'));

    await slow.handleTurn('why do birds fly');

    const firstTts = order.findIndex((entry) => entry.startsWith('tts:'));
    const done = order.indexOf('done');
    expect(firstTts).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(firstTts);
    expect(order[firstTts]).toContain('Birds fly because');
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

  it('emits turn timeline marks for escalated turns', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['Timeline ', 'answer.'] }),
      tts: new PassthroughTts(),
    });
    const stages: string[] = [];
    p.bus.on('turn.timeline', (e) => void stages.push(e.stage));

    await p.handleTurn('why is timing useful');

    expect(stages).toContain('tts.start');
    expect(stages).toContain('llm.first_token');
    expect(stages).toContain('tts.first_answer_chunk');
    expect(stages).toContain('llm.done');
    expect(stages).toContain('tts.done');
  });

  it('does not store truncated incomplete model responses as successful history', async () => {
    const p = new Pipeline({
      sessionId: 't',
      router: escalateComplex,
      reasoner: new FakeReasoner({ tokens: ['The most practical step is to keep requests focused. When you'] }),
      tts: new PassthroughTts(),
    });
    const chunks: string[] = [];
    p.bus.on('tts.chunk', (e) => {
      if (e.filler !== true) chunks.push(e.text);
    });

    const turn = await p.handleTurn('how can latency improve');

    expect(turn.agentText).toBe('Sorry, I got cut off there. Please try again.');
    expect(p.state.snapshot().turns.at(-1)?.agentText).toBe(turn.agentText);
    expect(chunks.join(' ')).toContain('Sorry, I got cut off there');
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
