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
                onStartNewMeeting: { delegate.startNewMeetingFromMenu() },
                onOpenSettings: { delegate.showSettingsWindow() }
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
    private var settingsWindowController: NSWindowController?

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
        installTerminationSignalHandler()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.shutdown()
        meetingController.cancel()
        ServerAutoLauncher.shared.stop()
    }

    // AppKit does not install a SIGTERM handler by default, so a plain
    // `kill <pid>` (as opposed to Cmd+Q / NSApp.terminate, which go
    // through the normal application-termination sequence) bypasses
    // applicationWillTerminate entirely — the kernel's default SIGTERM
    // action just ends the process immediately, with no chance for our
    // cleanup to run. That's how the locally-spawned Node/FunASR server
    // process kept getting silently orphaned (reparented to launchd,
    // still bound to the port, still holding a loaded speech model)
    // across every restart during development. Route SIGTERM through
    // the same clean-quit path so both cases converge.
    private var sigtermSource: DispatchSourceSignal?

    private func installTerminationSignalHandler() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in
            self?.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            exit(0)
        }
        source.resume()
        sigtermSource = source
    }

    func showSettingsWindow() {
        if let window = settingsWindowController?.window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let contentWidth: CGFloat = 520
        // Only fix the WIDTH here. The previous code also pinned
        // .frame(height: 540) on the SwiftUI content while separately
        // giving the AppKit hosting view a hardcoded 900pt-tall frame
        // below — two different, conflicting sizes for the same view.
        // NSHostingView centers SwiftUI content that's smaller than its
        // own frame, so that mismatch alone produced a large empty gap
        // above AND below every tab, regardless of what was in it.
        let rootView = SettingsView()
            .environmentObject(state)
            .environmentObject(controller)
            .frame(width: contentWidth)
        let hosting = NSHostingController(rootView: rootView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Oasis Echo Settings"
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        // A SwiftUI hosting view has no reliable intrinsic height inside
        // NSScrollView (constraining all four edges made the document
        // exactly viewport-sized, defeating scroll entirely), so ask it
        // directly: lay out at the target width, then read back the
        // height SwiftUI actually wants at that width instead of
        // guessing a constant.
        hosting.view.translatesAutoresizingMaskIntoConstraints = true
        hosting.view.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 1)
        let fittingHeight = max(hosting.view.fittingSize.height, 540)
        hosting.view.frame = NSRect(x: 0, y: 0, width: contentWidth, height: fittingHeight)
        scrollView.documentView = hosting.view
        window.contentView = scrollView
        window.minSize = NSSize(width: 480, height: 360)
        window.center()
        window.isReleasedWhenClosed = false
        settingsWindowController = NSWindowController(window: window)
        settingsWindowController?.showWindow(nil)
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        NSApp.activate(ignoringOtherApps: true)
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
