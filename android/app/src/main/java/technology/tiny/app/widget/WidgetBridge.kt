package technology.tiny.app.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * The app-side entry point for keeping the home-screen widgets fresh: write the
 * snapshot via [WidgetStore], then ask Glance to re-render every placed widget.
 * Fire-and-forget on an IO scope so callers (heartbeat / chat turn) never block.
 */
object WidgetBridge {
    private val scope = CoroutineScope(Dispatchers.IO)

    /** Presence/unread refresh (FleetManager heartbeat, ~5-min cadence). */
    fun publishFleet(
        context: Context,
        online: Int,
        total: Int,
        unread: Int,
        login: String,
        accentHex: String?,
    ) {
        WidgetStore.updateFleet(context, online, total, unread, login, accentHex, System.currentTimeMillis())
        reload(context)
    }

    /** Newest exchange + memories (chat turn completion). */
    fun publishExchange(context: Context, q: String, a: String, memories: List<String>) {
        WidgetStore.updateExchange(context, q, a, memories, System.currentTimeMillis())
        reload(context)
    }

    /** Just the remembered facts (remember/forget tools mid-turn). */
    fun publishMemories(context: Context, memories: List<String>) {
        WidgetStore.updateMemories(context, memories, System.currentTimeMillis())
        reload(context)
    }

    /** Sign-out: wipe identity from the snapshot + re-render (iOS logout scrub parity). */
    fun scrubIdentity(context: Context) {
        WidgetStore.scrubIdentity(context, System.currentTimeMillis())
        reload(context)
    }

    private fun reload(context: Context) {
        val app = context.applicationContext
        scope.launch {
            runCatching {
                TinyStatusWidget().updateAll(app)
                TinyLastAnswerWidget().updateAll(app)
                TinyMemoryWidget().updateAll(app)
                TinyAskWidget().updateAll(app)
                TinyBriefingWidget().updateAll(app)
            }
        }
    }
}
