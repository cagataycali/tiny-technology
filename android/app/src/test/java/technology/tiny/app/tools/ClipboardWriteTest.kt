package technology.tiny.app.tools

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `copy_to_clipboard` — the widest sink this app hands the agent.
 *
 * The clipboard is the only one whose value the user then pastes into ANOTHER
 * program, so a wrong value here is spent somewhere this code will never see.
 * Web enforces four rules (`lib/chat/clipboard-write.ts`); Android enforced
 * none, and `org.json` made two of them WORSE here than on the web:
 *
 *  1. a blank/absent `text` wrote nothing and was audited as "ran on the phone";
 *  2. non-Strings were COERCED by `optString` (`Object.toString()`, measured in
 *     the shipping `json-20240303.jar` bytecode, not assumed) — so `{"a":1}`
 *     landed on the clipboard literally;
 *  3. the `.max(10_000)` cap the model is told about was never applied;
 *  4. the user was told nothing at all.
 *
 * ⚠️ These run on the JVM, where `org.json` is the REAL jar (`testImplementation
 * libs.json`) — `android.jar`'s copy is stubs that throw. That matters for the
 * `JSONObject.NULL` case: it is a real object whose `toString()` is "null", so a
 * naive read puts the four characters `null` on the clipboard. The test would be
 * vacuous against a stub.
 */
class ClipboardWriteTest {

    // -- the destructive case, and the reason this exists --

    @Test
    fun `a blank text is refused, not written, because writing it would erase`() {
        for (blank in listOf("", " ", "\n", "\t  \n ")) {
            val d = decideClipboardWrite(blank)
            assertTrue("blank ${blank.length}-char text was allowed through", d is ClipboardWrite.Refused)
            // The refusal is FOR THE MODEL: it has to say the clipboard survived,
            // or the agent reports a failure the user reads as data loss.
            assertTrue(
                "the refusal doesn't say the write was destructive",
                (d as ClipboardWrite.Refused).error.contains("ERASED"),
            )
        }
    }

    @Test
    fun `an absent key is refused and says the clipboard is intact`() {
        // The exact shape from the wire: {} with no "text" at all. This is what
        // `optString` turned into "" — the empty write that erased.
        val d = decideClipboardWrite(JSONObject().opt("text"))
        assertTrue(d is ClipboardWrite.Refused)
        val error = (d as ClipboardWrite.Refused).error
        assertTrue("no mention of what the user still has", error.contains("still holds what the user had"))
        assertTrue("the refusal doesn't say nothing was copied", error.contains("nothing was copied"))
    }

    @Test
    fun `JSONObject NULL is refused rather than copying the word null`() {
        // ⚠️ `{"text": null}` parses to JSONObject.NULL, NOT Kotlin null, and its
        // toString() is the string "null" — so a coercing read puts four
        // characters on the user's clipboard and calls it a copy.
        val d = decideClipboardWrite(JSONObject("""{"text":null}""").opt("text"))
        assertTrue("JSON null reached the clipboard", d is ClipboardWrite.Refused)
        assertEquals(
            "refused: no text was given — nothing was copied, the clipboard still holds what the user had",
            (d as ClipboardWrite.Refused).error,
        )
    }

    // -- the coercion `optString` performed --

    @Test
    fun `non-strings are refused, not stringified`() {
        val args = JSONObject("""{"o":{"a":1},"n":42,"b":true,"arr":["a","b"]}""")
        for (key in listOf("o", "n", "b", "arr")) {
            val raw = args.opt(key)
            val d = decideClipboardWrite(raw)
            assertTrue("$key was coerced onto the clipboard as \"$raw\"", d is ClipboardWrite.Refused)
            assertTrue(
                "the refusal doesn't name the type problem",
                (d as ClipboardWrite.Refused).error.contains("must be a string"),
            )
        }
        // And the fact this test defends against, stated: the OLD read really
        // did coerce. If org.json ever stops doing this the comment above is
        // stale, and this assertion is what says so.
        assertEquals("{\"a\":1}", args.optString("o"))
        assertEquals("42", args.optString("n"))
    }

    // -- the cap that was only ever described to the model --

    @Test
    fun `over-long text is truncated to the cap and the model is told`() {
        val d = decideClipboardWrite("x".repeat(CLIPBOARD_MAX + 500))
        assertTrue(d is ClipboardWrite.Allowed)
        val allowed = d as ClipboardWrite.Allowed
        assertEquals(CLIPBOARD_MAX, allowed.text.length)
        assertTrue("a truncated write didn't report itself", allowed.truncated)
        // The note has to say the rest did NOT land, or the agent goes on to
        // describe the whole string as copied.
        assertTrue(allowed.note.contains("truncated"))
        assertTrue(allowed.note.contains("was not copied"))
    }

    @Test
    fun `text exactly at the cap is not truncated`() {
        // The boundary: `>` not `>=`, so a string of exactly CLIPBOARD_MAX is
        // whole. An off-by-one here silently shortens a legitimate paste.
        val d = decideClipboardWrite("x".repeat(CLIPBOARD_MAX)) as ClipboardWrite.Allowed
        assertEquals(CLIPBOARD_MAX, d.text.length)
        assertFalse(d.truncated)
        assertEquals("copied to the user's clipboard", d.note)
    }

    // -- what IS allowed, and what must survive intact --

    @Test
    fun `accepted text is passed through byte for byte, whitespace included`() {
        // ⚠️ NOT trimmed. Leading/trailing whitespace is meaningful in the things
        // people copy — an indented code block, the trailing newline before a
        // paste into a terminal. Trimming is only how BLANKNESS is detected.
        val text = "  fun main() {\n    println(\"hi\")\n}\n"
        val d = decideClipboardWrite(text) as ClipboardWrite.Allowed
        assertEquals(text, d.text)
        assertFalse(d.truncated)
    }

    // -- rule 4: the confirmation the user actually sees --

    @Test
    fun `the toast quotes what landed, because the risk is substitution`() {
        val toast = clipboardConfirmToast("0xdeadbeefcafe", truncated = false)
        // "Copied!" cannot surface a swapped wallet address; the value can.
        assertTrue("the toast doesn't show the value", toast.contains("0xdeadbeefcafe"))
        assertTrue(toast.startsWith("📋 Copied"))
        assertFalse("an untruncated write claims it was trimmed", toast.contains("trimmed"))
    }

    @Test
    fun `a truncated toast says so, with a number a person can read`() {
        val toast = clipboardConfirmToast("x".repeat(CLIPBOARD_MAX), truncated = true)
        assertTrue(toast.contains("trimmed to"))
        // Grouped thousands (web's toLocaleString parity): "10000 characters"
        // reads as machine output in a sentence meant for a person.
        assertTrue("the cap isn't grouped — reads as machine output", toast.contains("10,000"))
    }

    @Test
    fun `the preview is one line and bounded`() {
        // A toast is one line: a multi-line preview either clips mid-height or
        // shoves the rest of the UI around.
        assertEquals("a b c", clipboardPreview("a\nb\t\tc"))
        val long = clipboardPreview("y".repeat(200))
        assertEquals(49, long.length) // 48 + the ellipsis
        assertTrue("truncation isn't marked — \"…\" is how a user tells it from a short string", long.endsWith("…"))
        // A short string is untouched, ellipsis included: the mark must MEAN
        // something.
        assertEquals("short", clipboardPreview("short"))
    }
}
