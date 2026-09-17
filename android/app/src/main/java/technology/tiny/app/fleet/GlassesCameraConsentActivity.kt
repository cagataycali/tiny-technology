package technology.tiny.app.fleet

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 🕶️🔐 The glasses-camera ASK — Android's answer to iOS
 * `WearablesManager.ensureCameraPermission()`.
 *
 * iOS asks inline at all three capture rails: `checkPermissionStatus(.camera)`,
 * and if it isn't granted, `requestPermission(.camera)`. **Android's core
 * `Wearables` object has no `requestPermission` at all** (verified with `javap`
 * on mwdat-core 0.8.0) — the ONLY path is `Wearables.RequestPermissionContract`,
 * an `ActivityResultContract`, which needs an Activity to launch it. So before
 * this file every Android rail could only CHECK, and "take a photo through my
 * glasses" from web chat or a voice call dead-ended on "grant it in settings →
 * meta glasses": a button the user had to go find on a phone they weren't
 * holding, in an app they weren't looking at.
 *
 * This is [technology.tiny.app.tools.ScreenshotConsentActivity]'s pattern — a
 * transparent, no-UI activity whose whole job is to own a launcher. The dialog
 * the user actually sees belongs to the Meta AI app.
 *
 * Two things it does that iOS does not:
 *  - **The wait is BOUNDED** ([GlassesCameraAsk.ASK_WINDOW_MS]). The prompt lands
 *    in another app, so on a phone in a pocket it is answered whenever the phone
 *    is next picked up. iOS awaits it forever, which means the tool's own 90s
 *    poll expires and the user is told the glasses didn't answer.
 *  - **"Couldn't ask" keeps its reason.** The contract answers
 *    META_AI_NOT_INSTALLED *synchronously*, without ever starting an activity —
 *    and "install the Meta AI app" is not the same sentence as "not granted".
 *
 * ⚠️ A camera grant is DURABLE, unlike the per-capture screenshot consent, so a
 * grant arriving after the window is not consent applied to a moment it was
 * never given for. It merely lands too late for THIS ask and makes the next one
 * work — which is why a timeout reports "still waiting", not "denied".
 */
class GlassesCameraConsentActivity : ComponentActivity() {

