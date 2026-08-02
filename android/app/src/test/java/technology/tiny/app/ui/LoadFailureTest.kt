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
 * 🔴 `LoadFailure` — why a list sheet is empty, and whether it may say "empty" at
 * all. iOS `LoadFailure` (Api.swift:55) ported, plus the arm iOS cannot have.
 *
 * Six sheets load a list over the relay and each carries a comment swearing it
 * keeps "it failed" distinct from "there is nothing": My Devices, Jobs, Memory,
 * the memory graph, Activity, Messages.
 *
 * On one input all six broke that promise, silently. `executeJson` parses with
 * `runCatching { JSONObject(text) }.getOrElse { JSONObject() }` and stamps
 * `_status` **only on a non-2xx**, so a 200 whose body is not JSON becomes an
 * EMPTY JSONObject with no status: `res != null`, status reads as a success, the
 * old `status >= 400` guard passes, the array is absent, and the sheet paints a
 * confident "No devices yet" over a fleet that exists. A mid-redeploy HTML error
 * page served with a 200 is the everyday way that happens.
 *
 * iOS reaches the same case by a different road — `JSONSerialization` THROWS, so
 * its rule catches an NSCocoaError. Android's parse was already defused, so the
 * check has to be positive: a 2xx must CONTAIN the shape it promised.
 */
class LoadFailureTest {

    /** A real 200 from one of these routes: `ok`, and the array it promised. */
    private fun ok(key: String = "devices", n: Int = 2) = JSONObject()
        .put("ok", true)
        .put(key, JSONArray().apply { repeat(n) { put(JSONObject().put("id", "d$it")) } })

    /** A genuinely empty list — a success, and NOT a failure. */
    private fun empty(key: String = "devices") = JSONObject()
        .put("ok", true)
        .put(key, JSONArray())

    /** What `executeJson` produces for a non-2xx: the body plus `_status`. */
    private fun httpError(status: Int) = JSONObject()
        .put("ok", false)
        .put("error", "login required")
        .put("_status", status)

    /**
     * ⚠️ What `executeJson` produces for a 200 that wasn't JSON: an EMPTY object.
     * No `_status` (only non-2xx gets one), no keys at all. This is the input the
     * whole rule exists for.
     */
    private fun nonJson200() = JSONObject()

    // ── the arm iOS does not have ────────────────────────────────────────────

    @Test
    fun `a 200 that was not JSON is a failure, not an empty list`() {
        // The silent-empty collapse, on the exact object `executeJson` hands back.
        assertFalse(LoadFailure.loadedOk(nonJson200(), "devices"))
        assertNull(LoadFailure.loaded(nonJson200(), "devices"))
        assertNotNull(
            "a non-JSON 200 read as a successful load — the sheet would say 'none yet'",
            LoadFailure.message(nonJson200(), "devices", "your devices"),
        )
    }

    @Test
    fun `the reason for an unusable body blames neither the connection nor a code`() {
        // The bytes ARRIVED, so "check your connection" points at the wrong thing;
        // and the status is 200, the one code that must never appear under a retry
        // button. So this case gets its own sentence, naming the sheet's subject.
        val m = LoadFailure.message(nonJson200(), "devices", "your devices")!!
        assertFalse("blames the connection: $m", m.contains("connection"))
        assertFalse("shows a bare 200 to a person: $m", m.contains("200"))
        assertTrue("does not name what failed to load: $m", m.contains("your devices"))
        assertEquals(LoadFailure.unusableBody("your devices"), m)
    }

    @Test
    fun `an empty list is a real empty and says nothing`() {
        // The other half of the point: this rule must not turn every empty sheet
        // into an error. A present-but-empty array is a successful load.
        assertTrue(LoadFailure.loadedOk(empty(), "devices"))
        assertNotNull(LoadFailure.loaded(empty(), "devices"))
        assertNull(LoadFailure.message(empty(), "devices", "your devices"))
        // And a populated one, obviously.
        assertNull(LoadFailure.message(ok(), "devices", "your devices"))
    }

    @Test
    fun `a body carrying an error shape instead of the array is a failure`() {
        // A 200 whose body is well-formed JSON but the WRONG json — an error
        // envelope from a proxy, say. The array it promised is absent either way.
        val wrong = JSONObject().put("ok", false).put("error", "nope")
        assertNull(LoadFailure.loaded(wrong, "devices"))
        assertNotNull(LoadFailure.message(wrong, "devices", "your devices"))
    }

    @Test
    fun `a failure that ships the key anyway is still a failure`() {
        // ⚠️ Both halves of the check are load-bearing, and this is why. Two of these
        // routes answer their 401 with the array PRESENT and empty:
        //   /api/jobs      → { jobs: [], runs: [], error: 'login required' }  401
        //   /api/learnings → { learnings: [], error: 'login required' }       401
        // A shape check alone would read those as a good, empty load and print
        // "No jobs yet" to a signed-out user — the same masked-empty defect, arrived
        // at from the other side. Found by a surviving mutant that deleted the
        // status line and stayed green.
        for (key in listOf("jobs", "learnings")) {
            val res = httpError(401).put(key, JSONArray())
            assertFalse("a 401 carrying an empty $key read as a load", LoadFailure.loadedOk(res, key))
            assertNull(LoadFailure.loaded(res, key))
            assertEquals(
                "a 401 that shipped $key lost its caption",
                friendlyHttpError(401),
                LoadFailure.message(res, key, "your $key"),
            )
        }
        // And the check is `== 200`, not `< 400`: /api/jobs forwards the worker's own
        // status verbatim (`new Response(await res.text(), { status: res.status })`),
        // so a 3xx OkHttp couldn't follow arrives stamped, with the worker's body. A
        // `>= 400` guard would call that a good empty load; only a 200 is one.
        val redirect = JSONObject().put("_status", 302).put("jobs", JSONArray())
        assertFalse("a 302 read as a load", LoadFailure.loadedOk(redirect, "jobs"))
        assertNotNull(LoadFailure.message(redirect, "jobs", "your jobs"))
    }

