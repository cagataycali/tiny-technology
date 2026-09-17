/**
 * 🎥 GlassesRecorderBridge — Android's meta_record_video executor (iOS
 * WearablesRecorder.swift parity). TOGGLE semantics: the agent's first call
 * starts a recording (posts {recording:true} fast), the second stops it —
 * the MP4 finalizes, uploads once as video/mp4, up to 4 sampled frames ride
 * along, and {ok,url,frames,seconds} posts to the mailbox. Auto-stop at 28s
 * (the media store's 6MB cap); an auto-stopped clip waits as `pending` for
 * the agent's second call — but only for PENDING_TTL_MS, after which it is
 * discarded and the agent is TOLD (a clip from an hour ago is not an answer
 * to a question asked now).
 *
 * The DAT stream hands raw I420 ByteBuffers (+width/height/presentationTimeUs)
 * — they feed MediaCodec's flexible YUV input directly, drained into a
 * MediaMuxer MP4. No bitmap round-trip on the hot path; the ≤4 sampled
 * JPEGs go I420→NV21→YuvImage off the same frames.
 */
package technology.tiny.app.fleet

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import com.meta.wearable.dat.camera.addStream
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.types.RegistrationState
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.TinyApp

object GlassesRecorderBridge {
    private const val MAX_SECONDS = 28L
    private const val MAX_BYTES = 6 * 1024 * 1024

    private val mutex = Mutex()
    private var active: Recording? = null

    /** A finalized clip held in MEMORY, not yet uploaded (iOS `Finished`). */
    class Finished(val mp4: ByteArray, val frameJpegs: List<ByteArray>, val seconds: Int)

    /**
     * What the auto-stop parks for a call that may never come (iOS `Parked`).
     *
     * ⚠️ `Clip` is NOT uploaded. Finalizing is forced at MAX_SECONDS (the MP4
     * has to close), but uploading is not — and the START call was already
     * answered, so at park time nobody has asked for these bytes. Uploading
     * then meant a clip nobody collected sat in R2 forever: the worker has
     * MEDIA.put/head/get and **no delete** (worker/src/media.ts),
     * so there was no reclaim path even in principle.
     */
    sealed class Parked {
        class Clip(val done: Finished) : Parked()
        class Failure(val payload: JSONObject) : Parked()
    }

    /**
     * What the auto-stop left for the agent's second call — paired with WHEN it
     * was parked, because it does not wait forever. One value, not two fields,
     * so no assignment can park unstamped.
     */
    private var pending: Pair<Parked, Long>? = null

    /**
     * How long an auto-stopped clip stays collectable (iOS
     * `GlassesRecorder.pendingTTL` parity — a test pins them equal).
     *
     * ⚠️ NOT derived from the server's poll budget, deliberately: the START
     * call was already answered, so nobody is polling for this clip. The
     * deadline that matters is the USER'S. Without one, a clip that
     * auto-stopped an hour ago answers the next meta_record_video call and the
     * agent narrates a moment nobody asked about — the same rot as an expired
     * consent grant, on video. Checked at COLLECT, no timer: nothing is
     * blocked waiting, so there is no listener to tell early.
     */
    const val PENDING_TTL_MS = 180_000L

    /** Verbatim on both phones: expired means DISCARDED, and a new recording started. */
    const val STALE_NOTE =
        "⏱️ An earlier recording auto-stopped and expired uncollected, so it was discarded — " +
            "this call started a NEW recording. Don't describe the old clip; call again to stop this one."

    val isRecording: Boolean get() = active != null

    /**
     * Sign-out: drop everything this object holds for the OUTGOING user (iOS
     * `GlassesRecorder.endSession()` parity — a test pins both wired).
     *
     * A parked clip is hosted video of the previous user's surroundings at a
     * public-but-unguessable /media/ URL, collectable by whoever signs in next
     * with one meta_record_video call. A rolling recording is worse: it keeps
     * the glasses streaming past sign-out and would upload under the NEXT
     * token to arrive (`authed()` reads tokenProvider() at call time). Nobody
     * is owed a result — the turn that asked for it is gone with the session.
     *
     * ⚠️ Takes the SAME mutex every other path takes. Without it this races
     * the auto-stop coroutine, which parks its finished clip under
     * `mutex.withLock` — losing that race re-parks a clip we just dropped, and
     * the leak comes back with no trace in the diff. That is why the sign-out
     * caller (`Panels.kt`, already inside `scope.launch`) awaits it.
     */
    suspend fun endSession() = mutex.withLock {
        pending = null
        active?.teardown()
        active = null
    }

