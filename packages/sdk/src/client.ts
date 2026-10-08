import type {
  EventHandler,
  EventMap,
  EventName,
} from './events.js';
import { openSse, type EventSourceLike, type SseHandle } from './sse.js';
import type {
  CorrectionsState,
  PartialRequest,
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
  /**
   * Headers for every request (e.g. `Authorization` for a native app, which can't
   * share a browser's cookies). Called per request, so a refreshed token is picked up.
   * Not applied to a browser `EventSource`, which can't send headers.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Server event names beyond the built-in ones, delivered through `on()` like the rest. */
  extraEvents?: string[];
  /** Fetch-based SSE only: reopen the stream this long after it ends (or the server's `retry:`). */
  reconnectMs?: number;
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
  private readonly extraEvents?: string[];
  private readonly reconnectMs?: number;

  constructor(opts: OasisClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Bind to globalThis — storing the native `fetch` on a plain object
    // and calling it as `this.fetchFn(...)` detaches its `this` context
    // and throws "Illegal invocation" in browsers.
    const base =
      opts.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const headers = opts.headers;
    this.fetchFn = headers
      ? (async (input: RequestInfo | URL, init?: RequestInit) =>
          base(input, { ...init, headers: { ...(await headers()), ...(init?.headers as Record<string, string> | undefined) } })) as typeof fetch
      : base;
    if (opts.eventSourceCtor) this.eventSourceCtor = opts.eventSourceCtor;
    if (opts.extraEvents) this.extraEvents = opts.extraEvents;
    if (opts.reconnectMs !== undefined) this.reconnectMs = opts.reconnectMs;
    if (opts.autoConnect) this.connect();
  }

  /* ──────────────── Event subscription ──────────────── */

  /** A server event outside the built-in map (see `extraEvents`), e.g. a hosted server's own. */
  onEvent(event: string, handler: (payload: unknown) => void): () => void {
    return this.on(event as EventName, handler as EventHandler<EventName>);
  }

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
      ...(this.extraEvents ? { extraEvents: this.extraEvents } : {}),
      ...(this.reconnectMs !== undefined ? { reconnectMs: this.reconnectMs } : {}),
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

  /**
   * Tell the server we have a stable partial transcript so it can run
   * speculative routing + reasoning in the background. Zero user-visible
   * effect on its own — the work lands on the next `sendTurn` that
   * carries the same `speculationId`.
   */
  async sendPartial(req: PartialRequest): Promise<{ accepted: true }> {
    const res = await this.fetchFn(`${this.baseUrl}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, partial: true }),
    });
    if (!res.ok) throw new Error(`sendPartial ${res.status}: ${await res.text()}`);
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
