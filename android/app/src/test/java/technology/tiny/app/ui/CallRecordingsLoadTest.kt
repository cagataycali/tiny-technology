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
 * 🔴 "No calls yet" was said to people whose session had merely expired, and again
 * during a worker outage. iOS `3eca0cfe` ported — Android reached the same lie by a
 * worse road.
 *
 * GET /api/voice/sessions answers exactly three ways:
 *   200 `{ok:true, sessions:[…]}`
 *   401 `{ok:false, error:"login required"}`
 *   502 `{ok:false, error:…}`   (worker unreachable, or it answered an error)
 *
 * iOS decoded all three into a struct whose `sessions` was OPTIONAL, so both
 * refusals decoded cleanly as nil → `[]` → the empty state. Android's sheet instead
 * reached past `app.api` to a bare `HttpURLConnection`, and `conn.inputStream`
 * THROWS on a 401 or a 502 — so `runCatching { … }.getOrNull()` flattened every
 * refusal into ONE sentence, "Couldn't load calls — check your connection". Two
 * distinct server answers, one caption, and it blamed the network for an expired
 * session — sending the reader at a remedy that cannot work.
 *
 * The load now goes through `app.api.getJson`, which keeps the code as `_status`,
 * and the decode is split out here so all three answers are checkable without a
 * network. That split is the point: the old shape made the defect untestable.
 */
class CallRecordingsLoadTest {

    /** One row as the worker's VOICE_LIST_SQL returns it. */
    private fun row(
        id: String = "s1",
        status: String = "ended",
        durationMs: Long = 30_000,
        segments: Long = 4,
        tiny: String? = "ada",
    ) = JSONObject()
        .put("id", id)
        .put("status", status)
        .put("duration_ms", durationMs)
        .put("segment_count", segments)
        .apply { if (tiny != null) put("tiny_name", tiny) }

    /** A real 200 from the route. */
    private fun ok(vararg rows: JSONObject) = JSONObject()
        .put("ok", true)
        .put("sessions", JSONArray().apply { rows.forEach { put(it) } })

    /** What `executeJson` hands back for the route's 401 / 502. */
    private fun refusal(status: Int, error: String) = JSONObject()
        .put("ok", false)
        .put("error", error)
        .put("_status", status)

    // ── the defect: a refusal is not an empty archive ────────────────────────

    @Test
    fun `an expired session is not an empty archive`() {
        // The exact 401 body, and the whole point: NO rows come back, so the sheet
        // cannot reach its empty state and say "No calls yet" about someone's own
        // recordings.
        val res = refusal(401, "login required")
        assertNull("a 401 yielded rows — the empty state would claim the archive is empty",
                   CallRecordingsLoad.rows(res))
        assertNotNull(CallRecordingsLoad.message(res))
    }

    @Test
    fun `a worker outage is not an empty archive either`() {
        val res = refusal(502, "voice worker unreachable")
        assertNull(CallRecordingsLoad.rows(res))
        assertNotNull(CallRecordingsLoad.message(res))
    }

    @Test
    fun `the two refusals no longer share one caption`() {
        // ⚠️ THE ANDROID DEFECT. The bypass collapsed 401 and 502 into the same
        // sentence, so the screen could not tell an expired session from an outage —
        // and the remedies are opposite ones.
        val expired = CallRecordingsLoad.message(refusal(401, "login required"))!!
        val outage = CallRecordingsLoad.message(refusal(502, "voice worker unreachable"))!!
        assertFalse("401 and 502 still read the same: $expired", expired == outage)
        // And neither blames the connection, which is what the old single line did.
        assertFalse("still blames the connection: $expired", expired.contains("connection"))
        // The words come from the shared table, not a seventh copy.
        assertEquals(friendlyHttpError(401), expired)
        assertEquals(friendlyHttpError(502), outage)
    }

    @Test
    fun `nothing answered still says so, and says it once`() {
        // A thrown request (airplane mode, DNS) really is the connection — and that
        // is the ONE case the old sentence was right about. It keeps the house line,
        // byte-shared with the other six sheets.
        assertNull(CallRecordingsLoad.rows(null))
        assertEquals(LoadFailure.noResponse, CallRecordingsLoad.message(null))
        // Not two causes in one breath — the defect iOS's own commit named.
        assertFalse(CallRecordingsLoad.message(null)!!.contains(" or network"))
    }

    @Test
    fun `a 200 that was not JSON is not an empty archive`() {
        // The other half of the collapse (e24f07bf): a 200 whose body isn't JSON
        // becomes an empty JSONObject with no `_status` at all. Shape check, not
        // status check, is what catches it.
        val nonJson200 = JSONObject()
        assertNull(CallRecordingsLoad.rows(nonJson200))
        val m = CallRecordingsLoad.message(nonJson200)!!
        assertTrue("does not name what failed: $m", m.contains("your call recordings"))
        assertFalse("blames the connection for a body that arrived: $m", m.contains("connection"))
    }

    @Test
    fun `a 200 whose body says otherwise is a failure`() {
        // `ok` is checked, not assumed. An intermediary between the app and the
        // worker is exactly what pairs a 200 with a body that refuses — iOS made
        // `ok` non-optional for this; Android has to ask.
        val res = JSONObject().put("ok", false).put("sessions", JSONArray())
        assertNull("a 2xx saying ok:false was read as a good, empty load",
                   CallRecordingsLoad.rows(res))
        // And the wording, not merely that one exists: this is the ONE path that
        // reaches the `?:` fallback, so nothing else pins its sentence. A mutant that
        // made it `unusableBody("it")` survived the first run — "couldn't read it" on
        // a screen full of recordings names nothing at all.
        val m = CallRecordingsLoad.message(res)!!
        assertEquals(LoadFailure.unusableBody("your call recordings"), m)
        assertTrue("does not name what failed: $m", m.contains("your call recordings"))
    }

