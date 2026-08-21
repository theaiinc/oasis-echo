# Oasis Echo — Agent Guidelines

## Recent implementation notes

- **2026-07-17 — Optional Echo speaker verification**
  - FunASR transcription remains SenseVoice; speaker verification is a separate CAM++/CAMPPlus embedding model (`iic/speech_campplus_sv_zh-cn_16k-common`).
  - The coordinator enrolls a bounded bank of recent Kokoro answer PCM clips and returns an `echoMatchScore` with `stt.final` for R1 command captures.
  - The bridge rejects a whole candidate only for a high-confidence match during the recent assistant playback window; `r1-barge-in-command` remains trusted and bypasses this transcript/speaker filter.
  - Set `R1_SPEAKER_VERIFY_REJECTION=0` for diagnostics-only rollout. Thresholds are `R1_SPEAKER_VERIFY_THRESHOLD` (default `0.78`) and `R1_SPEAKER_VERIFY_HIGH_THRESHOLD` (default `0.88`).

## macOS App Development

### Code signing & TCC (Accessibility / Automation)

- The Mac app is **ad-hoc signed** on every local build (no stable cert).
- Ad-hoc signing changes the `CDHash` each build, which **invalidates Accessibility and Automation TCC grants**.
- After a rebuild, `AXIsProcessTrusted()` returns `false` even if the toggle appears ON in System Settings.
- The fix: `tccutil reset Accessibility` on the terminal, re-launch the app, and re-grant the permission.

### Auto-paste

- Paster.swift tries these paths in order:
  1. **AppleScript** (`osascript` with System Events `keystroke`).
  2. **CGEventPost to `.cghidEventTap`** — only if `AXIsProcessTrusted()`.
  3. **AX insertion** (`AXUIElementSetAttributeValue` on focused element) — final fallback only.
- Direct `CGEventPostToPid` injection was removed after it produced duplicate pastes in Electron targets despite a single `Paster.paste` call and successful API results.
- Do not run another paste strategy after a direct AX insertion attempt; some apps mutate the focused element even when AX reports a non-success result, which can duplicate text if followed by Cmd+V.
- Aha (2026-07-29): keep the paste boundary idempotent too. Duplicate hotkey/STT lifecycle callbacks can invoke `Paster.paste` twice even when `finishCommitted` is intended to guard the turn; suppress an identical successful transcript repeated within one second and log the suppression.
- On macOS 14+, all paths require Accessibility permission. Without it, auto-paste falls back to clipboard-only.
- The permission gate window shows Automation (System Events) instructions, but `keystroke` in System Events also requires Accessibility.

### Audio engine lifecycle (mic-in-use indicator)

