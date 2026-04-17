import type { Intent } from './intents.js';

export type Phase =
  | 'idle'
  | 'greeting'
  | 'collecting'
  | 'confirming'
  | 'executing'
  | 'closing';

export type Slot = string | number | boolean | null;

export type Turn = {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly userText: string;
  readonly intent?: Intent;
  readonly agentText?: string;
  readonly tier: 'reflex' | 'local' | 'escalated';
  readonly interrupted: boolean;
};

export type DialogueState = {
  sessionId: string;
  phase: Phase;
  allowedIntents: readonly Intent[];
  slots: Record<string, Slot>;
  turns: Turn[];
  summary: string;
  startedAtMs: number;
  lastActivityMs: number;
};

export const ALLOWED_INTENTS_BY_PHASE: Record<Phase, readonly Intent[]> = {
  idle: ['greeting', 'smalltalk', 'question_simple', 'question_complex', 'command_local', 'command_tool'],
  greeting: ['greeting', 'smalltalk', 'question_simple', 'command_local', 'command_tool'],
  collecting: ['smalltalk', 'question_simple', 'question_complex', 'command_local', 'command_tool', 'cancel'],
  confirming: ['confirm', 'deny', 'cancel', 'wait'],
  executing: ['stop', 'cancel', 'wait', 'backchannel'],
  closing: ['greeting', 'smalltalk', 'confirm', 'deny'],
};

export function newDialogueState(sessionId: string, now: number): DialogueState {
  return {
    sessionId,
    phase: 'idle',
    allowedIntents: ALLOWED_INTENTS_BY_PHASE.idle,
    slots: {},
    turns: [],
    summary: '',
    startedAtMs: now,
    lastActivityMs: now,
  };
}
