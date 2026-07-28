package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * validHeroUrl guards the per-tiny hero banner URL against anything that isn't a
 * clean https image URL (web Chat.tsx:2378/:2382 regex `^https://[^\s"'\\<>]+$`,
 * iOS Views.swift:400). Pure Kotlin — runs on the local JVM.
 */
class HeroTest {

    @Test fun `plain https url passes through unchanged`() {
        val url = "https://example.com/banner.png"
        assertEquals(url, validHeroUrl(url))
        // Query strings and encoded chars are fine — the regex only bans a few.
        assertEquals(
            "https://cdn.example.com/img/a%20b.jpg?w=1500&h=500",
            validHeroUrl("https://cdn.example.com/img/a%20b.jpg?w=1500&h=500"),
        )
    }

    @Test fun `http is rejected — https only`() {
        assertNull(validHeroUrl("http://example.com/banner.png"))
        assertNull(validHeroUrl("ftp://example.com/banner.png"))
        assertNull(validHeroUrl("javascript:alert(1)"))
    }

    @Test fun `whitespace quotes backslash and angle brackets are rejected`() {
        assertNull(validHeroUrl("https://example.com/a b.png")) // space
        assertNull(validHeroUrl("https://example.com/a\"b.png")) // double quote
        assertNull(validHeroUrl("https://example.com/a'b.png")) // single quote
        assertNull(validHeroUrl("https://example.com/a\\b.png")) // backslash
        assertNull(validHeroUrl("https://example.com/<img>.png")) // angle brackets
        assertNull(validHeroUrl("https://example.com/a\nb.png")) // newline
    }

    @Test fun `missing or blank means no banner`() {
        assertNull(validHeroUrl(null))
        assertNull(validHeroUrl("")) // JSONObject.optString default for absent key
        assertNull(validHeroUrl("https://")) // scheme alone — nothing after it
    }
}
