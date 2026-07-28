package technology.tiny.app.fleet

import org.json.JSONArray

/**
 * Pure counting decisions behind the ⚡ activity badge and the fleet-status widget,
 * extracted from FleetManager so the correctness-sensitive arithmetic is unit-testable
 * without a Context, network, or prefs. Both are off-by-one-prone (a wrong badge count
 * or a wrong "N of M online" is user-visible) and both mirror web/iOS exactly:
 *   - unread events = events.filter(id > seenId).length  (web ActivityHUD)
 *   - fleet online  = devices.filter(online).length      (iOS refreshFleetWidget)
 */
object FleetCounts {

    /**
     * Count event-ring entries strictly newer than the seen high-water [seenId]
     * (web ActivityHUD's `events.filter(e => e.id > seenId).length`). STRICT `>`,
     * so an event whose id equals the mark is already-seen, not unread. Entries
     * missing an id count as id 0 (never unread once anything has been seen).
     */
    fun unreadEvents(events: JSONArray?, seenId: Long): Int {
        if (events == null) return 0
        var unread = 0
        for (i in 0 until events.length()) {
            if ((events.optJSONObject(i)?.optLong("id") ?: 0L) > seenId) unread++
        }
        return unread
    }

    /** Online-device count for the fleet badge/widget (iOS refreshFleetWidget). */
    fun onlineCount(devices: JSONArray?): Int {
        if (devices == null) return 0
        var online = 0
        for (i in 0 until devices.length()) {
            if (devices.optJSONObject(i)?.optBoolean("online") == true) online++
        }
        return online
    }

    /** Total enrolled-device count (well-formed objects only) — the M in "N of M online". */
    fun totalCount(devices: JSONArray?): Int {
        if (devices == null) return 0
        var total = 0
        for (i in 0 until devices.length()) {
            if (devices.optJSONObject(i) != null) total++
        }
        return total
    }
}
