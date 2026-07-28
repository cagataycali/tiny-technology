package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

/**
 * Pure /export markdown assembly (web Chat.tsx export VERBATIM — the documented
 * cross-platform contract). iOS uses a DIFFERENT export shape, so web is the parity
 * target here. The header date + filename are UTC (web toISOString), the speaker
 * labels are "you"/"<tiny>", messages join by "\n\n---\n\n", non-system only. Pure
 * Kotlin, runs on the local JVM (the file write + share sheet are exercised on-device).
 */
class SharingTest {

    private fun msg(role: String, text: String) = ChatMessage(role = role, text = text)

    @Test fun `header, body and speaker labels match the web format`() {
        val md = Sharing.exportMarkdown(
            "sage",
            listOf(msg("user", "hi"), msg("assistant", "hello there")),
        )
        // Body sanity independent of today's date:
        assertTrue(md.startsWith("# Conversation with sage\n\n> tiny.technology/sage · exported "))
        assertTrue(md.contains("\n\n**you**: hi\n\n---\n\n**sage**: hello there\n"))
        assertTrue("trailing newline", md.endsWith("\n"))
    }

    @Test fun `messages join with the horizontal-rule separator`() {
        val md = Sharing.exportMarkdown("t", listOf(msg("user", "a"), msg("user", "b"), msg("user", "c")))
        val body = md.substringAfter("\n\n", "").substringAfter("\n\n") // past header + blank line
        assertTrue(body.contains("**you**: a\n\n---\n\n**you**: b\n\n---\n\n**you**: c"))
    }

    @Test fun `system messages are excluded, blank non-system bubbles are KEPT (web filter parity)`() {
        // Web filters only role !== "system"; a blank-text user/assistant bubble stays.
        val md = Sharing.exportMarkdown(
            "t",
            listOf(msg("system", "you are..."), msg("user", ""), msg("assistant", "hi")),
        )
        assertTrue("no system line", !md.contains("you are..."))
        assertTrue("blank user bubble kept", md.contains("**you**: \n\n---\n\n**t**: hi"))
    }

    @Test fun `the header date is UTC, not device-local (web toISOString parity)`() {
        // Pin a UTC+14 zone: near a date boundary a device-local formatter would drift
        // a day off web. We assert the exported date equals what UTC yields right now.
        val saved = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Kiritimati")) // UTC+14
            val utcToday = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(java.util.Date())
            val md = Sharing.exportMarkdown("t", listOf(msg("user", "x")))
            assertTrue("header carries the UTC date", md.contains("· exported $utcToday\n\n"))
        } finally {
            TimeZone.setDefault(saved)
        }
    }

    @Test fun `filename mirrors web with the UTC date`() {
        val name = Sharing.exportFilename("sage")
        assertTrue(name.startsWith("sage-conversation-"))
        assertTrue(name.endsWith(".md"))
        val utcToday = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(java.util.Date())
        assertEquals("sage-conversation-$utcToday.md", name)
    }
}
