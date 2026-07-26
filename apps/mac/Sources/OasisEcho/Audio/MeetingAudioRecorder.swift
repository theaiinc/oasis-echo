import AVFoundation
import Foundation

/// Writes the meeting microphone stream to a local CAF file. CAF is used
/// because it preserves whatever hardware sample rate/channel layout macOS
/// provides without an extra conversion in the audio callback.
final class MeetingAudioRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private(set) var url: URL?

    func start(url: URL, format: AVAudioFormat) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        lock.lock()
        defer { lock.unlock() }
        file = try AVAudioFile(forWriting: url, settings: format.settings)
        self.url = url
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try file?.write(from: buffer)
        } catch {
            NSLog("meeting audio write failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        lock.lock()
        file = nil
        lock.unlock()
    }
}
