import { describe, expect, it } from 'vitest';
import { newDialogueState } from '@oasis-echo/types';
import {
  alwaysEscalate,
  buildRouterPrompt,
  parseRouterJson,
  toRouterOutput,
} from '../src/router.js';

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
