package technology.tiny.app.fleet

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The DM unread diff (DmNotifier.diff) is the single decision that decides which
 * logins get a heads-up banner on each `/api/messages` poll — the Android port of
 * iOS Session.refreshUnread. It's correctness-sensitive: notify on an unchanged
 * count and every poll re-nags the same message; notify on the first-ever poll and
 * a fresh login gets blasted with all pre-existing unread. These pin the rule.
 * Pure — org.json is on the test classpath, no Context/NotificationManager touched.
 */
class DmNotifierTest {

    private fun thread(login: String, unread: Int, lastBody: String = "hi", name: String? = null) =
        DmThreadSnapshot(login = login, name = name, unread = unread, lastBody = lastBody)

    private fun snapshot(vararg pairs: Pair<String, Int>) =
        JSONObject().apply { pairs.forEach { (k, v) -> put(k, v) } }

    @Test fun `first poll primes silently — never banners even with unread`() {
        val d = DmNotifier.diff(JSONObject(), listOf(thread("ana", 3), thread("bo", 1)), primed = false)
        assertTrue("nothing bannered on the priming poll", d.toNotify.isEmpty())
        assertEquals(4, d.total)
        // snapshot still records the current truth so the NEXT poll can diff.
        assertEquals(3, d.nextSnapshot.getInt("ana"))
        assertEquals(1, d.nextSnapshot.getInt("bo"))
    }

    @Test fun `grown unread banners once we're primed`() {
        val d = DmNotifier.diff(snapshot("ana" to 1), listOf(thread("ana", 3, "new msg")), primed = true)
        assertEquals(1, d.toNotify.size)
        assertEquals("ana", d.toNotify.single().login)
        assertEquals(3, d.total)
    }

    @Test fun `unchanged unread does not re-notify`() {
        val d = DmNotifier.diff(snapshot("ana" to 2), listOf(thread("ana", 2)), primed = true)
        assertTrue(d.toNotify.isEmpty())
        assertEquals(2, d.total)
    }

    @Test fun `dropped unread (a read) does not notify`() {
        val d = DmNotifier.diff(snapshot("ana" to 3), listOf(thread("ana", 1)), primed = true)
        assertTrue(d.toNotify.isEmpty())
        // snapshot follows the count DOWN so a later re-grow diffs from the new floor.
        assertEquals(1, d.nextSnapshot.getInt("ana"))
    }

    @Test fun `a brand-new login (absent from prior) banners when primed`() {
        // optInt defaults to 0, so any positive unread on an unseen login is growth.
        val d = DmNotifier.diff(snapshot("ana" to 1), listOf(thread("ana", 1), thread("newbie", 2)), primed = true)
        assertEquals(listOf("newbie"), d.toNotify.map { it.login })
    }

    @Test fun `grown unread with a blank last body is suppressed`() {
        // Nothing to show in the banner → don't fire (MessagingStyle needs a body).
        val d = DmNotifier.diff(snapshot("ana" to 0), listOf(thread("ana", 2, lastBody = "  ")), primed = true)
        assertTrue(d.toNotify.isEmpty())
        assertEquals(2, d.total)
    }

    @Test fun `only the grown logins banner in a mixed poll`() {
        val prior = snapshot("ana" to 1, "bo" to 2, "cy" to 0)
        val threads = listOf(
            thread("ana", 4, "grew"),  // grew → notify
            thread("bo", 2),           // same → skip
            thread("cy", 1, "first"),  // 0→1 → notify
        )
        val d = DmNotifier.diff(prior, threads, primed = true)
        assertEquals(setOf("ana", "cy"), d.toNotify.map { it.login }.toSet())
        assertEquals(7, d.total)
    }

    @Test fun `total sums every thread regardless of notify state`() {
        val d = DmNotifier.diff(snapshot(), listOf(thread("a", 2), thread("b", 3), thread("c", 0)), primed = true)
        assertEquals(5, d.total)
    }

    @Test fun `empty threads yield an empty snapshot and zero total`() {
        val d = DmNotifier.diff(snapshot("ana" to 5), emptyList(), primed = true)
        assertTrue(d.toNotify.isEmpty())
        assertEquals(0, d.total)
        assertFalse("stale prior logins drop out of the fresh snapshot", d.nextSnapshot.has("ana"))
    }

    // -- lock-screen redaction (the public version shown when sensitive content
    //    is hidden). The one rule that matters: the private DM BODY must never
    //    appear in it — only the sender. --

    @Test fun `lockscreen summary names the sender but never the message body`() {
        val body = "meet me at the safehouse at midnight"
        val summary = DmNotifier.lockscreenSummary("ada")
        assertTrue("sender is shown", summary.contains("@ada"))
        assertFalse("body must never leak to the lock screen", summary.contains(body))
        assertFalse("no fragment of the body leaks", summary.contains("safehouse"))
    }

    @Test fun `lockscreen summary is body-independent — same text for any message`() {
        // It's derived from the login alone, so a body with lock-screen markup
        // or PII can't influence the redacted preview.
        assertEquals(DmNotifier.lockscreenSummary("ada"), DmNotifier.lockscreenSummary("ada"))
    }
}
