/**
 * CallAudio — where a live voice call comes OUT of the phone.
 *
 * iOS says this in one option: `.defaultToSpeaker`, on the same rail
 * (`VoiceCall.swift:207`) and on dictation too (`Voice.swift:119/185`). It is the
 * load-bearing half of a pair — `.allowBluetooth, .defaultToSpeaker` — and the
 * pair is the whole intent: **hear it through the headset when one is connected,
 * otherwise out of the LOUD speaker.**
 *
 * Android has no session to describe, and its default is the other one. A
 * `USAGE_VOICE_COMMUNICATION` AudioTrack — which is what `VoiceCall` builds, and
 * correctly, because that usage is what pairs with the VOICE_COMMUNICATION
 * capture source and its echo canceller — routes to the **earpiece**, the tiny
 * 1-inch driver you hold against your ear on a phone call. So the tiny answered
 * out of the earpiece: audible if the phone happens to be at your face, and
 * nearly silent on a desk, which is where a hands-free assistant call actually
 * happens. Nothing reported it, because nothing is wrong — every frame arrived,
 * the transcript rendered, the orb moved. The sound simply went somewhere almost
 * nobody was listening.
 *
 * ⚠️ `AudioDuck` already stated this gap and could not close it:
 * "Focus attributes set ducking POLICY, not routing — `VoiceCall`'s own
 * `AudioTrack` still declares USAGE_VOICE_COMMUNICATION for its playback, and
 * that is what routes." That is this file.
 *
 * ⚠️⚠️ **FORCING THE SPEAKER UNCONDITIONALLY WOULD BE A REGRESSION, NOT A FIX.**
 * `.defaultToSpeaker` changes the DEFAULT; it does not outrank a connected
 * headset, and iOS asks for `.allowBluetooth` in the very same breath. A phone
 * that shouts a private call out of its loudspeaker while the user is wearing the
 * Meta glasses would undo exactly what [technology.tiny.app.fleet.BtMic] exists
 * to do, and it would do it to the surface where privacy matters most. Hence
 * [chooseRoute]: a headset present means TOUCH NOTHING and let the OS route
 * there; only the bare-phone case is redirected.
 */
package technology.tiny.app.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

object CallAudio {

    /** What to do about the call's output route. */
    enum class Route {
        /**
         * A headset is connected — leave the OS alone. It already routes there,
         * and overriding would shout a private call into the room.
         */
        LEAVE_ALONE,

        /** Bare phone: the earpiece default is wrong for a hands-free call. */
        SPEAKER,
    }

    /**
     * Every device type that means "the user is listening through something they
     * are wearing or holding to their ear".
     *
     * A SET rather than a chain of `||` so [chooseRoute] can be a pure function
     * over what the AudioManager reported, which is the half worth RUNNING in a
     * test. These are compile-time `int` constants, so they inline and this stays
     * free of live `android.*` calls.
     *
     * ⚠️ USB and wired headsets are in here on purpose. The iOS pair does not
     * mention them because `.defaultToSpeaker` never outranked a wired route on
     * that platform either — the honest translation is "anything the user plugged
     * in or paired", not "Bluetooth only". A user on USB-C earbuds is exactly as
     * surprised by a loudspeaker as a user wearing the glasses.
     */
    private val HEADSETS = setOf(
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID,
    )

    /**
     * The decision, as a pure function of the device types currently available.
     *
     * Split out from [route] for [technology.tiny.app.chat.AudioDuck]'s reason:
     * this is the part that can be WRONG in a way no crash reports, so it is the
     * part a local JVM test can run. Empty set → [Route.SPEAKER]: a phone that
     * reports no communication devices at all is a bare phone, and the earpiece
     * default is what we are here to override.
     */
    internal fun chooseRoute(available: Set<Int>): Route =
        if (available.any { it in HEADSETS }) Route.LEAVE_ALONE else Route.SPEAKER

