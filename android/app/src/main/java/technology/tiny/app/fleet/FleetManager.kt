package technology.tiny.app.fleet

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.Config
import technology.tiny.app.auth.AuthManager
import technology.tiny.app.chat.Continuity
import technology.tiny.app.chat.Speech
import technology.tiny.app.net.TinyApi
import technology.tiny.app.tools.DeviceTools

data class RelayEntry(val prompt: String, val result: String, val ts: Long = System.currentTimeMillis())

/**
 * The text a "say/announce/speak" relay command should speak aloud on THIS phone,
 * or null when the prompt carries no such command (→ proxy to the agent instead).
 * Pure string parsing (no Speech/Config deps) so the quote grammar is testable off
 * the impure speak() path in [FleetManager.answer].
 *
 * The verb must LEAD (word-boundary anchored so "display"/"essay" never trigger it),
 * then a MATCHED-PAIR quoted span holds the message. The old single character-class
 * `["“'](.+?)["”']` let a bare apostrophe both OPEN and CLOSE a span, so
 * `say don't worry, it's fine` matched `'t worry, it'` BETWEEN the two contractions
 * (iOS Session.swift:532-536 fixed the identical bug). Straight single quotes
 * additionally require word boundaries so an apostrophe-in-a-word can't open a span.
 * Bounded to 300 chars per span (iOS parity); the first pattern that matches wins.
 */
internal fun announceText(prompt: String): String? {
    val verb = "\\b(?:say|announce|speak)\\b.*?" // the command must precede the quote
    val patterns = listOf(
        "$verb\"([^\"]{1,300})\"",
        "$verb“([^”]{1,300})”",
        "$verb‘([^’]{1,300})’",
        "$verb(?<=\\s)'([^']{1,300})'(?=[\\s.,!?;:]|\$)",
    )
    for (p in patterns) {
        Regex(p, RegexOption.IGNORE_CASE).find(prompt)?.let { return it.groupValues[1].trim() }
    }
    return null
}

/**
 * Fleet-node loops (iOS Session.swift parity): enroll once, heartbeat every 30s
 * (presence window is 60s server-side), poll the relay every 5s for `invoke`
 * envelopes from the web agent. Local fast-paths answer status/say instantly;
 * everything else proxies through the server agent via chatOnce. At-most-once:
 * the server marks envelopes delivered on poll, so answer what we take.
 */
