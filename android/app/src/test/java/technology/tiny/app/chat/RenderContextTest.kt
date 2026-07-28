package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Continuity.renderContext is the pure half of buildContext — it assembles the
 * injected context section from already-loaded memories + turns, so it's testable
 * without filesDir. This string is a BYTE-PARITY contract: web (continuity.ts) and
 * iOS (Continuity.swift) must produce the identical section, or Android sends the
 * server a different context than the other surfaces. These tests pin the headers,
 * the tag suffix, the timestamp format, and the null/empty cases.
 *
 * Turn timestamps render via a local-timezone SimpleDateFormat, so expected values
 * are computed with the SAME formatter rather than hardcoded (timezone-independent).
 */
class RenderContextTest {

    private fun mem(content: String, tags: List<String> = emptyList()) =
        MemoryEntry(id = "x", content = content, tags = tags, ts = 0L)

    private fun turn(q: String, a: String, ts: Long) = TurnEntry(q = q, a = a, ts = ts)

    private fun stamp(ts: Long) = SimpleDateFormat("M/d H:mm", Locale.US).format(Date(ts))

    @Test fun `no memories and no turns yields null`() {
        assertNull(Continuity.renderContext(emptyList(), emptyList()))
    }

    @Test fun `memories-only section has the header and bullet lines`() {
        val out = Continuity.renderContext(listOf(mem("likes green tea")), emptyList())!!
        // NO trailing newline: web continuity.ts joins bullets with "\n" and adds
        // none after the last (parts.join("\n\n")). Pinning the exact string guards
        // the byte-parity contract against the old StringBuilder's stray trailing \n.
        assertEquals(
            "## Persistent Memories (stored via remember tool, survives resets):\n" +
                "- likes green tea",
            out,
        )
    }

    @Test fun `a tagged memory appends the bracketed tag suffix`() {
        val out = Continuity.renderContext(listOf(mem("ships on fridays", listOf("work", "cadence"))), emptyList())!!
        assertTrue(out.contains("- ships on fridays [work, cadence]"))
    }

    @Test fun `turns-only section carries the count and the arrow format`() {
        val ts = 1_600_000_000_000L
        val out = Continuity.renderContext(emptyList(), listOf(turn("hi", "hello", ts)))!!
        // No trailing newline after the final "→ you: …" line (web parity).
        assertEquals(
            "## Continuous Turn Log (last 1 turns, survives history clears):\n" +
                "[${stamp(ts)}] user: hi\n→ you: hello",
            out,
        )
    }

    @Test fun `memories and turns are separated by a blank line`() {
        val ts = 1_600_000_000_000L
        val out = Continuity.renderContext(listOf(mem("m1")), listOf(turn("q", "a", ts)))!!
        // The memories block ends "\n", then a lone "\n" separator precedes the turn header.
        assertTrue(out.contains("- m1\n\n## Continuous Turn Log"))
    }

    @Test fun `the turn count reflects the number of turns rendered`() {
        val turns = (1..3).map { turn("q$it", "a$it", 1_600_000_000_000L + it) }
        val out = Continuity.renderContext(emptyList(), turns)!!
        assertTrue(out.contains("(last 3 turns,"))
    }

    @Test fun `an untagged memory has no bracket`() {
        val out = Continuity.renderContext(listOf(mem("plain fact")), emptyList())!!
        assertTrue(out.contains("- plain fact"))
        assertTrue("no empty bracket for a tagless memory", !out.contains("["))
    }
}
