package technology.tiny.app.fleet

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.net.TinyApi
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Turning a relay reply's `payload` into a sentence a person can read.
 *
 * Shared by every panel that talks to a device, because they all face the same
 * wire: a JSON envelope whose useful text hides under one of several keys, or no
 * envelope at all. iOS RelayReply (TinyLive.swift).
 */
object RelayReply {
    /**
     * `JSONTokener`, not `JSONObject(…)`, because a bare JSON string IS a legal
     * payload here: the worker validates with JS `JSON.parse`, which accepts a
     * top-level string, so a daemon may legitimately reply `"done"`.
     * `JSONObject("\"done\"")` throws on that, and the catch-all then hands the
     * user `"done"` complete with its quotes. iOS passes `.fragmentsAllowed` to
     * the same end.
     */
    fun text(payload: String): String {
        val obj = runCatching { org.json.JSONTokener(payload).nextValue() }.getOrNull()
            ?: return payload
        if (obj is String) return obj
        if (obj is JSONObject) {
            for (key in listOf("result", "text", "output", "error")) {
                val v = obj.optString(key)
                if (v.isNotBlank()) return v
            }
        }
        return payload
    }
}

/** What a device's reply to a `frame` invoke turned out to be. */
sealed class FrameAnswer {
    data class ImageUrl(val url: String) : FrameAnswer()

    /** It answered with prose, not a picture. STILL an answer. */
    data class Words(val said: String) : FrameAnswer()
}

/**
 * Why a frame didn't arrive.
 *
 * `fetchFrame` collapses every one of these into `null`, which is harmless for
 * the streaming loop (it simply retries) and a dead end in a panel: the user
 * taps, waits nineteen seconds, and is handed back the same "tap to peek"
 * placeholder they started from — five different failures wearing one blank
 * face, none of them distinguishable from not having tapped at all.
 * iOS TinyLive.FrameFailure.
 */
sealed class FrameFailure {
    abstract val message: String

    /** The send never landed: signed out, device revoked, no network. */
    data class RelayRefused(val why: String) : FrameFailure() {
        override val message get() = why
    }

    /** The board never answered inside the poll budget. */
    data class NoReply(val seconds: Int) : FrameFailure() {
        override val message get() = "No frame in ${seconds}s — is the camera awake?"
    }

    /**
     * It DID answer, with words instead of an image — "camera busy", "no camera
     * on this device". The most useful failure of the five, and the one the old
     * code discarded most thoroughly.
     */
    data class DeviceSaid(val what: String) : FrameFailure() {
        override val message get() = what
    }

    /** The frame's URL was unreachable, or the bytes weren't an image. */
    object Undecodable : FrameFailure() {
        override val message get() = "The frame arrived but couldn't be decoded."
    }

    /** The caller asked us to stop (panel left the screen, mode switched away). */
    object Cancelled : FrameFailure() {
        override val message get() = ""
    }
}

/** One peek: a frame, or the reason there isn't one. */
sealed class FrameResult {
    data class Success(val bitmap: Bitmap) : FrameResult()
    data class Failure(val why: FrameFailure) : FrameResult()
}

/**
 * 💎 Live video/audio from the tiny necklace — Android port of iOS
 * TinyLive.swift (necklace n2/n5).
 *
 * Internet-first: remote mode polls relay `frame` invokes (the warm-camera
 * firmware answers in ~1-3s), with an on-demand 2s WAV "remote listen"; on a
 * shared WiFi it upgrades to the direct LAN stream from tiny_stream.py —
 * multipart MJPEG ~20fps + raw PCM16 mono 16kHz.
 */
object TinyLive {
    enum class Mode { REMOTE, LAN }

    private val _frame = MutableStateFlow<Bitmap?>(null)
    val frame: StateFlow<Bitmap?> = _frame

    private val _status = MutableStateFlow("idle")
    val status: StateFlow<String> = _status

    private val _mode = MutableStateFlow(Mode.REMOTE)
    val mode: StateFlow<Mode> = _mode

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running

    private val _listening = MutableStateFlow(false)
    val listening: StateFlow<Boolean> = _listening

    private val _transcribe = MutableStateFlow(true)

    /** Whether the necklace's audio is being read as well as played. */
    val transcribe: StateFlow<Boolean> = _transcribe

    private val _liveText = MutableStateFlow("")

    /** What the necklace is saying right now — the live overlay's text. */
    val liveText: StateFlow<String> = _liveText

    private val _scribeNote = MutableStateFlow<String?>(null)

