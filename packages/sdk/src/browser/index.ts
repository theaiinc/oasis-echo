/**
 * Browser-only entrypoints for @oasis-echo/sdk — Web Audio playback,
 * mic PCM capture via AudioWorklet, SER emotion detector, and the
 * adaptive barge-in volume monitor. Import from:
 *
 *   import { AudioPlayer, MicCapture, EmotionDetector, BargeInMonitor }
 *     from '@oasis-echo/sdk/browser';
 */

export * from './audio-player.js';
export * from './mic-capture.js';
export * from './emotion-detector.js';
export * from './barge-in-monitor.js';
export * from './audio-stream.js';
