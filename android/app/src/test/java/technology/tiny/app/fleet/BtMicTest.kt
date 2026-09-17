package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 🎧 BtMic's holder arithmetic — RUN, not pinned as source text.
 *
 * This is the half of c66's port that made four rails safe, and the reason it
 * needed to exist at all: iOS sets `.allowBluetooth` on four audio sessions, so
 * Android grew from two BtMic callers to four — and [MicClaim] does not serialise
 * them (the HUD transcriber and a relay-commanded take never see each other, so
 * they genuinely overlap). Under the single `claimed` boolean this object used to
 * keep, the first rail to FINISH tore the SCO link down underneath a rail still
 * recording, which then carried on hearing the phone's built-in mic while `active`
 * read false. Silent: the transcript still arrives, the words are just the wrong
 * room's.
 *
 * The three entry points are pure (no `android.*`), which is why they were split
 * out of `acquire`/`release` — those need an `AudioManager` and can only be pinned
 * by source-reading (`tests/wearables-android.test.ts`). Everything a wrong
 * holder-set would do to the link is decided here.
 */
class BtMicTest {
    @Before fun reset() = BtMic.clearHolders()

    @Test fun `the first rail does not JOIN — there is nothing up to join`() {
        assertFalse("an empty holder set means the link is DOWN", BtMic.joinIfUp("recorder"))
        // …and joining nothing must record nothing: a rail told "already up" skips
        // raising SCO, so a recorded non-holder would hear the phone and report BT.
        assertEquals(emptySet<String>(), BtMic.heldBy)
        assertFalse(BtMic.active)
    }

    @Test fun `a second rail joins a live link and is recorded`() {
        BtMic.noteHolder("recorder")
        assertTrue("the link is up, so the answer to 'will it hear the headset' is yes",
            BtMic.joinIfUp("hud-transcript"))
        assertEquals(setOf("recorder", "hud-transcript"), BtMic.heldBy)
    }

    @Test fun `one rail finishing does NOT drop a link another still holds`() {
        BtMic.noteHolder("hud-transcript")
        BtMic.joinIfUp("recorder")
        // The exact bug: the HUD transcriber finishes first while the take records.
        assertEquals(BtMic.Drop.STILL_HELD, BtMic.dropHolder("hud-transcript"))
        assertTrue("the take is still recording through the headset", BtMic.active)
        assertEquals(setOf("recorder"), BtMic.heldBy)
        // …and when the take finishes too, the link may finally come down.
        assertEquals(BtMic.Drop.LAST, BtMic.dropHolder("recorder"))
        assertFalse(BtMic.active)
    }

    @Test fun `a teardown that runs TWICE cannot drop another rail's link`() {
        // A SET, not a counter, and this is what the difference buys: a `finally`
        // after a cancellation that already released is ordinary, not a bug. A
        // counter would go 2 → 1 → 0 and cut the link while `recorder` records.
        BtMic.noteHolder("voice-mode")
        BtMic.joinIfUp("recorder")
        assertEquals(BtMic.Drop.STILL_HELD, BtMic.dropHolder("voice-mode"))
        assertEquals("the second release is a no-op, not a decrement",
            BtMic.Drop.NOT_A_HOLDER, BtMic.dropHolder("voice-mode"))
        assertTrue(BtMic.active)
        assertEquals(setOf("recorder"), BtMic.heldBy)
    }

    @Test fun `releasing without ever acquiring changes nothing`() {
        // The COMMON case: no glasses on the user's face, so `acquire` returned
        // false and never recorded the rail — but `release` still runs in a
        // `finally`. It must not touch a link somebody else raised.
        BtMic.noteHolder("meta_listen")
        assertEquals(BtMic.Drop.NOT_A_HOLDER, BtMic.dropHolder("recorder"))
        assertTrue(BtMic.active)
        assertEquals(setOf("meta_listen"), BtMic.heldBy)
    }

    @Test fun `the same rail acquiring twice holds ONE name, and one release ends it`() {
        // Idempotent by construction (a set). VoiceMode's start() can be reached
        // twice around a denied permission; two names for one rail would leave a
        // ghost holder and the headset would keep the phone in call mode forever.
        BtMic.noteHolder("voice-mode")
        BtMic.joinIfUp("voice-mode")
        assertEquals(setOf("voice-mode"), BtMic.heldBy)
        assertEquals(BtMic.Drop.LAST, BtMic.dropHolder("voice-mode"))
        assertFalse(BtMic.active)
    }

    @Test fun `active and heldBy agree with each other at every step`() {
        // `active` is what `micRoute` reports to the agent ("bluetooth" / "phone"),
        // so a derivation that drifts from the holder set is a transcript naming the
        // wrong microphone — the one failure mode nothing on screen would show.
        assertEquals(BtMic.heldBy.isNotEmpty(), BtMic.active)
        BtMic.noteHolder("recorder")
        assertEquals(BtMic.heldBy.isNotEmpty(), BtMic.active)
        assertTrue(BtMic.active)
        BtMic.dropHolder("recorder")
        assertEquals(BtMic.heldBy.isNotEmpty(), BtMic.active)
        assertFalse(BtMic.active)
    }

    @Test fun `heldBy is a COPY — a caller cannot mutate the holder set`() {
        BtMic.noteHolder("recorder")
        val snapshot = BtMic.heldBy
        BtMic.noteHolder("hud-transcript")
        assertEquals("the snapshot must not follow later changes", setOf("recorder"), snapshot)
        assertEquals(setOf("recorder", "hud-transcript"), BtMic.heldBy)
    }

    @Test fun `four overlapping rails — only the last one out drops the link`() {
        // The whole reason ownership had to land before the two new callers did.
        val rails = listOf("meta_listen", "hud-transcript", "recorder", "voice-mode")
        BtMic.noteHolder(rails.first())
        for (r in rails.drop(1)) assertTrue(BtMic.joinIfUp(r))
        assertEquals(rails.toSet(), BtMic.heldBy)
        for (r in rails.dropLast(1)) {
            assertEquals("$r left, but others are still recording",
                BtMic.Drop.STILL_HELD, BtMic.dropHolder(r))
            assertTrue(BtMic.active)
        }
        assertEquals(BtMic.Drop.LAST, BtMic.dropHolder(rails.last()))
        assertFalse(BtMic.active)
    }
}
