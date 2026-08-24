import AppKit

// Shared clamping helper for every overlay window anchored relative to the
// orb — now that the orb's position is user-draggable (Settings' "Move
// Indicator Overlay"), none of them can assume they're safely inside a
// screen edge anymore. Anything that positions itself off the orb's
// current frame (the orb panel's own toast/caption/review growth, the
// Echo reply dialog) should route through this rather than growing/
// placing itself unclamped.
extension NSScreen {
    /// The screen whose frame contains `point`, if any.
    static func containing(_ point: NSPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) }
    }

    /// `origin` shifted so a `size`-sized window stays fully within this
    /// screen's visible frame (menu bar / Dock excluded). If `size` is
    /// larger than the visible frame on some axis, clamps to that axis's
    /// minimum edge instead of overshooting negative — the window will
    /// still be partially off-screen in that degenerate case, but that's
    /// the best a single screen can offer content bigger than itself.
    func clampedOrigin(for size: CGSize, from origin: NSPoint) -> NSPoint {
        let visible = visibleFrame
        let maxX = max(visible.minX, visible.maxX - size.width)
        let maxY = max(visible.minY, visible.maxY - size.height)
        let x = min(max(origin.x, visible.minX), maxX)
        let y = min(max(origin.y, visible.minY), maxY)
        return NSPoint(x: x, y: y)
    }
}
