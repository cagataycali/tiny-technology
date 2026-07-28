package technology.tiny.app.fleet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import technology.tiny.app.TinyApp

/**
 * Handles the notification quick-reply (RemoteInput) from [DmNotifier].
 * Sends the typed text as a DM with `viaTiny="android-notification"`
 * (platform-tagged, mirroring iOS's per-surface value "ios-notification").
 *
 * There's no on-screen draft to preserve for a banner reply, so a send failure
 * surfaces as a fresh "Reply didn't send" notification (iOS Notifications.swift
 * parity) whose tap reopens the thread to resend.
 */
class DmReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY) return
        val login = intent.getStringExtra(DmNotifier.EXTRA_LOGIN) ?: return
        val text = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(DmNotifier.REPLY_KEY)?.toString()?.trim()
        if (text.isNullOrEmpty()) return

        // BroadcastReceiver.onReceive must return fast; keep the process alive
        // for the network call via goAsync(). Own the scope in a val so finally can
        // CANCEL it — a bare CoroutineScope(Dispatchers.IO) is never cancelled, so if
        // the send somehow outlived goAsync's keep-alive (postJson's own callTimeout
        // is 30s, longer than the ~10s a receiver is guaranteed alive) the coroutine
        // would be orphaned against a possibly-reclaimed process. SupervisorJob so a
        // failure can't propagate to any sibling (there are none, but it keeps the
        // scope well-formed).
        val pending = goAsync()
        val app = context.applicationContext as TinyApp
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            try {
                val res = app.api.postJson(
                    "/api/messages",
                    JSONObject()
                        .put("to", login)
                        .put("message", text.take(2000))
                        .put("viaTiny", "android-notification"),
                )
                val status = res.optInt("_status", 200)
                val okFalse = res.has("ok") && !res.optBoolean("ok", true)
                if (status >= 400 || okFalse) {
                    val reason = res.optString("error").ifBlank { "Open tiny to try again." }
                    DmNotifier.notifyReplyFailed(context, login, reason)
                } else {
                    // Sent — the banner it replied to has already been dismissed by the
                    // system on reply; refresh unread so the badge/snapshot settle.
                    DmNotifier.clear(context, login)
                    app.fleet.refreshUnread()
                }
            } catch (t: Throwable) {
                Log.w("TinyDM", "reply send failed: ${t.message}")
                DmNotifier.notifyReplyFailed(context, login, "Couldn't reach tiny — open the app to resend to @$login.")
            } finally {
                pending.finish()
                // Release the process AND tear down the scope so nothing outlives the
                // broadcast (the launch has completed by the time finally runs).
                scope.cancel()
            }
        }
    }

    companion object {
        const val ACTION_REPLY = "technology.tiny.app.DM_REPLY"
    }
}
