package technology.tiny.app.fleet

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONObject
import technology.tiny.app.TinyApp
import java.util.concurrent.TimeUnit

/**
 * Background DM freshness (WorkManager, ~15 min — the OS minimum period).
 * The foreground fleet loop polls every 30s while the app is open; this worker
 * keeps DM banners flowing when it's closed — the Android advantage over iOS,
 * which is dead when locked (no APNs on the worker). Also sends a heartbeat so
 * the fleet node doesn't silently drop off the roster between foreground sessions.
 */
class DmPollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as TinyApp
        if (!app.auth.isLoggedIn) return Result.success()

        // Opportunistic heartbeat (best-effort; enroll already happened foreground).
        val devId = app.auth.deviceId
        val devTok = app.auth.deviceToken
        if (devId != null && devTok != null) {
            runCatching {
                app.api.postJson(
                    "/api/devices/heartbeat",
                    JSONObject().put("deviceId", devId).put("token", devTok),
                )
            }
        }

        val res = runCatching { app.api.getJson("/api/messages") }.getOrNull()
            ?: return Result.retry()
        val arr = res.optJSONArray("threads") ?: return Result.success()
        val threads = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { t ->
                DmThreadSnapshot(
                    login = t.optString("login"),
                    name = t.optString("name").takeIf { it.isNotEmpty() },
                    unread = t.optInt("unread"),
                    lastBody = t.optString("lastBody"),
                )
            }
        }
        val total = DmNotifier.syncUnread(applicationContext, threads)
        Log.i("TinyDM", "bg poll: $total unread across ${threads.size} threads")
        return Result.success()
    }

    companion object {
        private const val NAME = "tiny-dm-poll"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<DmPollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                NAME, ExistingPeriodicWorkPolicy.KEEP, req,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
