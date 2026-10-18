// Offline check of the browser noise pipeline on a recording: DeepFilterNet3
// (the same wasm the SDK loads) → 16 kHz → Silero VAD v5 (the same model) and
// the server's STT (/stt/clip). Prints, per variant, where the VAD hears speech
// and the transcript, so raw and filtered can be compared.
//
//   node experiments/noise/eval.mjs <audio file> [server=http://localhost:9187]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ort from 'onnxruntime-node';
import { DeepFilter } from '@lofcz/deepfilternet-web';

const require = createRequire(import.meta.url);
const [file, server = 'http://localhost:9187'] = process.argv.slice(2);
if (!file) throw new Error('usage: eval.mjs <audio file> [server]');

const decode = (args, input) =>
  new Float32Array(new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', ...args, '-f', 'f32le', '-'], { input, maxBuffer: 1 << 30 })).buffer);
const at48 = decode(['-i', file, '-ac', '1', '-ar', '48000']);
const to16 = (pcm48) => decode(['-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', '-', '-ar', '16000'], Buffer.from(pcm48.buffer));

async function deepFilter(pcm, attenuationLimit) {
  const wasm = readFileSync(require.resolve('@lofcz/deepfilternet-web').replace(/index\.js$/, 'df_bg.wasm'));
  const df = await DeepFilter.create({ wasmUrl: `data:application/wasm;base64,${wasm.toString('base64')}`, attenuationLimit });
  const out = new Float32Array(pcm.length);
  const started = performance.now();
  for (let i = 0; i + df.frameLength <= pcm.length; i += df.frameLength) out.set(df.process(pcm.subarray(i, i + df.frameLength)), i);
  const ms = performance.now() - started;
  df.destroy();
  return { out, rtf: ms / ((pcm.length / 48000) * 1000) };
}

const silero = await ort.InferenceSession.create(require.resolve('@ricky0123/vad-web/dist/silero_vad_v5.onnx'));
async function vadSegments(pcm16, { on = 0.5, off = 0.35, minSilenceMs = 700 } = {}) {
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]));
  const segs = [];
  let start = -1, lastSpeech = 0, speechMs = 0;
  for (let i = 0; i + 512 <= pcm16.length; i += 512) {
    const r = await silero.run({ input: new ort.Tensor('float32', pcm16.slice(i, i + 512), [1, 512]), state, sr });
    state = r.stateN;
    const p = r.output.data[0], t = (i / 16000) * 1000;
    if (p >= on) speechMs += 32;
    if (start < 0 && p >= on) start = t;
    if (p >= off) lastSpeech = t + 32;
    if (start >= 0 && t - lastSpeech >= minSilenceMs) { segs.push([start, lastSpeech]); start = -1; }
  }
  if (start >= 0) segs.push([start, (pcm16.length / 16000) * 1000]);
  return { segs, speechMs };
}

async function stt(pcm16) {
  const res = await fetch(`${server}/stt/clip`, { method: 'POST', body: Buffer.from(pcm16.buffer) });
  return res.ok ? (await res.json()).text : `(stt ${res.status})`;
}

const variants = [['raw', at48, null]];
for (const lim of [100, 30]) {
  const { out, rtf } = await deepFilter(at48, lim);
  variants.push([`deepfilter ${lim} dB`, out, rtf]);
}
const secs = (ms) => (ms / 1000).toFixed(1);
for (const [name, pcm48, rtf] of variants) {
  const pcm16 = to16(pcm48);
  const { segs, speechMs } = await vadSegments(pcm16);
  console.log(`\n== ${name}${rtf ? ` (real-time factor ${rtf.toFixed(2)})` : ''}`);
  console.log(`VAD speech ${secs(speechMs)} s of ${secs((pcm16.length / 16000) * 1000)} s; turns: ${segs.map(([a, b]) => `${secs(a)}–${secs(b)}`).join(', ')}`);
  console.log(`STT: ${await stt(pcm16)}`);
}
