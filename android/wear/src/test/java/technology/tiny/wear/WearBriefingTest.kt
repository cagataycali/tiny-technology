package technology.tiny.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WearBriefing is the pure brain of the wrist briefing (iOS Briefing.swift /
 * WatchSettings presets twin). These pin the prompt-resolution fallback, the
 * iOS-matching selected-preset (checkmark) rule, and the briefing steer — so the
 * eventual trigger + Settings section both lean on tested logic. No hardware.
 */
class WearBriefingTest {

    @Test fun `there are four presets and the first is the default`() {
        assertEquals(4, WearBriefing.presets.size)
        assertEquals(WearBriefing.presets.first().prompt, WearBriefing.DEFAULT_PROMPT)
        assertEquals("Daily brief", WearBriefing.presets.first().label)
    }

    @Test fun `resolve falls back to the default when nothing is stored`() {
        assertEquals(WearBriefing.DEFAULT_PROMPT, WearBriefing.resolve(null))
    }

    @Test fun `resolve falls back to the default on a blank stored prompt`() {
        // An empty custom prompt must not ask nothing.
        assertEquals(WearBriefing.DEFAULT_PROMPT, WearBriefing.resolve(""))
        assertEquals(WearBriefing.DEFAULT_PROMPT, WearBriefing.resolve("   \n "))
    }

    @Test fun `resolve keeps a real stored prompt, trimmed`() {
        assertEquals("what's up?", WearBriefing.resolve("  what's up?  "))
    }

    @Test fun `steer prepends the briefing prefix to the prompt`() {
        val out = WearBriefing.steer("hello")
        assertTrue(out.startsWith(WearBriefing.BRIEFING_STEER))
        assertTrue(out.endsWith("hello"))
    }

    @Test fun `the briefing steer is distinct from the dictation steer`() {
        // The server must be able to tell a briefing from a dictated question.
        assertFalse(WearBriefing.BRIEFING_STEER == WRIST_STEER)
    }

    @Test fun `isSelected ticks the default preset when nothing is stored`() {
        val daily = WearBriefing.presets.first()
        assertTrue(WearBriefing.isSelected(daily, null))
        assertTrue(WearBriefing.isSelected(daily, ""))
        // …and no OTHER preset is ticked in that state.
        assertFalse(WearBriefing.isSelected(WearBriefing.presets[1], null))
    }

    @Test fun `isSelected ticks exactly the preset matching a stored prompt`() {
        val fleet = WearBriefing.presets[1]
        assertTrue(WearBriefing.isSelected(fleet, fleet.prompt))
        assertFalse(WearBriefing.isSelected(WearBriefing.presets.first(), fleet.prompt))
    }

    @Test fun `isSelected ticks no preset when a custom prompt is stored`() {
        // A free-form custom prompt matches none of the four canned rows.
        WearBriefing.presets.forEach { assertFalse(WearBriefing.isSelected(it, "my own custom prompt")) }
    }
}
