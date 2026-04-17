import {
  INTENTS,
  type DialogueState,
  type Intent,
  type RouterOutput,
} from '@oasis-echo/types';

export interface Router {
  route(input: { text: string; state: DialogueState }): Promise<RouterOutput>;
}

/**
 * Prompt used by the SLM coordinator. State-aware: only the allowed
 * intents for the current phase are offered, preventing "yeah" from
 * being classified as confirm when no confirmation is pending.
 */
export function buildRouterPrompt(text: string, state: DialogueState): string {
  const allowed = state.allowedIntents.join(', ');
  const summary = state.summary.length > 0 ? `Summary so far: ${state.summary}\n` : '';
  const recent = state.turns
    .slice(-3)
    .map((t) => `  user: ${t.userText}${t.agentText ? `\n  agent: ${t.agentText}` : ''}`)
    .join('\n');
  return [
    'You are the routing module for a voice assistant. Emit JSON only.',
    `Phase: ${state.phase}`,
    `Allowed intents: [${allowed}]`,
    summary,
    recent ? `Recent turns:\n${recent}` : '',
    `User: "${text}"`,
    '',
    'Respond with JSON matching:',
    '{"intent": "<one of allowed>", "confidence": 0.0..1.0, "kind": "local"|"escalate", "reply"?: string, "reason"?: string, "filler"?: string}',
    'Use kind="escalate" for: tool use, multi-step reasoning, RAG, low confidence (<0.7), or unfamiliar topics.',
    'Use kind="local" for: greetings, confirmations, simple factual answers you are certain about.',
    'When escalating, include a "filler" <= 6 words the TTS can play immediately.',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

export type RouterJson = {
  intent: string;
  confidence: number;
  kind: 'local' | 'escalate';
  reply?: string;
  reason?: string;
  filler?: string;
};

export function parseRouterJson(raw: string, allowed: readonly Intent[]): RouterJson | null {
  const extracted = extractJson(raw);
  if (!extracted) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const intent = typeof p['intent'] === 'string' ? p['intent'] : null;
  const confidence = typeof p['confidence'] === 'number' ? p['confidence'] : null;
  const kind = p['kind'] === 'local' || p['kind'] === 'escalate' ? p['kind'] : null;
  if (!intent || confidence === null || !kind) return null;
  if (!(INTENTS as readonly string[]).includes(intent)) return null;
  if (!allowed.includes(intent as Intent) && allowed.length > 0) {
    // downgrade to unknown rather than allowing out-of-phase intents
    return { ...(p as RouterJson), intent: 'unknown', kind: 'escalate', confidence: 0.3 };
  }
  return p as RouterJson;
}

function extractJson(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export function toRouterOutput(json: RouterJson): RouterOutput {
  const intent = json.intent as Intent;
  if (json.kind === 'local') {
    return {
      intent,
      confidence: json.confidence,
      decision: {
        kind: 'local',
        intent,
        ...(json.reply !== undefined ? { reply: json.reply } : {}),
      },
    };
  }
  return {
    intent,
    confidence: json.confidence,
    decision: {
      kind: 'escalate',
      intent,
      reason: json.reason ?? 'complex',
      ...(json.filler !== undefined ? { filler: json.filler } : {}),
    },
  };
}

/**
 * Heuristic router used in tests and as a fallback when no SLM backend
 * is configured. Covers the decision logic in prod but with regex
 * instead of a model. Good enough to validate the orchestration spine.
 */
export class HeuristicRouter implements Router {
  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    const text = input.text.toLowerCase().trim();
    const phase = input.state.phase;

    if (phase === 'confirming') {
      if (/^(yes|yeah|yep|yup|correct|right|sure|confirm)\b/.test(text)) {
        return {
          intent: 'confirm',
          confidence: 0.95,
          decision: { kind: 'local', intent: 'confirm', reply: 'Confirmed.' },
        };
      }
      if (/^(no|nope|nah|deny|cancel|wrong)\b/.test(text)) {
        return {
          intent: 'deny',
          confidence: 0.95,
          decision: { kind: 'local', intent: 'deny', reply: 'Okay, cancelled.' },
        };
      }
    }

    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/.test(text)) {
      return {
        intent: 'greeting',
        confidence: 0.97,
        decision: { kind: 'local', intent: 'greeting', reply: 'Hi there!' },
      };
    }

    if (/\b(search|look\s*up|find|schedule|book|call|email|send|create|delete|update)\b/.test(text)) {
      return {
        intent: 'command_tool',
        confidence: 0.8,
        decision: {
          kind: 'escalate',
          intent: 'command_tool',
          reason: 'tool-needed',
          filler: 'One moment, let me check.',
        },
      };
    }

    if (/\b(why|how|explain|compare|analyze|summariz|differen)/.test(text)) {
      return {
        intent: 'question_complex',
        confidence: 0.75,
        decision: {
          kind: 'escalate',
          intent: 'question_complex',
          reason: 'complex-reasoning',
          filler: 'Let me think about that.',
        },
      };
    }

    if (text.length < 60 && /^(what|when|where|who)\b/.test(text)) {
      return {
        intent: 'question_simple',
        confidence: 0.7,
        decision: {
          kind: 'escalate',
          intent: 'question_simple',
          reason: 'factual-lookup',
          filler: 'Looking that up.',
        },
      };
    }

    if (text.length < 40) {
      return {
        intent: 'smalltalk',
        confidence: 0.6,
        decision: {
          kind: 'local',
          intent: 'smalltalk',
          reply: 'Got it.',
        },
      };
    }

    return {
      intent: 'unknown',
      confidence: 0.4,
      decision: {
        kind: 'escalate',
        intent: 'unknown',
        reason: 'unclassified',
        filler: 'One moment.',
      },
    };
  }
}
