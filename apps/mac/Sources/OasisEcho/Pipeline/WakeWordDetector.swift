import Foundation
import AVFoundation
import Speech
import os.log

/// "Hey Echo" wake-word detector using VAD-triggered one-shot recognition.
///
/// Keeps a lightweight audio-energy monitor running. When speech is
/// detected, captures ~2.5 s of audio and runs a focused recognition
/// pass looking for the activation phrase.
final class WakeWordDetector: @unchecked Sendable {
    private let log = Logger(subsystem: "ai.oasis.echo.mac", category: "wakeword")
    private let engine = AVAudioEngine()
    private var hardwareRate: Double = 48000
    /// Ring buffer big enough for ~4 s at the hardware rate.
    private var buffer: RingBuffer?
    private var vadThreshold: Float = 0.018
    private var loudFrames = 0
    private let vadConfirmCount = 3
    private var captureDuration: Double = 3.0
    private var isActive = false
    private var recognizing = false
    private var cooldownUntil: Date = .distantPast
    private let cooldownInterval: TimeInterval = 3.0
    private let recognizer: SFSpeechRecognizer?

    var onWakeWordDetected: (() -> Void)?

    init() {
        self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    @MainActor
    static func requestAuthorization() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            return await withCheckedContinuation { c in
                SFSpeechRecognizer.requestAuthorization { s in
                    c.resume(returning: s == .authorized)
                }
            }
        }
        return status == .authorized
    }

    @MainActor
    func start() throws {
        guard !isActive else { return }
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "WakeWordDetector", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Recognizer unavailable"])
        }

        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        hardwareRate = fmt.sampleRate
        let bufferCapacity = Int(hardwareRate * 4.0)
        buffer = RingBuffer(capacity: bufferCapacity)
        log.notice("hw rate: \(fmt.sampleRate) Hz, ring: \(bufferCapacity)")

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in
            self?.processAudio(buf)
        }

        engine.prepare()
        try engine.start()
        isActive = true
        log.notice("started")
    }

    func pause() {
        guard isActive else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        buffer?.clear()
        loudFrames = 0
        recognizing = false
        log.notice("paused")
    }

    func resume() {
        guard isActive else { return }
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in
            self?.processAudio(buf)
        }
        engine.prepare()
        do {
            try engine.start()
            log.notice("resumed")
        } catch {
            log.error("resume failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        guard isActive else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        buffer?.clear()
        buffer = nil
        isActive = false
        recognizing = false
        log.notice("stopped")
    }

    var isRunning: Bool { isActive }

    // MARK: - Audio processing

    private func processAudio(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData?[0] else { return }
        let n = Int(buf.frameLength)
        guard n > 0 else { return }

        var sum: Float = 0
        for i in 0..<n { let s = ch[i]; sum += s * s }
        let rms = sqrt(sum / Float(n))

        let wasSilent = self.loudFrames == 0
        if rms > self.vadThreshold {
            if wasSilent { log.debug("vad trigger: rms=\(rms)") }
            self.loudFrames += 1
        } else {
            if self.loudFrames > 0 { log.debug("vad reset: rms=\(rms) after \(self.loudFrames) loud") }
            self.loudFrames = 0
        }

        self.buffer?.append(ch, count: n)

        if self.loudFrames >= self.vadConfirmCount, !self.recognizing, Date() >= self.cooldownUntil {
            log.notice("vad fired: \(self.loudFrames) frames above threshold")
            self.loudFrames = 0
            startRecognition()
        }
    }

    // MARK: - Recognition

    private func startRecognition() {
        recognizing = true
        let frameCount = Int(hardwareRate * captureDuration)
        let avail = buffer?.count ?? 0
        let frames = min(frameCount, avail)
        guard Double(frames) > hardwareRate * 0.3 else {
            log.debug("too little audio: \(frames) frames")
            recognizing = false
            return
        }

        guard let pcmBuf = AVAudioPCMBuffer(
            pcmFormat: AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: hardwareRate,
                channels: 1,
                interleaved: false
            )!,
            frameCapacity: AVAudioFrameCount(frames)
        ) else { recognizing = false; return }
        pcmBuf.frameLength = AVAudioFrameCount(frames)
        buffer?.read(into: pcmBuf.floatChannelData![0], count: frames)

        log.notice("recognition pass: \(frames) frames at \(Int(self.hardwareRate)) Hz = \(String(format: "%.1f", Double(frames) / self.hardwareRate)) s")

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = false
        req.taskHint = .search
        req.contextualStrings = ["hey echo", "hey echo oasis", "echo oasis"]
        req.append(pcmBuf)
        req.endAudio()

        recognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            defer { self.recognizing = false }

            if let error = error {
                let ns = error as NSError
                if ns.domain != "kAFAssistantErrorDomain" || ns.code != 1110 {
                    self.log.error("recognition error: \(error.localizedDescription) (\(ns.domain) / \(ns.code))")
                } else {
                    self.log.debug("recognition: no speech (1110)")
                }
                return
            }
            guard let result, result.isFinal else {
                self.log.debug("recognition: non-final or nil result")
                return
            }
            let text = result.bestTranscription.formattedString
            let confidence = result.bestTranscription.segments.reduce(0.0) { $0 + Double($1.confidence) } / max(1.0, Double(result.bestTranscription.segments.count))
            self.log.notice("recognized: '\(text)' (confidence: \(String(format: "%.2f", confidence)))")
            self.checkWakeWord(result)
        }
    }

    private func checkWakeWord(_ result: SFSpeechRecognitionResult) {
        let text = result.bestTranscription.formattedString
        let lowered = text.lowercased().trimmingCharacters(in: .whitespaces)
        guard !lowered.isEmpty else { return }

        let wakePatterns: [String] = [
            "hey echo",
            "hey, echo",
            "hey echo oasis",
            "hey ecko",
            "hay echo",
            "he echo",
            "the echo",
            "a echo",
            "he ecko",
        ]

        let matches = wakePatterns.contains { lowered.contains($0) }
        if matches {
            cooldownUntil = Date().addingTimeInterval(cooldownInterval)
            log.notice("✅ DETECTED: '\(text)'")
            DispatchQueue.main.async { [weak self] in
                self?.onWakeWordDetected?()
            }
        } else {
            log.notice("no match: '\(lowered)'")
            for s in result.bestTranscription.segments {
                log.debug("  segment: '\(s.substring)' conf=\(s.confidence)")
            }
        }
    }
}

// MARK: - Ring buffer (mono float32)

private final class RingBuffer {
    private let buf: UnsafeMutablePointer<Float>
    private let capacity: Int
    private var head = 0
    private(set) var count = 0

    init(capacity: Int) {
        self.capacity = capacity
        buf = .allocate(capacity: capacity)
    }

    deinit { buf.deallocate() }

    func append(_ data: UnsafePointer<Float>, count n: Int) {
        for i in 0..<n {
            buf[head] = data[i]
            head = (head + 1) % capacity
        }
        count = min(count + n, capacity)
    }

    func read(into dest: UnsafeMutablePointer<Float>, count n: Int) {
        let r = min(n, count)
        let start = (head - count + capacity) % capacity
        for i in 0..<r {
            dest[i] = buf[(start + i) % capacity]
        }
    }

    func clear() { count = 0; head = 0 }
}
