import { describe, expect, it } from 'vitest';
import { ContextBiasStage } from '../src/postprocess/context-bias.js';
import type { AgentContext } from '../src/postprocess/types.js';

const stage = new ContextBiasStage();

function run(text: string, agentContext?: AgentContext): {
  text: string;
  changed: boolean;
  info?: Record<string, unknown>;
} {
  const ctx = { text, ...(agentContext ? { agentContext } : {}) };
  if (!stage.shouldRun(ctx)) return { text, changed: false };
  const r = stage.run(ctx) as { text: string; changed: boolean; info?: Record<string, unknown> };
  return r;
}

describe('ContextBiasStage', () => {
  it('skips when there is no agent context', () => {
    const r = run('yeah see tell');
    expect(r.changed).toBe(false);
  });

  it('snaps a 2-token homophone window to a proper noun from context', () => {
    const r = run('yeah see tell', {
      lastUtterance: 'Should I book a flight to Seattle?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(true);
    expect(r.text.toLowerCase()).toContain('seattle');
    // Preserves the agent's canonical casing.
    expect(r.text).toContain('Seattle');
  });

  it('snaps a split code identifier "use state" → "useState"', () => {
    const r = run('I think we should use state here', {
      lastUtterance: 'The counter should live in `useState` at the top.',
    });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('useState');
  });

  it('does not swap when the topic has clearly changed', () => {
    const r = run('by the way what time is it', {
      lastUtterance: 'Should I book a flight to Seattle?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(false);
  });

  it('does not swap when the yes-no reply is unrelated (topic-change signal)', () => {
    const r = run('pizza', {
      lastUtterance: 'Should I book a flight to Seattle?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(false);
  });

  it('leaves stopwords alone even if they share a Soundex code', () => {
    const r = run('yes the flight is fine', {
      lastUtterance: 'Do you want the Tuesday flight?',
      pendingQuestion: { kind: 'yes-no' },
    });
    // "the" should NOT be swapped for something else via Soundex.
    expect(r.text).toContain('the');
  });

  it('does not swap when the user already typed the canonical form', () => {
    const r = run('yes Seattle sounds good', {
      lastUtterance: 'Should I book Seattle?',
      pendingQuestion: { kind: 'yes-no' },
    });
    // No-op or exact-preserve — either way text contains "Seattle".
    expect(r.text).toContain('Seattle');
  });

  it('preserves punctuation around the swapped token', () => {
    const r = run('yes, see tell.', {
      lastUtterance: 'Should I book a flight to Seattle?',
      pendingQuestion: { kind: 'yes-no' },
    });
    expect(r.changed).toBe(true);
    // "Seattle" followed by a period.
    expect(r.text).toMatch(/Seattle\./);
  });

  it('snaps a 4-token STT garble of a proper noun to the context form', () => {
    // Real failure case from a live session: agent mentioned Shinkansen;
    // STT rendered "Shinkansen" as "same can send trans".
    const r = run('what are the same can send trans mean', {
      lastUtterance:
        'You should purchase a Japan Rail Pass and travel by Shinkansen bullet train from city to city.',
    });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('Shinkansen');
  });

  it('does not falsely snap a long phrase when no salient context matches', () => {
    // Unrelated user text with no phonetic neighbor in context — no swap.
    const r = run('tell me about the weather please', {
      lastUtterance: 'You should purchase a Japan Rail Pass and travel by Shinkansen.',
    });
    expect(r.changed).toBe(false);
  });

  it('rescues case: "usestate" → "useState"', () => {
    const r = run('use usestate for the counter', {
      lastUtterance: 'The counter lives in `useState` at the top.',
    });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('useState');
  });
});
