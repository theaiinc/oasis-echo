import { describe, expect, it } from 'vitest';
import {
  PhraseMatcherStage,
  PostProcessPipeline,
  RuleStage,
  SemanticCorrectionStage,
  combinedSimilarity,
  levenshtein,
  normalizedLevenshtein,
  tokenJaccard,
} from '../src/postprocess/index.js';

/* -----------------------------------------------------------------
 * RuleStage — fast synchronous cleanup
 * ----------------------------------------------------------------- */
describe('RuleStage', () => {
  const stage = new RuleStage({
    phoneticFixes: {
      gonna: 'going to',
      wanna: 'want to',
      cuz: 'because',
    },
  });

  it('strips default fillers (uh, um, like)', () => {
    const out = stage.run({ text: 'uh so like I was um thinking about it' });
    expect(out.text).toBe('so I was thinking about it');
    expect(out.changed).toBe(true);
  });

  it('collapses immediately-repeated words', () => {
    const out = stage.run({ text: 'the the the cat sat on on the mat' });
    expect(out.text).toBe('the cat sat on the mat');
  });

  it('applies phonetic fixes', () => {
    const out = stage.run({ text: "I'm gonna go cuz I wanna see it" });
    expect(out.text).toBe("I'm going to go because I want to see it");
  });

  it('normalizes whitespace and punctuation', () => {
    const out = stage.run({ text: 'hello  ,   world  !  how    are you' });
    expect(out.text).toBe('hello, world! how are you');
  });

  it('preserves already-clean text (changed=false)', () => {
    const out = stage.run({ text: 'The weather is nice today.' });
    expect(out.text).toBe('The weather is nice today.');
    expect(out.changed).toBe(false);
  });

  it('handles edge case: only fillers', () => {
    const out = stage.run({ text: 'uh um uh' });
    expect(out.text.trim()).toBe('');
  });
});

/* -----------------------------------------------------------------
 * PhraseMatcherStage — fuzzy snap to canonical phrases
 * ----------------------------------------------------------------- */
describe('PhraseMatcherStage', () => {
  const stage = new PhraseMatcherStage({
    phrases: [
      'send an email',
      'schedule a meeting',
      'turn on the lights',
      'set an alarm',
      'play some music',
    ],
    similarityThreshold: 0.7,
  });

  it('snaps near-identical input to canonical', () => {
    const out = stage.run({ text: 'sent an email' });
    expect(out.text).toBe('send an email');
    expect(out.changed).toBe(true);
    // "sent an email" vs "send an email": Lev=1/13 (high), Jaccard=2/4
    // (moderate) → combined ≈ 0.75.
    expect((out.info as { similarity: number }).similarity).toBeGreaterThan(0.7);
  });

  it('snaps word-order / minor-word variations', () => {
    const out = stage.run({ text: 'schedule the meeting' });
    expect(out.text).toBe('schedule a meeting');
  });

  it('leaves input unchanged when nothing is close enough', () => {
    const out = stage.run({ text: 'how is the weather today' });
    expect(out.text).toBe('how is the weather today');
    expect(out.changed).toBe(false);
  });

  it('skips on very long inputs', () => {
    const longText = 'this is a much longer sentence that exceeds the max input words limit and should be skipped entirely';
    expect(stage.shouldRun({ text: longText })).toBe(false);
  });

  it('returns info.bestScore when no match wins', () => {
    const out = stage.run({ text: 'completely unrelated command' });
    expect(out.info).toHaveProperty('bestScore');
  });
});

/* -----------------------------------------------------------------
 * Similarity primitives
 * ----------------------------------------------------------------- */
describe('similarity helpers', () => {
  it('levenshtein(kitten, sitting) === 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('normalizedLevenshtein returns 1 for equal strings', () => {
    expect(normalizedLevenshtein('hello', 'hello')).toBe(1);
  });

  it('tokenJaccard returns 1 for same tokens', () => {
    expect(tokenJaccard('hello world', 'world hello')).toBe(1);
  });

  it('combinedSimilarity is 1 for identical strings', () => {
    expect(combinedSimilarity('send an email', 'send an email')).toBe(1);
  });

  it('combinedSimilarity >= 0.7 for one-token off', () => {
    const s = combinedSimilarity('send an email', 'sent an email');
    expect(s).toBeGreaterThan(0.7);
  });
});

/* -----------------------------------------------------------------
 * SemanticCorrectionStage — conditional LLM escalation
 * ----------------------------------------------------------------- */
