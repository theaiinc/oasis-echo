import type { SystemVoice } from './voices.js';

/**
 * What the session needs from the phone. `createExpoAdapters()` (from
 * '@theaiinc/oasis-echo-expo/expo') builds these from expo-speech, expo-speech-recognition and
 * expo-audio; tests and other runtimes pass their own.
 */

/** The phone's own voice (expo-speech). */
export interface DeviceSpeech {
  /** Speak one line; callbacks fire once each (onDone or onError, after onStart). */
  speak(text: string, opts: { language: string; voice?: string; rate?: number; onStart?: () => void; onDone: () => void; onError: (err: unknown) => void }): void;
  /** Stop speaking now and drop anything queued in the engine. */
  stop(): void;
  voices(): Promise<SystemVoice[]>;
}

export type RecognizerEvent =
  | { type: 'start' }
  | { type: 'speechstart' }
  | { type: 'result'; text: string; isFinal: boolean }
  | { type: 'end' }
  | { type: 'error'; error: string; message?: string };

/** The phone's own speech recognition (expo-speech-recognition). */
export interface Recognizer {
  /** Ask for the microphone and speech recognition permissions; true when granted. */
  requestPermissions(): Promise<boolean>;
  start(opts: { lang: string; interimResults: boolean; continuous: boolean; onDevice?: boolean }): void;
  /** Stop listening, delivering a final result for what was heard. */
  stop(): void;
  /** Stop listening and drop what was heard. */
  abort(): void;
  /** Subscribe to recognizer events; returns an unsubscribe. */
  listen(cb: (e: RecognizerEvent) => void): () => void;
}

/** Plays the server's voice: WAV clips, one after another. */
export interface ClipPlayer {
  /** Queue a clip (WAV bytes); `onEnd` fires when it finished or was stopped. */
  play(wav: Uint8Array, onEnd: () => void): void;
  /** Stop the current clip and drop the queue. */
  stop(): void;
}

export type EchoAdapters = { speech?: DeviceSpeech; recognizer: Recognizer; player?: ClipPlayer };
