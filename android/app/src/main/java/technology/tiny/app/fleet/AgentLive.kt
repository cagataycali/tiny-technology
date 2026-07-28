package technology.tiny.app.fleet

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import technology.tiny.app.MainActivity
import technology.tiny.app.R
import technology.tiny.app.TinyApp

/**
 * Per-turn live status (Android analog of iOS AgentLive.swift / the Live Activity
 * + Dynamic Island). While a turn streams, a low-importance, silent, ongoing
 * notification tracks what the agent is doing — "thinking…" → "running <tool>…"
 * → "N/M agents" → the answer preview on finish. iOS's ActivityKit card is
 * foreground-start-only; a plain ongoing notification has no such limit, so this
 * even works for a turn that begins while the phone is locked (e.g. a relayed
 * ask). Distinct from RelayService's always-on chip (id 42, that's presence);
 * this is id 43 and lives only for the duration of one turn.
 *
 * Single live turn at a time (start() clears any prior, mirroring iOS end()).
 * Gated on the per-turn-activity config toggle + POST_NOTIFICATIONS.
 */
object AgentLive {
    const val CHANNEL = "tiny_turn"
    const val NOTIF_ID = 43
    private const val LINGER_MS = 4000L

    // Live state for the current turn so update()s don't need to re-thread it.
    private var tiny: String = "tiny"
    private var prompt: String = ""
    private var active = false
    private val main = Handler(Looper.getMainLooper())
    // Cancels a scheduled post-finish dismissal if a new turn starts first.
    private var dismiss: Runnable? = null

    private fun enabled(context: Context): Boolean {
        val app = context.applicationContext as? TinyApp ?: return false
        if (!app.config.turnActivity) return false
        return android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "turn activity", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Live status while your tiny is answering"
                    setShowBadge(false)
                },
            )
        }
    }

    fun start(context: Context, tiny: String, prompt: String) {
        // State is captured even when the chip itself is gated off — the
        // StreamGuardService's mandatory FGS notification reuses it, so the
        // guard shows the real tiny/prompt regardless of the chip toggle.
        this.tiny = tiny.ifBlank { "tiny" }
        this.prompt = prompt.trim().take(80)
        if (!enabled(context)) return
        dismiss?.let { main.removeCallbacks(it) }
        dismiss = null
        active = true
        ensureChannel(context)
        post(context, "🤔 thinking…", ongoing = true)
    }

    fun tool(context: Context, name: String?) {
        if (!active) return
        val label = name?.takeIf { it.isNotBlank() }?.let { "⚙ running $it…" } ?: "🤔 thinking…"
        post(context, label, ongoing = true)
    }

    fun spawn(context: Context, done: Int, total: Int) {
        if (!active || total <= 0) return
        post(context, "🧩 $done/$total agents", ongoing = true)
    }

    /** Stream ended: flip to a done/failed chip with the answer preview, linger, dismiss. */
    fun finish(context: Context, error: Boolean, preview: String? = null) {
        if (!active) return
        active = false
        if (!enabled(context)) { cancel(context); return }
        val status = if (error) "⚠️ failed" else "✓ done"
        val body = preview?.trim()?.replace(Regex("\\s+"), " ")?.take(120)?.takeIf { it.isNotBlank() }
        post(context, status, ongoing = false, body = body)
        // Linger so the result is visible, then clear (iOS dismisses after ~2s).
        val r = Runnable { cancel(context) }
        dismiss = r
        main.postDelayed(r, LINGER_MS)
    }

    /** Hard clear — sign-out / channel teardown. */
    fun cancel(context: Context) {
        active = false
        dismiss?.let { main.removeCallbacks(it) }
        dismiss = null
        runCatching { NotificationManagerCompat.from(context).cancel(NOTIF_ID) }
    }

    /**
     * True while notification id 43 is (or should be) on screen — mid-turn or
     * lingering on the post-finish "✓ done". StreamGuardService.onDestroy uses
     * this to decide DETACH (hand the chip back to AgentLive's linger/cancel)
     * vs REMOVE (nothing left to own it).
     */
    fun chipVisible(): Boolean = active || dismiss != null

    /**
     * The notification StreamGuardService promotes via startForeground — the
     * SAME id-43 chip content as start()'s "thinking…" post, so adopting it is
     * visually seamless (silent + onlyAlertOnce = no flicker, no re-alert).
     * Built unconditionally: an FGS must always supply a notification, even
     * when the chip toggle/permission would gate a plain post().
     */
    fun buildGuardNotification(context: Context): android.app.Notification {
        ensureChannel(context)
        return build(context, "🤔 thinking…", ongoing = true)
    }

    private fun post(context: Context, status: String, ongoing: Boolean, body: String? = null) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        runCatching { NotificationManagerCompat.from(context).notify(NOTIF_ID, build(context, status, ongoing, body)) }
    }

    private fun build(context: Context, status: String, ongoing: Boolean, body: String? = null): android.app.Notification {
        val tap = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = body ?: prompt.takeIf { it.isNotBlank() } ?: "your tiny is working"
        return NotificationCompat.Builder(context, CHANNEL)
            .setContentTitle("$tiny · $status")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentIntent(tap)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setSilent(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
