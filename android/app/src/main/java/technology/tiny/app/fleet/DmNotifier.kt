package technology.tiny.app.fleet

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import org.json.JSONObject
import technology.tiny.app.MainActivity
import technology.tiny.app.R

/**
 * DM local notifications (iOS Notifications.swift / Session.refreshUnread parity).
 *
 * [syncUnread] is the single diff point: given the current `/api/messages`
 * threads, it compares each login's unread against a persisted snapshot and
 * fires a heads-up banner only for logins whose unread GREW — so a poll never
 * re-notifies the same message, and pre-existing unread on the first-ever poll
 * is primed silently (no startup banner blast). Called from both the foreground
 * fleet loop and the background [DmPollWorker], sharing one prefs snapshot so
 * the diff stays consistent across process/instance.
 *
 * Banner carries a RemoteInput quick-reply (→ [DmReplyReceiver]) and a tap
 * deep-link into the Messages thread. No FCM/APNs on the worker, so this is the
 * only DM-alert path; background freshness comes from WorkManager (~15 min).
 */
object DmNotifier {
    const val CHANNEL = "tiny_dms"
    const val REPLY_KEY = "dm_reply_text"
    const val EXTRA_LOGIN = "dm_login"
    const val EXTRA_OPEN_WITH = "open_messages_with"
    private const val PREFS = "tiny_dm"
    private const val KEY_SNAPSHOT = "unread_by_login"
    private const val KEY_PRIMED = "primed"

    // Serializes the syncUnread read-modify-write. Two schedulers call it in the
    // SAME process — the foreground FleetManager loop (~30s) and the background
    // DmPollWorker (~15min, WorkManager can run in-process while foregrounded).
    // Both do getString(snapshot) → diff → putString(snapshot); unsynchronized
    // they can both read the same prior, then last-writer-wins clobbers the
    // other's update → a message re-notifies (its growth lost from the snapshot)
    // or a genuine DM is suppressed. A single in-process monitor closes it.
    private val syncLock = Any()

    /** Stable per-login notification id so a reply/read replaces the same banner. */
    fun notifId(login: String): Int = ("dm_" + login).hashCode()

