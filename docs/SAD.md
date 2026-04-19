# Software Architecture Document — Oasis Echo

**Version:** 0.1 (Draft)
**Date:** 2026-04-17
**Status:** Proposed
**Target Platform:** Apple Silicon (M3 Pro 18GB minimum) + Node.js orchestrator
**Related:** [research.md](research.md)

---

## 1. Purpose & Scope

Oasis Echo is a tiered hybrid voice assistant that delivers sub-300ms perceived response time on consumer Apple Silicon hardware while retaining cloud-class reasoning for complex turns. This document defines the system's structural decomposition, data flows, latency budgets, failure modes, and technology choices. It is the source of truth for implementation and review.

**In scope:** end-to-end audio pipeline, model tiering, state management, barge-in handling, telemetry.
**Out of scope (v1):** multi-speaker rooms, vision fusion, true full-duplex (Level 3), on-prem multi-tenant deployment.

## 2. Architectural Drivers

| Driver | Target | Rationale |
|---|---|---|
| Time-to-First-Audio (TTFA) | < 800ms p95, < 500ms p50 | Human perception of "live" conversation |
| Turn-end detection | < 50ms | Avoid awkward pauses |
| Local-handled turn ratio | ≥ 80% | Cost, privacy, reliability |
| Barge-in response | < 100ms to cancel TTS | Natural interruption |
| Cloud escalation cost | < $0.02 per session avg | Economic predictability |
| Privacy | PII stays on-device by default | HIPAA/GDPR posture |

## 3. High-Level Architecture

Three latency tiers acting as a **Mixture-of-Experts across latency**, not knowledge:

```
┌──────────────────────────────────────────────────────────────────┐
│                       USER (microphone / speaker)                │
└──────────────▲──────────────────────────────────────▲────────────┘
               │ PCM in                               │ PCM out
┌──────────────┴──────────────────────────────────────┴────────────┐
│   TIER 0 — Reflex Layer (on-device, <20ms)                       │
│   • VAD (Silero / WebRTC-VAD)                                    │
│   • Wake-word + directed-speech gate                             │
│   • Deterministic intent router (greetings, "wait", "stop")      │
└──────────────▲──────────────────────────────────────▲────────────┘
               │ speech segments                      │ reflex audio
┌──────────────┴──────────────────────────────────────┴────────────┐
│   TIER 1 — Dialogue Coordinator (on-device SLM, 50–150ms)        │
│   • Streaming STT (Whisper-MLX / Parakeet)                       │
│   • SLM router & memory (Llama-3.2-3B / Phi-3.5 via MLX)         │
│   • Dialogue state machine + short-term memory                   │
│   • Streaming TTS (Kokoro / Piper)                               │
└──────────────▲──────────────────────────────────────▲────────────┘
               │ escalation request                   │ tokens
┌──────────────┴──────────────────────────────────────┴────────────┐
│   TIER 2 — Reasoning Engine (cloud, 300–800ms)                   │
│   • Frontier LLM (Claude Sonnet 4.6 / GPT-4o)                    │
│   • Tool orchestration + RAG                                     │
│   • Invoked for 10–20% of turns                                  │
└──────────────────────────────────────────────────────────────────┘
```

The **Orchestrator** (Node.js) spans all three tiers. It owns the event bus, pipeline back-pressure, and barge-in arbitration.

## 4. Component Decomposition

### 4.1 Tier 0 — Reflex Layer
| Component | Tech | Responsibility |
|---|---|---|
| Audio I/O | CoreAudio via `node-speaker` / `naudiodon` | 16kHz mono PCM capture/playback |
| VAD | Silero-VAD (ONNX, NPU) | Frame-level voiced/unvoiced at 10ms granularity |
| Endpointer | Custom rule + prosody heuristic | Fires turn-end within 50ms of silence |
| Reflex intent | Regex + small classifier (<50M params) | Short-circuits greetings, acknowledgements, barge-in commands |

### 4.2 Tier 1 — Dialogue Coordinator
| Component | Tech | Responsibility |
|---|---|---|
| Streaming STT | `whisper.cpp` or `parakeet-mlx` | Partial transcripts every 100ms |
| Coordinator SLM | Llama-3.2-3B-Instruct (MLX, 4-bit) | Intent routing, state updates, filler generation, simple answers |
| Dialogue state store | In-process key-value + JSON schema | Explicit slots: user_id, topic, pending_tool, last_confirm |
| Summarizer | Same SLM via scheduled pass | Compress turns N-5..N-1 every 5 turns |
| TTS | Kokoro (MLX) primary, Piper fallback | Streaming synthesis, sentence-boundary chunks |
| Guardrail | Deterministic validator + schema check | Blocks hallucinated structure before TTS |

### 4.3 Tier 2 — Reasoning Engine
| Component | Tech | Responsibility |
|---|---|---|
| Cloud LLM client | Anthropic SDK (Claude Sonnet 4.6) | Streaming completions with tool use |
| Tool registry | Typed JSON-schema tools | RAG, calendar, search, domain APIs |
| Prompt cache | Anthropic prompt caching | Amortize system prompt + tool defs |
| Expressive directives | Inline TTS hints in response | `<prosody rate="fast">` style tags |

