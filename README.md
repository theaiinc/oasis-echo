# Oasis Echo

[![CI](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml/badge.svg)](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Tiered hybrid voice AI — reflex / coordinator / reasoning. See [docs/SAD.md](docs/SAD.md) and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the design.

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
- **Voice** toggle (uses browser `SpeechRecognition`); mid-utterance backchannels ("uh huh", "yeah", "mhm", …) are pre-synthesized via Kokoro and played at full volume while you talk
- **Barge-in**: click the button, hit Escape, or just talk over the agent — a volume monitor on a separate echo-cancelled mic stream detects intent to interrupt

## Env

Copy `.env.example` to `.env`. All keys documented there. Key ones:

- `OASIS_BACKEND` — `anthropic` · `openai` · `ollama`
- `OASIS_TTS_BACKEND` — `kokoro` · `web-speech`
- `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `OLLAMA_BASE_URL`
- `OASIS_LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## What ships

**Everything is real — no mock stubs in the production bundle.**

- Typed event bus, dialogue state machine, overlapping-execution pipeline
- Barge-in arbiter with AbortSignal propagation
- PII redaction + rehydrate across the LLM boundary
- Circuit breaker (per-backend), TTFT EMA forecaster, rate-stretched fillers with cross-turn no-repeat memory
- Deterministic reflex-intent classifier (Tier-0)
- SLM router via Ollama (Tier-1) with intent-based escalation policy and JSON-shaped output
- Three streaming reasoner clients: Anthropic, OpenAI / OpenAI-compatible, Ollama — all with token-level streaming and tool-use support where available
- Kokoro-82M local TTS with sentence-boundary chunking and Web Audio playback
- Browser client: `SpeechRecognition` best-of-N hypothesis picking, pre-synthesized backchannels, volume-based barge-in detection with echo cancellation

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
- `npm test` — vitest suite (77 tests)
- `npm run server` — launch the web UI

## License

MIT. See [LICENSE](./LICENSE).
