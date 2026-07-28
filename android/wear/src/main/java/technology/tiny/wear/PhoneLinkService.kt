package technology.tiny.wear

import android.util.Log
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import technology.tiny.app.wear.WatchCore

/**
 * Phone → watch link over the Wearable Data Layer — the Android analog of the
 * iOS WatchConnectivity applicationContext push (TinyWatchApp WCSessionDelegate).
 * The phone writes a `/tiny/session` DataItem carrying the session token, theme
 * accent, and a loggedOut flag; that item survives offline and is delivered when
 * the watch reconnects, so the wrist stays linked away from the phone.
 *
 * The received values are staged in a process-wide [Inbox] the ViewModel drains
 * on creation and via a live callback — a bound Service can't reach the VM
 * directly, and the DataItem may land while the app is dead.
 */
class PhoneLinkService : WearableListenerService() {

    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val item = event.dataItem
            val map = DataMapItem.fromDataItem(item).dataMap
            when (item.uri.path) {
                SESSION_PATH -> {
                    val loggedOut = map.getBoolean("loggedOut", false)
                    val token = map.getString("token")
                    val accent = map.getString("accent")
                    Log.i("TinyWearLink", "session push: loggedOut=$loggedOut hasToken=${token != null}")
                    // A logout must scrub the persisted snapshot even when the app
                    // (and its VM) is dead — the store, not the VM, feeds the tile.
                    if (loggedOut) {
                        // Scrub under the monitor: a concurrent snapshot-push merge must not
                        // read the pre-scrub exchange and write it back after this logout.
                        runCatching { WearStore(this).scrubSnapshot() }
                        requestTileUpdate()
                    }
                    Inbox.deliver(loggedOut = loggedOut, token = token, accent = accent)
                }
                SNAPSHOT_PATH -> {
                    // lastAt = 0L sentinel for "absent" (DataMap has no nullable Long).
                    val pushedAt = map.getLong("lastAt", 0L).takeIf { it > 0L }
                    val incoming = WatchSnapshot(
                        online = map.getInt("online", 0),
                        total = map.getInt("total", 0),
                        unread = map.getInt("unread", 0),
                        accent = map.getString("accent"),
                        lastQ = map.getString("lastQ"),
                        lastA = map.getString("lastA"),
                        lastAt = pushedAt,
                    )
                    Log.i("TinyWearLink", "snapshot push: ${incoming.online}/${incoming.total} unread=${incoming.unread}")
                    // Persist HERE (not just in the VM): a snapshot most often lands
                    // while the app is closed — the exact case the tile serves — so
                    // the VM is dead and can't cache it. The service is always alive
                    // on delivery. Then nudge the tile to re-render immediately
                    // rather than waiting on the 5-min freshness tick.
                    //
                    // Presence/unread/accent always take the incoming push, but the
                    // last exchange only replaces the stored one when STRICTLY NEWER
                    // — the user may have chatted on the WATCH since this push was
                    // built, and that fresher wrist exchange must not be clobbered by
                    // a stale mirror (iOS absorbSnapshot: phone wins only if newer).
                    // RMW under the store's process-wide monitor: a wrist turn
                    // (WearViewModel.rememberExchange) can fold a fresh exchange onto the
                    // same snapshot on another thread. Reading `stored` and writing the
                    // merge unguarded races that write — either the push's presence or the
                    // wrist's fresher exchange is silently lost. The stored exchange is
                    // re-read INSIDE the lock so the incomingExchangeWins arbitration sees
                    // the latest wrist timestamp, not a stale pre-lock copy.
                    val snap = WearStore(this).updateSnapshot { stored ->
                        if (WatchCore.incomingExchangeWins(incoming.lastAt, stored?.lastAt)) {
                            incoming
                        } else {
                            incoming.copy(
                                lastQ = stored?.lastQ, lastA = stored?.lastA, lastAt = stored?.lastAt,
                            )
                        }
                    }
                    requestTileUpdate()
                    if (snap != null) SnapshotInbox.deliver(snap)
                }
            }
        }
    }

    /** Ask the system to re-render the fleet tile AND complication now (state
     *  just changed) — shared with the VM's own snapshot writes via [WristSurfaces]
     *  so neither surface is ever forgotten. */
    private fun requestTileUpdate() = WristSurfaces.refresh(this)

    companion object {
        const val SESSION_PATH = "/tiny/session"
        const val SNAPSHOT_PATH = "/tiny/snapshot"
    }

    /** Process-wide handoff between the Service and whatever ViewModel is alive. */
    object Inbox {
        @Volatile private var pending: Triple<Boolean, String?, String?>? = null
        @Volatile private var listener: ((Boolean, String?, String?) -> Unit)? = null

        @Synchronized
        fun deliver(loggedOut: Boolean, token: String?, accent: String?) {
            val l = listener
            if (l != null) l(loggedOut, token, accent)
            else pending = Triple(loggedOut, token, accent)
        }

        /** ViewModel registers on creation; drains any push that arrived while dead. */
        @Synchronized
        fun observe(l: (Boolean, String?, String?) -> Unit) {
            listener = l
            pending?.let { (out, tok, acc) -> l(out, tok, acc); pending = null }
        }

        @Synchronized
        fun clear() {
            listener = null
        }
    }

    /**
     * Fleet presence + unread the phone mirrors to the wrist (iOS absorbSnapshot
     * parity), staged like [Inbox] so the ViewModel drains it on creation and via
     * a live callback. Distinct path from the session so identity + presence never
     * clobber each other.
     */
    object SnapshotInbox {
        @Volatile private var pending: WatchSnapshot? = null
        @Volatile private var listener: ((WatchSnapshot) -> Unit)? = null

        @Synchronized
        fun deliver(snap: WatchSnapshot) {
            val l = listener
            if (l != null) l(snap) else pending = snap
        }

        @Synchronized
        fun observe(l: (WatchSnapshot) -> Unit) {
            listener = l
            pending?.let { l(it); pending = null }
        }

        @Synchronized
        fun clear() {
            listener = null
        }
    }
}

/** Fleet snapshot the phone pushes over `/tiny/snapshot` (presence + unread + last exchange).
 *  [lastAt] (epoch ms, null when absent) arbitrates whether a phone push replaces the
 *  wrist's own last exchange — see [WatchCore.incomingExchangeWins]. */
data class WatchSnapshot(
    val online: Int,
    val total: Int,
    val unread: Int,
    val accent: String?,
    val lastQ: String?,
    val lastA: String?,
    val lastAt: Long? = null,
)
