package technology.tiny.app.tools

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import technology.tiny.app.R

/** Fires an agent-scheduled local alert (schedule_alert tool). */
class AlertWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        // title carries the agent's reminder; body is optional detail (iOS parity).
        val title = inputData.getString("title") ?: return Result.success()
        val body = inputData.getString("body").orEmpty()
        val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "tiny alerts", NotificationManager.IMPORTANCE_HIGH)
        )
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) {
            val builder = NotificationCompat.Builder(applicationContext, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_tiny)
                .setContentTitle("⏰ $title")
                .setAutoCancel(true)
            if (body.isNotEmpty()) builder.setContentText(body)
            // Notification id derived from THIS work request's UUID (the same string
            // stored as AlertRecord.id), not the wall clock. A time-derived id
            // (System.currentTimeMillis()) collides when two alerts fire in the same
            // millisecond — one banner silently replaces the other — and is
            // unrecoverable, so the banner could never be individually cancelled the
            // way AlertStore cancels the WorkManager job by its UUID. A UUID-derived
            // id is unique per alert and reproducible from the record id.
            NotificationManagerCompat.from(applicationContext).notify(
                notificationId(id.toString()),
                builder.build(),
            )
        }
        return Result.success()
    }

    companion object {
        const val TAG = "agent-alert"
        const val CHANNEL = "tiny_alerts"

        /**
         * Stable notification id for an alert, derived from its WorkManager request
         * UUID string (== AlertRecord.id). Same input → same id, so the banner is
         * reproducibly addressable (a future per-alert cancel can target it); distinct
         * UUIDs → distinct ids, so two alerts firing the same millisecond no longer
         * collide. hashCode can be Int.MIN_VALUE, whose abs() overflows back to
         * negative — mask to non-negative rather than abs() so the id is always a
         * clean positive int. A blank/absent id degrades to 0 (single fallback bucket).
         */
        fun notificationId(workId: String): Int =
            if (workId.isEmpty()) 0 else workId.hashCode() and Int.MAX_VALUE
    }
}
