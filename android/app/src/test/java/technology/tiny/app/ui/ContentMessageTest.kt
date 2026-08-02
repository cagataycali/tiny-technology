package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.net.friendlyHttpError

/**
 * 🔴 The chat table stays in the chat. iOS `Api.contentMessage` (`d71b1ff3`) ported
 * — and the defect was in MY OWN rule, landed two cycles earlier.
 *
 * `friendlyHttpError` is the CHAT table: it words 404 as "that tiny doesn't exist"
 * and 402 as "this tiny charges per message". c49's [LoadFailure.message] handed
 * every one of the eight content loads straight to it. [RevokeFailure], landed the
 * cycle BEFORE that, refuses the same table in so many words — "two of that table's
 * entries would actively lie here" — so the app already knew.
 *
 * ⚠️ It is REACHABLE, and the chain is the reason this suite exists:
 *   worker `messages.ts:300` → `404 {error:"peer not found"}`
 *   `/api/messages` route.ts:34 forwards the worker's status VERBATIM
 *   `Messages.kt:251` thread load → the caption
 * So opening a thread with a peer the worker can no longer resolve said "that tiny
 * doesn't exist" — about a person whose conversation was on screen. `/api/jobs:21`
 * and `/api/graph:31` forward verbatim too.
 *
 * ⚠️ And Android discarded the better answer it already had. `executeJson` keeps the
 * server's body (`TinyApi.kt:429`), so `{error:"peer not found"}` ARRIVED and the
 * old rule read only the number. iOS's `httpMessage` has always preferred the
 * server's words; that missing rung is Android-only, and it is fixed here too.
 */
class ContentMessageTest {

    /** A real 200 from one of these routes. */
    private fun ok(key: String = "devices") = JSONObject()
        .put("ok", true)
        .put(key, JSONArray().put(JSONObject().put("id", "d1")))

    /** What `executeJson` produces for a non-2xx: the server's body plus `_status`. */
    private fun httpError(status: Int, error: String? = null) = JSONObject()
        .put("ok", false)
        .apply { if (error != null) put("error", error) }
        .put("_status", status)

    // ── the defect ───────────────────────────────────────────────────────────

    @Test
    fun `a peer the worker cannot resolve is not a tiny that does not exist`() {
        // ⚠️ THE DEFECT, on the exact body the chain above delivers. The old caption
        // was "that tiny doesn't exist" — about a person whose thread is open.
        val res = httpError(404, "peer not found")
        val m = LoadFailure.contentMessage(res, "messages", "this conversation")!!
        assertFalse("still answers with the chat table: $m", m == friendlyHttpError(404))
        assertFalse("still says a tiny doesn't exist: $m", m.contains("doesn't exist"))
        // The server described THIS request, so its words win — with the code kept
        // so a support conversation still has it.
        assertEquals("peer not found (HTTP 404)", m)
    }

    @Test
    fun `a paywall meant for chat is not shown over a list`() {
        // 402's table line is "this tiny charges per message". On a devices list that
        // is a confident answer to a question nobody asked.
        val m = LoadFailure.contentMessage(httpError(402), "devices", "your devices")!!
        assertFalse("shows a chat paywall over a list: $m", m.contains("charges per message"))
        assertFalse(m == friendlyHttpError(402))
        // No body to prefer, so: what the app knows, and nothing more.
        assertEquals("couldn't load your devices — try again (HTTP 402)", m)
    }

    @Test
    fun `a bare router 404 falls back to the code, not to the table`() {
        // The worker's router-level `404 Not Found.` reached by a stale build sends no
        // JSON error at all — the case iOS's comment names. The app knows the load
        // failed and knows the number; it does NOT know that a tiny is missing.
        for (res in listOf(httpError(404), httpError(404, "   "))) {
            val m = LoadFailure.contentMessage(res, "messages", "this conversation")!!
            assertEquals("couldn't load this conversation — try again (HTTP 404)", m)
            assertFalse("blames the connection: $m", m.contains("connection"))
            assertTrue("does not name what failed: $m", m.contains("this conversation"))
        }
    }

    // ── but the table is RIGHT where it describes the transport ───────────────

