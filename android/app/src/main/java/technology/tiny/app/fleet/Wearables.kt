/**
 * 🕶️ Meta Wearables (DAT) — the glasses join the tiny device fleet.
 * iOS twin: ios/Tiny/Sources/Wearables.swift (same shape, same states).
 *
 * One object over the Meta Wearables Device Access Toolkit:
 * `ensureInitialized()` gates every call (the SDK demands initialize() after
 * BLUETOOTH_CONNECT is granted — a runtime permission on this minSdk),
 * `startRegistration()` hands off to the Meta AI app (which returns via the
 * host-less tinyapp:// intent filter), and `capturePhoto()` runs the full
 * session dance (session → STARTED → stream → STREAMING → capture → teardown)
 * to turn "what am I looking at?" into JPEG bytes for the agent.
 *
 * The glasses-camera permission is granted inside the Meta AI app via
 * Wearables.RequestPermissionContract() — an Activity contract, so the UI
 * (Panels glasses section) owns that launcher; this bridge only checks.
 */
package technology.tiny.app.fleet

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.ContextCompat
import com.meta.wearable.dat.camera.addStream
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

class WearablesCaptureException(message: String) : Exception(message)

object WearablesBridge {
    @Volatile private var initialized = false

    /** BLUETOOTH_CONNECT is the one Android runtime permission the SDK needs. */
    fun hasBtPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Initialize the SDK once BT permission exists. False = not initialized
     * (caller shows the permission ask); safe to call repeatedly.
     */
    fun ensureInitialized(context: Context): Boolean {
        if (initialized) return true
        if (!hasBtPermission(context)) return false
        synchronized(this) {
            if (!initialized) {
                Wearables.initialize(context.applicationContext)
                initialized = true
            }
        }
        return true
    }

    val isInitialized: Boolean get() = initialized

    /** Live registration state (REGISTERED = linked) — for the settings UI. */
    val registrationState: Flow<RegistrationState> get() = Wearables.registrationState

    /** Hand off to the Meta AI app; the result arrives on registrationState. */
    fun startRegistration(activity: Activity): Boolean {
        if (!ensureInitialized(activity)) return false
        Wearables.startRegistration(activity)
        return true
    }

    fun startUnregistration(activity: Activity): Boolean {
        if (!ensureInitialized(activity)) return false
        Wearables.startUnregistration(activity)
        return true
    }

    suspend fun isLinked(context: Context): Boolean =
        ensureInitialized(context) && Wearables.registrationState.first() == RegistrationState.REGISTERED