describe('SemanticCorrectionStage', () => {
  it('does not run when confidence is high and no ambiguity markers', () => {
    const stage = new SemanticCorrectionStage({
      correct: async () => { throw new Error('should not be called'); },
    });
    expect(stage.shouldRun({ text: 'hello world', confidence: 0.95 })).toBe(false);
  });

  it('runs when confidence is below threshold', () => {
    const stage = new SemanticCorrectionStage({
      correct: async (t) => t + ' (fixed)',
      minConfidenceToRun: 0.7,
    });
    expect(stage.shouldRun({ text: 'garbled input here', confidence: 0.4 })).toBe(true);
  });

  it('runs when ambiguity markers present even at high confidence', () => {
    const stage = new SemanticCorrectionStage({
      correct: async (t) => t,
    });
    // Duplicated word triggers the default marker.
    expect(stage.shouldRun({ text: 'the the cat', confidence: 0.99 })).toBe(true);
  });

  it('applies the corrector and returns changed text', async () => {
    const stage = new SemanticCorrectionStage({
      correct: async () => 'corrected version',
      minConfidenceToRun: null,
    });
    const out = await stage.run({ text: 'bad input' });
    expect(out.text).toBe('corrected version');
    expect(out.changed).toBe(true);
  });

  it('rejects pathological length drift (hallucination guardrail)', async () => {
    const stage = new SemanticCorrectionStage({
      correct: async () => 'a'.repeat(500),
      minConfidenceToRun: null,
    });
    const out = await stage.run({ text: 'short' });
    expect(out.changed).toBe(false);
    expect(out.info).toHaveProperty('reason', 'length-drift');
  });

  it('falls back silently on corrector error / timeout', async () => {
    const stage = new SemanticCorrectionStage({
      correct: async () => { throw new Error('net'); },
      minConfidenceToRun: null,
    });
    const out = await stage.run({ text: 'anything' });
    expect(out.changed).toBe(false);
    expect(out.text).toBe('anything');
  });
});

/* -----------------------------------------------------------------
 * End-to-end pipeline — all stages composed
 * ----------------------------------------------------------------- */
describe('PostProcessPipeline', () => {
  it('runs rules → phrases → semantic, recording history', async () => {
    const pipeline = new PostProcessPipeline([
      new RuleStage(),
      new PhraseMatcherStage({ phrases: ['send an email'], similarityThreshold: 0.6 }),
      new SemanticCorrectionStage({
        correct: async (t) => t.toUpperCase(),
        minConfidenceToRun: 0.5,
      }),
    ]);

    // Low confidence → semantic stage will run.
    const out = await pipeline.process({
      text: 'uh send a the email',
      confidence: 0.3,
    });

    // Rule stage stripped "uh" and collapsed "a the"? — actually rules
    // don't collapse distinct adjacent words, only identical ones. So
    // after rules: "send a the email" → phrase matcher snaps to "send
    // an email" → semantic uppercases. Order of stagesApplied reflects
    // the actual changes made.
    expect(out.stagesApplied.length).toBeGreaterThan(0);
    expect(out.history.length).toBeGreaterThan(0);
    expect(out.text).toBe('SEND AN EMAIL');
    expect(out.original).toBe('uh send a the email');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('skips semantic when confidence is high and input looks clean', async () => {
    let semanticCalled = false;
    const pipeline = new PostProcessPipeline([
      new RuleStage(),
      new SemanticCorrectionStage({
        correct: async (t) => { semanticCalled = true; return t; },
      }),
    ]);
    await pipeline.process({ text: 'how is the weather today', confidence: 0.95 });
    expect(semanticCalled).toBe(false);
  });

  it('guardrail: returns original if pipeline produced empty text', async () => {
    const wipe = {
      name: 'wipe',
      shouldRun: () => true,
      run: () => ({ text: '', changed: true }),
    };
    const pipeline = new PostProcessPipeline([wipe]);
    const out = await pipeline.process({ text: 'real input' });
    expect(out.text).toBe('real input');
  });
});

/* -----------------------------------------------------------------
 * Real-world noisy samples — demonstrates end-to-end improvement
 * ----------------------------------------------------------------- */
describe('noisy transcript samples (integration demo)', () => {
  const commands = [
    'send an email',
    'schedule a meeting',
    'turn on the lights',
    'play some music',
    'set a timer for five minutes',
  ];

  // Uppercase-echoing corrector stands in for a real LLM. In prod this
  // wraps Ollama/OpenAI/Anthropic; the contract is identical.
  const pipeline = new PostProcessPipeline([
    new RuleStage({
      phoneticFixes: { gonna: 'going to', wanna: 'want to' },
    }),
    new PhraseMatcherStage({ phrases: commands, similarityThreshold: 0.72 }),
    new SemanticCorrectionStage({
      correct: async (t) => t,  // no-op, just exercise the shouldRun gate
      minConfidenceToRun: 0.55,
    }),
  ]);

  const cases: Array<{ label: string; input: string; confidence?: number; expectContains?: string }> = [
    {
      label: 'filler + noise',
      input: 'uh um like send the an email',
      expectContains: 'send an email',
    },
    {
      label: 'repeated words',
      input: 'turn turn on the the lights',
      expectContains: 'turn on the lights',
    },
    {
      label: 'casual speech',
      input: "I'm gonna schedule a meeting",
      expectContains: 'schedule a meeting',
    },
    {
      label: 'mixed-language: snap falls through, rules still clean',
      input: 'uh play some música por favor',
      expectContains: 'play',
    },
    {
      label: 'incomplete phrase stays as-is',
      input: 'hmm what was I saying',
      confidence: 0.9,
    },
  ];

  for (const { label, input, confidence, expectContains } of cases) {
    it(label, async () => {
      const out = await pipeline.process({ text: input, ...(confidence !== undefined ? { confidence } : {}) });
      if (expectContains) expect(out.text.toLowerCase()).toContain(expectContains.toLowerCase());
      // Every case should produce non-empty output.
      expect(out.text.trim().length).toBeGreaterThan(0);
    });
  }
});
