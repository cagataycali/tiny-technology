package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The `forget` tool's three outcomes (web ForgetOutcome parity).
 *
 * The defect these close: `forgetMemory` computed its answer from the FILTER —
 * the in-memory list shrank, so it reported a removal — while `atomicWrite`
 * swallowed every failure into Unit. The voice executor then discarded even that
 * and answered the model a flat `{ ok: true }`. A store that refused the write
 * was spoken as forgotten, and `buildContext` kept injecting the "forgotten"
 * fact into every later request: "I forgot your address" followed by the
 * address, forever (web continuity.ts:32-47 documents the same bug).
 *
 * `decide` is pure so the mapping is testable without a Context — leaving it
 * only reachable on-device is how it went unnoticed that the write's verdict was
 * never consulted at all.
 */
class ForgetOutcomeTest {

    // ---- decide: the three cases ---------------------------------------------

    @Test fun `a match whose write lands is FORGOTTEN with its count`() {
        assertEquals(ForgetOutcome.FORGOTTEN to 2, Continuity.decide(removed = 2, wrote = true))
    }

    @Test fun `a match whose write is refused is BLOCKED, never FORGOTTEN`() {
        val (outcome, count) = Continuity.decide(removed = 2, wrote = false)
        assertEquals(ForgetOutcome.BLOCKED, outcome)
        // The count MUST collapse to 0: two memories were dropped from a list
        // that never reached the disk, so "2 removed" would be the lie itself.
        assertEquals(0, count)
    }

    @Test fun `nothing matched is NO_MATCH even when the write succeeded`() {
        assertEquals(ForgetOutcome.NO_MATCH to 0, Continuity.decide(removed = 0, wrote = true))
    }

    @Test fun `nothing matched is NO_MATCH, not BLOCKED, when the write also failed`() {
        // A store that never needed changing cannot have refused. Reporting
        // BLOCKED here would send someone to clear app data over a typo'd match.
        assertEquals(ForgetOutcome.NO_MATCH to 0, Continuity.decide(removed = 0, wrote = false))
    }

    @Test fun `a negative removed count cannot report success`() {
        assertEquals(ForgetOutcome.NO_MATCH to 0, Continuity.decide(removed = -1, wrote = true))
    }

    // ---- survivors: the blank needle is the store's safety catch --------------

    private fun mem(content: String) =
        MemoryEntry(id = content.take(4), content = content, tags = emptyList(), ts = 0L)

    private val store = listOf(mem("home address is 12 Oak"), mem("prefers tea"))

    @Test fun `a blank match must never touch the store`() {
        // ⚠️ THE one that wipes everything. `match` comes straight from the model's
        // forget tool call, and on the JVM `contains("")` is TRUE — so without this
        // guard a blank needle matches EVERY memory, saves the empty list, and
        // reports FORGOTTEN with a count of 2. Web tests this directly
        // (tests/continuity.test.ts "empty/undefined forget does NOT wipe the
        // store"); iOS cannot, because Swift's `contains("")` is FALSE, so there
        // the guard is free and its test passes for a reason that does not
        // transfer here. Before `survivors` was extracted this was reachable only
        // through a Context — i.e. only on a device — so deleting the guard broke
        // nothing on any gate.
        for (blank in listOf("", " ", "\t", "\n", "   ")) {
            assertEquals("a blank match must be a no-op: ${'"'}$blank${'"'}",
                null, Continuity.survivors(store, blank))
        }
    }

    @Test fun `nothing matched is a no-op, distinct from an empty result`() {
        // null, not an empty list: "nothing to do" must not reach the write at
        // all, or an untouched store gets reported as having refused.
        assertEquals(null, Continuity.survivors(store, "no such thing"))
    }

    @Test fun `a real match returns only the survivors`() {
        val keep = Continuity.survivors(store, "address")
        assertEquals(listOf("prefers tea"), keep?.map { it.content })
    }

    @Test fun `the match is case-insensitive, like web and iOS`() {
        assertEquals(1, Continuity.survivors(store, "ADDRESS")?.size)
    }

