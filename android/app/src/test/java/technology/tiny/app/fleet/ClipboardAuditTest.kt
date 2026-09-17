package technology.tiny.app.fleet

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the model is TOLD about a clipboard write, on both surfaces that report one.
 *
 * ⚠️ These two functions exist because `DeviceTools.Outcome` cannot carry this
 * fact: the `copy_to_clipboard` arm executes whether or not the write was
 * allowed, so it returns RAN either way — and RAN renders as "ran on the phone".
 * A refused write was therefore reported to the proxied web agent as a
 * successful copy, and spoken aloud as one on the live-voice rail.
 *
 * The pattern is `open_url`'s, in the same file: re-run the PURE decision the
 * write made, and report that. Not a second copy of the rule — the same
 * function, so what is audited cannot drift from what happened.
 */
class ClipboardAuditTest {

    // -- the relay audit line the web agent reads as ground truth --

    @Test
    fun `a refused write is never audited as a copy`() {
        for (raw in listOf<Any?>(null, JSONObject.NULL, "", "   ", 42, JSONObject("""{"a":1}"""))) {
            val line = DeviceActionAudit.clipboardLine(raw)
            assertTrue("$raw was audited as a successful copy: $line", line.contains("NOT copied"))
            // ⚠️ The exact regression shape: the phrase the audit prints for RAN.
            // If this ever appears for a refusal, the web agent tells the user
            // their text is ready to paste when it is not.
            assertFalse("$raw still claims it ran on the phone", line.contains("ran on the phone"))
        }
    }

    @Test
    fun `the refusal keeps its own words instead of a generic line`() {
        // The refusal already says what was wrong AND that the clipboard is
        // intact — the second half is what the model needs before it says
        // anything to the user. A re-wording here would drop it.
        val blank = DeviceActionAudit.clipboardLine("  ")
        assertTrue("the destructive-write reason was reworded away", blank.contains("ERASED"))
        val typed = DeviceActionAudit.clipboardLine(7)
        assertTrue("the type reason was reworded away", typed.contains("must be a string"))
        assertTrue("the user's clipboard is no longer said to be intact",
            typed.contains("still holds what the user had"))
        // Prefixed once, not twice: "NOT copied — refused: …" is the stutter this
        // strips, and it is the line a person may end up reading.
        assertFalse("the line stutters", blank.contains("refused:"))
    }

    @Test
    fun `an allowed write is audited as copied, and truncation is reported`() {
        val ok = DeviceActionAudit.clipboardLine("hello")
        assertEquals("copy_to_clipboard: copied to the user's clipboard", ok)

        val long = DeviceActionAudit.clipboardLine("x".repeat(technology.tiny.app.tools.CLIPBOARD_MAX + 1))
        assertTrue("a truncated copy was audited as a whole one", long.contains("truncated"))
        assertFalse("a truncated copy is not a refusal", long.contains("NOT copied"))
    }

    // -- the live-voice tool result the tiny SPEAKS --

    @Test
    fun `a refused write is an ok false result, unlike a quiet-hours mute`() {
        // ⚠️ The distinction: quiet hours is the phone obeying the user, so it is
        // ok:true with a note. A clipboard write that never happened is the
        // model's request UNMET — `ok:true` is how a tiny comes to say, in
        // speech, that the text is ready to paste.
        val r = DeviceActionAudit.clipboardResult(JSONObject.NULL)
        assertFalse("a refused write came back as success", r.optBoolean("ok"))
        assertTrue("the model gets no reason", r.optString("error").contains("nothing was copied"))
        assertFalse("a refusal carries a success note", r.has("note"))
    }

    @Test
    fun `an allowed write is ok true with the note the model needs`() {
        val r = DeviceActionAudit.clipboardResult("wallet address")
        assertTrue(r.optBoolean("ok"))
        assertEquals("copied to the user's clipboard", r.optString("note"))
        assertFalse("a success carries an error", r.has("error"))

        val t = DeviceActionAudit.clipboardResult("x".repeat(technology.tiny.app.tools.CLIPBOARD_MAX + 9))
        assertTrue("a truncated write is still a write", t.optBoolean("ok"))
        assertTrue("spoken as a whole copy", t.optString("note").contains("was not copied"))
    }

    @Test
    fun `both surfaces agree on every input, because they share one decision`() {
        // The two readers must never be told different stories about the same
        // action: the same raw arg has to be a refusal on both rails or a
        // success on both. Divergence here is the drift the shared decision
        // exists to prevent.
        for (raw in listOf<Any?>(null, JSONObject.NULL, "", " \n ", 0, false, "ok", "x".repeat(20_000))) {
            val refusedInAudit = DeviceActionAudit.clipboardLine(raw).contains("NOT copied")
            val refusedInVoice = !DeviceActionAudit.clipboardResult(raw).optBoolean("ok")
            assertEquals("audit and voice disagree about $raw", refusedInAudit, refusedInVoice)
        }
    }
}
