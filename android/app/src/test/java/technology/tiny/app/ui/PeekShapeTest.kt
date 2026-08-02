package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import technology.tiny.app.fleet.FrameFailure

/**
 * 📷 `PeekShape` — who asked for the peek, and therefore how loudly the camera
 * panel may report that it failed. iOS `PeekShapeTests` (TinyTests.swift:3295)
 * ported alongside the rule.
 *
 * [RelayCameraPanel] fetches on appearance, so it can be holding a failure nobody
 * requested — and it dressed that in the chrome this app reserves for a user's own
 * action going wrong: a ⚠, TinyWarn, and a control labelled "retry" for something
 * never tried. Four shapes; each one's words are asserted here rather than inside
 * a `Column` where no test can read them.
 */
class PeekShapeTest {

    /**
     * The whole fix in one assertion: identical failure, different provenance,
     * different volume.
     */
    @Test
    fun `the same failure is quiet unasked and loud when asked`() {
        assertEquals(
            PeekShape.Quiet("camera busy"),
            PeekShape.of(error = "camera busy", busy = false, asked = false),
        )
        assertEquals(
            PeekShape.Alarm("camera busy"),
            PeekShape.of(error = "camera busy", busy = false, asked = true),
        )
    }

    /**
     * Quiet is not silent. A swallowed reason is the bug the panel's `error` state
     * exists to fix, so the reason survives in BOTH shapes — only the chrome
     * changes.
     */
    @Test
    fun `an unasked failure still says why`() {
        val why = "No frame in 19s — is the camera awake?"
        val s = PeekShape.of(error = why, busy = false, asked = false)
        assertEquals(why, s.quietReason)
        assertEquals(why, s.spoken)
    }

    /**
     * The card owns its reason, so there is no grey line to print alongside it —
     * otherwise the sheet says the same thing twice in two shapes.
     */
    @Test
    fun `the card's reason is not also a line`() {
        assertNull(PeekShape.Alarm("camera busy").quietReason)
        assertNull(PeekShape.Idle.quietReason)
        assertNull(PeekShape.Working.quietReason)
    }

    /**
     * A fetch in flight outranks the reason the last one failed: the spinner is
     * the newer fact. This is the ordering `why != null && !busy` already had, and
     * reversing it makes a retry look like it never started.
     */
    @Test
    fun `a fetch in flight outranks a stale reason`() {
        assertEquals(PeekShape.Working, PeekShape.of(error = "camera busy", busy = true, asked = true))
        assertEquals(PeekShape.Working, PeekShape.of(error = "camera busy", busy = true, asked = false))
    }

    /**
     * `FrameFailure.Cancelled` means the panel left the screen: nobody is left to
     * read a complaint, and an empty message renders as a bare ⚠ with no words
     * beside it.
     */
    @Test
    fun `a cancelled peek is not a failure to report`() {
        assertEquals(PeekShape.Idle, PeekShape.of(error = null, busy = false, asked = true))
        assertEquals(
            PeekShape.Idle,
            PeekShape.of(error = FrameFailure.Cancelled.message, busy = false, asked = true),
        )
    }

    /**
     * TalkBack reads a merged node's contentDescription INSTEAD of the text inside
     * it, so every shape must carry its own words — the failure `deviceSubtitle`
     * fixed for device rows, one panel deeper.
     */
    @Test
    fun `every shape has something to say out loud`() {
        val shapes = listOf(
            PeekShape.Working, PeekShape.Idle,
            PeekShape.Quiet("camera busy"), PeekShape.Alarm("camera busy"),
        )
        for (s in shapes) assertTrue("$s is silent to TalkBack", s.spoken.isNotEmpty())
        assertEquals("peek at the camera", PeekShape.Idle.spoken)
        assertEquals("asking the camera for a frame", PeekShape.Working.spoken)
    }

    /**
     * The affordance goes in the CLICK LABEL, for exactly the one shape whose
     * words are the board's own. Gluing "tap to peek" onto "camera busy" would be
     * the "·" bug in a new costume: two of the five messages are pass-through
     * strings with no punctuation to join against.
     */
    @Test
    fun `only the reason shape needs the affordance spelled separately`() {
        assertEquals("fetch a frame", PeekShape.Quiet("camera busy").spokenHint)
        assertNull(PeekShape.Idle.spokenHint)
        assertNull(PeekShape.Working.spokenHint)
        assertNull(PeekShape.Alarm("camera busy").spokenHint)
        // The label carries no invitation of its own, which is WHY there's a hint.
        assertEquals("camera busy", PeekShape.Quiet("camera busy").spoken)
    }

    /**
     * Every real failure an unasked peek can produce lands in `Quiet` carrying the
     * words whoever actually knew wrote — none re-worded, none promoted to an
     * alarm the user never asked for.
     */
    @Test
    fun `every real failure from an unasked peek stays quiet and verbatim`() {
        val failures = listOf(
            FrameFailure.RelayRefused("device not found"),
            FrameFailure.NoReply(19),
            FrameFailure.DeviceSaid("no camera on this board"),
            FrameFailure.Undecodable,
        )
        for (f in failures) {
            val s = PeekShape.of(error = f.message, busy = false, asked = false)
            assertEquals("$f escaped the quiet shape", PeekShape.Quiet(f.message), s)
            assertEquals(f.message, s.quietReason)
        }
    }
}
