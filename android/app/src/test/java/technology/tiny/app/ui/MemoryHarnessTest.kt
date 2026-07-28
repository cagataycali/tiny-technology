package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MemoryHarness — the Android side of the c56 iOS fix, landed here in c63.
 *
 * Android had a harness for the memory GRAPH and for the device FLEET, and none for the
 * sheet the graph is reached FROM — even though [MemorySheet] renders the same facts as a
 * legible LIST. 🔑 **A harness for the screen that leaked is not a harness for the screen
 * beside it.**
 *
 * It's a SAFETY gate, so the release-build case is pinned here rather than left to
 * inspection — the same contract as GraphHarnessTest/FleetHarnessTest. Two things make
 * this suite different from those:
 *
 *  - the sheet has **TWO** ungated sources (`/api/learnings` and the on-device
 *    `Continuity.loadMemories`), so both substitutions are asserted at the CALL SITE.
 *    Substituting one and shipping it as "the memory harness" is the defect this file
 *    exists to prevent;
 *  - it's the first harnessed screen with **mutating controls**. A dataset alone is not
 *    enough: both delete handlers end by touching the real source (one re-reads
 *    Continuity, one sends a DELETE to the account), so the harness has to route them
 *    away or its own UI leaks what it was built to hide.
 */
class MemoryHarnessTest {

    // ── the gate ─────────────────────────────────────────────────────────────

    @Test fun `a release build substitutes nothing however the extra is set`() {
        // The whole safety property: an APK on a stranger's phone cannot be shown fake
        // memories, and a real user's load failure can never be masked by a harness.
        assertFalse(MemoryHarness.enabled(debug = false, raw = true))
        assertFalse(MemoryHarness.enabled(debug = false, raw = false))
    }

    @Test fun `a debug build substitutes only when the flag is actually set`() {
        assertTrue(MemoryHarness.enabled(debug = true, raw = true))
        assertFalse(MemoryHarness.enabled(debug = true, raw = false))
    }

    @Test fun `the extra key is namespaced like its siblings`() {
        // A capture script reaches all three with the same `--ez tiny_harness_*` shape;
        // an off-pattern key is a recipe that silently arms nothing.
        assertTrue(MemoryHarness.EXTRA_MEMORY.startsWith("tiny_harness_"))
        assertEquals("tiny_harness_memory", MemoryHarness.EXTRA_MEMORY)
    }

    // ── the dataset ──────────────────────────────────────────────────────────

    @Test fun `both live and archived rows are present, so the dot channel is not flat`() {
        val rows = MemoryHarness.learnings()
        val live = rows.count { it.live }
        val closed = rows.count { !it.live }
        // All-live rows render MemoryRow's dot in ONE state and quietly hide half of what
        // the frame claims — the same reason the graph harness needs History on.
        assertTrue("no archived rows: the ⚪ dot has no referent on screen", closed >= 2)
        assertTrue("no live rows: the 🟢 dot has no referent on screen", live >= 5)
    }

    @Test fun `freshness maps through the REAL live rule, not a hand-set boolean`() {
        // MemorySheet computes `live` from the wire's `freshness` via learningIsLive. If
        // the harness's own booleans disagreed with that rule, the harnessed shot would
        // render a state the product never produces.
        for (row in MemoryHarness.learnings()) {
            val freshness = if (row.live) "live" else "closed"
            assertEquals("row ${row.id} disagrees with learningIsLive",
                row.live, learningIsLive(freshness))
        }
    }

    @Test fun `every id is unique, so LazyColumn cannot collapse two rows`() {
        val ids = MemoryHarness.learnings().map { it.id } + MemoryHarness.localEntries().map { it.id }
        assertEquals("duplicate keys across the two sections: $ids", ids.size, ids.toSet().size)
    }

    @Test fun `ids and timestamps are fixed, so the same capture twice is the same pixels`() {
        // A clock read or a generated id would re-key the list between frames of one take
        // and defeat any reference comparison a per-beat check is built on.
        assertEquals(MemoryHarness.learnings().map { it.id }, MemoryHarness.learnings().map { it.id })
        assertEquals(MemoryHarness.localEntries().map { it.ts }, MemoryHarness.localEntries().map { it.ts })
        assertTrue("a local ts of 0 renders as the epoch",
            MemoryHarness.localEntries().all { it.ts > 1_600_000_000_000L })
    }

    @Test fun `one row wraps, because real learnings wrap`() {
        // A set of uniformly short rows does not prove the layout handles a long one, and
        // the longest real learnings are the ones that carry a reason.
        val longest = MemoryHarness.learnings().maxOf { it.content.length }
        assertTrue("longest row is $longest chars — nothing here will wrap", longest >= 70)
    }

