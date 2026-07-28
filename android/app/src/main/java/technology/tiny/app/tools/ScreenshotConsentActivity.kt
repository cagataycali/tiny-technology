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
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            ScreenshotService.start(this, toolUseId, result.resultCode, data)
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

    companion object {
        private const val TAG = "TinyScreenshot"
        const val EXTRA_TOOL_USE_ID = "toolUseId"

        /** Open the consent dialog for a screenshot tool call (app may be backgrounded). */
        fun launch(context: Context, toolUseId: String) {
            val intent = Intent(context, ScreenshotConsentActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_TOOL_USE_ID, toolUseId)
            context.startActivity(intent)
        }
    }
}
