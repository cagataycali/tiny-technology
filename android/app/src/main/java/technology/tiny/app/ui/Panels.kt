package technology.tiny.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Bluetooth
import androidx.compose.material.icons.outlined.BluetoothConnected
import androidx.compose.material.icons.outlined.BluetoothSearching
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.KeyboardCommandKey
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Mouse
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.RadioButtonChecked
import androidx.compose.material.icons.outlined.RemoveRedEye
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Window
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhonelinkErase
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Podcasts
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.ScreenRotation
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.SettingsRemote
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Straighten
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.*
import androidx.compose.runtime.*
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import technology.tiny.app.fleet.PhoneRecorder
import technology.tiny.app.fleet.VoiceStatus
import technology.tiny.app.fleet.WearablesBridge
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import technology.tiny.app.geo.Geo
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.net.ModelConfigStore
import technology.tiny.app.net.Standing
import technology.tiny.app.ui.theme.TinyGray
import technology.tiny.app.ui.theme.TinyWarn

data class DeviceRow(
    val id: String,
    val name: String,
    val kind: String,
    /**
     * The wire's `online` — NULLABLE, because presence is a THREE-state fact and
     * only two of them are a boolean question. An endpoint device never
     * heartbeats, so the worker sends `null` (devices.ts:294) meaning "unknown
     * from here", and this app flattened it to `false`: a healthy printer read
     * "endpoint · seen never" — declared dead twice in four words — with a grey
     * dot beside it. iOS keeps the same `Bool?` for the same reason.
     */
    val online: Boolean?,
    val lastSeen: Long, // unix seconds (worker /api/devices), 0 when never heard from
    /// Parsed from the wire's JSON *string* — decides whether a camera is drawn.
    val capabilities: List<String> = emptyList(),
    /// "nicla-vision" / "nicla-voice" / "" — picks the row's live sub-panel.
    val platform: String = "",
    /**
     * Endpoint devices only: the https origin tiny dials OUT to.
     *
     * The worker lists it deliberately — its SELECT carries the comment "the
     * owner needs to see where a body lives" — and this app was throwing it
     * away, which is why a printer's row had nothing to say about itself.
     */
    val url: String = "",
) {
    val presence: DevicePresence
        get() = when (online) {
            null -> DevicePresence.UNKNOWN
            true -> DevicePresence.ONLINE
            false -> DevicePresence.OFFLINE
        }
    /**
     * An endpoint device is a robot at its own authenticated API (printer, rover),
     * not something that heartbeats to us. Only these get a live camera/telemetry
     * panel — every other row must cost nothing extra.
     */
    val isEndpoint: Boolean get() = kind == "endpoint"
}

/**
 * Capability → icon for the devices list's hardware strip (iOS capabilityIcon,
 * Panels.swift:1643). "wake" is the Nicla Voice's always-on wake-word
 * inference — the one capability that is a *listening posture* rather than a
 * piece of hardware.
 */
internal fun capabilityIcon(c: String): ImageVector? = when (c) {
    // Hardware sensors (the Nicla boards + glasses)
    "camera" -> Icons.Outlined.PhotoCamera
    "mic" -> Icons.Outlined.Mic
    "tof" -> Icons.Outlined.Straighten
    "imu" -> Icons.Outlined.ScreenRotation
    "ble" -> Icons.Outlined.Bluetooth
    "wifi" -> Icons.Outlined.Wifi
    "wake" -> Icons.Outlined.GraphicEq
    "glasses" -> Icons.Outlined.Visibility
    // Phone-node capabilities
    "chat" -> Icons.AutoMirrored.Outlined.Chat
    "bluetooth_scan" -> Icons.Outlined.BluetoothSearching
    "location" -> Icons.Outlined.LocationOn
    "record" -> Icons.Outlined.RadioButtonChecked
    "speak" -> Icons.Outlined.VolumeUp
    "open_app" -> Icons.Outlined.Apps
    "image_gen" -> Icons.Outlined.AutoAwesome
    "voice" -> Icons.Outlined.RecordVoiceOver
    "see" -> Icons.Outlined.RemoveRedEye
    // Daemon/CLI capabilities (the Mac's long list)
    "mcp" -> Icons.Outlined.Extension
    "files" -> Icons.Outlined.Folder
    "shell" -> Icons.Outlined.Terminal
    "apple" -> Icons.Outlined.KeyboardCommandKey
    "computer" -> Icons.Outlined.Mouse
    "windows" -> Icons.Outlined.Window
    "ocr" -> Icons.Outlined.DocumentScanner
    "browse" -> Icons.Outlined.Public
    "desktop" -> Icons.Outlined.NotificationsActive
    "spotify" -> Icons.Outlined.MusicNote
    "google" -> Icons.Outlined.Search
    "whatsapp" -> Icons.Outlined.Sms
    "adb" -> Icons.Outlined.BugReport
    "flipper" -> Icons.Outlined.SettingsRemote
    // A Flipper reached over Bluetooth by the phone itself, not down a cable.
    // Mirrors iOS `dot.radiowaves.right` (Panels.swift capabilityIcon) — the
    // parity suite requires the same token on both phones, icons may differ.
    "flipper_ble" -> Icons.Outlined.BluetoothConnected
    // Endpoint devices
    "print" -> Icons.Outlined.Print
    "telemetry" -> Icons.Outlined.MonitorHeart
    // No glyph rather than a stand-in one (iOS 96da0dfc): an icon that is
    // the same on every unknown chip reads as a rendering fault, not
    // information — the word alone carries the meaning.
    else -> null
}

/**
 * Capability → the user's word for it (iOS CAPABILITY_LABELS, Panels.swift).
 *
 * The strip used to print the daemon's token verbatim: a laptop row read
 * `bluetooth_scan` `image_gen` `open_app` `tof` `imu` `ble` `windows` — three
 * with an underscore in them, four acronyms expanded nowhere on screen, and one
 * that reads as Microsoft's product. TalkBack had it worst, since
 * `contentDescription = c` said "bluetooth underscore scan" on the one surface
 * where an unexplained token can't be squinted at twice.
 *
 * Terse on purpose: this is a capsule in a strip a dozen wide, not a sentence.
 * The long forms live in CAPABILITY_HINTS (web `lib/chat/prompt.ts`) for the
 * agent, and each label here is that hint's headline — so the two differ in
 * length without differing in meaning.
 *
 * A map, not a `when`: `tests/nicla-android-parity.test.ts` scrapes iOS's table
 * to enumerate capabilities, and pinning shapes on both sides is what keeps the
 * two phones' vocabularies honest.
 */
internal val CAPABILITY_LABELS: Map<String, String> = mapOf(
    // ── The necklaces ──
    "camera" to "camera",
    "mic" to "mic",
    "tof" to "distance", // time-of-flight ranging
    "imu" to "motion", // accelerometer + gyroscope
    "ble" to "bluetooth",
    "wifi" to "Wi-Fi",
    "wake" to "wake word",
    // ── This phone ──
    "chat" to "chat",
    "bluetooth_scan" to "bluetooth",
    "location" to "location",
    "record" to "records audio",
    "speak" to "speaks",
    "open_app" to "opens apps",
    "image_gen" to "makes images",
    "glasses" to "glasses",
    // ── Mesh nodes (tiny-tech device-tools.ts) ──
    "mcp" to "MCP", // an acronym, so at least let it read as a NAME
    "files" to "files",
    "shell" to "shell",
    "apple" to "Apple apps",
    "computer" to "screen control",
    "ocr" to "reads text",
    // Not Microsoft's. "windows" alone is the one token here that reads as a
    // different product entirely, which is worse than reading as jargon.
    "windows" to "arranges windows",
    "browse" to "browser",
    "desktop" to "notifications",
    "voice" to "voice",
    "see" to "sees images",
    "spotify" to "Spotify",
    "google" to "Google",
    "whatsapp" to "WhatsApp",
    "telegram" to "Telegram",
    "adb" to "Android",
    "flipper" to "Flipper Zero",
    "flipper_ble" to "Flipper (Bluetooth)",
    "integrations" to "integrations",
    // ── Endpoint robots ──
    "print" to "prints",
    "telemetry" to "telemetry",
)

/**
 * A capability's label, falling back to the token with its separators opened up.
 *
 * An unmapped word still shows — a newer daemon must not be silenced, the same
 * rule [capabilityIcon] follows by returning null rather than a stand-in glyph.
 * But it shows as WORDS: whatever `some_new_thing` turns out to mean, it never
 * means an underscore.
 */
internal fun capabilityLabel(c: String): String =
    CAPABILITY_LABELS[c] ?: c.replace('_', ' ').replace('-', ' ')

/**
 * Strip order: by the visible label, case-insensitively so proper nouns
 * ("Wi-Fi", "Spotify") don't float to the top, with the token as a tiebreak so
 * the order stays total and stable across refreshes.
 */
internal fun sortCapabilities(caps: List<String>): List<String> =
    caps.sortedWith(compareBy({ capabilityLabel(it).lowercase() }, { it }))

/**
 * How many capability labels a collapsed device row shows, and what the rest become.
 *
 * The strip was uncapped. A laptop declares twelve capabilities — `npx tiny-tech
 * mesh` sends one per resolved device tool — so its FlowRow wrapped to several
 * lines of grey words and the row's own NAME stopped being the largest thing in
 * it. The row answers two questions, "which device is this" and "can I reach it";
 * the reference strip was outweighing both, six near-identical walls down a list.
 *
 * The precedent is `BuilderCard`'s tiny strip (MemoryUniverse.kt:424), which caps
 * at eight and offers a trailing "+N more".
 * iOS CapabilityRibbon (Panels.swift:1865).
 *
 * ⚠️ What survives the cap is the alphabetical PREFIX, not a ranking.
 * [sortCapabilities] orders by the visible label on purpose — a list ordered by an
 * invisible field looks like a list nobody ordered — and ranking by anything else
 * (which ones grow a panel, say) would order the row by a field nobody is shown.
 * The bias is worth admitting: a phone shows bluetooth, chat, glasses, location
 * and hides makes images, opens apps, records audio, speaks. That is exactly why
 * the rest are one tap away, and why TalkBack still hears every one of them
 * ([toggleDescription]) — the cap is a WIDTH problem and a spoken row has no width.
 */
internal object CapabilityRibbon {
    const val cap = 4

    /** Both halves from ONE cut, so what is drawn and what is claimed hidden cannot disagree. */
    data class Split(val shown: List<String>, val hidden: List<String>)

    fun split(caps: List<String>, expanded: Boolean): Split {
        // "+1 more" is a word that hides a word: it costs the line space it saves,
        // so the cap only applies where it buys back at least two.
        if (!expanded && caps.size > cap + 1) return Split(caps.take(cap), caps.drop(cap))
        return Split(caps, emptyList())
    }

    /**
     * The toggle's words, or null when this row has nothing to collapse — asked of
     * [split] rather than of `size`, so one rule decides both whether the strip is
     * capped and whether a control admits it. Always asked with `expanded = false`:
     * an OPEN ribbon still needs to know how many it is holding open, or there is
     * no way back.
     */
    fun toggleLabel(caps: List<String>, expanded: Boolean): String? {
        val hidden = split(caps, expanded = false).hidden
        if (hidden.isEmpty()) return null
        return if (expanded) "show fewer" else "+${hidden.size} more"
    }

    /**
     * What TalkBack reads INSTEAD of "+8 more" — the same control, saying the words
     * the strip stopped drawing.
     *
     * iOS gets this free: `.accessibilityElement(children: .combine)` makes the
     * row's own label the only one VoiceOver reads, and it enumerates the whole
     * fleet either way. Compose has no such merge here — every capability is its
     * own semantics node — so capping the strip visually WOULD delete those
     * capabilities from the spoken row, which is the one place the cap has no
     * excuse: a spoken row has no width. The labels come from the same cut that did
     * the hiding, so this can never name a capability the strip is still showing.
     */
    fun toggleDescription(caps: List<String>, expanded: Boolean): String? {
        val hidden = split(caps, expanded = false).hidden
        if (hidden.isEmpty()) return null
        if (expanded) return "show fewer"
        return "can also " + hidden.joinToString(", ") { capabilityLabel(it) }
    }

