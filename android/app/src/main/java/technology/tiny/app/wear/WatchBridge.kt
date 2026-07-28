package technology.tiny.app.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

/**
 * Phone → watch session sender — the write half of the link the wrist's
 * PhoneLinkService reads (Android analog of the iOS phone pushing its session
 * over WatchConnectivity applicationContext). Publishes a single `/tiny/session`
 * DataItem carrying the session token, theme accent, and a loggedOut flag.
 *
 * A DataItem is last-write-wins and survives offline delivery: the watch gets it
 * when it next reconnects, so the wrist stays linked away from the phone — and a
 * logout is guaranteed to reach it eventually (the identity scrub can't be lost).
 *
 * Wiring: TinyApp observes auth.user and calls [pushSession] on login (token +
 * accent) and [pushLogout] on sign-out. Fire-and-forget; a missing/paused
 * Wearable API (no watch ever paired) just logs — the phone app is unaffected.
 */
object WatchBridge {

    const val SESSION_PATH = "/tiny/session"
    const val SNAPSHOT_PATH = "/tiny/snapshot"

    /**
     * Pure payload decision for the `/tiny/session` DataItem — the exact keys the
     * watch's PhoneLinkService reads. Extracted so the login/logout contract is
     * unit-testable on the JVM without a live Wearable API (DataMap is a throwing
     * stub off-device). A logout carries NO token (and no accent): the item's
     * only job is to tell the wrist to scrub. `ts` bumps every push so an
     * unchanged token still re-delivers (DataItems dedupe on identical bytes).
     */
    fun sessionPayload(loggedOut: Boolean, token: String?, accent: String?, now: Long): Map<String, Any> {
        val m = LinkedHashMap<String, Any>()
        m["loggedOut"] = loggedOut
        if (!loggedOut) {
            token?.let { m["token"] = it }
            accent?.let { m["accent"] = it }
        }
        m["ts"] = now
        return m
    }

    /**
     * Publish the current identity to the wrist. [token] is the session JWT;
     * [accent] is the per-tiny theme hex (nullable → green fallback on the watch).
     */
    fun pushSession(context: Context, token: String, accent: String?, now: Long) {
        put(context, SESSION_PATH, sessionPayload(loggedOut = false, token = token, accent = accent, now = now), "session")
    }

    /**
     * Scrub the wrist identity on sign-out: a loggedOut item with NO token
     * (the watch's PhoneLinkService clears its Keychain/transcript on this).
     */
    fun pushLogout(context: Context, now: Long) {
        put(context, SESSION_PATH, sessionPayload(loggedOut = true, token = null, accent = null, now = now), "logout")
    }

    /**
     * Pure payload for the `/tiny/snapshot` DataItem — fleet presence + unread the
     * wrist shows WITHOUT the app ever opening (iOS absorbSnapshot parity). Rides
     * a path DISTINCT from the session so the two never clobber each other. Only
     * the scalars a complication/glance needs; omits an empty last-answer so an
     * unchanged exchange doesn't overwrite a fresher wrist-side one.
     */
    fun snapshotPayload(
        online: Int,
        total: Int,
        unread: Int,
        accent: String?,
        lastQ: String?,
        lastA: String?,
        lastAt: Long?,
        now: Long,
    ): Map<String, Any> {
        val m = LinkedHashMap<String, Any>()
        m["online"] = online
        m["total"] = total
        m["unread"] = unread
        accent?.let { m["accent"] = it }
        // Last exchange only rides when present AND timestamped — an empty/undated
        // one must not blank a fresher wrist exchange (iOS "phone wins if newer").
        if (!lastQ.isNullOrEmpty() && !lastA.isNullOrEmpty() && lastAt != null) {
            m["lastQ"] = lastQ
            m["lastA"] = lastA
            m["lastAt"] = lastAt
        }
        m["ts"] = now
        return m
    }

    /** Publish fleet presence + unread (+ optional last exchange) to the wrist. */
    fun pushSnapshot(
        context: Context,
        online: Int,
        total: Int,
        unread: Int,
        accent: String?,
        lastQ: String? = null,
        lastA: String? = null,
        lastAt: Long? = null,
        now: Long,
    ) {
        put(
            context, SNAPSHOT_PATH,
            snapshotPayload(online, total, unread, accent, lastQ, lastA, lastAt, now),
            "snapshot",
        )
    }

    private fun put(context: Context, path: String, payload: Map<String, Any>, label: String) {
        val req = PutDataMapRequest.create(path).apply {
            payload.forEach { (k, v) ->
                when (v) {
                    is Boolean -> dataMap.putBoolean(k, v)
                    is Int -> dataMap.putInt(k, v)
                    is Long -> dataMap.putLong(k, v)
                    is String -> dataMap.putString(k, v)
                }
            }
        }
        // urgent → deliver as soon as possible rather than batching for power.
        val request = req.asPutDataRequest().setUrgent()
        runCatching {
            Wearable.getDataClient(context.applicationContext).putDataItem(request)
                .addOnSuccessListener { Log.i("TinyWatchBridge", "pushed $label to wrist") }
                .addOnFailureListener { e -> Log.w("TinyWatchBridge", "push $label failed: ${e.message}") }
        }.onFailure { Log.w("TinyWatchBridge", "wearable unavailable: ${it.message}") }
    }
}
