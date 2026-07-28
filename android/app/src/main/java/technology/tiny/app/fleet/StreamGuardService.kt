package technology.tiny.app.fleet

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Stream guard — a foreground service that exists ONLY while at least one chat
 * stream is live. A streaming reply collects in ChatViewModel's viewModelScope,
 * which survives onStop but dies with the process; once the Activity backgrounds
 * (Home, lock, app switch) the process is just another cached app the OS may
 * reclaim, killing the turn mid-answer. Holding foreground-service priority for
 * the stream's duration makes backgrounded replies genuinely survive.
 *
 * ChatViewModel is the sole driver: started when liveIds goes 0→1 (send()'s
 * claim site), stopped when the LAST stream releases (the finally path) and in
 * stopAll(). No new notification chrome: this service promotes the EXISTING
 * per-turn AgentLive chip (id 43) as its mandatory FGS notification —
 * AgentLive's tool()/spawn() updates keep working (notify(43) on a foregrounded
 * service just updates its notification).
 *
 * Notification-ownership order on finish (see ChatViewModel's finally): the
 * service is stopped BEFORE AgentLive.finish() posts "✓ done" — while
 * foregrounded the service pins id 43, so onDestroy hands the chip back
 * (DETACH when it's still visible) and the chip's own linger + cancel flow can
 * actually remove it.
 *
 * Deliberately NOT sticky (contrast RelayService): a guard restarted by the OS
 * has no stream left to guard — the stream died with the process, and
 * loadHistory's reconcile marks the orphaned turn retryable instead.
 */
class StreamGuardService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 14+ requires reaching startForeground() promptly after
        // startForegroundService() — do it first thing, before anything else.
        val notif = AgentLive.buildGuardNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(AgentLive.NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(AgentLive.NOTIF_ID, notif)
        }
        Log.i(TAG, "stream guard up — a chat stream is live")
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // Hand notification id 43 back to AgentLive: mid-turn or lingering on
        // "✓ done" → DETACH so the chip's own update/linger/cancel flow finishes
        // the job; chip already cancelled (or never shown — turnActivity off /
        // notifications denied) → REMOVE so the guard's startForeground
        // notification can't be orphaned with no owner left to clear it.
        stopForeground(if (AgentLive.chipVisible()) STOP_FOREGROUND_DETACH else STOP_FOREGROUND_REMOVE)
        Log.i(TAG, "stream guard down")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "TinyStreamGuard"

        /**
         * Start guarding (liveIds 0→1). send() can fire with the app NOT
         * foregrounded — the offline queue drains on reconnect and on
         * last-stream-release, and a voice utterance can land right after
         * backgrounding — where API 31+ throws
         * ForegroundServiceStartNotAllowedException. Degrade gracefully to the
         * pre-guard behavior: the stream still runs, just without FGS priority.
         */
        fun start(context: Context) {
            val intent = Intent(context, StreamGuardService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.onFailure {
                Log.w(TAG, "guard not started (background-start restriction?) — stream runs unguarded", it)
            }
        }

        /** Stop guarding (last stream released / stopAll). Call BEFORE AgentLive.finish/cancel. */
        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, StreamGuardService::class.java)) }
        }
    }
}
