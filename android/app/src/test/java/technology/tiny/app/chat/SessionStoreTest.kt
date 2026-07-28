package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date

/**
 * The pure decisions behind SessionStore — newest-first ordering, the auto-backup
 * retention rule, and the list subtitle — extracted to the companion so they're
 * verifiable without filesDir. These mirror the iOS SessionStore behaviors
 * (list newest-first by savedAt, pruneAutoBackups keepingNewest, "N messages"
 * subtitle) so the two surfaces treat saved sessions identically.
 */
class SessionStoreTest {

    private fun arc(
        id: String,
        savedAt: Long,
        autoBackup: Boolean = false,
        count: Int = 2,
    ) = SessionArchive(
        id = id, name = "s-$id", tiny = "tiny", savedAt = savedAt,
        messagesJson = "[]", messageCount = count, autoBackup = autoBackup,
    )

    // -- sortNewestFirst --

    @Test fun `sort puts the most recently saved first`() {
        val out = SessionStore.sortNewestFirst(
            listOf(arc("a", 100), arc("b", 300), arc("c", 200)),
        )
        assertEquals(listOf("b", "c", "a"), out.map { it.id })
    }

    @Test fun `sort is stable on equal timestamps`() {
        // Equal savedAt keeps input order — a same-millisecond batch stays deterministic.
        val out = SessionStore.sortNewestFirst(listOf(arc("x", 50), arc("y", 50), arc("z", 50)))
        assertEquals(listOf("x", "y", "z"), out.map { it.id })
    }

    @Test fun `sort of empty list is empty`() {
        assertTrue(SessionStore.sortNewestFirst(emptyList()).isEmpty())
    }

    // -- prunable (auto-backup retention) --

    @Test fun `prunable never returns a named save`() {
        val all = listOf(arc("named1", 100), arc("named2", 200), arc("auto", 300, autoBackup = true))
        // keepingNewest=1 and only one auto-backup → nothing to prune.
        assertTrue(SessionStore.prunable(all, 1).isEmpty())
    }

    @Test fun `prunable keeps the newest auto-backup and drops the older ones`() {
        val all = listOf(
            arc("old", 100, autoBackup = true),
            arc("mid", 200, autoBackup = true),
            arc("new", 300, autoBackup = true),
            arc("named", 250),
        )
        val toDelete = SessionStore.prunable(all, 1).map { it.id }
        // Newest auto (300) survives; the two older autos are pruned; named untouched.
        assertEquals(listOf("mid", "old"), toDelete)
        assertFalse(toDelete.contains("new"))
        assertFalse(toDelete.contains("named"))
    }

    @Test fun `prunable can keep more than one`() {
        val all = listOf(
            arc("a", 100, autoBackup = true),
            arc("b", 200, autoBackup = true),
            arc("c", 300, autoBackup = true),
        )
        // keepingNewest=2 → only the oldest (100) is pruned.
        assertEquals(listOf("a"), SessionStore.prunable(all, 2).map { it.id })
    }

    @Test fun `prunable with a non-positive keep count drops every auto-backup`() {
        val all = listOf(arc("a", 100, autoBackup = true), arc("b", 200, autoBackup = true))
        assertEquals(2, SessionStore.prunable(all, 0).size)
        // Negative is clamped to 0, not treated as "drop from the end".
        assertEquals(2, SessionStore.prunable(all, -5).size)
    }

    @Test fun `prunable with no auto-backups is empty`() {
        assertTrue(SessionStore.prunable(listOf(arc("a", 100), arc("b", 200)), 1).isEmpty())
    }

    // -- subtitle --

    @Test fun `subtitle pluralizes and separates with a middle dot`() {
        val s = SessionStore.subtitle(3, 0L) { "DATE" }
        assertEquals("3 messages · DATE", s)
    }

    @Test fun `subtitle uses the singular for exactly one message`() {
        assertEquals("1 message · DATE", SessionStore.subtitle(1, 0L) { "DATE" })
    }

    @Test fun `subtitle says zero messages plural`() {
        assertEquals("0 messages · DATE", SessionStore.subtitle(0, 0L) { "DATE" })
    }

    @Test fun `subtitle passes the saved instant to the formatter`() {
        var seen: Date? = null
        SessionStore.subtitle(1, 1_600_000_000_000L) { d -> seen = d; "x" }
        assertEquals(Date(1_600_000_000_000L), seen)
    }

    // -- saveFooter (iOS Sessions.swift:100 parity) --

    @Test fun `saveFooter pluralizes the message count`() {
        assertEquals(
            "Snapshots the current 5-messages conversation. The live chat stays put.",
            SessionStore.saveFooter(5),
        )
    }

    @Test fun `saveFooter uses the singular for exactly one message`() {
        assertEquals(
            "Snapshots the current 1-message conversation. The live chat stays put.",
            SessionStore.saveFooter(1),
        )
    }

    @Test fun `saveFooter says zero messages plural`() {
        assertEquals(
            "Snapshots the current 0-messages conversation. The live chat stays put.",
            SessionStore.saveFooter(0),
        )
    }

    // -- savedHeader (iOS Sessions.swift:129 parity) --

    @Test fun `savedHeader names the current tiny after a middle dot`() {
        assertEquals("Saved sessions · claude", SessionStore.savedHeader("claude"))
    }

    @Test fun `savedHeader drops the separator when the tiny is blank`() {
        assertEquals("Saved sessions", SessionStore.savedHeader(""))
        assertEquals("Saved sessions", SessionStore.savedHeader("   "))
    }

    // -- fromJson round-trip --

    @Test fun `fromJson reads the persisted fields`() {
        val o = org.json.JSONObject()
            .put("id", "abc").put("name", "My chat").put("tiny", "scout")
            .put("savedAt", 1234L).put("messageCount", 5).put("autoBackup", true)
            .put("messages", org.json.JSONArray().put(org.json.JSONObject().put("role", "user")))
        val a = SessionStore.fromJson(o)
        assertEquals("abc", a.id)
        assertEquals("My chat", a.name)
        assertEquals("scout", a.tiny)
        assertEquals(1234L, a.savedAt)
        assertEquals(5, a.messageCount)
        assertTrue(a.autoBackup)
        assertTrue("messages survive as an array string", a.messagesJson.contains("\"role\""))
    }

    @Test fun `fromJson defaults a missing messages array to empty`() {
        val a = SessionStore.fromJson(org.json.JSONObject().put("name", "n").put("tiny", "t"))
        assertEquals("[]", a.messagesJson)
        assertFalse(a.autoBackup)
    }

    @Test fun `sanitize lowercases and replaces unsafe path chars`() {
        assertEquals("my_tiny_1", SessionStore.sanitize("My/Tiny 1"))
    }
}
