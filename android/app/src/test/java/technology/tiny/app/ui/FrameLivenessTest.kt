package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * 🔴 `FrameLiveness` — a frozen frame is not a live view. iOS `FrameLivenessTests`
 * (EndpointPanelTests.swift:228) ported alongside the rule.
 *
 * [EndpointPanel] keeps the last good frame when a camera tick fails, deliberately.
 * The badge over it said `live` from the first successful decode and had no way to
 * stop: `cameraFailed` is only ever assigned while `frame == null`, so a camera
 * that died at 3am left a still picture of a finished print wearing a live badge
 * for as long as the sheet stayed open.
 *
 * Three claims made that independently — the word, its accent tint, and the
 * contentDescription — so all three now read one boolean, and this suite owns the
 * boolean. `now` is always passed explicitly: a test that reads the wall clock is a
 * test that fails at midnight.
 */
class FrameLivenessTest {

    /** A fixed noon, like [ReadingAgeTest] uses: no DST edge, no midnight. */
    private val noon = 1_700_000_000_000L

    @Test
    fun `nothing has arrived, so nothing is live`() {
        // The first tick runs before any frame lands. Defaulting this to `true`
        // would put a live badge over the "connecting to camera…" placeholder.
        assertFalse(FrameLiveness.isLive(frameAt = null, now = noon))
    }

    @Test
    fun `a frame that just arrived is live`() {
        assertTrue(FrameLiveness.isLive(frameAt = noon, now = noon))
    }

    @Test
    fun `one dropped frame does not flicker the badge`() {
        // A robot's own webcam drops frames while it is busy. Flipping the word on a
        // single miss would make a working camera strobe between two labels every
        // two seconds, which reads as a broken app.
        for (missed in 1..2) {
            assertTrue(
                "$missed missed tick(s) is a hiccup, not a stall",
                FrameLiveness.isLive(frameAt = noon - missed * 2_000L, now = noon),
            )
        }
    }

    @Test
    fun `three missed ticks is a stall, and the badge says so`() {
        // The boundary itself, from both sides: 6s is the third tick's due time.
        assertFalse(FrameLiveness.isLive(frameAt = noon - 6_000L, now = noon))
        assertTrue(FrameLiveness.isLive(frameAt = noon - 5_900L, now = noon))
        assertFalse(FrameLiveness.isLive(frameAt = noon - 600_000L, now = noon))
    }

    @Test
    fun `the window is three ticks of the camera poll, not an invented number`() {
        // The camera loop delays 2s between frames; three of those is the window.
        // Parity: iOS `staleAfter: TimeInterval = 6`, web `STALE_AFTER_MS = 6_000`.
        assertEquals(6_000L, FrameLiveness.staleAfter)
    }

    @Test
    fun `a clock that steps backwards does not resurrect a stale frame`() {
        // Android has no monotonic guarantee here — `System.currentTimeMillis()`
        // jumps when NTP corrects the phone or the user edits the date, and a
        // negative age must not read as "0ms old, therefore live". iOS gets this
        // free from `timeIntervalSince` being compared the same way; spelled out
        // here because the subtraction is ours.
        assertTrue(FrameLiveness.isLive(frameAt = noon + 60_000L, now = noon))
    }

    @Test
    fun `the badge names WHICH frame this is, and never diagnoses`() {
        // `fetchEndpointFrame` answers null for every failure alike and keeps no
        // reason, so "camera offline" here would be invented. Which frame it is, is
        // the one thing this panel actually knows.
        assertEquals("live", FrameLiveness.badge(true))
        assertEquals("last frame", FrameLiveness.badge(false))
        assertNotEquals(FrameLiveness.badge(true), FrameLiveness.badge(false))
    }

    @Test
    fun `TalkBack hears the same claim the badge makes`() {
        val live = FrameLiveness.spoken("3D printer", true)
        val stale = FrameLiveness.spoken("3D printer", false)
        assertEquals("Live camera view from 3D printer", live)
        assertEquals("Last camera frame from 3D printer", stale)
        // The whole point: the stale label must not claim a live view. Someone using
        // a screen reader has no frozen picture to notice, so this label WAS the bug.
        assertFalse(stale.lowercase().contains("live camera"))
        // Both name the device, because a panel is its own block and "it" has no
        // antecedent inside one — the rule `RelayReach.cameraNote` follows too.
        assertTrue(live.contains("3D printer") && stale.contains("3D printer"))
    }
}

/**
 * 🕒 `ReadingAge` — when a reading kept on screen was taken. iOS `ReadingAgeTests`
 * ported, and with it the two defects the inline
 * `SimpleDateFormat("HH:mm:ss", Locale.US)` in [RelayCameraPanel] carried.
 *
 * Both were invisible on the phone that wrote the line: a US-locale 24-hour clock
 * reads correctly to anyone whose phone is set to 24-hour time, and a sheet is
 * rarely open across midnight.
 */
class ReadingAgeTest {

    /**
     * Noon on 14 Nov 2023 in `America/New_York` — every test below pins that zone,
     * so this really is midday and nothing here can drift across a date boundary by
     * accident. A fixed instant rather than "now minus something": these assertions
     * are about which DAY a stamp falls on, and a test that reads the wall clock is
     * a test that fails once a year at midnight.
     */
    private val noon = 1_699_981_200_000L