    @Test
    fun `the key must be the one the sheet actually reads`() {
        // A rule keyed on the wrong name would call every good load a failure —
        // the mirror of the bug, and just as invisible from the guard.
        assertNull(LoadFailure.loaded(ok("jobs"), "devices"))
        assertNotNull(LoadFailure.loaded(ok("jobs"), "jobs"))
    }

    @Test
    fun `Memory accepts either name the route has answered under`() {
        // /api/learnings has answered under `learnings` and `memories`, and the
        // reader takes either — so a rule that knew only one would report a failure
        // on a perfectly good load the day the other came back.
        assertNotNull(LoadFailure.loaded(ok("learnings"), "learnings", alt = "memories"))
        assertNotNull(LoadFailure.loaded(ok("memories"), "learnings", alt = "memories"))
        assertNull(LoadFailure.message(ok("memories"), "learnings", "your memories", alt = "memories"))
        // …and the alt is not a wildcard: some third name is still a failure.
        assertNotNull(LoadFailure.message(ok("facts"), "learnings", "your memories", alt = "memories"))
    }

    // ── status, and the trap it shares with RevokeFailure ────────────────────

    @Test
    fun `a success is not read as a lost connection`() {
        // ⚠️ Same trap as RevokeFailure.statusOf and the same fix: `_status` is
        // stamped ONLY on a non-2xx, so an absent one means 2xx — not 0, the house
        // code for "nothing answered". Defaulting to 0 would have every successful
        // load report a dropped connection.
        assertEquals(200, LoadFailure.status(ok()))
        assertEquals(200, LoadFailure.status(nonJson200()))
        // A request that genuinely threw really is 0.
        assertEquals(0, LoadFailure.status(null))
        assertEquals(401, LoadFailure.status(httpError(401)))
    }

    @Test
    fun `nothing answered says so, in words the table does not have`() {
        // ⚠️ Android's table has NO 0 arm — asked, it answers "request failed
        // (HTTP 0)": a bare code naming a status that never existed. So the house
        // line is used, byte-shared with RevokeFailure's 0 case.
        assertEquals(LoadFailure.noResponse, LoadFailure.message(null, "devices", "your devices"))
        assertEquals(RevokeFailure.statusLine(0), LoadFailure.noResponse)
        assertFalse(
            "the table was asked about status 0",
            LoadFailure.noResponse == friendlyHttpError(0),
        )
        assertFalse("shows a bare HTTP 0", LoadFailure.noResponse.contains("0"))
    }

    @Test
    fun `a real HTTP status yields to the shared table, not a new sentence`() {
        // The table is the one iOS's httpMessage is a copy of; a sixth wording is
        // how the app got the "Login required or network error" caption in the
        // first place. 401/424/503 are what these five GET routes actually answer.
        for (status in listOf(401, 424, 503)) {
            assertEquals(
                "status $status stopped using the shared table",
                friendlyHttpError(status),
                LoadFailure.message(httpError(status), "devices", "your devices"),
            )
        }
    }

    @Test
    fun `no caption offers the reader two causes at once`() {
        // The defect iOS's commit names: "Login required or network error" — two
        // mutually exclusive causes with opposite remedies, the app committing to
        // neither. Every line this rule can produce names exactly one.
        val captions = listOf(
            LoadFailure.message(null, "devices", "your devices"),
            LoadFailure.message(nonJson200(), "devices", "your devices"),
            LoadFailure.message(httpError(401), "devices", "your devices"),
            LoadFailure.message(httpError(503), "devices", "your devices"),
        )
        for (c in captions) {
            assertNotNull(c)
            assertFalse("offers two causes: $c", c!!.contains(" or network"))
            // And no wire phrase: "login required" is what the worker says to a
            // machine. The table's 401 line is the human version.
            assertFalse("prints the worker's wire phrase: $c", c.lowercase().contains("login required"))
        }
    }

    @Test
    fun `a failed load never returns a body for the sheet to read`() {
        // The two halves cannot disagree: whenever there is a caption there is no
        // body, so no sheet can show a failure and a list at the same time. This is
        // why `loaded` returns the validated object instead of the caller
        // smart-casting its own response.
        for (res in listOf(null, nonJson200(), httpError(401), JSONObject().put("ok", false))) {
            val body = LoadFailure.loaded(res, "devices")
            val msg = LoadFailure.message(res, "devices", "your devices")
            assertTrue(
                "body and caption disagree for $res",
                (body == null) == (msg != null),
            )
        }
        // …and on success, exactly the object the caller may read.
        val good = ok()
        assertEquals(good, LoadFailure.loaded(good, "devices"))
        assertNull(LoadFailure.message(good, "devices", "your devices"))
    }
}