    @Test fun `a match on every memory empties the store, and that is not null`() {
        // The one case where an empty list IS the right answer — "forget
        // everything that says 'e'" legitimately clears it. Distinguishable from
        // the no-op only because that returns null.
        val keep = Continuity.survivors(listOf(mem("aaa"), mem("aab")), "aa")
        assertEquals(emptyList<MemoryEntry>(), keep)
    }

    // ---- survivors: a UI row names ONE memory, and it names it by id ----------

    private fun idMem(id: String, content: String) =
        MemoryEntry(id = id, content = content, tags = emptyList(), ts = 0L)

    /** Two memories where one's ENTIRE content is a substring of the other — the
     *  shape the memory sheet's delete used to destroy. Contents are >40 chars
     *  apart so the old `take(40)` needle is the whole short row. */
    private val overlapping = listOf(
        idMem("a1b2c3d4e5f6", "likes coffee"),
        idMem("f6e5d4c3b2a1", "likes coffee in the morning, never after four"),
    )

    @Test fun `a memory is forgotten by its id`() {
        val keep = Continuity.survivors(overlapping, "a1b2c3d4e5f6")
        assertEquals(listOf("likes coffee in the morning, never after four"), keep?.map { it.content })
    }

    @Test fun `🔴 deleting the short memory must not take its longer neighbour`() {
        // THE defect. The sheet's row had no way to name itself, so it passed
        // `m.content.take(40)` — for a memory under 40 chars, its whole text — into
        // a SUBSTRING match. One tap on "likes coffee" also deleted "likes coffee
        // in the morning…": silent, unrecoverable, and the list just re-read and
        // showed fewer rows. iOS passed `m.id` and always deleted exactly one.
        val byContent = Continuity.survivors(overlapping, overlapping[0].content.take(40))
        assertEquals("the old content needle is why the id arm exists: it takes BOTH",
            emptyList<MemoryEntry>(), byContent)

        val byId = Continuity.survivors(overlapping, overlapping[0].id)
        assertEquals("an id names exactly one row", 1, byId?.size)
        assertEquals("and it must be the OTHER one that survives",
            overlapping[1].id, byId?.single()?.id)
    }

    @Test fun `two memories sharing a 40-char prefix both died on one tap`() {
        // The same defect above 40 chars: the needle is the shared opening, so it
        // matches every row that starts the same way. Long memories written by the
        // model routinely do ("The user prefers …").
        val shared = "The user prefers dark mode in every app they"
        val rows = listOf(
            idMem("111111111111", shared + " use on the phone"),
            idMem("222222222222", shared + " use on the laptop"),
        )
        assertEquals("both rows share the needle", emptyList<MemoryEntry>(),
            Continuity.survivors(rows, rows[0].content.take(40)))
        assertEquals("by id, only one goes", 1, Continuity.survivors(rows, rows[0].id)?.size)
    }

    @Test fun `an id match is exact, never a substring`() {
        // The content arm is deliberately fuzzy (the model forgets by text); the id
        // arm must not be, or one row's id prefix would name several.
        assertEquals(null, Continuity.survivors(overlapping, "a1b2c3d4"))
        assertEquals(null, Continuity.survivors(overlapping, "A1B2C3D4E5F6"))
    }

    @Test fun `a blank id cannot match every row`() {
        // `loadMemories` reads ids with optString, which yields "" for a file with
        // no "id" field. Without the blank guard `it.id == match` would then match
        // EVERY such row on an empty forget — the id arm inherits the store's
        // safety catch rather than reopening it.
        val noIds = listOf(idMem("", "home address"), idMem("", "prefers tea"))
        assertEquals(null, Continuity.survivors(noIds, ""))
        assertEquals(null, Continuity.survivors(noIds, "   "))
    }

