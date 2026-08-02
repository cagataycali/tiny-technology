package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FleetHarness — the c41 fix for `play-05-devices.png`, which was sitting in the Play
 * upload tree rendering the user's real device fleet by HOSTNAME (six names embedding
 * the account login, each with a `revoke` button). The same raw fed two Instagram
 * carousel slides nobody had listed.
 *
 * It's a SAFETY gate, so the release-build case is pinned here rather than left to
 * inspection — the same contract as GraphHarnessTest. The dataset tests are not
 * decoration: this harness feeds a screen whose text is computed from its fields
 * (`deviceSubtitle`, `relativeSeen`, `isSelf`), so a dataset that renders wrongly is
 * indistinguishable from a working one until someone reads the pixels.
 */
class FleetHarnessTest {

    private val NOW = 1_780_000_000L

    // ── the gate ─────────────────────────────────────────────────────────────

    @Test fun `a release build substitutes nothing however the extra is set`() {
        // The whole safety property: an APK on a stranger's phone cannot be shown a
        // fake fleet, and a real user's load failure can never be masked by a harness.
        assertFalse(FleetHarness.enabled(debug = false, raw = true))
        assertFalse(FleetHarness.enabled(debug = false, raw = false))
    }

    @Test fun `a debug build substitutes only when the flag is actually set`() {
        assertTrue(FleetHarness.enabled(debug = true, raw = true))
        // Default-off matters: getBooleanExtra returns false when absent, so an ordinary
        // debug launch must go to /api/devices like any other.
        assertFalse(FleetHarness.enabled(debug = true, raw = false))
    }

    // ── the leak itself ──────────────────────────────────────────────────────

    @Test fun `no row name embeds an account login or a real hostname`() {
        // The regression guard for the defect. The leaking capture's rows were exactly
        // this shape: FleetManager.enrollIfNeeded builds "${auth.login}-pixel", so every
        // real name carries the login. A harness renders whatever it's handed.
        val leaked = listOf(
            "cagatay", "cagataycali", "thor", "@", ".local", ".lan", "iphone",
        )
        for (r in FleetHarness.rows(selfId = "d1", nowSec = NOW)) {
            for (bad in leaked) {
                assertFalse(
                    "row name leaks '$bad': ${r.name}",
                    r.name.contains(bad, ignoreCase = true),
                )
            }
            assertTrue("row name is empty", r.name.isNotBlank())
        }
    }

    // ── the two things a fixed dataset gets wrong ────────────────────────────

    @Test fun `lastSeen is relative to NOW, so the shot cannot rot`() {
        // GraphHarness pins a fixed epoch and is right to: validFrom only feeds a
        // self-relative recency ramp. lastSeen is different — it goes through
        // relativeSeen() against nowSec, so a fixed epoch renders "371d ago" on every
        // row and gets worse daily. Capture-day plausibility is the trap: it would look
        // correct exactly once.
        val early = FleetHarness.rows("d1", nowSec = NOW)
        val muchLater = FleetHarness.rows("d1", nowSec = NOW + 400 * 86_400L)
        for ((a, b) in early.zip(muchLater)) {
            val sa = relativeSeen(a.lastSeen, NOW)
            val sb = relativeSeen(b.lastSeen, NOW + 400 * 86_400L)
            assertEquals("row ${a.name} reads differently a year on", sa, sb)
        }
        // And concretely: nothing reads as a year stale on capture day.
        assertTrue(
            "a row rendered as months old",
            early.none { relativeSeen(it.lastSeen, NOW).endsWith("d ago") && it.lastSeen > 0 && NOW - it.lastSeen > 30 * 86_400L },
        )
    }

