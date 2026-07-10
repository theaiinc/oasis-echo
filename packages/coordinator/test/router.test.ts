import { describe, expect, it } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import {
  alwaysEscalate,
  buildRouterPrompt,
  parseRouterJson,
  toRouterOutput,
  type Router,
} from '../src/router.js';
import { ThreeTierRouter } from '../src/router-three-tier.js';

describe('alwaysEscalate', () => {
  it('always returns an escalate decision', async () => {
    const out = await alwaysEscalate.route({ text: 'anything', state: newDialogueState('s', 0) });
    expect(out.decision.kind).toBe('escalate');
  });
});

describe('parseRouterJson', () => {
  const allowed = ['greeting', 'question_simple', 'command_tool'] as const;

  it('parses valid JSON', () => {
    const raw = '{"intent": "greeting", "confidence": 0.9, "kind": "local", "reply": "Hi"}';
    const parsed = parseRouterJson(raw, allowed);
    expect(parsed?.intent).toBe('greeting');
    expect(parsed?.kind).toBe('local');
  });

  it('extracts JSON from surrounding text', () => {
    const raw = 'Sure, here is the output: {"intent":"greeting","confidence":0.8,"kind":"local"} done.';
    const parsed = parseRouterJson(raw, allowed);
    expect(parsed?.intent).toBe('greeting');
  });

  it('rejects disallowed intents by escalating', () => {
    const raw = '{"intent": "confirm", "confidence": 0.9, "kind": "local"}';
    const parsed = parseRouterJson(raw, allowed);
    expect(parsed?.intent).toBe('unknown');
    expect(parsed?.kind).toBe('escalate');
  });

  it('returns null on unparseable output', () => {
    expect(parseRouterJson('not json', allowed)).toBeNull();
    expect(parseRouterJson('{"intent": "greeting"}', allowed)).toBeNull();
  });

  it('converts to RouterOutput', () => {
    const json = { intent: 'greeting', confidence: 0.9, kind: 'local' as const, reply: 'Hi' };
    const out = toRouterOutput(json);
    expect(out.decision.kind).toBe('local');
    if (out.decision.kind === 'local') expect(out.decision.reply).toBe('Hi');
  });
});

describe('buildRouterPrompt', () => {
  it('includes allowed intents and the user text', () => {
    const state = newDialogueState('s', 0);
    const prompt = buildRouterPrompt('hello', state);
    expect(prompt).toContain('"hello"');
    expect(prompt).toContain('greeting');
  });
});

