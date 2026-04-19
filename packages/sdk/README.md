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
  // 600ms grace window after `isActive` flips true — keeps the
  // adaptive baseline from tripping on the FIRST frames of agent TTS
  // (residual echo bleeding through AEC) before it has a chance to
  // stabilize. Lowered or raised per your environment.
  graceMs: 600,
  onBargeIn: () => { player.stopAll(); client.bargeIn(); },
}).start(source);

client.on('tts.chunk', (p) => {
  agentSpeaking = true;
  // `AudioPlayer` owns audio for the whole turn. DO NOT fall through
  // to `speechSynthesis.speak()` on chunks without PCM — Kokoro-style
  // backends stream one sentence per chunk and can emit an empty one
  // mid-turn; letting synth pick up that gap causes two TTS voices
  // to overlap.
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
- **`BargeInMonitor`** — adaptive volume-monitor barge-in detector with a dynamic baseline (tracks ambient mic RMS while the agent is speaking and fires when user voice exceeds the baseline × multiplier). Options include `baselineMultiplier` (default 1.6), `absoluteFloor` (6), `holdMs` (100 — minimum sustained-speech time above threshold), and **`graceMs` (600 — observe-but-don't-fire window right after `isActive()` flips true, so the baseline can stabilize around the agent's first-frame bleed instead of false-triggering on it)**.

## Behavioural invariants

Things the SDK deliberately prevents — each one is a real bug we've hit:

- **Single TTS path per turn.** Once `AudioPlayer.playPcm` has been called for a turn, your `tts.chunk` handler should NEVER fall through to `speechSynthesis.speak()` on chunks that happen to arrive without PCM — Kokoro-style backends stream sentence-by-sentence and can emit a gap chunk mid-turn. Letting synth cover that gap plays two agent voices simultaneously.
- **`fetch` is called bound.** `OasisClient` wraps the default `fetch` in a closure so the browser doesn't throw `Illegal invocation` when calling it off a plain-object owner. If you pass your own `fetch`, make sure it's already bound.
- **Barge-in grace window.** `BargeInMonitor` observes-but-doesn't-fire for the first `graceMs` after `isActive()` flips true, so the first frames of agent-TTS bleed can't trip an adaptive baseline that hasn't stabilized yet.
- **Empty reply → no stuck UI.** Reflex-tier intents (`confirm`, `acknowledge`) can return an empty `agentText`. Callers should clear any pending/typing state and hide the reply bubble on `turn.complete` when `agentText` is empty, or the UI looks stuck.
- **Confidence + margin gate on SER.** `EmotionDetector` requires `top1 ≥ 0.7` AND `(top1 − top2) ≥ 0.15` AND top-1 in the "informative labels" set (default excludes SAD / NEUTRAL / CALM — the classes the acted-speech-trained classifier over-fires on casual English). Keeps the server-side emotion adaptation out of always-softening mode.

## Platform notes

- **SSE transport**: the SDK auto-detects `globalThis.EventSource` (native in browsers). In Node (20+) it falls back to a streaming `fetch` body reader — no extra dep required. Pass `eventSourceCtor` to override with the [`eventsource`](https://www.npmjs.com/package/eventsource) npm package if you want its reconnect semantics.
- **`fetch`**: Node 18+ ships a native `fetch`. The SDK wraps the default `fetch` in a closure internally because storing a bare reference and calling it off a non-`Window` owner throws `Illegal invocation` in browsers. If you supply `new OasisClient({ fetch: customFetch })`, we call it as-is — make sure your wrapper is already bound correctly.
- **Zero coordinator dep**: the SDK does not import `@oasis-echo/coordinator` or any other server package. It carries its own minimal type definitions that mirror the server's SSE payloads.
- **`@huggingface/transformers` is a peer dep**: only required if you use `EmotionDetector` (browser). Node / headless usage doesn't need it.
- **Importing in a raw HTML page**: use an import map. The reference wiring in [packages/app/src/index.html](../app/src/index.html) is the canonical example:

  ```html
  <script type="importmap">
    {
      "imports": {
        "@oasis-echo/sdk": "/sdk/index.js",
        "@oasis-echo/sdk/browser": "/sdk/browser/index.js",
        "@huggingface/transformers": "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.1.0"
      }
    }
  </script>
  <script type="module">
    import { OasisClient } from '@oasis-echo/sdk';
    // …
  </script>
  ```

  The server in `packages/app` already serves compiled SDK files from `/sdk/*` (see its `GET /sdk/*` handler in `server.ts`), so the HTML just needs to point the import map at the right URLs.

## Deferred (phase 2)

- Node audio adapter (wraps `node-speaker` / file-out). For now, Node usage is text-in / directive-out.
- Web Worker-based SSE reader for zero-main-thread overhead.

## License

MIT.
