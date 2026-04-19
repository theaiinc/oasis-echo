import { describe, expect, it } from 'vitest';
import { SpeculationManager } from '../src/speculation.js';
import type { Router } from '../src/router.js';
import type { RouterOutput, DialogueState } from '@oasis-echo/types';

/** Minimal DialogueState stub — the router / reasoner stubs below don't read it. */
function state(): DialogueState {
  return {
    phase: 'open',
    allowedIntents: [],
    slots: {},
    turns: [],
    summary: '',
  };
}

function localRouter(reply: string): Router {
  return {
    async route() {
      return {
        intent: 'smalltalk',
        confidence: 0.9,
        decision: { kind: 'local', intent: 'smalltalk', reply },
      } satisfies RouterOutput;
    },
  };
}

function escalateRouter(): Router {
  return {
    async route() {
      return {
        intent: 'question_complex',
        confidence: 0.8,
        decision: {
          kind: 'escalate',
          intent: 'question_complex',
          reason: 'test',
        },
      } satisfies RouterOutput;
    },
  };
}

type FakeReasonerOpts = {
  /** Full text the reasoner emits (split into tokens of ~10 chars each). */
  text: string;
  /** Delay between each token in ms. Default 0 (synchronous-ish). */
  delayMs?: number;
};

function fakeReasoner(opts: FakeReasonerOpts) {
  return {
    async *stream({ signal }: { signal?: AbortSignal }) {
      const tokens = opts.text.match(/.{1,10}/g) ?? [];
      for (const t of tokens) {
        if (signal?.aborted) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield { type: 'token' as const, text: t };
      }
      yield { type: 'done' as const, outputTokens: tokens.length, inputTokens: 10 };
    },
  } as unknown as Parameters<typeof SpeculationManager>[0]['reasoner'] extends infer R
    ? R
    : never;
}

describe('SpeculationManager — commit HIT (local reply)', () => {
  it('promotes a local-router speculation when partial closely matches final', async () => {
    const mgr = new SpeculationManager({
      router: localRouter('Sure, happy to help.'),
      reasoner: fakeReasoner({ text: 'unused' }),
      getState: state,
    });
    mgr.update('turn1', 'how are you doin');
    const result = await mgr.commit('turn1', 'how are you doing');
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') return;
    expect(result.routerOutput.decision.kind).toBe('local');
    const sentences: string[] = [];
    for await (const s of result.sentences) sentences.push(s);
    expect(sentences.join(' ')).toContain('Sure, happy to help');
  });
});

describe('SpeculationManager — commit HIT (escalated reasoner)', () => {
  it('drains already-buffered sentences and pending ones from the reasoner', async () => {
    const mgr = new SpeculationManager({
      router: escalateRouter(),
      reasoner: fakeReasoner({ text: 'Of course. I can help with that. Let me explain.' }),
      getState: state,
    });
    mgr.update('turn2', 'I want to book a flight');
    // Let the reasoner tokens accumulate briefly.
    await new Promise((r) => setTimeout(r, 50));
    const result = await mgr.commit('turn2', 'I want to book a flight');
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') return;
    const sentences: string[] = [];
    for await (const s of result.sentences) sentences.push(s);
    const full = sentences.join(' ');
    expect(full).toContain('Of course');
    expect(full).toContain('help with that');
  });
});

describe('SpeculationManager — commit MISS', () => {
  it('returns miss=not-found when no speculation was started', async () => {
    const mgr = new SpeculationManager({
      router: localRouter(''),
      reasoner: fakeReasoner({ text: '' }),
      getState: state,
    });
    const result = await mgr.commit('never-started', 'anything');
    expect(result.kind).toBe('miss');
    if (result.kind === 'miss') expect(result.reason).toBe('not-found');
  });

  it('returns miss=diverged when final drifts far from the speculated partial', async () => {
    const mgr = new SpeculationManager({
      router: escalateRouter(),
      reasoner: fakeReasoner({ text: 'Will never be used.' }),
      getState: state,
      similarityThreshold: 0.72,
    });
    mgr.update('turn3', 'what time is it in tokyo today');
    const result = await mgr.commit(
      'turn3',
      'tell me a bedtime story about dragons',
    );
    expect(result.kind).toBe('miss');
    if (result.kind === 'miss') expect(result.reason).toBe('diverged');
  });
});

