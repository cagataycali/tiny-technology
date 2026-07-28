package technology.tiny.app.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app↔widget bridge (iOS WidgetStore.swift parity). One JSON snapshot in a
 * plain SharedPreferences file — the APP is the only writer (its heartbeat /
 * unread / chat loops know the truth), the Glance widgets only read.
 *
 * NOT the encrypted config store: widget code needs cheap, frequent reads and
 * holds no secrets (counts + the last exchange only, never the JWT).
 */
data class FleetSnapshot(
    val online: Int = 0,
    val total: Int = 0,
    val unread: Int = 0,
    val login: String = "",
    val accentHex: String? = null,
    val lastQ: String? = null,
    val lastA: String? = null,
    val lastAt: Long = 0L,
    val memories: List<String> = emptyList(),
    val updated: Long = 0L,
) {
    fun toJson(): String = JSONObject().apply {
        put("online", online)
        put("total", total)
        put("unread", unread)
        put("login", login)
        accentHex?.let { put("accentHex", it) }
        lastQ?.let { put("lastQ", it) }
        lastA?.let { put("lastA", it) }
        put("lastAt", lastAt)
        if (memories.isNotEmpty()) put("memories", JSONArray(memories))
        put("updated", updated)
    }.toString()

    companion object {
        fun fromJson(s: String): FleetSnapshot {
            val o = runCatching { JSONObject(s) }.getOrNull() ?: return FleetSnapshot()
            return FleetSnapshot(
                online = o.optInt("online"),
                total = o.optInt("total"),
                unread = o.optInt("unread"),
                login = o.optString("login"),
                accentHex = o.optString("accentHex").takeIf { it.isNotEmpty() },
                lastQ = o.optString("lastQ").takeIf { it.isNotEmpty() },
                lastA = o.optString("lastA").takeIf { it.isNotEmpty() },
                lastAt = o.optLong("lastAt"),
                memories = o.optJSONArray("memories")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotEmpty) }
                } ?: emptyList(),
                updated = o.optLong("updated"),
            )
        }
    }
}

object WidgetStore {
    private const val PREFS = "tiny_widget_store"
    private const val KEY = "fleet_snapshot"
    private const val LAST_LOGIN = "last_user_login"
    private const val BRIEFING_RUNNING = "briefing_running"

    // Serializes the snapshot read→copy→write. The "APP is the only writer" note
    // above is true but NOT single-threaded: updateFleet runs on the FleetManager
    // heartbeat (Dispatchers.IO, ~5min), updateExchange from a chat turn
    // (viewModelScope/main) AND the Briefing Glance action, and scrubIdentity from
    // sign-out — all in-process on different threads. Unsynchronized, a merge that
    // read snapshot S writes S+its-field back and clobbers a concurrent merge's
    // field (fresh exchange OR fresh presence silently lost). The dangerous one:
    // scrubIdentity racing a merge — the merge read the PRE-scrub snapshot and
    // writes it back AFTER the wipe, resurrecting the prior user's lastQ/lastA/
    // memories/login onto the home screen (the cross-user leak the scrub exists to
    // prevent). One in-process monitor around every read-modify-write closes it.
    private val snapshotLock = Any()

    /**
     * Record the just-signed-in login as a device anchor and report whether it
     * DIFFERS from the previously stored one (→ a different account took over this
     * device). Lives in this plaintext prefs file, NOT the encrypted auth store,
     * precisely because logout() clears the auth store — the anchor must outlive a
     * sign-out so User A → sign out → User B is still detected as a switch. Scrubs
     * only on a real change: a first login (no anchor) or same-user re-login after
     * a token expiry both return false, preserving that user's continuity (which
     * does NOT re-sync from the server). A blank login is ignored so a malformed
     * session response can't false-trigger or poison the anchor. (iOS bb0ed15.)
     */
    fun recordLoginDetectSwitch(context: Context, login: String): Boolean {
        if (login.isBlank()) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val prev = prefs.getString(LAST_LOGIN, null)
        prefs.edit().putString(LAST_LOGIN, login).apply()
        return !prev.isNullOrBlank() && prev != login
    }

    /**
     * Transient "briefing turn in flight" flag for the interactive Briefing widget
     * (iOS runs one PhoneBriefingIntent at a time). A plain bool beside the snapshot
     * — kept out of the JSON so flipping it twice per tap doesn't rewrite the whole
     * exchange payload. Best-effort feedback only; a lost write just misses the
     * "running…" label, never wedges a turn.
     */
    fun isBriefingRunning(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(BRIEFING_RUNNING, false)

    fun setBriefingRunning(context: Context, running: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(BRIEFING_RUNNING, running).apply()
    }

    fun read(context: Context): FleetSnapshot {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return FleetSnapshot()
        return FleetSnapshot.fromJson(raw)
    }

    fun write(context: Context, snap: FleetSnapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, snap.toJson()).apply()
    }

    /** Merge helper: update only the presence/unread fields, keep the last exchange. */
    fun updateFleet(context: Context, online: Int, total: Int, unread: Int, login: String, accentHex: String?, now: Long) {
        synchronized(snapshotLock) {
            val prev = read(context)
            write(
                context,
                prev.copy(
                    online = online, total = total, unread = unread, login = login,
                    accentHex = accentHex ?: prev.accentHex, updated = now,
                ),
            )
        }
    }

    /** Merge helper: record the newest exchange + memories, keep presence fields. */
    fun updateExchange(context: Context, q: String, a: String, memories: List<String>, now: Long) {
        synchronized(snapshotLock) {
            val prev = read(context)
            write(
                context,
                prev.copy(
                    lastQ = q.take(60), lastA = a.take(120), lastAt = now,
                    memories = memories.takeLast(12).map { it.take(100) },
                    updated = now,
                ),
            )
        }
    }

    /** Merge helper: refresh just the remembered facts (remember/forget tools). */
    fun updateMemories(context: Context, memories: List<String>, now: Long) {
        synchronized(snapshotLock) {
            val prev = read(context)
            write(context, prev.copy(memories = memories.takeLast(12).map { it.take(100) }, updated = now))
        }
    }

    /**
     * Sign-out scrub (iOS WatchCore.loggedOut parity): wipe every identity-bearing
     * field the home-screen widgets render — last exchange, remembered facts,
     * unread count, login, accent — but keep the harmless fleet counts. The loops
     * that would otherwise overwrite the snapshot are stopped at sign-out, so
     * without this the prior user's answer/memories/unread linger on the home
     * screen and bleed into the next user on the same device.
     */
    fun scrubIdentity(context: Context, now: Long) {
        synchronized(snapshotLock) {
            val prev = read(context)
            // commit() (not apply()) so the wipe is DURABLE before the lock
            // releases — an async apply() could let a merge that entered the
            // monitor next read the un-scrubbed value and write it back.
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(
                    KEY,
                    FleetSnapshot(
                        online = prev.online, total = prev.total, // harmless counts survive
                        updated = now,
                    ).toJson(),
                )
                .commit()
        }
    }
}
