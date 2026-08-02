/**
 * 🕶️ GlassesEvents — "the user tapped the glasses", derived, because DAT
 * 0.8.0 ships NO button/gesture API (grep of both platforms' interfaces:
 * zero button/touch symbols; the mock kit's captouch.tap() proves the
 * hardware emits them). On real devices a capture-button tap surfaces only
 * as the active stream pausing/resuming — so every stream owner (the live
 * HUD, the recorder) feeds its state transitions here, and the agent reads
 * the result in contextIfLinked()/meta_glasses_status.
 *
 * Ring buffer, monotonic clock, phone-local — nothing uploads from here;
 * the context line rides extraSystem like the location block does.
 */
package technology.tiny.app.fleet

import android.os.SystemClock
import com.meta.wearable.dat.camera.types.StreamState

object GlassesEvents {
    private const val KEEP = 8
    private const val WINDOW_MS = 120_000L

    private val lock = Any()
    private val events = ArrayDeque<Pair<Long, String>>() // elapsedRealtime ms → label

    fun record(label: String) {
        synchronized(lock) {
            events.addLast(SystemClock.elapsedRealtime() to label)
            while (events.size > KEEP) events.removeFirst()
        }
    }

    /** Human lines from the last two minutes, oldest first; empty when quiet. */
    fun recent(): List<String> {
        val now = SystemClock.elapsedRealtime()
        return synchronized(lock) {
            events.filter { now - it.first <= WINDOW_MS }
                .map { "${(now - it.first) / 1000}s ago: ${it.second}" }
        }
    }

    /**
     * The tap rule, single-sourced: a STREAMING↔PAUSED flip on an ACTIVE
     * stream is a capture-button tap. Startup passes through STARTING/
     * STARTED without ever holding STREAMING, so those never record.
     */
    fun onStreamTransition(from: StreamState?, to: StreamState) {
        if (from == StreamState.STREAMING && to == StreamState.PAUSED) {
            record("the user TAPPED the glasses capture button (stream paused)")
        }
        if (from == StreamState.PAUSED && to == StreamState.STREAMING) {
            record("the user TAPPED the glasses capture button again (stream resumed)")
        }
    }
}
