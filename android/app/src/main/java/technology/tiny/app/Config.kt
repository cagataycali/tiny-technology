package technology.tiny.app

import android.content.Context
import android.content.SharedPreferences
import java.util.Calendar

/** UserDefaults-analog settings, mirroring iOS Config.swift keys. */
class Config(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("tiny_config", Context.MODE_PRIVATE)

    var tinyName: String
        get() = prefs.getString("cfg_tiny_name", "tiny") ?: "tiny"
        set(v) = prefs.edit().putString("cfg_tiny_name", v.trim().lowercase()).apply()

    var autoSpeak: Boolean
        get() = prefs.getBoolean("cfg_auto_speak", true)
        set(v) = prefs.edit().putBoolean("cfg_auto_speak", v).apply()

    var quietHours: Boolean
        get() = prefs.getBoolean("cfg_quiet_hours", true)
        set(v) = prefs.edit().putBoolean("cfg_quiet_hours", v).apply()

    var voiceId: String?
        get() = prefs.getString("cfg_voice_id", null)
        set(v) = prefs.edit().putString("cfg_voice_id", v).apply()

    /** Current tiny's theme accent hex (#RRGGBB) — mirrors iOS cfg_accent_hex so
     *  the home-screen widgets can tint to match the active tiny. */
    var accentHex: String?
        get() = prefs.getString("cfg_accent_hex", null)?.takeIf { it.isNotBlank() }
        set(v) = prefs.edit().putString("cfg_accent_hex", v).apply()

    var serverOverride: String?
        get() = prefs.getString("cfg_server", null)?.takeIf { it.isNotBlank() }
        set(v) = prefs.edit().putString("cfg_server", v).apply()

    /** First-run tour seen (iOS onboarded_v1 parity) — set once the main app or a
     *  skip/sign-in from onboarding is reached; existing logged-in installs skip it. */
    var onboarded: Boolean
        get() = prefs.getBoolean("cfg_onboarded_v1", false)
        set(v) = prefs.edit().putBoolean("cfg_onboarded_v1", v).apply()

    /** 📍 Share live location with the tiny (web `tiny-geo-context` parity):
     *  while on, each send carries a `### Location` block (coords/speed/heading)
     *  in the hidden context. Off by default; flipping on runs the runtime
     *  permission ask in Settings — this flag never outruns the grant. */
    var locationContext: Boolean
        get() = prefs.getBoolean("cfg_location_context", false)
        set(v) = prefs.edit().putBoolean("cfg_location_context", v).apply()

    /** Always-on fleet node: run a foreground service so heartbeat + 5s relay stay
     *  alive when the app is backgrounded (Android-only edge — iOS dies when locked). */
    var alwaysOn: Boolean
        get() = prefs.getBoolean("cfg_always_on", false)
        set(v) = prefs.edit().putBoolean("cfg_always_on", v).apply()

    /** Per-turn live status notification (Android analog of iOS Live Activity /
     *  Dynamic Island): a silent ongoing chip tracks thinking→tool→agents→done
     *  while a turn streams. On by default (iOS ships its Live Activity on). */
    var turnActivity: Boolean
        get() = prefs.getBoolean("cfg_turn_activity", true)
        set(v) = prefs.edit().putBoolean("cfg_turn_activity", v).apply()

    /** Activity feed high-water mark: the max event-ring id the user has seen
     *  (web ActivityHUD SEEN_KEY "tiny_events_seen_id"). Events with a higher id
     *  count toward the ⚡ unread badge; opening the Activity panel advances it. */
    var eventsSeenId: Long
        get() = prefs.getLong("cfg_events_seen_id", 0L)
        set(v) = prefs.edit().putLong("cfg_events_seen_id", v).apply()

    /** Composer draft, written through on every edit. rememberSaveable alone can't
     *  protect it: a root back press FINISHES the activity (state discarded, not
     *  saved), and AdaptiveChat's 600dp branch swap changes the saveable slot path
     *  on rotate — both silently ate half-typed messages (audit 2026-07-23 #1). */
    var composerDraft: String
        get() = prefs.getString("cfg_composer_draft", "") ?: ""
        set(v) = prefs.edit().putString("cfg_composer_draft", v.take(8000)).apply()

    /** Offline send queue, mirrored to disk on every mutation. send() promises
     *  "queued, will send when back online"; an in-memory-only queue breaks that
     *  promise on process death — the ONLY copy of a user-authored message dies
     *  silently (the offline branch never adds a transcript bubble). JSON array
     *  of prompt strings, capped defensively. */
    var queuedSends: List<String>
        get() = runCatching {
            val arr = org.json.JSONArray(prefs.getString("cfg_queued_sends", "[]") ?: "[]")
            (0 until arr.length()).map { arr.getString(it) }
        }.getOrDefault(emptyList())
        set(v) = prefs.edit().putString(
            "cfg_queued_sends",
            org.json.JSONArray().apply { v.take(50).forEach { put(it) } }.toString(),
        ).apply()

    /**
     * Clear the USER-scoped channels held in tiny_config on an account switch /
     * sign-out. These three carry the prior user's private content or per-user
     * state; the rest of tiny_config (tinyName, voiceId, accentHex, alwaysOn,
     * onboarded, server/update overrides) is DEVICE/tiny-level and deliberately
     * kept — a switch shouldn't reset which tiny is active or the device tour flag.
     *  - queuedSends: A's offline-composed messages would otherwise be flushed
     *    from B's account on reconnect (send() uses the CURRENT session token).
     *  - composerDraft: A's half-typed message would seed B's composer.
     *  - eventsSeenId: A's activity high-water mark would make B's ⚡ badge
     *    under-count (events with id ≤ A's last-seen never register as unread).
     * Same identity boundary the widget/DM/alert/model-config channels scrub on.
     */
    fun scrubIdentity() = prefs.edit()
        .remove("cfg_queued_sends")
        .remove("cfg_composer_draft")
        .remove("cfg_events_seen_id")
        .apply()

    val serverBase: String get() = serverOverride ?: "https://tiny.technology"

    /** Debug-only: point OTA checks somewhere else without rerouting the API. */
    var updateBase: String?
        get() = prefs.getString("cfg_update_base", null)?.takeIf { it.isNotBlank() }
        set(v) = prefs.edit().putString("cfg_update_base", v).apply()

    /** Quiet = 22:00–08:00 local, when the toggle is on (iOS parity). */
    fun isQuietNow(): Boolean {
        if (!quietHours) return false
        return isQuietHour(Calendar.getInstance().get(Calendar.HOUR_OF_DAY))
    }

    companion object {
        /**
         * Whether a 24-hour clock hour falls in the quiet window (22:00–08:00 local),
         * assuming the toggle is on. Pure + Calendar-free so the wrap-around boundary
         * (inclusive 22, exclusive 8 — matching iOS `hour >= 22 || hour < 8`) is
         * JVM-unit-testable; a remote agent's audible play_sound is gated on this, so
         * an off-by-one at the boundary would let a 22:00 or silence an 08:00 alert.
         */
        fun isQuietHour(hour: Int): Boolean = hour >= 22 || hour < 8
    }
}
