/**
 * Upstream audio over WebSocket to the server for streaming STT.
 *
 * Shape:
 *   - Binary frames: Float32 PCM at 16kHz mono (browser AudioWorklet
 *     output after resampling). Each frame is an `ArrayBuffer` of a
 *     ~128-sample block as emitted by the worklet.
 *   - Text frames (JSON): control + events.
 *       client → server:
 *         { type: 'start', speculationId }
 *         { type: 'end' }
 *         { type: 'abort' }
 *       server → client:
 *         { type: 'ready' }
 *         { type: 'stt.partial', text, atMs }
 *         { type: 'stt.final', text, speculationId, atMs }
 *
 * The client still owns turn commit — it POSTs `/turn` with the
 * `stt.final` text + the same `speculationId` so the server promotes
 * the pre-computed speculation buffer. No behavior change to the HTTP
 * side; this class only replaces "browser SpeechRecognition → debounce
 * → POST /turn" with "mic PCM → server STT → server speculation →
 * POST /turn with server's final text".
 */

const TARGET_RATE = 16000;

export type AudioStreamEvents = {
  partial: (text: string) => void;
  final: (payload: { text: string; speculationId: string | null }) => void;
  open: () => void;
  close: () => void;
  error: (err: unknown) => void;
};

export type AudioStreamOpts = {
  /** WebSocket URL, e.g. `ws://localhost:3001/audio`. Defaults to same-origin `/audio`. */
  url?: string;
  /**
   * Supplied AudioContext. Required — the caller must provide the same
   * context used by the mic source so the worklet connects cleanly.
   */
  audioContext: AudioContext;
  /**
   * Live mic source node. Same node the volume monitor + MicCapture
   * attach to — re-using it means we don't ask for another permission
   * and the worklet runs in the existing audio graph.
   */
  source: AudioNode;
  /**
   * How many seconds of mic audio to keep in a client-side lookback
   * ring buffer, captured even BEFORE `startUtterance`. Flushed to the
   * server on `startUtterance` so the ~300-500ms that the browser's
   * SpeechRecognition VAD swallows before emitting its first interim
   * isn't lost. Default 1.2s.
   */
  lookbackSeconds?: number;
};

const WORKLET_CODE = `
class PcmStreamer extends AudioWorkletProcessor {
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c && c.length) this.port.postMessage(c.slice(0));
    return true;
  }
}
registerProcessor('pcm-streamer', PcmStreamer);
`;

/**
 * One instance per voice session. Call `connect()` up front, then
 * `startUtterance(speculationId)` when recording begins and
 * `endUtterance()` when the user stops (client-side VAD or manual
 * commit). Receive server-side partials + final via `on('partial')`
 * / `on('final')` listeners.
 */
export class AudioStreamUpload {
  private readonly url: string;
  private readonly audioContext: AudioContext;
  private readonly source: AudioNode;
  private ws: WebSocket | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceRate: number;
  private capturing = false;
  private handlers: Partial<AudioStreamEvents> = {};

  // Client-side lookback ring buffer, sized to the configured number
  // of seconds at 16kHz. Always written to by the worklet; flushed
  // to the server on `startUtterance` so the first ~500ms of speech
  // that the browser's SpeechRecognition VAD eats isn't lost.
  private readonly lookbackSize: number;
  private readonly lookback: Float32Array;
  private lookbackWrite = 0;
  private lookbackFilled = false;

