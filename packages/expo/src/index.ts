/**
 * @theaiinc/oasis-echo-expo — voice with an oasis-echo server from Expo apps (Android and iOS).
 *
 *   import { EchoVoiceSession, EchoConnection } from '@theaiinc/oasis-echo-expo';
 *   import { createExpoAdapters } from '@theaiinc/oasis-echo-expo/expo';
 *
 * EchoConnection is the transport (event stream, posts, audio socket) for apps that run their own turns;
 * EchoVoiceSession is a whole call on top of it. Everything here is plain TypeScript (no native imports); the
 * '/expo' entry wires the session to expo-speech, expo-speech-recognition and expo-audio.
 */
export * from './adapters.js';
export * from './connection.js';
export * from './pcm.js';
export * from './protocol.js';
export * from './session.js';
export * from './sse-parser.js';
export * from './voices.js';
export * from './wav.js';
