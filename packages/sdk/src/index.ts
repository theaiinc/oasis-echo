/**
 * @oasis-echo/sdk — universal client bindings for the oasis-echo server.
 *
 * Works in browsers AND Node.js backends:
 *
 *   import { OasisClient, TurnDebouncer, scheduleChunk } from '@oasis-echo/sdk';
 *
 * For browser-only helpers (Web Audio playback, mic capture, emotion
 * detector, barge-in monitor) import from the `/browser` subpath:
 *
 *   import { AudioPlayer, MicCapture, EmotionDetector } from '@oasis-echo/sdk/browser';
 */

export * from './types.js';
export * from './events.js';
export * from './sse.js';
export * from './client.js';
export * from './turn-debouncer.js';
export * from './directives.js';
