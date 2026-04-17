import {
  ALLOWED_INTENTS_BY_PHASE,
  newDialogueState,
  type DialogueState,
  type Intent,
  type Phase,
  type Slot,
  type Turn,
} from '@oasis-echo/types';

export type StateTransition = {
  from: Phase;
  to: Phase;
  on: Intent[];
};

export const DEFAULT_TRANSITIONS: StateTransition[] = [
  { from: 'idle', to: 'greeting', on: ['greeting'] },
  { from: 'idle', to: 'collecting', on: ['question_simple', 'question_complex', 'command_local', 'command_tool'] },
  { from: 'greeting', to: 'collecting', on: ['question_simple', 'question_complex', 'command_local', 'command_tool'] },
  { from: 'collecting', to: 'confirming', on: ['command_tool'] },
  { from: 'confirming', to: 'executing', on: ['confirm'] },
  { from: 'confirming', to: 'collecting', on: ['deny'] },
  { from: 'confirming', to: 'idle', on: ['cancel'] },
  { from: 'executing', to: 'closing', on: ['confirm'] },
  { from: 'executing', to: 'idle', on: ['cancel', 'stop'] },
  { from: 'closing', to: 'idle', on: ['greeting', 'confirm', 'deny'] },
];

export class DialogueStateStore {
  private state: DialogueState;
  private readonly transitions: StateTransition[];
  private readonly maxTurnsRetained: number;

  constructor(opts: {
    sessionId: string;
    now?: number;
    transitions?: StateTransition[];
    maxTurnsRetained?: number;
  }) {
    this.state = newDialogueState(opts.sessionId, opts.now ?? Date.now());
    this.transitions = opts.transitions ?? DEFAULT_TRANSITIONS;
    this.maxTurnsRetained = opts.maxTurnsRetained ?? 20;
  }

  snapshot(): Readonly<DialogueState> {
    return { ...this.state, slots: { ...this.state.slots }, turns: [...this.state.turns] };
  }

  get phase(): Phase {
    return this.state.phase;
  }

  get allowedIntents(): readonly Intent[] {
    return this.state.allowedIntents;
  }

  setSlot(key: string, value: Slot): void {
    this.state.slots[key] = value;
  }

  getSlot(key: string): Slot | undefined {
    return this.state.slots[key];
  }

  applyIntent(intent: Intent, now = Date.now()): { transitioned: boolean; to: Phase } {
    this.state.lastActivityMs = now;
    const t = this.transitions.find((tr) => tr.from === this.state.phase && tr.on.includes(intent));
    if (t) {
      this.state.phase = t.to;
      this.state.allowedIntents = ALLOWED_INTENTS_BY_PHASE[t.to];
      return { transitioned: true, to: t.to };
    }
    return { transitioned: false, to: this.state.phase };
  }

  recordTurn(turn: Turn): void {
    this.state.turns.push(turn);
    if (this.state.turns.length > this.maxTurnsRetained) {
      this.state.turns.shift();
    }
  }

  setSummary(summary: string): void {
    this.state.summary = summary;
  }

  reset(now = Date.now()): void {
    this.state = newDialogueState(this.state.sessionId, now);
  }
}
