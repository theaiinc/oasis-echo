# Oasis Echo — macOS app

Native SwiftUI menu-bar app. Dictate voice into any text field, or talk back-and-forth with the Oasis Echo voice agent. Floating pill HUD, global hotkeys (including the Fn / 🌐 key), default streaming-Whisper STT with on-device fallback.

Tracking issue: [#2 — macOS menu-bar app: dictate into anything, talk with Echo](https://github.com/theaiinc/oasis-echo/issues/2).

## Build

```bash
cd apps/mac
./Scripts/make-app.sh release        # produces OasisEcho.app
open OasisEcho.app
```

First launch asks for **Microphone**, **Speech Recognition**, and **Accessibility** permissions. The Accessibility prompt is what lets the app synthesize the ⌘V paste keystroke into other apps.

> Requires macOS 13+, Xcode 15+ / Swift 5.9+. Dev iteration: `swift build && swift run` (no bundle, skips permission prompts).
>
> Ad-hoc signed builds get a fresh cdhash on every rebuild, which invalidates the Accessibility grant. Toggle the OasisEcho row off/on under System Settings → Privacy & Security → Accessibility after each rebuild — or install a Developer ID Application certificate to make the grant stick.

## Run

1. Start the Oasis Echo server: `npm run server` from the repo root (default `http://127.0.0.1:3000`).
2. Launch `OasisEcho.app`. A pill appears at the bottom-center; a microphone glyph appears in the menu bar.
3. Hold the push-to-talk hotkey, speak, release. Cleaned text pastes into the focused app (Transcribe mode) or the agent replies in voice (Echo mode).

## Modes

| Mode | Hotkey | Behavior |
|---|---|---|
| **Transcribe** | hold `⌃⌥O` (or hold **Fn / 🌐**) | mic → Whisper WS → POST `/transcribe` (rule + context-bias + phrase-match + LLM correction) → ⌘V paste at cursor |
| **Echo** (voice agent) | hold `⌃⌥O` (or hold **Fn / 🌐**) | mic → STT → POST `/turn` → server streams `tts.chunk` (Kokoro PCM) + emotion directives → playback through the system audio graph |
| **Switch mode** | `⌘⇧M` | flip Transcribe ⇄ Echo anywhere — surfaces a toast above the orb |
| **Hands-free** | `⌃⌥⇧O` | toggle (press to start, press to stop) — useful when you don't want to hold a key for a long Echo turn |

All hotkeys are remappable in **Settings → Shortcuts**. The Fn-key listener can be disabled in **Settings → General**. Custom STT vocabulary and learned corrections live under **Settings → Dictionary**.

> If the Fn key produces no events, set System Settings → Keyboard → "Press 🌐 key to" to **Do Nothing** so macOS stops consuming it for dictation / emoji picker.

## Architecture

```
Mac App (Swift)                              Oasis Echo server :3000
─────────────────                            ───────────────────────────
Core Audio mic ──► AudioResampler ──► WS    ┌────────────────┐
   (AVAudioEngine)    (16 kHz mono Float32) │  /audio (WS)   │ ◄─ default streaming STT (Whisper)
                                            │  /transcribe   │ ◄─ Transcribe post-process
KeyboardShortcuts + FnKeyMonitor ──► HotkeyManager  │  /turn        │ ◄─ Echo
Accessibility paste ◄── Paster (CGEvent ⌘V)         │  /events (SSE)│ → token / tts.chunk / emotion / turn.complete
AVAudioPlayerNode ◄── tts.chunk (PCM16)             │  /correction  │
MediaRemote duck/resume                             │  /backchannel │
                                                    └────────────────┘
```

- **STT default is the server's streaming Whisper endpoint** over a persistent WebSocket. Falls back to Apple `SFSpeechRecognizer` (on-device, offline) when configured. Either way, only the audio you spoke during a hotkey hold is sent.
- **SSE** events drive the Echo HUD (tokens, TTS PCM, emotion directives, turn completion, post-process traces).
- **Auto-paste** synthesizes a ⌘V keystroke via `CGEvent`, so it works in any text context (Slack, Mail, ChatGPT, Code, Messages, etc.). Falls back to AppleScript when CGEvent is rejected.
- **Audio-drain tracking** keeps the orb in `.speaking` state until Kokoro's playback queue actually empties — not just until `turn.complete` arrives.
- **Mid-utterance backchannels** ("uh huh", "mhm") fire only while the reasoner is still thinking and never overlap the agent's reply.
- **Media ducking** pauses YouTube / Spotify / Music via MediaRemote when capture starts and resumes when the turn ends.

## UI panels

The HUD is split across two `NSPanel`s that share `AppState` via `@EnvironmentObject`:

| Panel | Size | Contents |
|---|---|---|
| **Orb panel** | 60×60 (grows to ≤340×90 for transient toasts) | The pulsing orb, mode-tinted, plus toast bubbles (Pasted / Copied · ⌘V / Mode switched / errors / Polishing…) and the live partial-transcript caption. |
| **Echo dialog panel** | 480×220 (fixed) | Frosted-glass card hosting the agent's reply text. Bottom 20 % fades to transparent so the dialog visually dissolves into the orb. Shown only while `state.isHudExpanded`. |

The dialog lives in its own panel — instead of growing the orb panel under SwiftUI — to avoid a layout bug where the SwiftUI content was laid into the orb's original 60 px content rect even though the panel had grown. Two fixed-size panels make that race impossible.

## Key files

| Concern | File |
|---|---|
| App entry, menu bar | `Sources/OasisEcho/OasisEchoApp.swift` |
| Global state | `Sources/OasisEcho/AppState.swift` |
| Orb panel + container | `Sources/OasisEcho/UI/PillWindow.swift`, `UI/PillView.swift` |
| Echo dialog panel | `Sources/OasisEcho/UI/EchoDialogWindow.swift`, `UI/EchoHUDView.swift` |
| Menu bar content | `Sources/OasisEcho/UI/MenuBarContent.swift` |
| Settings | `Sources/OasisEcho/UI/SettingsView.swift` |
| Hotkeys | `Sources/OasisEcho/Hotkeys/HotkeyManager.swift`, `Hotkeys/FnKeyMonitor.swift` |
| Mic, playback, ducking | `Sources/OasisEcho/Audio/MicCapture.swift`, `Audio/AudioPlayer.swift`, `Audio/AudioResampler.swift`, `Audio/MediaControl.swift` |
| STT engines | `Sources/OasisEcho/STT/STTEngine.swift`, `STT/ServerSTTEngine.swift` (default WS), `STT/SpeechTranscriber.swift` (fallback) |
| Paste | `Sources/OasisEcho/Paste/Paster.swift` |
| HTTP / SSE / WS | `Sources/OasisEcho/Network/OasisClient.swift`, `Network/SSEClient.swift`, `Network/Events.swift` |
| Orchestration | `Sources/OasisEcho/Pipeline/TurnController.swift` |

## Server requirements

The app talks to the same Node server the web UI uses (`packages/app`). The endpoints it depends on:

| Endpoint | Purpose |
|---|---|
| `GET /config` | Liveness + reasoner / model identity for the menu bar status line |
| `WS  /audio` | Default streaming STT (16 kHz mono Float32 frames in, partial / final transcript text out) |
| `POST /transcribe` | Transcribe-mode post-process pipeline (rules + context-bias + phrase-match + optional LLM correction) |
| `POST /turn` | Echo-mode reasoning + Kokoro TTS via SSE |
| `GET /events` | Server-sent event stream for `tts.chunk`, `emotion.directives`, `turn.complete`, `stt.postprocess`, etc. |
| `POST /correction` | Teaches the post-process pipeline a `{ original, corrected }` pair from the dictionary editor |
| `POST /backchannel` | Plays a pre-synthesized "still listening" cue mid-utterance |

Everything else (router, reasoners, Kokoro TTS) is shared with the web UI — see the [root README](../../README.md) for backend configuration.
