/**
 * Node example: headless text-in / text-out with emotion directives.
 *
 * This is how you'd wire the agent into a Slack bot, an IVR bridge, a
 * scripted test harness, or any backend system that doesn't need
 * browser audio. You still receive emotion.directives events — apply
 * them wherever your downstream TTS engine supports prosody (Azure
 * SSML, ElevenLabs params, Twilio <prosody>, etc.) or just log them.
 *
 * Prereq: `npm install eventsource` (or use Node 18+ with a polyfill).
 *
 * Run:
 *   node --loader tsx packages/sdk/examples/node-text-only.ts
 */

import { OasisClient } from '@oasis-echo/sdk';

const baseUrl = process.env.OASIS_URL ?? 'http://localhost:3001';

const client = new OasisClient({
  baseUrl,
  // For Node, supply an EventSource impl — either the `eventsource` npm
  // package or rely on the built-in fetch fallback (works out of the box
  // on Node 18+, no extra dep required).
  // eventSourceCtor: (await import('eventsource')).default,
});

client.on('turn.summary', (p) => {
  console.log(`[turn] ${p.tier} intent=${p.intent} ${p.latencyMs}ms`);
});

client.on('tts.chunk', (p) => {
  // Strip audio bytes from logs; just show the text stream.
  console.log(`[tts] final=${p.final} text="${p.text}"`);
});

client.on('emotion.directives', (p) => {
  console.log(
    `[emotion] detected=${p.detected} (${p.source}) → strategy=${p.strategy} ` +
    `rate=${p.directives.playbackRate} gain=${p.directives.gain} ` +
    `pauses=${p.directives.interChunkSilenceMs}ms`,
  );
  // If you were wiring to Azure / ElevenLabs, this is where you'd
  // forward p.directives.ssml (Azure) or p.directives.pitchSemitones
  // + gain + rate (ElevenLabs / Polly) to the downstream TTS.
});

client.on('stt.postprocess', (p) => {
  if (p.original !== p.final) {
    console.log(`[stt] "${p.original}" → "${p.final}" via [${p.stages.join(', ')}]`);
  }
});

client.on('error', (p) => {
  console.error('[error]', p.source, p.error);
});

// Connect to the SSE stream, then fire a couple of synthetic turns.
client.connect();

async function run(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200)); // let SSE settle

  console.log('---');
  console.log('Turn 1: plain text, no emotion');
  await client.sendTurn({ text: 'What is the current time?' });
  await new Promise((r) => setTimeout(r, 8000));

  console.log('---');
  console.log('Turn 2: with an acoustic emotion payload (simulating a classifier')
  console.log('        that fired `angry` from the client side)');
  await client.sendTurn({
    text: 'This is the third time I have asked',
    emotion: { label: 'ANG', confidence: 0.82 },
  });
  await new Promise((r) => setTimeout(r, 10000));

  console.log('---');
  console.log('Turn 3: text-only. Server keyword detector picks up "frustrated"');
  console.log('        and forces `soften`.');
  await client.sendTurn({
    text: 'This is ridiculous it doesnt work and wasted my time',
  });
  await new Promise((r) => setTimeout(r, 10000));

  console.log('---');
  console.log('Teach a correction');
  const teach = await client.sendCorrection({
    original: 'send a email',
    corrected: 'send an email',
  });
  console.log('correction response:', teach);

  client.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
