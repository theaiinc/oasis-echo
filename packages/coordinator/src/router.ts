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
    'Classify the next voice turn and output ONE JSON object. Nothing else.',
    '',
    'Schema: {"intent":"<one-of-allowed>","confidence":0.85,"kind":"local"|"escalate","reply":"..."}',
    '',
    'INTENT RULES (very important — pick the right bucket):',
    '  smalltalk         — social pleasantries ABOUT the speaker/agent: "how are you", "what\'s up", "how\'s it going", "you doing okay", "nice to meet you"',
    '  greeting          — bare openers: "hi", "hey", "hello"',
    '  confirm / deny    — "yes" / "no" / "yeah" / "nope" etc',
    '  cancel / stop / wait — meta commands to interrupt',
    '  question_simple   — quick factual lookup: "what time is it", "when was X born", "capital of Y"',
    '  question_complex  — needs reasoning / explanation: "why does X happen", "explain Y", "how does Z work"',
    '  command_tool      — requires an action/tool: "send an email", "schedule a meeting", "search for…"',
    '  command_local     — simple app command: "mute", "brighter", "next page"',
    '',
    'CRITICAL: "how are you" / "how you doing" / "what\'s up" are smalltalk, NOT question_complex.',
    '          They are rhetorical check-ins, not questions needing reasoning.',
    '',
    'EXAMPLES:',
    '  user: "hey"                → {"intent":"greeting","confidence":0.98,"kind":"local","reply":"Hey! What\'s up?"}',
    '  user: "hey how you doing"  → {"intent":"smalltalk","confidence":0.95,"kind":"local","reply":"Doing great — you?"}',
    '  user: "what\'s up"          → {"intent":"smalltalk","confidence":0.95,"kind":"local","reply":"Not much, you?"}',
    '  user: "yeah"               → {"intent":"confirm","confidence":0.97,"kind":"local","reply":"Cool."}',
    '  user: "what time is it"    → {"intent":"question_simple","confidence":0.9,"kind":"escalate"}',
    '  user: "explain gravity"    → {"intent":"question_complex","confidence":0.9,"kind":"escalate"}',
    '  user: "email alice the notes" → {"intent":"command_tool","confidence":0.9,"kind":"escalate"}',
    '',
    `phase: ${state.phase}`,
    `allowed intents: [${allowed}]`,
    summary,
    recent ? `recent:\n${recent}` : '',
    `user: "${text}"`,
    '',
    'Keep reply under 20 words, casual, conversational. Output JSON only.',
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
 * Always escalates past the reflex tier. Used when a real reasoner
 * (Anthropic or Ollama) is available and we want most turns to flow
 * through the model instead of a canned local reply. The reflex tier
 * still short-circuits greetings/confirms/cancels before this runs.
 */
export class PassthroughRouter implements Router {
  async route(input: { text: string; state: DialogueState }): Promise<RouterOutput> {
    void input.state;
    const text = input.text.trim();
    if (text.length === 0) {
      return {
        intent: 'unknown',
        confidence: 0.4,
        decision: { kind: 'escalate', intent: 'unknown', reason: 'unclassified' },
      };
    }
    const lower = text.toLowerCase();
    const isQuestion = /\?$/.test(text) || /^(what|when|where|who|why|how|which|is|are|can|could|would|should|do|does|did)\b/.test(lower);
    const isCommand = /^(please |hey |)?(search|look\s*up|find|schedule|book|call|email|send|create|delete|update|open|close|remind|play|pause)\b/.test(lower);
    const intent = isCommand ? 'command_tool' : isQuestion ? 'question_complex' : 'question_complex';
    return {
      intent,
      confidence: 0.8,
      decision: {
        kind: 'escalate',
        intent,
        reason: isCommand ? 'tool-needed' : 'complex-reasoning',
        // Leave filler unset so the pipeline rotates through the pool
        // for this reason — avoids the same word every turn.
      },
    };
  }
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
          // filler left blank — pipeline picks from the pool
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
