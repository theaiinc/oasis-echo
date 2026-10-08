/**
 * VoiceSession: high-level voice-chat orchestration that glues together
 * the SDK's browser primitives (AudioPlayer, MicCapture, BargeInMonitor,
 * EmotionDetector, AudioStreamUpload) with the browser's native
 * SpeechRecognition and the OasisClient SSE stream.
 *
 * The class owns all the cross-cutting state that previously lived
 * inline in `packages/app/src/index.html`:
 *
 *   - mic pause/resume arbitration against TTS playback
 *   - `completedTurns` gating so gaps between sentence chunks don't
 *     prematurely restart mic capture (which could trigger a second
 *     /turn and abort the in-flight reply via the server's arbiter)
 *   - interim-stability tracking + pre-commit speculation
 *   - mid-utterance backchannel triggering
 *   - optional server-STT routing (?serverstt=1 style)
 *   - emotion pre-classification on final-utterance
 *
 * The hosting app is responsible only for UI wiring. Subscribe to the
 * session's `on('hint' | 'speakingChange' | 'error')` events to update
 * labels, button classes, etc.
 */

import type { OasisClient } from '../client.js';
import type { TurnRequest, EmotionPayload } from '../types.js';
import { TurnDebouncer, type TurnDebouncerOpts } from '../turn-debouncer.js';
import { AudioPlayer } from './audio-player.js';
import { AudioStreamUpload } from './audio-stream.js';
import { BargeInMonitor } from './barge-in-monitor.js';
import { EmotionDetector } from './emotion-detector.js';
import { MicCapture } from './mic-capture.js';
import { EnergyVad } from './energy-vad.js';

export type VoiceHint = { text: string; warn?: boolean };

export type VoiceSessionEvents = {
  /** UI hint string — "listening…", "pausing…", "agent speaking — mic paused", etc. */
  hint: VoiceHint;
  /** Whether the agent is currently producing TTS audio. */
  speakingChange: boolean;
  /** Recoverable errors (mic permission, audioStream ws failure, etc.). */
  error: { kind: 'mic' | 'server-stt' | 'recognition'; message: string };
  /** Fires when VoiceSession is fully started (mic + context + recognizer running). */
  started: void;
  /** Fires when `stop()` has torn everything down. */
  stopped: void;
};

type Handler<T> = (payload: T) => void;

export type VoiceSessionOpts = {
  /** Required — the SSE client whose events the session will react to. */
  client: OasisClient;
  /** Enable SER emotion classification on every utterance. Default true. */
  emotion?: boolean;
  /**
   * Enable server-side streaming STT (WebSocket /audio). When set, the
   * browser SpeechRecognition drives VAD only and the server's Whisper
   * result commits the turn. Default false — browser STT is faster and
   * more accurate than any self-hosted Whisper right now.
   */
  serverStt?: boolean;
  /**
   * Base URL for the /backchannel and /bargein HTTP endpoints. Empty
   * string (the default) means same-origin.
   */
  baseUrl?: string;
  /**
   * Silence (ms) the turn debouncer waits before committing a final
   * utterance. Propagated through to `TurnDebouncer`. Default 1200.
   */
  silenceMs?: number;
  /**
   * Override any debouncer option (complete/incomplete-tail regexes,
   * multipliers). Useful for non-English locales.
   */
  debouncer?: Omit<TurnDebouncerOpts, 'onCommit' | 'onStateChange'>;
  /**
   * Audio-input constraints passed straight to `getUserMedia`. Defaults
   * enable echoCancellation + noiseSuppression + autoGainControl; most
   * callers can leave this alone.
   */
  audioConstraints?: MediaTrackConstraints;
  /**
   * With serverStt, what notices you speaking: the browser's
   * SpeechRecognition ('recognition', the default) or the mic's loudness
   * ('energy', no dependency on the browser's speech service). A
   * recognition that fails for good (network, service not allowed, none
   * in this browser) falls back to 'energy' on its own.
   */
  vad?: 'recognition' | 'energy';
  /**
   * Energy VAD: silence (ms) before the page ends an utterance itself. A server
   * that decides turn ends from the words (hosted Echo) sets this long, as a fallback.
   */
  vadEndSilenceMs?: number;
  /**
   * The agent's volume (0-1) while a possible interruption is checked. Default 0.25.
   * Higher keeps the agent audible when people nearby talk.
   */
  duckLevel?: number;
  /**
   * Who decides that talking over the agent interrupts it: the page, on loudness
   * ('page', default), or the server ('server'), which can check it's the user's voice
   * and not someone nearby. The page then only ducks and asks (POST bargein {verify}).
   */
  bargeInBy?: 'page' | 'server';
  /** Speech recognition language (BCP 47, e.g. "vi-VN"). Default: the browser's. */
  lang?: string;
  /** sendPartial min-word-count gate. Default 3. */
  partialMinWords?: number;
  /** Interim-stability window (ms) before firing the backchannel check. Default 300. */
  interimStableMs?: number;
  /** Min cooldown (ms) between backchannel triggers. Default 4500. */
  backchannelCooldownMs?: number;
};