    suspend fun runTool(app: TinyApp, toolUseId: String) {
        val payload = try {
            toggle(app)
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "recording failed on the device")
        }
        runCatching {
            app.api.postJson(
                "/api/chat/tool-result",
                JSONObject().put("toolUseId", toolUseId).put("payload", payload.toString()),
            )
        }
    }

    /**
     * The shared toggle core (iOS GlassesRecorder.toggle(token:) parity):
     * chat's runTool posts the result to the mailbox; the voice call answers
     * over its own WS (MainActivity runVoiceTool). Caller handles throws.
     */
    internal suspend fun toggle(app: TinyApp): JSONObject = mutex.withLock {
        pending?.let { (parked, parkedAt) ->
            pending = null
            // Collect only while it is still THIS conversation's clip; a stale
            // one is dropped and we fall through to START — and the agent is
            // TOLD, since otherwise it gets a bare {recording:true} and cannot
            // know a clip it once asked for was thrown away.
            if (System.currentTimeMillis() - parkedAt < PENDING_TTL_MS) {
                // THE UPLOAD HAPPENS HERE, not at park time: this is the first
                // moment anyone has actually asked for the bytes. An expired
                // clip therefore never reaches R2 at all — the only reclaim
                // story available, since the worker cannot delete.
                return when (parked) {
                    is Parked.Clip -> upload(app, parked.done)
                    is Parked.Failure -> parked.payload
                }
            }
            return start(app).put("note", STALE_NOTE)
        }
        active?.let { rec -> active = null; return rec.stopAndUpload(app) }
        start(app)
    }

    /**
     * The upload half (iOS `upload(_:token:)` parity) — runs when someone is
     * actually waiting for the URL, which is why it lives on the bridge rather
     * than inside `Recording`: the recording object is long gone by then.
     */
    private suspend fun upload(app: TinyApp, done: Finished): JSONObject {
        val b64 = android.util.Base64.encodeToString(done.mp4, android.util.Base64.NO_WRAP)
        val up = app.api.postJson(
            "/api/media",
            JSONObject().put("data", b64).put("contentType", "video/mp4"),
        )
        val url = up.optString("url").takeIf { it.isNotEmpty() }
            ?: return JSONObject().put("ok", false)
                .put("error", up.optString("error").ifEmpty { "clip upload failed" })
        // Frames are best-effort — a clip with no stills is still a clip.
        val frames = JSONArray()
        for (jpeg in done.frameJpegs) {
            runCatching {
                val fb64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP)
                val fu = app.api.postJson(
                    "/api/media",
                    JSONObject().put("data", fb64).put("contentType", "image/jpeg"),
                )
                fu.optString("url").takeIf { it.isNotEmpty() }?.let { frames.put(it) }
            }
        }
        return JSONObject().put("ok", true).put("url", url)
            .put("frames", frames).put("seconds", done.seconds)
    }

    private suspend fun start(app: TinyApp): JSONObject {
        if (!WearablesBridge.ensureInitialized(app)) {
            return JSONObject().put("ok", false)
                .put("error", "Bluetooth permission missing — open the glasses settings first")
        }
        if (Wearables.registrationState.first() != RegistrationState.REGISTERED) {
            return JSONObject().put("ok", false)
                .put("error", "No Meta glasses linked — link them in settings first")
        }
        // Asks via the Meta AI app when it isn't granted yet (iOS
        // WearablesRecorder.swift:232 parity). This rail answers the agent in
        // JSON rather than throwing, so the reason is carried into `error`.
        try {
            WearablesBridge.ensureCameraPermission(app)
        } catch (t: Throwable) {
            return JSONObject().put("ok", false)
                .put("error", t.message ?: "the glasses camera isn't granted")
        }

        val rec = Recording(app)
        return try {
            rec.begin()
            active = rec
            JSONObject().put("ok", true).put("recording", true)
        } catch (t: Throwable) {
            rec.teardown()
            JSONObject().put("ok", false).put("error", t.message ?: "could not start the glasses stream")
        }
    }

    /** One in-flight recording: session + stream + encoder + sampled stills. */
    private class Recording(private val app: TinyApp) {
        private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        private var session: DeviceSession? = null
        private var stream: Stream? = null
        private var collectJob: Job? = null

        private val file = File.createTempFile("glasses-", ".mp4", app.cacheDir)
        private var codec: MediaCodec? = null
        private var muxer: MediaMuxer? = null
        private var track = -1
        private var muxerStarted = false
        private var firstPtsUs = -1L
        private var lastPtsUs = -1L
        private val jpegs = ArrayList<ByteArray>(4)
        private var lastSampleUs = Long.MIN_VALUE

        suspend fun begin() {
            // One door for the session (WearablesBridge.openSession): it uses
            // the long-lived selector. A newborn AutoDeviceSelector() here read
            // as NO_ELIGIBLE_DEVICE by construction, so meta_record_video
            // answered "session: no eligible device" with the glasses awake.
            val s = WearablesBridge.openSession(app, startTimeoutMs = 25_000)
            session = s

            val streamDeferred = CompletableDeferred<Stream>()
            s.addStream(StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 24))
                .onSuccess { streamDeferred.complete(it) }
                .onFailure { error, _ -> streamDeferred.completeExceptionally(Exception("stream: ${error.description}")) }
            val st = streamDeferred.await()
            stream = st
            collectJob = scope.launch {
                st.videoStream.collect { frame -> encode(frame) }
            }
            scope.launch {
                // A recording is an active stream too — a capture-button tap
                // mid-clip must reach the agent's context (GlassesEvents).
                var prev: StreamState? = null
                st.state.collect { state ->
                    GlassesEvents.onStreamTransition(prev, state)
                    prev = state
                }
            }
            st.start()
            withTimeout(25_000) { st.state.first { it == StreamState.STREAMING } }
            scope.launch {
                delay(MAX_SECONDS * 1000)
                // Auto-stop: finalize now, hold the result for the next call.
                mutex.withLock {
                    if (active === this@Recording) {
                        active = null
                        // FINALIZE only — no upload. Nobody asked for these bytes
                        // yet (the START call was answered long ago), and R2 has
                        // no delete, so a speculative upload is permanent. They
                        // ride memory until the second call collects them.
                        //
                        // Stamped at PARK time: the TTL measures how long the
                        // clip has sat unclaimed, not how long ago it was asked for.
                        pending = finalize() to System.currentTimeMillis()
                    }
                }
            }
        }

        /** Runs on the collector coroutine — everything it touches is owned here. */
        private fun encode(frame: VideoFrame) {
            val c = codec ?: run {
                val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, frame.width, frame.height).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                    setInteger(MediaFormat.KEY_BIT_RATE, 1_000_000)
                    setInteger(MediaFormat.KEY_FRAME_RATE, 24)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                }
                MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).also {
                    it.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    it.start()
                    codec = it
                    muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                }
            }
            // ⚠️ MONOTONIC pts is on US, not the source: a stream's timestamps
            // can go BACKWARDS (measured: the mock device loops its feed file
            // and restarts pts each loop — the muxed clip came out 697 frames
            // in a 7.7s timeline at "90fps" and no player would touch it).
            // Real glasses shouldn't loop, but a recorder that trusts source
            // pts produces an unplayable file the day one does. Rewind →
            // synthesize one nominal frame step past the last stamp.
            val raw = frame.presentationTimeUs
            val ptsUs = if (lastPtsUs < 0 || raw > lastPtsUs) raw else lastPtsUs + 41_666 // 1/24s
            if (firstPtsUs < 0) firstPtsUs = ptsUs
            lastPtsUs = ptsUs

            val inIdx = c.dequeueInputBuffer(10_000)
            if (inIdx >= 0) {
                val image = c.getInputImage(inIdx)
                if (image != null) {
                    fillImageFromI420(image.planes, frame.buffer, frame.width, frame.height)
                    c.queueInputBuffer(inIdx, 0, frame.width * frame.height * 3 / 2, ptsUs, 0)
                } else {
                    c.queueInputBuffer(inIdx, 0, 0, ptsUs, 0)
                }
            }
            drain(c, endOfStream = false)

            // ≤4 stills, ~8s apart, so the agent can SEE the clip.
            if (jpegs.size < 4 && ptsUs - lastSampleUs >= 8_000_000) {
                lastSampleUs = ptsUs
                i420ToJpeg(frame.buffer, frame.width, frame.height)?.let { jpegs.add(it) }
            }
        }

        private fun drain(c: MediaCodec, endOfStream: Boolean) {
            if (endOfStream) {
                val inIdx = c.dequeueInputBuffer(10_000)
                if (inIdx >= 0) c.queueInputBuffer(inIdx, 0, 0, lastPtsUs + 1, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            }
            val info = MediaCodec.BufferInfo()
            while (true) {
                val outIdx = c.dequeueOutputBuffer(info, if (endOfStream) 10_000 else 0)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val m = muxer ?: return
                        track = m.addTrack(c.outputFormat)
                        m.start()
                        muxerStarted = true
                    }
                    outIdx >= 0 -> {
                        val buf = c.getOutputBuffer(outIdx)
                        if (buf != null && info.size > 0 && muxerStarted && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                            muxer?.writeSampleData(track, buf, info)
                        }
                        c.releaseOutputBuffer(outIdx, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                    }
                    else -> return
                }
            }
        }

        /**
         * ⚠️ NonCancellable is load-bearing: this tears down `scope` — and the
         * AUTO-STOP path runs INSIDE `scope`, so without it scope.cancel()
         * cancels the very coroutine doing the upload; the suspend postJson
         * throws CancellationException, `pending` never assigns, and the
         * auto-stopped clip is silently LOST (the agent's next toggle then
         * starts a fresh recording instead of returning the clip — observed
         * live on the Pixel, 2026-08-02).
         */
        suspend fun stopAndUpload(app: TinyApp): JSONObject =
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                when (val parked = finalizeInner()) {
                    is Parked.Clip -> upload(app, parked.done)
                    is Parked.Failure -> parked.payload
                }
            }

        /**
         * Stop + finalize, NO network (iOS `finalizeClip()` parity). Split out so
         * the auto-stop can park real bytes without uploading them: the MP4 must
         * close at MAX_SECONDS, but nobody has asked for the clip yet, and an
         * upload nobody collects is unreclaimable (no MEDIA.delete in the worker).
         */
        suspend fun finalize(): Parked =
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { finalizeInner() }

        private fun finalizeInner(): Parked {
            collectJob?.cancel()
            runCatching { stream?.stop() }
            runCatching { session?.stop() }
            val seconds = if (firstPtsUs >= 0) ((lastPtsUs - firstPtsUs) / 1_000_000).toInt() else 0
            val finalized = runCatching {
                codec?.let { drain(it, endOfStream = true); it.stop(); it.release() }
                if (muxerStarted) muxer?.stop()
                muxer?.release()
            }
            scope.cancel()
            codec = null; muxer = null

            // The temp file dies here either way — the bytes we keep are in
            // memory, so a parked clip never depends on a cache-dir file
            // surviving (Android reclaims cacheDir under pressure).
            try {
                if (finalized.isFailure || !muxerStarted || !file.exists() || file.length() == 0L) {
                    return Parked.Failure(
                        JSONObject().put("ok", false)
                            .put("error", "the recording could not be finalized (no frames arrived?) — try again")
                    )
                }
                if (file.length() > MAX_BYTES) {
                    return Parked.Failure(
                        JSONObject().put("ok", false)
                            .put("error", "the clip came out over the 6MB upload cap — record a shorter one")
                    )
                }
                return Parked.Clip(Finished(file.readBytes(), jpegs.toList(), seconds))
            } finally {
                file.delete()
            }
        }

        fun teardown() {
            collectJob?.cancel()
            runCatching { stream?.stop() }
            runCatching { session?.stop() }
            runCatching { codec?.release() }
            runCatching { muxer?.release() }
            scope.cancel()
            file.delete()
        }
    }

    /** I420 (contiguous planar Y+U+V) → the codec's flexible YUV image planes. */
    private fun fillImageFromI420(planes: Array<android.media.Image.Plane>, i420: ByteBuffer, width: Int, height: Int) {
        val src = i420.duplicate().apply { rewind() }
        val ySize = width * height
        val cw = width / 2
        val ch = height / 2
        copyPlane(src, 0, width, planes[0], width, height)          // Y
        copyPlane(src, ySize, cw, planes[1], cw, ch)                 // U
        copyPlane(src, ySize + cw * ch, cw, planes[2], cw, ch)       // V
    }

    private fun copyPlane(src: ByteBuffer, srcOffset: Int, srcRowStride: Int, dst: android.media.Image.Plane, width: Int, height: Int) {
        val out = dst.buffer
        val row = ByteArray(srcRowStride)
        for (y in 0 until height) {
            src.position(srcOffset + y * srcRowStride)
            src.get(row, 0, srcRowStride)
            if (dst.pixelStride == 1) {
                out.position(y * dst.rowStride)
                out.put(row, 0, width)
            } else {
                for (x in 0 until width) {
                    out.position(y * dst.rowStride + x * dst.pixelStride)
                    out.put(row[x])
                }
            }
        }
    }

    /**
     * I420 → NV21 (Y + interleaved VU) → JPEG, for the sampled stills.
     * Internal: GlassesLive decodes its HUD frames through this too — one
     * conversion, two consumers.
     */
    internal fun i420ToJpeg(i420: ByteBuffer, width: Int, height: Int): ByteArray? = runCatching {
        val src = i420.duplicate().apply { rewind() }
        val ySize = width * height
        val cSize = ySize / 4
        val nv21 = ByteArray(ySize + 2 * cSize)
        src.get(nv21, 0, ySize)
        val u = ByteArray(cSize).also { src.get(it) }
        val v = ByteArray(cSize).also { src.get(it) }
        for (i in 0 until cSize) {
            nv21[ySize + 2 * i] = v[i]
            nv21[ySize + 2 * i + 1] = u[i]
        }
        val out = ByteArrayOutputStream()
        YuvImage(nv21, ImageFormat.NV21, width, height, null)
            .compressToJpeg(Rect(0, 0, width, height), 60, out)
        out.toByteArray()
    }.getOrNull()
}
