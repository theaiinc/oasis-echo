import type {
  EventHandler,
  EventMap,
  EventName,
} from './events.js';
import { openSse, type EventSourceLike, type SseHandle } from './sse.js';
import type {
  CorrectionsState,
  TurnRequest,
} from './types.js';

export type OasisClientOpts = {
  /** Base URL of the oasis-echo server, e.g. `http://localhost:3001`. No trailing slash. */
  baseUrl: string;
  /** Override `fetch` for testing or bespoke transport. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Optional EventSource constructor override — useful in Node via the `eventsource` npm package. */
  eventSourceCtor?: new (url: string, init?: unknown) => EventSourceLike;
  /** Automatically open the SSE stream on construction. Default `false` — caller calls `connect()`. */
  autoConnect?: boolean;
};

type Listeners = {
  [E in EventName]?: Array<EventHandler<E>>;
};

/**
 * Top-level SDK client for the oasis-echo server.
 *
 * One instance per session. Same API in browsers and Node — only
 * difference is the SSE implementation (native EventSource vs
 * streaming fetch fallback).
 *
 *   const client = new OasisClient({ baseUrl: 'http://localhost:3001' });
 *   client.on('tts.chunk', (e) => audio.playPcm(e.audio, e.sampleRate, { turnId: e.turnId }));
 *   client.on('emotion.directives', (e) => audio.setDirectives(e.turnId, e.directives));
 *   client.connect();
 *   await client.sendTurn({ text: 'hello there' });
 */
export class OasisClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly eventSourceCtor?: new (url: string, init?: unknown) => EventSourceLike;
  private readonly listeners: Listeners = {};
  private sse: SseHandle | null = null;
  private connectState: 'idle' | 'open' | 'closed' = 'idle';

  constructor(opts: OasisClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Bind to globalThis — storing the native `fetch` on a plain object
    // and calling it as `this.fetchFn(...)` detaches its `this` context
    // and throws "Illegal invocation" in browsers.
    this.fetchFn =
      opts.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    if (opts.eventSourceCtor) this.eventSourceCtor = opts.eventSourceCtor;
    if (opts.autoConnect) this.connect();
  }

  /* ──────────────── Event subscription ──────────────── */

  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    const arr = (this.listeners[event] ??= []) as EventHandler<E>[];
    arr.push(handler);
    return () => this.off(event, handler);
  }

  off<E extends EventName>(event: E, handler: EventHandler<E>): void {
    const arr = this.listeners[event] as EventHandler<E>[] | undefined;
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }

  private emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const arr = this.listeners[event] as EventHandler<E>[] | undefined;
    if (!arr) return;
    for (const h of arr.slice()) {
      try { h(payload); } catch {
        // swallow — one misbehaving handler mustn't break the stream
      }
    }
  }

  /* ──────────────── SSE lifecycle ──────────────── */

  /** Open the server-sent event stream. Idempotent. */
  connect(): void {
    if (this.connectState === 'open') return;
    this.connectState = 'open';
    const sseOpts = {
      url: `${this.baseUrl}/events`,
      onMessage: (msg: { event: string; data: string }) => {
        if (!msg.data) return;
        let payload: unknown;
        try { payload = JSON.parse(msg.data); } catch { return; }
        this.emit(msg.event as EventName, payload as EventMap[EventName]);
      },
      onError: (err: unknown) => {
        this.emit('error', {
          source: 'sse',
          error: String((err as Error)?.message ?? err),
          atMs: Date.now(),
        });
      },
      ...(this.eventSourceCtor ? { eventSourceCtor: this.eventSourceCtor } : {}),
      ...(this.fetchFn !== fetch ? { fetch: this.fetchFn } : {}),
    };
    this.sse = openSse(sseOpts);
  }

  /** Close the SSE stream. After this, reconnection requires a fresh `connect()`. */
  close(): void {
    this.sse?.close();
    this.sse = null;
    this.connectState = 'closed';
  }

  /* ──────────────── REST endpoints ──────────────── */

  /** Submit a turn. Returns `{ accepted: true }` on success; all downstream
   *  activity (transcription echo, tts.chunk, emotion.directives, turn.complete)
   *  arrives via the SSE stream. */
  async sendTurn(req: TurnRequest): Promise<{ accepted: true }> {
    const res = await this.fetchFn(`${this.baseUrl}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`sendTurn ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{ accepted: true }>;
  }

  /** Teach the STT pipeline a correction. Server classifies the diff: single-
   *  token substitution → word rule, multi-word → canonical phrase. */
  async sendCorrection(input: { original: string; corrected: string }): Promise<{
    accepted: true;
    wordPairs: Array<{ wrong: string; right: string }>;
    addedAsPhrase: boolean;
  }> {
    const res = await this.fetchFn(`${this.baseUrl}/correction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`sendCorrection ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{
      accepted: true;
      wordPairs: Array<{ wrong: string; right: string }>;
      addedAsPhrase: boolean;
    }>;
  }

  /** Read the current learned-correction state. */
  async getCorrections(): Promise<CorrectionsState> {
    const res = await this.fetchFn(`${this.baseUrl}/corrections`);
    if (!res.ok) throw new Error(`getCorrections ${res.status}`);
    return res.json() as Promise<CorrectionsState>;
  }

  /** Interrupt the current in-flight agent reply. */
  async bargeIn(): Promise<{ interrupted: boolean }> {
    const res = await this.fetchFn(`${this.baseUrl}/bargein`, { method: 'POST' });
    if (!res.ok) throw new Error(`bargeIn ${res.status}`);
    return res.json() as Promise<{ interrupted: boolean }>;
  }

  /** Fetch a random pre-synthesized backchannel clip (base64 PCM). */
  async getBackchannel(): Promise<
    | { ready: false }
    | { ready: true; text: string; audio: string; sampleRate: number }
  > {
    const res = await this.fetchFn(`${this.baseUrl}/backchannel`);
    if (!res.ok) return { ready: false };
    return res.json() as Promise<{ ready: true; text: string; audio: string; sampleRate: number }>;
  }

  /** Fetch the server's config snapshot (backend, model, tts voice, session id). */
  async getConfig(): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.baseUrl}/config`);
    return res.json() as Promise<Record<string, unknown>>;
  }
}
