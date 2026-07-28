package technology.tiny.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure quiet-hours classification (iOS Config.isQuietNow parity — 22:00–08:00 local,
 * `hour >= 22 || hour < 8`). A remote agent's audible play_sound is gated on this, so
 * the wrap-around boundaries must be exact: 22:00 is quiet, 08:00 is NOT. Pure Kotlin,
 * runs on the local JVM (the Calendar read + toggle pref are exercised on-device).
 */
class ConfigTest {

    @Test fun `late evening into the small hours is quiet`() {
        listOf(22, 23, 0, 3, 7).forEach {
            assertTrue("hour $it should be quiet", Config.isQuietHour(it))
        }
    }

    @Test fun `daytime is not quiet`() {
        listOf(8, 9, 12, 17, 21).forEach {
            assertFalse("hour $it should NOT be quiet", Config.isQuietHour(it))
        }
    }

    @Test fun `22 is the inclusive start of the quiet window`() {
        assertFalse("21:xx is still audible", Config.isQuietHour(21))
        assertTrue("22:00 enters quiet", Config.isQuietHour(22))
    }

    @Test fun `8 is the exclusive end of the quiet window`() {
        assertTrue("07:xx is still quiet", Config.isQuietHour(7))
        assertFalse("08:00 is audible again", Config.isQuietHour(8))
    }
}
