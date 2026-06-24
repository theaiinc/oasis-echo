import Foundation

/// Assembles rolling-buffer STT hypotheses into one user-visible turn.
///
/// Server Whisper/FunASR repeatedly re-transcribe the current audio window,
/// so a later partial/final can be a replacement for the earlier tail rather
/// than text that should be appended. The merge below keeps true continuations
/// while letting later overlapping hypotheses rewrite the unstable suffix.
struct TranscriptAssembler {
    private var committedTranscript = ""
    private var pendingHypothesis = ""

    var text: String {
        Self.join(committedTranscript, pendingHypothesis)
    }

    mutating func reset() {
        committedTranscript = ""
        pendingHypothesis = ""
    }

    mutating func ingestPartial(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        guard !pendingHypothesis.isEmpty else {
            pendingHypothesis = trimmed
            return
        }

        let merged = Self.merge(pendingHypothesis, with: trimmed)
        if merged.kind == .appended {
            commitPending()
            pendingHypothesis = trimmed
        } else {
            pendingHypothesis = merged.text
        }
    }

    mutating func ingestFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        commitPending()
        committedTranscript = Self.merge(committedTranscript, with: trimmed).text
    }

    mutating func commitPending() {
        let part = pendingHypothesis.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !part.isEmpty else { return }
        committedTranscript = Self.merge(committedTranscript, with: part).text
        pendingHypothesis = ""
    }

    static func mergeTranscript(_ existing: String, with next: String) -> String {
        merge(existing, with: next).text
    }

    private enum MergeKind {
        case unchanged
        case replaced
        case overlapped
        case appended
    }

    private struct MergeResult {
        let text: String
        let kind: MergeKind
    }

    private struct Token {
        let raw: String
        let keys: [String]
    }

    private struct Overlap {
        let existingStart: Int
        let nextDropCount: Int
        let score: Double
        let matches: Int
        let nextCoverage: Double
    }

    private static func merge(_ existing: String, with next: String) -> MergeResult {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextTrimmed = next.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !existingTrimmed.isEmpty else { return .init(text: nextTrimmed, kind: .replaced) }
        guard !nextTrimmed.isEmpty else { return .init(text: existingTrimmed, kind: .unchanged) }

        let existingTokens = tokenize(existingTrimmed)
        let nextTokens = tokenize(nextTrimmed)
        let existingKeys = existingTokens.flatMap(\.keys)
        let nextKeys = nextTokens.flatMap(\.keys)

        if existingKeys == nextKeys || containsSequence(existingKeys, nextKeys) {
            return .init(text: existingTrimmed, kind: .unchanged)
        }
        if containsSequence(nextKeys, existingKeys) {
            return .init(text: nextTrimmed, kind: .replaced)
        }

        if let overlap = bestOverlap(existingTokens: existingTokens, nextTokens: nextTokens) {
            let existingStart = adjustedStartForOrphanPronoun(
                overlap.existingStart,
                existingTokens: existingTokens,
                nextTokens: nextTokens
            )
            let prefix = existingTokens.prefix(existingStart).map(\.raw).joined(separator: " ")
            let suffix = nextTokens.dropFirst(overlap.nextDropCount).map(\.raw).joined(separator: " ")
            let merged = join(prefix, suffix)
            if !merged.isEmpty {
                return .init(text: merged, kind: .overlapped)
            }
        }

        return .init(text: join(existingTrimmed, nextTrimmed), kind: .appended)
    }

    private static func adjustedStartForOrphanPronoun(
        _ start: Int,
        existingTokens: [Token],
        nextTokens: [Token]
    ) -> Int {
        guard start > 0 else { return start }
        let previousKeys = existingTokens[start - 1].keys
        guard previousKeys.count == 1, let previous = previousKeys.first else { return start }
        let pronouns = Set(["i", "you", "we", "they", "it", "that", "there"])
        guard pronouns.contains(previous) else { return start }
        let nextLeadKeys = nextTokens.prefix(3).flatMap(\.keys)
        return nextLeadKeys.contains(previous) ? start - 1 : start
    }

    private static func bestOverlap(existingTokens: [Token], nextTokens: [Token]) -> Overlap? {
        guard !existingTokens.isEmpty, !nextTokens.isEmpty else { return nil }

        var best: Overlap?
        for start in existingTokens.indices {
            let existingTail = Array(existingTokens[start...].flatMap(\.keys))
            guard !existingTail.isEmpty else { continue }

            let maxNextWords = min(nextTokens.count, max(existingTokens.count - start + 3, 1))
            for nextCount in 1...maxNextWords {
                let nextPrefix = Array(nextTokens.prefix(nextCount).flatMap(\.keys))
                guard !nextPrefix.isEmpty else { continue }

                let matches = lcsLength(existingTail, nextPrefix)
                guard matches > 0 else { continue }

                let exactPrefix = existingTail.suffix(matches) == nextPrefix.prefix(matches)
                let minLength = min(existingTail.count, nextPrefix.count)
                let maxLength = max(existingTail.count, nextPrefix.count)
                let score = Double(matches) / Double(maxLength)
                let coverage = Double(matches) / Double(minLength)
                let nextCoverage = Double(matches) / Double(nextPrefix.count)

                let accepted: Bool
                if exactPrefix {
                    accepted = matches >= min(2, minLength)
                } else if matches >= 4 {
                    accepted = coverage >= 0.55 && score >= 0.45
                } else {
                    accepted = matches >= 3 && coverage >= 0.60 && score >= 0.50
                }
                guard accepted else { continue }

                let candidate = Overlap(
                    existingStart: start,
                    nextDropCount: 0,
                    score: score,
                    matches: matches,
                    nextCoverage: nextCoverage
                )
                if isBetter(candidate, than: best) {
                    best = candidate
                }
            }
        }
        return best
    }

    private static func isBetter(_ candidate: Overlap, than current: Overlap?) -> Bool {
        guard let current else { return true }
        if candidate.matches != current.matches {
            return candidate.matches > current.matches
        }
        if abs(candidate.score - current.score) > 0.001 {
            return candidate.score > current.score
        }
        if abs(candidate.nextCoverage - current.nextCoverage) > 0.001 {
            return candidate.nextCoverage > current.nextCoverage
        }
        return candidate.existingStart < current.existingStart
    }

    private static func containsSequence(_ haystack: [String], _ needle: [String]) -> Bool {
        guard !needle.isEmpty, needle.count <= haystack.count else { return false }
        if needle.count == haystack.count { return haystack == needle }
        for start in 0...(haystack.count - needle.count) {
            if Array(haystack[start..<(start + needle.count)]) == needle {
                return true
            }
        }
        return false
    }

    private static func tokenize(_ text: String) -> [Token] {
        text.split(whereSeparator: { $0.isWhitespace }).map { part in
            let raw = String(part)
            return Token(raw: raw, keys: normalizedKeys(raw))
        }.filter { !$0.keys.isEmpty }
    }

    private static func normalizedKeys(_ raw: String) -> [String] {
        let lower = raw.lowercased()
        let stripped = lower.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "'" ? Character(scalar) : " "
        }
        let normalized = String(stripped)
            .replacingOccurrences(of: "i'm", with: "i am")
            .replacingOccurrences(of: "you're", with: "you are")
            .replacingOccurrences(of: "we're", with: "we are")
            .replacingOccurrences(of: "they're", with: "they are")
            .replacingOccurrences(of: "it's", with: "it is")
            .replacingOccurrences(of: "that's", with: "that is")
            .replacingOccurrences(of: "there's", with: "there is")
            .replacingOccurrences(of: "n't", with: " not")
            .replacingOccurrences(of: "'ll", with: " will")
            .replacingOccurrences(of: "'ve", with: " have")
            .replacingOccurrences(of: "'re", with: " are")
            .replacingOccurrences(of: "'d", with: " would")
            .replacingOccurrences(of: "'s", with: "")
            .replacingOccurrences(of: "'", with: "")
        return normalized.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    private static func lcsLength(_ a: [String], _ b: [String]) -> Int {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        var previous = Array(repeating: 0, count: b.count + 1)
        var current = previous
        for aIndex in 1...a.count {
            current[0] = 0
            for bIndex in 1...b.count {
                if a[aIndex - 1] == b[bIndex - 1] {
                    current[bIndex] = previous[bIndex - 1] + 1
                } else {
                    current[bIndex] = max(previous[bIndex], current[bIndex - 1])
                }
            }
            swap(&previous, &current)
        }
        return previous[b.count]
    }

    private static func join(_ first: String, _ second: String) -> String {
        let a = first.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = second.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return "\(a) \(b)"
    }
}
