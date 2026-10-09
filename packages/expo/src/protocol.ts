/**
 * The wire protocol between an app and an oasis-echo agent, as one place: every path, event, body and socket
 * message an app sends or reads. Pure (no React Native), so it runs under Node tests too.
 *
 * Per agent, under its root URL (e.g. https://echo.example/a/assistant), with the app's headers (auth) on every request:
 *   GET  events         server-sent events: tts.chunk, turn.complete, action.request, stt.*, bargein, error, idle, …
 *   POST hello          { actions, context } → { accepted, actions }: what the app can do now; the server answers with
 *                       the actions it offers this call. Each hello replaces the last. (Servers with client actions.)
 *   POST turn           { text }: something the user said, as text
 *   POST bargein        {}: the user talked over the agent
 *   POST action-result  { id, ok, result?, error? } → 200, or 404 when late or a duplicate
 *   WS   audio          binary frames of 16 kHz mono float32 PCM; JSON { type: start | end | abort } around each
 *                       utterance; the server answers { type: ready | stt.partial | stt.final }
 * Refusals (401 / 403 / 503) carry `{ error, message }`, where message may hold a line per language to speak.
 */

/** Mic audio the server listens to: 16 kHz mono 32-bit float, little-endian. */
export const MIC_SAMPLE_RATE = 16_000;

/** Servers refuse larger action results by default; an answer is a few facts, not a list to read out. */
export const DEFAULT_MAX_RESULT_BYTES = 4_000;

// ── where ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type EchoPaths = { events: string; hello: string; turn: string; bargein: string; actionResult: string; audio: string };

/** Every URL under an agent's root (https://…/a/agent, or a plain server's root); the audio socket on ws(s)://. */
export function echoPaths(root: string): EchoPaths {
  const r = root.replace(/\/+$/, '');
  return {
    events: `${r}/events`,
    hello: `${r}/hello`,
    turn: `${r}/turn`,
    bargein: `${r}/bargein`,
    actionResult: `${r}/action-result`,
    audio: `${r.replace(/^http/, 'ws')}/audio`,
  };
}

// ── server-sent events ──────────────────────────────────────────────────────────────────────────────────────────

export type TtsChunkEvent = {
  type: 'tts.chunk';
  turnId: string;
  text: string;
  sampleRate: number;
  final: boolean;
  filler: boolean;
  /** Base64 16-bit little-endian mono PCM at sampleRate; absent when the server sent text only. */
  audio?: string;
};

export type ActionRequest = { id: string; name: string; args: Record<string, unknown> };

export type EchoEvent =
  | TtsChunkEvent
  | { type: 'turn.complete'; turnId: string; userText: string; agentText: string; interrupted: boolean }
  | ({ type: 'action.request' } & ActionRequest)
  | { type: 'stt.partial' | 'stt.final'; text: string }
  | { type: 'user.input'; text: string; speaker?: string }
  | { type: 'bargein'; interruptedTurnId?: string }
  | { type: 'error'; source: string; error: string }
  /** The server recycled a quiet stream; reconnect if still in a call. */
  | { type: 'idle' }
  /** The server ended the call (e.g. the plan's talk time or longest call), after saying `message`. */
  | { type: 'call.ended'; reason: string; message: string }
  /** Any other event (a server's own, e.g. call.language), parsed JSON as sent. */
  | { type: 'other'; name: string; data: unknown };

