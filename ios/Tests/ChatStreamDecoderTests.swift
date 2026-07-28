/**
 * The SSE decode path — previously untestable, because it lived inside a Task
 * holding a live URLSession, and therefore untested despite carrying every
 * payment card the app can show.
 *
 * The tests that matter most here are the UNNAMED-result ones: that is the exact
 * shape (gaps report cause 3) in which the iOS payment UI silently never
 * appeared, while web kept working because it keys off the id it captured at the
 * block-start event.
 */
import Testing
import Foundation
@testable import Tiny

private func frame(_ obj: [String: Any]) -> String {
    "data: " + String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
}

/// The wire shape of a pay_x402 quote result, with the name controllable —
/// `nil` reproduces an SDK after-event that omitted `toolUse`.
private func quoteResult(id: String, name: String?) -> [String: Any] {
    var tr: [String: Any] = [
        "toolUseId": id,
        "content": [["json": [
            "requires_confirmation": true,
            "quote": "eyJxdW90ZSI6…",
            "price_micro": 25_000,
            "network": "tiny",
            "payee": "0xabc",
            "message": "consult weather-pro",
            "url": "https://tiny.technology/api/x/weather-pro",
        ]]],
    ]
    if let name { tr["name"] = name }
    return ["type": "afterToolCallEvent", "toolResult": tr]
}

@Suite("ChatStreamDecoder — tool name recovery (p-a-ios)")
struct ChatStreamDecoderNameTests {

    /// The baseline: a named result still works exactly as before. This is the
    /// path that was never broken, and the fix must not change it.
    @Test func namedQuoteStillYieldsACard() {
        var d = ChatStreamDecoder()
        let events = d.decode(event: quoteResult(id: "tu_1", name: "pay_x402"), type: "afterToolCallEvent")
        #expect(events.count == 2)
        guard case .payQuote(_, let quote, let price, _, _, _, let message, let url) = events.dropFirst().first else {
            Issue.record("expected a payQuote, got \(events)"); return
        }
        #expect(quote == "eyJxdW90ZSI6…")
        #expect(price == 25_000)
        #expect(message == "consult weather-pro")
        #expect(url == "https://tiny.technology/api/x/weather-pro")
    }

    /// 🏷️ THE BUG. An after-event without `name` used to fail `if let n =
    /// tr["name"]` and skip every branch — no card, no toolEnd, nothing. The
    /// pairing learned at the block-start event now rescues it.
    @Test func unnamedQuoteIsRecoveredFromTheBlockStartPairing() {
        var d = ChatStreamDecoder()
        _ = d.decode(event: [
            "type": "modelContentBlockStartEvent",
            "toolStart": ["name": "pay_x402", "toolUseId": "tu_1"],
        ], type: "modelContentBlockStartEvent")

        let events = d.decode(event: quoteResult(id: "tu_1", name: nil), type: "afterToolCallEvent")
        guard case .toolEnd(let n) = events.first else { Issue.record("no toolEnd: \(events)"); return }
        #expect(n == "pay_x402")
        guard case .payQuote(_, _, let price, _, _, _, _, _) = events.dropFirst().first else {
            Issue.record("the card must render from an unnamed result: \(events)"); return
        }
        #expect(price == 25_000)
    }

    /// The before-event is the other place a pairing is learned — a tool whose
    /// block-start never arrived is still nameable at its result.
    @Test func unnamedQuoteIsRecoveredFromTheBeforeEventPairing() {
        var d = ChatStreamDecoder()
        _ = d.decode(event: [
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "pay_x402", "toolUseId": "tu_9", "input": ["url": "https://x"]],
        ], type: "beforeToolCallEvent")

