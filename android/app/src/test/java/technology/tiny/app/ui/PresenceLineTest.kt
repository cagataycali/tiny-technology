package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the second line of a device row says.
 *
 * Android drew `"<kind> · online"` from the raw wire field, which had four
 * separate problems and one of them made a working robot look broken:
 *
 *  1. **`kind` is wire vocabulary, not English.** Every phone, Mac and laptop
 *     this app enrols posts `kind: "daemon"`, so the fleet read "daemon ·
 *     online" three times over — a word the owner never chose, can't act on,
 *     and that doesn't distinguish the rows it's printed on.
 *  2. **A robot read as dead.** The worker sends `online: null` for endpoint
 *     kinds because an endpoint never heartbeats (devices.ts:294). Kotlin's
 *     `optBoolean` collapses that to `false`, so a healthy printer rendered
 *     "endpoint · seen never" — declared dead twice in four words — under a
 *     filled grey dot. The fix needs `isNull`, because `JSONObject.NULL` is a
 *     sentinel OBJECT and `optBoolean` cannot tell it from a real `false`.
 *  3. **`url` was decoded nowhere**, so the one thing a robot can say about
 *     itself — where its body lives — was dropped on the floor.
 *  4. **Presence came second**, so the fact that actually changes sat behind a
 *     constant on every row of the list.
 *
 * iOS Panels.swift parity (`deviceLabel`, `DevicePresence`, `presenceLine`).
 */
class PresenceLineTest {

    // 2026-07-23T12:00:00Z.
    private val nowSec = 1_784_808_000L

    private fun row(
        kind: String = "daemon",
        online: Boolean? = true,
        lastSeen: Long = nowSec,
        platform: String = "",
        url: String = "",
    ) = DeviceRow("d", "n", kind, online, lastSeen, platform = platform, url = url)

    // ── presence is three states ─────────────────────────────────────────────

    @Test fun `a null online is unknown, not offline`() {
        // The bug, at its root. Absent/null means "we can't tell from here" —
        // which for a robot is the permanent, correct answer.
        assertEquals(DevicePresence.UNKNOWN, row(online = null).presence)
        assertEquals(DevicePresence.ONLINE, row(online = true).presence)
        assertEquals(DevicePresence.OFFLINE, row(online = false).presence)
    }

    @Test fun `an endpoint says it is reachable, never that it was never seen`() {
        // What the printer's row USED to say: "endpoint · seen never".
        val line = presenceLine(row(kind = "endpoint", online = null, lastSeen = 0L), nowSec)
        assertFalse("a healthy robot still reads as dead: $line", line.contains("never"))
        assertFalse("a robot claims a heartbeat it never sends: $line", line.contains("seen "))
        assertTrue("a robot does not say it can be reached: $line", line.startsWith("reachable when called"))
    }

    @Test fun `unknown presence never claims a recency, however stale the stamp`() {
        // last_seen is meaningless for a device that doesn't heartbeat — a stamp
        // from a year ago must not turn into "seen 365d ago" beside a robot
        // that answers instantly when dialled.
        val line = presenceLine(
            row(kind = "endpoint", online = null, lastSeen = nowSec - 400 * 86_400),
            nowSec,
        )
        assertEquals("reachable when called · robot", line)
        assertFalse("a stamp leaked into an unknown row: $line", line.contains("ago"))
    }

    // ── the second line names hardware, not the wire's kind ──────────────────

    @Test fun `a platform becomes the hardware's own name`() {
        assertEquals("Mac", deviceLabel("darwin-arm64", "daemon"))
        assertEquals("iOS", deviceLabel("ios-arm64", "daemon"))
        assertEquals("Android", deviceLabel("android-arm64", "daemon"))
        assertEquals("Linux", deviceLabel("linux-x64", "cli"))
        assertEquals("Windows", deviceLabel("win32-x64", "cli"))
        assertEquals("Nicla Vision", deviceLabel("nicla-vision", "daemon"))
        assertEquals("Nicla Voice", deviceLabel("nicla-voice", "daemon"))
    }

    @Test fun `an iPad is not an iPhone — the needle order is load-bearing`() {
        // "ipados" CONTAINS "ios", so a Map or a reordered list would label an
        // iPad "iOS". This is the single reason DEVICE_PLATFORM_NAME is an
        // ordered List<Pair> and not a Map: iteration order is the algorithm.
        assertEquals("iPad", deviceLabel("ipados-arm64", "daemon"))
        val names = DEVICE_PLATFORM_NAME.map { it.first }
        assertTrue(
            "the ipad needle no longer precedes ios — an iPad now reads as iOS",
            names.indexOf("ipad") < names.indexOf("ios"),
        )
    }

