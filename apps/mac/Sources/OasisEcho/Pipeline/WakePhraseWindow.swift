import Foundation

/// Which audio to recognize for the wake phrase, decided as samples arrive.
///
/// The detector used to recognize the moment its VAD fired — a few frames into the
/// phrase — and read the OLDEST 3 s of its 4 s ring buffer, so once the buffer was
/// full the window ended about a second before the speech that triggered it. Now,
/// once speech starts, it waits for the phrase to be said (until a short pause, at
/// most `maxPhraseSeconds`) and takes the newest audio from a little before the
/// speech started. Same design as the Windows port (apps/windows, WakeWordDetector.cs).
struct WakePhraseWindow {
    var sampleRate: Double
    /// Audio kept from before the VAD confirmed speech (it fires a few frames late).
    var preRollSeconds = 0.4
    /// Longest stretch recognized for the phrase.
    var maxPhraseSeconds = 3.0
    /// Quiet after speech that ends the phrase.
    var endQuietSeconds = 0.4

    /// Samples since the phrase started, or nil when not capturing one.
    private(set) var phraseSamples: Int?
    private var quietSamples = 0

    init(sampleRate: Double) { self.sampleRate = sampleRate }

    var isCapturing: Bool { phraseSamples != nil }

    /// The VAD confirmed speech: start a phrase.
    mutating func begin() {
        phraseSamples = 0
        quietSamples = 0
    }

    /// Feed one buffer (`count` samples, loud or not). Returns how many of the newest
    /// samples to recognize once the phrase has ended, else nil.
    mutating func push(count: Int, loud: Bool) -> Int? {
        guard var samples = phraseSamples else { return nil }
        samples += count
        quietSamples = loud ? 0 : quietSamples + count
        phraseSamples = samples
        let ended = Double(quietSamples) >= sampleRate * endQuietSeconds
        let tooLong = Double(samples) >= sampleRate * maxPhraseSeconds
        guard ended || tooLong else { return nil }
        phraseSamples = nil
        return samples + Int(sampleRate * preRollSeconds)
    }

    mutating func reset() {
        phraseSamples = nil
        quietSamples = 0
    }
}
