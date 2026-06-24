# Oasis Echo — Agent Guidelines

## macOS App Development

### Code signing & TCC (Accessibility / Automation)

- The Mac app is **ad-hoc signed** on every local build (no stable cert).
- Ad-hoc signing changes the `CDHash` each build, which **invalidates Accessibility and Automation TCC grants**.
- After a rebuild, `AXIsProcessTrusted()` returns `false` even if the toggle appears ON in System Settings.
- The fix: `tccutil reset Accessibility` on the terminal, re-launch the app, and re-grant the permission.

### Auto-paste

- Paster.swift tries these paths in order:
  1. **CGEventPostToPid** (private SPI) — posts Cmd+V directly to target PID.
  2. **AppleScript** (`osascript` with System Events `keystroke`).
  3. **CGEventPost to `.cghidEventTap`** — only if `AXIsProcessTrusted()`.
  4. **AX insertion** (`AXUIElementSetAttributeValue` on focused element) — final fallback only.
- Do not run another paste strategy after a direct AX insertion attempt; some apps mutate the focused element even when AX reports a non-success result, which can duplicate text if followed by Cmd+V.
- On macOS 14+, all paths require Accessibility permission. Without it, auto-paste falls back to clipboard-only.
- The permission gate window shows Automation (System Events) instructions, but `keystroke` in System Events also requires Accessibility.
- AppleScript error `1002` = "not allowed to send keystrokes" = no AX permission.

### Permission gate

- `PermissionGateController` shows a modal window with instructions.
- No polling — there's no API to verify Automation permission at runtime.
- The Continue button always works; it just dismisses the gate.

### Fn / Globe key hotkey

- `FnKeyMonitor` owns a `CGEventTap` for `.flagsChanged` because Fn is a modifier and cannot be bound by KeyboardShortcuts.
- macOS can disable event taps mid-session (`tapDisabledByTimeout` / `tapDisabledByUserInput`); re-enable the tap and synthesize a release if Fn was down so push-to-talk state does not get stuck.
- Fn still requires Accessibility trust, and System Settings → Keyboard → "Press 🌐 key to" should be "Do Nothing" if macOS consumes the key.

### Wake word ("Hey Echo")

- `WakeWordDetector` uses RMS VAD (threshold 0.018) + one-shot `SFSpeechRecognizer`.
- Captures ~3.0s of audio on VAD trigger.
- Debug logs in Console.app (filter `wakeword`).
- The Node server defaults to `127.0.0.1` for local clients. Set `OASIS_LISTEN_HOST=0.0.0.0` in launchd when LAN devices such as the Phicomm R1 companion must connect to `/audio`.

### Transcript finalization

- Treat STT finals as potentially repeated or overlapping hypotheses; merge idempotently in `TurnController` before paste/echo instead of blindly appending.
- Rolling-buffer STT partials/finals can rewrite earlier words with near-overlap substitutions (not just exact suffix/prefix matches); use `TranscriptAssembler`-style token overlap merging before paste/echo.
- Server `/audio` messages carry `utteranceId`; the Mac client must ignore partial/final STT messages whose id does not match the active/finishing capture.

## Docker

- Port 9187, subnet 10.89.87.0/24.
- `docker-compose.yml` uses static IP 10.89.87.10.
- `host.docker.internal` for Ollama access.

## STT Backends

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
