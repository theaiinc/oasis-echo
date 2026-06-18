import AppKit
import Combine
import SwiftUI

// One window for the entire meeting flow:
//   .recording  → red dot + timer + notes editor + collapsible transcript + Stop
//   .generating → progress spinner over the recording layout
//   .completed  → markdown-rendered notes + "New Meeting" + "History"
//   .failed     → error + "Retry" / "Discard"
//
// The window is a borderless floating panel (does not steal focus from
// whatever app the user is also typing in — Granola pattern).

@MainActor
final class MeetingWindowController {
    private let panel: NSPanel
    private let controller: MeetingController
    private var subscriptions = Set<AnyCancellable>()

    init(state: AppState, controller: MeetingController, onShowHistory: @escaping () -> Void) {
        self.controller = controller

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 460),
            styleMask: [.titled, .closable, .nonactivatingPanel, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Meeting Notes"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 380, height: 280)

        let view = MeetingWindowView(onShowHistory: onShowHistory)
            .environmentObject(state)
            .environmentObject(controller)
        panel.contentView = NSHostingView(rootView: view)
        self.panel = panel

        // Auto-show on transitions into .recording or .completed (e.g.,
        // when a history item is loaded). User can close the window
        // without canceling the meeting; we just hide it.
        controller.$state
            .removeDuplicates()
            .sink { [weak self] s in
                switch s {
                case .recording, .completed: self?.show()
                default: break
                }
            }
            .store(in: &subscriptions)
    }

    func show() {
        if !panel.isVisible { panel.center() }
        panel.orderFrontRegardless()
    }

    func close() { panel.orderOut(nil) }
}