- `TurnController` shares ONE `AVAudioEngine` between `mic` (`MicCapture`) and `player` (`AudioPlayer`), with Voice-Processing I/O enabled on both nodes for AEC (`player`'s TTS/backchannel output gets cancelled out of `mic`'s input). `MicCapture(engine:)` with an external engine never calls `engine.start()`/`.stop()` itself — see the comment on `ownsEngine` — that's deliberately left to whoever else uses the engine (`AudioPlayer`). `bootstrap()` calls `try? player.prepare()` once at launch to start it, and nothing stops it again until the app quits (`shutdown()` → `player.stop()`).
- Aha (2026-08-21): tried making this lazy — start on first `beginCapture()`, release via `player.stop()` once both `state.pill == .idle` and `player.isQueueIdle`, to fix the mic-in-use indicator staying lit for the app's whole lifetime. **This broke recording outright** (silent — no error surfaced, capture just stopped producing buffers) and was reverted the same day. Root cause not confirmed, but the leading suspect is that Voice-Processing I/O (AUVoiceIO) does not reliably support a `stop()` → later `start()` cycle on the same engine instance the way a plain (non-AEC) `AVAudioEngine` does — unlike `MeetingController`'s separate plain engine, which already stops/starts per-meeting without issue.
- **Do not re-attempt the lazy/release approach without a way to verify against real hardware first** (this session couldn't — no live mic to test with). If revisited: test on an actual device through several start→stop→start cycles before considering it safe, or sidestep the restart question entirely by using a SEPARATE plain (non-voice-processing) `AVAudioEngine` for capture that stops/starts freely like `MeetingController`'s already does, and only spin up the shared AEC engine for the narrower window an Echo TTS reply is actually about to play.
- `MeetingController` is unaffected by any of the above — it owns a fully separate `MicCapture()` with its OWN private (non-shared, non-voice-processing) `AVAudioEngine`, and already correctly calls `engine.stop()` on every `stop()`/`cancel()`/`fail()` path (`ownsEngine == true` there).
- If wake word ("Hey Echo") is enabled, `WakeWordDetector` holds its own separate always-on `AVAudioEngine` for VAD — the mic indicator will legitimately stay lit continuously while it's active. That's expected/by-design for an always-listening feature.
- AppleScript error `1002` = "not allowed to send keystrokes" = no AX permission.

### Permission gate

- `PermissionGateController` shows a modal window with instructions.
- No polling — there's no API to verify Automation permission at runtime.
- The Continue button always works; it just dismisses the gate.

### Fn / Globe key hotkey

- `FnKeyMonitor` owns a `CGEventTap` for `.flagsChanged` because Fn is a modifier and cannot be bound by KeyboardShortcuts.
- macOS can disable event taps mid-session (`tapDisabledByTimeout` / `tapDisabledByUserInput`); re-enable the tap and synthesize a release if Fn was down so push-to-talk state does not get stuck.
- Fn still requires Accessibility trust, and System Settings → Keyboard → "Press 🌐 key to" should be "Do Nothing" if macOS consumes the key.
- Fn+Space brainstorming: Fn starts push-to-talk; pressing Space while Fn is held toggles a capture into brainstorming mode, so releasing Fn keeps recording. A second Fn+Space commits the capture. Space key repeats are ignored.
- The Fn event tap must use `.defaultTap` and consume Fn+Space key-down events; `.listenOnly` detects the gesture but leaks Space into the focused chat/editor.

### Wake word ("Hey Echo")

- `WakeWordDetector` uses RMS VAD (threshold 0.018) + one-shot `SFSpeechRecognizer`.
- Captures ~3.0s of audio on VAD trigger.
- Debug logs in Console.app (filter `wakeword`).
- The Node server defaults to `127.0.0.1` for local clients. Set `OASIS_LISTEN_HOST=0.0.0.0` in launchd when LAN devices such as the Phicomm R1 companion must connect to `/audio`.

### Transcript finalization

- Treat STT finals as potentially repeated or overlapping hypotheses; merge idempotently in `TurnController` before paste/echo instead of blindly appending.
- Rolling-buffer STT partials/finals can rewrite earlier words with near-overlap substitutions (not just exact suffix/prefix matches); use `TranscriptAssembler`-style token overlap merging before paste/echo.
- Aha (2026-07-28): the merge rules above apply to SEGMENT engines (Apple Speech). Server STT hypotheses are CUMULATIVE — every partial/final already covers the whole utterance — so `TranscriptAssembler.cumulativeHypotheses` must be set for `ServerSTTEngine`: unrelated re-hearings replace the pending hypothesis (append duplicates the utterance: "Current Re The The enrollment …"), and the server final replaces the assembled text outright. Committing partial fragments and overlap-merging the final back in is what mangled pasted transcripts.
- Server `/audio` messages carry `utteranceId`; the Mac client must ignore partial/final STT messages whose id does not match the active/finishing capture.

## Docker

- Port 9187, subnet 10.89.87.0/24.
- `docker-compose.yml` uses static IP 10.89.87.10.
- `host.docker.internal` for Ollama access.

## Local Model Runtime

- Aha: the live local LLM stack can run from Avalon (`/Users/stevetran/llama-dash`) instead of separate LM Studio/Ollama servers. Current `.env` maps the OpenAI reasoner to `http://localhost:8787/v1` model `google_gemma-4-E4B-it-qat-q4_0-gguf`, the Arch classifier to `katanemo_Arch-Router-1.5B.gguf`, and the SLM/filler Ollama-compatible path to `http://localhost:8787` model `Qwen_Qwen3-4B-GGUF`.
- Aha: Avalon currently serves GGUF through `llama-cli` subprocess calls, not a resident LM Studio server, so router timeouts must be higher than the old hot-model defaults. Use `OASIS_ARCH_TIMEOUT_MS=15000` and `OASIS_SLM_TIMEOUT_MS=20000` for this setup.
- Aha: medium-complexity Oasis turns should prefer Qwen for speed while preserving Gemma for harder reasoning. `OASIS_MEDIUM_REASONER_MODEL=Qwen_Qwen3-4B-GGUF` makes the pipeline pass a per-turn model override for `question_simple` / `factual-lookup` escalations only; complex/tool turns keep `OPENAI_MODEL=google_gemma-4-E4B-it-qat-q4_0-gguf`.
- Aha: Avalon currently exposes `ewinregirgojr_MiniCPM5-1B-Agentic-Tooluse-GGUF`, `google_gemma-4-E4B-it-qat-q4_0-gguf`, `ankk98_dspark-gemma4-12b-block7-Q4_0-GGUF`, `Qwen_Qwen3-4B-GGUF`, and `katanemo_Arch-Router-1.5B.gguf`. For the router's strict JSON/reply call, MiniCPM5-1B is the first smaller replacement to benchmark; Arch-Router remains the fastest option for classification but does not generate JSON replies.
- Aha: for a new local formatting/JSON model, Qwen3.5-2B Instruct in non-thinking mode is a better current target than Qwen3-4B: it is much smaller while retaining stronger instruction/structured-output behavior. Qwen3.5-0.8B is the speed-first fallback; Ministral 3 3B Instruct is the quality-first structured-output alternative.
- Aha (2026-07-28): Avalon's model list drifts between restarts — `Qwen_Qwen3-4B-GGUF` and `google_gemma-4-E4B-it-qat-q4_0-gguf` were replaced by `unsloth_Qwen3.5-4B-GGUF`, `lmstudio-community_gemma-4-E4B-it-GGUF`, and `mradermacher_Qwen3.5-2B-GPT-5.1-HighIQ-INSTRUCT-GGUF`. A stale model name 404s instantly and the STT semantic/formatting stage silently never applies ("always failed to format"). The server now probes `/v1/models` at startup and logs `configured model missing from model server`; check that log line first when formatting or routing degrades.
- Aha (2026-07-28): the STT correction model and timeout are now `OASIS_STT_CORRECT_MODEL` / `OASIS_STT_CORRECT_TIMEOUT_MS` (default: medium-reasoner model, 10s). The old hardcoded 2.5s timeout aborted nearly every correction on Avalon's llama-cli cold starts. Postprocess stage failures surface in `PostProcessResult.errors` and are logged as `stt.postprocess stage failed`.

## Speech Text

- Aha: user-facing model text may contain markdown (`*anime title*`, `**bold**`, bullets, links). Do not pass raw markdown to TTS, because the R1/Kokoro path can literally read punctuation such as `asterisk`. `sanitizeMarkdownForSpeech()` now strips common markdown before `PassthroughTts` and before `Pipeline.streamTts()` calls any backend, while preserving the spoken words.
- Aha: Gemma can emit its hidden reasoning in normal content as `[Start thinking] ... [End thinking]` or markdown-wrapped `**Thought:** ... **Answer:**`, not only OpenAI-style `reasoning_content` or `<think>` tags. The pipeline `ThinkingFilter` now routes those bracketed/markdown thought blocks to `think.token` diagnostics and strips leading `Final Answer:` labels before TTS. Live Gemma smoke for `what is two plus two?` emitted TTS `Two plus two is four.` while the reasoning stayed out of speech.
- Default policy: keep model thinking off unless the user explicitly asks for reasoning. `OpenAIReasoner` now injects a reasoning policy system message that forbids hidden scratchpad output (`Thought`, `Thinking Process`, `[Start thinking]`, etc.) and asks for direct final answers by default. If reasoning is explicitly requested, the model should provide only a concise user-facing rationale, not private chain-of-thought. Live Gemma smoke emitted `Two plus two equals four.` to TTS with no spoken thinking.

## STT Backends

- Aha (2026-07-28): SenseVoice emits internal tags (`<|en|>`, `<|NEUTRAL|>`, …) that can sit directly between words; stripping them with an empty string welds the neighboring words together ("word<|en|>Next" → "wordNext"). `funasr-bridge.py` must replace tags with a space and collapse runs. Also pass `use_itn=True` to `model.generate` or the transcript has no punctuation/casing.

### API startup
- Aha: a Finder-launched app may no longer be adjacent to the checkout; `make-app.sh` embeds the build checkout in `OasisEchoServerRepoRoot`, while `RepoRoot` still validates configured, current-directory, and bundle candidates before spawning the local API.
- Aha: launching through `npm run server` can leave the npm parent alive for minutes before the workspace child starts when invoked from the GUI; the Mac launcher now executes the workspace server entrypoint directly with Node and logs spawn/exit diagnostics.
- Aha (2026-08-01): Finder-launched macOS apps inherit launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so bare `node` exits with status 127 even when Node works in Terminal. `ServerLaunchCommand` must resolve executable Node paths such as `/opt/homebrew/bin/node` before spawning the API.
- Aha: the macOS app must always probe `/config` during launch and start the local API when it is unavailable; do not gate this recovery path on the legacy `autoStartServer` preference. Docker vs `npm run server` remains selectable.
- Aha: heartbeat recovery must probe `/config` even when `serverReachable` is already true; otherwise an API process can die behind a stale SSE state and never reach `ServerAutoLauncher`.
- Aha: Echo mode initially displays raw STT text, so the Mac client must apply the server's `stt.postprocess` event to the latest user message; otherwise spacing and phonetic corrections are only used for reasoning while malformed text remains visible.
- Aha: applying a postprocess result by mutating `agentMessages[index]` in place can bypass SwiftUI `@Published` notification; replace the whole message array when formatting the latest user transcript.
- Aha: short STT artifacts such as `u`, `ur`, and `r` should trigger semantic correction; the local Ollama-compatible SLM can repair ambiguous transcripts even when the primary dialogue reasoner is OpenAI or Anthropic.
- Aha: Avalon exposes the correction model through OpenAI-compatible `/v1/chat/completions`, not Ollama `/api/generate`; when `OPENAI_BASE_URL` points at Avalon, semantic STT correction must use that protocol or it silently falls back to raw text.
- Aha: transcript corrections must never block dictation; deliver the raw transcript immediately, surface semantic proposals as a bounded non-blocking review queue, and persist only explicitly accepted corrections.
- Aha (2026-08-21): "Accept" on the correction review bubble used to force `phraseOnly: true`, so `CorrectionStore.addCorrection` skipped word-pair extraction entirely — an accepted fix only persisted as a fuzzy match on the WHOLE accepted sentence (`PhraseMatcherStage` compares full-string similarity, not substrings). A misheard name/term corrected once never generalized to a different sentence containing the same word — this is what "vocabulary correction doesn't work" reports were about. `TurnController.acceptCorrectionReview` now omits `phraseOnly`, letting the server's `analyzeDiff` decide: it only promotes to a global word rule when exactly one token differs between original/corrected (same safety guarantee the note above intended — multi-word LLM rewrites still fall back to phrase-only).
- Aha (2026-08-21): the correction-review bubble itself almost never appeared for ordinary misheard words. `client.transcribe(_:)` never sends STT confidence (nothing in the Mac client tracks it), so `/transcribe`'s `postprocess.process()` call left `confidence` undefined; `SemanticCorrectionStage.shouldRun` then defaults `ctx.confidence ?? 1` to full confidence and only runs the LLM when text matches a fixed filler-word/duplicate-word regex. A misheard proper noun or technical term ("cubernetes" for "kubernetes") reads as a perfectly ordinary sentence to that regex, so the semantic pass — and the `reviewCandidate` flag that drives the bubble — silently never fired. Verified A/B: identical request against the pre-fix code returned `stagesApplied: [], reviewCandidate: false`; post-fix returns the LLM correction with `reviewCandidate: true`. Fix: `/transcribe` now passes `confidence: 0` unconditionally — it's a fire-and-forget background call that runs after paste already happened, so there's no latency cost to always checking. Do NOT do this for the live `/turn` path (Echo mode) — that one is genuinely latency-sensitive and should keep the confidence gate.

### Whisper (default)
- Uses `@huggingface/transformers` with `Xenova/whisper-base.en` ONNX model.
- Rolling buffer approach: accumulates PCM, re-transcribes the tail periodically.
- **ONNX Runtime limitation**: only one instance can preload at a time (two concurrent ONNX sessions SIGABRT).

### FunASR (SenseVoiceSmall) — added 2026-06-21
- **Python subprocess bridge** via `packages/coordinator/src/funasr-bridge.py`.
- Uses ModelScope's `iic/SenseVoiceSmall` model (234M params, 17x realtime on CPU).
- Communication: line-delimited JSON on stdin/stdout (`child_process.spawn`).
- The TypeScript side (`FunasrStreamingStt`) manages the rolling buffer identically to `WhisperStreamingStt`.
- The buffer is sent to Python per-inference (bridge is stateless between feeds).
- Virtual environment at repo root `.venv-funasr/` with Python 3.14.5.
- Set `OASIS_STT_BACKEND=funasr` env var to use FunASR instead of Whisper.
- Aha: manual live restart commands must include `OASIS_STT_BACKEND=funasr`, or Oasis silently falls back to Whisper because `config.ts` defaults unknown/missing values to `whisper`. `/config` now exposes `stt.backend`; verify it says `funasr` after restarts, and watch for `funasr-stt ready` rather than `streaming-stt ready ... Xenova/whisper-base.en`.
- **Key files**:
  - `packages/coordinator/src/funasr-bridge.py` — Python bridge script
  - `packages/coordinator/src/funasr-streaming-stt.ts` — TypeScript wrapper
  - `packages/app/src/config.ts` — `SttBackend` type + `OASIS_STT_BACKEND` env
  - `packages/app/src/server.ts` — conditional instantiation based on config

### Protocol (Python bridge)
Commands (JSON lines to stdin):
- `{"type":"preload"}` — load model, responds `{"type":"ready"}`
- `{"type":"feed","samples":"<base64_float32>"}` — replace buffer, responds `{"type":"ack"}`
- `{"type":"partial"}` — transcribe buffer, responds `{"type":"partial","text":"..."}`
- `{"type":"finalize"}` — transcribe buffer, responds `{"type":"final","text":"..."}`
- `{"type":"reset"}` — clear buffer, responds `{"type":"ack"}`
- On error: `{"type":"error","message":"..."}`
- stderr is inherited by parent (not part of protocol).

### Meeting mode reliability
- Meeting transcripts are autosaved locally in macOS `UserDefaults` after each
  final segment and notes edit, with a server-side `.oasis-meetings/current-draft.json`
  backup when the API is reachable. An interrupted meeting can be resumed from
  the Meeting window instead of being discarded on app/server restart.
- The meeting prompt starts at `8` and uses an observable main-run-loop timer
  to count down visibly to zero before dismissing.
- Meeting microphone buffers are also written to local CAF files under
  `~/Library/Application Support/OasisEcho/Meetings/`; transcript recovery and
  raw audio recovery are separate so a server failure does not lose either.
