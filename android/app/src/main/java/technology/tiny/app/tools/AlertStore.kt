package technology.tiny.app.tools

import android.content.Context
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject

/** One agent-scheduled on-device alert (schedule_alert). `id` is the WorkManager
 *  request UUID string, so it can be cancelled individually. */
data class AlertRecord(val id: String, val title: String, val body: String, val fireAt: Long)

/**
 * Sidecar metadata for schedule_alert notifications. WorkManager's WorkInfo exposes
 * neither the input data (title/body) nor the scheduled fire time, so the Jobs panel
 * can't list device-local alerts without this — mirrors iOS reading pending
 * UNUserNotificationCenter requests. Plaintext (no secrets), keyed by the work UUID.
 */
object AlertStore {
    private const val PREFS = "tiny_alerts"
    private const val KEY = "pending"

    // Serializes the load→mutate→save read-modify-writes. The sidecar is written
    // from multiple in-process threads: add() from DeviceTools.scope
    // (Dispatchers.Default) when the agent schedules an alert mid-stream, while
    // loadPending() (prune+persist) and remove() run from the Jobs panel
    // (composition/UI thread), and scrubAll()→clear() from sign-out. Unsynchronized,
    // an add racing a prune both read the same base list and last-writer-wins drops
    // one: either the new alert vanishes from the sidecar (its WorkManager job still
    // FIRES but the Jobs UI can't show or individually cancel it) or the prune is
    // lost. Same RMW-race class as DmNotifier.syncUnread + WidgetStore. One
    // in-process monitor around every read-modify-write closes it.
    private val lock = Any()

    fun add(context: Context, rec: AlertRecord) {
        synchronized(lock) { save(context, load(context) + rec) }
    }

    /**
     * Still-pending alerts (fireAt in the future), soonest first. Any whose time has
     * already passed (fired or missed while the app was dead) are pruned and the prune
     * is persisted — so the list only shows alerts the user can still act on.
     */
    fun loadPending(context: Context, now: Long): List<AlertRecord> = synchronized(lock) {
        val all = load(context)
        val pending = pendingFrom(all, now)
        if (pending.size != all.size) save(context, pending)
        pending
    }

    /**
     * Pure filter+sort behind [loadPending]: keep only alerts still in the future
     * (fireAt STRICTLY > now — one firing this instant has already been handed to the
     * user), soonest first. Extracted Context-free so the prune boundary + ordering
     * are JVM-unit-testable; the Jobs panel lists exactly this, so a `>=` slip would
     * surface an already-fired alert and a bad sort would misorder the countdown.
     */
    fun pendingFrom(all: List<AlertRecord>, now: Long): List<AlertRecord> =
        all.filter { it.fireAt > now }.sortedBy { it.fireAt }

    fun remove(context: Context, id: String) {
        synchronized(lock) { save(context, load(context).filterNot { it.id == id }) }
    }

    fun clear(context: Context) {
        // commit() (not apply()) so the wipe is durable before the lock releases —
        // scrubAll() calls this on sign-out, and an async apply() could let a
        // concurrent add() that entered the monitor next read the pre-clear list.
        synchronized(lock) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).commit()
        }
    }

    /**
     * Cancel every scheduled alert AND drop its sidecar record — the full teardown
     * the `cancel_alerts` device tool does, named so the account-switch scrub can
     * reuse the exact same two-step (a bare [clear] would orphan the WorkManager
     * jobs, which would still FIRE — with the prior user's title/body — on the new
     * user's device). Agent-scheduled alerts are per-user content, keyed by the
     * device-level tiny name, so a different account signing in must not inherit
     * (or be woken by) them.
     */
    fun scrubAll(context: Context) {
        WorkManager.getInstance(context).cancelAllWorkByTag(AlertWorker.TAG)
        clear(context)
    }

    private fun load(context: Context): List<AlertRecord> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let {
                    AlertRecord(it.optString("id"), it.optString("title"), it.optString("body"), it.optLong("fireAt"))
                }
            }
        }.getOrElse { emptyList() }
    }

    private fun save(context: Context, list: List<AlertRecord>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("title", it.title)
                    .put("body", it.body).put("fireAt", it.fireAt)
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, arr.toString()).apply()
    }
}