    @Test
    fun `a status that owns its meaning keeps the shared table`() {
        // ⚠️ The fix is NOT "stop using the table". 401's remedy is the account menu,
        // which only the app knows; a 5xx server's own words about being broken are
        // not the useful part; and 424 describes the TRANSPORT ("backend
        // unavailable"), not a tiny. Overriding these would throw away the one thing
        // the table is for. The server sends `error` on all of them and it must NOT win.
        for (status in listOf(401, 500, 502, 503, 599, 424)) {
            val res = httpError(status, "login required")
            assertEquals(
                "status $status stopped using the shared table",
                friendlyHttpError(status),
                LoadFailure.contentMessage(res, "devices", "your devices"),
            )
        }
    }

    @Test
    fun `the owning set is exactly 401, 0 and 5xx`() {
        // iOS `Api.statusOwnsTheMessage` parity, asserted directly so the two clients
        // cannot drift. 424 is handled beside it, not inside it — it is not a status
        // whose meaning the CLIENT knows, it is one whose table line happens to
        // describe the transport.
        assertTrue(LoadFailure.statusOwnsTheMessage(401))
        assertTrue(LoadFailure.statusOwnsTheMessage(0))
        for (s in listOf(500, 502, 503, 599)) assertTrue("$s should own", LoadFailure.statusOwnsTheMessage(s))
        for (s in listOf(400, 402, 403, 404, 413, 424, 429, 499, 600)) {
            assertFalse("$s should NOT own its message", LoadFailure.statusOwnsTheMessage(s))
        }
    }

    @Test
    fun `a 400 yields to the server, whose words beat the table's bare code`() {
        // The clearest case for preferring the body: the table's best for 400 is
        // literally "request failed (HTTP 400)". The worker answers a handle it
        // refuses to look up with `400 {error:"invalid login"}` — a permanent verdict
        // that the table would have dressed as a generic failure.
        val m = LoadFailure.contentMessage(httpError(400, "invalid login"), "threads", "your messages")!!
        assertEquals("invalid login (HTTP 400)", m)
        assertFalse(m == friendlyHttpError(400))
    }

    @Test
    fun `429 and 413 keep the table when the server says nothing`() {
        // These two the table words WELL and route-independently ("daily limit
        // reached", "too large"), but they are not in the owning set — so with no
        // body they reach the fallback. That is the honest trade: the fallback names
        // the subject and the code, and never asserts a cause. Pinned so the
        // behaviour is a decision on record rather than an accident.
        val m = LoadFailure.contentMessage(httpError(429), "jobs", "your jobs")!!
        assertEquals("couldn't load your jobs — try again (HTTP 429)", m)
        // And when the server DOES explain, its explanation wins.
        assertEquals(
            "daily limit reached — try again tomorrow (HTTP 429)",
            LoadFailure.contentMessage(httpError(429, "daily limit reached — try again tomorrow"), "jobs", "your jobs"),
        )
    }

    // ── everything c49 established must survive the override ─────────────────

    @Test
    fun `a successful load still says nothing at all`() {
        // The rule cannot invent a caption for a load that happened, or every sheet
        // shows an error over its own content.
        assertNull(LoadFailure.contentMessage(ok(), "devices", "your devices"))
        val realEmpty = JSONObject().put("ok", true).put("devices", JSONArray())
        assertNull("a real empty load gained a caption", LoadFailure.contentMessage(realEmpty, "devices", "your devices"))
    }

    @Test
    fun `nothing answered still says so, and never yields to a body`() {
        // Status 0 is in the owning set BECAUSE there is no body to prefer — and the
        // house line, byte-shared with RevokeFailure, is the one the table lacks.
        assertEquals(LoadFailure.noResponse, LoadFailure.contentMessage(null, "devices", "your devices"))
        assertEquals(RevokeFailure.statusLine(0), LoadFailure.contentMessage(null, "devices", "your devices"))
    }

    @Test
    fun `a 200 that was not JSON keeps its own sentence`() {
        // c49's arm, which has no status to word: the bytes arrived and weren't the
        // shape promised. `unusableBody`, not the table (whose only answer would be a
        // bare 200) and not the connection (which plainly worked).
        val m = LoadFailure.contentMessage(JSONObject(), "devices", "your devices")!!
        assertEquals(LoadFailure.unusableBody("your devices"), m)
        assertFalse("shows a bare 200: $m", m.contains("200"))
    }

