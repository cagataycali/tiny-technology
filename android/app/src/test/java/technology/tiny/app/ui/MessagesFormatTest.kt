package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The under-bubble DM meta line "<age> · via <tiny>" (iOS Messages.swift:228 /
 * web MessagesHUD.tsx:506 parity). The age half reuses the shared ago(); the
 * "· via <tiny>" suffix appears only when the message was routed through an
 * agent. nowMs is injected so the relative age is deterministic in tests.
 */
class MessagesFormatTest {

    // A fixed "now" 5 minutes after the message's created stamp.
    private val createdSec = 1_784_808_000L
    private val nowMs = (createdSec + 300) * 1000

    @Test fun `age plus via when routed through a tiny`() {
        assertEquals("5m · via luna", dmMeta(createdSec, "luna", nowMs))
    }

    @Test fun `age only when not routed`() {
        // A plain human-to-human DM has no viaTiny → just the age, no dangling separator.
        assertEquals("5m", dmMeta(createdSec, null, nowMs))
        assertEquals("5m", dmMeta(createdSec, "", nowMs)) // empty string treated as absent
    }

    @Test fun `seconds and hours track the shared ago buckets`() {
        assertEquals("30s", dmMeta(createdSec, null, (createdSec + 30) * 1000))
        assertEquals("2h", dmMeta(createdSec, null, (createdSec + 7200) * 1000))
    }

    @Test fun `zero or garbage created floors to 1s not a bogus huge age`() {
        // A missing created (optLong default 0) must read "1s", not ~20000 days.
        assertEquals("1s", dmMeta(0L, null, nowMs))
        assertEquals("1s · via bot", dmMeta(0L, "bot", nowMs))
    }

    // The inbox thread-row title prefers the builder's display name (iOS
    // Messages.swift:167 / web MessagesHUD.tsx:402); "@login" is the fallback.
    @Test fun `thread title prefers the display name`() {
        assertEquals("Luna Rivers", threadTitle("Luna Rivers", "luna"))
    }

    @Test fun `thread title falls back to the handle when name is absent`() {
        // parse stores name as null when empty; a blank/whitespace name also falls back.
        assertEquals("@luna", threadTitle(null, "luna"))
        assertEquals("@luna", threadTitle("", "luna"))
        assertEquals("@luna", threadTitle("   ", "luna"))
    }

    // ── DM length cap (tests/dm-length-parity.test.ts is the cross-surface half) ──
    //
    // The server used to cut an over-long DM at 2000 UTF-16 units and answer
    // { ok: true }; it now REFUSES with a 400, because a DM can't be unsent. The
    // 400 reaches this app as "send failed — try again", which invites a retry
    // that can never work, so the composer states the real reason itself.
    //
    // The trap this pins: Kotlin's String.length is UTF-16 UNITS. Using it here
    // would report a 2000-emoji draft as 4000 characters and refuse a message the
    // server accepts — the mirror image of the server bug being fixed.

    @Test fun `overrun counts code points, not UTF-16 units`() {
        val emoji = "👋".repeat(DM_MAX_CHARS)   // 👋 ×2000 = 4000 units
        assertEquals(4000, emoji.length)                   // what NOT to count
        assertEquals(0, dmOverrun(emoji))                  // exactly at the cap
        assertEquals(1, dmOverrun(emoji + "👋"))
    }

    @Test fun `at and under the cap there is nothing to say`() {
        assertEquals(null, dmSendRefusal("hi"))
        assertEquals(null, dmSendRefusal("a".repeat(DM_MAX_CHARS)))
        // A blank draft is the send button's own business (it stays disabled) —
        // reporting a length problem for an empty field would be nonsense.
        assertEquals(null, dmSendRefusal(""))
        assertEquals(null, dmSendRefusal("   "))
    }

    @Test fun `over the cap names the overrun, so the user knows what to cut`() {
        val r = dmSendRefusal("a".repeat(DM_MAX_CHARS + 7))
        assertEquals(true, r != null)
        assertEquals(true, r!!.startsWith("7 characters too long"))
        assertEquals(true, r.contains("$DM_MAX_CHARS"))
        // "nothing was sent" — the whole point of refusing over truncating is
        // that the user knows the state they are in.
        assertEquals(true, r.contains("nothing was sent"))
    }

    @Test fun `one over is singular, because a wrong plural reads as a bug`() {
        assertEquals(true, dmSendRefusal("a".repeat(DM_MAX_CHARS + 1))!!.startsWith("1 character too long"))
    }

    @Test fun `an emoji draft is judged by its real length`() {
        // 1500 emoji = 3000 UTF-16 units. Under a length-based check this would
        // be refused as "1000 characters too long" while the server would have
        // happily accepted it.
        assertEquals(null, dmSendRefusal("👋".repeat(1500)))
    }
}