    /** The ACTION, which is a different sentence from the content: "double tap to …". */
    fun toggleAction(expanded: Boolean): String =
        if (expanded) "show fewer capabilities" else "show all capabilities"
}

/**
 * Relative "last heard from" for a fleet device — byte-for-byte the web devices
 * page's buckets (app/devices/page.tsx:42-50). [nowSec] is injected so the result
 * is deterministic in tests. 0/absent → "never" (a device that never checked in).
 */
internal fun relativeSeen(lastSeenSec: Long, nowSec: Long): String {
    if (lastSeenSec <= 0L) return "never"
    val d = maxOf(0L, nowSec - lastSeenSec)
    return when {
        d < 60 -> "just now"
        d < 3600 -> "${d / 60}m ago"
        d < 86400 -> "${d / 3600}h ago"
        else -> "${d / 86400}d ago"
    }
}

/**
 * Presence is a THREE-state fact and only two of them are a boolean question.
 *
 * An endpoint device (a robot behind its own authenticated API) never
 * heartbeats, so the worker reports `online: null` — "unknown from here" — and
 * neither "online" nor "offline" is a true statement about it. Web parity:
 * `presenceOf` in app/devices/page.tsx; iOS DevicePresence.
 */
enum class DevicePresence { ONLINE, OFFLINE, UNKNOWN }

/**
 * Platform → the word for the hardware, mirroring iOS DEVICE_PLATFORM_NAME.
 *
 * A LIST, not a map, because these are substring needles matched IN ORDER and
 * that order is load-bearing: "ipados" contains "ios", so only `ipad` sitting
 * before `ios` keeps an iPad off the iPhone entry. A map would lose it.
 */
internal val DEVICE_PLATFORM_NAME: List<Pair<String, String>> = listOf(
    "nicla-vision" to "Nicla Vision",
    "nicla-voice" to "Nicla Voice",
    "darwin" to "Mac",
    "mac" to "Mac",
    "ipad" to "iPad",
    "ios" to "iOS",
    "android" to "Android",
    "linux" to "Linux",
    "win" to "Windows",
)

/** Kind → a word, for the rows where no platform is on the wire at all. */
internal val DEVICE_KIND_NAME: Map<String, String> = mapOf(
    "endpoint" to "robot",
    "browser" to "browser",
    "cli" to "computer",
    "daemon" to "device",
)

/**
 * What the thing IS, in words — "Mac", not "darwin-arm64".
 *
 * The row's second line printed both identifier fields the daemon posts to the
 * server: "daemon · darwin-arm64", "endpoint · bambu", "daemon · nicla-vision".
 * Those are wire identifiers, and read as English they are false — a necklace is
 * not a daemon and a 3D printer is not an endpoint; they name how the device
 * dialled in, not what it is. `kind` is also redundant wherever a platform
 * exists, which is every row where it matters, so the honest line is one word
 * rather than two.
 *
 * An unmapped platform still SHOWS, with its separators opened up
 * (`freebsd-arm64` → "freebsd arm64"), because a newer daemon must not vanish
 * from the sheet — the same rule [capabilityLabel] follows. Empty only when the
 * row has nothing to say, so [presenceLine] never joins a separator onto
 * nothing. iOS deviceLabel(platform:kind:).
 */
internal fun deviceLabel(platform: String, kind: String): String {
    val p = platform.trim().lowercase()
    if (p.isNotEmpty() && p != "?") {
        DEVICE_PLATFORM_NAME.firstOrNull { p.contains(it.first) }?.let { return it.second }
        return p.replace('_', ' ').replace('-', ' ')
    }
    return DEVICE_KIND_NAME[kind.trim().lowercase()] ?: ""
}

/**
 * The row's identity word — or, for a robot, its ADDRESS.
 *
 * A robot is the one device class with no platform on the wire: nothing
 * self-reports for it, since the enroll form posts `{name, kind}` and nothing
 * else. So the most this line could otherwise say is its `kind` in a nicer word,
 * and "robot" is a category that tells the owner nothing they didn't already
 * know from opening the sheet. Where the body LIVES is the fact they can't get
 * anywhere else on this screen — the worker lists `url` for exactly that reason
 * ("the owner needs to see where a body lives") and this app decoded every field
 * of that response except this one.
 *
 * Scheme stripped, matching web (`d.url.replace(/^https:\/\//, "")`): the worker
 * normalises every endpoint to an https origin, so "https://" is eight
 * identical characters on every robot's row, spent on the widest element in it.
 * A port survives, because it is part of where the body actually is. Endpoints
 * ONLY — a daemon that somehow carried a url is still named by its hardware,
 * since an address is not a Mac's identity. iOS DeviceRow.descriptor.
 */
internal fun deviceDescriptor(d: DeviceRow): String {
    if (d.isEndpoint) {
        val host = d.url.trim()
        if (host.isNotEmpty()) return host.removePrefix("https://")
    }
    return deviceLabel(d.platform, d.kind)
}

/**
 * `online · Mac` — the device row's whole second line.
 *
 * An offline device shows its relative last-seen instead of the word "offline",
 * because "3 minutes ago" and "in March" are otherwise the same word and that
 * difference is the entire question being asked. A row with nothing to say about
 * its hardware gets no trailing " · ". iOS DeviceRow.presenceLine.
 */
internal fun presenceLine(d: DeviceRow, nowSec: Long): String {
    val presence = when (d.presence) {
        DevicePresence.ONLINE -> "online"
        // Not "offline": this device answers when tiny dials OUT to it, and the
        // panel below the row is what actually proves it's alive.
        DevicePresence.UNKNOWN -> "reachable when called"
        DevicePresence.OFFLINE ->
            if (d.lastSeen <= 0L) "never seen" else "seen ${relativeSeen(d.lastSeen, nowSec)}"
    }
    return listOf(presence, deviceDescriptor(d)).filter { it.isNotEmpty() }.joinToString(" · ")
}

/**
 * 🌙 May a panel spend a relay round-trip on this device — and what does it say
 * when it may not?
 *
 * The worker's own definition of a dial-in device answers it. `PULL_KINDS`
 * (worker/src/devices.ts) is documented as the kinds that "hold a
 * `tind_` token, heartbeat, poll the relay" — one loop, both jobs. A device
 * outside the 60s `PRESENCE_WINDOW_S` is therefore not reading the relay either,
 * so an invoke posted to it can only wait out the caller's own poll budget.
 *
 * [RelayCameraPanel] did exactly that, automatically, on every appearance: open
 * My devices with a necklace asleep in a drawer and the sheet spent a POST plus
 * sixteen polls on it before painting the silence in orange, under a ⚠, above a
 * row that already read "seen 3 days ago". The camera was awake. The board was
 * gone — and the one element large enough to notice blamed the hardware that was
 * working.
 *
 * ⚠️ RELAY only. An endpoint device (robot, printer) polls nothing — tiny dials
 * OUT to its own HTTPS API — and its presence is UNKNOWN BY CONSTRUCTION, since
 * the worker sends `online: null` for it. Gate [EndpointPanel] on this and every
 * healthy printer on the sheet goes dark. Pinned by a negative test.
 *
 * iOS `RelayReach` (Panels.swift:1999). One difference worth naming: iOS shares
 * this rule with a second caller, `FlipperDevicePanel`, which had invented it
 * first (`hostPresence != .online`) — Android has no Flipper panel, so this is
 * one caller and one rule, extracted anyway because the two halves below must
 * not be able to disagree.
 */
/**
 * 🔴 Why a list sheet is empty, in words that name ONE cause — and, on Android,
 * whether it is even entitled to say "empty". iOS `LoadFailure` (Api.swift:55)
 * ported, plus the arm iOS cannot have.
 *
 * Six sheets load a list over the relay and must keep "it failed" distinct from
 * "there is nothing": My Devices, Jobs, Memory (universe), the memory graph,
 * Activity and Messages (threads + one thread). Every one of them already carries
 * a comment swearing it does exactly that — "keep DISTINCT from a clean empty so
 * we don't render 'no messages yet' on an outage", "so we don't lie 'no jobs'".
 *
 * ⚠️ And on one input all six broke that promise, silently. `executeJson` parses
 * with `runCatching { JSONObject(text) }.getOrElse { JSONObject() }` and stamps
 * `_status` **only on a non-2xx**, so a 200 carrying bytes that are not JSON
 * becomes an **empty JSONObject with no status at all**: `res != null`, `status`
 * reads 0, the failure guard passes, `optJSONArray("devices")` is null, and the
 * sheet paints a confident "No devices yet" over a fleet that exists. A
 * mid-redeploy HTML error page served with a 200 is the everyday way that
 * happens, and it is invisible from the guard these six sites actually use.
 *
 * iOS reaches the same case by a different road — `JSONSerialization` THROWS, so
 * `LoadFailure` catches an NSCocoaError and its comment notes "bytes DID arrive
 * and weren't JSON". Android's parse cannot throw, having already been defused,
 * so the check has to be positive: a 2xx must CONTAIN the shape it promised. That
 * is [loadedOk], the arm with no iOS counterpart.
 *
 * The wording is delegated, never rewritten: [friendlyHttpError] for a real HTTP
 * status (the same table iOS's `httpMessage` is a copy of), and one house line
 * for status 0, which Android's table has **no arm for** — it would answer a
 * dropped connection with "request failed (HTTP 0)", a bare code naming a status
 * that never existed. Byte-shared with [RevokeFailure.statusLine]'s 0 case.
 *
 * ⚠️⚠️ **But [friendlyHttpError] is the CHAT table, and c49 wired all eight content
 * loads straight into it** — the defect iOS fixed at `d71b1ff3`, reached here by my
 * own rule. That table words 404 as "that tiny doesn't exist" and 402 as "this tiny
 * charges per message". [RevokeFailure] two cycles earlier refused the same table in
 * so many words ("two of that table's entries would actively lie here"), and then
 * this object handed every list sheet to it.
 *
 * It is REACHABLE, not theoretical, and the chain is worth keeping written down:
 * the worker answers `404 {error:"peer not found"}` for a peer it can't resolve
 * (`worker/src/messages.ts:300`), and `/api/messages` forwards the
 * worker's status **verbatim** (`route.ts:34` — `new Response(await res.text(),
 * { status: res.status })`, as do `/api/jobs:21` and `/api/graph:31`). So opening a
 * thread with a peer the worker no longer resolves says "that tiny doesn't exist"
 * about a person whose conversation is on screen.
 *
 * ⚠️ And Android threw away the answer that was RIGHT THERE. `executeJson` keeps the
 * server's body (`TinyApi.kt:429`), so `{error:"peer not found"}` arrived and
 * [message] read only the number. iOS's `httpMessage` has always preferred the
 * server's own words; Android's table-only path is a second gap on the same line —
 * see [contentMessage].
 */
internal object LoadFailure {
    /**
     * A 2xx that actually carried what it promised.
     *
     * `key` is the array the sheet reads. Absent means the body was not this
     * route's 200 — either not JSON at all (see above) or an error shape — and
     * BOTH are failures, not emptiness. An empty array present IS a real empty.
     *
     * ⚠️ `has`, not `optJSONArray() != null`: a key present but null/wrong-typed is
     * still a body this sheet cannot read, and reporting it as a failed load is the
     * cautious answer. `alt` is for Memory, whose route has answered under two
     * names (`learnings` / `memories`).
     */
    fun loadedOk(res: JSONObject?, key: String, alt: String? = null): Boolean {
        if (res == null) return false
        if (status(res) != 200) return false
        return res.has(key) || (alt != null && res.has(alt))
    }

    /**
     * The body of a load that succeeded, or null — in which case [message] says why.
     *
     * A separate return rather than a smart-cast on the caller's own `res`, because
     * "the response" and "a body this sheet may read" are different things and only
     * one of them is safe to pull an array out of. A caller that reads the validated
     * value cannot accidentally parse an unchecked one.
     */
    fun loaded(res: JSONObject?, key: String, alt: String? = null): JSONObject? =
        if (loadedOk(res, key, alt)) res else null

    /**
     * The HTTP status a response represents, or 0 for "nothing usable arrived".
     *
     * Same derivation as [RevokeFailure.statusOf] and for the same reason: a
     * SUCCESS carries no `_status`, so the absent case must read as a 2xx, not as
     * the house code for a dead connection.
     */
    fun status(res: JSONObject?): Int = if (res == null) 0 else res.optInt("_status", 200)

