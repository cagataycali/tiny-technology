package technology.tiny.app.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * isStale — the home-screen widget's "≥2h old → open the app to sync" rule
 * (iOS TinyStatus parity, TinyWidgets.swift:41 `updated < now - 2*3600`). This is
 * the ONLY pure branch in the Glance widget code; everything else is framework
 * rendering. Pinning it locks two things a silent regression would break:
 *   - the exact 2h threshold (a drift would nag too early or hide a dead widget)
 *   - the DELIBERATE `updated > 0` deviation from iOS: a never-populated snapshot
 *     (default 0L) reads NOT stale on Android, where iOS's distantPast reads stale.
 *
 * `now` is injected (the widget process can't call the app's disallowed clock), so
 * these are plain arithmetic — no Robolectric needed.
 */
class TinyWidgetsTest {

    private val TWO_H = 2 * 3600_000L
    private val now = 1_700_000_000_000L // fixed anchor (Date.now unavailable in tests)

    private fun snap(updated: Long) = FleetSnapshot(online = 1, total = 2, updated = updated)

    @Test fun `a snapshot updated just now is fresh`() {
        assertFalse(isStale(snap(now), now))
    }

    @Test fun `a snapshot updated under two hours ago is fresh`() {
        assertFalse(isStale(snap(now - TWO_H + 1), now))       // 1ms shy of the cutoff
        assertFalse(isStale(snap(now - 90 * 60_000L), now))    // 90 min
    }

    @Test fun `a snapshot exactly two hours old is still fresh — the boundary is exclusive`() {
        // isStale uses strictly-less-than (updated < now - 2h), so the instant it
        // turns 2h it is NOT yet stale — matching iOS's `<`.
        assertFalse(isStale(snap(now - TWO_H), now))
    }

    @Test fun `a snapshot past two hours is stale`() {
        assertTrue(isStale(snap(now - TWO_H - 1), now))        // 1ms past
        assertTrue(isStale(snap(now - 3 * 3600_000L), now))    // 3h
    }

    @Test fun `a never-populated snapshot reads NOT stale — deliberate deviation from iOS`() {
        // default updated = 0L: the `updated > 0` guard means a freshly-added widget
        // (before the app heartbeat ever writes the store) shows neutral counts, not
        // the sync nudge iOS shows for its distantPast default. This is the pinned
        // Android contract; if we ever want the iOS first-add nudge, drop the guard.
        assertFalse(isStale(FleetSnapshot(), now))             // updated defaults to 0L
        assertFalse(isStale(snap(0L), now))
    }

    @Test fun `a negative or garbage past timestamp is guarded, not treated as ancient-stale`() {
        // A corrupt store could yield a negative updated; the `> 0` guard keeps it
        // out of the stale branch rather than rendering "open to sync" on junk data.
        assertFalse(isStale(snap(-1L), now))
    }

    // ── Accessibility descriptions ────────────────────────────────────────────
    // Without these, TalkBack reads the widgets' raw child text — bare emoji
    // glyphs ("seedling", "green circle") with no statement of what a tap does.
    // Each builder must announce the CONTENT and the TAP ACTION, and carry no
    // bare status emoji. `now` is injected (no Date.now in tests).

    private fun noBareEmoji(s: String) {
        // The status/rotation emoji that were being read aloud as glyph names.
        listOf("🌱", "🟢", "⚫", "💬", "🧠", "⚡", "🎙").forEach {
            assertFalse("description must not contain the bare emoji $it: \"$s\"", s.contains(it))
        }
    }

    @Test fun `status a11y states counts, unread, and the tap destination`() {
        val s = statusA11y(FleetSnapshot(online = 2, total = 3, unread = 0, updated = now), now)
        assertTrue(s.contains("2 of 3")); assertTrue(s.contains("no unread messages"))
        assertTrue("empty-unread taps to ask", s.contains("Tap to ask"))
        noBareEmoji(s)
    }

