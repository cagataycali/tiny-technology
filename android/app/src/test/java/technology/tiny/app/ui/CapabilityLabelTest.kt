package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The devices strip used to print the daemon's token verbatim — `bluetooth_scan`,
 * `image_gen`, `tof`, `windows` — and TalkBack read the underscore out loud.
 * These pin the words, the fallback and the order (iOS e39e5f69 parity).
 */
class CapabilityLabelTest {

    @Test
    fun `no label reaches the screen carrying wire punctuation`() {
        CAPABILITY_LABELS.forEach { (token, label) ->
            assertFalse("$token → '$label' still has an underscore", label.contains('_'))
            assertTrue("$token has an empty label", label.isNotBlank())
        }
    }

    @Test
    fun `the tokens that read as jargon or as another product get real words`() {
        // Each of these was on a real row: three acronyms, one underscore, and
        // "windows", which alone reads as Microsoft's product.
        assertEquals("distance", capabilityLabel("tof"))
        assertEquals("motion", capabilityLabel("imu"))
        assertEquals("bluetooth", capabilityLabel("ble"))
        assertEquals("bluetooth", capabilityLabel("bluetooth_scan"))
        assertEquals("makes images", capabilityLabel("image_gen"))
        assertEquals("opens apps", capabilityLabel("open_app"))
        assertEquals("arranges windows", capabilityLabel("windows"))
    }

    @Test
    fun `an unmapped capability still shows, but as words`() {
        // A newer daemon must not be silenced — the same rule capabilityIcon
        // follows by returning null instead of a stand-in glyph.
        assertEquals("some new thing", capabilityLabel("some_new_thing"))
        assertEquals("read only mode", capabilityLabel("read-only-mode"))
        assertEquals("newthing", capabilityLabel("newthing"))
    }

    @Test
    fun `every capability with an icon has a word to go with it`() {
        // A chip with a glyph and a raw token is the exact thing being fixed.
        CAPABILITY_LABELS.keys.forEach { token ->
            assertTrue("$token has no label", capabilityLabel(token).isNotBlank())
        }
    }

    @Test
    fun `the strip is ordered by the word the user sees, not the token`() {
        // The necklace's own set. By token this is ble/camera/imu/mic/tof/wifi,
        // which renders as "bluetooth camera motion mic distance Wi-Fi" —
        // alphabetical by an invisible key, indistinguishable from unsorted.
        val necklace = listOf("camera", "mic", "tof", "imu", "ble", "wifi")
        val labels = sortCapabilities(necklace).map { capabilityLabel(it) }
        assertEquals(listOf("bluetooth", "camera", "distance", "mic", "motion", "Wi-Fi"), labels)
    }

    @Test
    fun `sorting is case-insensitive so proper nouns don't float to the top`() {
        val caps = listOf("spotify", "camera", "wifi", "adb")
        val labels = sortCapabilities(caps).map { capabilityLabel(it) }
        // "Android", "camera", "Spotify", "Wi-Fi" — not the capitalised ones first.
        assertEquals(listOf("Android", "camera", "Spotify", "Wi-Fi"), labels)
    }

    @Test
    fun `the order is total and stable regardless of the server's order`() {
        // The chips must not reshuffle on refresh, and two tokens that happen to
        // share a label still need a deterministic order.
        val a = listOf("ble", "bluetooth_scan", "camera")
        assertEquals(sortCapabilities(a), sortCapabilities(a.reversed()))
        assertEquals(sortCapabilities(a), sortCapabilities(a.shuffled(java.util.Random(7))))
        // ble and bluetooth_scan both read "bluetooth" — the token breaks the tie.
        assertEquals(listOf("ble", "bluetooth_scan", "camera"), sortCapabilities(a))
    }

    @Test
    fun `an empty or single strip is handled`() {
        assertEquals(emptyList<String>(), sortCapabilities(emptyList()))
        assertEquals(listOf("camera"), sortCapabilities(listOf("camera")))
    }
}
