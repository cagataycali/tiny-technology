package technology.tiny.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp
import technology.tiny.app.ui.theme.TinyGray
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 🤖 A robot's chamber camera + telemetry, inside the fleet sheet.
 *
 * Web parity: app/devices/page.tsx's EndpointPanel — same two polls (frames every
 * 2s, readings every 10s), same failure copy, same "keep the last good reading"
 * rule. iOS: EndpointPanel.swift.
 *
 * What differs from web, and why it's a constraint rather than a choice: the web
 * points an `<img src>` at the proxy and lets the browser fetch it, because its
 * session rides a cookie. This app authenticates with a Bearer token, so a plain
 * coil `AsyncImage` (which sends no auth header) would 401 on every frame. Frames
 * are fetched explicitly and decoded — which means WE own the content-type check
 * that a browser's image decoder gave the web for free.
 *
 * And `document.hidden` becomes the Lifecycle: a phone that pockets mid-poll must
 * stop calling someone's printer.
 */

/** One labelled reading, ready to draw. */
data class TelemetryReading(val label: String, val value: String)

/**
 * Tolerant numeric read: a JSON number OR a numeric string, and never a
 * null/NaN/non-numeric.
 *
 * Bambu's MQTT payload genuinely mixes both forms (`temps.nozzle` is a number,
 * `fan.cooling` is the string "0"), so a projection that only accepted numbers
 * would silently drop real readings — and one that accepted anything would print
 * "NaN°" at someone whose sensor is simply absent.
 *
 * `JSONObject.NULL` (the printer really does answer `chamber: null`) lands in the
 * `else` because it is neither a Number nor a String — absent, not zero.
 */
internal fun telemetryNumber(any: Any?): Double? {
    val d = when (any) {
        is Number -> any.toDouble()
        is String -> any.toDoubleOrNull() ?: return null
        else -> return null
    }
    return if (d.isFinite()) d else null
}

/**
 * A temperature with its target, but only when the machine is actually heating to
 * one: a target of 0 means "not heating", and "41° → 0°" would suggest an active
 * cooldown command that was never issued.
 */
private fun temp(t: JSONObject, key: String): String? {
    val temps = t.optJSONObject("temps") ?: return null
    val now = telemetryNumber(temps.opt(key)) ?: return null
    val target = telemetryNumber(temps.opt("${key}_target")) ?: 0.0
    val n = Math.round(now)
    return if (target > 0) "$n° → ${Math.round(target)}°" else "$n°"
}

/**
 * The readings worth a glance, in the web's reading order.
 *
 * Every field is optional and every number is suspect — this is a machine's own
 * JSON. Anything missing or unparseable is SKIPPED, so an idle printer shows a
 * short list rather than a grid of dashes.
 */
internal fun telemetryReadings(t: JSONObject): List<TelemetryReading> {
    val out = mutableListOf<TelemetryReading>()
    fun add(label: String, value: String?) {
        if (!value.isNullOrEmpty()) out.add(TelemetryReading(label, value))
    }

    t.optString("gcode_state").takeIf { it.isNotEmpty() }?.let { add("state", it.lowercase()) }

    val job = t.optString("subtask_name").trim()
    if (job.isNotEmpty()) {
        val pct = telemetryNumber(t.opt("progress"))
        // Only show a percentage when there IS one: "job · 0%" on a queued print
        // is less honest than just the name.
        add("job", if (pct != null && pct > 0) "$job · ${pct.toInt()}%" else job)
    }

    add("nozzle", temp(t, "nozzle"))
    add("bed", temp(t, "bed"))

    val layer = telemetryNumber(t.opt("layer"))
    val total = telemetryNumber(t.opt("total_layers"))
    if (layer != null && total != null && total > 0) add("layer", "${layer.toInt()} / ${total.toInt()}")

    telemetryNumber(t.opt("remaining_min"))?.takeIf { it > 0 }?.let { add("remaining", "${it.toInt()} min") }
    return out
}

/** Mid-job? Tints the state row and the live badge so a running machine reads at a glance. */
internal fun telemetryIsRunning(t: JSONObject?): Boolean =
    (t?.optString("gcode_state") ?: "").uppercase() == "RUNNING"