const DEFAULT_INCOMPLETE_TAIL =
  /(?:^|\s)(?:but|and|or|if|because|cause|cuz|so|when|while|as|though|although|yet|plus|like|with|for|to|of|at|what if|even if|only if|in case|what about|how about|the|a|an|my|your|his|her|their|our)\s*$/i;

type SRInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((ev: SREvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SRResult = {
  isFinal: boolean;
  length: number;
  0: { transcript: string; confidence: number };
  [index: number]: { transcript: string; confidence: number };
};

type SREvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SRResult;
  };
};

export class VoiceSession {
  private readonly client: OasisClient;
  private readonly emotionEnabled: boolean;
  private readonly serverStt: boolean;
  private readonly baseUrl: string;
  private readonly lang: string | undefined;
  private readonly vad: 'recognition' | 'energy';
  private energyVad: EnergyVad | null = null;
  private micSource: AudioNode | null = null;
  private readonly silenceMs: number;
  private readonly vadEndSilenceMs: number | undefined;
  private readonly duckLevel: number;
  private readonly bargeInBy: 'page' | 'server';
  private readonly debouncerOpts: Omit<TurnDebouncerOpts, 'onCommit' | 'onStateChange'>;
  private audioConstraints: MediaTrackConstraints;
  private readonly partialMinWords: number;
  private readonly interimStableMs: number;
  private readonly backchannelCooldownMs: number;

  private readonly listeners: { [K in keyof VoiceSessionEvents]?: Handler<VoiceSessionEvents[K]>[] } = {};
  private readonly clientUnsubs: Array<() => void> = [];

  private voiceOn = false;
  private shouldListen = false;
  private micPausedForTts = false;
  private agentSpeaking = false;
  private currentTurnIdPlaying: string | null = null;
  private readonly abandonedTurns = new Set<string>();
  private readonly completedTurns = new Set<string>();

  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private muted = false;
  private speakerMuted = false;
  private outputDeviceId = '';
  private headset = false;
  private outputGain: GainNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private micCapture: MicCapture | null = null;
  private audioPlayer: AudioPlayer | null = null;
  private bargeInMonitor: BargeInMonitor | null = null;
  private turnDebouncer: TurnDebouncer | null = null;
  private emotionDetector: EmotionDetector | null = null;
  private recognition: SRInstance | null = null;
  private audioStream: AudioStreamUpload | null = null;
  private audioStreamReady = false;

  private speculationId: string | null = null;
  private speculationFiredForBuffer = '';
  private lastInterim = '';
  private interimStableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBackchannelAt = 0;
  private pendingEmotionResult: Promise<{ label: string; confidence: number } | null> | null = null;
  private lastEmotion: { label: string; confidence: number } | null = null;

  constructor(opts: VoiceSessionOpts) {
    this.client = opts.client;
    this.emotionEnabled = opts.emotion ?? true;
    this.serverStt = opts.serverStt ?? false;
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.lang = opts.lang;
    this.vad = opts.vad ?? 'recognition';
    this.silenceMs = opts.silenceMs ?? 1200;
    this.vadEndSilenceMs = opts.vadEndSilenceMs;
    this.duckLevel = opts.duckLevel ?? 0.25;
    this.bargeInBy = opts.bargeInBy ?? 'page';
    this.debouncerOpts = opts.debouncer ?? {};
    this.audioConstraints = opts.audioConstraints ?? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    // 5 instead of the old 3 — a 3-word partial ("currently I'm trying")
    // doesn't give the SLM router enough context to pick the right
    // intent, and a wrong `local/smalltalk` verdict at that point gets
    // committed before the rest of the utterance arrives. The server
    // now also length-divergence-checks on commit, but starting later
    // avoids wasted reasoner work.
    this.partialMinWords = opts.partialMinWords ?? 5;
    this.interimStableMs = opts.interimStableMs ?? 300;
    this.backchannelCooldownMs = opts.backchannelCooldownMs ?? 4500;

    this.wireClientEvents();
  }

