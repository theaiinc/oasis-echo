import XCTest
@testable import OasisEcho

final class TranscriptAssemblerTests: XCTestCase {
    func testRollingBufferRewritesFuzzyOverlappingHypotheses() {
        var assembler = TranscriptAssembler()

        assembler.ingestPartial("Yeah, sure. I actually am testing an order")
        assembler.ingestPartial("Actually I'm testing another route to where to")
        assembler.ingestPartial("Actually I'm testing another route or whether this would")
        assembler.ingestFinal("Actually I'm testing an order out of whether this was based actually good or not.")

        XCTAssertEqual(
            assembler.text,
            "Yeah, sure. Actually I'm testing an order out of whether this was based actually good or not."
        )
    }

    func testExactOverlapAppendsOnlyNewWords() {
        XCTAssertEqual(
            TranscriptAssembler.mergeTranscript(
                "please turn on the living room",
                with: "living room lights"
            ),
            "please turn on the living room lights"
        )
    }

    func testLaterFullHypothesisReplacesEarlierShortHypothesis() {
        XCTAssertEqual(
            TranscriptAssembler.mergeTranscript(
                "testing another route",
                with: "yeah sure testing another route today"
            ),
            "yeah sure testing another route today"
        )
    }

    func testUnrelatedContinuationIsPreserved() {
        var assembler = TranscriptAssembler()

        assembler.ingestPartial("I need to schedule a meeting")
        assembler.ingestPartial("and send the notes afterward")
        assembler.ingestFinal("and send the notes afterward")

        XCTAssertEqual(
            assembler.text,
            "I need to schedule a meeting and send the notes afterward"
        )
    }

    func testShortCoincidentalOverlapDoesNotDropContinuation() {
        XCTAssertEqual(
            TranscriptAssembler.mergeTranscript(
                "I talked to Sam",
                with: "to confirm the booking"
            ),
            "I talked to Sam to confirm the booking"
        )
    }

    // Server STT (rolling-buffer re-inference) sends cumulative
    // hypotheses: each partial already covers the whole utterance.
    // When a re-hearing shares no detectable overlap with the previous
    // hypothesis it must replace it — appending duplicates the whole
    // utterance ("Current Re The The enrollment …").
    func testCumulativeRehearingReplacesInsteadOfAppending() {
        var assembler = TranscriptAssembler()
        assembler.cumulativeHypotheses = true

        assembler.ingestPartial("Current Re")
        assembler.ingestPartial("The enrollment")
        assembler.ingestPartial("Right now the enrollment requirements")
        assembler.ingestFinal("Right now the enrollment requirements are great")

        XCTAssertEqual(
            assembler.text,
            "Right now the enrollment requirements are great"
        )
    }

    func testCumulativeFinalIsAuthoritative() {
        var assembler = TranscriptAssembler()
        assembler.cumulativeHypotheses = true

        // Partials drift as the rolling buffer re-infers; the final
        // covers the whole utterance and must win outright — mixing it
        // with stale hypotheses is what produced mangled paste output.
        assembler.ingestPartial("Yeah, sure. I actually am testing an order")
        assembler.ingestPartial("Actually I'm testing another route to where to")
        assembler.ingestFinal("Yeah sure, actually I'm testing an order out of whether this was good.")

        XCTAssertEqual(
            assembler.text,
            "Yeah sure, actually I'm testing an order out of whether this was good."
        )
    }

    func testCumulativeEmptyFinalKeepsLastHypothesis() {
        var assembler = TranscriptAssembler()
        assembler.cumulativeHypotheses = true

        assembler.ingestPartial("send the report tomorrow morning")
        assembler.ingestFinal("   ")

        XCTAssertEqual(assembler.text, "send the report tomorrow morning")
    }

    func testSegmentModeStillAppendsUnrelatedContinuations() {
        var assembler = TranscriptAssembler()
        // Default (Apple Speech) mode: unrelated text is new speech.
        assembler.ingestPartial("I need to schedule a meeting")
        assembler.ingestPartial("and send the notes afterward")

        XCTAssertEqual(
            assembler.text,
            "I need to schedule a meeting and send the notes afterward"
        )
    }
}


final class ServerAutoLauncherTests: XCTestCase {
    func testLaunchesServerDirectlyWithoutNpmWrapper() {
        let arguments = ServerLaunchCommand.arguments(port: 9187, nodePath: "/opt/homebrew/bin/node")
        XCTAssertEqual(arguments, ["-l", "-c", "PORT=9187 exec '/opt/homebrew/bin/node' --import tsx packages/app/src/server.ts"])
        XCTAssertFalse(arguments.joined(separator: " ").contains("npm run server"))
    }

    func testFindsNodeOutsideLaunchdPath() {
        let node = ServerLaunchCommand.nodeExecutable(environment: [
            "PATH": "/usr/bin:/bin"
        ])
        XCTAssertEqual(node, ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: {
            FileManager.default.isExecutableFile(atPath: $0)
        }))
    }
}


@MainActor
final class AppStateTranscriptTests: XCTestCase {
    func testFormattedTranscriptPublishesWholeMessageArray() {
        let state = AppState()
        state.agentMessages = [
            AgentMessage(role: .user, text: "hello  ,world", partial: false),
            AgentMessage(role: .echo, text: "", partial: true),
        ]

        XCTAssertTrue(state.replaceLatestUserMessage(original: "hello  ,world", with: "hello, world"))
        XCTAssertEqual(state.agentMessages[0].text, "hello, world")
    }

    func testStaleFormattedTranscriptDoesNotReplaceNewerMessage() {
        let state = AppState()
        state.agentMessages = [AgentMessage(role: .user, text: "new turn", partial: false)]

        XCTAssertFalse(state.replaceLatestUserMessage(original: "old turn", with: "formatted old turn"))
        XCTAssertEqual(state.agentMessages[0].text, "new turn")
    }
}
