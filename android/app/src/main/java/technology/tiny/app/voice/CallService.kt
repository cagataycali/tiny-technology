package technology.tiny.app.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import technology.tiny.app.MainActivity
import technology.tiny.app.R

/**
 * Foreground service for a live 📞 call — keeps the microphone + playback
 * alive when the app backgrounds or the screen locks. Without it, modern
 * Android cuts AudioRecord the moment the activity loses foreground, so a
 * call silently died on screen-off (iOS gets the same survival from the
 * `audio` UIBackgroundMode).
 *
 * Deliberately holds NO call logic: VoiceCall owns the WS + audio engine;
 * this service only carries the microphone|mediaPlayback foreground
 * privilege and the "in call — tap to return" notification. Started when a
 * call goes LIVE (the activity is foregrounded then, which API 34+ requires
 * for a microphone-typed FGS), stopped on ENDED/ERROR/dismiss.
 */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat(intent?.getStringExtra(EXTRA_TINY) ?: "tiny")
        // If the system kills us mid-call the call is already gone (the WS
        // lives in the app process) — don't resurrect a zombie notification.
        return START_NOT_STICKY
    }

    private fun startForegroundCompat(tiny: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown while you're in a live call with a tiny"
                    },
                )
            }
        }
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_shortcut_voice)
            .setContentTitle("📞 In call with $tiny")
            .setContentText("The call keeps running with the screen off — tap to return")
            .setContentIntent(tap)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(
                NOTIF_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    companion object {
        private const val CHANNEL_ID = "voice-call"
        private const val NOTIF_ID = 48
        const val EXTRA_TINY = "tiny"

        fun start(ctx: Context, tiny: String) {
            ContextCompat.startForegroundService(
                ctx,
                Intent(ctx, CallService::class.java).putExtra(EXTRA_TINY, tiny),
            )
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, CallService::class.java))
        }
    }
}
