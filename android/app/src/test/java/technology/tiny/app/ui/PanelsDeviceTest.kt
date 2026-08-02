package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The fleet device row's "seen <relative>" recency (web devices/page.tsx:42-50 +
 * iOS Panels.swift:1496-1500 parity). last_seen was parsed into DeviceRow but never
 * rendered, so an offline device showed only its kind with no sense of how stale it
 * was. relativeSeen mirrors web's buckets exactly; [presenceLine] merges the online
 * swap. nowSec is injected so ages are deterministic without a wall clock.
 *
 * [presenceLine] replaced `deviceSubtitle`, which put the wire's raw `kind` first —
 * "daemon · online". See PresenceLineTest for the reasons and the new table.
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

    private fun row(
        kind: String,
        online: Boolean?,
        lastSeen: Long,
        platform: String = "",
        url: String = "",
    ) = DeviceRow("d", "n", kind, online, lastSeen, platform = platform, url = url)

    @Test fun `online device shows online not a stale seen line`() {
        // A live device says "online" regardless of its last_seen value.
        assertEquals(
            "online · Mac",
            presenceLine(row("cli", true, nowSec - 999999, platform = "darwin-arm64"), nowSec),
        )
    }

    @Test fun `offline device appends its recency`() {
        assertEquals(
            "seen 5m ago · Android",
            presenceLine(row("daemon", false, nowSec - 300, platform = "android-arm64"), nowSec),
        )
        assertEquals(
            "never seen · Linux",
            presenceLine(row("daemon", false, 0L, platform = "linux-arm64"), nowSec),
        )
    }

    @Test fun `presence leads the line, because it is what changes`() {
        // deviceSubtitle put the wire's `kind` first, so every row began with a word
        // the owner didn't choose and can't act on ("daemon"), and the one fact that
        // moves — is it there — was pushed to second place on every row of the list.
        for (line in listOf(
            presenceLine(row("daemon", true, nowSec, platform = "android-arm64"), nowSec),
            presenceLine(row("daemon", false, nowSec - 300, platform = "android-arm64"), nowSec),
            presenceLine(row("endpoint", null, 0L, url = "https://p1s.tiny.technology"), nowSec),
        )) {
            assertTrue(
                "the line does not lead with presence: $line",
                line.startsWith("online") || line.startsWith("seen ") ||
                    line.startsWith("never seen") || line.startsWith("reachable"),
            )
        }
    }
}
