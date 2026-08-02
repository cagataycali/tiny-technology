/**
 * 🕶️ GlassesLive — the Android live HUD core (iOS WearablesLive.swift
 * GlassesLive parity). The 🕶 toolbar icon (visible when linked) opens a
 * floating card that streams the glasses camera LIVE, with an on-device
 * transcript of what the glasses hear.
 *
 * How each piece maps to the hardware:
 *  - VIDEO: a DAT camera stream — the raw I420 frames the recorder encodes
 *    are decoded here to Bitmaps instead (throttled to ~11fps; a HUD needs
 *    smooth-enough, not every frame), through the same session dance
 *    meta_take_photo runs.
 *  - AUDIO: the glasses are the phone's Bluetooth microphone at the SYSTEM
 *    level — so the platform SpeechRecognizer (prefer-offline, the exact
 *    recipe meta_listen uses) transcribes what the GLASSES hear. The DAT SDK
 *    itself exposes no audio API (0.8.0).
 *  - ANGLE/IMU: NOT exposed by DAT 0.8.0 — stated here so nobody hunts for it.
 *
 * Display-only: no frame and no transcript ever leaves the phone from here
 * (meta_take_photo/meta_record_video upload on the agent's explicit ask).
 */
package technology.tiny.app.fleet

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.addStream
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

object GlassesLive {
    private val _frame = MutableStateFlow<Bitmap?>(null)
    val frame: StateFlow<Bitmap?> = _frame

    private val _status = MutableStateFlow("connecting…")
    val status: StateFlow<String> = _status

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running

    private val _transcribing = MutableStateFlow(false)
    val transcribing: StateFlow<Boolean> = _transcribing

    private val _transcript = MutableStateFlow("")
    val transcript: StateFlow<String> = _transcript

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var startJob: Job? = null
    private var collectJob: Job? = null
    private var stateJob: Job? = null
    private var errorJob: Job? = null
    private var watchdogJob: Job? = null
    @Volatile private var lastFrameAtMs = 0L
    private var transcriptionJob: Job? = null
    private var session: DeviceSession? = null
    private var stream: Stream? = null
    private var lastDecodeUs = Long.MIN_VALUE

    fun start(context: Context) {
        if (_running.value || startJob?.isActive == true) return
        _lastError.value = null
        _status.value = "connecting…"
        val app = context.applicationContext
        startJob = scope.launch { startInternal(app) }
    }

