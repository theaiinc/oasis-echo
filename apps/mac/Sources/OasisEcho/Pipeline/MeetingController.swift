import Foundation
import AVFoundation
import Combine
import SwiftUI

// Continuous-capture state machine for meeting recording. Independent of
// TurnController (which is hotkey-driven push-to-talk). Owns its own
// MicCapture + ServerSTTEngine instance so a meeting can run end-to-end
// without interfering with normal Echo/Transcribe turns.
//
// Lifecycle:
//   .idle ── start() ──▶ .recording ── stop() ──▶ .generating ──▶ .completed | .failed
//   reset() returns to .idle for the next meeting.
//
// While .recording the controller appends each STT-final segment to
// `transcript` (timestamped from meeting start). The user can edit
// freeform `userNotes` in parallel; both are sent to /meeting/notes on
// stop. The reasoner returns markdown which the UI renders.

@MainActor
final class MeetingController: ObservableObject {
    private struct LocalDraft: Codable {
        let startedAt: Int64
        let durationSec: Int
        let transcript: [MeetingSegment]
        let userNotes: String
    }

    private static let draftKey = "oasis.meeting.currentDraft"

    enum State: Equatable {
        case idle
        case recording
        case generating
        case completed
        case failed(String)
    }

    @Published var state: State = .idle
    @Published var transcript: [MeetingSegment] = []
    @Published var userNotes: String = ""
    @Published var elapsedSec: Int = 0
    @Published var liveSegment: String = ""
    @Published var generatedNotes: String = ""
    @Published var generatedMeetingId: String = ""
    @Published var lastError: String = ""

    private let appState: AppState
    private var client: OasisClient
    private let mic = MicCapture()
    private let audioRecorder = MeetingAudioRecorder()
    private var stt: ServerSTTEngine?
    private var currentAudioURL: URL?
    private var startedAtMs: Int64 = 0
    private var timer: Timer?

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    var hasDraft: Bool {
        !transcript.isEmpty || !userNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(state: AppState) {
        self.appState = state
        let url = URL(string: state.serverBaseURL) ?? URL(string: "http://127.0.0.1:3000")!
        self.client = OasisClient(baseURL: url)
        restoreDraft()
    }

    // MARK: - Public API

    /// Begin continuous capture. Safe to call only when .idle. Resets all
    /// previous-meeting state.
    func start() {
        start(resuming: false)
    }

    /// Stop capture and request notes generation. Transitions through
    /// .generating before settling on .completed or .failed.
    func stop() async {
        guard isRecording else { return }
        timer?.invalidate(); timer = nil
        mic.stop()
        audioRecorder.stop()
        stt?.finish()
        // Brief grace for the trailing STT segment finals to arrive
        // before we tear down the websocket.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard isRecording else { return }
        // Flush any leftover live partial as a final segment so it makes
        // it into the saved transcript even if the server never sent a
        // matching `final` for it.
        let leftover = liveSegment.trimmingCharacters(in: .whitespacesAndNewlines)
        if !leftover.isEmpty {
            transcript.append(MeetingSegment(
                elapsedSec: elapsedSecAt(now: Self.nowMs()),
                speaker: "Speaker",
                text: leftover
            ))
            liveSegment = ""
        }
        persistDraft()
        stt?.cancel()
        stt = nil

        state = .generating
        do {
            let resp = try await client.generateMeetingNotes(
                transcript: transcript,
                userNotes: userNotes,
                startedAt: startedAtMs
            )
            guard case .generating = state else { return }
            generatedNotes = resp.notes
            generatedMeetingId = resp.id
            clearDraft()
            Task { await client.clearMeetingDraft() }
            state = .completed
        } catch {
            if case .generating = state {
                fail(error.localizedDescription)
            }
        }
    }

    /// Throw away the current meeting without generating notes. Used by
    /// the cancel button or when the user dismisses the recording window
    /// without stopping cleanly.
    func cancel() {
        timer?.invalidate(); timer = nil
        mic.stop()
        audioRecorder.stop()
        if let url = currentAudioURL {
            try? FileManager.default.removeItem(at: url)
            currentAudioURL = nil
        }
        stt?.cancel()
        stt = nil
        reset()
    }

    /// Return to .idle so the next start() begins a fresh meeting.
    func reset() {
        state = .idle
        transcript = []
        userNotes = ""
        elapsedSec = 0
        liveSegment = ""
        generatedNotes = ""
        generatedMeetingId = ""
        lastError = ""
        clearDraft()
    }

    /// Replace controller state with a previously-saved meeting (loaded
    /// from /meeting/:id). Puts the controller in .completed so the
    /// notes window renders the saved markdown.
    func loadCompleted(detail: MeetingDetail) {
        cancel()
        startedAtMs = detail.startedAt
        transcript = detail.transcript
        userNotes = detail.userNotes
        elapsedSec = detail.durationSec
        generatedNotes = detail.notes
        generatedMeetingId = detail.id
        state = .completed
    }

    // MARK: - Internals

    private func acceptFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        transcript.append(MeetingSegment(
            elapsedSec: elapsedSecAt(now: Self.nowMs()),
            speaker: "Speaker",
            text: trimmed
        ))
        liveSegment = ""
        persistDraft()
    }

