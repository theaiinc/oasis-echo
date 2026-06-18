import ServiceManagement
import os.log

/// Bridges the "Open at login" preference to `SMAppService` (macOS 13+).
enum LaunchAtLogin {
    private static let log = Logger(subsystem: "ai.oasis.echo.mac", category: "LaunchAtLogin")

    static func apply(_ enabled: Bool) {
        let svc = SMAppService.mainApp
        do {
            if enabled {
                if svc.status == .enabled || svc.status == .requiresApproval { return }
                try svc.register()
            } else {
                if svc.status == .notRegistered { return }
                try svc.unregister()
            }
        } catch {
            log.error("SMAppService: \(error.localizedDescription, privacy: .public)")
        }
    }
}
