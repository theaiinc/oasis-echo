import SwiftUI
import KeyboardShortcuts

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralTab().tabItem { Label("General", systemImage: "gear") }
            ShortcutsTab().tabItem { Label("Shortcuts", systemImage: "keyboard") }
            DictionaryTab().tabItem { Label("Dictionary", systemImage: "character.book.closed") }
            PrivacyTab().tabItem { Label("Privacy", systemImage: "lock") }
        }
        .padding(20)
    }
}

struct GeneralTab: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Form {
            Section("Server") {
                TextField("Oasis Echo URL", text: $state.serverBaseURL)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                HStack {
                    Circle().fill(state.serverReachable ? Color.green : Color.gray).frame(width: 8, height: 8)
                    Text(state.serverReachable ? "Connected" : "Offline")
                    if !state.serverModel.isEmpty {
                        Text("· \(state.serverModel)").foregroundStyle(.secondary)
                    }
                }.font(.caption)
            }
            Section("Pill") {
                Toggle("Anchor to bottom of screen", isOn: $state.pillAtBottom)
                Toggle("Show mic indicator in menu bar", isOn: $state.showMenuBarLevel)
                Toggle("Auto-paste transcription at cursor", isOn: $state.autoPaste)
            }
            Section("Focus") {
                Toggle("Pause other media while listening", isOn: $state.pauseOtherMedia)
                Text("Pauses YouTube, Spotify, Apple Music, and any app that responds to the system Play/Pause key when you start dictating. Auto-resumes when the pill returns to idle.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Section("Transcription engine") {
                Picker("Engine", selection: Binding(
                    get: { state.sttEngine },
                    set: { state.sttEngine = $0 }
                )) {
                    ForEach(STTEngineKind.allCases, id: \.self) { kind in
                        Text(kind.label).tag(kind)
                    }
                }
                Text(engineDescription(state.sttEngine))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private func engineDescription(_ kind: STTEngineKind) -> String {
    switch kind {
    case .appleSpeech:
        return "Apple's on-device Speech framework. Fastest to start (no model to load), works without the Oasis server. Weaker accuracy on proper nouns and technical vocabulary."
    case .serverWhisper:
        return "Sends audio to the Oasis Echo server over a local WebSocket. Uses Whisper for much higher accuracy, and the same post-process pipeline as the voice agent. Requires the server to be running."
    }
}

struct ShortcutsTab: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var controller: TurnController

    var body: some View {
        Form {
            Section("Dictation") {
                KeyboardShortcuts.Recorder("Push-to-talk (hold)", name: .pushToTalk)
                KeyboardShortcuts.Recorder("Hands-free (toggle)", name: .handsFree)
                Toggle("Also use Fn / 🌐 key (hold)", isOn: Binding(
                    get: { state.useFnKey },
                    set: { newValue in
                        state.useFnKey = newValue
                        HotkeyManager.shared.setFnKeyEnabled(newValue, controller: controller)
                    }
                ))
                Text("If Fn doesn't trigger anything, open System Settings → Keyboard → \"Press 🌐 key to…\" and set it to \"Do Nothing\" so macOS stops intercepting it.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Section("Modes") {
                KeyboardShortcuts.Recorder("Switch mode", name: .toggleMode)
            }
            Text("Hold push-to-talk to dictate; release to commit. Press Switch mode to flip between Transcribe and Echo.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct DictionaryTab: View {
    @EnvironmentObject var controller: TurnController
    @State private var original: String = ""
    @State private var corrected: String = ""
    @State private var message: String = ""

    var body: some View {
        Form {
            Section("Teach a correction") {
                TextField("Heard as (e.g. popeye place)", text: $original)
                    .textFieldStyle(.roundedBorder)
                TextField("Should be (e.g. Poppy Place)", text: $corrected)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("Save") {
                        let o = original.trimmingCharacters(in: .whitespaces)
                        let c = corrected.trimmingCharacters(in: .whitespaces)
                        guard !o.isEmpty, !c.isEmpty else { return }
                        Task {
                            do {
                                try await controller.teachCorrection(original: o, corrected: c)
                                await MainActor.run {
                                    message = "Saved — post-process pipeline updated."
                                    original = ""; corrected = ""
                                }
                            } catch {
                                await MainActor.run { message = "Failed: \(error.localizedDescription)" }
                            }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    if !message.isEmpty { Text(message).foregroundStyle(.secondary).font(.caption) }
                }
            }
            Section {
                Text("Corrections are stored server-side and feed the same STT post-process pipeline used by the voice agent. New rules apply to the next utterance.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct PrivacyTab: View {
    var body: some View {
        Form {
            Section("On-device") {
                Label("Speech-to-text runs locally via Apple Speech.", systemImage: "mic")
                Label("Audio never leaves your Mac.", systemImage: "lock.shield")
            }
            Section("Server") {
                Label("Text (post-STT) is sent to your Oasis Echo server for dictionary post-processing.", systemImage: "server.rack")
                Label("Echo mode forwards text to the configured reasoner (Anthropic / OpenAI / Ollama).", systemImage: "brain")
            }
        }
    }
}
