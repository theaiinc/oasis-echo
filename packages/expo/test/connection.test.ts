import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSpeech, Recognizer, RecognizerEvent } from '../src/adapters.js';
import { EchoConnection, EchoRefused } from '../src/connection.js';
import { base64ToBytes, bytesToBase64, bytesToFloat32, float32ToBytes, int16Base64DurationMs, rms } from '../src/pcm.js';
import { actionResultBody, echoPaths, parseEvent, parseRefusal, parseSocketMessage } from '../src/protocol.js';
import type { EchoEvent } from '../src/protocol.js';
import { EchoVoiceSession } from '../src/session.js';
import { SseParser } from '../src/sse-parser.js';
import { FakeXhr } from './fakes.js';

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  binaryType = '';
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  constructor(readonly url: string, _p: unknown, readonly options: { headers: Record<string, string> }) { FakeWs.last = this; }
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  opened() { this.readyState = 1; this.onopen?.(); }
}

const posts: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
let reply: (url: string) => { status: number; body: unknown } = () => ({ status: 202, body: { accepted: true } });
const fakeFetch = (async (url: string, init?: RequestInit) => {
  posts.push({ url, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
  const r = reply(url);
  return { status: r.status, ok: r.status < 400, json: async () => r.body } as Response;
}) as unknown as typeof fetch;

const platform = { XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest, WebSocket: FakeWs as never, fetch: fakeFetch };
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  posts.length = 0;
  reply = () => ({ status: 202, body: { accepted: true } });
  FakeXhr.last = null;
  FakeXhr.all = [];
});
afterEach(() => vi.useRealTimers());