    /** Same day, 20:35:12 — the evening the 24-hour-clock defect was reported at. */
    private val evening = 1_700_012_112_000L

    /** 23:00 on the 13th and 01:00 on the 14th: two hours apart, two days. */
    private val elevenPmPrevDay = 1_699_934_400_000L
    private val oneAmNextDay = 1_699_941_600_000L

    private fun <T> withLocale(locale: Locale, tz: String, body: () -> T): T {
        val oldLocale = Locale.getDefault()
        val oldTz = TimeZone.getDefault()
        Locale.setDefault(locale)
        TimeZone.setDefault(TimeZone.getTimeZone(tz))
        try {
            return body()
        } finally {
            Locale.setDefault(oldLocale)
            TimeZone.setDefault(oldTz)
        }
    }

    @Test
    fun `nothing read yet means no line to draw`() {
        // The callers gate on null rather than on their own state: an age with no
        // reading under it dates nothing.
        assertNull(ReadingAge.asOf(null, now = noon))
    }

    /**
     * Whether a stamp NAMES its day, asked without matching a month's spelling —
     * "Nov" is English, and one of the tests below deliberately runs in German.
     * Every locale's date format carries the day-of-month as digits; a bare time
     * does not, so a second run of digits outside the clock is the day.
     */
    private fun namesTheDay(s: String): Boolean =
        Regex("""\d""").containsMatchIn(Regex("""\d{1,2}:\d{2}:\d{2}""").replace(s, ""))

    @Test
    fun `a reading from today is just the time`() {
        val s = withLocale(Locale.US, "America/New_York") { ReadingAge.asOf(noon, now = noon) }
        assertTrue("no 'as of': $s", s!!.startsWith("as of "))
        // No date on a same-day reading — the sheet is nearly always looking at one,
        // and "Nov 14, 12:00:00 PM" for a frame from four seconds ago is noise.
        assertFalse("today's reading names the day: $s", namesTheDay(s))
    }

    @Test
    fun `a reading from another day names the day`() {
        // The overnight case, which the replaced format could not express at all: a
        // sheet left open comes back holding last night's frame, and `03:14:07`
        // reads as this morning.
        val s = withLocale(Locale.US, "America/New_York") {
            val cal = Calendar.getInstance()
            cal.timeInMillis = elevenPmPrevDay
            val today = Calendar.getInstance()
            today.timeInMillis = noon
            assertNotEquals(
                "the fixture is not actually on another day",
                today.get(Calendar.DAY_OF_YEAR), cal.get(Calendar.DAY_OF_YEAR),
            )
            ReadingAge.asOf(elevenPmPrevDay, now = noon)!!
        }
        assertTrue("an overnight reading with no date: $s", namesTheDay(s))
    }

    @Test
    fun `the day boundary is the calendar's, not a 24-hour window`() {
        // 23:00 and 01:00 are TWO HOURS apart and two different days. A
        // `now - then > 86_400_000` check — the obvious implementation — calls that
        // "today" and dates last night's frame as this morning's.
        val s = withLocale(Locale.US, "America/New_York") {
            ReadingAge.asOf(elevenPmPrevDay, now = oneAmNextDay)!!
        }
        assertEquals(
            "the fixture is not a two-hour gap any more",
            2L, (oneAmNextDay - elevenPmPrevDay) / 3600_000L,
        )
        assertTrue("two hours across midnight read as today: $s", namesTheDay(s))
    }

    @Test
    fun `the clock belongs to the phone, not to this source file`() {
        // The defect. `Locale.US` told a 24-hour phone `20:35:12` while the same
        // frame on iOS read `8:35:12 PM`; a hand-written "h:mm:ss a" would be the
        // same defect reversed. Only the locale's own format asks instead of
        // deciding, so two locales looking at one instant must disagree here.
        val us = withLocale(Locale.US, "America/New_York") { ReadingAge.asOf(evening, now = noon) }
        val de = withLocale(Locale.GERMANY, "America/New_York") { ReadingAge.asOf(evening, now = noon) }
        assertNotEquals("both locales got the same clock — the format is hard-coded", us, de)
        assertTrue("the US clock lost its 12-hour meridiem: $us", us!!.contains("PM"))
        assertTrue("the German clock is not 24-hour: $de", de!!.contains("20:35:12"))
    }

    @Test
    fun `seconds survive, because the polls are finer than a minute`() {
        // A 2s camera poll cannot be seen going stale on an `HH:mm` clock: the frame
        // ages out three ticks before the line it is drawn under ever changes.
        val s = withLocale(Locale.US, "America/New_York") {
            ReadingAge.asOf(noon + 37_000L, now = noon)
        }!!
        assertTrue("no seconds in the stamp: $s", Regex("""\d{1,2}:\d{2}:\d{2}""").containsMatchIn(s))
    }

    @Test
    fun `the age is an instant, never an elapsed time`() {
        // "4m ago" would need a ticker these panels do not have — nothing re-renders
        // them once the polling stops, so a relative line rots in place at whatever
        // it said when the last frame landed. Which is the badge's own bug.
        val s = withLocale(Locale.US, "America/New_York") {
            ReadingAge.asOf(noon - 600_000L, now = noon)
        }!!
        assertFalse("an elapsed age needs a timer this sheet has not got: $s", s.contains("ago"))
    }
}