    @Test fun `the memory sheet's row deletes by identity`() {
        // Pin the CALLER, not just the predicate: the id arm is inert if the one
        // caller that needs it still hands over a content prefix. Both halves have
        // to be true at once, which is what made this defect survive — the
        // predicate looked complete on its own terms.
        val ui = src("ui/MemoryUniverse.kt")
        val local = ui.indexOf("items(local, key = { it.id })")
        assertTrue("the local memory rows moved — re-anchor this pin", local > 0)
        val server = ui.indexOf("server learnings", local)
        assertTrue("the server section moved — re-anchor this pin", server > local)
        // ⚠️ Strip the comments first. The fix's own comment NAMES the defect it
        // replaced ("the old `m.content.take(40)`…"), and a scan that reads prose
        // cannot tell a warning about a shape from a use of it — this assertion
        // failed on its own documentation before the strip went in.
        val rowBody = ui.substring(local, server).replace(Regex("""(?m)^\s*//.*$"""), "")
        assertTrue("the local row must forget by id", rowBody.contains("forgetMemory(tiny, m.id)"))
        assertTrue("never by a content prefix — take(40) deletes every row that shares it",
            !rowBody.contains("m.content.take("))
    }

    // ---- clipToCodePoints: the cross-surface truncation unit -----------------

