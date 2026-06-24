import AVFoundation
import Foundation

// Keeps a SINGLE WebSocket to the server's /audio endpoint open for
// the app's entire lifetime. Each `start(...)` opens a turn on that
// socket via `{type:"start"}` and `finish()` closes it with
// `{type:"end"}`. The server's WhisperStreamingStt is designed to be
// reset() + reused between turns — creating a new one per capture
// races ONNX Runtime and can SIGABRT the server.
//
// Auto-reconnects with a small backoff if the socket drops.

final class ServerSTTEngine: STTEngine, @unchecked Sendable {

    enum WSState { case disconnected, connecting, idle, active, finishing }

    private var baseURL: URL
    private let resampler = AudioResampler()
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var state: WSState = .disconnected
    private var pendingBuffers: [Data] = []
    private var reconnectWork: DispatchWorkItem?
    private var currentUtteranceID: String?
    private var finishingUtteranceID: String?

    private var onPartial: (@Sendable (String) -> Void)?
    private var onFinal: (@Sendable (String) -> Void)?
    private var onError: (@Sendable (Error) -> Void)?

    private let queue = DispatchQueue(label: "oasis.echo.server-stt")

    init(serverBaseURL: URL) {
        self.baseURL = serverBaseURL
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
        connect()
    }

    // MARK: - STTEngine

    func start(
        onPartial: @escaping @Sendable (String) -> Void,
        onFinal: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) throws {
        self.onPartial = onPartial
        self.onFinal = onFinal
        self.onError = onError
        let utteranceID = UUID().uuidString
        queue.async { [weak self] in
            guard let self else { return }
            if state == .disconnected { self.connect() }
            state = .active
            currentUtteranceID = utteranceID
            finishingUtteranceID = nil
            self.sendControl(["type": "start", "utteranceId": utteranceID])
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let pcm = resampler.convert(buffer) else { return }
        queue.async { [weak self] in
            guard let self else { return }
            switch state {
            case .active, .idle:
                self.sendBinary(pcm)
            case .connecting, .disconnected:
                self.pendingBuffers.append(pcm)
                if self.pendingBuffers.count > 200 {
                    self.pendingBuffers.removeFirst(self.pendingBuffers.count - 200)
                }
            case .finishing: break
            }
        }
    }

    func finish() {
        queue.async { [weak self] in
            guard let self, state == .active else { return }
            let utteranceID = currentUtteranceID
            state = .finishing
            finishingUtteranceID = utteranceID
            var payload: [String: Any] = ["type": "end"]
            if let utteranceID { payload["utteranceId"] = utteranceID }
            self.sendControl(payload)
        }
    }

    func cancel() {
        queue.async { [weak self] in
            guard let self else { return }
            if state == .active || state == .finishing {
                var payload: [String: Any] = ["type": "abort"]
                if let utteranceID = finishingUtteranceID ?? currentUtteranceID {
                    payload["utteranceId"] = utteranceID
                }
                self.sendControl(payload)
                state = .idle
                currentUtteranceID = nil
                finishingUtteranceID = nil
            }
        }
    }

    // Clean shutdown — call on app teardown.
    func shutdown() {
        reconnectWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
    }

    /// Reconnect the audio WebSocket when the HTTP base URL changes (e.g.
    /// ephemeral port discovery or Settings edit).
    func updateServerBase(_ url: URL) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.baseURL.absoluteString != url.absoluteString else { return }
            self.baseURL = url
            self.reconnectWork?.cancel()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.pendingBuffers.removeAll()
            self.state = .disconnected
            self.connect()
        }
    }

    // MARK: - WebSocket lifecycle

    private func connect() {
        guard state == .disconnected else { return }
        state = .connecting
        let url = Self.audioURL(fromBase: baseURL)
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        let t = session.webSocketTask(with: req)
        self.task = t
        t.resume()
        receive()
    }

    private func scheduleReconnect(after seconds: Double) {
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.state = .disconnected
            self.connect()
        }
        reconnectWork = work
        queue.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                let e = err as NSError
                if e.code != NSURLErrorCancelled { self.onError?(err) }
                self.queue.async {
                    self.state = .disconnected
                    self.scheduleReconnect(after: 1.5)
                }
            case .success(let msg):
                switch msg {
                case .string(let s): self.handleText(s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) { self.handleText(s) }
                @unknown default: break
                }
                self.receive()
            }
        }
    }

    private func handleText(_ s: String) {
        guard let data = s.data(using: .utf8) else { return }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "ready":
            queue.async { [weak self] in
                guard let self else { return }
                // `ready` comes back after each `{type:"start"}`. If a
                // capture is already active, flush any buffered frames.
                if state == .connecting || state == .disconnected { state = .idle }
                for chunk in self.pendingBuffers { self.sendBinary(chunk) }
                self.pendingBuffers.removeAll()
            }
        case "stt.partial":
            guard let t = obj["text"] as? String, !t.isEmpty else { return }
            let utteranceID = obj["utteranceId"] as? String
            queue.async { [weak self] in
                guard let self, self.acceptsSTTMessage(utteranceID, final: false) else { return }
                self.onPartial?(t)
            }
        case "stt.final":
            let t = (obj["text"] as? String) ?? ""
            let utteranceID = obj["utteranceId"] as? String
            queue.async { [weak self] in
                guard let self, self.acceptsSTTMessage(utteranceID, final: true) else { return }
                self.onFinal?(t)
                self.state = .idle
                self.currentUtteranceID = nil
                self.finishingUtteranceID = nil
            }
        default: break
        }
    }

    private func acceptsSTTMessage(_ utteranceID: String?, final: Bool) -> Bool {
        if let utteranceID {
            return utteranceID == currentUtteranceID || utteranceID == finishingUtteranceID
        }
        // Backward compatibility for older servers that do not echo IDs:
        // accept only messages that match the local lifecycle phase.
        return final ? state == .finishing : state == .active
    }

    private func sendControl(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let s = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(s)) { [weak self] err in
            if let err { self?.onError?(err) }
        }
    }

    private func sendBinary(_ data: Data) {
        task?.send(.data(data)) { [weak self] err in
            if let err { self?.onError?(err) }
        }
    }

    // http(s)://host:port/ → ws(s)://host:port/audio
    private static func audioURL(fromBase base: URL) -> URL {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        switch comps.scheme {
        case "https": comps.scheme = "wss"
        default:      comps.scheme = "ws"
        }
        comps.path = "/audio"
        return comps.url ?? base
    }
}
