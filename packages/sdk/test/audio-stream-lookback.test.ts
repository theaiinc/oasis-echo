import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Verifies the `AudioStreamUpload` client-side lookback ring buffer:
 * audio captured BEFORE `startUtterance()` must be flushed to the
 * WebSocket on start, in chronological order, so the server-side
 * Whisper sees the ~500ms of speech the browser's SpeechRecognition
 * VAD eats before emitting its first interim.
 *
 * The class reads from the browser's AudioContext + AudioWorklet which
 * don't exist in Node. We stub the minimum globals needed to exercise
 * the ring-buffer paths in isolation.
 */

function setupBrowserStubs(): {
  wsSent: Array<ArrayBuffer | string>;
  fireMicFrame: (samples: Float32Array) => void;
  getWsInstance: () => { readyState: number; onopen?: () => void; onmessage?: unknown; onerror?: unknown; onclose?: unknown };
} {
  const wsSent: Array<ArrayBuffer | string> = [];
  let wsInstance: {
    readyState: number;
    onopen?: () => void;
    onmessage?: unknown;
    onerror?: unknown;
    onclose?: unknown;
    send: (data: ArrayBuffer | string) => void;
    close: () => void;
    binaryType?: string;
  } | null = null;
  // @ts-expect-error — adding globals
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    onopen?: () => void;
    onmessage?: unknown;
    onerror?: unknown;
    onclose?: unknown;
    constructor(_url: string) {
      wsInstance = this as unknown as typeof wsInstance;
      // Defer open to mimic async connection.
      setTimeout(() => {
        (this as unknown as { readyState: number }).readyState = 1;
        this.onopen?.();
      }, 0);
    }
    send(data: ArrayBuffer | string): void {
      wsSent.push(data);
    }
    close(): void {
      /* no-op */
    }
  };
  // Capture the worklet message handler so the test can simulate
  // mic-produced PCM frames.
  let workletMessageHandler: ((ev: { data: Float32Array }) => void) | null = null;
  // @ts-expect-error — adding globals
  globalThis.AudioWorkletNode = class {
    port = {
      set onmessage(fn: (ev: { data: Float32Array }) => void) { workletMessageHandler = fn; },
      get onmessage() { return workletMessageHandler; },
      close: () => {},
    };
    connect(): void {}
    disconnect(): void {}
  };
  // @ts-expect-error — adding globals
  globalThis.URL ??= {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  };
  // @ts-expect-error — adding globals
  globalThis.Blob ??= class {
    constructor(_: unknown, __?: unknown) {}
  };
  // @ts-expect-error — adding globals
  globalThis.location = { protocol: 'http:', host: 'test' };

  const fireMicFrame = (samples: Float32Array): void => {
    workletMessageHandler?.({ data: samples });
  };

  return {
    wsSent,
    fireMicFrame,
    getWsInstance: () => wsInstance!,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // @ts-expect-error — cleanup globals we added
  delete globalThis.WebSocket;
  // @ts-expect-error
  delete globalThis.AudioWorkletNode;
});

