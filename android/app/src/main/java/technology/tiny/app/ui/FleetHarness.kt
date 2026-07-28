package technology.tiny.app.ui

/**
 * FleetHarness — debug-only substitute device list for the `fleet` screenshot.
 *
 * ## Why this exists
 *
 * `play-05-devices.png` was sitting in the Play upload tree rendering the user's real
 * device fleet BY HOSTNAME — `cagataycali-iphone`, `cagataycali-pixel (this phone)`,
 * `cagatay-mac`, `cagataycali-ipad`, `cagatay-cagatay`, `thor` — each with its
 * online/last-seen state and a `revoke` button. The same raw also fed two Instagram
 * carousel slides (`ig-p1-5-devices`, `ig-p4-3-node`) that no cycle had ever listed.
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
 * on the real code path: [StatusDot]'s online colour, [deviceSubtitle]'s
 * "<kind> · online" / "<kind> · seen <relative>" text, [relativeSeen]'s buckets, the
 * `(this phone)` self-label, and the rule that the current device is offered no revoke
 * button. Those are read off the same fields the wire supplies.
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
     */
    private val DEMO = listOf(
        Demo(name = "pixel", kind = "daemon", online = true, secondsAgo = 0L, self = true),
        Demo(name = "macbook-pro", kind = "daemon", online = true, secondsAgo = 0L),
        Demo(name = "ipad", kind = "daemon", online = false, secondsAgo = 30L),
        Demo(name = "studio-mac", kind = "cli", online = false, secondsAgo = 8 * MIN),
        Demo(name = "chrome-laptop", kind = "browser", online = false, secondsAgo = 5 * HOUR),
        Demo(name = "watch", kind = "daemon", online = false, secondsAgo = 2 * DAY),
        Demo(name = "old-thinkpad", kind = "cli", online = false, secondsAgo = -1L),
    )

    private data class Demo(
        val name: String,
        val kind: String,
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
                // Empty on purpose: capabilities only drive the endpoint camera panel,
                // and there is deliberately no endpoint row. See the class docblock.
                capabilities = emptyList(),
            )
        }
    }
}
