const FALLBACK = 'One moment.';

const BY_REASON: Record<string, string[]> = {
  'tool-needed': ['Let me check that.', 'One moment, looking that up.', 'Checking now.'],
  'complex-reasoning': ['Let me think.', 'Thinking about that.', 'Give me a second.'],
  'factual-lookup': ['Looking that up.', 'One moment.', 'Let me verify.'],
  'low-confidence': ['Let me double-check.', 'One moment.'],
  'reply-too-long': ['One moment.', 'Let me condense that.'],
  unclassified: ['One moment.', 'Hmm, let me think.'],
};

/**
 * Pick a filler phrase appropriate for the escalation reason. Rotated
 * weakly by a session counter so the same filler doesn't repeat back
 * to back.
 */
export function pickFiller(reason: string, counter: number): string {
  const pool = BY_REASON[reason] ?? [FALLBACK];
  return pool[counter % pool.length] ?? FALLBACK;
}