describe('EchoConnection', () => {
  it('streams events with its headers, and reconnects after the server ends the stream, after its retry', async () => {
    const events: EchoEvent[] = [];
    const states: string[] = [];
    let n = 0;
    const c = new EchoConnection({ url: 'https://echo.test/a/arion/', headers: async () => ({ Authorization: `Bearer t${++n}` }), onEvent: (e) => events.push(e), onStream: (s) => states.push(s), ...platform });
    const opened = c.open();
    await flush();
    const x1 = FakeXhr.last!;
    expect(x1.url).toBe('https://echo.test/a/arion/events');
    expect(x1.headers).toMatchObject({ Accept: 'text/event-stream', Authorization: 'Bearer t1' });
    x1.respond(200, 'retry: 500\n: connected\n\n');
    await vi.advanceTimersByTimeAsync(50);
    await opened;
    x1.push('event: tts.chunk\ndata: {"turnId":"t1","text":"Chào","sampleRate":24000,"final":false,"filler":false}\n\nevent: call.language\ndata: {"lang":"vi-VN"}\n\n');
    x1.event('idle', {});
    x1.end();
    expect(states).toEqual(['open', 'closed']);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeXhr.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeXhr.all).toHaveLength(2);
    expect(FakeXhr.last!.headers['Authorization']).toBe('Bearer t2'); // fresh headers per connect (a refreshed token)
    expect(events.map((e) => e.type)).toEqual(['tts.chunk', 'other', 'idle']);
    expect(events[1]).toEqual({ type: 'other', name: 'call.language', data: { lang: 'vi-VN' } });
    c.close();
    expect(FakeXhr.last!.aborted).toBe(true);
  });

  it('stops for good on a refusal, with the lines to speak', async () => {
    const states: Array<[string, unknown]> = [];
    const c = new EchoConnection({ url: 'https://echo.test/a/arion', onEvent: () => {}, onStream: (s, r) => states.push([s, r]), ...platform });
    const opened = c.open();
    await flush();
    const x = FakeXhr.last!;
    x.status = 403;
    x.responseText = JSON.stringify({ error: 'arion_pro_required', message: { vi: 'Cần gói Pro.', en: 'Needs Pro.' } });
    x.end();
    const refused = expect(opened).rejects.toBeInstanceOf(EchoRefused);
    await vi.advanceTimersByTimeAsync(50);
    await refused;
    expect(c.refusal).toEqual({ status: 403, code: 'arion_pro_required', message: { vi: 'Cần gói Pro.', en: 'Needs Pro.' } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeXhr.all).toHaveLength(1); // no reconnect
    expect(states[0]?.[0]).toBe('closed');
  });

  it('posts hello, action results (too large becomes an error), barge-in and turns; refusals throw', async () => {
    const c = new EchoConnection({ url: 'https://echo.test/a/arion', headers: () => ({ Authorization: 'Bearer t' }), onEvent: () => {}, ...platform });
    reply = (url) => (url.endsWith('/hello') ? { status: 202, body: { accepted: true, actions: ['nav_search', 42] } } : url.endsWith('/action-result') ? { status: 404, body: {} } : { status: 202, body: {} });
    expect(await c.hello({ actions: ['nav_search', 'report'], context: { lang: 'vi' } })).toEqual(['nav_search']);
    expect(await c.actionResult({ id: 'a1', ok: true, result: { big: 'x'.repeat(5000) } })).toBe(false);
    expect(posts[1]).toMatchObject({ url: 'https://echo.test/a/arion/action-result', body: { id: 'a1', ok: false, error: 'result_too_large' } });
    await c.bargeIn();
    await c.turn('đi Bến Thành');
    expect(posts.map((p) => p.url.split('/').pop())).toEqual(['hello', 'action-result', 'bargein', 'turn']);
    expect(posts.every((p) => p.headers['Authorization'] === 'Bearer t')).toBe(true);
    reply = () => ({ status: 401, body: { error: 'arion_signed_out' } });
    await expect(c.turn('hi')).rejects.toMatchObject({ refusal: { code: 'arion_signed_out', status: 401 } });
  });

  it('streams an utterance over the audio socket, with its headers', async () => {
    const socket: unknown[] = [];
    const c = new EchoConnection({ url: 'http://localhost:8080/a/dev', headers: () => ({ Authorization: 'Bearer t' }), onEvent: () => {}, onSocket: (m) => socket.push(m), ...platform });
    const ready = c.openAudio();
    await flush();
    const ws = FakeWs.last!;
    expect(ws.url).toBe('ws://localhost:8080/a/dev/audio');
    expect(ws.options.headers).toEqual({ Authorization: 'Bearer t' });
    expect(c.startUtterance('u1')).toBe(false); // not open yet
    ws.opened();
    await ready;
    expect(c.startUtterance('u1')).toBe(true);
    expect(c.sendAudio(new Float32Array([0.5, -0.5]).length ? float32ToBytes(new Float32Array([0.5, -0.5])) : new Uint8Array())).toBe(true);
    c.endUtterance();
    ws.onmessage?.({ data: JSON.stringify({ type: 'stt.final', text: 'xin chào', utteranceId: 'u1' }) });
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent[0]).toBe('{"type":"start","utteranceId":"u1"}');
    expect(bytesToFloat32(new Uint8Array(ws.sent[1] as ArrayBuffer))).toEqual(new Float32Array([0.5, -0.5]));
    expect(ws.sent[2]).toBe('{"type":"end"}');
    expect(socket).toEqual([{ type: 'stt.final', text: 'xin chào', utteranceId: 'u1' }]);
  });
});