describe('AudioStreamUpload lookback ring buffer', () => {
  async function makeStream() {
    const stubs = setupBrowserStubs();
    const { AudioStreamUpload } = await import('../src/browser/audio-stream.js');
    const audioContext = {
      sampleRate: 16000,
      audioWorklet: { addModule: async () => {} },
    } as unknown as AudioContext;
    const source = { connect: () => {}, disconnect: () => {} } as unknown as AudioNode;
    const s = new AudioStreamUpload({
      audioContext,
      source,
      lookbackSeconds: 0.5, // 8000 samples @ 16kHz
    });
    await s.connect();
    // Wait for mock WebSocket to enter OPEN state.
    await new Promise((r) => setTimeout(r, 5));
    return { s, ...stubs };
  }

  it('flushes pre-start audio on startUtterance', async () => {
    const { s, fireMicFrame, wsSent } = await makeStream();
    // Fire 400 samples (25ms) of mic audio BEFORE startUtterance.
    const pre = new Float32Array(400);
    for (let i = 0; i < pre.length; i++) pre[i] = (i % 100) / 100;
    fireMicFrame(pre);
    expect(wsSent.length).toBe(0); // nothing sent yet

    s.startUtterance('sp-1');
    // Two sends: the 'start' JSON control message + the flushed lookback.
    expect(wsSent.length).toBe(2);
    expect(typeof wsSent[0]).toBe('string');
    expect(wsSent[0]).toContain('"type":"start"');
    expect(wsSent[1]).toBeInstanceOf(ArrayBuffer);
    const flushed = new Float32Array(wsSent[1] as ArrayBuffer);
    expect(flushed.length).toBe(400);
    expect(flushed[0]).toBeCloseTo(pre[0]!, 5);
    expect(flushed[399]).toBeCloseTo(pre[399]!, 5);
  });

  it('streams live frames after startUtterance', async () => {
    const { s, fireMicFrame, wsSent } = await makeStream();
    s.startUtterance('sp-2');
    wsSent.length = 0; // drop start + empty-lookback
    const live = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    fireMicFrame(live);
    expect(wsSent.length).toBe(1);
    const got = new Float32Array(wsSent[0] as ArrayBuffer);
    expect(got[0]).toBeCloseTo(0.1, 5);
    expect(got[3]).toBeCloseTo(0.4, 5);
  });

  it('ring wraps: oldest samples drop when lookback fills', async () => {
    const { s, fireMicFrame, wsSent } = await makeStream(); // 8000-sample ring
    // Feed 10000 samples in two chunks. Oldest 2000 should roll off.
    const chunk1 = new Float32Array(6000);
    chunk1.fill(0.1);
    const chunk2 = new Float32Array(4000);
    chunk2.fill(0.9);
    fireMicFrame(chunk1);
    fireMicFrame(chunk2);
    s.startUtterance('sp-wrap');
    const flushed = new Float32Array(wsSent[1] as ArrayBuffer);
    expect(flushed.length).toBe(8000);
    // First 4000 should be the tail of chunk1 (0.1), last 4000 should be chunk2 (0.9).
    expect(flushed[0]).toBeCloseTo(0.1, 5);
    expect(flushed[3999]).toBeCloseTo(0.1, 5);
    expect(flushed[4000]).toBeCloseTo(0.9, 5);
    expect(flushed[7999]).toBeCloseTo(0.9, 5);
  });

  it('resets lookback between utterances so turn N tail does not leak into turn N+1', async () => {
    const { s, fireMicFrame, wsSent } = await makeStream();
    fireMicFrame(new Float32Array(1000).fill(0.5));
    s.startUtterance('sp-first');
    expect(wsSent.length).toBe(2); // start + 1000 samples
    s.endUtterance(); // resets lookback
    wsSent.length = 0;

    // New utterance: only 200 fresh samples captured before start.
    fireMicFrame(new Float32Array(200).fill(0.9));
    s.startUtterance('sp-second');
    // start + 200-sample flush. NOT 1200.
    const flushed = new Float32Array(wsSent[1] as ArrayBuffer);
    expect(flushed.length).toBe(200);
    expect(flushed[0]).toBeCloseTo(0.9, 5);
  });

  it('abortUtterance also resets the lookback', async () => {
    const { s, fireMicFrame, wsSent } = await makeStream();
    fireMicFrame(new Float32Array(1000).fill(0.5));
    s.startUtterance('sp-a');
    s.abortUtterance();
    wsSent.length = 0;

    fireMicFrame(new Float32Array(100).fill(0.3));
    s.startUtterance('sp-b');
    const flushed = new Float32Array(wsSent[1] as ArrayBuffer);
    expect(flushed.length).toBe(100);
  });
});