    @Test fun `the phone row carries the app's OWN device id, so it reads as self`() {
        // DevicesSheet computes isSelf = d.id == app.auth.deviceId and uses it TWICE:
        // the "(this phone)" accent label, and withholding the revoke button (revoking
        // self would kill the app's own auth). With invented ids nothing matches, so the
        // capture would offer `revoke` on the very phone taking the screenshot —
        // advertising a control the product deliberately hides.
        val rows = FleetHarness.rows(selfId = "real-device-id", nowSec = NOW)
        assertEquals(1, rows.count { it.id == "real-device-id" })
        // Exactly one self row, and every other id is distinct from it.
        val self = rows.first { it.id == "real-device-id" }
        for (r in rows.filter { it !== self }) assertNotEquals(self.id, r.id)
    }

    @Test fun `an unenrolled app still gets exactly one self row`() {
        // auth.deviceId is null until the phone enrols. A null-through would make ids
        // like null == null match on every row, or none — either way the screen's
        // self-handling stops being what a real fleet shows.
        for (id in listOf(null, "", "   ")) {
            val rows = FleetHarness.rows(selfId = id, nowSec = NOW)
            assertEquals(
                "selfId=<$id> did not produce one self row",
                1,
                rows.count { it.id == FleetHarness.PLACEHOLDER_SELF },
            )
        }
    }

    @Test fun `every id is unique, so no two rows collapse into self`() {
        val rows = FleetHarness.rows("d1", NOW)
        assertEquals(rows.size, rows.map { it.id }.toSet().size)
    }

    // ── the dataset exercises what the caption claims ────────────────────────

    @Test fun `presence is mixed, so the dot channel is not flat`() {
        // A uniform list would quietly stop demonstrating a fleet with mixed presence
        // while still captioning it — the same class of defect as GraphHarness's
        // recency-span trap.
        val rows = FleetHarness.rows("d1", NOW)
        assertTrue("no online device", rows.any { it.presence == DevicePresence.ONLINE })
        assertTrue("no offline device", rows.any { it.presence == DevicePresence.OFFLINE })
        // No UNKNOWN row on purpose — the worker only sends `online: null` for
        // endpoint kinds, and there is deliberately no endpoint row (below). A
        // fabricated "reachable when called" daemon would draw a pairing the
        // product never produces. Pinned so it stays a decision, not a drift.
        assertTrue(
            "a demo row claims unknown presence",
            rows.none { it.presence == DevicePresence.UNKNOWN },
        )
    }

    @Test fun `every relativeSeen bucket appears exactly once among offline rows`() {
        // The second line is COMPUTED from lastSeen (presenceLine → relativeSeen), so
        // this is what proves the offline rows show a spread rather than seven
        // identical lines.
        val rows = FleetHarness.rows("d1", NOW)
        val buckets = rows.filter { it.presence == DevicePresence.OFFLINE }.map {
            val s = relativeSeen(it.lastSeen, NOW)
            when {
                s == "never" -> "never"
                s == "just now" -> "just now"
                s.endsWith("m ago") -> "minutes"
                s.endsWith("h ago") -> "hours"
                s.endsWith("d ago") -> "days"
                else -> "?"
            }
        }
        assertFalse("an unclassified bucket", buckets.contains("?"))
        assertEquals(
            "buckets are not all distinct: $buckets",
            buckets.size,
            buckets.toSet().size,
        )
        assertTrue("the never bucket is unexercised", buckets.contains("never"))
    }

    @Test fun `a never-seen row renders as never, not as the epoch`() {
        // lastSeen 0 is the wire's "never heard from". An offset arithmetic slip would
        // turn it into `nowSec - (-1)`, i.e. one second in the FUTURE, which
        // relativeSeen clamps to "just now" — a device that never checked in would be
        // drawn as the most recently active one on screen.
        val rows = FleetHarness.rows("d1", NOW)
        val never = rows.filter { it.lastSeen == 0L }
        assertEquals(1, never.size)
        assertEquals("never", relativeSeen(never[0].lastSeen, NOW))
        assertTrue("a lastSeen is in the future", rows.all { it.lastSeen <= NOW })
    }

