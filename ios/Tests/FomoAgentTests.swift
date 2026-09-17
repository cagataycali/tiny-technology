/**
 * FomoAgentTests — the /ws/agent frame reducer (web parity: useAgent.ts).
 */
import Testing
import Foundation
@testable import Tiny

private func f(_ s: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:] }

@Suite struct FomoAgentCoreTests {
    @Test func oneNarrativePerPrompt() {
        var log = FomoAgentCore.Log()
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"hello","tools":["move","motion","photo"],"version":"0.3"}"#))
        #expect(log.tools == ["move", "motion", "photo"] && log.turns.isEmpty)
        log.you("nod")
        #expect(log.busy && log.turns.count == 1 && log.turns[0].role == .you)
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"text","delta":"Sure, "}"#))
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"tool","id":"t1","name":"motion","input":{"name":"approve"}}"#))
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"text","delta":"nodding."}"#))
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"tool_result","id":"t1","status":"success","text":"played approve 5 frames"}"#))
        #expect(log.turns.count == 2)
        let fomo = log.turns[1]
        #expect(fomo.role == .fomo && fomo.text == "Sure, nodding." && !fomo.done)
        #expect(fomo.receipts.count == 1 && fomo.receipts[0].name == "motion" && fomo.receipts[0].status == "success")
        #expect(fomo.receipts[0].input?.contains("approve") == true)
        #expect(fomo.receipts[0].text == "played approve 5 frames")
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"done"}"#))
        #expect(log.turns[1].done && !log.busy)
        // a second prompt opens a NEW fomo turn
        log.you("look at me")
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"text","delta":"ok"}"#))
        #expect(log.turns.count == 4 && log.turns[3].text == "ok")
    }

    @Test func errorClosesTheTurnAndPhotoBecomesAPath() {
        var log = FomoAgentCore.Log()
        log.you("photo")
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"tool","id":"p","name":"photo","input":null}"#))
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"tool_result","id":"p","status":"success","photo":"/Users/c/.fomo/photos/2026-09-09_1.jpg"}"#))
        #expect(log.turns[1].receipts[0].photo == "/photos/2026-09-09_1.jpg")
        #expect(log.turns[1].receipts[0].input == nil)
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"error","error":"still answering the last one"}"#))
        #expect(log.turns[1].done && log.turns[1].error == "still answering the last one" && !log.busy)
        // an orphan result (no matching tool) still shows up
        log.you("x")
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"tool_result","id":"zz","status":"error","text":"boom"}"#))
        #expect(log.turns.last?.receipts.first?.name == "?" && log.turns.last?.receipts.first?.text == "boom")
        // unknown frames are ignored
        let before = log
        FomoAgentCore.reduce(&log, frame: f(#"{"type":"heartbeat"}"#))
        #expect(log == before)
        FomoAgentCore.reduce(&log, frame: f(#"{"nope":1}"#))
        #expect(log == before)
    }

    @Test func chatFallbackIsOneFinishedTurn() {
        var log = FomoAgentCore.Log()
        log.you("wave")
        FomoAgentCore.reduceChat(&log, result: "waved", tools: ["motion"], errors: [])
        #expect(log.turns.count == 2 && log.turns[1].done && log.turns[1].text == "waved" && log.turns[1].receipts.map(\.name) == ["motion"] && !log.busy)
        FomoAgentCore.reduceChat(&log, result: "", tools: [], errors: ["token required"])
        #expect(log.turns.last?.error == "token required")
    }
}
