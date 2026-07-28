package technology.tiny.app.chat

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.TimeZone

/**
 * Pure continuity-context assembly (web continuity.ts + iOS Continuity.swift byte
 * parity) — the "## Persistent Memories" + "## Continuous Turn Log" section the
 * server agent sees on EVERY platform. A drift here makes Android send a different
 * context string than web/iOS, breaking the one-format-across-surfaces invariant.
 * Pure Kotlin, runs on the local JVM (filesDir I/O is exercised on-device).
 */
class ContinuityTest {

    // The "M/d H:mm" format is device-LOCAL by design (matches web getHours());
    // pin UTC so these assertions are deterministic across CI/dev machines.
    private var saved: TimeZone? = null

    @Before fun pinUtc() {
        saved = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restore() {
        saved?.let { TimeZone.setDefault(it) }
    }

    // 2021-01-02T03:04:05Z → "1/2 3:04" under UTC + Locale.US ("M/d H:mm").
    private val TS = 1_609_556_645_000L

    private fun mem(content: String, tags: List<String> = emptyList()) =
        MemoryEntry(id = "m", content = content, tags = tags, ts = TS)

    // ---- empty ----------------------------------------------------------------

    @Test fun `nothing to inject yields null`() {
        assertNull(Continuity.renderContext(emptyList(), emptyList()))
    }

    // ---- memories block --------------------------------------------------------

    @Test fun `a memory without tags is a plain dashed line`() {
        assertEquals(
            "## Persistent Memories (stored via remember tool, survives resets):\n- likes tea",
            Continuity.renderContext(listOf(mem("likes tea")), emptyList()),
        )
    }

    @Test fun `tags render in a bracketed comma-joined suffix`() {
        assertEquals(
            "## Persistent Memories (stored via remember tool, survives resets):\n- likes tea [drink, warm]",
            Continuity.renderContext(listOf(mem("likes tea", listOf("drink", "warm"))), emptyList()),
        )
    }

    @Test fun `multiple memories join with a single newline, no trailing newline`() {
        val out = Continuity.renderContext(listOf(mem("a"), mem("b")), emptyList())!!
        assertEquals(
            "## Persistent Memories (stored via remember tool, survives resets):\n- a\n- b",
            out,
        )
        assertTrue("must not end with a trailing newline", !out.endsWith("\n"))
    }

    // ---- turn-log block --------------------------------------------------------

    @Test fun `a turn renders the local timestamp, user and you lines`() {
        assertEquals(
            "## Continuous Turn Log (last 1 turns, survives history clears):\n" +
                "[1/2 3:04] user: hi\n→ you: hello",
            Continuity.renderContext(emptyList(), listOf(TurnEntry("hi", "hello", TS))),
        )
    }

    @Test fun `turn count in the header reflects the injected turns`() {
        val out = Continuity.renderContext(
            emptyList(),
            listOf(TurnEntry("q1", "a1", TS), TurnEntry("q2", "a2", TS)),
        )!!
        assertTrue(out.startsWith("## Continuous Turn Log (last 2 turns, survives history clears):\n"))
        assertTrue("must not end with a trailing newline", !out.endsWith("\n"))
    }

    // ---- both blocks (the byte-parity assembly) -------------------------------

    @Test fun `memories and turns are joined by exactly one blank line`() {
        val out = Continuity.renderContext(
            listOf(mem("likes tea")),
            listOf(TurnEntry("hi", "hello", TS)),
        )
        assertEquals(
            "## Persistent Memories (stored via remember tool, survives resets):\n- likes tea" +
                "\n\n" +
                "## Continuous Turn Log (last 1 turns, survives history clears):\n[1/2 3:04] user: hi\n→ you: hello",
            out,
        )
    }

    // ---- account-switch scrub scope -------------------------------------------
    // scrubAllLocal wipes per-tiny stores when a DIFFERENT account signs in. The
    // bug this pins: the scope was too narrow (turnlog + memories only), leaving
    // the readable chat transcript (chat-history-*) and named-session archives
    // (sessions/) — visible message content — on disk for the next user.

    @Test fun `turn-log and memory files are scrubbed`() {
        assertTrue(Continuity.isScrubbableLocalFile("tiny_turnlog_scout.json"))
        assertTrue(Continuity.isScrubbableLocalFile("tiny_memories_scout.json"))
    }

    @Test fun `the readable chat transcript is scrubbed (the leak this closed)`() {
        assertTrue(Continuity.isScrubbableLocalFile("chat-history-scout.json"))
        assertTrue(Continuity.isScrubbableLocalFile("chat-history-priv-example-a1b2.json"))
    }

    @Test fun `the named-session archive directory is scrubbed`() {
        assertTrue(Continuity.isScrubbableLocalFile("sessions"))
    }

    @Test fun `anonymous-share tokens are NOT scrubbed — they aren't identity-scoped`() {
        // tiny_my_shares.json holds revokeTokens returned once at creation; wiping
        // them on a switch would irrecoverably orphan anonymous shares.
        assertFalse(Continuity.isScrubbableLocalFile("tiny_my_shares.json"))
    }

    @Test fun `unrelated app files are left alone`() {
        assertFalse(Continuity.isScrubbableLocalFile("profileInstalled"))
        assertFalse(Continuity.isScrubbableLocalFile("datastore"))
        // A file that merely CONTAINS a scrub keyword mid-name is not matched
        // (prefix/exact only, so we can't nuke an unrelated store by accident).
        assertFalse(Continuity.isScrubbableLocalFile("keep-chat-history-note.txt"))
    }
}
