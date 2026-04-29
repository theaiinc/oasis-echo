import Foundation
import Speech
import AVFoundation

// On-device streaming dictation via SFSpeechRecognizer.
// `requiresOnDeviceRecognition = true` forces offline mode on supported
// macOS versions — audio never leaves the Mac. Results stream in as
// partials; the final hypothesis fires when we stop the request.

final class SpeechTranscriber: STTEngine, @unchecked Sendable {
    enum TranscribeError: LocalizedError {
        case notAuthorized, unavailable, failed(String)
        var errorDescription: String? {
            switch self {
            case .notAuthorized: "Speech recognition not authorized"
            case .unavailable:   "Speech recognizer unavailable for this locale"
            case .failed(let m): m
            }
        }
    }

    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var onPartial: ((String) -> Void)?
    private var onFinal: ((String) -> Void)?
    private var onError: ((Error) -> Void)?

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: .init(identifier: "en-US"))
    }

    static func requestAuthorization() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { status in
                c.resume(returning: status == .authorized)
            }
        }
    }

    func start(
        onPartial: @escaping @Sendable (String) -> Void,
        onFinal: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) throws {
        // Lazy authorization: only trip TCC when we're actually about
        // to use Apple Speech. If the user is on the server-Whisper
        // path they never hit this code, so the entitlement is never
        // requested at all.
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in }
        }
        guard let recognizer, recognizer.isAvailable else { throw TranscribeError.unavailable }
        self.onPartial = onPartial
        self.onFinal = onFinal
        self.onError = onError

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        req.taskHint = .dictation
        self.request = req

        self.task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let error = error {
                let ns = error as NSError
                // 1110 = "No speech detected" after a silent stop — benign.
                if ns.domain != "kAFAssistantErrorDomain" || ns.code != 1110 {
                    self.onError?(error)
                }
                return
            }
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            if result.isFinal {
                self.onFinal?(text)
            } else {
                self.onPartial?(text)
            }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        request?.append(buffer)
    }

    func finish() {
        request?.endAudio()
        request = nil
        // Task continues until final result fires, then auto-completes.
    }

    func cancel() {
        task?.cancel()
        task = nil
        request = nil
    }
}