    @Test fun `no row is an endpoint, so no camera panel fetches for a fake device`() {
        // kind == "endpoint" mounts EndpointPanel, which immediately fetches
        // /api/devices/endpoint?deviceId=… — for a fabricated id that means real
        // requests for a device that doesn't exist, and an error panel rendered into
        // the marketing shot.
        val rows = FleetHarness.rows("d1", NOW)
        assertTrue("a demo row is an endpoint", rows.none { it.isEndpoint })
        assertTrue("a demo row carries capabilities", rows.all { it.capabilities.isEmpty() })
    }

    @Test fun `every kind is one the product really emits`() {
        // A seeded value can name anything, so it has to be checked against source
        // rather than against the caption: FleetManager/Session enrol as "daemon", the
        // web enrol form offers cli/daemon/browser, the route defaults to "cli".
        val real = setOf("daemon", "cli", "browser")
        for (r in FleetHarness.rows("d1", NOW)) {
            assertTrue("kind '${r.kind}' is not one the app emits", r.kind in real)
        }
    }

    @Test fun `second lines are the real computed strings, not placeholders`() {
        // End-to-end on the text the screenshot actually shows: an online row must say
        // "online" and never a stale recency, and an offline row must say "seen …" or
        // "never seen".
        val rows = FleetHarness.rows("d1", NOW)
        for (r in rows) {
            val s = presenceLine(r, NOW)
            if (r.presence == DevicePresence.ONLINE) {
                assertTrue("an online row shows a recency: $s", s.startsWith("online"))
            } else {
                assertTrue(
                    "offline row lacks a seen line: $s",
                    s.startsWith("seen ") || s.startsWith("never seen"),
                )
            }
        }
    }

    @Test fun `the platform column is exercised, not left blank on every row`() {
        // The whole point of seeding `platform`: without it every row fell through
        // deviceLabel to its `kind` word and the capture showed seven devices calling
        // themselves "device" and "computer" — a line the product doesn't draw.
        // iOS's fixture had the mirror-image bug (a printer posting "bambu").
        // Pinned against the HARDWARE table, not against "is it non-empty":
        // blanking every platform still leaves the kind fallback emitting three
        // distinct words ("device", "computer", "browser"), so a non-empty check
        // passes on exactly the dataset this test exists to reject. Measured —
        // that mutant survived the first version of this assertion.
        val hardware = DEVICE_PLATFORM_NAME.map { it.second }.toSet()
        val rows = FleetHarness.rows("d1", NOW)
        val named = rows.map { deviceDescriptor(it) }
        assertTrue(
            "no row names real hardware — every one fell back to its kind: $named",
            named.count { it in hardware } >= 6,
        )
        assertTrue("the hardware column is flat: $named", named.filter { it in hardware }.toSet().size >= 3)
        // And no row may render a `kind` word, which is the line being replaced.
        val kindWords = DEVICE_KIND_NAME.values.toSet()
        for (r in rows) {
            // The browser row is the exception ON PURPOSE: a browser enrols
            // through the web form and posts no platform, so "browser" is both
            // its kind word and the truest thing anyone can say about it.
            if (r.kind == "browser") continue
            assertFalse(
                "row '${r.name}' fell back to a kind word: ${deviceDescriptor(r)}",
                deviceDescriptor(r) in kindWords,
            )
        }
    }

    @Test fun `every platform is a token the product really enrols`() {
        // Same rule as the `kind` check below, for the same reason: a seeded string can
        // claim any hardware. Session/FleetManager build these from Build.* and the
        // iOS/CLI daemons post the darwin/linux forms; "" is the browser row, which
        // enrols through the web form and posts no platform at all.
        val real = setOf("android-arm64", "darwin-arm64", "ios-arm64", "linux-arm64", "linux-x64", "")
        for (r in FleetHarness.rows("d1", NOW)) {
            assertTrue("platform '${r.platform}' is not one the app enrols", r.platform in real)
        }
    }