    private func elapsedSecAt(now: Int64) -> Int {
        Int((now - startedAtMs) / 1000)
    }

    private func fail(_ msg: String) {
        timer?.invalidate(); timer = nil
        mic.stop()
        stt?.cancel()
        stt = nil
        lastError = msg
        state = .failed(msg)
        persistDraft()
    }

    /// Resume an interrupted meeting without starting a second microphone
    /// session. The draft is kept local so this also works while the server is
    /// restarting or unavailable.
    func resumeDraft() {
        guard case .idle = state, hasDraft else { return }
        state = .idle
        start(resuming: true)
    }

    func saveCurrentDraft() {
        persistDraft()
    }

    private func start(resuming: Bool = false) {
        guard case .idle = state else { return }
        if !resuming {
            startedAtMs = Self.nowMs()
            transcript = []
            userNotes = ""
            elapsedSec = 0
            liveSegment = ""
            generatedNotes = ""
            generatedMeetingId = ""
            lastError = ""
        } else {
            elapsedSec = max(elapsedSec, elapsedSecAt(now: Self.nowMs()))
        }
        state = .recording
        persistDraft()

        let url = URL(string: appState.serverBaseURL) ?? URL(string: "http://127.0.0.1:3000")!
        Task { await client.updateBase(url) }
        let engine = ServerSTTEngine(serverBaseURL: url)
        do {
            let audioURL = Self.audioURL(startedAt: startedAtMs, resuming: resuming)
            try audioRecorder.start(url: audioURL, format: mic.format)
            currentAudioURL = audioURL
            try engine.start(
                onPartial: { [weak self] text in
                    Task { @MainActor [weak self] in self?.liveSegment = text }
                },
                onFinal: { [weak self] text in
                    Task { @MainActor [weak self] in self?.acceptFinal(text) }
                },
                onError: { [weak self] err in
                    Task { @MainActor [weak self] in self?.fail(err.localizedDescription) }
                }
            )
            stt = engine
            try mic.start(
                onBuffer: { [weak self] buf in
                    self?.audioRecorder.append(buf)
                    self?.stt?.append(buf)
                },
                onLevel: { _ in }
            )
            timer?.invalidate()
            let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self = self, self.isRecording else { return }
                    self.elapsedSec = self.elapsedSecAt(now: Self.nowMs())
                }
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func persistDraft() {
        guard startedAtMs > 0 else { return }
        let draft = LocalDraft(
            startedAt: startedAtMs,
            durationSec: elapsedSec,
            transcript: transcript,
            userNotes: userNotes
        )
        if let data = try? JSONEncoder().encode(draft) {
            UserDefaults.standard.set(data, forKey: Self.draftKey)
        }
        let transcript = draft.transcript
        let notes = draft.userNotes
        let startedAt = draft.startedAt
        let duration = draft.durationSec
        Task {
            await client.saveMeetingDraft(
                transcript: transcript,
                userNotes: notes,
                startedAt: startedAt,
                durationSec: duration
            )
        }
    }

    private func restoreDraft() {
        guard let data = UserDefaults.standard.data(forKey: Self.draftKey),
              let draft = try? JSONDecoder().decode(LocalDraft.self, from: data) else { return }
        // Treat the saved duration as the point at which the interrupted
        // capture paused; wall-clock time may span an app/server restart.
        startedAtMs = Self.nowMs() - Int64(max(0, draft.durationSec)) * 1000
        elapsedSec = draft.durationSec
        transcript = draft.transcript
        userNotes = draft.userNotes
    }

    private func clearDraft() {
        UserDefaults.standard.removeObject(forKey: Self.draftKey)
    }

    private static func audioURL(startedAt: Int64, resuming: Bool) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OasisEcho", isDirectory: true)
            .appendingPathComponent("Meetings", isDirectory: true)
        let suffix = resuming ? "-resume-\(nowMs())" : ""
        return base.appendingPathComponent("meeting-\(startedAt)\(suffix).caf")
    }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
