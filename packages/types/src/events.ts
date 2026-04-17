import type { AudioFrame } from './audio.js';
import type { RouteDecision } from './intents.js';
import type { Turn } from './dialogue.js';

export type AudioFrameEvent = { type: 'audio.frame'; frame: AudioFrame };
export type VadStartEvent = { type: 'vad.start'; atMs: number };
export type VadEndEvent = { type: 'vad.end'; atMs: number; durationMs: number };
export type SttPartialEvent = { type: 'stt.partial'; turnId: string; text: string; atMs: number };
export type SttFinalEvent = { type: 'stt.final'; turnId: string; text: string; atMs: number };
export type RouteDecisionEvent = {
  type: 'route.decision';
  turnId: string;
  decision: RouteDecision;
  atMs: number;
};
export type LlmTokenEvent = { type: 'llm.token'; turnId: string; token: string; atMs: number };
export type LlmDoneEvent = { type: 'llm.done'; turnId: string; atMs: number };
export type TtsChunkEvent = {
  type: 'tts.chunk';
  turnId: string;
  pcm: Int16Array;
  sampleRate: number;
  atMs: number;
  final: boolean;
};
export type TtsStartEvent = { type: 'tts.start'; turnId: string; atMs: number };
export type TtsDoneEvent = { type: 'tts.done'; turnId: string; atMs: number };
export type BargeInEvent = { type: 'bargein'; atMs: number; interruptedTurnId: string };
export type TurnCompleteEvent = { type: 'turn.complete'; turn: Turn };
export type ErrorEvent = { type: 'error'; source: string; error: Error; atMs: number };

export type PipelineEvent =
  | AudioFrameEvent
  | VadStartEvent
  | VadEndEvent
  | SttPartialEvent
  | SttFinalEvent
  | RouteDecisionEvent
  | LlmTokenEvent
  | LlmDoneEvent
  | TtsChunkEvent
  | TtsStartEvent
  | TtsDoneEvent
  | BargeInEvent
  | TurnCompleteEvent
  | ErrorEvent;

export type EventType = PipelineEvent['type'];

export type EventOf<T extends EventType> = Extract<PipelineEvent, { type: T }>;
