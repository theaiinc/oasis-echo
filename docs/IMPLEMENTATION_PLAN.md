# Oasis Echo — Implementation Plan

**Version:** 0.1 (Draft)
**Date:** 2026-04-17
**Companion to:** [SAD.md](SAD.md), [docs/research.md](docs/research.md)
**Target first demo:** 6 weeks
**Target v1 (production candidate):** 14 weeks

---

## 0. Guiding Principles

1. **Ship the spine, then grow the nerves.** Get a crude end-to-end pipeline running in week 1; optimize stages only once the full loop works.
2. **Measure before optimizing.** Every phase exits on quantitative latency/accuracy gates, not on "it feels fast."
3. **Local-first.** Nothing goes to the cloud until Tier 0 and Tier 1 can complete a turn alone.
4. **One tier at a time.** No concurrent work on Tier 1 and Tier 2 until Tier 1 hits its latency budget.

## 1. Milestones at a Glance

| Phase | Duration | Exit Criteria |
|---|---|---|
| 0. Foundations | Week 1 | Repo, CI, audio I/O round-trip < 100ms, telemetry skeleton |
| 1. Reflex Tier | Weeks 2–3 | VAD + endpointer p95 < 50ms; barge-in cancels playback < 100ms |
| 2. Coordinator (STT+SLM+TTS local) | Weeks 4–6 | Local turn TTFA p95 < 500ms on M3 Pro 18GB |
| 3. Reasoning Tier (cloud escalation) | Weeks 7–9 | Escalated turn perceived TTFA < 500ms via filler; tool use working |
| 4. State, memory, guardrails | Weeks 10–11 | State-aware routing accuracy ≥ 92% on eval set; no hallucinated tool calls |
| 5. Hardening & observability | Weeks 12–13 | OTel traces end-to-end; 8-hour soak without drift |
| 6. Polish & v1 release | Week 14 | All architectural drivers in §2 of SAD met at p95 |

## 2. Phase 0 — Foundations (Week 1)

**Goal:** A Node.js app that captures microphone audio and plays back synthesized audio through a minimal event bus.

**Tasks**
- Initialize Node.js 22 + TypeScript monorepo (`pnpm` workspaces): `packages/orchestrator`, `packages/reflex`, `packages/coordinator`, `packages/reasoning`, `packages/telemetry`.
- Pick audio I/O library (candidates: `naudiodon`, `node-speaker`, native addon over CoreAudio). Benchmark round-trip latency.
- Scaffold typed event bus (`EventEmitter3` or custom `AsyncIterator`-based) with events from [SAD.md §4.4](SAD.md).
- Wire OpenTelemetry with a local OTLP collector; one span per audio frame burst.
- CI: lint, typecheck, unit tests, benchmark harness.

**Exit gate:** Speak into the mic, hear it looped back via the event bus, with per-frame traces. Round-trip p95 < 100ms.

**Risks:** Node audio libraries are often unmaintained. Fallback: write a thin Swift/Obj-C helper exposed via N-API.

## 3. Phase 1 — Reflex Tier (Weeks 2–3)

**Goal:** The system knows when a human is talking to it and can be interrupted instantly.

**Tasks**
- Integrate Silero-VAD via ONNX Runtime with NPU backend. Measure frame-level latency.
- Build endpointer: silence-duration + prosody heuristic; configurable threshold.
- Implement deterministic reflex intents (regex + small classifier): greeting, stop, cancel, wait.
- Build **barge-in arbiter**: on `vad.start` during `tts.playing`, cancel TTS, flush OS audio buffer, abort any upstream stream via `AbortController`.
- Eval harness: 500 labeled audio clips; measure endpointer precision/recall and VAD latency.

**Exit gate:** Endpointer p95 < 50ms; barge-in cancels audio within 100ms measured by speaker callback.

## 4. Phase 2 — Coordinator (Weeks 4–6)

**Goal:** Local-only conversations work end-to-end with TTFA p95 < 500ms.

**Week 4 — Streaming STT**
- Bench Whisper-MLX (small/medium) vs Parakeet-TDT on M3 Pro. Pick the winner.
- Wrap chosen engine behind a `StreamingSTT` interface emitting `stt.partial` every ~100ms and `stt.final` at endpoint.
- Add word-level timestamps for later alignment.

**Week 5 — Coordinator SLM**
- Load Llama-3.2-3B-Instruct (4-bit MLX) into a long-lived worker process.
- Build the **router prompt**: takes `DialogueState`, partial transcript, allowed intents; outputs grammar-constrained JSON `{decision, intent, reply?}`.
- Bench first-token and tokens/sec; iterate on quantization.
- Unit tests for router on a synthetic dialogue dataset.

**Week 6 — Streaming TTS + pipelining**
- Integrate Kokoro-MLX for streaming TTS; chunk on sentence boundaries (`.`,`!`,`?`).
- Implement **overlapping execution** in the orchestrator: STT partial triggers speculative SLM; SLM first sentence triggers TTS while generation continues.
- End-to-end latency profiling; fix the worst stage.