    /**
     * Why transcription isn't running, when it isn't.
     *
     * A silent failure here is the whole hazard: the stream plays, the panel says
     * "live", and no words ever appear — indistinguishable from a quiet room.
     */
    val scribeNote: StateFlow<String?> = _scribeNote

    /** [LiveScribe]'s way in — see TinyLiveScribeBridge. */
    internal fun publishLiveText(t: String) { _liveText.value = t }

    /** [LiveScribe]'s way in for a refusal — see TinyLiveScribeBridge. */
    internal fun publishScribeNote(why: String?) { _scribeNote.value = why }

    /** Turn reading the necklace's audio on or off for the stream in progress. */
    fun toggleTranscribe() {
        _transcribe.value = !_transcribe.value
        if (_transcribe.value) _scribeNote.value = null else _liveText.value = ""
    }

    /**
     * The app, for the recognizer and for filing a segment.
     *
     * [start] is the only setter: transcription needs a Context and a way to
     * reach the server, and the LAN audio loop is several calls deep from there.
     */
    private var liveApp: technology.tiny.app.TinyApp? = null

    private val scope = CoroutineScope(Dispatchers.IO)
    private var videoJob: Job? = null
    private var audioJob: Job? = null
    private var deviceId: String? = null
    private var cachedBase: String? = null
    private var clipPlayer: MediaPlayer? = null

    /**
     * @param app when given, the necklace's audio is READ as well as played
     *   (see [lanAudio]). Optional so the object stays usable from a call site
     *   that has only an api — transcription is then simply off.
     */
    fun start(api: TinyApi, app: technology.tiny.app.TinyApp? = null) {
        if (_running.value) return
        liveApp = app
        _running.value = true
        _frame.value = null
        _status.value = "finding the necklace…"
        videoJob = scope.launch { connect(api) }
    }

    fun stop() {
        videoJob?.cancel(); videoJob = null
        audioJob?.cancel(); audioJob = null
        clipPlayer?.release(); clipPlayer = null
        _running.value = false
        _liveText.value = ""
        _frame.value = null
        _status.value = "idle"
    }

    // ---- discovery -------------------------------------------------------------

    private suspend fun connect(api: TinyApi) {
        cachedBase?.let { base ->
            if (probe(base)) { _mode.value = Mode.LAN; lanLoop(base); return }
            // Forget a base that stopped answering: DHCP hands the board a new
            // address across reboots, and this object outlives any one session,
            // so the dead one would otherwise be re-probed on every start for
            // the rest of the process's life. (iOS also had to drop it because
            // toggleAudio() dialed the cached key WITHOUT probing; here every
            // read is probe-guarded, so the cost is wasted time, not a wrong
            // dial — which is why this is a smaller fix than iOS's.)
            cachedBase = null
        }
        _status.value = "connecting through the cloud…"
        val id = findDevice(api)
        if (id == null) { _status.value = "no necklace enrolled"; _running.value = false; return }
        deviceId = id
        _mode.value = Mode.REMOTE
        // Try the LAN upgrade in the background while remote frames flow.
        scope.launch {
            val base = discoverBase(api, id) ?: return@launch
            if (probe(base) && _running.value && _mode.value == Mode.REMOTE) {
                cachedBase = base
                _mode.value = Mode.LAN
                videoJob?.cancel()
                videoJob = scope.launch { lanLoop(base) }
            }
        }
        remoteLoop(api, id)
    }

    /**
     * Pick the necklace to talk to — and it must be the LIVE one.
     *
     * A board that gets re-enrolled (a wiped flash loses the device token, and
     * the API mints it exactly once) leaves its old row behind forever: an
     * orphan that is permanently offline and can never be reprovisioned, only
     * revoked. Taking the FIRST `nicla-vision` row therefore leans on registry
     * ordering to stay correct — today `/api/devices` happens to sort newest
     * first, so it works, but nothing in the contract promises that.
     *
     * Aiming at an orphan costs the whole session, not one frame: `remoteLoop`
     * burns all four of its misses on a device that will never answer, and
     * `discoverBase`'s relay `stream` invoke never returns a LAN base, so the
     * fast path is never even tried — the live view fails while a healthy
     * necklace on the same WiFi is serving MJPEG at 20fps.
     *
     * Order explicitly instead: online first, then freshest heartbeat. Pure and
     * `internal` so the ordering is testable without a registry — the decision
     * is which row wins, and that shouldn't need a network to pin.
     * iOS TinyLive.findDeviceId.
     */
    internal fun pickNicla(devices: JSONArray): String? {
        data class Row(val id: String, val online: Boolean, val seen: Double)
        val visions = mutableListOf<Row>()
        for (i in 0 until devices.length()) {
            val dev = devices.optJSONObject(i) ?: continue
            if (dev.optString("platform") != "nicla-vision") continue
            val id = dev.optString("id")
            if (id.isEmpty()) continue
            visions += Row(id, dev.optBoolean("online"), dev.optDouble("last_seen", 0.0))
        }
        return visions
            .sortedWith(compareByDescending<Row> { it.online }.thenByDescending { it.seen })
            .firstOrNull()?.id
    }

