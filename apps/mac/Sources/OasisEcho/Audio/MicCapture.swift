import AppKit
import AVFoundation
import Foundation

// Opens the default input, installs a tap at the hardware format, and
// forwards PCM buffers to a consumer. We keep the hardware sample rate
// and channel layout to avoid a format converter in the hot path —
// SFSpeechRecognizer accepts any format. Peak RMS is exposed so the
// pill waveform can animate off the live signal.

// AVAudioEngine.start() can return successfully with the tap installed
// even when the mic's TCC authorization is denied or was never asked —
// no exception, no audio, and macOS's mic-in-use indicator never lights
// up. Every caller here already wraps mic.start() in try/catch and
// surfaces the error, so throwing on anything short of `.authorized`
// turns that silent-record-nothing failure into a real, visible one.
enum MicCaptureError: LocalizedError {
    case accessDenied
    case accessNotDetermined

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "Microphone access is disabled for Oasis Echo. Enable it in System Settings › Privacy & Security › Microphone, then try again."
        case .accessNotDetermined:
            return "Microphone access hasn't been granted yet — check for a permission prompt, then try again."
        }
    }
}

final class MicCapture: @unchecked Sendable {
    private let engine: AVAudioEngine
    // When an external engine is supplied, its start/stop lifecycle belongs
    // to whoever else is using it (e.g. AudioPlayer, so its Voice-Processing
    // I/O has a live reference to cancel) — we only ever touch our own tap.
    private let ownsEngine: Bool
    private var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    private var onLevel: ((Float) -> Void)?
    private var isRunning = false

    var format: AVAudioFormat { engine.inputNode.outputFormat(forBus: 0) }

    /// For the menu bar's "Grant Microphone Access" item — true only once
    /// TCC has actually authorized the app, matching what mic.start() itself
    /// requires.
    static var isAuthorized: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    /// Requests access if the user has never been asked (shows the system
    /// prompt); otherwise — once denied, macOS won't show that prompt
    /// again — opens System Settings' Microphone privacy pane directly so
    /// they can flip it on themselves, mirroring Paster.openAccessibilitySettings().
    static func requestAccessOrOpenSettings() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
        default:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    init(engine: AVAudioEngine? = nil) {
        if let engine {
            self.engine = engine
            self.ownsEngine = false
        } else {
            self.engine = AVAudioEngine()
            self.ownsEngine = true
        }
    }

    func start(
        onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
        onLevel: @escaping (Float) -> Void
    ) throws {
        guard !isRunning else { return }
        try Self.ensureMicAuthorized()
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
        if ownsEngine {
            engine.prepare()
            try engine.start()
        } else if !engine.isRunning {
            // The shared engine (AudioPlayer owns its start/stop) can be
            // stopped here for reasons we don't control — its own
            // start() failed at launch (VPIO init error, see
            // TurnController.bootstrap), or a device/route change
            // stopped it after the fact with nothing listening to
            // restart it. Without this check, installing the tap above
            // still "succeeds" and isRunning below still flips true, so
            // beginCapture() proceeds, the pill shows .listening, and
            // no audio ever arrives — a permanently stuck indicator
            // with no error surfaced. Retry the start here so a real
            // failure throws and reaches beginCapture()'s catch, which
            // flashes a visible error instead.
            do {
                try engine.start()
            } catch {
                input.removeTap(onBus: 0)
                throw error
            }
        }
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        if ownsEngine {
            engine.stop()
        }
        isRunning = false
    }

    /// Throws unless the mic is already authorized. `.notDetermined` fires
    /// the system permission prompt in the background (requestAccess is
    /// completion-handler based; `start()` stays synchronous/throwing so
    /// every existing call site needs no changes) — the caller sees a clear
    /// "not granted yet" error on this attempt and the next mic.start()
    /// after the user responds will succeed on its own.
    private static func ensureMicAuthorized() throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            throw MicCaptureError.accessNotDetermined
        case .denied, .restricted:
            throw MicCaptureError.accessDenied
        @unknown default:
            throw MicCaptureError.accessDenied
        }
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
