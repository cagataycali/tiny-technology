package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The PURE render_ui classifier behind RenderUiCard — iOS parseRenderUi parity.
 * Guards the two blank-card regressions this replaced: a top-level JSON array
 * (rendered NOTHING) and a scalar dict (dumped raw JSON instead of key/value
 * rows). Pure Kotlin + org.json — runs on the local JVM, no Compose.
 *
 * ⚠️ The classifier is the whole testable surface, so a shape that resolves must
 * resolve to something a composable actually DRAWS — asserting the columns and the
 * cells, not just the case. A `Rows` whose cells were all blank would satisfy
 * `is RenderContent.Rows` and render an empty table.
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

    @Test fun `when no candidate charts the first array-of-objects is still drawn, as rows`() {
        // Neither array charts (each 1 row / no numeric column). The rows are still
        // rows: the FIRST candidate becomes a keyed table. iOS reaches the identical
        // shape through parseRenderUi's tableFromRows.
        val c = classifyRenderUi("""{"a":[{"label":"x","value":"hi"}],"b":[{"label":"y","value":"lo"}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        c as RenderContent.Rows
        assertEquals(listOf("label", "value"), c.columns)
        assertEquals(listOf(listOf("x", "hi")), c.rows)   // candidate `a`, not `b`
    }

    // ---- rows that don't chart are still rows (iOS b61c7afe parity) ------------

    @Test fun `a record list keeps EVERY column, not a guessed label and value`() {
        // 🔴 THE DEFECT. This drew "a" beside a BLANK cell: the old fallback read
        // label|name|x for the label and value|y|count for the value, so `status` —
        // the only thing either row was about — was silently dropped. There is no
        // key here the app could have guessed, which is exactly why it must not try.
        val c = classifyRenderUi("""{"data":[{"name":"a","status":"ok"},{"name":"b","status":"fail"}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        c as RenderContent.Rows
        assertEquals(listOf("name", "status"), c.columns)
        assertEquals(listOf(listOf("a", "ok"), listOf("b", "fail")), c.rows)
    }

    @Test fun `a row whose keys are all unguessable is not a pair of empty strings`() {
        // `{"foo":"bar"}` used to draw a visible, contentless line — two blank cells,
        // because neither alias chain matched. Worse than dropping it: it looked like
        // the data had arrived and was empty.
        val c = classifyRenderUi("""{"data":[{"foo":"bar"}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        c as RenderContent.Rows
        assertEquals(listOf("foo"), c.columns)
        assertEquals(listOf(listOf("bar")), c.rows)
    }

    @Test fun `a chartable candidate still wins — the fallback did not take over`() {
        // The row fallback is reached only after the chart loop fails for EVERY
        // candidate. If it ran first, every chart on the phone would become a table.
        val c = classifyRenderUi("""{"data":[{"m":"jan","v":1},{"m":"feb","v":2}]}""")
        assertTrue("expected Chart, got $c", c is RenderContent.Chart)
    }

    @Test fun `rows are drawn ahead of the scalar key-value path, like iOS`() {
        // The array is the data; the loose scalars beside it are the caption. Ordered
        // the other way, `title` alone would win and the rows would never be seen.
        val c = classifyRenderUi("""{"title":"Runs","data":[{"id":"a","state":"ok"}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        assertEquals(listOf("id", "state"), (c as RenderContent.Rows).columns)
    }

    @Test fun `columns are the sorted UNION of the rows' keys, blank where a row lacks one`() {
        // A row missing a key must get a blank cell, not shift its neighbours' cells
        // left under the wrong headers. Sorted so the same payload draws the same
        // table every time — org.json's key order is a hash order, not insertion.
        val c = classifyRenderUi("""{"data":[{"b":"1"},{"a":"2","c":"3"}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        c as RenderContent.Rows
        assertEquals(listOf("a", "b", "c"), c.columns)
        assertEquals(listOf(listOf("", "1", ""), listOf("2", "", "3")), c.rows)
    }

    @Test fun `a JSON null cell is blank, not the word null`() {
        // org.json hands back the JSONObject.NULL sentinel, whose toString() is the
        // four characters "null" — so a bare .toString() PRINTS it where iOS and web
        // print an empty cell.
        val c = classifyRenderUi("""{"data":[{"k":"a","v":null}]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        assertEquals(listOf(listOf("a", "")), (c as RenderContent.Rows).rows)
    }

    @Test fun `a top-level array that cannot chart is drawn too, not dropped`() {
        // Same rule one level up. This shape reached no path at all: it isn't a
        // string list, and the object branch never sees it.
        val c = classifyRenderUi("""[{"name":"a","status":"ok"},{"name":"b","status":"fail"}]""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        assertEquals(listOf("name", "status"), (c as RenderContent.Rows).columns)
    }

    @Test fun `the table caps hold — 6 columns and 30 rows, like the columns-rows path`() {
        // Untrusted agent JSON, and every cell is an eager Compose Text.
        val rows = (1..40).joinToString(",") { i ->
            (1..9).joinToString(",", "{", "}") { k -> """"k$k":"v$i-$k"""" }
        }
        val c = classifyRenderUi("""{"data":[$rows]}""")
        assertTrue("expected Rows, got $c", c is RenderContent.Rows)
        c as RenderContent.Rows
        assertEquals(6, c.columns.size)
        assertEquals(30, c.rows.size)
        assertTrue("every row is as wide as the header", c.rows.all { it.size == 6 })
    }

    @Test fun `rows with no keys at all fall through instead of drawing a headerless table`() {
        // `[{}]` carries no columns; a Rows with an empty header would be a blank
        // surface wearing a table's clothes. The scalar path then gets its turn.
        assertEquals(RenderContent.Empty, classifyRenderUi("""{"data":[{}]}"""))
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
