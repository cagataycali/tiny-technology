package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * prettyJson — the tool-call card's input/result formatter (web parity:
 * `JSON.stringify(x, null, 2)`, Chat.tsx:3131/3139). The contract that keeps a
 * tool card from ever rendering blank or crashing on a weird result:
 *   - a JSON object/array is re-indented with 2 spaces
 *   - anything that isn't JSON (plain string, number-ish, garbage) passes THROUGH
 *     verbatim — org.json would happily wrap a bare token, so the leading-brace
 *     guard is what preserves non-JSON results unchanged
 *   - malformed JSON (looks like an object but isn't) falls back to the raw text
 * prettyJson shipped untested; this is its first coverage.
 */
class PrettyJsonTest {

    @Test fun `a JSON object is re-indented with two spaces`() {
        val out = prettyJson("""{"a":1,"b":"x"}""")
        // org.json toString(2) puts each key on its own 2-space-indented line.
        assertTrue("expected 2-space indent, got:\n$out", out.contains("\n  \"a\""))
        assertTrue(out.contains("\"b\": \"x\""))
    }

    @Test fun `a JSON array is re-indented`() {
        val out = prettyJson("""[1,2,3]""")
        assertTrue(out.trimStart().startsWith("["))
        assertTrue(out.contains("\n  1"))
    }

    @Test fun `surrounding whitespace does not stop object detection`() {
        val out = prettyJson("  \n {\"k\":true}\t")
        assertTrue(out.contains("\"k\": true"))
    }

    @Test fun `a plain non-JSON string passes through verbatim`() {
        // The crux: a bare word must NOT be swallowed/wrapped by org.json — the
        // leading-brace/bracket guard returns it as-is so the card shows the text.
        assertEquals("just a plain result", prettyJson("just a plain result"))
        assertEquals("", prettyJson(""))
    }

    @Test fun `a bare number or token is left untouched, not JSON-coerced`() {
        // "42" IS valid JSON to a permissive parser, but our guard only reformats
        // objects/arrays, so scalars stay exactly as the tool emitted them.
        assertEquals("42", prettyJson("42"))
        assertEquals("true", prettyJson("true"))
    }

    @Test fun `malformed object-looking text falls back to the raw string`() {
        val bad = """{"a": unclosed"""
        assertEquals(bad, prettyJson(bad))
    }
}
