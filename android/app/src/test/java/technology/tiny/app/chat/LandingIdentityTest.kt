package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Per-tiny landing identity helpers (Hero.kt): custom starter chips validation,
 * the custom tagline, and the logo media classifiers that pick VideoView vs Coil
 * (and the animated GIF decoder). Pure Kotlin — runs on the local JVM.
 */
class LandingIdentityTest {

    @Test fun `custom chips - 1-4 trimmed strings pass, violations reject whole list`() {
        // Happy path: trimmed, blanks dropped, order kept.
        assertEquals(
            listOf("Tell me a story", "Who are you?"),
            validCustomChips(listOf("  Tell me a story ", "", "Who are you?")),
        )
        // Exactly 60 chars is legal; 61 poisons the WHOLE list (never partial).
        val sixty = "x".repeat(60)
        assertEquals(listOf(sixty), validCustomChips(listOf(sixty)))
        assertNull(validCustomChips(listOf("fine", "x".repeat(61))))
        // Empty / all-blank / >4 chips / absent → null (defaults stay).
        assertNull(validCustomChips(emptyList()))
        assertNull(validCustomChips(listOf(" ", "\t")))
        assertNull(validCustomChips(listOf("a", "b", "c", "d", "e")))
        assertNull(validCustomChips(null))
        // Upper bound inclusive: exactly 4 chips are fine.
        assertEquals(4, validCustomChips(listOf("a", "b", "c", "d"))?.size)
    }

    @Test fun `validTagline - trims, strips control chars, caps at 200, else null`() {
        assertEquals(
            "Yerli ve açık kaynaklı robotik çözümler geliştiriyoruz.",
            validTagline("  Yerli ve açık kaynaklı robotik çözümler geliştiriyoruz.  "),
        )
        // Control chars (incl. NUL, unit-sep, DEL) are removed, not rejected.
        assertEquals("lineonetwo", validTagline("line\u0000one\u001Ftwo\u007F"))
        assertEquals("ab", validTagline("ab"))
        // Exactly 200 chars is legal; 201 → null (fall back to the generic line).
        val twoHundred = "x".repeat(200)
        assertEquals(twoHundred, validTagline(twoHundred))
        assertNull(validTagline("x".repeat(201)))
        // Blank / whitespace-only / null → null.
        assertNull(validTagline(""))
        assertNull(validTagline("   "))
        assertNull(validTagline(null))
    }

    @Test fun `isVideoLogo - mp4 and webm by path extension, query and case ignored`() {
        assertTrue(isVideoLogo("https://cdn.example.com/logo.mp4"))
        assertTrue(isVideoLogo("https://cdn.example.com/logo.webm"))
        assertTrue(isVideoLogo("https://cdn.example.com/LOGO.MP4?v=2#t"))
        assertFalse(isVideoLogo("https://cdn.example.com/logo.png"))
        assertFalse(isVideoLogo("https://cdn.example.com/logo.gif"))
        // Extension hidden inside the query string must NOT classify as video.
        assertFalse(isVideoLogo("https://cdn.example.com/logo.png?fake=.mp4"))
        assertFalse(isVideoLogo("https://cdn.example.com/logo")) // extensionless
    }

    @Test fun `isGifLogo - gif by path extension only`() {
        assertTrue(isGifLogo("https://cdn.example.com/logo.gif"))
        assertTrue(isGifLogo("https://cdn.example.com/LOGO.GIF?w=96"))
        assertFalse(isGifLogo("https://cdn.example.com/logo.png"))
        assertFalse(isGifLogo("https://cdn.example.com/logo.mp4"))
        assertFalse(isGifLogo("https://cdn.example.com/gif")) // no dot-extension
        assertFalse(isGifLogo("https://cdn.example.com/logo.png?as=.gif"))
    }

    @Test fun `isSvgLogo - svg by path extension, query ignored`() {
        assertTrue(isSvgLogo("https://hashtagrobotics.tr/assets/favicon.svg?v=20260718-1"))
        assertTrue(isSvgLogo("https://cdn.example.com/LOGO.SVG"))
        assertFalse(isSvgLogo("https://cdn.example.com/logo.png"))
        assertFalse(isSvgLogo("https://cdn.example.com/logo.png?as=.svg"))
        assertFalse(isSvgLogo("https://cdn.example.com/svg")) // no dot-extension
    }

    @Test fun `validIntroVibe - trims and case-folds a known pattern, else null`() {
        // The per-tiny intro haptic (/api/tiny intro_vibe) — the shared allowlist
        // contract across all 3 clients: iOS Speech.introVibe (Views.swift:434) and
        // web INTRO_VIBES (Control.tsx:19) hold the SAME 10 names, and all three
        // fold case + trim then require membership. The load-bearing rule (Hero.kt:52,
        // iOS comment): an unknown/blank/typo'd server value → null = SILENT no-op,
        // never a surprise default-tap (unlike DeviceTools.vibrate, whose unknown
        // name DOES fall back to "tap"). Pin that here so a stray server string can
        // never buzz the device on tiny-open.

        // Trim + case-fold onto the canonical lowercase name.
        assertEquals("tap", validIntroVibe("  TAP "))
        assertEquals("heartbeat", validIntroVibe("HeartBeat"))

        // The full 10-name vocabulary is accepted (iOS vibePatterns / web INTRO_VIBES).
        for (name in listOf(
            "tap", "double", "success", "warning", "error",
            "heartbeat", "sos", "long", "escalate", "wave",
        )) {
            assertEquals(name, validIntroVibe(name))
        }

        // Unknown / typo / blank / whitespace / null → null (no intro haptic).
        assertNull(validIntroVibe("buzz"))       // not in the vocabulary
        assertNull(validIntroVibe("taps"))       // near-miss typo, no fuzzy match
        assertNull(validIntroVibe(""))
        assertNull(validIntroVibe("   "))
        assertNull(validIntroVibe(null))
    }
}
