import SwiftUI
import AppKit

@main
struct OasisEchoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(
                onShowMeetingWindow: { delegate.meetingWindowController?.show() },
                onShowMeetingHistory: { delegate.meetingHistoryWindowController?.show() },
                onStartNewMeeting: { delegate.startNewMeetingFromMenu() }
            )
                .environmentObject(delegate.state)
                .environmentObject(delegate.controller)
                .environmentObject(delegate.meetingController)
        } label: {
            MenuBarLabel()
                .environmentObject(delegate.state)
                .environmentObject(delegate.meetingController)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(delegate.state)
                .environmentObject(delegate.controller)
                .frame(width: 560, height: 540)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    lazy var controller: TurnController = TurnController(state: state)
    lazy var meetingController: MeetingController = MeetingController(state: state)
    private var pillController: PillWindowController!
    private var echoDialogController: EchoDialogWindowController!
    var meetingWindowController: MeetingWindowController?
    var meetingHistoryWindowController: MeetingHistoryWindowController?
    var meetingToastController: MeetingToastWindowController?

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

        // Meeting windows + toast. We construct lazily-referenced
        // controllers up front so the menu items and TurnController
        // don't have to spin up windows mid-session.
        meetingHistoryWindowController = MeetingHistoryWindowController(state: state) { [weak self] id in
            self?.loadMeetingFromHistory(id: id)
        }
        meetingWindowController = MeetingWindowController(
            state: state,
            controller: meetingController,
            onShowHistory: { [weak self] in self?.meetingHistoryWindowController?.show() }
        )
        meetingToastController = MeetingToastWindowController { [weak self] in
            self?.startNewMeetingFromToast()
        }

        // TurnController owns the long-capture detector. When a single
        // capture exceeds the threshold, it pings us to show the toast.
        controller.onLongCaptureDetected = { [weak self] in
            self?.meetingToastController?.show()
        }

        HotkeyManager.shared.install(controller: controller, state: state)
        LaunchAtLogin.apply(state.launchAtLogin)
        Task { await controller.bootstrap() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.shutdown()
        meetingController.cancel()
    }

    // MARK: - Meeting actions wired to menu/toast

    func startNewMeetingFromMenu() {
        // If a meeting is already in flight, just bring its window forward
        // — don't blow it away.
        if case .recording = meetingController.state {
            meetingWindowController?.show(); return
        }
        if case .generating = meetingController.state {
            meetingWindowController?.show(); return
        }
        meetingController.reset()
        meetingController.start()
        meetingWindowController?.show()
    }

    func startNewMeetingFromToast() {
        // The toast fires while a push-to-talk capture is still going
        // — cancel that capture so the mic is free for the meeting,
        // then start the meeting and surface the window.
        controller.cancelInFlightCaptureIfAny()
        meetingController.reset()
        meetingController.start()
        meetingWindowController?.show()
    }

    private func loadMeetingFromHistory(id: String) {
        let url = URL(string: state.serverBaseURL) ?? URL(string: "http://127.0.0.1:3000")!
        let client = OasisClient(baseURL: url)
        Task {
            do {
                let detail = try await client.getMeeting(id: id)
                await MainActor.run {
                    self.meetingController.loadCompleted(detail: detail)
                    self.meetingWindowController?.show()
                }
            } catch {
                NSLog("loadMeetingFromHistory failed: \(error)")
            }
        }
    }
}