    private suspend fun findDevice(api: TinyApi): String? = runCatching {
        val d = api.getJson("/api/devices")
        pickNicla(d.optJSONArray("devices") ?: return null)
    }.getOrNull()

    /** relay invoke → poll ≤ waitMs → parsed reply payload JSON. */
    private suspend fun invoke(api: TinyApi, id: String, prompt: String, waitMs: Long = 20_000): JSONObject? {
        val sent = runCatching {
            api.postJson("/api/devices/relay", JSONObject()
                .put("toDevice", id)
                .put("payload", JSONObject().put("type", "invoke").put("prompt", prompt)))
        }.getOrNull() ?: return null
        val msgId = sent.optString("id"); if (msgId.isEmpty()) return null
        val deadline = System.currentTimeMillis() + waitMs
        while (System.currentTimeMillis() < deadline) {
            delay(1200)
            val r = runCatching { api.getJson("/api/devices/relay?inReplyTo=$msgId") }.getOrNull() ?: continue
            val reply = r.optJSONObject("reply") ?: continue
            return runCatching { JSONObject(reply.optString("payload")) }.getOrNull()
        }
        return null
    }

    private const val FRAME_POLL_TRIES = 16
    private const val FRAME_POLL_EVERY_MS = 1_200L // the warm-sensor firmware answers in ~2-3s

