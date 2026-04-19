/**
 * Shared types duplicated from the coordinator package so the SDK has
 * zero runtime dependency on server-side code. Keep this file in sync
 * with `packages/coordinator/src/emotion/types.ts` and the server's
 * SSE event payloads.
 */

/* ──────────────── Emotion ──────────────── */

export type Emotion =
  | 'angry'
  | 'calm'
  | 'disgust'
  | 'fear'
  | 'happy'
  | 'neutral'
  | 'sad'
  | 'surprise'
  | 'frustrated'
  | 'confused'
  | 'urgent';

export type Strategy = 'mirror' | 'soften' | 'counterbalance';

export type Intonation = 'soft' | 'dynamic' | 'flat';
export type PausePattern = 'short' | 'natural' | 'extended';

export type StyleTag =
  | 'empathetic'
  | 'calm'
  | 'cheerful'
  | 'reassuring'
  | 'curious'
  | 'focused'
  | 'supportive'
  | 'warm'
  | 'patient';

export type TtsParameters = {
  speakingRate: number;
  pitch: number;
  volume: number;
  intonation: Intonation;
  pausePattern: PausePattern;
};

export type TtsDirectives = {
  playbackRate: number;
  gain: number;
  interChunkSilenceMs: number;
  pitchSemitones: number;
  ssml: string;
  voiceHint?: string;
};

/* ──────────────── Correction API ──────────────── */

export type CorrectionAnalysis = {
  wordPairs: Array<{ wrong: string; right: string }>;
  addAsPhrase: boolean;
};

export type CorrectionsState = {
  wordRules: Record<string, string>;
  phrases: string[];
  history: Array<{ original: string; corrected: string; atMs: number }>;
};

/* ──────────────── /turn request body ──────────────── */

export type EmotionPayload = {
  label: string;
  confidence: number;
  strategy?: Strategy;
};

export type TurnRequest = {
  text: string;
  emotion?: EmotionPayload;
};