    @Test fun `no row carries user data or a placeholder`() {
        val all = MemoryHarness.learnings().map { it.content } + MemoryHarness.localEntries().map { it.content }
        for (c in all) {
            assertTrue("empty row", c.isNotBlank())
            for (marker in listOf("cagatay", "@", "http", "lorem", "TODO", "FIXME", "test test")) {
                assertFalse("row leaks or placeholders ($marker): $c", c.lowercase().contains(marker))
            }
        }
    }

    @Test fun `the local section is short enough to leave the server section on frame`() {
        // "on this phone" sits ABOVE "server learnings" — the section the caption is
        // about. A long local list pushes the subject off a 9:16 store frame.
        val n = MemoryHarness.localEntries().size
        assertTrue("local section of $n rows will push server learnings off frame", n in 1..3)
    }

    /**
     * ⚠️ The cross-harness check, and the reason it is a TEST rather than a comment: a
     * capture (or a video cut) walks list → graph in one motion. Two unrelated demo
     * datasets would make the app look like it forgot everything between two taps — the
     * opposite of what the caption claims — and nothing but a human's memory would
     * connect the two files when one of them is edited.
     */
    @Test fun `every server row is a graph fact, so the two harnesses cannot drift apart`() {
        /*
         * ⚠️ This asserts the STRICT direction — every row of the list IS a graph fact (or
         * a longer form of one) — rather than a "≥N of them overlap" threshold. The first
         * draft counted overlap the other way round (how many graph facts appear in the
         * list, ≥8 of 15) and a mutant that replaced two baking rows with running ones
         * still PASSED: the surviving 10 satisfied the count.
         * 🔑 **A threshold over a set has slack in it by construction, so it cannot detect
         * a single drifted member — check the direction that has no slack.** The same
         * both-directions rule the loop keeps relearning about lookup tables.
         */
        val graphLabels = GraphHarness.graph(includeClosed = true).first.map { it.label }
        assertTrue("graph harness returned no labels — re-anchor", graphLabels.size >= 12)
        for (row in MemoryHarness.learnings()) {
            val match = graphLabels.any { label ->
                // The list's wrapping row is a LONGER form of a graph fact, so a graph
                // label that is a prefix of the row counts — but only a substantial one,
                // or a two-word label would match half the dataset.
                row.content == label ||
                    (row.content.startsWith(label.substringBefore(", ")) &&
                        label.substringBefore(", ").length >= 20)
            }
            assertTrue("\"${row.content}\" is in the memory list but NOT in the graph " +
                "harness — the two datasets have drifted, so a list→graph capture would " +
                "look like the app forgot everything between two taps", match)
        }
    }

    @Test fun `the on-device half belongs to the same persona too`() {
        // The local rows are deliberately NOT graph facts (they come from the `remember`
        // tool, not `learn`), so the strict rule above can't apply. They still have to
        // read as the same tiny: assert a distinctive noun shared with the graph corpus.
        val graphText = GraphHarness.graph(includeClosed = true).first
            .joinToString(" ") { it.label }.lowercase()
        val shared = MemoryHarness.localEntries().count { e ->
            e.content.lowercase().split(Regex("[^a-z]+"))
                .any { w -> w.length >= 6 && graphText.contains(w) }
        }
        assertTrue("no on-device row shares any distinctive term with the graph persona — " +
            "the 'on this phone' section reads as a different tiny than the section below it",
            shared >= 1)
    }

    // ── the call site ────────────────────────────────────────────────────────

    /**
     * [MemorySheet] is a `@Composable`, so there is no JVM-unit path that RUNS it.
     * Reading the source is the weaker substitute, so it is made as strict as a text
     * assertion can be: comments are stripped first (a `contains("MemoryHarness")` passes
     * on a commented-out line — and on MemoryHarness.kt's own docblock), each call must
     * sit INSIDE MemorySheet, and the server substitution must sit BEFORE the
     * /api/learnings fetch, which is the ordering that keeps a capture off the network.
     */
    @Test fun `the sheet substitutes BOTH sources, live and before the fetch`() {
        val code = liveCode()
        val sheet = code.indexOf("fun MemorySheet(")
        assertTrue("MemorySheet not found in live code", sheet >= 0)
        val fetch = code.indexOf("\"/api/learnings?limit=200\"", sheet)
        assertTrue("the /api/learnings fetch is gone from MemorySheet — re-anchor", fetch > sheet)

        // Anchor on the CALLS, not the bare identifier: an import or a doc mention would
        // otherwise satisfy this and prove nothing.
        val gate = code.indexOf("MemoryHarness.enabled(", sheet)
        assertTrue("MemorySheet never calls MemoryHarness.enabled() in live code",
            gate in (sheet + 1) until fetch)

        // ⚠️ BOTH halves. This sheet's two ungated sources are the whole point: a harness
        // for the network fetch alone leaves the on-device memories live while still being
        // called "the memory harness".
        val learnings = code.indexOf("MemoryHarness.learnings(", sheet)
        assertTrue("MemorySheet never substitutes the SERVER half (MemoryHarness.learnings())",
            learnings in (gate + 1) until fetch)
        val localSub = code.indexOf("MemoryHarness.localEntries(", sheet)
        assertTrue("MemorySheet never substitutes the ON-DEVICE half " +
            "(MemoryHarness.localEntries()) — a harness for one source is not a harness " +
            "for this sheet", localSub > gate)

        // And the gate is handed the real build flag. Passing a literal `true` would
        // compile, pass every test above, and arm the harness on a shipped APK.
        val args = code.substring(gate, code.indexOf(')', gate) + 1)
        assertTrue("the gate is not passed BuildConfig.DEBUG: $args", args.contains("BuildConfig.DEBUG"))
        assertTrue("the gate is not passed the process flag: $args", args.contains("memoryHarness"))
    }

