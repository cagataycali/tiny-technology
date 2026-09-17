package technology.tiny.app.chat

import android.media.AudioManager
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ownership arithmetic + loss polarity of the app's single audio-focus holder,
 * on the local JVM — the [technology.tiny.app.fleet.BtMicTest] shape, for the same
 * reason: this is the part that decides whether the user's music comes back at the
 * right moment, and it must be EXECUTED, not read.
 *
 * `AudioManager`'s int constants are compile-time `const`, so [AudioDuck.classify]
 * needs no device. `acquire`/`release` do (they touch a system service), which is
 * exactly why the decisions live in the internal functions these tests drive.
 */
class AudioDuckTest {

    @After
    fun tearDown() = AudioDuck.clearHolders() // an `object` outlives one test

    // ── Loss polarity ─────────────────────────────────────────────────────────

    @Test
    fun `a real loss halts the rail`() {
        assertEquals(AudioDuck.OnLoss.HALT, AudioDuck.classify(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals(AudioDuck.OnLoss.HALT, AudioDuck.classify(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
    }

    /**
     * The arm the polarity turns on. `CAN_DUCK` means something short wants to talk
     * over US — a navigation prompt. Halting there would end a live call because the
     * phone said "turn left", so it must read KEEP, not HALT.
     */
    @Test
    fun `being ducked ourselves is not a loss`() {
        assertEquals(
            AudioDuck.OnLoss.KEEP,
            AudioDuck.classify(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK),
        )
    }

    @Test
    fun `regaining focus does not halt anything`() {
        assertEquals(AudioDuck.OnLoss.KEEP, AudioDuck.classify(AudioManager.AUDIOFOCUS_GAIN))
        assertEquals(AudioDuck.OnLoss.KEEP, AudioDuck.classify(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT))
        assertEquals(
            AudioDuck.OnLoss.KEEP,
            AudioDuck.classify(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK),
        )
    }

    // ── Ownership ─────────────────────────────────────────────────────────────

    @Test
    fun `nothing is held to begin with`() {
        assertFalse(AudioDuck.active)
        assertEquals(emptySet<String>(), AudioDuck.heldBy)
    }

    /**
     * The gate that keeps a rail from reporting a duck that isn't happening: with
     * nothing held there is nothing to join, and — the half a bare `return false`
     * gets wrong — the caller must not be recorded either.
     */
    @Test
    fun `joining an unheld duck records nothing`() {
        assertFalse(AudioDuck.joinIfHeld("tts") {})
        assertEquals(emptySet<String>(), AudioDuck.heldBy)
        assertFalse(AudioDuck.active)
    }

    @Test
    fun `a granted request makes the duck ours`() {
        AudioDuck.noteHolder("tts") {}
        assertTrue(AudioDuck.active)
        assertEquals(setOf("tts"), AudioDuck.heldBy)
    }

    /** A second rail joins with no OS call at all — that IS the no-steal property. */
    @Test
    fun `a second rail joins a duck we already hold`() {
        AudioDuck.noteHolder("tts") {}
        assertTrue(AudioDuck.joinIfHeld("voice-mode-mic") {})
        assertEquals(setOf("tts", "voice-mode-mic"), AudioDuck.heldBy)
    }

    /**
     * ⚠️ The whole reason this is a set and not a boolean. Voice mode speaks a reply
     * while its recognizer rolls; the rail that finishes FIRST must not unduck.
     */
    @Test
    fun `the first rail to finish does not unduck`() {
        AudioDuck.noteHolder("tts") {}
        AudioDuck.joinIfHeld("voice-mode-mic") {}
        assertEquals(AudioDuck.Drop.STILL_HELD, AudioDuck.dropHolder("tts"))
        assertTrue(AudioDuck.active)
        assertEquals(setOf("voice-mode-mic"), AudioDuck.heldBy)
        assertEquals(AudioDuck.Drop.LAST, AudioDuck.dropHolder("voice-mode-mic"))
        assertFalse(AudioDuck.active)
    }

    /**
     * A teardown that runs twice is ordinary here (a `finally` after a cancellation
     * that already released). Under a COUNTER the second pass would decrement below
     * the true holder count and unduck over a live sentence; a name can only be
     * removed once.
     */
    @Test
    fun `releasing twice cannot unduck another rail`() {
        AudioDuck.noteHolder("voice-call") {}
        AudioDuck.joinIfHeld("tts") {}
        assertEquals(AudioDuck.Drop.STILL_HELD, AudioDuck.dropHolder("voice-call"))
        // The duplicate: NOT_A_HOLDER, and — the part that matters — still held.
        assertEquals(AudioDuck.Drop.NOT_A_HOLDER, AudioDuck.dropHolder("voice-call"))
        assertTrue(AudioDuck.active)
        assertEquals(setOf("tts"), AudioDuck.heldBy)
    }

    /**
     * `release()` is safe to call unconditionally, so a rail that never acquired
     * (a call that died before the mic opened) has to be distinguishable from the
     * last holder leaving — the first must abandon nothing.
     */
    @Test
    fun `a rail that never acquired is not a holder`() {
        assertEquals(AudioDuck.Drop.NOT_A_HOLDER, AudioDuck.dropHolder("voice-call"))
        assertFalse(AudioDuck.active)
    }

    /** Re-acquiring under the same name is idempotent — back-to-back speak(). */
    @Test
    fun `the same rail twice is one holder`() {
        AudioDuck.noteHolder("tts") {}
        AudioDuck.joinIfHeld("tts") {}
        assertEquals(setOf("tts"), AudioDuck.heldBy)
        // One release, and the music comes back — not two.
        assertEquals(AudioDuck.Drop.LAST, AudioDuck.dropHolder("tts"))
    }

    // ── Loss fan-out ──────────────────────────────────────────────────────────

    /**
     * A phone call has to reach EVERY holder. When the mic rails and TTS are both
     * up, halting only one leaves the other talking over the caller.
     */
    @Test
    fun `a loss reaches every holder`() {
        val halted = mutableListOf<String>()
        AudioDuck.noteHolder("tts") { halted += "tts" }
        AudioDuck.joinIfHeld("voice-mode-mic") { halted += "voice-mode-mic" }
        AudioDuck.lossTargets().forEach { it() }
        assertEquals(listOf("tts", "voice-mode-mic"), halted)
    }

    /**
     * A joining rail brings its OWN halt action. The map is keyed by name, and an
     * overwrite must replace the callback too — otherwise a rail that re-acquires
     * after being rebuilt halts a dead instance and keeps playing.
     */
    @Test
    fun `re-acquiring replaces the halt action`() {
        var which = ""
        AudioDuck.noteHolder("tts") { which = "old" }
        AudioDuck.noteHolder("tts") { which = "new" }
        AudioDuck.lossTargets().forEach { it() }
        assertEquals("new", which)
    }

    /**
     * ⚠️ The snapshot must be a COPY. Every real halt action calls `release()`,
     * which mutates the holder map — iterating the live collection would throw
     * `ConcurrentModificationException` on the very event this exists to handle,
     * and a phone call would leave the tiny talking.
     */
    @Test
    fun `a halt action may release from inside the fan-out`() {
        AudioDuck.noteHolder("tts") { AudioDuck.dropHolder("tts") }
        AudioDuck.joinIfHeld("voice-mode-mic") { AudioDuck.dropHolder("voice-mode-mic") }
        AudioDuck.lossTargets().forEach { it() } // must not throw
        assertFalse(AudioDuck.active)
    }

    @Test
    fun `an unheld duck has nothing to halt`() {
        assertEquals(0, AudioDuck.lossTargets().size)
    }
}
