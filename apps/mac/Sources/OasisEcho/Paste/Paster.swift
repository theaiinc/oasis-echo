import AppKit
import Carbon.HIToolbox
import os

// Auto-paste into the frontmost app:
//   1) write plain text to the general pasteboard
//   2) bring target app to front
//   3) synthesize a single ⌘V-style insertion path
//
// Direct AX mutation is kept as the final fallback. Some apps can mutate
// their focused element even when AX reports a non-success result; trying
// Cmd+V after that ambiguous side effect can insert the same text twice.



enum Paster {
    enum Outcome { case pasted, copiedOnly, empty }

    private static let log = Logger(subsystem: "ai.oasis.echo.mac", category: "paste")

    /// How many times in a row paste has failed (both CGEvent + AppleScript).
    /// Reset on success; alert shown once when this hits 5.
    private static var consecutiveFailures = 0
    private static var alertShown = false
    /// Strong ref so the gate window's timer keeps running.
    private static var gateController: PermissionGateController?

    static func paste(_ text: String, activateTarget: NSRunningApplication? = nil) -> Outcome {
        guard !text.isEmpty else { return .empty }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)

        let target = activateTarget
        let pid = target?.processIdentifier
        log.notice("paste: targetPID=\(pid ?? -1, privacy: .public) targetBundle=\(target?.bundleIdentifier ?? "nil", privacy: .public)")

        // Bring the target app to front so ⌘V lands in the right field.
        if let target, target != NSRunningApplication.current {
            target.activate(options: [.activateIgnoringOtherApps])
            Thread.sleep(forTimeInterval: 0.3)
        }

        // Try event-based paste paths first. They all use the pasteboard
        // and mimic a normal user paste, so a single request maps to one
        // visible insertion.
        let axTrusted = isAccessibilityTrusted()
        log.notice("paste: started (AX=\(axTrusted, privacy: .public), textLen=\(text.count, privacy: .public))")

        // Path 1: CGEventPostToPid — posts Cmd+V directly to the target PID.
        if let pid, sendCmdVViaPostToPid(pid) {
            log.notice("paste: CGEventPostToPid OK")
            consecutiveFailures = 0; alertShown = false
            return .pasted
        }

        // Path 2: AppleScript — System Events keystroke.
        if sendCmdVViaAppleScript() {
            log.notice("paste: AppleScript OK")
            consecutiveFailures = 0; alertShown = false
            return .pasted
        }

        // Path 3: HID tap (only when AX trusted).
        if axTrusted {
            log.notice("paste: HID tap")
            sendCmdVViaHIDTap()
            consecutiveFailures = 0; alertShown = false
            return .pasted
        }

        // Path 4: AX insertion fallback. This is intentionally last so
        // an ambiguous AX side effect is never followed by another paste
        // strategy for the same request.
        if insertViaAX(text) {
            log.notice("paste: AX insertion OK")
            consecutiveFailures = 0; alertShown = false
            return .pasted
        }

        consecutiveFailures += 1
        log.error("paste: all paths failed (fails=\(consecutiveFailures))")

        if consecutiveFailures > 0, consecutiveFailures % 5 == 0, !alertShown {
            alertShown = true
            Task { @MainActor in showPermissionGate() }
        }

