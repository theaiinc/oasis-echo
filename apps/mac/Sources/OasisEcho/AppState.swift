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
}

struct AgentMessage: Identifiable, Equatable {
    enum Role { case user, echo }
    let id = UUID()
    let role: Role
    var text: String
    var partial: Bool
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
    @Published var agentMessages: [AgentMessage] = []
    @Published var autoPaste: Bool = true
    @Published var showMenuBarLevel: Bool = false
    @Published var emotionTag: String = ""
    @Published var statusLine: String = "Idle"
    @Published var isHudExpanded: Bool = false
    @Published var serverReachable: Bool = false
    @Published var serverModel: String = ""

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
}
