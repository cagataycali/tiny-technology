package technology.tiny.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * friendlyHttpError is a pure top-level fn (no android.* deps) that maps an HTTP
 * status onto the message the chat surface actually shows. It's the last line of
 * defence against a raw "HTTP 4xx" leaking to the user, so the mapping is worth
 * pinning — especially the two codes that carry cycle-hardened intent:
 *   - 403 is OWNERSHIP, not auth: it must NOT tell the user to re-authenticate
 *     (a cycle-46 regression grouped it with 401).
 *   - 424 is the transient backend-degrade code: "try again", not "failed".
 */
class TinyApiTest {

    @Test fun `401 tells the user their session expired`() {
        assertEquals("session expired — sign out and back in from the menu", friendlyHttpError(401))
    }

    @Test fun `402 points at the wallet`() {
        assertEquals(
            "this tiny charges per message — check /wallet or top up at tiny.technology/wallet",
            friendlyHttpError(402),
        )
    }

    @Test fun `403 is ownership, not an expired session`() {
        val msg = friendlyHttpError(403)
        assertEquals("not allowed — this belongs to another account", msg)
        // Regression guard for the cycle-46 bug: 403 must never nudge the user to
        // sign in again the way 401 does.
        assertTrue("403 must not read like an auth error", !msg.contains("session"))
        assertTrue("403 must not read like an auth error", !msg.contains("sign"))
    }

    @Test fun `404 says the tiny is missing`() {
        assertEquals("that tiny doesn't exist", friendlyHttpError(404))
    }

    @Test fun `413 flags an oversized payload`() {
        assertEquals("message or attachments too large", friendlyHttpError(413))
    }

    @Test fun `424 is transient — asks to retry, never says failed`() {
        val msg = friendlyHttpError(424)
        assertEquals("backend unavailable — take a breath, try again soon", msg)
        assertTrue("424 is transient — must invite a retry", msg.contains("try again"))
    }

    @Test fun `429 is the daily limit`() {
        assertEquals("daily limit reached — try again tomorrow", friendlyHttpError(429))
    }

    @Test fun `5xx interpolates the code into the hiccup message`() {
        assertEquals("server hiccup (HTTP 500) — usually passes, try again", friendlyHttpError(500))
        assertEquals("server hiccup (HTTP 502) — usually passes, try again", friendlyHttpError(502))
        assertEquals("server hiccup (HTTP 599) — usually passes, try again", friendlyHttpError(599))
    }

    @Test fun `boundaries of the 5xx range`() {
        // 499 is below the range → generic fallback; 500 and 599 are inside; 600 is above.
        assertEquals("request failed (HTTP 499)", friendlyHttpError(499))
        assertTrue(friendlyHttpError(500).contains("server hiccup"))
        assertTrue(friendlyHttpError(599).contains("server hiccup"))
        assertEquals("request failed (HTTP 600)", friendlyHttpError(600))
    }

    @Test fun `unmapped codes fall back to the generic message with the code`() {
        assertEquals("request failed (HTTP 400)", friendlyHttpError(400))
        assertEquals("request failed (HTTP 418)", friendlyHttpError(418))
        // A 400 is distinct from 413's "too large" — make sure they don't collide.
        assertTrue(friendlyHttpError(400) != friendlyHttpError(413))
    }

    // ── droppedNote: lost-frame warning (iOS Api.swift:476 / web Chat.tsx:1363 parity) ──

    @Test fun `one dropped frame is singular — the case iOS explicitly guards`() {
        // The bug: Android used to always say "events", so a single lost frame read
        // the ungrammatical "1 stream events dropped".
        assertEquals("1 stream event dropped — this reply may be incomplete", droppedNote(1))
    }

    @Test fun `multiple dropped frames are plural`() {
        assertEquals("3 stream events dropped — this reply may be incomplete", droppedNote(3))
        assertEquals("42 stream events dropped — this reply may be incomplete", droppedNote(42))
    }

    @Test fun `the note states the consequence, not just a raw count`() {
        // Parity intent: both iOS and web tell the user the REPLY may be incomplete —
        // the count alone doesn't say why it matters.
        assertTrue("must warn the reply may be incomplete", droppedNote(2).contains("may be incomplete"))
    }

    @Test fun `the glyph is added by the renderer, not embedded here`() {
        // ChatViewModel prefixes notes with "⚠ "; embedding another would double it.
        assertTrue("droppedNote must not embed a warning glyph", !droppedNote(1).contains("⚠"))
    }
}