        return .copiedOnly
    }

    // MARK: - Instrumented AX insertion

    /// Logs every AX call outcome to Console.app (filter `paste`).
    private static func insertViaAX(_ text: String) -> Bool {
        log.notice("=== AX INSERTION DIAGNOSTIC ===")
        log.notice("bundleId: \(Bundle.main.bundleIdentifier ?? "nil", privacy: .public)")
        log.notice("bundlePath: \(Bundle.main.bundlePath, privacy: .public)")
        log.notice("pid: \(ProcessInfo.processInfo.processIdentifier, privacy: .public)")
        log.notice("AXIsProcessTrusted: \(AXIsProcessTrusted(), privacy: .public)")
        if let front = NSWorkspace.shared.frontmostApplication {
            log.notice("frontmostApp: \(front.bundleIdentifier ?? "nil", privacy: .public) pid=\(front.processIdentifier, privacy: .public)")
        }

        let systemWide = AXUIElementCreateSystemWide()

        // 1. Get focused application
        var focusedApp: CFTypeRef?
        let appResult = AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp)
        log.notice("AX focusedApp result=\(appResult.rawValue)")

        guard appResult == .success, let app = focusedApp else {
            log.notice("→ no focused app (AX may not be working)")
            return false
        }
        let appEl = app as! AXUIElement

        // 2. Get focused element within that app
        var focusedEl: CFTypeRef?
        let elResult = AXUIElementCopyAttributeValue(
            appEl, kAXFocusedUIElementAttribute as CFString, &focusedEl)
        log.notice("AX focusedEl result=\(elResult.rawValue)")

        guard elResult == .success, let element = focusedEl else {
            log.notice("→ no focused element (app may not expose one)")
            return false
        }
        let ax = element as! AXUIElement

        // 3. Log role and subrole
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(ax, kAXRoleAttribute as CFString, &role) == .success {
            log.notice("AX role: \(role as? String ?? "?")")
        }
        var subrole: CFTypeRef?
        if AXUIElementCopyAttributeValue(ax, kAXSubroleAttribute as CFString, &subrole) == .success {
            log.notice("AX subrole: \(subrole as? String ?? "?")")
        }

        // 4. Log writable attribute names
        var names: CFArray?
        if AXUIElementCopyAttributeNames(ax, &names) == .success {
            let attrs = (names as? [String]) ?? []
            log.notice("AX attributeNames: \(attrs)")
            log.notice("AX hasValue=\(attrs.contains("AXValue")) hasSelectedText=\(attrs.contains("AXSelectedText"))")
        }

        // 5. Log action names (paste action etc.)
        var actions: CFArray?
        if AXUIElementCopyActionNames(ax, &actions) == .success {
            log.notice("AX actionNames: \((actions as? [String]) ?? [])")
        }

        // 6. Try setting AXValue
        let valErr = AXUIElementSetAttributeValue(ax, kAXValueAttribute as CFString, text as CFTypeRef)
        log.notice("AX setValue result=\(valErr.rawValue)")
        if valErr == .success {
            log.notice("→ AXValue set OK")
            return true
        }

        // 7. Try AXSelectedText
        var selectedText: CFTypeRef?
        let selResult = AXUIElementCopyAttributeValue(ax, kAXSelectedTextAttribute as CFString, &selectedText)
        log.notice("AX selectedText result=\(selResult.rawValue)")

        if selResult == .success {
            let selErr = AXUIElementSetAttributeValue(ax, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
            log.notice("AX setSelectedText result=\(selErr.rawValue)")
            if selErr == .success {
                log.notice("→ AXSelectedText set OK")
                return true
            }
        }

        // 8. Try AXPress (some elements accept paste via press)
        var pressAction: CFTypeRef?
        if AXUIElementCopyAttributeValue(ax, "AXPressAction" as CFString, &pressAction) == .success {
            // Not standard — just log it
        }

        log.notice("=== AX INSERTION FAILED ===")
        return false
    }

    // MARK: - Event helpers

    /// Create a Cmd+V key-down + key-up pair.
    private static func cmdVEvents() -> (down: CGEvent, up: CGEvent)? {
        let src = CGEventSource(stateID: .privateState)
        let vKey = CGKeyCode(kVK_ANSI_V)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false)
        else { return nil }
        down.flags = .maskCommand
        up.flags = .maskCommand
        return (down, up)
    }

    /// Path: CGEventPost to `.cghidEventTap`. Needs AX.
    private static func sendCmdVViaHIDTap() {
        guard let (down, up) = cmdVEvents() else { return }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    // CGEventPostToPid — posts events directly to a process.
    @_silgen_name("CGEventPostToPid")
    private static func _CGEventPostToPid(_ pid: pid_t, _ event: CGEvent) -> CGError

    /// Path: CGEventPostToPid — private SPI, posts to target PID directly.
    private static func sendCmdVViaPostToPid(_ pid: pid_t) -> Bool {
        guard let (down, up) = cmdVEvents() else { return false }
        let r1 = _CGEventPostToPid(pid, down)
        let r2 = _CGEventPostToPid(pid, up)
        log.notice("CGEventPostToPid(\(pid, privacy: .public)): down=\(r1.rawValue, privacy: .public) up=\(r2.rawValue, privacy: .public)")
        return r1 == .success && r2 == .success
    }

    private static func sendCmdVViaAppleScript() -> Bool {
        // Use osascript CLI instead of NSAppleScript — on macOS 14+
        // the in-process NSAppleScript TCC prompt is silently denied
        // for ad-hoc-signed apps, but osascript shows it properly.
        let src = #"tell application "System Events" to keystroke "v" using command down"#
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", src]
        let errOut = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = errOut
        do {
            try p.run()
            p.waitUntilExit()
            let ok = p.terminationStatus == 0
            if !ok {
                let errData = errOut.fileHandleForReading.readDataToEndOfFile()
                let errStr = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                log.error("paste: osascript exit \(p.terminationStatus, privacy: .public) — \(errStr, privacy: .public)")
            }
            return ok
        } catch {
            log.error("paste: osascript launch failed: \(error.localizedDescription)")
            return false
        }
    }

    static func isAccessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    /// Show the gate window that waits for the user to grant the missing
    /// permission. Only fired after 5 consecutive paste failures.
    @MainActor
    static func showPermissionGate() {
        // AppleScript (System Events) is the reliable paste path — tied
        // to bundle ID, survives ad-hoc rebuilds. Always guide to
        // Automation permission, not Accessibility.
        let ctrl = PermissionGateController(requires: .automation) { gateController = nil }
        gateController = ctrl
        ctrl.show()
    }

    /// Public convenience for "Grant Accessibility" menu item (menu bar).
    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}
