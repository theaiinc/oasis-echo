# Emotion-Adaptive TTS

Turns a detected user emotion plus the agent's reply text into engine-neutral TTS directives (playback rate, gain, inter-chunk silence, pitch) and an SSML fragment for SSML-capable engines. Designed around one principle from the spec:

> Make the user feel understood, not copied.

Full mirroring of frustration sounds aggressive; empathy acknowledges the feeling while staying calm. The strategy resolver enforces that automatically.

## Architecture

```
 mic PCM (8s ring, AudioWorklet)            transcript text
        │                                         │
        ▼                                         ▼
 transformers.js SER pipeline          detectEmotionFromText
 (onnx-community/Speech-Emotion-        (keyword / regex rules)
  Classification-ONNX, ~91MB q8)
        │                                         │
        ▼                                         ▼
   acoustic label                            text label
   (high-arousal only —                  (meaning-driven —
    sad/neutral/calm                      sad/frustrated/
    filtered client-side)                 confused/urgent)
              \                                  /
               └──── fusion policy ──────────────┘
                          │
                          ▼
 ┌────────────────────────────────────────────────────────────────┐
 │                     EmotionAdaptiveTts                         │
 │                                                                │
 │   EmotionMapper   →   StrategyResolver   →   TtsAdapter        │
 │   (base params        (mirror / soften /     (directives +     │
 │    per emotion)        counterbalance;        SSML fragment)   │
 │                        confidence gate;                        │
 │                        negative-streak                         │
 │                        smoothing;                              │
 │                        empathetic-mirroring                    │
 │                        override;                               │
 │                        text-source →                           │
 │                        auto-soften)                            │
 └────────────────────────────────────────────────────────────────┘
                          │
                          ▼
             emotion.directives SSE event
                          │
                          ▼
         client playPcm() applies per chunk:
           • src.playbackRate       (rate)
           • GainNode gain          (volume)
           • audioQueueEndsAt += ms (inter-chunk silence)
```

## Detection: complementary signals

Acoustic SER and text meaning have **opposite strengths**. We run both and fuse.

### Acoustic (SER model)

Strong on **arousal-driven** emotions — happy / surprise / angry / fear / disgust — where tone, energy, and pitch carry the signal. Weak on meaning-driven emotions where the acoustic signature overlaps with baseline conversational speech.

In [packages/app/src/index.html](../packages/app/src/index.html):

- **Audio capture**: `AudioWorklet` (inline via Blob URL) feeds a rolling 8-second `Float32Array` ring buffer from the same `getUserMedia` stream the volume monitor uses. Off-main-thread so it doesn't stall the volume monitor's baseline and cause false-positive barge-ins.
- **Pre-warm on voice start**: `ensureEmotionPipeline()` is kicked off when voice mode is enabled, so the ~91MB ONNX is loading/ready before the first utterance.
- **Pre-fetch during debounce**: `scheduleTurnCommit()` starts inference the moment a final STT fragment lands. By the time the turn-end debounce fires (1.2s later), the classifier result is usually already waiting — no visible commit-time hang.
- **Commit-time cap**: `commitTurn()` waits at most `EMOTION_COMMIT_WAIT_MS` (300ms) for the pre-fetched result. Past that, the turn ships with no emotion and we fall through to text fallback + neutral mirror.
- **Client-side filters**:
  1. `top1 >= 0.7` AND `top1 − top2 >= 0.15` — both confidence floor and margin gate.
  2. Ignore `sad` / `neutral` / `calm` predictions regardless of confidence — the model over-fits to acted data and consistently mis-reads casual speech as sad with 0.95+ confidence. Only high-arousal labels (`happy`, `surprise`, `angry`, `fear`, `disgust`) pass through.
- **Kill switch**: `http://localhost:3001/?noemotion=1` disables the entire client-side pipeline for quick A/B comparison.

### Text (server-side rule engine)

Strong on **meaning-driven** emotions — sad / frustrated / confused / urgent — that live in the words, not the tone. In [packages/coordinator/src/emotion/text.ts](../packages/coordinator/src/emotion/text.ts):

- Keyword + regex rules per emotion, each with a per-rule confidence weight and a bonus when multiple rules match the same emotion.
- Rules deliberately conservative. Example: `urgent` requires unambiguous words (`asap`, `urgent`, `hurry`, `emergency`) or `right now` paired with a need/action verb — bare `right now` ("I'm right now trying to X") does NOT fire. `quickly` / `immediately` alone were dropped for the same reason.
- Returns `{ emotion, confidence, matched }` or `null`.

### Fusion policy

