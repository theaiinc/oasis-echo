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
    // Bumped by every start()/stop() so a still-in-flight retry loop from
    // an earlier call can tell it's been superseded and quit instead of
    // clobbering a newer watch (or firing after stop()).
    private var generation = 0

    /// How often to re-read the field's value.
    private let pollInterval: TimeInterval = 0.4
    /// How long the value must sit unchanged before treating the user as
    /// "done editing" and diffing it. Long enough that normal typing
    /// pauses (thinking mid-sentence) don't trigger a premature diff.
    private let settleDelay: TimeInterval = 1.6
    /// Give up watching a field indefinitely — the user may never touch
    /// it, or may navigate away without us noticing a focus change.
    private let maxWatchDuration: TimeInterval = 45
    /// How many times to retry finding+matching the focused element
    /// before giving up. Some apps (Electron/Chromium in particular)
    /// can lag updating their Accessibility tree after receiving a
    /// paste keystroke, so the very first lookup failing isn't final.
    private let maxFindAttempts = 8
    private let findRetryInterval: TimeInterval = 0.35

    /// Fired once, with (original, corrected), when a settled edit is
    /// detected. Never fired for a field that was never edited.
    var onCorrectionDetected: ((String, String) -> Void)?

    /// Begin watching. Captures whatever element is focused once it
    /// settles on holding exactly `originalText` (retrying briefly, since
    /// the target app's Accessibility tree may lag a moment after
    /// receiving the paste). No-ops (silently, after exhausting retries)
    /// if Accessibility isn't trusted, or the app never exposes a
    /// matching readable AXValue at all.
    func start(originalText: String) {
        stop()
        generation += 1
        let myGeneration = generation
        guard Paster.isAccessibilityTrusted() else {
            log.notice("post-paste watch: skipped, Accessibility not trusted")
            return
        }
        Task { [weak self] in
            await self?.findAndAttach(originalText: originalText, generation: myGeneration, attemptsLeft: self?.maxFindAttempts ?? 0)
        }
    }

    private func findAndAttach(originalText: String, generation myGeneration: Int, attemptsLeft: Int) async {
        guard generation == myGeneration else { return }  // superseded by a newer start()/stop()

        guard let el = Self.focusedElement() else {
            await retryOrGiveUp("no focused element found", originalText: originalText, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }
        var role: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role)
        guard let value = Self.readValue(of: el) else {
            await retryOrGiveUp("focused element (role=\(role as? String ?? "?")) has no readable AXValue", originalText: originalText, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }
        guard value == originalText else {
            await retryOrGiveUp("focused element's value doesn't match what was pasted (role=\(role as? String ?? "?"), gotLen=\(value.count), wantLen=\(originalText.count))", originalText: originalText, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }

        guard generation == myGeneration else { return }
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
        log.notice("post-paste watch: started (after \(self.maxFindAttempts - attemptsLeft, privacy: .public) attempt(s))")
    }

    private func retryOrGiveUp(_ reason: String, originalText: String, generation myGeneration: Int, attemptsLeft: Int) async {
        guard attemptsLeft > 0 else {
            log.notice("post-paste watch: gave up, \(reason, privacy: .public)")
            return
        }
        try? await Task.sleep(nanoseconds: UInt64(findRetryInterval * 1_000_000_000))
        guard generation == myGeneration else { return }
        await findAndAttach(originalText: originalText, generation: myGeneration, attemptsLeft: attemptsLeft - 1)
    }

    /// Stop watching without firing. Call when a new capture begins so a
    /// stale watch from an earlier paste doesn't fire mid-edit of
    /// something else.
    func stop() {
        generation += 1
        timer?.invalidate()
        timer = nil
        element = nil
    }

    private func tick() {
        guard let el = element else { stop(); return }
        if Date() >= deadline {
            log.notice("post-paste watch: gave up after \(Int(self.maxWatchDuration), privacy: .public)s, field never settled on an edit")
            stop()
            return
        }
        guard let value = Self.readValue(of: el) else {
            // Field became unreadable (focus moved to a non-text
            // element, app quit, etc.) — nothing more we can observe.
            log.notice("post-paste watch: stopped, focused element became unreadable")
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
        let log = Logger(subsystem: "ai.oasis.echo.mac", category: "post-paste-watch")
        let frontmost = NSWorkspace.shared.frontmostApplication
        log.notice("post-paste watch: frontmostApp=\(frontmost?.bundleIdentifier ?? "nil", privacy: .public) pid=\(frontmost?.processIdentifier ?? -1, privacy: .public)")

        let systemWide = AXUIElementCreateSystemWide()
        var focusedApp: CFTypeRef?
        let appResult = AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp
        )
        guard appResult == .success, let app = focusedApp else {
            log.notice("post-paste watch: kAXFocusedApplicationAttribute failed, error=\(appResult.rawValue, privacy: .public)")
            return nil
        }
        let appEl = app as! AXUIElement

        var focusedEl: CFTypeRef?
        let elResult = AXUIElementCopyAttributeValue(
            appEl, kAXFocusedUIElementAttribute as CFString, &focusedEl
        )
        guard elResult == .success, let element = focusedEl else {
            log.notice("post-paste watch: kAXFocusedUIElementAttribute failed, error=\(elResult.rawValue, privacy: .public)")
            return nil
        }
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