class FleetManager(
    private val context: Context,
    private val api: TinyApi,
    private val auth: AuthManager,
    private val config: Config,
    private val speech: Speech,
    private val continuity: Continuity,
    private val deviceTools: DeviceTools,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null
    private var relayJob: Job? = null
    private var consecutiveAuthFailures = 0

    // Whether the app is foregrounded (MainActivity onStart/onStop toggles it).
    // Gates the "web agent reached your phone" trace: iOS only posts it from a
    // background wake, and a foreground user is already watching the live relay
    // log, so a shade trace would be redundant noise there.
    @Volatile
    var foreground = false

    // Set when a revoked registration is cleared for self-heal; the trace fires
    // only after the re-join actually lands (iOS posts "re-enrolled" post-success,
    // not on the clear), so a failed re-join doesn't falsely claim success.
    private var reEnrollPending = false

    private val _online = MutableStateFlow(false)
    val online: StateFlow<Boolean> = _online
    private val _relayLog = MutableStateFlow<List<RelayEntry>>(emptyList())
    val relayLog: StateFlow<List<RelayEntry>> = _relayLog
    private val _unread = MutableStateFlow(0)
    val unread: StateFlow<Int> = _unread
    // ⚡ Activity feed: count of event-ring entries newer than the seen high-water
    // mark (web ActivityHUD badge). Fed by the heartbeat poll, like DM unread.
    private val _eventsUnread = MutableStateFlow(0)
    val eventsUnread: StateFlow<Int> = _eventsUnread

    // "location" = this node can answer where/speed asks with a live fused fix
    // (relay block below; gated at runtime on the actual permission grant)
    private val capabilities = listOf("chat", "location")

    fun start() {
        if (!auth.isLoggedIn) return
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = scope.launch { heartbeatLoop() }
        relayJob = scope.launch { relayLoop() }
    }

    fun stop() {
        heartbeatJob?.cancel(); heartbeatJob = null
        relayJob?.cancel(); relayJob = null
        _online.value = false
    }

    private suspend fun enrollIfNeeded(): Boolean {
        if (auth.deviceId != null && auth.deviceToken != null) return true
        val name = "${auth.login ?: "user"}-pixel"
        val res = runCatching {
            api.postJson(
                "/api/devices",
                JSONObject()
                    .put("name", name)
                    .put("platform", "android-arm64")
                    .put("kind", "daemon")
                    .put("capabilities", org.json.JSONArray(capabilities)),
            )
        }.getOrNull() ?: return false
        val id = res.optString("device_id").ifEmpty { res.optString("deviceId") }
        val token = res.optString("device_token").ifEmpty { res.optString("token") }
        if (id.isEmpty() || token.isEmpty()) {
            Log.w("TinyFleet", "enroll failed: $res")
            return false
        }
        Log.i("TinyFleet", "enrolled as $name id=$id")
        auth.deviceId = id
        auth.deviceToken = token
        return true
    }

    private suspend fun heartbeatLoop() {
        var first = true
        var beat = 0
        while (true) {
            if (enrollIfNeeded()) {
                if (reEnrollPending) {
                    reEnrollPending = false
                    RelayNotifier.notifyFleetTrace(
                        context, RelayNotifier.REENROLL_NOTIF_ID,
                        "🔄 Device re-enrolled",
                        "This phone's fleet registration was revoked — it re-joined automatically.",
                    )
                }
                val body = JSONObject()
                    .put("deviceId", auth.deviceId)
                    .put("token", auth.deviceToken)
                // First beat re-asserts capabilities; later beats send null → server keeps stored.
                if (first) body.put("capabilities", org.json.JSONArray(capabilities))
                val res = runCatching { api.postJson("/api/devices/heartbeat", body) }.getOrNull()
                if (res != null && res.optBoolean("ok", false)) {
                    if (!_online.value) Log.i("TinyFleet", "heartbeat ok — device online")
                    _online.value = true
                    consecutiveAuthFailures = 0
                    first = false
                    pollUnread() // heartbeat doubles as DM unread poll (iOS parity)
                    pollEventsUnread() // …and the ⚡ activity-feed badge (web ActivityHUD)
                    // Fleet-count widget refresh every 10th beat (~5 min, iOS parity).
                    if (beat % 10 == 0) refreshFleetWidget()
                    beat++
                } else {
                    Log.w("TinyFleet", "heartbeat failed: $res")
                    _online.value = false
                    val status = res?.optInt("_status") ?: 0
                    val unknown = res?.optString("error")?.contains("unknown", true) == true
                    if (status == 401 || status == 404 || unknown) {
                        // Two strikes → self-heal re-enroll (revoked/wiped server-side).
                        if (++consecutiveAuthFailures >= 2) {
                            auth.clearDevice()
                            consecutiveAuthFailures = 0
                            first = true
                            reEnrollPending = true // trace it once the re-join lands (below)
                        }
                    }
                }
            }
            delay(30_000)
        }
    }

    private suspend fun pollUnread() {
        val res = runCatching { api.getJson("/api/messages") }.getOrNull() ?: return
        val threads = res.optJSONArray("threads") ?: return
        val snapshots = (0 until threads.length()).mapNotNull { i ->
            threads.optJSONObject(i)?.let { t ->
                DmThreadSnapshot(
                    login = t.optString("login"),
                    name = t.optString("name").takeIf { it.isNotEmpty() },
                    unread = t.optInt("unread"),
                    lastBody = t.optString("lastBody"),
                )
            }
        }
        // Diff + banner grown-unread (shares one snapshot with DmPollWorker).
        _unread.value = DmNotifier.syncUnread(context, snapshots)
    }

    fun refreshUnread() {
        scope.launch { pollUnread() }
    }

    /**
     * Count event-ring entries newer than the seen high-water mark for the ⚡ badge
     * (web ActivityHUD's unread = events.filter(id > seenId).length). Silent on any
     * failure — a badge is not worth surfacing an outage. Leaves the last count intact
     * on a blip (never zeroes a real badge on a transient failure).
     */
    private suspend fun pollEventsUnread() {
        val res = runCatching { api.getJson("/api/events") }.getOrNull() ?: return
        if (!res.optBoolean("ok", false)) return // route 502s ok:false when the ring is down
        val arr = res.optJSONArray("events") ?: return
        _eventsUnread.value = FleetCounts.unreadEvents(arr, config.eventsSeenId)
    }

    /** Opening the Activity panel marks everything seen: advance the high-water mark
     *  to the highest known id and clear the badge (web markSeen). */
    fun markEventsSeen(maxId: Long) {
        if (maxId > config.eventsSeenId) config.eventsSeenId = maxId
        _eventsUnread.value = 0
    }

    /**
     * Fleet-count snapshot for the home-screen widgets (iOS refreshFleetWidget
     * parity): GET /api/devices, count online, publish to the WidgetStore. Keeps
     * the last exchange/memories intact (WidgetStore.updateFleet merges).
     */
    private suspend fun refreshFleetWidget() {
        val res = runCatching { api.getJson("/api/devices") }.getOrNull() ?: return
        val arr = res.optJSONArray("devices") ?: return
        val online = FleetCounts.onlineCount(arr)
        val total = FleetCounts.totalCount(arr)
        technology.tiny.app.widget.WidgetBridge.publishFleet(
            context, online, total, _unread.value, auth.login ?: "", config.accentHex,
        )
        // …and mirror the same presence + unread to the wrist so a Wear
        // complication/glance stays current without the watch app opening
        // (iOS absorbSnapshot parity). Fire-and-forget; no watch paired → just logs.
        technology.tiny.app.wear.WatchBridge.pushSnapshot(
            context, online = online, total = total, unread = _unread.value,
            accent = config.accentHex, now = System.currentTimeMillis(),
        )
    }

    private suspend fun relayLoop() {
        while (true) {
            val id = auth.deviceId
            val token = auth.deviceToken
            if (id != null && token != null) {
                val res = runCatching {
                    api.putJson(
                        "/api/devices/relay",
                        JSONObject().put("deviceId", id).put("token", token).put("max", 3),
                    )
                }.getOrNull()
                val msgs = res?.optJSONArray("messages")
                if (msgs != null) {
                    for (i in 0 until msgs.length()) {
                        val env = msgs.optJSONObject(i) ?: continue
                        handleEnvelope(env.optString("id"), env.optString("payload"))
                    }
                }
            }
            delay(5_000)
        }
    }

    private suspend fun handleEnvelope(envelopeId: String, payloadRaw: String) {
        val payload = runCatching { JSONObject(payloadRaw) }.getOrNull() ?: return
        // Push mirror (worker push.ts relayPushToDevices): every web push also
        // arrives here as {type:'notify'} — banner natively, nothing to reply.
        if (payload.optString("type") == "notify") {
            RelayNotifier.handle(context, payload) { refreshUnread() }
            return
        }
        if (payload.optString("type") != "invoke") return
        val prompt = payload.optString("prompt")
        if (prompt.isEmpty()) return

        Log.i("TinyFleet", "relay invoke: ${prompt.take(80)}")
        val result = runCatching { answer(prompt) }
            .getOrElse { "⚠ ${it.message ?: "failed"}" }
            .take(7_000)

        runCatching {
            api.patchJson(
                "/api/devices/relay",
                JSONObject()
                    .put("deviceId", auth.deviceId)
                    .put("token", auth.deviceToken)
                    .put("inReplyTo", envelopeId)
                    .put("payload", JSONObject().put("result", result)),
            )
        }
        _relayLog.value = (_relayLog.value + RelayEntry(prompt, result)).takeLast(50)

        // The app was asleep when the web agent reached this phone — leave a shade
        // trace so the user knows it happened (iOS Session.swift "📡 Web agent
        // reached your phone"). Background-only: a foreground user is already
        // watching the live relay log, so a banner there would just be noise. Id
        // hashes the prompt so back-to-back invokes don't collapse onto one line.
        if (!foreground) {
            RelayNotifier.notifyFleetTrace(
                context, ("relay-invoke-" + prompt).hashCode(),
                "📡 Web agent reached your phone", prompt.take(120),
            )
        }
    }

    private suspend fun answer(prompt: String): String {
        val lower = prompt.lowercase()
        // Local fast-paths (<1s, no agent round-trip)
        if (Regex("\\b(ping|alive|status|battery)\\b").containsMatchIn(lower)) {
            return deviceStatus()
        }
        announceText(prompt)?.let { text ->
            if (!config.isQuietNow()) {
                speech.speak(text, "relay-${System.currentTimeMillis()}")
                return "🔊 said aloud on ${deviceName()}: “$text”"
            }
            return "🌙 quiet hours (22:00–08:00) — didn't speak, but noted: “$text”"
        }
        // 🎵 Spotify intent — a real device action, no chat proxy (iOS
        // Session.swift:342). Open the search deep-link so the track is one tap
        // from playing; foreground-only, since Android forbids launching apps
        // from a backgrounded process (same constraint iOS enforces via
        // applicationState == .active). Backgrounded → hand back the link.
        if (Regex("\\bspotify\\b", RegexOption.IGNORE_CASE).containsMatchIn(prompt)) {
            val url = Media.searchUrl(Media.musicQuery(prompt))
            return if (Media.open(this.context, url)) {
                "🎵 Opened Spotify on ${deviceName()}: $url"
            } else {
                "The tiny app isn't in the foreground on the phone, so it can't open Spotify right now. The search link: $url"
            }
        }
        // Radio context the server can't see: a nearby/bluetooth prompt gets a live
        // BLE scan appended, so the agent answers with REAL radio data (iOS parity,
        // Session.swift:355). Gated on the runtime scan permission — if it's not
        // granted, scanSummary() returns a plain "permission not granted" line.
        var context = ""
        if (Regex("bluetooth|nearby|\\bble\\b|around (me|us|the phone)|devices around", RegexOption.IGNORE_CASE)
                .containsMatchIn(prompt)
        ) {
            context = "\n\n[Live Bluetooth scan from this phone]\n" +
                Bluetooth.scanSummary(this.context)
        }
        // Motion/steps questions get a live sensor snapshot (iOS Session.swift:360).
        if (Regex("motion|moving|orientation|steps|shake|accel|\\bstill\\b|face (up|down)", RegexOption.IGNORE_CASE)
                .containsMatchIn(prompt)
        ) {
            context += "\n\n[Live motion snapshot from this phone]\n" +
                Motion.snapshot(this.context)
        }
        // 📍 Where/speed questions get a live fused fix (same `### Location`
        // grammar every client injects). Degrades to a plain "not granted"
        // line, the Bluetooth/Motion contract — never blocks the answer.
        if (Regex("location|\\bwhere\\b|coordinates|latitude|longitude|speed|heading|konum|nerede|hız", RegexOption.IGNORE_CASE)
                .containsMatchIn(prompt)
        ) {
            val block = technology.tiny.app.geo.Geo.current(this.context)
                ?.let { technology.tiny.app.geo.Geo.contextBlock(it) }
            context += "\n\n[Live location from this phone]\n" +
                (block ?: "Location permission not granted on the phone.")
        }
        // Everything else proxies through the server agent as this device.
        // Device-tool events from the proxied stream act on THIS phone (iOS parity).
        return api.chatOnce(
            "[Executing on ${deviceName()}, Android] $prompt$context",
            tiny = "tiny",
            extraSystem = continuity.buildContext(config.tinyName),
            onTool = { name, input ->
                if (name == "speak") {
                    val text = input.optString("text")
                    if (text.isNotBlank() && !config.isQuietNow()) {
                        speech.speak(text, "relay-${System.currentTimeMillis()}")
                    }
                } else {
                    deviceTools.handle(name, input)
                }
            },
        )
    }

    private fun deviceName() = "${auth.login ?: "user"}-pixel"

    private fun deviceStatus(): String {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            .let { it == BatteryManager.BATTERY_STATUS_CHARGING || it == BatteryManager.BATTERY_STATUS_FULL }
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val stat = StatFs(context.filesDir.absolutePath)
        val freeGb = stat.availableBytes / 1_073_741_824.0
        val upH = SystemClock.elapsedRealtime() / 3_600_000.0
        return "📱 ${deviceName()} (${Build.MODEL}, Android ${Build.VERSION.RELEASE}) — " +
            "🔋 $pct%${if (charging) " charging" else ""}" +
            (if (pm.isPowerSaveMode) ", battery saver" else "") +
            ", 💾 %.1f GB free, ⏱ up %.1f h".format(java.util.Locale.US, freeGb, upH)
    }
}