In [packages/app/src/server.ts](../packages/app/src/server.ts), `/turn` runs both signals and picks:

1. **If acoustic forwarded a label** → trust it by default. Already filtered through the over-predict-sad guard, so when it fires it's meaningful.
2. **Text override** → when a meaning-driven text signal (`sad` / `frustrated` / `confused` / `urgent`) has confidence at least 0.1 higher than the acoustic read, the text label wins. Catches the "the user said 'I'm sad' calmly" case.
3. **Acoustic missing → text alone** → if acoustic returned nothing (filtered out or no-signal), forward whatever text detected.
4. **Both missing → no adaptation**. Server does NOT broadcast `emotion.directives` and the client plays the reply at baseline.
5. **Text-source → auto-soften**. When the emotion came from text (weaker signal — we're inferring from words, not tone), the strategy defaults to `soften` even for emotions that would normally `mirror`. A client-explicit `strategy` still wins. Pulls parameters partway toward neutral so the adaptation is a gentle tint, not a whiplash.

Every `emotion.adapted` log line records the `source: "acoustic" | "text"` and, for text, the matched cues — so you can always see why a given turn adapted the way it did.

## Server-side adaptation

In [packages/coordinator/src/emotion/](../packages/coordinator/src/emotion/):

### EmotionMapper

Baseline parameters per emotion. Negative emotions already have softened baselines so even `mirror` doesn't amplify anger. Selected rows:

| Emotion     | Rate  | Pitch | Volume | Intonation | Pauses   |
|-------------|-------|-------|--------|------------|----------|
| neutral     | 1.00  |  0    | 1.00   | flat       | natural  |
| happy       | 1.14  | +3    | 1.00   | dynamic    | short    |
| surprise    | 1.10  | +2    | 1.00   | dynamic    | natural  |
| sad         | 0.88  | -2    | 0.92   | soft       | extended |
| angry       | 0.85  | -2    | 0.88   | soft       | extended |
| frustrated  | 0.87  | -2    | 0.90   | soft       | extended |
| confused    | 0.85  |  0    | 1.00   | soft       | extended |
| urgent      | 1.12  | +1    | 1.00   | flat       | short    |

Pause patterns map to inter-chunk silence in the adapter:

| Pattern  | ms  |
|----------|-----|
| short    | 30  |
| natural  | 100 |
| extended | 180 |

### StrategyResolver

Five gates, applied in order:

1. **Confidence floor (default 0.5)** — low-confidence reads degrade to `neutral`, no over-correction on noise.
2. **Negative-streak smoothing (default 2-of-3)** — if the last 3 turns read ≥ 2 negatives, one lucky-neutral classification doesn't flip the agent back to cheerful.
3. **Empathetic-mirroring override** — `mirror` on a negative emotion silently upgrades to `soften`. Disable via `empatheticMirroringOverride: false` (not recommended).
4. **Text-source auto-soften** (applied in server.ts before calling `adapt`) — when the emotion came from text rules rather than acoustic, default to `soften` regardless of valence. Acoustic tone is a stronger signal of real emotion; text alone justifies a lighter touch.
5. **Strategy blend** — `soften` pulls 30% toward neutral for negative-valence baselines (preserves empathetic flavor) and 60% toward neutral for positive-valence baselines (dampens over-excitement). `counterbalance` actively moves opposite to the user's valence (agitated user → visibly calm agent).

Every resolve returns a `rationale` string like `emotion=frustrated; strategy=mirror→soften (empathetic override)` so behavior is inspectable in logs (see `emotion.adapted` log line in server.ts).

### TtsAdapter

Two outputs per call:

- **Directives** (engine-neutral, what Kokoro uses):
  ```json
  {
    "playbackRate": 0.92,
    "gain": 0.92,
    "interChunkSilenceMs": 280,
    "pitchSemitones": -1
  }
  ```
- **SSML** (for Azure / Google / Polly / ElevenLabs, if/when we add them):
  ```xml
  <speak>
    <!-- style: empathetic, patient, supportive -->
    <prosody rate="92%" pitch="-1st" volume="medium">
      I hear you.<break time="280ms"/>
      Let me help.<break time="280ms"/>
    </prosody>
  </speak>
  ```

## Sample outputs

### 1. Frustrated user → calm empathetic reply

```js
const { output, directives } = new EmotionAdaptiveTts().adapt({
  text: 'I understand, let me help you with that.',
  emotion: 'frustrated',
  confidence: 0.85,
});
```

```json
{
  "output": {
    "effectiveEmotion": "frustrated",
    "strategyApplied": "soften",
    "styleTags": ["empathetic", "patient", "supportive"],
    "rationale": "emotion=frustrated; strategy=mirror→soften (empathetic override)",
    "ttsParameters": {
      "speakingRate": 0.968,
      "pitch": -0.4,
      "volume": 0.968,
      "intonation": "soft",
      "pausePattern": "extended"
    }
  },
  "directives": {
    "playbackRate": 0.968,
    "gain": 0.968,
    "interChunkSilenceMs": 280,
    "pitchSemitones": 0
  }
}
```

### 2. Happy user → mirror energy honestly

```js
adapt({ text: "That's great to hear!", emotion: 'happy', confidence: 0.9 });
```

```
strategyApplied: 'mirror'
ttsParameters.speakingRate: 1.08
ttsParameters.intonation: 'dynamic'
interChunkSilenceMs: 40
```

### 3. Confused user → slower, clearer

```js
adapt({ text: 'Let me explain that again.', emotion: 'confused', confidence: 0.8 });
```

```
ttsParameters.speakingRate: 0.90
ttsParameters.intonation: 'soft'
ttsParameters.pausePattern: 'extended'
styleTags: ['patient', 'reassuring']
```

### 4. Low-confidence classification → neutral fallback

```js
adapt({ text: 'OK.', emotion: 'angry', confidence: 0.2 });
```

```
effectiveEmotion: 'neutral'     // below confidence floor
rationale: 'confidence below floor → neutral (requested angry); strategy=mirror'
```

## Integration examples

### Kokoro (current, in-repo)

Client applies directives at playback time in [playPcm()](../packages/app/src/index.html):

```js
const dir = directivesByTurn.get(opts.turnId);
if (dir && dir.playbackRate !== 1) src.playbackRate.value = dir.playbackRate;
// ...gain chain...
const extraSilenceSec = (dir.interChunkSilenceMs ?? 0) / 1000;
const startAt = Math.max(ctx.currentTime, audioQueueEndsAt + extraSilenceSec);
```

Pitch-shift in phase 1 is passthrough (Kokoro PCM isn't pitch-shifted locally — would need a phase vocoder). Voice preset swap (`af_heart` vs `af_bella`) is a cheap coarse affect knob we can wire up later via `voiceHint`.

### Azure Speech / Google Cloud TTS (future)

```ts
const { directives } = adapter.adapt(input);
const result = await azureClient.synthesize({ ssml: directives.ssml });
```

The `<prosody>` and `<break>` tags are Azure/Google-compatible as-is. `style:` comment carries Azure's `express-as` hints for the speaker style.

### ElevenLabs

ElevenLabs accepts stability / similarity / style parameters, not SSML. Map from directives:

```ts
const params = {
  stability: dir.gain < 0.95 ? 0.6 : 0.4,      // softer delivery = more stable
  style: dir.playbackRate > 1.05 ? 0.8 : 0.3,  // faster = more expressive
};
```

## Extensibility

- **Custom emotion mappings** — pass overrides to the constructor:
  ```ts
  new EmotionAdaptiveTts({
    mapperOverrides: {
      params: { happy: { speakingRate: 1.12, pitch: 3 } },
      styles: { sad: ['empathetic', 'warm', 'slow'] }
    }
  });
  ```
- **Custom strategy thresholds** — `new StrategyResolver(mapper, { confidenceFloor: 0.6, negativeStreakOf: { n: 3, of: 4 } })`.
- **Add a new emotion** — extend the `Emotion` union, add rows to `BASE_PARAMS` and `BASE_STYLES` in [mapper.ts](../packages/coordinator/src/emotion/mapper.ts), and (optionally) a `normalizeSerLabel` rule in [facade.ts](../packages/coordinator/src/emotion/facade.ts).
- **Different SER classifier** — swap the model ID in [index.html](../packages/app/src/index.html); any transformers.js-compatible `audio-classification` pipeline works if its labels collapse into the 8-class set via `normalizeSerLabel`.

## Safety properties (guaranteed by tests)

- For every strategy on `angry` / `frustrated`: `speakingRate ≤ 1.0`, `volume ≤ 1.0`, `intonation ≠ 'dynamic'`. Covered by `emotion.test.ts :: never amplifies anger`.
- Confidence below floor always degrades to `neutral`. Covered by `emotion.test.ts :: gates low-confidence reads to neutral`.
- Parameters clamped into `[rate 0.7..1.3, pitch -4..+4, volume 0.6..1.0]` after blend. Covered by `clampParams` tests.
- `finalText` always ends with sentence punctuation so TTS chunking behaves.

29 tests in [packages/coordinator/test/emotion.test.ts](../packages/coordinator/test/emotion.test.ts).
