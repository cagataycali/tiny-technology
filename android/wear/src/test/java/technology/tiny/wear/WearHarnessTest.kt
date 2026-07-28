package technology.tiny.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WearHarness is the debug-only seed path that lets a Wear screenshot get past the
 * link gate. Two properties matter more than the parsing: a RELEASE build must seed
 * nothing whatever the intent says, and an unreadable/absent payload must leave the
 * stored state alone rather than blank it — "I couldn't parse that" must never
 * present as "you asked for an empty chat", because an empty chat is a screenshot
 * that looks plausible and is wrong.
 */
class WearHarnessTest {

    private val json = """[{"q":"what can you do?","a":"I can run commands on your Mac."}]"""

    // --- the safety property -------------------------------------------------

    @Test fun `a release build seeds no token, whatever the extra says`() {
        assertNull(WearHarness.token(debug = false, raw = "a.real.jwt"))
    }

    @Test fun `a release build seeds no turns, whatever the extra says`() {
        assertNull(WearHarness.turns(debug = false, json = json))
    }

    // --- token ---------------------------------------------------------------

    @Test fun `a debug build adopts a trimmed token`() {
        assertEquals("a.real.jwt", WearHarness.token(debug = true, raw = "  a.real.jwt\n"))
    }

    @Test fun `an absent token extra is null, not empty`() {
        assertNull(WearHarness.token(debug = true, raw = null))
    }

    @Test fun `a blank token is null — an unset shell var must not pass the gate`() {
        // `--es tiny_harness_token "$TOK"` with TOK unset arrives as "". Adopting it
        // would render the chat UI on a session that 401s on every send.
        assertNull(WearHarness.token(debug = true, raw = ""))
        assertNull(WearHarness.token(debug = true, raw = "   "))
    }

    // --- turns ---------------------------------------------------------------

    @Test fun `turns parse q and a`() {
        val turns = WearHarness.turns(debug = true, json = json)!!
        assertEquals(1, turns.size)
        assertEquals("what can you do?", turns[0].q)
        assertEquals("I can run commands on your Mac.", turns[0].a)
    }

    @Test fun `every seeded turn is done — a seeded turn is never mid-stream`() {
        // done=false would render a spinner forever (nothing is streaming it), and
        // loadTurns' sanitize only rescues it to "(interrupted)". Neither is
        // shippable, so `done` is forced rather than read from the JSON.
        val turns = WearHarness.turns(debug = true, json = """[{"q":"a","a":"b","done":false}]""")!!
        assertTrue(turns.all { it.done })
    }

    @Test fun `ids are generated when absent and kept when given`() {
        val turns = WearHarness.turns(debug = true, json = """[{"q":"a","a":"b"},{"id":"X","q":"c","a":"d"}]""")!!
        assertEquals("harness-0", turns[0].id)
        assertEquals("X", turns[1].id)
    }

    @Test fun `malformed json leaves the transcript alone`() {
        assertNull(WearHarness.turns(debug = true, json = "{not json"))
    }

    @Test fun `a non-array payload leaves the transcript alone`() {
        assertNull(WearHarness.turns(debug = true, json = """{"q":"a","a":"b"}"""))
    }

    @Test fun `an empty array leaves the transcript alone`() {
        assertNull(WearHarness.turns(debug = true, json = "[]"))
    }

    @Test fun `an absent or blank turns extra leaves the transcript alone`() {
        assertNull(WearHarness.turns(debug = true, json = null))
        assertNull(WearHarness.turns(debug = true, json = "  "))
    }

    @Test fun `a turn with neither side is dropped, and an all-empty array is null`() {
        val turns = WearHarness.turns(debug = true, json = """[{"q":"","a":""},{"q":"real","a":"answer"}]""")!!
        assertEquals(1, turns.size)
        assertEquals("real", turns[0].q)
        assertNull(WearHarness.turns(debug = true, json = """[{"q":"","a":""}]"""))
    }

