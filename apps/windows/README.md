# Oasis Echo for Windows

A notification-area (tray) app that listens for **"Hey Echo"**, then takes your
request and plays Echo's spoken reply. It is the Windows port of the macOS app's
wake word (`apps/mac/Sources/OasisEcho/Pipeline/WakeWordDetector.swift`) and the
Echo turn it starts.

## Install

1. Download `OasisEcho-Windows-<version>-x64.zip` from the
   [Releases](https://github.com/theaiinc/oasis-echo/releases) page (tags `win-v*`).
2. Unzip and run `OasisEcho.exe` (Windows 10 or 11, x64; self-contained, no .NET install).
   The build isn't code-signed yet: if SmartScreen says "Windows protected your PC",
   choose **More info → Run anyway**.
3. Allow microphone access if Windows asks (Settings → Privacy & security → Microphone →
   "Let desktop apps access your microphone").

It needs an **Oasis Echo server** to talk to: the same Node server the macOS app uses
(`npm run server` or Docker, see the repository README), on `http://127.0.0.1:9187`
by default. To use a server elsewhere, choose **Edit settings…** in the tray menu and
change `ServerUrl`, then restart the app.

### Code signing

Windows releases are signed through the SignPath Foundation's free program for open-source
projects: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/). (Until that's approved, releases are unsigned; each
release's notes say which.)

## Use

- Say **"Hey Echo"**. A chime means it's listening: ask your question, then pause.
- Or say it in one go: **"Hey Echo, what's on my calendar today?"**
- The reply plays through your default speakers. While Echo is listening or speaking,
  the wake word is paused, so its own voice can't trigger it.
- Tray menu: turn **Listen for "Hey Echo"** on or off, open the log, edit settings, quit.

## How it works

Like the macOS detector: a light energy VAD watches the microphone; when speech
starts, the clip around it (from just before the speech, up to 3 s, ending at a short
pause) is transcribed once and checked for the phrase, with the same misrecognitions
accepted ("hey ecko", "hay echo", …). macOS uses Apple's on-device recognizer for that
pass; Windows sends it to the Echo server's `/audio` listener, the same one the macOS
app streams to (Whisper or FunASR, whichever the server runs). After a match the app
records the request until a 0.9 s pause, transcribes it the same way, sends it to
`/turn`, and plays the `tts.chunk` audio from `/events`.

Settings (`%APPDATA%\OasisEcho\settings.json`):

| Key | Default | |
|---|---|---|
| `ServerUrl` | `http://127.0.0.1:9187` | Echo server |
| `WakeWordEnabled` | `true` | Listen for "Hey Echo" |
| `VadThreshold` | `0.018` | Speech level (RMS of a 20 ms window); raise it in a noisy room |

Log: `%APPDATA%\OasisEcho\oasis-echo.log` (every recognition pass and whether it matched).

## Build

```
cd apps/windows
dotnet test tests/OasisEcho.Core.Tests
dotnet publish src/OasisEcho -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

`OasisEcho.Core` (wake word, VAD, server client) is plain .NET 8 and builds and tests
on any OS; `OasisEcho` (WinForms, NAudio) builds anywhere but runs only on Windows.
A `win-v*` tag runs `.github/workflows/windows-release.yml`, which publishes the release.
