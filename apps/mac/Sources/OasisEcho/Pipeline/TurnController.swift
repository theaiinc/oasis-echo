import Foundation
import AVFoundation
import Combine
import SwiftUI

// Owns the capture → STT → post-process → (paste | echo) loop. All
// user-visible state flows through AppState so the UI stays reactive.
//
// Transcribe mode:
//   hotkey down → MicCapture.start → SpeechTranscriber.start
//   partials update the live pill caption
//   hotkey up → finish → POST /transcribe → paste cleaned text.
//
// Echo mode:
//   hotkey down → capture + STT as above
//   on final → POST /turn (server streams SSE: tts.chunk, emotion…)
//   AudioPlayer enqueues PCM and the pill shows "Echo".

@MainActor
final class TurnController: ObservableObject {
    private let state: AppState
    private var client: OasisClient
    private let mic = MicCapture()
    private let player = AudioPlayer()
    private var stt: STTEngine?
    private var persistentServerSTT: ServerSTTEngine?
    private var pill: PillWindowController?
    private var eventsOpen = false
    // Streaming STT (server Whisper) emits one `stt.final` per VAD
    // segment, not one per turn. A long sentence with a natural breath
    // in the middle arrives as TWO finals; the user releasing the
    // hotkey is what actually ends the turn. So we accumulate segment
    // finals into `committedTranscript` and keep the in-flight
    // partial in `pendingPartial`; the live caption shows their join.
    private var committedTranscript: String = ""
    private var pendingPartial: String = ""
    private var committedForEcho: Bool = false
    // Set the moment finishAfterSTT runs (whether through the user's
    // release-driven grace, the safety net, or an explicit
    // cancellation). Prevents double-paste when multiple paths fire —
    // e.g. fallback marks "no speech", real final arrives later with
    // the transcript and tries to paste again.
    private var finishCommitted: Bool = false
    // True between commitCapture (user release) and finishAfterSTT.
    // Used to know whether late-arriving STT finals should EXTEND the
    // grace window (we're past commit and waiting for the trailing
    // segment) vs simply update the live caption (still mid-utterance).
    private var commitInProgress: Bool = false
    private var handsFreeActive: Bool = false
    private var lastStartMs: Int64 = 0
    private var pillCancellable: AnyCancellable?
    private var hudCloseTask: Task<Void, Never>?
    // The 8 s "STT never came back" guard scheduled in commitCapture.
    // Stored so beginCapture/cancelCapture can cancel it — otherwise an
    // earlier capture's safety net fires during the next capture, sees
    // finishCommitted == false (just reset) and the transcript empty
    // (also just reset), and flashes "No speech detected" in the
    // middle of the user still talking.
    private var safetyNetTask: Task<Void, Never>?
    // Short post-release grace window. After the user releases the
    // hotkey we send `end` to the STT engine and wait this long for the
    // trailing segment final to arrive before finalising. Each new
    // partial / final landing during the grace bumps it forward, so a
    // server that flushes multiple segments still gets fully captured.
    private var graceTask: Task<Void, Never>?
    private var firstRealTtsChunkReceived: Bool = false
    private var lastSSEEventAt: Date = .distantPast
    // Echo finalisation needs BOTH signals before we can drop pill state
    // out of .speaking: the server's turn.complete (text generation
    // done) AND the audio queue actually draining (Kokoro chunks fully
    // played). Whichever lands second triggers finalizeEcho.
    private var pendingTurnCompleteText: String? = nil
    private var sawTurnComplete: Bool = false
    // Backchannel triggers run from the mic-level callback while the
    // user is mid-utterance. Reset at the start of each capture.
    private var bcListeningStartedAt: Date?
    private var bcLastPlayedAt: Date = .distantPast
    private var bcPauseStartedAt: Date?

    init(state: AppState) {
        self.state = state
        self.client = OasisClient(baseURL: URL(string: state.serverBaseURL) ?? URL(string: "http://127.0.0.1:3000")!)

        pillCancellable = state.$pill
            .dropFirst()
            .sink { new in
                if case .idle = new {
                    Task { @MainActor in MediaControl.resumeIfPaused() }
                }
            }

        // The audio drain callback is what flips Echo out of .speaking
        // once Kokoro's queue is empty. We hop to the main actor to
        // touch state safely.
        player.onQueueDrained = { [weak self] in
            Task { @MainActor [weak self] in
                self?.audioQueueDrained()
            }
        }
    }

    func bindPill(_ p: PillWindowController) { self.pill = p }

    // MARK: - Bootstrap

