import Foundation

/// Finds the monorepo root (directory whose `package.json` has `"name": "oasis-echo"`).
enum RepoRoot {
    static func resolve(customPath: String) -> URL? {
        var candidates: [URL] = []
        let trimmed = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            candidates.append(URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath, isDirectory: true))
        }
        if let bundled = Bundle.main.object(forInfoDictionaryKey: "OasisEchoServerRepoRoot") as? String,
           !bundled.isEmpty {
            candidates.append(URL(fileURLWithPath: bundled, isDirectory: true))
        }
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true))
        candidates.append(Bundle.main.bundleURL)
        if let executable = Bundle.main.executableURL {
            candidates.append(executable.deletingLastPathComponent())
        }

        for candidate in candidates {
            var url = candidate
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
        }
        return nil
    }
}

enum ServerLaunchCommand {
    /// Finder/launched apps inherit launchd's minimal PATH, which usually
    /// excludes Homebrew's Node installation. Resolve Node before spawning
    /// the shell instead of relying on the interactive terminal's PATH.
    static func nodeExecutable(environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        var candidates: [String] = []
        if let path = environment["PATH"] {
            candidates.append(contentsOf: path.split(separator: ":").map { "\($0)/node" })
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ])

        for candidate in candidates {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func arguments(port: Int = 9187, nodePath: String) -> [String] {
        let quotedNodePath = "'" + nodePath.replacingOccurrences(of: "'", with: "'\\''") + "'"
        return ["-l", "-c", "PORT=\(port) exec \(quotedNodePath) --import tsx packages/app/src/server.ts"]
    }
}

/// Spawns the server when the API is down.
///
/// Two modes:
///   - `useDocker = false` → runs the workspace server entrypoint directly
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

        guard let repo = RepoRoot.resolve(customPath: state.serverRepoRootPath) else {
            NSLog("ServerAutoLauncher: no oasis-echo checkout found; set Repository folder in Settings")
            return
        }

        if child?.isRunning == true {
            await waitForReachable(client: client, state: state)
            return
        }

        guard let nodePath = ServerLaunchCommand.nodeExecutable() else {
            NSLog("ServerAutoLauncher: Node.js not found; install Node or add it to PATH")
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ServerLaunchCommand.arguments(nodePath: nodePath)
        p.currentDirectoryURL = repo
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "dumb"
        p.environment = env
        if let null = try? FileHandle(forWritingTo: URL(fileURLWithPath: "/dev/null")) {
            p.standardOutput = null
            p.standardError = null
        }

        do {
            NSLog("ServerAutoLauncher: starting API from \(repo.path) using Node \(nodePath)")
            try p.run()
            child = p
            p.terminationHandler = { process in
                NSLog("ServerAutoLauncher: API process exited with status \(process.terminationStatus)")
            }
        } catch {
            NSLog("ServerAutoLauncher: failed to spawn API: \(error.localizedDescription)")
            return
        }

        await waitForReachable(client: client, state: state)
    }

    /// Starts the Docker container via `docker compose up -d`.
    private func ensureDockerRunning(client: OasisClient, state: AppState) async {
        guard let repo = RepoRoot.resolve(customPath: state.serverRepoRootPath) else {
            NSLog("ServerAutoLauncher: no oasis-echo checkout found for Docker; set Repository folder in Settings")
            return
        }

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
