package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import technology.tiny.app.net.friendlyHttpError

/**
 * 🔴 `RevokeFailure` — what to say when a revoke did NOT happen. iOS
 * `RevokeFailure` (Panels.swift:3642) + web `lib/devices/revoke-message.ts` ported.
 *
 * Revoke is the devices sheet's one destructive action, and it told the reader the
 * least: `status < 400`, body discarded, and the code handed to
 * [friendlyHttpError] — the CHAT table, which words 404 as "that tiny doesn't
 * exist". Everything else collapsed to "couldn't revoke device", one sentence for a
 * rejected session, a malformed request, a refusing worker and a dropped connection
 * alike.
 *
 * Neither half said the fact that matters: **a failed revoke leaves the token
 * working.** That is what someone revoking a laptop they just lost needs to know.
 */
class RevokeFailureTest {

    /** What `DELETE /api/devices` answers on success. No `_status` — see [statusOf]. */
    private fun ok() = JSONObject().put("ok", true).put("revoked", 1)

    private fun failure(status: Int, error: String? = null) = JSONObject()
        .put("ok", false)
        .put("_status", status)
        .also { if (error != null) it.put("error", error) }

    // ── the outcome clause ──────────────────────────────────────────────────

    @Test
    fun `every failure leads with what it left behind`() {
        // The whole point of the increment, and the one sentence that is byte-shared
        // with iOS and web: the device being revoked is very often the OTHER one, so
        // this outcome is read on whichever surface is in the user's hand.
        assertEquals("Not revoked — its token still works.", RevokeFailure.lead)
        for (res in listOf(null, failure(400, "deviceId required"), failure(401), failure(424), failure(503))) {
            val m = RevokeFailure.message(res)
            assertNotNull("a failure with no message at all", m)
            assertTrue("does not lead with the outcome: $m", m!!.startsWith(RevokeFailure.lead))
            // Exactly one space joining the two clauses. The lead is a terminated
            // sentence and the reason is appended to it, so a missing separator runs
            // them together ("works.no response") and a doubled one is the gap the
            // web suite already pins — both read as a rendering bug, not a sentence.
            assertTrue("clauses not joined by one space: $m", m.startsWith(RevokeFailure.lead + " "))
            assertFalse("doubled space in the joint: $m", m.contains("  "))
        }
    }

    @Test
    fun `the old one-size sentence is gone, and so is 'try again' as the whole answer`() {
        // "couldn't revoke device" said nothing about the token, and "try again"
        // implies nothing has been decided yet — the opposite of the truth.
        val m = RevokeFailure.message(failure(400, "deviceId required"))!!
        assertFalse("the one-size sentence is back: $m", m.contains("couldn't revoke"))
    }

    // ── success, which is where Android's own convention bites ──────────────

    @Test
    fun `a real revoke says nothing`() {
        assertNull(RevokeFailure.message(ok()))
    }

    @Test
    fun `a success is not read as a lost connection`() {
        // ⚠️ The trap this rule exists to absorb: `executeJson` stamps `_status` ONLY
        // on a non-2xx, so a SUCCESSFUL revoke carries no status and
        // `optInt("_status", 0)` reads 0 — the house code for "nothing answered".
        // Defaulting to 0 here would announce a dropped connection on every
        // successful revoke, having already told the user the token still works.
        assertEquals(200, RevokeFailure.statusOf(ok()))
        assertEquals("a success was read as no-response", null, RevokeFailure.message(ok()))
        // And a request that genuinely threw really is 0.
        assertEquals(0, RevokeFailure.statusOf(null))
    }

    @Test
    fun `a 2xx that says otherwise is not a revoke`() {
        // The route's own comment: a false success "would hide a still-live device
        // token from the user", and the row is dropped optimistically on this
        // answer. The old call site defaulted `ok` to TRUE for any 2xx, so a body
        // that said `ok: false` still removed the row.
        assertNotNull("a 200 with ok:false read as a success",
            RevokeFailure.message(JSONObject().put("ok", false)))
        // …including one with no `ok` flag at all: absent is not consent.
        assertNotNull("a 200 with no ok flag read as a success",
            RevokeFailure.message(JSONObject()))
        // ⚠️ And the mirror of it. Success needs BOTH halves, so the range needs its
        // own case: the web suite learned this the hard way — pinning only the `ok`
        // half let a mutant widen the accepted range to 4xx with nothing failing,
        // while every docstring kept claiming a conjunction.
        assertNotNull("a 424 with ok:true read as a success",
            RevokeFailure.message(failure(424).put("ok", true)))
        assertNotNull("a 401 with ok:true read as a success",
            RevokeFailure.message(failure(401).put("ok", true)))
    }