    @Test fun `status a11y routes to messages and singularizes one unread`() {
        val s = statusA11y(FleetSnapshot(online = 1, total = 1, unread = 1, updated = now), now)
        assertTrue(s.contains("1 unread message") && !s.contains("1 unread messages"))
        assertTrue("unread taps to messages", s.contains("Tap to open messages"))
    }

    @Test fun `status a11y surfaces the stale nudge instead of counts`() {
        val s = statusA11y(FleetSnapshot(online = 9, total = 9, updated = now - 3 * 3600_000L), now)
        assertTrue(s.contains("out of date")); assertTrue(s.contains("sync"))
        assertFalse("stale must not read fake counts", s.contains("9 of 9"))
    }

    @Test fun `last-answer a11y reads the answer and the question, else the empty prompt`() {
        val empty = lastAnswerA11y(FleetSnapshot(lastA = null))
        assertTrue(empty.contains("No answers yet")); assertTrue(empty.contains("tap to ask"))
        val full = lastAnswerA11y(FleetSnapshot(lastQ = "weather?", lastA = "Sunny, 20°."))
        assertTrue(full.contains("weather?")); assertTrue(full.contains("Sunny, 20°."))
        assertTrue(full.contains("Tap to ask again"))
        noBareEmoji(full)
    }

    @Test fun `memory a11y reads the rotating fact with position, else the empty prompt`() {
        assertTrue(memoryA11y(FleetSnapshot(memories = emptyList()), now).contains("Nothing remembered yet"))
        val one = memoryA11y(FleetSnapshot(memories = listOf("likes tea")), now)
        assertTrue(one.contains("likes tea")); assertFalse("single fact has no position", one.contains(" of "))
        // Two facts: the deterministic index must fall in range and show "N of 2".
        val two = memoryA11y(FleetSnapshot(memories = listOf("a", "b")), now)
        assertTrue(two.contains("of 2")); assertTrue(two.contains("Tap to open memory"))
        noBareEmoji(two)
    }

    @Test fun `memory a11y announces the SAME fact and position the body renders — shared index formula`() {
        // The regression this guards: the visible widget body and the a11y string
        // each derived the rotation index from their OWN clock read; a 20-min boundary
        // between the two reads within one provideGlance made TalkBack announce a
        // different fact than shown. Both now consult memoryIdx(total, now), so for a
        // FIXED now the announced position must equal the index the body would render.
        val mems = listOf("a", "b", "c")
        // Pick a `now` sitting ON a rotation boundary (the exact instant idx increments)
        // — the worst case for two independent reads — and one just before it.
        val boundary = (20 * 60_000L) * 7 // idx = 7 % 3 = 1 → "b", position 2 of 3
        val justBefore = boundary - 1     // idx = (boundary-1)/20min = 6 → 6 % 3 = 0 → "a"
        assertEquals(1, memoryIdx(mems.size, boundary))
        assertEquals(0, memoryIdx(mems.size, justBefore))
        val at = memoryA11y(FleetSnapshot(memories = mems), boundary)
        assertTrue("announces the body's fact", at.contains("b."))
        assertTrue("announces the body's position", at.contains("(2 of 3)"))
        val before = memoryA11y(FleetSnapshot(memories = mems), justBefore)
        assertTrue(before.contains("a.")); assertTrue(before.contains("(1 of 3)"))
        assertEquals("empty list is index 0, never a crash", 0, memoryIdx(0, boundary))
    }

    @Test fun `briefing a11y distinguishes idle from running`() {
        assertTrue(briefingA11y(running = false).contains("Tap to run"))
        val run = briefingA11y(running = true)
        assertTrue(run.contains("running")); assertFalse("running state has no tap CTA", run.contains("Tap to run"))
        noBareEmoji(run)
    }

    @Test fun `ask a11y states the voice flow`() {
        val s = askA11y()
        assertTrue(s.contains("voice")); assertTrue(s.contains("speak")); assertTrue(s.contains("3 second"))
        noBareEmoji(s)
    }
}
