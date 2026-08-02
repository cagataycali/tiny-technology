package technology.tiny.app.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🔴 The phone read back 0% of its own recordings.
 *
 * `PhoneRecorder` files every take to `POST /api/devices/transcript` — the Record
 * button, a wake word, the agent's `nicla_voice_record` envelope — and until
 * `TranscriptsSheet` existed nothing in this app ever asked for one back. Every
 * other link was whole: the worker stores up to 16KB, `/transcript/list` returns
 * previews with `chars`/`truncated`, `/transcript?id=` returns the full text, and
 * the agent's own tool reads them. **The agent could quote a memo back that the
 * phone which recorded it could not show you.**
 *
 * iOS's version of this bug (`73e11eb4`) was subtler and worth stating, because it
 * is what these tests are mostly about: it DID fetch the list, and then stored the
 * 200-char `preview` as the row's text. A 120s memo is ~1700 characters, so a
 * refreshed row showed ~12% of it and **looked exactly like a complete short
 * transcript — truncated text and short text are the same pixels.**
 *
 * These are the pure halves, all of which a JVM test can reach: which answers are a
 * list and which are a refusal, when a row is only a preview, and the two lines the
 * row shows about its own size. The Compose wiring (the ellipsis, the hydrate-on-
 * appear, the retry rail, sharing only what is on screen) is pinned in
 * `tests/android-transcripts-readback.test.ts`.
 */
class TranscriptsLoadTest {

    // ── helpers ─────────────────────────────────────────────────────────────────

    private fun listBody(vararg rows: JSONObject): JSONObject {
        val arr = JSONArray()
        rows.forEach { arr.put(it) }
        return JSONObject().put("ok", true).put("transcripts", arr)
    }

    /** A list row exactly as `TRANSCRIPT_LIST_SQL` shapes it. */
    private fun listRow(
        id: String = "tr-1",
        label: String = "memo",
        preview: String = "hello",
        chars: Int = 5,
        truncated: Boolean = false,
        durationS: Int = 12,
        created: Long = 1_780_000_000L,
    ): JSONObject = JSONObject()
        .put("id", id).put("label", label).put("preview", preview)
        .put("chars", chars).put("truncated", truncated)
        .put("duration_s", durationS).put("created", created)

    /** `_status` is stamped by `TinyApi.executeJson` on a non-2xx, and only then. */
    private fun failure(status: Int, error: String? = null): JSONObject {
        val o = JSONObject().put("ok", false).put("_status", status)
        error?.let { o.put("error", it) }
        return o
    }

    // ── which answers are a list ────────────────────────────────────────────────

    @Test fun `a clean list is a list`() {
        val rows = TranscriptsLoad.rows(listBody(listRow(), listRow(id = "tr-2")))
        assertEquals(2, rows?.size)
        assertEquals("tr-1", rows?.first()?.id)
    }

    @Test fun `an empty archive is an empty list, not a failure`() {
        // The one case that legitimately shows "No transcripts yet".
        val rows = TranscriptsLoad.rows(JSONObject().put("ok", true).put("transcripts", JSONArray()))
        assertNotNull(rows)
        assertEquals(0, rows?.size)
        assertNull("an empty list has nothing to explain", TranscriptsLoad.message(
            JSONObject().put("ok", true).put("transcripts", JSONArray())))
    }

    @Test fun `every refusal is a failure, never an empty archive`() {
        // ⚠️ THE COLLAPSE this split exists to prevent: `optJSONArray` returns null on
        // each of these bodies, and a sheet that read it as a list would tell someone
        // their own recordings don't exist.
        for (res in listOf(
            null,                                                   // nothing answered
            failure(401, "login required"),                         // the proxy's own 401
            failure(424, "registry unreachable"),                   // worker unreachable
            failure(404, "transcripts unavailable"),                // route not deployed
            failure(500),
            JSONObject(),                                           // a 200 that wasn't JSON
            JSONObject().put("ok", false).put("transcripts", JSONArray()), // 2xx saying no
            JSONObject().put("ok", true),                           // 2xx missing the key
            JSONObject().put("ok", true).put("transcripts", "nope"), // 2xx, wrong type
        )) {
            assertNull("this answer is not a list: $res", TranscriptsLoad.rows(res))
        }
    }

