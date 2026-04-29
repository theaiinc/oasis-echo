import Foundation

// Mirrors packages/sdk/src/events.ts event payload shapes we actually consume.
// We only decode the fields we need; unknown fields are ignored.

struct SttPartialEvent: Decodable {
    let turnId: String?
    let text: String
}

struct SttFinalEvent: Decodable {
    let turnId: String?
    let text: String
}

struct SttPostprocessEvent: Decodable {
    let turnId: String?
    let original: String?
    let final: String
    let stages: [String]?
    let latencyMs: Double?
}

struct TtsChunkEvent: Decodable {
    let turnId: String
    let text: String
    let sampleRate: Int?
    let final: Bool?
    let filler: Bool?
    let audio: String?   // base64 PCM16 (little-endian)
}

struct EmotionDirectivesEvent: Decodable {
    struct Directives: Decodable {
        let playbackRate: Double?
        let gain: Double?
        let interChunkSilenceMs: Int?
        let pitchSemitones: Double?
    }
    let turnId: String?
    let detected: String?
    let effective: String?
    let strategy: String?
    let directives: Directives?
}

struct TurnCompleteEvent: Decodable {
    struct Turn: Decodable {
        let id: String
        let intent: String?
        let tier: String?
        let userText: String?
        let agentText: String?
    }
    let turn: Turn
}

struct ErrorEvent: Decodable {
    let message: String?
    let code: String?
}

struct TranscribeResponse: Decodable {
    let text: String
    let original: String?
    let stages: [String]?
    let latencyMs: Double?
    let totalMs: Double?
}

struct TurnRequestBody: Encodable {
    let text: String
    let emotion: EmotionPayload?
    struct EmotionPayload: Encodable {
        let label: String
        let confidence: Double
    }
}

struct CorrectionRequestBody: Encodable {
    let original: String
    let corrected: String
}

struct ConfigResponse: Decodable {
    let backend: String?
    let model: String?
    let session: String?
}
