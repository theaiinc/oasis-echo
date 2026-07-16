import AppKit
import Foundation
import os.log

// Detects Fn (fn/globe) key press and release system-wide by observing
// a CGEvent tap for flagsChanged events. The KeyboardShortcuts library
// can't bind Fn because it's a modifier flag, not a regular key code —
// so this runs in parallel and fires the same push-to-talk callbacks.
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
    private let log = Logger(subsystem: "ai.oasis.echo.mac", category: "fn-key")
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var fallbackMonitor: Any?
    private var localMonitor: Any?
    private var isDown = false
    private var onDown: (@MainActor () -> Void)?
    private var onUp: (@MainActor () -> Void)?

    func install(onDown: @escaping @MainActor () -> Void,
                 onUp:   @escaping @MainActor () -> Void) {
        uninstall()
        self.onDown = onDown
        self.onUp = onUp

        installEventTap()

        // Keep an AppKit global monitor active even when the CGEvent tap
        // exists. macOS can disable an otherwise valid tap in response to
        // user input; the fallback must already be installed to preserve
        // Fn while another app has focus.
        fallbackMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in self?.handle(modifierFlags: event.modifierFlags) }
        }

        // A session event tap sees our app too, but the local monitor is
        // cheap and preserves Fn handling in Settings if global trust is
        // missing or the tap is temporarily unavailable.
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in self?.handle(modifierFlags: event.modifierFlags) }
            return event
        }
    }

    func uninstall() {
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let m = fallbackMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
        runLoopSource = nil
        eventTap = nil
        fallbackMonitor = nil
        localMonitor = nil
        isDown = false
    }

    private func installEventTap() {
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: Self.eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )

        guard let tap else {
            log.warning("Fn event tap unavailable; Accessibility trust may be missing")
            return
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            log.error("Fn event tap source creation failed")
            CGEvent.tapEnable(tap: tap, enable: false)
            return
        }

        eventTap = tap
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        log.notice("Fn event tap installed")
    }

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let monitor = Unmanaged<FnKeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()

        Task { @MainActor in
            monitor.handle(type: type, event: event)
        }

        return Unmanaged.passUnretained(event)
    }

    private func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .flagsChanged:
            // Read the native CGEvent flag directly. On newer macOS
            // versions the Fn/Globe key is reported as secondaryFn, and
            // converting through NSEvent.ModifierFlags can lose that bit.
            handle(fnDown: event.flags.contains(.maskSecondaryFn))
        case .tapDisabledByTimeout:
            recoverDisabledTap(reason: "timeout")
        case .tapDisabledByUserInput:
            recoverDisabledTap(reason: "user-input")
        default:
            break
        }
    }

    private func recoverDisabledTap(reason: String) {
        log.warning("Fn event tap disabled by \(reason, privacy: .public); re-enabling")
        if isDown {
            isDown = false
            onUp?()
            log.notice("Fn release synthesized after disabled event tap")
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: true)
        } else {
            installEventTap()
        }
    }

    private func handle(modifierFlags: NSEvent.ModifierFlags) {
        handle(fnDown: modifierFlags.contains(.function))
    }

    private func handle(fnDown down: Bool) {
        if down && !isDown {
            isDown = true
            log.debug("Fn down")
            onDown?()
        } else if !down && isDown {
            isDown = false
            log.debug("Fn up")
            onUp?()
        }
    }
}
