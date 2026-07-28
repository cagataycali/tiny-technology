package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * normalizeTinySlug is the single choke point that sanitizes every persona
 * switch — the /tiny command, the MRU launcher shortcut, and the BROWSABLE
 * tinyapp://tiny?name=<slug> deep link (which lets any web page hand us an
 * arbitrary name). Before it, switchTiny stored `name.trim().lowercase()`
 * verbatim, so "My Bot" became "my bot" — a persona that can never resolve, a
 * junk MRU entry, and garbage in the top bar. These pin the canonical form and
 * that pure punctuation collapses to empty (caller then ignores the switch, so
 * the current tiny can't be blanked).
 */
class NormalizeTinySlugTest {

    @Test fun `a plain lowercase name is unchanged`() {
        assertEquals("scout", normalizeTinySlug("scout"))
    }

    @Test fun `case is folded`() {
        assertEquals("scout", normalizeTinySlug("Scout"))
        assertEquals("scout", normalizeTinySlug("SCOUT"))
    }

    @Test fun `spaces and punctuation collapse to single dashes`() {
        assertEquals("my-support-bot", normalizeTinySlug("My Support Bot"))
        assertEquals("a-b-c", normalizeTinySlug("a/b/c"))
        assertEquals("hi-there", normalizeTinySlug("hi!!!   there"))
    }

    @Test fun `leading and trailing separators are trimmed`() {
        assertEquals("scout", normalizeTinySlug("  scout  "))
        assertEquals("scout", normalizeTinySlug("--scout--"))
        assertEquals("scout", normalizeTinySlug("...scout..."))
    }

    @Test fun `pure punctuation collapses to empty so switchTiny ignores it`() {
        assertEquals("", normalizeTinySlug("!!!"))
        assertEquals("", normalizeTinySlug("   "))
        assertEquals("", normalizeTinySlug("/../.."))
    }

    @Test fun `path-traversal-shaped input cannot escape the slug charset`() {
        // Even though the history filename separately sanitizes, the stored slug
        // itself must never carry separators an attacker could lean on.
        val slug = normalizeTinySlug("../../etc/passwd")
        assertEquals("etc-passwd", slug)
        assertTrue(slug.none { it == '/' || it == '.' })
    }

    @Test fun `length is capped and never ends in a dash after the cut`() {
        // A 100-char name with a separator right at the 64 boundary must not
        // leave a dangling '-'.
        val long = "a".repeat(63) + " " + "b".repeat(40)
        val slug = normalizeTinySlug(long)
        assertTrue("capped to 64", slug.length <= 64)
        assertTrue("no trailing dash", !slug.endsWith("-"))
    }

    @Test fun `digits and existing dashes survive`() {
        assertEquals("bot-2000", normalizeTinySlug("bot-2000"))
        assertEquals("priv-example-a1b2", normalizeTinySlug("priv-example-a1b2"))
    }
}
