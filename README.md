# Oasis Echo

Tiered hybrid voice AI — reflex / coordinator / reasoning. See [SAD.md](SAD.md) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the design.

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
pnpm install
pnpm build
pnpm test              # 68 tests across all packages
pnpm server            # web UI at http://localhost:3000
pnpm demo              # scripted end-to-end demo
pnpm dev               # interactive terminal REPL
```

Set `ANTHROPIC_API_KEY` in `.env` to use the real Claude Sonnet 4.6 backend; otherwise a deterministic mock reasoner streams canned responses so the full pipeline still runs.

### Web UI

`pnpm server` serves a single-page app at `http://localhost:3000`. Type a message, hit Enter, and watch:

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

- `pnpm typecheck` — project-reference typecheck across all workspaces
- `pnpm build` — emits `packages/*/dist`
- `pnpm test` — vitest suite
- `pnpm --filter @oasis-echo/app demo` — scripted end-to-end run
- `pnpm dev` — interactive REPL
