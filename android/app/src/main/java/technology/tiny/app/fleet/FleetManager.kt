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
import technology.tiny.app.tools.resolveOpenUrl

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

    // What a relay invoke can REALLY do here (use_device P4/P5) — the model
    // reads this list from use_device action:'list' and the system prompt's
    // device block, and reasons from it ("only advertises chat+location, so
    // it can't open apps"). Capability = the software path exists; runtime
    // preconditions (permission grants, glasses linked, foreground) are
    // reported honestly at invoke time by the device-actions audit.
    //   location       = live fused fix (permission-gated at runtime)
    //   bluetooth_scan = live BLE scan context (same runtime gate)
    //   speak          = on-device TTS (quiet-hours gated)
    //   open_app       = open_url incl. mailto/maps/spotify (foreground-gated)
    //   screenshot     = MediaProjection capture behind its consent dialog
    //   glasses        = meta_* bridges (honest "not linked" when absent)
    //   record         = a {type:"record"} relay envelope records the phone's mic
    //                    and answers with a TRANSCRIPT (no audio file — see
    //                    PhoneRecorder's header for why Android cannot host one)
    private val capabilities = listOf(
        "chat", "location", "bluetooth_scan", "speak", "open_app", "screenshot", "glasses",
        "record",
    )

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
        // 🎙️ {type:"record"} — the worker's nicla_voice_record tool reaching this
        // phone. Handled HERE because the poll CLAIMS envelopes (CAS
        // delivered=0→1): an unhandled type is consumed and destroyed, not
        // retried, so falling through to the `invoke` guard below meant the
        // caller waited out its whole window and then told the user the phone
        // might still be recording. Nothing was.
        if (payload.optString("type") == "record") {
            handleRecordEnvelope(envelopeId, payload)
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

    /**
     * Record for the web agent and reply on the same envelope.
     *
     * ALWAYS replies, including on a refusal: the caller is blocked polling for
     * a reply to this exact envelope id, and staying silent about a mic that is
     * busy or a permission that was never granted spends its whole wait window
     * before it can say anything at all. A named refusal arriving in two seconds
     * is worth more than a timeout arriving in thirty-five.
     */
    private suspend fun handleRecordEnvelope(envelopeId: String, payload: JSONObject) {
        val secs = PhoneRecorder.clampSeconds(
            if (payload.has("seconds")) payload.optInt("seconds") else null,
        )
        val label = PhoneRecorder.label(payload.optString("reason"))
        Log.i("TinyFleet", "relay record: ${secs}s ($label)")

        val app = this.context as? technology.tiny.app.TinyApp
        val take = if (app == null) {
            PhoneRecorder.Take(false, "", "", 0, "recorder unavailable on this build")
        } else {
            PhoneRecorder.record(app, secs, label)
        }
        runCatching {
            api.patchJson(
                "/api/devices/relay",
                JSONObject()
                    .put("deviceId", auth.deviceId)
                    .put("token", auth.deviceToken)
                    .put("inReplyTo", envelopeId)
                    .put("payload", PhoneRecorder.reply(take)),
            )
        }

        // A remote request turned this phone's microphone on. That is exactly the
        // kind of thing a user must be able to notice after the fact, so it lands
        // in the relay log the same way an invoke does — and in the shade when
        // nobody was watching the screen.
        val summary = if (take.ok) {
            "🎙️ recorded ${take.seconds}s — ${take.text.take(120).ifEmpty { "(silence)" }}"
        } else {
            "⚠ ${take.error ?: "recording failed"}"
        }
        _relayLog.value = (_relayLog.value + RelayEntry("🎙️ record ${secs}s ($label)", summary)).takeLast(50)
        if (!foreground) {
            RelayNotifier.notifyFleetTrace(
                context, ("relay-record-$envelopeId").hashCode(),
                "🎙️ Web agent recorded on your phone", summary.take(120),
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
        // Device-tool events from the proxied stream act on THIS phone (iOS
        // parity) — and every attempt is AUDITED (use_device P4): the proxied
        // model gets no per-tool result, so without this trail it claims
        // success for actions that silently no-oped ("Mail app opened 📬"
        // while mailto: was dropped). The audit block appended to the reply is
        // what the web-side agent relays instead of that optimism.
        val audit = mutableListOf<String>()
        val reply = api.chatOnce(
            "[Executing on ${deviceName()}, Android] $prompt$context",
            tiny = "tiny",
            extraSystem = continuity.buildContext(config.tinyName),
            onTool = { id, name, input ->
                when (name) {
                    "speak" -> {
                        val text = input.optString("text")
                        val quiet = config.isQuietNow()
                        val spoke = text.isNotBlank() && !quiet
                        if (spoke) speech.speak(text, "relay-${System.currentTimeMillis()}")
                        audit += DeviceActionAudit.speakLine(spoke, quiet)
                    }
                    "open_url" -> {
                        // Resolve the same decision openUrl() will make, but
                        // OBSERVABLY: allowlist verdict + foreground check are
                        // the two silent-failure layers being reported on.
                        val raw = input.optString("url")
                        val resolved = resolveOpenUrl(
                            runCatching { android.net.Uri.parse(raw) }.getOrNull()?.scheme, raw,
                        )
                        val fg = Media.isForeground(this.context)
                        deviceTools.handle(name, input)
                        audit += DeviceActionAudit.openUrlLine(raw, resolved, fg)
                    }
                    // 🔁 Round-trip tools (use_device P5, iOS 943e7294 parity):
                    // the proxied turn's server callback is blocked polling the
                    // chat's tool-result mailbox — run the SAME executors main
                    // chat uses (each posts an outcome on EVERY path, keyed by
                    // this id). Dispatched async: the proxied stream stays open
                    // on keepalives while the capture/bridge works.
                    "screenshot" -> {
                        if (foreground) {
                            // Android's per-capture consent IS the system
                            // MediaProjection dialog — the user is on the phone
                            // and sees exactly what is asking for the screen.
                            // Screenshot.deliver/postDenied posts every outcome.
                            technology.tiny.app.tools.ScreenshotConsentActivity.launch(this.context, id)
                            audit += DeviceActionAudit.dispatchedLine("screenshot (consent prompt shown)")
                        } else {
                            postToolFailure(id, "Screen capture needs the phone in the foreground — its consent dialog cannot show from the background. Ask the user to open the tiny app first.")
                            audit += DeviceActionAudit.toolLine("screenshot", handled = false)
                        }
                    }
                    "meta_take_photo", "meta_record_video", "meta_listen", "meta_glasses_status" -> {
                        val app = this.context as? technology.tiny.app.TinyApp
                        if (app == null) {
                            postToolFailure(id, "glasses bridge unavailable on this build")
                            audit += DeviceActionAudit.toolLine(name, handled = false)
                        } else {
                            scope.launch {
                                when (name) {
                                    "meta_take_photo" -> WearablesBridge.runPhotoTool(app, id)
                                    "meta_record_video" -> GlassesRecorderBridge.runTool(app, id)
                                    "meta_listen" -> WearablesListenerBridge.runTool(app, id, input.optInt("seconds", 10))
                                    else -> WearablesBridge.runStatusTool(app, id)
                                }
                            }
                            audit += DeviceActionAudit.dispatchedLine(name)
                        }
                    }
                    else -> audit += DeviceActionAudit.toolLine(name, deviceTools.handle(name, input))
                }
            },
        )
        // Truncate the answer BEFORE appending the audit (iOS parity):
        // handleEnvelope caps the whole reply at 7000, and a chatty answer
        // must lose its tail — never the truth about what the phone did.
        // 6500 + the render's ≤400-char block stays inside the cap.
        return reply.take(6500) + DeviceActionAudit.render(audit)
    }

    /**
     * Fast honest outcome for a round-trip tool this relay turn can't run —
     * the server callback polls the chat's tool-result mailbox and, with
     * nothing posted, strands for its full 90s (use_device design G7).
     * Posting within one poll tick makes it an immediate, explainable error.
     */
    private fun postToolFailure(toolUseId: String, error: String) {
        scope.launch {
            runCatching {
                api.postJson(
                    "/api/chat/tool-result",
                    JSONObject().put("toolUseId", toolUseId)
                        .put("payload", JSONObject().put("ok", false).put("error", error).toString()),
                )
            }
        }
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
