import type { AgentContext } from './types.js';

/**
 * Signal that the user changed topic. When true, downstream stages
 * should NOT bias the user's transcript toward agent-context vocabulary —
 * doing so would pull the new topic toward irrelevant words.
 */
export type TopicChangeSignal = {
  changed: boolean;
  reason?: 'explicit-marker' | 'yes-no-mismatch' | 'choice-mismatch';
};

const TOPIC_CHANGE_MARKERS = [
  /\bby the way\b/i,
  /\banyway\b/i,
  /\bactually,?\b/i,
  /\bnever\s*mind\b/i,
  /\bwait\b/i,
  /\bhold on\b/i,
  /^\s*(?:oh|ah)[,\s]/i,
  /\balso\b/i,
  /\bdifferent\s+(?:question|topic|subject)\b/i,
  /\bchange\s+(?:of\s+)?(?:topic|subject)\b/i,
  /\bforget\s+(?:that|it)\b/i,
  /\bmoving on\b/i,
];

const YES_NO_REPLY = /\b(?:yes|yeah|yep|yup|sure|correct|right|no|nope|nah|not really|okay|ok)\b/i;

export function detectTopicChange(
  userText: string,
  agentContext?: AgentContext,
): TopicChangeSignal {
  if (!agentContext?.lastUtterance) return { changed: false };
  const trimmed = userText.trim();
  if (!trimmed) return { changed: false };

  for (const re of TOPIC_CHANGE_MARKERS) {
    if (re.test(trimmed)) return { changed: true, reason: 'explicit-marker' };
  }

  const q = agentContext.pendingQuestion;
  const wordCount = trimmed.split(/\s+/).length;
  if (q?.kind === 'yes-no' && wordCount <= 8) {
    if (!YES_NO_REPLY.test(trimmed)) {
      return { changed: true, reason: 'yes-no-mismatch' };
    }
  }
  if (q?.kind === 'choice' && q.options && q.options.length > 0 && wordCount <= 8) {
    const lower = trimmed.toLowerCase();
    const matched = q.options.some((o) => {
      const head = o.toLowerCase().split(/\s+/)[0]!;
      return head.length > 0 && lower.includes(head);
    });
    if (!matched) return { changed: true, reason: 'choice-mismatch' };
  }

  return { changed: false };
}

/**
 * Coarse classification of the agent's last utterance into the type of
 * reply we expect from the user. Called once per turn after the agent
 * finishes; the result lives on AgentContext.pendingQuestion so the
 * topic-gate on the NEXT user turn can check reply-shape.
 *
 * The classifier is deliberately conservative — when in doubt, returns
 * `undefined` or `{ kind: 'open' }` so no reply gets incorrectly flagged
 * as a topic change.
 */
export function classifyQuestion(
  agentText: string,
): AgentContext['pendingQuestion'] | undefined {
  const t = agentText.trim();
  if (!t) return undefined;
  // A question mark anywhere in the last sentence suffices.
  const lastSentence = lastSentenceOf(t);
  if (!lastSentence.endsWith('?')) return undefined;
  const lower = lastSentence.toLowerCase();

  // "A or B" choice — check before yes-no because "do you want X or Y"
  // starts with an auxiliary but is really a choice.
  const orMatch = lower.match(/\b([a-z][a-z\s]{1,30}?)\s+or\s+([a-z][a-z\s]{1,30}?)\s*\??$/);
  if (orMatch) {
    const a = orMatch[1]!.trim();
    const b = orMatch[2]!.trim();
    if (a && b && a !== b) {
      return { kind: 'choice', options: [a, b] };
    }
  }

  if (
    /^(?:do|does|did|is|are|was|were|will|would|can|could|should|shall|may|might|have|has|had)\b/.test(
      lower,
    )
  ) {
    return { kind: 'yes-no' };
  }

  return { kind: 'open' };
}

function lastSentenceOf(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? text.trim();
}