  /* ──────────────── Public API ──────────────── */

  /** Returns true iff the SDK thinks browser voice input is supported. */
  static isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition) &&
      !!navigator?.mediaDevices?.getUserMedia;
  }

  get isRunning(): boolean {
    return this.voiceOn;
  }

  get isAgentSpeaking(): boolean {
    return this.agentSpeaking;
  }

  on<E extends keyof VoiceSessionEvents>(event: E, handler: Handler<VoiceSessionEvents[E]>): () => void {
    const bucket = this.listeners as { [K in keyof VoiceSessionEvents]?: Handler<VoiceSessionEvents[K]>[] };
    const arr = (bucket[event] ??= []) as Handler<VoiceSessionEvents[E]>[];
    arr.push(handler);
    return () => {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  /**
   * Start the full voice stack: mic getUserMedia, AudioContext, player,
   * barge-in monitor, turn debouncer, SR, and (optional) server-STT
   * WebSocket. Safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this.voiceOn) return;
    this.voiceOn = true;

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints });
      this.muted = false;
    } catch (err) {
      this.voiceOn = false;
      this.emit('error', { kind: 'mic', message: (err as Error)?.name ?? String(err) });
      return;
    }

    this.audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(this.micStream);

    // Agent audio goes through one output bus so the speaker can be switched off
    // and both directions can be metered for visualisations (see `levels`).
    this.outputGain = this.audioCtx.createGain();
    this.outputGain.gain.value = this.speakerMuted ? 0 : 1;
    this.outputGain.connect(this.audioCtx.destination);
    this.outputAnalyser = this.audioCtx.createAnalyser();
    this.outputAnalyser.fftSize = 512;
    this.outputGain.connect(this.outputAnalyser);
    this.inputAnalyser = this.audioCtx.createAnalyser();
    this.inputAnalyser.fftSize = 512;
    source.connect(this.inputAnalyser);

    if (this.outputDeviceId) await this.applyOutputDevice();

    this.audioPlayer = new AudioPlayer({
      audioContext: this.audioCtx,
      destinationNode: this.outputGain,
      onEnd: () => this.onAudioQueueEmpty(),
    });

    this.micCapture = new MicCapture();
    try {
      await this.micCapture.start({ audioContext: this.audioCtx, source });
    } catch {
      this.micCapture = null;
    }

    if (this.serverStt) await this.connectServerStt(source);

    if (this.emotionEnabled) {
      this.emotionDetector = new EmotionDetector();
      this.emotionDetector.preload().catch(() => {});
    }

    this.bargeInMonitor = new BargeInMonitor({
      // With the server checking the voice, the page can flag talk-over sooner and more
      // readily: someone else (or a cough) is turned down there, not cut off here.
      ...(this.bargeInBy === 'server' ? { confirmMs: 280, baselineMultiplier: 1.35 } : {}),
      isActive: () => this.agentSpeaking,
      onBargeIn: () => (this.bargeInBy === 'server' ? void this.askBargeIn() : this.bargeIn()),
      // A possible interruption lowers the agent's voice until it's confirmed (or not).
      onDuck: (ducked) => this.setOutputLevel(ducked ? this.duckLevel : 1),
    });
    this.bargeInMonitor.setHeadset(this.headset);
    this.bargeInMonitor.start(source);

    this.turnDebouncer = new TurnDebouncer({
      silenceMs: this.silenceMs,
      ...this.debouncerOpts,
      onCommit: (text) => void this.commitUtterance(text),
      onStateChange: (s) => this.onDebouncerState(s),
    });

    this.micSource = source;
    if (this.serverStt && this.audioStreamReady && this.vad === 'energy') this.startEnergyVad();
    else this.startRecognition();

    this.emit('hint', { text: 'say hello…' });
    this.emit('started', undefined);
  }

  /** Tear down the voice stack. Safe to call when already stopped. */
  stop(): void {
    this.voiceOn = false;
    this.shouldListen = false;
    this.turnDebouncer?.cancel();
    this.turnDebouncer = null;
    this.clearInterimStability();
    this.speculationId = null;
    this.speculationFiredForBuffer = '';

    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;
    this.energyVad?.stop();
    this.energyVad = null;
    this.micSource = null;
    this.bargeInMonitor?.stop();
    this.bargeInMonitor = null;
    this.micCapture?.stop();
    this.micCapture = null;
    this.emotionDetector = null;
    this.audioPlayer?.stopAll();
    this.audioPlayer = null;
    this.audioStream?.close();
    this.audioStream = null;
    this.audioStreamReady = false;

    try { this.micStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.micStream = null;
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null;
    this.outputGain = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;

    this.agentSpeaking = false;
    this.micPausedForTts = false;

    this.emit('hint', { text: '' });
    this.emit('speakingChange', false);
    this.emit('stopped', undefined);
  }

  /**
   * User-initiated or monitor-detected barge-in. Stops current TTS,
   * flushes in-flight speculation state, and tells the server to drop
   * both the pre-computed speculation and the current turn.
   */
  bargeIn(tellServer = true): void {
    if (this.currentTurnIdPlaying) {
      this.abandonedTurns.add(this.currentTurnIdPlaying);
      this.completedTurns.add(this.currentTurnIdPlaying);
    }
    this.stopSpeaking();
    this.setOutputLevel(1); // the next reply plays at full volume
    const abortedSpec = this.speculationId;
    this.speculationId = null;
    this.speculationFiredForBuffer = '';
    this.clearInterimStability();
    this.audioStream?.abortUtterance();
    if (tellServer) {
      void fetch(`${this.baseUrl}/bargein`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(abortedSpec ? { speculationId: abortedSpec } : {}),
      }).catch(() => {});
    }
    this.emit('hint', { text: 'interrupted — listening…' });
    this.micPausedForTts = false;
    if (this.voiceOn) this.requestListen();
  }

  private recentPcm16(): string | null {
    const f = this.audioStream?.recentAudio();
    if (!f || !f.length) return null;
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i]! * 32767)));
    let bin = '';
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /**
   * Talking over the agent, with the server deciding (bargeInBy 'server'): it stops
   * the agent only if it's the user's voice; otherwise the agent carries on at full volume.
   */
  private async askBargeIn(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/bargein`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The mic isn't streamed while the agent talks: send what was just said, as
        // 16-bit 16 kHz PCM (about 50 KB for the 1.2 s lookback).
        body: JSON.stringify({ verify: true, ...(this.recentPcm16() ? { pcm: this.recentPcm16() } : {}) }),
      });
      // Couldn't check (server busy, e.g. a 429): the user gets the benefit of the doubt.
      if (!res.ok) {
        if (this.agentSpeaking) this.bargeIn();
        return;
      }
      const r = (await res.json()) as { interrupted?: boolean; other?: boolean };
      if (r.other) this.setOutputLevel(1);
      else if (this.agentSpeaking) this.bargeIn(false);
    } catch {
      if (this.agentSpeaking) this.bargeIn();
    }
  }

  /**
   * Send a text turn. Mirrors what happens when the turn-debouncer
   * commits, so typed input drains the same speculation state as voice.
   */
  async sendText(text: string, opts: { emotion?: EmotionPayload } = {}): Promise<void> {
    const t = text.trim();
    if (!t) return;
    this.turnDebouncer?.cancel();
    this.clearInterimStability();
    const body: TurnRequest = { text: t };
    if (opts.emotion) body.emotion = opts.emotion;
    if (this.speculationId) body.speculationId = this.speculationId;
    this.speculationId = null;
    this.speculationFiredForBuffer = '';
    await this.client.sendTurn(body);
  }

  /* ──────────────── Internal: mic / TTS arbitration ──────────────── */

  private onTtsChunk(p: { turnId: string; audio?: string; sampleRate: number; filler?: boolean }): void {
    if (this.abandonedTurns.has(p.turnId)) return;
    if (!this.audioPlayer) return;
    if (!p.audio) return;
    this.currentTurnIdPlaying = p.turnId;
    if (!this.agentSpeaking) {
      this.agentSpeaking = true;
      this.emit('speakingChange', true);
      if (!this.micPausedForTts && this.voiceOn) {
        this.micPausedForTts = true;
        this.pauseListen();
        this.emit('hint', { text: 'agent speaking — mic paused' });
      }
    }
    this.audioPlayer.playPcm(p.audio, p.sampleRate, {
      turnId: p.turnId,
      filler: p.filler === true,
    });
  }

  private onTurnComplete(p: { turn: { id: string } }): void {
    this.abandonedTurns.delete(p.turn.id);
    this.audioPlayer?.forgetDirectives(p.turn.id);
    this.completedTurns.add(p.turn.id);
    if (this.completedTurns.size > 32) {
      const iter = this.completedTurns.values();
      for (let i = 0; i < 16; i++) this.completedTurns.delete(iter.next().value as string);
    }
    if (this.currentTurnIdPlaying === p.turn.id) this.currentTurnIdPlaying = null;
    // If the last chunk already drained before turn.complete arrived,
    // resume the mic immediately — otherwise it would stay paused
    // forever because onAudioQueueEmpty gated on completedTurns.
    if (this.audioPlayer && this.audioPlayer.activeCount === 0 && this.agentSpeaking) {
      this.agentSpeaking = false;
      this.emit('speakingChange', false);
      this.micPausedForTts = false;
      if (this.voiceOn) {
        this.emit('hint', { text: 'listening…' });
        this.requestListen();
      }
    }
  }

  private onAudioQueueEmpty(): void {
    // Gate mic resume on the SERVER having marked the turn complete.
    // A momentary queue empty between Kokoro sentence chunks is NOT
    // end-of-turn and restarting recognition there lets ambient audio
    // fire recognition.onresult → second /turn → arbiter aborts the
    // in-flight reply via its AbortController. That manifests as
    // "TTS drops in the middle".
    const finishedTurnId = this.currentTurnIdPlaying;
    if (!finishedTurnId || !this.completedTurns.has(finishedTurnId)) return;
    this.agentSpeaking = false;
    this.emit('speakingChange', false);
    setTimeout(() => {
      if (this.audioPlayer && this.audioPlayer.activeCount === 0) {
        this.micPausedForTts = false;
        if (this.voiceOn) {
          this.emit('hint', { text: 'listening…' });
          this.requestListen();
        }
      }
    }, 350);
  }

  private stopSpeaking(): void {
    try { this.audioPlayer?.stopAll(); } catch { /* ignore */ }
    this.agentSpeaking = false;
    this.emit('speakingChange', false);
    if (this.voiceOn) {
      this.micPausedForTts = false;
      this.emit('hint', { text: 'listening…' });
      this.requestListen();
    }
  }

  /** The mic in use (its deviceId), or '' before a call starts. */
  get inputDeviceId(): string {
    return this.micStream?.getAudioTracks()[0]?.getSettings().deviceId ?? '';
  }

  /** The chosen output (an `audiooutput` deviceId), or '' for the system default. */
  get selectedOutputId(): string {
    return this.outputDeviceId;
  }

  /** Whether this browser can send the agent's voice to a chosen output. */
  static get canSelectOutput(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  /**
   * Play the agent's voice on this output ('' = system default). Kept across calls;
   * ignored where the browser can't choose (iOS Safari: the OS routes audio).
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    await this.applyOutputDevice();
  }

  private async applyOutputDevice(): Promise<void> {
    const ctx = this.audioCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try { await ctx.setSinkId(this.outputDeviceId); } catch { /* device gone: stays on the current one */ }
  }

  /**
   * Use this microphone ('' = system default). A running call switches mics by
   * restarting the voice stack (`stopped` then `started` fire).
   */
  async setInputDevice(deviceId: string): Promise<void> {
    const { deviceId: _old, ...rest } = this.audioConstraints;
    this.audioConstraints = deviceId ? { ...rest, deviceId: { exact: deviceId } } : rest;
    if (!this.voiceOn) return;
    this.stop();
    await this.start();
  }

  /**
   * Whether audio is on a headset (Bluetooth or wired). The agent's voice doesn't
   * bleed into a headset mic, so interrupting it can be more sensitive.
   */
  setHeadset(on: boolean): void {
    this.headset = on;
    this.bargeInMonitor?.setHeadset(on);
  }

  /** Whether the agent's voice is switched off (kept across calls). */
  get isSpeakerMuted(): boolean {
    return this.speakerMuted;
  }

  /** Switch the agent's voice off or on. The call carries on; you just don't hear it. */
  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    this.setOutputLevel(1);
  }

  /** The agent's voice at `level` (0..1) of normal, unless the speaker is off. */
  private setOutputLevel(level: number): void {
    if (this.outputGain && this.audioCtx) this.outputGain.gain.setTargetAtTime(this.speakerMuted ? 0 : level, this.audioCtx.currentTime, 0.03);
  }

  /**
   * Current loudness (RMS, roughly 0..1) of the mic and of the agent's voice, for
   * meters and visualisations. Both are 0 when no call is running. Cheap enough to
   * read every animation frame.
   */
  get levels(): { input: number; output: number } {
    return { input: this.rms(this.inputAnalyser), output: this.rms(this.outputAnalyser) };
  }

  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    if (!this.levelBuf || this.levelBuf.length !== analyser.fftSize) this.levelBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.sqrt(sum / this.levelBuf.length);
  }

  /** Whether the user has muted their mic for this call. */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Mute or unmute the mic during a call: the mic tracks go silent (so neither the
   * page nor a listening server hears anything) and speech recognition stops.
   * A new call always starts unmuted.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    try { this.micStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; }); } catch { /* ignore */ }
    if (muted) this.pauseListen();
    else if (this.voiceOn) this.requestListen();
  }

  private requestListen(): void {
    this.shouldListen = true;
    // Muted: stay deaf even when the agent finishes speaking and listening would resume.
    if (this.muted || !this.recognition) return;
    try { this.recognition.start(); } catch { /* already started */ }
  }

  private pauseListen(): void {
    this.shouldListen = false;
    if (!this.recognition) return;
    try { this.recognition.stop(); } catch { /* already stopped */ }
  }

  /* ──────────────── Internal: recognition + debouncer ──────────────── */

  private startEnergyVad(): void {
    if (this.energyVad || !this.audioCtx || !this.micSource) return;
    this.energyVad = new EnergyVad({
      ...(this.vadEndSilenceMs ? { endSilenceMs: this.vadEndSilenceMs } : {}),
      isListening: () => !this.micPausedForTts && !this.agentSpeaking,
      onStart: () => {
        if (!this.audioStream) return;
        this.speculationId = newSpeculationId();
        this.audioStream.startUtterance(this.speculationId);
        this.emit('hint', { text: 'listening…' });
      },
      onEnd: () => {
        this.audioStream?.endUtterance();
        this.emit('hint', { text: 'thinking…' });
      },
      // Steady background noise, not speech: drop it rather than make a turn of it.
      onCancel: () => {
        this.audioStream?.abortUtterance();
        this.speculationId = null;
        this.emit('hint', { text: 'listening…' });
      },
    });
    this.energyVad.start(this.audioCtx, this.micSource);
  }

  private startRecognition(): void {
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SRInstance }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SRInstance }).webkitSpeechRecognition;
    if (!Ctor) {
      if (this.serverStt && this.audioStreamReady) this.startEnergyVad();
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang || navigator.language || 'en-US';
    rec.maxAlternatives = 4;
    rec.onresult = (ev) => this.onSrResult(ev);
    rec.onerror = (ev) => {
      // These don't recover by retrying: notice speech from loudness instead.
      if (['network', 'service-not-allowed', 'language-not-supported'].includes(ev.error) && this.serverStt && this.audioStreamReady) {
        this.recognition = null;
        rec.onend = null;
        try { rec.stop(); } catch { /* ignore */ }
        this.startEnergyVad();
        return;
      }
      this.emit('error', { kind: 'recognition', message: ev.error });
    };
    rec.onend = () => {
      if (this.voiceOn && this.shouldListen && !this.muted) {
        try { rec.start(); } catch { /* ignore */ }
      }
    };
    this.recognition = rec;
    this.requestListen();
  }

  private onSrResult(ev: SREvent): void {
    if (this.micPausedForTts || this.agentSpeaking) return;
    let interim = '';
    let finalText = '';
    let finalConf = 1;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i]!;
      if (r.isFinal) {
        let best = r[0]!;
        for (let j = 1; j < r.length; j++) {
          if ((r[j]!.confidence || 0) > (best.confidence || 0)) best = r[j]!;
        }
        finalText += best.transcript;
        finalConf = Math.min(finalConf, best.confidence || 0);
      } else {
        interim += r[0]!.transcript;
      }
    }

    // Server-STT path: recognition is a VAD only — text goes to
    // audioStream, not the debouncer.
    if (this.audioStreamReady && this.audioStream) {
      if ((interim.trim() || finalText.trim()) && !this.speculationId) {
        this.speculationId = newSpeculationId();
        this.audioStream.startUtterance(this.speculationId);
      }
      if (finalText.trim()) this.audioStream.endUtterance();
      return;
    }

    if (interim.trim()) {
      this.turnDebouncer?.onInterim(interim);
      if (interim !== this.lastInterim) {
        this.lastInterim = interim;
        const trimmed = interim.trim();
        if (
          trimmed.split(/\s+/).length >= this.partialMinWords &&
          trimmed !== this.speculationFiredForBuffer
        ) {
          this.speculationFiredForBuffer = trimmed;
          if (!this.speculationId) this.speculationId = newSpeculationId();
          this.client.sendPartial({ speculationId: this.speculationId, text: trimmed }).catch(() => {});
        }
        if (this.interimStableTimer) clearTimeout(this.interimStableTimer);
        this.interimStableTimer = setTimeout(() => {
          this.interimStableTimer = null;
          const stable = this.lastInterim.trim();
          if (!stable || stable.split(/\s+/).length < this.partialMinWords) return;
          void this.maybeFireBackchannel(stable);
        }, this.interimStableMs);
      }
    }
    if (finalText.trim()) {
      this.clearInterimStability();
      this.turnDebouncer?.onFinal(finalText);
      if (finalConf > 0 && finalConf < 0.55) {
        this.emit('hint', { text: 'low-confidence transcript', warn: true });
      }
      if (this.emotionEnabled && this.emotionDetector && this.micCapture) {
        const pcm = this.micCapture.snapshot(5);
        if (pcm) {
          this.pendingEmotionResult = this.emotionDetector
            .classify(pcm, this.micCapture.sampleRate, { timeoutMs: 1500 })
            .catch(() => null);
        }
      }
    }
  }

  private onDebouncerState(s: { kind: 'idle' | 'listening' | 'pausing'; preview?: string; buffer?: string }): void {
    if (s.kind === 'listening') {
      this.emit('hint', { text: 'listening…' });
      return;
    }
    if (s.kind === 'pausing') {
      this.emit('hint', { text: 'pausing…' });
      const buffer = s.buffer ?? '';
      if (
        buffer &&
        buffer !== this.speculationFiredForBuffer &&
        buffer.split(/\s+/).length >= this.partialMinWords
      ) {
        this.speculationFiredForBuffer = buffer;
        if (!this.speculationId) this.speculationId = newSpeculationId();
        this.client.sendPartial({ speculationId: this.speculationId, text: buffer }).catch(() => {});
      }
    }
  }

  private async commitUtterance(text: string): Promise<void> {
    let emotion: { label: string; confidence: number } | undefined;
    try {
      const detected = await (this.pendingEmotionResult ?? Promise.resolve(null));
      this.pendingEmotionResult = null;
      if (detected) {
        emotion = { label: detected.label, confidence: detected.confidence };
        this.lastEmotion = emotion;
        this.emit('hint', {
          text: `sent · ${detected.label.toLowerCase()} ${Math.round(detected.confidence * 100)}%`,
        });
      }
    } catch { /* ignore */ }
    await this.sendText(text, emotion ? { emotion } : {});
  }

  private clearInterimStability(): void {
    if (this.interimStableTimer) {
      clearTimeout(this.interimStableTimer);
      this.interimStableTimer = null;
    }
    this.lastInterim = '';
  }

  private async maybeFireBackchannel(tail: string): Promise<void> {
    if (!this.voiceOn || this.agentSpeaking || this.micPausedForTts) return;
    if (!tail || !DEFAULT_INCOMPLETE_TAIL.test(tail)) return;
    const now = performance.now();
    if (now - this.lastBackchannelAt < this.backchannelCooldownMs) return;
    this.lastBackchannelAt = now;
    try {
      const res = await fetch(`${this.baseUrl}/backchannel`).then((r) => r.json());
      if (!res?.ready || !res.audio || !this.audioPlayer) return;
      this.audioPlayer.playPcm(res.audio, res.sampleRate, {
        filler: true,
        gain: 0.8,
      });
    } catch { /* non-fatal */ }
  }

  /* ──────────────── Internal: server-STT over WS ──────────────── */

  private async connectServerStt(source: AudioNode): Promise<void> {
    if (!this.audioCtx) return;
    // The audio socket lives beside the other endpoints (baseUrl may be a
    // path like /a/assistant, or another origin).
    const audioUrl = new URL(`${this.baseUrl}/audio`, location.href);
    audioUrl.protocol = audioUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const stream = new AudioStreamUpload({ audioContext: this.audioCtx, source, url: audioUrl.toString() });
    stream.on('partial', (text) => this.emit('hint', { text: 'listening…' }));
    stream.on('final', (payload) => {
      const t = (payload.text ?? '').trim();
      if (!t) return;
      const commitSpecId = payload.speculationId ?? this.speculationId ?? null;
      this.speculationId = null;
      this.speculationFiredForBuffer = '';
      const body: TurnRequest = { text: t };
      if (commitSpecId) body.speculationId = commitSpecId;
      this.client.sendTurn(body).catch(() => {});
    });
    stream.on('error', (err) => {
      this.audioStreamReady = false;
      this.emit('error', { kind: 'server-stt', message: String(err) });
    });
    stream.on('close', () => { this.audioStreamReady = false; });
    this.audioStream = stream;
    try {
      await stream.connect();
      this.audioStreamReady = true;
    } catch (err) {
      this.audioStream = null;
      this.audioStreamReady = false;
      this.emit('error', { kind: 'server-stt', message: (err as Error)?.message ?? String(err) });
    }
  }

  /* ──────────────── Internal: client event wiring ──────────────── */

  private wireClientEvents(): void {
    this.clientUnsubs.push(
      this.client.on('tts.chunk', (p) => this.onTtsChunk(p as never)),
      this.client.on('turn.complete', (p) => this.onTurnComplete(p as never)),
      this.client.on('bargein', (p) => {
        const interruptedTurnId = (p as { interruptedTurnId?: string }).interruptedTurnId;
        if (interruptedTurnId) {
          this.abandonedTurns.add(interruptedTurnId);
          this.completedTurns.add(interruptedTurnId);
        }
        this.stopSpeaking();
      }),
      this.client.on('tool.use', (p) => {
        const name = (p as { name: string }).name;
        // Surface "calling web_search..." in the voice hint so the user
        // sees the agent is doing real work, not stalling. We strip the
        // server-name prefix (e.g. oasis_cognition__) for readability.
        const short = name.split('__').pop() ?? name;
        this.emit('hint', { text: `calling ${short}…` });
      }),
      this.client.on('tool.result', (p) => {
        const cast = p as { name: string; ok: boolean; latencyMs: number };
        const short = cast.name.split('__').pop() ?? cast.name;
        this.emit('hint', {
          text: cast.ok
            ? `${short} returned in ${cast.latencyMs}ms`
            : `${short} failed`,
          ...(cast.ok ? {} : { warn: true }),
        });
      }),
      this.client.on('emotion.directives', (p) => {
        const cast = p as { turnId: string; directives: Parameters<AudioPlayer['setDirectives']>[1] };
        this.audioPlayer?.setDirectives(cast.turnId, cast.directives);
      }),
    );
  }

  private emit<E extends keyof VoiceSessionEvents>(event: E, payload: VoiceSessionEvents[E]): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const h of (arr as Handler<VoiceSessionEvents[E]>[]).slice()) {
      try { h(payload); } catch { /* swallow */ }
    }
  }
}

function newSpeculationId(): string {
  return 'sp-' + Math.random().toString(36).slice(2, 10);
}
