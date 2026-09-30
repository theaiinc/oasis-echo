/**
 * When to answer after the user goes quiet, from what they said: soon after a
 * question or a finished sentence, later when the words trail off mid-thought.
 */

/** Words a sentence doesn't end on (English and Vietnamese), and trailing fillers. */
const TRAILING = /(?:^|[\s,])(and|but|or|so|because|cause|the|a|an|to|of|with|for|in|on|at|from|my|your|our|their|um+|uh+|er+|hmm+|like|if|when|that|which|then|is|are|was|were|và|nhưng|thì|là|của|để|với|mà|nên|vì|hoặc|hay|ờ+|ừm+|à+)\s*[.,…-]*$/iu;

/** Milliseconds of quiet to wait (counted from the last speech) before answering `text`. */
export function endpointMs(text: string): number {
  const t = text.trim();
  if (/(\.\.\.|…|,|-)$/.test(t) || TRAILING.test(t)) return 1800;
  if (/[?？]$/.test(t)) return 300;
  // Whisper ends almost everything with a full stop, mid-thought too ("I want to check
  // the" came back as "I want to check, though."), so a full stop alone is weak evidence.
  if (/[.!。！]$/.test(t)) return 800;
  return 900;
}
