package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * announceText — the "say/announce/speak '<message>'" relay-command parser behind
 * the local speak fast-path (iOS Session.announceText parity). Extracted from the
 * impure answer() so the quote grammar is pinned off the Speech/Config I/O.
 *
 * The regression this locks: the shipped single character-class `["“'](.+?)["”']`
 * let a bare apostrophe both OPEN and CLOSE a span, so a message with contractions
 * ("say don't worry, it's fine") captured the junk BETWEEN the apostrophes. The fix
 * uses MATCHED-PAIR patterns with word-boundary-guarded straight quotes.
 */
class AnnounceTextTest {

    @Test fun `a double-quoted message is the text verbatim`() {
        assertEquals("dinner is ready", announceText("say \"dinner is ready\""))
        assertEquals("dinner is ready", announceText("announce \"dinner is ready\""))
        assertEquals("hello", announceText("speak \"hello\""))
    }

    // ── the regression: apostrophes in contractions must NOT open a quoted span ──

    @Test fun `contraction apostrophes do not open a span — the double-quoted message wins`() {
        // The buggy mixed class matched `'t worry, it'` between the two apostrophes.
        // With matched pairs, the DOUBLE quotes are the only real span.
        assertEquals("don't worry, it's fine", announceText("say \"don't worry, it's fine\""))
    }

    @Test fun `a straight-single-quoted message needs word boundaries around the quotes`() {
        // A properly-quoted single-quote span still works…
        assertEquals("dinner is ready", announceText("say 'dinner is ready'"))
        // …but bare contraction apostrophes with no surrounding boundaries never open one.
        assertNull(announceText("say don't worry"))
    }

    @Test fun `curly quote pairs are matched (smart-quote keyboards)`() {
        assertEquals("game night", announceText("announce “game night”"))
        assertEquals("game night", announceText("announce ‘game night’"))
    }

    // ── verb must lead (word-boundary anchored) ──

    @Test fun `the verb must be a whole word — display and essay never trigger it`() {
        assertNull(announceText("display \"the charts\""))
        assertNull(announceText("essay \"about cats\""))
    }

    @Test fun `no speak verb yields null — the prompt proxies to the agent`() {
        assertNull(announceText("what's the weather \"today\""))
        assertNull(announceText("play daft punk on spotify"))
    }

    @Test fun `a speak verb with no quoted span yields null`() {
        // Android couples the verb to a quoted span (unlike iOS's unquoted fallback);
        // no quotes → null → the command proxies through the agent.
        assertNull(announceText("say dinner is ready"))
    }

    // ── ordering + bounds ──

    @Test fun `the verb must PRECEDE the quote, not merely appear somewhere`() {
        // A quote before any verb is not a command span (the `.*?` runs verb→quote).
        assertNull(announceText("\"random quote\" with no command"))
    }

    @Test fun `the first matching pattern wins and the result is trimmed`() {
        // Leading/trailing whitespace inside the span is trimmed (iOS parity).
        assertEquals("hi there", announceText("say \"  hi there  \""))
    }

    @Test fun `a span longer than 300 chars is not captured`() {
        val huge = "x".repeat(301)
        assertNull(announceText("say \"$huge\""))
        // Exactly 300 is fine.
        val ok = "y".repeat(300)
        assertEquals(ok, announceText("say \"$ok\""))
    }
}
