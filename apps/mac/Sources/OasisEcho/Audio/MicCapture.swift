import AVFoundation
import Foundation

// Opens the default input, installs a tap at the hardware format, and
// forwards PCM buffers to a consumer. We keep the hardware sample rate
// and channel layout to avoid a format converter in the hot path —
// SFSpeechRecognizer accepts any format. Peak RMS is exposed so the
// pill waveform can animate off the live signal.

final class MicCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    private var onLevel: ((Float) -> Void)?
    private var isRunning = false

    var format: AVAudioFormat { engine.inputNode.outputFormat(forBus: 0) }

    func start(
        onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
        onLevel: @escaping (Float) -> Void
    ) throws {
        guard !isRunning else { return }
        self.onBuffer = onBuffer
        self.onLevel = onLevel

        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in
            guard let self else { return }
            self.onBuffer?(buf)
            if let level = Self.rms(buf) { self.onLevel?(level) }
        }
        engine.prepare()
        try engine.start()
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
    }

    private static func rms(_ buf: AVAudioPCMBuffer) -> Float? {
        guard let channelData = buf.floatChannelData else { return nil }
        let n = Int(buf.frameLength)
        guard n > 0 else { return 0 }
        let ptr = channelData[0]
        var sum: Float = 0
        for i in 0..<n { let s = ptr[i]; sum += s * s }
        let rms = sqrt(sum / Float(n))
        // Loose dB-ish normalization: -60 dBFS..0 dBFS → 0..1.
        let db = 20 * log10(max(rms, 1e-6))
        let norm = (db + 60) / 60
        return max(0, min(1, norm))
    }
}
