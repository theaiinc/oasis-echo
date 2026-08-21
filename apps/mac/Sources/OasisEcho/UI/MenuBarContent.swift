import SwiftUI
import AppKit

struct MenuBarLabel: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var meeting: MeetingController

    var body: some View {
        // Do NOT override foregroundStyle in the idle/default case —
        // SwiftUI's MenuBarExtra auto-templates an untinted system
        // symbol to match the menu bar (white in dark mode, black in
        // light mode). We only tint when something is actively
        // happening so the user gets a clear status hint.
        HStack(spacing: 3) {
            icon
            if meeting.isRecording {
                Circle().fill(.red).frame(width: 5, height: 5)
            } else if state.showMenuBarLevel, case .listening = state.pill {
                Circle().fill(.red).frame(width: 5, height: 5)
            }
        }
    }

    @ViewBuilder
    private var icon: some View {
        // Meeting in progress takes priority — make the menu bar status
        // unambiguous when the user is recording.
        if meeting.isRecording {
            Image(systemName: "record.circle").foregroundStyle(.red)
        } else {
            switch state.pill {
            case .listening:
                trayLogo
            case .processing:
                Image(systemName: "arrow.triangle.2.circlepath")
            case .speaking:
                trayLogo
            case .error:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            default:
                trayLogo
            }
        }
    }

    private var trayLogo: some View {
        Group {
            if let url = Bundle.module.url(forResource: "OasisEchoTray", withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                Image(nsImage: image)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "mic")
            }
        }
        .frame(width: 18, height: 18)
        .clipped()
    }
}

struct MenuBarContent: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var controller: TurnController
    @EnvironmentObject var meeting: MeetingController

    let onShowMeetingWindow: () -> Void
    let onShowMeetingHistory: () -> Void
    let onStartNewMeeting: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header

            Divider().padding(.vertical, 2)

            Button(action: toggleMode) {
                HStack {
                    Label("Mode", systemImage: state.mode == .transcribe ? "text.cursor" : "bubble.left.and.bubble.right")
                    Spacer()
                    Text("\(state.mode.label) · ⌘⇧M").foregroundStyle(.secondary).font(.caption)
                }
            }.buttonStyle(.plain)

            Toggle(isOn: $state.autoPaste) {
                Label("Auto-paste at cursor", systemImage: "square.and.pencil")
            }

            Toggle(isOn: $state.showMenuBarLevel) {
                Label("Show mic indicator", systemImage: "waveform")
            }

            if !state.lastPastedText.isEmpty {
                Button {
                    controller.teachFromClipboard()
                } label: {
                    Label("Teach Correction from Clipboard", systemImage: "text.badge.checkmark")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .help("Edited the last pasted transcript in place? Copy the fixed text, then click this to teach it — no need to retype either version.")
            }

            Divider().padding(.vertical, 2)

            // Meeting section — always visible. The label changes
            // depending on controller state so the user knows whether
            // a click will start fresh, resume, or just open the window.
            meetingSection

            Divider().padding(.vertical, 2)

            if !Paster.isAccessibilityTrusted() {
                Button {
                    Paster.openAccessibilitySettings()
                } label: {
                    Label("Grant Accessibility (for paste)", systemImage: "exclamationmark.shield")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(.orange)
                }.buttonStyle(.plain)
            }

            Button {
                onOpenSettings()
            } label: {
                Label("Settings…", systemImage: "gear").frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain).keyboardShortcut(",")

            Button {
                NSApp.terminate(nil)
            } label: {
                Label("Quit Oasis", systemImage: "power").frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain).keyboardShortcut("q")
        }
        .padding(10)
        .frame(width: 320)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Circle().fill(state.mode == .transcribe ? Color.accentColor : Color.purple)
                    .frame(width: 8, height: 8)
                Text("Oasis Echo").font(.headline)
                Spacer()
                Text(state.serverReachable ? "connected" : "offline")
                    .font(.caption2)
                    .foregroundStyle(state.serverReachable ? .green : .secondary)
            }
            Text(state.statusLine).font(.caption).foregroundStyle(.secondary)
            if !state.serverModel.isEmpty {
                Text(state.serverModel).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private var meetingSection: some View {
        switch meeting.state {
        case .recording:
            Button(action: onShowMeetingWindow) {
                HStack {
                    Label("Meeting in progress…", systemImage: "record.circle")
                        .foregroundStyle(.red)
                    Spacer()
                    Text(formatTime(meeting.elapsedSec))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button {
                Task { await meeting.stop() }
                onShowMeetingWindow()
            } label: {
                Label("Stop & Generate Notes", systemImage: "stop.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)

        case .generating:
            Button(action: onShowMeetingWindow) {
                Label("Generating meeting notes…", systemImage: "sparkles")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(.secondary)
            }.buttonStyle(.plain)

        case .completed:
            Button(action: onShowMeetingWindow) {
                Label("Meeting Notes", systemImage: "note.text")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Button(action: onStartNewMeeting) {
                Label("Record New Meeting", systemImage: "record.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Button(action: onShowMeetingHistory) {
                Label("Past Meetings…", systemImage: "clock.arrow.circlepath")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)

        default:
            Button(action: onStartNewMeeting) {
                Label("Record New Meeting", systemImage: "record.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Button(action: onShowMeetingHistory) {
                Label("Past Meetings…", systemImage: "clock.arrow.circlepath")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
        }
    }

    private func formatTime(_ sec: Int) -> String {
        String(format: "%d:%02d", sec / 60, sec % 60)
    }

    private func toggleMode() {
        let next = state.mode.toggled()
        // MUST run onModeChanged BEFORE setMode so onModeChanged can
        // inspect the current pill state (e.g. .listening) and cancel
        // any in-flight capture before setMode overwrites it with the
        // .modeSwitched toast.
        controller.onModeChanged(next)
        state.setMode(next)
    }

}
