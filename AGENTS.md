# Oasis Echo — Agent Guidelines

## macOS App Development

### Code signing & TCC (Accessibility / Automation)

- The Mac app is **ad-hoc signed** on every local build (no stable cert).
- Ad-hoc signing changes the `CDHash` each build, which **invalidates Accessibility and Automation TCC grants**.
- After a rebuild, `AXIsProcessTrusted()` returns `false` even if the toggle appears ON in System Settings.
- The fix: `tccutil reset Accessibility` on the terminal, re-launch the app, and re-grant the permission.

### Auto-paste

- Paster.swift tries these paths in order:
  1. **AX insertion** (`AXUIElementSetAttributeValue` on focused element) — most reliable when AX is granted.
  2. **CGEventPostToPid** (private SPI) — posts Cmd+V directly to target PID.
  3. **AppleScript** (`osascript` with System Events `keystroke`).
  4. **CGEventPost to `.cghidEventTap`** — only if `AXIsProcessTrusted()`.
- On macOS 14+, all paths require Accessibility permission. Without it, auto-paste falls back to clipboard-only.
- The permission gate window shows Automation (System Events) instructions, but `keystroke` in System Events also requires Accessibility.
- AppleScript error `1002` = "not allowed to send keystrokes" = no AX permission.

### Permission gate

- `PermissionGateController` shows a modal window with instructions.
- No polling — there's no API to verify Automation permission at runtime.
- The Continue button always works; it just dismisses the gate.

### Wake word ("Hey Echo")

- `WakeWordDetector` uses RMS VAD (threshold 0.018) + one-shot `SFSpeechRecognizer`.
- Captures ~3.0s of audio on VAD trigger.
- Debug logs in Console.app (filter `wakeword`).

## Docker

- Port 9187, subnet 10.89.87.0/24.
- `docker-compose.yml` uses static IP 10.89.87.10.
- `host.docker.internal` for Ollama access.
