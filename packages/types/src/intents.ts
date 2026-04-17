export const INTENTS = [
  'greeting',
  'smalltalk',
  'confirm',
  'deny',
  'cancel',
  'stop',
  'wait',
  'backchannel',
  'question_simple',
  'question_complex',
  'command_local',
  'command_tool',
  'unknown',
] as const;

export type Intent = (typeof INTENTS)[number];

export type RouteDecision =
  | { kind: 'reflex'; intent: Intent; reply?: string }
  | { kind: 'local'; intent: Intent; reply?: string }
  | { kind: 'escalate'; intent: Intent; reason: string; filler?: string };

export type RouterOutput = {
  intent: Intent;
  confidence: number;
  decision: RouteDecision;
};
