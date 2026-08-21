import Foundation
import Combine
import SwiftUI

enum Mode: String, CaseIterable, Codable {
    case transcribe
    case echo

    var label: String {
        switch self {
        case .transcribe: "Transcribe"
        case .echo: "Echo"
        }
    }

    func toggled() -> Mode { self == .transcribe ? .echo : .transcribe }
}

enum PillState: Equatable {
    case idle
    case listening(level: Float)      // RMS 0...1 for waveform
    case processing                   // awaiting post-process or first TTS token
    case speaking                     // Echo mode, agent is replying
    case pasted(words: Int, ms: Int)  // transient success, auto-dismiss
    case copiedOnly(words: Int)       // text on clipboard; paste blocked
    case modeSwitched(Mode)           // brief mode-change toast
    case error(String)                // transient error, auto-dismiss
    case taught                       // "teach from clipboard" saved, auto-dismiss
}

struct AgentMessage: Identifiable, Equatable {
    enum Role { case user, echo }
    let id = UUID()
    let role: Role
    var text: String
    var partial: Bool
}

struct CorrectionReview: Identifiable, Equatable {
    let id = UUID()
    let original: String
    let corrected: String
}

extension UserDefaults {
    @objc dynamic var wakeWordEnabled: Bool {
        bool(forKey: "oasis.wakeWordEnabled")
    }
}

@MainActor
final class AppState: ObservableObject {
    // user-visible
    @Published var mode: Mode = .transcribe
    @Published var pill: PillState = .idle
    @Published var liveTranscript: String = ""
    @Published var brainstormingActive: Bool = false
    @Published var agentMessages: [AgentMessage] = []
    @Published var autoPaste: Bool = true
    @Published var showMenuBarLevel: Bool = false
    @Published var emotionTag: String = ""
    @Published var statusLine: String = "Idle"
    @Published var isHudExpanded: Bool = false
    @Published var serverReachable: Bool = false
    @Published var serverModel: String = ""
    @Published var correctionReviews: [CorrectionReview] = []
    // Raw text from the most recent Transcribe-mode paste. Lets "Teach
    // Correction from Clipboard" diff it against whatever the user has
    // since copied (e.g. after editing the pasted text themselves in
    // the destination app) without making them retype either version.
    // Empty until the first paste; cleared after a successful teach so
    // a stale menu click doesn't resubmit the same pair.
    @Published var lastPastedText: String = ""

    // configuration
    @AppStorage("oasis.serverBaseURL") var serverBaseURL: String = "http://127.0.0.1:9187"
    @AppStorage("oasis.pillAtBottom") var pillAtBottom: Bool = true
    @AppStorage("oasis.sttEngine") var sttEngineRaw: String = STTEngineKind.serverWhisper.rawValue
    @AppStorage("oasis.pauseOtherMedia") var pauseOtherMedia: Bool = true
    @AppStorage("oasis.useFnKey") var useFnKey: Bool = true
    @AppStorage("oasis.launchAtLogin") var launchAtLogin: Bool = true
    @AppStorage("oasis.autoStartServer") var autoStartServer: Bool = true
    /// Use Docker Compose instead of `npm run server` to start the API.
    @AppStorage("oasis.useDocker") var useDocker: Bool = false
    /// Wake-word "Hey Echo" detection.
    @AppStorage("oasis.wakeWordEnabled") var wakeWordEnabled: Bool = false

    /// Optional absolute path to the oasis-echo git checkout. Empty = walk upward from this .app to find `package.json` with `"name": "oasis-echo"`.
    @AppStorage("oasis.serverRepoRootPath") var serverRepoRootPath: String = ""

    var sttEngine: STTEngineKind {
        get { STTEngineKind(rawValue: sttEngineRaw) ?? .serverWhisper }
        set { sttEngineRaw = newValue.rawValue }
    }

    /// Port from `~/.oasis-echo/listen-port` (written by `npm run server`).
    func discoveredListenPort() -> Int? {
        let portFile = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".oasis-echo/listen-port")
        guard let data = try? Data(contentsOf: portFile),
              let s = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              let port = Int(s), port > 0, port < 65_536
        else { return nil }
        return port
    }

    /// Preferred loopback URL from the listen-port file (IPv4).
    func discoveredListenPortURL() -> URL? {
        guard let port = discoveredListenPort() else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    /// Local API URLs to probe — saved setting, listen-port on IPv4 and IPv6.
    /// On macOS another process can bind the same port on the other stack
    /// (e.g. mock API on 127.0.0.1:3001 while Oasis Echo is on [::1]:3001).
    func localServerURLCandidates() -> [URL] {
        var seen = Set<String>()
        var urls: [URL] = []
        func add(_ url: URL?) {
            guard let url, seen.insert(url.absoluteString).inserted else { return }
            urls.append(url)
        }
        add(URL(string: serverBaseURL))
        if let port = discoveredListenPort() {
            add(URL(string: "http://127.0.0.1:\(port)"))
            add(URL(string: "http://[::1]:\(port)"))
        }
        return urls
    }

    func setMode(_ next: Mode) {
        guard next != mode else { return }
        mode = next
        statusLine = "Mode: \(next.label)"
        flashPill(.modeSwitched(next), after: 1.0)
    }

    func flashPill(_ state: PillState, after: TimeInterval = 1.2) {
        pill = state
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(after * 1_000_000_000))
            guard let self else { return }
            if self.pill == state { self.pill = .idle }
        }
    }

    /// Replace the latest raw user message with its server-formatted text.
    /// Assign the array as a whole so SwiftUI observers reliably receive the
    /// change; mutating a nested array element can bypass @Published updates.
    @discardableResult
    func replaceLatestUserMessage(original: String?, with corrected: String) -> Bool {
        guard let index = agentMessages.lastIndex(where: { $0.role == .user }),
              original == nil || agentMessages[index].text == original
        else { return false }
        var updated = agentMessages
        updated[index].text = corrected
        agentMessages = updated
        return true
    }

    /// Un-acted-upon reviews auto-dismiss after this long so a bubble
    /// the user never noticed doesn't sit there indefinitely.
    private static let correctionReviewTimeout: UInt64 = 20_000_000_000

    func enqueueCorrectionReview(original: String, corrected: String) {
        guard original != corrected,
              !original.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !corrected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !correctionReviews.contains(where: { $0.original == original && $0.corrected == corrected })
        else { return }
        let review = CorrectionReview(original: original, corrected: corrected)
        correctionReviews.append(review)
        if correctionReviews.count > 10 {
            correctionReviews.removeFirst(correctionReviews.count - 10)
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.correctionReviewTimeout)
            // dismissCorrectionReview is a no-op if the user already
            // accepted/kept/dismissed it by id, so this is always safe.
            self?.dismissCorrectionReview(review)
        }
    }

    func dismissCorrectionReview(_ review: CorrectionReview) {
        correctionReviews.removeAll { $0.id == review.id }
    }

    func deferCorrectionReview(_ review: CorrectionReview) {
        guard let index = correctionReviews.firstIndex(where: { $0.id == review.id }) else { return }
        let item = correctionReviews.remove(at: index)
        correctionReviews.append(item)
    }
}