    // --- the overwrite guard (c64) --------------------------------------------

    /*
     * ⚠️ Why this harness needs a guard its three phone-side siblings don't.
     *
     * GraphHarness / FleetHarness / MemoryHarness substitute a dataset IN MEMORY and
     * leave storage alone, so refusing to seed costs nothing but a plain screen. This
     * one CANNOT: the gate it defeats (`vm.token == null -> Unlinked()`) is read out of
     * WearStore by the ViewModel's constructor, so the seed must land in the store
     * first. It therefore replaces the encrypted session token AND `writeText`s over
     * the transcript file.
     *
     * 🔑 **A harness that substitutes what a screen READS by writing over the real
     * thing needs a guard its read-only siblings don't.** On an emulator both writes
     * hit a blank slate. Aim the same `am start` at a real, phone-linked watch running
     * the DEBUG apk the capture recipe sideloads — one mistyped `--serial` — and it
     * unlinks that watch and deletes the conversation on it, while the seeder prints
     * "✓ seeded". 🔑 **A debug-only write is still a write to whatever device it lands
     * on**: `BuildConfig.DEBUG` bounds who can run it, not what it destroys.
     */

    @Test fun `a release build overwrites nothing, whatever the wrist holds`() {
        // Belt to the token/turns gates' braces: even the decision to write is off.
        assertFalse(WearHarness.mayOverwrite(debug = false, hasToken = false, harnessSeeded = false))
        assertFalse(WearHarness.mayOverwrite(debug = false, hasToken = false, harnessSeeded = true))
        assertFalse(WearHarness.mayOverwrite(debug = false, hasToken = true, harnessSeeded = true))
    }

    @Test fun `an unlinked wrist may be seeded — there is nothing of the user's to lose`() {
        // The fresh-emulator case, i.e. every intended run. No session to unlink, and
        // no transcript reachable behind a gate that needs a token to pass.
        assertTrue(WearHarness.mayOverwrite(debug = true, hasToken = false, harnessSeeded = false))
    }

    @Test fun `a wrist the harness already seeded may be re-seeded`() {
        // Re-capture has to work: a wrist shot is almost never right the first time,
        // and a guard that only allowed the FIRST run would send the next attempt
        // looking for a way around it.
        assertTrue(WearHarness.mayOverwrite(debug = true, hasToken = true, harnessSeeded = true))
    }

    @Test fun `a PHONE-LINKED wrist is refused — the case the guard exists for`() {
        // A real token this harness did not put there: seeding would unlink the watch
        // (placeholder token replaces the live session) and delete the real transcript.
        assertFalse(WearHarness.mayOverwrite(debug = true, hasToken = true, harnessSeeded = false))
    }

    // --- the call site --------------------------------------------------------

