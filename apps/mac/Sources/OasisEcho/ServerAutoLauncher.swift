import Foundation

/// Finds the monorepo root (directory whose `package.json` has `"name": "oasis-echo"`).
enum RepoRoot {
    static func resolve(customPath: String) -> URL? {
        let trimmed = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            let expanded = (trimmed as NSString).expandingTildeInPath
            let u = URL(fileURLWithPath: expanded, isDirectory: true)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir), isDir.boolValue else {
                return nil
            }
            let pkg = u.appendingPathComponent("package.json")
            guard let data = try? Data(contentsOf: pkg),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (json["name"] as? String) == "oasis-echo"
            else { return nil }
            return u
        }
        var url = Bundle.main.bundleURL
        for _ in 0 ..< 16 {
            let pkg = url.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: pkg),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (json["name"] as? String) == "oasis-echo" {
                return url
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        return nil
    }
}

/// Spawns the server when the API is down.
///
/// Two modes:
///   - `useDocker = false` → runs `npm run server` from the repo root
///   - `useDocker = true`  → runs `docker compose up -d` and waits for the container
@MainActor
final class ServerAutoLauncher {
    static let shared = ServerAutoLauncher()

    private var child: Process?
    private let refreshLock = NSLock()
    private var refreshServerActive = false

    private init() {}

    /// Prevents overlapping `refreshServer` runs from spawning duplicate processes.
    func beginRefreshServerSection() -> Bool {
        refreshLock.lock()
        defer { refreshLock.unlock() }
        if refreshServerActive { return false }
        refreshServerActive = true
        return true
    }

    func endRefreshServerSection() {
        refreshLock.lock()
        refreshServerActive = false
        refreshLock.unlock()
    }

    /// Starts the server (Docker or npm) and waits until `/config` succeeds or timeout.
    func ensureServerRunning(client: OasisClient, state: AppState) async {
        if state.useDocker {
            await ensureDockerRunning(client: client, state: state)
            return
        }

        guard let repo = RepoRoot.resolve(customPath: state.serverRepoRootPath) else { return }

        if child?.isRunning == true {
            await waitForReachable(client: client, state: state)
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-l", "-c", "PORT=9187 npm run server"]
        p.currentDirectoryURL = repo
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "dumb"
        p.environment = env
        if let null = try? FileHandle(forWritingTo: URL(fileURLWithPath: "/dev/null")) {
            p.standardOutput = null
            p.standardError = null
        }

        do {
            try p.run()
            child = p
        } catch {
            NSLog("ServerAutoLauncher: failed to spawn npm run server: \(error.localizedDescription)")
            return
        }

        await waitForReachable(client: client, state: state)
    }

    /// Starts the Docker container via `docker compose up -d`.
    private func ensureDockerRunning(client: OasisClient, state: AppState) async {
        guard let repo = RepoRoot.resolve(customPath: state.serverRepoRootPath) else { return }

        guard dockerAvailable() else {
            NSLog("ServerAutoLauncher: Docker is not available (docker info failed)")
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["docker", "compose", "up", "-d"]
        p.currentDirectoryURL = repo
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "dumb"
        p.environment = env
        if let null = try? FileHandle(forWritingTo: URL(fileURLWithPath: "/dev/null")) {
            p.standardOutput = null
            p.standardError = null
        }

        do {
            try p.run()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else {
                NSLog("ServerAutoLauncher: docker compose up failed with status \(p.terminationStatus)")
                return
            }
        } catch {
            NSLog("ServerAutoLauncher: failed to run docker compose up: \(error.localizedDescription)")
            return
        }

        await waitForReachable(client: client, state: state)
    }

    /// Returns true if the Docker daemon is reachable.
    private func dockerAvailable() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["docker", "info", "--format", "{{.ServerVersion}}"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func waitForReachable(client: OasisClient, state: AppState) async {
        for _ in 0 ..< 120 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if await tryPingIntoState(client: client, state: state) { return }
        }
    }

    /// Returns `true` if the server answered and `state` was updated.
    private func tryPingIntoState(client: OasisClient, state: AppState) async -> Bool {
        for url in state.localServerURLCandidates() {
            await client.updateBase(url)
            if let cfg = await client.ping() {
                state.serverBaseURL = url.absoluteString
                state.serverReachable = true
                state.serverModel = [cfg.backend, cfg.model].compactMap { $0 }.joined(separator: " · ")
                return true
            }
        }
        return false
    }
}
