const FALLBACK = 'Hmm.';

function randomPick<T>(arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Short apologies for when the agent unintentionally cut off the user
 * — typically fires on barge-in, where the agent started speaking
 * during a mid-utterance pause and the user had to reclaim the floor.
 */
const APOLOGIES = [
  "Sorry, please go ahead.",
  "Oh, sorry — I'm all ears.",
  "Apologies, go on.",
  "Sorry, please continue.",
  "Oh, my bad — keep going.",
  "Sorry, didn't mean to cut in.",
  "Go ahead, I'm listening.",
  "Sorry about that — please finish your thought.",
];

/**
 * Pick a random apology phrase. Caller can pass a `recent` set to
 * avoid repeating the same line back-to-back.
 */
export function pickApology(recent?: Set<string>): string {
  const available = recent ? APOLOGIES.filter((a) => !recent.has(a)) : APOLOGIES;
  const picked = randomPick(available.length > 0 ? available : APOLOGIES) ?? APOLOGIES[0]!;
  recent?.add(picked);
  return picked;
}

/**
 * Natural English disfluencies. Neural TTS engines (Kokoro, Piper,
 * ElevenLabs) all run a real phonemizer, so stretched-letter tricks
 * like "hmmmm" or "uhhhh" come out wrong — they get read as words
 * ("ewww", "em em em") or letter-by-letter. Real phrases with
 * punctuation phonemize naturally in any modern TTS and still sound
 * reasonable on browser speechSynthesis as a fallback.
 */
/**
 * First-beat fillers — played immediately for snappy feedback. Long
 * enough (3-5 words) that a single word like "Well." doesn't land in
 * isolation, but short enough that synthesis finishes quickly so the
 * next filler (or the model reply) can start right behind it.
 */
const FIRST_BEATS = [
  'Hmm, let me see.',
  'Well, one moment.',
  'Okay, just a second.',
  'Right, give me a moment.',
  'Oh, hold on a sec.',
  'Yeah, let me think.',
  'Alright, let me see.',
  'Okay, just a moment.',
  "Let's see.",
  'Good question, one moment.',
];

/**
 * Continuation fillers — concise natural phrases played as chained
 * pairs when the wait drags on. Kept short (2-6 words each) so that
 * a chained pair synthesizes in under ~1.5s, keeping pace with the
 * model rather than creating a new gap.
 */
const CONTINUATIONS_BY_REASON: Record<string, string[]> = {
  'tool-needed': [
    'Let me check.',
    'Hmm, looking now.',
    'Still looking.',
    'Almost there.',
    'Bear with me.',
    'Just a sec.',
  ],
  'complex-reasoning': [
    'Let me think.',
    'Give me a second.',
    'Working on it.',
    "That's a good one.",
    'Turning that over.',
    'Almost got it.',
    'Just a moment.',
    "Let me see.",
    'Hmm.',
    "That's layered.",
    'Piecing it together.',
  ],
  'factual-lookup': [
    'Let me see.',
    'Hmm, checking.',
    'One moment.',
    'Almost there.',
    'Just a second.',
  ],
  'low-confidence': [
    'Let me verify.',
    'Making sure.',
    'One moment.',
    'Hmm, checking.',
  ],
  'reply-too-long': [
    'One moment.',
    'Trimming this down.',
    'Finding the short version.',
  ],
  unclassified: [
    'Let me think.',
    'Give me a moment.',
    'Working on it.',
    'Just a second.',
    'Hmm.',
    'Bear with me.',
  ],
};
/**
 * Pick a random short "first-beat" filler that hasn't been used
 * recently (per the caller-provided `recent` set, which the caller
 * typically threads across turns so we don't repeat yesterday's word
 * as today's opener).
 */
export function pickFirstFiller(recent?: Set<string>): string {
  const available = recent
    ? FIRST_BEATS.filter((f) => !recent.has(f))
    : FIRST_BEATS;
  const picked = randomPick(available.length > 0 ? available : FIRST_BEATS) ?? FALLBACK;
  recent?.add(picked);
  return picked;
}

/**
 * A longer "continuation" filler built by chaining two reason-pool
 * entries that haven't been used yet. Neural TTS gives a chained
 * phrase continuous prosody — much better than synthesizing separate
 * clips back-to-back. Callers pass a `used` set so we don't pick the
 * same phrase twice in a turn; they can also pass a `recent` set
 * scoped to the whole session to avoid repeating across turns.
 */
export function pickContinuationFiller(
  reason: string,
  used: Set<string>,
  recent?: Set<string>,
): string {
  const pool = CONTINUATIONS_BY_REASON[reason] ?? CONTINUATIONS_BY_REASON['unclassified'] ?? [FALLBACK];
  // Prefer phrases we haven't used this turn OR recently across turns.
  const fresh = pool.filter((p) => !used.has(p) && !(recent?.has(p) ?? false));
  const unused = pool.filter((p) => !used.has(p));
  const candidates = fresh.length > 0 ? fresh : unused.length > 0 ? unused : pool;

  const a = randomPick(candidates) ?? FALLBACK;
  used.add(a);
  recent?.add(a);

  const remaining = candidates.filter((p) => p !== a);
  const b = randomPick(remaining) ?? '';
  if (b) {
    used.add(b);
    recent?.add(b);
  }
  return b ? `${a} ${b}` : a;
}
