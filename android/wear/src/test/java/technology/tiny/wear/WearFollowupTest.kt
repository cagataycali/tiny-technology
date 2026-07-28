package technology.tiny.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import technology.tiny.app.wear.WatchCore

/**
 * WearFollowup is the wrist's face-button follow-up gate (iOS FollowupIntent /
 * W7). These pin that a fresh chip resolves, everything stale/blank/absent decays
 * to null, and the steer is distinct from the dictation and briefing steers so the
 * server can tell the three apart. Pure + deterministic — `now` is passed in.
 */
class WearFollowupTest {

    private val now = 1_000_000_000L
    private val fresh = now - 1000L // 1s ago — well inside the 30-min window
    private val stale = now - WatchCore.FOLLOWUP_FRESH_MS - 1L // just past the window

    @Test fun `a fresh non-empty followup resolves to itself (trimmed)`() {
        assertEquals("what about tomorrow?", WearFollowup.resolve("  what about tomorrow?  ", fresh, now))
    }

    @Test fun `a stale followup resolves to null (the button decays)`() {
        assertNull(WearFollowup.resolve("old question", stale, now))
    }

    @Test fun `a null timestamp resolves to null`() {
        assertNull(WearFollowup.resolve("has text but no when", null, now))
    }

    @Test fun `a null followup resolves to null`() {
        assertNull(WearFollowup.resolve(null, fresh, now))
    }

    @Test fun `a blank followup resolves to null`() {
        assertNull(WearFollowup.resolve("   ", fresh, now))
    }

    @Test fun `the freshness boundary is exclusive (exactly-at-edge is stale)`() {
        // isFresh is `at > now - WINDOW`, so a chip exactly WINDOW old is NOT fresh.
        val edge = now - WatchCore.FOLLOWUP_FRESH_MS
        assertNull(WearFollowup.resolve("edge", edge, now))
        // …but one millisecond newer is.
        assertEquals("edge", WearFollowup.resolve("edge", edge + 1, now))
    }

    @Test fun `steer prefixes the followup and is distinct from dictation and briefing steers`() {
        val steered = WearFollowup.steer("why is that?")
        assertTrue(steered.startsWith(WearFollowup.FOLLOWUP_STEER))
        assertTrue(steered.endsWith("why is that?"))
        assertTrue("follow-up steer must be its own string", WearFollowup.FOLLOWUP_STEER != WRIST_STEER)
        assertTrue("follow-up steer must differ from briefing", WearFollowup.FOLLOWUP_STEER != WearBriefing.BRIEFING_STEER)
    }

    @Test fun `faceTap prefers a fresh followup as the tap target`() {
        assertEquals(WearFollowup.FaceTap.FOLLOWUP, WearFollowup.faceTap("what next?", fresh, now))
    }

    @Test fun `faceTap falls back to briefing when the followup is stale or absent`() {
        assertEquals(WearFollowup.FaceTap.BRIEFING, WearFollowup.faceTap("old", stale, now))
        assertEquals(WearFollowup.FaceTap.BRIEFING, WearFollowup.faceTap(null, fresh, now))
        assertEquals(WearFollowup.FaceTap.BRIEFING, WearFollowup.faceTap("  ", fresh, now))
    }
}