describe('ThreeTierRouter', () => {
  it('answers hearing checks locally without calling the large model path', async () => {
    const state = newDialogueState('s', 0);
    let archCalls = 0;
    let slmCalls = 0;
    const archRouter: Router = {
      async route() {
        archCalls++;
        return {
          intent: 'question_simple',
          confidence: 0.95,
          decision: {
            kind: 'escalate',
            intent: 'question_simple',
            reason: 'factual-lookup',
          },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        slmCalls++;
        return {
          intent: 'smalltalk',
          confidence: 0.9,
          decision: { kind: 'local', intent: 'smalltalk', reply: 'wrong path' },
        };
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({ text: 'hey can you hear me', state });

    expect(archCalls).toBe(0);
    expect(slmCalls).toBe(0);
    expect(output).toMatchObject({
      intent: 'smalltalk',
      decision: {
        kind: 'local',
        reply: 'Yes, I can hear you.',
      },
    });
  });

  it('routes greetings through the SLM local-reply tier without escalation', async () => {
    const state = newDialogueState('s', 0);
    let archCalls = 0;
    let slmCalls = 0;
    const archRouter: Router = {
      async route() {
        archCalls++;
        return {
          intent: 'greeting',
          confidence: 0.95,
          decision: { kind: 'local', intent: 'greeting' },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        slmCalls++;
        return {
          intent: 'greeting',
          confidence: 0.9,
          decision: { kind: 'local', intent: 'greeting', reply: 'Hey, I am listening.' },
        };
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({ text: 'hey', state });

    expect(archCalls).toBe(1);
    expect(slmCalls).toBe(1);
    expect(output.intent).toBe('greeting');
    expect(output.decision).toMatchObject({
      kind: 'local',
      reply: 'Hey, I am listening.',
    });
  });

  it('bypasses the SLM tier for complex questions so the big reasoner handles them', async () => {
    const state = newDialogueState('s', 0);
    let slmCalls = 0;
    const archRouter: Router = {
      async route() {
        return {
          intent: 'question_complex',
          confidence: 0.92,
          decision: {
            kind: 'escalate',
            intent: 'question_complex',
            reason: 'complex-reasoning',
            filler: 'Thinking through the cause.',
          },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        slmCalls++;
        throw new Error('SLM should not be called for complex questions');
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({
      text: 'why do birds fly',
      state,
    });

    expect(slmCalls).toBe(0);
    expect(output).toMatchObject({
      intent: 'question_complex',
      decision: {
        kind: 'escalate',
        reason: 'complex-reasoning',
        filler: 'Thinking through the cause.',
      },
    });
  });

  it('keeps local intents local when the SLM tier fails or escalates', async () => {
    const state = newDialogueState('s', 0);
    const archRouter: Router = {
      async route() {
        return {
          intent: 'unknown',
          confidence: 0.8,
          decision: { kind: 'local', intent: 'unknown' },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        return {
          intent: 'unknown',
          confidence: 0.4,
          decision: { kind: 'escalate', intent: 'unknown', reason: 'unclassified' },
        };
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({ text: 'how are you', state });

    expect(output).toMatchObject({
      intent: 'unknown',
      decision: {
        kind: 'local',
        reply: "I'm doing well. What can I help with?",
      },
    });
  });

  it('escalates substantive questions when classifier returns unknown', async () => {
    const state = newDialogueState('s', 0);
    state.phase = 'greeting';
    state.allowedIntents = ['greeting', 'smalltalk', 'question_simple', 'command_local', 'command_tool'];
    const archRouter: Router = {
      async route() {
        return {
          intent: 'unknown',
          confidence: 0.4,
          decision: { kind: 'local', intent: 'unknown' },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        throw new Error('SLM should not be called for obvious questions');
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({
      text: 'Well, do you remember any latest animation in Apple TV?',
      state,
    });

    expect(output).toMatchObject({
      intent: 'question_simple',
      confidence: 0.55,
      decision: {
        kind: 'escalate',
        intent: 'question_simple',
        reason: 'substantive-question-fallback',
      },
    });
  });

  it('escalates substantive corrections while confirming', async () => {
    const state = newDialogueState('s', 0);
    state.phase = 'confirming';
    state.allowedIntents = [
      'confirm',
      'deny',
      'cancel',
      'wait',
      'question_simple',
      'question_complex',
      'command_local',
      'command_tool',
    ];
    const archRouter: Router = {
      async route() {
        return {
          intent: 'question_complex',
          confidence: 0.85,
          decision: {
            kind: 'escalate',
            intent: 'question_complex',
            reason: 'complex-reasoning',
          },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        throw new Error('SLM should not be called for corrections');
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({
      text: 'that anime, not image',
      state,
    });

    expect(output).toMatchObject({
      intent: 'question_complex',
      decision: {
        kind: 'escalate',
        intent: 'question_complex',
      },
    });
  });

  it('does not escalate social questions when classifier returns unknown', async () => {
    const state = newDialogueState('s', 0);
    const archRouter: Router = {
      async route() {
        return {
          intent: 'unknown',
          confidence: 0.8,
          decision: { kind: 'local', intent: 'unknown' },
        };
      },
    };
    const slmRouter: Router = {
      async route() {
        return {
          intent: 'unknown',
          confidence: 0.4,
          decision: { kind: 'escalate', intent: 'unknown', reason: 'unclassified' },
        };
      },
    };
    const router = new ThreeTierRouter({ archRouter, slmRouter });

    const output = await router.route({ text: 'how are you', state });

    expect(output).toMatchObject({
      intent: 'unknown',
      decision: {
        kind: 'local',
        reply: "I'm doing well. What can I help with?",
      },
    });
  });
});
