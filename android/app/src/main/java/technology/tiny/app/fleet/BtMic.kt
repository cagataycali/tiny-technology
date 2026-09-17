/**
 * 🎧 BtMic — route speech recognition through a connected Bluetooth
 * headset's microphone (the Meta glasses, when they're worn).
 *
 * iOS gets this with one option: `.allowBluetooth` on the audio session
 * makes the glasses the phone's mic (WearablesLive.swift:137 calls it the
 * load-bearing option). Android does NOT route automatically for speech
 * recognition: SpeechRecognizer captures in Google's recognition-service
 * process with the VOICE_RECOGNITION source, which stays on the built-in
 * mic unless the SCO audio link is raised device-wide. Without this, every
 * meta_listen and HUD transcript reads the PHONE's mic and calling the
 * result "what the glasses heard" would be a lie about which microphone
 * heard it.
 *
 * The legacy startBluetoothSco() API is deprecated on 31+ but remains the
 * one knob that affects ANOTHER process's capture route — the modern
 * setCommunicationDevice() only scopes to the calling app's own use cases.
 * Best-effort by design: no BT mic around → acquire() returns false and the
 * caller proceeds on the phone mic, exactly like today.
 *
 * ⚠️ OWNED, NOT A BARE FLAG — and the ownership is what makes more than one
 * caller safe. This is a DEVICE-WIDE link with four rails now asking for it,
 * and [MicClaim] does not serialise them: the HUD transcriber and a
 * relay-commanded take never see each other, so they genuinely overlap. Under
 * the single `claimed` boolean this object used to keep, the first rail to
 * FINISH called release() and tore the SCO link down underneath a rail that was
 * still recording — which then carried on hearing the phone's built-in mic while
 * `active` read false. Silent, and the transcript still arrives: the words are
 * simply the wrong room's. So a release only drops the link when the LAST holder
 * leaves, and releasing something you never acquired is a no-op ([MicClaim] has
 * the same guard for the same reason).
 */
package technology.tiny.app.fleet

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

object BtMic {
    /**
     * Every rail currently holding the link, by name.
     *
     * A SET, not a counter: a rail whose teardown runs twice (a `finally` after a
     * cancellation that already released is the ordinary case, not a bug) would
     * decrement a counter twice and drop the link while another rail records.
     * Removing a name that isn't there is naturally idempotent.
     */
    private val holders = mutableSetOf<String>()

    /** The SCO link is currently ours — i.e. recognition hears the headset. */
    val active: Boolean get() = synchronized(this) { holders.isNotEmpty() }

    /** Who is holding it, for a diagnostic line. Empty when the link is down. */
    val heldBy: Set<String> get() = synchronized(this) { holders.toSet() }

    /** What [dropHolder] found — the three cases a release has to tell apart. */
    internal enum class Drop {
        /** This rail never acquired (no headset present). Touch nothing. */
        NOT_A_HOLDER,
        /** Removed, but another rail is still recording through the headset. */
        STILL_HELD,
        /** The last holder left — the link may come down. */
        LAST,
    }

    /**
     * Join a link that is ALREADY up, so the caller can answer yes immediately and
     * skip the AudioManager dance. False — and NOTHING recorded — when the link is
     * down.
     *
     * ⚠️ RECORDS NOTHING ON FALSE, and that is the whole point of the shape. An
     * earlier draft added the owner first and removed it if the headset turned out
     * to be absent; in that window a second rail read a non-empty holder set, was
     * told "the link is up", and skipped raising SCO — so it recorded itself as a
     * holder of a link nobody ever raised, and heard the phone. A rail may only be
     * recorded once the link is genuinely up ([noteHolder]) or already was (here).
     */
    internal fun joinIfUp(owner: String): Boolean = synchronized(this) {
        if (holders.isEmpty()) return false
        holders += owner
        true
    }

    /**
     * Record [owner] — the rail that just raised the link itself.
     *
     * Split out from [acquire], with [joinIfUp] and [dropHolder], for one reason:
     * this is the arithmetic that made four rails safe, and none of it needs
     * `android.*` — so it is PROVABLE on the local JVM (`BtMicTest`) instead of
     * only pinned as source text.
     */
    internal fun noteHolder(owner: String) = synchronized(this) { holders += owner }

    /** [owner] is finished; which of the three [Drop] cases that turns out to be. */
    internal fun dropHolder(owner: String): Drop = synchronized(this) {
        if (owner !in holders) return Drop.NOT_A_HOLDER
        holders -= owner
        if (holders.isEmpty()) Drop.LAST else Drop.STILL_HELD
    }

    /** Test-only: forget every holder (the object outlives a single test). */
    internal fun clearHolders() = synchronized(this) { holders.clear() }

    /** A SCO/BLE-headset mic is present and connected. */
    fun available(context: Context): Boolean {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return if (Build.VERSION.SDK_INT >= 31) {
            am.availableCommunicationDevices.any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            }
        } else {
            @Suppress("DEPRECATION")
            am.isBluetoothScoAvailableOffCall
        }
    }

    /**
     * Raise the SCO link so recognition hears the headset, for [owner]. Returns
     * false (and changes nothing) when no BT mic is around. The link takes
     * ~0.5-1s to come up — callers should give it a beat before recording.
     *
     * ⚠️ [owner] must be the SAME string the matching [release] passes, or that
     * rail's name is never removed and the link stays up for the life of the
     * process — a headset that keeps the phone's audio in call mode forever.
     * Owners are `const val`s at their call sites, not literals typed twice.
     */
    fun acquire(context: Context, owner: String): Boolean {
        // Already up: just record the second holder. Returns TRUE, because the
        // caller's question is "will recognition hear the headset", and it will.
        if (joinIfUp(owner)) return true
        if (!available(context)) return false
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return runCatching {
            @Suppress("DEPRECATION")
            am.startBluetoothSco()
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = true
            noteHolder(owner) // only now: the link is genuinely up
            true
        }.getOrDefault(false)
    }

    /**
     * [owner] is done with the link; drop it when nobody else holds it.
     *
     * Safe to call unconditionally — a rail that never acquired (no headset
     * present, so `acquire` returned false) removes a name that was never added
     * and changes nothing. That case is the COMMON one: most takes happen with no
     * glasses on the user's face.
     */
    fun release(context: Context, owner: String) {
        // ⚠️ NOT_A_HOLDER and STILL_HELD both mean "touch nothing", for DIFFERENT
        // reasons — the first is a rail that never had the link, the second a rail
        // that had it and isn't the last to leave. Collapsing either into "drop it"
        // is the silent cross-rail teardown this object exists to prevent.
        if (dropHolder(owner) != Drop.LAST) return
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        runCatching {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
        }
    }
}
