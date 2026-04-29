import AppKit
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    static let pushToTalk = Self("pushToTalk", default: .init(.o, modifiers: [.control, .option]))
    static let handsFree  = Self("handsFree",  default: .init(.o, modifiers: [.control, .option, .shift]))
    static let toggleMode = Self("toggleMode", default: .init(.m, modifiers: [.command, .shift]))
}

@MainActor
final class HotkeyManager {
    static let shared = HotkeyManager()
    private var installed = false
    private let fn = FnKeyMonitor()

    func install(controller: TurnController, state: AppState) {
        guard !installed else { return }
        installed = true

        // Push-to-talk: press = start capture, release = commit.
        KeyboardShortcuts.onKeyDown(for: .pushToTalk) { [weak controller] in
            controller?.startPushToTalk()
        }
        KeyboardShortcuts.onKeyUp(for: .pushToTalk) { [weak controller] in
            controller?.endPushToTalk()
        }

        // Hands-free: press once to start, press again to stop/commit.
        KeyboardShortcuts.onKeyDown(for: .handsFree) { [weak controller] in
            controller?.toggleHandsFree()
        }

        // Mode toggle: flip Transcribe ⇄ Echo anywhere, any time.
        KeyboardShortcuts.onKeyDown(for: .toggleMode) { [weak state, weak controller] in
            guard let state, let controller else { return }
            let next = state.mode.toggled()
            state.setMode(next)
            controller.onModeChanged(next)
        }

        // Fn key push-to-talk (modifier — not bindable through the
        // regular shortcut API). Fires the same controller callbacks.
        if state.useFnKey {
            fn.install(
                onDown: { [weak controller] in controller?.startPushToTalk() },
                onUp:   { [weak controller] in controller?.endPushToTalk() }
            )
        }
    }

    func setFnKeyEnabled(_ enabled: Bool, controller: TurnController) {
        if enabled {
            fn.install(
                onDown: { [weak controller] in controller?.startPushToTalk() },
                onUp:   { [weak controller] in controller?.endPushToTalk() }
            )
        } else {
            fn.uninstall()
        }
    }
}