    @Test fun `every needle in the table is reachable`() {
        // A needle sitting behind a substring of itself is dead code that reads
        // like coverage. Checked by construction rather than by eye.
        for ((i, pair) in DEVICE_PLATFORM_NAME.withIndex()) {
            val shadowedBy = DEVICE_PLATFORM_NAME.take(i).firstOrNull { pair.first.contains(it.first) }
            assertEquals(
                "'${pair.first}' is unreachable: '${shadowedBy?.first}' matches it first",
                null,
                shadowedBy,
            )
        }
    }

    @Test fun `an unknown platform is shown as itself, tidied`() {
        // Better a token the owner can recognise than a word we invented. The
        // underscore/dash swap is for the ESP/Pi-class names the CLI posts.
        assertEquals("freebsd x64", deviceLabel("freebsd_x64", "cli"))
        assertEquals("riscv board", deviceLabel("riscv-board", "daemon"))
    }

    @Test fun `no platform falls back to the kind, translated`() {
        // A browser enrols through the web form and posts no platform at all.
        assertEquals("browser", deviceLabel("", "browser"))
        assertEquals("computer", deviceLabel("", "cli"))
        assertEquals("robot", deviceLabel("", "endpoint"))
        assertEquals("device", deviceLabel("", "daemon"))
    }

    @Test fun `a literal question-mark platform is not printed as hardware`() {
        // The CLI posts "?" when it can't identify itself. Rendering that would
        // put a bare "?" where a device name belongs.
        assertEquals("device", deviceLabel("?", "daemon"))
        assertEquals("robot", deviceLabel(" ? ", "endpoint"))
    }

    @Test fun `an unknown kind with no platform says nothing rather than guessing`() {
        // Empty is a real answer: presenceLine drops the separator entirely, so
        // the row reads "online" instead of "online · ".
        assertEquals("", deviceLabel("", "wormhole"))
        assertEquals("online", presenceLine(row(kind = "wormhole"), nowSec))
    }

    // ── a robot's descriptor is where its body lives ─────────────────────────

    @Test fun `an endpoint names its host instead of the word robot`() {
        val d = row(kind = "endpoint", online = null, url = "https://p1s.ada.tiny.technology")
        assertEquals("p1s.ada.tiny.technology", deviceDescriptor(d))
        assertEquals("reachable when called · p1s.ada.tiny.technology", presenceLine(d, nowSec))
    }

    @Test fun `the scheme is stripped, because it is the same on every robot`() {
        // Eight identical characters on every row, in a line that has to fit a
        // phone's width. Web strips it in exactly the same place.
        assertFalse(deviceDescriptor(row(kind = "endpoint", url = "https://x.io")).contains("https"))
        // A non-https origin keeps its scheme — there it is INFORMATION (and a
        // warning), not boilerplate.
        assertEquals("http://192.168.1.9", deviceDescriptor(row(kind = "endpoint", url = "http://192.168.1.9")))
    }

    @Test fun `an endpoint with no url falls back to the word, not to blank`() {
        // Enrolling a robot without a url is possible; the row still has to say
        // what it is.
        assertEquals("robot", deviceDescriptor(row(kind = "endpoint", online = null, url = "")))
        assertEquals("robot", deviceDescriptor(row(kind = "endpoint", online = null, url = "   ")))
    }

    @Test fun `only an endpoint shows a url`() {
        // A phone's row must never render a host: if a daemon somehow carries a
        // url, the hardware name is still the truer thing to print.
        assertEquals(
            "Android",
            deviceDescriptor(row(kind = "daemon", platform = "android-arm64", url = "https://evil.example")),
        )
    }

    // ── the assembled line ───────────────────────────────────────────────────

    @Test fun `presence leads and hardware follows`() {
        assertEquals("online · Mac", presenceLine(row(platform = "darwin-arm64"), nowSec))
        assertEquals(
            "seen 5m ago · Android",
            presenceLine(row(online = false, lastSeen = nowSec - 300, platform = "android-arm64"), nowSec),
        )
    }

    @Test fun `an online row never shows a stale recency`() {
        // A live device's last_seen can be minutes old between heartbeats; the
        // question the row answers is "is it there", not "when did it speak".
        assertEquals(
            "online · Linux",
            presenceLine(row(lastSeen = nowSec - 999_999, platform = "linux-x64"), nowSec),
        )
    }

    @Test fun `never seen reads as English, not as a recency of never`() {
        // The old line said "seen never". "never seen" is the same fact in the
        // order a person says it.
        assertEquals(
            "never seen · Nicla Vision",
            presenceLine(row(online = false, lastSeen = 0L, platform = "nicla-vision"), nowSec),
        )
    }

    @Test fun `the wire's kind never appears verbatim on a row this app enrols`() {
        // The regression that started this: three rows all reading "daemon".
        for (platform in listOf("android-arm64", "darwin-arm64", "ios-arm64", "linux-x64")) {
            val line = presenceLine(row(kind = "daemon", platform = platform), nowSec)
            assertFalse("the wire's kind leaked into the row: $line", line.contains("daemon"))
        }
    }
}
