import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipPlayer, DeviceSpeech, Recognizer, RecognizerEvent } from '../src/adapters.js';
import { EchoVoiceSession } from '../src/session.js';
import { chooseVoice } from '../src/voices.js';
import { base64ToBytes } from '../src/pcm.js';
import { pcm16ToWav } from '../src/wav.js';
import { FakeXhr } from './fakes.js';

function phone() {
  let cb: ((e: RecognizerEvent) => void) | null = null;
  const recognizer = {
    granted: true,
    requestPermissions: vi.fn(async () => recognizer.granted),
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    listen: (f: (e: RecognizerEvent) => void) => { cb = f; return () => { cb = null; }; },
    fire: (e: RecognizerEvent) => cb?.(e),
  };
  const spoken: Array<{ text: string; done: () => void }> = [];
  const speech: DeviceSpeech = {
    speak: vi.fn((text, o) => { spoken.push({ text, done: o.onDone }); }),
    stop: vi.fn(),
    voices: async () => [{ identifier: 'vi-1', name: 'Linh', language: 'vi-VN' }],
  };
  const clips: Array<{ wav: Uint8Array; end: () => void }> = [];
  const player: ClipPlayer = { play: vi.fn((wav, onEnd) => { clips.push({ wav, end: onEnd }); }), stop: vi.fn() };
  return { recognizer: recognizer as Recognizer & typeof recognizer, speech, player, spoken, clips };
}

const posted: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
  return { ok: true, status: 202, json: async () => ({ accepted: true, interrupted: true }) } as Response;
}) as unknown as typeof fetch;

