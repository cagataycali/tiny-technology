package technology.tiny.app.fleet

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which necklace the live view aims at.
 *
 * Taking the first `nicla-vision` row leaned on `/api/devices` ordering, which
 * nothing in the contract promises — and a re-enrolled board (wiped flash, and
 * the API mints a device token exactly once) leaves an orphan row behind
 * forever: permanently offline, never reprovisionable, only revocable. Aiming
 * at it costs the whole session, because `remoteLoop` burns all four misses on
 * a device that will never answer AND `discoverBase` never returns a LAN base,
 * so the 20fps fast path is never tried while a healthy necklace serves MJPEG
 * one hop away. iOS TinyLive.findDeviceId parity.
 */
class PickNiclaTest {

    private fun rows(vararg json: String) = JSONArray("[${json.joinToString(",")}]")

    private fun nicla(id: String, online: Boolean, seen: Any) =
        """{"id":"$id","platform":"nicla-vision","online":$online,"last_seen":$seen}"""

    @Test
    fun `the online board wins over an orphan listed first`() {
        // The exact shape of the bug: the orphan is row 0.
        val picked = TinyLive.pickNicla(rows(nicla("orphan", false, 100), nicla("live", true, 50)))
        assertEquals("live", picked)
    }

    @Test
    fun `among offline boards the freshest heartbeat wins`() {
        // Nothing is online — the least-stale row is still the better guess
        // than whichever the registry happened to list first.
        val picked = TinyLive.pickNicla(rows(nicla("stale", false, 10), nicla("recent", false, 999)))
        assertEquals("recent", picked)
    }

    @Test
    fun `among online boards the freshest heartbeat wins`() {
        val picked = TinyLive.pickNicla(rows(nicla("a", true, 5), nicla("b", true, 7)))
        assertEquals("b", picked)
    }

    @Test
    fun `online beats fresh — a heartbeat is not a promise to answer`() {
        // An offline row can carry a NEWER last_seen than an online one (it was
        // seen seconds before dropping off). Online still wins: the ordering is
        // about who will answer the next invoke, not who spoke most recently.
        val picked = TinyLive.pickNicla(rows(nicla("justDied", false, 9_999), nicla("live", true, 1)))
        assertEquals("live", picked)
    }

    @Test
    fun `other platforms are never picked`() {
        val picked = TinyLive.pickNicla(
            rows(
                """{"id":"mac","platform":"darwin-arm64","online":true,"last_seen":9999}""",
                """{"id":"voice","platform":"nicla-voice","online":true,"last_seen":9999}""",
                nicla("vision", false, 1),
            ),
        )
        // A nicla-VOICE has no camera and no LAN stream — picking it because it
        // was online would aim the live view at a board that cannot serve it.
        assertEquals("vision", picked)
    }

    @Test
    fun `no necklace enrolled is null, not a crash`() {
        assertNull(TinyLive.pickNicla(JSONArray()))
        assertNull(TinyLive.pickNicla(rows("""{"id":"mac","platform":"darwin-arm64"}""")))
    }

    @Test
    fun `rows missing fields do not sink the pick`() {
        // A registry row without last_seen/online (older daemon, partial write)
        // must not throw and must not beat a healthy board.
        val picked = TinyLive.pickNicla(
            rows("""{"id":"partial","platform":"nicla-vision"}""", nicla("live", true, 1)),
        )
        assertEquals("live", picked)
    }

    @Test
    fun `a row with no id is skipped rather than returned empty`() {
        // Returning "" would be worse than returning null: the caller treats a
        // non-null id as "found it" and would relay to nowhere for the session.
        val picked = TinyLive.pickNicla(
            rows("""{"platform":"nicla-vision","online":true,"last_seen":9}""", nicla("real", false, 1)),
        )
        assertEquals("real", picked)
    }

    @Test
    fun `an epoch-MILLISECOND heartbeat still orders correctly`() {
        // last_seen is not guaranteed to be seconds: a daemon writing Date.now()
        // sends epoch ms, and those do not fit in an Int. Measured with org.json
        // 20240303 (this suite's jar): optInt(1754100000000) = 1753343232 and
        // optInt(1754494200000) = -2147424064 — it wraps NEGATIVE, so an
        // Int-based read reports the older board as the fresher one and the live
        // view aims at the wrong necklace. Real values ~4.5 days apart.
        //
        // The wrap carries to the DEVICE too, where org.json is Android's own
        // implementation rather than this jar: both funnel through
        // Number.intValue(), whose narrowing is defined by the JLS, so the
        // truncated values are the same on both. That is what makes a JVM test
        // adequate evidence for a device-side decision here.
        val picked = TinyLive.pickNicla(
            rows(nicla("older", false, 1_754_100_000_000), nicla("newer", false, 1_754_494_200_000)),
        )
        assertEquals("newer", picked)
    }

    @Test
    fun `a fractional last_seen is not truncated away`() {
        // Some rows carry a fractional second. iOS needed the same two-shape
        // read (`as? Double ?? Double(as? Int)`).
        val picked = TinyLive.pickNicla(
            rows(nicla("lower", false, "1754100001.2"), nicla("higher", false, "1754100001.8")),
        )
        assertEquals("higher", picked)
    }

    @Test
    fun `a single enrolled necklace is picked even when offline`() {
        // Offline is not a reason to refuse: the remote path may still wake it,
        // and "no necklace enrolled" is a different, wronger message.
        assertEquals("only", TinyLive.pickNicla(rows(nicla("only", false, 0))))
    }
}
