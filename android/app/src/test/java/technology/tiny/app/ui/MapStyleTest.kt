package technology.tiny.app.ui

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * gradedMapStyle bakes the web/iOS ambient multiply into the style JSON
 * (SurfaceView can't compositor-blend). Same math as web gradeTintCss:
 * tint = gray(0.78) leaned 30% into the accent; geometry gray(N%) × tint.
 */
class MapStyleTest {

    private val graded = gradedMapStyle(0, 255, 136) // default tiny accent

    @Test
    fun stillValidStyleJsonWithSameEntryCount() {
        val before = JSONArray(TINY_MAP_DARK_STYLE)
        val after = JSONArray(graded)
        assertEquals(before.length(), after.length())
    }

    @Test
    fun bakesTheExactWebTintMath() {
        // lightness 20 → gray 51; tint (139.23, 215.73, 180.03)/255 →
        // truncated channels (27, 43, 36) = #1b2b24
        assertTrue(graded.contains("""{"color":"#1b2b24"}"""))
    }

    @Test
    fun noBlackPlusLightnessPairSurvives() {
        assertFalse(Regex("""\{"color":"#000000"\},\{"lightness":\d+\}""").containsMatchIn(graded))
    }

    @Test
    fun strokeWeightAndVisibilityStylersSurvive() {
        assertTrue(graded.contains(""""weight":1.2"""))
        assertTrue(graded.contains(""""visibility":"off""""))
    }

    @Test
    fun accentChannelsClampAndZeroLeanIsNeutralGray() {
        val wild = gradedMapStyle(999, -5, 136)
        assertTrue(JSONArray(wild).length() > 0) // clamps, still valid
        // lean 0 → pure gray tint: gray(20%)×0.78 = 39 = #272727
        val neutral = gradedMapStyle(0, 255, 136, lean = 0.0)
        assertTrue(neutral.contains("""{"color":"#272727"}"""))
    }
}
