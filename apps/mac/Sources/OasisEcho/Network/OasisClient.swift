import Foundation

// HTTP + SSE client against the oasis-echo server (packages/app).
// Keep this thin: higher layers interpret events and issue turn calls.

actor OasisClient {
    struct ServerError: LocalizedError {
        let status: Int; let body: String
        var errorDescription: String? { "server \(status): \(body)" }
    }

    private var baseURL: URL
    private let sse = SSEClient()
    private var session: URLSession
    // Separate session for long-running operations (meeting note
    // generation can take 30s+ when the reasoner streams a full
    // markdown document end-to-end).
    private var longSession: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        self.session = URLSession(configuration: c)
        let lc = URLSessionConfiguration.default
        lc.timeoutIntervalForRequest = 120
        lc.timeoutIntervalForResource = 180
        lc.waitsForConnectivity = false
        self.longSession = URLSession(configuration: lc)
    }

    func updateBase(_ url: URL) { self.baseURL = url }

    // MARK: - HTTP calls

    func ping() async -> ConfigResponse? {
        do {
            let (data, resp) = try await session.data(from: baseURL.appending(path: "/config"))
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(ConfigResponse.self, from: data)
        } catch { return nil }
    }

    func transcribe(_ rawText: String) async throws -> TranscribeResponse {
        var req = URLRequest(url: baseURL.appending(path: "/transcribe"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": rawText])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ServerError(status: 0, body: "no response")
        }
        if http.statusCode != 200 {
            throw ServerError(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(TranscribeResponse.self, from: data)
    }

    func sendTurn(text: String, emotionLabel: String? = nil, emotionConfidence: Double? = nil) async throws {
        var req = URLRequest(url: baseURL.appending(path: "/turn"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["text": text]
        if let label = emotionLabel {
            body["emotion"] = [
                "label": label,
                "confidence": emotionConfidence ?? 0.5
            ]
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw ServerError(status: http.statusCode, body: "")
        }
    }

    // Pre-synthesized Kokoro acknowledgement ("uh huh", "yeah", etc.)
    // GET /backchannel returns a random short clip the client can play
    // while the reasoner is still thinking — same technique the web app
    // uses to avoid dead-air on slow backends.
    struct BackchannelClip: Decodable { let audio: String; let sampleRate: Int }
    func backchannel() async -> BackchannelClip? {
        do {
            let (data, resp) = try await session.data(from: baseURL.appending(path: "/backchannel"))
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(BackchannelClip.self, from: data)
        } catch { return nil }
    }

    // MARK: - Meeting notes

    func generateMeetingNotes(
        transcript: [MeetingSegment],
        userNotes: String,
        startedAt: Int64
    ) async throws -> MeetingNotesResponse {
        var req = URLRequest(url: baseURL.appending(path: "/meeting/notes"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        req.httpBody = try JSONEncoder().encode(MeetingNotesRequestBody(
            transcript: transcript,
            userNotes: userNotes,
            startedAt: startedAt
        ))
        let (data, resp) = try await longSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ServerError(status: 0, body: "no response")
        }
        if http.statusCode != 200 {
            throw ServerError(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(MeetingNotesResponse.self, from: data)
    }

    func listMeetings() async throws -> [MeetingListItem] {
        let (data, resp) = try await session.data(from: baseURL.appending(path: "/meetings"))
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw ServerError(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: "")
        }
        return try JSONDecoder().decode(MeetingListResponse.self, from: data).meetings
    }

    func getMeeting(id: String) async throws -> MeetingDetail {
        let (data, resp) = try await session.data(from: baseURL.appending(path: "/meeting/\(id)"))
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw ServerError(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: "")
        }
        return try JSONDecoder().decode(MeetingDetail.self, from: data)
    }

    func learnCorrection(original: String, corrected: String) async throws {
        var req = URLRequest(url: baseURL.appending(path: "/correction"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(CorrectionRequestBody(original: original, corrected: corrected))
        _ = try await session.data(for: req)
    }

    // MARK: - SSE

    func openEventStream(
        onEvent: @Sendable @escaping (SSEClient.Event) -> Void,
        onError: @Sendable @escaping (Error) -> Void
    ) async {
        let url = baseURL.appending(path: "/events")
        await sse.connect(url: url, onEvent: onEvent, onError: onError)
    }

    func closeEventStream() async {
        await sse.disconnect()
    }
}