    /** The house line for a request nothing answered — the arm the table lacks. */
    const val noResponse = "no response — check your connection"

    /**
     * A 2xx whose body this sheet cannot use.
     *
     * The status is fine and the content is not, so neither half of the usual answer
     * fits: [friendlyHttpError] has only the number (here 200 — the one status that
     * must never appear under a retry button), and [noResponse] would blame a
     * connection that plainly worked, since the bytes arrived.
     *
     * Two callers reach it by a route the shape check cannot see: Activity's 200
     * with `ok:false` and the graph's 200 with an `error` string. Both are the
     * server saying "not this time" inside a well-formed body, and both used to
     * invent their own sentence for it.
     */
    fun unusableBody(what: String): String =
        "couldn't read $what — the server answered, but not with $what"

    /**
     * The caption under the retry button, for a load that did not happen.
     *
     * null when the load succeeded, so a caller cannot show a failure and a list
     * at the same time. `what` names the sheet's own subject for the one case the
     * status table cannot describe: a 2xx whose body was unusable, where the
     * status is fine and the content is not.
     */
    fun message(res: JSONObject?, key: String, what: String, alt: String? = null): String? {
        if (loadedOk(res, key, alt)) return null
        val status = status(res)
        if (status == 0) return noResponse
        if (status >= 400) return technology.tiny.app.net.friendlyHttpError(status)
        return unusableBody(what)
    }

    /**
     * The statuses whose meaning the CLIENT knows better than any server body —
     * iOS `Api.statusOwnsTheMessage` ported byte-for-byte in intent.
     *
     * 401: the server says "login required"; only the app knows the remedy is the
     * account menu. 0: nothing answered, so there is no body to prefer. 5xx: the
     * server is broken, so its own words about being broken are not the useful part.
     *
     * Every OTHER status yields to the server, which is describing THIS request
     * while the table can only describe the number. 400 is the clearest case — the
     * table's best is literally "request failed (HTTP 400)".
     */
    fun statusOwnsTheMessage(status: Int): Boolean =
        status == 401 || status == 0 || status in 500..599

    /**
     * The caption for a failed load of CONTENT — a list someone asked to SEE, which
     * is every caller of [message]. iOS `Api.contentMessage` (`d71b1ff3`) ported,
     * plus the server-message preference Android was missing.
     *
     * ⚠️ Three rungs, in this order, and each is load-bearing:
     *
     *  1. A status that OWNS its meaning keeps the table (401, 0, 5xx) — and 424,
     *     whose "backend unavailable" describes the TRANSPORT, not a tiny. These are
     *     the arms of [friendlyHttpError] that are true anywhere.
     *  2. Otherwise the SERVER's own `error` string wins, with the code kept so a
     *     support conversation still has it. This is the rung Android never had:
     *     `{error:"peer not found"}` is far better than anything the app can invent,
     *     and it was being discarded in favour of "that tiny doesn't exist".
     *  3. Only if there is no body to prefer does it fall back — and then to a
     *     cause-free line with the code, NOT the chat table. That is the worker's
     *     router-level bare `404 Not Found.` reached by a stale build: the app knows
     *     the load failed and the number, and nothing else it can back up.
     */
    fun contentMessage(res: JSONObject?, key: String, what: String, alt: String? = null): String? {
        // Delegated, not re-derived: [message] already owns "did this load happen",
        // status 0, and the unusable-2xx sentence. Only the rung where the CHAT table
        // starts lying is overridden, so the two rules cannot drift on the rest.
        val base = message(res, key, what, alt) ?: return null
        val status = status(res)
        if (status < 400 || statusOwnsTheMessage(status) || status == 424) return base
        val server = res?.optString("error")?.trim().orEmpty()
        if (server.isNotEmpty()) return "$server (HTTP $status)"
        return "couldn't load $what — try again (HTTP $status)"
    }
}

/**
 * 🔴 What to say when a revoke did NOT happen. iOS `RevokeFailure`
 * (Panels.swift:3642) and web `lib/devices/revoke-message.ts` ported.
 *
 * Revoke is this sheet's one destructive action, and it was the request that told
 * the reader the least. Android took `status < 400`, threw the body away, and
 * handed the code to `friendlyHttpError` — **the CHAT table**. That is the real
 * defect here, and it is worse than a vague sentence: that table words 404 as "that
 * tiny doesn't exist" and 402 as "this tiny charges per message", so a failed
 * revoke could answer a question nobody asked, about a thing that is not a tiny. On
 * anything else it fell back to "couldn't revoke device" — one sentence for a
 * rejected session, a malformed request, a worker that refused, and a dropped
 * connection alike, two of which no amount of retrying fixes.
 *
 * And neither half said the fact that matters. **A revoke that fails leaves the
 * device's token working.** Someone revoking a laptop they have just lost needs
 * exactly that; "couldn't revoke — try again" implies the opposite, that nothing has
 * been decided yet.
 *
 * ⚠️ [statusOf] exists because `_status` is stamped by `executeJson` **only on a
 * non-2xx response**, so a SUCCESSFUL revoke arrives with no status at all and
 * `optInt("_status", 0)` reads 0 — the code for "nothing answered". The old call
 * site got away with it by testing `status < 400`, which 0 satisfies; anything that
 * maps 0 to a sentence would have announced a lost connection on every success. So
 * the rule derives the status itself rather than trusting a caller to remember.
 */
internal object RevokeFailure {
    /** The outcome clause, before any reason. Byte-identical on iOS and web (pinned). */
    const val lead = "Not revoked — its token still works."

    /**
     * The status a response actually represents.
     *
     * null response = the request threw, so nothing answered: 0, the house code for
     * that. A response with no `_status` is a 2xx by construction (see above).
     */
    fun statusOf(res: JSONObject?): Int = when {
        res == null -> 0
        else -> res.optInt("_status", 200)
    }

    /**
     * Status → a reason a person can act on, for exactly the codes
     * `DELETE /api/devices` produces — 0, 400, 401, 424, 503 and other 5xx — and
     * deliberately NOT the rest of [friendlyHttpError]'s table. A line this route
     * cannot return is a line nobody can check, and two of that table's entries
     * would actively lie here.
     *
     * 401, 0 and 5xx are the cases where the client knows something the server
     * cannot phrase, so they keep their own words. Everything else yields to the
     * server, which is describing THIS request — with the code kept, so a support
     * conversation still has it.
     */
    fun statusLine(status: Int, serverMessage: String? = null): String {
        if (status == 0) return "no response — check your connection"
        if (status == 401) return "session expired — sign out and back in from the menu (HTTP 401)"
        if (status in 500..599) return "server hiccup (HTTP $status) — usually passes, try again"
        val msg = serverMessage?.trim().orEmpty()
        return if (msg.isNotEmpty()) "$msg (HTTP $status)" else "HTTP $status"
    }

    /**
     * null when the token really is dead; the sheet's red line when it isn't.
     *
     * ⚠️ Success requires the route's own `ok` flag AND a 2xx. A 200 whose body says
     * otherwise is not a revoke, and this sheet is the wrong place to assume the two
     * always agree — the route's own comment says a false success "would hide a
     * still-live device token from the user", and the row is dropped optimistically
     * on the strength of this answer.
     */
    fun message(res: JSONObject?): String? {
        val status = statusOf(res)
        if (status in 200..299 && res?.optBoolean("ok") == true) return null
        return lead + " " + statusLine(status, res?.optString("error")?.takeIf { it.isNotEmpty() })
    }
}

/**
 * 🕒 When a reading kept on screen was actually taken. iOS `ReadingAge`
 * (Panels.swift:2226) ported.
 *
 * Every panel on this sheet that fetches something over the relay then KEEPS
 * showing it — a stale frame is worth more than a blank rectangle. Which makes the
 * moment part of the reading: without it, a chamber view taken while the necklace
 * was awake reads identically twenty minutes after the board went in a drawer.
 *
 * Two things the inline `SimpleDateFormat("HH:mm:ss", Locale.US)` this replaces got
 * wrong, both invisible on the phone that wrote it:
 *
 *   1. `Locale.US` hard-codes a 24-hour clock, so a phone set to 12-hour time was
 *      told `20:35:12` while the same frame on iOS read `8:35:12 PM`. The clock
 *      belongs to the device, not to the source file.
 *   2. It can never name the DAY. A sheet left open overnight comes back holding
 *      last night's frame stamped `03:14:07`, which reads as this morning.
 *
 * An elapsed age ("4m ago") is deliberately not an option: nothing re-renders these
 * panels once the polling stops, so a relative line rots in place at whatever it
 * said when the last frame landed — the exact failure mode the badge above it has.
 */
internal object ReadingAge {
    /**
     * null ⇒ nothing has been read yet, so there is no line to draw. Callers gate
     * on this rather than on their own state: an age with no reading under it dates
     * nothing.
     */
    fun asOf(millis: Long?, now: Long = System.currentTimeMillis()): String? {
        if (millis == null) return null
        val cal = java.util.Calendar.getInstance()
        cal.timeInMillis = millis
        val nowCal = java.util.Calendar.getInstance()
        nowCal.timeInMillis = now
        val today = cal.get(java.util.Calendar.YEAR) == nowCal.get(java.util.Calendar.YEAR) &&
            cal.get(java.util.Calendar.DAY_OF_YEAR) == nowCal.get(java.util.Calendar.DAY_OF_YEAR)
        // ⚠️ An INSTANCE format, not a pattern. A hand-written "h:mm:ss a" would be
        // the same defect wearing the other shoe — forcing a 12-hour clock on a
        // phone set to 24 — because a pattern decides the convention itself and only
        // a locale's own format asks. `MEDIUM` is the one that carries seconds,
        // which are load-bearing here: a 2s camera poll is finer-grained than a
        // minute, so `HH:mm` cannot show a frame going stale at all.
        val fmt =
            if (today) {
                java.text.DateFormat.getTimeInstance(
                    java.text.DateFormat.MEDIUM, java.util.Locale.getDefault(),
                )
            } else {
                java.text.DateFormat.getDateTimeInstance(
                    java.text.DateFormat.MEDIUM, java.text.DateFormat.MEDIUM,
                    java.util.Locale.getDefault(),
                )
            }
        return "as of " + fmt.format(java.util.Date(millis))
    }
}

internal object RelayReach {
    /** The one rule, so a second relay panel can only ever ask, never re-invent. */
    fun canReach(presence: DevicePresence): Boolean = presence == DevicePresence.ONLINE

    /**
     * null = go ahead and fetch. Non-null = the line to show INSTEAD of fetching.
     *
     * One function for both halves on purpose: a panel cannot end up showing this
     * sentence and still making the call, or making the call and having nothing
     * to say about why no frame is coming.
     *
     * It names the device rather than saying "it", because a panel is its own
     * block and "it" has no antecedent inside one. And it is not a failure: the
     * board is asleep, which is a thing boards do.
     */
    fun cameraNote(deviceName: String, presence: DevicePresence): String? =
        if (canReach(presence)) null
        else "$deviceName isn't online — its camera answers once it's back."
}

/**
 * 📷 Who asked for the peek that failed — and therefore how loudly the camera
 * panel is allowed to report it. iOS `PeekShape` (Panels.swift:2257) ported.
 *
 * [RelayCameraPanel] fetches a frame the moment the sheet opens, for an online
 * necklace, on purpose. When THAT fetch failed the panel wore the chrome this app
 * reserves for "what you just did didn't work": TinyWarn, a ⚠, and a control
 * labelled **retry** — a word naming the repetition of something the user had not
 * done. Open My devices with two online Vision necklaces whose cameras don't
 * answer and the sheet raised two alarms for two requests nobody made, each one
 * louder than the device's own name beside it. Meanwhile the idle copy still read
 * "tap to peek", advertising a gesture already performed on the user's behalf.
 *
 * The panel states the rule one branch up, for a board asleep in a drawer:
 * "Deliberately NOT the failure shape: nothing failed." The automatic fetch is
 * the single path that escaped it. So the reason still shows in every state — a
 * swallowed failure is the bug this panel exists to prevent — and only the VOLUME
 * follows who asked.
 *
 * ONE total decision instead of three conditions inside the `Column`: the shapes
 * are mutually exclusive, and asking one rule is what stops the chrome drifting
 * away from the provenance, which is exactly how the alarm ended up on a request
 * the user never made.
 */