  constructor(opts: AudioStreamOpts) {
    this.url =
      opts.url ??
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/audio`;
    this.audioContext = opts.audioContext;
    this.source = opts.source;
    this.sourceRate = opts.audioContext.sampleRate;
    this.lookbackSize = Math.floor((opts.lookbackSeconds ?? 1.2) * TARGET_RATE);
    this.lookback = new Float32Array(this.lookbackSize);
  }

  on<E extends keyof AudioStreamEvents>(event: E, fn: AudioStreamEvents[E]): void {
    this.handlers[event] = fn;
  }

  /** Open the WebSocket and load the resampling AudioWorklet. Idempotent. */
  async connect(): Promise<void> {
    if (this.ws) return;
    // 1. Attach the worklet that streams PCM blocks from the mic.
    const blob = new Blob([WORKLET_CODE], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await this.audioContext.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-streamer');
    this.workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const resampled = downsampleTo16k(ev.data, this.sourceRate);
      if (resampled.length === 0) return;
      // ALWAYS write to the lookback ring buffer — even when we're
      // not actively streaming to the server. This is how we catch
      // audio from BEFORE startUtterance is called.
      this.writeLookback(resampled);
      // Only send to server when an utterance is in progress.
      if (!this.capturing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(resampled.buffer);
      } catch {
        /* ignore send-on-close */
      }
    };
    this.source.connect(this.workletNode);

    // 2. Open the WebSocket. Events surface through the registered
    // handlers — we do NOT buffer messages before open; callers should
    // await `connect()` before `startUtterance()`.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.handlers.open?.();
        resolve();
      };
      ws.onerror = (ev) => {
        this.handlers.error?.(ev);
        reject(ev);
      };
      ws.onclose = () => {
        this.capturing = false;
        this.handlers.close?.();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let payload: { type?: string } & Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.data) as typeof payload;
        } catch {
          return;
        }
        if (payload.type === 'stt.partial' && typeof payload['text'] === 'string') {
          this.handlers.partial?.(payload['text']);
        } else if (payload.type === 'stt.final' && typeof payload['text'] === 'string') {
          this.handlers.final?.({
            text: payload['text'],
            speculationId:
              typeof payload['speculationId'] === 'string'
                ? payload['speculationId']
                : null,
          });
        }
      };
    });
  }

  /**
   * Tell the server a new utterance is starting. Flushes the
   * client-side lookback ring buffer FIRST so the server has the
   * ~500ms of speech that the browser's SpeechRecognition VAD
   * swallows before emitting its first interim. Then begins live
   * streaming.
   */
  startUtterance(speculationId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'start', speculationId }));
    const lookback = this.drainLookback();
    if (lookback && lookback.length > 0) {
      try {
        this.ws.send(lookback.buffer);
      } catch {
        /* ignore send-on-close */
      }
    }
    this.capturing = true;
  }

  /** Tell the server the user stopped. Triggers the final transcript. */
  endUtterance(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.capturing = false;
    this.resetLookback();
    this.ws.send(JSON.stringify({ type: 'end' }));
  }

  /** User cancelled / bargein — drop speculation, reset buffer. */
  abortUtterance(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.capturing = false;
    this.resetLookback();
    this.ws.send(JSON.stringify({ type: 'abort' }));
  }

  private writeLookback(samples: Float32Array): void {
    const ring = this.lookback;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      ring[this.lookbackWrite] = samples[i]!;
      this.lookbackWrite++;
      if (this.lookbackWrite >= this.lookbackSize) {
        this.lookbackWrite = 0;
        this.lookbackFilled = true;
      }
    }
  }

  /**
   * Return a linearized copy of the lookback ring's contents in
   * chronological order, then reset the ring so the NEXT utterance
   * doesn't re-send this utterance's tail.
   */
  private drainLookback(): Float32Array | null {
    if (this.lookbackSize === 0) return null;
    const validLen = this.lookbackFilled ? this.lookbackSize : this.lookbackWrite;
    if (validLen === 0) return null;
    const out = new Float32Array(validLen);
    if (this.lookbackFilled) {
      // Ring has wrapped: oldest sample is at lookbackWrite, newest at lookbackWrite-1.
      const tailLen = this.lookbackSize - this.lookbackWrite;
      out.set(this.lookback.subarray(this.lookbackWrite), 0);
      out.set(this.lookback.subarray(0, this.lookbackWrite), tailLen);
    } else {
      out.set(this.lookback.subarray(0, this.lookbackWrite));
    }
    this.resetLookback();
    return out;
  }

  private resetLookback(): void {
    this.lookbackWrite = 0;
    this.lookbackFilled = false;
  }

  close(): void {
    this.capturing = false;
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    this.workletNode = null;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

/**
 * Simple decimating downsampler from the source rate to 16 kHz mono.
 * Skips anti-aliasing filter for speed — Whisper is tolerant of mild
 * aliasing noise and the latency budget is tight.
 */
function downsampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_RATE) return input;
  if (sourceRate < TARGET_RATE) return input; // no upsampling
  const ratio = sourceRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * ratio;
    const a = Math.floor(s);
    const b = Math.min(input.length - 1, a + 1);
    const frac = s - a;
    out[i] = input[a]! * (1 - frac) + input[b]! * frac;
  }
  return out;
}