    // ── and the fix must not just move the lie ───────────────────────────────

    @Test
    fun `a real empty archive is still allowed to say empty`() {
        // The fix is NOT "never say empty". A genuine 200 with no rows must still
        // reach the empty state, or the screen just relocates the lie.
        val rows = CallRecordingsLoad.rows(ok())
        assertNotNull(rows)
        assertTrue(rows!!.isEmpty())
        assertNull("a good empty load produced a caption", CallRecordingsLoad.message(ok()))
    }

    @Test
    fun `a real archive comes back mapped`() {
        val rows = CallRecordingsLoad.rows(ok(row(id = "a"), row(id = "b", tiny = null)))!!
        assertEquals(listOf("a", "b"), rows.map { it.id })
        assertEquals("ada", rows[0].tiny)
        // A row with no name is still playable — "tiny" rather than a blank button.
        assertEquals("tiny", rows[1].tiny)
        assertEquals(30_000L, rows[0].durationMs)
    }

    // ── the filter, which the port had to carry across unchanged ─────────────

    @Test
    fun `only finished calls with real audio are listed`() {
        // Live calls 409 on stitch; sub-2s pocket dials and zero-segment rows have no
        // audio journaled at all (outage casualties — their stitch 404s). Each
        // exclusion is a row that would render a play button that cannot play.
        val res = ok(
            row(id = "live", status = "live"),
            row(id = "short", durationMs = 1_500),
            row(id = "silent", segments = 0),
            row(id = "good"),
            row(id = "errored", status = "error"),
        )
        val ids = CallRecordingsLoad.rows(res)!!.map { it.id }
        assertEquals(listOf("good", "errored"), ids)
    }

    @Test
    fun `a boundary duration is excluded, not rounded in`() {
        // `> 2_000`, not `>=`: exactly 2s is still a pocket dial. Pinned because a
        // comparison is the easiest thing to loosen by one character.
        assertTrue(CallRecordingsLoad.rows(ok(row(durationMs = 2_000)))!!.isEmpty())
        assertEquals(1, CallRecordingsLoad.rows(ok(row(durationMs = 2_001)))!!.size)
    }

    @Test
    fun `a malformed row is skipped, not fatal`() {
        // The array is the server's; one bad element must not lose the calls around
        // it. `getJSONObject` used to throw here, inside the runCatching — so a
        // single junk row emptied the whole archive AND blamed the connection.
        val arr = JSONArray().apply {
            put(row(id = "first"))
            put("not an object")
            put(row(id = "last"))
        }
        val res = JSONObject().put("ok", true).put("sessions", arr)
        assertEquals(listOf("first", "last"), CallRecordingsLoad.rows(res)!!.map { it.id })
    }

    @Test
    fun `a sessions key that is not an array is a failure, not an empty archive`() {
        // ⚠️ `has("sessions")` and "sessions is a list" are DIFFERENT questions, and
        // both survivors of the first mutation run lived in the gap. The route does
        // `sessions: res?.sessions || []` — the worker's value passes straight
        // through — so an object or a string arrives as a 200 with the key present.
        // The shape check says yes; `optJSONArray` still returns null.
        for (bad in listOf(JSONObject().put("count", 3), "none", 7)) {
            val res = JSONObject().put("ok", true).put("sessions", bad)
            assertNull("a non-array `sessions` ($bad) read as an empty archive",
                       CallRecordingsLoad.rows(res))
            val m = CallRecordingsLoad.message(res)
            assertNotNull("a non-array `sessions` ($bad) produced no caption", m)
            // The body arrived and parsed, so the caption must name the subject
            // rather than blame the connection or show a bare 200.
            assertTrue("does not name what failed: $m", m!!.contains("your call recordings"))
            assertFalse("blames the connection: $m", m.contains("connection"))
        }
    }

    @Test
    fun `an absent ok is not taken for consent`() {
        // `optBoolean("ok")` defaults to FALSE, and that is deliberate: a 200 whose
        // body never claimed success isn't the documented shape, and defaulting the
        // other way makes every unrecognised body a good load. Survived until pinned.
        val res = JSONObject().put("sessions", JSONArray())
        assertNull(CallRecordingsLoad.rows(res))
        assertNotNull(CallRecordingsLoad.message(res))
    }

    @Test
    fun `a body with no sessions key at all is a failure, not an empty list`() {
        // An absent key is not an empty array. This is the shape that made two of the
        // route's three answers read as "your recordings are gone".
        val res = JSONObject().put("ok", true)
        assertNull(CallRecordingsLoad.rows(res))
        assertNotNull(CallRecordingsLoad.message(res))
    }

    @Test
    fun `rows and caption never both exist, and never both miss`() {
        // The two halves cannot disagree: exactly one of "here are the rows" and
        // "here is why not" is true for every answer the route can give.
        val answers = listOf(
            null,
            JSONObject(),
            refusal(401, "login required"),
            refusal(502, "worker down"),
            JSONObject().put("ok", false).put("sessions", JSONArray()),
            JSONObject().put("ok", true),
            ok(),
            ok(row()),
        )
        for (res in answers) {
            val rows = CallRecordingsLoad.rows(res)
            val msg = CallRecordingsLoad.message(res)
            assertTrue("rows and caption disagree for $res", (rows == null) == (msg != null))
        }
    }
}
