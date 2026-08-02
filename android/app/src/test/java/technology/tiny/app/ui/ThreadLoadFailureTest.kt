package technology.tiny.app.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🔴 A DM thread that failed to load told two very different stories in one voice.
 *
 * After cycle 51 the thread sheet asked `LoadFailure.contentMessage`, which
 * prefers the SERVER's own words over the chat table — the right call for a list,
 * and on this one path it put the wire's vocabulary on a human surface:
 *
 *     peer not found (HTTP 404)
 *
 * "peer" is a router's word for a person. And under it sat a retry button, for a
 * request that will answer 404 forever.
 *
 * iOS split the verdict (`c7314145`). This is that split ported, and the reason it
 * keys on the BODY rather than the status is the interesting half: **two different
 * things answer 404 here.**
 *
 *  · `{error:"peer not found"}` — the worker (`messages.ts:300`) could not resolve
 *    a login. About the PERSON. Permanent, so: no retry, and say it about them.
 *  · plain-text `404 Not Found.` — the worker's router catch-all
 *    (`index.ts:228`), reached when a STALE build asks for a path that moved. A
 *    stale Next deploy for /api/messages itself answers the same way. About US.
 *
 * Keying on the bare status would print our own staleness as someone's absence.
 * The test is "did the server explain itself", which `TinyApi.executeJson` already
 * answers: it parses with `runCatching { JSONObject(text) }.getOrElse
 * { JSONObject() }`, so a plain-text body becomes an EMPTY object and `error` is
 * blank. iOS spells the same test as `Api.serverError(in:)` returning nil.
 *
 * `ContentMessageTest` owns the caption rule; this owns the verdict on top of it.
 * `tests/load-failure-caption.test.ts` owns the wiring and the render arms.
 */
class ThreadLoadFailureTest {

    /** A failed response as `executeJson` builds it: parsed body + stamped status. */
    private fun res(status: Int, json: String = "{}"): JSONObject =
        JSONObject(json).put("_status", status)

    /** A body that wasn't JSON — `getOrElse { JSONObject() }`, then the stamp. */
    private fun nonJson(status: Int): JSONObject = JSONObject().put("_status", status)

    private fun message(res: JSONObject?): String {
        val why = classifyThreadLoad(res)
        assertTrue("expected a retryable verdict, got $why", why is ThreadLoadFailure.Retryable)
        return (why as ThreadLoadFailure.Retryable).message
    }

    // ── the split itself ─────────────────────────────────────────────────────────

    @Test fun `a 404 the server explained is a person who is gone`() {
        val why = classifyThreadLoad(res(404, """{"error":"peer not found"}"""))
        assertEquals(ThreadLoadFailure.Gone, why)
    }

    @Test fun `a bare 404 is our own staleness, not their absence`() {
        // The router's plain-text `404 Not Found.` — unparseable, so no `error`.
        // Rendering this as "@someone isn't reachable any more" would accuse a
        // healthy person of leaving because THIS build is out of date.
        val why = classifyThreadLoad(nonJson(404))
        assertTrue("a bare 404 became a verdict about a person", why is ThreadLoadFailure.Retryable)
        assertEquals("couldn't load this conversation — try again (HTTP 404)", message(nonJson(404)))
    }

    @Test fun `a 404 whose explanation is only whitespace is not an explanation`() {
        // Same reason `contentMessage` trims: " " is not the server saying anything.
        for (blank in listOf("""{"error":""}""", """{"error":"   "}""", """{"error":"\n"}""")) {
            val why = classifyThreadLoad(res(404, blank))
            assertTrue("$blank was read as an explanation", why is ThreadLoadFailure.Retryable)
        }
    }

    @Test fun `the wire's word for a person never reaches the screen`() {
        // The defect this increment exists to remove, asserted at the surface: on the
        // one answer that carries it, the wire phrase must not be what is shown.
        val why = classifyThreadLoad(res(404, """{"error":"peer not found"}"""))
        assertEquals(ThreadLoadFailure.Gone, why)
        assertFalse(
            "the router's vocabulary for a person is on screen",
            peerGoneLine("ada").lowercase().contains("peer not found"),
        )
    }

    // ── the verdict's own wording ────────────────────────────────────────────────

    @Test fun `the verdict names who it is about`() {
        assertEquals("@ada isn't reachable any more.", peerGoneLine("ada"))
        assertTrue(peerGoneLine("ada").contains("ada"))
    }

    @Test fun `the verdict does not invite a retry in words either`() {
        // The button is gone (pinned in the wiring suite); the sentence must not
        // reintroduce it, or the reader goes looking for one that isn't there.
        val line = peerGoneLine("ada").lowercase()
        for (word in listOf("try again", "retry", "check your connection", "http")) {
            assertFalse("the verdict suggests '$word' for something permanent", line.contains(word))
        }
    }

