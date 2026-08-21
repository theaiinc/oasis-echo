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
    // The field may hold MORE than just what we pasted — e.g. a chat
    // composer that accumulates each dictation on top of the last
    // rather than replacing it. `prefixLength` is however many
    // characters preceded our pasted text at watch-start; every
    // subsequent read drops that many characters and treats only the
    // remainder as "our" text, so this still works after several
    // dictations have piled up in the same field without a clear
    // in between. Edits BEFORE that prefix boundary are invisible to
    // this watcher by design — we only track what we ourselves pasted.
    private var prefixLength: Int = 0
    private var lastSeenTail: String = ""
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
    /// before giving up, and how far apart. Two distinct causes have
    /// been observed for the first attempt(s) failing, both transient:
    /// Electron/Chromium apps lazily building their accessibility tree
    /// (AXError -25212, kAXErrorNoValue — resolved within ~2s once
    /// activateAccessibility() forces it), and Accessibility trust
    /// having been granted moments ago but the AX server not yet fully
    /// wired up for this process (AXError -25211, kAXErrorAPIDisabled,
    /// despite AXIsProcessTrusted() already reporting true — took
    /// longer than the original 8×0.35s≈3s window to clear in
    /// practice). 20×0.5s=10s gives real headroom for either.
    private let maxFindAttempts = 20
    private let findRetryInterval: TimeInterval = 0.5

    /// Fired once, with (original, corrected), when a settled edit is
    /// detected. Never fired for a field that was never edited.
    var onCorrectionDetected: ((String, String) -> Void)?

    /// Begin watching. Captures whatever element is focused within
    /// `targetPID` — the app we just pasted into — once its value ENDS
    /// WITH `originalText` (retrying briefly, since the target app's
    /// Accessibility tree may lag a moment after receiving the paste).
    /// No-ops (silently, after exhausting retries) if Accessibility
    /// isn't trusted, or the app never exposes a matching readable
    /// AXValue at all.
    ///
    /// Deliberately does NOT use the system-wide `kAXFocusedApplication`
    /// lookup (asking "who's focused?"), even though that's the more
    /// common pattern — it consistently failed with AXError -25212
    /// (`kAXErrorNoValue`) here, apparently because OasisEcho, an
    /// accessory app with no windows of its own, had just driven the
    /// target app frontmost via synthetic activation rather than a
    /// direct user click, and the system's AX-focus tracking didn't
    /// resolve cleanly from that state. We already know exactly which
    /// app we pasted into, so build its AXUIElement directly from that
    /// PID and ask IT which of its own elements is focused — a strictly
    /// narrower, more reliable question.
    func start(originalText: String, targetPID: pid_t) {
        stop()
        generation += 1
        let myGeneration = generation
        guard Paster.isAccessibilityTrusted() else {
            log.notice("post-paste watch: skipped, Accessibility not trusted")
            return
        }
        Self.activateAccessibility(forPID: targetPID)
        Task { [weak self] in
            await self?.findAndAttach(originalText: originalText, targetPID: targetPID, generation: myGeneration, attemptsLeft: self?.maxFindAttempts ?? 0)
        }
    }

    /// Chromium/Electron apps (Claude Desktop included) compute their
    /// accessibility tree lazily — by default a caller asking for
    /// kAXFocusedUIElement gets AXError -25212 (kAXErrorNoValue) because
    /// the tree was never built, not because nothing is focused. Setting
    /// these attributes on the app element is the documented way to force
    /// Chromium to activate full accessibility support for this process.
    /// Best-effort: harmless no-op on apps that don't recognize either
    /// attribute (most non-Electron apps).
    private static func activateAccessibility(forPID targetPID: pid_t) {
        let appEl = AXUIElementCreateApplication(targetPID)
        AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    private func findAndAttach(originalText: String, targetPID: pid_t, generation myGeneration: Int, attemptsLeft: Int) async {
        guard generation == myGeneration else { return }  // superseded by a newer start()/stop()

        guard let el = Self.focusedElement(inApp: targetPID) else {
            await retryOrGiveUp("no focused element found in pid \(targetPID)", originalText: originalText, targetPID: targetPID, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }
        var role: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role)
        guard let value = Self.readValue(of: el) else {
            await retryOrGiveUp("focused element (role=\(role as? String ?? "?")) has no readable AXValue", originalText: originalText, targetPID: targetPID, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }
        // The field's current value must END WITH what we just pasted —
        // not equal it outright — since an app whose composer
        // accumulates text (rather than clearing between dictations)
        // will have earlier content still sitting before it.
        guard value.hasSuffix(originalText) else {
            await retryOrGiveUp("focused element's value doesn't end with what was pasted (role=\(role as? String ?? "?"), gotLen=\(value.count), wantLen=\(originalText.count))", originalText: originalText, targetPID: targetPID, generation: myGeneration, attemptsLeft: attemptsLeft)
            return
        }

        guard generation == myGeneration else { return }
        element = el
        self.originalText = originalText
        prefixLength = value.count - originalText.count
        lastSeenTail = originalText
        lastChangedAt = Date()
        deadline = Date().addingTimeInterval(maxWatchDuration)

        let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        log.notice("post-paste watch: started (after \(self.maxFindAttempts - attemptsLeft, privacy: .public) attempt(s))")
    }

    private func retryOrGiveUp(_ reason: String, originalText: String, targetPID: pid_t, generation myGeneration: Int, attemptsLeft: Int) async {
        guard attemptsLeft > 0 else {
            log.notice("post-paste watch: gave up, \(reason, privacy: .public)")
            return
        }
        try? await Task.sleep(nanoseconds: UInt64(findRetryInterval * 1_000_000_000))
        guard generation == myGeneration else { return }
        await findAndAttach(originalText: originalText, targetPID: targetPID, generation: myGeneration, attemptsLeft: attemptsLeft - 1)
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
        guard value.count >= prefixLength else {
            // The user deleted back past where our text started (e.g.
            // selected everything and retyped) — can no longer say
            // which part, if any, corresponds to what we pasted.
            log.notice("post-paste watch: stopped, field shrank past our prefix boundary")
            stop()
            return
        }
        let tail = String(value.dropFirst(prefixLength))

        if tail != lastSeenTail {
            lastSeenTail = tail
            lastChangedAt = Date()
            return
        }

        guard Date().timeIntervalSince(lastChangedAt) >= settleDelay else { return }
        stop()
        if tail != originalText, !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            log.notice("post-paste watch: detected edit (originalLen=\(self.originalText.count, privacy: .public) newLen=\(tail.count, privacy: .public))")
            onCorrectionDetected?(originalText, tail)
        }
    }

    // MARK: - Accessibility helpers

    /// Ask the target app itself which of its own elements is focused,
    /// rather than asking the system-wide element "who's focused?" — see
    /// the comment on `start(originalText:targetPID:)` for why.
    private static func focusedElement(inApp targetPID: pid_t) -> AXUIElement? {
        let log = Logger(subsystem: "ai.oasis.echo.mac", category: "post-paste-watch")
        let appEl = AXUIElementCreateApplication(targetPID)

        var focusedEl: CFTypeRef?
        let elResult = AXUIElementCopyAttributeValue(
            appEl, kAXFocusedUIElementAttribute as CFString, &focusedEl
        )
        guard elResult == .success, let element = focusedEl else {
            log.notice("post-paste watch: kAXFocusedUIElementAttribute (pid=\(targetPID, privacy: .public)) failed, error=\(elResult.rawValue, privacy: .public)")
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
