import AVFoundation
import Foundation
import os

// Streaming PCM16 player for Kokoro tts.chunk + /backchannel clips.
// Buffers arrive as base64-encoded little-endian Int16 at a given sample
// rate; we convert to Float32 and schedule on an AVAudioPlayerNode.
//
// Two gotchas that were actually breaking audio before:
//   1. Connecting a player to the mixer with `format: nil` is valid
//      only if the player has a buffer staged at connect-time. Fresh
//      node → invalid graph → `engine.start()` throws. With
//      `try? prepare()` that error was silently swallowed. We now
//      connect with an explicit format so the graph is always valid.
//   2. AVAudioEngine gracefully resamples between nodes with different
//      formats, so a 16 kHz backchannel and a 24 kHz TTS chunk both
//      play through the same 24 kHz connection without additional work.

final class AudioPlayer: @unchecked Sendable {
    private let log = Logger(subsystem: "ai.oasis.echo.mac", category: "audio")
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var started = false
    private var currentRate: Float = 1.0
    private var currentGain: Float = 1.0

    // Tracks how much audio is still scheduled but not yet finished
    // playing back. When `inFlight` hits zero AFTER at least one buffer
    // has been enqueued, we fire `onQueueDrained` on the main queue so
    // the controller can transition state.pill out of `.speaking`. This
    // is what keeps the orb animating for the full duration of Echo's
    // reply — turn.complete arrives well before Kokoro's audio queue
    // has actually played out.
    private let lock = NSLock()
    private var inFlight: Int = 0
    var onQueueDrained: (@Sendable () -> Void)?

    var isQueueIdle: Bool {
        lock.lock(); defer { lock.unlock() }
        return inFlight == 0
    }

    // Kokoro emits 24 kHz mono; we lock the player→mixer edge to this.
    // Sources with different rates get resampled by AVAudioEngine.
    private let playerFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24_000,
        channels: 1,
        interleaved: false
    )!

    func prepare() throws {
        guard !started else { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playerFormat)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            log.error("AVAudioEngine.start failed: \(String(describing: error), privacy: .public)")
            throw error
        }
        player.play()
        started = true
        log.info("AudioPlayer ready (output=\(self.engine.outputNode.outputFormat(forBus: 0).sampleRate, privacy: .public) Hz)")
    }

    func applyDirectives(rate: Double?, gainDb: Double?) {
        if let r = rate { currentRate = Float(max(0.5, min(2.0, r))) }
        if let g = gainDb {
            let clamped = max(-6.0, min(6.0, g))
            currentGain = Float(pow(10.0, clamped / 20.0))
            engine.mainMixerNode.outputVolume = currentGain
        }
    }

    func enqueue(pcm16: Data, sampleRate: Int, final: Bool) {
        if !started {
            do { try prepare() }
            catch {
                log.error("enqueue: prepare failed, dropping chunk (\(pcm16.count, privacy: .public) bytes)")
                return
            }
        }
        guard let buffer = Self.makeBuffer(pcm16: pcm16, sampleRate: sampleRate) else {
            log.error("enqueue: makeBuffer returned nil (bytes=\(pcm16.count, privacy: .public), sr=\(sampleRate, privacy: .public))")
            return
        }
        lock.lock(); inFlight += 1; lock.unlock()
        // .dataPlayedBack fires when this buffer's last sample has been
        // rendered to the output device, NOT when it was handed off to
        // the audio thread. That's what we need — "audio actually
        // finished" semantics, not "audio was scheduled".
        player.scheduleBuffer(
            buffer,
            at: nil,
            options: [],
            completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.inFlight -= 1
            let drained = (self.inFlight == 0)
            self.lock.unlock()
            if drained {
                let cb = self.onQueueDrained
                DispatchQueue.main.async { cb?() }
            }
        }
        log.debug("enqueued \(buffer.frameLength, privacy: .public) frames @ \(sampleRate, privacy: .public) Hz, inFlight=\(self.inFlight, privacy: .public)")
    }

    /// Cancel everything and reset the inFlight counter. Call when the
    /// user starts a new turn before the previous audio has finished
    /// (otherwise the new turn's drain callback would be polluted by
    /// counters from the prior turn).
    func resetQueue() {
        player.stop()
        lock.lock(); inFlight = 0; lock.unlock()
        if started { player.play() }
    }

    func stop() {
        player.stop()
        engine.stop()
        started = false
    }

    private static func makeBuffer(pcm16: Data, sampleRate: Int) -> AVAudioPCMBuffer? {
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: Double(sampleRate),
                                      channels: 1,
                                      interleaved: false) else { return nil }
        let frameCount = UInt32(pcm16.count / MemoryLayout<Int16>.size)
        guard frameCount > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frameCount) else { return nil }
        buf.frameLength = frameCount
        guard let dst = buf.floatChannelData?[0] else { return nil }
        pcm16.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<Int(frameCount) {
                dst[i] = Float(src[i]) / 32768.0
            }
        }
        return buf
    }
}
