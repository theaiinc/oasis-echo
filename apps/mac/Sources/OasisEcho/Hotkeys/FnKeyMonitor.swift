import AppKit
import Foundation

// Detects Fn (fn/globe) key press and release system-wide by observing
// NSEvent.flagsChanged globally. The KeyboardShortcuts library can't
// bind Fn because it's a modifier flag, not a regular key code — so
// this runs in parallel and fires the same push-to-talk callbacks.
//
// Requires Accessibility permission (already granted for auto-paste).
//
// Caveat: on recent macOS versions the OS may consume Fn for the
// built-in dictation or the emoji picker depending on
// System Settings → Keyboard → "Press 🌐 key to". If this monitor sees
// no events when the user holds Fn, they should change that setting to
// "Do Nothing".

@MainActor
final class FnKeyMonitor {
    private var monitor: Any?
    private var localMonitor: Any?
    private var isDown = false
    private var onDown: (@MainActor () -> Void)?
    private var onUp: (@MainActor () -> Void)?

    func install(onDown: @escaping @MainActor () -> Void,
                 onUp:   @escaping @MainActor () -> Void) {
        uninstall()
        self.onDown = onDown
        self.onUp = onUp

        // Global monitor: events from other apps. Won't fire when our
        // own window has focus, so we also install a local monitor.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
            return event
        }
    }

    func uninstall() {
        if let m = monitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
        monitor = nil
        localMonitor = nil
        isDown = false
    }

    private func handle(_ event: NSEvent) {
        let down = event.modifierFlags.contains(.function)
        if down && !isDown {
            isDown = true
            onDown?()
        } else if !down && isDown {
            isDown = false
            onUp?()
        }
    }
}
