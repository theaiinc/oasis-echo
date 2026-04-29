import SwiftUI
import AppKit

@main
struct OasisEchoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent()
                .environmentObject(delegate.state)
                .environmentObject(delegate.controller)
        } label: {
            MenuBarLabel()
                .environmentObject(delegate.state)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(delegate.state)
                .environmentObject(delegate.controller)
                .frame(width: 560, height: 420)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    lazy var controller: TurnController = TurnController(state: state)
    private var pillController: PillWindowController!
    private var echoDialogController: EchoDialogWindowController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu bar only, no Dock icon
        pillController = PillWindowController(state: state, controller: controller)
        pillController.show()
        pillController.bindSizeUpdates(state)
        echoDialogController = EchoDialogWindowController(
            state: state,
            orbPanel: pillController.window()
        )
        echoDialogController.bind()
        // Keep the dialog stuck to the orb when the orb's panel resizes
        // for a toast/caption or repositions on a screen change.
        pillController.onGeometryChanged = { [weak self] in
            self?.echoDialogController.reposition()
        }
        controller.bindPill(pillController)
        HotkeyManager.shared.install(controller: controller, state: state)
        Task { await controller.bootstrap() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.shutdown()
    }
}
