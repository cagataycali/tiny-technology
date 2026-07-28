package technology.tiny.app.ui

import technology.tiny.app.chat.MemoryEntry

/**
 * MemoryHarness — debug-only substitute dataset for the memory LIST sheet.
 *
 * ## Why this exists
 *
 * Android had a harness for the memory GRAPH ([GraphHarness]) and for the device
 * fleet ([FleetHarness]), and none for the sheet the graph is reached FROM. The
 * graph got one because it leaked (`play-02-memory-graph.png`); nothing
 * generalised the lesson one sheet over, even though [MemorySheet] renders the
 * same facts as a LEGIBLE LIST — easier to read in an upload than the graph's
 * node captions ever were. iOS hit exactly this and fixed it there (c56,
 * `MemoryHarness` in Panels.swift); this is the Android side of that same fix.
 *
 * 🔑 **A harness for the screen that leaked is not a harness for the screen
 * beside it.** The remaining Android capture backlog is what proves it: the
 * memory list has no cleared still at all, because there was no known dataset to
 * capture it against.
 *
 * ## TWO ungated sources, not one
 *
 * ⚠️⚠️ [MemorySheet] draws **both** `/api/learnings` AND the on-device
 * `Continuity.loadMemories(tiny)` section above it. A harness that substituted
 * only the network fetch would leave the local half live while still being
 * called "the memory harness" — the same defect one layer down. Both are
 * substituted, and a test asserts both call sites.
 *
 * ## The delete paths, which are the subtle half
 *
 * ⚠️ This sheet is the first harnessed screen with **mutating controls**, and
 * they are why a dataset alone is not enough here. [GraphSheet] and
 * [DevicesSheet] only read. A memory row has a delete, and both of its handlers
 * end by re-reading the real source:
 *
 *  - the local row calls `Continuity.forgetMemory(tiny, …)` and then
 *    `loadMemories(tiny)` — so one tap on a DEMO row would swap the user's real
 *    on-device memories into the frame, which is the leak the harness exists to
 *    prevent, triggered by the harness's own UI;
 *  - the server row sends `DELETE /api/learnings` with a fabricated id. Nothing
 *    would match it, but it is still a real write aimed at the user's real
 *    account — and the standing capture rule is to **seed content, never mutate
 *    the account for an asset**.
 *
 * So under the harness both deletes drop the row from the in-memory list only.
 * The control still animates, which keeps the screenshot honest about what the
 * product does, and neither the device store nor the account is touched.
 * 🔑 **A read-only harness generalises to a screen with buttons only if you
 * check where the buttons lead.**
 *
 * ## What it fakes, and what it deliberately does NOT
 *
 * Only the DATASET. Everything that makes the shot a depiction of the product
 * stays on the real path: [MemoryRow]'s 🟢 live / ⚪ archived dot, the
 * live-vs-closed split via [learningIsLive], the "on this phone" / "server
 * learnings" section headers, the sheet's own scroll and the 🕸 graph button.
 *
 * The persona is the SAME baking tiny as [GraphHarness]'s, on purpose: a capture
 * (or a video cut) walks list → graph in one motion, and two unrelated demo
 * datasets would make the app look like it forgot everything between two taps —
 * the opposite of what the caption claims. A test pins that overlap rather than
 * trusting the two files to be edited together.
 *
 * ## Safety
 *
 * Pure on purpose (no Context, no Intent, no BuildConfig read): the rules are
 * JVM-unit-tested in MemoryHarnessTest, and [enabled] takes `debug` explicitly
 * so a test can pin that a release build substitutes NOTHING. The call site in
 * [MemorySheet] passes `BuildConfig.DEBUG`, so on a shipped APK the flag is
 * inert however the intent is crafted — a stranger's install cannot be shown a
 * fake memory list, and the harness can never mask a real load failure.
 *
 *   adb shell am start -n technology.tiny.app/.MainActivity \
 *     --ez tiny_harness_memory true
 */
object MemoryHarness {

    /** Launch-extra key. Prefixed `tiny_harness_` to match its two siblings. */
    const val EXTRA_MEMORY = "tiny_harness_memory"

    /**
     * Whether to substitute the demo dataset. False in a release build no matter
     * what the extra says — that's the whole safety property.
     */
    fun enabled(debug: Boolean, raw: Boolean): Boolean = debug && raw

    /**
     * Nine live learnings. Every one is something the `learn` tool genuinely
     * stores (short, factual), and the set exercises the view's channels rather
     * than looking tidy:
     *  - one row long enough to WRAP, because real learnings wrap and a set of
     *    uniformly short ones would not prove the layout handles it;
     *  - the wrapping row is a LONGER FORM of a graph fact rather than a new
     *    one, so the two datasets still read as one persona.
     */
    private val LIVE = listOf(
        "Bakes sourdough every Sunday morning",
        "Keeps a rye starter named Bubbles, fed Saturday night",
        "Kitchen runs cold — proofs in the oven with the light on",
        "Prefers 78% hydration for an open crumb",
        "Dutch oven preheats 45 min at 250°C",
        "Scores a single long slash, never a cross",
        "Bread flour from the mill on Grand St",
        "Sunday bake has to be out of the oven by 11, because the market stall opens at noon",
        "Learning to shape baguettes, still tearing the skin",
    )

    /**
     * Three superseded learnings, so the archived ⚪ dot has a referent ON
     * SCREEN. All-live rows render the dot in one state and quietly hide half of
     * what the frame claims — the same reason [GraphHarness] needs History on
     * for its grey nodes. Identical strings to that harness's CLOSED set.
     */
    private val CLOSED = listOf(
        "Proofed on the counter (superseded — kitchen too cold)",
        "Used 65% hydration (superseded — wanted a more open crumb)",
        "Fed the starter every morning (superseded — Saturdays only)",
    )

    /**
     * The server half, as [Learning]s the sheet renders unchanged.
     *
     * Ids are fixed and no clock is read: `LazyColumn` keys on them, and a
     * varying id would re-key the list between frames of the same capture.
     */
    fun learnings(): List<Learning> =
        LIVE.mapIndexed { i, c -> Learning(id = "s${100 + i}", content = c, live = true) } +
            CLOSED.mapIndexed { i, c -> Learning(id = "s${200 + i}", content = c, live = false) }

    /** A fixed epoch in ms, matching Continuity's `ts` unit. A live clock would
     *  vary the shot run to run and defeat any reference comparison. */
    private const val T0_MS = 1_753_000_000_000L

    /**
     * The on-device half. It exists because this sheet has TWO ungated sources,
     * and a harness for one of them is not a harness for the sheet.
     *
     * Deliberately SHORT (two rows): the local section sits above the server one,
     * and a long local list would push "server learnings" — the section the
     * caption is about — off a 9:16 store frame.
     */
    fun localEntries(): List<MemoryEntry> = listOf(
        MemoryEntry(id = "h1", content = "Calls the starter \"she\"",
            tags = emptyList(), ts = T0_MS),
        MemoryEntry(id = "h2", content = "Wants gram weights, never cups",
            tags = emptyList(), ts = T0_MS + 3_600_000L),
    )
}
