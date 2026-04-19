import { describe, expect, it, vi } from 'vitest';
import { OasisClient } from '../src/client.js';
import type { EventSourceLike, SseMessage } from '../src/sse.js';

/** A mock EventSource that captures listeners and lets us dispatch synthetic events. */
class MockEventSource implements EventSourceLike {
  static lastInstance: MockEventSource | null = null;
  static lastUrl: string | null = null;
  private listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(url: string) {
    MockEventSource.lastInstance = this;
    MockEventSource.lastUrl = url;
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }
  dispatch(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  close(): void {
    this.listeners.clear();
  }
}

function buildFetchMock(responses: Map<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const body = responses.get(key) ?? responses.get(url);
    return {
      ok: true,
      status: 200,
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('OasisClient', () => {
  it('delivers typed events to registered handlers', () => {
    const client = new OasisClient({
      baseUrl: 'http://test',
      eventSourceCtor: MockEventSource as unknown as new (url: string) => EventSourceLike,
    });
    client.connect();
    const tts = vi.fn();
    const emo = vi.fn();
    client.on('tts.chunk', tts);
    client.on('emotion.directives', emo);
    const es = MockEventSource.lastInstance!;
    es.dispatch(
      'tts.chunk',
      JSON.stringify({ turnId: 't1', text: 'hi', sampleRate: 24000, final: false, filler: false, atMs: 1 }),
    );
    es.dispatch(
      'emotion.directives',
      JSON.stringify({
        turnId: 't1',
        atMs: 2,
        source: 'acoustic',
        detected: 'happy',
        confidence: 0.9,
        effective: 'happy',
        strategy: 'mirror',
        styleTags: ['cheerful'],
        rationale: 'emotion=happy; strategy=mirror',
        directives: { playbackRate: 1.14, gain: 1, interChunkSilenceMs: 30, pitchSemitones: 3, ssml: '<speak/>' },
      }),
    );
    expect(tts).toHaveBeenCalledOnce();
    expect(tts.mock.calls[0]![0]).toMatchObject({ turnId: 't1', text: 'hi' });
    expect(emo).toHaveBeenCalledOnce();
    expect(emo.mock.calls[0]![0]).toMatchObject({ effective: 'happy', strategy: 'mirror' });
  });

  it('off() removes a handler', () => {
    const client = new OasisClient({
      baseUrl: 'http://test',
      eventSourceCtor: MockEventSource as unknown as new (url: string) => EventSourceLike,
    });
    client.connect();
    const h = vi.fn();
    client.on('bargein', h);
    client.off('bargein', h);
    MockEventSource.lastInstance!.dispatch('bargein', JSON.stringify({ atMs: 1 }));
    expect(h).not.toHaveBeenCalled();
  });

  it('on() returns an unsubscribe function', () => {
    const client = new OasisClient({
      baseUrl: 'http://test',
      eventSourceCtor: MockEventSource as unknown as new (url: string) => EventSourceLike,
    });
    client.connect();
    const h = vi.fn();
    const off = client.on('bargein', h);
    off();
    MockEventSource.lastInstance!.dispatch('bargein', JSON.stringify({ atMs: 1 }));
    expect(h).not.toHaveBeenCalled();
  });

  it('sendTurn POSTs JSON to /turn', async () => {
    const mockFetch = buildFetchMock(new Map([['POST http://test/turn', { accepted: true }]]));
    const client = new OasisClient({ baseUrl: 'http://test', fetch: mockFetch });
    const res = await client.sendTurn({ text: 'hello' });
    expect(res).toEqual({ accepted: true });
    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });
  });

  it('sendCorrection POSTs JSON to /correction', async () => {
    const mockFetch = buildFetchMock(
      new Map([['POST http://test/correction', { accepted: true, wordPairs: [], addedAsPhrase: true }]]),
    );
    const client = new OasisClient({ baseUrl: 'http://test', fetch: mockFetch });
    const res = await client.sendCorrection({ original: 'teh', corrected: 'the' });
    expect(res.accepted).toBe(true);
  });

  it('getCorrections GETs /corrections', async () => {
    const mockFetch = buildFetchMock(
      new Map([['GET http://test/corrections', { wordRules: {}, phrases: [], history: [] }]]),
    );
    const client = new OasisClient({ baseUrl: 'http://test', fetch: mockFetch });
    const s = await client.getCorrections();
    expect(s.wordRules).toEqual({});
  });

  it('bargeIn POSTs /bargein', async () => {
    const mockFetch = buildFetchMock(new Map([['POST http://test/bargein', { interrupted: true }]]));
    const client = new OasisClient({ baseUrl: 'http://test', fetch: mockFetch });
    const res = await client.bargeIn();
    expect(res.interrupted).toBe(true);
  });

  it('uses the SSE URL "/events" under the given baseUrl', () => {
    new OasisClient({
      baseUrl: 'http://host:3001/',
      eventSourceCtor: MockEventSource as unknown as new (url: string) => EventSourceLike,
      autoConnect: true,
    });
    expect(MockEventSource.lastUrl).toBe('http://host:3001/events');
  });

  it('wraps the default fetch so calls keep the correct this — browsers throw "Illegal invocation" when a native fetch ref is called off a non-window owner', async () => {
    // Regression: storing `this.fetchFn = opts.fetch ?? fetch` and later
    // calling `this.fetchFn(...)` detaches fetch from window in the
    // browser and sendTurn silently fails with "Illegal invocation". The
    // constructor wraps the default in a closure that re-anchors fetch.
    const globalFetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accepted: true }),
      text: async () => '{}',
    }) as unknown as Response);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = globalFetchSpy as unknown as typeof fetch;
    try {
      const client = new OasisClient({ baseUrl: 'http://test' });
      const res = await client.sendTurn({ text: 'regression' });
      expect(res).toEqual({ accepted: true });
      expect(globalFetchSpy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips non-JSON SSE data silently', () => {
    const client = new OasisClient({
      baseUrl: 'http://test',
      eventSourceCtor: MockEventSource as unknown as new (url: string) => EventSourceLike,
    });
    client.connect();
    const h = vi.fn();
    client.on('tts.chunk', h);
    MockEventSource.lastInstance!.dispatch('tts.chunk', 'not json');
    expect(h).not.toHaveBeenCalled();
  });
});

// Silence unused-import warning for the reference type
const _s: SseMessage | undefined = undefined;
void _s;