    @Test fun `a clip never leaves half an emoji`() {
        // ⚠️ `take(500)` counts UTF-16 CHARS, so this cut landed between the two
        // halves of the 👍 and stored a LONE HIGH SURROGATE. Unpaired, it cannot
        // be encoded to UTF-8: the JVM writes '?' (0x3f) and a browser writes
        // U+FFFD — so the SAME turn reached the model as different bytes
        // depending on which surface logged it, and this file promises the
        // opposite ("byte-compatible with web/iOS").
        val out = Continuity.clipToCodePoints("a".repeat(499) + "👍 more", 500)
        // The property, stated as the thing that goes wrong: a UTF-8 round trip
        // must be lossless. A lone surrogate fails this and nothing else does.
        assertEquals("a UTF-8 round trip must be lossless", out,
            String(out.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
        assertTrue("no lone surrogate may survive",
            out.none { Character.isHighSurrogate(it) || Character.isLowSurrogate(it) } ||
                out.codePoints().allMatch { Character.isValidCodePoint(it) && it !in 0xD800..0xDFFF })
        // The 👍 is the 500th code point, so it is kept WHOLE — where take(500)
        // kept its leading half and dropped the trailing one.
        assertTrue("the emoji must be kept whole: $out", out.endsWith("👍"))
        assertEquals(500, out.codePointCount(0, out.length))
    }

    @Test fun `the clip counts code points, not chars`() {
        // 1200 thumbs = 2400 UTF-16 chars. `take(1000)` would keep 500 emoji and
        // then half of one more.
        val out = Continuity.clipToCodePoints("👍".repeat(1200), 1000)
        assertEquals("👍".repeat(1000), out)
        assertEquals(1000, out.codePointCount(0, out.length))
    }

    @Test fun `text that fits is returned untouched`() {
        // Including the exact-cap case: an off-by-one here silently drops a
        // character from every memory already short enough to keep whole.
        val exact = "e".repeat(1000)
        assertEquals(exact, Continuity.clipToCodePoints(exact, 1000))
        assertEquals("short", Continuity.clipToCodePoints("short", 1000))
        assertEquals("", Continuity.clipToCodePoints("", 1000))
    }

    @Test fun `🔴 the clip agrees with web and iOS BYTE FOR BYTE`() {
        // The whole point. These expectations are the measured UTF-8 byte lengths
        // and content produced by the web (`Array.from`) and Swift
        // (`unicodeScalars`) implementations on the SAME inputs — all three were
        // compared by SHA-256 and matched. A divergence here means one surface
        // now sends the model a different context section than the others, which
        // is the invariant this file exists to keep.
        val cases = listOf(
            Triple("a".repeat(498) + "👍🏽x", 500, 506),   // skin-tone modifier: 2 code points
            Triple("a".repeat(495) + "👨‍👩‍👧‍👦x", 500, 513), // ZWJ family: 7 code points
            Triple("a".repeat(498) + "🇹🇷x", 500, 506),   // regional-indicator pair
            Triple("a".repeat(498) + "éx", 500, 501),     // precomposed accent
            Triple("a".repeat(498) + "日本x", 500, 504),   // CJK, 3 bytes each
            Triple("a".repeat(499) + "👍 tail", 500, 503), // the cut lands ON the emoji
        )
        for ((input, max, expectedBytes) in cases) {
            val out = Continuity.clipToCodePoints(input, max)
            assertEquals("code points for ${input.takeLast(8)}", max, out.codePointCount(0, out.length))
            assertEquals("UTF-8 bytes for ${input.takeLast(8)}", expectedBytes,
                out.toByteArray(Charsets.UTF_8).size)
        }
    }

    @Test fun `the store paths use the clip, not take`() {
        val code = src("chat/Continuity.kt")
        assertTrue("the turn log must clip both halves",
            code.contains("clipToCodePoints(q, 500), clipToCodePoints(a, 800)"))
        assertTrue("a memory must be clipped by code points",
            code.contains("content = clipToCodePoints(content, 1000)"))
        // The regression shape: a unit-counting truncation anywhere in the store.
        assertTrue("no take(n) truncation may remain",
            !code.contains("q.take(500)") && !code.contains("a.take(800)") &&
                !code.contains("content.take(1000)"))
    }

    // ---- the three cases are distinguishable ---------------------------------

    @Test fun `no-match and blocked are different facts`() {
        // The whole point of three states: both mean "nothing was forgotten",
        // and a caller that reports the wrong one has diagnosed the user
        // confidently and wrongly.
        assertNotEquals(
            Continuity.decide(removed = 0, wrote = true).first,
            Continuity.decide(removed = 1, wrote = false).first,
        )
    }

    @Test fun `every outcome has its own sentence`() {
        val lines = ForgetOutcome.values().map { Continuity.forgetLine(it) }
        assertEquals("each outcome needs its own wording", 3, lines.toSet().size)
        assertTrue("nothing may be blank", lines.none { it.isBlank() })
    }

    @Test fun `only the blocked sentence says the memory survived`() {
        val blocked = Continuity.forgetLine(ForgetOutcome.BLOCKED)
        // The user has already been told the fact is gone. This line is the only
        // thing that corrects it, so it has to say the memory is STILL THERE —
        // "couldn't forget that" alone reads as a retryable hiccup.
        assertTrue("blocked must say the memory survived: $blocked",
            blocked.contains("still there"))
        assertTrue(Continuity.forgetLine(ForgetOutcome.FORGOTTEN).contains("forgotten"))
        // A no-match is NOT an error and must not blame storage.
        val noMatch = Continuity.forgetLine(ForgetOutcome.NO_MATCH)
        assertTrue("a no-match must not blame storage: $noMatch",
            !noMatch.contains("storage") && !noMatch.contains("still there"))
    }

    // ---- the call sites (source-scraped: no JVM test can reach a Context) ----

    private fun src(path: String): String {
        val f = File("src/main/java/technology/tiny/app/$path")
        val text = if (f.exists()) f.readText() else File("android/app/src/main/java/technology/tiny/app/$path").readText()
        // A slicer that silently returns "" passes every assertion below forever.
        assertTrue("could not read $path — re-anchor this test", text.length > 500)
        return text
    }

    @Test fun `the voice executor branches on all three outcomes`() {
        val code = src("MainActivity.kt")
        val forget = code.indexOf("\"forget\" -> {")
        assertTrue("the voice forget case moved — re-anchor", forget > 0)
        val body = code.substring(forget, forget + 1700)
        assertTrue("the voice executor must ask for the OUTCOME, not the count",
            body.contains("forgetOutcome("))
        for (case in listOf("FORGOTTEN", "NO_MATCH", "BLOCKED")) {
            assertTrue("the voice forget case no longer handles $case", body.contains(case))
        }
        // The regression: a bare ok:true with the result thrown away.
        assertTrue("BLOCKED must answer the model ok:false", body.contains("put(\"ok\", false)"))
        assertTrue("BLOCKED must tell the model the memory survived",
            body.contains("the memory is still there; tell the user"))
    }

    @Test fun `the voice remember case reports the write, not the attempt`() {
        val code = src("MainActivity.kt")
        val remember = code.indexOf("\"remember\" -> {")
        assertTrue("the voice remember case moved — re-anchor", remember > 0)
        val body = code.substring(remember, remember + 1100)
        assertTrue("the 'remembered' claim must be gated on addMemory's verdict",
            body.contains("if (app.continuity.addMemory("))
        assertTrue("a refused write must tell the model it was NOT remembered",
            body.contains("it was NOT remembered"))
    }

    @Test fun `the chat stream warns on a blocked forget and a blocked remember`() {
        val code = src("chat/ChatViewModel.kt")
        val forget = code.indexOf("\"forget\" -> {")
        assertTrue("the chat-stream forget case moved — re-anchor", forget > 0)
        val body = code.substring(forget, forget + 900)
        assertTrue("the chat stream must ask for the OUTCOME", body.contains("forgetOutcome("))
        assertTrue("a blocked forget must reach the user", body.contains("ForgetOutcome.BLOCKED"))
        assertTrue("the warning needs a Toast — nothing else is visible here",
            body.contains("Toast.makeText"))
        val remember = code.indexOf("\"remember\" -> {")
        val rBody = code.substring(remember, remember + 900)
        assertTrue("a refused remember must reach the user too",
            rBody.contains("if (!tinyApp.continuity.addMemory("))
    }

    @Test fun `the store write reports failure instead of swallowing it`() {
        val code = src("chat/Continuity.kt")
        assertTrue("atomicWrite must return whether the bytes landed",
            code.contains("private fun atomicWrite(file: File, text: String): Boolean"))
        assertTrue("saveMemories must pass the verdict up",
            code.contains("private fun saveMemories(tiny: String, mems: List<MemoryEntry>): Boolean"))
        assertTrue("addMemory must report durability",
            code.contains("fun addMemory(tiny: String, content: String, tags: List<String>): Boolean"))
        // The exact regression: a runCatching with no failure branch.
        assertTrue("atomicWrite must not swallow the throw",
            code.contains("}.getOrElse { t ->"))
    }

    @Test fun `forgetMemory delegates so the predicate has one implementation`() {
        val code = src("chat/Continuity.kt")
        // Two copies of "did this match and land?" is how the two answers drift.
        assertTrue("forgetMemory must delegate to forgetOutcome",
            code.contains("forgetOutcome(tiny, match).let"))
        // A second filter/save pair inside forgetMemory would be that drift.
        val start = code.indexOf("fun forgetMemory(tiny: String, match: String): Int")
        assertTrue(start > 0)
        val body = code.substring(start, code.indexOf("fun forgetOutcome"))
        assertTrue("forgetMemory must not re-implement the filter",
            !body.contains("filterNot") && !body.contains("saveMemories"))
    }

    @Test fun `the filter itself exists exactly once`() {
        val code = src("chat/Continuity.kt")
        // A second copy of the match predicate is how the blank-needle guard gets
        // bypassed on one path and honoured on another.
        //
        // ⚠️ This pin used to read `filterNot { it.content.contains(match` — it
        // transcribed the content-only filter, so it VOTED FOR the missing id arm:
        // adding the arm the other two surfaces have would have turned it red.
        // Match the shape without fixing which arms are in it, and let the
        // behavioural tests above own the arms.
        assertEquals("the forget filter must have ONE implementation", 1,
            Regex("""filterNot \{ it\.""").findAll(code).count())
        assertTrue("forgetOutcome must go through survivors",
            code.contains("survivors(mems, match) ?: return ForgetOutcome.NO_MATCH to 0"))
    }
}
