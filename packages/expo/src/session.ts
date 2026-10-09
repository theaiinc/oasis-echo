import type { EchoAdapters, RecognizerEvent } from './adapters.js';
import { EchoConnection, EchoRefused } from './connection.js';
import { base64ToBytes } from './pcm.js';
import type { ActionRequest, EchoEvent, Refusal, TtsChunkEvent } from './protocol.js';
import { chooseVoice } from './voices.js';
import { pcm16ToWav, pcmDurationMs } from './wav.js';

/**
 * A voice call with an oasis-echo server from a phone.
 *
 * Listening is the phone's own speech recognition: what the user says goes to the
 * server as a turn. The agent's reply is spoken with the phone's own voice
 * (`voice: 'device'`, from each chunk's text) or the server's (`'server'`, its PCM).
 * Same rules as the web VoiceSession: the mic is off while the agent speaks (so it
 * can't hear itself), and comes back only once that reply is complete and played.
 *
 *   const s = new EchoVoiceSession({ baseUrl: 'https://echo.example/a/assistant',
 *     adapters: createExpoAdapters(), headers: async () => ({ authorization: `Bearer ${token}` }) });
 *   s.on('userText', ({ text, final }) => …);
 *   await s.start();
 */

export type VoiceMode = 'device' | 'server';
export type CallState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type EchoVoiceSessionOpts = {
  /** The server (or a hosted agent's base, e.g. https://echo.example/a/assistant). */
  baseUrl: string;
  adapters: EchoAdapters;
  /** Who speaks the agent's words. Default 'device'. */
  voice?: VoiceMode;
  /** BCP 47, e.g. "vi-VN" or "en-US". Default "en-US". */
  lang?: string;
  /** Headers for every request (auth). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Things the app can do for the agent (servers with client actions, e.g. hosted Echo): offered to the server with
   * hello whenever the stream opens (call refreshActions() when they change), and run when the agent asks.
   */
  actions?: {
    names(): string[];
    context?(): unknown;
    run(req: ActionRequest): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  };
  /** Platform overrides for the connection (tests, other runtimes). */
  connection?: Pick<ConstructorParameters<typeof EchoConnection>[0], 'XMLHttpRequest' | 'WebSocket' | 'fetch'>;
  /** Speaking rate per language, e.g. { vi: 1.15 }. Default 1. */
  rate?: Record<string, number>;
  /** Ask the recognizer to stay on the device (Android 13+, iOS when supported). Default false. */
  onDevice?: boolean;
  /** Quiet after the last words before the turn is sent, when the recognizer doesn't end it itself. Default 1200. */
  endSilenceMs?: number;
  /** Server voice: gather this much audio per clip (fewer gaps between clips). Default 1200. */
  clipMs?: number;
};

type SessionEvents = {
  started: void;
  stopped: void;
  state: CallState;
  /** What the user is saying (partial) and said (final, sent as a turn). */
  userText: { text: string; final: boolean };
  /** What the agent is saying, a line at a time. */
  agentText: { turnId: string; text: string; filler: boolean };
  error: { kind: 'permission' | 'recognition' | 'network' | 'speech'; message: string };
  /** The server refused the app (signed out, not allowed, unavailable): the call stops; say `message` if given. */
  refused: Refusal;
  /** Every server event, for anything the session doesn't handle itself (e.g. a server's own events). */
  event: EchoEvent;
};
type Handler<K extends keyof SessionEvents> = (payload: SessionEvents[K]) => void;

/** Recognizer errors that just mean "nothing was said": listen again. */
const QUIET_ERRORS = new Set(['no-speech', 'speech-timeout', 'aborted']);

export class EchoVoiceSession {
  readonly connection: EchoConnection;
  private readonly opts: EchoVoiceSessionOpts;
  private readonly handlers: { [K in keyof SessionEvents]?: Array<Handler<K>> } = {};
  private voiceMode: VoiceMode;
  private lang: string;
  private voiceId: string | undefined;
  private voiceFor: string | null = null;

  private on_ = false;
  private listening = false;
  private agentSpeaking = false;
  private state_: CallState = 'idle';
  private unsubs: Array<() => void> = [];

  /** The utterance being heard: last partial, and the timer that ends it after quiet. */
  private heard = '';
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartBackoff = 200;

