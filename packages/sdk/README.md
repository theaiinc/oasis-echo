# @oasis-echo/sdk

Client SDK for the [oasis-echo](https://github.com/theaiinc/oasis-echo) voice AI server. Works in **browsers and Node.js** — same `OasisClient` API, same typed event map, same correction / turn / barge-in endpoints.

Use it to:
- Wire the agent into a **Slack bot / Discord bot / CLI** (text-in, text-out, listen to emotion directives for downstream TTS).
- Bridge the agent to **Twilio / Vonage / LiveKit** IVR (forward SSML + directives to their TTS).
- Build a **custom browser UI** — the pre-built `AudioPlayer` / `MicCapture` / `EmotionDetector` / `BargeInMonitor` do the heavy Web-Audio lifting.
- Run **scripted tests and replay harnesses** — deterministic `TurnDebouncer` and `scheduleChunk()` make it easy to assert behavior without a real mic.

## Install

```bash
npm i @oasis-echo/sdk
# optional, only if you want the browser SER classifier
npm i @huggingface/transformers
```

## Quick start — Node (text-only)

```ts
import { OasisClient } from '@oasis-echo/sdk';

const client = new OasisClient({ baseUrl: 'http://localhost:3001' });

client.on('tts.chunk',        (p) => console.log('[tts]', p.text));
client.on('turn.summary',     (p) => console.log('[turn]', p.intent, p.latencyMs + 'ms'));
client.on('emotion.directives', (p) => console.log('[emo]', p.effective, p.strategy));

client.connect();
await client.sendTurn({ text: 'what time is it' });
// Attach an emotion payload when your own classifier has detected one:
await client.sendTurn({
  text: 'this is not working',
  emotion: { label: 'ANG', confidence: 0.82 },
});
```

Full Node example: [examples/node-text-only.ts](./examples/node-text-only.ts).

## Quick start — Browser (full voice stack)

```ts
import { OasisClient, TurnDebouncer } from '@oasis-echo/sdk';
import { AudioPlayer, MicCapture, EmotionDetector, BargeInMonitor }
  from '@oasis-echo/sdk/browser';

const client = new OasisClient({ baseUrl: '' });        // same origin
const audioCtx = new AudioContext();
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const source = audioCtx.createMediaStreamSource(stream);

const player = new AudioPlayer({ audioContext: audioCtx });
const mic = new MicCapture();
await mic.start({ audioContext: audioCtx, source });
const emo = new EmotionDetector();
emo.preload();

let agentSpeaking = false;
new BargeInMonitor({
  isActive: () => agentSpeaking,
  onBargeIn: () => { player.stopAll(); client.bargeIn(); },
}).start(source);

client.on('tts.chunk', (p) => {
  agentSpeaking = true;
  if (p.audio) player.playPcm(p.audio, p.sampleRate, { turnId: p.turnId, filler: p.filler });
});
client.on('emotion.directives', (p) => player.setDirectives(p.turnId, p.directives));
client.on('turn.complete',      (p) => { agentSpeaking = false; player.forgetDirectives(p.turn.id); });
client.connect();

const deb = new TurnDebouncer({
  silenceMs: 1200,
  onCommit: async (text) => {
    const pcm = mic.snapshot(5);
    const detected = pcm ? await emo.classify(pcm, mic.sampleRate, { timeoutMs: 300 }) : null;
    await client.sendTurn({
      text,
      ...(detected ? { emotion: { label: detected.label, confidence: detected.confidence } } : {}),
    });
  },
});
```

Full browser example: [examples/browser.ts](./examples/browser.ts).

## API surface

### `OasisClient`

| Method | Use |
|---|---|
| `connect()` | Open the `/events` SSE stream. Idempotent. |
| `close()` | Close the SSE stream and release listeners. |
| `on(event, handler)` | Subscribe. Returns an unsubscribe function. |
| `off(event, handler)` | Remove a handler. |
| `sendTurn({ text, emotion? })` | `POST /turn`. Returns `{ accepted: true }`. |
| `sendCorrection({ original, corrected })` | `POST /correction`. Server classifies the diff. |
| `getCorrections()` | `GET /corrections` — snapshot of learned rules + phrases + history. |
| `bargeIn()` | `POST /bargein`. Interrupts the in-flight reply. |
| `getBackchannel()` | `GET /backchannel` — pre-synthesized "still listening" clip. |
| `getConfig()` | `GET /config` — server's backend / model / voice snapshot. |

### Typed event map

```
user.input            { turnId, text, emotion?, atMs }
stt.partial           { turnId, text, atMs }
stt.final             { turnId, text, atMs }
stt.postprocess       { turnId, original, final, stages, history, latencyMs, atMs }
route.decision        { turnId, decision: { kind, intent, reply? }, atMs }
tts.chunk             { turnId, text, sampleRate, final, filler, audio?, atMs }
turn.complete         { turn: { id, tier, intent, interrupted, userText, agentText, ... } }
turn.summary          { turnId, tier, intent, interrupted, latencyMs }
bargein               { turnId?, interruptedTurnId?, atMs }
emotion.directives    { turnId, source, detected, effective, strategy, directives, styleTags, rationale, atMs }
error                 { source, error, atMs }
```

Each event arrives typed — `client.on('emotion.directives', (e) => ...)` gives you a fully-typed `EmotionDirectivesEvent`.

### `TurnDebouncer`

Accumulates `isFinal` fragments from the browser's `SpeechRecognition` and commits the whole utterance after sustained silence. Doubles the silence window when the tail is an incomplete-thought fragment (`"but"`, `"and"`, `"what if"`, …).

```ts
const deb = new TurnDebouncer({
  silenceMs: 1200,
  incompleteTailMultiplier: 2,
  onCommit: (text) => client.sendTurn({ text }),
});
deb.onInterim('hello');
deb.onFinal('hello there');
deb.flush();    // commit now
deb.cancel();   // discard buffer
```

### `scheduleChunk()`

Pure function that turns a PCM chunk's duration + optional emotion directives into a concrete Web Audio schedule. Useful even if you're not using the browser `AudioPlayer`.

```ts
import { scheduleChunk } from '@oasis-echo/sdk';

const plan = scheduleChunk({
  ctxTime: audioCtx.currentTime,
  queueEndsAt,
  chunkDurationSec: buffer.duration,
  directives,
});
src.playbackRate.value = plan.playbackRate;
src.start(plan.startAt);
queueEndsAt = plan.endAt;
```

### Browser helpers (`@oasis-echo/sdk/browser`)

- **`AudioPlayer`** — Web Audio playback with per-turn emotion directives (playback rate, composed gain, inter-chunk silence). Applies `scheduleChunk` under the hood.
- **`MicCapture`** — off-main-thread PCM ring buffer via an inline `AudioWorklet`. Exposes `snapshot(durationSec)` for classification / replay. Ships a `resampleTo16k()` helper.
- **`EmotionDetector`** — wraps `@huggingface/transformers` `audio-classification` pipeline with pre-warm, race-against-timeout classify, confidence floor + margin gate, and the "only-high-arousal-labels" filter that keeps casual speech from always reading as `sad`.
- **`BargeInMonitor`** — adaptive volume-monitor barge-in detector with dynamic baseline (tracks ambient mic RMS while the agent is speaking and fires when user voice exceeds the baseline × multiplier).

## Platform notes

- **SSE transport**: the SDK auto-detects `globalThis.EventSource` (native in browsers). In Node (20+) it falls back to a streaming `fetch` body reader — no extra dep required. Pass `eventSourceCtor` to override with the [`eventsource`](https://www.npmjs.com/package/eventsource) npm package if you want its reconnect semantics.
- **`fetch`**: Node 18+ ships a native `fetch`. For older runtimes, pass your own via `new OasisClient({ fetch: customFetch })`.
- **Zero coordinator dep**: the SDK does not import `@oasis-echo/coordinator` or any other server package. It carries its own minimal type definitions that mirror the server's SSE payloads.
- **`@huggingface/transformers` is a peer dep**: only required if you use `EmotionDetector` (browser). Node / headless usage doesn't need it.

## Deferred (phase 2)

- Node audio adapter (wraps `node-speaker` / file-out). For now, Node usage is text-in / directive-out.
- Web Worker-based SSE reader for zero-main-thread overhead.

## License

MIT.
