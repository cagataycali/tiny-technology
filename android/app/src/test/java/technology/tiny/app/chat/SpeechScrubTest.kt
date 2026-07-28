package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Speech.scrub is the pure markdown→speakable-text pass TTS runs before it speaks
 * (companion fn, kotlin Regex only — no android.* or org.json, so it runs on the
 * local JVM). It must agree with web (voice.ts / tts.ts) and iOS (Speech.swift):
 * fenced code is announced, not read; inline noise is unwrapped; markdown-noise
 * chars collapse to a SINGLE space (never "", which would jam word boundaries);
 * output is trimmed and capped at 3000 chars.
 */
class SpeechScrubTest {

    @Test fun `fenced code blocks are announced, not read aloud`() {
        val out = Speech.scrub("before\n```kotlin\nval x = 1\n```\nafter")
        assertTrue("fence replaced with the spoken placeholder", out.contains("code block omitted"))
        assertFalse("the code body is not spoken", out.contains("val x = 1"))
    }

    @Test fun `inline code backticks are unwrapped to their contents`() {
        assertEquals("run the build command", Speech.scrub("run the `build` command"))
    }

    @Test fun `links and images keep the label, drop the url`() {
        assertEquals("see the docs", Speech.scrub("see the [docs](https://tiny.technology/x)"))
        // Image syntax (leading !) keeps the alt text, not the url.
        assertEquals("a diagram", Speech.scrub("![a diagram](https://x/y.png)"))
    }

    @Test fun `markdown-noise chars become a single space, never empty`() {
        // The critical parity guard: a table row or emphasis must NOT jam together.
        // "cell1|cell2" → "cell1 cell2", "word*emphasis*" → "word emphasis".
        assertEquals("cell1 cell2", Speech.scrub("cell1|cell2"))
        assertEquals("word emphasis", Speech.scrub("word *emphasis*"))
        assertEquals("Heading body", Speech.scrub("# Heading\nbody").replace("\n", " "))
    }

    @Test fun `whitespace runs collapse and the result is trimmed`() {
        assertEquals("a b c", Speech.scrub("   a    b\t\tc   "))
    }

    @Test fun `output is capped at 3000 chars`() {
        val long = "a".repeat(5000)
        assertEquals(3000, Speech.scrub(long).length)
    }

    @Test fun `plain text passes through unchanged`() {
        assertEquals("Hello there, how are you?", Speech.scrub("Hello there, how are you?"))
    }
}
