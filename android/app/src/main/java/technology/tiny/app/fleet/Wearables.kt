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
 * Wearables.RequestPermissionContract() — an Activity contract, so a launcher
 * needs an Activity. [WearablesBridge.ensureCameraPermission] gets one from
 * GlassesCameraConsentActivity, which is why a capture asked for from web chat
 * or a voice call can now raise that prompt itself instead of dead-ending on
 * "grant it in settings" (the Panels button is still there, for granting it
 * before anything is asked).
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
import com.meta.wearable.dat.core.types.DatError
import com.meta.wearable.dat.core.types.DeviceSessionError
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.types.ThermalLevel
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

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

    // ── the one door to a session (iOS Wearables.swift openSession) ─────────

    // iOS parity: 15s for the selector's first value, ONE retry 2s later, 25s
    // for the session to reach STARTED.
    internal const val ACTIVE_DEVICE_WAIT_MS = 15_000L
    internal const val SESSION_RETRY_DELAY_MS = 2_000L
    internal const val SESSION_START_TIMEOUT_MS = 25_000L

    /** iOS WearablesCaptureError.notConnected, word for word. */
    internal const val NOT_REACHABLE =
        "The glasses are linked but not reachable right now — make sure they're on your face " +
            "(not folded/in the case), awake, and near the phone, then ask again."

    /**
     * A STARTED [DeviceSession], or a thrown reason. The single door all three
     * capture rails (photo, video, live HUD) go through.
     *
     * ⚠️ It hands `createSession` the LONG-LIVED [selector], and that is the
     * whole reason it exists. Measured in DAT 0.8.0's bytecode:
     * `DeviceSelectorBase.<init>` builds its state as
     * `stateIn(deviceFlow, applicationScope(io()), Eagerly, null)` — initial
     * value **null**, filled in later off an IO dispatcher — and
     * `WearablesImpl.createSession(DeviceSelector)` reads `activeDevice()` and
     * returns NO_ELIGIBLE_DEVICE the instant it is null. So each rail's
     * ask-time `AutoDeviceSelector()` failed BY CONSTRUCTION, while
     * `readyForCapture()` — reading the long-lived one two lines away in the
     * same status payload — said "ready" in the same breath.
     *
     * The wait and the single retry are iOS parity: the observer may simply not
     * have been handed its first value yet, and the SDK can answer
     * NO_ELIGIBLE_DEVICE once more while the link settles.
     *
     * The session is stopped before any throw — a started session nobody holds
     * makes the NEXT ask fail with SESSION_ALREADY_EXISTS.
     */
    suspend fun openSession(context: Context, startTimeoutMs: Long = SESSION_START_TIMEOUT_MS): DeviceSession {
        if (!ensureInitialized(context)) {
            throw WearablesCaptureException("Bluetooth permission missing — open the glasses settings first")
        }
        val live = selector ?: throw WearablesCaptureException(NOT_REACHABLE)
        if (!awaitActive({ live.activeDevice() }, live.activeDeviceFlow(), ACTIVE_DEVICE_WAIT_MS)) {
            throw WearablesCaptureException(NOT_REACHABLE)
        }
        val session = attemptSession(live) ?: run {
            delay(SESSION_RETRY_DELAY_MS)
            attemptSession(live) ?: throw WearablesCaptureException(NOT_REACHABLE)
        }
        try {
            session.start()
            withTimeout(startTimeoutMs) { session.state.first { it == DeviceSessionState.STARTED } }
        } catch (t: Throwable) {
            runCatching { session.stop() }
            throw t
        }
        return session
    }

    /**
     * True once the selector has an active device — now, or within the budget.
     *
     * Takes its two readings as arguments so the wait itself is JVM-testable:
     * the SDK's selector cannot be constructed without `Wearables.initialize`,
     * and this is the part with a deadline in it.
     */
    internal suspend fun awaitActive(
        current: () -> Any?,
        stream: Flow<Any?>,
        budgetMs: Long,
    ): Boolean {
        if (current() != null) return true
        return withTimeoutOrNull(budgetMs) { stream.first { it != null } } != null
    }

    /**
     * One `createSession` attempt: the session, or null when the SDK says
     * NO_ELIGIBLE_DEVICE. Every OTHER error is thrown with its description —
     * THERMAL_CRITICAL, CAPABILITY_DENIED and DEVICE_POWERED_OFF are answers,
     * not conditions that a second attempt two seconds later would change.
     */
    private suspend fun attemptSession(sel: AutoDeviceSelector): DeviceSession? {
        val out = CompletableDeferred<DeviceSession?>()
        Wearables.createSession(sel)
            .onSuccess { out.complete(it) }
            .onFailure { error, _ ->
                if (retryableSessionError(error)) out.complete(null)
                else if (error == DeviceSessionError.SESSION_ALREADY_EXISTS) {
                    out.completeExceptionally(
                        WearablesCaptureException(
                            cameraBusyMessage(GlassesLive.running.value, GlassesRecorderBridge.isRecording),
                        ),
                    )
                } else {
                    out.completeExceptionally(WearablesCaptureException("session: ${error.description}"))
                }
            }
        return out.await()
    }

    internal fun retryableSessionError(error: DatError): Boolean =
        error == DeviceSessionError.NO_ELIGIBLE_DEVICE

    /**
     * Who is holding the one glasses camera, in the user's words — the answer
     * to SESSION_ALREADY_EXISTS.
     *
     * ⚠️ MEASURED in DAT 0.8.0's bytecode (`WearablesImpl.createSession`): the
     * SDK keeps ONE session per device in a `sessions` map and answers
     * SESSION_ALREADY_EXISTS for any ask while the existing entry's state is
     * anything but STOPPED. The entry goes in AT `createSession`, in state
     * IDLE, before `start()` — so the collision window is the whole 25s walk
     * to STARTED plus the holder's entire lifetime (the live HUD holds it for
     * as long as its card is on screen). Both stop paths — `stop()` and
     * `handleExternalTermination()`, i.e. the glasses being folded — run
     * `performStop()`, which clears the entry synchronously, so nothing leaks
     * and nothing is stuck; a busy camera is exactly and only a busy camera.
     *
     * There is no public accessor for the session already open — `Wearables`
     * exposes `createSession` and nothing else — so the second rail cannot
     * take it over. The remedy belongs to the USER: close the live card, or
     * wait out the clip. Which means the answer has to NAME the holder.
     *
     * The SDK's own description is "A session already exists for this device":
     * true, and useless to someone who asked for a photo of what they are
     * looking at WHILE watching the live feed — the most natural moment there
     * is to ask. The app already knows who holds it; [statusFacts] publishes
     * both of these flags a few functions down, and the context lines tell the
     * agent "the live glasses feed is OPEN" in the same breath the capture
     * dead-ends. Derived, never claimed: a flag we set ourselves could be left
     * on by a rail that died, and then the camera would read as busy forever.
     */
    internal fun cameraBusyMessage(liveOpen: Boolean, recording: Boolean): String = when {
        liveOpen ->
            "The live glasses feed is open on the phone and it holds the glasses camera — " +
                "close the live card there, then ask again."
        recording ->
            "The glasses are recording a video right now, which holds their camera — " +
                "wait for that clip to finish, then ask again."
        // Nothing we own says it is busy: another capture asked for moments ago
        // is still walking up to its session, or finishing. It ends on its own.
        else ->
            "Another glasses capture is still finishing on the phone — " +
                "give it a few seconds and ask again."
    }

    // ── the one door to the glasses camera (iOS ensureCameraPermission) ─────

    /**
     * Returns once the glasses camera is usable; throws the reason it isn't.
     *
     * iOS parity (`Wearables.swift:ensureCameraPermission`): check, and if it
     * isn't granted, **ASK** — all three rails do this before touching a
     * session. Android could only check until now, so every rail answered
     * "grant it via the glasses settings": a button on a phone the user isn't
     * holding, in an app they aren't looking at, for a photo they just asked
     * for out loud. The ask has to come to them.
     *
     * Divergences from iOS, both deliberate:
     *  - the wait is BOUNDED ([GlassesCameraAsk.ASK_WINDOW_MS]) — the prompt
     *    lives in ANOTHER app here, so an unanswered one would otherwise hold
     *    the rail until the tool's own 90s poll expired with nothing to say;
     *  - a check that FAILS (no device, Meta AI missing) throws its own
     *    description instead of asking. Raising a prompt that cannot be
     *    answered just spends the window to end up at the same place.
     */
    suspend fun ensureCameraPermission(
        context: Context,
        windowMs: Long = GlassesCameraAsk.ASK_WINDOW_MS,
    ) {
        val status = CompletableDeferred<PermissionStatus>()
        Wearables.checkPermissionStatus(Permission.CAMERA)
            .onSuccess { status.complete(it) }
            .onFailure { error, _ -> status.completeExceptionally(WearablesCaptureException(error.description)) }
        if (status.await() == PermissionStatus.Granted) return
        // ⚠️ refusal() carries the ONLY honest wording for each ending — the
        // SDK cannot tell "declined" from "backed out", so no caller may say.
        GlassesCameraAsk.refusal(GlassesCameraAsk.request(context, windowMs))
            ?.let { throw WearablesCaptureException(it) }
    }

    /**
     * One JPEG from the glasses camera, or a thrown reason. The session and
     * stream are torn down before returning either way.
     *
     * `timeoutMs` budgets the STREAM and the shutter, not the walk up to a
     * started session — [openSession] carries its own deadlines (iOS budgets
     * per step the same way). Sharing one 45s budget meant a slow-but-normal
     * 17s device wait left 3s for the photo itself.
     */
    suspend fun capturePhoto(context: Context, timeoutMs: Long = 45_000): ByteArray {
        if (!ensureInitialized(context)) {
            throw WearablesCaptureException("Bluetooth permission missing — open the glasses settings first")
        }
        if (Wearables.registrationState.first() != RegistrationState.REGISTERED) {
            throw WearablesCaptureException("No Meta glasses linked — link them in settings first")
        }
        ensureCameraPermission(context)

        val session = openSession(context, startTimeoutMs = timeoutMs)
        return withTimeout(timeoutMs) {
            try {
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
     * (and /api/media) speaks JPEG — normalize AND cap here, once.
     */
    private fun toJpeg(photo: PhotoData): ByteArray = when (photo) {
        is PhotoData.Bitmap -> encode(photo.bitmap)
        is PhotoData.HEIC -> {
            val bytes = ByteArray(photo.data.remaining())
            photo.data.get(bytes)
            // minSdk 29 decodes HEIF natively; re-encode as JPEG.
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ?: throw WearablesCaptureException("could not decode the HEIC photo from the glasses")
            encode(bitmap)
        }
    }

    /**
     * 📸 Cap the long side, then JPEG — the numbers and the reasoning are
     * [technology.tiny.app.tools.Screenshot]'s and iOS
     * `WearablesManager.captureAndUpload`'s ("Cap the long side like
     * Screenshot: the glasses shoot large and the model only needs
     * legibility, not megapixels").
     *
     * ⚠️⚠️ MEASURED IN THE SDK's BYTECODE (javap, mwdat-camera 0.8.0): there is
     * NO photo-resolution knob to ask for a smaller still.
     * `StreamConfiguration.videoQuality` is read by exactly two methods —
     * `StreamImpl.start` and `StreamImpl.createVideoFormat`, i.e. the VIDEO
     * rail (LOW 360×640 / MEDIUM 504×896 / HIGH 720×1280) — and
     * `StreamImpl.capturePhoto` reads none of it. So the LOW we open the
     * stream with above does NOT shrink the photo: a still arrives at whatever
     * the hardware shoots (12MP on Ray-Ban Meta), and capping is on us.
     *
     * ⚠️ Which is not cosmetic: the upload is base64 inside a JSON body and
     * `/media/upload` gates at 6MB DECODED (MEDIA_MAX_BYTES in
     * `worker/src/media.ts`), answering 400 `data must be valid
     * base64 ≤6MB` — a string [photoPayload] then hands the user verbatim as
     * the reason their photo failed. iOS never reaches that gate because it
     * caps first, and neither does any other Android image rail
     * (Screenshot 1600/80, chat/Attachments 1568/85, ui/DmMedia 85). The
     * glasses rail was the only one shipping raw sensor pixels.
     */
    private fun encode(bitmap: Bitmap): ByteArray {
        val scaled = scaledTo(bitmap.width, bitmap.height, PHOTO_MAX_SIDE)
            ?.let { (w, h) -> Bitmap.createScaledBitmap(bitmap, w, h, true) }
            ?: bitmap
        return ByteArrayOutputStream().use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, PHOTO_QUALITY, out)
            out.toByteArray()
        }
    }

    /** Long-side cap for an uploaded glasses still — Screenshot's number. */
    internal const val PHOTO_MAX_SIDE = 1600

    /** JPEG quality for it — Screenshot's 80, iOS's `quality: 0.8`. */
    internal const val PHOTO_QUALITY = 80

    /**
     * The scaling decision, split out of [encode] because `Bitmap` is an
     * Android type and this module has no Robolectric — the math is the part a
     * JVM test can reach (same seam as [awaitActive] and
     * [GlassesCameraAsk.await]).
     *
     * Null means "already inside the cap": returning the bitmap untouched
     * matters, because `createScaledBitmap` on an in-budget photo would
     * resample it for nothing.
     */
    internal fun scaledTo(width: Int, height: Int, maxSide: Int): Pair<Int, Int>? {
        val side = maxOf(width, height)
        if (side <= maxSide) return null
        val scale = maxSide.toFloat() / side
        // coerceAtLeast(1): a panorama-shaped frame scales its short side
        // toward zero, and a 0-pixel dimension is a createScaledBitmap crash.
        return (width * scale).toInt().coerceAtLeast(1) to
            (height * scale).toInt().coerceAtLeast(1)
    }
}
