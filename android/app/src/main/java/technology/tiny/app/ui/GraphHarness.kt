package technology.tiny.app.ui

/**
 * GraphHarness — debug-only substitute dataset for the memory-graph screenshot.
 *
 * ## Why this exists
 *
 * `play-02-memory-graph.png` was shipping the signed-in user's OWN fact graph, and
 * the node captions are legible in a 1080×2160 upload: a named third party, a
 * "FINANCIAL FLAG" fact, "SHIPMENT OF RECORD", "LEDGER READ", a WhatsApp reference
 * and a wall of private repo names. Slot 2 is one of the first three shots Play
 * shows in search, so it was among the most-viewed assets in the listing.
 *
 * The chat shots are fixed by seeding a file. The graph is a **network fetch**
 * (`GET /api/graph?all=1` in [GraphSheet]), so there is nothing on disk to seed —
 * the substitution has to happen where the fetch would land. Same problem, same
 * shape of answer as the iOS `--memory-graph-harness` flag (MemoryGraph.swift).
 *
 * ## What it fakes, and what it deliberately does NOT
 *
 * Only the DATASET is chosen. Everything that makes the screenshot a depiction of
 * the product stays on the real code path:
 *  - the force layout (same golden-angle seed, repulsion, springs, cooling),
 *  - the `liveFill` recency ramp — which is why [validFrom] spans six days rather
 *    than one timestamp: a single timestamp collapses [recencySpan] to null and
 *    flattens every node to the same brightness, quietly hiding half of what the
 *    caption "Watch its memory grow" claims,
 *  - the grey `live = false` history path,
 *  - the legend, which **counts these very lists** — "15 facts · 17 links" is a
 *    computed count, not a drawn string.
 *
 * The dataset is one PERSONA's knowledge (a baking tiny), because that is what a
 * new user's graph actually looks like. A power user's 105-fact hairball is what
 * the leaking shot was, and nothing in it was readable anyway.
 *
 * Every fact is something the `learn` tool genuinely stores (short, factual). A
 * harness dataset renders whatever it's handed, so — exactly like the seeded chat
 * transcripts — the CONTENT has to be checked against what the app really does
 * rather than written to fit a caption.
 *
 * ## Safety
 *
 * Pure on purpose (no Context, no Intent, no BuildConfig read): the rules are
 * JVM-unit-tested in GraphHarnessTest, and [enabled] takes `debug` explicitly so a
 * test can pin that a release build substitutes NOTHING. The call site in
 * [GraphSheet] passes `BuildConfig.DEBUG`, so on a shipped APK the flag is inert
 * however the intent is crafted — a stranger's install cannot be shown a fake
 * graph, and more importantly the harness can never mask a real load failure.
 *
 *   adb shell am start -n technology.tiny.app/.MainActivity \
 *     --ez tiny_harness_graph true
 */
object GraphHarness {

    /** Launch-extra key. Prefixed `tiny_harness_` to match [WearHarness]'s keys. */
    const val EXTRA_GRAPH = "tiny_harness_graph"

    /**
     * Whether to substitute the demo dataset. False in a release build no matter
     * what the extra says — that's the whole safety property.
     */
    fun enabled(debug: Boolean, raw: Boolean): Boolean = debug && raw

    /** A fixed epoch, so the shot doesn't vary run to run. Seconds, like the wire. */
    private const val T0 = 1_753_000_000L
    private const val DAY = 86_400L

    /** 12 live facts. `dayOffset` spreads them so the recency ramp has a span. */
    private val LIVE = listOf(
        Triple("f1", "Bakes sourdough every Sunday morning", 0L),
        Triple("f2", "Keeps a rye starter named Bubbles, fed Saturday night", 1L),
        Triple("f3", "Kitchen runs cold — proofs in the oven with the light on", 1L),
        Triple("f4", "Prefers 78% hydration for an open crumb", 2L),
        Triple("f5", "Dutch oven preheats 45 min at 250°C", 2L),
        Triple("f6", "Scores a single long slash, never a cross", 3L),
        Triple("f7", "Bread flour from the mill on Grand St", 3L),
        Triple("f8", "Hates a gummy crumb more than a pale crust", 4L),
        Triple("f9", "Sunday bake has to be out of the oven by 11", 4L),
        Triple("f10", "Learning to shape baguettes, still tearing the skin", 5L),
        Triple("f11", "Wants the alarm 25 min before the bulk ends", 5L),
        Triple("f12", "Bakes for four; doubles the recipe on holidays", 6L),
    )

    /**
     * 3 superseded facts, joined only when History is on. They give the legend's
     * "⚪ closed" marker a referent ON SCREEN — without them the shot advertises a
     * distinction it doesn't show.
     */
    private val CLOSED = listOf(
        Triple("c1", "Proofed on the counter (superseded — kitchen too cold)", 0L),
        Triple("c2", "Used 65% hydration (superseded — wanted a more open crumb)", 1L),
        Triple("c3", "Fed the starter every morning (superseded — Saturdays only)", 2L),
    )

    /**
     * Uneven degree on purpose: node radius encodes degree, so a uniform ring
     * would erase that channel entirely. The starter and the Sunday bake are hubs.
     */
    private val LINKS = listOf(
        Triple("f1", "f2", "requires"), Triple("f1", "f5", "uses"),
        Triple("f1", "f9", "constrains"), Triple("f1", "f12", "scales_with"),
        Triple("f2", "f3", "affected_by"), Triple("f2", "f7", "made_from"),
        Triple("f4", "f8", "avoids"), Triple("f4", "f1", "applies_to"),
        Triple("f5", "f6", "precedes"), Triple("f6", "f10", "practised_in"),
        Triple("f9", "f11", "needs"), Triple("f3", "f5", "compensated_by"),
        Triple("f10", "f7", "made_from"), Triple("f12", "f4", "applies_to"),
        Triple("c1", "f3", "supersedes"), Triple("c2", "f4", "supersedes"),
        Triple("c3", "f2", "supersedes"),
    )

    /**
     * The demo graph. [includeClosed] mirrors the History chip (the real one
     * appends `&include_closed=1`), so toggling it here behaves like the real
     * toggle rather than becoming a no-op that reads as a broken control.
     *
     * Edges referencing a node that isn't present are dropped, matching what the
     * canvas does anyway (`byId[e.src] ?: continue`) — so the legend's link count
     * can never claim more links than are drawn.
     */
    fun graph(includeClosed: Boolean): Pair<List<VizNode>, List<VizEdge>> {
        val src = LIVE + if (includeClosed) CLOSED else emptyList()
        val nodes = src.map { (id, text, day) ->
            val closed = id.startsWith("c")
            VizNode(
                id = id,
                wireId = id.removePrefix("f").removePrefix("c"),
                label = text,
                source = text,
                live = !closed,
                validFrom = T0 + day * DAY,
                validTo = if (closed) T0 + (day + 3) * DAY else null,
            )
        }
        val ids = nodes.map { it.id }.toSet()
        val edges = LINKS.filter { it.first in ids && it.second in ids }
            .mapIndexed { i, (s, d, rel) ->
                VizEdge(id = "e$i", src = s, dst = d, rel = rel, scope = null, closed = false)
            }
        return nodes to edges
    }
}