    @Test fun `rows and a reason never both exist, and never both miss`() {
        // ⚠️ The invariant the sheet's two arms rest on. Neither → a spinner that never
        // stops; both → a failure caption over a list.
        for (res in listOf(
            null,
            failure(401, "login required"),
            failure(424, "registry unreachable"),
            failure(404),
            JSONObject(),
            JSONObject().put("ok", false).put("transcripts", JSONArray()),
            JSONObject().put("ok", true).put("transcripts", "nope"),
            JSONObject().put("ok", true).put("transcripts", JSONArray()),
            listBody(listRow()),
        )) {
            val rows = TranscriptsLoad.rows(res)
            val why = TranscriptsLoad.message(res)
            assertTrue(
                "exactly one of rows/message must exist for $res",
                (rows == null) != (why == null),
            )
        }
    }

    @Test fun `a non-2xx that carries a list is still a failure`() {
        // ⚠️ The status wins over the body's shape, and nothing else here pins that:
        // every other refusal is ALSO caught by the `ok:false` check, so the shared
        // `loaded()` rule looks redundant until a proxy answers 500 with a stale or
        // cached list. Rendering that as the archive would show yesterday's takes
        // under no indication anything went wrong.
        val res = JSONObject().put("_status", 500).put("ok", true)
            .put("transcripts", JSONArray().put(listRow()))
        assertNull(TranscriptsLoad.rows(res))
        assertNotNull(TranscriptsLoad.message(res))
    }

    @Test fun `an expired session does not read as a dropped connection`() {
        // The whole point of routing through the shared rule: 401 keeps the client's
        // own words (only the app knows the remedy is the account menu), while a 424
        // keeps the table's transport sentence.
        val why = TranscriptsLoad.message(failure(401, "login required"))
        assertNotNull(why)
        assertFalse("a 401 blamed the connection: $why", why!!.contains("connection"))
    }

    @Test fun `a 200 whose body is not a list still explains itself`() {
        // `contentMessage` correctly reports NO failure for these (the status is fine),
        // so without the `?:` fallback the sheet would have neither rows nor a reason.
        for (res in listOf(
            JSONObject().put("ok", false).put("transcripts", JSONArray()),
            JSONObject().put("ok", true).put("transcripts", "nope"),
        )) {
            val why = TranscriptsLoad.message(res)
            assertNotNull("a 2xx with an unusable body said nothing: $res", why)
            assertTrue("the sentence should name the subject: $why",
                why!!.contains("transcripts"))
        }
    }

    // ── when a row is only a preview ────────────────────────────────────────────

    @Test fun `a truncated row is marked, so the ellipsis can be shown`() {
        val row = TranscriptsLoad.row(listRow(preview = "a".repeat(200), chars = 1712, truncated = true))
        assertTrue("a cut preview must say it is cut", row!!.isPreview)
        assertEquals(1712, row.chars)
    }

    @Test fun `a whole short transcript is not marked`() {
        // ⚠️ The other half of "same pixels": marking everything would put an ellipsis
        // and a "Read in full" button on a five-word note, which is its own lie.
        val row = TranscriptsLoad.row(listRow(preview = "buy milk", chars = 8, truncated = false))
        assertFalse(row!!.isPreview)
    }

