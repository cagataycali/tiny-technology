package technology.tiny.app.tools

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import technology.tiny.app.TinyApp

/**
 * ScreenshotConsentActivity — a transparent, no-UI activity that fires the
 * system MediaProjection consent dialog for the `screenshot` device tool. That
 * system dialog ("Start recording or casting with tiny?", showing the recording
 * indicator) IS the per-capture consent iOS asks with its in-app prompt — so we
 * lean on the OS rather than reinventing it, keeping the contended chat UI
 * untouched.
 *
 * Approve → hand the grant to [ScreenshotService] (which owns the mediaProjection
 * foreground service + the actual capture). Cancel/deny → post {denied:true} so
 * the model treats it as "the user said no" (iOS postDenied / web `p.denied`
 * parity) instead of a retryable error, then finish. Either way this activity
 * closes immediately — the user never sees a tiny screen, only the OS prompt.
 *
 * Launched from ChatViewModel off the `screenshot` beforeToolCallEvent; NEW_TASK
 * so it works even when the app is backgrounded when the tool fires.
 */
class ScreenshotConsentActivity : ComponentActivity() {

    private val launcher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        // The user answered, so the unattended-expiry timer must not also fire —
        // it would post "expired" over a grant that is capturing, or over a
        // decline, and the LAST write is what the poll reads.
        deadline?.cancel()
        val toolUseId = intent?.getStringExtra(EXTRA_TOOL_USE_ID)
        if (toolUseId == null) { finish(); return@registerForActivityResult }
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null && !isExpired()) {
            ScreenshotService.start(this, toolUseId, result.resultCode, data)
        } else if (result.resultCode == Activity.RESULT_OK && data != null) {
            // ⏱️ Granted, but the asking request is dead (see CONSENT_WINDOW_MS).
            // The system dialog survives a locked screen indefinitely, so this is
            // the ordinary outcome for a relay ask nobody was waiting for. Do NOT
            // capture: the screen in front of the user now is not the screen the
            // agent asked about, the projection would grab it anyway, and it
            // would be stored permanently for a poll that has long since given up.
            val app = applicationContext as TinyApp
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { Screenshot.postExpired(app, toolUseId) }
                    .onFailure { Log.w(TAG, "postExpired failed", it) }
            }
        } else {
            // User dismissed/denied the system consent dialog — first-class "no".
            val app = applicationContext as TinyApp
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { Screenshot.postDenied(app, toolUseId) }
                    .onFailure { Log.w(TAG, "postDenied failed", it) }
            }
        }
        finish()
    }

    /** Fires when the window closes with the dialog still unanswered. */
    private var deadline: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val toolUseId = intent?.getStringExtra(EXTRA_TOOL_USE_ID)
        if (toolUseId == null) { finish(); return }
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        runCatching { launcher.launch(mgr.createScreenCaptureIntent()) }
            .onSuccess { armDeadline(toolUseId) }
            .onFailure { t ->
                Log.w(TAG, "couldn't open capture consent", t)
                val app = applicationContext as TinyApp
                CoroutineScope(Dispatchers.IO).launch {
                    runCatching {
                        Screenshot.postDenied(app, toolUseId) // best we can do — capture unavailable
                    }
                }
                finish()
            }
    }

    /**
     * ⏳ Close the window without waiting for a finger.
     *
     * [isExpired] only ran INSIDE the result handler, i.e. only if the user ever
     * answered. The system projection dialog survives a locked screen
     * indefinitely, so the ordinary outcome of a relay ask — a phone in a pocket
     * — posted nothing at all: the server polled its full 90s and then told the
     * user it may have been ignored, or capture may be unavailable, or the app may
     * have been backgrounded. It could not tell which. A voice call waited 120s
     * and then said "capture timed out". Both are guesses about a thing the phone
     * knew. Now the phone answers, in time to be heard.
     *
     * Deliberately NOT on `lifecycleScope`: this activity is transparent and
     * finishes the moment the dialog is answered, and if the system destroys it
     * while the dialog is still up then "expired, nothing captured" is precisely
     * the truth to report — a lifecycle-bound timer would die exactly when it is
     * most needed. The result handler cancels it, so a real answer always wins.
     */
    private fun armDeadline(toolUseId: String) {
        val app = applicationContext as TinyApp
        deadline = CoroutineScope(Dispatchers.IO).launch {
            delay(CONSENT_WINDOW_MS)
            runCatching { Screenshot.postExpired(app, toolUseId) }
                .onFailure { Log.w(TAG, "deadline postExpired failed", it) }
        }
    }

    /** True once the asking request can no longer receive a result. */
    private fun isExpired(): Boolean {
        val asked = intent?.getLongExtra(EXTRA_ASKED_AT, 0L) ?: 0L
        // A missing stamp means an older caller — treat as live rather than
        // silently refusing every capture on a mixed-version install.
        if (asked <= 0L) return false
        return System.currentTimeMillis() - asked >= CONSENT_WINDOW_MS
    }

    companion object {
        private const val TAG = "TinyScreenshot"
        const val EXTRA_TOOL_USE_ID = "toolUseId"
        const val EXTRA_ASKED_AT = "askedAt"

        /**
         * How long the server callback waits: lib/chat/tools/platform.ts loops 45×
         * over `sleep(2s)` THEN check, so its last look is at t≈90s and the result
         * must already be in the mailbox by then.
         */
        const val SERVER_POLL_BUDGET_MS = 90_000L

        /**
         * What still has to happen after the tap: MediaProjection start, one frame,
         * the JPEG encode, /api/media, then the tool-result POST.
         */
        const val DELIVERY_GRACE_MS = 20_000L

        /**
         * ⏱️ How long a grant stays good for. iOS shares the arithmetic
         * (Screenshot.consentWindow = serverPollBudget - deliveryGrace).
         *
         * Without any window the system dialog outlives its request: it sits on the
         * lock screen indefinitely, and a tap an hour later captures whatever is on
         * screen THEN, for a request that is long gone — consent applied to a
         * moment it was never given for.
         *
         * ⚠️ And the window must land BELOW the poll budget, not above it. At
         * 100_000L (shipped briefly, 2026-08-02) a tap at t=95s counted as live,
         * captured, and uploaded to R2 *permanently* for a poll that was already
         * gone — the same rot, merely bounded. Consent must expire early enough
         * that what it authorises can still reach someone.
         */
        const val CONSENT_WINDOW_MS = SERVER_POLL_BUDGET_MS - DELIVERY_GRACE_MS

        /** Open the consent dialog for a screenshot tool call (app may be backgrounded). */
        fun launch(context: Context, toolUseId: String) {
            val intent = Intent(context, ScreenshotConsentActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_TOOL_USE_ID, toolUseId)
                // Stamped at ASK time, not at tap time — the window has to cover
                // the stretch where the dialog waits to be noticed.
                .putExtra(EXTRA_ASKED_AT, System.currentTimeMillis())
            context.startActivity(intent)
        }
    }
}
