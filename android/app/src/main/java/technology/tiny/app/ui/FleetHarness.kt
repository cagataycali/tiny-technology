package technology.tiny.app.ui

/**
 * FleetHarness — debug-only substitute device list for the `fleet` screenshot.
 *
 * ## Why this exists
 *
 * `play-05-devices.png` was sitting in the Play upload tree rendering the user's real
 * device fleet BY HOSTNAME — six rows, one per device they own (both phones, both
 * laptops, the tablet and a node), each carrying its own real name plus its
 * online/last-seen state and a `revoke` button. The same raw also fed two Instagram
 * carousel slides (`ig-p1-5-devices`, `ig-p4-3-node`) that no cycle had ever listed.
 *
 * The names are described, never quoted: a docblock about why a hostname list cannot be
 * published is the last place one should be pasted, and this file ships in the APK and
 * in a public repo. `published-hostname-scrub.test.ts` greps this file for them.
 *
 * Unlike the wallet page there is **no publishable crop**: the fleet LIST is the
 * screen's entire content, so every crop worth captioning is the hostname list. And
 * unlike the chat shots there is nothing on disk to seed — the fleet is a **network
 * fetch** (`GET /api/devices` in [DevicesSheet]), so the substitution has to happen
 * where the fetch would land. Same problem and same shape of answer as [GraphHarness],
 * one screen over.
 *
 * ## What it fakes, and what it deliberately does NOT
 *
 * Only the ROWS. Everything that makes the screenshot a depiction of the product stays
 * on the real code path: [PresenceDot]'s three-state tint, [presenceLine]'s
 * "online · Mac" / "seen <relative> · iOS" text, [deviceLabel]'s platform table,
 * [relativeSeen]'s buckets, the `(this phone)` self-label, and the rule that the
 * current device is offered no revoke button. Those are read off the same fields the
 * wire supplies.
 *
 * The third presence state — [DevicePresence.UNKNOWN], "reachable when called" — is
 * absent for the same reason the endpoint row is (below): the worker only sends
 * `online: null` for endpoint kinds, so a row that renders it honestly is a row that
 * mounts [EndpointPanel]. Faking presence without faking the kind would draw a state
 * the product never pairs with a `daemon`.
 *
 * ## Two things a fixed dataset gets WRONG here, which [GraphHarness] does not have
 *
 *  1. **`lastSeen` is judged against NOW, so it cannot be a fixed epoch.** GraphHarness
 *     pins `T0 = 1_753_000_000` and that is correct there, because `validFrom` only
 *     feeds a *self-relative* recency ramp — the span is what matters, not the absolute
 *     value. A device's `lastSeen` goes through [relativeSeen] against `nowSec`, so the
 *     same trick renders "371d ago" on every row and gets worse every day. Copying the
 *     sibling harness verbatim would have produced a screenshot that looked plausible on
 *     capture day and rotted silently. Hence [rows] takes `nowSec` and stores OFFSETS.
 *
 *  2. **The self row must carry the REAL device id**, or the screenshot shows a screen
 *     the app never renders. `DevicesSheet` computes `isSelf = d.id == app.auth.deviceId`
 *     and uses it twice: to append `(this phone)` in the accent colour, and to withhold
 *     the revoke button (revoking self would kill the app's own auth). With invented ids
 *     nothing matches, so every row — including the phone taking the screenshot — would
 *     offer `revoke`, advertising a control the product deliberately hides. So [rows]
 *     takes `selfId` and stamps it onto the phone row. That leaks nothing: a row's id is
 *     never drawn (only name/kind/subtitle are), and the id is a local opaque handle.
 *
 * ## No `endpoint` row, on purpose
 *
 * `kind == "endpoint"` makes the row mount [EndpointPanel], which immediately fetches
 * `/api/devices/endpoint?deviceId=…` for a camera frame and telemetry. A fabricated id
 * would send real requests for a device that does not exist and render an error panel
 * into the marketing shot. A robot deserves its own captioned shot from a real endpoint,
 * not a fake row here.
 *
 * ## Safety
 *
 * Pure on purpose (no Context, no Intent, no BuildConfig read): the rules are
 * JVM-unit-tested in FleetHarnessTest, and [enabled] takes `debug` explicitly so a test
 * can pin that a release build substitutes NOTHING. The call site in [DevicesSheet]
 * passes `BuildConfig.DEBUG`, so on a shipped APK the flag is inert however the intent
 * is crafted — a stranger's install cannot be shown a fake fleet.
 *
 *   adb shell am start -n technology.tiny.app/.MainActivity \
 *     --ez tiny_harness_fleet true
 */
object FleetHarness {

