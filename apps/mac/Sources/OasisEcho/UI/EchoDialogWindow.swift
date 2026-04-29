import AppKit
import Combine
import SwiftUI

// Separate fixed-size panel for the Echo reply dialog.
//
// Living in its own NSPanel — instead of growing the orb panel under
// SwiftUI — avoids the bug where SwiftUI laid the dialog into the orb's
// original 60-wide content rect and text wrapped one character per line.
// This panel is always 640×280; nothing resizes it. SwiftUI sees the
// real geometry from the very first layout pass.
//
// The panel is non-interactive (ignoresMouseEvents = true) — it's a
// pure overlay for reading text — and is positioned relative to the orb
// panel so the two move together when the user toggles pillAtBottom or
// changes screens.
@MainActor
final class EchoDialogWindowController {
    static let dialogSize = CGSize(width: 480, height: 220)
    // Negative gap = the dialog's bottom edge actually OVERLAPS the
    // orb's panel. The HUD view fades its bottom fifth to transparent,
    // so the visible content still stops well above the orb — it just
    // looks like the dialog dissolves toward the orb instead of sitting
    // in a separate floating box.
    private let gap: CGFloat = -28

    private let panel: NSPanel
    private let state: AppState
    private weak var orbPanel: NSPanel?

    private var visibilitySubscription: AnyCancellable?

    init(state: AppState, orbPanel: NSPanel) {
        self.state = state
        self.orbPanel = orbPanel

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.dialogSize),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // hasShadow draws a real AppKit shadow around the visible
        // (non-transparent) glass card, escaping the content-view bounds
        // — much better than a SwiftUI shadow that gets clipped.
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false
        panel.setContentSize(Self.dialogSize)

        let host = NSHostingView(rootView: EchoHUDView().environmentObject(state))
        host.wantsLayer = true
        host.autoresizingMask = [.width, .height]
        panel.contentView = host

        self.panel = panel
    }

    func bind() {
        visibilitySubscription = state.$isHudExpanded
            .removeDuplicates()
            .sink { [weak self] expanded in
                guard let self else { return }
                if expanded {
                    self.reposition()
                    self.panel.orderFrontRegardless()
                } else {
                    self.panel.orderOut(nil)
                }
            }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func reposition() {
        guard let orbPanel else { return }
        let orbFrame = orbPanel.frame
        let dialogSize = Self.dialogSize
        let x = orbFrame.midX - dialogSize.width / 2
        // Place the dialog visually adjacent to the orb on the side that
        // points away from the screen edge the orb is anchored to.
        let y: CGFloat = state.pillAtBottom
            ? orbFrame.maxY + gap
            : orbFrame.minY - dialogSize.height - gap
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func window() -> NSPanel { panel }

    @objc nonisolated private func screensChanged() {
        Task { @MainActor in
            if self.state.isHudExpanded { self.reposition() }
        }
    }
}
