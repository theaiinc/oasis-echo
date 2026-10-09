import {
  actionResultBody, echoPaths, isRefusalStatus, parseEvent, parseHelloResponse, parseRefusal, parseSocketMessage, wsAbort, wsEnd, wsStart,
} from './protocol.js';
import type { ActionResult, EchoEvent, EchoPaths, HelloBody, Refusal, SocketMessage } from './protocol.js';
import { SseParser } from './sse-parser.js';

/**
 * One app's connection to an oasis-echo agent: the event stream, the POSTs, and the audio socket. It only moves
 * bytes; what a turn is (when to listen, what to play) is up to the app or EchoVoiceSession.
 *
 * The event stream runs over XMLHttpRequest: React Native has no EventSource, and its fetch has no streaming body,
 * but XHR's progress events deliver the text as it arrives (and it can send headers, unlike EventSource). It
 * reconnects with backoff, honouring the server's `retry:`, and stops for good on a refusal (401/403/503).
 * The audio socket uses React Native's WebSocket headers argument, so auth goes along there too.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed';
type Headers = Record<string, string>;

export class EchoRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.code);
    this.name = 'EchoRefused';
  }
}

type WebSocketCtor = new (url: string, protocols: string[] | null, options: { headers: Headers }) => WebSocket;

export type EchoConnectionOpts = {
  /** The agent's root: https://echo.example/a/assistant (or a plain server's root). */
  url: string;
  /** Headers for every request, the stream and the socket included (e.g. Authorization). */
  headers?: () => Headers | Promise<Headers>;
  onEvent: (e: EchoEvent) => void;
  /** The stream opened, dropped (it will reconnect), or was refused (it won't). */
  onStream?: (state: ConnectionState, refusal?: Refusal) => void;
  onSocket?: (m: SocketMessage) => void;
  /** Longest wait between reconnects. Default 10 s. */
  maxBackoffMs?: number;
  /** Platform overrides (tests, other runtimes). Default: the globals. */
  XMLHttpRequest?: typeof XMLHttpRequest;
  WebSocket?: WebSocketCtor;
  fetch?: typeof fetch;
};

export class EchoConnection {
  readonly paths: EchoPaths;
  state: ConnectionState = 'closed';
  /** Set when the server refused the stream; cleared by the next open(). */
  refusal: Refusal | null = null;

  private xhr: XMLHttpRequest | null = null;
  private parser = new SseParser();
  private seen = 0;
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> | null = null;

  constructor(private readonly opts: EchoConnectionOpts) {
    this.paths = echoPaths(opts.url);
  }

  private async headers(): Promise<Headers> {
    return (await this.opts.headers?.()) ?? {};
  }

  // ── events ────────────────────────────────────────────────────────────────