        let events = d.decode(event: quoteResult(id: "tu_9", name: nil), type: "afterToolCallEvent")
        #expect(events.count == 2)
        guard case .payQuote = events.dropFirst().first else { Issue.record("expected a card: \(events)"); return }
    }

    /// With NO pairing and no name there is genuinely nothing to key on, and
    /// inventing one would be worse than dropping the event: `pay_x402` and
    /// `spawn_agents` read the same content block differently.
    @Test func aTrulyUnidentifiableResultIsDropped() {
        var d = ChatStreamDecoder()
        #expect(d.decode(event: quoteResult(id: "tu_unknown", name: nil), type: "afterToolCallEvent").isEmpty)
    }

    /// An explicit name on the wire always wins, so the memory can only ever
    /// rescue an unnamed event — never relabel a correctly-named one.
    @Test func anExplicitNameBeatsARememberedOne() {
        var d = ChatStreamDecoder()
        _ = d.decode(event: [
            "type": "modelContentBlockStartEvent",
            "toolStart": ["name": "pay_x402", "toolUseId": "tu_1"],
        ], type: "modelContentBlockStartEvent")
        let events = d.decode(event: [
            "type": "afterToolCallEvent",
            "toolResult": ["name": "spawn_agents", "toolUseId": "tu_1",
                           "content": [["text": "[]"]]],
        ], type: "afterToolCallEvent")
        guard case .toolEnd(let n) = events.first else { Issue.record("\(events)"); return }
        #expect(n == "spawn_agents", "the wire's own name must win")
    }

    /// Ids are unique per call, so a re-set would only ever be the same value —
    /// and keeping the FIRST pairing means a later bogus one can't overwrite the
    /// entry a pending result needs.
    @Test func theFirstPairingForAnIdWins() {
        let names = ChatToolNames()
        names.remember(id: "tu_1", name: "pay_x402")
        names.remember(id: "tu_1", name: "something_else")
        #expect(names.resolve(name: nil, id: "tu_1") == "pay_x402")
    }

    /// The memory is bounded, and it stops GROWING rather than evicting:
    /// evicting could drop the very entry a pending result needs, which is the
    /// bug this file exists to fix.
    @Test func theMemoryIsBoundedAndDoesNotEvict() {
        let names = ChatToolNames()
        names.remember(id: "tu_first", name: "pay_x402")
        for i in 0..<(ChatToolNames.maxRemembered + 50) { names.remember(id: "id_\(i)", name: "t") }
        #expect(names.count == ChatToolNames.maxRemembered)
        #expect(names.resolve(name: nil, id: "tu_first") == "pay_x402", "the earliest pairing must survive the cap")
    }

    /// Two concurrent turns (main chat + a relay reply) must not see each
    /// other's pairings — hence an instance, not a global.
    @Test func decodersDoNotShareMemory() {
        var a = ChatStreamDecoder()
        var b = ChatStreamDecoder()
        _ = a.decode(event: [
            "type": "modelContentBlockStartEvent",
            "toolStart": ["name": "pay_x402", "toolUseId": "tu_1"],
        ], type: "modelContentBlockStartEvent")
        #expect(b.decode(event: quoteResult(id: "tu_1", name: nil), type: "afterToolCallEvent").isEmpty)
    }

    @Test func emptyAndNonStringNamesAreNotRemembered() {
        let names = ChatToolNames()
        names.remember(id: "a", name: "")
        names.remember(id: "", name: "pay_x402")
        names.remember(id: "b", name: 42)
        names.remember(id: 7, name: "pay_x402")
        #expect(names.count == 0)
        #expect(names.resolve(name: nil, id: "a") == nil)
    }
}

@Suite("ChatStreamDecoder — payment results")
struct ChatStreamDecoderPaymentTests {

    /// A failed tool (login/allowlist/over-cap) is a terminal card, not silence.
    @Test func aFailedPaymentSurfacesATerminalCard() {
        var d = ChatStreamDecoder()
        let events = d.decode(event: [
            "type": "afterToolCallEvent",
            "toolResult": ["name": "pay_x402", "toolUseId": "t1",
                           "content": [["json": ["ok": false, "error": "login required"]]]],
        ], type: "afterToolCallEvent")
        guard case .payResult(_, let failed, let error) = events.dropFirst().first else { Issue.record("\(events)"); return }
        #expect(failed)
        #expect(error == "login required")
    }

    /// A free target (200, no 402) is also terminal, but NOT a failure — the two
    /// read differently in the card.
    @Test func aFreeTargetIsTerminalButNotFailed() {
        var d = ChatStreamDecoder()
        let events = d.decode(event: [
            "type": "afterToolCallEvent",
            "toolResult": ["name": "pay_x402", "toolUseId": "t1",
                           "content": [["json": ["ok": true, "message": "No payment needed"]]]],
        ], type: "afterToolCallEvent")
        guard case .payResult(_, let failed, _) = events.dropFirst().first else { Issue.record("\(events)"); return }
        #expect(!failed)
    }

