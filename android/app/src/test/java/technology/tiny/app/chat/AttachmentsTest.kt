package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure document format-resolution + name-sanitize (server lib/file-attachments.ts
 * parity) — the format tag and the `name` field sent to Anthropic in a document
 * content block. Both must match the web byte-for-byte (the server derives the same
 * values), so a drift here changes what the model receives. Pure Kotlin, runs on the
 * local JVM (the base64 encode + content-resolver query are exercised on-device).
 */
class AttachmentsTest {

    // ---- formatFor (MIME map first, extension fallback — getDocumentFormat) ----

    @Test fun `known mime resolves regardless of the name`() {
        assertEquals("pdf", Attachments.formatFor("application/pdf", "whatever"))
        assertEquals("xlsx", Attachments.formatFor(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", null))
    }

    @Test fun `mime wins over a conflicting extension`() {
        // A .txt name but a csv mime → the mime map is consulted first.
        assertEquals("csv", Attachments.formatFor("text/csv", "data.txt"))
    }

    @Test fun `unknown mime falls back to the extension (case-insensitive)`() {
        // A .PDF mislabeled as octet-stream still resolves by extension.
        assertEquals("pdf", Attachments.formatFor("application/octet-stream", "report.PDF"))
        assertEquals("md", Attachments.formatFor(null, "NOTES.markdown")) // markdown alias
        assertEquals("html", Attachments.formatFor(null, "page.htm"))     // htm alias
    }

    @Test fun `no mime and an unsupported extension is unsupported`() {
        assertNull(Attachments.formatFor(null, "clip.mp4"))
        assertNull(Attachments.formatFor("audio/mpeg", "song.mp3"))
        assertNull(Attachments.formatFor(null, "noextension"))
    }

    // ---- sanitizeName (server buildContentBlocks name rule) --------------------

    @Test fun `strips the extension and keeps a clean base`() {
        assertEquals("report", Attachments.sanitizeName("report.pdf"))
    }

    @Test fun `strips only the LAST extension, interior dots become underscores`() {
        // web replace(/\.[^.]+$/) strips ".pdf"; the remaining "." is non-safe → "_".
        assertEquals("my_file", Attachments.sanitizeName("my.file.pdf"))
    }

    @Test fun `a trailing dot is NOT an extension (web-regex parity)`() {
        // THE divergence this fixes: \.[^.]+$ needs a non-dot after the dot, so
        // "archive." keeps the dot, which then sanitizes to "_" → "archive_"
        // (the old substringBeforeLast produced "archive").
        assertEquals("archive_", Attachments.sanitizeName("archive."))
    }

    @Test fun `unsafe characters become underscores, safe punctuation kept`() {
        assertEquals("a_b c-(1)[2]", Attachments.sanitizeName("a/b c-(1)[2].csv"))
    }

    @Test fun `a leading-dot dotfile sanitizes to the fallback`() {
        // ".gitignore" is treated as all-extension → base "" → fallback.
        assertEquals("document", Attachments.sanitizeName(".gitignore"))
    }

    @Test fun `null and blank fall back to document`() {
        assertEquals("document", Attachments.sanitizeName(null))
        assertEquals("document", Attachments.sanitizeName(""))
    }

    @Test fun `caps at 200 characters`() {
        val long = "x".repeat(250) + ".txt"
        assertEquals(200, Attachments.sanitizeName(long).length)
    }
}