    // ── every OTHER answer keeps its caption, and its button ─────────────────────

    @Test fun `a status that is not 404 never becomes a verdict, body or no body`() {
        // Only 404 means "this login does not resolve". A 500 with a body is an
        // outage; calling it absence would bury a working person for the day.
        for (status in listOf(0, 401, 402, 403, 424, 429, 500, 502, 503)) {
            val why = classifyThreadLoad(res(status, """{"error":"peer not found"}"""))
            assertTrue("HTTP $status became a permanent verdict", why is ThreadLoadFailure.Retryable)
        }
    }

    @Test fun `the retryable arm is the shared content rule, not the chat table`() {
        // ⚠️ The rungs `contentMessage` owns, checked THROUGH the verdict so the two
        // cannot drift. 401 and 5xx keep the house table (the client knows the
        // remedy); a 424 describes the transport; everything else yields to the
        // server's own words. If this arm ever reverted to `LoadFailure.message`,
        // the bare 404 above would read "that tiny doesn't exist" about a person.
        assertEquals(
            "session expired — sign out and back in from the menu",
            message(res(401, """{"error":"login required"}""")),
        )
        assertEquals("no response — check your connection", message(null))
        assertTrue(message(res(503)).contains("server hiccup (HTTP 503)"))
        assertTrue(message(res(424)).contains("backend unavailable"))
        // The server explains a 400 better than any table can.
        assertEquals("userId required (HTTP 400)", message(res(400, """{"error":"userId required"}""")))
    }

    @Test fun `an unusable 2xx is still a failure and still retryable`() {
        // A 200 that wasn't JSON carries NO `_status` — the case that used to paint
        // "no messages yet" over a live conversation. It is neither gone nor a code.
        val why = classifyThreadLoad(JSONObject())
        assertTrue("an unusable 200 became a verdict", why is ThreadLoadFailure.Retryable)
        assertEquals(
            "couldn't read this conversation — the server answered, but not with this conversation",
            message(JSONObject()),
        )
    }

    @Test fun `the retryable arm always has something to say`() {
        // `contentMessage` returns null for a load that SUCCEEDED, which this
        // function is never called on — but a Retryable holding an empty caption
        // would render a bare retry button with no reason, so the fallback is real.
        // A well-formed 200 with the array present is the one input that could.
        val loaded = JSONObject("""{"messages":[]}""")
        val why = classifyThreadLoad(loaded)
        assertTrue(why is ThreadLoadFailure.Retryable)
        assertEquals("no response — check your connection", (why as ThreadLoadFailure.Retryable).message)
        assertTrue("a retryable verdict with no words", why.message.isNotEmpty())
    }

    // ── the two arms never overlap, on any answer this path gives ────────────────

    @Test fun `every answer these routes give lands in exactly one arm`() {
        // The statuses reachable on this path: the route's own 401/503, the worker's
        // 404/500, a forwarded 4xx, and the client-side 0 and unusable-2xx.
        val answers = listOf(
            null, JSONObject(), nonJson(404), nonJson(401), nonJson(503),
            res(401, """{"error":"login required"}"""),
            res(404, """{"error":"peer not found"}"""),
            res(500, """{"error":"messages unavailable"}"""),
            res(503, """{"error":"backend unavailable"}"""),
            res(400, """{"error":"userId required"}"""),
        )
        for (a in answers) {
            when (val why = classifyThreadLoad(a)) {
                // Gone renders a sentence and no button; Retryable renders a caption
                // and a button. Neither may be empty, and no answer may be both.
                is ThreadLoadFailure.Gone -> assertEquals(404, LoadFailure.status(a))
                is ThreadLoadFailure.Retryable ->
                    assertTrue("empty caption for $a", why.message.isNotEmpty())
            }
        }
    }

    @Test fun `only one of the ten answers is permanent`() {
        // A count, so widening the verdict's reach fails here rather than quietly
        // burying more people. Only the explained 404 is about a person.
        val answers = listOf(
            null, JSONObject(), nonJson(404), nonJson(401), nonJson(503),
            res(401, """{"error":"login required"}"""),
            res(404, """{"error":"peer not found"}"""),
            res(500, """{"error":"messages unavailable"}"""),
            res(503, """{"error":"backend unavailable"}"""),
            res(400, """{"error":"userId required"}"""),
        )
        assertEquals(1, answers.count { classifyThreadLoad(it) is ThreadLoadFailure.Gone })
    }

    @Test fun `a peer who comes back is not still gone`() {
        // The state-clearing half, at the rule's level: a good load produces no
        // failure at all, so nothing keeps the verdict alive. (The `peerGone = false`
        // on success is pinned in the wiring suite.)
        assertEquals(null, LoadFailure.contentMessage(
            JSONObject("""{"messages":[]}"""), "messages", "this conversation"))
    }
}
