package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Attachments.blocks builds the Converse content-block array that rides a chat
 * send (server lib/file-attachments.ts parity). It's pure given the already-
 * encoded base64 strings (no Context), and now runs on the local JVM since the
 * real org.json is on the test classpath (cycle 117). Guards the block ordering,
 * the blank-text default, the image cap, and the exact image/document JSON shapes
 * the server expects.
 */
class AttachmentsBlocksTest {

    @Test fun `blank text falls back to the have-a-look default`() {
        val arr = Attachments.blocks("", emptyList())
        assertEquals(1, arr.length())
        assertEquals("Have a look.", arr.getJSONObject(0).getString("text"))
        // Whitespace-only counts as blank too.
        assertEquals("Have a look.", Attachments.blocks("   ", emptyList()).getJSONObject(0).getString("text"))
    }

    @Test fun `the text block is always first and carries the message`() {
        val arr = Attachments.blocks("look at this", listOf("AAAA"))
        assertEquals("look at this", arr.getJSONObject(0).getString("text"))
    }

    @Test fun `an image block has the exact jpeg source shape`() {
        val arr = Attachments.blocks("hi", listOf("BASE64IMG"))
        val img = arr.getJSONObject(1).getJSONObject("image")
        assertEquals("jpeg", img.getString("format"))
        assertEquals("BASE64IMG", img.getJSONObject("source").getString("bytes"))
    }

    @Test fun `images are capped at MAX`() {
        // MAX = 4: a 5th image is dropped. 1 text block + 4 image blocks = 5.
        val six = (1..6).map { "img$it" }
        val arr = Attachments.blocks("hi", six)
        assertEquals(1 + Attachments.MAX, arr.length())
        assertEquals(4, Attachments.MAX)
    }

    @Test fun `a document block has name, format and byte source`() {
        val arr = Attachments.blocks("read this", emptyList(), listOf(PendingDoc("report.pdf", "pdf", "DOCB64")))
        val doc = arr.getJSONObject(1).getJSONObject("document")
        assertEquals("report.pdf", doc.getString("name"))
        assertEquals("pdf", doc.getString("format"))
        assertEquals("DOCB64", doc.getJSONObject("source").getString("bytes"))
    }

    @Test fun `blocks are ordered text then images then documents`() {
        val arr = Attachments.blocks(
            "everything",
            listOf("imgA", "imgB"),
            listOf(PendingDoc("a.csv", "csv", "csvB64")),
        )
        assertEquals(4, arr.length())
        assertTrue(arr.getJSONObject(0).has("text"))
        assertTrue(arr.getJSONObject(1).has("image"))
        assertTrue(arr.getJSONObject(2).has("image"))
        assertTrue(arr.getJSONObject(3).has("document"))
    }

    @Test fun `text-only send is a single text block`() {
        val arr = Attachments.blocks("just words", emptyList(), emptyList())
        assertEquals(1, arr.length())
        assertTrue(arr.getJSONObject(0).has("text"))
    }
}
