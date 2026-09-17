/**
 * StickyCardTests — the card composer's compiler: lines → spec, and every
 * refusal a sentence with the numbers in it.
 *
 * Wire truth (tiny_display.cpp, grammar v4): text{body}, list{items[]},
 * kv{rows — [[k,v],…] keeps the user's order}, chart{data[], labels?},
 * buttons max 4 on any card. The firmware parses with cJSON, so the one
 * hard rule is that compile() output is REAL JSON after the verb.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct StickyCardTests {

    private func spec(_ draft: StickyCardDraft) throws -> [String: Any] {
        guard case .ok(let cmd) = StickyCardSpec.compile(draft) else {
            Issue.record("compile refused: \(StickyCardSpec.compile(draft))")
            return [:]
        }
        #expect(cmd.hasPrefix("render_ui "))
        let json = String(cmd.dropFirst("render_ui ".count))
        return try #require(try JSONSerialization.jsonObject(
            with: Data(json.utf8)) as? [String: Any])
    }

    // ── text ─────────────────────────────────────────────────────────────────

    @Test func textCardCarriesTitleAndBody() throws {
        var d = StickyCardDraft()
        d.title = "note"
        d.content = "hello glass"
        let s = try spec(d)
        #expect(s["type"] as? String == "text")
        #expect(s["title"] as? String == "note")
        #expect(s["body"] as? String == "hello glass")
        #expect(s["card_id"] as? String == "ios")
    }

    @Test func emptyBodyIsARefusalSentence() {
        var d = StickyCardDraft()
        d.content = "   \n "
        guard case .refused(let why) = StickyCardSpec.compile(d) else {
            Issue.record("compiled an empty card"); return
        }
        #expect(why.contains("body"))
    }

    // ── list ─────────────────────────────────────────────────────────────────

    @Test func listSplitsLinesAndDropsBlanks() throws {
        var d = StickyCardDraft()
        d.kind = .list
        d.content = "  milk \n\n eggs\n\tbread\n   "
        let s = try spec(d)
        #expect(s["items"] as? [String] == ["milk", "eggs", "bread"])
    }

    // ── kv ───────────────────────────────────────────────────────────────────

    @Test func kvSplitsOnFirstColonOnlyAndKeepsOrder() throws {
        var d = StickyCardDraft()
        d.kind = .kv
        d.content = "time: 09:30\nzzz: last?\nno colon line\n: empty key\nwho: "
        let s = try spec(d)
        let rows = try #require(s["rows"] as? [[String]])
        // "time" keeps its value's colons; colonless and empty-key lines are
        // skipped; empty VALUE survives (a kv row may be a label); user order
        // is preserved (pairs, not a dictionary — "zzz" must not sort last).
        #expect(rows == [["time", "09:30"], ["zzz", "last?"], ["who", ""]])
    }

    @Test func kvWithNoParsableRowsRefusesWithTheFormat() {
        var d = StickyCardDraft()
        d.kind = .kv
        d.content = "just words"
        guard case .refused(let why) = StickyCardSpec.compile(d) else {
            Issue.record("compiled rowless kv"); return
        }
        #expect(why.contains("key: value"))
    }

    // ── chart ────────────────────────────────────────────────────────────────

    @Test func chartParsesNumbersAndMatchedLabels() throws {
        var d = StickyCardDraft()
        d.kind = .chart
        d.content = "3, 7.5 4\n9"
        d.labels = "a, b, c, d"
        let s = try spec(d)
        #expect((s["data"] as? [Double]) == [3, 7.5, 4, 9])
        #expect((s["labels"] as? [String]) == ["a", "b", "c", "d"])
    }

    @Test func chartNamesTheTokenThatIsNotANumber() {
        var d = StickyCardDraft()
        d.kind = .chart
        d.content = "3, seven, 4"
        guard case .refused(let why) = StickyCardSpec.compile(d) else {
            Issue.record("compiled a chart from words"); return
        }
        #expect(why.contains("seven"))
    }

    @Test func chartLabelCountMismatchNamesBothNumbers() {
        var d = StickyCardDraft()
        d.kind = .chart
        d.content = "1, 2, 3"
        d.labels = "a, b"
        guard case .refused(let why) = StickyCardSpec.compile(d) else {
            Issue.record("compiled mismatched labels"); return
        }
        #expect(why.contains("2") && why.contains("3"))
    }

    // ── buttons ──────────────────────────────────────────────────────────────

    @Test func buttonsRideAnyCardUpToFour() throws {
        var d = StickyCardDraft()
        d.content = "pick one"
        d.buttons = "Yes, No, Maybe , Later,"
        let s = try spec(d)
        #expect(s["buttons"] as? [String] == ["Yes", "No", "Maybe", "Later"])
    }

    @Test func fifthButtonIsRefusedWithTheBarSize() {
        var d = StickyCardDraft()
        d.content = "pick"
        d.buttons = "a,b,c,d,e"
        guard case .refused(let why) = StickyCardSpec.compile(d) else {
            Issue.record("compiled 5 buttons"); return
        }
        #expect(why.contains("5") && why.contains("4"))
    }

    @Test func noButtonsMeansNoButtonsKey() throws {
        var d = StickyCardDraft()
        d.content = "plain"
        let s = try spec(d)
        #expect(s["buttons"] == nil)
    }
}
