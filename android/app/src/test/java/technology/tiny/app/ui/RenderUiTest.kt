package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The PURE render_ui classifier behind RenderUiCard — iOS parseRenderUi parity.
 * Guards the two blank-card regressions this replaced: a top-level JSON array
 * (rendered NOTHING) and a scalar dict (dumped raw JSON instead of key/value
 * rows). Pure Kotlin + org.json — runs on the local JVM, no Compose.
 */
class RenderUiTest {

    @Test fun `top-level array of objects becomes a chart candidate (was a blank card)`() {
        val c = classifyRenderUi("""[{"month":"Jan","sales":5},{"month":"Feb","sales":8}]""")
        assertTrue("expected Chart, got $c", c is RenderContent.Chart)
        assertEquals(2, (c as RenderContent.Chart).entries.size)
    }

    @Test fun `top-level array of strings becomes a bulleted list`() {
        val c = classifyRenderUi("""["alpha","beta","gamma"]""")
        assertTrue(c is RenderContent.StringList)
        assertEquals(listOf("alpha", "beta", "gamma"), (c as RenderContent.StringList).items)
    }

    @Test fun `scalar dict becomes sorted key-value rows, not raw JSON`() {
        val c = classifyRenderUi("""{"temp":20,"humidity":60,"city":"Berlin"}""")
        assertTrue(c is RenderContent.KeyValues)
        // sorted by key: city, humidity, temp
        assertEquals(
            listOf("city" to "Berlin", "humidity" to "60", "temp" to "20"),
            (c as RenderContent.KeyValues).pairs,
        )
    }

    @Test fun `array-of-rows under a non-data key is still charted`() {
        val c = classifyRenderUi("""{"results":[{"x":"a","y":1},{"x":"b","y":2}]}""")
        assertTrue("expected Chart, got $c", c is RenderContent.Chart)
        assertEquals(2, (c as RenderContent.Chart).entries.size)
    }

    @Test fun `explicit shapes win over chartable values`() {
        // markdown present → Md even though a chartable array also exists
        val c = classifyRenderUi("""{"markdown":"# hi","data":[{"a":"x","b":1},{"a":"y","b":2}]}""")
        assertTrue(c is RenderContent.Md)
        assertEquals("# hi", (c as RenderContent.Md).text)
    }

    @Test fun `text field maps to markdown`() {
        val c = classifyRenderUi("""{"text":"plain words"}""")
        assertTrue(c is RenderContent.Md)
        assertEquals("plain words", (c as RenderContent.Md).text)
    }

    @Test fun `data key preferred over other chartable values`() {
        val c = classifyRenderUi("""{"data":[{"k":"a","v":1},{"k":"b","v":2}]}""")
        assertTrue(c is RenderContent.Chart)
    }

    @Test fun `chart candidate advances past a non-charting array to the one that charts`() {
        // {a:[{x:"one"}], b:[{m,v},{m,v}]} — `a` is array-of-objects but can't chart
        // (1 row, no numeric column); `b` can. iOS returns .chart for the first
        // candidate whose chartPoints succeeds, so Android must chart `b`, not commit
        // to `a` and render its degenerate rows. Guards the c296 candidate-advance.
        val c = classifyRenderUi("""{"a":[{"x":"one"}],"b":[{"m":"jan","v":1},{"m":"feb","v":2}]}""")
        assertTrue("expected Chart, got $c", c is RenderContent.Chart)
        assertEquals(2, (c as RenderContent.Chart).entries.size) // charted `b`, not `a`
    }

    @Test fun `when no candidate charts the first array-of-objects is still a Chart for row fallback`() {
        // Neither array charts (each 1 row / no numeric column). iOS drops both and
        // lands on .empty; Android keeps the first as a Chart so DataRows renders it
        // as label/value rows — the fallback iOS lacks. Guards that fallback survives.
        val c = classifyRenderUi("""{"a":[{"label":"x","value":"hi"}],"b":[{"label":"y","value":"lo"}]}""")
        assertTrue("expected Chart, got $c", c is RenderContent.Chart)
        assertEquals(1, (c as RenderContent.Chart).entries.size)
    }

    @Test fun `flat columns and rows is a table`() {
        val c = classifyRenderUi("""{"columns":["a","b"],"rows":[["1","2"]]}""")
        assertTrue(c is RenderContent.Table)
    }

    @Test fun `nested table columns and rows is a table (iOS parseTable form)`() {
        val c = classifyRenderUi("""{"table":{"columns":["a","b"],"rows":[["1","2"]]}}""")
        assertTrue("expected Table, got $c", c is RenderContent.Table)
    }

    @Test fun `items array maps to Items`() {
        val c = classifyRenderUi("""{"items":[{"label":"one"},{"label":"two"}]}""")
        assertTrue(c is RenderContent.Items)
    }

    @Test fun `empty object is Empty, not a blank surface`() {
        assertEquals(RenderContent.Empty, classifyRenderUi("""{}"""))
    }

    @Test fun `non-JSON text is shown raw rather than dropped`() {
        val c = classifyRenderUi("just a plain sentence")
        assertTrue(c is RenderContent.Raw)
        assertEquals("just a plain sentence", (c as RenderContent.Raw).text)
    }

    @Test fun `blank input is Empty`() {
        assertEquals(RenderContent.Empty, classifyRenderUi("   "))
    }

    @Test fun `nested objects and arrays are skipped in the key-value fallback`() {
        // Only scalar keys become rows; a lone nested value with no scalars → Empty.
        assertEquals(RenderContent.Empty, classifyRenderUi("""{"meta":{"nested":true}}"""))
    }
}
