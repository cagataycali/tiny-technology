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
import com.meta.wearable.dat.core.types.ThermalLevel
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

class WearablesCaptureException(message: String) : Exception(message)

object WearablesBridge {
    @Volatile private var initialized = false
    // ONE selector, alive from initialize (iOS c6's lesson, ported): an
    // AutoDeviceSelector discovers the active device by OBSERVING — one
    // constructed at ask-time knows nothing and reads as "not ready" even
    // with the glasses awake on your face.
    @Volatile private var selector: AutoDeviceSelector? = null

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
                selector = AutoDeviceSelector()
                initialized = true
            }
        }
        return true
    }

    /** iOS `selector?.activeDevice != nil` — the honest capture-readiness bit. */
    private fun readyForCapture(): Boolean =
        runCatching { selector?.activeDevice() != null }.getOrDefault(false)

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

    /** Per-device facts, everything DAT 0.8.0 exposes (iOS parity). */
    internal data class DeviceFacts(
        val name: String,
        val link: String,
        val type: String,
        val hasDisplay: Boolean,
        val thermal: String?,
    )

    private fun deviceFacts(): List<DeviceFacts> =
        Wearables.devices.value.mapNotNull { id ->
            val d = Wearables.devicesMetadata[id]?.value ?: return@mapNotNull null
            val thermal = runCatching { Wearables.getDeviceState(id).value.thermalLevel }
                .getOrNull()?.takeIf { it != ThermalLevel.UNKNOWN }?.name?.lowercase()
            DeviceFacts(d.name, d.linkState.name.lowercase(), d.deviceType.name.lowercase(), d.isDisplayCapable(), thermal)
        }

    /**
     * One device's context fragment — "Name (connected, rayban_meta, thermal
     * light)". Pure so the assembly is JVM-testable; freshly-linked glasses
     * can report an EMPTY name (iOS user QA 2026-07-28), hence the fallback.
     */
    internal fun deviceBits(f: DeviceFacts): String {
        val bits = mutableListOf(f.link, f.type)
        if (f.hasDisplay) bits.add("has a display")
        f.thermal?.let { bits.add("thermal $it") }
        return "${f.name.ifBlank { "Glasses connected" }} (${bits.joinToString(", ")})"
    }

    /**
     * Live device context for the agent (null = not linked) — rides
     * extraSystem beside the location block each send. iOS contextIfLinked()
     * parity: per-device name/link/type/display/thermal, capture readiness,
     * the open live HUD + its on-device transcript tail — deep context so the
     * agent "just works" instead of guessing at the hardware. Android extra:
     * derived tap events (iOS doesn't have these yet).
     */
    suspend fun contextIfLinked(context: Context): String? {
        if (!ensureInitialized(context)) return null
        return runCatching {
            if (Wearables.registrationState.first() != RegistrationState.REGISTERED) return null
            val lines = mutableListOf<String>()
            val devices = deviceFacts()
            if (devices.isEmpty()) {
                lines.add(
                    "🕶 Meta glasses: linked to this phone, but none nearby right now — " +
                        "the user may need to wear or wake them before camera asks.",
                )
            } else {
                val ready = if (readyForCapture()) {
                    "ready — meta_take_photo will capture what the user is LOOKING AT (their first-person camera)"
                } else {
                    "not reachable for capture right now (asleep/folded/out of range — tell the user to wear or wake them before you try)"
                }
                lines.add("🕶 Meta glasses: ${devices.joinToString("; ") { deviceBits(it) }} — $ready.")
            }
            // Live HUD: when the user is watching the feed, say so — and carry
            // what the glasses just HEARD (on-device transcript) into context.
            if (GlassesLive.running.value) {
                lines.add("The user has the live glasses feed OPEN on their phone right now.")
                val heard = GlassesLive.transcript.value
                if (heard.isNotEmpty()) {
                    lines.add("Heard through the glasses moments ago (on-device transcript): \"${heard.takeLast(400)}\"")
                }
            }
            // Derived tap events (GlassesEvents) — "the user tapped the
            // glasses" is a signal worth answering ("want a photo?"), and
            // the SDK gives us no other channel for it.
            val taps = GlassesEvents.recent()
            if (taps.isNotEmpty()) lines.add("Recent glasses events: ${taps.joinToString("; ")}.")
            lines.joinToString("\n")
        }.getOrNull()
    }

    // ── Agent tool executors (iOS Wearables.swift parity) ──────────────────

    /**
     * meta_take_photo: capture → upload once to /api/media → post to the
     * mailbox the server tool polls. EVERY path posts — a silent failure
     * strands the server callback until its 90s timeout.
     */
    suspend fun runPhotoTool(app: technology.tiny.app.TinyApp, toolUseId: String) {
        postToolResult(app, toolUseId, photoPayload(app))
    }

    /**
     * The shared capture core (iOS captureAndUpload parity): chat posts the
     * payload to the mailbox above; the voice call answers over its own WS
     * (MainActivity runVoiceTool). Never throws — errors become the payload.
     */
    suspend fun photoPayload(app: technology.tiny.app.TinyApp): org.json.JSONObject = try {
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

    /** meta_glasses_status: instant facts from state the app already holds. */
    suspend fun runStatusTool(app: technology.tiny.app.TinyApp, toolUseId: String) {
        val payload = try {
            statusFacts(app)
        } catch (t: Throwable) {
            org.json.JSONObject().put("ok", false).put("error", t.message ?: "status unavailable")
        }
        postToolResult(app, toolUseId, payload)
    }

    /**
     * The meta_glasses_status payload — the same facts contextIfLinked()
     * narrates, as JSON (iOS statusFacts() shape: linked / readyForCapture /
     * devices[{name,type,link,hasDisplay,thermal?}] / liveHudOpen /
     * recording; Android extras: btPermission + recentEvents).
     */
    suspend fun statusFacts(context: Context): org.json.JSONObject {
        val facts = org.json.JSONObject().put("ok", true)
        facts.put("btPermission", hasBtPermission(context))
        if (!ensureInitialized(context)) {
            return facts.put("linked", false)
                .put("note", "Bluetooth permission missing — open the glasses settings on the phone first")
        }
        val linked = Wearables.registrationState.first() == RegistrationState.REGISTERED
        facts.put("linked", linked)
        if (linked) {
            val devices = org.json.JSONArray()
            deviceFacts().forEach { f ->
                devices.put(
                    org.json.JSONObject()
                        .put("name", f.name.ifBlank { "Glasses connected" })
                        .put("type", f.type)
                        .put("link", f.link)
                        .put("hasDisplay", f.hasDisplay)
                        .apply { f.thermal?.let { put("thermal", it) } },
                )
            }
            facts.put("devices", devices)
            facts.put("readyForCapture", readyForCapture())
            facts.put("liveHudOpen", GlassesLive.running.value)
            facts.put("recording", GlassesRecorderBridge.isRecording)
            val taps = GlassesEvents.recent()
            if (taps.isNotEmpty()) facts.put("recentEvents", org.json.JSONArray(taps))
        }
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
