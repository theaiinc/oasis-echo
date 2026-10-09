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
export function pickApology(recent?: Set<string>, lang: FillerLanguage = 'en', custom?: FillerPool): string {
  const pool = custom?.apology?.length ? custom.apology : lang === 'vi' ? VI_APOLOGIES : APOLOGIES;
  const available = recent ? pool.filter((a) => !recent.has(a)) : pool;
  const picked = randomPick(available.length > 0 ? available : pool) ?? pool[0]!;
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
 * Vietnamese counterparts, for calls held in Vietnamese. Polite, neutral register, and
 * no self-pronoun: the agent's own (em / mình / tôi) is the persona's choice, and a
 * filler in a different one makes the voice sound like it keeps changing who it is.
 */
const VI_APOLOGIES = [
  'Xin lỗi, cứ nói tiếp nhé.',
  'Ồ, xin lỗi, đang nghe đây.',
  'Xin lỗi, mời nói tiếp.',
];
const VI_FIRST_BEATS = [
  'Ừm, để xem nào.',
  'Đợi một chút nhé.',
  'Dạ, chờ chút ạ.',
  'Để nghĩ đã.',
  'Câu hỏi hay, chờ chút nhé.',
];
const VI_CONTINUATIONS = [
  'Đang xem đây.',
  'Sắp xong rồi.',
  'Chờ thêm chút nhé.',
  'Đang kiểm tra.',
  'Ừm.',
];

/** Fillers that praise the question: only said when the user asked one. */
const QUESTION_ONLY = new Set(['Good question, one moment.', "That's a good one.", 'Câu hỏi hay, chờ chút nhé.']);

/**
 * Whether the user's words are a question: a question mark, or (transcripts often have
 * none) an English question opening, or Vietnamese question words.
 */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  if (/^(?:(?:so|and|but|okay|ok|hey|um|uh)[,\s]+)*(?:what|what's|whats|who|who's|whom|whose|when|where|where's|why|how|how's|which|is|are|was|were|am|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|isn't|aren't|don't|doesn't|didn't|can't|won't)\b/.test(t)) return true;
  return /(?:^|\s)(?:gì|sao|nào|ai|đâu|bao giờ|bao nhiêu|mấy|không|chưa|hả|à|nhỉ|chứ)\s*[.!]?\s*$|(?:^|\s)(?:tại sao|vì sao|làm sao|thế nào|như thế nào|có phải)(?:\s|$)/u.test(t);
}

/** The phrases fit for what the user said ("Good question" only after a question). */
function fitting(pool: readonly string[], userText: string | undefined): readonly string[] {
  if (userText === undefined || isQuestion(userText)) return pool;
  const kept = pool.filter((p) => !QUESTION_ONLY.has(p));
  return kept.length ? kept : pool;
}

/** A filler language this module has phrases for; anything else falls back to English. */
export type FillerLanguage = 'en' | 'vi';

/**
 * A caller's own phrases in place of the built-in ones (e.g. a persona's Vietnamese,
 * whose pronouns depend on who it's talking to). Missing or empty lists keep the defaults.
 */
export type FillerPool = { first?: readonly string[]; continuation?: readonly string[]; apology?: readonly string[] };

/**
 * Pick a random short "first-beat" filler that hasn't been used
 * recently (per the caller-provided `recent` set, which the caller
 * typically threads across turns so we don't repeat yesterday's word
 * as today's opener). With `userText`, phrases praising a question
 * ("Good question") are only picked when it is one.
 */
export function pickFirstFiller(recent?: Set<string>, lang: FillerLanguage = 'en', custom?: FillerPool, userText?: string): string {
  const beats = fitting(custom?.first?.length ? custom.first : lang === 'vi' ? VI_FIRST_BEATS : FIRST_BEATS, userText);
  const available = recent
    ? beats.filter((f) => !recent.has(f))
    : beats;
  const picked = randomPick(available.length > 0 ? available : beats) ?? FALLBACK;
  recent?.add(picked);
  return picked;
}

/**
 * A short continuation filler. Keep this to one phrase so R1-side playback can
 * keep up with repeated fillers while a slow local model is still thinking.
 * Callers pass a `used` set so we prefer not to pick the same phrase twice in a
 * turn; they can also pass a `recent` set scoped to the whole session.
 */
export function pickContinuationFiller(
  reason: string,
  used: Set<string>,
  recent?: Set<string>,
  lang: FillerLanguage = 'en',
  custom?: FillerPool,
  userText?: string,
): string {
  const pool = fitting(custom?.continuation?.length ? custom.continuation : lang === 'vi' ? VI_CONTINUATIONS : CONTINUATIONS_BY_REASON[reason] ?? CONTINUATIONS_BY_REASON['unclassified'] ?? [FALLBACK], userText);
  // Prefer phrases we haven't used this turn OR recently across turns.
  const fresh = pool.filter((p) => !used.has(p) && !(recent?.has(p) ?? false));
  const unused = pool.filter((p) => !used.has(p));
  const candidates = fresh.length > 0 ? fresh : unused.length > 0 ? unused : pool;

  const a = randomPick(candidates) ?? FALLBACK;
  used.add(a);
  recent?.add(a);
  return a;
}

/** Every fixed phrase the pipeline may speak on its own (apologies and fillers), so a voice can prepare them ahead of time. */
export function allFillerPhrases(lang: FillerLanguage = 'en'): string[] {
  if (lang === 'vi') return [...new Set([...VI_APOLOGIES, ...VI_FIRST_BEATS, ...VI_CONTINUATIONS])];
  return [...new Set([...APOLOGIES, ...FIRST_BEATS, ...Object.values(CONTINUATIONS_BY_REASON).flat(), FALLBACK])];
}