/**
 * The one-line note for a failed poll.
 *
 * ⚠️ These must stay DISTINCT (web + iOS parity). A thinking robot is not an
 * absent one, and a rejected credential is not a network problem — collapsing
 * them is how a busy printer gets reported as unplugged, or how an expired token
 * sends someone out to check cables. A rejected credential outranks a timeout
 * because waiting won't fix an expired token.
 */
internal fun telemetryNote(unauthorized: Boolean, timeout: Boolean, unreachable: Boolean): String = when {
    unauthorized -> "Credential rejected — re-enroll this device."
    timeout -> "Still working — no answer yet."
    unreachable -> "Not answering right now."
    else -> "Telemetry unavailable."
}

/**
 * Does this device show a camera?
 *
 * ⚠️ The live printer's capabilities are ["chat","telemetry","print","cad"] — no
 * "camera" — so keying only on `camera` would hide a chamber view that
 * demonstrably works. `print` implies a build chamber worth watching. A device
 * claiming neither gets telemetry only, rather than a permanently-failing box.
 */
internal fun endpointHasCamera(capabilities: List<String>): Boolean =
    capabilities.contains("camera") || capabilities.contains("print")

/** `capabilities` arrives as a JSON *string*; a malformed one means none, never a crash. */
internal fun parseCapabilities(raw: String?): List<String> {
    if (raw.isNullOrBlank()) return emptyList()
    val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.opt(it) as? String }
}

/**
 * Content types we will decode into a frame.
 *
 * ⚠️ Load-bearing, not hygiene. The proxy pins the type already, but this app
 * decodes bytes from a machine nobody here controls, so it re-asserts the
 * allowlist rather than trusting a header. `image/svg+xml` is absent on purpose:
 * coil-svg IS in this app's dependencies, so an SVG would actually render — and
 * SVG is the one image type that can script.
 */
internal val ENDPOINT_IMAGE_TYPES = listOf("image/jpeg", "image/png", "image/webp")

/** A robot is not a trusted size. Matches the worker's own cap. */
internal const val ENDPOINT_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * One camera frame, or null.
 *
 * Deliberately null-on-anything-wrong: the caller keeps the previous frame up, so
 * a dropped tick is invisible rather than a flash of empty box.
 */