    /**
     * Decide, and record the holder in the same breath.
     *
     * ⚠️ The bookkeeping lives HERE rather than in [route] because forgetting it is
     * silent and permanent: the route gets forced, nothing is ever recorded, and
     * [restore]'s guard then declines to undo it for the life of the process — so
     * the loudspeaker outlives the call and the NEXT thing the phone plays in call
     * mode comes out of it. There is no crash and no log. In [route] that pairing
     * cannot be tested without a device (the AudioManager lookup comes first); here
     * it is arithmetic, and [CallAudioTest] runs it.
     *
     * Only [Route.SPEAKER] holds: a headset call forced nothing, so it has nothing
     * to hand back, and claiming otherwise would make `stop()` clear a route the OS
     * chose rather than one we took.
     */
    internal fun claim(available: Set<Int>, owner: String): Route {
        val decision = chooseRoute(available)
        if (decision == Route.SPEAKER) held = owner
        return decision
    }

    /**
     * Send the call's audio to the loudspeaker unless a headset is connected.
     * Returns the [Route] actually taken, so a caller can log which it was.
     *
     * Best-effort by design, like [technology.tiny.app.fleet.BtMic.acquire]: on a
     * refusal the call proceeds exactly as it does today rather than failing. A
     * quiet call is a poor call; a call that won't start is no call.
     */
    fun route(context: Context, owner: String): Route {
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return Route.LEAVE_ALONE
        val available = runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                am.availableCommunicationDevices.map { it.type }.toSet()
            } else {
                // Pre-31 has no availableCommunicationDevices. getDevices(OUTPUTS)
                // covers the same question for our purposes: is the user wearing
                // or plugged into anything?
                am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }.toSet()
            }
        }.getOrDefault(emptySet())

        // Decide AND take ownership together — see [claim] for why they cannot be
        // two statements here.
        val decision = claim(available, owner)
        if (decision == Route.LEAVE_ALONE) return decision

        runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                // The modern knob, and the RIGHT one here: it scopes to this app's
                // own communication use cases, which is precisely the scope of one
                // voice call. (Its narrowness is why BtMic cannot use it — routing
                // ANOTHER process's recognition capture needs the device-wide SCO
                // link instead.)
                am.availableCommunicationDevices
                    .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ?.let { am.setCommunicationDevice(it) }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = true
            }
        }
        return decision
    }

    /**
     * The rail that currently holds a forced route, or null.
     *
     * A single owner rather than [technology.tiny.app.chat.AudioDuck]'s holder
     * SET, and the difference is honest rather than lazy: a phone has ONE live
     * voice call, so two rails cannot overlap here the way the four mic rails
     * genuinely do. ⚠️ **A second caller changes that** — it would need the
     * holder-set arithmetic, or the first rail to finish would hand the route back
     * to the earpiece underneath a call still talking. That is the exact bug
     * `BtMic` and `AudioDuck` each grew a holder set to prevent; do not add a
     * caller without reading them.
     */
    @Volatile private var held: String? = null

    /** The forced route is currently ours (i.e. [restore] has something to undo). */
    val forced: Boolean get() = held != null

    /**
     * Claim the right to undo the forced route: true only for the rail that took
     * it, and true at most once.
     *
     * ⚠️ Split out of [restore] so it can be RUN. The guard is the whole of
     * [technology.tiny.app.fleet.MicClaim]'s lesson, it is one `!=` away from being
     * wrong, and being wrong is silent both ways — drop it and a late teardown
     * hands back a route another rail is using; invert it and no call ever restores
     * anything. Inside [restore] none of that is reachable without a live
     * `AudioManager`, i.e. without a device; here it is arithmetic on a string.
     */
    internal fun release(owner: String): Boolean {
        if (held != owner) return false
        held = null
        return true
    }

    /**
     * Hand routing back to the OS. Safe to call unconditionally: a call that never
     * forced anything (a headset was connected, or the OS refused) restores
     * nothing.
     *
     * ⚠️ Guarded on [owner] for [technology.tiny.app.fleet.MicClaim]'s reason: a
     * late teardown must not release a route a different rail has since taken.
     */
    fun restore(context: Context, owner: String) {
        if (!release(owner)) return
        val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
            }
        }
    }

    /** Test-only: forget the holder (the object outlives a single test). */
    internal fun clearHolder() { held = null }
}
