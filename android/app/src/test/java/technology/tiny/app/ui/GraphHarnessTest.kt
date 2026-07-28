package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GraphHarness + graphFitScale — the two halves of the c29 fix for
 * `play-02-memory-graph.png`, which shipped the signed-in user's own fact graph
 * (a named third party, a FINANCIAL FLAG fact, private repo names) in a slot Play
 * shows in search results.
 *
 * The harness half is a SAFETY gate, so the release-build case is pinned here and
 * not left to inspection. The fit half is a real rendering bug the capture exposed.
 */
class GraphHarnessTest {

    // ── the gate ─────────────────────────────────────────────────────────────

    @Test fun `a release build substitutes nothing however the extra is set`() {
        // The whole safety property: an APK on a stranger's phone cannot be shown a
        // fake graph, and — the part that actually matters — the harness can never
        // mask a real load failure for a real user.
        assertFalse(GraphHarness.enabled(debug = false, raw = true))
        assertFalse(GraphHarness.enabled(debug = false, raw = false))
    }

    @Test fun `a debug build substitutes only when the flag is actually set`() {
        assertTrue(GraphHarness.enabled(debug = true, raw = true))
        // Default-off matters: getBooleanExtra returns false when absent, so an
        // ordinary debug launch must go to the network like any other.
        assertFalse(GraphHarness.enabled(debug = true, raw = false))
    }

    // ── the dataset ──────────────────────────────────────────────────────────

    @Test fun `the demo graph is 12 live facts and 14 links with history off`() {
        val (nodes, edges) = GraphHarness.graph(includeClosed = false)
        assertEquals(12, nodes.size)
        // The 3 supersedes edges point at closed nodes that aren't present, so they
        // drop — the legend's link count can never claim more links than are drawn.
        assertEquals(14, edges.size)
        assertTrue(nodes.all { it.live })
    }

    @Test fun `history on adds the closed facts and their supersedes edges`() {
        val (nodes, edges) = GraphHarness.graph(includeClosed = true)
        assertEquals(15, nodes.size)
        assertEquals(17, edges.size)
        // Three grey nodes so the legend's "⚪ closed" marker has a referent ON
        // SCREEN. Without them the shot advertises a distinction it doesn't show.
        assertEquals(3, nodes.count { !it.live })
        assertTrue(nodes.filter { !it.live }.all { it.validTo != null })
    }

    @Test fun `every edge endpoint resolves to a node in the same dataset`() {
        // The canvas silently skips an edge whose endpoint is missing
        // (`byId[e.src] ?: continue`), so a dangling edge would inflate the legend's
        // count above the number of lines actually drawn.
        for (closed in listOf(false, true)) {
            val (nodes, edges) = GraphHarness.graph(closed)
            val ids = nodes.map { it.id }.toSet()
            assertTrue(
                "dangling edge with includeClosed=$closed",
                edges.all { it.src in ids && it.dst in ids },
            )
        }
    }

    @Test fun `live facts span several days so the recency ramp has a span`() {
        // Load-bearing, and the exact thing that reads as "fine" while being broken:
        // if every live fact shared one timestamp, recencySpan() collapses to null,
        // every node renders at the same 0.85 alpha, and the shot silently stops
        // demonstrating "brighter = newer" while still captioning it.
        val (nodes, _) = GraphHarness.graph(includeClosed = true)
        val span = recencySpan(nodes)
        requireNotNull(span) { "recency ramp has no span — brightness would be flat" }
        val (mn, mx) = span
        assertTrue("span should cover days, not seconds", mx - mn >= 5 * 86_400L)
    }

    @Test fun `node degree is uneven so radius still encodes hubness`() {
        // Radius = min(6 + degree*2, 14). A uniform ring would erase that channel,
        // making every node identical and the "hubs read as hubs" claim invisible.
        val (nodes, edges) = GraphHarness.graph(includeClosed = true)
        val degree = nodes.associate { n ->
            n.id to edges.count { it.src == n.id || it.dst == n.id }
        }
        assertTrue("some node must be a hub", degree.values.max() >= 4)
        assertTrue("some node must be a leaf", degree.values.min() <= 1)
    }

