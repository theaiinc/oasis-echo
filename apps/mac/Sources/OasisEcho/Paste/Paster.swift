import AppKit
import Carbon.HIToolbox
import os

// Two-step auto-paste into the frontmost app:
//   1) write plain text to the general pasteboard
//   2) synthesize a ⌘V key event with CGEvent → system delivers it to
//      whatever has keyboard focus.
//
// This avoids Accessibility-API text field manipulation (which breaks
// on sandboxed targets like Messages) and works in any text context
// that accepts a paste command — which is what Wispr/Superwhisper do.

enum Paster {
    enum Outcome { case pasted, copiedOnly, empty }

    private static let log = Logger(subsystem: "ai.oasis.echo.mac", category: "paste")

    static func paste(_ text: String) -> Outcome {
        guard !text.isEmpty else { return .empty }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        // Path 1: CGEvent.post — needs Accessibility. Fast (~1 ms).
        if isAccessibilityTrusted() {
            log.info("paste: AX trusted — using CGEvent")
            // Tiny delay so the pasteboard write is visible before the
            // keystroke fires. CGEvent is async-safe.
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(30)) {
                sendCmdVViaCGEvent()
            }
            return .pasted
        }

        // Path 2: AppleScript via System Events — needs Automation
        // permission (NSAppleEventsUsageDescription is in our Info.plist).
        // Synchronous: ~10–50 ms. Returns the real outcome so we don't
        // pretend a paste happened when it didn't.
        let scriptOK = sendCmdVViaAppleScript()
        if scriptOK {
            log.info("paste: AppleScript path succeeded")
            return .pasted
        }

        log.error("paste: BOTH paths failed (AX=false, AppleScript denied/error). Text remains on clipboard for manual ⌘V.")
        return .copiedOnly
    }

    private static func sendCmdVViaCGEvent() {
        let src = CGEventSource(stateID: .hidSystemState)
        let vKey = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true)
        let up   = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private static func sendCmdVViaAppleScript() -> Bool {
        // First call triggers macOS's one-shot Automation prompt for
        // "System Events". If the user denied or the prompt was missed,
        // executeAndReturnError fills `err` with code -1743 (errAEEventNotPermitted)
        // and we report failure so the UI can flag it.
        let src = #"tell application "System Events" to keystroke "v" using command down"#
        guard let script = NSAppleScript(source: src) else {
            log.error("paste: NSAppleScript init failed")
            return false
        }
        var err: NSDictionary?
        _ = script.executeAndReturnError(&err)
        if let err {
            // Common: -1743 = "not authorized to send Apple events to System Events"
            // Less common: -600 = process not running
            log.error("paste: AppleScript error \(String(describing: err), privacy: .public)")
            return false
        }
        return true
    }

    // Non-prompting probe. Returns current AX trust state without
    // annoying the user with a Settings prompt.
    static func isAccessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    // One-time prompt at startup so the user sees a helpful alert
    // directing them to System Settings → Privacy → Accessibility.
    @discardableResult
    static func ensureAccessibilityAuthorized() -> Bool {
        let opts: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        return AXIsProcessTrustedWithOptions(opts)
    }

    // Direct URL into the Accessibility pane on macOS 13+.
    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    // Once-per-session prompt when paste actually fails. Shows an alert
    // explaining what's missing and offers a one-click jump to Settings.
    private static var didShowAXAlert = false
    @MainActor
    static func showAccessibilityFailureAlert() {
        guard !didShowAXAlert else { return }
        didShowAXAlert = true

        // Bring the alert to the foreground; otherwise an .accessory app
        // shows the dialog behind whatever the user is focused on.
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "Auto-paste needs Accessibility"
        alert.informativeText = """
            Your transcript is on the clipboard, but macOS won't let Oasis Echo paste it for you until you grant Accessibility permission.

            Open System Settings → Privacy & Security → Accessibility and toggle Oasis Echo on. (You may need to drag OasisEcho.app onto the list with the + button.)
            """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn {
            openAccessibilitySettings()
        }
    }
}