    /**
     * Read one reply payload. Pure, because the two bugs it fixes are both
     * decisions about a string and neither was reachable by a test while they
     * lived inside `invoke`'s polling loop:
     *
     *   1. A payload carrying no `images` used to leave the loop as a bare
     *      `null`, so a board saying "no camera on this device" was reported to
     *      the user as no frame having arrived.
     *   2. A payload that is a bare JSON string — legal on this wire, since the
     *      worker validates with JS `JSON.parse` and that accepts a top-level
     *      string — makes `JSONObject(payload)` throw, so `invoke` returned null
     *      and an answer that had ALREADY arrived burned the whole poll budget
     *      and was then reported as a timeout.
     *
     * Both collapse to: if the device said ANYTHING, stop polling and say what it
     * said. iOS TinyLive.readFrameAnswer.
     */
    fun readFrameAnswer(payload: String): FrameAnswer {
        val obj = runCatching { JSONObject(payload) }.getOrNull()
        val url = obj?.optJSONArray("images")?.optJSONObject(0)?.optString("url")
        // A scheme-less or empty href is not something fetchBitmap can open, so
        // it is prose as far as this panel is concerned — same guard as iOS's
        // `url.scheme != nil`, which exists because `URL(string:)` accepts a
        // bare path.
        if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
            return FrameAnswer.ImageUrl(url)
        }
        return FrameAnswer.Words(RelayReply.text(payload))
    }

    /**
     * One relay round-trip: invoke `frame`, await the reply, fetch the R2 URL —
     * returning the REASON on failure. The DevicesSheet row's tap-to-refresh
     * camera (~4-15s cloud round-trip; the 💎 toolbar card is the live view,
     * this is "check on it"). iOS TinyLive.frameResult.
     *
     * Deliberately not routed through `invoke()`: that helper answers `null` for
     * every one of refused / silent / said-something-else, which is the whole
     * defect. Its other three callers want exactly that collapse, so the fix
     * belongs here rather than in a contract they share.
     */
    suspend fun frameResult(
        api: TinyApi,
        deviceId: String,
        keepGoing: () -> Boolean = { true },
    ): FrameResult {
        val sent = runCatching {
            api.postJson("/api/devices/relay", JSONObject()
                .put("toDevice", deviceId)
                .put("payload", JSONObject().put("type", "invoke").put("prompt", "frame")))
        }.getOrNull()
        val msgId = sent?.optString("id") ?: ""
        if (msgId.isEmpty()) {
            val why = sent?.optString("error")?.takeIf { it.isNotBlank() }
                ?: "Couldn't reach the relay."
            return FrameResult.Failure(FrameFailure.RelayRefused(why))
        }
        val query = java.net.URLEncoder.encode(msgId, "UTF-8")
        repeat(FRAME_POLL_TRIES) {
            delay(FRAME_POLL_EVERY_MS)
            if (!keepGoing()) return FrameResult.Failure(FrameFailure.Cancelled)
            val r = runCatching { api.getJson("/api/devices/relay?inReplyTo=$query") }.getOrNull()
            val payload = r?.optJSONObject("reply")?.optString("payload")
            if (payload.isNullOrEmpty()) return@repeat
            // Past here the device HAS answered. An answer without an image is
            // still an answer, so it must never fall through to the timeout.
            when (val answer = readFrameAnswer(payload)) {
                is FrameAnswer.Words -> return FrameResult.Failure(FrameFailure.DeviceSaid(answer.said))
                is FrameAnswer.ImageUrl -> {
                    val bmp = fetchBitmap(answer.url)
                        ?: return FrameResult.Failure(FrameFailure.Undecodable)
                    return FrameResult.Success(bmp)
                }
            }
        }
        return FrameResult.Failure(
            FrameFailure.NoReply((FRAME_POLL_TRIES * FRAME_POLL_EVERY_MS / 1000).toInt()),
        )
    }

    /**
     * The streaming loop's view of the same call: it retries on its own schedule
     * and has nowhere to show a sentence, so a reason is just a null.
     */
    suspend fun fetchFrame(api: TinyApi, deviceId: String): Bitmap? =
        (frameResult(api, deviceId) as? FrameResult.Success)?.bitmap

    private suspend fun discoverBase(api: TinyApi, id: String): String? {
        val obj = invoke(api, id, "stream") ?: return null
        return Regex("http://[0-9.]+:\\d+").find(obj.optString("result"))?.value
    }

    /**
     * `GET /` on a base answers `{"stream":…}` in <2s when reachable.
     *
     * The failure is LOGGED, not just swallowed. Every reason this can fail —
     * board asleep, wrong subnet, DHCP moved it, the platform refusing the dial
     * outright — collapsed into the same silent `false`, and the only visible
     * symptom was the live view quietly preferring the cloud. iOS spent a long
     * time reading that as a firmware fault; one `TinyLive` line in logcat turns
     * the next occurrence into a grep.
     */
    private fun probe(base: String): Boolean = runCatching {
        val conn = URL("$base/").openConnection() as HttpURLConnection
        conn.connectTimeout = 2000; conn.readTimeout = 2000
        val ok = conn.inputStream.bufferedReader().readText().contains("stream")
        conn.disconnect(); ok
    }.onFailure {
        android.util.Log.w("TinyLive", "LAN probe of $base failed: ${it.javaClass.simpleName}: ${it.message}")
    }.getOrDefault(false)

    // ---- remote mode -------------------------------------------------------------

    private suspend fun remoteLoop(api: TinyApi, id: String) {
        var misses = 0
        while (_running.value && _mode.value == Mode.REMOTE && misses < 4) {
            val obj = invoke(api, id, "frame")
            val url = obj?.optJSONArray("images")?.optJSONObject(0)?.optString("url")
            val bmp = url?.takeIf { it.isNotEmpty() }?.let { fetchBitmap(it) }
            if (bmp != null) {
                _frame.value = bmp
                _status.value = "remote · updating every few seconds"
                misses = 0
            } else misses++
        }
        if (_running.value && _mode.value == Mode.REMOTE) {
            _status.value = "necklace not answering"
            _running.value = false
        }
    }

    private fun fetchBitmap(url: String): Bitmap? = runCatching {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 5000; conn.readTimeout = 8000
        val b = conn.inputStream.use { BitmapFactory.decodeStream(it) }
        conn.disconnect(); b
    }.getOrNull()

    /** Remote ears: 2s WAV via relay `record`, played on the phone. */
    fun remoteListen(api: TinyApi) {
        val id = deviceId ?: return
        if (_listening.value) return
        _listening.value = true
        scope.launch {
            try {
                val obj = invoke(api, id, "record", waitMs = 40_000)
                val url = Regex("https://\\S+\\.wav").find(obj?.optString("result") ?: "")?.value ?: return@launch
                clipPlayer?.release()
                clipPlayer = MediaPlayer().apply {
                    setDataSource(url)
                    setOnPreparedListener { it.start() }
                    prepareAsync()
                }
            } finally {
                _listening.value = false
            }
        }
    }

    // ---- LAN mode ----------------------------------------------------------------

    private fun lanLoop(base: String) {
        _status.value = "connecting to $base…"
        audioJob = scope.launch { lanAudio(base) }
        runCatching {
            val conn = URL("$base/stream").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000; conn.readTimeout = 15000
            val stream = BufferedInputStream(conn.inputStream, 64 * 1024)
            val buf = java.io.ByteArrayOutputStream()
            var prev = -1
            var inJpeg = false
            while (_running.value && _mode.value == Mode.LAN) {
                val b = stream.read()
                if (b < 0) break
                if (!inJpeg) {
                    if (prev == 0xFF && b == 0xD8) {   // SOI
                        inJpeg = true
                        buf.reset(); buf.write(0xFF); buf.write(b)
                    }
                } else {
                    buf.write(b)
                    if (prev == 0xFF && b == 0xD9) {   // EOI
                        inJpeg = false
                        val bytes = buf.toByteArray()
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let {
                            _frame.value = it
                            _status.value = "live"
                        }
                    }
                }
                prev = b
            }
            conn.disconnect()
        }
        if (_running.value && _mode.value == Mode.LAN) {
            _status.value = "stream ended (5 min session cap)"
            _running.value = false
        }
    }

    /**
     * Read the board's PCM and BOTH play it and read it — the words used to be
     * decoded, written to the speaker and discarded (iOS `7d81ac87` parity, with
     * `f0c524dd`'s corrections folded in from the start).
     *
     * Conditioning happens ONCE, before either consumer: the speaker and the
     * recognizer want the same DC-corrected, level-corrected audio, and at the
     * board's native -40 dBFS the recognizer returns nothing at all.
     *
     * ⚠️ This is where Android genuinely differs from iOS, and it is not a
     * shortcut. There is no `append(buffer)` on `SpeechRecognizer`: it reads its
     * own audio. Since API 33 it will read a caller's stream instead, via
     * `EXTRA_AUDIO_SOURCE` + a `ParcelFileDescriptor` pipe — so the board's PCM
     * is written down a pipe the recognizer owns the read end of. The phone's
     * microphone is never opened here, which is why this cannot collide with
     * VoiceMode or a [PhoneRecorder] take over [MicClaim].
     */
    private suspend fun lanAudio(base: String) {
        val track = runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(16000)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(AudioTrack.getMinBufferSize(
                    16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT) * 2)
                .build()
        }.getOrNull() ?: return
        track.play()
        val app = liveApp
        val scribe = if (app != null && _transcribe.value) LiveScribe(app) else null
        val floats = FloatArray(4096)
        val out = ByteArray(8192)
        var peakHold = 0f
        var gain = 1f
        runCatching {
            val conn = URL("$base/audio").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000; conn.readTimeout = 15000
            val stream = conn.inputStream
            val chunk = ByteArray(4096)
            while (currentCoroutineContextActive() && _running.value && _mode.value == Mode.LAN) {
                val n = stream.read(chunk)
                if (n < 0) break
                // Decode + DC-correct once, then level-correct once. Both consumers
                // below read the RESULT: at the board's native level the recognizer
                // transcribes nothing, and the DC offset makes every level
                // measurement read the same number (LiveTranscribe.decode).
                val samples = LiveTranscribe.decode(chunk, n, floats)
                if (samples <= 0) continue
                peakHold = LiveTranscribe.nextPeakHold(peakHold, LiveTranscribe.rms(floats, samples))
                gain = LiveTranscribe.gainFor(peakHold, gain)
                val safe = LiveTranscribe.safeGain(gain, LiveTranscribe.peak(floats, samples))
                for (i in 0 until samples) {
                    val v = (floats[i] * safe).coerceIn(-1f, 1f)
                    val s = (v * 32767f).toInt()
                    out[i * 2] = (s and 0xFF).toByte()
                    out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
                }
                track.write(out, 0, samples * 2)
                scribe?.feed(out, samples * 2)
            }
            conn.disconnect()
        }
        // Close the segment before tearing down, or the last thing said on the
        // stream is dropped — a stream's final act is usually falling quiet, so
        // this is the common path, not an edge case.
        scribe?.close()
        track.release()
        _liveText.value = ""
    }

    private fun currentCoroutineContextActive(): Boolean = scope.isActive
}