**Exit gate:** On 50 local-answer test dialogues, TTFA p95 < 500ms, p50 < 350ms.

## 5. Phase 3 — Reasoning Tier (Weeks 7–9)

**Goal:** Complex turns escalate to the cloud without the user noticing the extra latency.

**Week 7 — Cloud LLM client**
- Integrate Anthropic SDK with streaming + prompt caching for system prompt + tool defs.
- Build tool registry with JSON-schema types; ship two starter tools (web search, calendar).
- Add a circuit breaker (2s timeout, open for 30s after 3 failures).

**Week 8 — Escalation path**
- Coordinator emits `ESCALATE` with a redaction-passed context bundle.
- Parallel launch: Tier 1 TTS plays a **filler** (`"One moment, let me look that up…"`) while cloud stream begins.
- Post-filler handoff: TTS queue seamlessly continues with cloud tokens at the next sentence boundary.

**Week 9 — PII redaction + prompt hygiene**
- Local regex + small NER model to redact PII; placeholders rehydrated after cloud returns.
- Log redaction hits as metrics; alert if PII leaks past redactor in tests.

**Exit gate:** On 30 escalated dialogues (requiring tool use), perceived TTFA p95 < 500ms; zero PII leakage in recorded cloud payloads.

## 6. Phase 4 — State, Memory, Guardrails (Weeks 10–11)

**Goal:** The assistant stays on topic for long conversations and never hallucinates structure.

**Tasks**
- Implement `DialogueState` store with explicit slots and phase machine (see SAD §6).
- Rolling summarization pass every 5 turns, driven by the coordinator SLM.
- Grammar-constrained decoding for all router outputs (JSON schema enforcement).
- Guardrail validator: reject any tool call whose args fail schema; auto-escalate instead of guessing.
- Build a 200-turn eval suite covering context drift, ambiguous "yeah", multi-step tool flows, interruptions.

**Exit gate:** State-aware routing accuracy ≥ 92%; zero unhandled hallucinated tool calls in eval.

## 7. Phase 5 — Hardening & Observability (Weeks 12–13)

**Goal:** Production-grade telemetry and stability.

**Tasks**
- OTel spans for every stage; trace exemplars for p99 turns.
- Prometheus metrics: `ttfa_ms`, `tier_hit_ratio`, `bargein_rate`, `redaction_hits`, `tool_error_rate`.
- Structured JSON logs with turn IDs; redaction-aware.
- 8-hour soak test: simulated conversation loop; assert no memory growth > 20%, no TTFA regression > 10%.
- Chaos: inject cloud timeouts, NPU contention, mic glitches; verify graceful degradation.
- Model-lifecycle config: pinned versions, canary flag for coordinator prompt changes.

**Exit gate:** Soak test passes; dashboards usable; runbooks for common failures documented.

## 8. Phase 6 — Polish & v1 (Week 14)

- Close open questions from [SAD §11](SAD.md) with benchmark data.
- Finalize YAML hardware profiles (M3 Pro 18GB, M4 Max 64GB).
- Packaging: `pnpm build` produces a notarized `.app` bundle with weights lazy-fetched on first run.
- Ship v1 with release notes mapping features back to architectural drivers.

## 9. Team, Workstreams, Parallelism

After Phase 0, three parallel workstreams:

| Workstream | Owns | Unblocks |
|---|---|---|
| **A — Audio/Reflex** | Phases 1, barge-in, audio I/O | Phase 2 TTS testing |
| **B — Models/Coordinator** | Phase 2, Phase 4 guardrails | Phase 3 escalation |
| **C — Cloud/Tools** | Phase 3, Phase 5 chaos | Phase 6 release |

Single integrator owns the orchestrator and cross-cuts all three.

## 10. Eval Strategy

- **Unit:** per-component (VAD, router JSON, TTS chunking).
- **Synthetic dialogues:** 200 scripted turns covering confirm/deny, small talk, tool calls, drift, barge-in.
- **Golden audio:** 50 real recordings with human-labeled endpoints and intents.
- **Latency regression:** CI runs a 20-turn canned dialogue on M3 Pro nightly; fails the build on p95 TTFA regression > 10%.
- **Human eval:** weekly 10-minute session with an internal user; rate naturalness 1–5.

## 11. Top Risks & Contingencies

| Risk | Likelihood | Impact | Contingency |
|---|---|---|---|
| Node audio libs can't hit <100ms round-trip | Medium | High | Native Swift helper via N-API (add 1 week to Phase 0) |
| Coordinator SLM too slow at 3B | Medium | High | Drop to Phi-3.5-mini or 1B Llama; accept lower routing accuracy |
| Kokoro TTS quality insufficient | Medium | Medium | Hybrid: Kokoro for filler, ElevenLabs for primary answer |
| PII redactor misses edge cases | High | High | Defense-in-depth: server-side redaction at cloud vendor + audit logs |
| MLX framework breaking changes | Low | Medium | Pin MLX version; quarterly upgrade sprints |

## 12. Decision Log (to be maintained)

Record each consequential choice as `YYYY-MM-DD — Decision — Rationale — Consequences`. First entry when Phase 0 starts.
