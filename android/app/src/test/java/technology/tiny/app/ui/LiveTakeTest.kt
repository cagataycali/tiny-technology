package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🎙️ A take that showed a meter and no words.
 *
 * Both Record buttons on this phone — the Voice device panel and the Transcripts
 * sheet — drew ten level bars while a take ran and never showed a single word,
 * because `PhoneRecorder.listen` kept the recognizer's partials in a LOCAL
 * variable and dropped them at the end. **A meter proves the mic hears SOMETHING;
 * only words prove it hears YOU**, which is what a person wants to know before
 * trusting a screen with two minutes of speech. iOS carried the identical gap and
 * said so in its own comment ("partial recognition text is not shown anywhere
 * else in this view"); it was fixed at `e99e3c53`.
 *
 * These are the two pure rules a JVM test can reach: when there is anything worth
 * drawing, and what the line under the bars says. The Compose half (that the
 * recorder publishes on its 200ms tick, that both surfaces render it, that the
 * scroll tails) is pinned in `tests/android-live-take-words.test.ts`.
 */
class LiveTakeTest {

    // ── when there is anything worth drawing ────────────────────────────────────

    @Test fun `no words yet means nothing to draw`() {
        assertFalse(LiveTake.hasWords(""))
    }

    @Test fun `whitespace is not words`() {
        // ⚠️ `PhoneRecorder.partial` is built by `snapshot()`, which JOINS the finals
        // and the live partial — an empty final beside an empty partial can arrive as
        // " ". Drawing that opens a text block holding nothing, which reads as a
        // rendering bug rather than as a quiet room.
        assertFalse(LiveTake.hasWords(" "))
        assertFalse(LiveTake.hasWords("   \n\t "))
    }

    @Test fun `one word is enough`() {
        // The first partial is the whole point: it is the moment the screen stops
        // being a claim and starts being evidence.
        assertTrue(LiveTake.hasWords("buy"))
        assertTrue(LiveTake.hasWords("  buy  "))
    }

    // ── the caption: the one place two identical-looking states differ ──────────

    @Test fun `silence and speech are captioned differently`() {
        // ⚠️ THE RULE. Without it, "Recording…" covers both "you just tapped Record"
        // and "this microphone is not hearing you at all" — normal at second one,
        // alarming at second ten, and the app's only chance to say which.
        assertNotEquals(LiveTake.caption(""), LiveTake.caption("buy milk"))
    }

    @Test fun `a take with no words yet still says how to end it`() {
        // Both captions must name Stop: the take runs to a 120-second ceiling, and a
        // caption that drops the instruction leaves the user waiting out a memo they
        // already finished.
        assertTrue(LiveTake.caption("").contains("Stop"))
        assertTrue(LiveTake.caption("buy milk").contains("Stop"))
    }

    @Test fun `the speaking caption says the words are being transcribed here`() {
        // On-device, and said out loud — the words in that box are the app listening
        // to a room, so where they are going is not a detail.
        val c = LiveTake.caption("buy milk")
        assertTrue(c, c.contains("on-device"))
    }

    @Test fun `a whitespace-only take is captioned as silence, not as speech`() {
        // The same join artifact as above, in the half that is always rendered: a
        // blank snapshot claiming "Transcribing" is a promise about words nobody said.
        assertEquals(LiveTake.caption(""), LiveTake.caption("   "))
    }
}