    /**
     * One JPEG from the glasses camera, or a thrown reason. The session and
     * stream are torn down before returning either way.
     */
    suspend fun capturePhoto(context: Context, timeoutMs: Long = 45_000): ByteArray {
        if (!ensureInitialized(context)) {
            throw WearablesCaptureException("Bluetooth permission missing — open the glasses settings first")
        }
        if (Wearables.registrationState.first() != RegistrationState.REGISTERED) {
            throw WearablesCaptureException("No Meta glasses linked — link them in settings first")
        }
        val permission = CompletableDeferred<PermissionStatus>()
        Wearables.checkPermissionStatus(Permission.CAMERA)
            .onSuccess { permission.complete(it) }
            .onFailure { error, _ -> permission.completeExceptionally(WearablesCaptureException(error.description)) }
        if (permission.await() != PermissionStatus.Granted) {
            throw WearablesCaptureException("Glasses camera permission not granted — grant it via the glasses settings")
        }

        return withTimeout(timeoutMs) {
            val sessionDeferred = CompletableDeferred<DeviceSession>()
            Wearables.createSession(AutoDeviceSelector())
                .onSuccess { sessionDeferred.complete(it) }
                .onFailure { error, _ ->
                    sessionDeferred.completeExceptionally(WearablesCaptureException("session: ${error.description}"))
                }
            val session = sessionDeferred.await()
            try {
                session.start()
                session.state.first { it == DeviceSessionState.STARTED }

                val streamDeferred = CompletableDeferred<com.meta.wearable.dat.camera.Stream>()
                session.addStream(StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 24))
                    .onSuccess { streamDeferred.complete(it) }
                    .onFailure { error, _ ->
                        streamDeferred.completeExceptionally(WearablesCaptureException("stream: ${error.description}"))
                    }
                val stream = streamDeferred.await()
                try {
                    stream.start()
                    stream.state.first { it == StreamState.STREAMING }

                    val photoDeferred = CompletableDeferred<PhotoData>()
                    stream.capturePhoto()
                        .onSuccess { photoDeferred.complete(it) }
                        .onFailure { error, _ ->
                            photoDeferred.completeExceptionally(WearablesCaptureException("capture: ${error.description}"))
                        }
                    toJpeg(photoDeferred.await())
                } finally {
                    stream.stop()
                }
            } finally {
                session.stop()
            }
        }
    }

    /**
     * One line of live context (null = not linked) — rides extraSystem
     * beside the location block each send, iOS contextIfLinked() parity, so
     * the agent knows the glasses exist before reaching for meta_take_photo.
     */
    suspend fun contextIfLinked(context: Context): String? {
        if (!ensureInitialized(context)) return null
        return runCatching {
            if (Wearables.registrationState.first() != RegistrationState.REGISTERED) return null
            val count = Wearables.devices.first().size
            val state = if (count > 0) "$count device(s) known" else "linked, none nearby right now"
            "🕶 Meta glasses: $state. meta_take_photo returns what the user is LOOKING AT (their first-person camera)."
        }.getOrNull()
    }

    // ── Agent tool executors (iOS Wearables.swift parity) ──────────────────

    /**
     * meta_take_photo: capture → upload once to /api/media → post to the
     * mailbox the server tool polls. EVERY path posts — a silent failure
     * strands the server callback until its 90s timeout.
     */
    suspend fun runPhotoTool(app: technology.tiny.app.TinyApp, toolUseId: String) {
        val payload = try {
            val jpeg = capturePhoto(app)
            val b64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP)
            val up = app.api.postJson(
                "/api/media",
                org.json.JSONObject().put("data", b64).put("contentType", "image/jpeg"),
            )
            val url = up.optString("url").takeIf { it.isNotEmpty() }
            if (url == null) {
                org.json.JSONObject().put("ok", false)
                    .put("error", up.optString("error").ifEmpty { "photo upload failed (no url)" })
            } else {
                org.json.JSONObject().put("ok", true).put("url", url).put("format", "jpeg")
            }
        } catch (t: Throwable) {
            org.json.JSONObject().put("ok", false)
                .put("error", t.message ?: "glasses capture failed on the device")
        }
        postToolResult(app, toolUseId, payload)
    }

    /** meta_glasses_status: instant facts from state the app already holds. */
    suspend fun runStatusTool(app: technology.tiny.app.TinyApp, toolUseId: String) {
        val payload = try {
            statusFacts(app)
        } catch (t: Throwable) {
            org.json.JSONObject().put("ok", false).put("error", t.message ?: "status unavailable")
        }
        postToolResult(app, toolUseId, payload)
    }

    suspend fun statusFacts(context: Context): org.json.JSONObject {
        val facts = org.json.JSONObject().put("ok", true)
        facts.put("btPermission", hasBtPermission(context))
        if (!ensureInitialized(context)) {
            return facts.put("linked", false)
                .put("note", "Bluetooth permission missing — open the glasses settings on the phone first")
        }
        val linked = Wearables.registrationState.first() == RegistrationState.REGISTERED
        facts.put("linked", linked)
        if (linked) facts.put("devices", Wearables.devices.first().size)
        return facts
    }

    private suspend fun postToolResult(app: technology.tiny.app.TinyApp, toolUseId: String, payload: org.json.JSONObject) {
        runCatching {
            app.api.postJson(
                "/api/chat/tool-result",
                org.json.JSONObject().put("toolUseId", toolUseId).put("payload", payload.toString()),
            )
        }
    }

    /**
     * The SDK hands back either a Bitmap or HEIC bytes; the agent pipeline
     * (and /api/media) speaks JPEG — normalize here, once.
     */
    private fun toJpeg(photo: PhotoData): ByteArray = when (photo) {
        is PhotoData.Bitmap -> ByteArrayOutputStream().use { out ->
            photo.bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
            out.toByteArray()
        }
        is PhotoData.HEIC -> {
            val bytes = ByteArray(photo.data.remaining())
            photo.data.get(bytes)
            // minSdk 29 decodes HEIF natively; re-encode as JPEG.
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ?: throw WearablesCaptureException("could not decode the HEIC photo from the glasses")
            ByteArrayOutputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
                out.toByteArray()
            }
        }
    }
}
