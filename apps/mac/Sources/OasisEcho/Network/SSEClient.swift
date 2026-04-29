import Foundation

// Minimal SSE parser + streaming URLSession client.
// Emits decoded event name + raw JSON payload string.

actor SSEClient {
    struct Event { let name: String; let data: String }

    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var buffer = Data()
    private var pendingEvent = "message"
    private var pendingData = ""
    private var onEvent: (@Sendable (Event) -> Void)?
    private var onError: (@Sendable (Error) -> Void)?

    func connect(
        url: URL,
        onEvent: @Sendable @escaping (Event) -> Void,
        onError: @Sendable @escaping (Error) -> Void
    ) {
        disconnect()
        self.onEvent = onEvent
        self.onError = onError

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 0
        config.timeoutIntervalForResource = 0
        config.httpAdditionalHeaders = ["Accept": "text/event-stream"]
        let delegate = SSEDelegate(owner: self)
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        self.session = session

        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: req)
        self.task = task
        task.resume()
    }

    func disconnect() {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        buffer.removeAll()
        pendingEvent = "message"
        pendingData = ""
    }

    func feed(_ data: Data) {
        buffer.append(data)
        while let lineEnd = buffer.firstIndex(of: 0x0A) { // '\n'
            let lineData = buffer[..<lineEnd]
            let line = String(data: Data(lineData), encoding: .utf8) ?? ""
            buffer.removeSubrange(...lineEnd)
            processLine(line.trimmingCharacters(in: ["\r"]))
        }
    }

    func fail(_ error: Error) {
        onError?(error)
    }

    private func processLine(_ line: String) {
        if line.isEmpty {
            if !pendingData.isEmpty {
                onEvent?(Event(name: pendingEvent, data: pendingData))
            }
            pendingEvent = "message"
            pendingData = ""
            return
        }
        if line.hasPrefix(":") { return } // comment / heartbeat
        if let colon = line.firstIndex(of: ":") {
            let field = String(line[..<colon])
            var value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
            switch field {
            case "event": pendingEvent = value
            case "data":
                if !pendingData.isEmpty { pendingData.append("\n") }
                pendingData.append(value)
            default: break // id, retry — unused
            }
        }
    }
}

final class SSEDelegate: NSObject, URLSessionDataDelegate {
    private weak var owner: SSEClient?
    init(owner: SSEClient) { self.owner = owner }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let snap = data
        Task { await owner?.feed(snap) }
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, (error as NSError).code != NSURLErrorCancelled {
            Task { await owner?.fail(error) }
        }
    }
}
