package technology.tiny.wear

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import technology.tiny.app.wear.WatchCore
import technology.tiny.app.wear.WatchTurn

/**
 * Wrist-side persistence — the Android analog of the watch's Keychain + turns
 * file (iOS TinyWatchApp WatchLink store half). The session token lives in an
 * EncryptedSharedPreferences (the Keychain analog); the transcript rides as a
 * plain JSON file so a relaunch restores the last conversation. The token is
 * pushed here from the phone over the Data Layer (PhoneLinkService), so the
 * watch works away from the phone once linked.
 */
class WearStore(context: Context) {

    private val prefs = run {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "tiny_wear_secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val turnsFile = context.filesDir.resolve("watch-turns.json")

    private companion object {
        // Process-wide monitor for the snapshot read-modify-write (see [updateSnapshot]).
        // WearStore is created fresh per call site, so the lock MUST be static to serialize
        // across instances; the "tiny_wear_secure" prefs it guards is a process-singleton.
        val snapshotLock = Any()
    }

    var token: String?
        get() = prefs.getString("tiny_token", null)
        set(value) {
            prefs.edit().apply { if (value == null) remove("tiny_token") else putString("tiny_token", value) }.apply()
        }

    var accentHex: String?
        get() = prefs.getString("accent_hex", null)
        set(value) { prefs.edit().putString("accent_hex", value).apply() }

    /**
     * Whether the CURRENT wrist session + transcript were put here by the
     * screenshot harness ([WearHarness]) rather than by a phone link.
     *
     * Persisted, unlike the phone's process-scoped `graphHarness`/`memoryHarness`
     * flags, and for the same reason the harness has to write at all: the state it
     * seeds outlives the process (encrypted prefs + a file on disk), so the fact
     * that the state is DEMO state has to outlive it too. A process-scoped flag
     * would read false on the very next launch and the guard would then treat
     * harness-seeded content as a real user's — refusing every re-capture.
     *
     * Cleared by [logout] and by a real phone push ([WearViewModel.onLinked]): the
     * flag describes the provenance of what is stored NOW, not "a harness once ran
     * on this watch".
     */
    var harnessSeeded: Boolean
        get() = prefs.getBoolean("harness_seeded", false)
        set(value) { prefs.edit().putBoolean("harness_seeded", value).apply() }

    /** Autoplay spoken replies through the wrist speaker (iOS WatchSettings
     *  `watch_auto_speak`). Defaults on; a wrist-local preference, NOT scrubbed on
     *  logout — it's a device setting, not identity. */
    var autoSpeak: Boolean
        get() = prefs.getBoolean("auto_speak", true)
        set(value) { prefs.edit().putBoolean("auto_speak", value).apply() }

    /** The chosen briefing prompt (iOS WatchSettings `watch_briefing_prompt`) — what
     *  the wrist briefing asks. Empty/absent means "use the default" ([WearBriefing]
     *  resolves that). A wrist-local pref, not identity, so it survives logout. */
    var briefingPrompt: String?
        get() = prefs.getString("briefing_prompt", null)
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrBlank()) remove("briefing_prompt") else putString("briefing_prompt", value)
            }.apply()
        }

    /**
     * tiny's top suggested follow-up + when it landed (iOS FollowupIntent's
     * `snap.followup`/`followupAt`). Persisted so a headless face tap can ask it
     * while the app is dead; [WearFollowup.resolve] gates it on freshness at read
     * time. Unlike autoSpeak/briefingPrompt this IS conversation content, so it's
     * scrubbed on [logout]. Stored as its OWN keys (not folded into [snapshot]) —
     * a follow-up is generated only by a wrist turn, never carried by a phone push,
     * so keeping it separate avoids every phone-mirror write having to preserve it.
     * A null/blank text clears both keys (the button decays). 0L = absent (prefs
     * has no nullable Long).
     */
    var topFollowup: Pair<String, Long>?
        get() {
            val q = prefs.getString("followup_q", null)?.takeIf { it.isNotEmpty() } ?: return null
            val at = prefs.getLong("followup_at", 0L).takeIf { it > 0L } ?: return null
            return q to at
        }
        set(value) {
            prefs.edit().apply {
                if (value == null || value.first.isBlank()) {
                    remove("followup_q"); remove("followup_at")
                } else {
                    putString("followup_q", value.first); putLong("followup_at", value.second)
                }
            }.apply()
        }

    /**
     * Fleet snapshot cached so a relaunch (and, later, a tile/complication) reads
     * presence + unread COLD — without waiting for the next phone push. Stored in
     * the same encrypted prefs as the token: the counts are innocuous, but the
     * last exchange text is conversation content and belongs behind the scrub.
     */
    var snapshot: WatchSnapshot?
        get() {
            if (!prefs.contains("snap_ts")) return null
            return WatchSnapshot(
                online = prefs.getInt("snap_online", 0),
                total = prefs.getInt("snap_total", 0),
                unread = prefs.getInt("snap_unread", 0),
                accent = prefs.getString("snap_accent", null),
                lastQ = prefs.getString("snap_lastQ", null),
                lastA = prefs.getString("snap_lastA", null),
                // 0L sentinel = absent (SharedPreferences has no nullable Long).
                lastAt = prefs.getLong("snap_lastAt", 0L).takeIf { it > 0L },
            )
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    listOf("snap_ts", "snap_online", "snap_total", "snap_unread",
                        "snap_accent", "snap_lastQ", "snap_lastA", "snap_lastAt").forEach { remove(it) }
                } else {
                    putInt("snap_online", value.online)
                    putInt("snap_total", value.total)
                    putInt("snap_unread", value.unread)
                    putString("snap_accent", value.accent)
                    putString("snap_lastQ", value.lastQ)
                    putString("snap_lastA", value.lastA)
                    putLong("snap_lastAt", value.lastAt ?: 0L)
                    putLong("snap_ts", 1L) // presence marker: distinguishes "cached" from "never seen"
                }
            }.apply()
        }

    /**
     * Atomically read-modify-write the cached snapshot under a PROCESS-WIDE monitor.
     *
     * The snapshot is RMW'd from two threads that never see each other's lock: a wrist
     * turn ([WearViewModel.rememberExchange], off-main) folds a fresh lastQ/lastA onto the
     * current presence, and a phone push ([PhoneLinkService.onDataChanged], the
     * WearableListenerService binder thread) merges incoming presence while preserving a
     * newer wrist exchange ([WatchCore.incomingExchangeWins]). Both do read→copy→write; an
     * unguarded interleave (both read S0, one writes the wrist exchange, the other writes a
     * merge built on S0) silently drops whichever fresh field lost the race. Same class as
     * the WidgetStore/DmNotifier/AlertStore RMW fixes — the wrist store was the missed
     * fourth member. The monitor lives on the COMPANION because WearStore is instantiated
     * fresh at every call site (not a singleton like WidgetStore), so an instance lock would
     * serialize nothing; the underlying "tiny_wear_secure" prefs is a process-singleton, so
     * a process-wide lock is both necessary and sufficient. Returns the value written.
     */
    fun updateSnapshot(transform: (WatchSnapshot?) -> WatchSnapshot?): WatchSnapshot? =
        synchronized(snapshotLock) {
            val next = transform(snapshot)
            snapshot = next
            next
        }

    /** Scrub the cached snapshot under the same monitor a merge holds, so a phone-push
     *  merge racing the wipe can't read the pre-scrub (prior-user) exchange and write it
     *  back — resurrecting conversation content the logout was meant to erase. */
    fun scrubSnapshot() = synchronized(snapshotLock) { snapshot = null }

    /** Restore the transcript, forcing any turn killed mid-stream to done so it
     *  doesn't spin forever (WatchCore.sanitize — iOS loadTurns parity). */
    fun loadTurns(): List<WatchTurn> {
        val raw = runCatching { turnsFile.readText() }.getOrNull() ?: return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        val turns = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                WatchTurn(
                    id = o.optString("id"),
                    q = o.optString("q"),
                    a = o.optString("a"),
                    done = o.optBoolean("done", false),
                )
            }
        }
        return WatchCore.sanitize(turns)
    }

    /** Persist the most-recent turns (wrist-sized, shared WatchCore.TURN_CAP). */
    fun saveTurns(turns: List<WatchTurn>) {
        val arr = JSONArray()
        WatchCore.capTurns(turns).forEach { t ->
            arr.put(
                JSONObject()
                    .put("id", t.id).put("q", t.q).put("a", t.a).put("done", t.done),
            )
        }
        runCatching { turnsFile.writeText(arr.toString()) }
    }

    /** Remote logout: scrub the wrist identity (iOS apply(loggedOut:) — token,
     *  transcript, accent all go). */
    fun logout() {
        token = null
        scrubSnapshot() // scrub the cached fleet snapshot (incl. last-exchange text) under the lock
        topFollowup = null // conversation content — goes with the transcript
        // The seeded state is gone with the token/transcript, so its provenance flag
        // goes too: a logged-out wrist is unlinked, which the guard already allows.
        harnessSeeded = false
        prefs.edit().remove("accent_hex").apply()
        runCatching { turnsFile.delete() }
    }
}