    /**
     * ⚠️ The mutating-controls check, which is what makes this harness different from its
     * two read-only siblings. Both delete handlers end at the real source — one re-reads
     * `Continuity.loadMemories`, one sends `DELETE /api/learnings` — so under a harness a
     * single tap would either swap the user's real memories into the frame or write to
     * their real account. Both are guarded, and this asserts the guard sits between the
     * handler and the real call rather than merely existing in the file.
     */
    @Test fun `neither delete reaches the device store or the account under the harness`() {
        val code = liveCode()
        val sheet = code.indexOf("fun MemorySheet(")

        /*
         * ⚠️ Each guard is anchored INSIDE ITS OWN ROW BLOCK, not merely "somewhere before
         * the call". The first draft of this test used `lastIndexOf("if (demo)", forget)`
         * and a mutant that deleted the local guard entirely still PASSED — because the
         * server-fetch guard sits earlier in the same function and satisfied the search.
         * 🔑 **A guard-exists assertion that scans the whole enclosing function proves the
         * FILE has a guard, not that this call site does.** Bound the search at the
         * `items(...)` that opens the row's own lambda.
         */

        // Local: the re-read of the real store must be guarded, and the guard must be in
        // the local row's lambda.
        val localRows = code.indexOf("items(local", sheet)
        assertTrue("the local rows are gone from MemorySheet — re-anchor", localRows > sheet)
        val forget = code.indexOf("continuity.forgetMemory(", localRows)
        assertTrue("the local delete no longer calls forgetMemory — re-anchor", forget > localRows)
        val reread = code.indexOf("continuity.loadMemories(", forget)
        assertTrue("the local delete no longer re-reads Continuity — re-anchor", reread > forget)
        val localGuard = code.indexOf("if (demo)", localRows)
        assertTrue("nothing guards the LOCAL delete: a tap on a demo row calls " +
            "forgetMemory + loadMemories and swaps the user's real memories into the shot",
            localGuard in (localRows + 1) until forget)

        // Server: the DELETE must be guarded too, inside the server row's lambda.
        val serverRows = code.indexOf("items(server!!", sheet)
        assertTrue("the server rows are gone from MemorySheet — re-anchor", serverRows > sheet)
        val del = code.indexOf("deleteJson(\"/api/learnings\"", serverRows)
        assertTrue("the server delete no longer calls deleteJson — re-anchor", del > serverRows)
        val serverGuard = code.indexOf("if (demo)", serverRows)
        assertTrue("nothing guards the SERVER delete: a tap on a demo row sends a real " +
            "DELETE to the user's account, and the standing rule is to seed content and " +
            "never mutate the account for an asset", serverGuard in (serverRows + 1) until del)
    }

    /**
     * The extra has to be READ somewhere or the flag can never be armed, and the read has
     * to land on the process-scoped field the gate is passed. A harness wired to nothing
     * passes every test above.
     */
    @Test fun `MainActivity arms the flag from the extra`() {
        val src = java.io.File("src/main/java/technology/tiny/app/MainActivity.kt")
        assertTrue("MainActivity.kt not found at ${src.absolutePath} — re-anchor", src.isFile)
        val code = stripComments(src.readText())
        val read = code.indexOf("MemoryHarness.EXTRA_MEMORY")
        assertTrue("MainActivity never reads MemoryHarness.EXTRA_MEMORY, so the extra can " +
            "never arm the harness", read >= 0)
        val set = code.indexOf("memoryHarness = true", read)
        assertTrue("the extra is read but never sets app.memoryHarness", set > read)
    }

    private fun liveCode(): String {
        // cwd for JVM unit tests is android/app — verified, not assumed.
        val src = java.io.File("src/main/java/technology/tiny/app/ui/MemoryUniverse.kt")
        // A moved file must FAIL, not vacuously pass.
        assertTrue("MemoryUniverse.kt not found at ${src.absolutePath} — re-anchor", src.isFile)
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
