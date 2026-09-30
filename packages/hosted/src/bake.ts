/**
 * Image build step: synthesize the fixed lines once so a cold start plays them at
 * once instead of spending minutes of CPU on them. Usage: node dist/bake.js <file>
 * With ECHO_VIENEU_PYTHON set, the Vietnamese lines are baked with VieNeu too.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFillerPhrases } from '@oasis-echo/orchestrator';
import { BACKCHANNELS, BACKCHANNELS_VI, bakePhrases } from './voice.js';
import { VieneuTts } from './vieneu.js';

const file = process.argv[2];
if (!file) throw new Error('usage: bake.js <file>');
const python = process.env['ECHO_VIENEU_PYTHON'];
const vi = python
  ? new VieneuTts({ python, script: join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vieneu-bridge.py') })
  : undefined;
if (vi && !(await vi.ready)) throw new Error('VieNeu did not start');
const phrases = [...allFillerPhrases(), ...BACKCHANNELS, ...(vi ? [...allFillerPhrases('vi'), ...BACKCHANNELS_VI] : [])];
const count = await bakePhrases(file, phrases, undefined, vi);
console.log(`baked ${count} phrases into ${file}${vi ? ' (with Vietnamese)' : ''}`);
vi?.close();
// Kokoro's phonemizer exits 7 on teardown; leave cleanly.
process.exit(0);
