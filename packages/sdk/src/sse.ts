/**
 * Cross-platform Server-Sent Events consumer.
 *
 * In a browser, we prefer the native `EventSource` for auto-reconnect
 * and the semantics the server's heartbeat pings already expect. In
 * Node we fall back to `fetch` + a streaming body reader, parsing the
 * text/event-stream frames ourselves. Callers can supply their own
 * `EventSource` constructor (e.g. the `eventsource` npm package) to
 * override the Node path when they want the same reconnect semantics.
 */

export type SseMessage = {
  event: string;
  data: string;
  id?: string;
};

export type SseOpts = {
  url: string;
  /** Custom EventSource constructor (browser `EventSource` or the `eventsource` npm package). */
  eventSourceCtor?: new (url: string, init?: unknown) => EventSourceLike;
  /** Override fetch for testing / custom networking. Defaults to global fetch. */
  fetch?: typeof fetch;
  onMessage: (msg: SseMessage) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
};

export type EventSourceLike = {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
};

export type SseHandle = {
  close(): void;
};

/** Detect whether a real `EventSource` constructor is available globally (browser). */
function nativeEventSource(): typeof EventSource | undefined {
  return typeof (globalThis as { EventSource?: typeof EventSource }).EventSource === 'function'
    ? (globalThis as { EventSource: typeof EventSource }).EventSource
    : undefined;
}

/**
 * Open an SSE connection and invoke `onMessage` for each framed event.
 * Returns a handle whose `close()` aborts the connection.
 */
export function openSse(opts: SseOpts): SseHandle {
  const Ctor = opts.eventSourceCtor ?? nativeEventSource();
  if (Ctor) {
    // Browser path (or user-supplied EventSource). We register one
    // listener per known event name + a generic 'message' fallback.
    const es = new Ctor(opts.url) as EventSourceLike & {
      onopen?: (() => void) | null;
      onerror?: ((ev: unknown) => void) | null;
    };
    // Known event names — the server uses named events, not default
    // "message" frames. Keep this in sync with events.ts. Passing an
    // explicit list ahead of time keeps us decoupled from the map.
    const events = [
      'user.input',
      'stt.partial',
      'stt.final',
      'stt.postprocess',
      'route.decision',
      'tts.chunk',
      'turn.complete',
      'turn.summary',
      'bargein',
      'emotion.directives',
      'error',
      'message',
    ];
    for (const name of events) {
      es.addEventListener(name, (ev) => {
        opts.onMessage({ event: name, data: ev.data });
      });
    }
    if (opts.onOpen) {
      es.onopen = opts.onOpen;
    }
    if (opts.onError) {
      es.onerror = (ev) => opts.onError?.(ev);
    }
    return { close: () => es.close() };
  }
  // Node fallback: fetch + streaming body parse.
  return openSseViaFetch(opts);
}

function openSseViaFetch(opts: SseOpts): SseHandle {
  const fetchFn = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let closed = false;
  (async () => {
    try {
      const res = await fetchFn(opts.url, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        opts.onError?.(new Error(`SSE HTTP ${res.status}`));
        return;
      }
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        // Events are terminated by a blank line (\n\n or \r\n\r\n).
        let sep: number;
        while ((sep = findFrameEnd(buf)) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2); // skip the terminating \n\n
          const parsed = parseFrame(frame);
          if (parsed) opts.onMessage(parsed);
        }
      }
    } catch (err) {
      if (!closed) opts.onError?.(err);
    }
  })();
  return {
    close: () => {
      closed = true;
      try { ctrl.abort(); } catch { /* ignore */ }
    },
  };
}

/** Find the end of an SSE frame in a buffer — either \n\n or \r\n\r\n. */
function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b === -1 ? -1 : b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): SseMessage | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // keep-alive / comment
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^\s/, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0 && event === 'message') return null;
  const out: SseMessage = { event, data: dataLines.join('\n') };
  if (id) out.id = id;
  return out;
}
