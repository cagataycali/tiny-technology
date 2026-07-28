package technology.tiny.app.geo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 📍 Geo's pure half — must match web lib/geo.ts (tests/geo.test.ts)
 * byte-for-byte: every client teaches the tiny the same `### Location`
 * shape, so a drift here is a cross-platform context fork.
 */
class GeoTest {
    private fun fix(
        speedMs: Double? = 6.5,
        headingDeg: Double? = 48.0,
        accuracyM: Int? = 12,
        altitudeM: Int? = 52,
    ) = Geo.Fix(
        lat = 37.7749, lng = -122.4194,
        accuracyM = accuracyM, altitudeM = altitudeM,
        speedMs = speedMs, headingDeg = headingDeg,
        timestampMs = 1_753_400_000_000,
    )

    @Test fun `kmh converts with one decimal and rejects junk`() {
        assertEquals(23.4, Geo.kmh(6.5)!!, 1e-9)
        assertEquals(0.0, Geo.kmh(0.0)!!, 1e-9)
        assertNull(Geo.kmh(null))
        assertNull(Geo.kmh(-1.0))
        assertNull(Geo.kmh(Double.NaN))
    }

    @Test fun `cardinal maps and wraps like the web`() {
        assertEquals("N", Geo.cardinal(0.0))
        assertEquals("NE", Geo.cardinal(48.0))
        assertEquals("E", Geo.cardinal(90.0))
        assertEquals("S", Geo.cardinal(180.0))
        assertEquals("W", Geo.cardinal(270.0))
        assertEquals("NW", Geo.cardinal(315.0))
        assertEquals("N", Geo.cardinal(359.0))
        assertEquals("E", Geo.cardinal(810.0))
        assertEquals("W", Geo.cardinal(-90.0))
        assertNull(Geo.cardinal(null))
        assertNull(Geo.cardinal(Double.NaN))
    }

    @Test fun `contextBlock renders the exact web grammar for a moving fix`() {
        assertEquals(
            listOf(
                "### Location",
                "- **Coordinates**: 37.7749, -122.4194",
                "- **Accuracy**: ±12m",
                "- **Altitude**: 52m",
                "- **Speed**: 23.4 km/h",
                "- **Heading**: NE (48°)",
            ).joinToString("\n"),
            Geo.contextBlock(fix()),
        )
    }

    @Test fun `stationary fix omits speed and heading lines`() {
        val block = Geo.contextBlock(fix(speedMs = null, headingDeg = null, altitudeM = null))
        assertEquals(
            listOf(
                "### Location",
                "- **Coordinates**: 37.7749, -122.4194",
                "- **Accuracy**: ±12m",
            ).joinToString("\n"),
            block,
        )
    }

    @Test fun `zero speed is parked, not a 0 kmh line`() {
        val block = Geo.contextBlock(fix(speedMs = 0.0, headingDeg = null))
        assertEquals(false, block.contains("Speed"))
    }

    @Test fun `null or degenerate fix renders empty so callers append blindly`() {
        assertEquals("", Geo.contextBlock(null))
        assertEquals("", Geo.contextBlock(fix().copy(lat = Double.NaN)))
    }
}