    private suspend fun startInternal(context: Context) {
        try {
            if (!WearablesBridge.ensureInitialized(context)) {
                throw WearablesCaptureException("Bluetooth permission missing — open settings → meta glasses first")
            }
            if (Wearables.registrationState.first() != RegistrationState.REGISTERED) {
                throw WearablesCaptureException("No Meta glasses linked — link them in settings first")
            }
            val camera = CompletableDeferred<PermissionStatus>()
            Wearables.checkPermissionStatus(Permission.CAMERA)
                .onSuccess { camera.complete(it) }
                .onFailure { error, _ -> camera.completeExceptionally(WearablesCaptureException(error.description)) }
            if (camera.await() != PermissionStatus.Granted) {
                throw WearablesCaptureException("Glasses camera permission not granted — grant it in settings → meta glasses")
            }

            val sessionDeferred = CompletableDeferred<DeviceSession>()
            Wearables.createSession(AutoDeviceSelector())
                .onSuccess { sessionDeferred.complete(it) }
                .onFailure { error, _ -> sessionDeferred.completeExceptionally(WearablesCaptureException("session: ${error.description}")) }
            val s = sessionDeferred.await()
            session = s
            s.start()
            withTimeout(25_000) { s.state.first { it == DeviceSessionState.STARTED } }

            val streamDeferred = CompletableDeferred<Stream>()
            s.addStream(StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 24))
                .onSuccess { streamDeferred.complete(it) }
                .onFailure { error, _ -> streamDeferred.completeExceptionally(WearablesCaptureException("stream: ${error.description}")) }
            val st = streamDeferred.await()
            stream = st
            collectJob = scope.launch { st.videoStream.collect { publish(it) } }
            errorJob = scope.launch {
                // iOS listens to errorPublisher (WearablesLive.swift:74) —
                // without this, a stream that starts but can't deliver frames
                // fails into a silent black card.
                st.errorStream.collect { e ->
                    android.util.Log.w("GlassesLive", "stream error: $e")
                    _lastError.value = e.toString()
                }
            }
            stateJob = scope.launch {
                // Tap detection (GlassesEvents' rule) + an honest status line
                // while the user has the stream paused from the glasses side.
                var prev: StreamState? = null
                st.state.collect { state ->
                    GlassesEvents.onStreamTransition(prev, state)
                    prev = state
                    if (state == StreamState.PAUSED) _status.value = "paused — tap the glasses to resume"
                    else if (state == StreamState.STREAMING) _status.value = "live"
                }
            }
            watchdogJob = scope.launch {
                // ⚠️ MEASURED (mock, Pixel 10): folding the glasses mid-stream
                // produces NO stream error and NO state transition — the SDK
                // just goes quiet, and the card froze on the last frame while
                // claiming "live". Frames are the only honest liveness signal,
                // so their absence flips the card to the truth; a resumed
                // stream restores itself through publish().
                while (kotlinx.coroutines.currentCoroutineContext().isActive) {
                    kotlinx.coroutines.delay(2_000)
                    if (!_running.value) continue
                    val last = lastFrameAtMs
                    if (last != 0L &&
                        android.os.SystemClock.elapsedRealtime() - last > 4_000 &&
                        _frame.value != null
                    ) {
                        _frame.value = null
                        _status.value = "no frames — the glasses may be folded, asleep or out of range"
                    }
                }
            }
            st.start()
            withTimeout(25_000) { st.state.first { it == StreamState.STREAMING } }
            _status.value = "live"
            _running.value = true
            // ⚠️ Deliberately NOT auto-starting the transcript (iOS c8's
            // lesson, kept as posture here): the mic is an explicit tap on
            // the card — better privacy, and no route-flip race at open.
        } catch (t: Throwable) {
            _lastError.value = t.message ?: "could not start the glasses stream"
            _status.value = "failed"
            stopStreamOnly()
        }
    }

    private var framesSeen = 0L

    /** Runs on the collector coroutine — decode throttled, publish the Bitmap. */
    private fun publish(frame: VideoFrame) {
        // First-frame facts + decode failures only — the ONE log line that
        // answers "is the HUD black because no frames arrive, or because the
        // decode eats them?" without spamming 24fps.
        if (framesSeen++ == 0L) {
            android.util.Log.i(
                "GlassesLive",
                "first frame: ${frame.width}x${frame.height} pts=${frame.presentationTimeUs} " +
                    "buf=${frame.buffer.capacity()} (i420 needs ${frame.width * frame.height * 3 / 2})",
            )
        }
        val pts = frame.presentationTimeUs
        if (lastDecodeUs != Long.MIN_VALUE && pts - lastDecodeUs < 90_000) return
        lastDecodeUs = pts
        lastFrameAtMs = android.os.SystemClock.elapsedRealtime()
        val jpeg = GlassesRecorderBridge.i420ToJpeg(frame.buffer, frame.width, frame.height)
        if (jpeg == null) {
            android.util.Log.w("GlassesLive", "i420ToJpeg returned null (frame ${frame.width}x${frame.height}, buf=${frame.buffer.capacity()})")
            return
        }
        val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return
        _frame.value = bitmap
        // Frames prove liveness — a stream the watchdog declared dead heals
        // itself the moment they return (unfolded, back in range).
        if (_status.value != "live" && _running.value) _status.value = "live"
    }

    fun stop() {
        stopTranscription()
        startJob?.cancel(); startJob = null
        stopStreamOnly()
        _running.value = false
        _frame.value = null
        _transcript.value = ""
    }

    private fun stopStreamOnly() {
        collectJob?.cancel(); collectJob = null
        stateJob?.cancel(); stateJob = null
        errorJob?.cancel(); errorJob = null
        watchdogJob?.cancel(); watchdogJob = null
        runCatching { stream?.stop() }; stream = null
        runCatching { session?.stop() }; session = null
        lastDecodeUs = Long.MIN_VALUE
        lastFrameAtMs = 0L
        framesSeen = 0L
    }

    // ── Transcript: on-device STT over the glasses' BT mic ────────────────
    // WearablesListenerBridge's exact recognizer recipe (one path for both
    // surfaces); its sessions end at each silence, so this restarts until
    // toggled off — the continuous strip meta_listen can also ride.

    fun toggleTranscription(context: Context) {
        if (_transcribing.value) { stopTranscription(); return }
        if (!_running.value) return
        val app = context.applicationContext
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            _lastError.value = "microphone permission needed for the transcript"
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            _lastError.value = "speech recognition unavailable on this phone"
            return
        }
        _transcribing.value = true
        // SpeechRecognizer is main-thread-only, start to finish.
        transcriptionJob = scope.launch(Dispatchers.Main) {
            // Hear through the GLASSES when they're connected (BtMic.kt —
            // iOS `.allowBluetooth` parity); phone mic otherwise, as before.
            val viaBt = BtMic.acquire(app)
            if (viaBt) kotlinx.coroutines.delay(800)
            val (recognizer, _) = WearablesListenerBridge.newRecognizer(app)
            try {
                val intent = WearablesListenerBridge.freeFormIntent()
                while (isActive && _transcribing.value) {
                    val segment = WearablesListenerBridge.once(recognizer, intent)
                    if (segment.isNotBlank()) {
                        _transcript.value = (_transcript.value + " " + segment.trim()).trim()
                    }
                }
            } finally {
                runCatching { recognizer.destroy() }
                BtMic.release(app)
            }
        }
    }

    private fun stopTranscription() {
        _transcribing.value = false
        transcriptionJob?.cancel(); transcriptionJob = null
    }
}
