package technology.tiny.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The selected-node "learned <date> · closed <date>" line behind the memory-graph
 * detail card (iOS MemoryGraph.swift:308 / web MemoryGraph.tsx:447-449 parity).
 * valid_from/valid_to arrive as epoch SECONDS; the shared formatToolCreated pins
 * a UTC "MMM d, yyyy" so the rendered date can't drift by device timezone.
 */
class MemoryGraphTest {

    // 2026-07-23T12:00:00Z (mid-day so no tz edge) and 2026-08-15T12:00:00Z.
    private val learnedSec = 1_784_808_000L
    private val closedSec = 1_786_795_200L

    @Test fun `live node shows only the learned date`() {
        assertEquals("learned Jul 23, 2026", graphValidityLine(learnedSec, null))
    }

    @Test fun `closed node appends the closed date`() {
        assertEquals(
            "learned Jul 23, 2026 · closed Aug 15, 2026",
            graphValidityLine(learnedSec, closedSec),
        )
    }

    @Test fun `no learned date drops the whole line`() {
        // A node with no valid_from can't claim "learned ?" — omit the line entirely
        // (iOS/web only render it when valid_from is present).
        assertNull(graphValidityLine(null, null))
        assertNull(graphValidityLine(null, closedSec))
    }

    @Test fun `millisecond timestamps format the same day as seconds`() {
        // formatToolCreated's epochMs guard treats a >1e12 value as already-ms.
        assertEquals("learned Jul 23, 2026", graphValidityLine(learnedSec * 1000, null))
    }

    // -- edge dash precedence (web MemoryGraph.tsx:350 / iOS MemoryGraph.swift:252 parity) --

    @Test fun `a plain live edge draws solid`() {
        assertEquals(EdgeDash.NONE, edgeDash(closed = false, rel = "relates"))
    }

    @Test fun `a live supersedes edge draws the supersedes dash`() {
        assertEquals(EdgeDash.SUPERSEDES, edgeDash(closed = false, rel = "supersedes"))
    }

    @Test fun `a closed non-supersedes edge draws the closed dash`() {
        assertEquals(EdgeDash.CLOSED, edgeDash(closed = true, rel = "relates"))
    }

    @Test fun `a closed supersedes edge draws the CLOSED dash — closed wins`() {
        // The regression this pins: an edge that is BOTH supersedes AND closed reads
        // as history. Web (`closed ? "3 3" : supersedes ? …`) and iOS (`if closed …
        // else if supersedes …`) both give closed precedence; Android used to check
        // supersedes first and drew the "6 3" dash on this same edge.
        assertEquals(EdgeDash.CLOSED, edgeDash(closed = true, rel = "supersedes"))
    }

    // ── recencySpan: the live-fill brightness ramp's min/max (web MemoryGraph.tsx:297
    // `max > min ? … : null` / iOS recencySpan() `hi > lo else return nil`). The
    // `mx > mn` collapse is the load-bearing guard — without it liveFill divides by
    // zero and paints an invisible node. Extracted from the composable to pin it.

    private fun node(live: Boolean, validFrom: Long?): VizNode =
        VizNode(id = "n", wireId = "n", label = "n", source = null, live = live,
            validFrom = validFrom, validTo = null)

    @Test fun `recencySpan spans the min and max valid_from of live dated nodes`() {
        val span = recencySpan(listOf(
            node(live = true, validFrom = 100L),
            node(live = true, validFrom = 500L),
            node(live = true, validFrom = 300L),
        ))
        assertEquals(100L to 500L, span)
    }

    @Test fun `recencySpan is null when every live dated node shares one timestamp`() {
        // mx == mn → a span would make liveFill compute 0/0 = NaN → invisible node.
        // All three clients collapse this to null so the nodes fall to the 0.85 default.
        assertNull(recencySpan(listOf(
            node(live = true, validFrom = 42L),
            node(live = true, validFrom = 42L),
        )))
        // A single dated node is the same degenerate case (min == max).
        assertNull(recencySpan(listOf(node(live = true, validFrom = 42L))))
    }

    @Test fun `recencySpan ignores closed and undated nodes`() {
        // Only live+dated nodes ride the ramp: closed history draws grey, and an
        // undated node has no position on the timeline. With those excluded, the two
        // live+dated 42s are the only inputs → degenerate → null.
        assertNull(recencySpan(listOf(
            node(live = true, validFrom = 42L),
            node(live = false, validFrom = 999L),  // closed — excluded
            node(live = true, validFrom = null),   // undated — excluded
            node(live = true, validFrom = 42L),
        )))
    }

    @Test fun `recencySpan is null on an empty node list`() {
        assertNull(recencySpan(emptyList()))
    }
}
