import AVFoundation
import Foundation

// Uniform interface over Apple Speech, server-side Whisper, or any
// future on-device model. TurnController depends on this protocol only.

protocol STTEngine: AnyObject {
    func start(
        onPartial: @escaping @Sendable (String) -> Void,
        onFinal: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) throws
    func append(_ buffer: AVAudioPCMBuffer)
    func finish()
    func cancel()
}

enum STTEngineKind: String, CaseIterable, Codable {
    case appleSpeech = "apple"
    case serverWhisper = "server"
    var label: String {
        switch self {
        case .appleSpeech: "Apple Speech (on-device)"
        case .serverWhisper: "Oasis Echo Whisper (server)"
        }
    }
}
