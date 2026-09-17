/**
 * StickyMessagesTests — both wire shapes of the unread badge, and the
 * null-is-not-zero contract the firmware states explicitly ("`null` means
 * 'could not read it', never zero").
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct StickyMessagesTests {

    // ── Shape 1: body echoed verbatim ────────────────────────────────────────

    @Test func verbatimBodyYieldsCountAndSenders() throws {
        let payload = """
        {"op":"unread","http":200,"body":{"unread":2,"from":["alice","bob"]},\
        "summary":"unread badge via device token"}
        """
        let b = try #require(StickyMessages.badge(payload))
        #expect(b.unread == 2)
        #expect(b.senders == ["alice", "bob"])
        #expect(b.line == "2 unread — @alice, @bob")
    }

    @Test func zeroUnreadIsAQuietLine() throws {
        let payload = #"{"op":"unread","http":200,"body":{"unread":0,"from":[]}}"#
        let b = try #require(StickyMessages.badge(payload))
        #expect(b.unread == 0)
        #expect(b.line == "no unread messages")
    }

    // ── Shape 2: body dropped, counts parsed device-side ────────────────────

    @Test func droppedBodyKeepsTheTwoNumbersABadgeNeeds() throws {
        let payload = """
        {"op":"unread","http":200,"unread":12,"from_count":9,"body_bytes":1400,\
        "body_dropped":true,"summary":"unread badge (body too large to echo verbatim)"}
        """
        let b = try #require(StickyMessages.badge(payload))
        #expect(b.unread == 12)
        #expect(b.senderCount == 9)
        #expect(b.senders.isEmpty)
        #expect(b.line == "12 unread from 9 senders (list too long to echo)")
    }

    // ── null is "could not read", never zero ─────────────────────────────────

    @Test func nullBodyIsCouldNotReadNotZero() throws {
        // http 500, body null: the firmware could not read the backend.
        let payload = #"{"op":"unread","http":500,"body":null}"#
        let b = try #require(StickyMessages.badge(payload))
        #expect(b.unread == nil)
        #expect(b.line == "couldn't read the badge (http 500)")
    }

    @Test func http200WithUnreadableBodyStillSaysCouldNotRead() throws {
        let payload = #"{"op":"unread","http":200,"body":null}"#
        let b = try #require(StickyMessages.badge(payload))
        #expect(b.unread == nil)
        #expect(b.line == "couldn't read the badge")
    }

    // ── Not the badge shape at all ───────────────────────────────────────────

    @Test func foreignPayloadsRefuseToBecomeABadge() {
        #expect(StickyMessages.badge(#"{"error":"out of memory"}"#) == nil)
        #expect(StickyMessages.badge("not json at all") == nil)
        #expect(StickyMessages.badge(#"{"op":"inbox","http":200}"#) == nil)
    }
}
