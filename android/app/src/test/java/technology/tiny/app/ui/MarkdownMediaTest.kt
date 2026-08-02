package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Chat media splitting — `isolateMediaLines` + `mediaLineMatch` + `imageLineMatch`.
 *
 * This is the logic that broke in the user's hands: the agent butts an image
 * against prose (`…jpg)Anything else?`) and replies with bare .wav/.gif links,
 * and the whole-line-only branches rendered them as literal markdown text.
 * isolateMediaLines gives every embedded/bare media URL its own line so the
 * player branches fire. It shipped untested; this pins it (and mirrors iOS
 * ChatMedia.extract, the twin that must classify the same URLs the same way).
 */
class MarkdownMediaTest {

    // ── isolateMediaLines: the fix for "media rendered as raw text" ──────────

    @Test
    fun `image butted against prose gets its own line`() {
        val out = isolateMediaLines(
            "Got it 📸 — ![necklace photo](https://plugin.tiny.technology/media/a1.jpg)Anything else?"
        )
        val lines = out.lines().map { it.trim() }.filter { it.isNotEmpty() }
        assertEquals("Got it 📸 —", lines[0])
        assertEquals("![necklace photo](https://plugin.tiny.technology/media/a1.jpg)", lines[1])
        assertEquals("Anything else?", lines[2])
        // and the isolated line is now matchable by the image branch
        assertEquals(
            "https://plugin.tiny.technology/media/a1.jpg",
            imageLineMatch(lines[1])?.second,
        )
    }

    @Test
    fun `bare media links land on their own line and classify`() {
        val out = isolateMediaLines(
            "Here's the clip https://plugin.tiny.technology/media/b2.wav have a listen"
        )
        val line = out.lines().map { it.trim() }.first { it.startsWith("http") }
        assertEquals("https://plugin.tiny.technology/media/b2.wav" to "audio", mediaLineMatch(line))
    }

    @Test
    fun `several media items in one message each get isolated`() {
        val out = isolateMediaLines(
            "photo ![p](https://x.test/1.jpg) then clip https://x.test/2.gif and audio https://x.test/3.wav"
        )
        val media = out.lines().map { it.trim() }.filter { it.startsWith("http") || it.startsWith("![") }
        assertEquals(3, media.size)
        assertEquals("image", mediaLineMatch(media[1])?.second)   // gif → animated image
        assertEquals("audio", mediaLineMatch(media[2])?.second)
        // DOCUMENT ORDER, not per-regex order. iOS's twin ran the image pass and
        // the bare-link pass as two appends and shipped ["2.gif","3.wav","1.jpg"];
        // isolating in place can't drift like that, so pin it here too.
        assertEquals(
            listOf("1.jpg", "2.gif", "3.wav"),
            media.map { it.substringAfterLast('/').removeSuffix(")") },
        )
    }

    @Test
    fun `markdown image URL is not double-isolated as a bare link`() {
        // BARE_MEDIA_URL's lookbehind must skip the URL inside `](...)`, or a
        // gif image tag would be split mid-markup and render as broken text.
        val out = isolateMediaLines("![clip](https://x.test/c.gif)")
        val kept = out.lines().map { it.trim() }.filter { it.isNotEmpty() }
        assertEquals(listOf("![clip](https://x.test/c.gif)"), kept)
    }

    @Test
    fun `prose without media is untouched`() {
        val text = "Just a sentence about a gif, no links here."
        assertEquals(text, isolateMediaLines(text))
    }

    // ── classification: mediaLineMatch's kind vocabulary ────────────────────

    @Test
    fun `audio video and image extensions classify distinctly`() {
        assertEquals("audio", mediaLineMatch("https://x.test/a.wav")?.second)
        assertEquals("audio", mediaLineMatch("https://x.test/a.mp3")?.second)
        assertEquals("audio", mediaLineMatch("https://x.test/a.m4a")?.second)
        assertEquals("video", mediaLineMatch("https://x.test/a.mp4")?.second)
        assertEquals("video", mediaLineMatch("https://x.test/a.mov")?.second)
        assertEquals("image", mediaLineMatch("https://x.test/a.gif")?.second)
    }

    @Test
    fun `non-media links are left to the normal link renderer`() {
        assertNull(mediaLineMatch("https://tiny.technology/about"))
        assertNull(mediaLineMatch("https://x.test/photo.jpg"))   // jpg → image branch, not media-line
    }

    @Test
    fun `extension matching is case-insensitive`() {
        assertEquals("audio", mediaLineMatch("https://x.test/A.WAV")?.second)
        assertTrue(isolateMediaLines("see https://x.test/A.GIF now").contains("\nhttps://x.test/A.GIF\n"))
    }

    // ── linked images (the [![alt](img)](href) form) ─────────────────────────

    @Test
    fun `linked image keeps both the image and its destination`() {
        val m = imageLineMatch("[![thumb](https://x.test/t.jpg)](https://x.test/full.jpg)")
        assertEquals("thumb", m?.first)
        assertEquals("https://x.test/t.jpg", m?.second)
        assertEquals("https://x.test/full.jpg", m?.third)
    }

    // ── code fences: isolateMediaLines runs BEFORE splitFences ───────────────

    @Test
    fun `media URL inside a code fence survives as code`() {
        val src = "Run this:\n```bash\ncurl -o out.gif https://x.test/clip.gif\n```\ndone"
        // MarkdownText's real order: fences out first, media isolation on prose only.
        val segs = splitFences(src)
        val code = segs.filter { it.isCode }
        assertEquals(1, code.size)
        // The command must stay one runnable line — isolateMediaLines must not
        // have split the URL out of it.
        assertTrue("code was mangled: ${code[0].text}",
            code[0].text.contains("curl -o out.gif https://x.test/clip.gif"))
    }

    @Test
    fun `media URL in an inline code span keeps no newline`() {
        // A URL the user is meant to copy must stay intact inside backticks.
        val out = isolateMediaLines("run `curl https://x.test/clip.gif` then play it")
        assertTrue("newline injected into code span: $out",
            out.contains("`curl https://x.test/clip.gif`"))
    }

    @Test
    fun `media outside backticks still isolates when a code span is present`() {
        val out = isolateMediaLines("use `--flag` then see https://x.test/c.wav ok")
        assertTrue(out.contains("\nhttps://x.test/c.wav\n"))
        assertTrue(out.contains("`--flag`"))
    }
}