    /// `requires_confirmation` without a quote is not approvable — it must fall
    /// to the terminal card rather than render an Approve button that can't work.
    @Test func confirmationWithoutAQuoteIsNotACard() {
        var d = ChatStreamDecoder()
        let events = d.decode(event: [
            "type": "afterToolCallEvent",
            "toolResult": ["name": "pay_x402", "toolUseId": "t1",
                           "content": [["json": ["requires_confirmation": true, "ok": true]]]],
        ], type: "afterToolCallEvent")
        guard case .payResult = events.dropFirst().first else { Issue.record("expected terminal, got \(events)"); return }
    }

    /// A string return arrives as {text:"…"} holding JSON — firstToolJson handles
    /// both wrappings, and a quote must survive either.
    @Test func aQuoteInATextBlockIsStillAQuote() {
        var d = ChatStreamDecoder()
        let json = #"{"requires_confirmation":true,"quote":"q","price_micro":1000}"#
        let events = d.decode(event: [
            "type": "afterToolCallEvent",
            "toolResult": ["name": "pay_x402", "toolUseId": "t1", "content": [["text": json]]],
        ], type: "afterToolCallEvent")
        guard case .payQuote(_, let q, let p, _, _, _, _, _) = events.dropFirst().first else { Issue.record("\(events)"); return }
        #expect(q == "q")
        #expect(p == 1000)
    }

    /// `Int(Double.infinity)` TRAPS in Swift — a crash, not an overflow — and a
    /// price arrives from JSON, where `1e999` decodes to infinity. The same guard
    /// as Wallet.swift:207 and the c134 loadPrice() fix; a nonsense price must
    /// render as a nonsense number, never take the app down.
    @Test func anAbsurdPriceDoesNotCrashTheApp() {
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: Double.infinity)) == Int.max)
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: -Double.infinity)) == 0)
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: Double.nan)) == 0)
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: 1e300)) == Int.max)
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: -5)) == 0)
        #expect(ChatStreamDecoder.safeMicro(nil) == 0)
        #expect(ChatStreamDecoder.safeMicro("lots") == 0)
        #expect(ChatStreamDecoder.safeMicro(NSNumber(value: 25_000)) == 25_000)
    }

    /// A price that JSON *can* hold, but Int can't: 1e300 parses fine, so it
    /// reaches safeMicro and must clamp instead of trapping.
    @Test func anOversizedButParseablePriceClampsRatherThanTrapping() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: #"data: {"type":"afterToolCallEvent","toolResult":{"name":"pay_x402","toolUseId":"t1","content":[{"json":{"requires_confirmation":true,"quote":"q","price_micro":1e300}}]}}"#)
        guard case .payQuote(_, _, let price, _, _, _, _, _) = events.dropFirst().first else { Issue.record("\(events)"); return }
        #expect(price == Int.max)
        #expect(d.dropped == 0, "a parseable frame is not a loss")
    }

    /// And a price JSON *can't* hold: JSONSerialization rejects a literal outside
    /// Double's range and fails the WHOLE object, so the card is unrecoverable
    /// no matter how careful safeMicro is — the containment limit is the PARSER,
    /// not the type. What we owe the user then is the truth: count the frame as
    /// dropped so the reply is marked incomplete instead of silently short a card.
    @Test func anUnparseablePriceIsCountedAsALostFrame() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: #"data: {"type":"afterToolCallEvent","toolResult":{"name":"pay_x402","toolUseId":"t1","content":[{"json":{"requires_confirmation":true,"quote":"q","price_micro":1e999}}]}}"#)
        #expect(events.isEmpty)
        #expect(d.dropped == 1)
        #expect(d.droppedNote?.contains("1 stream event ") == true)
    }
}

@Suite("ChatStreamDecoder — framing and parity with the old inline decode")
struct ChatStreamDecoderFramingTests {