describe('EchoVoiceSession with actions and refusals', () => {
  const phone = () => {
    let cb: ((e: RecognizerEvent) => void) | null = null;
    const recognizer: Recognizer = { requestPermissions: async () => true, start: vi.fn(), stop: vi.fn(), abort: vi.fn(), listen: (f) => { cb = f; return () => { cb = null; }; } };
    const speech: DeviceSpeech = { speak: vi.fn(), stop: vi.fn(), voices: async () => [] };
    return { recognizer, speech, fire: (e: RecognizerEvent) => cb?.(e) };
  };

  it('says hello when the stream opens, runs what the agent asks and answers it', async () => {
    const p = phone();
    const run = vi.fn(async () => ({ ok: true, result: { places: [{ id: 'p1', title: 'Chợ Bến Thành' }] } }));
    const s = new EchoVoiceSession({
      baseUrl: 'https://echo.test/a/arion', adapters: p, connection: platform,
      actions: { names: () => ['nav_search'], context: () => ({ lang: 'vi' }), run },
    });
    await s.start();
    await flush();
    FakeXhr.last!.respond(200);
    await flush();
    expect(posts[0]).toMatchObject({ url: 'https://echo.test/a/arion/hello', body: { actions: ['nav_search'], context: { lang: 'vi' } } });
    s.refreshActions(); // nothing changed: no second hello
    await flush();
    expect(posts).toHaveLength(1);
    FakeXhr.last!.event('action.request', { id: 'a1', name: 'nav_search', args: { query: 'chợ' } });
    await flush();
    expect(run).toHaveBeenCalledWith({ id: 'a1', name: 'nav_search', args: { query: 'chợ' } });
    expect(posts[1]).toMatchObject({ url: 'https://echo.test/a/arion/action-result', body: { id: 'a1', ok: true, result: { places: [{ id: 'p1' }] } } });
    s.stop();
  });

  it('stops and reports a refusal', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://echo.test/a/arion', adapters: p, connection: platform });
    const refusals: unknown[] = [];
    s.on('refused', (r) => refusals.push(r));
    await s.start();
    await flush();
    FakeXhr.last!.status = 503;
    FakeXhr.last!.responseText = JSON.stringify({ error: 'arion_unavailable', message: { vi: 'Tạm thời không dùng được.' } });
    FakeXhr.last!.end();
    await flush();
    expect(refusals).toEqual([{ status: 503, code: 'arion_unavailable', message: { vi: 'Tạm thời không dùng được.' } }]);
    expect(s.isRunning).toBe(false);
  });
});

describe('protocol', () => {
  it('paths under an agent root, the socket on ws(s)', () => {
    expect(echoPaths('https://echo.example/a/arion/').audio).toBe('wss://echo.example/a/arion/audio');
    expect(echoPaths('http://localhost:8080').actionResult).toBe('http://localhost:8080/action-result');
  });

  it('events: tts.chunk defaults, turn.complete in either shape, action.request needs an id, others pass through', () => {
    expect(parseEvent('tts.chunk', '{"turnId":"t","text":"Hi","final":true}')).toEqual({ type: 'tts.chunk', turnId: 't', text: 'Hi', sampleRate: 24000, final: true, filler: false });
    expect(parseEvent('turn.complete', '{"turn":{"id":"t","agentText":"Ok"}}')).toMatchObject({ turnId: 't', agentText: 'Ok', interrupted: false });
    expect(parseEvent('action.request', '{"name":"x"}')).toBeNull();
    expect(parseEvent('action.request', '{"id":"a","name":"x","args":[1]}')).toEqual({ type: 'action.request', id: 'a', name: 'x', args: {} });
    expect(parseEvent('expert.answer', '{"answer":"y"}')).toEqual({ type: 'other', name: 'expert.answer', data: { answer: 'y' } });
    expect(parseEvent('tts.chunk', 'nope')).toBeNull();
  });

  it('refusals: the server\'s code, else one from the status; messages as given', () => {
    expect(parseRefusal(401, null)).toEqual({ status: 401, code: 'signed_out', message: null });
    expect(parseRefusal(403, { error: 'plan', message: 'Upgrade.' })).toEqual({ status: 403, code: 'plan', message: { default: 'Upgrade.' } });
  });

  it('action results count UTF-8 bytes', () => {
    const vi8 = 'Đường Nguyễn Huệ '.repeat(250); // ~4.2k chars, ~6k UTF-8 bytes
    expect(actionResultBody({ id: 'a', ok: true, result: { t: vi8 } }).ok).toBe(false);
    expect(actionResultBody({ id: 'a', ok: false })).toEqual({ id: 'a', ok: false, error: 'failed' });
    expect(parseSocketMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
  });
});

describe('sse parser and pcm', () => {
  it('parses events split anywhere, across \\r\\n pieces, and keeps retry', () => {
    const p = new SseParser();
    expect(p.push('retry: 2000\r')).toEqual([]);
    expect(p.push('\nevent: tts.ch')).toEqual([]);
    expect(p.push('unk\r\ndata: {"a":1}\r\n')).toEqual([]);
    expect(p.push('\r\n: ping\n\n')).toEqual([{ event: 'tts.chunk', data: '{"a":1}', id: null }]);
    expect(p.retryMs).toBe(2000);
  });

  it('base64, float32 and durations', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(int16Base64DurationMs(Buffer.alloc(48_000).toString('base64'), 24_000)).toBe(1000);
  });
});
