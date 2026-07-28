package technology.tiny.app.voice

import android.Manifest
import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import androidx.annotation.RequiresPermission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.sqrt

/**
 * VoiceCall — native speech-to-speech with a tiny (docs/voice-sessions-design.md),
 * the Android twin of iOS VoiceCall.swift / web lib/voice/realtime.ts.
 *
 * Talks to the worker's VoiceSession Durable Object over a single OkHttp
 * WebSocket:
 *   - up:   mic PCM16 @ 24 kHz mono as binary frames (the DO does
 *           input_audio_buffer.append server-side; we send raw bytes)
 *   - down: assistant audio as binary PCM16 frames → AudioTrack streaming
 *           playback; JSON control frames (transcripts, barge_in, error)
 *
 * The DO owns semantic VAD, tool routing, and journaling — the phone stays
 * dumb: capture, send, play, render transcript. Barge-in = flush the AudioTrack
 * the moment the server says the user started talking.
 *
 * v1 is BYO-OpenAI-key ONLY: POST /api/voice/session carries the same
 * x-tiny-model-* headers chat sends; a 402 → status = ByokRequired so the UI
 * can point the user at model settings instead of a dead error.
 *
 * Self-contained (no ChatViewModel / MainActivity coupling): the caller passes
 * base URL, token, and BYOK headers; state is a StateFlow the Compose surface
 * collects.
 */
class VoiceCall {
    enum class Phase { IDLE, CONNECTING, LIVE, ENDED, ERROR, BYOK_REQUIRED }

    data class State(
        val phase: Phase = Phase.IDLE,
        val userTranscript: String = "",
        val assistantTranscript: String = "",
        val level: Float = 0f,          // mic input 0..1 for the meter
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    // ── Inline-chat hooks (docs/voice-sessions-design.md, inline-chat) ────────
    // The call is part of the textual chat now: the surface wires these to
    // ChatViewModel's voice-turn methods so every spoken/typed user turn and
    // every assistant reply lands in the thread as a real ChatMessage, and
    // tool_call frames run on the same device executors chat uses (iOS
    // VoiceCall.swift onUserTranscript/… parity). All hooks are invoked on the
    // OkHttp WS READER THREAD — receivers must hop to main themselves before
    // touching Compose state.
    var onUserTranscript: ((String) -> Unit)? = null
    var onAssistantDelta: ((String) -> Unit)? = null
    var onResponseStarted: (() -> Unit)? = null
    var onResponseDone: (() -> Unit)? = null
    var onBargeIn: (() -> Unit)? = null
    var onToolCall: ((id: String, name: String, args: JSONObject) -> Unit)? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ws: WebSocket? = null
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var captureJob: Job? = null
    // Playback runs on its OWN coroutine, fed by this queue, so a full AudioTrack
    // buffer NEVER blocks OkHttp's single WS reader thread. If write() ran inline
    // in onMessage(), a backlog of assistant audio would wedge the reader and the
    // `barge_in` control frame couldn't be read until the tiny finished its whole
    // sentence — i.e. talking over the tiny didn't cut it off. Draining here + a
    // drainToken generation counter (bumped on barge-in) makes the cut-off instant.
    private var playbackJob: Job? = null
    private var audioQueue: Channel<Pair<ByteArray, Int>>? = null
    @Volatile private var drainToken = 0
    // Set on barge-in, cleared when the NEXT turn starts (response_started).
    // Bumping drainToken only discards frames ALREADY queued at the instant of
    // the barge; but response.cancel isn't instant upstream — OpenAI keeps
    // emitting audio.delta for the cancelled response for a short window (the
    // relay documents this race, voice.ts:462), and the relay forwards each one.
    // Those late frames arrive AFTER the barge_in control frame, so they'd be
    // stamped with the freshly-bumped (now-current) drainToken and PLAY — the
    // tiny keeps talking past the interruption. Gate on this flag to drop every
    // frame from a barged response until a genuinely new turn begins, mirroring
    // the relay's own `responseActive` gate (false on barge, true on response.created).
    @Volatile private var suppressAudio = false

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)      // WS stays open
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    /**
     * Start a call. `base` is Config.serverBase (https origin), `token` the auth
     * JWT, `modelHeaders` = ModelConfigStore.headers() for BYOK. Mic permission
     * MUST already be granted by the caller.
     */
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    fun start(
        base: String,
        tiny: String,
        token: String?,
        modelHeaders: Map<String, String>,
        // Client-built continuity block (memories + recent turns) — rides into
        // the session instructions so the voice agent starts knowing what the
        // chat agent knows.
        context: String? = null,
    ) {
        val phase = _state.value.phase
        if (phase == Phase.CONNECTING || phase == Phase.LIVE) return
        _state.value = State(phase = Phase.CONNECTING)
        scope.launch {
            val session = createSession(base, tiny, token, modelHeaders, context)
            if (_state.value.phase != Phase.CONNECTING) return@launch // hung up mid-connect
            when (session) {
                is SessionResult.Byok ->
                    _state.value = _state.value.copy(
                        phase = Phase.BYOK_REQUIRED,
                        error = "Voice needs your own OpenAI API key. Add one in Settings → Model, then call again.",
                    )
                is SessionResult.Failure ->
                    _state.value = _state.value.copy(phase = Phase.ERROR, error = session.message)
                is SessionResult.Success -> {
                    if (!startAudio()) {
                        _state.value = _state.value.copy(
                            phase = Phase.ERROR,
                            error = "Couldn't open the microphone.",
                        )
                        stop()
                        return@launch
                    }
                    connect(session.wsUrl)
                }
            }
        }
    }

