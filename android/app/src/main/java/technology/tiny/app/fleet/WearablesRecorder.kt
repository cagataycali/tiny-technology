/**
 * 🎥 GlassesRecorderBridge — Android's meta_record_video executor (iOS
 * WearablesRecorder.swift parity). TOGGLE semantics: the agent's first call
 * starts a recording (posts {recording:true} fast), the second stops it —
 * the MP4 finalizes, uploads once as video/mp4, up to 4 sampled frames ride
 * along, and {ok,url,frames,seconds} posts to the mailbox. Auto-stop at 28s
 * (the media store's 6MB cap); an auto-stopped clip waits as `pending` for
 * the agent's second call.
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
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
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
    private var pending: JSONObject? = null

    val isRecording: Boolean get() = active != null

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

    private suspend fun toggle(app: TinyApp): JSONObject = mutex.withLock {
        pending?.let { done -> pending = null; return done }
        active?.let { rec -> active = null; return rec.stopAndUpload(app) }
        start(app)
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
        val camera = CompletableDeferred<PermissionStatus>()
        Wearables.checkPermissionStatus(Permission.CAMERA)
            .onSuccess { camera.complete(it) }
            .onFailure { error, _ -> camera.completeExceptionally(Exception(error.description)) }
        if (camera.await() != PermissionStatus.Granted) {
            return JSONObject().put("ok", false)
                .put("error", "Glasses camera permission not granted — grant it in settings → meta glasses")
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
            val sessionDeferred = CompletableDeferred<DeviceSession>()
            Wearables.createSession(AutoDeviceSelector())
                .onSuccess { sessionDeferred.complete(it) }
                .onFailure { error, _ -> sessionDeferred.completeExceptionally(Exception("session: ${error.description}")) }
            val s = sessionDeferred.await()
            session = s
            s.start()
            withTimeout(25_000) { s.state.first { it == DeviceSessionState.STARTED } }

            val streamDeferred = CompletableDeferred<Stream>()
            s.addStream(StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 24))
                .onSuccess { streamDeferred.complete(it) }
                .onFailure { error, _ -> streamDeferred.completeExceptionally(Exception("stream: ${error.description}")) }
            val st = streamDeferred.await()
            stream = st
            collectJob = scope.launch {
                st.videoStream.collect { frame -> encode(frame) }
            }
            st.start()
            withTimeout(25_000) { st.state.first { it == StreamState.STREAMING } }
            scope.launch {
                delay(MAX_SECONDS * 1000)
                // Auto-stop: finalize now, hold the result for the next call.
                mutex.withLock {
                    if (active === this@Recording) {
                        active = null
                        pending = stopAndUpload(app)
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
            val ptsUs = frame.presentationTimeUs
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

        suspend fun stopAndUpload(app: TinyApp): JSONObject {
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

            try {
                if (finalized.isFailure || !muxerStarted || !file.exists() || file.length() == 0L) {
                    return JSONObject().put("ok", false)
                        .put("error", "the recording could not be finalized (no frames arrived?) — try again")
                }
                if (file.length() > MAX_BYTES) {
                    return JSONObject().put("ok", false)
                        .put("error", "the clip came out over the 6MB upload cap — record a shorter one")
                }
                val b64 = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                val up = app.api.postJson(
                    "/api/media",
                    JSONObject().put("data", b64).put("contentType", "video/mp4"),
                )
                val url = up.optString("url").takeIf { it.isNotEmpty() }
                    ?: return JSONObject().put("ok", false)
                        .put("error", up.optString("error").ifEmpty { "clip upload failed" })
                val frames = JSONArray()
                for (jpeg in jpegs) {
                    runCatching {
                        val fb64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP)
                        val fu = app.api.postJson(
                            "/api/media",
                            JSONObject().put("data", fb64).put("contentType", "image/jpeg"),
                        )
                        fu.optString("url").takeIf { it.isNotEmpty() }?.let { frames.put(it) }
                    }
                }
                return JSONObject().put("ok", true).put("url", url).put("frames", frames).put("seconds", seconds)
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

    /** I420 → NV21 (Y + interleaved VU) → JPEG, for the sampled stills. */
    private fun i420ToJpeg(i420: ByteBuffer, width: Int, height: Int): ByteArray? = runCatching {
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
