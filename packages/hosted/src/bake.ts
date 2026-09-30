/**
 * Image build step: synthesize the fixed lines once so a cold start plays them at
 * once instead of spending minutes of CPU on them. Usage: node dist/bake.js <file>
 */
import { allFillerPhrases } from '@oasis-echo/orchestrator';
import { BACKCHANNELS, bakePhrases } from './voice.js';

const file = process.argv[2];
if (!file) throw new Error('usage: bake.js <file>');
const count = await bakePhrases(file, [...allFillerPhrases(), ...BACKCHANNELS]);
console.log(`baked ${count} phrases into ${file}`);
// Kokoro's phonemizer exits 7 on teardown; leave cleanly.
process.exit(0);