internal sealed interface PeekShape {
    /** A fetch is in flight. Outranks a stale reason — the spinner is the news. */
    object Working : PeekShape

    /** Nothing tried yet, nothing to report. */
    object Idle : PeekShape

    /**
     * It failed, but nobody asked: the reason, in the grey one-line shape every
     * other non-frame state on this sheet already wears.
     */
    data class Quiet(val why: String) : PeekShape

    /** It failed after the user asked for it: the card, the ⚠, the retry. */
    data class Alarm(val why: String) : PeekShape

    /**
     * The reason the grey line prints, or null when it has nothing to say.
     * [Alarm]'s reason belongs to the card, so it is not a line.
     */
    val quietReason: String? get() = (this as? Quiet)?.why

    /**
     * What TalkBack reads for the grey line — which merges its descendants, so
     * this REPLACES the text inside it. A reason left out of here is a reason a
     * TalkBack user never hears, the same way a device row lost its presence
     * before `deviceSubtitle` spoke it.
     */
    val spoken: String get() = when (this) {
        Working -> "asking the camera for a frame"
        Idle -> "peek at the camera"
        is Quiet -> why
        // The card speaks through its own children and never reads this, but
        // returning the reason keeps it honest if it ever does.
        is Alarm -> why
    }

    /**
     * The affordance, for the one state whose words are the board's own and so
     * can't carry it. Compose's `onClickLabel` — TalkBack's "double-tap to …" —
     * is Android's slot for this, and it is deliberately NOT glued onto the
     * reason: two of [technology.tiny.app.fleet.FrameFailure]'s five messages are
     * pass-through strings from the server or the board ("camera busy"), so there
     * is no punctuation to join against. That is the same trap that made
     * "Couldn't reach the relay. · tap to retry" wrong.
     *
     * Null in the other three states, matching iOS: [Idle]'s own label already
     * says the affordance, and repeating it would have TalkBack say "peek at the
     * camera, double-tap to peek at the camera".
     */
    val spokenHint: String? get() = if (this is Quiet) "fetch a frame" else null