    fun stop() {
        captureJob?.cancel(); captureJob = null
        playbackJob?.cancel(); playbackJob = null
        audioQueue?.close(); audioQueue = null
        suppressAudio = false // never carry a barge-in mute into the next call
        runCatching { ws?.close(1000, "bye") }
        ws = null
        runCatching { record?.stop() }
        runCatching { record?.release() }
        record = null
        runCatching { track?.stop() }
        runCatching { track?.release() }
        track = null
        if (_state.value.phase != Phase.ERROR && _state.value.phase != Phase.BYOK_REQUIRED) {
            _state.value = _state.value.copy(phase = Phase.ENDED, level = 0f)
        } else {
            _state.value = _state.value.copy(level = 0f)
        }
    }

    /** Release everything — call when the surface is dismissed for good. */
    fun dispose() {
        stop()
        scope.cancel()
    }

    /**
     * Clear the in-call strip: tear the call down AND reset to a fresh IDLE
     * state so the surface's strip disappears and a new call can start clean.
     * stop() deliberately preserves ERROR/BYOK_REQUIRED so the user can read
     * why the call died — this is the explicit "Dismiss" acknowledging it.
     */
    fun dismiss() {
        stop()
        _state.value = State()
    }

    /**
     * A TYPED composer message joins the live call (inline-chat design): the
     * DO forwards it as a user turn and the tiny answers in voice. Returns
     * true when it was actually sent (call LIVE + non-blank text) — the caller
     * falls back to the normal chat turn otherwise.
     */
    fun sendUserText(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty() || _state.value.phase != Phase.LIVE) return false
        val sock = ws ?: return false
        return sock.send(JSONObject().put("type", "user_text").put("text", t).toString())
    }

    /** Return a device-tool result to the model (answers an onToolCall). */
    fun sendToolResult(id: String, output: JSONObject) {
        ws?.send(JSONObject().put("type", "tool_result").put("id", id).put("output", output).toString())
    }

    // ── Session mint (POST /api/voice/session) ────────────────────────────────

    private sealed interface SessionResult {
        data class Success(val wsUrl: String) : SessionResult
        data object Byok : SessionResult
        data class Failure(val message: String) : SessionResult
    }

    private suspend fun createSession(
        base: String,
        tiny: String,
        token: String?,
        modelHeaders: Map<String, String>,
        context: String? = null,
    ): SessionResult = withContext(Dispatchers.IO) {
        val body = JSONObject().put("tiny", tiny)
            .apply { if (!context.isNullOrBlank()) put("context", context) }
            .toString()
            .toRequestBody("application/json".toMediaType())
        val builder = Request.Builder()
            .url("$base/api/voice/session")
            .post(body)
        // Announce the native client (same header as TinyApi chat requests): the
        // server keys the voice TOOL ROSTER on this (lib/voice/tools.ts). Without
        // it the session falls back to the WEB roster — the model gets the web
        // render_ui contract (JSX code, but this device renders props-only native
        // cards via voiceRenderUi) and is NEVER told `screenshot` exists, so it
        // can't call the on-device capture runVoiceTool already implements. iOS
        // sends `tiny-ios` here for the identical reason (VoiceCall.swift).
        builder.header("x-tiny-session", "tiny-android")
        token?.let { builder.header("Authorization", "Bearer $it") }
        modelHeaders.forEach { (k, v) -> builder.header(k, v) }

        runCatching {
            http.newCall(builder.build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val obj = runCatching { JSONObject(text) }.getOrNull()
                if (resp.code == 402 || obj?.optString("code") == "byok_required") {
                    return@use SessionResult.Byok
                }
                val wsUrl = obj?.optString("wsUrl").orEmpty()
                if (resp.isSuccessful && wsUrl.isNotEmpty()) {
                    SessionResult.Success(wsUrl)
                } else {
                    SessionResult.Failure(
                        obj?.optString("error")?.takeIf { it.isNotEmpty() }
                            ?: "Couldn't start the call (HTTP ${resp.code})",
                    )
                }
            }
        }.getOrElse { SessionResult.Failure("No response — check your connection.") }
    }

    // ── Audio: 24 kHz PCM16 mono capture (AudioRecord) + playback (AudioTrack) ──

    @SuppressLint("MissingPermission")
    private fun startAudio(): Boolean {
        val minIn = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minIn <= 0) return false
        val bufIn = maxOf(minIn, FRAME_BYTES * 4)
        val rec = runCatching {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION, // AEC/NS — keeps the tiny's own audio out of the mic
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufIn,
            )
        }.getOrNull() ?: return false
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return false }
        record = rec

        val minOut = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val tk = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minOut, FRAME_BYTES * 8))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = tk
        tk.play()

        // Drain the audio queue on a dedicated coroutine. The blocking write()
        // lives HERE, off the WS reader thread, so control frames (barge_in)
        // are always read promptly. A frame stamped with a stale drainToken —
        // one enqueued before the latest barge-in — is dropped, not played.
        val queue = Channel<Pair<ByteArray, Int>>(Channel.UNLIMITED)
        audioQueue = queue
        playbackJob = scope.launch(Dispatchers.IO) {
            for ((arr, token) in queue) {
                if (token != drainToken) continue // superseded by a barge-in — skip
                val tk2 = track ?: break
                runCatching { tk2.write(arr, 0, arr.size) }
            }
        }

        rec.startRecording()
        captureJob = scope.launch(Dispatchers.IO) {
            val buf = ShortArray(FRAME_SAMPLES)
            while (record != null) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                val sock = ws ?: continue
                // RMS level for the orb (cheap, off the shorts we already have).
                var sum = 0.0
                for (i in 0 until n) { val s = buf[i] / 32768.0; sum += s * s }
                val level = min(1.0, sqrt(sum / n) * 4).toFloat()
                _state.value = _state.value.copy(level = level)
                // Shorts → little-endian bytes.
                val bytes = ByteArray(n * 2)
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    bytes[i * 2] = (v and 0xFF).toByte()
                    bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                }
                sock.send(bytes.toByteString())
            }
        }
        return true
    }

    private fun playAudio(bytes: ByteString) {
        // A barged (cancelled) response can still push audio.delta frames down
        // the wire until the next turn opens — drop them, or the tiny talks over
        // the user's interruption. See suppressAudio above.
        if (suppressAudio) return
        val arr = bytes.toByteArray()
        if (arr.isEmpty()) return
        // Hand the frame to the playback coroutine (blocking write() runs THERE,
        // never on this WS reader thread) tagged with the current drainToken so a
        // later barge-in can discard it. trySend can't fail on an UNLIMITED channel.
        audioQueue?.trySend(arr to drainToken)
    }

    /**
     * Barge-in: stop the tiny mid-sentence the instant the server says the user
     * started talking. Bumping drainToken makes the playback coroutine skip every
     * already-queued frame; pause()+flush() dumps the frames AudioTrack has itself
     * buffered (the ones the drain loop already handed off). Runs on the WS reader
     * thread, which is now never blocked on write() — so the cut is immediate.
     */
    private fun flushPlayback() {
        drainToken++ // supersede everything queued before this barge-in
        suppressAudio = true // and drop late frames the cancelled response is still emitting
        val tk = track ?: return
        runCatching { tk.pause(); tk.flush(); tk.play() }
    }

    // ── WebSocket ──────────────────────────────────────────────────────────

    private fun connect(wsUrl: String) {
        val req = Request.Builder().url(wsUrl).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                _state.value = _state.value.copy(phase = Phase.LIVE)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleControl(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                playAudio(bytes)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (_state.value.phase == Phase.LIVE) stop()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (_state.value.phase == Phase.LIVE || _state.value.phase == Phase.CONNECTING) {
                    // Surface WHY, not a mute "call ended" — a failed upgrade
                    // carries the relay's reason in its JSON body (e.g. the
                    // DO's "openai connect failed: …"), and t.message covers
                    // plain transport drops. This silence hid a server bug
                    // that killed every call behind "call ended".
                    val body = response?.body?.let { b -> runCatching { b.string() }.getOrNull() }
                    val detail = body?.let { runCatching { JSONObject(it).optString("error") }.getOrNull() }
                        ?.takeIf { it.isNotEmpty() }
                        ?: t.message?.takeIf { it.isNotEmpty() }
                    _state.value = _state.value.copy(
                        phase = Phase.ERROR,
                        error = detail?.let { "Call failed — $it" } ?: "Call failed — connection dropped.",
                    )
                }
                stop()
            }
        })
    }

    private fun handleControl(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (obj.optString("type")) {
            "user_transcript" -> {
                _state.value = _state.value.copy(userTranscript = obj.optString("text", _state.value.userTranscript))
                onUserTranscript?.invoke(obj.optString("text"))
            }
            // A fresh assistant turn began — clear the previous turn's text so
            // back-to-back replies (e.g. either side of a tool call, with no
            // user turn between) don't concatenate into one run-on line.
            "response_started" -> {
                suppressAudio = false // a genuinely new turn — let its audio through
                _state.value = _state.value.copy(assistantTranscript = "")
                onResponseStarted?.invoke()
            }
            "assistant_transcript" -> {
                val delta = obj.optString("delta")
                _state.value = _state.value.copy(assistantTranscript = _state.value.assistantTranscript + delta)
                if (delta.isNotEmpty()) onAssistantDelta?.invoke(delta)
            }
            "response_done" -> onResponseDone?.invoke() // response_started clears the strip text for the next turn
            "barge_in" -> {
                flushPlayback()
                _state.value = _state.value.copy(assistantTranscript = "")
                onBargeIn?.invoke()
            }
            // Device tool routed down the call (same executors as chat) — the
            // surface runs it and answers via sendToolResult (iOS parity).
            "tool_call" -> {
                val id = obj.optString("id")
                val name = obj.optString("name")
                if (id.isNotEmpty() && name.isNotEmpty()) {
                    onToolCall?.invoke(id, name, obj.optJSONObject("args") ?: JSONObject())
                }
            }
            "error" ->
                _state.value = _state.value.copy(error = obj.optString("error", "error"))
        }
    }

    companion object {
        private const val SAMPLE_RATE = 24_000
        private const val FRAME_SAMPLES = 1024        // ~43ms per frame at 24kHz
        private const val FRAME_BYTES = FRAME_SAMPLES * 2
    }
}
