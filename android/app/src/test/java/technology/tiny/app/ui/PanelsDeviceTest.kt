package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The fleet device row's "seen <relative>" recency (web devices/page.tsx:42-50 +
 * iOS Panels.swift:1496-1500 parity). last_seen was parsed into DeviceRow but never
 * rendered, so an offline device showed only its kind with no sense of how stale it
 * was. relativeSeen mirrors web's buckets exactly; deviceSubtitle merges the online
 * swap. nowSec is injected so ages are deterministic without a wall clock.
 */
class PanelsDeviceTest {

    // 2026-07-23T12:00:00Z.
    private val nowSec = 1_784_808_000L

    @Test fun `relativeSeen matches the web buckets`() {
        assertEquals("just now", relativeSeen(nowSec - 30, nowSec))       // < 60s
        assertEquals("5m ago", relativeSeen(nowSec - 300, nowSec))        // minutes
        assertEquals("2h ago", relativeSeen(nowSec - 7200, nowSec))       // hours
        assertEquals("3d ago", relativeSeen(nowSec - 3 * 86400, nowSec))  // days
    }

    @Test fun `relativeSeen floors a bucket edge down like web`() {
        // 59m59s is still minutes, not "0h"; 23h59m is still hours, not "0d".
        assertEquals("59m ago", relativeSeen(nowSec - 3599, nowSec))
        assertEquals("23h ago", relativeSeen(nowSec - 86399, nowSec))
    }

    @Test fun `never checked in reads never`() {
        // last_seen absent (optLong default 0) or negative → "never", not a huge age.
        assertEquals("never", relativeSeen(0L, nowSec))
        assertEquals("never", relativeSeen(-5L, nowSec))
    }

    @Test fun `a future stamp clamps to just now`() {
        // Clock skew: a device stamped slightly in the future must not read "-1s".
        assertEquals("just now", relativeSeen(nowSec + 120, nowSec))
    }

    @Test fun `online device shows online not a stale seen line`() {
        // A live device says "online" regardless of its last_seen value.
        assertEquals("laptop · online", deviceSubtitle("laptop", true, nowSec - 999999, nowSec))
    }

    @Test fun `offline device appends its recency`() {
        assertEquals("phone · seen 5m ago", deviceSubtitle("phone", false, nowSec - 300, nowSec))
        assertEquals("watch · seen never", deviceSubtitle("watch", false, 0L, nowSec))
    }

    @Test fun `blank kind falls back to device`() {
        assertEquals("device · online", deviceSubtitle("", true, nowSec, nowSec))
        assertEquals("device · seen 2h ago", deviceSubtitle("", false, nowSec - 7200, nowSec))
    }
}
