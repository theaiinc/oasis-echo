import AVFoundation
import Foundation

// Converts arbitrary AVAudioPCMBuffer (hardware rate, stereo) into
// 16kHz mono Float32 data suitable for the server's /audio endpoint.
// We create the AVAudioConverter lazily on first buffer so we pick up
// the actual input format (not the format we guessed at init time).

final class AudioResampler {
    private var converter: AVAudioConverter?
    private var lastInputFormat: AVAudioFormat?
    let targetFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    func convert(_ input: AVAudioPCMBuffer) -> Data? {
        // (Re)build the converter if the source format changed.
        if converter == nil || input.format != lastInputFormat {
            guard let conv = AVAudioConverter(from: input.format, to: targetFormat) else {
                return nil
            }
            converter = conv
            lastInputFormat = input.format
        }
        guard let converter else { return nil }

        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return nil
        }

        var err: NSError?
        var suppliedInput = false
        converter.convert(to: out, error: &err) { _, status in
            if suppliedInput {
                status.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            status.pointee = .haveData
            return input
        }
        if err != nil { return nil }

        let n = Int(out.frameLength)
        guard n > 0, let ch = out.floatChannelData?[0] else { return nil }
        return Data(bytes: ch, count: n * MemoryLayout<Float32>.size)
    }
}
