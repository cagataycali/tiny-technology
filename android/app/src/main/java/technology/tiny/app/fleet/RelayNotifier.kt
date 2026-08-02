package technology.tiny.app.fleet

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import technology.tiny.app.MainActivity
import technology.tiny.app.R
import technology.tiny.app.tools.AlertWorker

/**
 * Native leg of the worker's push system: the worker mirrors every web push
 * (DM, job result, tiny visit) as a {type:'notify'} relay envelope
 * (push.ts relayPushToDevices), which FleetManager's 5s poll hands here.
 *
 * Routing is by the worker's own push tags — the single naming contract:
 *   dm-<senderId>      → DON'T banner from the payload; poke the DM poll so
 *                        DmNotifier stays the one DM path (MessagingStyle,
 *                        quick-reply, unread snapshot — no double banners:
 *                        syncUnread only fires on unread GROWTH).
 *   tiny-job-<id>      → heads-up on AlertWorker's "tiny alerts" channel.
 *   tiny-visit-<slug>  → silent chip on the low-importance activity channel
 *                        (visits are ambient; the worker already throttles
 *                        them to one per 5 min per tiny).
 *   anything else      → activity channel (quiet default for future kinds).
 *
 * Notification ids hash the tag, so a re-push with the same tag replaces its
 * banner — the exact semantics the web SW gets from the Notification tag.
 */
object RelayNotifier {
    const val CHANNEL_ACTIVITY = "tiny_activity"

    sealed class Route {
        data object DmPoke : Route()
        data class Banner(
            val channel: String,
            val notifId: Int,
            val tinySlug: String?,
            // The push url's ?q= redeem turn (worker buildDeviceResultPush /
            // web spawn.ts buildBatchPush) — a tap converts it to a TRUSTED
            // tinyapp://ask?q= so the banner lands on the fetched result,
            // exactly like the web notification click (native tap→redeem).
            val redeemQ: String? = null,
        ) : Route()
    }

    /** Pure tag→route decision (see class doc for the contract). */
    fun classify(tag: String, url: String): Route = when {
        tag.startsWith("dm-") || url.contains("?dm=") -> Route.DmPoke
        tag.startsWith("tiny-job-") -> Route.Banner(AlertWorker.CHANNEL, tag.hashCode(), tinySlug(url), redeemQuery(url))
        // A finished use_device background task (worker relay.ts
        // buildDeviceResultPush): the user explicitly fired this work and is
        // waiting on it — a heads-up like a job result, not a silent chip.
        tag.startsWith("device-result-") -> Route.Banner(AlertWorker.CHANNEL, tag.hashCode(), tinySlug(url), redeemQuery(url))
        tag.startsWith("batch-") -> Route.Banner(AlertWorker.CHANNEL, tag.hashCode(), tinySlug(url), redeemQuery(url))
        else -> Route.Banner(CHANNEL_ACTIVITY, tag.hashCode(), tinySlug(url), redeemQuery(url))
    }

    /**
     * Pure: the auto-send text a push url carries (`/?q=<urlencoded turn>`).
     * Manual string parsing, not android.net.Uri — this runs in JVM unit
     * tests like tinySlug, and Uri is an Android framework class there.
     */
    fun redeemQuery(url: String): String? {
        val raw = url.substringAfter('?', "").split('&')
            .firstOrNull { it.startsWith("q=") }?.substringAfter('=') ?: return null
        return runCatching { java.net.URLDecoder.decode(raw, "UTF-8") }
            .getOrNull()?.takeIf { it.isNotBlank() }
    }

    /**
     * Pure: the tiny slug a push url deep-links to, or null when the url isn't
     * a plain tiny page ("/" home, "/@login" profiles — no in-app screen yet).
     */
    fun tinySlug(url: String): String? {
        val path = url.substringBefore('?').removePrefix("/")
        return path.takeIf { it.isNotEmpty() && !it.startsWith("@") && !it.contains('/') }
    }

    fun handle(context: Context, payload: JSONObject, onDmPoke: () -> Unit) {
        val tag = payload.optString("tag")
        val url = payload.optString("url")
        when (val route = classify(tag, url)) {
            is Route.DmPoke -> onDmPoke()
            is Route.Banner -> banner(
                context, route,
                title = payload.optString("title").ifEmpty { "tiny" },
                body = payload.optString("body"),
            )
        }
    }

    private fun banner(context: Context, route: Route.Banner, title: String, body: String) {
        ensureChannels(context)
        if (!canPost(context)) return

        // Redeem turn → TRUSTED tinyapp://ask?q= (package-scoped, never
        // BROWSABLE — MainActivity auto-sends only on this origin, so a tap
        // lands on the fetched result like the web notification click);
        // slug → the same tinyapp://tiny deep link the launcher shortcuts
        // use; otherwise just open the app.
        val tapIntent = when {
            route.redeemQ != null ->
                Intent(Intent.ACTION_VIEW, Uri.parse("tinyapp://ask?q=${Uri.encode(route.redeemQ)}"))
                    .setPackage(context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            route.tinySlug != null ->
                Intent(Intent.ACTION_VIEW, Uri.parse("tinyapp://tiny?name=${route.tinySlug}"))
                    .setPackage(context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            else -> Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
        }
        val tapPending = PendingIntent.getActivity(
            context, route.notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // The body is worker-authored content — a job/agent result or a visit
        // note — that can carry private detail (what the agent found, who visited
        // which tiny). On a lock screen that shows notification content it was
        // fully readable without unlocking, and there was no public (redacted)
        // version, so the OS had nothing safer to fall back to. Show only the
        // TITLE on the lock screen (already a generic label — "tiny", the job
        // name); the body stays in the unlocked notification. Mirrors the DM
        // fix, kept proportional: DM redacts to sender-only, this to title-only.
        val publicVersion: Notification = NotificationCompat.Builder(context, route.channel)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle(title)
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .build()

        val notif = NotificationCompat.Builder(context, route.channel)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle(title)
            .setContentText(body.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .build()
        NotificationManagerCompat.from(context).notify(route.notifId, notif)
    }

    // Stable ids for the ambient fleet-node traces (below) so a repeat replaces
    // rather than stacks; kept out of the tag-hash space used by push banners.
    val REENROLL_NOTIF_ID = "fleet-reenroll".hashCode()

    /**
     * Ambient fleet-node trace on the activity channel (iOS Notify.post from a
     * background wake — Session.swift re-enroll + "web agent reached your phone").
     * The phone did something while the user was away; leave a trace in the shade
     * so they know. Silent by design (activity channel is LOW) — a record, not an
     * interruption — and tapping just opens the app.
     */
    fun notifyFleetTrace(context: Context, id: Int, title: String, body: String) {
        ensureChannels(context)
        if (!canPost(context)) return
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tapPending = PendingIntent.getActivity(
            context, id, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Same lock-screen discipline as banner(): the body describes what the
        // phone did while away (which agent reached it, what it found) — keep it
        // off the lock screen behind a title-only public version.
        val publicVersion: Notification = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle(title)
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .build()

        val notif = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentTitle(title)
            .setContentText(body.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .build()
        NotificationManagerCompat.from(context).notify(id, notif)
    }

    private fun ensureChannels(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // AlertWorker creates its channel on first alert; a job push can land
        // before any alert ever fired, so create it here too (same spec).
        if (nm.getNotificationChannel(AlertWorker.CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(AlertWorker.CHANNEL, "tiny alerts", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        if (nm.getNotificationChannel(CHANNEL_ACTIVITY) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ACTIVITY, "activity", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Ambient activity around your tinys (visits and the like)"
                },
            )
        }
    }

    private fun canPost(context: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
}