    /** Launch-extra key. Prefixed `tiny_harness_` to match [GraphHarness]'s keys. */
    const val EXTRA_FLEET = "tiny_harness_fleet"

    /**
     * Whether to substitute the demo fleet. False in a release build no matter what the
     * extra says — that's the whole safety property.
     */
    fun enabled(debug: Boolean, raw: Boolean): Boolean = debug && raw

    /** Id for the phone row when the app has no enrolled device id (see [rows]). */
    internal const val PLACEHOLDER_SELF = "harness-self"

    private const val MIN = 60L
    private const val HOUR = 3_600L
    private const val DAY = 86_400L

    /**
     * One row per shape the screen can draw, because the caption claims a fleet with
     * mixed presence and a uniform list would quietly stop showing it:
     *
     *  - `online = true` (the lit dot) on the phone and one desktop,
     *  - and every [relativeSeen] bucket exactly once across the offline rows:
     *    "just now", "Nm ago", "Nh ago", "Nd ago", "never".
     *
     * `secondsAgo < 0` means "never checked in" — the wire sends `last_seen` 0/absent,
     * and 0 is not expressible as an offset from now.
     *
     * Names are generic device types, never hostnames: the real fleet's names embed the
     * account login (`FleetManager.enrollIfNeeded` builds `"${auth.login}-pixel"`), which
     * is exactly what leaked.
     *
     * Each row also carries the `platform` its real counterpart posts, because the
     * second line names the HARDWARE now ("Mac", not "daemon · darwin-arm64").
     * Without them every demo row fell back to its `kind` word and the fixture
     * became the one place in the world where a fleet of seven devices claimed to
     * be four "device"s and three "computer"s — a screenshot of a line the
     * product doesn't draw. iOS hit the mirror image of this: its fixture posted
     * `"platform": "bambu"` on a printer, making our own captures the only place
     * a robot's row said what hardware it was.
     */
    private val DEMO = listOf(
        Demo(name = "pixel", kind = "daemon", platform = "android-arm64", online = true, secondsAgo = 0L, self = true),
        Demo(name = "macbook-pro", kind = "daemon", platform = "darwin-arm64", online = true, secondsAgo = 0L),
        // An iPad enrolls as "ios-arm64" — Session/FleetManager hard-code it for
        // both idioms and make only the NAME idiom-aware. So this row reads "iOS",
        // which is the strongest TRUE claim for that token; the `ipad` needle in
        // DEVICE_PLATFORM_NAME is dead for anything this app enrolled. Recorded
        // rather than fixed: correcting it means changing the wire, and
        // lib/chat/tools/nicla-voice.ts matches `platform === 'ios-arm64'` exactly
        // to pick the recorder phone for the Voice necklace.
        Demo(name = "ipad", kind = "daemon", platform = "ios-arm64", online = false, secondsAgo = 30L),
        Demo(name = "studio-mac", kind = "cli", platform = "darwin-arm64", online = false, secondsAgo = 8 * MIN),
        Demo(name = "chrome-laptop", kind = "browser", platform = "", online = false, secondsAgo = 5 * HOUR),
        Demo(name = "watch", kind = "daemon", platform = "linux-arm64", online = false, secondsAgo = 2 * DAY),
        Demo(name = "old-thinkpad", kind = "cli", platform = "linux-x64", online = false, secondsAgo = -1L),
    )

    private data class Demo(
        val name: String,
        val kind: String,
        val platform: String,
        val online: Boolean,
        val secondsAgo: Long,
        val self: Boolean = false,
    )

    /**
     * The demo fleet, as [DeviceRow]s the sheet can render unchanged.
     *
     * @param selfId the app's own enrolled device id, so the phone row reads as `self`
     *   and the screen behaves exactly as it does for a real fleet. Null (not enrolled)
     *   falls back to [PLACEHOLDER_SELF] — still self-consistent, so the capture never
     *   shows a revoke button on the device taking the screenshot.
     * @param nowSec the clock the sheet is about to format against, so `lastSeen` is an
     *   offset from it rather than a fixed epoch that ages into "371d ago".
     */
    fun rows(selfId: String?, nowSec: Long): List<DeviceRow> {
        val self = selfId?.takeIf { it.isNotBlank() } ?: PLACEHOLDER_SELF
        return DEMO.mapIndexed { i, d ->
            DeviceRow(
                id = if (d.self) self else "demo-$i",
                name = d.name,
                kind = d.kind,
                online = d.online,
                lastSeen = if (d.secondsAgo < 0L) 0L else nowSec - d.secondsAgo,
                platform = d.platform,
                // Empty on purpose: capabilities only drive the endpoint camera panel,
                // and there is deliberately no endpoint row. See the class docblock.
                capabilities = emptyList(),
            )
        }
    }
}
