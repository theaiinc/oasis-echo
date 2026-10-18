/**
 * DeepFilterNet3 noise suppression on the mic, in an AudioWorklet
 * (@lofcz/deepfilternet-web: libDF compiled to WASM SIMD, weights baked in).
 * It removes background noise — traffic, fans, a café's clatter and chatter
 * at a distance — and keeps the voice, so the VAD can hear the gaps between
 * the user's words and the server's STT gets cleaner audio. About 2% of one
 * core in real time.
 *
 * The model runs at 48 kHz and the worklet doesn't resample, so the
 * AudioContext must run at 48 kHz (VoiceSession creates it that way when the
 * filter is on). The worklet script and the wasm come from the app's own
 * server (`workletUrl`, `wasmUrl`), not a CDN.
 */

export type NoiseFilterOpts = {
  /** The package's AudioWorklet script (`worklet.js`). */
  workletUrl: string;
  /** The package's wasm (`df_bg.wasm`, ~34 MB, 13 MB gzipped). */
  wasmUrl: string;
  /**
   * How far noise may be turned down, in dB. 100 removes all it can; lower
   * keeps a little of the room, which sounds more natural but leaves the VAD
   * more to ignore. Default 100.
   */
  attenuationLimit?: number;
};

export type NoiseFilter = {
  /** The filtered mic: connect everything that listens to it here. */
  output: AudioNode;
  setEnabled(enabled: boolean): void;
  destroy(): void;
};

/** 48 kHz: the only rate the DeepFilterNet3 model runs at. */
export const NOISE_FILTER_SAMPLE_RATE = 48000;

/** The wasm is compiled once per page; later sessions reuse it. */
let compiled: Promise<WebAssembly.Module> | null = null;

export async function createNoiseFilter(
  ctx: AudioContext,
  source: AudioNode,
  opts: NoiseFilterOpts,
): Promise<NoiseFilter> {
  if (ctx.sampleRate !== NOISE_FILTER_SAMPLE_RATE) {
    throw new Error(`noise filter needs a ${NOISE_FILTER_SAMPLE_RATE} Hz AudioContext (got ${ctx.sampleRate})`);
  }
  compiled ??= WebAssembly.compileStreaming(fetch(opts.wasmUrl)).catch((err) => {
    compiled = null;
    throw err;
  });
  const [wasmModule] = await Promise.all([compiled, ctx.audioWorklet.addModule(opts.workletUrl)]);
  const node = new AudioWorkletNode(ctx, 'deepfilternet-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { wasmModule, attenuationLimit: opts.attenuationLimit ?? 100 },
  });
  source.connect(node);
  return {
    output: node,
    setEnabled: (enabled) => node.port.postMessage({ type: 'setEnabled', value: enabled }),
    destroy: () => {
      try { source.disconnect(node); } catch { /* already gone */ }
      try { node.disconnect(); } catch { /* already gone */ }
    },
  };
}
