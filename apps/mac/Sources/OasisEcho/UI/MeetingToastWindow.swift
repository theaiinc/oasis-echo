import AppKit
import SwiftUI

// Granola-style "looks like you're in a meeting — record?" toast.
//
// Triggered by TurnController when a single push-to-talk capture has
// been held longer than `triggerSec` (default 30s) — a short voice
// query is much shorter than that, so this only fires when the user is
// genuinely talking continuously. The toast slides in from the top-
// right of the active screen, runs an 8 s countdown, and dismisses
// itself if the user does nothing.

@MainActor
final class MeetingToastWindowController {
    private let panel: NSPanel
    private let onAccept: () -> Void
    private var view: MeetingToastView!
    private var timer: Timer?
    private var dismissTimer: Timer?
    private var countdown: Int = 8

    init(onAccept: @escaping () -> Void) {
        self.onAccept = onAccept

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 80),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        self.panel = panel

        // The view needs callbacks back to this controller; build it
        // after self exists.
        let v = MeetingToastView(
            countdown: { [weak self] in self?.countdown ?? 0 },
            onRecord: { [weak self] in self?.accept() },
            onDismiss: { [weak self] in self?.hide() }
        )
        self.view = v
        panel.contentView = NSHostingView(rootView: v)
    }

    /// Show the toast in the top-right of the focused screen and start
    /// the 8 s countdown. If `record` isn't pressed before zero, hides.
    func show() {
        countdown = 8
        view.tick()  // show "8" before first timer fire

        let screen = NSScreen.main ?? NSScreen.screens.first
        if let visible = screen?.visibleFrame {
            let pad: CGFloat = 16
            let size = panel.frame.size
            let origin = NSPoint(
                x: visible.maxX - size.width - pad,
                y: visible.maxY - size.height - pad
            )
            panel.setFrameOrigin(origin)
        }
        panel.orderFrontRegardless()

        timer?.invalidate()
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.countdown -= 1
                self.view.tick()
                if self.countdown <= 0 { self.hide() }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func hide() {
        timer?.invalidate(); timer = nil
        panel.orderOut(nil)
    }

    private func accept() {
        hide()
        onAccept()
    }
}

private struct MeetingToastView: View {
    let countdown: () -> Int
    let onRecord: () -> Void
    let onDismiss: () -> Void

    // SwiftUI doesn't observe a closure return; tick() bumps this so
    // the countdown ring re-renders every second.
    @State private var refresh: Int = 0
    func tick() { refresh &+= 1 }

    var body: some View {
        let n = countdown()
        let urgent = n <= 3
        HStack(spacing: 12) {
            Image(systemName: "note.text")
                .font(.system(size: 22))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Recording a meeting?")
                    .font(.subheadline.weight(.semibold))
                Text("Switch to meeting mode to capture full notes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button("Record", action: onRecord)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .help("Dismiss")
            ZStack {
                Circle()
                    .stroke(urgent ? Color.red : Color.secondary.opacity(0.4), lineWidth: 2)
                    .frame(width: 26, height: 26)
                Text("\(max(0, n))")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(urgent ? Color.red : Color.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThickMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.secondary.opacity(0.18), lineWidth: 1)
        )
        // Keying off `refresh` makes the View body re-evaluate so the
        // closure-based countdown reads the latest value.
        .id(refresh)
    }
}