    @Test func textAndReasoningDeltas() {
        var d = ChatStreamDecoder()
        guard case .text(let t) = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "hi"])).first else {
            Issue.record("no text"); return
        }
        #expect(t == "hi")
        guard case .reasoning(let r) = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "reasoningDelta": "hmm"])).first else {
            Issue.record("no reasoning"); return
        }
        #expect(r == "hmm")
    }

    /// An empty textDelta is a real frame the server sends; it must stay an
    /// event (the old code yielded it too) rather than being filtered.
    @Test func anEmptyTextDeltaIsStillAnEvent() {
        var d = ChatStreamDecoder()
        #expect(d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": ""])).count == 1)
    }

    /// SSE framing noise is EXPECTED traffic, not loss — counting a keepalive as
    /// a dropped event would put a scary warning under every long reply.
    @Test func nonDataLinesAndKeepalivesAreIgnoredWithoutBlame() {
        var d = ChatStreamDecoder()
        for noise in [": keepalive", "", "event: ping", "data:", "data: [DONE]", "data:   "] {
            #expect(d.decode(line: noise).isEmpty, "\(noise.debugDescription) must decode to nothing")
        }
        #expect(d.dropped == 0)
        #expect(d.droppedNote == nil)
    }

    /// A `data:` line we cannot read IS a loss: something was sent for the user
    /// and never arrived, and no seq gap can reveal it because the seq was inside
    /// the frame we failed to parse.
    @Test func anUnreadableDataFrameCountsAsDropped() {
        var d = ChatStreamDecoder()
        for bad in ["data: not json", "data: []", "data: null", "data: {\"no\":\"type\"}", "data: {truncated"] {
            #expect(d.decode(line: bad).isEmpty)
        }
        #expect(d.dropped == 5)
    }

    /// A seq JUMP means frames were lost in transit, and the user is told the
    /// reply may be incomplete rather than silently trusting it.
    @Test func aSeqGapIsCountedAndReported() {
        var d = ChatStreamDecoder()
        _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "a", "seq": 1]))
        _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "b", "seq": 5]))
        #expect(d.dropped == 3)
        #expect(d.droppedNote?.contains("3 stream events dropped") == true)
    }

    @Test func noGapMeansNoNote() {
        var d = ChatStreamDecoder()
        for i in 1...4 { _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "x", "seq": i])) }
        #expect(d.dropped == 0)
        #expect(d.droppedNote == nil)
    }

    /// One dropped frame reads "1 stream event", not "1 stream events".
    @Test func theDroppedNotePluralizes() {
        var d = ChatStreamDecoder()
        _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "a", "seq": 1]))
        _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "b", "seq": 3]))
        #expect(d.droppedNote?.contains("1 stream event ") == true)
    }

    /// The FIRST frame can't be a gap — lastSeq starts at -1, and treating seq 7
    /// as "6 dropped" would warn on every stream that doesn't start at 0.
    @Test func theFirstFrameIsNeverAGap() {
        var d = ChatStreamDecoder()
        _ = d.decode(line: frame(["type": "modelContentBlockDeltaEvent", "textDelta": "a", "seq": 7]))
        #expect(d.dropped == 0)
    }

    @Test func clientExecutedToolsRideTheBeforeEvent() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: frame([
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "speak", "toolUseId": "s1", "input": ["text": "hello", "voice": "af_heart"]],
        ]))
        guard case .speak(let id, let text, let voice) = events.last else { Issue.record("\(events)"); return }
        #expect(id == "s1")
        #expect(text == "hello")
        #expect(voice == "af_heart")
    }

    @Test func vibrateDefaultsMatchTheOldInlineDecode() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: frame(["type": "beforeToolCallEvent", "toolCall": ["name": "vibrate", "toolUseId": "v", "input": [:]]]))
        guard case .vibrate(let pattern, let times, let intensity) = events.last else { Issue.record("\(events)"); return }
        #expect(pattern == "tap")
        #expect(times == 1)
        #expect(intensity == 1.0)
    }

    @Test func deviceActionsCarryTheirArgsAsJson() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: frame([
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "copy_to_clipboard", "toolUseId": "c1", "input": ["text": "copied"]],
        ]))
        guard case .deviceAction(let name, let argsJson) = events.last else { Issue.record("\(events)"); return }
        #expect(name == "copy_to_clipboard")
        #expect(argsJson.contains("copied"))
    }

    /// `props` is whatever the model wrote. A non-object there must become "{}"
    /// for the native renderer, not throw inside JSONSerialization (a crash).
    @Test func renderUiSurvivesNonObjectProps() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: frame([
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "render_ui", "toolUseId": "r1", "input": ["title": "Chart", "props": "not an object"]],
        ]))
        guard case .renderUi(_, let title, let propsJson) = events.last else { Issue.record("\(events)"); return }
        #expect(title == "Chart")
        #expect(propsJson == "{}")
    }

    @Test func renderUiPassesPropsThrough() {
        var d = ChatStreamDecoder()
        let events = d.decode(line: frame([
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "render_ui", "toolUseId": "r1", "input": ["title": "T", "props": ["data": [["label": "Mon", "value": 12]]]]],
        ]))
        guard case .renderUi(_, _, let propsJson) = events.last else { Issue.record("\(events)"); return }
        #expect(propsJson.contains("Mon"))
    }

    @Test func spawnAgentsCarriesTasksThenResults() {
        var d = ChatStreamDecoder()
        let before = d.decode(line: frame([
            "type": "beforeToolCallEvent",
            "toolCall": ["name": "spawn_agents", "toolUseId": "sa1",
                         "input": ["tasks": [["prompt": "one"], ["prompt": "two"]]]],
        ]))
        guard case .spawnTasks(let id, let prompts) = before.last else { Issue.record("\(before)"); return }
        #expect(id == "sa1")
        #expect(prompts == ["one", "two"])

        // And the results, unnamed — the same recovery the payment card needs.
        let after = d.decode(line: frame([
            "type": "afterToolCallEvent",
            "toolResult": ["toolUseId": "sa1", "content": [["text": "[{\"ok\":true}]"]]],
        ]))
        guard case .spawnResults(_, let json) = after.last else {
            Issue.record("unnamed spawn results must still land: \(after)"); return
        }
        #expect(json.contains("ok"))
    }

    @Test func usageIsReportedOnlyWhenThereAreTokens() {
        var d = ChatStreamDecoder()
        #expect(d.decode(line: frame([
            "type": "modelMetadataEvent", "usage": ["inputTokens": 0, "outputTokens": 0],
        ])).isEmpty, "an all-zero usage frame is noise")

        let events = d.decode(line: frame([
            "type": "modelMetadataEvent", "modelId": "claude-opus-5",
            "usage": ["inputTokens": 10, "outputTokens": 20, "cacheReadInputTokens": 5],
        ]))
        guard case .usage(let i, let o, let c, let m) = events.first else { Issue.record("\(events)"); return }
        #expect(i == 10); #expect(o == 20); #expect(c == 5); #expect(m == "claude-opus-5")
    }

    @Test func errorFramesBecomeErrorEvents() {
        var d = ChatStreamDecoder()
        guard case .error(let e) = d.decode(line: frame(["type": "error", "error": "provider failed"])).first else {
            Issue.record("no error event"); return
        }
        #expect(e == "provider failed")
    }

    /// Unknown event types are forwarded as type-only markers by the server, and
    /// the client has always ignored them. A new server event must not break an
    /// old build.
    @Test func unknownEventTypesAreIgnored() {
        var d = ChatStreamDecoder()
        #expect(d.decode(line: frame(["type": "somethingEntirelyNew", "payload": 1])).isEmpty)
    }

    /// A realistic turn, in order, ending in an UNNAMED quote result: the whole
    /// point, as one sequence.
    @Test func aFullTurnEndingInAnUnnamedQuote() {
        var d = ChatStreamDecoder()
        var events: [Api.ChatEvent] = []
        var unnamed: [String: Any] = quoteResult(id: "tu_7", name: nil)
        unnamed["seq"] = 4
        let lines = [
            frame(["type": "modelContentBlockDeltaEvent", "textDelta": "Checking", "seq": 1]),
            frame(["type": "modelContentBlockStartEvent", "toolStart": ["name": "pay_x402", "toolUseId": "tu_7"], "seq": 2]),
            frame(["type": "beforeToolCallEvent", "toolCall": ["name": "pay_x402", "toolUseId": "tu_7", "input": ["url": "https://x"]], "seq": 3]),
            frame(unnamed),
            frame(["type": "modelContentBlockDeltaEvent", "textDelta": " — approve?", "seq": 5]),
        ]
        for l in lines { events += d.decode(line: l) }

        #expect(d.dropped == 0)
        let hasQuote = events.contains { if case .payQuote = $0 { return true }; return false }
        #expect(hasQuote, "the turn must end with an approvable card: \(events)")
        let texts = events.compactMap { if case .text(let t) = $0 { return t }; return nil }
        #expect(texts == ["Checking", " — approve?"])
    }
}
