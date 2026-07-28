package technology.tiny.app.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * statusAnnouncement — the spoken (TalkBack live-region) phrasing of the voice
 * call phase. The call phase is the one meaning-bearing state a blind user can't
 * hear otherwise (the tiny's reply arrives as audio, but "connected"/"ended"/
 * connection failures are visual-only), so these pin that every phase produces a
 * full, non-fragment sentence — and that the two states a user most needs to
 * distinguish (connected vs ended) are unambiguous and name the tiny where it helps.
 */
class VoiceCallScreenTest {

    private val tiny = "scout"

    @Test fun `every phase yields a non-empty sentence ending in punctuation`() {
        for (p in VoiceCall.Phase.values()) {
            val s = statusAnnouncement(tiny, p)
            assertTrue("phase $p must announce something", s.isNotBlank())
            assertTrue("phase $p should read as a sentence: \"$s\"", s.trimEnd().endsWith("…") || s.trimEnd().endsWith("."))
        }
    }

    @Test fun `connecting names the tiny so the user knows who is being called`() {
        assertTrue(statusAnnouncement(tiny, VoiceCall.Phase.CONNECTING).contains("scout"))
        // IDLE reads the same as CONNECTING — the dialog opens straight into dialing.
        assertTrue(statusAnnouncement(tiny, VoiceCall.Phase.IDLE).contains("Connecting"))
    }

    @Test fun `live states the call is connected and names the tiny`() {
        val s = statusAnnouncement(tiny, VoiceCall.Phase.LIVE)
        assertTrue(s.contains("connected")); assertTrue(s.contains("scout"))
    }

    @Test fun `connected and ended are distinct announcements`() {
        // The whole point of the live region: a blind user must not confuse
        // "the call just connected" with "the call just ended".
        val live = statusAnnouncement(tiny, VoiceCall.Phase.LIVE)
        val ended = statusAnnouncement(tiny, VoiceCall.Phase.ENDED)
        assertFalse("connected and ended must differ", live.equals(ended, ignoreCase = true))
        assertTrue(ended.contains("ended"))
    }

    @Test fun `error and byok phases explain what went wrong, not a bare 'live'`() {
        assertTrue(statusAnnouncement(tiny, VoiceCall.Phase.ERROR).contains("Couldn't connect"))
        val byok = statusAnnouncement(tiny, VoiceCall.Phase.BYOK_REQUIRED)
        assertTrue(byok.contains("OpenAI key"))
        // BYOK is actionable — the announcement should say what to do.
        assertTrue(byok.contains("Add"))
    }
}