const flush = () => vi.advanceTimersByTimeAsync(0);
/** The session opened its event stream: answer it. */
const connect = async () => { await flush(); FakeXhr.last!.respond(200); await flush(); return FakeXhr.last!; };
const conn = { XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest, fetch: undefined as unknown as typeof fetch };
const chunk = (turnId: string, text: string, extra: Record<string, unknown> = {}) => ({ turnId, text, sampleRate: 24000, final: false, filler: false, atMs: 1, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  posted.length = 0;
  FakeXhr.last = null;
  FakeXhr.all = [];
  conn.fetch = fakeFetch;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EchoVoiceSession', () => {
  it('listens, sends what was said as a turn, with the auth header', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://echo.test/a/maya', adapters: p, connection: conn, lang: 'vi-VN', headers: () => ({ authorization: 'Bearer t' }) });
    const heard: Array<[string, boolean]> = [];
    s.on('userText', ({ text, final }) => heard.push([text, final]));
    expect(await s.start()).toBe(true);
    const xhr = await connect();
    expect(xhr.url).toBe('https://echo.test/a/maya/events');
    expect(xhr.headers).toMatchObject({ authorization: 'Bearer t' });
    expect(p.recognizer.start).toHaveBeenCalledWith({ lang: 'vi-VN', interimResults: true, continuous: true });
    expect(s.state).toBe('listening');
    p.recognizer.fire({ type: 'result', text: 'xin chào', isFinal: false });
    p.recognizer.fire({ type: 'result', text: 'xin chào em', isFinal: true });
    await flush();
    expect(heard).toEqual([['xin chào', false], ['xin chào em', true]]);
    expect(posted[0]).toMatchObject({ url: 'https://echo.test/a/maya/turn', body: { text: 'xin chào em' }, headers: { authorization: 'Bearer t' } });
    expect(s.state).toBe('thinking');
    s.stop();
  });

  it('ends an utterance after quiet when the recognizer never does, and sends a cut-off one', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn, endSilenceMs: 1000 });
    await s.start();
    p.recognizer.fire({ type: 'result', text: 'hello', isFinal: false });
    await vi.advanceTimersByTimeAsync(999);
    expect(p.recognizer.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.recognizer.stop).toHaveBeenCalledTimes(1);
    p.recognizer.fire({ type: 'end' }); // ended without a final result
    await flush();
    expect(posted.map((x) => x.body)).toEqual([{ text: 'hello' }]);
    await vi.advanceTimersByTimeAsync(250);
    expect(p.recognizer.start).toHaveBeenCalledTimes(2); // listening again
    s.stop();
  });

  it('speaks with the phone\'s voice, mic off meanwhile, back on once the reply is complete', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn, lang: 'vi-VN', rate: { vi: 1.15 } });
    await s.start();
    const es = await connect();
    es.event('tts.chunk', chunk('t1', 'Dạ, anh đợi em một chút nhé.'));
    es.event('tts.chunk', chunk('t1', 'Em xem rồi.'));
    await flush();
    expect(p.recognizer.abort).toHaveBeenCalled();
    expect(s.state).toBe('speaking');
    expect(p.spoken.map((x) => x.text)).toEqual(['Dạ, anh đợi em một chút nhé.']); // one line at a time
    expect(p.speech.speak).toHaveBeenCalledWith('Dạ, anh đợi em một chút nhé.', expect.objectContaining({ language: 'vi-VN', voice: 'vi-1', rate: 1.15 }));
    p.spoken[0]!.done();
    await flush();
    expect(p.spoken.map((x) => x.text)).toEqual(['Dạ, anh đợi em một chút nhé.', 'Em xem rồi.']);
    p.spoken[1]!.done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.recognizer.start).toHaveBeenCalledTimes(1); // the reply isn't complete yet: more may come
    es.event('turn.complete', { turn: { id: 't1', tier: 'escalated', intent: 'x', interrupted: false, userText: '', startedAtMs: 0 } });
    await vi.advanceTimersByTimeAsync(350);
    expect(p.recognizer.start).toHaveBeenCalledTimes(2);
    expect(s.state).toBe('listening');
    s.stop();
  });

  it('plays the server\'s voice as WAV clips, gathering chunks per clip', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn, voice: 'server', clipMs: 1000 });
    await s.start();
    const es = await connect();
    const half = btoa(String.fromCharCode(...new Uint8Array(24000))); // 0.5 s at 24 kHz
    es.event('tts.chunk', chunk('t1', 'One.', { audio: half }));
    await flush();
    expect(p.clips).toHaveLength(0);
    es.event('tts.chunk', chunk('t1', 'Two.', { audio: half }));
    await flush();
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0]!.wav.length).toBe(44 + 48000);
    es.event('tts.chunk', chunk('t1', '', { audio: half, final: true }));
    es.event('turn.complete', { turn: { id: 't1', tier: 'escalated', intent: 'x', interrupted: false, userText: '', startedAtMs: 0 } });
    await flush();
    expect(p.clips).toHaveLength(2);
    p.clips[0]!.end();
    p.clips[1]!.end();
    await vi.advanceTimersByTimeAsync(350);
    expect(p.recognizer.start).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('interrupting stops the agent, tells the server, ignores the rest of that reply, and listens', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn });
    await s.start();
    const es = await connect();
    es.event('tts.chunk', chunk('t1', 'A long answer.'));
    await flush();
    s.interrupt();
    await flush();
    expect(p.speech.stop).toHaveBeenCalled();
    expect(posted.some((x) => x.url === 'https://e.test/bargein')).toBe(true);
    expect(p.recognizer.start).toHaveBeenCalledTimes(2);
    es.event('tts.chunk', chunk('t1', 'More of it.'));
    await flush();
    expect(p.spoken.map((x) => x.text)).toEqual(['A long answer.']);
    s.stop();
  });

  it('a server barge-in stops the agent too', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn });
    await s.start();
    await connect();
    FakeXhr.last!.event('tts.chunk', chunk('t1', 'Hi.'));
    await flush();
    FakeXhr.last!.event('bargein', { interruptedTurnId: 't1', atMs: 2 });
    await flush();
    expect(p.speech.stop).toHaveBeenCalled();
    expect(s.state).toBe('listening');
    s.stop();
  });

  it('without the mic permission it says so and doesn\'t start', async () => {
    const p = phone();
    p.recognizer.granted = false;
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn });
    const errors: string[] = [];
    s.on('error', (e) => errors.push(e.kind));
    expect(await s.start()).toBe(false);
    expect(errors).toEqual(['permission']);
    expect(FakeXhr.last).toBeNull();
    expect(p.recognizer.start).not.toHaveBeenCalled();
  });

  it('switches language: listening restarts in the new one', async () => {
    const p = phone();
    const s = new EchoVoiceSession({ baseUrl: 'https://e.test', adapters: p, connection: conn, lang: 'en-US' });
    await s.start();
    s.setLang('vi-VN');
    expect(p.recognizer.abort).toHaveBeenCalled();
    expect(p.recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'vi-VN' }));
    s.stop();
  });
});

describe('helpers', () => {
  it('wraps PCM in a WAV header', () => {
    const wav = pcm16ToWav([new Uint8Array([1, 2]), new Uint8Array([3, 4])], 24000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint32(40, true)).toBe(4);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4]);
    expect([...base64ToBytes(btoa('\x01\x02'))]).toEqual([1, 2]);
  });

  it('picks the best voice for the language, never a novelty one', () => {
    const voices = [
      { identifier: 'en-x-local', name: 'English', language: 'en-US' },
      { identifier: 'vi-vn-x-gft-local', name: 'vi local', language: 'vi-VN' },
      { identifier: 'vi-vn-x-gft-network', name: 'vi network', language: 'vi-VN' },
      { identifier: 'com.apple.speech.synthesis.voice.Zarvox', name: 'Zarvox', language: 'en-US', quality: 'Enhanced' },
    ];
    expect(chooseVoice(voices, 'vi-VN')?.identifier).toBe('vi-vn-x-gft-network');
    expect(chooseVoice(voices, 'en-US')?.identifier).toBe('en-x-local');
    expect(chooseVoice(voices, 'ja-JP')).toBeUndefined();
  });
});
