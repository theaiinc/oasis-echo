// node gen_en.mjs jobs.json  — jobs: [[relpath, text, voice, speed], ...]
import { KokoroTTS } from '/Users/stevetran/echo-hosted/node_modules/kokoro-js/dist/kokoro.js';
import fs from 'fs'; import path from 'path';
const OUT = '/Volumes/Data/dev/wakeword-arion/tts';
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
let n = 0;
for (const [rel, text, voice, speed] of jobs) {
  const p = path.join(OUT, rel);
  if (fs.existsSync(p)) continue;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const a = await tts.generate(text, { voice, speed });
  await a.save(p);
  if (++n % 50 === 0) console.log('done', n);
}
console.log('ALL DONE', n);