    @Test
    fun `a 302 is still a failure, and does not reach the server-words rung`() {
        // /api/jobs forwards the worker's status verbatim, so a 3xx OkHttp couldn't
        // follow arrives stamped with a real body. It is `< 400`, so it keeps c49's
        // unusable-body sentence rather than quoting a redirect's error string.
        val res = JSONObject().put("_status", 302).put("error", "moved").put("jobs", JSONArray())
        val m = LoadFailure.contentMessage(res, "jobs", "your jobs")!!
        assertEquals(LoadFailure.unusableBody("your jobs"), m)
    }

    @Test
    fun `a failure that ships the key anyway still gets its caption`() {
        // /api/jobs and /api/learnings answer their 401 with the array PRESENT and
        // empty. 401 owns its message, so the table's human line survives the override.
        for (key in listOf("jobs", "learnings")) {
            val res = httpError(401, "login required").put(key, JSONArray())
            assertEquals(friendlyHttpError(401), LoadFailure.contentMessage(res, key, "your $key"))
        }
    }

    @Test
    fun `no caption offers two causes, prints a wire phrase, or blames the wrong thing`() {
        // c49's invariants, re-asserted across the NEW rung: a server string is
        // quoted verbatim, so this is where the worker's machine-facing wording could
        // leak onto a screen. `login required` is the phrase to watch — and 401,
        // where the worker sends it, is exactly why 401 is in the owning set.
        val all = listOf(
            LoadFailure.contentMessage(null, "devices", "your devices"),
            LoadFailure.contentMessage(JSONObject(), "devices", "your devices"),
            LoadFailure.contentMessage(httpError(401, "login required"), "devices", "your devices"),
            LoadFailure.contentMessage(httpError(404, "peer not found"), "messages", "this conversation"),
            LoadFailure.contentMessage(httpError(402), "devices", "your devices"),
            LoadFailure.contentMessage(httpError(503, "worker down"), "jobs", "your jobs"),
        )
        for (c in all) {
            assertNotNull(c)
            assertFalse("offers two causes: $c", c!!.contains(" or network"))
            assertFalse("prints the worker's wire phrase: $c", c.lowercase().contains("login required"))
            assertFalse("still words a list failure as a chat: $c", c.contains("doesn't exist"))
            assertFalse("still words a list failure as a paywall: $c", c.contains("charges per message"))
        }
    }

    @Test
    fun `body and caption never disagree, on every answer these routes give`() {
        // The biconditional c50 learned to write for every load rule: exactly one of
        // "here is the body" and "here is why not" is true. A gate the override could
        // silently break by returning a caption for a good load.
        val answers = listOf(
            null,
            JSONObject(),
            ok(),
            JSONObject().put("ok", true).put("devices", JSONArray()),
            httpError(401, "login required"),
            httpError(402),
            httpError(404, "peer not found"),
            httpError(424, "registry not deployed"),
            httpError(503, "worker down"),
            JSONObject().put("_status", 302).put("devices", JSONArray()),
        )
        for (res in answers) {
            val body = LoadFailure.loaded(res, "devices")
            val msg = LoadFailure.contentMessage(res, "devices", "your devices")
            assertTrue("body and caption disagree for $res", (body == null) == (msg != null))
        }
    }

    @Test
    fun `the override changes only the rung where the table lies`() {
        // ⚠️ `contentMessage` DELEGATES to `message` and overrides one rung, so the
        // two can never drift on status 0, an unusable 2xx, or an owning status. This
        // asserts that relationship directly: identical everywhere the table is
        // honest, different exactly where it is not.
        val sameEverywhere = listOf(null, JSONObject(), ok(), httpError(401, "x"),
                                    httpError(503, "x"), httpError(424, "x"))
        for (res in sameEverywhere) {
            assertEquals(
                "the two rules drifted for $res",
                LoadFailure.message(res, "devices", "your devices"),
                LoadFailure.contentMessage(res, "devices", "your devices"),
            )
        }
        for (res in listOf(httpError(404, "peer not found"), httpError(402), httpError(400, "invalid login"))) {
            assertFalse(
                "the override stopped applying for $res",
                LoadFailure.message(res, "devices", "your devices") ==
                    LoadFailure.contentMessage(res, "devices", "your devices"),
            )
        }
    }
}
