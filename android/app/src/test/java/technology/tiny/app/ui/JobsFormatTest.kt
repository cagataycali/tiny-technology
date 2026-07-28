package technology.tiny.app.ui

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.TimeZone

/**
 * Pure job-row formatting behind JobsSheet (web JobsPanel.tsx cadence()/when() +
 * runStamp parity). These strings ARE the scheduled-jobs surface — a bad cadence
 * label misreports when a background loop fires, so the DSL parse + one-shot phrasing
 * + the local-time conversion must be exact. Timezone-dependent cases pin the default
 * TZ so they're deterministic across CI/dev machines.
 */
class JobsFormatTest {

    private var savedTz: TimeZone? = null

    @Before fun pinTz() {
        savedTz = TimeZone.getDefault()
        // UTC+0 makes the daily@/when local-time conversions equal their UTC input,
        // so the expected strings are hand-verifiable.
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restoreTz() {
        TimeZone.setDefault(savedTz)
    }

    // ── cadence: recurring DSL ────────────────────────────────────────────────
    @Test fun `every-N-minutes DSL reads as "every N min"`() {
        assertEquals("every 5 min", cadence("*/5m", null, 0, true, 0))
        assertEquals("every 30 min", cadence("*/30m", null, 3, true, 0))
    }

    @Test fun `every-N-hours DSL reads as "every N hr"`() {
        assertEquals("every 2 hr", cadence("*/2h", null, 0, true, 0))
    }

    @Test fun `daily DSL converts the stored-UTC time to local wall clock`() {
        // Default TZ pinned to UTC → 09:00 UTC renders as 09:00 AM.
        assertEquals("daily at 09:00 AM", cadence("daily@09:00", null, 0, true, 0))
        assertEquals("daily at 11:30 PM", cadence("daily@23:30", null, 0, true, 0))
    }

    @Test fun `daily conversion shifts with the device timezone`() {
        // 09:00 UTC in a UTC-5 zone is 04:00 local.
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York")) // EST = UTC-5 in Jan
        val jan = 1_704_106_800_000L // 2024-01-01T11:00:00Z, unambiguously EST
        assertEquals("daily at 04:00 AM", cadence("daily@09:00", null, 0, true, jan))
    }

    @Test fun `an unrecognized schedule string passes through verbatim`() {
        assertEquals("0 9 * * 1", cadence("0 9 * * 1", null, 0, true, 0))
    }

    // ── cadence: one-shot run_at ──────────────────────────────────────────────
    @Test fun `a not-yet-fired one-shot reads "once at"`() {
        // 2024-01-01T09:00:00Z (unix 1704099600) → local == UTC here.
        assertEquals("once at Jan 1, 09:00 AM", cadence(null, 1_704_099_600L, 0, true, 0))
    }

    @Test fun `a one-shot that has fired reads "ran"`() {
        assertEquals("ran Jan 1, 09:00 AM", cadence(null, 1_704_099_600L, 1, true, 0))
    }

    @Test fun `a disabled one-shot reads "ran" even at zero fires`() {
        // done = fired>0 OR !enabled — a disabled one-shot is spent.
        assertEquals("ran Jan 1, 09:00 AM", cadence(null, 1_704_099_600L, 0, false, 0))
    }

    @Test fun `neither schedule nor runAt yields the question mark`() {
        assertEquals("?", cadence(null, null, 0, true, 0))
        assertEquals("?", cadence(null, 0L, 0, true, 0)) // 0 is not a valid runAt
    }

    // ── whenStamp ─────────────────────────────────────────────────────────────
    @Test fun `whenStamp formats a valid unix-seconds stamp`() {
        assertEquals("Jan 1, 09:00 AM", whenStamp(1_704_099_600L))
    }

    @Test fun `whenStamp returns empty for non-positive or null (never "Invalid Date")`() {
        assertEquals("", whenStamp(null))
        assertEquals("", whenStamp(0L))
        assertEquals("", whenStamp(-5L))
    }

    // ── runStamp (previously untested) ────────────────────────────────────────
    @Test fun `runStamp renders unix-seconds as a relative age`() {
        val now = 1_704_099_600_000L // ms
        assertEquals("30s ago", runStamp("1704099570", now)) // 30s earlier
        assertEquals("5m ago", runStamp("1704099300", now)) // 300s earlier
    }

    @Test fun `runStamp falls back to the first 16 chars for non-numeric stamps`() {
        // sqlite CURRENT_TIMESTAMP text "2024-01-01 09:00:00" → first 16 chars.
        assertEquals("2024-01-01 09:00", runStamp("2024-01-01 09:00:00", 0))
    }
}