### 4.4 Orchestrator (Node.js)
| Subsystem | Responsibility |
|---|---|
| Event bus | Typed events: `audio.frame`, `vad.start`, `vad.end`, `stt.partial`, `stt.final`, `route.decision`, `llm.token`, `tts.chunk`, `bargein` |
| Pipeline controller | Overlapping execution: STT→SLM→TTS concurrent stages with back-pressure |
| Router | Reads coordinator decision; dispatches to Tier 1 direct-answer or Tier 2 escalation |
| Barge-in arbiter | On `vad.start` during playback: cancel TTS, flush buffers, abort in-flight LLM stream |
| Telemetry | OpenTelemetry spans per stage; exports TTFA, turn latency, tier utilization |

## 5. Key Data Flows

### 5.1 Normal turn (Tier 1 resolves)
```
t=0     VAD detects speech
t=10    STT begins streaming partial transcripts
t=150   STT emits confident partial → Coordinator starts inference
t=220   SLM routing decision = LOCAL_ANSWER
t=260   SLM first token → TTS begins synthesis at sentence boundary
t=340   TTS first audio chunk → speaker (TTFA)
t=600   User hears complete first sentence; SLM still generating
```

### 5.2 Escalated turn (Tier 2)
```
t=0     VAD detects speech
t=150   STT partial → Coordinator
t=220   SLM routing decision = ESCALATE (confidence low / tool needed)
t=230   Parallel: (a) Tier 1 emits filler "Let me check that…" via TTS
                  (b) Cloud LLM stream begins with full context
t=350   TTS first audio (filler) (TTFA perceived)
t=750   Cloud LLM first substantive token → TTS queues post-filler
t=900   Speaker transitions seamlessly from filler to answer
```

### 5.3 Barge-in
```
t=N     TTS playing; VAD detects user speech
t=N+20  Arbiter: cancel TTS, flush speaker buffer, abort LLM stream
t=N+30  New turn begins; prior turn logged as interrupted
```

## 6. State-Aware Intent Routing

The coordinator's router is **not** a global intent classifier. It is conditioned on `DialogueState.allowedIntents`:

```ts
type DialogueState = {
  phase: 'greeting' | 'collecting' | 'confirming' | 'executing' | 'closing'
  allowedIntents: Intent[]   // constrained per phase
  slots: Record<string, unknown>
  lastTurn: Turn
}
```

Example: in `confirming` phase, "yeah" maps to `confirm`; in `greeting` phase, same utterance maps to `smalltalk`. The SLM is prompted with only the allowed intents plus a schema-constrained output grammar.

## 7. Latency Budget (p95 target)

| Stage | Budget | Notes |
|---|---|---|
| VAD → STT activation | 20ms | ONNX on NPU |
| STT partial → useful | 150ms | First committed 3-gram |
| SLM route decision | 70ms | 3B-4bit, ~50 tokens context |
| SLM first token (local answer) | 40ms | Streaming |
| TTS TTFA | 100ms | Kokoro streaming |
| **Total TTFA (local)** | **< 400ms** | |
| Cloud escalation TTFT | 500ms | Prompt-cache hit |
| **Total TTFA (escalated, with filler)** | **< 350ms perceived** | Filler covers cloud latency |

## 8. Failure Modes & Mitigations

| Failure | Mitigation |
|---|---|
| Router picks wrong intent in context | State-aware prompting + grammar-constrained output + confidence threshold → escalate |
| Coordinator context drift | Rolling summarization every 5 turns; slots stored outside context |
| SLM hallucinates tool call | Schema validator rejects; arbiter forces escalation |
| Cloud outage / timeout | Circuit breaker at 2s; coordinator falls back to "I can't reach that right now" |
| TTS glitch mid-sentence | Sentence-level chunks limit blast radius; retry from next boundary |
| Barge-in race with TTS buffer | Hardware-level audio buffer flush; TTS worker holds cancellation token |
| NPU contention (STT vs TTS) | Pin STT to NPU, TTS to GPU via MLX device placement |

## 9. Deployment & Operations

- **Packaging:** single Node.js app + bundled MLX model weights (lazy-loaded).
- **Observability:** OTel traces per turn, Prometheus metrics (TTFA, tier_hit_rate, bargein_count), structured JSON logs.
- **Model lifecycle:** pinned model versions; canary via A/B on routing decisions.
- **Config:** YAML profile per hardware tier (M3 Pro 18GB vs M4 Max 64GB); switches model sizes + quantization.

## 10. Security & Privacy

- Audio buffers never persisted by default; opt-in session recording writes to encrypted local volume.
- PII redaction pass on transcript before any Tier-2 egress; redacted tokens replaced with placeholders and rehydrated locally.
- Cloud calls over TLS 1.3 with pinned cert; no raw audio leaves device.
- Keychain-backed storage for API credentials.

## 11. Open Questions

1. Which STT engine wins on M3 Pro: Whisper-MLX large-v3 vs Parakeet-TDT? (needs bench)
2. Is Kokoro's expressiveness sufficient, or do we fall back to ElevenLabs for premium voices?
3. Should the coordinator be Llama-3.2-3B or Phi-3.5-mini? (routing accuracy vs latency tradeoff)
4. Session memory persistence: SQLite vs flat JSON vs embedded vector store?
5. How do we version the dialogue state schema without breaking long-lived sessions?

## 12. Glossary

- **TTFA:** Time-to-First-Audio, from end-of-user-speech to first speaker sample.
- **SLM:** Small Language Model (1–8B params), on-device.
- **Barge-in:** user interrupts while agent is speaking.
- **Reflex tier:** deterministic/tiny-model layer for sub-20ms reactions.
