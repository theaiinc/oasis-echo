import type { Emotion, Strategy, StyleTag, TtsDirectives } from './types.js';

/**
 * Strongly-typed map of every SSE event the server broadcasts to
 * connected /events subscribers. Use as:
 *
 *   client.on('tts.chunk', (p) => { ... p is TtsChunkEvent ... });
 *
 * All events include at least a `turnId` and an `atMs` timestamp.
 */

export type BaseEvent = {
  turnId: string;
  atMs: number;
};

export type UserInputEvent = BaseEvent & {
  text: string;
  emotion?: { label: string; confidence: number };
};

export type SttPartialEvent = BaseEvent & {
  text: string;
};

export type SttFinalEvent = BaseEvent & {
  text: string;
};

export type SttPostprocessEvent = BaseEvent & {
  original: string;
  final: string;
  stages: string[];
  history: Array<{ stage: string; before: string; after: string; info?: Record<string, unknown> }>;
  latencyMs: number;
};

export type RouteDecisionEvent = BaseEvent & {
  decision: {
    kind: 'local' | 'escalate' | 'reflex';
    intent: string;
    reply?: string;
  };
};

export type TtsChunkEvent = BaseEvent & {
  text: string;
  sampleRate: number;
  final: boolean;
  filler: boolean;
  /** Base64-encoded 16-bit PCM, mono, at `sampleRate`. Empty when engine is passthrough. */
  audio?: string;
};

export type TurnCompleteEvent = {
  turn: {
    id: string;
    tier: 'reflex' | 'local' | 'escalated';
    intent: string;
    interrupted: boolean;
    userText: string;
    agentText?: string;
    startedAtMs: number;
    endedAtMs?: number;
  };
};

export type TurnSummaryEvent = {
  turnId: string;
  tier: 'reflex' | 'local' | 'escalated';
  intent: string;
  interrupted: boolean;
  latencyMs: number;
};

export type BargeInEvent = {
  turnId?: string;
  interruptedTurnId?: string;
  atMs: number;
};

export type EmotionDirectivesEvent = BaseEvent & {
  source: 'acoustic' | 'text';
  detected: Emotion;
  confidence: number;
  effective: Emotion;
  strategy: Strategy;
  styleTags: StyleTag[];
  rationale: string;
  directives: TtsDirectives;
};

export type ErrorEvent = {
  source: string;
  error: string;
  atMs: number;
};

/** Master event map — add a row when the server adds a new broadcast type. */
export interface EventMap {
  'user.input': UserInputEvent;
  'stt.partial': SttPartialEvent;
  'stt.final': SttFinalEvent;
  'stt.postprocess': SttPostprocessEvent;
  'route.decision': RouteDecisionEvent;
  'tts.chunk': TtsChunkEvent;
  'turn.complete': TurnCompleteEvent;
  'turn.summary': TurnSummaryEvent;
  'bargein': BargeInEvent;
  'emotion.directives': EmotionDirectivesEvent;
  'error': ErrorEvent;
}

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (payload: EventMap[E]) => void;