describe('SpeculationManager — restart on partial divergence mid-speculation', () => {
  it('aborts the previous reasoner when the partial changes substantially', async () => {
    let startCount = 0;
    const reasoner = {
      async *stream({ signal }: { signal?: AbortSignal }) {
        startCount++;
        for (let i = 0; i < 20 && !signal?.aborted; i++) {
          await new Promise((r) => setTimeout(r, 5));
          yield { type: 'token' as const, text: 'x' };
        }
        yield { type: 'done' as const, outputTokens: 20, inputTokens: 10 };
      },
    } as unknown as Parameters<typeof SpeculationManager>[0]['reasoner'] extends infer R
      ? R
      : never;
    const mgr = new SpeculationManager({
      router: escalateRouter(),
      reasoner,
      getState: state,
    });
    mgr.update('turn4', 'hello world how');
    await new Promise((r) => setTimeout(r, 15));
    mgr.update('turn4', 'this is a totally different topic entirely');
    await new Promise((r) => setTimeout(r, 15));
    expect(startCount).toBe(2);
    mgr.abort('turn4');
  });

  it('does NOT restart when new partial is a prefix-extension of old', async () => {
    // This is the optimization that makes "stream sendPartial on
    // every browser-STT interim" cheap. A dictated sentence that
    // grows word-by-word must not cause N reasoner restarts.
    let startCount = 0;
    const reasoner = {
      async *stream({ signal }: { signal?: AbortSignal }) {
        startCount++;
        for (let i = 0; i < 50 && !signal?.aborted; i++) {
          await new Promise((r) => setTimeout(r, 5));
          yield { type: 'token' as const, text: 'x' };
        }
        yield { type: 'done' as const, outputTokens: 50, inputTokens: 10 };
      },
    } as unknown as Parameters<typeof SpeculationManager>[0]['reasoner'] extends infer R
      ? R
      : never;
    const mgr = new SpeculationManager({
      router: escalateRouter(),
      reasoner,
      getState: state,
    });
    mgr.update('turn-prefix', "I'm thinking about");
    await new Promise((r) => setTimeout(r, 15));
    mgr.update('turn-prefix', "I'm thinking about going");
    mgr.update('turn-prefix', "I'm thinking about going to");
    mgr.update('turn-prefix', "I'm thinking about going to Tokyo");
    mgr.update('turn-prefix', "I'm thinking about going to Tokyo next month");
    await new Promise((r) => setTimeout(r, 15));
    expect(startCount).toBe(1); // one reasoner run for all the prefix extensions
    mgr.abort('turn-prefix');
  });
});

describe('SpeculationManager — abort', () => {
  it('removes the buffer and makes subsequent commit a miss', async () => {
    const mgr = new SpeculationManager({
      router: localRouter('hi'),
      reasoner: fakeReasoner({ text: '' }),
      getState: state,
    });
    mgr.update('turn5', 'hi there');
    mgr.abort('turn5');
    const result = await mgr.commit('turn5', 'hi there');
    expect(result.kind).toBe('miss');
  });

  it('activeCount() reflects live buffers', async () => {
    const mgr = new SpeculationManager({
      router: escalateRouter(),
      reasoner: fakeReasoner({ text: 'x', delayMs: 100 }),
      getState: state,
    });
    expect(mgr.activeCount()).toBe(0);
    mgr.update('a', 'hello world');
    mgr.update('b', 'another one here');
    expect(mgr.activeCount()).toBe(2);
    mgr.abort('a');
    expect(mgr.activeCount()).toBe(1);
    mgr.abort('b');
  });
});
