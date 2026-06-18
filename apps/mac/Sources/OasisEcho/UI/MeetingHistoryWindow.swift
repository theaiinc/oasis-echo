import AppKit
import SwiftUI

// Lists past meetings (GET /meetings). Clicking a row loads the full
// meeting (GET /meeting/:id) into the MeetingController and brings up
// the MeetingWindow in completed-state to render the saved notes.

@MainActor
final class MeetingHistoryWindowController {
    private let panel: NSPanel
    private let onSelect: (String) -> Void
    private let appState: AppState

    init(state: AppState, onSelect: @escaping (String) -> Void) {
        self.appState = state
        self.onSelect = onSelect

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 480),
            styleMask: [.titled, .closable, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Past Meetings"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 320, height: 240)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let view = MeetingHistoryView(state: state, onSelect: { [weak panel] id in
            onSelect(id)
            panel?.orderOut(nil)
        })
        panel.contentView = NSHostingView(rootView: view)
        self.panel = panel
    }

    func show() {
        panel.center()
        panel.orderFrontRegardless()
    }
}

private struct MeetingHistoryView: View {
    @ObservedObject var state: AppState
    let onSelect: (String) -> Void

    @State private var meetings: [MeetingListItem] = []
    @State private var loading = true
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Past Meetings").font(.headline)
                Spacer()
                Button(action: load) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
            Divider()
            if loading {
                Spacer()
                ProgressView().controlSize(.small)
                Spacer()
            } else if let err = errorMessage {
                Spacer()
                VStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text("Couldn't load meetings").font(.subheadline)
                    Text(err).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Retry", action: load).buttonStyle(.bordered)
                }.padding(20)
                Spacer()
            } else if meetings.isEmpty {
                Spacer()
                VStack(spacing: 6) {
                    Image(systemName: "tray").font(.system(size: 28)).foregroundStyle(.secondary)
                    Text("No past meetings yet").font(.subheadline).foregroundStyle(.secondary)
                }.padding(20)
                Spacer()
            } else {
                List(meetings) { m in
                    Button {
                        onSelect(m.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(formatDate(m.startedAt)).font(.body)
                            Text("\(formatDuration(m.durationSec)) · \(m.id)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
            }
        }
        .frame(minWidth: 320, minHeight: 240)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear { load() }
    }

    private func load() {
        loading = true
        errorMessage = nil
        Task {
            var lastError: Error?
            if let u = URL(string: state.serverBaseURL) {
                let client = OasisClient(baseURL: u)
                do {
                    let list = try await client.listMeetings()
                    await MainActor.run {
                        meetings = list
                        loading = false
                    }
                    return
                } catch {
                    lastError = error
                }
            }
            // Same fallback as TurnController: stale default URL while server
            // wrote ~/.oasis-echo/listen-port after an ephemeral bind.
            if let d = state.discoveredListenPortURL() {
                let client = OasisClient(baseURL: d)
                do {
                    let list = try await client.listMeetings()
                    await MainActor.run {
                        if d.absoluteString != state.serverBaseURL {
                            state.serverBaseURL = d.absoluteString
                        }
                        meetings = list
                        loading = false
                    }
                    return
                } catch {
                    lastError = error
                }
            }
            await MainActor.run {
                errorMessage = lastError?.localizedDescription ?? "Could not reach the Oasis Echo server."
                loading = false
            }
        }
    }

    private func formatDate(_ ms: Int64) -> String {
        let d = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: d)
    }

    private func formatDuration(_ sec: Int) -> String {
        if sec < 60 { return "\(sec)s" }
        let m = sec / 60, s = sec % 60
        return s == 0 ? "\(m)m" : "\(m)m \(s)s"
    }
}
