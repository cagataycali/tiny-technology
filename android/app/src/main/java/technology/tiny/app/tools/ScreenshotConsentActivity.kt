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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val toolUseId = intent?.getStringExtra(EXTRA_TOOL_USE_ID)
        if (toolUseId == null) { finish(); return }
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        runCatching { launcher.launch(mgr.createScreenCaptureIntent()) }
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
         * ⏱️ How long a grant stays good for — the web callback polls 90s
         * (lib/chat/tools/platform.ts), plus a small grace for capture+upload.
         * iOS shares the number (Screenshot.consentWindow).
         *
         * Without it the system dialog outlives its request: it sits on the lock
         * screen indefinitely, and a tap an hour later captures whatever is on
         * screen THEN, for a request that is long gone — consent applied to a
         * moment it was never given for.
         */
        const val CONSENT_WINDOW_MS = 100_000L

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
