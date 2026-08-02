package technology.tiny.app.fleet

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

/**
 * 🎤 Who owns the microphone right now.
 *
 * There are three independent mic owners in this app and none of them could see
 * each other: VoiceMode (voice chat's rolling recognition session), VoiceCall
 * (the S2S websocket call), and now PhoneRecorder (a relay-commanded take). iOS
 * gets mutual exclusion for free — every one of them goes through the single
 * shared AVAudioSession, which is why NiclaRecorder can simply ask
 * `VoiceMode.shared.active` and refuse. On Android each owner opens its own
 * capture, so two can run at once: the recognizer and a second session fight for
 * the mic, and both transcripts come out shredded.
 *
 * Process-scoped and deliberately NOT persisted: a claim that outlived the
 * process would leave a phone convinced its mic was busy forever, with the only
 * cure being an app reinstall. That is a far worse bug than the collision.
 *
 * This is an ADVISORY claim, not a lock on the hardware — it can only stop the
 * owners that ask. PhoneRecorder asks (it is the one that can be triggered
 * remotely, with nobody looking at the screen); the two interactive surfaces are
 * driven by a user who can see what their phone is doing.
 */
object MicClaim {

    @Volatile private var owner: String? = null

    /** Who holds the mic, or null. Names an owner so a refusal can say WHO. */
    val heldBy: String? get() = owner

    val busy: Boolean get() = owner != null

    /**
     * Take the mic for [name], or return false if someone already has it.
     *
     * Synchronized rather than a bare volatile write: check-then-set from two
     * threads would otherwise let both callers believe they won.
     */
    fun claim(name: String): Boolean = synchronized(this) {
        if (owner != null) return false
        owner = name
        true
    }

    /**
     * Release the mic — but only if [name] is the holder.
     *
     * The guard matters: a late teardown from a finished take would otherwise
     * release a claim that a DIFFERENT owner has since taken, silently letting a
     * third session in on top of it.
     */
    fun release(name: String) = synchronized(this) {
        if (owner == name) owner = null
    }

    /** RECORD_AUDIO is granted — a runtime permission, revocable at any time. */
    fun granted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
