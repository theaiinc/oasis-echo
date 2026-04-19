# Oasis Echo

[![CI](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml/badge.svg)](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Tiered hybrid voice AI — reflex / coordinator / reasoning. See [docs/SAD.md](docs/SAD.md), [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), and [docs/STT_POSTPROCESS.md](docs/STT_POSTPROCESS.md) for design details.

## Status

| Tier | Status | Backend |
|---|---|---|
| Reflex (reflex intents, barge-in arbiter, sentence chunker) | done | deterministic regex / Web Audio analyser on the client |
| Coordinator (SLM router, state machine, guardrail, TTS) | done | Ollama-backed SLM router, Kokoro-82M or web-speech TTS |
| Reasoning (tools, redaction, circuit breaker) | done | Anthropic · OpenAI-compatible · Ollama — any real backend |
| Orchestrator (event bus, pipeline, streaming fillers) | done | — |

## Layout

```
packages/
  types/         shared DialogueState, events, intents
  telemetry/     logger, metrics, tracer
  reflex/        Vad interface, endpointer, reflex intent router, barge-in detector
  coordinator/   StreamingStt/Tts interfaces, Kokoro TTS, SLM router + prompt,
                 state machine, guardrail, sentence chunker
  reasoning/     Anthropic / OpenAI / Ollama streaming clients, PII redactor,
                 tool registry, circuit breaker
  orchestrator/  typed event bus, overlapping-execution pipeline, barge-in arbiter
  app/           Node HTTP + SSE server, web UI
```

## Quick start

```bash
npm install
npm run build
npm test               # 77 tests across all packages
npm run server         # web UI at http://localhost:3000
```

Copy `.env.example` to `.env` and configure a backend (see below), then `npm run server`.

### Reasoner backends

Three options, picked in this order of precedence:

1. `OASIS_BACKEND=anthropic|ollama|openai` (explicit override)
2. `ANTHROPIC_API_KEY` set → `anthropic`
3. `OPENAI_API_KEY` set → `openai`
4. otherwise → `ollama` (assumes `http://localhost:11434`)

**Anthropic (Claude):** put `ANTHROPIC_API_KEY=sk-ant-…` in `.env`. Default model `claude-sonnet-4-6`; override with `OASIS_MODEL=…`.

**OpenAI and compatible endpoints:** set `OPENAI_API_KEY`. The client speaks OpenAI Chat Completions SSE, so it works with any compatible server — LM Studio, vLLM, OpenRouter, Together, Groq, DeepSeek, Mistral, Fireworks, LocalAI — just point `OPENAI_BASE_URL` at the right address:

```bash
# OpenAI official
OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini npm run server

# Local LM Studio
OPENAI_API_KEY=lm-studio \
OPENAI_BASE_URL=http://localhost:1234/v1 \
OPENAI_MODEL=your-loaded-model \
npm run server

# Groq, OpenRouter, DeepSeek, Together, … same pattern
```

**Local (Ollama):** install [Ollama](https://ollama.com), pull a model, point the app at it:

```bash
ollama pull gemma4:e2b       # or: gemma3n:e4b, llama3.2, phi3.5, qwen2.5:3b
OASIS_BACKEND=ollama npm run server
```

Override model / URL with `OLLAMA_MODEL=…` and `OLLAMA_BASE_URL=http://…`.

### Tier-1 router (SLM)

The coordinator uses a small LLM to classify intent + generate a reply for smalltalk in one call (via Ollama's JSON-shaped output). Only escalates to the reasoner for questions / commands / complex turns.

- `OASIS_ROUTER_MODEL` — defaults to the reasoner model when on Ollama, otherwise `gemma4:e2b`. Point at a smaller model (e.g. `qwen2.5:1.5b`) for faster routing.
- `OASIS_ROUTER_BASE_URL` — defaults to `OLLAMA_BASE_URL`. Override if your router runs elsewhere.

### TTS backend

Default is **web-speech** — the server emits text-only SSE chunks and the browser voices them via `speechSynthesis`. Good enough for a quick demo; OS-dependent quality.

For near-studio quality, switch to **Kokoro-82M** local TTS:

```bash
OASIS_TTS_BACKEND=kokoro npm run server
```

- Downloads an ~80MB ONNX model on first run (cached to `~/.cache/huggingface`).
- Runs in-process via `kokoro-js` — no Python, no separate server.
- ~0.8s synth per short sentence on M-series; base64 PCM flies over SSE and plays via Web Audio.
- `KOKORO_VOICE=af_heart` (default). Other voices: `af_nova`, `af_bella`, `am_adam`, `am_echo`, `bf_emma`, `bm_george`, … 28 total.
- `KOKORO_DTYPE=q8` (default). Also `q4`, `fp16`, `fp32` for quality/memory trade-offs.

### Web UI

`npm run server` launches a single-page app. You'll see:

- Streaming transcript + agent bubbles per turn
- Routing decision (reflex / local / escalated) with the chosen intent
- Session state: phase, allowed intents, rolling summary
- Metrics: p50/p95 TTFA per tier, barge-in count
- Event stream (raw pipeline events for debugging)
- **Voice** toggle — uses browser `SpeechRecognition` for mic input and the Web Audio API for playback

### Voice UX

Everything the assistant does acoustically:

| Feature | How it works |
|---|---|
| **Barge-in (just talk over it)** | A volume monitor runs on a separate `getUserMedia({echoCancellation: true})` mic stream. Threshold is adaptive: it tracks an EMA of the ambient RMS *while agent is speaking* (that's agent audio bleeding into the mic), so you need ~1.6× that baseline to fire — no shouting required. ~110ms sustained-speech window. |
| **Barge-in (explicit)** | Click the Barge-in button or press Escape. |
| **WebRTC audio loopback** | Agent PCM routes through `AudioContext → MediaStreamDestination → RTCPeerConnection (send) → RTCPeerConnection (recv) → <audio>.srcObject`. This is the playback path Chrome's AEC references, so the mic-side echo cancellation is measurably cleaner than plain `ctx.destination`. |
| **Recognizer pauses during agent speech** | Even with WebRTC-loopback AEC, Chrome's internal SpeechRecognition mic capture leaked agent audio as fake user turns. The recognizer is paused while the agent talks and resumed when a turn ends (or barge-in fires). Tradeoff: the first word of an interrupt is lost. |
| **Mid-utterance backchannels** | While you keep talking past ~5s, the agent emits short pre-synthesized Kokoro clips (`uh huh`, `yeah`, `mhm`, `right`, `I see`, …) at full volume. Server caches the PCM on startup so there's no synth latency. |
| **Contextual fillers** | When the agent escalates, the SLM router produces a topic-referential filler as part of its JSON decision — e.g. user says *"help me plan a Tokyo trip"* → filler is `"Okay, Tokyo trip — pulling this together"` instead of a canned `Hmm…`. Falls back to the context-neutral pool if the SLM omits it. |
| **Filler rate/pacing** | Scales with the TTFT EMA: fast model → 1 filler at near-normal rate; slow model → up to 5 stretched chained fillers with trailing silences for natural breaths. Cross-turn memory prevents the same phrase repeating. |
| **Stale-chunk & abandoned-turn guards** | Barge-in marks the interrupted turnId in an `abandonedTurns` set; any late TTS chunks for that turn are dropped so they can't overlap the next turn's audio. `stopSpeaking()` hard-stops every in-flight `AudioBufferSourceNode` and cancels `speechSynthesis`. |

## Env

Copy `.env.example` to `.env`. All keys documented there. Key ones:

- `OASIS_BACKEND` — `anthropic` · `openai` · `ollama`
- `OASIS_TTS_BACKEND` — `kokoro` · `web-speech`
- `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `OLLAMA_BASE_URL`
- `OASIS_LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## What ships

**Everything is real — no mock stubs in the production bundle.**

### Orchestration
- Typed event bus, dialogue state machine, overlapping-execution pipeline
- Barge-in arbiter with AbortSignal propagation, per-turn `abandonedTurns` guard against late-chunk overlap
- PII redaction + rehydrate across the LLM boundary
- Circuit breaker (per backend)
- TTFT EMA forecaster driving filler count and rate
- Cross-turn filler memory (no phrase repeats for ~12 turns)
- Single-source `PERSONA_RULES` constant in `@oasis-echo/types`, shared by all reasoners + the router

### Tiered inference
- **Tier-0 (reflex):** deterministic regex intent classifier for `hi` / `yes` / `no` / `stop` / `cancel` / `wait`
- **Tier-1 (coordinator):** SLM router via Ollama with JSON-constrained output, few-shot intent examples, and contextual filler generation. Intent-based escalation policy: smalltalk stays local, real questions/commands escalate.
- **Tier-2 (reasoning):** three streaming reasoner clients (Anthropic, OpenAI / OpenAI-compatible, Ollama) with token-level streaming. Tool use on the clients that support it.

### STT post-processing
- Pluggable 4-stage pipeline: deterministic rules → context-biased phonetic snap → fuzzy phrase matching → conditional LLM correction
- Sub-ms rule stage strips fillers, collapses repeats, applies phonetic fixes
- **Context-bias stage** uses the assistant's last utterance as a vocabulary hint: Soundex-matched windows of the user's transcript snap to names, code identifiers, and rare words from context ("see tell" → "Seattle", "use state" → "useState"). Gated by a topic-change detector so genuine new topics aren't forced back to old vocabulary
- Fuzzy matcher uses combined normalized-Levenshtein + token-Jaccard scoring to snap noisy input to canonical phrases
- Semantic LLM correction gated on STT confidence, ambiguity markers, and context presence; hallucination guardrail rejects length drift. Agent context forwarded into the prompt so the LLM can recover in-context identifiers the cheap stages miss
- **Correction feedback loop** — `POST /correction { original, corrected }` teaches the pipeline at runtime. Single-word diffs become word rules; multi-word corrections become canonical phrases. Persists to disk, rebuilds the live pipeline via `onChange`
- `stt.postprocess` SSE event exposes the transformation for debugging
- See [docs/STT_POSTPROCESS.md](docs/STT_POSTPROCESS.md) for architecture, samples, and extensibility

### Audio
- Kokoro-82M local TTS with sentence-boundary chunking
- Web Audio playback with scheduling to keep chunks back-to-back (`audioQueueEndsAt`)
- WebRTC loopback: agent audio routed through `MediaStreamDestination → RTCPeerConnection pair → <audio>` so Chrome's `getUserMedia` AEC can cancel against it
- Pre-synthesized backchannels (7 phrases, ~90KB PCM each) cached in memory at startup
- Browser `SpeechRecognition` with best-of-N hypothesis picking, confidence surfacing, and 1.2s silence-debounced turn commit (doubled to 2.4s when the tail is an incomplete-thought conjunction like "but", "what if", "because")
- Adaptive volume-monitor barge-in detector with dynamic baseline (no fixed threshold)

### Emotion-adaptive TTS
- **Complementary detection**: in-browser Speech Emotion Recognition (`onnx-community/Speech-Emotion-Classification-ONNX`, ~91MB q8 via transformers.js, off-main-thread `AudioWorklet` PCM capture) + server-side keyword/regex text emotion detector. Acoustic wins on arousal (happy/surprise/angry/fear/disgust); text wins on meaning (sad/frustrated/confused/urgent); fused at `/turn` time
- **Pre-warmed + pre-fetched classifier**: model loads on voice start, inference kicks off during the turn-end debounce — commit caps the wait at 300ms, so there's no visible hang
- **False-positive guards**: client ignores `sad`/`neutral`/`calm` SER labels (dataset shift against casual speech); text rules require unambiguous cues (bare `right now`, `quickly`, `immediately` don't fire `urgent`)
- **Empathetic mirroring (not copying)**: mirror-of-negative auto-upgrades to soften; text-source emotions also default to soften (weaker signal → gentler adaptation); angry / frustrated NEVER produce `rate > 1.0`, `volume > 1.0`, or `dynamic` intonation
- **Engine-neutral directives** (playback rate, gain, inter-chunk silence, pitch semitones) applied in `playPcm` for Kokoro; SSML fragment rendered with `<prosody>` + `<break>` for Azure/Google/ElevenLabs-style engines
- `?noemotion=1` URL flag disables the entire client-side pipeline for quick A/B
- See [docs/EMOTION_ADAPTIVE_TTS.md](docs/EMOTION_ADAPTIVE_TTS.md) for architecture, parameter tables, safety properties, and integration examples

### Client SDK (`@oasis-echo/sdk`)
All of the voice-pipeline logic is available as a reusable package so you can wire oasis-echo into **any** client — not just the shipped web UI.

- Works in browsers **and** Node.js. Universal `OasisClient` handles SSE + `POST /turn` + `POST /correction` + `POST /bargein`, with a strongly-typed event map (`tts.chunk`, `emotion.directives`, `turn.complete`, `stt.postprocess`, etc.). Cross-platform transport — native `EventSource` in browsers, streaming `fetch` body reader in Node.
- **Browser subpath** (`@oasis-echo/sdk/browser`) ships the full voice stack as composable primitives — `AudioPlayer` (Web Audio + per-turn emotion directives), `MicCapture` (off-main-thread PCM ring buffer via inline `AudioWorklet`), `EmotionDetector` (transformers.js SER with pre-warm + commit-time cap + confidence/margin gate), `BargeInMonitor` (adaptive baseline + 600ms grace window), `TurnDebouncer` (silence-debounced commit with incomplete-tail extension).
- **Zero runtime dep** on any server-side package. SDK carries its own minimal types. `@huggingface/transformers` is an optional peer dep (only needed for browser emotion detection).
- **Backend integration patterns**: wire into Slack / Discord / Twilio / IVR by subscribing to `emotion.directives` and forwarding the SSML fragment (or numeric directives) to your downstream TTS engine.
- `packages/app/src/index.html` now uses the SDK via an import map, and `packages/app/src/server.ts` serves the compiled `/sdk/*` bundle so browsers can import it directly.
- Full API, examples (`node-text-only.ts`, `browser.ts`), and behavioural invariants in [packages/sdk/README.md](packages/sdk/README.md).

## Where to plug future backends in

| Interface | File | Candidate impls |
|---|---|---|
| `Vad` | [packages/reflex/src/vad.ts](packages/reflex/src/vad.ts) | Silero-VAD over ONNX |
| `StreamingStt` | [packages/coordinator/src/stt.ts](packages/coordinator/src/stt.ts) | Whisper / Parakeet / Moonshine via transformers.js |
| `StreamingTts` | [packages/coordinator/src/tts.ts](packages/coordinator/src/tts.ts) | Piper, XTTS, ElevenLabs |
| `Reasoner` | [packages/reasoning/src/*.ts](packages/reasoning/src/) | any SSE-compatible LLM |
| `Router` | [packages/coordinator/src/router.ts](packages/coordinator/src/router.ts) | swap `OllamaRouter` for a cloud classifier |

## Scripts

- `npm run typecheck` — project-reference typecheck across all workspaces
- `npm run build` — emits `packages/*/dist`
- `npm test` — vitest suite (242 tests across all workspaces)
- `npm run server` — launch the web UI
- `npm run -w @oasis-echo/sdk build` — build the client SDK in isolation

## License

MIT. See [LICENSE](./LICENSE).