  /** Opens the event stream and keeps it open (reconnecting) until close(); resolves once it is open. */
  open(timeoutMs = 8_000): Promise<void> {
    this.wanted = true;
    this.refusal = null;
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closed' && !this.retryTimer) void this.connect();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (this.state === 'open') return resolve();
        if (this.refusal) return reject(new EchoRefused(this.refusal));
        if (!this.wanted) return reject(new Error('closed'));
        if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
        setTimeout(check, 50);
      };
      check();
    });
  }

  private async connect(): Promise<void> {
    this.state = 'connecting';
    const headers = await this.headers().catch(() => ({}) as Headers);
    if (!this.wanted) { this.state = 'closed'; return; }
    const Xhr = this.opts.XMLHttpRequest ?? XMLHttpRequest;
    const xhr = new Xhr();
    this.xhr = xhr;
    this.parser = new SseParser();
    this.seen = 0;
    xhr.open('GET', this.paths.events);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.onreadystatechange = () => {
      if (this.xhr !== xhr) return;
      if (xhr.readyState >= 2 && xhr.status === 200 && this.state === 'connecting') {
        this.state = 'open';
        this.retries = 0;
        this.opts.onStream?.('open');
      }
      if (xhr.readyState === 3 || xhr.readyState === 4) this.read(xhr);
      if (xhr.readyState === 4) this.dropped(xhr);
    };
    xhr.onerror = () => { if (this.xhr === xhr) this.dropped(xhr); };
    xhr.send();
  }

  private read(xhr: XMLHttpRequest): void {
    if (xhr.status !== 200) return;
    const text = xhr.responseText ?? '';
    if (text.length <= this.seen) return;
    const fresh = text.slice(this.seen);
    this.seen = text.length;
    for (const m of this.parser.push(fresh)) {
      const e = parseEvent(m.event, m.data);
      if (e) this.opts.onEvent(e);
    }
  }

  private dropped(xhr: XMLHttpRequest): void {
    if (this.xhr !== xhr) return;
    this.xhr = null;
    const was = this.state;
    this.state = 'closed';
    if (isRefusalStatus(xhr.status)) {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      this.refusal = parseRefusal(xhr.status, body);
      this.wanted = false;
      this.opts.onStream?.('closed', this.refusal);
      return;
    }
    if (was === 'open') this.opts.onStream?.('closed');
    if (!this.wanted) return;
    // Servers recycle quiet streams (idle) and restart: reconnect quickly, then back off.
    const wait = Math.min(this.opts.maxBackoffMs ?? 10_000, (this.parser.retryMs ?? 1_000) * 2 ** Math.min(this.retries++, 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.xhr) void this.connect();
    }, wait);
  }

  /** Closes the stream and the audio socket. */
  close(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const xhr = this.xhr;
    this.xhr = null;
    xhr?.abort();
    this.state = 'closed';
    this.closeAudio();
  }

  // ── posts ─────────────────────────────────────────────────────────────────

  private async post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await this.headers()) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (isRefusalStatus(res.status)) throw new EchoRefused(parseRefusal(res.status, json));
    return { status: res.status, json };
  }

  /** Tells the server what the app can do now; resolves with the actions it offers this call (null: it didn't say). */
  async hello(body: HelloBody): Promise<string[] | null> {
    const r = await this.post(this.paths.hello, body);
    if (r.status >= 400) throw new Error(`hello ${r.status}`);
    return parseHelloResponse(r.json);
  }

  /** False when the server no longer waits for it (late or a duplicate). */
  async actionResult(r: ActionResult, maxBytes?: number): Promise<boolean> {
    const out = await this.post(this.paths.actionResult, actionResultBody(r, maxBytes));
    return out.status < 400;
  }

  /** The user talked over the agent. */
  async bargeIn(): Promise<{ interrupted?: boolean } | null> {
    const r = await this.post(this.paths.bargein, {});
    return r.json as { interrupted?: boolean } | null;
  }

  /** Something the user said, as text. */
  async turn(text: string): Promise<void> {
    const r = await this.post(this.paths.turn, { text });
    if (r.status >= 400) throw new Error(`turn ${r.status}`);
  }

  // ── the audio socket ──────────────────────────────────────────────────────

  /** Opens the audio socket (once) and resolves when it is connected. */
  async openAudio(timeoutMs = 6_000): Promise<void> {
    if (this.ws && this.wsReady) return this.wsReady;
    const headers = await this.headers();
    // React Native's WebSocket takes headers as a third argument; that is how auth goes along.
    const Ws = this.opts.WebSocket ?? (WebSocket as unknown as WebSocketCtor);
    const ws = new Ws(this.paths.audio, null, { headers });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.wsReady = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('audio socket timeout')), timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('audio socket failed')); };
    });
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') return;
      const msg = parseSocketMessage(m.data);
      if (msg) this.opts.onSocket?.(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) { this.ws = null; this.wsReady = null; }
    };
    this.wsReady.catch(() => { if (this.ws === ws) { this.ws = null; this.wsReady = null; } });
    return this.wsReady;
  }

  private sendWs(data: string | ArrayBuffer): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(data);
    return true;
  }

  /** Begin an utterance (the server starts listening). */
  startUtterance(id: string): boolean { return this.sendWs(wsStart(id)); }
  /** 16 kHz mono float32 little-endian PCM. False when the socket isn't open (keep it and send later). */
  sendAudio(bytes: Uint8Array): boolean {
    return this.sendWs(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer));
  }
  /** The user stopped talking: the server finishes the utterance. */
  endUtterance(): boolean { return this.sendWs(wsEnd()); }
  /** Drop the utterance. */
  abortUtterance(): boolean { return this.sendWs(wsAbort()); }

  closeAudio(): void {
    const ws = this.ws;
    this.ws = null;
    this.wsReady = null;
    ws?.close();
  }
}