internal suspend fun fetchEndpointFrame(base: String, deviceId: String, token: String?, stamp: Long): Bitmap? =
    withContext(Dispatchers.IO) {
        runCatching {
            // Cache-bust for the same reason web does: an identical URL lets the
            // stack serve the same frame forever and the poll becomes meaningless.
            val url = URL("$base/api/devices/endpoint?deviceId=$deviceId&action=snapshot&t=$stamp")
            val conn = url.openConnection() as HttpURLConnection
            token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
            conn.useCaches = false
            conn.connectTimeout = 10_000
            // Tighter than the 30s JSON house rule on purpose: a frame is polled
            // on a timer, so a slow one should lose its turn rather than delay the
            // ticks behind it. Above the worker's own 10s image budget so the
            // worker's typed error wins the race.
            conn.readTimeout = 15_000
            try {
                if (conn.responseCode !in 200..299) return@runCatching null
                val type = (conn.contentType ?: "").substringBefore(';').trim().lowercase()
                if (type !in ENDPOINT_IMAGE_TYPES) return@runCatching null
                // Read through a cap rather than trusting Content-Length: a device
                // that streams forever (or lies in the header) would otherwise
                // exhaust the heap.
                val buf = ByteArrayOutputStream()
                val chunk = ByteArray(16 * 1024)
                conn.inputStream.use { input ->
                    while (true) {
                        val n = input.read(chunk)
                        if (n <= 0) break
                        if (buf.size() + n > ENDPOINT_IMAGE_MAX_BYTES) return@runCatching null
                        buf.write(chunk, 0, n)
                    }
                }
                val bytes = buf.toByteArray()
                if (bytes.isEmpty()) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }

/**
 * 🔴 A frozen frame is not a live view. iOS `FrameLiveness`
 * (EndpointPanel.swift:203) and web's `STALE_AFTER_MS` ported.
 *
 * The camera poll keeps the last good frame when a tick fails, deliberately —
 * flashing an empty box over a working webcam is worse than a frame two seconds
 * old. But the badge over that frame said `live` from the first successful decode
 * and had no way left to be withdrawn: `cameraFailed` is only ever assigned while
 * `frame == null`, so after one success this panel could not report a failure at
 * all. A chamber camera that died at 3am showed a still picture of a finished
 * print, labelled live, in an accent tint, for as long as the sheet stayed open.
 *
 * Three claims said it independently — the word, its accent, and the
 * contentDescription — each on its own terms. All three now read ONE boolean.
 *
 * FRESHNESS decides the word, not the last tick's outcome: one dropped frame is
 * ordinary on a robot's own webcam and must not flicker the badge.
 */
internal object FrameLiveness {
    /**
     * Three ticks of the camera loop's 2s delay. One tick may be lost to a slow
     * frame or a busy printer; three in a row is a stall, not a hiccup. ⚠️ Shared
     * with iOS (`staleAfter: TimeInterval = 6`) and web (`STALE_AFTER_MS = 6_000`)
     * — two independently-chosen windows would mean the same dead camera reads live
     * on one device and stale on the next.
     */
    const val staleAfter = 6_000L

    /**
     * The one decision, so the badge, its tint and TalkBack cannot disagree.
     *
     * `now` is a parameter for the tests' sake — every caller passes the default.
     */
    fun isLive(frameAt: Long?, now: Long = System.currentTimeMillis()): Boolean {
        if (frameAt == null) return false
        return now - frameAt < staleAfter
    }

    /**
     * The badge, and deliberately not a diagnosis: [fetchEndpointFrame] answers
     * null for every failure alike and keeps no reason, so the only honest thing
     * left to say is WHICH frame this is. The instant it was taken goes beneath the
     * image in the sheet's one voice for that, [ReadingAge].
     */
    fun badge(live: Boolean): String = if (live) "live" else "last frame"

    /**
     * What TalkBack hears. The contentDescription said "Live camera view from X"
     * unconditionally — the same false claim with the volume up, and worse, because
     * someone using a screen reader has no frozen picture to notice.
     */
    fun spoken(deviceName: String, live: Boolean): String =
        if (live) "Live camera view from $deviceName"
        else "Last camera frame from $deviceName"
}

/**
 * The panel. Always visible for an endpoint device (web parity) — every other
 * fleet row costs nothing extra, which matters because most people have no robots.
 */
@Composable
fun EndpointPanel(app: TinyApp, deviceId: String, deviceName: String, capabilities: List<String>) {
    var telemetry by remember { mutableStateOf<JSONObject?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var frame by remember { mutableStateOf<Bitmap?>(null) }
    var cameraFailed by remember { mutableStateOf(false) }
    // When the frame on screen arrived, and whether that is still recent enough to
    // call live. `frameLive` is REPUBLISHED by every tick of the camera loop rather
    // than computed while drawing, because nothing else re-renders this panel once
    // the frames stop — a badge derived at draw time would freeze along with them.
    var frameAt by remember { mutableStateOf<Long?>(null) }
    var frameLive by remember { mutableStateOf(false) }

    val hasCamera = remember(capabilities) { endpointHasCamera(capabilities) }
    val running = telemetryIsRunning(telemetry)
    val readings = remember(telemetry) { telemetry?.let { telemetryReadings(it) } ?: emptyList() }
    val accent = MaterialTheme.colorScheme.primary

    // 👀 The lifecycle IS the visibility gate. A backgrounded app must not keep
    // calling someone's printer; resuming picks the polls back up without a
    // re-mount. (Web reads document.hidden, iOS reads scenePhase.)
    val lifecycleOwner = LocalLifecycleOwner.current
    var resumed by remember { mutableStateOf(true) }
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> resumed = true
                Lifecycle.Event.ON_PAUSE -> resumed = false
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        // ⚠️ Without the remove the observer outlives the row and leaks it.
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    // Telemetry every 10s. The LaunchedEffect is cancelled with the row, which is
    // what stops the loop — `delay` is the cancellation point.
    LaunchedEffect(deviceId) {
        while (true) {
            if (resumed) {
                val res = runCatching {
                    app.api.getJson("/api/devices/endpoint?deviceId=$deviceId&action=telemetry")
                }.getOrNull()
                val result = res?.optJSONObject("result")
                if (res != null && res.optBoolean("ok") && result != null) {
                    telemetry = result
                    note = null
                } else {
                    // ⚠️ Keep the LAST good reading — blanking the panel on one
                    // failed tick makes a working machine look broken.
                    note = telemetryNote(
                        unauthorized = res?.optBoolean("unauthorized") == true,
                        timeout = res?.optBoolean("timeout") == true,
                        // A null response is a transport failure: nothing answered.
                        unreachable = res == null || res.optBoolean("unreachable"),
                    )
                }
            }
            delay(10_000)
        }
    }

    // Camera every 2s. Serialized by construction — the fetch is awaited before
    // the next delay, so a slow frame can't stack ticks behind it (the web gets
    // this free from the browser's <img>).
    LaunchedEffect(deviceId, hasCamera) {
        if (!hasCamera) return@LaunchedEffect
        while (true) {
            if (resumed) {
                val img = fetchEndpointFrame(
                    app.config.serverBase, deviceId, app.auth.token, System.currentTimeMillis(),
                )
                if (img != null) {
                    frame = img
                    // Stamped HERE, beside the frame it dates. A `frameAt` set at
                    // the top of the tick would date the REQUEST, and on a poll that
                    // can time out after 15s those are not the same fact.
                    frameAt = System.currentTimeMillis()
                    cameraFailed = false
                } else if (frame == null) {
                    // Only admit failure while we've never had a frame: once one
                    // has landed, a dropped tick leaves the last frame up rather
                    // than flashing an error over a working camera.
                    cameraFailed = true
                }
            }
            // OUTSIDE the `resumed` gate on purpose: the ticks skipped while
            // backgrounded still have to AGE the frame, or a phone taken out of a
            // pocket finds a five-minute-old picture still badged live.
            frameLive = FrameLiveness.isLive(frameAt)
            delay(2_000)
        }
    }

    Column(Modifier.fillMaxWidth().padding(start = 20.dp, top = 4.dp, bottom = 8.dp)) {
        if (hasCamera) {
            Box(
                Modifier.fillMaxWidth()
                    // 16:9 so the row height never jumps between frames or while
                    // the first one is still loading.
                    .aspectRatio(16f / 9f)
                    .clip(RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                val bmp = frame
                if (bmp != null) {
                    Image(
                        bitmap = bmp.asImageBitmap(),
                        contentDescription = FrameLiveness.spoken(deviceName, frameLive),
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.matchParentSize(),
                    )
                    Box(Modifier.matchParentSize(), contentAlignment = Alignment.TopStart) {
                        Row(
                            Modifier.padding(8.dp)
                                .clip(RoundedCornerShape(50))
                                .background(Color.Black.copy(alpha = 0.6f))
                                .padding(horizontal = 7.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            // `running` alone lit the accent, so a stale frame from a
                            // job that is still printing glowed exactly like a live
                            // one. Both halves of the badge gate on liveness first.
                            Box(
                                Modifier.size(5.dp).clip(RoundedCornerShape(50))
                                    .background(if (frameLive && running) accent else TinyGray),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                FrameLiveness.badge(frameLive),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (frameLive && running) accent else Color.White.copy(alpha = 0.85f),
                            )
                        }
                    }
                } else {
                    Text(
                        if (cameraFailed) "camera unavailable" else "connecting to camera…",
                        style = MaterialTheme.typography.labelSmall,
                        color = TinyGray,
                    )
                }
            }
            // 🕒 A frame that stopped refreshing says WHEN it was taken, in the same
            // sentence the necklace camera uses. Gated on `!frameLive` because while
            // it IS live the badge already answers the question, and on `frameAt`
            // (inside `asOf`) because an age with no reading under it dates nothing.
            if (!frameLive) {
                ReadingAge.asOf(frameAt)?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                }
            }
            Spacer(Modifier.height(6.dp))
        }

        // Two columns of label/value — a phone-width version of the web's grid.
        readings.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth()) {
                pair.forEach { r ->
                    Column(Modifier.weight(1f)) {
                        Text(r.label, style = MaterialTheme.typography.labelSmall, color = TinyGray)
                        Text(
                            r.value,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (r.label == "state" && running) accent else MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                        )
                    }
                }
                // Keep a lone odd reading in its own column rather than centred.
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.height(3.dp))
        }

        // One line, and only when there's something true to say. The last good
        // reading stays visible above it.
        val n = note
        if (n != null) {
            Text(n, style = MaterialTheme.typography.labelSmall, color = TinyGray)
        } else if (telemetry == null) {
            Text("reading telemetry…", style = MaterialTheme.typography.labelSmall, color = TinyGray)
        }
    }
}
