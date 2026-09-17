package technology.tiny.app.voice

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CallAudio's route decision — RUN, not pinned as source text.
 *
 * The bug this closes is silent in both directions, which is why the decision is
 * a pure function instead of a branch inside `route()`. Get it wrong one way and
 * the tiny answers out of the earpiece on a desk (the defect: nothing fails,
 * every frame arrives, the sound just goes where nobody is listening). Get it
 * wrong the OTHER way and the phone shouts a private call into the room while the
 * user is wearing the glasses — a worse outcome than the bug, and equally
 * silent. No crash, no log, no failing assertion exists for either.
 *
 * `route()` itself needs a live `AudioManager` and is pinned by source-reading in
 * `tests/wearables-android.test.ts`. Everything that can be WRONG about which
 * speaker a call comes out of is decided here.
 */
class CallAudioTest {

    /** What a phone with nothing connected reports: the two built-in outputs. */
    private val BARE_PHONE = setOf(
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
    )

    @Test fun `a bare phone goes to the loudspeaker, not the earpiece`() {
        // The defect, and the common case: no headset, so the OS default
        // (USAGE_VOICE_COMMUNICATION → earpiece) is what we override.
        assertEquals(
            "a hands-free call on a desk must be audible",
            CallAudio.Route.SPEAKER,
            CallAudio.chooseRoute(setOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)),
        )
    }

    @Test fun `a phone reporting NO devices is still a bare phone`() {
        // An empty set is not "unknown, so be careful" — the earpiece default is
        // what happens if we do nothing, and that is the thing being fixed.
        assertEquals(CallAudio.Route.SPEAKER, CallAudio.chooseRoute(emptySet()))
    }

    @Test fun `the glasses keep the call — this is the regression that matters`() {
        // ⚠️ The whole reason chooseRoute exists. `.defaultToSpeaker` changes a
        // DEFAULT; it never outranked a connected headset, and iOS asks for
        // `.allowBluetooth` in the same breath. Forcing the speaker here would
        // shout a private call out loud, undoing BtMic's entire purpose on the one
        // surface where privacy matters most.
        assertEquals(
            "a call must not be forced out of the loudspeaker over a headset",
            CallAudio.Route.LEAVE_ALONE,
            CallAudio.chooseRoute(setOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)),
        )
    }

    @Test fun `every kind of headset is honoured, not just bluetooth`() {
        // The honest translation of the iOS pair is "anything the user plugged in
        // or paired", not "Bluetooth only" — a user on USB-C earbuds is exactly as
        // surprised by a loudspeaker as a user wearing the glasses. A regression
        // here would be invisible: the call works, it is just suddenly public.
        for (kind in listOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_HEARING_AID,
        )) {
            assertEquals(
                "device type $kind is something the user is wearing",
                CallAudio.Route.LEAVE_ALONE,
                CallAudio.chooseRoute(setOf(kind)),
            )
        }
    }

    @Test fun `a speaker-only route is not mistaken for a headset`() {
        // The inverse guard on the set above: were TYPE_BUILTIN_SPEAKER ever to
        // creep into HEADSETS, every call would silently go back to the earpiece
        // and this suite would be the only thing that noticed.
        assertEquals(
            CallAudio.Route.SPEAKER,
            CallAudio.chooseRoute(setOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)),
        )
        assertEquals(
            CallAudio.Route.SPEAKER,
            CallAudio.chooseRoute(setOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)),
        )
    }

    @Test fun `a late teardown cannot restore a route another rail took`() {
        // MicClaim's guard, for MicClaim's reason, and RUN rather than read: inside
        // `restore` this branch needs a live AudioManager, so on a device it is the
        // difference between handing back a route another rail is talking over and
        // not. Here it is arithmetic on a string.
        CallAudio.clearHolder()
        CallAudio.claim(BARE_PHONE, "voice-call")
        assertEquals("a stale owner must not undo our route", false, CallAudio.release("dictation"))
        assertEquals("the route is still held", true, CallAudio.forced)
        assertEquals("the owner undoes its own route", true, CallAudio.release("voice-call"))
        assertEquals("and the route is handed back", false, CallAudio.forced)
    }

    @Test fun `a second restore is not a second undo`() {
        // `stop()` is idempotent and reachable twice (hang up, then dispose()). The
        // second pass must not re-clear a route a LATER call has since forced — the
        // inverted guard is as silent as the missing one.
        CallAudio.clearHolder()
        CallAudio.claim(BARE_PHONE, "voice-call")
        assertEquals(true, CallAudio.release("voice-call"))
        assertEquals("nothing left to undo", false, CallAudio.release("voice-call"))
    }

    @Test fun `forcing the speaker is what makes the undo possible`() {
        // ⚠️ The pairing, which is the one thing about the holder that is silent AND
        // permanent: force the route, record nothing, and `restore` politely
        // declines to undo it for the rest of the process — so the loudspeaker
        // outlives the call and the next thing played in call mode comes out of it.
        // Nothing crashes and nothing logs. This is why `claim` decides and records
        // in one call instead of `route` doing it in two statements.
        CallAudio.clearHolder()
        assertEquals(CallAudio.Route.SPEAKER, CallAudio.claim(BARE_PHONE, "voice-call"))
        assertEquals("a forced route must be undoable", true, CallAudio.forced)
        assertEquals(true, CallAudio.release("voice-call"))
    }

    @Test fun `nothing forced means nothing to restore`() {
        // The headset case: the route was LEFT ALONE, so the unconditional `restore`
        // in stop() must be a no-op rather than a clearCommunicationDevice on a
        // route the OS chose — and it must not claim ownership it never took.
        CallAudio.clearHolder()
        assertEquals(
            CallAudio.Route.LEAVE_ALONE,
            CallAudio.claim(setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO), "voice-call"),
        )
        assertEquals("a headset call forced nothing to hand back", false, CallAudio.forced)
        assertEquals(false, CallAudio.release("voice-call"))
    }
}
