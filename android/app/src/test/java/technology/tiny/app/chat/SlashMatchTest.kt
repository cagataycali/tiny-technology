package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SlashCommand.matches / .score — the palette's membership filter AND its
 * ranking. matches() decides WHICH commands a typed query surfaces; score()
 * decides their ORDER (the palette sorts ascending, so the best match is the
 * top row a tap/Enter runs). Both are the EXACT port of web
 * CommandPalette.fuzzyScore (CommandPalette.tsx:70), folded over name OR
 * description (min of the two). iOS realigned to the same ranking (cycle 68);
 * Android previously filtered in static declaration order, so this pins the
 * ranking too — it's no longer "a separate concern the clients disagree on."
 *   - empty query → everything matches, score 0 (bare "/" opens the full list)
 *   - a substring of name OR description matches; score = its index (earlier wins)
 *   - a scattered subsequence matches ("mem" → memories); score = 100 + gaps
 *   - a substring hit (score < 100) always outranks any subsequence (score ≥ 100)
 *   - case-insensitive
 *   - a char not present as a subsequence → no match (score null)
 */
class SlashMatchTest {

    private fun cmd(name: String, description: String) =
        SlashCommand(name, description, insert = "/$name")

    @Test fun `empty query matches everything — bare slash opens the full list`() {
        val c = cmd("clear", "Wipe the conversation")
        assertTrue(c.matches(""))
        // And it holds for EVERY catalog entry, so "/" never yields an empty palette.
        assertTrue(SLASH_COMMANDS.all { it.matches("") })
    }

    @Test fun `a substring of the name matches`() {
        assertTrue(cmd("memory", "Memory panel").matches("mem"))
        assertTrue(cmd("wallet", "Balance and deposits").matches("wall"))
    }

    @Test fun `a scattered subsequence of the name matches (web fuzzyScore parity)`() {
        // "shr" is not a substring of "share" but is a subsequence — web's
        // issue-#11 example. Same for "mmr" → "memory".
        assertTrue(cmd("share", "Share this conversation").matches("shr"))
        assertTrue(cmd("memory", "Memory panel").matches("mmr"))
    }

    @Test fun `matching falls through to the description when the name misses`() {
        // "balance" isn't in the name "wallet" but is in its description.
        assertTrue(cmd("wallet", "Balance, deposit, withdraw").matches("balance"))
    }

    @Test fun `matching is case-insensitive on both query and target`() {
        assertTrue(cmd("Clear", "Wipe").matches("CL"))
        assertTrue(cmd("clear", "WIPE").matches("wipe"))
    }

    @Test fun `a char absent as a subsequence does not match`() {
        // "clearz" — the trailing z appears in neither name nor description.
        assertFalse(cmd("clear", "Wipe the conversation").matches("clearz"))
        assertFalse(cmd("jobs", "Scheduled background jobs").matches("xyz"))
    }

    @Test fun `out-of-order query is not a subsequence`() {
        // Subsequence is order-preserving: "rae" is not a subsequence of "clear"
        // (chars present, wrong order) and "rae" isn't in the description either.
        assertFalse(cmd("clear", "Wipe").matches("rae"))
    }

    @Test fun `the real catalog surfaces the expected commands for common queries`() {
        // A characterization pin over the SHIPPING catalog: typing these opens the
        // command you'd expect (guards against a future rename silently dropping it).
        assertTrue("'/mem' should surface memory", SLASH_COMMANDS.any { it.name == "memory" && it.matches("mem") })
        assertTrue("'/wall' should surface wallet", SLASH_COMMANDS.any { it.name == "wallet" && it.matches("wall") })
        assertTrue("'/graph' should surface graph", SLASH_COMMANDS.any { it.name == "graph" && it.matches("graph") })
        assertTrue("'/near' should surface nearby", SLASH_COMMANDS.any { it.name == "nearby" && it.matches("near") })
        // The chain explorer is only reachable by /chain or the overflow menu — if a
        // rename drops the catalog entry, `/chain` falls through to the agent as
        // literal text and the screen becomes unreachable from the composer.
        assertTrue("'/chain' should surface chain", SLASH_COMMANDS.any { it.name == "chain" && it.matches("chain") })
    }

    @Test fun `the catalog is non-empty and every entry has a routable insert`() {
        // A palette pick sends `insert`; an entry whose insert doesn't start with
        // "/" would send plain text to the agent instead of running the command.
        assertTrue(SLASH_COMMANDS.isNotEmpty())
        assertTrue(SLASH_COMMANDS.all { it.insert.startsWith("/") })
    }

    @Test fun `command names are unique — no two entries collide in the catalog`() {
        val names = SLASH_COMMANDS.map { it.name }
        assertEquals(names.size, names.toSet().size)
    }

    // -- score / ranking (web fuzzyScore parity, CommandPalette.tsx:70) --

    @Test fun `empty query scores 0`() {
        assertEquals(0, cmd("clear", "Wipe").score(""))
    }

    @Test fun `a non-match scores null`() {
        assertEquals(null, cmd("clear", "Wipe the conversation").score("clearz"))
    }

    @Test fun `a substring scores its start index — earlier is better`() {
        // "wall" is at index 0 of the name "wallet".
        assertEquals(0, cmd("wallet", "Balance").score("wall"))
        // "ally" starts at index 1 of the name "wally".
        assertEquals(1, cmd("wally", "x").score("ally"))
    }

    @Test fun `a substring hit always outranks a scattered subsequence`() {
        // Name "share": "shr" is a scattered subsequence (score ≥ 100); on the
        // description "Share history" the substring "sha" would score < 100.
        val subsequenceOnly = cmd("share", "Zzz").score("shr")!!
        val substringHit = cmd("share", "Zzz").score("sha")!!
        assertTrue("subsequence scores ≥ 100", subsequenceOnly >= 100)
        assertTrue("substring scores < 100", substringHit < 100)
        assertTrue("substring outranks subsequence", substringHit < subsequenceOnly)
    }

    @Test fun `score folds name OR description to the better (lower) of the two`() {
        // Query hits the description as a substring (good) but the name only as a
        // scattered subsequence (worse) — score takes the min.
        val c = cmd("wallet", "balance")
        // "bal" — substring of description (index 0), not in name at all.
        assertEquals(0, c.score("bal"))
    }

    @Test fun `ranking surfaces the intuitive top command for a query — declaration order does not win`() {
        // "mem" — /memory matches as a name-substring at index 0 (score 0). Any
        // OTHER catalog entry that also matches "mem" does so only via description
        // subsequence (score ≥ 100), so sorting by score puts /memory first
        // regardless of where it sits in the declaration list.
        val ranked = SLASH_COMMANDS
            .mapNotNull { c -> c.score("mem")?.let { c to it } }
            .sortedBy { it.second }
            .map { it.first }
        assertEquals("memory", ranked.first().name)
    }

    @Test fun `equal scores preserve declaration order — sortedBy is stable`() {
        // Two synthetic commands with an identical name-substring score; the sort
        // must keep the input order (Kotlin sortedBy is stable), matching web's
        // stable sections useMemo.
        val a = cmd("export", "x")
        val b = cmd("expand", "y")
        val ranked = listOf(a, b)
            .mapNotNull { c -> c.score("exp")?.let { c to it } }
            .sortedBy { it.second }
            .map { it.first }
        assertEquals(listOf("export", "expand"), ranked.map { it.name })
    }
}
