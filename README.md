# Oasis Echo

[![CI](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml/badge.svg)](https://github.com/theaiinc/oasis-echo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Tiered hybrid voice AI — reflex / coordinator / reasoning. See [docs/SAD.md](docs/SAD.md) and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the design.

## Status

v0.1 — orchestration spine is complete and tested. Native audio I/O and model-backed STT/SLM/TTS are pluggable interfaces with mock implementations so the full pipeline runs end-to-end without hardware or weights.

| Tier | Status | Backend |
|---|---|---|
| Reflex (VAD, endpointer, intent, barge-in) | done | Energy VAD + deterministic rules |
| Coordinator (STT, router, state, TTS, guardrail) | done | Heuristic router + mock STT/TTS |
| Reasoning (cloud LLM + tools + redaction) | done | Real Anthropic SDK + mock fallback |
| Orchestrator (event bus, pipeline, barge-in arbiter) | done | — |

## Layout

```
packages/
  types/         shared DialogueState, events, intents
  telemetry/     logger, metrics, tracer
  reflex/        VAD interface, endpointer, reflex intent router, barge-in detector
  coordinator/   streaming STT/TTS, SLM router + prompt, state machine, guardrail
  reasoning/     Anthropic client, PII redactor, tool registry, circuit breaker
  orchestrator/  typed event bus, overlapping-execution pipeline, barge-in arbiter
  app/           text-mode REPL + scripted demo
```

## Quick start

```bash
npm install
npm run build
npm test               # 81 tests across all packages
npm run server         # web UI at http://localhost:3000
npm run demo           # scripted end-to-end demo
npm run dev            # interactive terminal REPL
```

### Backends

Four reasoner backends, picked in this order of precedence:

1. `OASIS_BACKEND=anthropic|ollama|openai|mock` (explicit override)
2. `ANTHROPIC_API_KEY` set → `anthropic`
3. `OPENAI_API_KEY` set → `openai`
4. otherwise → `mock`

**Anthropic (Claude):** put `ANTHROPIC_API_KEY=sk-ant-…` in `.env` at the repo root. Default model is `claude-sonnet-4-6`; override with `OASIS_MODEL=…`.

**OpenAI and compatible endpoints:** set `OPENAI_API_KEY`. The client speaks the OpenAI Chat Completions streaming format, so it works with any compatible server — LM Studio, vLLM, OpenRouter, Together, Groq, DeepSeek, Mistral, Fireworks, LocalAI — just point `OPENAI_BASE_URL` at the right address:

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
ollama pull gemma4:e2b      # or: gemma3n:e4b, llama3.2, phi3.5, qwen2.5:3b
ollama serve                 # usually already running
OASIS_BACKEND=ollama npm run server
```

Override the model/URL with `OLLAMA_MODEL=…` and `OLLAMA_BASE_URL=http://…`.

**Mock:** default when nothing is configured. Canned, shallow replies that reference the last few turns so you can smoke-test the pipeline without hitting the network.

The header in the web UI shows which backend is live; a banner explains how to upgrade from mock to a real model.

### TTS backend (speech quality)

By default the browser's `speechSynthesis` speaks the agent text — decent, but heavily OS-dependent. For near-studio quality, switch to the built-in **Kokoro-82M** local TTS:

```bash
OASIS_BACKEND=ollama OASIS_TTS_BACKEND=kokoro npm run server
```

- Downloads an ~80MB ONNX model on first run (cached to `~/.cache/huggingface`).
- Runs in-process via `kokoro-js` — no Python, no separate server.
- ~0.8s synth per short sentence on M-series, ~2s for a full reply.
- Override the voice with `KOKORO_VOICE=af_heart` (other options: `af_nova`, `af_bella`, `am_adam`, `am_echo`, `bf_emma`, `bm_george`, ... 28 total).
- Override quantization with `KOKORO_DTYPE=q8` (default; also `q4`, `fp16`, `fp32` for more quality at higher memory).

Real PCM is base64-encoded into the SSE `tts.chunk` event and played client-side via the Web Audio API. If the server ever returns a chunk without `audio` (e.g. backend falls back), the client automatically uses `speechSynthesis` on the `text` field.

### Web UI

`npm run server` serves a single-page app at `http://localhost:3000`. Type a message, hit Enter, and watch:

- **Live transcript** — user text streams in word-by-word (simulating STT partials), then locks to the final.
- **Routing decision** — every turn shows whether it went reflex / local / escalated, with the chosen intent.
- **Agent response** — streams as TTS chunks arrive, color-coded per tier.
- **Session state** — current phase, allowed intents, rolling summary.
- **Metrics** — p50/p95 TTFA per tier, turn counts, barge-in count.
- **Event stream** — raw pipeline events for debugging.
- **Barge-in button** — interrupts the in-flight turn mid-stream.

## Env

Copy `.env.example` to `.env`:

- `ANTHROPIC_API_KEY` — enables Tier 2 with `claude-sonnet-4-6`. Without it, a `MockReasoner` streams canned responses so the pipeline still exercises the escalation path.
- `OASIS_MODEL` — override the reasoning model.
- `OASIS_LOG_LEVEL` — `debug` | `info` | `warn` | `error`.

## What's real vs stubbed

**Real:** event bus, dialogue state machine, state-aware intent routing, overlapping-execution pipeline, sentence chunker, barge-in arbiter, PII redactor + rehydrate, circuit breaker, tool registry, OTel-style tracer, metrics with p50/p95/p99, Anthropic streaming client with tool use.

**Stub (with pluggable interfaces):** VAD (energy-based fallback), STT (text-as-audio mock), TTS (text-as-PCM mock), coordinator SLM (regex-based `HeuristicRouter`). Each has a documented interface and can be swapped for a real implementation without touching the orchestrator.

## Where to plug in real backends

| Interface | File | Replace with |
|---|---|---|
| `Vad` | [packages/reflex/src/vad.ts](packages/reflex/src/vad.ts) | Silero-VAD over ONNX Runtime |
| `StreamingStt` | [packages/coordinator/src/stt.ts](packages/coordinator/src/stt.ts) | whisper.cpp / Parakeet-MLX |
| `Router` | [packages/coordinator/src/router.ts](packages/coordinator/src/router.ts) | Llama-3.2-3B or Phi-3.5 via MLX, using `buildRouterPrompt` |
| `StreamingTts` | [packages/coordinator/src/tts.ts](packages/coordinator/src/tts.ts) | Kokoro-MLX / Piper |
| Audio I/O | not yet present | Native CoreAudio via N-API or `naudiodon` |

## Scripts

- `npm run typecheck` — project-reference typecheck across all workspaces
- `npm run build` — emits `packages/*/dist`
- `npm test` — vitest suite
- `npm run demo` — scripted end-to-end run
- `npm run dev` — interactive REPL
- `npm run server` — launch the web UI