    @Test fun `truncated survives SQLite's missing boolean type`() {
        // ⚠️ `length(text) > 200` selects as 0/1; the worker normalizes with
        // `!!r.truncated`, but a rolled-back worker would send the raw number — and
        // `JSONObject.optBoolean` does NOT coerce it. The obvious
        // `optBoolean("truncated", false)` answers FALSE for the number 1, marking
        // every row of such a response complete: this screen's bug, restored. Each
        // shape is therefore read on purpose.
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("truncated", 1)))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("truncated", 0)))
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("truncated", true)))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("truncated", false)))
    }

    @Test fun `truncated survives a stringly-typed layer`() {
        // Some JSON layers stringify everything; both spellings of each answer, and
        // the case-insensitivity, are the reason the arm trims and lowercases.
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("truncated", "true")))
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("truncated", "1")))
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("truncated", " TRUE ")))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("truncated", "false")))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("truncated", "0")))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("truncated", "False")))
        // ⚠️ And a stringly-typed NO must win over the length guess, or the arm can be
        // deleted with every test still green: a 200-char preview of a 200-char memo is
        // whole, and marking it cut puts a "Read in full" button on complete text.
        assertFalse(TranscriptsLoad.truncated(
            JSONObject().put("truncated", "0").put("preview", "x".repeat(200))))
        assertFalse(TranscriptsLoad.truncated(
            JSONObject().put("truncated", "false").put("preview", "x".repeat(200))))
    }

    @Test fun `an unreadable flag falls through to the length guess, not to false`() {
        // ⚠️ The asymmetry again: a flag nobody can parse must not be read as "whole".
        // A 200-char preview beside a garbage flag is still a cut preview.
        assertTrue(TranscriptsLoad.truncated(
            JSONObject().put("truncated", "yes").put("preview", "x".repeat(200))))
        assertFalse(TranscriptsLoad.truncated(
            JSONObject().put("truncated", "yes").put("preview", "short")))
        // A null flag is the same case — `optBoolean` would have said false here too.
        assertTrue(TranscriptsLoad.truncated(
            JSONObject().put("truncated", JSONObject.NULL).put("preview", "x".repeat(200))))
    }

    @Test fun `with no flag at all, a preview at the cut is assumed cut`() {
        // ⚠️ The safe direction, and it is asymmetric on purpose: guessing "cut" costs
        // one redundant GET that rewrites the same text; guessing "whole" presents a
        // fragment as a complete memo, which is the bug.
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("preview", "x".repeat(200))))
        assertTrue(TranscriptsLoad.truncated(JSONObject().put("preview", "x".repeat(240))))
        assertFalse(TranscriptsLoad.truncated(JSONObject().put("preview", "x".repeat(199))))
        // And a flag that IS present wins over the length guess, both ways.
        assertFalse(TranscriptsLoad.truncated(
            JSONObject().put("preview", "x".repeat(200)).put("truncated", false)))
        assertTrue(TranscriptsLoad.truncated(
            JSONObject().put("preview", "short").put("truncated", true)))
    }

    @Test fun `a row that already carries full text has nothing to hydrate`() {
        // The `?id=` shape reuses this parser, and a hydrated row must not keep asking.
        val row = TranscriptsLoad.row(
            JSONObject().put("id", "tr-9").put("text", "the whole memo").put("truncated", true))
        assertEquals("the whole memo", row!!.text)
        assertFalse("full text still marked as a preview", row.isPreview)
    }

    @Test fun `when a row carries both, the full text wins over the preview`() {
        // ⚠️ No live response holds both today — the list sends `preview`, `?id=` sends
        // `text` — so this is the one rule here that is about the NEXT shape rather than
        // the current one. Worth pinning anyway: if the list ever adds `text` for short
        // takes (the cheap optimisation someone will reach for), preferring `preview`
        // would silently re-cut rows the server had already sent whole.
        val row = TranscriptsLoad.row(
            listRow(preview = "x".repeat(200), chars = 1712, truncated = true)
                .put("text", "the whole memo, all 1712 characters of it"))
        assertEquals("the whole memo, all 1712 characters of it", row!!.text)
        assertFalse("full text still wearing the preview's ellipsis", row.isPreview)
    }

    @Test fun `a row with no id is dropped, because it can never be fetched`() {
        assertNull(TranscriptsLoad.row(JSONObject().put("preview", "orphan")))
        assertNull(TranscriptsLoad.row(JSONObject().put("id", "  ").put("preview", "orphan")))
        // And it doesn't take the rest of the list with it.
        val rows = TranscriptsLoad.rows(listBody(JSONObject().put("preview", "orphan"), listRow()))
        assertEquals(1, rows?.size)
    }

    @Test fun `an unlabelled take still has something to call itself`() {
        assertEquals("recording", TranscriptsLoad.row(listRow(label = ""))!!.label)
        assertEquals("recording", TranscriptsLoad.row(listRow(label = "   "))!!.label)
        assertEquals("wake: alexa", TranscriptsLoad.row(listRow(label = "wake: alexa"))!!.label)
    }

    @Test fun `an absent audio url is null, not an empty string`() {
        // The sheet tests it for presence; "" would read as an uploaded recording.
        assertNull(TranscriptsLoad.row(listRow())!!.audioUrl)
        assertNull(TranscriptsLoad.row(listRow().put("audio_url", ""))!!.audioUrl)
        assertEquals("https://r2/x.wav",
            TranscriptsLoad.row(listRow().put("audio_url", "https://r2/x.wav"))!!.audioUrl)
    }

    // ── the full-text rail ──────────────────────────────────────────────────────

    @Test fun `the hydrate rail reads the full text`() {
        val res = JSONObject().put("ok", true)
            .put("transcript", JSONObject().put("id", "tr-1").put("text", "every word of it"))
        assertEquals("every word of it", TranscriptsLoad.fullText(res))
    }

    @Test fun `a hydrate that failed returns null, so the row keeps its retry`() {
        // Each of these must leave the row a preview with its button, NOT overwrite the
        // visible words with an empty string — which would delete the 200 chars the
        // reader already had.
        for (res in listOf(
            null,
            failure(401, "login required"),
            failure(404, "not found"),
            JSONObject(),
            JSONObject().put("ok", false).put("transcript", JSONObject().put("text", "x")),
            JSONObject().put("ok", true),
            JSONObject().put("ok", true).put("transcript", JSONObject()),
            JSONObject().put("ok", true).put("transcript", JSONObject().put("text", "")),
        )) {
            assertNull("this answer is not a full text: $res", TranscriptsLoad.fullText(res))
        }
    }

    // ── the size line ───────────────────────────────────────────────────────────

    @Test fun `the size line says how long and how much`() {
        // `chars` is the only thing on screen that can contradict a short-looking row:
        // 200 visible characters of a 1,712-character memo says the rest exists.
        assertEquals("1:58 · 1,712 chars", TranscriptsLoad.sizeLine(118, 1712))
        assertEquals("0:09 · 42 chars", TranscriptsLoad.sizeLine(9, 42))
        assertEquals("2:00 · 12,000 chars", TranscriptsLoad.sizeLine(120, 12000))
    }

    @Test fun `a missing char count is omitted, not shown as zero`() {
        // A worker below the `chars` column would otherwise report every take as "0
        // chars", which reads as an empty recording.
        assertEquals("1:58", TranscriptsLoad.sizeLine(118, 0))
        assertEquals("0:00", TranscriptsLoad.sizeLine(0, -1))
    }

    @Test fun `⚠️ FAILS WHEN FIXED — the preview cut this screen is built around`() {
        // Everything above rests on the server sending a CUT preview plus a flag. If
        // `/transcript/list` ever returns full text, `isPreview` is dead weight and the
        // ellipsis/hydrate/retry rail should go — this fails rather than sitting here
        // unexplained. 200 is `TRANSCRIPT_PREVIEW_CHARS` (worker transcripts.ts:44).
        assertEquals("🎉 the server's preview length changed — recheck the cut", 200,
            TranscriptsLoad.previewChars)
    }
}
