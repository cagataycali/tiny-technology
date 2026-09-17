/**
 * StickySayTests — the composer's pure halves: which relay door a message
 * takes, whether the JSON door survives the user's own punctuation, and the
 * five-slot history's dedupe.
 *
 * Wire truth under test (tiny_node.cpp, read 2026-08-26): `say <text>` takes
 * the text raw after the verb; a custom title needs `render_ui {json}` and
 * that JSON is parsed by cJSON on a microcontroller — so the one thing the
 * builder must never do is interpolate quotes into a string by hand.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct StickySayTests {

    // ── Door choice ──────────────────────────────────────────────────────────

    @Test func noTitleTakesTheSayDoor() {
        #expect(StickySayCard.command(text: "dinner's ready", title: "")
                == "say dinner's ready")
        // Whitespace-only title is no title.
        #expect(StickySayCard.command(text: "hi", title: "   ") == "say hi")
    }

    @Test func emptyTextIsRefusedAsNil() {
        #expect(StickySayCard.command(text: "", title: "note") == nil)
        #expect(StickySayCard.command(text: "  \n ", title: "") == nil)
    }

    @Test func trimmingHappensBeforeTheWire() {
        #expect(StickySayCard.command(text: "  hey \n", title: "")
                == "say hey")
    }

    // ── The JSON door ────────────────────────────────────────────────────────

    @Test func titledMessageBecomesValidRenderUiJson() throws {
        let cmd = try #require(StickySayCard.command(text: "call me", title: "from cagatay"))
        #expect(cmd.hasPrefix("render_ui "))
        let json = String(cmd.dropFirst("render_ui ".count))
        let obj = try #require(try JSONSerialization.jsonObject(
            with: Data(json.utf8)) as? [String: String])
        #expect(obj["type"] == "text")
        #expect(obj["card_id"] == "say")
        #expect(obj["title"] == "from cagatay")
        #expect(obj["body"] == "call me")
    }

    /// The reason a serializer builds the spec: quotes, backslashes and
    /// newlines in the user's own words must round-trip, not break cJSON.
    @Test func punctuationSurvivesTheJsonDoor() throws {
        let hostile = #"she said "don't" — path C:\tmp"# + "\nline two"
        let cmd = try #require(StickySayCard.command(text: hostile, title: "note"))
        let json = String(cmd.dropFirst("render_ui ".count))
        let obj = try #require(try JSONSerialization.jsonObject(
            with: Data(json.utf8)) as? [String: String])
        #expect(obj["body"] == hostile)
    }

    // ── The cap ──────────────────────────────────────────────────────────────

    @Test func overCapIsRefusedWithBothNumbers() {
        let long = String(repeating: "a", count: StickySayCard.maxChars + 1)
        let refusal = StickySayCard.refusal(long)
        #expect(refusal?.contains("\(StickySayCard.maxChars + 1)") == true)
        #expect(refusal?.contains("\(StickySayCard.maxChars)") == true)
        #expect(StickySayCard.refusal(String(repeating: "a",
                                             count: StickySayCard.maxChars)) == nil)
    }

    // ── History ──────────────────────────────────────────────────────────────

    private func entry(_ text: String, _ title: String = "") -> StickySayEntry {
        StickySayEntry(text: text, title: title, stamp: Date())
    }

    @Test func historyIsNewestFirstAndCapped() {
        var list: [StickySayEntry] = []
        for i in 1 ... 7 { list = StickySayHistory.pushed(list, entry("msg \(i)")) }
        #expect(list.count == StickySayHistory.cap)
        #expect(list.first?.text == "msg 7")
        #expect(list.last?.text == "msg 3")
    }

    @Test func resendMovesToTopInsteadOfDuplicating() {
        var list: [StickySayEntry] = []
        list = StickySayHistory.pushed(list, entry("a"))
        list = StickySayHistory.pushed(list, entry("b"))
        list = StickySayHistory.pushed(list, entry("a"))
        #expect(list.map(\.text) == ["a", "b"])
    }

    /// Same text under a different title is a DIFFERENT fridge note.
    @Test func titleParticipatesInIdentity() {
        var list: [StickySayEntry] = []
        list = StickySayHistory.pushed(list, entry("ok", "morning"))
        list = StickySayHistory.pushed(list, entry("ok", "evening"))
        #expect(list.count == 2)
    }
}