    @Test fun `captions carry no user data markers and stay readable`() {
        // A harness renders whatever it's handed. This is the regression guard for
        // the defect itself: the leaking shot's captions were exactly these shapes.
        val (nodes, _) = GraphHarness.graph(includeClosed = true)
        val forbidden = listOf(
            "FINANCIAL", "LEDGER", "SHIPMENT", "WhatsApp", "@", "http", "0x",
        )
        for (n in nodes) {
            val text = n.source ?: n.label
            for (bad in forbidden) {
                assertFalse("caption leaks '$bad': $text", text.contains(bad, ignoreCase = true))
            }
            assertTrue("caption is empty", text.isNotBlank())
        }
    }

    // ── the fit (twin of iOS GraphSimTests.fitScale*) ────────────────────────
    // Each case is chosen so the OLD formula
    // `min(viewW, viewH) / (max(spanX, spanY) + 120)` and the new one DISAGREE.

    @Test fun `fit actually FILLS the axis it binds on`() {
        // The defect, stated as the property it violated. A phone graph canvas is
        // ~1080x1500px and a settled layout is rarely square; the old formula scaled
        // by `min(viewW, viewH) / (max(spanX, spanY) + 120)`, i.e. it fitted the LONG
        // span into the SHORT viewport side. For a tall-and-narrow layout in a tall
        // canvas that under-zooms badly: the graph used ~69% of the height available
        // to it and sat as a small central island with the rest of the screen empty.
        val s = graphFitScale(spanX = 200f, spanY = 800f, viewW = 1080f, viewH = 1500f)
        val availH = 1500f - 148f
        assertTrue("must not overflow the canvas", 800f * s <= availH + 0.5f)
        assertTrue("must USE the height it has: ${800f * s} of $availH", 800f * s >= availH * 0.9f)
        // ...and the non-binding axis is along for the ride, not overflowing either.
        assertTrue("narrow axis fits too", 200f * s <= 1080f - 148f)
    }

    @Test fun `fit binds on the tighter axis per axis`() {
        val wide = graphFitScale(900f, 100f, 1080f, 1500f)
        assertTrue("width must fit", 900f * wide <= 1080f - 148f + 0.5f)
        assertTrue("height should have slack", 100f * wide < 1500f - 148f)

        val tall = graphFitScale(100f, 900f, 1080f, 1500f)
        assertTrue("height must fit", 900f * tall <= 1500f - 148f + 0.5f)
        // A tall layout in a tall viewport gets MORE zoom than the same span wide,
        // because the binding axis differs. One-span logic cannot express this.
        assertTrue("per-axis fit: $tall vs $wide", tall > wide)
    }

    @Test fun `fit is neutral rather than degenerate on unmeasured or flat input`() {
        assertEquals(1f, graphFitScale(400f, 400f, 0f, 0f), 0f)     // not measured yet
        assertEquals(1f, graphFitScale(0f, 0f, 1080f, 1500f), 0f)   // single node
        val flat = graphFitScale(600f, 0f, 1080f, 1500f)            // one flat axis
        assertTrue(flat > 0.15f && flat < 4f)
    }

    @Test fun `fit clamps instead of vanishing or exploding`() {
        assertEquals(0.15f, graphFitScale(100_000f, 100_000f, 1080f, 1500f), 0f)
        assertEquals(4f, graphFitScale(4f, 4f, 1080f, 1500f), 0f)
    }

    @Test fun `label padding never eats a small canvas`() {
        // labelPad is 74/side; on a canvas narrower than 148 the naive subtraction
        // goes negative and the scale flips sign or clamps to the floor.
        val s = graphFitScale(100f, 100f, 120f, 120f)
        assertTrue("not clamped to the floor: $s", s > 0.15f)
        assertTrue("still inside the canvas", 100f * s <= 120f)
    }
}
