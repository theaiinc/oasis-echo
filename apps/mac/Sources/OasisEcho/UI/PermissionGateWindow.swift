import AppKit
import SwiftUI

/// Simple instructional window for granting Automation permission
/// (System Events). No polling or AX check — there's no API to verify
/// Automation at runtime. Just show steps and dismiss on Continue.
/// The next paste attempt will verify via AppleScript.
@MainActor
final class PermissionGateController {
    private let panel: NSPanel
    private let onContinue: () -> Void

    init(requires perm: Permission, onContinue: @escaping () -> Void) {
        self.onContinue = onContinue

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 300),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Oasis Echo — Permission Required"
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces]
        panel.center()

        let v = PermissionGateView(
            requires: perm,
            onOpenSettings: { openPrivacyPane(perm) },
            onContinue: { panel.orderOut(nil); onContinue() }
        )
        panel.contentView = NSHostingView(rootView: v)
        self.panel = panel
    }

    func show() {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

// MARK: - Permission kind

enum Permission: CustomStringConvertible {
    case accessibility
    case automation

    var settingsURL: String {
        switch self {
        case .accessibility:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .automation:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        }
    }

    var description: String {
        switch self {
        case .accessibility: "Accessibility"
        case .automation: "Automation"
        }
    }
}

private func openPrivacyPane(_ p: Permission) {
    if let url = URL(string: p.settingsURL) { NSWorkspace.shared.open(url) }
}

// MARK: - SwiftUI view

private struct PermissionGateView: View {
    let requires: Permission
    let onOpenSettings: () -> Void
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 4)

            Image(systemName: "shield")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)

            Text("Oasis Echo needs \(requires.description) access")
                .font(.headline)

            Text("Oasis Echo uses this to paste transcribed text into your active app.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("1. Open System Settings → Privacy & Security → \(requires.description)")
                    .font(.callout)
                Text("2. Find “OasisEcho” in the list and toggle it ON")
                    .font(.callout)
                Text("3. Click “Continue”")
                    .font(.callout)
            }
            .padding(12)
            .background(Color(.controlBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 16) {
                Button("Open System Settings", action: onOpenSettings)
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                Button("Continue", action: onContinue)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
            }

            Spacer(minLength: 4)
        }
        .padding(24)
        .frame(width: 440, height: 260)
    }
}
