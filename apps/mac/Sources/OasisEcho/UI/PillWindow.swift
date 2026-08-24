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
    private var moveModeSubscription: AnyCancellable?

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
            .combineLatest(state.$liveTranscript, state.$correctionReviews)
            .removeDuplicates(by: { lhs, rhs in
                Self.targetSize(
                    state: state, pill: lhs.0, caption: lhs.1, hasReview: !lhs.2.isEmpty
                ) == Self.targetSize(
                    state: state, pill: rhs.0, caption: rhs.1, hasReview: !rhs.2.isEmpty
                )
            })
            .sink { [weak self] (pill, caption, reviews) in
                guard let self else { return }
                let target = Self.targetSize(
                    state: state, pill: pill, caption: caption, hasReview: !reviews.isEmpty
                )
                self.resize(to: target, isShrinking: target.height < self.panel.frame.height)
            }
    }

    // Toggled from Settings' "Move Indicator Overlay" button. While active,
    // the panel becomes draggable by its background and stops fighting the
    // drag with its normal auto-repositioning; on confirm (true → false)
    // the panel's current bottom-center point is captured and persisted as
    // the new custom anchor.
    func bindMoveMode() {
        moveModeSubscription = state.$isMoveModeActive
            .removeDuplicates()
            .sink { [weak self] active in
                guard let self else { return }
                self.panel.isMovableByWindowBackground = active
                if !active {
                    // Only a genuine confirm (was true → now false) should
                    // persist a position; skip the initial `false` this
                    // sink fires on subscribe.
                    guard self.wasMoveModeActive else { return }
                    let frame = self.panel.frame
                    self.state.pillCustomAnchorX = frame.midX
                    self.state.pillCustomAnchorY = frame.minY
                    self.state.pillUseCustomPosition = true
                    // @Published publishes from willSet — the backing
                    // store for `isMoveModeActive` isn't actually false
                    // yet at this point in the call stack, so
                    // reposition()'s own `guard !state.isMoveModeActive`
                    // would read the stale `true` and no-op. Defer one
                    // run-loop turn so it sees the settled value.
                    DispatchQueue.main.async { [weak self] in
                        self?.reposition()
                    }
                }
                self.wasMoveModeActive = active
            }
    }

    /// Called from Settings' "Reset to Default Position" button.
    func resetToDefaultPosition() {
        state.isMoveModeActive = false
        state.pillUseCustomPosition = false
        reposition()
    }

    private var wasMoveModeActive = false

    private static func targetSize(state: AppState,
                                   pill: PillState,
                                   caption: String,
                                   hasReview: Bool) -> CGSize {
        if hasReview {
            // The review bubble (title + up to 2 lines of quoted text +
            // a button row) sits ABOVE the orb in the same VStack, so
            // this height must fit both. 150 was cut too close — real
            // font/button chrome metrics could exceed it, and a VStack
            // that overflows its window pushes the orb (last in the
            // stack) out of the visible frame entirely rather than
            // just clipping the bubble. Generous margin here is cheap;
            // an invisible, unreachable orb is not.
            return CGSize(width: 360, height: 210)
        }
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
        if isShrinking {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 200_000_000)
                self?.applyResizeFrame(target)
            }
        } else {
            applyResizeFrame(target)
        }
    }

    // `NSScreen.main` means "the screen containing the currently KEY
    // window" — not "the primary display". This panel is a
    // .nonactivatingPanel that never becomes key, so NSScreen.main at
    // any moment reflects whichever OTHER app currently has focus.
    // Paster.paste() explicitly activates the paste target right
    // before a resize/reposition can fire (e.g. the .pasted toast, or
    // a correction-review bubble appearing) — on a multi-monitor setup
    // where that target lives on a different display than the one the
    // user is actually looking at, the orb (and any bubble on it) would
    // silently jump there. Anchor to `NSScreen.screens.first` instead —
    // Apple documents index 0 as the screen holding the menu bar, i.e.
    // the system's actual designated primary display (what System
    // Settings / system_profiler call "Main Display"), which is stable
    // and does NOT follow focus the way NSScreen.main does. Only
    // NSScreen.main as a last-resort fallback if .screens is ever empty.
    private var homeScreen: NSScreen?

    // Bottom-center anchor point (screen coordinates) to align a frame of
    // `target` width against. Prefers the user's dragged custom position —
    // but only if it still lands on a currently-connected screen, so
    // unplugging the monitor it was set on self-heals back to the default
    // anchor instead of parking the orb somewhere unreachable.
    private func anchor(for target: CGSize) -> (x: CGFloat, bottomY: CGFloat) {
        // A custom position is a single fixed point, but `target` grows
        // (idle orb → toast bubble → correction-review card, up to
        // 360×210) as the pill's content changes. Near a screen edge that
        // growth can push a bubble off-screen even though the orb itself
        // never moved — clamp every candidate frame to the screen it's
        // actually on, not just the default screen-edge anchor.
        if state.pillUseCustomPosition {
            let point = NSPoint(x: state.pillCustomAnchorX, y: state.pillCustomAnchorY)
            if let screen = NSScreen.containing(point) {
                let raw = NSPoint(x: point.x - target.width / 2, y: point.y)
                let clamped = screen.clampedOrigin(for: target, from: raw)
                return (clamped.x, clamped.y)
            }
        }
        let screen = homeScreen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? .zero
        let x = visible.midX - target.width / 2
        let bottomY: CGFloat = state.pillAtBottom
            ? visible.minY + 18
            : visible.maxY - target.height - 24
        guard let screen else { return (x, bottomY) }
        let clamped = screen.clampedOrigin(for: target, from: NSPoint(x: x, y: bottomY))
        return (clamped.x, clamped.y)
    }

    private func applyResizeFrame(_ target: CGSize) {
        // Don't fight an in-progress drag with a resize-triggered snap
        // back to the anchor — but still grow the panel's own frame
        // (origin untouched), not just its contentView. contentView
        // alone doesn't resize the NSPanel's backing store, so content
        // that grows mid-drag (a toast, a correction-review bubble)
        // used to render clipped/unclickable outside the window's
        // still-small bounds until the drag ended.
        guard !state.isMoveModeActive else {
            var frame = panel.frame
            frame.size = target
            panel.setFrame(frame, display: true)
            onGeometryChanged?()
            return
        }
        let (x, bottomY) = anchor(for: target)
        panel.setFrame(
            NSRect(x: x, y: bottomY, width: target.width, height: target.height),
            display: true,
            animate: false
        )
        panel.contentView?.setFrameSize(target)
        onGeometryChanged?()
    }

    func show() {
        homeScreen = NSScreen.screens.first ?? NSScreen.main
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
        Task { @MainActor in
            // A genuine display reconfiguration (monitor connected/
            // disconnected/resolution changed) — re-anchor in case the
            // home screen was removed, or just to reflect the new setup.
            self.homeScreen = NSScreen.screens.first ?? NSScreen.main
            self.reposition()
        }
    }

    func reposition() {
        guard !state.isMoveModeActive else { return }
        let (x, y) = anchor(for: panel.frame.size)
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
