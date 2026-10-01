import XCTest
@testable import OasisEcho

final class WakeWordWindowTests: XCTestCase {
    func testRingBufferReadsTheNewestSamplesEvenWhenFull() {
        let ring = RingBuffer(capacity: 5)
        let data: [Float] = [1, 2, 3, 4, 5, 6, 7]
        data.withUnsafeBufferPointer { ring.append($0.baseAddress!, count: $0.count) }
        var out = [Float](repeating: 0, count: 3)
        out.withUnsafeMutableBufferPointer { ring.readLatest(into: $0.baseAddress!, count: 3) }
        XCTAssertEqual(out, [5, 6, 7])
    }

    func testWindowWaitsForThePhraseThenTakesItWithPreRoll() {
        let rate = 48_000.0
        var w = WakePhraseWindow(sampleRate: rate)
        XCTAssertNil(w.push(count: 1024, loud: true), "not capturing before begin()")
        w.begin()
        var taken: Int?
        // ~0.8 s of speech in 1024-sample buffers: no recognition yet.
        for _ in 0..<38 { XCTAssertNil(w.push(count: 1024, loud: true)) }
        // A pause of 0.4 s ends the phrase.
        for _ in 0..<20 where taken == nil { taken = w.push(count: 1024, loud: false) }
        let frames = try! XCTUnwrap(taken)
        // The phrase plus the pause plus 0.4 s of pre-roll — not a fixed old 3 s.
        XCTAssertGreaterThan(Double(frames), rate * (0.8 + 0.4))
        XCTAssertLessThan(Double(frames), rate * (0.8 + 0.4 + 0.4 + 0.1))
        XCTAssertFalse(w.isCapturing)
    }

    func testWindowCapsALongUtterance() {
        let rate = 16_000.0
        var w = WakePhraseWindow(sampleRate: rate)
        w.begin()
        var taken: Int?
        for _ in 0..<1000 where taken == nil { taken = w.push(count: 160, loud: true) }
        let frames = try! XCTUnwrap(taken)
        XCTAssertLessThanOrEqual(Double(frames), rate * (3.0 + 0.4) + 160)
    }

    func testABriefDipDoesNotEndThePhrase() {
        var w = WakePhraseWindow(sampleRate: 16_000)
        w.begin()
        XCTAssertNil(w.push(count: 1600, loud: true))
        XCTAssertNil(w.push(count: 3200, loud: false)) // 0.2 s gap between words
        XCTAssertNil(w.push(count: 1600, loud: true))
        XCTAssertTrue(w.isCapturing)
    }
}