private struct MeetingWindowView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var controller: MeetingController
    let onShowHistory: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch controller.state {
            case .idle:
                idleView
            case .recording:
                recordingView
            case .generating:
                generatingView
            case .completed:
                completedView
            case .failed(let msg):
                failedView(msg)
            }
        }
        .frame(minWidth: 380, minHeight: 280)
        .background(Color(NSColor.windowBackgroundColor))
    }

    // MARK: - Recording state

    private var idleView: some View {
        VStack(spacing: 12) {
            Image(systemName: "record.circle").font(.system(size: 36)).foregroundStyle(.secondary)
            Text("No active meeting").font(.headline)
            Button("Start Recording") { controller.start() }
                .buttonStyle(.borderedProminent)
            Button("Show History", action: onShowHistory).buttonStyle(.link)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    private var recordingView: some View {
        VStack(alignment: .leading, spacing: 12) {
            recordingHeader
            Divider()
            notesEditor
            transcriptDisclosure
            Spacer(minLength: 0)
            recordingFooter
        }
        .padding(16)
    }

    private var recordingHeader: some View {
        HStack(spacing: 8) {
            PulsingDot(color: .red)
            Text(formatTime(controller.elapsedSec))
                .font(.system(.title3, design: .monospaced))
                .fontWeight(.semibold)
                .monospacedDigit()
            Text("RECORDING")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.red)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
            Spacer()
            Button(role: .destructive) {
                Task { await controller.stop() }
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
        }
    }

    private var notesEditor: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Your notes").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $controller.userNotes)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                .frame(minHeight: 110)
        }
    }

    private var transcriptDisclosure: some View {
        DisclosureGroup {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(controller.transcript.enumerated()), id: \.offset) { idx, seg in
                            HStack(alignment: .top, spacing: 6) {
                                Text(formatTime(seg.elapsedSec))
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(width: 36, alignment: .leading)
                                Text(seg.text).font(.caption)
                            }
                            .id(idx)
                        }
                        if !controller.liveSegment.isEmpty {
                            HStack(alignment: .top, spacing: 6) {
                                Text("…").font(.caption2).foregroundStyle(.secondary).frame(width: 36, alignment: .leading)
                                Text(controller.liveSegment).font(.caption.italic()).foregroundStyle(.secondary)
                            }.id("live")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .onChange(of: controller.transcript.count) { _ in
                    if let last = controller.transcript.indices.last {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        } label: {
            Text("Live transcript (\(controller.transcript.count) segments)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var recordingFooter: some View {
        HStack {
            Button("Discard") { controller.cancel() }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
            Spacer()
            Text("Notes & transcript will be summarized when you stop.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Generating

    private var generatingView: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text("Generating notes…").font(.headline)
            Text("Asking the model to summarize \(controller.transcript.count) segments.")
                .font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    // MARK: - Completed

    private var completedView: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Meeting Notes").font(.headline)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(controller.generatedNotes, forType: .string)
                } label: { Label("Copy", systemImage: "doc.on.doc") }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(action: onShowHistory) {
                    Label("History", systemImage: "clock.arrow.circlepath")
                }
                .buttonStyle(.bordered).controlSize(.small)
                Button {
                    controller.reset()
                    controller.start()
                } label: { Label("New", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)

            HStack(spacing: 6) {
                Text(formatTime(controller.elapsedSec))
                    .font(.caption.monospacedDigit())
                Text("·").foregroundStyle(.tertiary)
                Text("\(controller.transcript.count) segments")
                    .font(.caption)
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)

            Divider().padding(.top, 8)

            ScrollView {
                MarkdownText(controller.generatedNotes)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        }
    }

    // MARK: - Failed

    private func failedView(_ msg: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.orange)
            Text("Notes generation failed").font(.headline)
            Text(msg)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            HStack {
                Button("Discard") { controller.reset() }
                Button("Retry") {
                    Task {
                        // Re-attempt generation with the same data.
                        controller.cancel()
                        // Without a transcript there's nothing to retry —
                        // bounce back to idle.
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private func formatTime(_ sec: Int) -> String {
        String(format: "%d:%02d", sec / 60, sec % 60)
    }
}

// Pulsing red recording dot.
private struct PulsingDot: View {
    let color: Color
    @State private var pulsing = false
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .opacity(pulsing ? 0.35 : 1.0)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
    }
}

// Minimal markdown renderer for the meeting-notes prompt's output
// (## headings, - bullets, - [ ] checkboxes, paragraphs). Avoids pulling
// in a third-party dependency for a single window.
struct MarkdownText: View {
    private let blocks: [Block]

    init(_ md: String) {
        self.blocks = Self.parse(md)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .h2(let text):
                    Text(text)
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(0.6)
                        .foregroundStyle(Color.accentColor)
                        .padding(.top, 6)
                case .bullet(let text):
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").font(.body.bold()).foregroundStyle(.secondary)
                        Text(text).font(.body)
                    }
                case .todo(let text, let checked):
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: checked ? "checkmark.square.fill" : "square")
                            .foregroundStyle(checked ? Color.accentColor : .secondary)
                        Text(text).font(.body)
                            .strikethrough(checked, color: .secondary)
                            .foregroundStyle(checked ? .secondary : .primary)
                    }
                case .paragraph(let text):
                    Text(text).font(.body)
                }
            }
        }
    }

    private enum Block {
        case h2(String)
        case bullet(String)
        case todo(String, Bool)
        case paragraph(String)
    }

    private static func parse(_ md: String) -> [Block] {
        var out: [Block] = []
        for raw in md.split(whereSeparator: { $0 == "\n" }) {
            let line = String(raw).trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("## ") {
                out.append(.h2(String(line.dropFirst(3))))
            } else if line.hasPrefix("- [ ] ") {
                out.append(.todo(String(line.dropFirst(6)), false))
            } else if line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                out.append(.todo(String(line.dropFirst(6)), true))
            } else if line.hasPrefix("- ") {
                out.append(.bullet(String(line.dropFirst(2))))
            } else if line.hasPrefix("# ") {
                out.append(.h2(String(line.dropFirst(2))))
            } else {
                out.append(.paragraph(line))
            }
        }
        return out
    }
}
