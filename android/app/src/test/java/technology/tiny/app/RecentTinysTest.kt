package technology.tiny.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * RecentTinys.promote is the pure MRU fold extracted from record() — it decides
 * the dynamic launcher-shortcut list without touching SharedPreferences, so it
 * runs on the local JVM. Guards the slug normalization, the "tiny"/blank skip,
 * promote-to-front dedup, the MAX cap, and the null-means-no-change contract.
 */
class RecentTinysTest {

    @Test fun `a new tiny goes to the front`() {
        assertEquals(listOf("ada"), RecentTinys.promote("ada", emptyList()))
        assertEquals(listOf("bob", "ada"), RecentTinys.promote("bob", listOf("ada")))
    }

    @Test fun `name is slug-normalized (trim + lowercase)`() {
        assertEquals(listOf("ada"), RecentTinys.promote("  Ada  ", emptyList()))
        assertEquals(listOf("cake"), RecentTinys.promote("CAKE", emptyList()))
    }

    @Test fun `the default landing tiny earns no slot`() {
        assertNull(RecentTinys.promote("tiny", emptyList()))
        assertNull(RecentTinys.promote("  TINY  ", listOf("ada")))
    }

    @Test fun `blank names are ignored`() {
        assertNull(RecentTinys.promote("", emptyList()))
        assertNull(RecentTinys.promote("   ", listOf("ada")))
    }

    @Test fun `an existing tiny is promoted, not duplicated`() {
        assertEquals(listOf("ada", "bob", "cy"), RecentTinys.promote("ada", listOf("bob", "ada", "cy")))
    }

    @Test fun `re-recording the current front is a no-op (null)`() {
        // Already at front → next == current → null so the caller skips the write.
        assertNull(RecentTinys.promote("ada", listOf("ada", "bob")))
    }

    @Test fun `the list is capped at MAX, oldest dropped`() {
        // MAX = 4. A 5th distinct tiny pushes the oldest ("d") off the end.
        assertEquals(
            listOf("e", "a", "b", "c"),
            RecentTinys.promote("e", listOf("a", "b", "c", "d")),
        )
    }

    @Test fun `promoting from the tail within a full list keeps size at MAX`() {
        // "d" (tail of a full list) jumps to front; nothing is dropped since it
        // was already present — still 4 entries.
        assertEquals(
            listOf("d", "a", "b", "c"),
            RecentTinys.promote("d", listOf("a", "b", "c", "d")),
        )
    }
}