const s = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** One SSE event (its `event:` name and `data:` text) as an app reads it; null when it can't be read. */
export function parseEvent(name: string, data: string): EchoEvent | null {
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = data ? JSON.parse(data) : {};
    d = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  switch (name) {
    case 'tts.chunk':
      return {
        type: 'tts.chunk',
        turnId: s(d['turnId']),
        text: s(d['text']),
        sampleRate: typeof d['sampleRate'] === 'number' && d['sampleRate'] > 0 ? d['sampleRate'] : 24_000,
        final: d['final'] === true,
        filler: d['filler'] === true,
        ...(typeof d['audio'] === 'string' && d['audio'] ? { audio: d['audio'] } : {}),
      };
    case 'turn.complete': {
      const t = (d['turn'] && typeof d['turn'] === 'object' ? d['turn'] : d) as Record<string, unknown>;
      return { type: 'turn.complete', turnId: s(t['id'] ?? t['turnId']), userText: s(t['userText']), agentText: s(t['agentText']), interrupted: t['interrupted'] === true };
    }
    case 'action.request': {
      const id = s(d['id']);
      const actionName = s(d['name']);
      if (!id || !actionName) return null;
      const a = d['args'];
      return { type: 'action.request', id, name: actionName, args: a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {} };
    }
    case 'stt.partial':
    case 'stt.final':
      return { type: name, text: s(d['text']) };
    case 'user.input':
      return { type: 'user.input', text: s(d['text']), ...(typeof d['speaker'] === 'string' ? { speaker: d['speaker'] } : {}) };
    case 'bargein':
      return { type: 'bargein', ...(typeof d['interruptedTurnId'] === 'string' ? { interruptedTurnId: d['interruptedTurnId'] } : {}) };
    case 'error':
      return { type: 'error', source: s(d['source']), error: s(d['error']) };
    case 'idle':
      return { type: 'idle' };
    case 'call.ended':
      return { type: 'call.ended', reason: s(d['reason']), message: s(d['message']) };
    default:
      return { type: 'other', name, data: d };
  }
}

// ── hello and actions ───────────────────────────────────────────────────────────────────────────────────────────

export type HelloBody = { actions: string[]; context?: unknown };

/** The server's answer to hello: the actions it offers this call, or null when it didn't say. */
export function parseHelloResponse(body: unknown): string[] | null {
  const list = (body as { actions?: unknown } | null)?.actions;
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : null;
}

export type ActionResult = { id: string; ok: boolean; result?: unknown; error?: string };

/** The body of POST action-result: a result only with ok, an error only without; too large becomes an error. */
export function actionResultBody(r: ActionResult, maxBytes = DEFAULT_MAX_RESULT_BYTES): ActionResult {
  if (!r.ok) return { id: r.id, ok: false, error: r.error ?? 'failed' };
  const body: ActionResult = { id: r.id, ok: true, result: r.result ?? {} };
  // Counted in UTF-8 bytes (e.g. Vietnamese place names are mostly multi-byte).
  return utf8Length(JSON.stringify(body)) > maxBytes ? { id: r.id, ok: false, error: 'result_too_large' } : body;
}

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the server refused the app: its error code (or one from the status), and lines to speak, per language. */
export type Refusal = {
  status: number;
  /** The server's `error` code; else signed_out (401), forbidden (403), unavailable (503), other. */
  code: string;
  /** e.g. { vi: '…', en: '…' }; null when the server gave none. */
  message: Record<string, string> | null;
};

export function parseRefusal(status: number, body: unknown): Refusal {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' && b.error
    ? b.error
    : status === 401 ? 'signed_out' : status === 403 ? 'forbidden' : status === 503 ? 'unavailable' : 'other';
  let message: Record<string, string> | null = null;
  if (typeof b.message === 'string') message = { default: b.message };
  else if (b.message && typeof b.message === 'object') {
    const entries = Object.entries(b.message as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
    if (entries.length) message = Object.fromEntries(entries);
  }
  return { status, code, message };
}

/** Statuses that mean "no", not "try again": the app should stop and say why. */
export const isRefusalStatus = (status: number) => status === 401 || status === 403 || status === 503;

// ── the audio socket ────────────────────────────────────────────────────────────────────────────────────────────

export const wsStart = (utteranceId: string) => JSON.stringify({ type: 'start', utteranceId });
export const wsEnd = () => JSON.stringify({ type: 'end' });
export const wsAbort = () => JSON.stringify({ type: 'abort' });

export type SocketMessage = { type: 'ready' } | { type: 'stt.partial' | 'stt.final'; text: string; utteranceId: string | null };

export function parseSocketMessage(text: string): SocketMessage | null {
  try {
    const m = JSON.parse(text) as Record<string, unknown>;
    if (m['type'] === 'ready') return { type: 'ready' };
    if (m['type'] === 'stt.partial' || m['type'] === 'stt.final') {
      return { type: m['type'], text: s(m['text']), utteranceId: typeof m['utteranceId'] === 'string' ? m['utteranceId'] : null };
    }
  } catch { /* not JSON: nothing an app reads */ }
  return null;
}
