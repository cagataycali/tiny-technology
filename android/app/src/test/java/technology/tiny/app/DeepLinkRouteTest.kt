package technology.tiny.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * safeWidgetRoute is the pure gate that keeps a BROWSABLE tinyapp:// deep link
 * from auto-starting the mic. tinyapp://voice reaches MainActivity from ANY web
 * page's <a href> (the scheme is exported + browsable), and the voice route
 * calls vm.voice.start() when RECORD_AUDIO is already granted — so a silent web
 * link could trip the hardware mic with no user gesture. A browser hand-off
 * always carries CATEGORY_BROWSABLE; the trusted widget/launcher intents don't.
 * These pin: browser voice → downgraded to "ask"; widget voice → untouched;
 * every other route passes through from either origin.
 */
class DeepLinkRouteTest {

    @Test fun `a browser-originated voice link is downgraded to ask (mic stays gated)`() {
        assertEquals("ask", safeWidgetRoute("voice", browsable = true))
    }

    @Test fun `a widget voice tap keeps the voice route`() {
        assertEquals("voice", safeWidgetRoute("voice", browsable = false))
    }

    @Test fun `inert routes pass through unchanged from a browser`() {
        assertEquals("ask", safeWidgetRoute("ask", browsable = true))
        assertEquals("memory", safeWidgetRoute("memory", browsable = true))
        assertEquals("messages", safeWidgetRoute("messages", browsable = true))
    }

    @Test fun `inert routes pass through unchanged from a widget`() {
        assertEquals("ask", safeWidgetRoute("ask", browsable = false))
        assertEquals("memory", safeWidgetRoute("memory", browsable = false))
        assertEquals("messages", safeWidgetRoute("messages", browsable = false))
    }

    // ── askQuery: the ask?q= trust rule (native tap→redeem) ────────────────
    // Our own notification taps (never browsable) auto-send the push's redeem
    // turn; a BROWSABLE ask?q= from any web page must NEVER auto-send an
    // attacker-authored prompt into the user's agent — seed-only.

    @Test fun `a trusted (non-browsable) ask query auto-sends`() {
        val q = askQuery("fetch my results", browsable = false)!!
        assertEquals("fetch my results", q.text)
        assertEquals(true, q.autoSend)
    }

    @Test fun `a browser-originated ask query can only seed the composer`() {
        val q = askQuery("rm -rf my life", browsable = true)!!
        assertEquals(false, q.autoSend)
    }

    @Test fun `blank or missing q is no query at all`() {
        assertNull(askQuery(null, browsable = false))
        assertNull(askQuery("", browsable = false))
        assertNull(askQuery("   ", browsable = true))
    }

    @Test fun `a null host stays null (no route)`() {
        assertNull(safeWidgetRoute(null, browsable = true))
        assertNull(safeWidgetRoute(null, browsable = false))
    }

    @Test fun `an unknown host is not special-cased`() {
        // Only "voice" activates a sensor; anything else is returned verbatim and
        // filtered by the caller's when-branch, browsable or not.
        assertEquals("wallet", safeWidgetRoute("wallet", browsable = true))
    }
}