    /**
     * `applyHarness` is an Activity method, so there is no JVM-unit path that runs it —
     * reading the source is the weaker substitute, made as strict as a text assertion
     * can be: comments are stripped first (a bare `contains` matches a commented-out
     * line and the docblocks above), and the guard must sit BEFORE both writes, which
     * is the only ordering that protects anything.
     */
    @Test fun `applyHarness asks permission BEFORE either write`() {
        val code = liveCode("MainActivity.kt")
        val fn = code.indexOf("private fun applyHarness(")
        assertTrue("applyHarness is gone from MainActivity — re-anchor", fn >= 0)
        val end = code.indexOf("\n    }", fn)
        assertTrue("could not bound applyHarness — re-anchor", end > fn)
        val body = code.substring(fn, end)

        val guard = body.indexOf("WearHarness.mayOverwrite(")
        assertTrue("applyHarness never calls WearHarness.mayOverwrite(), so a mistyped " +
            "--serial still unlinks a real watch and deletes its transcript", guard >= 0)

        // Both writes, each strictly after the guard. Guarding one is not guarding the
        // seed: the token write unlinks the watch, the turns write deletes the chat.
        val tokenWrite = body.indexOf("store.token =")
        assertTrue("the token write is gone — re-anchor", tokenWrite > 0)
        assertTrue("the token write is NOT behind the guard: seeding a linked wrist " +
            "replaces its live session and the watch goes unlinked", tokenWrite > guard)
        val turnsWrite = body.indexOf("store.saveTurns(")
        assertTrue("the transcript write is gone — re-anchor", turnsWrite > 0)
        assertTrue("the transcript write is NOT behind the guard: saveTurns overwrites " +
            "the real conversation on a linked watch", turnsWrite > guard)

        // A guard that computes a verdict and drops it protects nothing. The refusal
        // must actually leave the function.
        val refuse = body.indexOf("return", guard)
        assertTrue("mayOverwrite is called but nothing returns on a refusal: the verdict " +
            "is computed and discarded, so both writes happen anyway",
            refuse in (guard + 1) until minOf(tokenWrite, turnsWrite))

        // And it is handed the REAL build flag plus the two real state reads. A literal
        // would compile and pass every rule test above while guarding nothing.
        val args = body.substring(guard, body.indexOf(')', guard) + 1)
        assertTrue("the guard is not passed BuildConfig.DEBUG: $args", args.contains("BuildConfig.DEBUG"))
        assertTrue("the guard is not told whether the wrist is linked: $args", args.contains("store.token"))
        assertTrue("the guard is not told the state's provenance: $args", args.contains("harnessSeeded"))
    }

    /**
     * The provenance flag is only useful if it is SET after a seed (or the next
     * re-capture is refused) and CLEARED when the wrist stops being demo state (or the
     * harness keeps permission to overwrite a real, phone-linked session forever).
     */
    @Test fun `the provenance flag is set on seed and cleared when a phone links`() {
        val activity = liveCode("MainActivity.kt")
        val fn = activity.indexOf("private fun applyHarness(")
        val body = activity.substring(fn, activity.indexOf("\n    }", fn))
        assertTrue("applyHarness never records that it seeded, so the next re-capture " +
            "would be refused as if the state were the user's",
            body.contains("harnessSeeded = true"))

        val vm = liveCode("WearViewModel.kt")
        val linked = vm.indexOf("fun onLinked(")
        assertTrue("onLinked is gone from WearViewModel — re-anchor", linked >= 0)
        val cleared = vm.indexOf("harnessSeeded = false", linked)
        val nextFun = vm.indexOf("\n    fun ", linked + 1)
        assertTrue("a real phone push does NOT clear harnessSeeded, so the wrist stays " +
            "overwritable and the seeder may still clobber a live session",
            cleared in (linked + 1) until (if (nextFun > linked) nextFun else vm.length))

        // Logout scrubs the token + transcript, so the flag describing them must go too
        // — otherwise a wrist that later links for real reads as harness state.
        val store = liveCode("WearStore.kt")
        val logout = store.indexOf("fun logout()")
        assertTrue("logout is gone from WearStore — re-anchor", logout >= 0)
        assertTrue("logout does not clear harnessSeeded",
            store.indexOf("harnessSeeded = false", logout) > logout)
    }

    /** cwd for these JVM unit tests is android/wear — verified, not assumed. */
    private fun liveCode(name: String): String {
        val src = java.io.File("src/main/java/technology/tiny/wear/$name")
        // A moved file must FAIL, not vacuously pass.
        assertTrue("$name not found at ${src.absolutePath} — re-anchor", src.isFile)
        return stripComments(src.readText())
    }

    /** Drops `/* … */` blocks and `//` tails so a commented-out call can't satisfy a match. */
    private fun stripComments(s: String): String {
        val noBlocks = Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL).replace(s, " ")
        return noBlocks.lineSequence().joinToString("\n") { line ->
            val i = line.indexOf("//")
            if (i >= 0) line.substring(0, i) else line
        }
    }
}
