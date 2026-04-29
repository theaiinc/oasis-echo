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
    @AppStorage("oasis.serverBaseURL") var serverBaseURL: String = "http://127.0.0.1:3000"
    @AppStorage("oasis.pillAtBottom") var pillAtBottom: Bool = true
    @AppStorage("oasis.sttEngine") var sttEngineRaw: String = STTEngineKind.serverWhisper.rawValue
    @AppStorage("oasis.pauseOtherMedia") var pauseOtherMedia: Bool = true
    @AppStorage("oasis.useFnKey") var useFnKey: Bool = true

    var sttEngine: STTEngineKind {
        get { STTEngineKind(rawValue: sttEngineRaw) ?? .serverWhisper }
        set { sttEngineRaw = newValue.rawValue }
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
