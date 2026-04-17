import type { Intent, RouterOutput } from '@oasis-echo/types';

type Rule = {
  pattern: RegExp;
  intent: Intent;
  reply?: string;
};

const RULES: Rule[] = [
  { pattern: /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening))[\s!.,?]*$/i, intent: 'greeting', reply: 'Hi!' },
  { pattern: /^\s*(stop|shut up|quiet|silence)[\s!.,?]*$/i, intent: 'stop' },
  { pattern: /^\s*(wait|hold on|one (moment|sec(ond)?))[\s!.,?]*$/i, intent: 'wait', reply: 'Sure.' },
  { pattern: /^\s*(cancel|nevermind|never mind|forget it)[\s!.,?]*$/i, intent: 'cancel' },
  { pattern: /^\s*(yes|yeah|yep|yup|correct|right|sure)[\s!.,?]*$/i, intent: 'confirm' },
  { pattern: /^\s*(no|nope|nah|incorrect|wrong)[\s!.,?]*$/i, intent: 'deny' },
  { pattern: /^\s*(mhm|uh huh|uhuh|ok|okay|got it)[\s!.,?]*$/i, intent: 'backchannel' },
];

/**
 * Sub-20ms deterministic intent classifier for ultra-short utterances.
 * Returns null when no rule matches so the coordinator can take over.
 */
export function reflexClassify(text: string): RouterOutput | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  for (const r of RULES) {
    if (r.pattern.test(trimmed)) {
      return {
        intent: r.intent,
        confidence: 0.98,
        decision: {
          kind: 'reflex',
          intent: r.intent,
          ...(r.reply !== undefined ? { reply: r.reply } : {}),
        },
      };
    }
  }
  return null;
}
