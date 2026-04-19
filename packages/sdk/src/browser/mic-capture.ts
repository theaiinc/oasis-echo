export type MicCaptureOpts = {
  /** Length of the rolling PCM buffer in seconds. Default 8. */
  ringSeconds?: number;
};

const WORKLET_CODE =
  "class PcmCapture extends AudioWorkletProcessor {" +
  "  process(inputs){const c=inputs[0]&&inputs[0][0];" +
  "    if(c&&c.length)this.port.postMessage(c.slice(0));" +
  "    return true;}}" +
  "registerProcessor('pcm-capture',PcmCapture);";

/**
 * MicCapture — off-main-thread PCM ring buffer fed by an AudioWorklet.
 *
 * Attaches to a `MediaStreamAudioSourceNode` (caller provides the
 * stream + AudioContext) and writes continuous PCM frames into a
 * ring buffer sized for the last N seconds. At any point, callers can
 * snapshot the tail for classification / debugging / replay.
 *
 * The worklet is created from an inline Blob URL so there's no
 * separate file to serve. Falls back silently if the browser doesn't
 * support AudioWorklet.
 *
 * Deliberately NOT a ScriptProcessorNode — that ran on the main thread
 * and stalled the barge-in volume monitor's rAF loop.
 */
export class MicCapture {
  private readonly ringSeconds: number;
  private ring: Float32Array | null = null;
  private writeIdx = 0;
  private sourceRate = 0;
  private node: AudioWorkletNode | null = null;
  private connected = false;

  constructor(opts: MicCaptureOpts = {}) {
    this.ringSeconds = opts.ringSeconds ?? 8;
  }

  /** Whether the ring buffer is initialized and receiving audio. */
  get isActive(): boolean {
    return this.connected && this.ring !== null;
  }

  /** Current capture sample rate (== AudioContext sample rate). */
  get sampleRate(): number {
    return this.sourceRate;
  }

  /** Start capturing from a source. Idempotent. */
  async start(opts: {
    audioContext: AudioContext;
    source: AudioNode;
  }): Promise<void> {
    if (this.connected) return;
    const ctx = opts.audioContext;
    this.sourceRate = ctx.sampleRate;
    this.ring = new Float32Array(this.ringSeconds * this.sourceRate);
    this.writeIdx = 0;

    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_CODE], { type: 'text/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    this.node = new AudioWorkletNode(ctx, 'pcm-capture');
    this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.writeFrame(ev.data);
    opts.source.connect(this.node);
    // Worklet output is NOT connected anywhere — we only want to read the
    // frames, not mix them into the destination.
    this.connected = true;
  }

  /** Snapshot the last `durationSec` of audio as a Float32Array in [-1,1]. */
  snapshot(durationSec: number): Float32Array | null {
    const ring = this.ring;
    if (!ring || !this.sourceRate) return null;
    const want = Math.min(ring.length, Math.floor(durationSec * this.sourceRate));
    if (want < this.sourceRate) return null; // need ≥ 1s of audio
    const out = new Float32Array(want);
    let read = (this.writeIdx - want + ring.length) % ring.length;
    for (let i = 0; i < want; i++) {
      out[i] = ring[read]!;
      read = (read + 1) % ring.length;
    }
    return out;
  }

  /** Stop capture and release resources. */
  stop(): void {
    this.node?.port.close();
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.node = null;
    this.ring = null;
    this.connected = false;
  }

  private writeFrame(input: Float32Array): void {
    const ring = this.ring;
    if (!ring) return;
    const n = input.length;
    for (let i = 0; i < n; i++) {
      ring[this.writeIdx] = input[i]!;
      this.writeIdx = (this.writeIdx + 1) % ring.length;
    }
  }
}

/**
 * Simple linear-interpolation resampler to 16kHz (SER model's native
 * rate). Good enough for phonetic-level features; low-pass anti-alias
 * filter skipped for simplicity.
 */
export function resampleTo16k(pcm: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16000) return pcm;
  const ratio = sourceRate / 16000;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * ratio;
    const a = Math.floor(s);
    const b = Math.min(pcm.length - 1, a + 1);
    const frac = s - a;
    out[i] = pcm[a]! * (1 - frac) + pcm[b]! * frac;
  }
  return out;
}
