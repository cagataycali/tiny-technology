package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🌙 When a panel may spend a relay round-trip — and what it says when it may not.
 *
 * `RelayCameraPanel` fetched a frame from `LaunchedEffect(deviceId)` on every
 * appearance and never read presence at all. So opening My devices with a Vision
 * necklace asleep in a drawer spent a POST plus sixteen polls on it and then
 * painted the silence orange, under a ⚠ and beside a retry, directly above a row
 * that already read "seen 3 days ago". The camera was awake. The board was gone,
 * and the biggest element on the sheet blamed the hardware that was working.
 *
 * The worker's own definition of a dial-in device settles it: PULL_KINDS
 * (worker/src/devices.ts) are the kinds that "hold a `tind_` token,
 * heartbeat, poll the relay" — one loop, both jobs — so a device outside the 60s
 * PRESENCE_WINDOW_S is not reading the relay either.
 *
 * iOS twin: RelayReachTests in ios/Tests/TinyTests.swift. The two implementations
 * are held to one shape by tests/nicla-android-parity.test.ts.
 */
class RelayReachTest {

    @Test fun `only an online device is worth a relay call`() {
        assertTrue(RelayReach.canReach(DevicePresence.ONLINE))
        assertFalse(RelayReach.canReach(DevicePresence.OFFLINE))
        // UNKNOWN too. It means "nothing here can tell you", which is not a
        // licence to spend a round-trip proving it.
        assertFalse(RelayReach.canReach(DevicePresence.UNKNOWN))
    }

    @Test fun `an asleep board is not a broken camera`() {
        // Blames the BOARD, and names it: a panel is its own block, so "it" has no
        // antecedent inside one.
        assertEquals(
            "tiny-vision isn't online — its camera answers once it's back.",
            RelayReach.cameraNote("tiny-vision", DevicePresence.OFFLINE),
        )
        assertEquals(
            "tiny-vision isn't online — its camera answers once it's back.",
            RelayReach.cameraNote("tiny-vision", DevicePresence.UNKNOWN),
        )
        // The line this replaced was the panel's own timeout — "no frame in 19s",
        // which sent the user to check a camera that was fine — and it must not
        // come back in this sentence's clothing.
        val note = RelayReach.cameraNote("tiny-vision", DevicePresence.OFFLINE) ?: ""
        assertFalse(note, note.contains("camera awake"))
        assertFalse(note, note.lowercase().contains("failed"))
        assertFalse(note, note.contains("19s"))
    }

    @Test fun `an online board gets no excuse and keeps its fetch`() {
        // null is what lets the panel call. ONE function answers both halves, so a
        // sentence on screen and a call on the wire can never coexist.
        assertNull(RelayReach.cameraNote("tiny-vision", DevicePresence.ONLINE))
    }

    @Test fun `the sentence and the silence are one decision`() {
        // Whatever else drifts, these two must stay the same fact: a note exists
        // exactly when the call is refused. Diverge them and the panel can show a
        // reason while still fetching, or fetch nothing with nothing to say.
        for (p in DevicePresence.entries) {
            assertEquals(
                "note and canReach disagree at $p",
                RelayReach.canReach(p),
                RelayReach.cameraNote("x", p) == null,
            )
        }
    }

    @Test fun `the note carries the device's own name, whatever it is`() {
        // Two necklaces on one sheet each get their own line; a hardcoded
        // "the necklace" would make the sheet ambiguous exactly when it matters.
        assertTrue(RelayReach.cameraNote("kitchen-cam", DevicePresence.OFFLINE)!!.startsWith("kitchen-cam "))
        // Names are user-supplied and this is a whole sentence, so an empty one
        // would open with a space. Not worth branching on — the row above always
        // has a name — but pinned so the shape is a decision, not an accident.
        assertEquals(
            " isn't online — its camera answers once it's back.",
            RelayReach.cameraNote("", DevicePresence.OFFLINE),
        )
    }
}
