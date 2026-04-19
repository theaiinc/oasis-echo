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
    'Schema: {"intent":"<one-of-allowed>","confidence":0.85,"kind":"local"|"escalate","reply":"...","filler":"..."}',
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
    'FILLER (only when kind="escalate"): a short 3-8 word phrase that sounds like the agent is starting to think about THIS specific question. It plays while the real reply is being generated.',
    '  - Reference the actual topic the user just said (keep it concrete).',
    '  - Sound like natural spoken hesitation, not a canned tag.',
    '  - Avoid clichés: "That sounds interesting", "Great question", "Let me think about that".',
    '  - Do NOT include a filler for kind="local" — the reply plays immediately.',
    '',
    'EXAMPLES:',
    '  user: "hey"                → {"intent":"greeting","confidence":0.98,"kind":"local","reply":"Hey! What\'s up?"}',
    '  user: "hey how you doing"  → {"intent":"smalltalk","confidence":0.95,"kind":"local","reply":"Doing great — you?"}',
    '  user: "yeah"               → {"intent":"confirm","confidence":0.97,"kind":"local","reply":"Cool."}',
    '  user: "what time is it"    → {"intent":"question_simple","confidence":0.9,"kind":"escalate","filler":"Okay, one sec — checking the time"}',
    '  user: "explain gravity"    → {"intent":"question_complex","confidence":0.9,"kind":"escalate","filler":"Hmm, gravity — let me think"}',
    '  user: "help me plan a Tokyo trip" → {"intent":"command_tool","confidence":0.9,"kind":"escalate","filler":"Okay, Tokyo trip — pulling this together"}',
    '  user: "how do quantum computers work" → {"intent":"question_complex","confidence":0.9,"kind":"escalate","filler":"Quantum computers, okay — thinking"}',
    '  user: "email alice the notes" → {"intent":"command_tool","confidence":0.9,"kind":"escalate","filler":"Alright, emailing Alice — one moment"}',
    '',
    `phase: ${state.phase}`,
    `allowed intents: [${allowed}]`,
    summary,
    recent ? `recent:\n${recent}` : '',
    `user: "${text}"`,
    '',
    'Keep reply under 20 words, casual, conversational. Keep filler under 8 words. Output JSON only.',
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
 * Inline fallback used by OllamaRouter when the SLM call fails — we
 * still need to make some decision rather than block the turn. A bare
 * "always escalate" punt is fine: the reasoning tier will handle
 * whatever the intent actually is.
 */
export const alwaysEscalate: Router = {
  async route() {
    return {
      intent: 'unknown',
      confidence: 0.3,
      decision: { kind: 'escalate', intent: 'unknown', reason: 'unclassified' },
    };
  },
};
