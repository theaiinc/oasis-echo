import AppKit
import Combine
import SwiftUI

// Borderless, non-activating floating panel anchored bottom-center.
// .statusBar window level + canJoinAllSpaces keeps it above everything
// without stealing focus from the frontmost app.
//
// This panel renders only the orb itself plus its tightly-coupled
// transient feedback (toast bubbles, listening caption). The Echo reply
// dialog has been split into its own EchoDialogWindowController, which
// stays at a fixed 640×280 — that split exists because growing this
// panel up to dialog size made SwiftUI lay the dialog into the orb's
// original 60-wide content rect, wrapping text one character per line.

@MainActor
final class PillWindowController {
    private let panel: NSPanel
    private let state: AppState
    private let controller: TurnController

    private var hudSubscription: AnyCancellable?

    // Notified after the orb panel's frame changes so a sibling overlay
    // (e.g. the Echo dialog) can reposition relative to it.
    var onGeometryChanged: (() -> Void)?

    init(state: AppState, controller: TurnController) {
        self.state = state
        self.controller = controller

        // Start tight to the orb so we don't intercept clicks across
        // a 240×80 dead zone in idle.
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 60, height: 60),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = false
        panel.acceptsMouseMovedEvents = true     // .onHover inside SwiftUI needs this
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false
        panel.setContentSize(NSSize(width: 60, height: 60))

        let content = PillContainer()
            .environmentObject(state)
            .environmentObject(controller)
        let host = NSHostingView(rootView: content)
        host.wantsLayer = true
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        self.panel = panel
    }

    // Recompute panel size whenever any input that affects the
    // visible orb-adjacent content changes. Toast bubbles and the
    // listening caption are small (≤340×90) so SwiftUI handles the
    // resize cleanly here — the dialog (640×280) lives in its own
    // window for exactly that reason.
    func bindSizeUpdates(_ state: AppState) {
        hudSubscription = state.$pill
            .combineLatest(state.$liveTranscript)
            .removeDuplicates(by: { lhs, rhs in
                Self.targetSize(state: state, pill: lhs.0, caption: lhs.1)
                  == Self.targetSize(state: state, pill: rhs.0, caption: rhs.1)
            })
            .sink { [weak self] (pill, caption) in
                guard let self else { return }
                let target = Self.targetSize(state: state, pill: pill, caption: caption)
                self.resize(to: target, isShrinking: target.height < self.panel.frame.height)
            }
    }

    private static func targetSize(state: AppState,
                                   pill: PillState,
                                   caption: String) -> CGSize {
        // Listening with a partial transcript caption above the orb.
        if case .listening = pill, !caption.isEmpty {
            return CGSize(width: 340, height: 90)
        }
        // Transient toast bubble (Pasted / Copied / ModeSwitched / Error / Polishing).
        switch pill {
        case .pasted, .copiedOnly, .modeSwitched, .error, .processing:
            return CGSize(width: 300, height: 90)
        default:
            // Idle / listening-without-caption / speaking.
            return CGSize(width: 60, height: 60)
        }
    }

    private func resize(to target: CGSize, isShrinking: Bool) {
        let setIt = { [weak self] in
            guard let self else { return }
            let screen = NSScreen.main?.visibleFrame ?? .zero
            let x = screen.midX - target.width / 2
            let bottomY: CGFloat = self.state.pillAtBottom
                ? screen.minY + 18
                : screen.maxY - target.height - 24
            self.panel.setFrame(
                NSRect(x: x, y: bottomY, width: target.width, height: target.height),
                display: true,
                animate: false
            )
            self.panel.contentView?.setFrameSize(target)
            self.onGeometryChanged?()
        }
        if isShrinking {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.20, execute: setIt)
        } else {
            setIt()
        }
    }

    func show() {
        reposition()
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func hide() { panel.orderOut(nil) }
    func window() -> NSPanel { panel }

    @objc nonisolated private func screensChanged() {
        Task { @MainActor in self.reposition() }
    }

    func reposition() {
        guard let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let size = panel.frame.size
        let x = frame.midX - size.width / 2
        let y = state.pillAtBottom
            ? frame.minY + 18
            : frame.maxY - size.height - 24
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        onGeometryChanged?()
    }
}

struct PillContainer: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var controller: TurnController

    var body: some View {
        VStack(spacing: 0) {
            if case .listening = state.pill, !state.liveTranscript.isEmpty {
                PillCaption().environmentObject(state).padding(.bottom, 4)
            }
            // Permanent orb at the bottom — same view in every state.
            PillView().environmentObject(state)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 8)
    }
}
