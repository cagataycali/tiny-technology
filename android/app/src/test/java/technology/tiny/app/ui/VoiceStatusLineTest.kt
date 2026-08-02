package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import technology.tiny.app.fleet.VoiceStatus

/**
 * 🎙️🕰️ The Nicla Voice panel's status line — `voiceUptime` + `voiceStatusLine`.
 *
 * Both phones printed the same wire-shaped string:
 *   "${s.labels} wake word(s) · ${s.wakes} heard · up ${s.uptimeS}s"
 *
 * Two defects in one line. The seconds were raw, so a necklace worn since
 * breakfast read "up 41293s" in a sentence otherwise written in words. And
 * `handleStatus` decodes that JSON with `optInt` — a missing key is expected in a
 * 64-byte BLE notify, not exceptional — so two of the three zeroes were alarms
 * the board never raised: "up 0s" (on a wearable, a reset loop) and "0 wake
 * words" (a net that can never hear you), the latter printed directly beneath a
 * green "listening" badge asserting the opposite.
 *
 * The iOS twin is VoiceFmtTests in ios/Tests/TinyTests.swift and the two output
 * strings are pinned identical by tests/nicla-android-parity.test.ts. Ladder
 * parity with this file's `ago()` is deliberate — see ActivityAgoTest.
 */
class VoiceStatusLineTest {

    @Test fun `uptime climbs the same ladder ago() does`() {
        assertEquals("1s", voiceUptime(1))
        assertEquals("59s", voiceUptime(59))
        assertEquals("1m", voiceUptime(60))
        assertEquals("59m", voiceUptime(3_599))
        assertEquals("1h", voiceUptime(3_600))
        assertEquals("23h", voiceUptime(86_399))
        assertEquals("1d", voiceUptime(86_400))
        // The number that started this: a necklace up since breakfast.
        assertEquals("11h", voiceUptime(41_293))
        // Integer-floored, like ago() — an hour-old board stays "1h" until 2h
        // rather than looking precise to a minute it isn't sure of.
        assertEquals("1h", voiceUptime(7_199))
    }

    @Test fun `an unreported uptime says nothing rather than rebooted`() {
        // 0 is what a missing "up" key decodes to, and "up 0s" on something you
        // wear is the signature of a crash loop. This is the difference between
        // a quiet panel and a permanent false alarm.
        assertNull(voiceUptime(0))
        // Never observed, but the wire is JSON and a negative would otherwise
        // fall through the ladder as "up -5s".
        assertNull(voiceUptime(-5))
    }

    @Test fun `a full status reads as one sentence of words`() {
        assertEquals(
            "3 wake words · 12 heard · up 11h",
            voiceStatusLine(VoiceStatus(labels = 3, wakes = 12, uptimeS = 41_293)),
        )
        // Singular survived the rewrite.
        assertEquals(
            "1 wake word · 1 heard · up 45s",
            voiceStatusLine(VoiceStatus(labels = 1, wakes = 1, uptimeS = 45)),
        )
    }

    @Test fun `a zero drops its segment instead of narrating it`() {
        // No "up" from the board: the rest of the line still stands.
        assertEquals(
            "3 wake words · 0 heard",
            voiceStatusLine(VoiceStatus(labels = 3, wakes = 0, uptimeS = 0)),
        )
        // No "l": "0 wake words" would contradict the listening badge above it.
        assertEquals(
            "4 heard · up 10m",
            voiceStatusLine(VoiceStatus(labels = 0, wakes = 4, uptimeS = 600)),
        )
        // A board that answered with nothing quantified gets no line at all —
        // not a bare "0 heard", whose only content is a number that may never
        // have arrived, and not a stray "·" either.
        assertNull(voiceStatusLine(VoiceStatus()))
    }

    @Test fun `the line never ends up with a dangling separator`() {
        // The old string hard-coded two "·"s, so any empty segment left one
        // hanging. Every reachable combination, checked for shape not content.
        for (labels in listOf(0, 1, 3)) {
            for (wakes in listOf(0, 7)) {
                for (up in listOf(0, 30, 90_000)) {
                    val line = voiceStatusLine(
                        VoiceStatus(labels = labels, wakes = wakes, uptimeS = up),
                    ) ?: continue
                    assertTrue("dangling: $line", !line.startsWith("·") && !line.endsWith("·"))
                    assertTrue("empty segment: $line", !line.contains("··"))
                    assertTrue("invented a reboot: $line", !line.contains("up 0"))
                }
            }
        }
    }

    // ── the gate: what this phone may still SPEAK for ────────────────────────

    /**
     * A board that was listening when the link dropped — the reading the panel
     * held on to. `ndpUp && micOn` is what `listening` means, so this is a status
     * that renders a GREEN "listening" badge if anything draws it.
     */
    private val wasListening = VoiceStatus(ndpUp = true, micOn = true, labels = 3, wakes = 12, uptimeS = 41_293)

    @Test fun `a necklace in a drawer stops claiming to listen`() {
        // The defect: `_status` is cleared in NiclaVoiceGateway.forget() ONLY —
        // never on disconnect, deliberately, because a wake delivered over a link
        // that dropped a second later still has to reach the row. So the panel
        // drew "out of range" and, on the same line, a green "listening".
        assertTrue("this fixture would not draw a green badge", wasListening.listening)
        assertNull("the badge speaks for a board out of range", liveVoiceStatus(wasListening, connected = false))
    }

    @Test fun `while connected the reading passes through untouched`() {
        // The gate withholds; it must not edit. A copy or a defaulted field here
        // would silently change what the badge reports about a live board.
        assertEquals(wasListening, liveVoiceStatus(wasListening, connected = true))
        assertTrue(liveVoiceStatus(wasListening, connected = true)!!.listening)
    }

    @Test fun `the badge still tells deaf apart from listening`() {
        // The fix must not swallow the badge whenever it is inconvenient: a loaded
        // board with a dead mic looks identical from outside — it advertises, it
        // looks online, it just never hears anything — and this badge is the only
        // surface that catches it. Only the LINK gates the reading, never the
        // reading's own content.
        val deaf = wasListening.copy(micOn = false)
        assertTrue("a deaf board claims to listen", !deaf.listening)
        assertEquals("a deaf board was withheld along with the stale ones", deaf, liveVoiceStatus(deaf, connected = true))
    }

    @Test fun `nothing known stays nothing, connected or not`() {
        // Before the first status notify arrives there is no reading at all, and
        // the gate must not invent a default one — VoiceStatus() would render a
        // grey "not listening" for a board that simply hasn't answered yet.
        assertNull(liveVoiceStatus(null, connected = true))
        assertNull(liveVoiceStatus(null, connected = false))
    }

    @Test fun `the badge and the detail line are gated by ONE decision`() {
        // The bug was one ungated read among TWO: the detail line
        // ("3 wake words · 12 heard · up 11h") already had its `connected` check
        // and correctly went away, while the badge beside it did not. Whatever the
        // gate returns, both callers get the same answer — so the panel can never
        // show half a stale reading.
        for (connected in listOf(true, false)) {
            val gated = liveVoiceStatus(wasListening, connected)
            val line = gated?.let(::voiceStatusLine)
            assertEquals(
                "badge and detail line disagree at connected=$connected",
                gated == null,
                line == null,
            )
        }
    }
}
