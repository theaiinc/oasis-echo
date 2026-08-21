import AppKit
import Foundation
import os.log

/// After a Transcribe-mode paste, watches the destination text field for
/// edits the user makes themselves (e.g. fixing a misheard word) and
/// reports the diff so it can be taught as a correction — without the
/// user having to copy anything or open a menu.
///
/// This only works by reading the focused element's value via the
/// Accessibility API, so it is best-effort by design: it silently does
/// nothing (never fires, never errors) when Accessibility isn't trusted,
/// or when the target app's text field doesn't expose a readable
/// `AXValue` at all — a real limitation with some Electron/Chromium
/// apps. There is no fallback for that case; the manual "Teach
/// Correction from Clipboard" menu item still exists for those apps.
@MainActor
final class PostPasteWatcher {
    private let log = Logger(subsystem: "ai.oasis.echo.mac", category: "post-paste-watch")

    private var timer: Timer?
    private var element: AXUIElement?
    private var originalText: String = ""
    private var lastSeenValue: String = ""
    private var lastChangedAt: Date = .distantPast
    private var deadline: Date = .distantPast

    /// How often to re-read the field's value.
    private let pollInterval: TimeInterval = 0.4
    /// How long the value must sit unchanged before treating the user as
    /// "done editing" and diffing it. Long enough that normal typing
    /// pauses (thinking mid-sentence) don't trigger a premature diff.
    private let settleDelay: TimeInterval = 1.6
    /// Give up watching a field indefinitely — the user may never touch
    /// it, or may navigate away without us noticing a focus change.
    private let maxWatchDuration: TimeInterval = 45

    /// Fired once, with (original, corrected), when a settled edit is
    /// detected. Never fired for a field that was never edited.
    var onCorrectionDetected: ((String, String) -> Void)?

    /// Begin watching. Captures whatever element is CURRENTLY focused as
    /// the paste target, so this must be called shortly after a
    /// successful paste while that field still has focus. No-ops
    /// (silently) if Accessibility isn't trusted, or if the focused
    /// element's current value doesn't match `originalText` — the
    /// latter means we've grabbed the wrong element (focus moved, or
    /// the app doesn't expose a plain-text AXValue for what it just
    /// received), and diffing against it would be meaningless.
    func start(originalText: String) {
        stop()
        guard Paster.isAccessibilityTrusted() else { return }
        guard let el = Self.focusedElement(), let value = Self.readValue(of: el) else { return }
        guard value == originalText else { return }

        element = el
        self.originalText = originalText
        lastSeenValue = value
        lastChangedAt = Date()
        deadline = Date().addingTimeInterval(maxWatchDuration)

        let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        log.debug("post-paste watch: started")
    }

    /// Stop watching without firing. Call when a new capture begins so a
    /// stale watch from an earlier paste doesn't fire mid-edit of
    /// something else.
    func stop() {
        timer?.invalidate()
        timer = nil
        element = nil
    }

    private func tick() {
        guard let el = element else { stop(); return }
        if Date() >= deadline {
            log.debug("post-paste watch: gave up after \(Int(self.maxWatchDuration), privacy: .public)s")
            stop()
            return
        }
        guard let value = Self.readValue(of: el) else {
            // Field became unreadable (focus moved to a non-text
            // element, app quit, etc.) — nothing more we can observe.
            stop()
            return
        }

        if value != lastSeenValue {
            lastSeenValue = value
            lastChangedAt = Date()
            return
        }

        guard Date().timeIntervalSince(lastChangedAt) >= settleDelay else { return }
        stop()
        if value != originalText, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            log.notice("post-paste watch: detected edit (originalLen=\(self.originalText.count, privacy: .public) newLen=\(value.count, privacy: .public))")
            onCorrectionDetected?(originalText, value)
        }
    }

    // MARK: - Accessibility helpers

    private static func focusedElement() -> AXUIElement? {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedApp: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp
        ) == .success, let app = focusedApp else { return nil }
        let appEl = app as! AXUIElement

        var focusedEl: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            appEl, kAXFocusedUIElementAttribute as CFString, &focusedEl
        ) == .success, let element = focusedEl else { return nil }
        return (element as! AXUIElement)
    }

    private static func readValue(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXValueAttribute as CFString, &value
        ) == .success else { return nil }
        return value as? String
    }
}