    func bootstrap() async {
        // Do NOT proactively request Speech authorization here. That
        // touches SFSpeechRecognizer, which hits TCC — and if the
        // app's "responsible process" (per macOS attribution) lacks
        // NSSpeechRecognitionUsageDescription, the WHOLE PROCESS gets
        // SIGABRT'd. We only request Speech when the Apple engine is
        // actually selected AND the user triggers a capture.
        _ = Paster.ensureAccessibilityAuthorized()

        // Warm up the audio graph on launch so the first backchannel
        // plays with no perceptible gap. Logs to Console.app on
        // failure; there's nothing useful the user can do about it.
        try? player.prepare()

        await reconnect()
        startHeartbeat()
    }

    // Poll /config every few seconds while offline; when it returns,
    // re-open the SSE stream. Localhost, so the cost is negligible.
    private var heartbeat: Task<Void, Never>?
    private func startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let self else { return }

                // Two independent health checks:
                //   (1) HTTP `/config` — is the server process up?
                //   (2) SSE liveness — have we received ANY event in
                //       the last 20 s? The server sends a keep-alive
                //       every 15 s, so silence longer than that means
                //       the stream died without a clean close. This is
                //       the critical case — URLSession won't fire
                //       `didCompleteWithError` for a silently dropped
                //       peer, so we'd otherwise stare at a dead socket
                //       forever.
                if !self.state.serverReachable {
                    await self.reconnect()
                    continue
                }
                let secondsSinceLastEvent = Date().timeIntervalSince(self.lastSSEEventAt)
                if secondsSinceLastEvent > 20 {
                    await self.reopenEventStream()
                }
            }
        }
    }

    private func reconnect() async {
        await refreshServer()
        if state.serverReachable {
            await reopenEventStream()
        }
    }

    private func reopenEventStream() async {
        await client.closeEventStream()
        eventsOpen = false
        await openEventStream()
        lastSSEEventAt = Date()  // grace window before the next staleness check
    }

    func shutdown() {
        heartbeat?.cancel()
        mic.stop()
        stt?.cancel()
        persistentServerSTT?.shutdown()
        player.stop()
        Task { await client.closeEventStream() }
    }

    private func refreshServer() async {
        if let url = URL(string: state.serverBaseURL) { await client.updateBase(url) }
        if let cfg = await client.ping() {
            state.serverReachable = true
            state.serverModel = [cfg.backend, cfg.model].compactMap { $0 }.joined(separator: " · ")
        } else {
            state.serverReachable = false
        }
    }

    private func openEventStream() async {
        if eventsOpen { await client.closeEventStream(); eventsOpen = false }
        eventsOpen = true
        lastSSEEventAt = Date()
        await client.openEventStream(
            onEvent: { [weak self] ev in
                Task { @MainActor [weak self] in
                    self?.lastSSEEventAt = Date()
                    self?.handleSSE(ev)
                }
            },
            onError: { [weak self] _ in
                // An SSE error doesn't necessarily mean the server is
                // gone — the TCP stream may have dropped for network
                // reasons. Mark the stream closed so the heartbeat
                // reopens it, but leave `serverReachable` alone.
                Task { @MainActor [weak self] in
                    self?.eventsOpen = false
                }
            }
        )
    }

    // MARK: - Hotkey entry points

    func startPushToTalk() { beginCapture() }
    func endPushToTalk()   { commitCapture() }

    func toggleHandsFree() {
        if handsFreeActive { commitCapture(); handsFreeActive = false }
        else { beginCapture(); handsFreeActive = true }
    }

    func onModeChanged(_ mode: Mode) {
        // Cancel any in-flight capture when the user flips mode mid-turn.
        if case .listening = state.pill {
            cancelCapture()
        }
        // No flash here — AppState.setMode already shows the proper
        // .modeSwitched(mode) toast. A second flashPill() here would
        // overwrite it with stale state (this is what caused the
        // mysterious "Pasted" bubble after ⌘⇧M).
    }

    // MARK: - Capture lifecycle

    private func beginCapture() {
        guard case .idle = state.pill else { return }
        // Kill any in-flight safety net / grace task from the previous
        // capture before their timers fire under the new capture's
        // reset state.
        safetyNetTask?.cancel(); safetyNetTask = nil
        graceTask?.cancel();     graceTask = nil
        committedTranscript = ""
        pendingPartial = ""
        committedForEcho = false
        finishCommitted = false
        commitInProgress = false
        lastStartMs = Self.nowMs()
        state.liveTranscript = ""
        state.pill = .listening(level: 0)
        // Reset backchannel state for this capture.
        bcListeningStartedAt = state.mode == .echo ? Date() : nil
        bcLastPlayedAt = .distantPast
        bcPauseStartedAt = nil
        if state.pauseOtherMedia { MediaControl.pauseIfPlaying() }

        do {
            let transcriber: STTEngine = makeEngine()
            try transcriber.start(
                onPartial: { [weak self] text in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.pendingPartial = text
                        self.state.liveTranscript = self.fullTranscript()
                        // A late partial landing in the grace window
                        // means the STT engine isn't done yet — give it
                        // a bit more time before we finalise.
                        if self.commitInProgress { self.scheduleFinalize() }
                    }
                },
                onFinal: { [weak self] text in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        // Accumulate, don't overwrite. Streaming Whisper
                        // emits one final per VAD segment — a long
                        // utterance with a natural breath shows up as
                        // multiple finals and we want them all.
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            if self.committedTranscript.isEmpty {
                                self.committedTranscript = trimmed
                            } else {
                                self.committedTranscript += " " + trimmed
                            }
                        }
                        self.pendingPartial = ""
                        self.state.liveTranscript = self.committedTranscript
                        // The user hasn't released yet — keep the turn
                        // open, more segments may follow. If the user
                        // HAS released and we're in the grace window,
                        // bump it so a trailing segment-final still
                        // makes it in.
                        if self.commitInProgress { self.scheduleFinalize() }
                    }
                },
                onError: { [weak self] err in
                    Task { @MainActor [weak self] in self?.fail(err.localizedDescription) }
                }
            )
            self.stt = transcriber

            try mic.start(
                onBuffer: { [weak self] buf in self?.stt?.append(buf) },
                onLevel: { [weak self] level in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if case .listening = self.state.pill {
                            self.state.pill = .listening(level: level)
                            self.maybeFireBackchannel(level: level)
                        }
                    }
                }
            )
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func commitCapture() {
        guard case .listening = state.pill else { return }
        state.pill = .processing
        mic.stop()
        stt?.finish()
        commitInProgress = true
        // Wait briefly for the trailing segment final to arrive after
        // we sent `end` to the STT engine. The grace task gets bumped
        // every time a new partial / final lands, so a server that
        // flushes multiple pending segments still gets fully captured.
        scheduleFinalize()
        // Safety net for catastrophic STT failure (WS dropped after
        // `end`, server stuck, no final ever delivered). 8 s is well
        // beyond a normal Whisper inference for any reasonable
        // utterance, so this fires only when something is truly wrong
        // and never preempts a slow-but-working transcription.
        // Stored on `safetyNetTask` so the next beginCapture/cancel can
        // cancel it before it fires under fresh capture state.
        safetyNetTask?.cancel()
        safetyNetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if !self.finishCommitted {
                self.finishAfterSTT(finalText: self.fullTranscript())
            }
        }
    }

    private func cancelCapture() {
        safetyNetTask?.cancel(); safetyNetTask = nil
        graceTask?.cancel();     graceTask = nil
        commitInProgress = false
        mic.stop()
        stt?.cancel()
        stt = nil
        state.liveTranscript = ""
        state.pill = .idle
    }

    // Combined committed segments + the in-flight partial. This is what
    // gets handed to handleTranscribe / handleEcho when the turn ends.
    private func fullTranscript() -> String {
        if pendingPartial.isEmpty { return committedTranscript }
        if committedTranscript.isEmpty { return pendingPartial }
        return committedTranscript + " " + pendingPartial
    }

    // Schedule (or bump) the post-release grace timer that finalises
    // the turn with whatever's accumulated. Cancelled by beginCapture /
    // cancelCapture so a stale grace doesn't preempt the next capture.
    private func scheduleFinalize() {
        graceTask?.cancel()
        graceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, !Task.isCancelled else { return }
            self.finishAfterSTT(finalText: self.fullTranscript())
        }
    }

    private func finishAfterSTT(finalText: String) {
        // Idempotent — if the grace task and the 8 s safety net both
        // fire (or grace + a late onFinal), the second call is a no-op.
        // Without this guard you could get the dreaded "No speech
        // detected" flash followed moments later by the real text pasting.
        guard !finishCommitted else { return }
        finishCommitted = true
        commitInProgress = false
        graceTask?.cancel(); graceTask = nil
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        stt = nil
        guard !text.isEmpty else {
            state.flashPill(.error("No speech detected"))
            return
        }
        switch state.mode {
        case .transcribe: handleTranscribe(raw: text)
        case .echo:       handleEcho(raw: text)
        }
    }

    // MARK: - Transcribe mode

    private func handleTranscribe(raw: String) {
        let startMs = Self.nowMs()
        Task { [weak self] in
            guard let self else { return }
            var cleaned = raw
            if state.serverReachable {
                do {
                    let resp = try await client.transcribe(raw)
                    cleaned = resp.text
                } catch {
                    // Fall through with raw text; don't block the paste.
                }
            }
            await MainActor.run {
                let words = cleaned.split(whereSeparator: { $0.isWhitespace }).count
                let totalMs = Int(Self.nowMs() - startMs)
                if self.state.autoPaste {
                    switch Paster.paste(cleaned) {
                    case .pasted:
                        self.state.flashPill(.pasted(words: words, ms: totalMs), after: 1.2)
                    case .copiedOnly:
                        // Text is on the clipboard. macOS blocked the
                        // synthetic keystroke (no Accessibility grant).
                        // Show the pill state AND, on first occurrence
                        // this session, an alert that opens System
                        // Settings directly. After that, every paste
                        // just shows the pill (no nag-loop).
                        self.state.flashPill(.copiedOnly(words: words), after: 2.4)
                        Paster.showAccessibilityFailureAlert()
                    case .empty:
                        break
                    }
                } else {
                    self.state.flashPill(.pasted(words: words, ms: totalMs), after: 1.2)
                }
                self.state.liveTranscript = ""
            }
        }
    }

    // MARK: - Echo mode

    private func handleEcho(raw: String) {
        committedForEcho = true
        firstRealTtsChunkReceived = false
        sawTurnComplete = false
        pendingTurnCompleteText = nil
        // Drop any leftover audio counters from a previous turn so the
        // drain callback fires for THIS turn's audio only.
        player.resetQueue()
        // If user starts a new turn during the post-turn window, kill
        // the pending close-and-wipe task — they're continuing the
        // conversation, don't tear down the HUD under them.
        hudCloseTask?.cancel(); hudCloseTask = nil
        state.pill = .speaking
        state.isHudExpanded = true
        state.agentMessages.append(.init(role: .user, text: raw, partial: false))
        state.agentMessages.append(.init(role: .echo, text: "", partial: true))
        Task { [weak self] in
            guard let self else { return }
            do {
                try await client.sendTurn(text: raw)
            } catch {
                await MainActor.run { self.fail(error.localizedDescription) }
            }
        }
    }

    // "I'm still listening" cue, played WHILE the user is talking — not
    // while the reasoner thinks. Triggers when:
    //   • Echo mode is active
    //   • the user has been talking for at least 4 s (don't acknowledge
    //     a quick "yes/no")
    //   • the mic level dropped (a real micro-pause), held low for 300 ms
    //   • we haven't fired one in the last 5 s (cooldown)
    // After firing, pauseStartedAt resets so the user has to take ANOTHER
    // breath before we'd say it again.
    private func maybeFireBackchannel(level: Float) {
        guard state.mode == .echo, let started = bcListeningStartedAt else { return }
        let now = Date()
        if level < 0.07 {
            if bcPauseStartedAt == nil { bcPauseStartedAt = now }
            let listenedFor = now.timeIntervalSince(started)
            let pausedFor = now.timeIntervalSince(bcPauseStartedAt ?? now)
            let sinceLast = now.timeIntervalSince(bcLastPlayedAt)
            if listenedFor >= 4.0, pausedFor >= 0.3, sinceLast >= 5.0 {
                bcLastPlayedAt = now
                bcPauseStartedAt = nil
                playOneBackchannel()
            }
        } else {
            bcPauseStartedAt = nil
        }
    }

    private func playOneBackchannel() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let clip = await self.client.backchannel(),
               let pcm = Data(base64Encoded: clip.audio) {
                self.player.enqueue(pcm16: pcm, sampleRate: clip.sampleRate, final: false)
            }
        }
    }

    // MARK: - SSE events

    private func handleSSE(_ ev: SSEClient.Event) {
        guard let data = ev.data.data(using: .utf8) else { return }
        switch ev.name {
        case "tts.chunk":
            if let chunk = try? JSONDecoder().decode(TtsChunkEvent.self, from: data) {
                let isFiller = chunk.filler == true
                if !isFiller { firstRealTtsChunkReceived = true }
                if state.mode == .echo, let b64 = chunk.audio, let pcm = Data(base64Encoded: b64) {
                    // Always play audio — fillers are entirely about
                    // the audible "still listening" cue.
                    player.enqueue(pcm16: pcm, sampleRate: chunk.sampleRate ?? 24_000, final: chunk.final ?? false)
                }
                // Fillers are pre-recorded acknowledgements — they
                // never contribute to the visible transcript.
                if !isFiller {
                    appendEchoText(chunk.text, final: chunk.final ?? false)
                }
            }
        case "stt.postprocess":
            if let e = try? JSONDecoder().decode(SttPostprocessEvent.self, from: data) {
                // No-op in Mac; /transcribe returns the cleaned text
                // directly. The stream copy is useful in Echo mode when
                // the server’s own STT path runs — it can still reach
                // here via websocket capture. Keep for parity.
                _ = e
            }
        case "emotion.directives":
            if let e = try? JSONDecoder().decode(EmotionDirectivesEvent.self, from: data) {
                state.emotionTag = [e.effective, e.strategy].compactMap { $0 }.joined(separator: " · ")
                player.applyDirectives(rate: e.directives?.playbackRate, gainDb: e.directives?.gain)
            }
        case "turn.complete":
            if let e = try? JSONDecoder().decode(TurnCompleteEvent.self, from: data) {
                // Don't flip pill to .idle yet — Kokoro's audio queue
                // is almost certainly still draining. Mark this turn as
                // server-finished and let the audio-drain callback
                // close it out. If the queue is already idle (TTS
                // disabled / passthrough), close immediately.
                pendingTurnCompleteText = e.turn.agentText ?? ""
                sawTurnComplete = true
                if player.isQueueIdle {
                    finalizeEcho(text: pendingTurnCompleteText ?? "")
                    pendingTurnCompleteText = nil
                }
            }
        case "error":
            if let e = try? JSONDecoder().decode(ErrorEvent.self, from: data) {
                fail(e.message ?? "error")
            }
        default: break
        }
    }

    private func appendEchoText(_ piece: String, final: Bool) {
        guard state.mode == .echo, !piece.isEmpty else { return }
        if var last = state.agentMessages.last, last.role == .echo, last.partial {
            last.text += piece
            state.agentMessages[state.agentMessages.count - 1] = last
        } else {
            state.agentMessages.append(.init(role: .echo, text: piece, partial: !final))
        }
    }

    // Called from AudioPlayer.onQueueDrained on the main actor. Runs
    // finalizeEcho only if the server has also signalled turn.complete;
    // otherwise we keep waiting (more chunks may still arrive).
    private func audioQueueDrained() {
        guard sawTurnComplete else { return }
        let text = pendingTurnCompleteText ?? ""
        pendingTurnCompleteText = nil
        sawTurnComplete = false
        finalizeEcho(text: text)
    }

    private func finalizeEcho(text: String) {
        if var last = state.agentMessages.last, last.role == .echo, last.partial {
            if !text.isEmpty { last.text = text }
            last.partial = false
            state.agentMessages[state.agentMessages.count - 1] = last
        }
        state.pill = .idle
        // Keep the HUD on screen for a couple seconds so the user can
        // read the reply; then auto-collapse and clear stale chat so
        // the next Echo turn starts from a clean slate.
        hudCloseTask?.cancel()
        hudCloseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.state.isHudExpanded = false
            // Wait for the collapse animation before wiping content,
            // otherwise the user sees the messages disappear mid-shrink.
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            self.state.agentMessages = []
            self.state.emotionTag = ""
        }
    }

    private func fail(_ msg: String) {
        mic.stop()
        stt?.cancel()
        stt = nil
        state.flashPill(.error(msg))
    }

    // MARK: - Dictionary learning

    func teachCorrection(original: String, corrected: String) async throws {
        try await client.learnCorrection(original: original, corrected: corrected)
    }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    // Picks the engine the user selected in Settings. Server engine falls
    // back to Apple Speech if the base URL is malformed — we don't want
    // a bad URL to brick dictation entirely.
    private func makeEngine() -> STTEngine {
        switch state.sttEngine {
        case .appleSpeech:
            return SpeechTranscriber()
        case .serverWhisper:
            // Reuse one persistent socket across every capture. The
            // server's Whisper instance is reset/reused too — creating
            // fresh WSes per turn triggers ONNX races and a server
            // SIGABRT.
            if let url = URL(string: state.serverBaseURL) {
                if let existing = persistentServerSTT {
                    return existing
                }
                let e = ServerSTTEngine(serverBaseURL: url)
                persistentServerSTT = e
                return e
            }
            return SpeechTranscriber()
        }
    }
}