    // ── the reason, for the statuses this route can actually answer ─────────

    @Test
    fun `nothing answered is not something to retry blindly`() {
        assertEquals("no response — check your connection", RevokeFailure.statusLine(0))
        // A thrown request has no body, so there is nothing to prefer over this.
        assertTrue(RevokeFailure.message(null)!!.endsWith("no response — check your connection"))
    }

    @Test
    fun `the client speaks for exactly 401, 0 and 5xx`() {
        // The house `statusOwnsTheMessage` set: the cases where the client knows
        // something the server cannot phrase. A server that says "login required"
        // on a 401 is describing the wire, not the remedy.
        assertEquals(
            "session expired — sign out and back in from the menu (HTTP 401)",
            RevokeFailure.statusLine(401, "login required"),
        )
        assertEquals("no response — check your connection", RevokeFailure.statusLine(0, "aborted"))
        assertEquals(
            "server hiccup (HTTP 503) — usually passes, try again",
            RevokeFailure.statusLine(503, "The operation was aborted due to timeout"),
        )
        // ⚠️ 503 is the route's transport-failure code and it carries
        // `String(e.message)` from the edge — which is how "The operation was
        // aborted due to timeout" landed on a person's screen on web. The status
        // owning the message is what keeps that off this one.
        assertFalse(RevokeFailure.statusLine(503, "aborted due to timeout").contains("aborted"))
        // ⚠️ The WHOLE range, from both sides. Pinning 503 alone let a mutant narrow
        // the arm to `502..599` with nothing failing — and a Worker that dies mid-request
        // answers 500, the commonest 5xx of the three, which would then have printed
        // whatever string the edge put in `error`.
        for (code in listOf(500, 501, 502, 599)) {
            assertEquals(
                "HTTP $code stopped being a server hiccup",
                "server hiccup (HTTP $code) — usually passes, try again",
                RevokeFailure.statusLine(code, "raw edge text"),
            )
        }
        // …and neither neighbour is inside it: both yield to the server.
        assertEquals("upstream said no (HTTP 499)", RevokeFailure.statusLine(499, "upstream said no"))
        assertEquals("odd (HTTP 600)", RevokeFailure.statusLine(600, "odd"))
    }

    @Test
    fun `everything else yields to the server, and keeps the code`() {
        // The server is describing THIS request; the code stays so a support
        // conversation still has it.
        assertEquals(
            "deviceId required (HTTP 400)",
            RevokeFailure.statusLine(400, "deviceId required"),
        )
        assertEquals("revoke failed (HTTP 424)", RevokeFailure.statusLine(424, "revoke failed"))
        // A blank or absent server message must not produce a dangling parenthesis
        // or an empty clause after the lead.
        assertEquals("HTTP 424", RevokeFailure.statusLine(424, null))
        assertEquals("HTTP 424", RevokeFailure.statusLine(424, "   "))
        assertTrue(RevokeFailure.message(failure(424))!!.endsWith("HTTP 424"))
    }

    @Test
    fun `the chat table's words cannot reach this sheet`() {
        // The actual defect being closed. `friendlyHttpError` is the CHAT table:
        // asked about a revoke it answers "that tiny doesn't exist" (404) or "this
        // tiny charges per message" (402) — a confident answer to a question nobody
        // asked, about a thing that is not a tiny. This route cannot return either
        // code, so neither line may be reachable from here.
        assertTrue("the fixture stopped being the chat wording",
            friendlyHttpError(404).contains("doesn't exist"))
        for (code in listOf(402, 404, 403, 413, 429)) {
            val line = RevokeFailure.statusLine(code, null)
            assertEquals("the chat table answered for HTTP $code: $line", "HTTP $code", line)
            assertFalse("chat wording reached the revoke sheet: $line",
                line.contains("tiny") || line.contains("message"))
        }
    }

    @Test
    fun `the reason is one sentence after the lead, never two verdicts`() {
        // The lead already states the outcome; a second "revoke failed" style clause
        // would be the app disagreeing with itself in one line. Exactly one period
        // (the lead's own) and no second failure verb.
        val m = RevokeFailure.message(failure(401))!!
        assertEquals("more than one sentence-ending period: $m", 1, m.count { it == '.' })
        assertFalse("a second failure verdict: $m", m.lowercase().contains("failed to"))
    }
}