  /** Agent speech: lines waiting for the device voice, clips for the server's. */
  private readonly lines: Array<{ turnId: string; text: string }> = [];
  private speakingLine = false;
  private clipsPlaying = 0;
  private pcm: { turnId: string; chunks: Uint8Array[]; bytes: number; rate: number } | null = null;
  private currentTurn: string | null = null;
  private readonly completed = new Set<string>();
  private readonly abandoned = new Set<string>();
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: EchoVoiceSessionOpts) {
    this.opts = opts;
    this.voiceMode = opts.voice ?? 'device';
    this.lang = opts.lang ?? 'en-US';
    this.connection = new EchoConnection({
      url: opts.baseUrl,
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...opts.connection,
      onEvent: (e) => this.onEvent(e),
      onStream: (state, refusal) => {
        if (refusal) return this.refused(refusal);
        if (state === 'open') void this.sendHello();
      },
    });
  }

  on<K extends keyof SessionEvents>(event: K, handler: Handler<K>): () => void {
    const list = (this.handlers[event] ??= []) as Array<Handler<K>>;
    list.push(handler);
    return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
  }

  private emit<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): void {
    for (const h of (this.handlers[event] ?? []).slice() as Array<Handler<K>>) {
      try { h(payload); } catch { /* a handler's bug mustn't break the call */ }
    }
  }

  get state(): CallState {
    return this.state_;
  }

  get isRunning(): boolean {
    return this.on_;
  }

  get isAgentSpeaking(): boolean {
    return this.agentSpeaking;
  }

  private setState(s: CallState): void {
    if (s === this.state_) return;
    this.state_ = s;
    this.emit('state', s);
  }

  /** Ask for permissions, open the event stream and start listening. False when the mic was refused. */
  async start(): Promise<boolean> {
    if (this.on_) return true;
    if (!(await this.opts.adapters.recognizer.requestPermissions())) {
      this.emit('error', { kind: 'permission', message: 'Allow the microphone and speech recognition to talk.' });
      return false;
    }
    this.on_ = true;
    this.unsubs.push(this.opts.adapters.recognizer.listen((e) => this.onRecognizer(e)));
    this.connection.open().catch((err) => {
      if (!(err instanceof EchoRefused)) this.emit('error', { kind: 'network', message: String((err as Error)?.message ?? err) });
    });
    this.emit('started', undefined);
    this.listen();
    return true;
  }

  /** Hang up: stop listening and speaking, close the event stream. */
  stop(): void {
    if (!this.on_) return;
    this.on_ = false;
    for (const u of this.unsubs.splice(0)) u();
    this.clearTimers();
    this.opts.adapters.recognizer.abort();
    this.listening = false;
    this.stopSpeech();
    this.agentSpeaking = false;
    this.connection.close();
    this.sentHello = null;
    this.setState('idle');
    this.emit('stopped', undefined);
  }

  /** Change the call's language (listening and the device voice), e.g. after the user asked for another. */
  setLang(lang: string): void {
    if (lang === this.lang) return;
    this.lang = lang;
    this.voiceFor = null;
    if (this.listening) {
      this.opts.adapters.recognizer.abort();
      this.listening = false;
      this.listen();
    }
  }

  /** Change who speaks the agent's words, from the next line on (e.g. a plan's custom voice ran out). */
  setVoice(mode: VoiceMode): void {
    this.voiceMode = mode;
  }

  /** The user interrupts (a button, a tap): stop the agent and listen. */
  interrupt(): void {
    if (!this.agentSpeaking) return;
    if (this.currentTurn) this.abandoned.add(this.currentTurn);
    void this.connection.bargeIn().catch(() => undefined);
    this.silence();
  }

  /** Send typed text as a turn. */
  async sendText(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (this.agentSpeaking) this.interrupt();
    this.emit('userText', { text: t, final: true });
    this.setState('thinking');
    await this.connection.turn(t);
  }

  /** What the app can do changed (e.g. a route started): tell the server, if connected. */
  refreshActions(): void {
    void this.sendHello();
  }

  /* ---------------- the server ---------------- */

  private sentHello: string | null = null;

  private async sendHello(): Promise<void> {
    const a = this.opts.actions;
    if (!a || this.connection.state !== 'open') return;
    const body = { actions: a.names(), context: a.context?.() };
    const key = JSON.stringify(body);
    if (key === this.sentHello) return;
    this.sentHello = key;
    try {
      await this.connection.hello(body);
    } catch (err) {
      this.sentHello = null;
      if (err instanceof EchoRefused) this.refused(err.refusal);
    }
  }

  private onEvent(e: EchoEvent): void {
    if (!this.on_) return;
    this.emit('event', e);
    switch (e.type) {
      case 'tts.chunk': return this.onChunk(e);
      case 'turn.complete': this.completed.add(e.turnId); return this.maybeResume();
      case 'bargein': if (e.interruptedTurnId) this.abandoned.add(e.interruptedTurnId); return this.silence();
      case 'action.request': {
        const a = this.opts.actions;
        const req = { id: e.id, name: e.name, args: e.args };
        void (a ? a.run(req).catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) })) : Promise.resolve({ ok: false, error: 'unsupported' }))
          .then((r) => this.connection.actionResult({ id: e.id, ...r }))
          .catch(() => undefined);
        return;
      }
      default:
    }
  }

  private refused(r: Refusal): void {
    this.emit('refused', r);
    this.stop();
  }

  /* ---------------- listening ---------------- */

  private listen(): void {
    if (!this.on_ || this.listening || this.agentSpeaking) return;
    this.listening = true;
    this.heard = '';
    this.opts.adapters.recognizer.start({ lang: this.lang, interimResults: true, continuous: true, ...(this.opts.onDevice ? { onDevice: true } : {}) });
    this.setState('listening');
  }

  private onRecognizer(e: RecognizerEvent): void {
    if (!this.on_) return;
    if (e.type === 'result') {
      const text = e.text.trim();
      if (!text) return;
      this.restartBackoff = 200;
      if (e.isFinal) return this.commit(text);
      this.heard = text;
      this.emit('userText', { text, final: false });
      // Some recognizers (iOS before 18 in continuous mode) never end an utterance by
      // themselves: after a quiet spell, stop to get the final result.
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        if (this.listening && this.heard) this.opts.adapters.recognizer.stop();
      }, this.opts.endSilenceMs ?? 1200);
      return;
    }
    if (e.type === 'end') {
      this.listening = false;
      // An utterance cut short by the recognizer ending (Android does after silence): send what was heard.
      if (this.heard) this.commit(this.heard);
      this.scheduleRestart();
      return;
    }
    if (e.type === 'error') {
      if (QUIET_ERRORS.has(e.error)) return; // 'end' follows and restarts listening
      if (e.error === 'not-allowed') {
        this.emit('error', { kind: 'permission', message: e.message ?? 'Microphone or speech recognition not allowed.' });
        return this.stop();
      }
      this.emit('error', { kind: 'recognition', message: e.message ?? e.error });
      this.restartBackoff = Math.min(this.restartBackoff * 2, 5_000);
    }
  }

  /** The user finished saying something: send it as a turn. */
  private commit(text: string): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.heard = '';
    this.emit('userText', { text, final: true });
    this.setState('thinking');
    this.connection.turn(text).catch((err) => {
      if (err instanceof EchoRefused) this.refused(err.refusal);
      else this.emit('error', { kind: 'network', message: String((err as Error)?.message ?? err) });
    });
  }

  /** Listen again soon after the recognizer stopped (it does after each utterance or a silence). */
  private scheduleRestart(): void {
    if (this.restartTimer || !this.on_ || this.agentSpeaking) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.listen();
    }, this.restartBackoff);
  }

  /* ---------------- speaking ---------------- */

  private onChunk(p: TtsChunkEvent): void {
    if (!this.on_ || this.abandoned.has(p.turnId)) return;
    const text = p.text?.trim() ?? '';
    const server = this.voiceMode === 'server' && !!p.audio && !!this.opts.adapters.player;
    if (!server && !text) return; // nothing to say (a final marker with no words)
    if (!server && !this.opts.adapters.speech) return;
    this.beginSpeaking(p.turnId);
    if (text) this.emit('agentText', { turnId: p.turnId, text, filler: p.filler });
    if (server) {
      const bytes = base64ToBytes(p.audio!);
      if (this.pcm && (this.pcm.turnId !== p.turnId || this.pcm.rate !== p.sampleRate)) this.flushClip();
      this.pcm ??= { turnId: p.turnId, chunks: [], bytes: 0, rate: p.sampleRate };
      this.pcm.chunks.push(bytes);
      this.pcm.bytes += bytes.length;
      if (p.final || pcmDurationMs(this.pcm.bytes, this.pcm.rate) >= (this.opts.clipMs ?? 1200)) this.flushClip();
    } else {
      this.lines.push({ turnId: p.turnId, text });
      void this.nextLine();
    }
  }

  private beginSpeaking(turnId: string): void {
    this.currentTurn = turnId;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null; }
    if (this.agentSpeaking) return;
    this.agentSpeaking = true;
    // The mic is off while the agent talks, so it doesn't hear (and answer) itself.
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.listening) { this.opts.adapters.recognizer.abort(); this.listening = false; }
    this.heard = '';
    this.setState('speaking');
  }

  private async nextLine(): Promise<void> {
    if (this.speakingLine) return;
    const line = this.lines.shift();
    if (!line) return this.maybeResume();
    if (this.abandoned.has(line.turnId)) return this.nextLine();
    this.speakingLine = true;
    const speech = this.opts.adapters.speech!;
    if (this.voiceFor !== this.lang) {
      this.voiceFor = this.lang;
      this.voiceId = chooseVoice(await speech.voices().catch(() => []), this.lang)?.identifier;
    }
    const done = () => {
      this.speakingLine = false;
      void this.nextLine();
    };
    const base = this.lang.split('-')[0]!;
    speech.speak(line.text, {
      language: this.lang,
      ...(this.voiceId ? { voice: this.voiceId } : {}),
      rate: this.opts.rate?.[base] ?? this.opts.rate?.[this.lang] ?? 1,
      onDone: done,
      onError: (err) => {
        this.emit('error', { kind: 'speech', message: String((err as Error)?.message ?? err) });
        done();
      },
    });
  }

  private flushClip(): void {
    const clip = this.pcm;
    this.pcm = null;
    if (!clip || !clip.bytes || this.abandoned.has(clip.turnId)) return this.maybeResume();
    this.clipsPlaying++;
    this.opts.adapters.player!.play(pcm16ToWav(clip.chunks, clip.rate), () => {
      this.clipsPlaying = Math.max(0, this.clipsPlaying - 1);
      this.maybeResume();
    });
  }

  /**
   * Back to listening once the agent is done: nothing queued or playing, and the
   * reply's turn.complete has arrived (between sentences the queue is briefly empty,
   * and listening then would catch the next sentence). If a server never sends
   * turn.complete, listen anyway after a few quiet seconds.
   */
  private maybeResume(): void {
    if (!this.agentSpeaking || this.speakingLine || this.lines.length || this.clipsPlaying || this.pcm) return;
    const turn = this.currentTurn;
    const finished = !turn || this.completed.has(turn) || this.abandoned.has(turn);
    if (!finished) {
      if (!this.fallbackTimer) this.fallbackTimer = setTimeout(() => { this.fallbackTimer = null; this.completed.add(turn); this.maybeResume(); }, 3_000);
      return;
    }
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
    if (this.resumeTimer) return;
    // A short gap so the tail of the reply (and the room's echo of it) isn't heard.
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.agentSpeaking || this.speakingLine || this.lines.length || this.clipsPlaying) return;
      this.agentSpeaking = false;
      this.listen();
    }, 350);
  }

  /** Stop the agent's speech now (interrupted) and listen. */
  private silence(): void {
    this.stopSpeech();
    if (this.currentTurn) this.completed.add(this.currentTurn);
    this.agentSpeaking = false;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null; }
    this.listen();
  }

  private stopSpeech(): void {
    this.lines.length = 0;
    this.pcm = null;
    this.speakingLine = false;
    this.clipsPlaying = 0;
    this.opts.adapters.speech?.stop();
    this.opts.adapters.player?.stop();
  }

  private clearTimers(): void {
    for (const t of [this.silenceTimer, this.restartTimer, this.resumeTimer, this.fallbackTimer]) if (t) clearTimeout(t);
    this.silenceTimer = this.restartTimer = this.resumeTimer = this.fallbackTimer = null;
  }
}