    /**
     * ⚠️⚠️ MEASURED IN THE SDK's BYTECODE (mwdat-core 0.8.0), and it decides the
     * wording downstream: `RequestPermissionContract.parseResult` reads
     * `intent?.getStringExtra("permission_granted")`, answers
     * `success(Granted)` when it is in the SDK's granted set, and
     * **`success(Denied)` for everything else — including a null intent and a
     * RESULT_CANCELED code.** It has NO failure path at all.
     *
     * So "the user tapped Don't allow", "the user backed out of the prompt" and
     * "the system dismissed it" arrive here as the SAME value, and nothing
     * downstream may claim to know which. [GlassesCameraAsk.refusal] is worded
     * for that. (`onFailure` is still reachable — via the synchronous
     * META_AI_NOT_INSTALLED result, which is exactly the case worth naming.)
     */
    private val launcher = registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        result
            .onSuccess {
                GlassesCameraAsk.deliver(
                    if (it == PermissionStatus.Granted) CameraAsk.Granted else CameraAsk.NotGranted,
                )
            }
            .onFailure { error, _ -> GlassesCameraAsk.deliver(CameraAsk.Unavailable(error.description)) }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runCatching { launcher.launch(Permission.CAMERA) }
            .onFailure { t ->
                Log.w(TAG, "couldn't open the glasses camera ask", t)
                // Nothing was ever shown, so nobody said no — say exactly that,
                // or the rail reports a refusal the user never made.
                GlassesCameraAsk.deliver(
                    CameraAsk.Unavailable(t.message ?: "the Meta AI permission screen wouldn't open"),
                )
                finish()
            }
    }

    companion object {
        private const val TAG = "TinyGlassesCamera"

        fun launch(context: Context) {
            context.startActivity(
                Intent(context, GlassesCameraConsentActivity::class.java)
                    // The ask can fire while the app is backgrounded — an agent
                    // asked for the photo, not the person holding the phone.
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}

/** How a glasses-camera ask ended. */
sealed class CameraAsk {
    object Granted : CameraAsk()

    /**
     * The prompt was shown and came back without a grant. ⚠️ The SDK cannot say
     * whether it was declined, backed out of, or dismissed — see the launcher's
     * note above.
     */
    object NotGranted : CameraAsk()

    /** The ask never reached the user (Meta AI not installed, or it wouldn't open). */
    data class Unavailable(val reason: String) : CameraAsk()

    /** Our window closed with the prompt still standing in the Meta AI app. */
    object TimedOut : CameraAsk()
}

/** The one place a glasses-camera ask is made, and the rails' shared queue for it. */
object GlassesCameraAsk {

    /**
     * ⏱️ How long a rail waits for the Meta AI prompt to be answered.
     *
     * `meta_take_photo` polls 45 × 2s = 90s (`lib/chat/tools/platform.ts`), and
     * the whole capture — session walk (≤17s), stream up, shutter, JPEG encode,
     * /api/media, tool-result POST — still has to fit AFTER the grant. 25s is
     * what is left to spend on a finger. Longer and the tool expires with no
     * reason given at all; shorter and a user reaching for their phone misses
     * the window they were reaching for.
     */
    const val ASK_WINDOW_MS = 25_000L

    /**
     * ⚠️ Asks are serialized. The SDK has its own REQUEST_IN_PROGRESS error, and
     * all three rails can ask: a photo tool and the live HUD racing would put
     * two prompts on the Meta AI app and resolve one of them into the other
     * rail's await.
     */
    private val gate = Mutex()

    @Volatile private var pending: CompletableDeferred<CameraAsk>? = null

    /** One ask, front to back. Never throws — every ending is a [CameraAsk]. */
    suspend fun request(context: Context, windowMs: Long = ASK_WINDOW_MS): CameraAsk =
        await(windowMs) { GlassesCameraConsentActivity.launch(context) }

    /**
     * The wait itself, with the launch handed in — the part that has a deadline
     * and a race in it, and the only part a JVM test can reach (an Activity
     * cannot start in a unit test). Same seam as `WearablesBridge.awaitActive`.
     */
    internal suspend fun await(windowMs: Long, launch: () -> Unit): CameraAsk = gate.withLock {
        val answer = CompletableDeferred<CameraAsk>()
        pending = answer
        try {
            launch()
            withTimeoutOrNull(windowMs) { answer.await() } ?: CameraAsk.TimedOut
        } catch (t: Throwable) {
            CameraAsk.Unavailable(t.message ?: "the Meta AI permission screen wouldn't open")
        } finally {
            // Hygiene, not the guard: what actually keeps a LATE answer out of
            // the next ask is `pending = answer` above — each ask installs its
            // own slot, so a leftover one is replaced before anyone waits on it.
            // (Measured: mutating only this line changes no behaviour; mutating
            // both — reuse a standing slot AND never clear — is caught.) It
            // still earns its keep, because after a timeout the prompt stays up
            // in the Meta AI app and an answer minutes later then finds nothing
            // at all rather than a deferred nobody is holding.
            pending = null
        }
    }

    /** First writer wins; a late or duplicate delivery is a no-op. */
    internal fun deliver(outcome: CameraAsk) {
        pending?.complete(outcome)
    }

    /**
     * What a rail refuses with, or null when the camera is usable.
     *
     * ⚠️⚠️ NOT-GRANTED IS NEVER NARRATED AS "THE USER SAID NO." The SDK folds
     * declined, backed-out and system-dismissed into one value (measured — see
     * the launcher), so naming inaction would let the model tell someone they
     * ignored a prompt they may never have seen. That is the same confabulation
     * `lib/chat/tools/platform.ts` already refuses to commit for `screenshot`:
     * *"Do NOT tell the user they ignored a prompt."*
     *
     * The other two endings are worth another try and say which one they were —
     * "install the Meta AI app" is not the same problem as "you didn't get to
     * the phone in time".
     */
    fun refusal(outcome: CameraAsk): String? = when (outcome) {
        CameraAsk.Granted -> null
        CameraAsk.NotGranted ->
            "The glasses camera prompt came back without a grant — it may have been declined, or " +
                "closed before it was answered. Don't say which; the phone can't tell. It's granted " +
                "in the Meta AI app, and asking again re-opens that prompt."
        CameraAsk.TimedOut ->
            "The glasses camera prompt is open in the Meta AI app and still unanswered. Ask the user " +
                "to grant it there, then try again — the grant sticks, so the next try won't prompt."
        is CameraAsk.Unavailable ->
            "Couldn't ask for the glasses camera: ${outcome.reason}. The camera is granted inside the " +
                "Meta AI app, so it has to be installed and the glasses reachable."
    }
}