    companion object {
        fun of(error: String?, busy: Boolean, asked: Boolean): PeekShape {
            if (busy) return Working
            // An empty message is `FrameFailure.Cancelled` — the panel left the
            // screen. `refresh` already nulls it; a blank alarm is what this
            // catches if that ever stops being true.
            if (error.isNullOrEmpty()) return Idle
            return if (asked) Alarm(error) else Quiet(error)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesSheet(app: TinyApp, onDismiss: () -> Unit) {
    var devices by remember { mutableStateOf<List<DeviceRow>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val relayLog by app.fleet.relayLog.collectAsState()
    // Device pending a revoke-confirm. Revoking kills that device's token instantly
    // (web app/devices:155 gates it behind a danger confirm). THIS phone is never
    // offered a revoke button — revoking self would kill the app's own auth.
    var pendingRevoke by remember { mutableStateOf<DeviceRow?>(null) }
    var revokeError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reloadKey) {
        loadError = null
        devices = null
        // 🛰 Screenshot harness (debug builds only) — see FleetHarness for why the fleet
        // can't be seeded like the chat shots, and for the two things a fixed dataset
        // gets wrong here that GraphHarness doesn't have to worry about.
        //
        // ⚠️ Returns BEFORE the fetch, unlike what a "substitute after the error branch"
        // reading of GraphHarness would suggest — and that IS the cautious order here.
        // The fleet request is authenticated with the user's own session, so letting it
        // fly during a capture would heartbeat/enumerate the real fleet for a screenshot
        // that discards the answer. GraphHarness returns early for the same reason
        // ("Returns BEFORE the fetch so no request is made", MemoryGraph.kt:89).
        //
        // The property that actually matters — a harness must never mask a real load
        // failure — is preserved by the DEBUG gate, not by the ordering: there is no
        // release build in which this line can run at all.
        if (FleetHarness.enabled(technology.tiny.app.BuildConfig.DEBUG, app.fleetHarness)) {
            devices = FleetHarness.rows(app.auth.deviceId, System.currentTimeMillis() / 1000)
            return@LaunchedEffect
        }
        val res = runCatching { app.api.getJson("/api/devices") }.getOrNull()
        // ONE rule decides, and it decides by the SHAPE that arrived, not just the
        // status: a 200 that wasn't JSON parses to an empty object with no `_status`
        // at all, which the old `status >= 400` guard waved through — and then
        // `optJSONArray("devices")` was null and the sheet said "No devices yet"
        // about a fleet that exists.
        val body = LoadFailure.loaded(res, "devices")
        if (body == null) {
            loadError = LoadFailure.contentMessage(res, "devices", "your devices")
            return@LaunchedEffect
        }
        val arr = body.optJSONArray("devices")
        devices = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
            arr?.optJSONObject(i)?.let { d ->
                DeviceRow(
                    id = d.optString("id"),
                    name = d.optString("name"),
                    kind = d.optString("kind"),
                    // ⚠️ `online` is a THREE-state field: an endpoint device never
                    // heartbeats, so the worker sends null (unknown from here)
                    // rather than a false "offline". `optBoolean` collapsed that
                    // to false and a healthy printer read "endpoint · seen never"
                    // under a grey dot — so the null is CARRIED now, and only the
                    // row decides how to say "I can't tell from here".
                    //
                    // isNull, not optBoolean: JSONObject.NULL is a sentinel
                    // OBJECT, so `optBoolean` can't distinguish absent-or-null
                    // from a real false. An older worker that omits the field
                    // entirely also lands here, which is right — absent is
                    // unknown too.
                    online = if (d.isNull("online")) null else d.optBoolean("online"),
                    lastSeen = d.optLong("last_seen"),
                    // Sorted so the chips don't reshuffle on every refresh — the
                    // server's order is whatever the daemon happened to declare.
                    //
                    // By the LABEL, because that is the only order anyone can
                    // see. Sorting the tokens would put the necklace's strip in
                    // ble/camera/imu/mic/tof/wifi order, which reaches the screen
                    // as "bluetooth camera motion mic distance Wi-Fi" —
                    // alphabetical by a key the user is never shown, and so
                    // indistinguishable from unsorted. Ties fall back to the
                    // token to keep the order total and stable (iOS e39e5f69).
                    capabilities = sortCapabilities(parseCapabilities(d.optString("capabilities"))),
                    platform = d.optString("platform"),
                    // The worker sends this for endpoint kinds only, on purpose,
                    // and this decoder dropped it — so the one device class with
                    // nothing else to say about itself said nothing.
                    url = d.optString("url"),
                )
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        // One clock (unix seconds) for every row's "seen <relative>" line, taken at
        // composition — the sheet lives seconds and web/iOS recompute per render too.
        val nowSec = remember { System.currentTimeMillis() / 1000 }
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                SheetTitle(Icons.Outlined.Devices, "fleet")
                Spacer(Modifier.height(12.dp))
            }
            loadError?.let {
                item {
                    Column {
                        Text(it, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { reloadKey++ }, contentPadding = PaddingValues(0.dp)) {
                            Text("retry", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
            if (devices == null && loadError == null) item { SheetLoading() }
            if (devices?.isEmpty() == true) item {
                SheetEmpty(Icons.Outlined.Devices, "no devices yet", "sign in on a laptop or phone and it joins your fleet")
            }
            revokeError?.let {
                item { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
            }
            items(devices.orEmpty()) { d ->
                val isSelf = d.id == app.auth.deviceId
                Column(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        PresenceDot(d.presence)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                d.name + if (isSelf) "  (this phone)" else "",
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (isSelf) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            )
                            Text(presenceLine(d, nowSec), style = MaterialTheme.typography.labelSmall, color = TinyGray)
                            // 💎 What the hardware can capture (iOS capabilityLine,
                            // Panels.swift:1859) — a FlowRow so a laptop daemon's long
                            // list WRAPS instead of running off the row, capped by
                            // CapabilityRibbon so it wraps at most twice.
                            if (d.capabilities.isNotEmpty()) {
                                // Keyed by device id, not a bare `remember`: `items()`
                                // reuses composition slots, so an unkeyed flag would
                                // hand a ribbon opened on one row to whatever device
                                // lands in that slot after the next poll.
                                var showAll by remember(d.id) { mutableStateOf(false) }
                                val ribbon = CapabilityRibbon.split(d.capabilities, showAll)
                                @OptIn(ExperimentalLayoutApi::class)
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    ribbon.shown.forEach { c ->
                                        val label = capabilityLabel(c)
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            capabilityIcon(c)?.let {
                                                // The label, not the token: TalkBack read
                                                // "bluetooth underscore scan" here.
                                                Icon(it, contentDescription = label, tint = TinyGray, modifier = Modifier.size(10.dp))
                                                Spacer(Modifier.width(2.dp))
                                            }
                                            Text(label, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                                        }
                                    }
                                    // Last, so it reads as the end of the strip rather
                                    // than as a capability in it.
                                    CapabilityRibbon.toggleLabel(d.capabilities, showAll)?.let { more ->
                                        Text(
                                            more,
                                            style = MaterialTheme.typography.labelSmall,
                                            // Accent where a capability is grey: the one
                                            // word in the strip that DOES something has
                                            // to look unlike the ones that only say
                                            // something.
                                            color = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier
                                                .clickable(
                                                    onClickLabel = CapabilityRibbon.toggleAction(showAll),
                                                    role = androidx.compose.ui.semantics.Role.Button,
                                                ) { showAll = !showAll }
                                                // "+8 more" is a count, and a count is
                                                // not what a spoken row is missing —
                                                // TalkBack reads the eight instead.
                                                .semantics {
                                                    CapabilityRibbon.toggleDescription(d.capabilities, showAll)
                                                        ?.let { contentDescription = it }
                                                },
                                        )
                                    }
                                }
                            }
                        }
                        // No revoke for this phone — killing our own token would sign the app
                        // out from under itself (web hides the button on the current device too).
                        if (!isSelf) {
                            TextButton(onClick = { revokeError = null; pendingRevoke = d }) {
                                Text("revoke", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    // 🤖 A robot's chamber camera + telemetry, always visible (web
                    // parity). Gated on the kind so a fleet of phones polls nothing.
                    if (d.isEndpoint) {
                        EndpointPanel(app, d.id, d.name, d.capabilities)
                    }
                    // 💎 The necklace's camera — EndpointPanel's sibling for PULL
                    // devices: frames arrive via a relay `frame` invoke, not the
                    // endpoint proxy (iOS RelayCameraPanel).
                    if (d.platform == "nicla-vision" && d.capabilities.contains("camera")) {
                        RelayCameraPanel(app, d.id, d.name, d.presence)
                    }
                    // 🎙️ The Voice necklace has no camera and no WiFi — its panel
                    // reports the BLE link this phone holds for it, which IS its
                    // connection (iOS VoiceDevicePanel).
                    if (d.platform == "nicla-voice") {
                        VoiceDevicePanel(app, d.id)
                    }
                }
            }
            if (relayLog.isNotEmpty()) {
                item {
                    Spacer(Modifier.height(16.dp))
                    Text("relay activity", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(8.dp))
                }
                items(relayLog.reversed()) { e ->
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Text("→ ${e.prompt}", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        Text("← ${e.result.take(200)}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }

    pendingRevoke?.let { d ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text("Revoke device?") },
            text = { Text("“${d.name}” — its token stops working immediately.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingRevoke = null
                    scope.launch {
                        val res = runCatching {
                            app.api.deleteJson("/api/devices", JSONObject().put("deviceId", d.id))
                        }.getOrNull()
                        // ONE rule decides, and it decides both halves: a null here
                        // is a revoke that happened, so the two can never disagree
                        // about whether the token is dead. The old call site tested
                        // `status < 400` and defaulted `ok` to TRUE, which made a 2xx
                        // body that said otherwise read as a success — the one
                        // outcome the route's own comment says must not be invented.
                        val failure = RevokeFailure.message(res)
                        if (failure == null) {
                            // Drop it locally so the row disappears without a full reload race.
                            devices = devices?.filterNot { it.id == d.id }
                        } else {
                            revokeError = failure
                        }
                    }
                }) { Text("revoke", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingRevoke = null }) { Text("cancel", color = TinyGray) } },
        )
    }
}

/**
 * A pull-device camera panel: shows the freshest frame the relay can fetch,
 * with tap-to-refresh. ~4-15s per frame (cloud round-trip) — this is the
 * "check on it" view; the 💎 toolbar button is the live one. iOS
 * RelayCameraPanel (Panels.swift:1671) parity.
 */
@Composable
internal fun RelayCameraPanel(
    app: TinyApp,
    deviceId: String,
    // Travel with the id for the reason [RelayReach] explains: the panel has to
    // know whether a relay call can land BEFORE it spends the poll budget finding
    // out, and then reports the silence as a camera problem.
    deviceName: String,
    presence: DevicePresence,
) {
    var frame by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var busy by remember { mutableStateOf(false) }
    var stamp by remember { mutableStateOf<Long?>(null) }
    // Why the last peek came back empty. Before this existed, five different
    // failures — a refused relay, a nineteen-second silence, a board answering
    // "no camera", an unreachable URL, undecodable bytes — all rendered as the
    // untouched "tap to peek" placeholder, which is also exactly what a user who
    // had never tapped saw. You could not tell a broken camera from an idle one.
    var error by remember { mutableStateOf<String?>(null) }
    // Whether the peek on screen was ASKED FOR. Written inside refresh, beside the
    // call it describes, so the answer can't drift from what happened. See
    // [PeekShape]: this decides the CHROME of a failure, never whether the call is
    // made. Spelled `askedFor` only because a Kotlin local function has no `self.`
    // to disambiguate its own parameter with.
    var askedFor by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Read once, rendered once: what the non-frame area is allowed to look like.
    val peek = PeekShape.of(error = error, busy = busy, asked = askedFor)

    // `asked` records PROVENANCE and nothing else: the call happens either way, so
    // a tap can never become a silent no-op.
    fun refresh(asked: Boolean) {
        if (busy) return
        // Recorded before the async work, so the shape can't be read off a
        // previous peek while this one is in flight.
        askedFor = asked
        busy = true
        error = null
        scope.launch {
            when (val r = technology.tiny.app.fleet.TinyLive.frameResult(app.api, deviceId)) {
                is technology.tiny.app.fleet.FrameResult.Success -> {
                    frame = r.bitmap
                    stamp = System.currentTimeMillis()
                }
                // A stale frame is worth more than a blank rectangle, so keep
                // whatever is already on screen and report the reason beneath.
                is technology.tiny.app.fleet.FrameResult.Failure ->
                    error = r.why.message.takeIf { it.isNotEmpty() }
            }
            busy = false
        }
    }

    // Non-null ⇒ don't call, say this. Read twice — once to decide, once to
    // render — from ONE function, so the sentence and the silence agree.
    val unreachable = RelayReach.cameraNote(deviceName, presence)

    // Gated where the fetch is AUTOMATIC, not inside refresh(): a tap is the user
    // overriding our guess about their own hardware, and this app's answer to that
    // is retry, never a silent no-op. The unreachable branch below draws no tap
    // target, so the two cannot collide.
    //
    // `asked = false` is the ONLY false in this panel, and it is what lets a
    // failure from this line stay quiet — see [PeekShape].
    LaunchedEffect(deviceId, unreachable == null) { if (unreachable == null) refresh(asked = false) }

    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 6.dp)) {
        val bmp = frame
        if (bmp != null) {
            Box(
                Modifier.fillMaxWidth().height(130.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color.Black.copy(alpha = 0.8f))
                    // A frame is the one element here worth acting on, so it
                    // carries the role rather than a bare tap listener — the
                    // Image's contentDescription alone announced no affordance.
                    .clickable(
                        onClickLabel = "fetch a new frame",
                        role = androidx.compose.ui.semantics.Role.Button,
                    ) { refresh(asked = true) },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bmp.asImageBitmap(), contentDescription = "latest camera frame",
                    modifier = Modifier.fillMaxWidth().height(130.dp),
                    contentScale = ContentScale.Crop,
                )
                if (busy) {
                    CircularProgressIndicator(
                        Modifier.align(Alignment.TopEnd).padding(6.dp).size(14.dp),
                        strokeWidth = 2.dp, color = Color.White,
                    )
                }
            }
        } else {
            // 130dp of black is what a FRAME looks like. Every other state used
            // to wear it too, so on the devices sheet the loudest, largest
            // element on the screen was a camera that had FAILED — bigger than
            // the device's own name, and repeated per necklace. A failure should
            // not occupy the footprint of a success.
            if (unreachable != null) {
                // FIRST, ahead of `error`: a reason left over from when the board
                // was awake is the very thing this fixes — a stale orange
                // "no frame" outliving the link it was measured over.
                //
                // Deliberately NOT the failure shape: no ⚠, no TinyWarn, no
                // retry. Nothing failed, the board is asleep, and there is
                // nothing here for a tap to change.
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(
                        Icons.Outlined.Bedtime,
                        // Decoration: the sentence beside it says the same thing,
                        // and a spoken "bedtime" before it would only interrupt.
                        contentDescription = null,
                        tint = TinyGray,
                        modifier = Modifier.size(13.dp).padding(top = 1.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(
                        unreachable,
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray,
                        modifier = Modifier.weight(1f),
                    )
                }
            } else if (peek is PeekShape.Alarm) {
                // The card belongs to a peek the USER asked for, and to no other.
                // The automatic fetch above fails too, and dressing THAT as an
                // alarm with a retry beside it made the sheet raise its voice
                // about something nobody had tried — see [PeekShape].
                Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Text("⚠ ", style = MaterialTheme.typography.labelSmall, color = TinyWarn)
                        // Wrapping, not clipping: the reason IS the fix here, so
                        // truncating it undoes the thing the panel exists for.
                        // It used to chain onto the retry as prose — "Couldn't
                        // reach the relay. · tap to retry" — and `·` is this
                        // app's separator for terminator-free fragments, so it
                        // landed after a full stop. Three of the five messages
                        // are whole sentences, two of them written by the server
                        // or the board rather than by us, so no amount of
                        // client-side punctuation-stripping could be right.
                        Text(
                            peek.why,
                            style = MaterialTheme.typography.labelSmall,
                            color = TinyWarn,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    // The retry gets its own line and is a real control, the way
                    // every other Android failure here offers one (ChainSheet,
                    // PayReceiptCard): as prose, TalkBack read a sentence with
                    // no action attached to it.
                    TextButton(
                        onClick = { refresh(asked = true) },
                        contentPadding = PaddingValues(0.dp),
                    ) {
                        Text(
                            "↻ retry",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            } else {
                Row(
                    Modifier.fillMaxWidth()
                        .clickable(
                            // The affordance rides the CLICK label, which is
                            // where TalkBack's "double-tap to …" comes from —
                            // and it is null in the states whose own words
                            // already say it, or TalkBack reads "peek at the
                            // camera, double-tap to peek at the camera".
                            onClickLabel = peek.spokenHint,
                            role = androidx.compose.ui.semantics.Role.Button,
                        ) { refresh(asked = true) }
                        // Merged, then LABELLED: without the label TalkBack reads
                        // the visible text, which for a failure is the board's own
                        // sentence and for the spinner is nothing at all. Same
                        // reason iOS `.combine`s and then sets accessibilityLabel.
                        .semantics(mergeDescendants = true) { contentDescription = peek.spoken }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (peek is PeekShape.Working) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = TinyGray)
                        Spacer(Modifier.width(6.dp))
                        // A frame is a full cloud round-trip through the relay,
                        // so say so — a silent spinner for 15s reads as a hang
                        // rather than as a camera waking up.
                        Text("asking the camera…", style = MaterialTheme.typography.labelSmall, color = TinyGray)
                    } else {
                        // The reason when there is one, the invitation when there
                        // isn't. Dropping the alarm must not drop the WORDS with
                        // it — a swallowed reason is the bug this panel's `error`
                        // state was added to fix.
                        Text(
                            peek.quietReason ?: "📷 tap to peek",
                            style = MaterialTheme.typography.labelSmall,
                            color = TinyGray,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth()) {
            // 🕒 The sheet's one voice for "when was this taken" — the clock is the
            // phone's, and it names the day when the frame is not from today.
            ReadingAge.asOf(stamp)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            // The placeholder above can only speak when it's on screen; a failed
            // REFRESH keeps the last good frame, so the reason needs somewhere to
            // go here too or it's swallowed all over again.
            //
            // This slot has NO iOS twin — it is where Android alone could still
            // show the bug: the necklace answered, then went to sleep, and the
            // last refresh's orange "no frame in 19s" sat under the kept frame,
            // outliving the link it was measured over. So the asleep line takes
            // this slot too, in grey, saying why the frame will not update. The
            // two are mutually exclusive by construction — the branch above owns
            // the no-frame case, this one only ever runs with a frame on screen.
            if (unreachable != null && frame != null) {
                Text(
                    " · $unreachable",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                    modifier = Modifier.weight(1f),
                )
            } else if (error != null && frame != null) {
                Text(
                    " · ${error}",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyWarn,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * 🕰️ How long the necklace has been up, in the largest unit that still says
 * something — "45s", "12m", "3h", "2d". Null when the board didn't say.
 *
 * Same ladder and the same integer-floored rounding as this file's neighbour
 * `ago()` (ActivityAgoTest pins that one), so "up 90m" reads "up 1h" here
 * exactly as a 90-minute-old event reads "1h" in the activity list. The panel
 * used to print `up ${s.uptimeS}s` straight off the wire, so a necklace worn
 * since breakfast said "up 41293s" in a line otherwise written in words.
 *
 * 0 returns null rather than "0s". `handleStatus` decodes the status JSON with
 * `optInt` — the whole notify has to fit a 64-byte BLE buffer, so an absent key
 * is expected, not exceptional — and on a wearable "up 0s" is the signature of a
 * reset loop. A board that simply never sends `up` would raise that alarm
 * forever. iOS VoiceFmt.uptime (Panels.swift).
 */
internal fun voiceUptime(seconds: Int): String? = when {
    seconds <= 0 -> null
    seconds < 60 -> "${seconds}s"
    seconds < 3_600 -> "${seconds / 60}m"
    seconds < 86_400 -> "${seconds / 3_600}h"
    else -> "${seconds / 86_400}d"
}

/**
 * 🔇 The status this phone may still SPEAK for — null once the link is down.
 *
 * Every segment of a status reading is a present-tense claim about a board
 * somewhere else, and [VoiceStatus] is a LAST-KNOWN value: NiclaVoiceGateway
 * clears `_status` in `forget()` only (line 178), never on disconnect —
 * deliberately, because a wake delivered over a link that dropped a second later
 * still has to reach the row. `onConnectionStateChange` sets `_connected = false`
 * and leaves the reading standing.
 *
 * So the panel drew "out of range" and, on the same line, a green "listening":
 * the one element written in the present tense was the one element that outlived
 * the link it depended on. A necklace in a drawer looked like a necklace on a
 * collar. The tell was already in the file — the detail line beside it
 * (`3 wake words · 12 heard · up 11h`) HAD the `connected` check and correctly
 * went away. One object, two readings, and only the live claim was ungated.
 *
 * One gate for both reads, so this panel cannot show half a stale reading. The
 * wake list below it is deliberately untouched: those are timestamped events, and
 * history stays true after the link drops. iOS VoiceFmt.live (Panels.swift:2278).
 */
internal fun liveVoiceStatus(s: VoiceStatus?, connected: Boolean): VoiceStatus? =
    if (connected) s else null

/**
 * "3 wake words · 12 heard · up 11h" — the Voice panel's one-line summary, with
 * segments joined only when they have something to say.
 *
 * The old string hard-coded both separators, so an empty segment left a "·"
 * hanging. Worse, two of the three zeroes were alarms the board never raised:
 * "up 0s" (above) and `0 wake words`, which claims the loaded net has no classes
 * — this thing can never wake — while sitting directly under a green "listening"
 * badge saying the opposite. That question already has an honest answer in
 * `VoiceStatus.listening` (ndp && mic), so the count drops rather than argue
 * with it. `wakes` is the one count that keeps its zero, because "0 heard" is
 * the expected reading rather than an alarm — but only next to a segment that
 * proves the board answered at all. iOS VoiceFmt.statusLine (Panels.swift).
 */
internal fun voiceStatusLine(s: VoiceStatus): String? {
    val parts = mutableListOf<String>()
    if (s.labels > 0) parts += "${s.labels} wake word${if (s.labels == 1) "" else "s"}"
    if (s.labels > 0 || s.wakes > 0) parts += "${s.wakes} heard"
    voiceUptime(s.uptimeS)?.let { parts += "up $it" }
    return if (parts.isEmpty()) null else parts.joinToString(" · ")
}

/**
 * 🎙️ Adopting an already-enrolled Voice — the rules, kept pure so they are
 * JVM-testable without a radio or a server (iOS VoiceDevicePanel.adopt()).
 *
 * The board this serves cannot heartbeat for itself, so a Voice enrolled from
 * ANOTHER client (a laptop, or a phone since reinstalled) sits in the fleet
 * reading offline with nothing this phone can do about it: `NiclaVoiceGateway.
 * start()` returns at `_unit.value ?: return`, and the only thing that sets
 * `_unit` is `register()`, whose one caller is BLE provisioning (Nearby.kt:248).
 * Provisioning MINTS A NEW DEVICE ROW and orphans this one — frozen last_seen,
 * wake history and transcripts stranded under the old id. So: rotate the token
 * on the row that already exists (POST /api/devices/adopt).
 */
internal object VoiceAdopt {
    /**
     * Why the scan came back without a necklace — never a bare "couldn't find
     * it", which sends the user hunting the room when the real problem is a
     * radio switch or a denied permission. [Bluetooth]'s own state strings.
     */
    fun scanFailure(state: String): String = when (state) {
        "unauthorized" -> "Bluetooth permission is denied for tiny on this phone."
        "poweredOff" -> "Bluetooth is turned off on this phone."
        "unsupported" -> "This phone has no Bluetooth adapter."
        else -> "Couldn't see the necklace nearby. Bring it closer — and if another phone is holding it, tap Release there first."
    }

    /**
     * The server's answer → the error to show, or null when it really adopted.
     *
     * A 404 is a REAL answer ("not yours, revoked, or an endpoint device") and
     * must not read as an outage: the user's next move differs. And a body with
     * no `device_token` is a failure even when it says ok — storing an empty
     * credential would install something that authenticates nothing, and the
     * break would surface later as an unexplained offline necklace instead of
     * here, where the user is looking.
     */
    fun claimFailure(reply: JSONObject?): String? {
        if (reply == null) return "Couldn't reach the server to claim the necklace. Check your connection and try again."
        if (reply.optInt("_status", 200) == 404) {
            return "That necklace isn't on your account any more. Set it up again to enroll it fresh."
        }
        if (reply.optString("device_token").isEmpty()) {
            return "Couldn't claim the necklace on the server. Check your connection and try again."
        }
        return null
    }

    /** The token to register with — only ever read after [claimFailure] cleared. */
    fun token(reply: JSONObject): String = reply.optString("device_token")
}

/**
 * 🎙️ The Nicla Voice's panel — RelayCameraPanel's counterpart for a board with
 * no camera and no internet. Everything here comes from the phone's own BLE
 * link (NiclaVoiceGateway), not from the server, because there is no
 * server-side truth to read: the board heartbeats only through this phone.
 * That is also why the link state is shown as prominently as the wake list —
 * "no wakes" means something completely different when the necklace is out of
 * range than when it's listening. iOS VoiceDevicePanel (Panels.swift:1728).
 */
@Composable
internal fun VoiceDevicePanel(app: TinyApp, deviceId: String) {
    val gw = technology.tiny.app.fleet.NiclaVoiceGateway
    val unit by gw.unit.collectAsState()
    val connected by gw.connected.collectAsState()
    val status by gw.status.collectAsState()
    val wakes by gw.wakes.collectAsState()
    val lastError by gw.lastError.collectAsState()
    var adopting by remember { mutableStateOf(false) }
    var adoptError by remember { mutableStateOf<String?>(null) }
    val recording by PhoneRecorder.isRecording.collectAsState()
    val level by PhoneRecorder.level.collectAsState()
    var recordError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Only speak for the unit this phone actually paired. A second phone (or a
    // necklace paired elsewhere) shows the row without claiming to gateway it.
    val isMine = unit?.deviceId == deviceId

    /**
     * Take over an already-enrolled Voice without re-provisioning it.
     *
     * Two things are needed to gateway a board and this phone has neither: a
     * TOKEN to heartbeat with, and the board's BLE address (which has to be
     * discovered locally — the phone has never seen this necklace).
     *
     * ORDER MATTERS. The scan comes FIRST, because rotating the token
     * immediately kills the other client's credential: doing that before
     * knowing the board is even in range would leave the necklace relayed by
     * nobody. Failing on "can't see it" costs nothing; failing after the
     * rotation costs the working link.
     *
     * Nothing is written to the BOARD. The Voice firmware never persists the
     * identity it is sent — it ACKs the payload and drops it (tiny_voice.ino:
     * cfgBuf is parsed for a terminator and never read again) — because the
     * board has no radio to use a token with. The phone speaks to the API on
     * its behalf, so the phone is the only place adoption has to land.
     */
    suspend fun adopt() {
        adopting = true
        adoptError = null
        try {
            val ble = technology.tiny.app.fleet.Bluetooth
            ble.startScan(app, durationMs = 6000)
            kotlinx.coroutines.delay(6500)
            val found = ble.devices.value.firstOrNull {
                it.tiny?.kind == technology.tiny.app.fleet.Bluetooth.TinyBeaconInfo.Kind.VOICE
            }
            if (found == null) {
                adoptError = VoiceAdopt.scanFailure(ble.state.value)
                return
            }
            val reply = runCatching {
                app.api.postJson("/api/devices/adopt", JSONObject().put("deviceId", deviceId))
            }.getOrNull()
            VoiceAdopt.claimFailure(reply)?.let { adoptError = it; return }
            // register() stores the token and starts the link. Only now does the
            // panel switch to the isMine branch, which is honest: this phone can
            // genuinely speak for the board from this point.
            gw.register(app, deviceId, VoiceAdopt.token(reply!!), found.address, found.name)
        } finally {
            adopting = false
        }
    }

    Column(
        Modifier.fillMaxWidth()
            .padding(top = 4.dp, bottom = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Gray.copy(alpha = 0.12f))
            .padding(10.dp),
    ) {
        if (!isMine) {
            // 🎙️ Not paired to THIS phone — and a Voice cannot heartbeat for
            // itself, so until some phone adopts it the row just sits in the
            // fleet reading offline. This used to say "set it up here to relay
            // it", pointing at the provisioning sheet: that mints a NEW device
            // row and orphans this one forever (frozen last_seen, wake history
            // and transcripts stranded under the old id). Adopt instead —
            // /api/devices/adopt rotates the token on the row that already
            // exists, so the id, its events and its recordings all survive.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.PhonelinkErase, contentDescription = null, tint = TinyGray, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "Paired to another phone or a computer.",
                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                )
            }
            Text(
                "Adopting moves the necklace to this phone, keeping its history. The other client stops relaying it.",
                style = MaterialTheme.typography.labelSmall, color = TinyGray,
            )
            OutlinedButton(
                onClick = { scope.launch { adopt() } },
                enabled = !adopting,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                modifier = Modifier.padding(top = 6.dp).heightIn(min = 44.dp),
            ) {
                Icon(Icons.Outlined.PhoneAndroid, contentDescription = null, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    if (adopting) "Adopting…" else "Adopt on this phone",
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            adoptError?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (connected) Icons.Outlined.PhoneAndroid else Icons.Outlined.PhonelinkErase,
                    contentDescription = null,
                    tint = if (connected) MaterialTheme.colorScheme.primary else TinyGray,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    if (connected) "relayed by this phone" else "out of range",
                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                )
                // `liveVoiceStatus`, not `status`: out of range, the last reading
                // is not news about this board — and this badge is the only
                // element here written in the present tense.
                liveVoiceStatus(status, connected)?.let { s ->
                    Spacer(Modifier.weight(1f))
                    // The one thing you cannot tell from outside: a necklace
                    // whose model failed to load still advertises and still
                    // looks online, it just never hears anything.
                    Icon(
                        if (s.listening) Icons.Outlined.GraphicEq else Icons.Outlined.MicOff,
                        contentDescription = null,
                        tint = if (s.listening) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        if (s.listening) "listening" else "not listening",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (s.listening) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary,
                    )
                }
            }
            // Already gated — through the same function now, so the badge and the
            // detail line cannot end up disagreeing about which readings this
            // phone is still entitled to show.
            liveVoiceStatus(status, connected)?.let(::voiceStatusLine)?.let { line ->
                Text(line, style = MaterialTheme.typography.labelSmall, color = TinyGray)
            }
            lastError?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            }
            if (wakes.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                wakes.take(4).forEach { w ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.GraphicEq, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("“${w.label}”", style = MaterialTheme.typography.labelSmall)
                        Spacer(Modifier.weight(1f))
                        Text(
                            java.text.SimpleDateFormat("HH:mm", java.util.Locale.US).format(java.util.Date(w.atMs)),
                            style = MaterialTheme.typography.labelSmall, color = TinyGray,
                        )
                    }
                }
            } else if (connected) {
                Text(
                    "Say the wake word — it appears here and on your tiny's activity.",
                    style = MaterialTheme.typography.labelSmall, color = TinyGray,
                )
            }

            // 🎙️ Record by hand — the phone's FIRST user-facing way in.
            //
            // Until now a take could only be started by the relay (the agent's
            // nicla_voice_record envelope) or by a wake word. So "the Nicla Voice
            // can be a really good voice recorder" was true only if an agent
            // asked for it: the user had no button, and Android has no
            // Transcripts screen to put one on either.
            //
            // ONE button, two jobs: open a take, or END the one running. It asks
            // for the recorder's full 120s ceiling rather than a fixed short
            // take, because with a Stop the window costs nothing — you end it
            // when you stop talking, and the take reports its REAL length.
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    onClick = {
                        if (recording) {
                            PhoneRecorder.stopEarly()
                        } else {
                            scope.launch {
                                // record() explains every refusal in words ("the
                                // phone's mic is already in use…"), and a Record
                                // button that silently does nothing is the worst
                                // version of that — so the reason is surfaced.
                                val take = PhoneRecorder.record(app, PhoneRecorder.MAX_SECONDS, "manual")
                                recordError = if (take.ok) null else (take.error ?: "Recording failed.")
                            }
                        }
                    },
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    modifier = Modifier.heightIn(min = 44.dp),
                ) {
                    Icon(
                        if (recording) Icons.Outlined.StopCircle else Icons.Outlined.Mic,
                        contentDescription = null,
                        tint = if (recording) MaterialTheme.colorScheme.tertiary else LocalContentColor.current,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (recording) "Stop and save" else "Record",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                if (recording) {
                    // A live input meter, because an open take with no feedback is
                    // indistinguishable from a broken one: with the mic muted or
                    // the phone face-down in a pocket, "Recording…" alone is a
                    // claim the user cannot check. The recorder already publishes
                    // `level`; nothing displayed it.
                    Spacer(Modifier.width(8.dp))
                    Row(verticalAlignment = Alignment.Bottom) {
                        repeat(10) { i ->
                            val lit = level * 10 > i
                            Box(
                                Modifier.padding(end = 2.dp)
                                    .size(width = 3.dp, height = (6 + (i % 4) * 3).dp)
                                    .background(
                                        if (lit) MaterialTheme.colorScheme.tertiary else TinyGray.copy(alpha = 0.3f),
                                        RoundedCornerShape(1.dp),
                                    ),
                            )
                        }
                    }
                }
            }
            recordError?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(app: TinyApp, onReplayTour: () -> Unit = {}, onDismiss: () -> Unit) {
    var tinyName by remember { mutableStateOf(app.config.tinyName) }
    var autoSpeak by remember { mutableStateOf(app.config.autoSpeak) }
    var quietHours by remember { mutableStateOf(app.config.quietHours) }
    var turnActivity by remember { mutableStateOf(app.config.turnActivity) }
    var alwaysOn by remember { mutableStateOf(app.config.alwaysOn) }
    var server by remember { mutableStateOf(app.config.serverOverride ?: "") }
    val online by app.fleet.online.collectAsState()
    val user by app.auth.user.collectAsState()
    val scope = rememberCoroutineScope()

    // skipPartiallyExpanded: settings is taller than half a screen, so the partial
    // detent both hides most controls and makes the first back press collapse
    // expanded→partial instead of dismissing — which left the sheet open under a
    // user who thought it was gone and typed into "default tiny" (audit #5).
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState())) {
            SheetTitle(Icons.Outlined.Settings, "settings")
            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = tinyName,
                onValueChange = { tinyName = it },
                label = { Text("default tiny") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))

            SettingSwitch(Icons.Outlined.VolumeUp, "speak replies aloud", autoSpeak) {
                autoSpeak = it; app.config.autoSpeak = it
            }
            VoicePicker(app)
            SettingSwitch(Icons.Outlined.Bedtime, "quiet hours (22:00–08:00)", quietHours) {
                quietHours = it; app.config.quietHours = it
            }
            SettingSwitch(Icons.Outlined.Bolt, "live turn status", turnActivity) {
                turnActivity = it; app.config.turnActivity = it
                if (!it) technology.tiny.app.fleet.AgentLive.cancel(app)
            }
            // 📍 Location context (web composer 📍 toggle parity). Flipping on
            // runs the runtime ask; the config flag follows the GRANT, not the
            // tap — deny leaves the switch (and every send) unchanged.
            var shareLocation by remember { mutableStateOf(app.config.locationContext) }
            val locationAsk = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestMultiplePermissions()
            ) { grants ->
                val granted = grants.values.any { it }
                shareLocation = granted
                app.config.locationContext = granted
            }
            SettingSwitch(Icons.Outlined.LocationOn, "share location with your tiny", shareLocation) { on ->
                if (on && !Geo.hasPermission(app)) {
                    locationAsk.launch(arrayOf(
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    ))
                } else {
                    shareLocation = on
                    app.config.locationContext = on
                }
            }
            SettingSwitch(Icons.Outlined.Podcasts, "keep me reachable (always-on node)", alwaysOn) {
                alwaysOn = it; app.config.alwaysOn = it
                technology.tiny.app.fleet.RelayService.sync(app)
            }
            Text(
                // Helper prose is bodySmall SANS — labelSmall is the mono metadata
                // voice, and full sentences set in it read like terminal output.
                "Runs a background service so your agent can reach this phone while it's locked. Shows a persistent notification.",
                style = MaterialTheme.typography.bodySmall,
                color = TinyGray,
            )
            Spacer(Modifier.height(16.dp))

            GlassesSection(app)
            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("server override (blank = tiny.technology)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(16.dp))

            ModelConfigSection(app)
            Spacer(Modifier.height(16.dp))

            VoiceKeySection(app)
            Spacer(Modifier.height(16.dp))

            AccountVoiceSection(app)
            Spacer(Modifier.height(16.dp))

            TextButton(
                onClick = { onReplayTour() },
                contentPadding = PaddingValues(0.dp),
            ) {
                Icon(Icons.Outlined.PlayCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("replay the tour", color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "signed in as @${user?.login ?: "?"} · fleet ",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
                StatusDot(online)
                Spacer(Modifier.width(4.dp))
                Text(
                    if (online) "online" else "offline",
                    style = MaterialTheme.typography.labelSmall,
                    color = TinyGray,
                )
            }
            Spacer(Modifier.height(16.dp))

            Row {
                Button(onClick = {
                    app.config.tinyName = tinyName.ifBlank { "tiny" }
                    app.config.serverOverride = server.trim().ifBlank { null }
                    onDismiss()
                }) { Text("save") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                    scope.launch {
                        app.config.alwaysOn = false
                        technology.tiny.app.fleet.RelayService.stop(app)
                        app.fleet.stop()
                        technology.tiny.app.fleet.DmPollWorker.cancel(app)
                        technology.tiny.app.fleet.DmNotifier.reset(app)
                        // Wipe the prior user's answer/memories/unread from the home-screen
                        // widgets — the loops that refresh them just stopped (iOS logout scrub).
                        technology.tiny.app.widget.WidgetBridge.scrubIdentity(app)
                        // The BYO-model config (api_key / voice_openai_key) is a paid
                        // secret in its OWN encrypted prefs file (tiny_model); logout()
                        // clears only tiny_auth, so without this the key survives sign-out
                        // and is prefilled/revealed to whoever signs in next on this
                        // device. Reset to the free default — same boundary as the
                        // switch-scrub in MainActivity.
                        app.modelConfig.reset()
                        // User-scoped tiny_config channels (offline send queue, composer
                        // draft, activity high-water mark) — same boundary as the switch.
                        app.config.scrubIdentity()
                        app.auth.logout()
                        onDismiss()
                    }
                }) { Text("sign out", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/**
 * 🎙 TTS voice picker (iOS Settings.swift "Voice" section parity). The engine's
 * installed voices for the user's locale (+ English), a "System default" row,
 * and a Preview button that speaks a sample in the currently-selected voice —
 * so the user hears a choice before it sticks. Voice ids are opaque engine
 * strings persisted to cfg_voice_id; Speech.applyVoice honors them at speak time.
 *
 * Voices are read lazily on expand (TextToSpeech.voices needs the engine ready;
 * the app-scoped Speech instance is initialized by the time Settings opens). If
 * the engine reports none (rare — no offline voice pack), the row collapses to a
 * hint pointing at the system voice-data download, mirroring iOS's footer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoicePicker(app: TinyApp) {
    var expanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(app.config.voiceId) }
    // The engine's voice list is stable per session — load once.
    val voices = remember { app.speech.voices() }
    val currentLabel = selected
        ?.let { id -> voices.firstOrNull { it.name == id }?.let { app.speech.voiceLabel(it) } }
        ?: "System default"

    Spacer(Modifier.height(4.dp))
    if (voices.isEmpty()) {
        Text(
            "No offline voices installed. Add them in Android Settings → System → Languages → Text-to-speech output.",
            style = MaterialTheme.typography.bodySmall,
            color = TinyGray,
        )
        return
    }

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = currentLabel,
            onValueChange = {},
            readOnly = true,
            label = { Text("spoken-reply voice (TTS)") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("System default") },
                onClick = {
                    selected = null; app.config.voiceId = null; expanded = false
                },
            )
            voices.forEach { v ->
                DropdownMenuItem(
                    text = { Text(app.speech.voiceLabel(v), style = MaterialTheme.typography.bodyMedium) },
                    onClick = {
                        selected = v.name; app.config.voiceId = v.name; expanded = false
                    },
                )
            }
        }
    }
    TextButton(
        onClick = { app.speech.preview("Hi, I'm tiny — this is how I sound.", selected) },
        contentPadding = PaddingValues(vertical = 4.dp),
    ) {
        Icon(Icons.Outlined.PlayCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("preview voice", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

/** An accent section header with a leading native glyph (was a leading emoji). */
@Composable
private fun SectionLabel(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
    }
}

/** A filled/hollow status dot — the native replacement for the 🟢/⚫ online glyph. */
/**
 * 🕶️ Meta glasses (iOS Settings 🕶 section parity): status + link/unlink +
 * the two permission launchers the DAT flow needs — BLUETOOTH_CONNECT (the
 * one Android runtime permission the SDK requires before initialize()) and
 * the glasses-camera grant, which happens INSIDE the Meta AI app via
 * Wearables.RequestPermissionContract (an Activity contract — this section
 * owns the launcher; WearablesBridge only checks).
 */
@Composable
private fun GlassesSection(app: TinyApp) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var btGranted by remember { mutableStateOf(WearablesBridge.hasBtPermission(app)) }
    var initialized by remember { mutableStateOf(WearablesBridge.ensureInitialized(app)) }
    var cameraNote by remember { mutableStateOf<String?>(null) }

    // Registration state only exists once the SDK is initialized — produceState
    // re-runs when the BT grant flips `initialized` true.
    val regState by produceState<RegistrationState?>(null, initialized) {
        if (initialized) Wearables.registrationState.collect { value = it }
    }

    val btAsk = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        btGranted = granted
        if (granted) initialized = WearablesBridge.ensureInitialized(app)
    }
    val cameraAsk = rememberLauncherForActivityResult(Wearables.RequestPermissionContract()) { result ->
        val status = result.getOrDefault(PermissionStatus.Denied)
        cameraNote = if (status == PermissionStatus.Granted) "camera access granted — your tiny can see through the glasses"
        else "camera access denied in the Meta AI app"
    }

    Text("🕶 meta glasses", style = MaterialTheme.typography.titleSmall)
    Spacer(Modifier.height(8.dp))
    when {
        !btGranted -> {
            Button(onClick = { btAsk.launch(android.Manifest.permission.BLUETOOTH_CONNECT) }, modifier = Modifier.fillMaxWidth()) {
                Text("allow bluetooth to find your glasses")
            }
        }
        regState == RegistrationState.REGISTERED -> {
            Text("linked", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { cameraAsk.launch(Permission.CAMERA) }) { Text("grant camera") }
                TextButton(onClick = { activity?.let { WearablesBridge.startUnregistration(it) } }) { Text("unlink") }
            }
        }
        regState == RegistrationState.REGISTERING -> {
            Text("linking via Meta AI…", style = MaterialTheme.typography.bodySmall, color = TinyGray)
        }
        else -> {
            Button(
                onClick = { activity?.let { WearablesBridge.startRegistration(it) } },
                enabled = activity != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("link glasses via Meta AI") }
        }
    }
    cameraNote?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.bodySmall, color = TinyGray)
    }
    Text(
        "Link your Meta AI glasses to give your tiny eyes — it can capture what you're looking at when you ask. Unlink here or in the Meta AI app any time.",
        style = MaterialTheme.typography.bodySmall,
        color = TinyGray,
    )
}

private tailrec fun android.content.Context.findActivity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * The devices sheet's presence dot — three states, not two.
 *
 * Separate from [StatusDot] rather than widening it: that one is a two-state
 * primitive used for this phone's own connection, and this row is the one place
 * in the app where "unknown" is a real answer. A hollow outline for it, because
 * an endpoint robot is neither lit nor greyed-out — the filled grey circle it
 * used to draw is what made a healthy printer look dead. iOS presenceDot.
 */
@Composable
private fun PresenceDot(presence: DevicePresence) {
    val online = presence == DevicePresence.ONLINE
    Icon(
        if (online) Icons.Filled.Circle else Icons.Outlined.RadioButtonUnchecked,
        // The dot is decoration here: presenceLine right beside it says the same
        // thing in words, and TalkBack reading "offline · reachable when called"
        // would contradict itself out loud.
        contentDescription = null,
        tint = when (presence) {
            DevicePresence.ONLINE -> MaterialTheme.colorScheme.primary
            DevicePresence.OFFLINE -> TinyGray
            DevicePresence.UNKNOWN -> TinyGray.copy(alpha = 0.55f)
        },
        modifier = Modifier.size(10.dp),
    )
}

@Composable
private fun StatusDot(online: Boolean) {
    Icon(
        if (online) Icons.Filled.Circle else Icons.Outlined.RadioButtonUnchecked,
        contentDescription = if (online) "online" else "offline",
        tint = if (online) MaterialTheme.colorScheme.primary else TinyGray,
        modifier = Modifier.size(10.dp),
    )
}

@Composable
private fun SettingSwitch(icon: ImageVector, label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = TinyGray, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = MaterialTheme.colorScheme.primary, checkedThumbColor = Color.Black),
        )
    }
}

/**
 * 🤖 BYO-model config — native port of web components/chat/ModelSettings.tsx (the
 * BYOK half; WebLLM/WebGPU on-device inference is browser-only, not ported). Pick a
 * provider + paste an API key to bypass the free tier's rate limits and use any
 * model; the config rides /api/chat as x-tiny-model-* headers. Persists to the
 * encrypted ModelConfigStore on Save, with web's guards (byok needs a key; custom
 * needs a base URL or the key would leak to OpenAI's default endpoint).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelConfigSection(app: TinyApp) {
    val store = app.modelConfig
    val scope = rememberCoroutineScope()
    var provider by remember { mutableStateOf(store.provider) }
    var apiKey by remember { mutableStateOf(store.apiKey) }
    var modelId by remember { mutableStateOf(store.modelId) }
    var baseUrl by remember { mutableStateOf(store.baseUrl) }
    var maxTokens by remember { mutableStateOf(store.maxTokens) }
    var region by remember { mutableStateOf(store.region) }
    var additionalFields by remember { mutableStateOf(store.additionalFields) }
    var showKey by remember { mutableStateOf(false) }
    var providerMenu by remember { mutableStateOf(false) }
    var regionMenu by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    // 🏅 This account's own daily allowance, off /api/me (c40). null until it
    // lands, and null forever when signed out or against a pre-c38 server — the
    // footer then quotes no number, exactly as it did before this existed.
    var standing by remember { mutableStateOf<Standing?>(null) }

    // Fresh-device hydration: a device still on the free default inherits the
    // account's synced BYOK selection (key stays server-side). Never clobbers a
    // local BYOK config. Reflect the pulled fields into the editing state.
    LaunchedEffect(Unit) {
        if (store.hydrateFromRemote(app.api)) {
            provider = store.provider; apiKey = store.apiKey; modelId = store.modelId
            baseUrl = store.baseUrl; maxTokens = store.maxTokens; region = store.region
            additionalFields = store.additionalFields
        }
        // Unlike iOS (Session.loadMe runs every launch) Android has no
        // launch-time /api/me, so the allowance has to be fetched here. Skipped
        // entirely without a token: /api/me 401s and the 401 body carries no
        // standing, so an anonymous round-trip could only ever produce the null
        // we already hold. runCatching because a footer sentence must never be
        // able to take down the settings panel.
        if (app.auth.token != null) {
            val me = runCatching { app.api.me() }.getOrNull()
            standing = Standing.parse(me?.optJSONObject("standing"))
        }
    }

    val preset = ModelConfigStore.PROVIDER_PRESETS[provider] ?: ModelConfigStore.PROVIDER_PRESETS["custom"]!!
    val byok = provider != "default"

    SectionLabel(Icons.Outlined.SmartToy, "model & API key")
    Spacer(Modifier.height(4.dp))
    Text(
        // Voice-call discoverability: the live call (📞) reads the same OpenAI
        // key set here, so surface that up front — mirrors the iOS footer.
        if (byok)
            "Bring your own provider + key — you pay them directly. Live voice calls (📞) also use this key; set an OpenAI provider + key here to enable calls."
        else
            // 🏅 …and on the free branch, the caller's OWN window rather than a
            // bare "(rate-limited)": the number is enforced in the limiter and
            // was, until c40, quoted nowhere this app can show.
            Standing.freeTierFooter(standing) +
                " Live voice calls (📞) need an OpenAI key — pick OpenAI here and paste your key to enable calls.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    // Provider dropdown
    ExposedDropdownMenuBox(expanded = providerMenu, onExpandedChange = { providerMenu = it }) {
        OutlinedTextField(
            value = ModelConfigStore.PROVIDER_PRESETS[provider]?.label ?: provider,
            onValueChange = {},
            readOnly = true,
            label = { Text("provider") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = providerMenu) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = providerMenu, onDismissRequest = { providerMenu = false }) {
            ModelConfigStore.PROVIDER_PRESETS.forEach { (key, p) ->
                DropdownMenuItem(
                    text = { Text(p.label) },
                    onClick = {
                        provider = key
                        // Adopt the preset base URL on switch (web onChange), so the
                        // custom-only free-form field starts from the right default.
                        baseUrl = p.baseUrl
                        providerMenu = false
                    },
                )
            }
        }
    }

    if (byok) {
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            label = { Text("API key") },
            placeholder = { Text(preset.keyPlaceholder, style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                if (apiKey.isNotEmpty()) {
                    TextButton(onClick = { showKey = !showKey }) {
                        Text(if (showKey) "hide" else "show", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "Stored encrypted on this device only. Sent per-request, never persisted server-side.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = modelId,
            onValueChange = { modelId = it },
            label = { Text("model") },
            placeholder = { Text(preset.modelPlaceholder, style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        if (provider == "bedrock") {
            Spacer(Modifier.height(10.dp))
            ExposedDropdownMenuBox(expanded = regionMenu, onExpandedChange = { regionMenu = it }) {
                OutlinedTextField(
                    value = region,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("region") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = regionMenu) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
                )
                ExposedDropdownMenu(expanded = regionMenu, onDismissRequest = { regionMenu = false }) {
                    ModelConfigStore.BEDROCK_REGIONS.forEach { r ->
                        DropdownMenuItem(text = { Text(r) }, onClick = { region = r; regionMenu = false })
                    }
                }
            }
        }

        // Base URL: shown for custom, or whenever a preset carries one (web condition).
        if (provider == "custom" || baseUrl.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("base URL") },
                placeholder = { Text("https://api.example.com/v1", style = MaterialTheme.typography.bodySmall) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = maxTokens,
            onValueChange = { maxTokens = it },
            label = { Text("max tokens (optional)") },
            placeholder = { Text("8192", style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = additionalFields,
            onValueChange = { additionalFields = it },
            label = { Text("additional request fields (JSON, optional)") },
            placeholder = { Text("{\"anthropic_beta\": [\"context-1m-2025-08-07\"]}", style = MaterialTheme.typography.bodySmall) },
            modifier = Modifier.fillMaxWidth(),
        )
    } else {
        Spacer(Modifier.height(6.dp))
        Text(
            "Using tiny's free model (rate-limited). Bring your own API key to bypass limits and pick any model.",
            style = MaterialTheme.typography.bodySmall, color = TinyGray,
        )
    }

    status?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = if (it.startsWith("⚠")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
    }

    Spacer(Modifier.height(10.dp))
    Row {
        Button(onClick = {
            // Web save() guards, ported: a byok provider needs a key; custom needs a
            // base URL (else the key leaks to OpenAI's default endpoint); additional
            // fields must parse to a JSON object.
            if (byok && apiKey.isBlank()) { status = "⚠ API key required for this provider"; return@Button }
            if (provider == "custom" && baseUrl.isBlank()) {
                status = "⚠ base URL required for a custom provider"; return@Button
            }
            if (additionalFields.isNotBlank() &&
                runCatching { JSONObject(additionalFields) }.getOrNull() == null
            ) {
                status = "⚠ additional fields must be a JSON object"; return@Button
            }
            store.provider = provider
            store.apiKey = apiKey
            store.modelId = modelId
            store.baseUrl = baseUrl
            store.maxTokens = maxTokens
            store.region = region
            store.additionalFields = additionalFields
            // Carry the selection to the account so other devices inherit it (key
            // encrypted server-side, never returned; empty key preserves the stored one).
            scope.launch { store.saveRemote(app.api) }
            status = if (byok) "✅ using your API key" else "using tiny's free model"
        }) { Text("save model") }
        Spacer(Modifier.weight(1f))
        TextButton(onClick = {
            store.reset()
            provider = "default"; apiKey = ""; modelId = ""; baseUrl = ""
            maxTokens = ""; region = "us-west-2"; additionalFields = ""
            // Reverting to the free tier clears the synced row on the account too.
            scope.launch { store.saveRemote(app.api) }
            status = "reset to tiny's free model"
        }) { Text("reset", color = TinyGray) }
    }
}

/**
 * 📞 Voice-call OpenAI key — an ALWAYS-VISIBLE key field, deliberately separate from
 * the chat "model & API key" section above. Live voice calls are OpenAI-ONLY (the
 * realtime speech-to-speech API), so a user running chat on Bedrock/Anthropic/etc.
 * previously had NO way to enable voice — the key field only appeared after switching
 * the whole chat provider to OpenAI. This dedicated field lets voice work without
 * touching the chat provider. Stored device-local in the encrypted ModelConfigStore.
 *
 * User-feedback fix (overrides the iOS/web parity rule): "I don't see the openai
 * voice keys in the settings in android so i can't use the voice."
 */
@Composable
private fun VoiceKeySection(app: TinyApp) {
    val store = app.modelConfig
    var key by remember { mutableStateOf(store.voiceOpenAiKey) }
    var showKey by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    // Chat already on OpenAI → voice reuses that key, so this field is optional.
    val chatIsOpenAi = store.provider.equals("openai", ignoreCase = true) && store.apiKey.isNotEmpty()

    SectionLabel(Icons.Outlined.Call, "voice-call OpenAI key")
    Spacer(Modifier.height(4.dp))
    Text(
        if (chatIsOpenAi)
            "Live voice calls use your OpenAI chat key above. Set a different key here only if you want voice on a separate OpenAI account."
        else
            "Live voice calls (📞) need an OpenAI key — paste one here to enable calls. Voice is OpenAI-only and works no matter which provider your chat uses.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    OutlinedTextField(
        value = key,
        onValueChange = { key = it },
        label = { Text("OpenAI API key (for voice)") },
        placeholder = { Text("sk-...", style = MaterialTheme.typography.bodySmall) },
        singleLine = true,
        visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
        trailingIcon = {
            if (key.isNotEmpty()) {
                TextButton(onClick = { showKey = !showKey }) {
                    Text(if (showKey) "hide" else "show", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
    Text(
        "Stored encrypted on this device only. Sent per-call to start the session, never persisted server-side.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )

    status?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }

    Spacer(Modifier.height(10.dp))
    Row {
        Button(onClick = {
            store.voiceOpenAiKey = key.trim()
            status = if (key.isBlank()) "voice key cleared" else "✅ voice key saved"
        }) { Text("save voice key") }
        if (key.isNotEmpty()) {
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { key = ""; store.voiceOpenAiKey = ""; status = "voice key cleared" }) {
                Text("clear", color = TinyGray)
            }
        }
    }
}

/**
 * 🎙 Account-default live-call voice (iOS Settings "Live-call voice" parity).
 *
 * The OpenAI Realtime voice used on 📞 calls to any tiny that hasn't set its own.
 * Synced across the user's devices via /api/account-voice; the fallback in the
 * per-call resolution (per-tiny voice → this account voice → marin). Separate
 * from the on-device TTS "spoken-reply voice" and the per-tiny call voice a
 * tiny's owner can set. "" = unset (each tiny's own, else marin).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountVoiceSection(app: TinyApp) {
    val store = app.modelConfig
    val scope = rememberCoroutineScope()
    var voice by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    // Reflect the account-synced value on open.
    LaunchedEffect(Unit) { voice = store.loadAccountVoice(app.api) }
    val label = if (voice.isEmpty()) "Default (each tiny's own, else marin)"
                else voice.replaceFirstChar { it.uppercase() }

    SectionLabel(Icons.Outlined.RecordVoiceOver, "live-call voice")
    Spacer(Modifier.height(4.dp))
    Text(
        "Your default voice for live calls (📞), synced across your devices. A tiny whose owner set its own voice still wins. The spoken-reply voice (TTS) above is separate.",
        style = MaterialTheme.typography.bodySmall, color = TinyGray,
    )
    Spacer(Modifier.height(8.dp))

    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = label,
            onValueChange = {},
            readOnly = true,
            label = { Text("live-call voice") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("Default (each tiny's own, else marin)") },
                onClick = {
                    voice = ""; expanded = false
                    scope.launch { store.saveAccountVoice(app.api, "") }
                },
            )
            ACCOUNT_REALTIME_VOICES.forEach { v ->
                DropdownMenuItem(
                    text = { Text(v.replaceFirstChar { it.uppercase() }) },
                    onClick = {
                        voice = v; expanded = false
                        scope.launch { store.saveAccountVoice(app.api, v) }
                    },
                )
            }
        }
    }
}

/** OpenAI Realtime voices for the account picker (mirrors the worker allowlist). */
private val ACCOUNT_REALTIME_VOICES = listOf(
    "alloy", "ash", "ballad", "coral", "echo",
    "sage", "shimmer", "verse", "marin", "cedar",
)
