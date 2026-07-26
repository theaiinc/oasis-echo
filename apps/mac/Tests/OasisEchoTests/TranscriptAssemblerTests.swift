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
}


final class ServerAutoLauncherTests: XCTestCase {
    func testLaunchesServerDirectlyWithoutNpmWrapper() {
        let arguments = ServerLaunchCommand.arguments(port: 9187)
        XCTAssertEqual(arguments, ["-l", "-c", "PORT=9187 exec node --import tsx packages/app/src/server.ts"])
        XCTAssertFalse(arguments.joined(separator: " ").contains("npm run server"))
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
