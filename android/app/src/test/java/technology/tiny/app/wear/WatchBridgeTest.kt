package technology.tiny.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WatchBridge.sessionPayload is the phone → watch `/tiny/session` DataItem
 * contract — the exact keys the wrist's PhoneLinkService reads back. These pin
 * the ONE rule that matters for the identity scrub: a logout MUST carry no token
 * (and no accent), so a stale/prior session can never ride along and silently
 * undo the wrist's scrub (the same hazard the iOS logout-context guard fixes).
 */
class WatchBridgeTest {

    @Test fun `login payload carries token, accent, and a fresh timestamp`() {
        val p = WatchBridge.sessionPayload(loggedOut = false, token = "jwt123", accent = "#00FF88", now = 42L)
        assertEquals(false, p["loggedOut"])
        assertEquals("jwt123", p["token"])
        assertEquals("#00FF88", p["accent"])
        assertEquals(42L, p["ts"])
    }

    @Test fun `login without an accent omits the key (watch falls back to green)`() {
        val p = WatchBridge.sessionPayload(loggedOut = false, token = "jwt", accent = null, now = 1L)
        assertEquals("jwt", p["token"])
        assertFalse(p.containsKey("accent"))
    }

    @Test fun `logout carries NO token and NO accent — only the scrub flag`() {
        // The critical invariant: a logout item must not smuggle a session back
        // to the wrist, or PhoneLinkService's scrub is silently undone.
        val p = WatchBridge.sessionPayload(loggedOut = true, token = "should-be-dropped", accent = "#fff", now = 7L)
        assertEquals(true, p["loggedOut"])
        assertFalse(p.containsKey("token"))
        assertFalse(p.containsKey("accent"))
        assertEquals(7L, p["ts"])
    }

    @Test fun `every payload stamps ts so an unchanged token still re-delivers`() {
        // DataItems dedupe on identical bytes; a bumped ts guarantees delivery.
        val a = WatchBridge.sessionPayload(false, "jwt", "#000", now = 100L)
        val b = WatchBridge.sessionPayload(false, "jwt", "#000", now = 200L)
        assertTrue(a["ts"] != b["ts"])
    }

    @Test fun `snapshot carries fleet counts, unread, accent, and ts`() {
        val p = WatchBridge.snapshotPayload(
            online = 2, total = 5, unread = 3, accent = "#00FF88",
            lastQ = null, lastA = null, lastAt = null, now = 9L,
        )
        assertEquals(2, p["online"])
        assertEquals(5, p["total"])
        assertEquals(3, p["unread"])
        assertEquals("#00FF88", p["accent"])
        assertEquals(9L, p["ts"])
    }

    @Test fun `snapshot omits the last exchange unless both sides AND a timestamp are present`() {
        // A half-formed exchange (missing answer, or undated) must not ride — it
        // would blank a fresher wrist-side one (iOS "phone wins only if newer").
        val noAnswer = WatchBridge.snapshotPayload(1, 1, 0, null, "hi", "", 5L, now = 1L)
        assertFalse(noAnswer.containsKey("lastQ"))
        assertFalse(noAnswer.containsKey("lastA"))
        val undated = WatchBridge.snapshotPayload(1, 1, 0, null, "hi", "there", null, now = 1L)
        assertFalse(undated.containsKey("lastAt"))
        assertFalse(undated.containsKey("lastQ"))
    }

    @Test fun `snapshot rides the full last exchange when present and timestamped`() {
        val p = WatchBridge.snapshotPayload(1, 1, 0, null, "weather?", "sunny", 42L, now = 7L)
        assertEquals("weather?", p["lastQ"])
        assertEquals("sunny", p["lastA"])
        assertEquals(42L, p["lastAt"])
    }

    @Test fun `snapshot omits accent when null (wrist keeps its own)`() {
        val p = WatchBridge.snapshotPayload(0, 0, 0, null, null, null, null, now = 1L)
        assertFalse(p.containsKey("accent"))
    }
}