    @Test fun `no row carries a url, because none of them is an endpoint`() {
        // deviceDescriptor prefers `url` for endpoint rows. A demo row with a url but a
        // non-endpoint kind would render a host the fake device does not serve.
        assertTrue("a demo row carries a url", FleetHarness.rows("d1", NOW).all { it.url.isEmpty() })
    }

    // ── the wiring ───────────────────────────────────────────────────────────

    /**
     * Everything above tests a PURE OBJECT, and a pure object cannot tell whether
     * anything ever calls it: commenting the substitution block out of `DevicesSheet`
     * left all thirteen tests green and the harness dead. A screenshot harness that is
     * never invoked isn't a benign no-op — it means the next capture silently renders the
     * REAL fleet again, which is the exact leak this cycle exists to close.
     *
     * DevicesSheet is a @Composable driving a LaunchedEffect over a network call, so
     * there is no JVM-unit path that RUNS it. Reading the source is the weaker
     * substitute, so it is made as strict as a text assertion can be: comments are
     * stripped first (a `contains("FleetHarness.rows")` passes on a commented-out line —
     * and on FleetHarness.kt's own docblock), the call must sit INSIDE DevicesSheet, and
     * it must sit BEFORE the /api/devices fetch, which is the ordering the call site
     * argues for and the reason no request flies during a capture.
     */
    @Test fun `the sheet actually calls the harness, live and before the fetch`() {
        val src = java.io.File("src/main/java/technology/tiny/app/ui/Panels.kt")
        // A moved file must FAIL, not vacuously pass. (cwd for JVM unit tests is
        // android/app — verified, not assumed.)
        assertTrue("Panels.kt not found at ${src.absolutePath} — re-anchor this test", src.isFile)
        val code = stripComments(src.readText())

        val sheet = code.indexOf("fun DevicesSheet(")
        assertTrue("DevicesSheet not found in live code", sheet >= 0)
        val fetch = code.indexOf("\"/api/devices\"", sheet)
        assertTrue("the /api/devices fetch is gone from DevicesSheet", fetch > sheet)

        // Anchor on the CALLS, not the bare identifier: an import or a doc mention would
        // otherwise satisfy this and prove nothing.
        val gate = code.indexOf("FleetHarness.enabled(", sheet)
        val rows = code.indexOf("FleetHarness.rows(", sheet)
        assertTrue("DevicesSheet never calls FleetHarness.enabled() in live code", gate in (sheet + 1) until fetch)
        assertTrue("DevicesSheet never calls FleetHarness.rows() in live code", rows in (gate + 1) until fetch)

        // And the gate is handed the real build flag. Passing a literal `true` would
        // compile, pass every test above, and arm the harness on a shipped APK.
        val args = code.substring(gate, code.indexOf(')', gate) + 1)
        assertTrue("the gate is not passed BuildConfig.DEBUG: $args", args.contains("BuildConfig.DEBUG"))
        assertTrue("the gate is not passed the process flag: $args", args.contains("fleetHarness"))
    }

    /** Drops `/* … */` blocks and `//` tails so a commented-out call can't satisfy a match. */
    private fun stripComments(s: String): String {
        val noBlocks = Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL).replace(s, " ")
        return noBlocks.lineSequence().joinToString("\n") { line ->
            val i = line.indexOf("//")
            if (i >= 0) line.substring(0, i) else line
        }
    }

    @Test fun `the fleet is big enough to read as a fleet and small enough to fit`() {
        // The caption is "Phone, tablet, watch — all one AI". Two rows wouldn't earn it;
        // a dozen would overflow the sheet and crop mid-row in a 9:16 store frame.
        val n = FleetHarness.rows("d1", NOW).size
        assertTrue("fleet of $n reads thin", n >= 5)
        assertTrue("fleet of $n will crop", n <= 8)
    }
}
