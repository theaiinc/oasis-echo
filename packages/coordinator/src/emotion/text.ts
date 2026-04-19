import type { Emotion } from './types.js';

/**
 * Lightweight text-based emotion detector. Intended as a COMPLEMENT to
 * the acoustic SER classifier — not a replacement. Acoustic is strong
 * at arousal (happy, surprise, angry) because those have clear energy
 * / pitch signatures; it's weak at semantically-driven emotions like
 * sadness, frustration, confusion, and urgency where the signal lives
 * in the words, not the prosody.
 *
 * This module fills that gap with zero-cost keyword + regex matching.
 * Rules are intentionally conservative — we only assign a label when
 * there's a clear textual cue, and we leave acoustic the authority on
 * anything it claims confidently.
 */

export type TextEmotionResult = {
  emotion: Emotion;
  confidence: number;
  matched: string[];
};

type Rule = {
  emotion: Emotion;
  patterns: RegExp[];
  /** Per-rule confidence. Lower for ambiguous cues, higher for unambiguous ones. */
  weight: number;
};

const RULES: Rule[] = [
  {
    emotion: 'frustrated',
    weight: 0.82,
    patterns: [
      /\b(?:frustrat|annoy|fed up|sick of|tired of)\w*\b/i,
      /\b(?:ridiculous|stupid|useless|broken|crap|junk)\b/i,
      /\b(?:doesn'?t|won'?t|can'?t|wouldn'?t) (?:work|help|answer|listen|stop)\b/i,
      /\bkeeps? (?:doing|happening|failing|crashing|breaking)\b/i,
      /\bwasted? (?:my |your |our )?time\b/i,
      /\bfor the (?:third|fourth|fifth|\d+th|\d+nd|\d+rd) time\b/i,
    ],
  },
  {
    emotion: 'sad',
    weight: 0.80,
    patterns: [
      /\b(?:sad|upset|depress|heartbroken|devastat|miserable|grief|grieving|mourning)\w*\b/i,
      /\b(?:lost|losing|died|passed away|gone forever|never (?:see|get back))\b/i,
      /\b(?:hurts?|aching|broken) (?:me|inside|heart)\b/i,
      /\bfeeling (?:down|low|blue|empty|hollow|alone)\b/i,
      /\bcr(?:y|ied|ying)\b/i,
    ],
  },
  {
    emotion: 'confused',
    weight: 0.75,
    patterns: [
      /\b(?:confused|puzzl|baffl|unclear)\w*\b/i,
      /\b(?:i )?don'?t (?:understand|get (?:it|that|this)|know what)\b/i,
      /\b(?:what|how) (?:do you|does that|does it) mean\b/i,
      /\bnot sure what (?:you|i|that|this)\b/i,
      /\b(?:you|that) (?:lost|confused) me\b/i,
      /\bwait,? (?:what|how)\b/i,
    ],
  },
  {
    emotion: 'urgent',
    weight: 0.78,
    patterns: [
      // Unambiguous urgency words. Deliberately DROPPED "right now"
      // (false-fires on "I'm right now doing X" conversational
      // filler) and bare "quickly"/"immediately" (too weak on their
      // own — "immediately called" isn't urgent).
      /\b(?:asap|urgent(?:ly|cy)?|hurry)\b/i,
      /\bneed (?:this|it|that) (?:now|immediately|asap|today|by)\b/i,
      /\bas (?:soon|fast) as possible\b/i,
      /\bno time to (?:wait|spare|lose)\b/i,
      /\b(?:emergency|critical|time-?sensitive)\b/i,
      // "right now" counts ONLY when paired with a need/action verb.
      /\b(?:need|want|have to|must|gotta|got to) (?:[^.!?]{0,30})? right now\b/i,
    ],
  },
  {
    emotion: 'happy',
    weight: 0.70,
    patterns: [
      // Lower weight — acoustic usually wins on happy, but we still
      // want to catch strong textual cues like "I'm so excited".
      /\b(?:excite|thrill|delight|love|awesome|amazing|fantastic|wonderful)\w*\b/i,
      /\b(?:so|really|super) (?:happy|excited|glad|pumped)\b/i,
      /\bcan'?t wait\b/i,
      /\byay\b|\bwoo+hoo+\b/i,
    ],
  },
  {
    emotion: 'surprise',
    weight: 0.68,
    patterns: [
      /\b(?:wow|whoa|woah|omg|oh my (?:god|gosh))\b/i,
      /\bno way\b/i,
      /\bare you (?:serious|kidding)\b/i,
      /\bi can'?t believe\b/i,
    ],
  },
];

/**
 * Classify a transcript by text cues. Returns the highest-weighted
 * match or null when no rule fires.
 */
export function detectEmotionFromText(text: string): TextEmotionResult | null {
  if (!text || !text.trim()) return null;
  let best: TextEmotionResult | null = null;
  for (const rule of RULES) {
    const matched: string[] = [];
    for (const re of rule.patterns) {
      const m = text.match(re);
      if (m && m[0]) matched.push(m[0]);
    }
    if (matched.length === 0) continue;
    // Small bonus for multiple independent matches. Caps at +0.15.
    const bonus = Math.min(0.15, 0.05 * (matched.length - 1));
    const confidence = Math.min(0.98, rule.weight + bonus);
    if (!best || confidence > best.confidence) {
      best = { emotion: rule.emotion, confidence, matched };
    }
  }
  return best;
}
