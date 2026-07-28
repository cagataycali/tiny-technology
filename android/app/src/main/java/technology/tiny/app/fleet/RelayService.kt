package technology.tiny.app.fleet

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
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import technology.tiny.app.MainActivity
import technology.tiny.app.R
import technology.tiny.app.TinyApp

/**
 * Always-on fleet node. When the user enables "keep me reachable", this
 * foreground service holds the FleetManager's heartbeat (30s) + relay (5s)
 * loops alive after the Activity backgrounds — so the web agent can reach this
 * phone even while it's locked. This is the Android edge iOS can't match (iOS
 * is dead when locked; its 15m WorkManager-equivalent floor is BGTask-bound).
 *
 * The persistent notification is mandatory on O+ and doubles as a live status
 * chip (fleet online/offline). Tapping it opens the app.
 */
class RelayService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onlineJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val app = application as TinyApp
        // Not logged in → nothing to serve; back off so we don't spin a dead node.
        if (!app.auth.isLoggedIn) {
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel(this)
        startForegroundCompat(buildNotification(online = app.fleet.online.value))
        app.fleet.start()

        // Live-update the chip as presence flips (kept lightweight — text only).
        onlineJob?.cancel()
        onlineJob = app.fleet.online
            .onEach { online ->
                val nm = getSystemService(NotificationManager::class.java)
                nm?.notify(NOTIF_ID, buildNotification(online))
            }
            .launchIn(scope)

        Log.i("TinyFleet", "RelayService started — always-on node")
        return START_STICKY // relaunch if the OS reclaims us
    }

    override fun onDestroy() {
        onlineJob?.cancel()
        scope.cancel()
        // Only tear the loops down if the user actually turned always-on off;
        // if the OS killed us with START_STICKY we'll be recreated and re-start().
        val app = application as TinyApp
        if (!app.config.alwaysOn) app.fleet.stop()
        Log.i("TinyFleet", "RelayService destroyed (alwaysOn=${app.config.alwaysOn})")
        super.onDestroy()
    }

    private fun startForegroundCompat(notif: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(online: Boolean): Notification {
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, RelayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(if (online) "tiny · fleet node online" else "tiny · connecting…")
            .setContentText("Your phone is reachable by your agent")
            .setSmallIcon(R.drawable.ic_stat_tiny)
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "stop", stopIntent)
            .build()
    }

    companion object {
        const val CHANNEL = "tiny_fleet_node"
        const val NOTIF_ID = 42
        const val ACTION_STOP = "technology.tiny.app.STOP_RELAY"

        private fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL, "fleet node", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Keeps your phone reachable by your tiny agent"
                        setShowBadge(false)
                    },
                )
            }
        }

        /** Start/stop the always-on node to match the current config toggle. */
        fun sync(context: Context) {
            val app = context.applicationContext as TinyApp
            if (app.config.alwaysOn && app.auth.isLoggedIn) start(context) else stop(context)
        }

        fun start(context: Context) {
            val intent = Intent(context, RelayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayService::class.java))
        }
    }
}
