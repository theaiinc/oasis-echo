import type { AudioChunk } from '@oasis-echo/types';

export type SttPartial = {
  turnId: string;
  text: string;
  stable: boolean;
  atMs: number;
};

export type SttFinal = {
  turnId: string;
  text: string;
  atMs: number;
};

/**
 * Streaming STT interface. Real implementations plug in here (Whisper
 * via transformers.js, Parakeet-MLX, Deepgram, etc.). No implementation
 * ships in this repo today — the browser client uses the Web Speech
 * API for STT and the server simulates stt.partial events from the
 * committed user text for UI display.
 */
export interface StreamingStt {
  openTurn(turnId: string): SttTurn;
}

export interface SttTurn {
  feed(chunk: AudioChunk): void;
  readonly partials: AsyncIterable<SttPartial>;
  close(): Promise<SttFinal>;
  cancel(): void;
}
