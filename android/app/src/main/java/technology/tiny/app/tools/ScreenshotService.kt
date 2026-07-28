package technology.tiny.app.tools

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import technology.tiny.app.MainActivity
import technology.tiny.app.R
import technology.tiny.app.TinyApp
import java.util.concurrent.atomic.AtomicBoolean

/**
 * ScreenshotService — the MediaProjection foreground service that grabs ONE
 * frame of the whole screen for the `screenshot` device tool, then hands it to
 * [Screenshot.deliver] (encode → /api/media → tool-result). iOS does this with
 * ReplayKit's single-frame startCapture; Android requires a foreground service
 * of type mediaProjection (API 29+) that outlives the transparent consent
 * activity, so the capture survives even if the app is backgrounded.
 *
 * Started by [ScreenshotConsentActivity] once the system consent dialog is
 * approved, carrying the projection grant (resultCode + data Intent) and the
 * toolUseId. We spin up a VirtualDisplay into an ImageReader, take the first
 * image, tear everything down, and deliver. Exactly one frame — a guarded
 * AtomicBoolean means the ImageReader listener firing repeatedly can't
 * double-deliver.
 */
class ScreenshotService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var bgThread: HandlerThread? = null
    private val delivered = AtomicBoolean(false)
    // Separate from [delivered]: guards the teardown/deliver body so it runs
    // exactly once no matter WHICH path calls finish() (listener, error path,
    // or the no-frame watchdog). [delivered] guards which capture path CLAIMS
    // the single frame; [finished] guards the one-time cleanup.
    private val finished = AtomicBoolean(false)
    // Ceiling on how long we hold the MediaProjection waiting for a frame. If
    // the ImageReader never delivers one (secure/DRM surface, a display that
    // emits no buffer, a GPU hiccup), the listener at capture() never fires and
    // NOTHING else stops the service — the "recording your screen" indicator
    // would stay lit and the projection/VirtualDisplay/thread leak until the
    // process dies. The watchdog force-finishes with a null bitmap, which the
    // deliver path already turns into an honest "no frame — try again" result.

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // API 29+ requires promptly reaching startForeground() with the
        // mediaProjection type BEFORE MediaProjectionManager.getMediaProjection.
        startForegroundCompat()

        val toolUseId = intent?.getStringExtra(EXTRA_TOOL_USE_ID)
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        if (toolUseId == null || data == null || resultCode == 0) {
            Log.w(TAG, "missing projection grant — nothing to capture")
            stopSelf()
            return START_NOT_STICKY
        }

        runCatching { capture(toolUseId, resultCode, data) }.onFailure { t ->
            Log.w(TAG, "capture failed", t)
            finish(toolUseId, null)
        }
        return START_NOT_STICKY
    }

    private fun capture(toolUseId: String, resultCode: Int, data: Intent) {
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = mgr.getMediaProjection(resultCode, data) ?: run {
            finish(toolUseId, null); return
        }
        projection = proj

        val metrics = screenMetrics()
        val width = metrics.first
        val height = metrics.second
        val density = metrics.third

        val thread = HandlerThread("screenshot-capture").apply { start() }
        bgThread = thread
        val handler = Handler(thread.looper)

        // API 34+ requires a registered callback before creating a VirtualDisplay.
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { /* torn down in finish() */ }
        }, handler)

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ r ->
            // Fires per frame; take the FIRST usable one and never again.
            if (!delivered.compareAndSet(false, true)) {
                runCatching { r.acquireLatestImage()?.close() }
                return@setOnImageAvailableListener
            }
            val bitmap = runCatching { r.acquireLatestImage()?.use { bitmapFrom(it, width) } }.getOrNull()
            finish(toolUseId, bitmap)
        }, handler)

        virtualDisplay = proj.createVirtualDisplay(
            "tiny-screenshot",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, handler,
        )

        // No-frame watchdog: if the listener above never fires (secure/DRM
        // surface, buffer-less display, GPU hiccup), force a null-bitmap finish
        // so the projection + VirtualDisplay + thread + foreground service can't
        // leak forever with the screen-recording indicator lit. Claims the frame
        // slot so a late listener can't also deliver.
        handler.postDelayed({
            if (delivered.compareAndSet(false, true)) {
                Log.w(TAG, "no frame within ${FRAME_TIMEOUT_MS}ms — tearing down")
                finish(toolUseId, null)
            }
        }, FRAME_TIMEOUT_MS)
    }

    /** Deliver exactly once (guarded by [finished]), then tear down + stop. */
    private fun finish(toolUseId: String, bitmap: Bitmap?) {
        // Run the deliver + teardown exactly once regardless of caller (frame
        // listener, error path, or the no-frame watchdog — two of these can race).
        if (!finished.compareAndSet(false, true)) return
        // Also mark delivered so a late listener that hasn't yet claimed the
        // frame slot bails out.
        delivered.set(true)
        val app = applicationContext as TinyApp
        scope.launch {
            runCatching { Screenshot.deliver(app, toolUseId, bitmap) }
                .onFailure { Log.w(TAG, "deliver threw", it) }
            teardown()
            stopSelf()
        }
    }

    private fun teardown() {
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        runCatching { imageReader?.close() }
        imageReader = null
        runCatching { projection?.stop() }
        projection = null
        runCatching { bgThread?.quitSafely() }
        bgThread = null
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    /** ImageReader gives a padded RGBA buffer — copy honoring rowStride, then crop. */
    private fun bitmapFrom(image: Image, width: Int): Bitmap {
        val plane = image.planes[0]
        val bmpWidth = paddedBufferWidth(width, plane.pixelStride, plane.rowStride)
        val full = Bitmap.createBitmap(bmpWidth, image.height, Bitmap.Config.ARGB_8888)
        full.copyPixelsFromBuffer(plane.buffer)
        // Padded → crop back to the real width; exact → use as-is.
        return if (bmpWidth == width) full
        else Bitmap.createBitmap(full, 0, 0, width, image.height)
    }

    private fun screenMetrics(): Triple<Int, Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            val density = resources.displayMetrics.densityDpi
            Triple(b.width(), b.height(), density)
        } else {
            @Suppress("DEPRECATION")
            val dm = DisplayMetrics().also { wm.defaultDisplay.getRealMetrics(it) }
            Triple(dm.widthPixels, dm.heightPixels, dm.densityDpi)
        }
    }

    private fun startForegroundCompat() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Screen capture", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown briefly while tiny captures your screen for the agent"
                    }
                )
            }
        }
        val tap = android.app.PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_shortcut_voice)
            .setContentTitle("📸 Capturing your screen")
            .setContentText("tiny is grabbing one frame for the agent")
            .setContentIntent(tap)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    companion object {
        private const val TAG = "TinyScreenshot"
        private const val CHANNEL_ID = "screenshot"
        private const val NOTIF_ID = 47
        // Well under the callers' own waits (voice bridge 120s, server tool-result
        // 90s) so the service self-heals long before they give up — a single frame
        // is normally available within a frame or two of createVirtualDisplay.
        private const val FRAME_TIMEOUT_MS = 5_000L

        /**
         * The width (in pixels) of the ImageReader's backing bitmap, which is
         * usually WIDER than the screen: the GPU pads each row to an alignment
         * boundary, so `rowStride` (bytes per row) can exceed `pixelStride *
         * width`. We must build the bitmap at this padded width and crop back to
         * `width`, or the pixels shear diagonally (every row offset by the pad).
         * Pure integer geometry, extracted so the off-by-one that would corrupt
         * EVERY Android capture is unit-tested (Bitmap/Image are on-device only).
         *
         * `rowStride == pixelStride * width` (no padding) returns `width` exactly,
         * which the caller uses to skip the crop.
         */
        fun paddedBufferWidth(width: Int, pixelStride: Int, rowStride: Int): Int {
            if (pixelStride <= 0) return width // defensive: never divide by zero
            val rowPadding = rowStride - pixelStride * width
            if (rowPadding <= 0) return width // exact or (defensively) under-reported
            return width + rowPadding / pixelStride
        }
        const val EXTRA_TOOL_USE_ID = "toolUseId"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        /** Launch the capture service with a fresh projection grant. */
        fun start(context: Context, toolUseId: String, resultCode: Int, data: Intent) {
            val intent = Intent(context, ScreenshotService::class.java)
                .putExtra(EXTRA_TOOL_USE_ID, toolUseId)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