    private fun ensureChannel(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "direct messages", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "New DMs from other tiny people"
                    // DM bodies are private person-to-person content: on a lock
                    // screen the OS must show only the redacted public version
                    // (see setPublicVersion below), never the message text.
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
            )
        }
    }

    /**
     * Lock-screen safe redaction for a DM banner (pure so it's unit-testable).
     * Names the SENDER but NEVER the message body — this is exactly what shows
     * when the user's lock screen hides sensitive content. Mirrors iOS, whose
     * DM notifications carry the sender in the title and keep the body out of
     * the redacted preview.
     */
    fun lockscreenSummary(login: String): String = "💬 New message from @$login"

    private fun canPost(context: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Diff the fresh threads against the stored snapshot, banner grown unread,
     * persist the new snapshot, and return total unread. First call primes only.
     */
    fun syncUnread(context: Context, threads: List<DmThreadSnapshot>): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // The read → diff → write must be atomic vs. the other scheduler (see
        // syncLock). commit() (not apply()) so the snapshot is durable BEFORE the
        // lock is released — an async apply() could let a concurrent caller read
        // the pre-write snapshot even under the lock. The NotificationManager IPC
        // is done OUTSIDE the lock: banners are idempotent by notifId, so they
        // needn't be serialized, and holding a monitor across IPC is best avoided.
        val diff = synchronized(syncLock) {
            val prior = runCatching { JSONObject(prefs.getString(KEY_SNAPSHOT, "{}") ?: "{}") }.getOrElse { JSONObject() }
            val primed = prefs.getBoolean(KEY_PRIMED, false)
            val d = diff(prior, threads, primed)
            prefs.edit()
                .putString(KEY_SNAPSHOT, d.nextSnapshot.toString())
                .putBoolean(KEY_PRIMED, true)
                .commit()
            d
        }
        for (t in diff.toNotify) notifyNewDm(context, t.login, t.name, t.lastBody)
        return diff.total
    }

    /** Outcome of the pure unread diff: who to banner, the snapshot to persist, total unread. */
    data class UnreadDiff(val toNotify: List<DmThreadSnapshot>, val nextSnapshot: JSONObject, val total: Int)

    /**
     * Pure diff — the notify decision with NO Context/prefs/NotificationManager,
     * so the correctness-sensitive rule is unit-testable (mirrors iOS
     * Session.refreshUnread). A login is bannered only when ALL hold:
     *   1. we're [primed] (never blast on the first-ever poll), AND
     *   2. its unread GREW vs the [prior] snapshot (`>` strict — an unchanged or
     *      dropped count is a read/no-op, not a new message), AND
     *   3. it has a non-blank last body (nothing to show otherwise).
     * The returned snapshot records EVERY thread's current unread (even primed-only
     * ones) so the next poll diffs against the truth.
     */
    fun diff(prior: JSONObject, threads: List<DmThreadSnapshot>, primed: Boolean): UnreadDiff {
        var total = 0
        val next = JSONObject()
        val toNotify = ArrayList<DmThreadSnapshot>()
        for (t in threads) {
            total += t.unread
            next.put(t.login, t.unread)
            val before = prior.optInt(t.login, 0)
            if (primed && t.unread > before && t.lastBody.isNotBlank()) toNotify.add(t)
        }
        return UnreadDiff(toNotify, next, total)
    }

    /** Sign-out / manual clear: forget the snapshot so the next poll re-primes. */
    fun reset(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        NotificationManagerCompat.from(context).cancelAll()
    }

    /** Drop a specific login's banner once its thread is opened/read. */
    fun clear(context: Context, login: String) {
        NotificationManagerCompat.from(context).cancel(notifId(login))
    }

    fun notifyNewDm(context: Context, login: String, name: String?, body: String) {
        ensureChannel(context)
        if (!canPost(context)) return

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_WITH, login)
        }
        val tapPending = PendingIntent.getActivity(
            context, notifId(login), tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val remoteInput = RemoteInput.Builder(REPLY_KEY).setLabel("Message").build()
        val replyIntent = Intent(context, DmReplyReceiver::class.java).apply {
            action = DmReplyReceiver.ACTION_REPLY
            putExtra(EXTRA_LOGIN, login)
        }
        // Mutable so the system can fill in the typed reply via RemoteInput.
        val replyPending = PendingIntent.getBroadcast(
            context, notifId(login), replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val replyAction = NotificationCompat.Action.Builder(
            R.drawable.ic_launcher_foreground, "Reply", replyPending,
        ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()

        val who = Person.Builder().setName(name?.takeIf { it.isNotBlank() } ?: "@$login").build()
        val style = NotificationCompat.MessagingStyle(who).addMessage(body, System.currentTimeMillis(), who)

        // Redacted stand-in shown when the lock screen hides sensitive content:
        // the sender, but NOT the message body. Without a public version the OS
        // shows a bare "Contents hidden"; with the wrong flags it can leak the
        // full DM. Body stays only in the private (unlocked) notification.
        val publicVersion: Notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle(lockscreenSummary(login))
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        val notif = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle("💬 @$login")
            .setContentText(body.take(120))
            .setStyle(style)
            .setContentIntent(tapPending)
            .addAction(replyAction)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // Private: full content only when unlocked; the lock screen falls
            // back to publicVersion (sender only, no body). Belt-and-suspenders
            // with the channel's lockscreenVisibility (channel wins on API 26+,
            // this covers pre-26 + is the documented per-notification contract).
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .build()
        NotificationManagerCompat.from(context).notify(notifId(login), notif)
    }

    /** Banner-reply failed: re-post so a tap reopens the thread to resend (iOS parity). */
    fun notifyReplyFailed(context: Context, login: String, reason: String) {
        ensureChannel(context)
        if (!canPost(context)) return
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_WITH, login)
        }
        val tapPending = PendingIntent.getActivity(
            context, notifId(login) + 1, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle("Reply didn't send")
            .setContentText(reason)
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(context).notify(notifId(login) + 1, notif)
    }
}

/** Minimal thread projection the notifier diffs on (from `/api/messages` threads[]). */
data class DmThreadSnapshot(val login: String, val name: String?, val unread: Int, val lastBody: String)
