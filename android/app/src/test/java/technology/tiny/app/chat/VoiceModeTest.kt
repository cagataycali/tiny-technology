package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 🔴 Continuous voice mode said things twice.
 *
 * `VoiceMode` rolls a new `SpeechRecognizer` on every final result and every
 * error, because Android's ends sessions on its own. It set ONE shared
 * `RecognitionListener` object on every recognizer it built — and `destroy()` is
 * asynchronous, so a callback from the session just torn down arrives at the same
 * listener that now serves its replacement, with nothing in the callback saying
 * which recognizer it came from.
 *
 * Two silent consequences. A late `onResults` appended its text to `pending` a
 * SECOND time (the roll in `onError` had already absorbed `_partial` into
 * `pending`), so the sent message repeated a sentence — and a model reads a
 * repetition as two things being said, which is worse than a clip. And a late
 * `onResults`/`onError` called `startSession()` on a recognizer that had only
 * just opened, destroying it mid-utterance and tripping an extra roll.
 *
 * iOS hit exactly this and fixed it with a generation counter in `TakeBox`
 * (`NiclaRecorder.swift:97`, `6a5eb026`): a callback that cannot prove it belongs
 * to the live task is ignored. Ported here, plus the dedupe half of
 * `TakeBox.bank` — the join was bare.
 *
 * These are the pure halves, which is all that runs on the local JVM: the
 * accumulation rule and the meter map. The wiring (a per-session listener, every
 * callback gated on it, `stop()` bumping the generation, the debounced roll
 * re-reading it AFTER its wait) is pinned in `tests/voice-session-identity.test.ts`.
 */
class VoiceModeTest {

    // ── the accumulation rule ────────────────────────────────────────────────────

    @Test fun `two different utterances join with a single space`() {
        assertEquals("hello there general kenobi",
            VoiceMode.appendHeard("hello there", "general kenobi"))
    }

    @Test fun `a repeated utterance is not said twice`() {
        // ⚠️ THE DEFECT. A late callback from a torn-down session reports words the
        // bank already holds; `joinToString(" ")` appended them regardless.
        assertEquals("okay send it", VoiceMode.appendHeard("okay send it", "send it"))
        assertEquals("okay send it", VoiceMode.appendHeard("okay send it", "okay send it"))
    }

    @Test fun `capitalisation does not make one utterance into two`() {
        // The recognizer re-capitalises freely across sessions, so a case-sensitive
        // compare would let the same sentence through as new.
        assertEquals("Okay send it", VoiceMode.appendHeard("Okay send it", "okay send it"))
        assertEquals("okay send it", VoiceMode.appendHeard("okay send it", "SEND IT"))
    }

    @Test fun `a longer re-reading of the tail replaces it instead of doubling it`() {
        // A roll can hand the next session audio already transcribed, and it often
        // comes back longer: "so I said" → "so I said hello". One sentence, heard
        // twice — keep the fuller reading, not both.
        assertEquals("so I said hello", VoiceMode.appendHeard("so I said", "so I said hello"))
    }

    @Test fun `blank input never adds a dangling separator`() {
        // `_partial` feeds the auto-send directly, so a trailing space or a lone
        // separator would be sent as the user's message.
        assertEquals("hello", VoiceMode.appendHeard("hello", ""))
        assertEquals("hello", VoiceMode.appendHeard("hello", "   "))
        assertEquals("hello", VoiceMode.appendHeard("", "hello"))
        assertEquals("hello", VoiceMode.appendHeard("  ", " hello "))
        assertEquals("", VoiceMode.appendHeard("", ""))
        assertEquals("", VoiceMode.appendHeard("  ", "\n"))
    }

    @Test fun `the result is always trimmed, because it is sent verbatim`() {
        for (out in listOf(
            VoiceMode.appendHeard(" hello ", " there "),
            VoiceMode.appendHeard("hello", " "),
            VoiceMode.appendHeard(" ", "hello"),
        )) {
            assertEquals("a sent message with edge whitespace", out.trim(), out)
        }
    }

    @Test fun `accumulating a whole rolled session never repeats a sentence`() {
        // The end-to-end shape of a real take: several rolls, one of which replays
        // its tail (the recognizer re-reading audio the bank already has) and one of
        // which arrives twice (the late-callback bug).
        var pending = ""
        for (heard in listOf(
            "what is", "what is the weather",   // a longer re-reading of the tail
            "in berlin",
            "in berlin",                        // a late duplicate from a dead session
            "today",
        )) pending = VoiceMode.appendHeard(pending, heard)
        assertEquals("what is the weather in berlin today", pending)
        // And said outright, since this is the property that matters:
        assertEquals("a sentence appears twice", 1,
            Regex("in berlin").findAll(pending.lowercase()).count())
    }

    @Test fun `a genuine repetition the speaker actually said is not the target`() {
        // ⚠️ The honest limit of this rule, stated so it is a decision and not a
        // surprise: someone who says "no no" across a roll boundary gets one "no".
        // Dedupe cannot distinguish that from a replayed utterance, and the
        // alternative — a doubled sentence on every roll — is the worse of the two,
        // because it changes the meaning of what was said rather than shortening it.
        assertEquals("no", VoiceMode.appendHeard("no", "no"))
    }

    // ── the meter ────────────────────────────────────────────────────────────────

    @Test fun `the level map covers Android's RMS range`() {
        assertEquals(0f, VoiceMode.levelFor(-2f), 0.001f)  // silence
        assertEquals(1f, VoiceMode.levelFor(10f), 0.001f)  // loud
        assertEquals(0.5f, VoiceMode.levelFor(4f), 0.001f) // midpoint
    }

    @Test fun `the level is clamped, so the bar cannot run past its track`() {
        // A shouted syllable reports well over 10 dB, and some engines report large
        // negatives for silence.
        assertEquals(1f, VoiceMode.levelFor(120f), 0.001f)
        assertEquals(0f, VoiceMode.levelFor(-100f), 0.001f)
        for (db in listOf(-100f, -2f, 0f, 4f, 10f, 42f, 1000f)) {
            val v = VoiceMode.levelFor(db)
            assertTrue("level $v out of 0..1 for ${db}dB", v in 0f..1f)
        }
    }
}
