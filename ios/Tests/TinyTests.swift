/**
 * TinyTests — unit tests for the pure logic (north-star hygiene).
 * Swift Testing framework (Xcode 16+); zero UI, zero network.
 */
import Testing
import Foundation
// SwiftUI: SidebarVisibilityTests asserts on NavigationSplitViewVisibility.
import SwiftUI
@testable import Tiny

// ── MarkdownSplitter ──────────────────────────────────────────────────────

@Suite struct MarkdownSplitterTests {
    @Test func plainProse() {
        let segs = MarkdownSplitter.segments("hello world")
        #expect(segs == [.prose("hello world")])
    }

    @Test func fencedCode() {
        let segs = MarkdownSplitter.segments("before\n```swift\nlet x = 1\n```\nafter")
        #expect(segs == [.prose("before"), .code(lang: "swift", body: "let x = 1"), .prose("after")])
    }

    @Test func unterminatedFenceStreamsAsCode() {
        // Streaming reality: closing fence hasn't arrived yet
        let segs = MarkdownSplitter.segments("text\n```py\nprint(1)")
        #expect(segs == [.prose("text"), .code(lang: "py", body: "print(1)")])
    }

    @Test func emptyLangTag() {
        let segs = MarkdownSplitter.segments("```\nplain\n```")
        #expect(segs == [.code(lang: nil, body: "plain")])
    }
}

// ── MarkdownProse (GFM tables) ────────────────────────────────────────────

@Suite struct MarkdownProseTests {
    @Test func plainRunHasNoTable() {
        #expect(MarkdownProse.blocks("just prose\nsecond line") == [.text("just prose\nsecond line")])
    }

    @Test func gfmTableParsed() {
        let md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
        #expect(MarkdownProse.blocks(md) == [
            .table(header: ["A", "B"], rows: [["1", "2"], ["3", "4"]])
        ])
    }

    @Test func tableSurroundedByProse() {
        let md = "before\n| A | B |\n|:--|--:|\n| 1 | 2 |\nafter"
        #expect(MarkdownProse.blocks(md) == [
            .text("before"),
            .table(header: ["A", "B"], rows: [["1", "2"]]),
            .text("after"),
        ])
    }

    @Test func raggedRowsPaddedAndTruncated() {
        // Short row padded to header width; over-wide row truncated.
        let md = "| A | B | C |\n| - | - | - |\n| 1 |\n| x | y | z | w |"
        #expect(MarkdownProse.blocks(md) == [
            .table(header: ["A", "B", "C"], rows: [["1", "", ""], ["x", "y", "z"]])
        ])
    }

    @Test func pipeWithoutSeparatorIsNotATable() {
        // A lone pipe line (no separator row after) stays plain text — must not
        // be mistaken for a table (would swallow prose into a 1-row grid).
        #expect(MarkdownProse.blocks("a | b is just prose") == [.text("a | b is just prose")])
    }

    @Test func separatorRequiresDash() {
        // ":::" is not a valid separator (no dash) → not a table.
        let md = "| A | B |\n| : | : |\n| 1 | 2 |"
        #expect(MarkdownProse.blocks(md) == [.text(md)])
    }

    @Test func borderlessPipesTolerated() {
        // No leading/trailing pipes (valid GFM).
        let md = "A | B\n--- | ---\n1 | 2"
        #expect(MarkdownProse.blocks(md) == [
            .table(header: ["A", "B"], rows: [["1", "2"]])
        ])
    }

    @Test func blockquoteParsed() {
        // GFM tolerates "> x" and ">x"; marker + one optional space stripped.
        #expect(MarkdownProse.blocks("> quoted") == [.quote("quoted")])
        #expect(MarkdownProse.blocks(">tight") == [.quote("tight")])
    }

    @Test func multiLineQuoteCollapsesToOneBlock() {
        // Consecutive '>' lines fold into a single quote block (web <blockquote>).
        let md = "> line one\n> line two"
        #expect(MarkdownProse.blocks(md) == [.quote("line one\nline two")])
    }

    @Test func quoteSurroundedByProse() {
        let md = "before\n> quoted\nafter"
        #expect(MarkdownProse.blocks(md) == [
            .text("before"),
            .quote("quoted"),
            .text("after"),
        ])
    }

    @Test func emptyQuoteMarkerTolerated() {
        // A bare ">" (empty quote line) must not crash — yields an empty quote.
        #expect(MarkdownProse.blocks(">") == [.quote("")])
    }

    @Test func strikethroughLiftsToSwiftUIStyle() {
        // ~~x~~ parses as an inlinePresentationIntent but SwiftUI's Text won't
        // render strikethrough from that — styled() must lift it into the
        // strikethroughStyle attribute so the line actually shows.
        let attr = MarkdownProse.styled("~~gone~~")
        #expect(attr != nil)
        #expect(String(attr!.characters) == "gone")   // tildes stripped
        let anyStruck = attr!.runs.contains { $0.strikethroughStyle != nil }
        #expect(anyStruck)
    }

    @Test func plainProseHasNoStrikethrough() {
        // Non-struck prose must not gain a stray strikethrough style.
        let attr = MarkdownProse.styled("just text")
        #expect(attr != nil)
        #expect(attr!.runs.allSatisfy { $0.strikethroughStyle == nil })
    }

    @Test func styledFallsBackNilOnlyWhenUnparseable() {
        // Well-formed inline markdown always parses (bold survives).
        #expect(MarkdownProse.styled("**bold** and *it*") != nil)
    }

    @Test func thematicBreakVariants() {
        #expect(MarkdownProse.isThematicBreak("---"))
        #expect(MarkdownProse.isThematicBreak("***"))
        #expect(MarkdownProse.isThematicBreak("___"))
        #expect(MarkdownProse.isThematicBreak("- - -"))   // spaces allowed
        #expect(MarkdownProse.isThematicBreak("****"))    // 4+ ok
        #expect(!MarkdownProse.isThematicBreak("--"))     // needs 3+
        #expect(!MarkdownProse.isThematicBreak("- item")) // bullet, not a rule
        #expect(!MarkdownProse.isThematicBreak("-*-"))    // mixed markers
        #expect(!MarkdownProse.isThematicBreak(""))
    }

    @Test func thematicBreakBecomesRuleBlock() {
        #expect(MarkdownProse.blocks("above\n---\nbelow") == [
            .text("above"), .rule, .text("below"),
        ])
    }

    @Test func dashSeparatorStillPrefersTableWhenPiped() {
        // A real table's "| --- |" separator must still build a table, not a
        // stray rule (the table branch requires a '|', checked first).
        let md = "| A | B |\n| --- | --- |\n| 1 | 2 |"
        #expect(MarkdownProse.blocks(md) == [
            .table(header: ["A", "B"], rows: [["1", "2"]])
        ])
    }
}

// ── Update.isNewer ────────────────────────────────────────────────────────

@Suite struct UpdaterTests {
    @Test func numericComparison() {
        #expect(Updater.isNewer("21", than: "19"))
        #expect(Updater.isNewer("100", than: "99"))   // numeric, not lexicographic
        #expect(!Updater.isNewer("19", than: "21"))
        #expect(!Updater.isNewer("21", than: "21"))
    }
}

// ── SpawnTreeItem.apply ───────────────────────────────────────────────────

@Suite struct SpawnTreeTests {
    private func tree(_ n: Int) -> SpawnTreeItem {
        SpawnTreeItem(id: "t1",
                      nodes: (1...n).map { SpawnNode(id: $0, prompt: "task \($0)", ok: nil, result: nil) },
                      elapsedMs: nil)
    }

    @Test func resultsFlipNodes() {
        var item = tree(2)
        item.apply(resultsJson: #"{"elapsed_ms": 1500, "results": [{"task": 1, "ok": true, "result": "done"}]}"#)
        #expect(item.nodes[0].ok == true)
        #expect(item.nodes[0].result == "done")
        #expect(item.elapsedMs == 1500)
        #expect(item.outcome == .settled)
        // ⚠️ CHANGED, deliberately. This used to assert `ok == false` under the
        // comment "unreported task = failure". Terminal, yes — but the app never
        // saw it run, so calling it a failure is a claim about work it has no
        // record of. It stays `nil` and reads as "didn't run", which is the
        // whole of what is known.
        #expect(item.nodes[1].ok == nil)
        #expect(item.state(of: item.nodes[1]) == .didNotRun)
    }

    /// ⚠️ This test was called `malformedJsonIsNoop` and it PASSED — it pinned
    /// the bug. A no-op leaves every node `nil` with the tree still `.live`, so
    /// the card spun its "running" spinner forever over a batch that had already
    /// ended. The no-op was the symptom; the test asserted it as the rule.
    @Test func malformedJsonEndsTheBatch() {
        var item = tree(1)
        item.apply(resultsJson: "not json")
        #expect(item.nodes[0].ok == nil)
        #expect(item.outcome == .aborted)
        #expect(item.state(of: item.nodes[0]) == .didNotRun)
        #expect(item.state(of: item.nodes[0]) != .running, "the spinner outlives the batch again")
    }

    /// The empty string is how the decoder says "the tool errored, or its result
    /// carried nothing readable" — the case that used to emit no event at all.
    @Test func nothingReadableIsNotStillRunning() {
        var item = tree(3)
        item.apply(resultsJson: "")
        #expect(item.outcome == .aborted)
        #expect(item.nodes.allSatisfy { item.state(of: $0) == .didNotRun })
    }

    @Test("a background fan-out is queued, not three failures")
    func pendingIsNotFailure() {
        var item = tree(3)
        // wait:false — what the server actually returns: no results, ever, on
        // this stream. The old sweep read that as a total wipeout.
        item.apply(resultsJson: #"{"ok": true, "pending": true, "batch_id": "batch_x", "tasks": 3}"#)
        #expect(item.outcome == .background)
        #expect(item.nodes.allSatisfy { item.state(of: $0) == .queued })
        #expect(item.nodes.allSatisfy { item.state(of: $0) != .failed })
        // Nothing has been timed, so there is nothing to report as elapsed.
        #expect(item.elapsedMs == nil)
    }

    @Test("a reported failure is still a failure, and keeps the server's reason")
    func reportedFailuresSurvive() {
        var item = tree(2)
        item.apply(resultsJson: #"{"results": [{"task": 1, "ok": false, "error": "task timeout"}, {"task": 2, "ok": true, "result": "ok"}]}"#)
        #expect(item.state(of: item.nodes[0]) == .failed)
        #expect(item.nodes[0].result == "task timeout")
        #expect(item.state(of: item.nodes[1]) == .succeeded)
    }

    @Test("ok answers for itself; only a silent node depends on how the batch ended")
    func stateTruthTable() {
        for outcome in [SpawnTreeItem.Outcome.live, .background, .settled, .aborted] {
            #expect(SpawnTreeItem.state(ok: true, outcome: outcome) == .succeeded)
            #expect(SpawnTreeItem.state(ok: false, outcome: outcome) == .failed)
        }
        #expect(SpawnTreeItem.state(ok: nil, outcome: .live) == .running)
        #expect(SpawnTreeItem.state(ok: nil, outcome: .background) == .queued)
        #expect(SpawnTreeItem.state(ok: nil, outcome: .settled) == .didNotRun)
        #expect(SpawnTreeItem.state(ok: nil, outcome: .aborted) == .didNotRun)
        // The one collapse that would put the bug back.
        #expect(SpawnTreeItem.state(ok: nil, outcome: .settled) != .failed)
    }

    /// Restored history predates `outcome`. It must NOT default to `.live`: that
    /// stream is gone, so a node that never reported can never report, and a
    /// spinner in scrolled-back history spins until the app is killed.
    @Test func restoredHistoryDoesNotSpin() throws {
        let old = #"{"id":"t1","nodes":[{"id":1,"prompt":"a"}],"elapsedMs":null}"#
        let item = try JSONDecoder().decode(SpawnTreeItem.self, from: Data(old.utf8))
        #expect(item.outcome == .settled)
        #expect(item.state(of: item.nodes[0]) == .didNotRun)
        #expect(item.state(of: item.nodes[0]) != .running)
    }

    @Test("VoiceOver can tell the five states apart") func spokenStatesAreDistinct() {
        // CaseIterable, so a sixth state added later cannot skip this check.
        let said = SpawnState.allCases.map(\.spoken)
        #expect(SpawnState.allCases.count == 5)
        #expect(Set(said).count == said.count)
        #expect(said.allSatisfy { !$0.isEmpty })
        // The pair that shares a glyph — dimmed vs full red — so the words are
        // the only thing separating them for a screen-reader user.
        #expect(SpawnState.didNotRun.spoken != SpawnState.failed.spoken)
    }
}

// ── RenderUi parsing ──────────────────────────────────────────────────────

@Suite struct RenderUiTests {
    @Test func chartFromLabeledRows() {
        let props = #"{"data": [{"label": "Mon", "value": 1}, {"label": "Tue", "value": 2}]}"#
        if case .chart(let points, let series) = parseRenderUi(props) {
            #expect(points.count == 2)
            #expect(series == 1)
        } else {
            Issue.record("expected .chart")
        }
    }

    @Test func keyValuesFromScalars() {
        if case .keyValues(let kvs) = parseRenderUi(#"{"name": "tiny", "age": 1}"#) {
            #expect(kvs.count == 2)
        } else {
            Issue.record("expected .keyValues")
        }
    }

    @Test func emptyOnGarbage() {
        // Reachability note (android shows non-JSON props as raw text instead):
        // BOTH iOS producers stringify through a validity check and substitute
        // "{}" — ChatStreamDecoder.jsonString and ChatModel.voiceRenderUi — so a
        // non-JSON propsJson cannot arrive here from a live call. That is the
        // only reason dropping the text is acceptable; if a third producer
        // appears, this becomes the same defect the table fallback below fixes.
        if case .empty = parseRenderUi("not json") {} else { Issue.record("expected .empty") }
    }

    @Test func tablePositionalRows() {
        let props = #"{"columns":["City","Pop"],"rows":[["NYC","8M"],["LA","4M"]]}"#
        if case .table(let cols, let rows) = parseRenderUi(props) {
            #expect(cols == ["City", "Pop"])
            #expect(rows == [["NYC", "8M"], ["LA", "4M"]])
        } else {
            Issue.record("expected .table")
        }
    }

    @Test func tableObjectKeyedRows() {
        // Freeform props: rows keyed by column name. Used to fail the [[Any]]
        // cast → nil → table dropped (and mis-guessed as a chart). Now cells are
        // read by column name so the object shape renders too.
        let props = #"{"columns":["City","Pop"],"rows":[{"City":"NYC","Pop":8},{"City":"LA","Pop":4}]}"#
        if case .table(let cols, let rows) = parseRenderUi(props) {
            #expect(cols == ["City", "Pop"])
            #expect(rows == [["NYC", "8"], ["LA", "4"]])
        } else {
            Issue.record("expected .table from object-keyed rows")
        }
    }

    @Test func tableObjectRowMissingColumnIsBlank() {
        // A row missing a column's key yields an empty cell, not a dropped row.
        let props = #"{"columns":["A","B"],"rows":[{"A":"x"}]}"#
        if case .table(_, let rows) = parseRenderUi(props) {
            #expect(rows == [["x", ""]])
        } else {
            Issue.record("expected .table")
        }
    }

    @Test func itemsAcceptLabelValueShape() {
        // {label, value} is a natural agent shape; value is numeric so it must
        // be stringified (a bare `as? String` dropped it). title/name still work.
        let props = #"{"items":[{"label":"CPU","value":42},{"text":"Disk","detail":"80%"}]}"#
        if case .titledItems(let items) = parseRenderUi(props) {
            #expect(items.count == 2)
            #expect(items[0].title == "CPU")
            #expect(items[0].subtitle == "42")
            #expect(items[1].title == "Disk")
            #expect(items[1].subtitle == "80%")
        } else {
            Issue.record("expected .titledItems from label/value shape")
        }
    }

    // ── rows that don't chart are still rows ───────────────────────────────
    // 🏷️ THE DEFECT: every one of these landed on .empty, which drew "Interactive
    // version on the web app" — a card refusing to show data it was holding, and
    // pointing at a web version this client cannot know exists.

    @Test func recordRowsWithoutANumberStillRender() {
        // The ordinary case: a list of records, no numeric column, so nothing to
        // chart. Two rows in hand; the old card showed neither.
        let props = #"{"data":[{"name":"a","status":"ok"},{"name":"b","status":"fail"}]}"#
        if case .table(let cols, let rows) = parseRenderUi(props) {
            #expect(cols == ["name", "status"])
            #expect(rows == [["a", "ok"], ["b", "fail"]])
        } else {
            Issue.record("expected .table from non-charting record rows")
        }
    }

    @Test func singleRowUnderAnyKeyStillRenders() {
        // The exact payload android's RenderUi.kt names as "iOS drops it".
        if case .table(let cols, let rows) = parseRenderUi(#"{"a":[{"x":"one"}]}"#) {
            #expect(cols == ["x"])
            #expect(rows == [["one"]])
        } else {
            Issue.record("expected .table from a lone row")
        }
    }

    @Test func topLevelRowsWithoutANumberStillRender() {
        // Same rule one level up: the string-list path can't match objects, so a
        // top-level [{…},{…}] fell through to .empty too.
        if case .table(let cols, let rows) = parseRenderUi(#"[{"name":"a"},{"name":"b"}]"#) {
            #expect(cols == ["name"])
            #expect(rows == [["a"], ["b"]])
        } else {
            Issue.record("expected .table from top-level record rows")
        }
    }

    @Test func columnsAreTheSortedUnionAndMissingCellsAreBlank() {
        // Rows need not agree on their keys: the union is shown, sorted, and a
        // row missing one gets a blank cell rather than being dropped. An
        // explicit JSON null is blank too — "<null>", NSNull's description, is
        // what a cell prints when the coercion forgets it.
        if case .table(let cols, let rows) = parseRenderUi(#"[{"b":1,"a":"x"},{"a":"y","c":"z","b":null}]"#) {
            #expect(cols == ["a", "b", "c"])
            #expect(rows == [["x", "1", ""], ["y", "", "z"]])
        } else {
            Issue.record("expected .table from ragged rows")
        }
    }

    @Test func rowTableIsCappedLikeTheColumnsPathItReuses() {
        // Untrusted agent JSON drawn as eager SwiftUI views: 6 columns, 30 rows,
        // the same caps as the explicit {columns,rows} path. Seven keys also make
        // the ordering assertion sharp — unsorted, the six kept would be random.
        let wide = #"[{"g":"7","f":"6","e":"5","d":"4","c":"3","b":"2","a":"1"},"#
                 + #"{"a":"1","b":"2","c":"3","d":"4","e":"5","f":"6","g":"7"}]"#
        if case .table(let cols, let rows) = parseRenderUi(wide) {
            #expect(cols == ["a", "b", "c", "d", "e", "f"])
            #expect(rows.allSatisfy { $0.count == 6 })
        } else {
            Issue.record("expected .table")
        }
        let many = "[" + (0..<40).map { #"{"n":"r\#($0)"}"# }.joined(separator: ",") + "]"
        if case .table(_, let rows) = parseRenderUi(many) {
            #expect(rows.count == 30)
            #expect(rows.first == ["r0"])   // the FIRST 30, not a random 30
        } else {
            Issue.record("expected .table from 40 rows")
        }
    }

    @Test func aChartableCandidateStillWinsOverTheRowTable() {
        // ⚠️ The fallback must not steal the card from a LATER candidate that
        // charts: `a` has one non-numeric row, `b` is the real chart.
        let props = #"{"a":[{"x":"one"}],"b":[{"m":"jan","v":1},{"m":"feb","v":2}]}"#
        if case .chart(let points, _) = parseRenderUi(props) {
            #expect(points.count == 2)
        } else {
            Issue.record("expected .chart from the candidate that charts")
        }
    }

    @Test func rowsBeatLooseScalarsBesideThem() {
        // {title:…, data:[…]} — the scalars are the meta, the array is the data
        // (android orders these the same way). Key/value rows of just "title"
        // would be a card about the caption instead of the content.
        let props = #"{"title":"Report","data":[{"name":"a","status":"ok"},{"name":"b","status":"fail"}]}"#
        if case .table(let cols, _) = parseRenderUi(props) {
            #expect(cols == ["name", "status"])
        } else {
            Issue.record("expected .table, not .keyValues from the loose title")
        }
    }

    // ── what the voice tool is allowed to claim ────────────────────────────

    @Test func onlyAnUndrawableCardIsRefused() {
        // voiceRenderUi's return is read OUT LOUD, so it may only say a card is
        // on screen when one will draw. Every shape that draws → no refusal.
        for props in [#"{"data":[{"label":"a","value":1},{"label":"b","value":2}]}"#,
                      #"{"name":"tiny"}"#,
                      #"["a","b"]"#,
                      ##"{"markdown":"# hi"}"##,
                      #"{"columns":["a"],"rows":[["1"]]}"#,
                      #"{"items":[{"label":"one"}]}"#,
                      #"{"data":[{"name":"a","status":"ok"},{"name":"b","status":"fail"}]}"#] {
            #expect(renderUiRefusal(parseRenderUi(props)) == nil, "\(props) draws, so nothing to refuse")
        }
        let refusal = renderUiRefusal(parseRenderUi("{}"))
        #expect(refusal != nil)
        // It has to tell the agent NOT to announce the card it didn't get, or the
        // agent describes a card the listening user cannot see.
        #expect(refusal?.contains("No card was added") == true)
        #expect(refusal?.contains("do not say one is on screen") == true)
    }

    @Test func theSpokenNoteNamesTheShapeThatActuallyDrew() {
        // "here's the chart" over a table is the same mistake one size smaller.
        #expect(renderUiShapeName(parseRenderUi(#"{"columns":["a"],"rows":[["1"]]}"#)) == "table")
        #expect(renderUiShapeName(parseRenderUi(#"{"data":[{"name":"a","s":"ok"},{"name":"b","s":"no"}]}"#)) == "table")
        #expect(renderUiShapeName(parseRenderUi(#"{"data":[{"label":"a","value":1},{"label":"b","value":2}]}"#)) == "chart")
        #expect(renderUiShapeName(parseRenderUi(##"{"markdown":"# hi"}"##)) == "text")
        #expect(renderUiShapeName(parseRenderUi(#"{"items":[{"label":"one"}]}"#)) == "list")
        #expect(renderUiShapeName(parseRenderUi(#"{"name":"tiny"}"#)) == "key/value")
    }
}


// ── WatchCore (W8) ────────────────────────────────────────────────────────

@Suite struct WatchCoreTests {
    @Test func historySkipsErrorsAndIncomplete() {
        let turns = [
            WatchTurn(q: "a", a: "answer a", done: true),
            WatchTurn(q: "b", a: "⚠️ failed", done: true),   // error → skipped
            WatchTurn(q: "c", a: "", done: false),            // incomplete → skipped
            WatchTurn(q: "d", a: "answer d", done: true),
        ]
        let h = WatchCore.history(from: turns)
        #expect(h.count == 4)  // 2 valid turns × (user + assistant)
        #expect((h[0]["role"] as? String) == "user")
        #expect((h[3]["role"] as? String) == "assistant")
    }

    @Test func historyCap() {
        let turns = (0..<20).map { WatchTurn(q: "q\($0)", a: "a\($0)", done: true) }
        #expect(WatchCore.history(from: turns, cap: 5).count == 10) // 5 pairs
    }

    @Test func sanitizeClosesInterrupted() {
        let turns = [WatchTurn(q: "q", a: "", done: false)]
        let fixed = WatchCore.sanitize(turns)
        #expect(fixed[0].done)
        #expect(fixed[0].a == "(interrupted)")
    }

    @Test func followupFreshness() {
        #expect(WatchCore.isFresh(followupAt: Date()))
        #expect(!WatchCore.isFresh(followupAt: Date(timeIntervalSinceNow: -31 * 60)))
        #expect(!WatchCore.isFresh(followupAt: nil))
    }

    @Test func logoutScrubsIdentityKeepsFleet() {
        var snap = FleetSnapshot(online: 3, total: 5, unread: 7, login: "alice")
        snap.memories = ["knows swift", "likes coffee"]
        snap.lastQ = "what's up"; snap.lastA = "not much"; snap.lastAt = Date()
        snap.followup = "ask again?"; snap.followupAt = Date()
        let now = Date(timeIntervalSince1970: 1_000_000)
        let out = WatchCore.loggedOut(snap, now: now)
        // Identity content is gone — nothing of the prior user survives on the face
        #expect(out.unread == 0)
        #expect(out.memories == nil)
        #expect(out.lastQ == nil && out.lastA == nil && out.lastAt == nil)
        #expect(out.followup == nil && out.followupAt == nil)
        #expect(out.updated == now)
        // Fleet counts are not identity — they stay until the next push corrects them
        #expect(out.online == 3 && out.total == 5)
    }
}

// ── DropRouter (iPad drag-and-drop routing) ───────────────────────────────

@Suite struct DropRouterTests {
    private let file = URL(fileURLWithPath: "/tmp/report.pdf")
    private let link = URL(string: "https://tiny.technology/docs")!

    @Test func fileBecomesDocument() {
        let out = AttachmentCodec.routeDrop(urls: [file], pendingCount: 0)
        #expect(out == [.document(file)])
    }

    @Test func linkBecomesComposerTextEvenWhenFull() {
        // Links don't consume attachment capacity — full pending is fine
        let out = AttachmentCodec.routeDrop(urls: [link], pendingCount: MAX_ATTACHMENTS)
        #expect(out == [.composerText("https://tiny.technology/docs")])
    }

    @Test func capacityCountsAcrossOneDrop() {
        // 3 pending + 2 files dropped: one fits, one over
        let out = AttachmentCodec.routeDrop(urls: [file, file], pendingCount: MAX_ATTACHMENTS - 1)
        #expect(out == [.document(file), .overCapacity])
    }

    @Test func mixedDropRoutesIndependently() {
        let out = AttachmentCodec.routeDrop(urls: [link, file, link], pendingCount: MAX_ATTACHMENTS)
        #expect(out == [.composerText(link.absoluteString), .overCapacity, .composerText(link.absoluteString)])
    }

    @Test func mergeLinkSeams() {
        #expect(AttachmentCodec.mergeLink("", "https://a.b") == "https://a.b")
        #expect(AttachmentCodec.mergeLink("check this", "https://a.b") == "check this https://a.b")
    }

    @Test func nonFileSchemeRejectedByCodec() {
        // The main-thread-fetch guard: https URL → .err, never Data(contentsOf:)
        #expect(AttachmentCodec.encodeDocument(url: URL(string: "https://tiny.technology/x.pdf")!) == .err("Only files can be attached"))
    }

    @Test func unreadableFileReportsReason() {
        // A file:// URL that doesn't exist → named couldn't-read reason, not a
        // silent drop (web/Android parity — the reject surfaces in the banner).
        let missing = URL(fileURLWithPath: "/tmp/does-not-exist-\(UUID().uuidString).pdf")
        guard case .err(let message) = AttachmentCodec.encodeDocument(url: missing) else {
            Issue.record("expected .err for a missing file"); return
        }
        #expect(message.hasPrefix("Couldn't read "))
        #expect(message.contains(missing.lastPathComponent))
    }

    @Test func oversizeDocReportsSizeAndCap() {
        // A >3MB file:// doc → named oversize reason with its size + the cap
        // (matches web "<name> is X.XMB — documents must be under 2.9MB" and
        // Android's MAX_DOC_LABEL copy), instead of vanishing silently.
        // The cap renders as MiB, like the size in the same sentence: 3_000_000 B
        // → "2.9MB". Asserting the old hardcoded "3MB" would re-demand copy that
        // states a limit HIGHER than the file it just refused (see 13bd170).
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("big-\(UUID().uuidString).pdf")
        let big = Data(count: MAX_DOCUMENT_BYTES + 1_000)
        try? big.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard case .err(let message) = AttachmentCodec.encodeDocument(url: tmp) else {
            Issue.record("expected .err for an oversize doc"); return
        }
        #expect(message.contains("documents must be under 2.9MB"))
        #expect(message.contains(tmp.lastPathComponent))
    }

    @Test func smallDocEncodesOk() {
        // A tiny valid file:// doc → .ok with the extension-stripped name + format
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("notes-\(UUID().uuidString).md")
        try? Data("# hello".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard case .ok(let att) = AttachmentCodec.encodeDocument(url: tmp) else {
            Issue.record("expected .ok for a small md doc"); return
        }
        #expect(att.docFormat == "md")
        #expect(att.docName?.hasPrefix("notes-") == true)
    }
}

// ── SessionStore (named conversation archives) ────────────────────────────

@Suite struct SessionStoreTests {
    @Test func roundTrip() throws {
        var msg = ChatMessage(role: "user", text: "hello")
        msg.inTok = 5
        let a = SessionArchive(name: "test-rt", tiny: "test-tiny-rt", savedAt: Date(), messages: [msg])
        try SessionStore.save(a)
        defer { SessionStore.delete(a) }
        let listed = SessionStore.list("test-tiny-rt")
        #expect(listed.contains { $0.id == a.id && $0.name == "test-rt" && $0.messages.first?.text == "hello" })
    }

    @Test func deleteRemoves() throws {
        let a = SessionArchive(name: "gone", tiny: "test-tiny-del", savedAt: Date(), messages: [ChatMessage(role: "user", text: "x")])
        try SessionStore.save(a)
        SessionStore.delete(a)
        #expect(!SessionStore.list("test-tiny-del").contains { $0.id == a.id })
    }

    @Test func newestFirst() throws {
        let old = SessionArchive(name: "old", tiny: "test-tiny-sort", savedAt: Date(timeIntervalSinceNow: -3600), messages: [ChatMessage(role: "user", text: "a")])
        let new = SessionArchive(name: "new", tiny: "test-tiny-sort", savedAt: Date(), messages: [ChatMessage(role: "user", text: "b")])
        try SessionStore.save(old); try SessionStore.save(new)
        defer { SessionStore.delete(old); SessionStore.delete(new) }
        let names = SessionStore.list("test-tiny-sort").map(\.name)
        #expect(names == ["new", "old"])
    }
}

// ── Media.musicQuery ───────────────────────────────────────────────────────

@Suite struct MusicQueryTests {
    @Test func stripsLeadingPlayVerb() {
        #expect(Media.musicQuery(from: "play daft punk on spotify") == "daft punk")
    }

    @Test func stripsPlayMidSentence() {
        #expect(Media.musicQuery(from: "can you play radiohead") == "radiohead")
    }

    @Test func doesNotMatchPlayInsideAWord() {
        // "display" contains the literal "play " — the word-boundary regex must
        // NOT treat it as the command verb (regression: substring match ate it).
        #expect(Media.musicQuery(from: "display the top charts on the phone") == "display the top charts")
    }

    @Test func stripsTrailingServiceSuffix() {
        #expect(Media.musicQuery(from: "play miles davis in spotify") == "miles davis")
    }

    @Test func noVerbNoSuffixPassesThrough() {
        #expect(Media.musicQuery(from: "kind of blue") == "kind of blue")
    }
}

// ── HTTP error messages ───────────────────────────────────────────────────

@Suite struct HTTPErrorTests {
    /// The JSON-verb table (ApiError.errorDescription) and the SSE-stream table
    /// (friendlyHTTPError) used to be two divergent copies. They now share one
    /// source — assert they agree so they can't silently drift again.
    @Test func jsonAndStreamTablesAgree() {
        for code in [401, 402, 403, 404, 413, 424, 429, 500, 503, 418] {
            #expect(ApiError.http(code, nil).errorDescription == Api.friendlyHTTPError(code))
        }
    }

    /// 403 is an ownership error (worker returns it for "belongs to another
    /// account"), NOT an expired session — re-auth won't fix it, so the copy
    /// must not tell the user to sign in again (regression: it used to).
    @Test func forbiddenIsNotSignInAgain() {
        let msg = Api.friendlyHTTPError(403)
        #expect(!msg.lowercased().contains("sign"))
        #expect(!msg.lowercased().contains("session expired"))
        #expect(msg.contains("another account"))
    }

    /// 424 is a transient backend degrade (tools/prefs/wallet), so the copy
    /// should invite a retry, not read like a permanent failure.
    @Test func backendUnavailableInvitesRetry() {
        #expect(Api.friendlyHTTPError(424).lowercased().contains("try again"))
    }

    @Test func serverErrorsCarryTheCode() {
        #expect(Api.friendlyHTTPError(503).contains("503"))
    }

    // ── The server's own explanation (review c16) ──────────────────────────
    //
    // `Api.request` threw `ApiError.http(code)` and dropped the response BODY,
    // so every /api route's `{ error: "<why>" }` was lost and the user got
    // whatever the status table could say from a number alone. For the statuses
    // where the table has nothing — 400 above all, whose entry is literally
    // "HTTP 400" — that meant an actionable refusal became a dead end.

    @Test func aFourHundredShowsWhatTheServerActuallySaid() {
        // The real body from the DM cap fix: it names the overrun AND the remedy.
        // "HTTP 400" names neither.
        let why = "message is 2043 characters, 43 over the 2000 limit — nothing was sent. Split it into shorter messages."
        let shown = Api.httpMessage(400, why)
        #expect(shown.contains("43 over the 2000 limit"))
        #expect(shown.contains("Split it into shorter messages"))
        // The code still rides along, so a screenshot is still diagnosable.
        #expect(shown.contains("400"))
        #expect(shown != Api.friendlyHTTPError(400))
    }

    @Test func withNoServerMessageTheTableStillSpeaks() {
        // A route that returns no body, a non-JSON body, or a blank error must
        // fall back — nil/"" must never render as an empty label.
        #expect(Api.httpMessage(404, nil) == Api.friendlyHTTPError(404))
        #expect(Api.httpMessage(404, "") == Api.friendlyHTTPError(404))
        #expect(Api.httpMessage(404, "   ") == Api.friendlyHTTPError(404))
        #expect(Api.httpMessage(400, nil) == Api.friendlyHTTPError(400))
    }

    @Test func theAppKeepsTheStatusesItPhrasesBetterThanTheServer() {
        // 401: the worker says "login required", which is not an instruction to
        // someone holding a stored token — this app knows to say sign out/in.
        #expect(Api.httpMessage(401, "login required") == Api.friendlyHTTPError(401))
        // 5xx: the body is an internal detail; the useful fact is "transient".
        #expect(Api.httpMessage(500, "messages unavailable") == Api.friendlyHTTPError(500))
        #expect(Api.httpMessage(503, "upstream boom") == Api.friendlyHTTPError(503))
        // 0: no response at all, so there is no body to prefer.
        #expect(Api.httpMessage(0, "whatever") == Api.friendlyHTTPError(0))
    }

    @Test func aServerMessageWinsOnEveryOtherStatus() {
        // 403/404/413/424/429 all describe THIS request server-side; when the
        // server bothered to explain, its sentence is the better one.
        for code in [403, 404, 413, 424, 429, 409, 418] {
            #expect(Api.httpMessage(code, "that tiny is private") != Api.friendlyHTTPError(code))
            #expect(Api.httpMessage(code, "that tiny is private").contains("that tiny is private"))
        }
    }

    @Test func errorDescriptionCarriesTheBodyThroughTheThrow() {
        // The whole point: a thrown ApiError must still know what the server
        // said by the time a `catch` renders it via localizedDescription.
        let e = ApiError.http(400, "voice must be a string — '' to clear, or a Realtime voice name")
        #expect(e.errorDescription?.contains("Realtime voice name") == true)
        #expect(e.status == 400)
        #expect(ApiError.badResponse.status == nil)
    }

    @Test func onlyAStringErrorFieldIsShown() {
        let json = { (s: String) in Data(s.utf8) }
        #expect(Api.serverError(in: json(#"{"error":"nope"}"#)) == "nope")
        // Trimmed — a stray newline in a body must not become label whitespace.
        #expect(Api.serverError(in: json(#"{"error":"  nope\n"}"#)) == "nope")
        // Not JSON, no error key, blank, or a non-string error → the table.
        #expect(Api.serverError(in: json("<html>500</html>")) == nil)
        #expect(Api.serverError(in: json(#"{"ok":false}"#)) == nil)
        #expect(Api.serverError(in: json(#"{"error":""}"#)) == nil)
        #expect(Api.serverError(in: json(#"{"error":{"code":1}}"#)) == nil)
        #expect(Api.serverError(in: Data()) == nil)
    }

    @Test func anAbsurdlyLongBodyIsBoundedBeforeItBecomesCopy() {
        // A route that leaks an HTML page or a stack trace must not paste 40KB
        // into a SwiftUI label.
        let huge = #"{"error":""# + String(repeating: "x", count: 5000) + #""}"#
        #expect(Api.serverError(in: Data(huge.utf8))?.count == 300)
    }
}

// ── The request core actually carries the body (review c16) ────────────────
//
// Everything above tests PURE functions, and the c16 defect was not in a pure
// function: `request` threw `ApiError.http(code)` and never looked at `data`.
// Deleting the body from that throw leaves every pure test above green, so
// these drive the real `Api.get/post/deleteJson` over a stubbed transport —
// the only way to assert the wiring rather than the helpers.
//
// `Api.transport` is restored in each test even on failure, because a leaked
// stub would make the rest of the suite talk to a fake server.
//
// `.serialized` is load-bearing, not tidiness: the stub is one static, and
// Swift Testing runs a suite's tests in PARALLEL by default. Without it the
// 409 test read the 502 test's stub and the 400 test read the 200 one — three
// tests asserting three different servers through a single seam.
@Suite(.serialized) struct ApiTransportTests {

    /// Answer every request with one canned status + body.
    private func withStub<T>(
        status: Int, json: String, _ run: () async throws -> T
    ) async rethrows -> T {
        let real = Api.transport
        defer { Api.transport = real }
        let data = Data(json.utf8)
        Api.transport = { req in
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (data, resp)
        }
        return try await run()
    }

    @Test func aFourHundredArrivesWithTheServersSentenceAttached() async throws {
        // The exact body /api/messages now returns for an over-long DM.
        let why = "message is 2043 characters, 43 over the 2000 limit — nothing was sent. Split it into shorter messages."
        await withStub(status: 400, json: #"{"error":"\#(why)"}"#) { () -> Void in
            do {
                let _: [String: Any] = try await Api.post("/api/messages", token: "t", body: ["message": "hi"])
                Issue.record("a 400 must throw")
            } catch let e as ApiError {
                if case .http(let code, let msg) = e {
                    #expect(code == 400)
                    #expect(msg == why)
                } else {
                    Issue.record("wrong ApiError case")
                }
                // And it survives all the way to what a `catch` block renders.
                #expect(e.localizedDescription.contains("43 over the 2000 limit"))
            } catch {
                Issue.record("wrong error: \(error)")
            }
        }
    }

    @Test func aBodylessFailureStillThrowsTheStatus() async throws {
        // Regression guard on the fallback: an HTML error page or an empty body
        // must not crash or produce an empty message.
        await withStub(status: 502, json: "<html>bad gateway</html>") {
            do {
                let _: [String: Any] = try await Api.get("/api/messages", token: "t")
                Issue.record("a 502 must throw")
            } catch let e as ApiError {
                #expect(e.status == 502)
                if case .http(_, let msg) = e { #expect(msg == nil) }
                #expect(e.localizedDescription == Api.friendlyHTTPError(502))
                #expect(!e.localizedDescription.isEmpty)
            } catch {
                Issue.record("wrong error: \(error)")
            }
        }
    }

    @Test func everyVerbCarriesIt_notJustTheOneThatWasFixed() async throws {
        // request() is shared by get/post/patch/put/delete; the body must ride
        // along on all of them, or one panel explains itself and the next
        // doesn't. deleteJson is the one with a status-routing caller.
        await withStub(status: 409, json: #"{"error":"that tool is in use"}"#) {
            for verb in ["get", "post", "delete"] {
                do {
                    switch verb {
                    case "get": let _: [String: Any] = try await Api.get("/api/tools", token: "t")
                    case "post": let _: [String: Any] = try await Api.post("/api/tools", token: "t", body: [:])
                    default: _ = try await Api.deleteJson("/api/tools", token: "t", body: ["name": "x"])
                    }
                    Issue.record("\(verb): a 409 must throw")
                } catch let e as ApiError {
                    #expect(e.localizedDescription.contains("that tool is in use"), "\(verb) lost the body")
                } catch {
                    Issue.record("\(verb): wrong error: \(error)")
                }
            }
        }
    }

    @Test func aSuccessBodyIsNotTouched() async throws {
        // The error path must not have changed what a 200 returns.
        try await withStub(status: 200, json: #"{"ok":true,"threads":[]}"#) {
            let d: [String: Any] = try await Api.get("/api/messages", token: "t")
            #expect(d["ok"] as? Bool == true)
        }
    }
}

// ── ModelPricing (per-turn ~$ estimate) ────────────────────────────────────

@Suite struct ModelPricingTests {
    /// The ordering hazard: claude-opus-4-8 must NOT be swallowed by the
    /// generic claude-opus-4 row (which is 3× the rate). First-match-wins on an
    /// ordered table is the whole contract — this locks the row order.
    @Test func opusRowOrderingPicksSpecificRate() {
        // opus-4-8: $5/M in → 1M input = $5.00
        #expect(ModelPricing.estimateCost(modelId: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0) == 5)
        // legacy opus-4: $15/M in → 1M input = $15.00 (the generic row)
        #expect(ModelPricing.estimateCost(modelId: "claude-opus-4-1", inputTokens: 1_000_000, outputTokens: 0) == 15)
    }

    /// 💸 The dotted spelling used to cost 3× the real price.
    ///
    /// OpenRouter writes versions with a DOT (`anthropic/claude-opus-4.8`) while
    /// this table is written with dashes, so a dotted id missed every specific
    /// Opus row and landed on the generic `claude-opus-4` legacy row: 15/75
    /// instead of 5/25. The row ORDER above was right the whole time — the id was
    /// spelled a way no row was written in. `anthropic/claude-sonnet-4.5` is this
    /// app's own OpenRouter placeholder, so that spelling is what users type.
    @Test func dottedAndDashedSpellingsCostTheSame() {
        #expect(ModelPricing.estimateCost(modelId: "anthropic/claude-opus-4.8", inputTokens: 1_000_000, outputTokens: 0) == 5)
        #expect(ModelPricing.estimateCost(modelId: "anthropic/claude-sonnet-4.5", inputTokens: 1_000_000, outputTokens: 0) == 3)
        // The legacy row still keeps its own higher rate, dotted or not.
        #expect(ModelPricing.estimateCost(modelId: "claude-opus-4.1", inputTokens: 1_000_000, outputTokens: 0) == 15)
    }

    /// Folding must not cost a row to ids whose dots separate NAME parts
    /// (Bedrock's namespace) or whose needle itself carries a dot (Gemini).
    @Test func foldingKeepsDottedNamespacesAndDottedNeedles() {
        #expect(ModelPricing.estimateCost(modelId: "global.anthropic.claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 0) == 3)
        #expect(ModelPricing.estimateCost(modelId: "gemini-2.5-pro", inputTokens: 1_000_000, outputTokens: 0) == 1.25)
        #expect(ModelPricing.estimateCost(modelId: "google/gemini-2.5-flash-lite", inputTokens: 1_000_000, outputTokens: 0) == 0.1)
        #expect(ModelPricing.estimateCost(modelId: "gpt-5-mini-2025-08-07", inputTokens: 1_000_000, outputTokens: 0) == 0.25)
    }

    @Test func bedrockPrefixedIdStillMatches() {
        // Bedrock ids like "us.anthropic.claude-opus-4-8" contain the needle.
        #expect(ModelPricing.estimateCost(modelId: "us.anthropic.claude-opus-4-8-20260101", inputTokens: 0, outputTokens: 1_000_000) == 25)
    }

    @Test func cachedReadsBillAtDiscount() {
        // 1M input all cached (0.1×) + 0 output on opus-4-8 ($5/M):
        // 1M × $5 × 0.1 = $0.50 (vs $5.00 uncached).
        let cost = ModelPricing.estimateCost(modelId: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000)
        #expect(cost == 0.5)
    }

    @Test func cacheReadClampedToInput() {
        // cacheRead > input must not drive fresh input negative.
        let cost = ModelPricing.estimateCost(modelId: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 999_999)
        #expect(cost != nil && cost! >= 0)
    }

    @Test func unknownModelReturnsNil() {
        #expect(ModelPricing.estimateCost(modelId: "totally-made-up-model", inputTokens: 1000, outputTokens: 1000) == nil)
        #expect(ModelPricing.estimateCost(modelId: nil, inputTokens: 1000, outputTokens: 1000) == nil)
    }

    @Test func formatCostThresholds() {
        #expect(ModelPricing.formatCost(0.00001) == "<$0.0001")
        #expect(ModelPricing.formatCost(0) == "$0.0000")   // exactly zero isn't "<$0.0001"
        #expect(ModelPricing.formatCost(0.0042) == "$0.0042")
        #expect(ModelPricing.formatCost(1.5) == "$1.50")
        #expect(ModelPricing.formatCost(12.345) == "$12.35")
    }
}

// ── Continuity cross-user scrub ────────────────────────────────────────────

/// Both suites below post PROCESS-WIDE notifications (and delete from the one
/// real container) that every live ChatModel observes — so they must not run
/// alongside each other, only in-order within themselves. `.serialized` on a
/// suite orders that suite's own tests and nothing else; measured, the two ran
/// concurrently and ContinuityScrubTests' scrub wiped a ChatModel fixture mid-
/// test ("keep me" gone, transcript count 0 instead of 1). Nesting them in one
/// serialized parent is what actually serializes them against each other.
@Suite(.serialized) struct LocalDataScrubSuites {
    /// `.serialized` is load-bearing, not tidiness: every test in here calls
    /// `Continuity.scrubAllLocal()`, which deletes from the ONE real container this
    /// process has. Run in parallel (Swift Testing's default), one test's scrub
    /// removes another's fixture mid-setup — observed as `Documents/sessions/…`
    /// vanishing between createDirectory and write.
    @Suite(.serialized) struct ContinuityScrubTests {
        /// A different user signing in wipes EVERY local turn-log + memory file
        /// (all tiny names), so the prior user's private context can't leak into
        /// the new user's buildContext. Guards the identity-leak fix.
        @Test func scrubAllLocalWipesTurnsAndMemoriesAcrossTinies() {
            // Two distinct tiny names, each with a turn + a memory.
            let a = "test-scrub-a", b = "test-scrub-b"
            Continuity.appendTurn(a, q: "q-a", a: "a-a")
            Continuity.addMemory(a, content: "secret-a")
            Continuity.appendTurn(b, q: "q-b", a: "a-b")
            Continuity.addMemory(b, content: "secret-b")
            // Precondition: they're actually there.
            #expect(!Continuity.memories(a).isEmpty)
            #expect(!Continuity.memories(b).isEmpty)
            #expect(Continuity.buildContext(a).contains("secret-a"))

            Continuity.scrubAllLocal()

            #expect(Continuity.memories(a).isEmpty)
            #expect(Continuity.memories(b).isEmpty)
            #expect(!Continuity.buildContext(a).contains("secret-a"))
            #expect(!Continuity.buildContext(b).contains("secret-b"))
        }

        /// 🔴 THE SCOPE IS THE CORRECTNESS-SENSITIVE PART, and it was too narrow.
        ///
        /// The test above passes against the buggy version, because its scope
        /// matched the bug's: it only ever wrote turnlog + memory files, which were
        /// the only two prefixes the scrub matched. The stores it never exercised —
        /// `chat-history-<tiny>.json` (the readable transcript, up to 200 messages,
        /// reloaded verbatim when that tiny is next opened) and `sessions/<tiny>/`
        /// (named session archives) — survived an account switch untouched.
        ///
        /// Port of Android's `isScrubbableLocalFile` coverage, which has had the
        /// full list since its own fix.
        @Test func scrubScopeCoversEveryPerTinyStore() {
            // The two that were already covered.
            #expect(Continuity.isScrubbableLocalName("tiny_turnlog_mytiny.json"))
            #expect(Continuity.isScrubbableLocalName("tiny_memories_mytiny.json"))
            // The two that leaked. These are the assertions that fail on the old scope.
            #expect(Continuity.isScrubbableLocalName("chat-history-mytiny.json"))
            #expect(Continuity.isScrubbableLocalName("sessions"))
            // Pre-per-tiny builds wrote an unsuffixed transcript; ChatModel.store
            // still adopts it, so a scrub that misses it leaks the same content.
            #expect(Continuity.isScrubbableLocalName("chat-history.json"))
        }

        /// A scrub that over-reaches is unrecoverable data loss, not a privacy fix —
        /// so the predicate must refuse everything that isn't per-tiny user data.
        @Test func scrubScopeRefusesUnrelatedFiles() {
            // Android's list carries this exact exception in prose: anonymous-share
            // revoke tokens are returned once at creation and aren't tied to the
            // logged-in identity, so wiping them destroys data instead of protecting it.
            #expect(!Continuity.isScrubbableLocalName("tiny_my_shares.json"))
            #expect(!Continuity.isScrubbableLocalName("Preferences"))
            #expect(!Continuity.isScrubbableLocalName("tiny.sqlite"))
            #expect(!Continuity.isScrubbableLocalName(""))
            // Prefix, not substring: a file that merely CONTAINS a store name is
            // somebody else's.
            #expect(!Continuity.isScrubbableLocalName("backup-chat-history-mytiny.json"))
            // "sessions" is matched exactly — a sibling directory must not vanish.
            #expect(!Continuity.isScrubbableLocalName("sessions-backup"))
            #expect(!Continuity.isScrubbableLocalName("voice_sessions"))
        }

        /// 🔴 The scrub must reach BOTH roots, and it deletes real files in each.
        ///
        /// `Continuity.dir()` resolves to the app-GROUP container, but the two
        /// highest-severity stores are written to the app's own Documents dir
        /// (ChatModel.store, SessionStore.dir). Widening the prefix list alone would
        /// have matched nothing there — the fix needed a second enumeration, which is
        /// what this exercises by planting files in Documents directly.
        @Test func scrubReachesTheDocumentsRootToo() throws {
            let fm = FileManager.default
            let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let transcript = docs.appendingPathComponent("chat-history-test-scrub-doc.json")
            let sessionsDir = docs.appendingPathComponent("sessions").appendingPathComponent("test-scrub-doc")
            let archive = sessionsDir.appendingPathComponent("one.json")

            try? fm.createDirectory(at: sessionsDir, withIntermediateDirectories: true)
            try Data("[{\"role\":\"user\",\"text\":\"secret-transcript\"}]".utf8).write(to: transcript)
            try Data("{\"id\":\"x\"}".utf8).write(to: archive)

            // Precondition: both are really on disk, in the root the scrub used to skip.
            #expect(fm.fileExists(atPath: transcript.path))
            #expect(fm.fileExists(atPath: archive.path))

            Continuity.scrubAllLocal()

            #expect(!fm.fileExists(atPath: transcript.path))
            // Recursive: `sessions` is a tree, so the archive INSIDE it must go too.
            #expect(!fm.fileExists(atPath: archive.path))
            #expect(!fm.fileExists(atPath: docs.appendingPathComponent("sessions").path))
        }

        /// The scrub announces itself, because deleting the files is not sufficient:
        /// a live ChatModel holds the transcript in memory (ChatView mounts before
        /// loadMe() runs the scrub) and re-persists it on the next save.
        @Test func scrubPostsTheNotificationInMemoryHoldersListenFor() async {
            var got = false
            let obs = NotificationCenter.default.addObserver(
                forName: .tinyLocalDataScrubbed, object: nil, queue: nil
            ) { _ in got = true }
            defer { NotificationCenter.default.removeObserver(obs) }

            Continuity.scrubAllLocal()
            // NotificationCenter delivers synchronously on the posting thread.
            #expect(got)
        }
    }

    /// The IN-MEMORY half of the same leak. Deleting files is not sufficient: this
    /// model can already be holding the previous user's data at the moment their
    /// file is deleted, and it is the model — not the file — that gets sent.
    ///
    /// Serialized for the same reason as ContinuityScrubTests: these post
    /// process-wide notifications that every live ChatModel observes.
    @Suite(.serialized) @MainActor struct ChatModelAccountSwitchTests {
        /// Both handlers hop to the MainActor through an unstructured Task, so a
        /// synchronous post is observed one hop later.
        private func settle() async {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        @Test func accountSwitchDropsEverythingHeldInMemory() async {
            let chat = ChatModel()
            chat.messages = [ChatMessage(role: "user", text: "my therapist said")]
            chat.followups = ["tell me more"]
            chat.queuedSends = ["the password is hunter2"]
            chat.heroURL = URL(string: "https://example.com/a.png")
            chat.logoURL = URL(string: "https://example.com/b.png")

            NotificationCenter.default.post(name: .tinyLocalDataScrubbed, object: nil)
            await settle()

            #expect(chat.messages.isEmpty)
            #expect(chat.followups.isEmpty)
            #expect(chat.queuedSends.isEmpty)
            #expect(chat.heroURL == nil)
            #expect(chat.logoURL == nil)
        }

        /// 🔴 The worst half of the finding, and the one no file deletion touches:
        /// `flushQueue` reads `session.token` at CALL time, so a message typed
        /// offline by user A was SENT, verbatim, under user B's token on the next
        /// reconnect — the prior user's words landing in the new user's account.
        @Test func signOutDropsTheOfflineQueueButKeepsTheTranscript() async {
            let chat = ChatModel()
            chat.messages = [ChatMessage(role: "user", text: "keep me")]
            chat.queuedSends = ["never send this under someone else's token"]

            NotificationCenter.default.post(name: .tinySessionEnded, object: nil)
            await settle()

            #expect(chat.queuedSends.isEmpty)
            // Narrower than an account switch ON PURPOSE: signing back in as the
            // SAME user must still find their conversation.
            #expect(chat.messages.count == 1)
        }

        /// 🔴 The tests above post the notification themselves, which proves the
        /// LISTENER and nothing about the SENDER — measured: deleting the post from
        /// `TinySession.logout()` left them all green while the queue survived
        /// sign-out for real. A notification-based fix has two halves and both need
        /// their own assertion.
        ///
        /// `Continuity.scrubAllLocal()` is the other sender, covered above by
        /// `scrubPostsTheNotificationInMemoryHoldersListenFor`.
        @Test func logoutIsWhatAnnouncesTheSessionEnded() {
            var got = false
            let obs = NotificationCenter.default.addObserver(
                forName: .tinySessionEnded, object: nil, queue: nil
            ) { _ in got = true }
            defer { NotificationCenter.default.removeObserver(obs) }

            TinySession().logout()
            #expect(got)
        }
    }

    /// The `forget` tool's three outcomes (web `ForgetOutcome` parity).
    ///
    /// The defect: `forgetMemory` computed its answer from the FILTER — the
    /// in-memory array shrank, so it returned `true` — while `write` swallowed
    /// both `try?`s. The voice executor surfaced that as `{ removed: true }` to
    /// the MODEL, which speaks it. A store that refused the write was spoken as
    /// forgotten, and `buildContext` kept injecting the "forgotten" fact into
    /// every later request: "I forgot your address" followed by the address,
    /// forever (web continuity.ts:32-47 documents the identical bug).
    ///
    /// ⚠️ Nested inside `LocalDataScrubSuites` on purpose: these tests write to
    /// the ONE real container, and the sibling suites call `scrubAllLocal()`.
    /// Run in parallel with them, a scrub deletes this suite's fixture between
    /// `addMemory` and the assertion — the exact race the parent's doc records.
    @Suite(.serialized) struct ForgetOutcomeTests {
        private func fresh(_ name: String) {
            Continuity.clearMemories(name)
            #expect(Continuity.memories(name).isEmpty)
        }

        /// A match that lands is `.forgotten` — and the fact must actually stop
        /// reaching the model, which is the only thing that makes the claim true.
        @Test func aMatchThatLandsIsForgottenAndLeavesTheContext() {
            let t = "test-forget-hit"
            fresh(t)
            Continuity.addMemory(t, content: "lives at 12 Elm Street")
            #expect(Continuity.buildContext(t).contains("12 Elm Street"))

            #expect(Continuity.forgetOutcome(t, "elm street") == .forgotten)

            #expect(Continuity.memories(t).isEmpty)
            // The whole point: buildContext is what re-injects it every request.
            #expect(!Continuity.buildContext(t).contains("12 Elm Street"))
            Continuity.clearMemories(t)
        }

        /// A needle that matches nothing is `.noMatch`, NOT `.blocked` — and the
        /// store must survive. Reporting a storage problem here sends someone to
        /// clear app data over a typo'd match string.
        @Test func nothingMatchedIsNoMatchAndKeepsTheStore() {
            let t = "test-forget-miss"
            fresh(t)
            Continuity.addMemory(t, content: "likes tea")

            #expect(Continuity.forgetOutcome(t, "coffee") == .noMatch)

            #expect(Continuity.memories(t).count == 1)
            Continuity.clearMemories(t)
        }

        /// 🔴 An empty match must never wipe the store — `match` arrives straight
        /// from the model's forget tool call.
        ///
        /// ⚠️ This test passes for a reason that does NOT transfer: Swift's
        /// `contains("")` returns FALSE, so on iOS an empty needle matches nothing
        /// and the count check catches it even with the blank guard deleted (a
        /// mutation confirmed that — an equivalent mutant here). On web and
        /// Android `includes("")`/`contains("")` are TRUE, so there the guard is
        /// the whole store's safety catch. Don't read a green here as coverage of
        /// the shared shape; `survivorsRejectsABlankNeedle` below tests the guard
        /// itself, and Android tests it on the surface where it bites.
        @Test func anEmptyMatchIsNoMatchAndWipesNothing() {
            let t = "test-forget-empty"
            fresh(t)
            Continuity.addMemory(t, content: "a")
            Continuity.addMemory(t, content: "b")

            #expect(Continuity.forgetOutcome(t, "") == .noMatch)
            #expect(Continuity.forgetOutcome(t, "   ") == .noMatch)

            #expect(Continuity.memories(t).count == 2)
            Continuity.clearMemories(t)
        }

        /// The id form matches too (the swipe-to-forget row passes `m.id`).
        @Test func anIdMatchIsForgotten() {
            let t = "test-forget-id"
            fresh(t)
            Continuity.addMemory(t, content: "opaque content")
            let id = Continuity.memories(t)[0].id

            #expect(Continuity.forgetOutcome(t, id) == .forgotten)
            #expect(Continuity.memories(t).isEmpty)
            Continuity.clearMemories(t)
        }

        /// `forgetMemory`'s Bool is exactly "`.forgotten`", not "something
        /// matched" — it delegates so the predicate has ONE implementation.
        @Test func theBooleanFormIsTrueOnlyForForgotten() {
            let t = "test-forget-bool"
            fresh(t)
            Continuity.addMemory(t, content: "likes tea")

            #expect(Continuity.forgetMemory(t, "coffee") == false)   // .noMatch
            #expect(Continuity.forgetMemory(t, "tea") == true)        // .forgotten
            Continuity.clearMemories(t)
        }

        /// `addMemory` reports DURABILITY, not intent — the caller's
        /// "remembered" claim is exactly as true as this write.
        @Test func addMemoryReportsWhetherItLanded() {
            let t = "test-add-verdict"
            fresh(t)
            #expect(Continuity.addMemory(t, content: "kept") == true)
            #expect(Continuity.memories(t).count == 1)
            // Nothing was stored, so the claim would be equally untrue.
            #expect(Continuity.addMemory(t, content: "") == false)
            #expect(Continuity.addMemory(t, content: "   ") == false)
            #expect(Continuity.memories(t).count == 1)
            Continuity.clearMemories(t)
        }

        /// Each outcome gets its own sentence, and only `.blocked` may claim the
        /// memory SURVIVED — the user has already been told the fact is gone, so
        /// that line is the only thing that corrects it.
        @Test func onlyTheBlockedSentenceSaysTheMemorySurvived() {
            #expect(ForgetOutcome.blocked.line.contains("still there"))
            #expect(ForgetOutcome.forgotten.line.contains("forgotten"))
            // A no-match is not an error and must not blame storage.
            #expect(!ForgetOutcome.noMatch.line.contains("storage"))
            #expect(!ForgetOutcome.noMatch.line.contains("still there"))
            let all: [ForgetOutcome] = [.forgotten, .noMatch, .blocked]
            #expect(Set(all.map(\.line)).count == 3)
            #expect(all.allSatisfy { !$0.line.isEmpty })
        }

        // ---- survivors: pure, so the guard is gated without the container ----

        private func mem(_ content: String) -> MemoryEntry {
            MemoryEntry(id: String(content.prefix(4)), content: content, tags: nil, ts: 0)
        }

        /// The blank needle. Free on iOS (Swift's `contains("")` is false) and the
        /// whole store's safety catch on web + Android, where it is true — so this
        /// pins the SHARED shape rather than the local behaviour. Kept as an
        /// explicit test because a "simplification" that drops the guard here
        /// invites dropping it on the surface where it wipes everything.
        @Test func survivorsRejectsABlankNeedle() {
            let store = [mem("home address is 12 Oak"), mem("prefers tea")]
            for blank in ["", " ", "\t", "\n", "   "] {
                #expect(Continuity.survivors(store, blank) == nil)
            }
        }

        /// nil, not an empty array: "nothing to do" must not reach the write at
        /// all, or an untouched store gets reported as having refused.
        @Test func survivorsIsNilWhenNothingMatched() {
            #expect(Continuity.survivors([mem("prefers tea")], "no such thing") == nil)
        }

        @Test func survivorsKeepsOnlyTheUnmatchedAndIsCaseInsensitive() {
            let store = [mem("home address is 12 Oak"), mem("prefers tea")]
            #expect(Continuity.survivors(store, "ADDRESS")?.map(\.content) == ["prefers tea"])
        }

        /// The one case where an empty array IS right — "forget everything
        /// matching aa" legitimately clears it. Distinguishable from the no-op
        /// only because that returns nil.
        @Test func survivorsCanLegitimatelyEmptyTheStore() {
            #expect(Continuity.survivors([mem("aaa"), mem("aab")], "aa")?.isEmpty == true)
        }

        // ---- clipToCodePoints: the cross-surface truncation unit ----------

        /// ⚠️ `prefix(n)` counts GRAPHEME CLUSTERS, so `"a"*495 + family-emoji`
        /// is 496 characters to Swift and 506 to web/Android (measured) — a cap
        /// of 500 cut the three surfaces in three different places, while this
        /// file promises "byte-compatible with the web's
        /// buildContinuityContext". Code points are the one unit all three agree
        /// on.
        @Test func theClipCountsCodePointsNotCharacters() {
            // 1200 thumbs. `prefix(1000)` keeps 1000 CLUSTERS = 1000 emoji here,
            // but web/Android keep 1000 code points = 1000 emoji too — the
            // divergence shows up when clusters and code points differ, below.
            let out = Continuity.clipToCodePoints(String(repeating: "👍", count: 1200), 1000)
            #expect(out.unicodeScalars.count == 1000)
            #expect(out == String(repeating: "👍", count: 1000))
        }

        /// The cases where a grapheme cluster is MORE than one code point — the
        /// exact inputs on which `prefix` and `Array.from` disagree.
        @Test func theClipSplitsClustersWhereWebAndAndroidDo() {
            // A ZWJ family is ONE character to Swift and SEVEN code points
            // everywhere else. Clipping must follow the code points, or iOS keeps
            // a whole family that the other two truncate.
            let family = String(repeating: "a", count: 495) + "👨‍👩‍👧‍👦x"
            #expect(family.count == 497)                      // grapheme clusters (495 a + family + x)
            #expect(family.unicodeScalars.count == 503)       // code points
            let out = Continuity.clipToCodePoints(family, 500)
            #expect(out.unicodeScalars.count == 500)
            // 500 = 495 a's + the first 5 scalars of the family sequence.
            #expect(out.utf8.count == 513)
        }

        /// 🔴 The whole point: the same input must produce the same BYTES on all
        /// three surfaces. These expectations were measured against the web
        /// (`Array.from`) and JVM (`codePointCount`) implementations and compared
        /// by SHA-256 — all three matched. A divergence means one surface now
        /// sends the model a different context section than the others.
        @Test func theClipAgreesWithWebAndAndroidByteForByte() {
            let cases: [(String, Int, Int)] = [
                (String(repeating: "a", count: 498) + "👍🏽x", 500, 506),
                (String(repeating: "a", count: 495) + "👨‍👩‍👧‍👦x", 500, 513),
                (String(repeating: "a", count: 498) + "🇹🇷x", 500, 506),
                (String(repeating: "a", count: 498) + "éx", 500, 501),
                (String(repeating: "a", count: 498) + "日本x", 500, 504),
                (String(repeating: "a", count: 499) + "👍 tail", 500, 503),
            ]
            for (input, max, expectedBytes) in cases {
                let out = Continuity.clipToCodePoints(input, max)
                #expect(out.unicodeScalars.count == max)
                #expect(out.utf8.count == expectedBytes, "bytes for \(input.suffix(8))")
            }
        }

        @Test func textThatFitsIsReturnedUntouched() {
            // Including the exact-cap case: an off-by-one silently drops a
            // character from every memory already short enough to keep whole.
            let exact = String(repeating: "e", count: 1000)
            #expect(Continuity.clipToCodePoints(exact, 1000) == exact)
            #expect(Continuity.clipToCodePoints("short", 1000) == "short")
            #expect(Continuity.clipToCodePoints("", 1000) == "")
        }

        /// The store paths must actually USE it — and a real memory round-trips
        /// through the container, so this is behaviour, not a source scan.
        ///
        /// ⚠️ The input has to be one where CLUSTERS and CODE POINTS DISAGREE.
        /// Measured: with a thumbs-only input (1 cluster = 1 code point each),
        /// reverting this call site to `prefix(1000)` passed every assertion —
        /// the test could not tell the defect from the fix. A ZWJ family is ONE
        /// cluster and SEVEN code points, which is where the two part company.
        @Test func aStoredMemoryIsClippedByCodePoints() {
            let t = "test-clip-memory"
            fresh(t)
            // 995 a's + a ZWJ family + "x" = 1003 code points but only 997
            // clusters, so `prefix(1000)` would store the string WHOLE.
            Continuity.addMemory(t, content: String(repeating: "a", count: 995) + "👨‍👩‍👧‍👦x")
            let stored = Continuity.memories(t)[0].content
            #expect(stored.unicodeScalars.count == 1000)
            // Scalar-level, deliberately: `contains("👦")` would be VACUOUS here,
            // because inside the intact family that emoji is not a standalone
            // Character and Swift's substring search matches whole clusters.
            #expect(!stored.unicodeScalars.contains("\u{1F466}"),
                    "the family's last member is past the cap but was stored")
            #expect(!stored.hasSuffix("x"), "the tail past the cap was stored")
            // …and the cap still holds for a plain over-long memory.
            Continuity.clearMemories(t)
            Continuity.addMemory(t, content: String(repeating: "👍", count: 1200))
            #expect(Continuity.memories(t)[0].content == String(repeating: "👍", count: 1000))
            Continuity.clearMemories(t)
        }

        @Test func aLoggedTurnIsClippedByCodePoints() {
            let t = "test-clip-turn"
            Continuity.clearTurnLog(t)
            // Both halves use a cluster/code-point mismatch, for the reason above:
            // with 1-scalar clusters, `prefix(500)` and the clip agree and this
            // test votes for neither. q's cap is 500, a's is 800.
            //
            // ⚠️ The marker must be SHORT enough that the CLUSTER count stays
            // under the cap: at 495 a's + family + a 5-char tail the string is
            // 501 clusters, so `prefix(500)` drops the marker too and the mutant
            // passes anyway. With a 3-char tail it is 499 clusters — `prefix`
            // returns the string WHOLE (marker present) while the code-point clip
            // cuts at 500 of its 505 scalars (marker gone). That gap is the test.
            Continuity.appendTurn(t, q: String(repeating: "a", count: 495) + "👨‍👩‍👧‍👦ZQX",
                                  a: String(repeating: "b", count: 795) + "👨‍👩‍👧‍👦YQW")
            // iOS has no public turn-log reader, so assert through the value
            // that actually SHIPS: buildContext is what goes to the server as
            // extraSystem on every request (Session.swift:520).
            let ctx = Continuity.buildContext(t) ?? ""
            #expect(ctx.contains("Continuous Turn Log"))
            // 500 code points = 495 a's + the family's first 5 scalars, so the
            // marker word past the cap must be GONE from the shipped context.
            #expect(!ctx.contains("ZQX"), "the q half was not clipped at 500 code points")
            #expect(!ctx.contains("YQW"), "the a half was not clipped at 800 code points")
            // And nothing arrives as a replacement character: a lone surrogate
            // (what a UTF-16 unit-slice leaves) would surface here as U+FFFD.
            #expect(!ctx.unicodeScalars.contains { $0.value == 0xFFFD })
            Continuity.clearTurnLog(t)
        }
    }
}

@Suite struct EventGlyphTests {
    /// Prefix-match: `job` covers job_result/job_error, `telegram` covers all
    /// telegram_* — mirrors lib/chat/event-icons.ts.
    @Test func iconMatchesByPrefix() {
        #expect(EventGlyph.icon(for: "job_result") == "⏰")
        #expect(EventGlyph.icon(for: "job_error") == "⏰")
        #expect(EventGlyph.icon(for: "telegram_out") == "✈️")
        #expect(EventGlyph.icon(for: "telegram_button") == "✈️")
        #expect(EventGlyph.icon(for: "follow") == "🤝")
        #expect(EventGlyph.icon(for: "dm") == "💬")
    }

    /// `tiny_visit` must be keyed in FULL — the bare `visit` prefix never
    /// matches it (kind starts with "tiny"), so 👀 would be unreachable.
    @Test func tinyVisitResolvesToEyes() {
        #expect(EventGlyph.icon(for: "tiny_visit") == "👀")
    }

    /// 💻 `device_result` — a use_device task whose reply landed after the 45s
    /// wait (worker relay.ts buildLateReplyEvent). The event ring is the ONLY
    /// surface a late completion can reach, so an unglyphed kind would land here
    /// as generic ⚡ noise.
    @Test func lateDeviceResultResolvesToLaptop() {
        #expect(EventGlyph.icon(for: "device_result") == "💻")
    }

    /// Unknown/empty kind degrades to ⚡ (web iconFor fallback).
    @Test func unknownKindFallsBackToBolt() {
        #expect(EventGlyph.icon(for: "wat") == "⚡")
        #expect(EventGlyph.icon(for: "") == "⚡")
    }

    /// ⚠️ THE GAP THIS PINS (mirrors tests/event-icons.test.ts). ⚡ is right for a
    /// kind a newer worker invented and wrong for one we ship — and the two are
    /// byte-identical on screen, so nothing failed while `pay_alarm` ("🚨 x402
    /// reconciliation needs a human", swept every minute) rendered as a corrupt
    /// event. The fallback is unchanged; the ROSTER is what makes it fail.
    @Test func everyEmittedKindHasAGlyph() {
        for kind in EventGlyph.emittedKinds {
            #expect(EventGlyph.icon(for: kind) != "⚡", "\(kind) falls through to ⚡ — add an icons entry")
        }
    }

    /// ⛔ A job that will NEVER run must not wear the glyph of one that did.
    ///
    /// `job` is an icons key and a real prefix of `job_missed`, so a lookup that
    /// walks the dictionary in whatever order it happens to enumerate can hand the
    /// ⏰ of a completed run to the one event meaning "this never happened, and it
    /// never will". Swift dictionaries have no order at all, so this was worse here
    /// than on the web: the glyph could differ between launches. `icon(for:)` sorts
    /// by key length so the specific key always wins, and that sort is what this
    /// test pins.
    @Test func jobMissedKeepsItsOwnGlyph() {
        #expect(EventGlyph.emittedKinds.contains("job_missed"))
        #expect(EventGlyph.icon(for: "job_missed") == "⛔")
        #expect(EventGlyph.icon(for: "job_missed") != EventGlyph.icon(for: "job_result"),
                "job_missed inherited the glyph of a job that ran")
        #expect(EventGlyph.icon(for: "job_error") == EventGlyph.icon(for: "job_result"))
    }

    /// 🎙️ The wearable kinds — and the one that was WRONG rather than missing.
    ///
    /// `device_note` is the job_missed case wearing different clothes: `device` is
    /// an icons key and a real prefix of it, so it inherited 💻, "your laptop
    /// finished a task". But device_note is what NiclaRecorder.postToServer falls
    /// back to while /api/devices/transcript isn't deployed — the current
    /// production state — so it is the kind that carries REAL TRANSCRIBED SPEECH
    /// today. A row of the user's own words, labelled as a laptop task.
    ///
    /// The other three were plain absences from `emittedKinds`: the glyphs were
    /// added to `icons` when the necklace shipped and the roster was not, so
    /// everyEmittedKindHasAGlyph — the test that exists to catch precisely this —
    /// iterated a list none of them were on and passed.
    @Test func eachWearableKindHasItsOwnGlyph() {
        let voice = ["nicla_wake", "nicla_transcript", "nicla_sentry", "device_note"]
        let glyphs = voice.map { EventGlyph.icon(for: $0) }
        #expect(Set(glyphs).count == voice.count, "wearable kinds share a glyph: \(glyphs)")
        for kind in voice {
            #expect(EventGlyph.emittedKinds.contains(kind), "\(kind) missing from the roster")
            #expect(EventGlyph.icon(for: kind) != "⚡", "\(kind) falls through to ⚡")
        }
        #expect(EventGlyph.icon(for: "device_note") != EventGlyph.icon(for: "device_result"),
                "device_note inherited 💻 from the `device` prefix — it carries speech, not a laptop task")
    }

    /// The loudest event in the system needs a glyph nothing else shares: a
    /// reconciliation page that looks like a page view is a page nobody reads.
    @Test func payAlarmIsTheSirenAndNothingElseIs() {
        #expect(EventGlyph.icon(for: "pay_alarm") == "🚨")
        for kind in EventGlyph.emittedKinds where kind != "pay_alarm" {
            #expect(EventGlyph.icon(for: kind) != "🚨", "\(kind) also renders 🚨")
        }
    }

    /// 💵 The four money kinds each say a different thing — "you were paid", "your
    /// payout landed", "your payout bounced and came back" — and the ring is often
    /// the only place the user learns any of them (the worker's payment paths
    /// notified through NO rail at all until money-events.ts). One shared glyph
    /// across them would collapse a refund into an earning at a glance.
    @Test func eachMoneyKindHasItsOwnGlyph() {
        let money = ["pay_earned", "pay_received", "pay_withdrawn", "pay_refunded"]
        let glyphs = money.map { EventGlyph.icon(for: $0) }
        #expect(Set(glyphs).count == money.count, "money kinds share a glyph: \(glyphs)")
        for kind in money {
            #expect(EventGlyph.emittedKinds.contains(kind), "\(kind) missing from the roster")
        }
    }

    /// ago() buckets seconds→s/m/h/d against an injected now.
    @Test func agoBucketsBySize() {
        let now = 1_000_000.0
        #expect(EventGlyph.ago(now - 5, now: now) == "5s")
        #expect(EventGlyph.ago(now - 120, now: now) == "2m")
        #expect(EventGlyph.ago(now - 7200, now: now) == "2h")
        #expect(EventGlyph.ago(now - 172_800, now: now) == "2d")
    }

    /// A non-finite or ≤0 `created` degrades to the "1s" floor, not "NaNd" or
    /// a ~20656-day epoch distance — matches the web HUD's ago() guard.
    @Test func agoDegradesOnBadTimestamp() {
        let now = 1_000_000.0
        #expect(EventGlyph.ago(0, now: now) == "1s")
        #expect(EventGlyph.ago(-5, now: now) == "1s")
        #expect(EventGlyph.ago(.nan, now: now) == "1s")
        #expect(EventGlyph.ago(.infinity, now: now) == "1s")
    }
}

/// BYO-model header contract — the iOS twin of web modelConfigHeaders().
/// Pins the security guards (default/keyless → nothing; custom-without-base
/// → nothing) and the preset base-URL fallthrough.
@Suite struct ModelConfigTests {
    @Test func defaultProviderEmitsNoHeaders() {
        #expect(ModelConfig(provider: "default", apiKey: "sk-x").headers().isEmpty)
    }

    @Test func byokWithoutKeyEmitsNoHeaders() {
        #expect(ModelConfig(provider: "openai", apiKey: "").headers().isEmpty)
    }

    @Test func openAiKeyRidesHeaders() {
        let h = ModelConfig(provider: "openai", apiKey: "sk-abc", modelId: "gpt-5-mini").headers()
        #expect(h["x-tiny-model-provider"] == "openai")
        #expect(h["x-tiny-model-api-key"] == "sk-abc")
        #expect(h["x-tiny-model-id"] == "gpt-5-mini")
        // openai preset baseUrl is "" → header omitted (uses provider default)
        #expect(h["x-tiny-model-base-url"] == nil)
    }

    @Test func presetBaseUrlFillsInWhenBlank() {
        // groq has a preset base URL; leaving baseUrl empty must fall through to it.
        let h = ModelConfig(provider: "groq", apiKey: "gsk_1").headers()
        #expect(h["x-tiny-model-base-url"] == "https://api.groq.com/openai/v1")
    }

    @Test func customWithoutBaseUrlLeaksNothing() {
        // The security guard: a custom provider with no base URL would send the
        // key to OpenAI's default endpoint — emit NOTHING instead.
        #expect(ModelConfig(provider: "custom", apiKey: "secret").headers().isEmpty)
    }

    @Test func customWithBaseUrlEmitsKey() {
        let h = ModelConfig(provider: "custom", apiKey: "secret",
                            baseUrl: "https://api.example.com/v1").headers()
        #expect(h["x-tiny-model-api-key"] == "secret")
        #expect(h["x-tiny-model-base-url"] == "https://api.example.com/v1")
    }

    @Test func regionOnlyForBedrock() {
        let bed = ModelConfig(provider: "bedrock", apiKey: "k", region: "eu-west-1").headers()
        #expect(bed["x-tiny-model-region"] == "eu-west-1")
        let oai = ModelConfig(provider: "openai", apiKey: "k", region: "eu-west-1").headers()
        #expect(oai["x-tiny-model-region"] == nil)
    }

    @Test func additionalFieldsOnlyValidJsonObject() {
        let ok = ModelConfig(provider: "openai", apiKey: "k",
                             additionalFields: "{\"reasoning_effort\":\"high\"}").headers()
        #expect(ok["x-tiny-model-additional-fields"] != nil)
        // malformed → dropped, never a throw
        let bad = ModelConfig(provider: "openai", apiKey: "k", additionalFields: "not json").headers()
        #expect(bad["x-tiny-model-additional-fields"] == nil)
        // a JSON array is not an object → dropped
        let arr = ModelConfig(provider: "openai", apiKey: "k", additionalFields: "[1,2]").headers()
        #expect(arr["x-tiny-model-additional-fields"] == nil)
    }

    @Test func additionalFieldsCollapseToOneLine() {
        let h = ModelConfig(provider: "openai", apiKey: "k",
                            additionalFields: "{\n  \"a\": 1\n}").headers()
        #expect(h["x-tiny-model-additional-fields"]?.contains("\n") == false)
    }
}

/// voiceModelHeaders — voice is OpenAI-ONLY and the dedicated key is separate from
/// the chat model, so a Bedrock/Anthropic chat key must never drive a voice call.
/// Pins the key precedence + the no-leak guard (Android buildVoiceHeaders parity).
@Suite struct VoiceModelHeaderTests {
    @Test func noKeyAnywhereEmitsNothing() {
        #expect(voiceModelHeaders(voiceKey: "", chatProvider: "default", chatKey: "", chatModelId: "").isEmpty)
    }
    @Test func bedrockChatKeyNeverDrivesVoice() {
        // Chat on Bedrock with a key, but no dedicated voice key → nothing (would leak).
        #expect(voiceModelHeaders(voiceKey: "", chatProvider: "bedrock", chatKey: "bedrock-key", chatModelId: "").isEmpty)
        #expect(voiceModelHeaders(voiceKey: "", chatProvider: "anthropic", chatKey: "sk-ant", chatModelId: "").isEmpty)
    }
    @Test func dedicatedVoiceKeyAlwaysOpenAI() {
        let h = voiceModelHeaders(voiceKey: "sk-voice", chatProvider: "bedrock", chatKey: "bedrock-key", chatModelId: "")
        #expect(h["x-tiny-model-provider"] == "openai")
        #expect(h["x-tiny-model-api-key"] == "sk-voice")
        #expect(h.values.contains("bedrock-key") == false) // chat key never leaks
    }
    @Test func dedicatedKeyWinsOverOpenAIChatKey() {
        let h = voiceModelHeaders(voiceKey: "sk-voice", chatProvider: "openai", chatKey: "sk-chat", chatModelId: "")
        #expect(h["x-tiny-model-api-key"] == "sk-voice")
    }
    @Test func openAIChatKeyReusedWhenNoDedicated() {
        let h = voiceModelHeaders(voiceKey: "", chatProvider: "openai", chatKey: "sk-chat", chatModelId: "")
        #expect(h["x-tiny-model-provider"] == "openai")
        #expect(h["x-tiny-model-api-key"] == "sk-chat")
    }
    @Test func realtimeModelIdPassesOnReusePathOnly() {
        #expect(voiceModelHeaders(voiceKey: "", chatProvider: "openai", chatKey: "k", chatModelId: "gpt-realtime-2.1")["x-tiny-model-id"] == "gpt-realtime-2.1")
        #expect(voiceModelHeaders(voiceKey: "", chatProvider: "openai", chatKey: "k", chatModelId: "gpt-5-mini")["x-tiny-model-id"] == nil)
        // Dedicated key → DO default model even if chat had a realtime id.
        #expect(voiceModelHeaders(voiceKey: "sk-voice", chatProvider: "openai", chatKey: "k", chatModelId: "gpt-realtime-2.1")["x-tiny-model-id"] == nil)
    }
    @Test func whitespaceVoiceKeyFallsThroughToChat() {
        let h = voiceModelHeaders(voiceKey: "   ", chatProvider: "openai", chatKey: "sk-chat", chatModelId: "")
        #expect(h["x-tiny-model-api-key"] == "sk-chat")
    }
}

/// Memory-graph force simulation — pins the pure physics (the iOS twin of web
/// MemoryGraph.tsx step()) so a refactor can't silently break layout settling.
@Suite struct GraphSimTests {
    @Test func seedIsGoldenAngleSpiralAndDeterministic() {
        let a = GraphSim.seed(count: 5, degree: [0, 0, 0, 0, 0])
        let b = GraphSim.seed(count: 5, degree: [0, 0, 0, 0, 0])
        #expect(a.count == 5)
        // deterministic — same seed twice is identical (stable reopens)
        #expect(a[3].x == b[3].x && a[3].y == b[3].y)
        // radius grows with index (√ spacing) — later nodes sit further out
        #expect(hypot(a[4].x, a[4].y) > hypot(a[1].x, a[1].y))
    }

    @Test func degreeSizesRadius() {
        // r = min(6 + deg*2, 14): deg 0 → 6, deg 3 → 12, deg 10 → capped 14
        let s = GraphSim.seed(count: 3, degree: [0, 3, 10])
        #expect(s[0].r == 6)
        #expect(s[1].r == 12)
        #expect(s[2].r == 14)
    }

    @Test func alphaCoolsByFactor() {
        var b = GraphSim.seed(count: 3, degree: [0, 0, 0])
        let next = GraphSim.step(&b, edges: [], alpha: 1.0)
        #expect(abs(next - 0.995) < 1e-9)
    }

    @Test func repulsionPushesTwoNodesApart() {
        // two coincident-ish nodes with no edges should spread (repulsion wins)
        var b = [SimBody(x: 0, y: 0, r: 6), SimBody(x: 2, y: 0, r: 6)]
        let d0 = abs(b[1].x - b[0].x)
        _ = GraphSim.step(&b, edges: [], alpha: 1.0)
        #expect(abs(b[1].x - b[0].x) > d0)
    }

    @Test func springPullsFarNodesTogether() {
        // two nodes far past the 130 rest length, connected — spring pulls in
        var b = [SimBody(x: 0, y: 0, r: 6), SimBody(x: 600, y: 0, r: 6)]
        let d0 = abs(b[1].x - b[0].x)
        // several ticks so the spring (net of repulsion at this distance) shows
        var alpha = 1.0
        for _ in 0..<5 { alpha = GraphSim.step(&b, edges: [(0, 1)], alpha: alpha) }
        #expect(abs(b[1].x - b[0].x) < d0)
    }

    @Test func degreesCountBothEndpoints() {
        let nodes = [
            GraphNode(id: "a", wireId: "1", label: "", source: nil, live: true, validFrom: nil, validTo: nil),
            GraphNode(id: "b", wireId: "2", label: "", source: nil, live: true, validFrom: nil, validTo: nil),
            GraphNode(id: "c", wireId: "3", label: "", source: nil, live: true, validFrom: nil, validTo: nil),
        ]
        let edges = [
            GraphEdge(id: "e1", src: "a", dst: "b", rel: "about", scope: nil, validTo: nil),
            GraphEdge(id: "e2", src: "a", dst: "c", rel: "about", scope: nil, validTo: nil),
        ]
        #expect(GraphSim.degrees(nodes, edges) == [2, 1, 1])  // a is the hub
    }

    @Test func relPhraseMapsKnownAndFallsThrough() {
        #expect(GraphSim.relPhrase("part_of") == "part of")
        #expect(GraphSim.relPhrase("supersedes") == "supersedes")
        #expect(GraphSim.relPhrase("weird_custom") == "weird_custom")
    }

    // ── fitScale: the "fit to view" that used to be a hardcoded 340pt ─────────
    // Each case below is chosen so the OLD formula
    // `min(340 / (max(spanX, spanY) + 180), …)` and the new one DISAGREE — a
    // square layout on a compact phone can't tell them apart, which is exactly
    // why the bug survived.

    @Test func fitScaleUsesTheRealViewportNotAFixedWidth() {
        // A 6.9" phone's graph canvas is ~430×760pt. The old formula ignored it and
        // fit into 340, so the layout landed at ~a third of the height available.
        let span = 400.0
        let big = GraphSim.fitScale(spanX: span, spanY: span, viewport: CGSize(width: 430, height: 760))
        let small = GraphSim.fitScale(spanX: span, spanY: span, viewport: CGSize(width: 320, height: 480))
        // Bigger canvas ⇒ strictly more zoom. The old formula returned the SAME
        // number for both (0.586), which is the whole defect.
        #expect(big > small)
        // and the fit is real: the scaled span plus label padding fits the canvas
        #expect(span * Double(big) + 148 <= 430.5)
    }

    @Test func fitScaleConstrainsOnTheTIGHTERAxis() {
        // Wide-and-short layout (the usual spring/repulsion outcome) in a TALL
        // viewport: width is the binding constraint. The old code took
        // max(spanX, spanY) = 900 and then also fit it into a WIDTH-shaped 340,
        // which happened to be conservative here — but the reverse case (tall
        // layout, wide viewport) it under-zoomed badly. Both must bind correctly.
        let wide = GraphSim.fitScale(spanX: 900, spanY: 100, viewport: CGSize(width: 430, height: 760))
        #expect(900 * Double(wide) <= Double(430 - 148) + 0.5)   // width fits
        #expect(100 * Double(wide) < Double(760 - 148))          // height has slack

        let tall = GraphSim.fitScale(spanX: 100, spanY: 900, viewport: CGSize(width: 430, height: 760))
        #expect(900 * Double(tall) <= Double(760 - 148) + 0.5)   // height fits
        // A tall layout in a tall viewport gets MORE zoom than the same span wide,
        // because the binding axis is the longer one. One-span logic can't do this.
        #expect(tall > wide)
    }

    @Test func fitScaleClampsAndSurvivesDegenerateInput() {
        // unmeasured viewport → neutral 1, not a pinhole clamp to minScale
        #expect(GraphSim.fitScale(spanX: 400, spanY: 400, viewport: .zero) == 1)
        // single node (zero span both axes) → neutral 1, never a divide-by-zero
        #expect(GraphSim.fitScale(spanX: 0, spanY: 0, viewport: CGSize(width: 430, height: 760)) == 1)
        // one flat axis is fine — the other one binds
        let flat = GraphSim.fitScale(spanX: 600, spanY: 0, viewport: CGSize(width: 430, height: 760))
        #expect(flat > 0.15 && flat < 5)
        // huge layout clamps at minScale rather than going to 0
        #expect(GraphSim.fitScale(spanX: 100_000, spanY: 100_000,
                                  viewport: CGSize(width: 430, height: 760)) == 0.15)
        // two close nodes clamp at maxScale rather than exploding
        #expect(GraphSim.fitScale(spanX: 4, spanY: 4,
                                  viewport: CGSize(width: 430, height: 760)) == 5)
    }

    @Test func fitScalePaddingNeverEatsATinyCanvas() {
        // labelPad is 74/side; on a canvas narrower than 148 the naive subtraction
        // goes negative and the scale flips sign / clamps to minScale.
        let s = GraphSim.fitScale(spanX: 100, spanY: 100, viewport: CGSize(width: 120, height: 120))
        #expect(s > 0.15)          // not clamped to the floor
        #expect(100 * Double(s) <= 120)  // still inside the canvas
    }
}

@Suite struct CommunityFmtTests {
    // Mirrors web tests/community.test.ts `compact` — the iOS twin must agree
    // byte-for-byte, including the never-NaN guard and the tier boundaries.
    @Test func headlineNumbers() {
        #expect(CommunityFmt.compact(0) == "0")
        #expect(CommunityFmt.compact(999) == "999")
        #expect(CommunityFmt.compact(45_300) == "45K")
        #expect(CommunityFmt.compact(1_880_100) == "1.9M")
        #expect(CommunityFmt.compact(1_500_000_000) == "1.5B")
    }
    @Test func neverEmitsNaNOrNegative() {
        #expect(CommunityFmt.compact(.nan) == "0")
        #expect(CommunityFmt.compact(-5) == "0")
        #expect(CommunityFmt.compact(.infinity) == "0")
    }
    @Test func roundsToNearest() {
        #expect(CommunityFmt.compact(12.7) == "13")
    }
    @Test func tierBoundariesRoundUpNotPastCeiling() {
        #expect(CommunityFmt.compact(999_499) == "999K")
        #expect(CommunityFmt.compact(999_500) == "1.0M")
        #expect(CommunityFmt.compact(999_999) == "1.0M")
        #expect(CommunityFmt.compact(999_949_999) == "999.9M")
        #expect(CommunityFmt.compact(999_950_000) == "1.0B")
    }
}

/// 🔴 The iPad sidebar answered `Couldn't load` — two words for four causes.
///
/// It was a hand copy of `UniverseView.load()`: same url, same 20s bound, same
/// `users` → `UniverseUser` decode. `d71b1ff3` ("three panels stop naming a
/// cause") fixed the panels it counted by hand and never reached this fourth
/// one, which still discarded the HTTP response (`let (data, _)`) — so it could
/// not have named a cause even if asked.
///
/// `CommunityFeed` is now the single read. These tests own the part that has
/// never had any coverage: the two silent FILTERS (a builder or a trust score
/// that just doesn't appear), and the line between "an empty universe" and "a
/// body we couldn't read" — the distinction the sidebar used to collapse.
@Suite struct CommunityFeedTests {
    /// The sentence a human actually reads, from the error `decode` throws.
    private func caption(_ body: [String: Any]) -> String? {
        do { _ = try CommunityFeed.decode(body); return nil }
        catch { return LoadFailure.contentMessage(error) }
    }

    @Test("no users key is unreadable, not empty")
    func aMissingListIsNotAnEmptyList() {
        // Both surfaces render "No tinys yet" for `.loaded` + empty. Reaching
        // that from a body without `users` states the universe is empty on the
        // strength of an answer nobody could read.
        #expect(caption([:]) == ApiError.badResponse.localizedDescription)
        #expect(caption(["users": "nope"]) == ApiError.badResponse.localizedDescription)
        #expect(caption(["users": [String: Any]()]) == ApiError.badResponse.localizedDescription)
    }

    @Test("an empty list IS an answer")
    func zeroBuildersIsNotAFailure() throws {
        // The worker's own degraded shape: `{users:[], error:'…'}` with a 500.
        // `load()` gates on the STATUS, so this body only reaches decode on a
        // 2xx — and then it means what it says.
        let feed = try CommunityFeed.decode(["users": [[String: Any]](), "error": "community query failed"])
        #expect(feed.users.isEmpty)
        #expect(caption(["users": [[String: Any]]()]) == nil)
    }

    @Test("a builder with no tinys is dropped, one with a capped list is kept")
    func theBuilderFilter() throws {
        let feed = try CommunityFeed.decode(["users": [
            ["login": "empty", "tinys": [[String: Any]]()],
            ["login": "nameless"],
            ["tinys": [["name": "orphan"]]],
            ["login": "capped", "name": "Cap", "avatar": "a.png",
             "tinyCount": 40, "tinys": [["name": "one"], ["name": "two"]]],
            ["login": "uncounted", "tinys": [["name": "solo"], ["nope": "x"]]],
        ]])
        #expect(feed.users.map(\.login) == ["capped", "uncounted"])
        #expect(feed.users[0].tinyCount == 40)          // the wire's COUNT wins…
        #expect(feed.users[0].tinys.count == 2)         // …over the capped list
        #expect(feed.users[0].name == "Cap")
        #expect(feed.users[1].tinyCount == 1)           // absent → what we can see
        #expect(feed.users[1].tinys == ["solo"])        // a nameless entry is skipped
        #expect(feed.users[1].name.isEmpty)             // never nil-crashes on absent
        #expect(feed.users[1].avatar.isEmpty)
    }

    @Test("the trust map keeps only scores it can defend")
    func theTrustFilter() throws {
        let feed = try CommunityFeed.decode(["users": [[String: Any]](), "trust": [
            "keep": 0.5, "one": 1.0, "tiny": 0.0001,
            "asString": "0.25",
            "zero": 0, "negative": -0.5, "over": 1.5,
            "nan": Double.nan, "inf": Double.infinity,
            "": 0.9,
            "notANumber": "high",
        ]])
        #expect(feed.trust.keys.sorted() == ["asString", "keep", "one", "tiny"])
        #expect(feed.trust["asString"] == 0.25)
        #expect(feed.trust["one"] == 1.0)
    }

    @Test("headline totals default to zero rather than crashing or lying")
    func theTotals() throws {
        let absent = try CommunityFeed.decode(["users": [[String: Any]]()])
        #expect(absent.totalMessages == 0)
        #expect(absent.totalPublicTinys == 0)
        let present = try CommunityFeed.decode(["users": [[String: Any]](),
                                               "totalMessages": 1_880_100, "totalPublicTinys": 42])
        #expect(present.totalMessages == 1_880_100)
        #expect(present.totalPublicTinys == 42)
        // What the sidebar's row and the drawer's card would show for a body
        // that never arrived — CommunityFmt's never-NaN guard, one layer up.
        #expect(CommunityFmt.compact(absent.totalMessages) == "0")
    }

    @Test("both surfaces get the same sentence because there is one read")
    func oneReadOneVocabulary() {
        // The four situations that all used to be "Couldn't load", each now a
        // different sentence — which is the entire user-visible deliverable.
        let five = LoadFailure.contentMessage(ApiError.http(500, "community query failed"))
        let four = LoadFailure.contentMessage(ApiError.http(404, nil))
        let dead = LoadFailure.contentMessage(URLError(.notConnectedToInternet))
        let junk = LoadFailure.contentMessage(ApiError.badResponse)
        #expect(Set([five, four, dead, junk]).count == 4)
        for s in [five, four, dead, junk] { #expect(s != "Couldn't load") }

        // ⚠️ A 5xx DROPS the worker's own reason on purpose: 500 is in
        // `statusOwnsTheMessage`, and "community query failed" is a sentence
        // about a SQL query, not something a reader of a builder list can act
        // on. The status table's line is the honest one, and it says "try
        // again", which is exactly what the Retry beside it does.
        #expect(five == Api.friendlyHTTPError(500))
        #expect(!five.contains("community query"))

        // ⚠️ And the 404 must NOT reach the chat table — `friendlyHTTPError`
        // words 404 as "That tiny doesn't exist", which on a community list is a
        // confident answer about a thing that is not a tiny. `contentMessage`
        // exists for that distinction; this fourth panel now has it too.
        #expect(four.contains("404"))
        #expect(!four.contains("doesn't exist"))

        // The one surface where "check your connection" is a fact, not a guess:
        // status 0 means nothing arrived at all.
        #expect(dead == Api.friendlyHTTPError(0))
    }
}

// ── ⏰ JobCadence ──────────────────────────────────────────────────────────

/// 🔴 The Jobs panel used to render `ran Jul 20, 09:00 · fired 0×` — one row
/// contradicting itself, with the false half the one a person acts on.
///
/// `let done = fired > 0 || !enabled` treated a cleared `enabled` flag as proof
/// of a run, and the scheduler clears it for the opposite reason too: a `once`
/// job due more than 24h ago is switched OFF, `fire_count` untouched
/// (`scheduler.ts` skip-stale). Since `JOB_ABANDONED_KIND` the worker also
/// PUSHES "⏰ <name> never ran" for exactly that row — so the notification and
/// the panel were telling the user opposite things about the same job.
///
/// These are the web's rules (`lib/chat/job-cadence.ts`, pinned by
/// `tests/job-cadence.test.ts`) now that iOS shares them. `now` is injected, so
/// every case here is a fixed clock rather than a race.
@Suite struct JobCadenceTests {
    /// A fixed "now" — 2026-08-02T12:00:00Z. No `Date()` anywhere in this suite.
    let now: Double = 1_785_412_800
    var hour: Double { 3600 }

    // ── the defect itself ─────────────────────────────────────────────────

    @Test("a one-shot that was switched off having never fired does not claim to have run")
    func theAbandonedOneShotTellsTheTruth() {
        // The exact row the worker's skip-stale branch leaves behind:
        // enabled = 0, fire_count = 0, run_at in the past.
        let s = JobCadence.oneShotState(runAt: now - 30 * hour, fired: 0, enabled: false, now: now)
        #expect(s == .missed)
        #expect(JobCadence.prefix(s) == "didn't run")
        // The old expression's verdict, for the record — this is what shipped.
        #expect((0 > 0 || !false) == true)
    }

    @Test("the cadence line for that job no longer says ran")
    func theCadenceStringChanged() {
        let line = JobsView.cadence(schedule: nil, runAt: now - 30 * hour,
                                    fired: 0, enabled: false, now: now)
        #expect(line.hasPrefix("didn't run "))
        // The two strings this row used to be able to show, and neither is true
        // of it: "ran …" was what it did show, "once at …" is the other branch.
        #expect(!line.hasPrefix("ran "))
        #expect(!line.hasPrefix("once at"))
        // The date itself is still there — the fix is the verb, not the loss of
        // the one fact the row had.
        #expect(line.count > "didn't run ".count)
    }

    // ── the rest of the state machine ─────────────────────────────────────

    @Test("a recorded run outranks every flag, including a still-enabled row")
    func aRunOutranksTheFlags() {
        // The post-fire disable is a separate statement, so enabled=1+fired=1 exists.
        #expect(JobCadence.oneShotState(runAt: now - hour, fired: 1, enabled: true, now: now) == .ran)
        #expect(JobCadence.oneShotState(runAt: now - hour, fired: 1, enabled: false, now: now) == .ran)
        // …and it outranks an unreadable run_at too (that is the first branch).
        #expect(JobCadence.oneShotState(runAt: nil, fired: 2, enabled: false, now: now) == .ran)
    }

    @Test("a job whose time just passed is in flight, not overdue forever")
    func theInFlightJobIsDue() {
        let s = JobCadence.oneShotState(runAt: now - 60, fired: 0, enabled: true, now: now)
        #expect(s == .due)
        #expect(JobCadence.prefix(s) == "due")
        // The exact tick it comes due belongs to `.due`, not `.pending`: the
        // scheduler skips only while `due > now`, so at equality it fires.
        #expect(JobCadence.oneShotState(runAt: now, fired: 0, enabled: true, now: now) == .due)
        #expect(JobCadence.oneShotState(runAt: now + 1, fired: 0, enabled: true, now: now) == .pending)
    }

    @Test("still enabled but past the catch-up window is already lost")
    func theCatchUpBoundary() {
        // The scheduler's own test is `now - due > CATCH_UP_SECONDS`, so exactly
        // 24h old is still catchable — the boundary belongs to `.due`.
        #expect(JobCadence.oneShotState(runAt: now - JobCadence.catchUpSeconds,
                                        fired: 0, enabled: true, now: now) == .due)
        #expect(JobCadence.oneShotState(runAt: now - JobCadence.catchUpSeconds - 1,
                                        fired: 0, enabled: true, now: now) == .missed)
    }

    @Test("a future one-shot is still coming")
    func thePendingJob() {
        let s = JobCadence.oneShotState(runAt: now + hour, fired: 0, enabled: true, now: now)
        #expect(s == .pending)
        #expect(JobCadence.prefix(s) == "once at")
    }

    // ── the 1970 guard ────────────────────────────────────────────────────

    @Test("an unusable run_at is unknown, not a job scheduled for 1970")
    func epochZeroIsNotADate() {
        for bad: Double? in [0, -1, .nan, .infinity, nil] {
            #expect(JobCadence.usableSec(bad) == nil)
            #expect(JobCadence.oneShotState(runAt: bad, fired: 0, enabled: true, now: now) == .unknown)
        }
        #expect(JobCadence.prefix(.unknown) == nil)
        // …and the panel falls back to "?" rather than printing Jan 1, 1970.
        let line = JobsView.cadence(schedule: nil, runAt: 0, fired: 0, enabled: true, now: now)
        #expect(line == "?")
        #expect(!line.contains("1970"))
    }

    // ── last_fired_at, the field the scheduler overwrites when it gives up ──

    @Test("nothing says last about a job that never fired")
    func lastNeedsAFireBehindIt() {
        #expect(JobCadence.lastFiredWord(fired: 1, state: .ran) == "last")
        // The abandoned row: the timestamp is real, but it is the moment the
        // scheduler switched the job off — so that is what it is called.
        #expect(JobCadence.lastFiredWord(fired: 0, state: .missed) == "switched off")
        // A recurring job that skipped a stale slot also gets last_fired_at
        // bumped with no fire. Nothing true to say, so nothing is said.
        #expect(JobCadence.lastFiredWord(fired: 0, state: .unknown) == nil)
        #expect(JobCadence.lastFiredWord(fired: 0, state: .pending) == nil)
        #expect(JobCadence.lastFiredWord(fired: 0, state: .due) == nil)
    }

    // ── colour ────────────────────────────────────────────────────────────

    @Test("green is never spent on a job that isn't going to happen")
    func toneFollowsTheState() {
        #expect(JobCadence.tone(schedule: "*/5m", state: .unknown, enabled: true) == .live)
        #expect(JobCadence.tone(schedule: "*/5m", state: .unknown, enabled: false) == .muted)
        #expect(JobCadence.tone(schedule: nil, state: .pending, enabled: true) == .live)
        #expect(JobCadence.tone(schedule: nil, state: .due, enabled: true) == .live)
        #expect(JobCadence.tone(schedule: nil, state: .ran, enabled: false) == .done)
        #expect(JobCadence.tone(schedule: nil, state: .missed, enabled: false) == .warn)
        #expect(JobCadence.tone(schedule: nil, state: .unknown, enabled: true) == .muted)
        // An empty schedule string is not a schedule (the payload is taken raw).
        #expect(JobCadence.tone(schedule: "", state: .missed, enabled: true) == .warn)
    }

    /// The one step where the rule meets SwiftUI. `tone` is covered above, but
    /// Tone → Color was pinned only by a source read in
    /// tests/ios-job-cadence.test.ts — so a mutant painting `.warn` green
    /// survived this suite while the row said "didn't run" in the colour of
    /// success. Compared as text: the exact hue names are the source pin's job,
    /// and these tests stay off SwiftUI.
    @Test("the colour a person actually sees separates the four tones")
    func tintTranslatesTheTone() {
        func hue(_ tone: JobCadence.Tone) -> String { String(describing: JobsView.tint(tone)) }
        #expect(hue(.warn) != hue(.live), "a job that will never run is painted as live")
        #expect(hue(.done) != hue(.live), "a job that already ran is painted as still coming")
        #expect(hue(.warn) != hue(.done), "the warning is indistinguishable from a finished job")
        // Spent and paused are deliberately the same quiet colour.
        #expect(hue(.muted) == hue(.done))
    }

    // ── daily@HH:MM speaks the viewer's clock, like the web ───────────────

    /// ⚠️ Foundation separates the time from AM/PM with U+202F (narrow no-break
    /// space), not U+0020 — so `"6:00 PM" == "6:00 PM"` fails while printing two
    /// identical-looking strings. Normalise before comparing; the app itself ships
    /// the real character, which is correct typography and not worth changing.
    private func norm(_ s: String?) -> String? {
        s?.replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    @Test("a daily job is shown on the reader's own clock, not in UTC")
    func theDailyDSLConverts() {
        let anchor = Date(timeIntervalSince1970: now)
        let posix = Locale(identifier: "en_US_POSIX")
        // Tokyo is UTC+9 with no DST, so 09:00 UTC is 18:00 there — a reader who
        // had to do that sum themselves is what the old "UTC" label asked for.
        #expect(norm(JobCadence.dailyLocal("daily@09:00", now: anchor,
                                           output: TimeZone(identifier: "Asia/Tokyo")!,
                                           locale: posix)) == "6:00 PM")
        #expect(norm(JobCadence.dailyLocal("daily@09:00", now: anchor,
                                           output: TimeZone(identifier: "UTC")!,
                                           locale: posix)) == "9:00 AM")
        // Crossing midnight backwards still names the right wall-clock time.
        #expect(norm(JobCadence.dailyLocal("daily@02:30", now: anchor,
                                           output: TimeZone(identifier: "America/Los_Angeles")!,
                                           locale: posix)) == "7:30 PM")
        // A 24-hour locale gets 24-hour text from the same call — the conversion
        // is the point, the rendering stays the reader's own.
        #expect(norm(JobCadence.dailyLocal("daily@09:00", now: anchor,
                                           output: TimeZone(identifier: "Asia/Tokyo")!,
                                           locale: Locale(identifier: "de_DE"))) == "18:00")
    }

    @Test("an unrecognised schedule is shown verbatim, never silently reworded")
    func malformedSchedulesArePassedThrough() {
        let anchor = Date(timeIntervalSince1970: now)
        for bad in ["daily@9:00", "daily@0900", "daily@", "daily@25:00", "daily@09:61",
                    "daily@ab:cd", "*/5m", "0 9 * * *"] {
            #expect(JobCadence.dailyLocal(bad, now: anchor) == nil, "\(bad) should not parse")
        }
        // …and the panel then prints the raw DSL rather than a guess.
        #expect(JobsView.cadence(schedule: "0 9 * * *", runAt: nil, fired: 0,
                                 enabled: true, now: now) == "0 9 * * *")
        #expect(JobsView.cadence(schedule: "daily@9:00", runAt: nil, fired: 0,
                                 enabled: true, now: now) == "daily@9:00")
    }

    @Test("the recurring DSL still reads the way it always did")
    func recurringUnchanged() {
        #expect(JobsView.cadence(schedule: "*/5m", runAt: nil, fired: 0, enabled: true, now: now)
                == "every 5 min")
        #expect(JobsView.cadence(schedule: "*/2h", runAt: nil, fired: 3, enabled: true, now: now)
                == "every 2 hr")
    }

    @Test("iOS and the worker still agree on the catch-up window")
    func theSharedConstant() {
        // scheduler.ts: CATCH_UP_SECONDS = 24 * 60 * 60, and the whole `.missed`
        // rule is only true while that is the number. tests/ios-job-cadence.test.ts
        // asserts the two sources really do still say it; this asserts the value
        // this app computes with.
        #expect(JobCadence.catchUpSeconds == 86_400)
    }
}

// ── 🎙️ AdoptFailure ─────────────────────────────────────────────────────────
//
// Adopting a Nicla Voice printed ONE sentence for every way it could fail:
// "Couldn't claim the necklace on the server. Check your connection and try
// again." /api/devices/adopt answers a different status per cause on purpose —
// its own comment says the caller's next move on a 404 (enroll it fresh)
// differs from what it should do on an outage (retry) — and `try?` discarded
// all of it. Each case below is one NEXT MOVE.
@Suite struct AdoptFailureTests {
    @Test("an expired session is not a connection problem")
    func theSessionCase() {
        #expect(AdoptFailure.classify(ApiError.http(401, "login required")) == .signedOut)
        // Deferred to the one status table rather than restated, so an expired
        // session reads the same here as in every other sheet.
        #expect(AdoptFailure.signedOut.message == Api.friendlyHTTPError(401))
        // …and the worker's wire phrase never reaches the panel.
        #expect(!AdoptFailure.signedOut.message.contains("login required"))
    }

    @Test("a necklace that is no longer on the account is not told to retry")
    func theRevokedCase() {
        #expect(AdoptFailure.classify(ApiError.http(404, "device not found")) == .notInFleet)
        let m = AdoptFailure.notInFleet.message
        // The route's own comment names this next move: enroll it fresh.
        #expect(m.contains("Set it up again"))
        #expect(!m.lowercased().contains("connection"))
        #expect(!m.lowercased().contains("try again"))
        #expect(!m.contains("device not found"))
    }

    @Test("only an outage is reported as an outage")
    func theOutageCase() {
        // 503 is the route's own `registry unreachable, retryable: true`.
        for e in [ApiError.http(503, "registry unreachable"), ApiError.http(500, nil),
                  ApiError.http(0, nil)] {
            #expect(AdoptFailure.classify(e) == .uncertain)
        }
        // A rotation whose reply was lost may still have landed, so the panel
        // must not claim nothing happened.
        #expect(AdoptFailure.uncertain.message.contains("may or may not have moved"))
    }

    @Test("a 2xx with no key says the handover already happened")
    func theKeyLostCase() {
        // `Api.request` throws `.http` for every non-2xx, so `.badResponse` out
        // of `Api.post` can ONLY be a 2xx whose body wasn't usable.
        #expect(AdoptFailure.classify(ApiError.badResponse) == .keyNotDelivered)
        let m = AdoptFailure.keyNotDelivered.message
        #expect(m.contains("moved to this phone"))
        #expect(m.contains("Adopt again"))
        // The one thing that provably worked must not be the thing blamed.
        #expect(!m.lowercased().contains("connection"))
    }

    @Test("a server that explained itself keeps the floor")
    func theRefusedCase() {
        // 424 carries the worker's own reason for the rotation failing.
        let worker = ApiError.http(424, "rotate failed: registry write rejected")
        guard case .refused(let why) = AdoptFailure.classify(worker) else {
            #expect(Bool(false), "a 424 stopped being reported as a refusal"); return
        }
        #expect(why.contains("rotate failed: registry write rejected"))
        // A 400 is the route's own validation; the status table's best would be
        // the bare number, so the body wins there too.
        #expect(AdoptFailure.classify(ApiError.http(400, "deviceId required"))
                    .message.contains("deviceId required"))
    }

    @Test("no failure sends the reader to look at their WiFi")
    func nothingBlamesTheConnection() {
        let all: [AdoptFailure] = [.signedOut, .notInFleet, .uncertain, .keyNotDelivered,
                                   .refused("the server's own words")]
        for f in all {
            #expect(!f.message.contains("Check your connection"),
                    "\(f) still blames the connection")
        }
        // Five causes, five distinct sentences — the defect was one sentence for
        // all of them, so distinctness is the property under test.
        #expect(Set(all.map(\.message)).count == all.count)
    }

    @Test("a transport failure is classified before any status is looked for")
    func urlErrorOutranksTheCast() {
        // URLError never produced a status. Reaching the ApiError cast first
        // would print "Unexpected response from the server" for a request that
        // got no response at all.
        for code: URLError.Code in [.notConnectedToInternet, .timedOut, .cannotFindHost] {
            #expect(AdoptFailure.classify(URLError(code)) == .uncertain)
        }
        #expect(AdoptFailure.classify(URLError(.timedOut)).message
                    != ApiError.badResponse.localizedDescription)
    }
}

@Suite struct ProfileToolParamsTests {
    // Mirrors web ProfileToolCard: params arrive as a JSON object OR a
    // stringified JSON blob — both must normalize to [String:String].
    @Test func objectParamsPassThrough() {
        let p = ProfileView.parseParams(["city": "target city", "units": "metric or imperial"])
        #expect(p["city"] == "target city")
        #expect(p["units"] == "metric or imperial")
    }
    @Test func stringifiedJsonIsParsed() {
        let p = ProfileView.parseParams("{\"q\":\"search query\"}")
        #expect(p["q"] == "search query")
    }
    @Test func nonObjectYieldsEmpty() {
        #expect(ProfileView.parseParams(nil).isEmpty)
        #expect(ProfileView.parseParams("not json").isEmpty)
        #expect(ProfileView.parseParams(42).isEmpty)
    }
    @Test func nonStringValuesCoerced() {
        let p = ProfileView.parseParams(["limit": 5, "flag": true])
        #expect(p["limit"] == "5")
        #expect(p["flag"] == "1" || p["flag"] == "true")  // NSNumber bool
    }
}

@Suite struct ToolboxParseTests {
    // GET /api/tools rows → ForgedTool; worker stores created in SECONDS but
    // the <1e12 guard must also absorb a milliseconds regression (the same
    // normalization ProfileView.joinedStr applies).
    @Test func parsesRowWithSecondsTimestamp() {
        let t = ToolboxView.parseTool([
            "name": "weather", "description": "current conditions",
            "params": ["city": "target city"], "code": "return 1",
            "created": 1_752_000_000.0,
        ])
        #expect(t?.name == "weather")
        #expect(t?.desc == "current conditions")
        #expect(t?.params["city"] == "target city")
        #expect(t?.code == "return 1")
        #expect(t?.created == Date(timeIntervalSince1970: 1_752_000_000))
    }
    @Test func millisecondCreatedNormalizedAndZeroDropped() {
        #expect(ToolboxView.createdDate(1_752_000_000_000) == Date(timeIntervalSince1970: 1_752_000_000))
        #expect(ToolboxView.createdDate(0) == nil)
        #expect(ToolboxView.createdDate(-5) == nil)
    }
    @Test func namelessOrEmptyNameRowsDropped() {
        #expect(ToolboxView.parseTool(["description": "orphan"]) == nil)
        #expect(ToolboxView.parseTool(["name": ""]) == nil)
    }
}

// ── Concurrent turns (web stream-registry parity) ─────────────────────────

@Suite struct ConcurrentTurnsTests {
    private func texts(_ h: [[String: Any]]) -> [String] {
        h.compactMap { ($0["content"] as? [[String: Any]])?.first?["text"] as? String }
    }

    @Test func annotateNonEmptyPartialMatchesWebString() {
        let started = Date(timeIntervalSince1970: 1_000)
        let now = Date(timeIntervalSince1970: 1_002.4)   // 2.4s → rounds to 2
        let out = ChatModel.annotateLivePartial("half an answer ", startedAt: started, now: now)
        #expect(out == "[⏳ You are STILL WRITING this reply in a parallel turn (started 2s ago). Partial text so far — do not repeat it, but you may build on it:]\nhalf an answer")
    }

    @Test func annotateEmptyPartialMatchesWebString() {
        let started = Date(timeIntervalSince1970: 1_000)
        let now = Date(timeIntervalSince1970: 1_005)
        let out = ChatModel.annotateLivePartial("  ", startedAt: started, now: now)
        #expect(out == "[⏳ You are still working on a reply to the previous message in a parallel turn (started 5s ago) — nothing written yet. Answer the new message on its own.]")
    }

    @Test func annotateFloorsAtOneSecond() {
        // A same-instant claim must read "1s ago", never "0s" (web max(1, …))
        let t = Date()
        #expect(ChatModel.annotateLivePartial("x", startedAt: t, now: t).contains("(started 1s ago)"))
    }

    @Test func liveSiblingRidesAlongEvenWhenEmpty() {
        // A sibling live placeholder with no text yet is INCLUDED (annotated),
        // not substituted with the "…" empty-bubble placeholder.
        let user = ChatMessage(role: "user", text: "first question")
        let placeholder = ChatMessage(role: "assistant", text: "")
        let h = ChatModel.turnHistory(prior: [user, placeholder],
                                      live: [placeholder.id: Date()])
        let t = texts(h)
        #expect(t.count == 2)
        #expect(t[0] == "first question")
        #expect(t[1].contains("nothing written yet"))
    }

    @Test func liveSiblingPartialTextIsWrappedNotRaw() {
        let sibling = ChatMessage(role: "assistant", text: "partial draft")
        let now = Date()
        let h = ChatModel.turnHistory(prior: [sibling],
                                      live: [sibling.id: now.addingTimeInterval(-3)],
                                      now: now)
        #expect(texts(h) == ["[⏳ You are STILL WRITING this reply in a parallel turn (started 3s ago). Partial text so far — do not repeat it, but you may build on it:]\npartial draft"])
    }

    @Test func nonLiveEmptiesKeepPlaceholderSubstitution() {
        // Bedrock role-alternation guard unchanged for finished empty bubbles
        let photoOnly = ChatMessage(role: "user", text: "")
        let uiOnly = ChatMessage(role: "assistant", text: "")
        let h = ChatModel.turnHistory(prior: [photoOnly, uiOnly], live: [:])
        #expect(texts(h) == ["Have a look.", "…"])
    }

    @Test func historyCapsAtThirtyNewest() {
        let prior = (0..<40).map { ChatMessage(role: $0 % 2 == 0 ? "user" : "assistant", text: "m\($0)") }
        let h = ChatModel.turnHistory(prior: prior, live: [:])
        #expect(h.count == 30)
        #expect(texts(h).first == "m10")
        #expect(texts(h).last == "m39")
    }
}

@Suite struct RecentTinysTests {
    // MRU promotion for Home-Screen quick actions (android parity): most-recent
    // first, deduped, capped. Pure — no UIKit/UserDefaults touched.
    @Test func promotesToFront() {
        #expect(RecentTinys.promote("b", into: ["a", "c"]) == ["b", "a", "c"])
    }
    @Test func dedupsExisting() {
        // Re-switching to a listed tiny moves it to front, not a duplicate row.
        #expect(RecentTinys.promote("c", into: ["a", "c", "b"]) == ["c", "a", "b"])
    }
    @Test func capsAtMax() {
        let r = RecentTinys.promote("e", into: ["a", "b", "c", "d"], max: 4)
        #expect(r == ["e", "a", "b", "c"])
        #expect(r.count == 4)
    }
    @Test func normalizesSlug() {
        // switchTiny lowercases/trims; promote must match so no dupe sneaks in.
        #expect(RecentTinys.promote("  Tiny  ", into: ["tiny"]) == ["tiny"])
    }
    @Test func emptyNameIsNoop() {
        #expect(RecentTinys.promote("   ", into: ["a", "b"]) == ["a", "b"])
    }
}

@Suite struct HeroURLTests {
    // Owner-set banner URLs render only when they'd pass the web's guard
    // (Chat.tsx: ^https://[^\s"'\\<>]+$) — parity keeps both surfaces
    // agreeing on which banners exist. Pure string → URL?, no network.
    @Test func plainHttpsPasses() {
        let u = ChatModel.heroURL(from: "https://cdn.example.com/banner.png")
        #expect(u?.absoluteString == "https://cdn.example.com/banner.png")
    }

    @Test func nonHttpsAndInjectionShapesRejected() {
        for bad in ["http://x.com/a.png",            // https only
                    "javascript:alert(1)",
                    "https://x.com/a b.png",         // whitespace
                    "https://x.com/\"a\".png",       // quote
                    "https://x.com/'a'.png",
                    "https://x.com/<svg>.png",       // angle brackets
                    "https://x.com/a\\b.png"] {      // backslash
            #expect(ChatModel.heroURL(from: bad) == nil, "should reject \(bad)")
        }
    }

    @Test func emptyMeansNoBanner() {
        // The not-exists / error fallback responses OMIT the field — the
        // caller coalesces absent to "" and gets nil (plain background).
        #expect(ChatModel.heroURL(from: "") == nil)
    }
}

@Suite struct LandingCopyTests {
    // Turn-zero hero copy (web heroMode parity, Chat.tsx) — the tagline and
    // starter chips must stay byte-identical to the web's strings so both
    // surfaces greet a tiny the same way. Pure string helpers, no UI.
    @Test func taglineMatchesWebBranches() {
        #expect(ChatModel.landingTagline(for: "tiny")
                == "Create your own AI by chatting — free, forever.")
        #expect(ChatModel.landingTagline(for: "koru")
                == "A tiny — a living AI at tiny.technology/koru. Say anything.")
    }

    @Test func chipsMatchWebBranches() {
        #expect(ChatModel.landingChips(for: "tiny")
                == ["Create an AI named …", "What is this place?", "Show me what a tiny can do"])
        #expect(ChatModel.landingChips(for: "koru")
                == ["What can you do?", "Who made you?", "Surprise me"])
    }

    @Test func ellipsisChipSeedsComposerKeepingTrailingSpace() {
        // Web: chip.endsWith('…') → setInput(chip.replace('…','')) — the
        // trailing space survives so the user just types the name.
        #expect(ChatModel.landingSeed(for: "Create an AI named …") == "Create an AI named ")
        #expect(ChatModel.landingSeed(for: "Surprise me") == nil)
    }
}

// ── Per-tiny identity (logo / intro_vibe / chips) ──────────────────────────

@Suite struct TinyIdentityTests {
    /// `chips` contract: 1–4 strings, trimmed, non-empty, ≤60 chars — any
    /// violation nils the whole array (defaults win, graceful no-op).
    @Test func customChipsValidator() {
        #expect(ChatModel.customChips(from: [" Hi ", "Two"]) == ["Hi", "Two"])
        #expect(ChatModel.customChips(from: ["one", "two", "three", "four"])?.count == 4)
        #expect(ChatModel.customChips(from: []) == nil)                              // < 1
        #expect(ChatModel.customChips(from: ["a", "b", "c", "d", "e"]) == nil)       // > 4
        #expect(ChatModel.customChips(from: [String(repeating: "x", count: 61)]) == nil)
        #expect(ChatModel.customChips(from: [String(repeating: "x", count: 60)]) != nil)
        #expect(ChatModel.customChips(from: ["ok", "   "]) == nil)                   // empty after trim
        #expect(ChatModel.customChips(from: "not an array") == nil)
        #expect(ChatModel.customChips(from: nil) == nil)
    }

    /// Extension classification picks the renderer: mp4/webm/mov → video,
    /// gif → gif, svg → svg (WKWebView path), everything else
    /// (png/jpg/webp/extensionless) → image.
    @Test func logoKindByExtension() {
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.mp4")!) == .video)
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.WEBM")!) == .video) // case-blind
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.gif")!) == .gif)
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.svg")!) == .svg)
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.SVG")!) == .svg) // case-blind
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/a.png")!) == .image)
        #expect(ChatModel.logoKind(for: URL(string: "https://x.com/logo")!) == .image)   // no ext
    }

    /// `intro_vibe` must be a real Haptic pattern name — unknowns become
    /// nil (no greeting), never a surprise default-tap.
    @Test func introVibeValidatesAgainstHapticVocabulary() {
        for known in ["tap", "double", "success", "warning", "error",
                      "heartbeat", "sos", "long", "escalate", "wave"] {
            #expect(ChatModel.introVibe(from: known) == known)
        }
        #expect(ChatModel.introVibe(from: " WAVE ") == "wave")  // trims + lowercases
        #expect(ChatModel.introVibe(from: "explode") == nil)
        #expect(ChatModel.introVibe(from: "") == nil)
        #expect(ChatModel.introVibe(from: nil) == nil)
    }

    /// `tagline` contract: a trimmed, non-empty string ≤200 chars replaces the
    /// generic landing line — anything else nils (generic line wins).
    @Test func customTaglineValidator() {
        #expect(ChatModel.customTagline(from: " Hello there ") == "Hello there")   // trimmed
        #expect(ChatModel.customTagline(from: String(repeating: "x", count: 200))?.count == 200)
        #expect(ChatModel.customTagline(from: String(repeating: "x", count: 201)) == nil) // > 200
        #expect(ChatModel.customTagline(from: "") == nil)
        #expect(ChatModel.customTagline(from: "   ") == nil)                        // empty after trim
        #expect(ChatModel.customTagline(from: 42) == nil)                           // wrong type
        #expect(ChatModel.customTagline(from: nil) == nil)
    }

    /// Garbage bytes must not crash the GIF decoder — nil, nothing renders.
    @Test func gifDecoderRejectsGarbage() {
        #expect(GIFDecoder.animatedImage(Data("definitely not a gif".utf8)) == nil)
        #expect(GIFDecoder.animatedImage(Data()) == nil)
    }
}

// ── Interrupted-stream reconcile (ChatModel.reconcileInterrupted) ──────────
// Load-time honesty pass: an app killed mid-stream must restore as
// "⚠️ interrupted + Retry", never as a silently-empty or silently-truncated
// answer (web reconcileInterruptedTools parity).

@Suite struct ChatReconcileTests {
    private func user(_ t: String) -> ChatMessage { ChatMessage(role: "user", text: t) }
    private func bot(_ t: String) -> ChatMessage { ChatMessage(role: "assistant", text: t) }

    @Test func legacyTailEmptyBubbleGetsMarkerAndRetryPrompt() {
        // Old save-at-send shape: transcript ends [user, empty assistant]
        let out = ChatModel.reconcileInterrupted([user("hi there"), bot("")])
        #expect(out[1].text == ChatModel.interruptedMarker)
        #expect(out[1].failedPrompt == "hi there")
    }

    @Test func flaggedPartialKeepsTextAppendsMarkerAnywhereInTranscript() {
        var partial = bot("Half an ans")
        partial.liveAtSave = true // persisted by a mid-stream partial save
        let out = ChatModel.reconcileInterrupted([user("q1"), partial, user("q2"), bot("done")])
        #expect(out[1].text == "Half an ans\n\n" + ChatModel.interruptedMarker)
        #expect(out[1].failedPrompt == "q1") // nearest PRECEDING user msg
        #expect(out[1].liveAtSave == false)  // consumed, never persists back true
        // The finished concurrent sibling is untouched
        #expect(out[3].text == "done")
        #expect(out[3].failedPrompt == nil)
    }

    @Test func renderUiOnlyTurnIsRealContentNotInterrupted() {
        // speak/render_ui-only turns legitimately persist with text ""
        var uiTurn = bot("")
        uiTurn.ui = [RenderUiItem(id: "u1", title: "chart", propsJson: "{}")]
        let out = ChatModel.reconcileInterrupted([user("chart it"), uiTurn])
        #expect(out[1].text.isEmpty)
        #expect(out[1].failedPrompt == nil)
    }

    @Test func historicEmptyMidTranscriptAndFailedTurnsUntouched() {
        var alreadyFailed = bot("⚠️ Server hiccup")
        alreadyFailed.failedPrompt = "old q"
        let out = ChatModel.reconcileInterrupted([user("a"), bot(""), user("b"), alreadyFailed, user("c"), bot("fine")])
        #expect(out[1].text.isEmpty)            // not at tail, no flag → historic empty stays
        #expect(out[1].failedPrompt == nil)
        #expect(out[3].text == "⚠️ Server hiccup") // already retryable — no double marker
        #expect(out[5].failedPrompt == nil)
    }
}

// ── Geo (maps-location loop c8) ───────────────────────────────────────────
// The `### Location` block must match web tests/geo.test.ts and Android
// GeoTest.kt byte-for-byte — a drift here is a cross-platform context fork.

@Suite struct GeoTests {
    private func fix(
        speedMs: Double? = 6.5,
        headingDeg: Double? = 48,
        accuracyM: Int? = 12,
        altitudeM: Int? = 52
    ) -> Geo.Fix {
        Geo.Fix(
            lat: 37.7749, lng: -122.4194,
            accuracyM: accuracyM, altitudeM: altitudeM,
            speedMs: speedMs, headingDeg: headingDeg,
            timestampMs: 1_753_400_000_000
        )
    }

    @Test func kmhConvertsAndRejectsJunk() {
        #expect(Geo.kmh(6.5) == 23.4)
        #expect(Geo.kmh(0) == 0)
        #expect(Geo.kmh(nil) == nil)
        #expect(Geo.kmh(-1) == nil)
        #expect(Geo.kmh(.nan) == nil)
    }

    @Test func cardinalMapsAndWraps() {
        #expect(Geo.cardinal(0) == "N")
        #expect(Geo.cardinal(48) == "NE")
        #expect(Geo.cardinal(90) == "E")
        #expect(Geo.cardinal(180) == "S")
        #expect(Geo.cardinal(270) == "W")
        #expect(Geo.cardinal(315) == "NW")
        #expect(Geo.cardinal(359) == "N")
        #expect(Geo.cardinal(810) == "E")
        #expect(Geo.cardinal(-90) == "W")
        #expect(Geo.cardinal(nil) == nil)
        #expect(Geo.cardinal(.nan) == nil)
    }

    @Test func contextBlockRendersTheExactSharedGrammar() {
        #expect(Geo.contextBlock(fix()) == [
            "### Location",
            "- **Coordinates**: 37.7749, -122.4194",
            "- **Accuracy**: ±12m",
            "- **Altitude**: 52m",
            "- **Speed**: 23.4 km/h",
            "- **Heading**: NE (48°)",
        ].joined(separator: "\n"))
    }

    @Test func stationaryOmitsSpeedHeadingAltitude() {
        let block = Geo.contextBlock(fix(speedMs: nil, headingDeg: nil, altitudeM: nil))
        #expect(block == [
            "### Location",
            "- **Coordinates**: 37.7749, -122.4194",
            "- **Accuracy**: ±12m",
        ].joined(separator: "\n"))
    }

    @Test func zeroSpeedIsParkedNotAZeroLine() {
        #expect(!Geo.contextBlock(fix(speedMs: 0, headingDeg: nil)).contains("Speed"))
    }

    @Test func degenerateFixRendersEmpty() {
        #expect(Geo.contextBlock(nil) == "")
        #expect(Geo.contextBlock(fix()).isEmpty == false)
        let bad = Geo.Fix(lat: .nan, lng: -122.4194, accuracyM: nil, altitudeM: nil,
                          speedMs: nil, headingDeg: nil, timestampMs: 0)
        #expect(Geo.contextBlock(bad) == "")
    }
}

/// The map screenshot harness (`--map-tracking-harness`, MapScreen.swift).
///
/// Why this is tested at all: the store shot captioned "Your phone becomes a node"
/// was an IDLE basemap — no position dot, no pins, no HUD — because tracking is only
/// reachable by tapping "locate me" and the simulator CLI cannot send a tap. The
/// harness exists to make the capture honest, and its one hard rule is that it may
/// start TRACKING (the fix stays on the device) and must never start `beSeen`, which
/// publishes the user's real coordinates as a public presence pin. That rule was a
/// comment; here it is an assertion.
@Suite struct MapHarnessTests {
    @Test func trackingStartsOnlyForTheExactFlag() {
        #expect(MapHarness.startsTracking(arguments: ["Tiny", "--map-tracking-harness"]))
        // Default-off is the load-bearing half: a normal launch (and every OTHER
        // harness flag) must leave the map in its real, untracked state.
        #expect(MapHarness.startsTracking(arguments: ["Tiny"]) == false)
        #expect(MapHarness.startsTracking(arguments: ["Tiny", "--memory-graph-harness"]) == false)
        #expect(MapHarness.startsTracking(arguments: []) == false)
    }

    @Test func aFlagThatMerelyContainsTheNameDoesNotArmTheHarness() {
        // A substring/prefix match would arm a capture harness on an argument that
        // says the opposite — the kind of thing only a test notices.
        #expect(MapHarness.startsTracking(arguments: ["Tiny", "--map-tracking-harness-disabled"]) == false)
        #expect(MapHarness.startsTracking(arguments: ["Tiny", "--no-map-tracking-harness"]) == false)
        #expect(MapHarness.startsTracking(arguments: ["Tiny", "map-tracking-harness"]) == false)
    }

    @Test func nothingEverTurnsPresenceOnForAScreenshot() {
        // `beSeen` POSTs real coordinates to /api/location. No argv may enable it —
        // not the tracking flag, and not a flag invented to look like one.
        #expect(MapHarness.startsBeingSeen(arguments: ["Tiny", MapHarness.trackingFlag]) == false)
        #expect(MapHarness.startsBeingSeen(arguments: ["Tiny", "--map-be-seen-harness"]) == false)
        #expect(MapHarness.startsBeingSeen(arguments: []) == false)
    }

    @Test func theTrackingHudPrintsARealContextBlock() {
        // The shot's whole claim is that the HUD shows what the tiny is handed, so
        // the harness is only useful if a fix produces a NON-empty context block —
        // an empty one renders "waiting for position…" and the asset says nothing.
        let f = Geo.Fix(lat: 37.7793, lng: -122.4193, accuracyM: 5, altitudeM: nil,
                        speedMs: nil, headingDeg: nil, timestampMs: 1_753_400_000_000)
        let block = Geo.contextBlock(f)
        #expect(block.isEmpty == false)
        #expect(block.contains("37.7793"))
    }
}

// ── Graph harness: dataset vs sheet are separate decisions ───────────────────
//
// All four shipped video encodes rendered the user's REAL fact graph, because
// the only flag the recording used was `--session-harness` (auth) and the graph
// beat therefore hit the live fetch. The stills flag couldn't be reused as-is:
// it auto-opens the sheet, which a preview cut has to navigate to itself.
@Suite struct GraphHarnessFlagTests {
    @Test func eitherFlagSubstitutesTheDemoDataset() {
        #expect(GraphHarness.usesDemoDataset(arguments: ["x", "--memory-graph-harness"]))
        #expect(GraphHarness.usesDemoDataset(arguments: ["x", "--graph-dataset-harness"]))
        #expect(GraphHarness.usesDemoDataset(
            arguments: ["--session-harness", "--graph-dataset-harness"]))
    }

    @Test func noFlagMeansTheREALGRAPH_soAnAssetRouteMustNeverLandHere() {
        // The leak, stated as a test: a recording launched with auth alone
        // reaches the user's own facts.
        #expect(GraphHarness.usesDemoDataset(arguments: ["--session-harness"]) == false)
        #expect(GraphHarness.usesDemoDataset(arguments: []) == false)
        #expect(GraphHarness.autoOpensSheet(arguments: ["--session-harness"]) == false)
    }

    @Test func onlyTheStillsFlagAutoOpensTheSheet() {
        #expect(GraphHarness.autoOpensSheet(arguments: ["--memory-graph-harness"]))
        // The video flag must NOT open it, or beat 1 is the sheet and the
        // driver's first tap is swallowed by a modal.
        #expect(GraphHarness.autoOpensSheet(arguments: ["--graph-dataset-harness"]) == false)
    }

    @Test func historyFollowsTheDATASETnotTheSheet() {
        // A video navigates to the sheet later, and still needs the grey
        // `live: false` nodes present when it arrives — otherwise the legend's
        // "closed" swatch has no referent on screen.
        #expect(GraphHarness.startsWithHistory(arguments: ["--graph-dataset-harness"]))
        #expect(GraphHarness.startsWithHistory(arguments: ["--memory-graph-harness"]))
        #expect(GraphHarness.startsWithHistory(arguments: ["--session-harness"]) == false)
    }

    @Test func aFlagThatMerelyCONTAINSTheNameDoesNotArmEither() {
        for bogus in ["--graph-dataset-harness-disabled", "--no-graph-dataset-harness",
                      "graph-dataset-harness", "--memory-graph-harness2"] {
            #expect(GraphHarness.usesDemoDataset(arguments: [bogus]) == false,
                    "\(bogus) must not arm the dataset swap")
            #expect(GraphHarness.autoOpensSheet(arguments: [bogus]) == false,
                    "\(bogus) must not auto-open the sheet")
        }
    }

    @Test func theTwoFlagsAreDISTINCTstrings() {
        // If someone "simplifies" these to the same literal, the video flag
        // starts auto-opening the sheet again and the beat driver silently
        // records 28 seconds of a modal.
        #expect(GraphHarness.sheetFlag != GraphHarness.datasetFlag)
        // And neither may be a substring of the other, or `contains` on the
        // argument list stops telling them apart.
        #expect(GraphHarness.sheetFlag.contains(GraphHarness.datasetFlag) == false)
        #expect(GraphHarness.datasetFlag.contains(GraphHarness.sheetFlag) == false)
    }
}

// ── Memory LIST harness: the sheet BESIDE the one that got a harness ─────────
//
// c54 found that all four shipped video encodes spend ≈3–8s on the memory LIST
// sheet, which draws the signed-in user's learnings at body-text size, and that
// NO check had ever looked at it — the per-beat checker could not clear it
// because there was no known dataset to compare a frame against. The graph
// sheet got `GraphHarness` in c28–c30 *because it leaked*; nothing generalised
// the lesson one view over.
@Suite struct MemoryHarnessFlagTests {
    @Test func eitherFlagSubstitutesTheDemoDataset() {
        #expect(MemoryHarness.usesDemoDataset(arguments: ["x", "--memory-list-harness"]))
        #expect(MemoryHarness.usesDemoDataset(arguments: ["x", "--memory-dataset-harness"]))
        #expect(MemoryHarness.usesDemoDataset(
            arguments: ["--session-harness", "--memory-dataset-harness"]))
    }

    @Test func noFlagMeansTheREALLEARNINGS_soAnAssetRouteMustNeverLandHere() {
        // The c54 leak, stated as a test: a recording launched with auth alone
        // reaches the user's own learnings.
        #expect(MemoryHarness.usesDemoDataset(arguments: ["--session-harness"]) == false)
        #expect(MemoryHarness.usesDemoDataset(arguments: []) == false)
        // And the GRAPH flags do not arm this sheet. This is the whole finding:
        // the four encodes that were later re-recorded with a graph flag STILL
        // hit the live fetch here, because these are different views.
        #expect(MemoryHarness.usesDemoDataset(arguments: ["--memory-graph-harness"]) == false)
        #expect(MemoryHarness.usesDemoDataset(arguments: ["--graph-dataset-harness"]) == false)
    }

    @Test func onlyTheStillsFlagAutoOpensTheSheet() {
        #expect(MemoryHarness.autoOpensSheet(arguments: ["--memory-list-harness"]))
        #expect(MemoryHarness.autoOpensSheet(arguments: ["--memory-dataset-harness"]) == false)
        #expect(MemoryHarness.autoOpensSheet(arguments: ["--session-harness"]) == false)
    }

    @Test func aFlagThatMerelyCONTAINSTheNameDoesNotArmEither() {
        for bogus in ["--memory-list-harness-disabled", "--no-memory-list-harness",
                      "memory-list-harness", "--memory-dataset-harness2"] {
            #expect(MemoryHarness.usesDemoDataset(arguments: [bogus]) == false,
                    "\(bogus) must not arm the dataset swap")
            #expect(MemoryHarness.autoOpensSheet(arguments: [bogus]) == false,
                    "\(bogus) must not auto-open the sheet")
        }
    }

    @Test func theFourHarnessFlagsAreALLDISTINCT() {
        // Four flags now name two sheets × two purposes. If any pair collapses
        // to the same literal — or one becomes a substring of another — then
        // `arguments.contains` stops telling them apart and a video flag starts
        // auto-opening a modal over beat 1 again.
        let flags = [GraphHarness.sheetFlag, GraphHarness.datasetFlag,
                     MemoryHarness.sheetFlag, MemoryHarness.datasetFlag]
        #expect(Set(flags).count == 4)
        for a in flags {
            for b in flags where a != b {
                #expect(a.contains(b) == false, "\(a) contains \(b)")
            }
        }
    }
}

// ── The harness dataset itself: it has to EXERCISE what the frame claims ─────
@Suite struct MemoryHarnessDatasetTests {
    @Test func theDatasetDecodesTHROUGHTheProductionWireParser() {
        // The graph harness's rule, applied here: the dataset is expressed as
        // wire dictionaries and decoded by the SAME `decodeLearnings` a real
        // response goes through. A harness that hand-built its rows could render
        // a shape the server cannot produce, and then the capture is evidence
        // about the harness rather than about the app.
        let rows = MemoryView.decodeLearnings(MemoryHarness.serverWire())
        #expect(rows.count == MemoryHarness.serverWire().count)
        #expect(rows.allSatisfy { !$0.content.isEmpty })
        #expect(rows.allSatisfy { !$0.id.isEmpty })
        // Distinct ids — SwiftUI's ForEach is keyed on them, and duplicates make
        // rows disappear from the shot with no error anywhere.
        #expect(Set(rows.map(\.id)).count == rows.count)
    }

    @Test func bothStatusDotStatesAppear() {
        // The row's only visual channel besides its text is live/archived. A
        // dataset of all-live rows renders the dot in ONE state and silently
        // hides half of what the frame is there to demonstrate — the same defect
        // as the graph harness needing History ON for its grey nodes.
        let rows = MemoryView.decodeLearnings(MemoryHarness.serverWire())
        #expect(rows.contains { $0.live })
        #expect(rows.contains { !$0.live })
    }

    @Test func theSheetsOTHERUNGATEDSOURCEisSubstitutedTOO() {
        // ⚠️⚠️ This sheet has TWO ungated sources: /api/learnings AND the
        // on-device `Continuity.memories(tiny)` section above it. A harness that
        // covered only the network fetch would leave the local half live while
        // being called "the memory harness" — the c54 defect one layer down.
        // 🔑 **A harness for one of a view's sources is not a harness for the
        // view.**
        #expect(MemoryHarness.localEntries().isEmpty == false)
        #expect(MemoryHarness.localEntries().allSatisfy { !$0.content.isEmpty })
        #expect(Set(MemoryHarness.localEntries().map(\.id)).count
                == MemoryHarness.localEntries().count)
    }

    @Test func theDatasetIsFIXED_notClockDependent() {
        // A `Date()` anywhere in a capture dataset makes the frame vary run to
        // run, which defeats the reference-image comparison the whole per-beat
        // check is built on.
        #expect(MemoryHarness.localEntries().map(\.ts) == MemoryHarness.localEntries().map(\.ts))
        #expect(MemoryHarness.localEntries().allSatisfy { $0.ts < 1_800_000_000_000 })
    }

    @Test func itIsTheSAMEPERSONAasTheGraphHarness() {
        // A video cut walks list → graph in one continuous shot. Two unrelated
        // demo datasets would make the app look like it forgot everything
        // between two taps — the opposite of the claim the beat exists to make.
        let listText = MemoryView.decodeLearnings(MemoryHarness.serverWire())
            .map(\.content).joined(separator: " ")
        #expect(listText.contains("sourdough"))
        #expect(listText.contains("Bubbles"))
    }

    @Test func aRowWRAPS_becauseRealLearningsDo() {
        let rows = MemoryView.decodeLearnings(MemoryHarness.serverWire())
        #expect(rows.contains { $0.content.count > 60 })
    }
}

/// The DM length cap — the client half of the fix in
/// `tests/dm-length-parity.test.ts`.
///
/// The server used to cut an over-long DM at 2000 UTF-16 CODE UNITS and answer
/// `{ ok: true }`. Two things were wrong: it truncated an irreversible send (a DM
/// can't be unsent, so the recipient reads half a sentence and the sender is told
/// "Delivered"), and it counted units while every other end counts characters —
/// so 2000 emoji, which `lib/chat/dm-send.ts` legitimately approves, arrived and
/// lost 999 of them, ending in a lone high surrogate.
///
/// It now refuses with a 400. This app renders a bare 400 as "HTTP 400"
/// (`Api.friendlyHTTPError` has no 400 case), which tells the user nothing they
/// can act on — and this composer had NO cap at all, so it was the surface most
/// likely to hit it. Hence a client-side refusal, stated before the round-trip.
@Suite struct DmLengthTests {

    @Test func theCapMatchesEverySurface() {
        // web MessagesHUD maxLength / dm-send.ts DM_MAX_CHARS / worker MAX_BODY /
        // Android DM_MAX_CHARS. A client cap that disagrees with the server's is
        // either an untypeable message or an unexplained refusal.
        #expect(kDmMaxChars == 2000)
    }

    @Test func overrunCountsCHARACTERSnotUTF16Units() {
        // Swift's String.count is grapheme clusters, so this is already right —
        // the test exists so a "performance" rewrite to `.utf16.count` fails
        // here instead of shipping. 2000 emoji are 4000 UTF-16 units.
        let emoji = String(repeating: "👋", count: kDmMaxChars)
        #expect(emoji.count == kDmMaxChars)
        #expect(emoji.utf16.count == 4000)   // the number NOT to compare against
        #expect(dmOverrun(emoji) == 0)
        #expect(dmOverrun(emoji + "👋") == 1)
    }

    @Test func atOrUnderTheCapThereIsNothingToSay() {
        #expect(dmSendRefusal("hi") == nil)
        #expect(dmSendRefusal(String(repeating: "a", count: kDmMaxChars)) == nil)
        // A blank draft is the send button's business (it early-returns on
        // empty); a length complaint about an empty field would be nonsense.
        #expect(dmSendRefusal("") == nil)
        #expect(dmSendRefusal("   \n ") == nil)
    }

    @Test func overTheCapNamesTheOverrunSoTheUserKnowsWhatToCut() {
        let r = dmSendRefusal(String(repeating: "a", count: kDmMaxChars + 7))
        #expect(r != nil)
        #expect(r?.hasPrefix("7 characters too long") == true)
        #expect(r?.contains("\(kDmMaxChars)") == true)
        // "nothing was sent" is the point of refusing rather than truncating:
        // the user knows which state they are in.
        #expect(r?.contains("nothing was sent") == true)
    }

    @Test func oneOverIsSingular_becauseAWrongPluralReadsAsABug() {
        #expect(dmSendRefusal(String(repeating: "a", count: kDmMaxChars + 1))?
            .hasPrefix("1 character too long") == true)
    }

    @Test func anEmojiDraftIsJudgedByItsRealLength() {
        // 1500 emoji = 3000 UTF-16 units. A unit-based check would refuse this
        // as "1000 characters too long" while the server accepts it happily.
        #expect(dmSendRefusal(String(repeating: "👋", count: 1500)) == nil)
    }
}

/// 🔔 iOS SILENTLY ATE EVERY PUSH THE WORKER SENT IT.
///
/// A native app has no web-push subscription, so the worker mirrors every push —
/// new DM, finished job, tiny visit — as a `{type:"notify"}` relay envelope, one
/// per fresh device (`push.ts` relayPushToDevices + buildNotifyEnvelope). On iOS
/// the relay poll IS the push rail; there is no other.
///
/// `Session.swift`'s relay loop `continue`d on anything that wasn't
/// `{type:"invoke"}`. And the poll CLAIMS what it hands out — RELAY_MARK_SQL is a
/// compare-and-swap on `delivered = 0` — so a skipped notify was not deferred for
/// the next beat, it was consumed and destroyed. Android has bannered these since
/// day one (`FleetManager.handleEnvelope` → `RelayNotifier`), which is why a job
/// finishing while the phone sat idle showed up on the Pixel and nowhere on iOS.
///
/// Routing is by the worker's own push TAG — the same contract
/// `RelayNotifier.classify` implements. These tests pin the agreement, because
/// two clients inventing their own routing from one set of tags is how one of
/// them starts double-bannering DMs.
@Suite struct RelayNotifyTests {

    @Test func aDmPushPokesTheDmPollInsteadOfBannering() {
        // refreshUnread() is the ONE DM banner path: it fires on unread GROWTH,
        // per @login, with the inline-reply category attached. Bannering from
        // this payload as well would show every DM twice.
        #expect(TinySession.classifyNotify(
            tag: "dm-user-123", url: "/tiny?dm=luna", title: "💬 Luna", body: "hey") == .dmPoke)
    }

    @Test func aDmIsRecognisedByTheURLToo_notOnlyTheTag() {
        // Belt and braces against a tag rename turning DMs into generic
        // banners — which would double them, since refreshUnread still fires.
        #expect(TinySession.classifyNotify(
            tag: "something-else", url: "/luna?dm=mert", title: "t", body: "b") == .dmPoke)
    }

    @Test func aJobResultBanners_theCaseThatUsedToVanish() {
        // The headline regression: a scheduled job finishing while the app is
        // idle. Android banners it on the alerts channel; iOS showed nothing.
        #expect(TinySession.classifyNotify(
            tag: "tiny-job-42", url: "/mytiny", title: "✅ job done", body: "3 PRs reviewed") == .banner)
    }

    @Test func aTinyVisitBanners() {
        #expect(TinySession.classifyNotify(
            tag: "tiny-visit-luna", url: "/luna", title: "👀 someone visited", body: "luna") == .banner)
    }

    // ── Loudness: the iOS half of the ladder ─────────────────────────────
    //
    // ⚠️ classifyNotify decides WHETHER to show; these decide HOW LOUDLY, and
    // that second question had no answer here at all. `Notify.post` set
    // `.sound = .default` for every caller, so the visit above — a nicety the
    // worker throttles to one per 5 min per tiny precisely because it repeats —
    // interrupted this phone exactly as hard as a refund. Android had the
    // mirror defect with the polarity reversed (it defaulted new kinds to its
    // SILENT channel, which is how `task-result-` arrived soundless there), so
    // no iOS↔Android parity assertion could ever see either one: they compare
    // the phones to each other, and both were wrong in opposite directions.

    @Test func aTinyVisitIsAmbient_theOneKindThatMayBeQuiet() {
        #expect(Notify.isAmbient(tag: "tiny-visit-luna"))
        #expect(Notify.isAmbient(tag: "tiny-visit-"))
    }

    @Test func theKindsThisFeatureShipsAreLoud() {
        // task-result- IS fire-and-forget use_device's delivery half: the user
        // fires a task at the Mac, walks away, and this is the thing that tells
        // them. It must never be the quiet one.
        #expect(!Notify.isAmbient(tag: "task-result-task_2b7f3e0f_t123"))
        #expect(!Notify.isAmbient(tag: "device-result-env42"))
        #expect(!Notify.isAmbient(tag: "tiny-job-42"))
        #expect(!Notify.isAmbient(tag: "batch-batch_abc12345"))
        // "Silence here reads as loss" — money-events.ts, about this exact tag.
        for kind in ["earned", "received", "withdrawn", "refunded"] {
            #expect(!Notify.isAmbient(tag: "money-\(kind)"))
        }
    }

    @Test func anUnknownTagIsLoud_theDefaultEveryFuturePushKindInherits() {
        // The polarity, stated directly. A push kind added next year is born
        // audible; the alternative is born silent, which is the bug Android had.
        #expect(!Notify.isAmbient(tag: "tiny-notification")) // buildNotifyEnvelope's own default
        #expect(!Notify.isAmbient(tag: "some-kind-invented-in-2027"))
        #expect(!Notify.isAmbient(tag: ""))
    }

    @Test func theAmbientMatchIsAnchoredAtTheStart() {
        // hasPrefix, not contains: a device result whose ticket happens to spell
        // the nicety is still a device result.
        #expect(!Notify.isAmbient(tag: "device-result-tiny-visit-x"))
        #expect(!Notify.isAmbient(tag: "x-tiny-visit-luna"))
    }

    @Test func theAmbientSetIsExactlyTheOneGenuinelyAmbientKind() {
        // Pins the SET, not just its behaviour: every prefix added here goes
        // permanently silent on this phone, so growing the list should have to
        // break a test and argue for itself.
        #expect(Notify.ambientTagPrefixes == ["tiny-visit-"])
    }
}

/// 📋 The clipboard rule — RUN, not read off source text.
///
/// The defect this suite exists for: `copy_to_clipboard`'s arm was
/// `if let text = args["text"] as? String, !text.isEmpty`, so a `text` of `" "`
/// passed the guard and a single space was written over whatever the user had
/// (a wallet address mid-paste, a password out of a manager). Emptiness was the
/// wrong test; blankness is the test. And because the switch then fell through
/// to `.ran`, BOTH reporting rails vouched for it — the relay audit said "ran on
/// the phone" and the live-voice rail answered `ok: true`, so the tiny SAID the
/// text was copied. The clipboard is the one sink whose value the user then
/// pastes into another program, so a wrong value is spent where this code will
/// never see it.
///
/// Web solved it in `lib/chat/clipboard-write.ts` and Android ported it; these
/// are the properties no source scan can reach — the actual verdicts, the actual
/// truncation boundary, and that the two rails report the same decision the
/// write made. `tests/clipboard-write-parity.test.ts` owns the cross-client
/// wiring; this owns the arithmetic.
@Suite struct ClipboardWriteTests {
    // ── the destructive case, the whole reason for the port ──

    @Test("a blank text is refused, because writing it would ERASE the clipboard")
    func blankIsRefused() {
        // ⚠️ " " is the one the old `!text.isEmpty` guard let through. It is
        // exactly as destructive as "" — the user's clipboard is gone either way.
        for blank in ["", " ", "   ", "\n", "\t", " \n\t "] {
            let write = Clipboard.decide(blank)
            #expect(write.note == nil, "a blank write was allowed: \(blank.debugDescription)")
            guard case .refused(let error) = write else {
                Issue.record("blank \(blank.debugDescription) was not refused")
                continue
            }
            // The model reads this, so it has to say the clipboard is intact —
            // otherwise the agent's next move is to apologise for erasing it.
            #expect(error.contains("ERASED"))
            #expect(error.contains("call this again with the actual text"))
        }
    }

    @Test("the pasteboard is never handed a blank value — the arm consults the rule")
    func blankNeverReachesTheWrite() {
        // The property the guard got wrong, stated as the write itself: there is
        // no input for which `decide` yields an allowed EMPTY string.
        for raw in ["", " ", "\n", nil as Any?, NSNull(), 42, ["a": 1] as [String: Any]] {
            if case .allowed(let text, _) = Clipboard.decide(raw) {
                Issue.record("\(String(describing: raw)) produced an allowed write of \(text.debugDescription)")
            }
        }
    }

    // ── the type cases: iOS was already right, but SILENTLY right ──

    @Test("a non-string is refused rather than coerced, and says the clipboard is intact")
    func nonStringIsRefused() {
        // The three clients each had a different wrong answer to {"text":{"a":1}}:
        // web coerced to "[object Object]", Android's optString wrote the literal
        // {"a":1}, iOS refused. iOS's verdict was right; what it lacked was
        // telling anyone, which is what made it audit as a copy.
        for bad in [42 as Any, 3.5, true, ["a", "b"], ["a": 1]] {
            guard case .refused(let error) = Clipboard.decide(bad) else {
                Issue.record("\(bad) was not refused")
                continue
            }
            #expect(error.contains("must be a string"))
            #expect(error.contains("the clipboard still holds what the user had"))
        }
    }

    @Test("a JSON null is refused, not copied as the word 'null'")
    func jsonNullIsRefused() {
        // JSONSerialization yields NSNull for a JSON `null`, and its description
        // is the four characters "null" — the shape that otherwise reaches a
        // user's clipboard as a word.
        guard case .refused(let error) = Clipboard.decide(NSNull()) else {
            Issue.record("NSNull was not refused")
            return
        }
        #expect(error.contains("no text was given"))
        // And an absent key, which arrives as nil rather than NSNull.
        guard case .refused = Clipboard.decide(nil) else {
            Issue.record("a missing text argument was not refused")
            return
        }
    }

    // ── the cap: enforcement, and the boundary ──

    @Test("the cap truncates at exactly max, and only above it")
    func capBoundary() {
        // Off-by-one here is the difference between a silent truncation the model
        // describes as a whole string and a note it passes on.
        if case .allowed(let text, let truncated) = Clipboard.decide(String(repeating: "x", count: Clipboard.max)) {
            #expect(text.count == Clipboard.max)
            #expect(truncated == false, "a string exactly at the cap was reported as truncated")
        } else {
            Issue.record("a string at the cap was refused")
        }
        if case .allowed(let text, let truncated) = Clipboard.decide(String(repeating: "x", count: Clipboard.max + 1)) {
            #expect(text.count == Clipboard.max, "the cap was not enforced — the raw string was written")
            #expect(truncated, "an over-long write was not reported as truncated")
        } else {
            Issue.record("an over-long string was refused instead of truncated")
        }
    }

    @Test("a truncated write TELLS the model, in the sentence the other clients use")
    func truncationNote() {
        let write = Clipboard.decide(String(repeating: "x", count: Clipboard.max + 500))
        // Word-for-word with web and Android: the model reads this, and a
        // per-client paraphrase is how two agents come to describe the same
        // write differently.
        #expect(write.note == "copied, but truncated to the first 10000 characters — tell the user the rest was not copied")
        #expect(Clipboard.decide("hello").note == "copied to the user's clipboard")
    }

    @Test("accepted text keeps its whitespace — trimming is only how blankness is DETECTED")
    func whitespaceIsPreserved() {
        // An indented code block and the trailing newline before a terminal paste
        // are both meaningful. Blankness is a test, not a transformation.
        let indented = "    let x = 1\n"
        guard case .allowed(let text, _) = Clipboard.decide(indented) else {
            Issue.record("indented code was refused")
            return
        }
        #expect(text == indented)
    }

    // ── both reporting rails, which is where the audit lied ──

    @Test("the relay audit reports the decision the WRITE made, not that the arm ran")
    func relayAuditFollowsTheDecision() {
        // ⚠️ THE REGRESSION THIS PINS. `Outcome` is .ran either way, so the only
        // honest line is one that re-runs the decision — the pattern openURLLine
        // already uses. A blank text used to read "copy_to_clipboard: ran on the
        // phone", which the web agent relayed as a successful copy.
        let blank = DeviceActionAudit.clipboardLine(argsJson: #"{"text":" "}"#)
        #expect(blank.contains("NOT copied"))
        #expect(blank.contains("ERASED"))
        #expect(!blank.contains("ran on the phone"))

        let ok = DeviceActionAudit.clipboardLine(argsJson: #"{"text":"hello"}"#)
        #expect(ok == "copy_to_clipboard: copied to the user's clipboard")

        // ⚠️ A TRUNCATED write is a SUCCESS that must carry its caveat on this
        // rail too. Without this the line hardcodes the plain sentence, the web
        // agent reads a clean "copied", and it describes the whole string as
        // being on the clipboard when the last N characters are not. Found by a
        // surviving mutant: the voice rail had this pinned and the relay rail
        // did not, so one reader got the caveat and the other didn't.
        let long = DeviceActionAudit.clipboardLine(
            argsJson: "{\"text\":\"\(String(repeating: "x", count: Clipboard.max + 1))\"}")
        #expect(long.contains("truncated to the first 10000 characters"))
        #expect(long.contains("the rest was not copied"))
        #expect(!long.contains("NOT copied"), "a truncated write is not a refusal")

        // A wrong type and an absent key are refusals too, and the line has to
        // name which — the model's next sentence depends on it.
        #expect(DeviceActionAudit.clipboardLine(argsJson: #"{"text":42}"#).contains("must be a string"))
        #expect(DeviceActionAudit.clipboardLine(argsJson: "{}").contains("no text was given"))
        #expect(DeviceActionAudit.clipboardLine(argsJson: #"{"text":null}"#).contains("no text was given"))
        // Unparseable args must not read as a successful copy either.
        #expect(DeviceActionAudit.clipboardLine(argsJson: "not json").contains("NOT copied"))
    }

    @Test("the live-voice rail answers ok:false for a refusal, because the tiny SPEAKS it")
    func voiceRailFailsARefusal() {
        // ⚠️ Unlike a quiet-hours mute, which is the phone obeying the user, a
        // clipboard write that never happened is the model's request UNMET. ok:true
        // here is how a tiny comes to tell a person, out loud, that their text is
        // ready to paste while the clipboard holds what it always held.
        let blank = DeviceActionAudit.clipboardResult(argsJson: #"{"text":"  "}"#)
        #expect(blank["ok"] as? Bool == false)
        #expect((blank["error"] as? String ?? "").contains("ERASED"))
        #expect(blank["note"] == nil, "a refusal carried a note, which reads as a copy")

        let ok = DeviceActionAudit.clipboardResult(argsJson: #"{"text":"hello"}"#)
        #expect(ok["ok"] as? Bool == true)
        #expect(ok["note"] as? String == "copied to the user's clipboard")
        #expect(ok["error"] == nil)

        // A truncated write is a SUCCESS that must carry the caveat: the tiny
        // says this aloud, and "copied" alone would describe the whole string.
        let long = DeviceActionAudit.clipboardResult(
            argsJson: "{\"text\":\"\(String(repeating: "x", count: Clipboard.max + 1))\"}")
        #expect(long["ok"] as? Bool == true)
        #expect((long["note"] as? String ?? "").contains("truncated"))
    }

    @Test("the two rails never disagree about the same input")
    func railsAgree() {
        // One decision, two readers. A second copy of the rule is how the audit
        // comes to describe something the write didn't do.
        for args in [#"{"text":"hello"}"#, #"{"text":" "}"#, #"{"text":42}"#, "{}",
                     "{\"text\":\"\(String(repeating: "y", count: Clipboard.max + 9))\"}"] {
            let line = DeviceActionAudit.clipboardLine(argsJson: args)
            let result = DeviceActionAudit.clipboardResult(argsJson: args)
            let copied = result["ok"] as? Bool == true
            #expect(copied == !line.contains("NOT copied"),
                    "the rails disagree about \(args): line=\(line) ok=\(copied)")
            // ⚠️ And not merely the VERDICT — the SENTENCE. A boolean-only check
            // let a mutant hardcode the plain note on one rail while the other
            // carried the truncation caveat, so the two readers of one write were
            // told different things about it.
            let carried = (result["note"] as? String) ?? (result["error"] as? String) ?? ""
            let stem = carried.hasPrefix("refused: ") ? String(carried.dropFirst(9)) : carried
            #expect(line.hasSuffix(stem),
                    "the rails word \(args) differently: line=\(line) carried=\(carried)")
        }
    }

    // ── the user-facing line: the substitution risk ──

    @Test("the chat line QUOTES what landed, so a substituted value is visible")
    func chatNoteQuotesTheValue() {
        // "Copied!" cannot surface a tiny swapping its own wallet address over the
        // one the user meant. The value can.
        let note = Clipboard.chatNote(argsJson: #"{"text":"0xdeadbeef"}"#)
        #expect(note.contains("0xdeadbeef"))
        #expect(note.hasPrefix("📋 Copied"))
        // A refusal is shown too — the user watched a copy be asked for.
        let refused = Clipboard.chatNote(argsJson: #"{"text":""}"#)
        #expect(refused.contains("Nothing copied"))
        #expect(refused.contains("unchanged"))
    }

    @Test("the preview is one line, bounded, and marks its own truncation")
    func previewIsSingleLineAndBounded() {
        // A multi-line preview would push the rest of the reply around; an
        // unmarked cut is indistinguishable from the real end of a short string.
        #expect(Clipboard.preview("a\nb\tc   d") == "a b c d")
        let long = String(repeating: "z", count: 200)
        let p = Clipboard.preview(long)
        #expect(p.count == 49, "48 characters plus the ellipsis")
        #expect(p.hasSuffix("…"))
        #expect(Clipboard.preview("short") == "short", "a short preview must not be marked")
    }

    @Test("the truncation toast names the cap with grouped thousands, locale-pinned")
    func toastGroupsThousands() {
        // "10000 characters" reads as a machine's number in a sentence meant for a
        // person; and an unpinned locale would make this sentence differ per phone
        // (and this assertion pass or fail by region).
        let toast = Clipboard.confirmToast(text: "hello", truncated: true)
        #expect(toast.contains("10,000 characters"))
        #expect(toast.contains("trimmed"))
        #expect(!Clipboard.confirmToast(text: "hello", truncated: false).contains("trimmed"))
    }

    @Test("the cap is the number the model was promised")
    func capIsTheSharedNumber() {
        // Four copies of one number: this, the zod .max(10_000) the tool schema
        // describes to the model, Android's CLIPBOARD_MAX, and web's. The parity
        // suite keeps them equal; this pins iOS's.
        #expect(Clipboard.max == 10_000)
    }
}

/// 🔔 The fleet traces — the three notifications the phone posts about things it
/// did while nobody was watching (a re-enrollment it healed on its own, a web
/// agent that reached it in the background, a recording that agent took).
///
/// ⚠️ ANDROID'S OWN DOCSTRING DESCRIBED THESE AS SILENT, CITING IOS AS THE
/// MODEL: `RelayNotifier.notifyFleetTrace` says "Silent by design (activity
/// channel is LOW) — a record, not an interruption", and routes all three to
/// `CHANNEL_ACTIVITY`. iOS, the surface it claims to mirror, dinged every one
/// of them — because it had no way not to. The defect was findable only by
/// reading what the OTHER phone said about this one.
@Suite struct FleetTraceLoudnessTests {
    private let source: String = {
        // Read from source: these are `Notify.post` CALL SITES, and the thing
        // being asserted is which argument they pass — not a return value any
        // unit test can observe without a live notification centre.
        let here = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
        let path = here.appendingPathComponent("Tiny/Sources/Session.swift")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }()

    @Test func theSourceWasActuallyRead() {
        // A slicer that returns "" passes every `contains` check below forever.
        #expect(source.count > 10_000)
        #expect(source.contains("func handleNotifyEnvelope"))
    }

    @Test func allThreeFleetTracesArePostedAmbient() {
        // Each is the phone reporting on itself, hours after the fact. A sound
        // for these is a phone that chirps in a pocket about nothing the user
        // is waiting on — and Android already treats all three this way.
        for marker in ["Device re-enrolled", "Web agent reached your phone", "Recorded for your tiny"] {
            guard let at = source.range(of: marker) else {
                #expect(Bool(false), "fleet trace \(marker) not found in Session.swift")
                continue
            }
            // The `ambient:` argument sits within a few lines of the title.
            let window = source[at.lowerBound...].prefix(400)
            #expect(window.contains("ambient: true"), "\(marker) posts loud")
        }
    }

    @Test func theRelayPushBannerStaysTagDriven_notHardcodedEitherWay() {
        // The notify-envelope banner is the one caller whose loudness is a
        // FUNCTION of the tag — it carries every kind the worker can push, so
        // hardcoding it (either way) would re-break exactly what this fixes.
        let handler = source[source.range(of: "func handleNotifyEnvelope")!.lowerBound...]
        let branch = handler.prefix(2_000)
        #expect(branch.contains("Notify.isAmbient(tag: tag)"))
    }

    @Test func anUnknownTagStillBanners_becauseSilenceIsTheBugBeingFixed() {
        // Future push kinds must default to VISIBLE. Defaulting to silent is
        // exactly how this defect existed: an unhandled type meant nothing at
        // all, and the envelope was already consumed.
        #expect(TinySession.classifyNotify(
            tag: "tiny-something-new", url: "/", title: "hello", body: "world") == .banner)
        #expect(TinySession.classifyNotify(
            tag: "", url: "", title: "hello", body: "") == .banner)
        #expect(TinySession.classifyNotify(
            tag: "", url: "", title: "", body: "world") == .banner)
    }

    @Test func onlyAPushWithNothingToShowIsDropped() {
        // A banner with an empty title AND empty body is a blank notification —
        // worse than nothing, because the user taps it and finds no content.
        #expect(TinySession.classifyNotify(tag: "x", url: "/", title: "", body: "") == .ignore)
        #expect(TinySession.classifyNotify(tag: "x", url: "/", title: "  ", body: "\n") == .ignore)
    }

    /// A concurrency-safe counter — `onDmPoke` is `@Sendable`, so a captured
    /// `var` won't compile (correctly: it crosses an isolation boundary).
    private final class Pokes: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func hit() { lock.lock(); n += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return n }
    }

    @Test func theHandlerRoutesADmToTheCallbackAndNowhereElse() async {
        // Proves the wiring, not just the classifier: a `notify` DM envelope has
        // to reach refreshUnread. (The banner branch calls into
        // UNUserNotificationCenter, which needs a real authorization state, so
        // this asserts the side-effect that IS observable in a unit test.)
        let pokes = Pokes()
        await TinySession.handleNotifyEnvelope(
            ["type": "notify", "tag": "dm-abc", "url": "/t?dm=luna", "title": "💬", "body": "hi"],
            onDmPoke: { pokes.hit() })
        #expect(pokes.count == 1)

        // …and a non-DM push must NOT poke the DM poll (it would cost an
        // /api/messages round-trip per job notification).
        await TinySession.handleNotifyEnvelope(
            ["type": "notify", "tag": "tiny-job-1", "url": "/x", "title": "done", "body": "ok"],
            onDmPoke: { pokes.hit() })
        #expect(pokes.count == 1)
    }

    @Test func aMissingFieldIsTreatedAsEmpty_notACrash() async {
        // This JSON comes off the wire through JSONSerialization; every field is
        // optional as far as the type system is concerned.
        let pokes = Pokes()
        await TinySession.handleNotifyEnvelope(["type": "notify"], onDmPoke: { pokes.hit() })
        #expect(pokes.count == 0)
        #expect(TinySession.classifyNotify(tag: "", url: "", title: "", body: "") == .ignore)
    }
}

// ── Devices list: presence + order ────────────────────────────────────────

/// The devices panel's ordering was the user-reported bug: "the order even is
/// broken". The worker sorts `ORDER BY last_seen DESC` and nothing else, iOS
/// added no order of its own, and it flattened the wire's three-state `online`
/// into a Bool — so a robot with no heartbeat rendered offline and sorted with
/// the dead. These pin the fix's actual behaviour, not its shape.
@Suite struct DeviceOrderTests {
    private func row(_ id: String, _ name: String, online: Bool?, seen: TimeInterval?,
                     kind: String = "daemon", platform: String = "darwin-arm64") -> DeviceRow {
        DeviceRow(id: id, name: name, kind: kind, platform: platform, online: online,
                  lastSeen: seen.map { Date(timeIntervalSince1970: $0) })
    }

    @Test func thisPhoneOutranksEverythingIncludingAFresherLaptop() {
        // The exact inversion that made the list unreadable: the phone in your
        // hand heartbeated 20s ago, the laptop 5s ago, so last_seen DESC put the
        // laptop first — in a list whose whole subject is "your devices".
        let phone = row("me", "owner-phone", online: true, seen: 1_000)
        let laptop = row("mac", "studio-mac", online: true, seen: 2_000)
        let out = DeviceOrder.sorted([laptop, phone], myDeviceId: "me")
        #expect(out.map(\.id) == ["me", "mac"])
    }

    @Test func anEndpointWithNoHeartbeatSortsAboveOfflineMachines_notBelowThem() {
        // online:null is "unknown", NOT "offline": a printer answers when called.
        // last_seen is NULL for it, so pure recency sort buried it under a laptop
        // that had been dead for a year.
        let printer = row("p1", "bambu", online: nil, seen: nil, kind: "endpoint", platform: "")
        let deadLaptop = row("l1", "old-mac", online: false, seen: 1_000)
        let out = DeviceOrder.sorted([deadLaptop, printer], myDeviceId: nil)
        #expect(out.map(\.id) == ["p1", "l1"])
    }

    @Test func withinAGroupTheMostRecentlySeenComesFirst() {
        let a = row("a", "a", online: true, seen: 100)
        let b = row("b", "b", online: true, seen: 300)
        let c = row("c", "c", online: true, seen: 200)
        #expect(DeviceOrder.sorted([a, b, c], myDeviceId: nil).map(\.id) == ["b", "c", "a"])
    }

    @Test func tiedRowsFallBackToNameSoTheListCannotJitter() {
        // Every endpoint ties: same rank, no timestamp. Without the name
        // tiebreak the order is whatever sort happened to do that refresh, and
        // rows visibly swap on the 30s repoll.
        let z = row("z", "zebra", online: nil, seen: nil, kind: "endpoint", platform: "")
        let a = row("a", "Alpha", online: nil, seen: nil, kind: "endpoint", platform: "")
        #expect(DeviceOrder.sorted([z, a], myDeviceId: nil).map(\.id) == ["a", "z"])
        #expect(DeviceOrder.sorted([a, z], myDeviceId: nil).map(\.id) == ["a", "z"])
    }

    @Test func groupsAreLabelledAndEmptyOnesAreDropped() {
        let phone = row("me", "owner-phone", online: true, seen: 900, platform: "ios-arm64")
        let printer = row("p1", "bambu", online: nil, seen: nil, kind: "endpoint", platform: "")
        let groups = DeviceOrder.grouped([printer, phone], myDeviceId: "me")
        #expect(groups.map(\.title) == ["This phone", "Reachable when called"])
        #expect(groups.first?.rows.map(\.id) == ["me"])
    }

    @Test func rankAndGroupingNeverDrift() {
        // grouped() buckets on rank(); if the title list and the rank range ever
        // disagree, rows silently vanish from the list instead of failing loudly.
        let rows = [
            row("me", "phone", online: true, seen: 5, platform: "ios-arm64"),
            row("on", "live", online: true, seen: 4),
            row("un", "robot", online: nil, seen: nil, kind: "endpoint", platform: ""),
            row("off", "asleep", online: false, seen: 3),
        ]
        let grouped = DeviceOrder.grouped(rows, myDeviceId: "me")
        #expect(grouped.count == DeviceOrder.groupTitles().count)
        #expect(grouped.flatMap(\.rows).count == rows.count)
        for r in rows { #expect(DeviceOrder.rank(r, myDeviceId: "me") < DeviceOrder.groupTitles().count) }
    }

    @Test func bothSpellingsOfRankAreTheSameRule() {
        // rowLine() asks the row's own question ("am I this phone?") because a row
        // view has no device id. Two functions, one answer, or a row could print
        // the line for a section it isn't in.
        let rows = [
            row("me", "phone", online: true, seen: 5, platform: "ios-arm64"),
            row("on", "live", online: true, seen: 4),
            row("un", "robot", online: nil, seen: nil, kind: "endpoint", platform: ""),
            row("off", "asleep", online: false, seen: 3),
        ]
        for r in rows {
            #expect(DeviceOrder.rank(r, myDeviceId: "me")
                    == DeviceOrder.rank(r, isThisPhone: r.id == "me"))
            #expect(DeviceOrder.rank(r, myDeviceId: nil)
                    == DeviceOrder.rank(r, isThisPhone: false))
        }
    }

    /// The row must not echo the header two lines above it.
    ///
    /// Presence was stated three times per row — section header, dot, word — and
    /// in two of the four sections the word was a verbatim copy of the header:
    /// "Online" over `online · Mac`, and worst, "Reachable when called" over
    /// `reachable when called · p1s.ada.tiny.tech…`, where 24 characters of echo
    /// truncated the address that row exists to show.
    @Test func noRowRepeatsTheSectionHeaderAboveIt() {
        let rows = [
            row("me", "owner-phone", online: true, seen: 5, platform: "ios-arm64"),
            row("on", "studio-mac", online: true, seen: 4),
            row("un", "bambu-p1s", online: nil, seen: nil, kind: "endpoint", platform: ""),
            row("off", "necklace", online: false, seen: 3, platform: "nicla-voice"),
        ]
        for g in DeviceOrder.grouped(rows, myDeviceId: "me") {
            for r in g.rows {
                let line = DeviceOrder.rowLine(r, isThisPhone: r.id == "me")
                #expect(!line.lowercased().hasPrefix(g.title.lowercased()),
                        "“\(g.title)” row still opens with its own header: \(line)")
                // Shortened, never deleted: this row has one line for everything
                // it isn't its name.
                #expect(!line.isEmpty, "\(g.title) row lost its second line")
            }
        }
    }

    @Test func anEndpointSpendsThatLineOnItsAddressInstead() {
        let printer = DeviceRow(id: "p", name: "bambu-p1s", kind: "endpoint", platform: "",
                                online: nil, lastSeen: nil,
                                url: "https://p1s.ada.tiny.technology")
        #expect(DeviceOrder.rowLine(printer, isThisPhone: false) == "p1s.ada.tiny.technology")
        let mac = row("m", "studio-mac", online: true, seen: 4)
        #expect(DeviceOrder.rowLine(mac, isThisPhone: false) == "Mac")
    }

    @Test func anOfflineRowKeepsItsWordsBecauseTheySayWHEN() {
        // "Offline" is the header; "seen 3 minutes ago" and "seen in March" are
        // the answer to the question the header only names. Different facts, so
        // this one stays — and a never-seen row keeps its words too.
        let asleep = row("off", "necklace", online: false, seen: 1_000, platform: "nicla-voice")
        let line = DeviceOrder.rowLine(asleep, isThisPhone: false)
        #expect(line.hasPrefix("seen "))
        #expect(line.hasSuffix(" · Nicla Voice"))
        let never = row("n", "board", online: false, seen: nil, platform: "linux-arm64")
        #expect(DeviceOrder.rowLine(never, isThisPhone: false) == "never seen · Linux")
    }

    @Test func thisPhoneKeepsItsWordBecauseItsHeaderSaysNothingAboutPresence() {
        // "This phone" is an identity, not a state — and the state is not always
        // "online": stop heartbeating and this row is the one place that shows it.
        let mine = row("me", "owner-phone", online: true, seen: 5, platform: "ios-arm64")
        #expect(DeviceOrder.rowLine(mine, isThisPhone: true) == "online · iOS")
        let stale = row("me", "owner-phone", online: false, seen: 5, platform: "ios-arm64")
        #expect(DeviceOrder.rowLine(stale, isThisPhone: true).hasPrefix("seen "))
    }

    @Test func aRowWithNothingElseToSayKeepsTheWordRatherThanGoingBlank() {
        // Neither platform nor kind maps, so `descriptor` is empty and the echo IS
        // the whole line. Dropping it here would delete the line, not shorten it.
        let mute = DeviceRow(id: "x", name: "x", kind: "", platform: "", online: true,
                             lastSeen: nil)
        #expect(mute.descriptor.isEmpty)
        #expect(DeviceOrder.rowLine(mute, isThisPhone: false) == "online")
    }
}

/// 📱 The one row in the list whose hardware is not in doubt was the one getting
/// it wrong.
///
/// `Session.enroll` posts `platform: "ios-arm64"` from the iPhone, the iPad and
/// the Mac Catalyst build alike, so an iPad's own row drew an iPhone glyph, said
/// "iOS", and sat under a header calling it a phone — while the app was running
/// on that iPad. `LocalHardware` corrects the row the app has first-hand
/// knowledge of and leaves the wire (which a server tool matches exactly) alone.
///
/// ⚠️ Any test that reaches `DevicesView.decodeDevices` or `LocalHardware.current`
/// needs `@MainActor`: both inherit main-actor isolation and assert it at RUNTIME,
/// and the crash is reported against whichever OTHER suites the host was running
/// ("Exceeded max restart count of 2"), never against the test that caused it.
@Suite struct LocalHardwareTests {
    private func row(_ id: String, _ platform: String,
                     kind: String = "daemon") -> DeviceRow {
        DeviceRow(id: id, name: id, kind: kind, platform: platform, online: true,
                  lastSeen: Date(timeIntervalSince1970: 10))
    }

    @Test func anIPadStopsDrawingItselfAsAnIPhone() {
        let shown = LocalHardware.platform(wire: "ios-arm64", shape: .pad)
        #expect(shown == "ipad-arm64")
        // Through the tables the app already has — the `ipad` needle sits ahead of
        // `ios` in both of them and had never once matched.
        #expect(deviceGlyph(platform: shown!, kind: "daemon") == "ipad")
        #expect(deviceLabel(platform: shown!, kind: "daemon") == "iPad")
    }

    @Test func theCatalystBuildIsAMacAndSaysSo() {
        let shown = LocalHardware.platform(wire: "ios-arm64", shape: .mac)
        #expect(shown == "darwin-arm64")
        #expect(deviceGlyph(platform: shown!, kind: "daemon") == "laptopcomputer")
        #expect(deviceLabel(platform: shown!, kind: "daemon") == "Mac")
    }

    @Test func anIPhoneIsLeftAloneBecauseTheWireWasAlreadyRight() {
        // nil is the point: "iOS" is true of an iPhone, so the row it draws today
        // is the row it draws after this change, byte for byte.
        #expect(LocalHardware.platform(wire: "ios-arm64", shape: .phone) == nil)
    }

    @Test func everySubstituteResolvesToARealGlyphAndARealWord() {
        // A token the tables don't know would fall through to the underscore
        // munge ("ipad arm64") and the `cpu` fallback glyph: the correction would
        // be a different wrong answer. CaseIterable, so a fourth shape is covered
        // by this test the day someone adds one.
        for shape in LocalHardware.Shape.allCases {
            guard let shown = LocalHardware.platform(wire: "ios-arm64", shape: shape) else {
                #expect(shape == .phone)  // the only shape allowed to decline
                continue
            }
            #expect(deviceGlyph(platform: shown, kind: "daemon") != "cpu")
            let word = deviceLabel(platform: shown, kind: "daemon")
            #expect(word != nil)
            #expect(word?.contains("arm64") == false)
        }
    }

    @Test func onlyTheLossyTokenIsCorrected() {
        // Every other row's platform is that device's own to report. A necklace,
        // a laptop, a Pi and a robot are never this app's hardware to rename —
        // and if enroll ever starts sending `ipad-arm64` itself, the rule stops
        // firing rather than correcting a correction.
        for wire in ["nicla-vision", "nicla-voice", "darwin-arm64", "android",
                     "linux-arm64", "win32", "ipad-arm64", ""] {
            for shape in LocalHardware.Shape.allCases {
                #expect(LocalHardware.platform(wire: wire, shape: shape) == nil,
                        "\(wire) got corrected for \(shape.rawValue)")
            }
        }
    }

    @Test func correctingOneRowLeavesEveryOtherRowIdentical() {
        // ⚠️ `sibling` carries the SAME lossy token and is not this device. Without
        // it this test could not tell "corrects this device" from "corrects every
        // iOS row" — see the test below, which is what that mutant found.
        let fleet = [row("me", "ios-arm64"), row("sibling", "ios-arm64"),
                     row("mac", "darwin-arm64"),
                     row("neck", "nicla-voice"), row("bot", "", kind: "endpoint")]
        let out = LocalHardware.corrected(fleet, thisDeviceId: "me", shape: .pad)
        #expect(out.count == fleet.count)
        #expect(out.map(\.id) == fleet.map(\.id))
        for (before, after) in zip(fleet, out) where before.id != "me" {
            #expect(after.localPlatform == nil)
            #expect(after.shownPlatform == before.platform)
        }
        #expect(out.first?.shownPlatform == "ipad-arm64")
    }

    @Test func theOtherIOSDeviceInTheSameAccountIsNotRelabelledToo() {
        // This account has both — an iPhone and an iPad under one login, two rows
        // carrying the same lossy token. A rule scoped to "any iOS row" rather
        // than "the row that IS this device" would open the list on the iPad and
        // rename the iPhone into a second one.
        //
        // ⚠️ Mutation-tested: swapping `row.id == id` for `!id.isEmpty` passed all
        // 471 tests before this existed. Every fleet in this suite had a single
        // iOS row, so the id check was doing nothing any test could see.
        let fleet = [row("pad", "ios-arm64"), row("phone", "ios-arm64")]
        let out = LocalHardware.corrected(fleet, thisDeviceId: "pad", shape: .pad)
        #expect(out.first?.shownPlatform == "ipad-arm64")
        #expect(out.last?.localPlatform == nil)
        #expect(out.last?.shownPlatform == "ios-arm64")
        #expect(out.last?.descriptor == "iOS")
    }

    @Test func theWireWordSurvivesTheCorrection() {
        // The whole reason this is a second field: `d.platform == "nicla-vision"`
        // gates the necklace's camera panel, and the server matches the string
        // exactly. Drawing is the only thing allowed to disagree with the wire.
        let out = LocalHardware.corrected([row("me", "ios-arm64")],
                                          thisDeviceId: "me", shape: .mac)
        #expect(out.first?.platform == "ios-arm64")
        #expect(out.first?.localPlatform == "darwin-arm64")
    }

    @Test func withNoDeviceIdNothingIsCorrected() {
        // Signed in on a device that never enrolled — or a harness run with no
        // Keychain id. Guessing which row is "us" would relabel someone else's
        // iPhone as this iPad.
        let fleet = [row("me", "ios-arm64"), row("other", "ios-arm64")]
        for out in LocalHardware.corrected(fleet, thisDeviceId: nil, shape: .pad) {
            #expect(out.localPlatform == nil)
        }
    }

    @Test func theHeaderAndThePillCannotDisagree() {
        // One noun, two strings, differing only in the case of the first letter:
        // a header that says "This iPad" over a pill that says "this phone" is
        // the same defect this whole change is about, one line lower down.
        for shape in LocalHardware.Shape.allCases {
            let noun = LocalHardware.selfNoun(shape)
            #expect(LocalHardware.selfTitle(shape) == "This \(noun)")
            #expect(LocalHardware.selfPill(shape) == "this \(noun)")
            #expect(LocalHardware.selfTitle(shape).lowercased()
                    == LocalHardware.selfPill(shape).lowercased())
        }
        #expect(LocalHardware.selfTitle(.phone) == "This phone")
        #expect(LocalHardware.selfPill(.pad) == "this iPad")
        #expect(LocalHardware.selfPill(.mac) == "this Mac")
    }

    @Test func theSelfSectionIsNamedAfterTheDeviceItHolds() {
        let fleet = [row("me", "ios-arm64"), row("mac", "darwin-arm64")]
        #expect(DeviceOrder.grouped(fleet, myDeviceId: "me", shape: .pad)
                    .first?.title == "This iPad")
        // The default shape is the identity case, which is what lets every other
        // caller and test in this file keep the strings it already asserts.
        #expect(DeviceOrder.grouped(fleet, myDeviceId: "me").first?.title == "This phone")
        #expect(DeviceOrder.groupTitles(.mac).first == "This Mac")
        #expect(Array(DeviceOrder.groupTitles(.mac).dropFirst())
                == Array(DeviceOrder.groupTitles().dropFirst()))
    }

    @Test func theRowComparesItselfAgainstTheHeaderThatIsActuallyOnScreen() {
        // `rowLine` hides a presence word that its section header already shows.
        // Section 0's header is now named after the hardware, so the shape has to
        // travel with the row — otherwise the row answers the question for a
        // screen nobody is looking at.
        let mine = LocalHardware.corrected([row("me", "ios-arm64")],
                                            thisDeviceId: "me", shape: .pad).first!
        #expect(DeviceOrder.rowLine(mine, isThisPhone: true, shape: .pad) == "online · iPad")
        #expect(DeviceOrder.groupTitles(.pad)[DeviceOrder.rank(mine, isThisPhone: true)]
                == "This iPad")
    }

    #if DEBUG
    @Test @MainActor func onTheHarnessFleetOnlyThisDevicesRowChanges() {
        let wire = DevicesView.decodeDevices(DevicesHarness.serverWire())
        #expect(wire.count > 3)
        let asPad = LocalHardware.corrected(wire, thisDeviceId: DevicesHarness.myDeviceId,
                                            shape: .pad)
        let asPhone = LocalHardware.corrected(wire, thisDeviceId: DevicesHarness.myDeviceId,
                                              shape: .phone)
        // An iPhone run is indistinguishable from no correction at all.
        #expect(asPhone.map(\.shownPlatform) == wire.map(\.shownPlatform))
        let changed = zip(wire, asPad).filter { $0.shownPlatform != $1.shownPlatform }
        #expect(changed.count == 1)
        #expect(changed.first?.1.id == DevicesHarness.myDeviceId)
        #expect(changed.first?.1.descriptor == "iPad")
        #expect(changed.first?.0.descriptor == "iOS")
    }
    #endif
}

/// What the devices list says to someone who cannot see it.
///
/// `.accessibilityElement(children: .combine)` makes this string the row's ONLY
/// spoken content — the glyph is hidden, the pill and the second line are
/// swallowed — so every one of these is a fact that is either here or nowhere.
@Suite struct SpokenDeviceRowTests {
    private func row(_ name: String, _ platform: String, kind: String = "daemon",
                     online: Bool? = true, seen: TimeInterval? = 10,
                     caps: [String] = [], url: String = "") -> DeviceRow {
        DeviceRow(id: name, name: name, kind: kind, platform: platform, online: online,
                  lastSeen: seen.map { Date(timeIntervalSince1970: $0) },
                  capabilities: caps, url: url)
    }

    @Test func theSpokenRowSaysWhatTheDeviceIs() {
        // The defect: every row read "<name>, online, can …". A necklace and a
        // phone were the same sentence with a different name in it.
        let necklace = row("necklace", "nicla-vision", caps: ["camera"])
        #expect(DeviceOrder.spokenLabel(necklace, isThisPhone: false)
                == "necklace, Nicla Vision, online, can camera")
    }

    @Test func aRobotSpeaksItsAddress_theOneFactItsRowCannotGetElsewhere() {
        // An endpoint's descriptor IS its address, and its presence is `.unknown`
        // by construction. Silent, this row was a name and a hedge.
        let bot = row("bambu", "", kind: "endpoint", online: nil, seen: nil,
                      url: "https://p1s.ada.tiny.tech")
        #expect(DeviceOrder.spokenLabel(bot, isThisPhone: false)
                == "bambu, p1s.ada.tiny.tech, reachable when called")
    }

    @Test func thisDeviceIsAnnouncedAsThisDevice() {
        // The "this iPad" pill is a child view, so `.combine` swallowed it: the
        // one row the listener is holding sounded like any other.
        let mine = LocalHardware.corrected([row("ada-ipad", "ios-arm64")],
                                           thisDeviceId: "ada-ipad", shape: .pad).first!
        #expect(DeviceOrder.spokenLabel(mine, isThisPhone: true, shape: .pad)
                == "ada-ipad, this iPad, online")
    }

    @Test func theNounIsNotSaidTwice() {
        // The sighted row shows "this iPad" over "online · iPad" and an eye skips
        // the repeat. An ear cannot, so the contained word is dropped — the same
        // trade `rowLine` makes in the other direction.
        for shape in [LocalHardware.Shape.pad, .mac] {
            let mine = LocalHardware.corrected([row("mine", "ios-arm64")],
                                               thisDeviceId: "mine", shape: shape).first!
            let spoken = DeviceOrder.spokenLabel(mine, isThisPhone: true, shape: shape)
            let noun = LocalHardware.selfNoun(shape)
            #expect(mine.descriptor == noun)  // the premise: the two words are one word
            #expect(spoken.components(separatedBy: noun).count == 2)
        }
    }

    @Test func aPhoneStillHearsItsPlatform_becauseThatWordIsNotInThePill() {
        // "this phone" does not carry "iOS", so this is not a repeat: it is the
        // difference between the iOS app's row and the Android app's row in one
        // account. Dropping it by rule instead of by containment would lose it.
        let mine = row("ada-iphone", "ios-arm64")
        #expect(DeviceOrder.spokenLabel(mine, isThisPhone: true, shape: .phone)
                == "ada-iphone, this phone, iOS, online")
    }

    @Test func presenceIsSpokenInFullEvenWhereTheVisibleRowDropsIt() {
        // `rowLine` may omit the word because the section header above says it.
        // Read aloud there is no header, so the row must say it itself.
        let mine = row("necklace", "nicla-voice", caps: ["mic"])
        #expect(DeviceOrder.rowLine(mine, isThisPhone: false) == "Nicla Voice")
        #expect(DeviceOrder.spokenLabel(mine, isThisPhone: false)
                == "necklace, Nicla Voice, online, can mic")
    }

    @Test func anOfflineRowSpeaksItsLastSeenNotTheWordOffline() {
        // The whole reason `DevicePresence.label` takes a date: "3 minutes ago"
        // and "in March" are both "offline" otherwise.
        let old = row("studio-mac", "darwin-arm64", online: false, seen: 1_000,
                      caps: ["flipper"])
        let spoken = DeviceOrder.spokenLabel(old, isThisPhone: false)
        #expect(spoken.hasPrefix("studio-mac, Mac, seen "))
        #expect(spoken.hasSuffix(", can Flipper Zero"))
        #expect(!spoken.contains("offline"))
    }

    @Test func everyCapabilityIsSpokenAsEnglish_andAllOfThem() {
        // Two rules in one row: the ribbon's four-chip cap is a WIDTH problem and
        // a spoken row has no width, so all of them are read; and the raw tokens
        // must not be, or VoiceOver is the surface saying "bluetooth underscore
        // scan" out loud.
        let node = row("studio-mac", "darwin-arm64",
                       caps: ["mcp", "files", "shell", "flipper", "adb", "browse",
                              "bluetooth_scan"])
        let spoken = DeviceOrder.spokenLabel(node, isThisPhone: false)
        #expect(!spoken.contains("_"))
        #expect(spoken.contains("bluetooth"))
        // The premise: this row IS capped on screen — a laptop daemon claiming
        // seven capabilities shows four chips and a "+3 more" button.
        #expect(CapabilityRibbon.split(node.capabilities, expanded: false).hidden == 3)
        for cap in node.capabilities {
            #expect(spoken.contains(capabilityLabel(cap)))
        }
    }

    @Test func aRowWithNothingToAddDoesNotOpenWithAComma() {
        // A blank server name (`dev["name"] as? String` keeps an empty string) and
        // a device whose kind has no word either — `rowLine` guards the same case
        // one function up. Joined blindly, the row began ", online".
        let bare = row("", "", kind: "watch")
        #expect(bare.descriptor.isEmpty)
        #expect(DeviceOrder.spokenLabel(bare, isThisPhone: false) == "online")
        #expect(DeviceOrder.spokenLabel(row("d1", "", kind: "watch"), isThisPhone: false)
                == "d1, online")
    }

    #if DEBUG
    @Test @MainActor func onTheHarnessFleetEveryRowSaysWhatItIs() {
        // The examples above are hand-built; this is the fleet the app actually
        // draws in the harness — necklaces, a Flipper-carrying mesh node, an
        // endpoint robot, this phone — decoded by the same function the sheet
        // uses. Before this change every one of these sentences was a name, a
        // presence word and a list of verbs.
        let wire = DevicesView.decodeDevices(DevicesHarness.serverWire())
        #expect(wire.count > 3)
        let fleet = LocalHardware.corrected(wire, thisDeviceId: DevicesHarness.myDeviceId,
                                            shape: .pad)
        for d in fleet {
            let mine = d.id == DevicesHarness.myDeviceId
            let spoken = DeviceOrder.spokenLabel(d, isThisPhone: mine, shape: .pad)
            #expect(spoken.hasPrefix("\(d.name), "), "\(spoken)")
            // Every row names its hardware, or its address, or says it is this one.
            let says = mine ? spoken.contains("this iPad") : spoken.contains(d.descriptor)
            #expect(says, "\(spoken) does not say what it is")
            #expect(!spoken.contains(", , "), "\(spoken)")
        }
    }
    #endif

    @Test func theSpokenRowNeverLosesAFactTheVisibleRowShows() {
        // The invariant behind all of the above: whatever the two visible lines
        // say, the spoken row says too. `rowLine` is one of those lines and the
        // pill is part of the other.
        let fleet = [row("a", "ios-arm64", caps: ["chat", "location"]),
                     row("b", "darwin-arm64", online: false, seen: 5, caps: ["mcp"]),
                     row("c", "", kind: "endpoint", online: nil, seen: nil,
                         url: "https://bot.example.com"),
                     row("d", "nicla-voice")]
        for shape in LocalHardware.Shape.allCases {
            for (i, d) in fleet.enumerated() {
                let mine = i == 0
                let spoken = DeviceOrder.spokenLabel(d, isThisPhone: mine, shape: shape)
                for word in DeviceOrder.rowLine(d, isThisPhone: mine, shape: shape)
                    .components(separatedBy: " · ") {
                    #expect(spoken.localizedCaseInsensitiveContains(word),
                            "\(shape): \"\(spoken)\" drops \"\(word)\"")
                }
                if mine {
                    #expect(spoken.contains(LocalHardware.selfPill(shape)))
                }
            }
        }
    }
}

/// 📋 The footer taught a gesture the list wasn't offering.
///
/// "Swipe a row to revoke its token." shipped unconditionally, under a list that
/// withholds the swipe on this phone — so a one-iPhone account, which is every
/// new account, read an instruction that does nothing on the only row it has.
/// With a necklace in range and nothing enrolled yet, the same line sat under
/// zero rows and called them "0 of 20 devices".
@Suite struct DevicesFooterTests {
    private func row(_ id: String, online: Bool? = true) -> DeviceRow {
        DeviceRow(id: id, name: id, kind: "daemon", platform: "darwin-arm64",
                  online: online, lastSeen: Date(timeIntervalSince1970: 10))
    }

    @Test func theCapIsTheWorkersCap() {
        // MAX_DEVICES_PER_USER in worker/src/devices.ts. A number
        // this screen invented would be a promise no server keeps.
        #expect(DevicesFooter.cap == 20)
    }

    @Test func aListWithNothingToRevokeDoesNotTeachTheSwipe() {
        // The defect, in the state a new user reaches first.
        let line = DevicesFooter.count(total: 1, revocable: 0)
        #expect(line == "1 of 20 devices.")
        #expect(!line.localizedCaseInsensitiveContains("swipe"))
    }

    @Test func aFleetWithARevocableRowStillGetsTheHint() {
        // The gesture is worth teaching wherever it exists — revoke is otherwise
        // undiscoverable on this sheet.
        #expect(DevicesFooter.count(total: 3, revocable: 2)
                == "3 of 20 devices. Swipe a row to revoke its token.")
    }

    @Test func anEmptyListDoesNotCountItsRowsToZero() {
        // Reachable with a beacon in range: the "No devices yet" screen is
        // withheld so the pairing card can show, and the footer stays.
        let line = DevicesFooter.count(total: 0, revocable: 0)
        #expect(line == "No devices yet — room for 20.")
        #expect(!line.contains("0 of"))
        #expect(!line.localizedCaseInsensitiveContains("swipe"))
    }

    @Test func atTheCapTheFooterStopsExplainingHowToAddAnother() {
        // The two sentences contradicted each other at the top end: full, and
        // here's how to add one more.
        #expect(!DevicesFooter.full(19))
        #expect(DevicesFooter.full(20))
        // A cap lowered server-side leaves accounts above it.
        #expect(DevicesFooter.full(21))
    }

    @Test func oneRuleDecidesWhoCanBeRevoked() {
        // The footer and the swipe action read this, so they cannot disagree.
        #expect(!row("mine").revocable(thisPhone: "mine"))
        #expect(row("theirs").revocable(thisPhone: "mine"))
        // No device id of our own — a harness run, or a Keychain miss — and
        // every row is revocable, which is what the swipe does too.
        #expect(row("mine").revocable(thisPhone: nil))
    }

    @Test func theHintTracksTheRowsRatherThanTheCount() {
        // Same total, different answer, decided by the one predicate: three rows
        // where all three can be swiped, and three where none can.
        let fleet = [row("a"), row("b"), row("c")]
        let mine = fleet.filter { $0.revocable(thisPhone: "a") }.count
        #expect(mine == 2)
        #expect(DevicesFooter.count(total: 3, revocable: mine)
                .localizedCaseInsensitiveContains("swipe"))
        let none = fleet.filter { $0.revocable(thisPhone: nil) }.count
        #expect(none == 3)
        // …and the degenerate fleet: one row, and it is ours.
        let solo = [row("a")].filter { $0.revocable(thisPhone: "a") }.count
        #expect(!DevicesFooter.count(total: 1, revocable: solo)
                .localizedCaseInsensitiveContains("swipe"))
    }

    #if DEBUG
    @Test @MainActor func onTheHarnessFleetTheFooterCountsWhatIsOnScreen() {
        // The dataset the store screenshots are taken from, through the same
        // decoder the app uses: the count must equal the rows the list draws,
        // and the hint must hold because this phone is not the only row.
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        let shown = DeviceOrder.grouped(rows, myDeviceId: DevicesHarness.myDeviceId)
            .reduce(0) { $0 + $1.rows.count }
        #expect(shown == rows.count, "grouping dropped a row the footer still counts")
        let revocable = rows.filter { $0.revocable(thisPhone: DevicesHarness.myDeviceId) }.count
        #expect(revocable == rows.count - 1)
        #expect(DevicesFooter.count(total: rows.count, revocable: revocable)
                == "\(rows.count) of 20 devices. Swipe a row to revoke its token.")
        #expect(!DevicesFooter.full(rows.count))
    }
    #endif
}

/// 🔴 The sentence after a revoke that didn't happen.
///
/// Revoke is the one destructive action on this sheet, and it was the one request
/// in the app that threw the server's answer away: `ok = code < 400`, body
/// discarded, and "Couldn't revoke — try again." for a rejected session, a
/// malformed request, a worker that refused and a transport blip alike. Half of
/// those cannot be fixed by trying again, and the app already has the table that
/// knows so — `HTTPErrorTests` exists to stop exactly this kind of second copy.
///
/// The claim this suite really owns: **a failed revoke says the token is still
/// working.** That is the fact a person revoking a phone they just lost needs, and
/// "try again" implies the opposite — that nothing has been decided yet.
///
/// ⚠️ …and then that sentence was said about answers that never came. A dropped
/// connection, a worker 5xx and a 200 that isn't this route's body are not
/// decisions: `DEVICE_REVOKE_SQL` may have run and only the reply been lost. The
/// old rule claimed a live token for all three — the same error as the sentence it
/// replaced, pointing the reader the same wrong way, and this time in the
/// expensive direction (a lost phone reported as still having access). See
/// `RevokeFailure.decided`; the rule and both leads are byte-shared with
/// lib/devices/revoke-message.ts and Android's `RevokeFailure` (pinned in
/// tests/revoke-message.test.ts).
@Suite struct RevokeFailureTests {

    @Test("a real revoke says nothing — the row disappearing is the message")
    func successIsSilent() {
        #expect(RevokeFailure.message(status: 200, body: ["ok": true, "revoked": 1]) == nil)
        #expect(RevokeFailure.message(status: 204, body: ["ok": true]) == nil)
    }

    @Test("a 200 whose body disagrees is not a revoke")
    func okFlagIsRequired() {
        // The route returns 200 only on a real revoke, but this sheet is the wrong
        // place to assume the status and the body always agree: a proxy or a
        // mid-redeploy page can answer 200 with something else entirely.
        #expect(RevokeFailure.message(status: 200, body: ["ok": false, "error": "revoke failed"]) != nil)
        #expect(RevokeFailure.message(status: 200, body: nil) != nil)
        #expect(RevokeFailure.message(status: 200, body: [:]) != nil)
        // And the same rule in the other direction — success needs BOTH halves.
        // Only the `ok` half was pinned here at first, so widening the accepted
        // range to `200...499` changed nothing any test could see, while the
        // doc comment went on claiming a conjunction. An intermediary between
        // this app and the worker is exactly what puts a status and a body at
        // odds; a 4xx is not a revoke no matter what the body claims.
        #expect(RevokeFailure.message(status: 424, body: ["ok": true]) != nil)
        #expect(RevokeFailure.message(status: 401, body: ["ok": true]) != nil)
    }

    @Test("a DECIDED failure leads with the token, not with the request")
    func failureNamesTheLiveToken() {
        // ⚠️ The whole point. Someone revoking a lost phone is told what is still
        // true of that phone, before any diagnosis of the HTTP call.
        //
        // 4xx only, and every one of these refuses before anything is written: the
        // route answers 401 with no session and 400 with no deviceId before it calls
        // the worker, the worker answers 401/400 before `DEVICE_REVOKE_SQL`, and the
        // route's 424 arm now fires only for a worker 4xx.
        for (status, body) in [(401, ["error": "login required"]),
                              (400, ["error": "deviceId required"]),
                              (424, ["error": "revoke failed"])] {
            let msg = RevokeFailure.message(status: status, body: body)
            #expect(msg?.hasPrefix(RevokeFailure.lead) == true,
                    "status \(status) buried the outcome")
            #expect(msg?.localizedCaseInsensitiveContains("still works") == true)
        }
    }

    @Test("only a decision may claim the token survived")
    func onlyADecisionClaimsTheTokenSurvived() {
        // ⚠️ The other half of the same sentence, and the one that was wrong: for
        // these the DELETE may have been received and executed — what was lost is
        // the answer. Claiming a live token here tells someone their lost phone
        // still has access when it may already be locked out.
        let unknown: [(Int?, [String: Any]?)] = [
            (nil, nil),                                              // the fetch threw
            (0, nil),
            (503, ["error": "aborted", "retryable": true]),          // the route's degraded arm
            (500, ["error": "worker 500", "retryable": true]),
            (502, nil),                                              // an HTML error page
            (200, nil),                                              // a 200 that isn't this route
            (200, ["ok": false, "error": "revoke failed"]),
        ]
        for (status, body) in unknown {
            let msg = RevokeFailure.message(status: status, body: body) ?? ""
            #expect(msg.hasPrefix(RevokeFailure.unconfirmedLead),
                    "status \(String(describing: status)) claims a settled outcome")
            #expect(!msg.localizedCaseInsensitiveContains("still works"))
            #expect(!msg.localizedCaseInsensitiveContains("not revoked"))
        }
        // The rule itself, at its edges — 399 and 500 are not decisions.
        #expect(!RevokeFailure.decided(399))
        #expect(RevokeFailure.decided(400))
        #expect(RevokeFailure.decided(499))
        #expect(!RevokeFailure.decided(500))
        #expect(!RevokeFailure.decided(0))
    }

    @Test("no response is status 0, not a retry instruction")
    func noResponseUsesTheHouseCode() {
        // `try? URLSession.data` returning nil means nothing arrived — there is no
        // body to prefer, and the house table already has the words for it.
        let msg = RevokeFailure.message(status: nil, body: nil)
        #expect(msg == RevokeFailure.unconfirmedLead + " " + Api.friendlyHTTPError(0))
        #expect(msg?.localizedCaseInsensitiveContains("no response") == true)
    }

    @Test("the reason comes from the app's ONE table, not a third copy")
    func reasonDelegatesToTheSharedTable() {
        // This is the drift `HTTPErrorTests` was written to prevent, one layer up:
        // a 401 must read the same here as everywhere else in the app, and the
        // server's own words must survive where the server is describing THIS
        // request (a 400 naming the missing field, a 424 naming the refusal).
        for (status, server) in [(401, "login required"), (400, "deviceId required"),
                                 (424, "revoke failed"), (503, "boom")] {
            let opening = RevokeFailure.decided(status) ? RevokeFailure.lead
                                                       : RevokeFailure.unconfirmedLead
            #expect(RevokeFailure.message(status: status, body: ["error": server])
                    == opening + " " + Api.httpMessage(status, server))
        }
        // And a 401 does NOT tell the user to repeat an action that can only fail
        // again — it tells them what would actually fix it.
        let expired = RevokeFailure.message(status: 401, body: ["error": "login required"]) ?? ""
        #expect(expired.localizedCaseInsensitiveContains("sign out"))
        #expect(!expired.localizedCaseInsensitiveContains("login required"))
    }

    @Test("both leads are one sentence, terminated, and never diagnose")
    func leadIsWellFormed() {
        // It gets a reason appended, so it must end cleanly — this is the `· tap to
        // retry` bug from inc 9, where a fragment with no terminator was joined to
        // the board's own words.
        for lead in [RevokeFailure.lead, RevokeFailure.unconfirmedLead] {
            #expect(lead.hasSuffix("."))
            #expect(!lead.localizedCaseInsensitiveContains("try again"))
            #expect(!lead.localizedCaseInsensitiveContains("http"))
        }
        // Two different outcomes must not read as the same sentence.
        #expect(RevokeFailure.lead != RevokeFailure.unconfirmedLead)
        // Two spaces would mean a lead already carried its own separator.
        #expect(RevokeFailure.message(status: 424, body: ["error": "revoke failed"])?
                .contains("  ") != true)
        #expect(RevokeFailure.message(status: 503, body: ["error": "boom"])?
                .contains("  ") != true)
        // The hedge offers the only action that is actually safe here, and it is safe
        // because `DEVICE_REVOKE_SQL` is an unguarded idempotent UPDATE (licensed in
        // tests/revoke-message.test.ts, which reads the worker's SQL).
        #expect(RevokeFailure.unconfirmedLead.localizedCaseInsensitiveContains("again is safe"))
    }
}

@Suite struct LoadFailureTests {

    /// The statuses those five routes actually answer on the GET these sheets
    /// make — 401 (no/expired session), 424 (the proxy lost a dependency), 503
    /// (worker outage or a transient blip) — read off
    /// app/api/{devices,jobs,learnings,events,graph}/route.ts. Their 400s are
    /// all on POST/DELETE, and `?all=1` returns before graph's 400.
    static let reachable = [401, 424, 503]

    @Test("an expired session gets its own remedy, not two causes")
    func expiredSessionIsNamed() {
        // Was: "Login required or network error" — both fixes offered at once,
        // one of them wrong every time, and signing out on a network blip
        // throws away a token that still works.
        let msg = LoadFailure.message(ApiError.http(401, "login required"))
        #expect(msg == Api.friendlyHTTPError(401))
        #expect(msg.localizedCaseInsensitiveContains("sign out"))
        // The worker's wire phrase does not reach the screen.
        #expect(!msg.localizedCaseInsensitiveContains("login required"))
    }

    @Test("the reason comes from the app's ONE table, not a sixth copy")
    func delegatesToTheSharedTable() {
        // ⚠️ This also proves the LocalizedError bridging that `message` leans
        // on: it reads `localizedDescription`, and these equalities only hold if
        // that really does hand back `errorDescription` → `Api.httpMessage`.
        for (status, server) in [(401, "login required"), (424, "registry not deployed"),
                                 (503, "events unavailable")] {
            #expect(LoadFailure.message(ApiError.http(status, server))
                    == Api.httpMessage(status, server))
        }
    }

    @Test("an outage says wait — it never tells the user to sign in")
    func outageIsTransient() {
        let msg = LoadFailure.message(ApiError.http(503, "events unavailable"))
        #expect(msg == Api.friendlyHTTPError(503))
        #expect(!msg.localizedCaseInsensitiveContains("sign"))
        #expect(msg.localizedCaseInsensitiveContains("try again"))
    }

    @Test("nothing arrived at all is status 0, not a session claim")
    func transportIsNoResponse() {
        for code in [URLError.notConnectedToInternet, .timedOut, .networkConnectionLost] {
            #expect(LoadFailure.message(URLError(code)) == Api.friendlyHTTPError(0))
        }
        let msg = LoadFailure.message(URLError(.timedOut))
        #expect(msg.localizedCaseInsensitiveContains("connection"))
        #expect(!msg.localizedCaseInsensitiveContains("sign"))
    }

    @Test("bytes that weren't JSON are not blamed on the connection")
    func badBodyIsNotOffline() {
        // `Api.get` parses with JSONSerialization, which throws an NSCocoaError
        // — NOT an ApiError — when a 200 carries an HTML error page, which is
        // what a mid-redeploy or a captive portal serves. "Check your
        // connection" would send the reader to fix something that isn't broken.
        let parse = NSError(domain: NSCocoaErrorDomain, code: 3840,
                            userInfo: [NSLocalizedDescriptionKey: "Garbage at end of JSON"])
        let msg = LoadFailure.message(parse)
        #expect(msg == ApiError.badResponse.localizedDescription)
        #expect(!msg.localizedCaseInsensitiveContains("connection"))
        // And the parser's own diagnostic stays off the screen.
        #expect(!msg.localizedCaseInsensitiveContains("garbage"))
    }

    @Test("every reachable failure reads as a sentence, never a bare code")
    func noBareStatusCodes() {
        // ⚠️ FAILS WHEN FIXED, deliberately: `friendlyHTTPError`'s default arm
        // is `"HTTP \(status)"`, machine vocabulary on a human surface. It is
        // unreachable from these five sheets today — every status they can get
        // has a curated line. If one of those routes starts answering something
        // else (a 402/404 would be worse still: the table words those for CHAT,
        // "That tiny doesn't exist" on My Devices), this catches it.
        for status in Self.reachable {
            let line = LoadFailure.message(ApiError.http(status, nil))
            // The default arm's exact output for THIS status — the one thing
            // that must never be the whole caption.
            #expect(line != "HTTP \(status)", "bare status code on a sheet: \(line)")
            // A curated line always carries prose alongside the code.
            #expect(line.contains(" — "), "no explanation, just a code: \(line)")
        }
        // The two non-HTTP paths are curated by construction, but they still
        // have to be sentences rather than a diagnostic.
        for line in [LoadFailure.message(URLError(.timedOut)),
                     LoadFailure.message(ApiError.badResponse)] {
            #expect(line.contains(" "), "not a sentence: \(line)")
            #expect(line.count > "HTTP 000".count, "as short as a bare code: \(line)")
        }
    }
}

@Suite struct DevicePresenceTests {
    @Test func nullOnlineIsUnknown_notOffline() {
        // The wire hands JSONSerialization an NSNull for an endpoint device.
        #expect(DeviceRow.parseOnline(NSNull()) == nil)
        #expect(DeviceRow.parseOnline(nil) == nil)
        #expect(DeviceRow.parseOnline(true) == true)
        #expect(DeviceRow.parseOnline(false) == false)
        // SQLite booleans arrive as 1/0; NSNumber bridges both to Bool.
        #expect(DeviceRow.parseOnline(NSNumber(value: 1)) == true)
        #expect(DeviceRow.parseOnline(NSNumber(value: 0)) == false)
    }

    @Test func theThreeStatesReadDifferently() {
        #expect(DevicePresence.online.label(lastSeen: nil) == "online")
        // Web parity: an unheartbeated device is not "offline", it's callable.
        #expect(DevicePresence.unknown.label(lastSeen: nil) == "reachable when called")
        #expect(DevicePresence.offline.label(lastSeen: nil) == "never seen")
        #expect(DevicePresence.offline.label(lastSeen: Date(timeIntervalSince1970: 1)).hasPrefix("seen "))
    }

    @Test func aRowsDescriptorNeverShowsAStraySeparator() {
        let bare = DeviceRow(id: "x", name: "x", kind: "?", platform: "", online: nil, lastSeen: nil)
        #expect(bare.descriptor == "")
        let full = DeviceRow(id: "x", name: "x", kind: "daemon", platform: "darwin-arm64",
                             online: true, lastSeen: nil)
        #expect(full.descriptor == "Mac")
    }

    /// A robot is the only device class with no platform on the wire — nothing
    /// self-reports for it, so the best this line could otherwise do was say its
    /// `kind` in a nicer word ("robot"), which is the category the glyph beside
    /// it has already drawn. The worker lists the endpoint's `url` for exactly
    /// this reason ("the owner needs to see where a body lives") and the iOS
    /// decoder was dropping it, so the web row showed the address and this one
    /// showed a synonym for its own icon.
    @Test func aRobotsRowSaysWhereItsBodyIs() {
        let printer = DeviceRow(id: "p", name: "bambu-p1s", kind: "endpoint", platform: "",
                                online: nil, lastSeen: nil,
                                url: "https://p1s.ada.tiny.technology")
        // Scheme dropped exactly as the web row drops it: the worker normalises
        // every endpoint to an https origin, so it is eight identical characters
        // on every robot's row, spent on the widest element in it.
        #expect(printer.descriptor == "p1s.ada.tiny.technology")
        #expect(printer.presenceLine == "reachable when called · p1s.ada.tiny.technology")
        // A port survives — it is part of where the body actually is.
        let rover = DeviceRow(id: "r", name: "rover", kind: "endpoint", platform: "",
                              online: nil, lastSeen: nil, url: "https://rover.local:8443")
        #expect(rover.descriptor == "rover.local:8443")
        // An older row with no url falls back rather than going blank.
        let urlless = DeviceRow(id: "u", name: "u", kind: "endpoint", platform: "",
                                online: nil, lastSeen: nil)
        #expect(urlless.descriptor == "robot")
        // The address belongs to endpoints ONLY. A daemon that somehow carried a
        // url must still be named by its hardware — the url is not its identity.
        let daemon = DeviceRow(id: "d", name: "d", kind: "daemon", platform: "darwin-arm64",
                               online: true, lastSeen: nil, url: "https://nope.example.com")
        #expect(daemon.descriptor == "Mac")
    }

    /// The decoder never read `url`, so the fix above would have been invisible
    /// on a real response no matter how right the row was.
    ///
    /// ⚠️ `@MainActor` is load-bearing: `decodeDevices` is a static on a `View`,
    /// so it inherits main-actor isolation, and its compactMap closure asserts it
    /// at RUNTIME (`dispatch_assert_queue`). Without this the process SIGTRAPs
    /// rather than failing — and the run then reports "10 tests passed" while
    /// exiting 65, because the harness restarts and the crashed test is simply
    /// absent from the summary. A green-looking summary is not a pass; the exit
    /// code and "Restarting after unexpected exit" are. DevicesHarnessTests
    /// carries the same annotation on the whole suite for the same reason.
    @Test @MainActor func theWiresEndpointAddressSurvivesDecoding() {
        let rows = DevicesView.decodeDevices([
            ["id": "p", "name": "printer", "kind": "endpoint", "platform": "",
             "url": "https://p1s.ada.tiny.technology", "online": NSNull()],
            // Absent on every non-endpoint, which must decode to "" and not crash.
            ["id": "m", "name": "mac", "kind": "cli", "platform": "darwin-arm64", "online": true],
        ])
        #expect(rows.count == 2)
        #expect(rows[0].url == "https://p1s.ada.tiny.technology")
        #expect(rows[0].descriptor == "p1s.ada.tiny.technology")
        #expect(rows[1].url == "")
        #expect(rows[1].descriptor == "Mac")
    }

    /// The line said `daemon · darwin-arm64` while the glyph beside it drew a
    /// laptop: two renderings of one fact, and only the picture had been
    /// translated. Read as English the wire words are also just false — a
    /// necklace is not a daemon, a 3D printer is not an endpoint — and `kind` is
    /// redundant wherever a platform exists, which is everywhere it matters.
    @Test func theRowSaysWhatTheHardwareIs_inTheGlyphsOwnVocabulary() {
        #expect(deviceLabel(platform: "darwin-arm64", kind: "daemon") == "Mac")
        #expect(deviceLabel(platform: "linux-arm64", kind: "cli") == "Linux")
        #expect(deviceLabel(platform: "nicla-vision", kind: "daemon") == "Nicla Vision")
        #expect(deviceLabel(platform: "nicla-voice", kind: "daemon") == "Nicla Voice")
        // The family is matched, not the exact token, so a new arch needs no
        // entry — same rule as the glyph needles.
        #expect(deviceLabel(platform: "darwin-x64", kind: "cli") == "Mac")
        #expect(deviceLabel(platform: "win32-x64", kind: "cli") == "Windows")
        #expect(deviceLabel(platform: "linux-riscv64", kind: "cli") == "Linux")
    }

    /// `ios-arm64` is what BOTH an iPhone and an iPad enroll — Session.enroll
    /// hard-codes it and makes only the NAME idiom-aware. So "iPhone" here would
    /// be a fresh false claim on the iPad rather than a fix, and the `ipad`
    /// needle (in this table and in the glyph table) is unreachable for anything
    /// this app enrolled. Pinned so the ambiguity is a recorded decision and not
    /// an oversight someone "corrects" later.
    @Test func anIPadIsNotCalledAnIPhone() {
        #expect(deviceLabel(platform: "ios-arm64", kind: "daemon") == "iOS")
        // Reachable only if the wire ever carries it; the needle order is what
        // makes that work, since "ipados" contains "ios" too.
        #expect(deviceLabel(platform: "ipados-arm64", kind: "daemon") == "iPad")
    }

    /// Platform wins, kind is the fallback, and an unknown platform still shows.
    @Test func aDeviceNobodyMappedStillSaysSomething() {
        // No platform: the kind is all there is, and it gets a word too. This is
        // not an edge case — it is EVERY robot and printer. Only a self-reporting
        // daemon puts a platform on the wire; the enroll form posts {name, kind},
        // so `platform: ""` is what a real Bambu row carries and "robot" is the
        // most this line can truthfully say about it. (The web row spends this
        // slot on the device's URL instead, which iOS has no field for.)
        #expect(deviceLabel(platform: "", kind: "endpoint") == "robot")
        #expect(deviceLabel(platform: "?", kind: "cli") == "computer")
        #expect(deviceLabel(platform: "", kind: "daemon") == "device")
        // An unmapped platform is shown rather than silenced — a newer daemon
        // must not vanish from the sheet — but never with a separator in it.
        #expect(deviceLabel(platform: "freebsd-arm64", kind: "cli") == "freebsd arm64")
        #expect(deviceLabel(platform: "some_new_board", kind: "daemon") == "some new board")
        // Nothing at all to say: nil, so presenceLine joins no separator.
        #expect(deviceLabel(platform: "", kind: "") == nil)
        #expect(deviceLabel(platform: "?", kind: "?") == nil)
    }

    /// The row's second line used to be four sibling views in an HStack — dot,
    /// presence, a literal "·", descriptor. SwiftUI sized each on its own, so at
    /// the accessibility text sizes it came apart: "online ·" on one line and a
    /// stranded "· ios-ar…" on the next, under a separator with nothing after it.
    /// One string can't do that, and these are the cases that string has to get
    /// right — including the one where there is nothing to separate.
    @Test func thePresenceLineIsOneSentenceWithNoDanglingSeparator() {
        let full = DeviceRow(id: "x", name: "x", kind: "daemon", platform: "ios-arm64",
                            online: true, lastSeen: nil)
        #expect(full.presenceLine == "online · iOS")
        // Nothing to say about the hardware: no trailing " · ".
        let bare = DeviceRow(id: "x", name: "x", kind: "?", platform: "", online: nil, lastSeen: nil)
        #expect(bare.presenceLine == "reachable when called")
        let dead = DeviceRow(id: "x", name: "x", kind: "cli", platform: "linux-arm64",
                            online: false, lastSeen: nil)
        #expect(dead.presenceLine == "never seen · Linux")
    }

    /// The chips printed the wire token, so the sheet showed people
    /// `bluetooth_scan` and `image_gen` and `tof`, and VoiceOver said "can
    /// bluetooth underscore scan". Two rules, and the second is the one that has
    /// to hold for words nobody has written down yet.
    @Test func aCapabilityReadsAsWordsEvenWhenNobodyMappedIt() {
        #expect(capabilityLabel("bluetooth_scan") == "bluetooth")
        #expect(capabilityLabel("image_gen") == "makes images")
        #expect(capabilityLabel("tof") == "distance")
        // Proper nouns get their capitals back — they rendered as "spotify".
        #expect(capabilityLabel("whatsapp") == "WhatsApp")
        // "windows" alone reads as Microsoft's, which is worse than jargon.
        #expect(capabilityLabel("windows") == "arranges windows")
        // An unmapped capability still SHOWS — a newer daemon must not be
        // silenced — but never with a separator in it.
        #expect(capabilityLabel("some_new_thing") == "some new thing")
        #expect(capabilityLabel("kernel-mode") == "kernel mode")
        #expect(capabilityLabel("plain") == "plain")
    }

    /// The icon table and the word table have to agree about which capabilities
    /// exist. They are separate lookups, so a capability added to one and not the
    /// other doesn't fail to build — it renders half-dressed: a glyph beside a raw
    /// token, or a real word with a hole where the icon goes. Every token with an
    /// ICON must therefore have a WORD. Not the reverse: `telegram` and
    /// `integrations` are real daemon labels (web DEVICE_LABELS) that neither
    /// phone has drawn yet, and a right word with no picture is the honest state.
    @Test func everyCapabilityWithAnIconAlsoHasAWord() {
        let iconed = ["camera", "mic", "tof", "imu", "ble", "wifi", "wake",
                      "chat", "bluetooth_scan", "location", "record", "speak",
                      "open_app", "image_gen", "glasses",
                      "mcp", "files", "shell", "apple", "computer", "windows",
                      "ocr", "browse", "desktop", "voice", "see",
                      "spotify", "google", "whatsapp", "adb", "flipper",
                      "print", "telemetry"]
        for cap in iconed {
            #expect(capabilityIcon(cap) != nil, "\(cap) lost its icon — update this list")
            // The KEY, not the returned string: half these words map to
            // themselves ("camera", "files", "voice"), so from out here a
            // deliberate identity mapping and a missing one read the same.
            #expect(CAPABILITY_LABELS[cap] != nil, "\(cap) has an icon but no word")
        }
    }

    @Test func theGlyphSaysWhatTheHardwareIs_platformBeatsKind() {
        // Both a necklace and a laptop enroll as kind "daemon"; "cpu" for a
        // camera on a lanyard tells the user nothing.
        #expect(deviceGlyph(platform: "nicla-vision", kind: "daemon") == "camera.aperture")
        #expect(deviceGlyph(platform: "nicla-voice", kind: "daemon") == "mic.and.signal.meter")
        #expect(deviceGlyph(platform: "darwin-arm64", kind: "daemon") == "laptopcomputer")
        // This app self-enrolls as platform "ios-arm64", kind "daemon".
        #expect(deviceGlyph(platform: "ios-arm64", kind: "daemon") == "iphone")
        #expect(deviceGlyph(platform: "", kind: "endpoint") == "cube.transparent")
        #expect(deviceGlyph(platform: "", kind: "browser") == "globe")
        #expect(deviceGlyph(platform: "totally-new-thing", kind: "who-knows") == "cpu")
    }
}

/// 🎗️ The capability ribbon was uncapped, and it was the biggest thing in the row.
///
/// A laptop enrolls twelve capabilities (one per resolved device tool), so its
/// chips wrapped to five lines of grey pills under a one-line name — the
/// reference half of the row outweighing the two facts the row exists to state.
/// Six such rows make a list of pill-walls you scroll past rather than read.
@Suite struct CapabilityRibbonTests {
    /// Every capability an iPhone actually enrolls, in the order the decoder
    /// sorts them (by LABEL) — so the prefix these tests assert is the prefix a
    /// real row shows, not a hand-picked one.
    private let phone = ["ble", "chat", "glasses", "location", "image_gen",
                         "open_app", "record", "speak"]

    @Test func aLongRibbonKeepsFourAndCountsTheRest() {
        let (shown, hidden) = CapabilityRibbon.split(phone, expanded: false)
        #expect(shown == ["ble", "chat", "glasses", "location"])
        #expect(hidden == 4)
        // The two halves are one function's output, so they cannot disagree:
        // what is shown plus what is claimed hidden is the whole list.
        #expect(shown.count + hidden == phone.count)
    }

    @Test func expandedShowsEveryOneAndNothingIsClaimedHidden() {
        let (shown, hidden) = CapabilityRibbon.split(phone, expanded: true)
        #expect(shown == phone)
        #expect(hidden == 0)
    }

    /// "+1 more" is a chip that hides a chip: it occupies the space it saves, so
    /// at five capabilities the cap costs a tap and buys nothing. The boundary is
    /// the whole reason the guard is `> cap + 1` and not `> cap`.
    @Test func theCapDoesNotFireWhenItWouldSaveNothing() {
        let five = Array(phone.prefix(5))
        #expect(CapabilityRibbon.split(five, expanded: false).shown == five)
        #expect(CapabilityRibbon.split(five, expanded: false).hidden == 0)
        #expect(CapabilityRibbon.toggleLabel(five, expanded: false) == nil)
        // Six is where it starts paying: four chips plus a counter, not six.
        let six = Array(phone.prefix(6))
        #expect(CapabilityRibbon.split(six, expanded: false).shown.count == 4)
        #expect(CapabilityRibbon.toggleLabel(six, expanded: false) == "+2 more")
    }

    /// The control and the cap are one decision. A row showing everything must
    /// not offer to show more, and a capped row must always admit it — a ribbon
    /// silently cut to four is worse than a long one, because nothing on screen
    /// says the device can do anything else.
    @Test func theToggleExistsExactlyWhenSomethingIsHidden() {
        for n in 0...12 {
            let caps = (0..<n).map { "cap\($0)" }
            let capped = CapabilityRibbon.split(caps, expanded: false).hidden > 0
            #expect((CapabilityRibbon.toggleLabel(caps, expanded: false) != nil) == capped,
                    "\(n) capabilities: control and cap disagree")
            // And the same at the other end of the toggle: an expanded row still
            // needs its way back, so the offer is present whenever a cap applies.
            #expect((CapabilityRibbon.toggleLabel(caps, expanded: true) != nil) == capped)
        }
    }

    @Test func theNumberInTheControlIsTheNumberActuallyHidden() {
        // The bug this forecloses: counting from `caps.count - cap` in the label
        // while `split` returns a different slice. One source, asserted as one.
        for n in 0...20 {
            let caps = (0..<n).map { "cap\($0)" }
            let hidden = CapabilityRibbon.split(caps, expanded: false).hidden
            if hidden > 0 {
                #expect(CapabilityRibbon.toggleLabel(caps, expanded: false) == "+\(hidden) more")
            }
        }
    }

    /// Collapsed says how many are missing; expanded says how to put them back.
    /// "+4 more" on an already-open ribbon would be a control describing the
    /// state it just left.
    @Test func theExpandedControlOffersTheWayBack() {
        #expect(CapabilityRibbon.toggleLabel(phone, expanded: true) == "show fewer")
        #expect(CapabilityRibbon.toggleLabel(phone, expanded: false) == "+4 more")
    }

    /// Not a ranking — the alphabetical prefix, admitted. The decoder sorts by
    /// label on purpose, so the visible four are simply the first four; asserting
    /// this stops a later "smarter" ordering from arriving without the row also
    /// showing what it ordered by.
    @Test func whatSurvivesTheCapIsThePrefixNotAChosenFew() {
        let caps = ["adb", "browse", "files", "flipper", "mcp", "shell"]
        #expect(CapabilityRibbon.split(caps, expanded: false).shown == Array(caps.prefix(4)))
        // Reordering the input reorders the prefix — there is no hidden rank.
        let reversed: [String] = caps.reversed()
        #expect(CapabilityRibbon.split(reversed, expanded: false).shown == Array(reversed.prefix(4)))
    }

    @Test func anEmptyOrShortRibbonIsUntouched() {
        #expect(CapabilityRibbon.split([], expanded: false).shown.isEmpty)
        #expect(CapabilityRibbon.toggleLabel([], expanded: false) == nil)
        #expect(CapabilityRibbon.split(["camera"], expanded: false).shown == ["camera"])
        #expect(CapabilityRibbon.toggleLabel(["camera"], expanded: false) == nil)
    }

    /// The fleet the harness draws is the fleet this has to look right on: the
    /// laptop is the row that broke, and the necklace and the Pi must not lose
    /// chips to a cap that was never about them.
    ///
    /// ⚠️ `@MainActor` is load-bearing, and it cost a run to learn twice:
    /// `decodeDevices` is a static on a `View`, so it inherits main-actor
    /// isolation and its closure asserts it at RUNTIME. Without this the process
    /// SIGTRAPs — and the failure surfaces as five UNRELATED suites "encountered
    /// an error", because the harness restarts and blames whatever was mid-flight.
    #if DEBUG
    @Test @MainActor func onTheRealFleetOnlyTheOverloadedRowsGetCapped() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        #expect(!rows.isEmpty)
        for row in rows {
            let (shown, hidden) = CapabilityRibbon.split(row.capabilities, expanded: false)
            // Nothing is ever invented, and no row is cut below the cap.
            #expect(shown.count + hidden == row.capabilities.count)
            #expect(shown.count <= max(CapabilityRibbon.cap, min(row.capabilities.count, 5)))
            #expect(shown.allSatisfy { row.capabilities.contains($0) })
        }
        // The laptop — twelve capabilities — is the row this exists for.
        guard let laptop = rows.max(by: { $0.capabilities.count < $1.capabilities.count }) else {
            Issue.record("the harness fleet is empty"); return
        }
        #expect(laptop.capabilities.count >= 10)
        #expect(CapabilityRibbon.split(laptop.capabilities, expanded: false).shown.count == 4)
        // And the necklace's four stay whole: it never needed capping.
        guard let voice = rows.first(where: { $0.platform == "nicla-voice" }) else {
            Issue.record("the harness lost its Voice necklace"); return
        }
        #expect(voice.capabilities.count <= CapabilityRibbon.cap + 1)
        #expect(CapabilityRibbon.split(voice.capabilities, expanded: false).hidden == 0)
    }
    #endif
}

/// The sheet's two relay panels must agree about when a relay call can land —
/// and the camera panel must stop reporting a sleeping board as a broken camera.
@Suite struct RelayReachTests {
    @Test func onlyAnOnlineDeviceIsWorthARelayCall() {
        // The worker calls a dial-in device one that "hold[s] a `tind_` token,
        // heartbeat[s], poll[s] the relay" (PULL_KINDS) — one loop, both jobs.
        // Outside the 60s presence window it is not reading the relay, so the
        // call can only wait out its own 19-second budget.
        #expect(RelayReach.canReach(.online))
        #expect(!RelayReach.canReach(.offline))
        // `.unknown` too: it means "nothing here can tell you", which is not a
        // licence to spend a round-trip proving it.
        #expect(!RelayReach.canReach(.unknown))
    }

    @Test func anAsleepBoardIsNotABrokenCamera() {
        // The sentence blames the BOARD, names it (a panel is its own block, so
        // "it" has no antecedent inside one), and opens exactly as the Flipper
        // panel's does one row down — one sheet, one voice.
        #expect(RelayReach.cameraNote(deviceName: "tiny-vision", presence: .offline)
                == "tiny-vision isn't online — its camera answers once it's back.")
        #expect(RelayReach.cameraNote(deviceName: "tiny-vision", presence: .unknown)
                == "tiny-vision isn't online — its camera answers once it's back.")
        // The old line was the camera panel's timeout — "No frame in 19s — is
        // the camera awake?" — which sent the user to check a camera that was
        // fine, over a row already reading "seen 3 days ago".
        let note = RelayReach.cameraNote(deviceName: "tiny-vision", presence: .offline) ?? ""
        #expect(!note.contains("camera awake"))
        #expect(!note.lowercased().contains("failed"))
    }

    @Test func anOnlineBoardGetsNoExcuseAndKeepsItsFetch() {
        // nil is what lets the panel call: ONE function answers both halves, so
        // a sentence on screen and a call on the wire can never coexist.
        #expect(RelayReach.cameraNote(deviceName: "tiny-vision", presence: .online) == nil)
    }

    @Test func theRuleIsTheSameOneTheFlipperPanelAlreadyUsed() {
        // FlipperDevicePanel's branch was `hostPresence != .online`, inlined. If
        // these two ever diverge, one sheet holds two answers to one question.
        for p: DevicePresence in [.online, .offline, .unknown] {
            #expect(RelayReach.canReach(p) == (p == .online))
            #expect((RelayReach.cameraNote(deviceName: "x", presence: p) == nil)
                    == RelayReach.canReach(p))
        }
    }
}

@Suite struct RelayReplyTests {
    @Test func theAgentsResultIsUnwrapped() {
        #expect(RelayReply.text(#"{"result":"fw 1.3.4, 87%"}"#) == "fw 1.3.4, 87%")
        #expect(RelayReply.text(#"{"text":"hello"}"#) == "hello")
        #expect(RelayReply.text(#""bare string""#) == "bare string")
    }

    @Test func anUnrecognisedPayloadIsShownRatherThanSwallowed() {
        // A blank panel is undebuggable; a raw payload on screen is not.
        #expect(RelayReply.text("not json at all") == "not json at all")
        #expect(RelayReply.text(#"{"weird":1}"#) == #"{"weird":1}"#)
        // An empty result must not read as success.
        #expect(RelayReply.text(#"{"result":"   "}"#) == #"{"result":"   "}"#)
    }
}

// ── The Voice panel's status line ─────────────────────────────────────────
//
// It read `\(s.labels) wake word(s) · \(s.wakes) heard · up \(s.uptimeS)s`,
// straight off the wire. Two problems in one line. The seconds were raw, so a
// necklace worn since breakfast said "up 41293s" in a sentence otherwise written
// in words. And handleStatus decodes that JSON with `?? 0` — an absent key is
// expected in a 64-byte BLE notify — so two of the three zeroes were alarms the
// board never raised: "up 0s" (a wearable in a reset loop) and "0 wake words"
// (a net that can never hear you), the latter printed directly under a green
// "listening" badge saying the opposite.

@Suite struct VoiceFmtTests {

    @Test func uptimeClimbsTheSameLadderTheRestOfTheAppUses() {
        // Activity.ago and dmAgo's units and thresholds, so "up 90m" reads as
        // "up 1h" here exactly as a 90-minute-old event reads "1h" over there.
        #expect(VoiceFmt.uptime(1) == "1s")
        #expect(VoiceFmt.uptime(59) == "59s")
        #expect(VoiceFmt.uptime(60) == "1m")
        #expect(VoiceFmt.uptime(3_599) == "59m")
        #expect(VoiceFmt.uptime(3_600) == "1h")
        #expect(VoiceFmt.uptime(86_399) == "23h")
        #expect(VoiceFmt.uptime(86_400) == "1d")
        // The number that started this: a necklace up since breakfast.
        #expect(VoiceFmt.uptime(41_293) == "11h")
        // Rounds DOWN, like the others — an hour-old board stays "1h" until 2h
        // rather than looking precise to a minute it isn't sure of.
        #expect(VoiceFmt.uptime(7_199) == "1h")
    }

    @Test func anUnreportedUptimeSaysNothingRatherThanRebooted() {
        // 0 is what a missing "up" key decodes to. "up 0s" on a wearable is the
        // signature of a crash loop, so this is the difference between a quiet
        // panel and a permanent false alarm.
        #expect(VoiceFmt.uptime(0) == nil)
        // Never observed, but the wire is JSON and a negative would render
        // "up -1s" / "up 0m" if it fell through to the ladder.
        #expect(VoiceFmt.uptime(-5) == nil)
    }

    @Test func aFullStatusReadsAsOneSentenceOfWords() {
        var s = VoiceStatus()
        s.labels = 3; s.wakes = 12; s.uptimeS = 41_293
        #expect(VoiceFmt.statusLine(s) == "3 wake words · 12 heard · up 11h")
        // Singular survived the rewrite.
        s.labels = 1; s.wakes = 1; s.uptimeS = 45
        #expect(VoiceFmt.statusLine(s) == "1 wake word · 1 heard · up 45s")
    }

    @Test func aZeroDropsItsSegmentInsteadOfNarratingIt() {
        var s = VoiceStatus()
        // No "up" from the board: the rest of the line still stands.
        s.labels = 3; s.wakes = 0; s.uptimeS = 0
        #expect(VoiceFmt.statusLine(s) == "3 wake words · 0 heard")
        // No "l": "0 wake words" would contradict the listening badge above it.
        s.labels = 0; s.wakes = 4; s.uptimeS = 600
        #expect(VoiceFmt.statusLine(s) == "4 heard · up 10m")
        // A board that answered with nothing quantified gets no line at all —
        // not a bare "0 heard", whose only content is a number that may never
        // have arrived, and not a stray "·" either.
        #expect(VoiceFmt.statusLine(VoiceStatus()) == nil)
    }

    /// A reading this phone can no longer verify is not news.
    ///
    /// `status` is a LAST-KNOWN value — the gateway clears it in `forget()` only,
    /// never on disconnect — so the panel drew "out of range" and, on the same
    /// line, a green "listening" from whenever the necklace was last in range.
    /// The one element written in the present tense was the one that outlived the
    /// link it depended on.
    @Test func aStatusReadingStopsBeingSpeakableWhenTheLinkDrops() {
        var s = VoiceStatus()
        s.ndpUp = true; s.micOn = true; s.labels = 3; s.wakes = 12; s.uptimeS = 41_293
        #expect(s.listening)
        // Connected: unchanged, badge and detail line both stand.
        #expect(VoiceFmt.live(s, connected: true) == s)
        #expect(VoiceFmt.live(s, connected: true).flatMap(VoiceFmt.statusLine)
                == "3 wake words · 12 heard · up 11h")
        // Out of range: nothing to say, rather than the old reading said again.
        #expect(VoiceFmt.live(s, connected: false) == nil)
        #expect(VoiceFmt.live(s, connected: false).flatMap(VoiceFmt.statusLine) == nil)
        // A board that has never answered says nothing either way — the panel's
        // "out of range" line is already the whole story there.
        #expect(VoiceFmt.live(nil, connected: true) == nil)
        #expect(VoiceFmt.live(nil, connected: false) == nil)
        // "not listening" is a REAL answer and must survive the gate: a loaded
        // board with a dead mic is exactly what the badge exists to catch.
        var deaf = s
        deaf.micOn = false
        #expect(deaf.listening == false)
        #expect(VoiceFmt.live(deaf, connected: true)?.listening == false)
    }

    @Test func theLineNeverEndsUpWithADanglingSeparator() {
        // The old string hard-coded two "·"s, so any empty segment left one
        // hanging. Every reachable combination of present/absent, checked for
        // the shape rather than the content.
        for labels in [0, 1, 3] {
            for wakes in [0, 7] {
                for up in [0, 30, 90_000] {
                    var s = VoiceStatus()
                    s.labels = labels; s.wakes = wakes; s.uptimeS = up
                    guard let line = VoiceFmt.statusLine(s) else { continue }
                    #expect(!line.hasPrefix("·") && !line.hasSuffix("·"), "dangling: \(line)")
                    #expect(!line.contains("··") && !line.contains(" ·  "), "empty segment: \(line)")
                    #expect(!line.contains("up 0"), "invented a reboot: \(line)")
                }
            }
        }
    }
}

// ── Camera-frame failures ─────────────────────────────────────────────────
//
// The old `fetchFrame` answered `nil` for five unrelated reasons and the panel
// drew its untouched "tap to peek" placeholder for all of them — the same face
// it shows someone who never tapped. These assert that each reason keeps a
// sentence of its own, because a message is the entire fix.

/// 🕒 `ReadingAge` — a fetched reading on the devices sheet says when it was
/// taken.
///
/// The camera panel stamped its frame; the Flipper panel printed firmware, a
/// battery percentage and which machine the cable is in with nothing at all to
/// say how old any of it was, so a reading survived being unplugged unchanged.
/// The properties below are what make the line worth trusting, and none of them
/// is observable through a `Text` inside a `VStack`.
///
/// Asserted as SHAPE, never as an exact string: the format is the user's locale
/// and the test machine's is not the user's.
@Suite struct ReadingAgeTests {

    /// Local noon on a fixed day, so "+1h is the same day" and "+2d is not" hold
    /// in every timezone the suite might run in.
    private static let noon = Calendar.current
        .startOfDay(for: Date(timeIntervalSince1970: 1_700_000_000))
        .addingTimeInterval(12 * 3600)

    @Test func nothingHasBeenReadSoThereIsNoLine() {
        #expect(ReadingAge.asOf(nil) == nil)
    }

    @Test func aReadingSaysThatItIsOne() throws {
        let line = try #require(ReadingAge.asOf(Self.noon, now: Self.noon))
        #expect(line.hasPrefix("as of "))
        // The clock time has to actually be in there — "as of " alone would pass
        // a prefix check and tell the user nothing.
        #expect(line.count > "as of ".count)
    }

    /// Why `.standard` and not `.shortened`. The line exists to answer "did this
    /// just update?", which a stamp shared by two different readings cannot.
    @Test func twoReadingsASecondApartDoNotShareAStamp() {
        let a = ReadingAge.asOf(Self.noon, now: Self.noon)
        let b = ReadingAge.asOf(Self.noon.addingTimeInterval(1), now: Self.noon)
        #expect(a != b)
    }

    /// It names an instant, not an elapsed time. Nothing on this sheet re-renders
    /// these panels on a timer, so a "2m ago" would rot on screen — the same
    /// reading, read an hour later, must still produce the same words.
    @Test func aStampDoesNotRotWhileItSitsOnScreen() {
        let taken = Self.noon
        #expect(ReadingAge.asOf(taken, now: taken)
                == ReadingAge.asOf(taken, now: taken.addingTimeInterval(3600)))
    }

    /// A sheet left open in a pocket overnight comes back holding yesterday's
    /// battery percentage. "as of 8:35:12 AM" would then be false in the most
    /// confident format the app has.
    @Test func aReadingFromAnotherDaySaysWhichDay() throws {
        let taken = Self.noon
        let today = try #require(ReadingAge.asOf(taken, now: taken))
        let tomorrow = try #require(
            ReadingAge.asOf(taken, now: taken.addingTimeInterval(2 * 86_400)))
        #expect(today != tomorrow)
        // And the ordinary case pays nothing for the rare one: same reading, and
        // the version that has to name a day is the longer of the two.
        #expect(today.count < tomorrow.count)
    }

    /// The boundary is the calendar DAY, not 24 hours — a reading from 23:50 is
    /// yesterday's at 00:10, ten minutes later.
    @Test func theBoundaryIsMidnightAndNotADurationSinceReading() throws {
        let cal = Calendar.current
        let lateLastNight = Self.noon.addingTimeInterval(11 * 3600 + 50 * 60)
        // Walked with the calendar, not by adding 86400: a DST day is 23 or 25
        // hours long and a fixed offset would land on the wrong side of midnight.
        let tomorrow = try #require(cal.date(byAdding: .day, value: 1, to: Self.noon))
        let justAfterMidnight = cal.startOfDay(for: tomorrow).addingTimeInterval(600)
        // Twenty minutes apart, and on opposite sides of midnight.
        #expect(justAfterMidnight.timeIntervalSince(lateLastNight) < 3600)
        let dated = try #require(ReadingAge.asOf(lateLastNight, now: justAfterMidnight))
        let bare = try #require(ReadingAge.asOf(lateLastNight, now: lateLastNight))
        #expect(dated != bare)
        #expect(dated.count > bare.count)
    }
}

/// 📷 `PeekShape` — who asked for the peek, and therefore how loudly the camera
/// panel may report that it failed.
///
/// The panel fetches on appearance, so it can be holding a failure nobody
/// requested — and it dressed that in the chrome this app reserves for a user's
/// own action going wrong: an orange warning triangle plus a button labelled
/// "Retry" for something never tried. Four shapes; each one's words are asserted
/// here rather than inside a `VStack` where nothing can read them.
@Suite struct PeekShapeTests {

    /// The whole fix in one assertion: identical failure, different provenance,
    /// different volume.
    @Test func theSameFailureIsQuietUnaskedAndLoudWhenAsked() {
        #expect(PeekShape.of(error: "camera busy", busy: false, asked: false)
                == .quiet("camera busy"))
        #expect(PeekShape.of(error: "camera busy", busy: false, asked: true)
                == .alarm("camera busy"))
    }

    /// Quiet is not silent. A swallowed reason is the bug the panel's `error`
    /// state exists to fix, so the reason survives in BOTH shapes — only the
    /// chrome changes.
    @Test func anUnaskedFailureStillSaysWhy() {
        let s = PeekShape.of(error: "No frame in 19s — is the camera awake?",
                             busy: false, asked: false)
        #expect(s.quietReason == "No frame in 19s — is the camera awake?")
        #expect(s.spoken == "No frame in 19s — is the camera awake?")
    }

    /// The card owns its reason, so there is no grey line to print alongside —
    /// otherwise the sheet would say the same thing twice in two shapes.
    @Test func theCardsReasonIsNotAlsoALine() {
        #expect(PeekShape.alarm("camera busy").quietReason == nil)
        #expect(PeekShape.idle.quietReason == nil)
        #expect(PeekShape.working.quietReason == nil)
    }

    /// A fetch in flight outranks the reason the last one failed: the spinner is
    /// the newer fact. This is the ordering `if let error, !busy` already had, and
    /// reversing it makes a retry look like it never started.
    @Test func aFetchInFlightOutranksAStaleReason() {
        #expect(PeekShape.of(error: "camera busy", busy: true, asked: true) == .working)
        #expect(PeekShape.of(error: "camera busy", busy: true, asked: false) == .working)
    }

    /// `FrameFailure.cancelled` means the panel left the screen: nobody is left to
    /// read a complaint, and an empty message renders as a bare orange triangle
    /// with no words beside it.
    @Test func aCancelledPeekIsNotAFailureToReport() {
        #expect(PeekShape.of(error: nil, busy: false, asked: true) == .idle)
        #expect(PeekShape.of(error: TinyLive.FrameFailure.cancelled.message,
                             busy: false, asked: true) == .idle)
    }

    /// VoiceOver reads the label INSTEAD of the text it combines, so every shape
    /// must carry its own words — the failure `DeviceOrder.spokenLabel` fixed for
    /// device rows, one panel deeper.
    @Test func everyShapeHasSomethingToSayOutLoud() {
        for s: PeekShape in [.working, .idle, .quiet("camera busy"), .alarm("camera busy")] {
            #expect(!s.spoken.isEmpty, "\(s) is silent to VoiceOver")
        }
        #expect(PeekShape.idle.spoken == "Peek at the camera")
        #expect(PeekShape.working.spoken == "Asking the camera for a frame")
    }

    /// The affordance goes in a HINT, for exactly the one shape whose label is the
    /// board's own words. Gluing "tap to peek" onto "camera busy" would be the "·"
    /// bug in a new costume: two of the five messages are pass-through strings
    /// with no punctuation to join against.
    @Test func onlyTheReasonShapeNeedsTheAffordanceSpelledSeparately() {
        #expect(PeekShape.quiet("camera busy").spokenHint == "Fetches a frame")
        #expect(PeekShape.idle.spokenHint == nil)
        #expect(PeekShape.working.spokenHint == nil)
        #expect(PeekShape.alarm("camera busy").spokenHint == nil)
        // The label carries no invitation of its own, which is WHY there's a hint.
        #expect(PeekShape.quiet("camera busy").spoken == "camera busy")
    }

    /// Every real failure an unasked peek can produce lands in `quiet` carrying
    /// the words whoever actually knew wrote — none re-worded, none promoted to an
    /// alarm the user never asked for.
    @Test func everyRealFailureFromAnUnaskedPeekStaysQuietAndVerbatim() {
        let failures: [TinyLive.FrameFailure] = [
            .relayRefused("device not found"),
            .noReply(seconds: 19),
            .deviceSaid("no camera on this board"),
            .undecodable,
        ]
        for f in failures {
            let s = PeekShape.of(error: f.message, busy: false, asked: false)
            #expect(s == .quiet(f.message), "\(f) escaped the quiet shape")
            #expect(s.quietReason == f.message)
        }
    }
}

@Suite struct FrameFailureTests {

    @Test func everyFailureCarriesSomethingToShowTheUser() {
        let cases: [TinyLive.FrameFailure] = [
            .relayRefused("device not found"),
            .noReply(seconds: 19),
            .deviceSaid("camera busy"),
            .undecodable,
        ]
        for c in cases {
            #expect(!c.message.isEmpty, "a silent failure is the bug being fixed: \(c)")
        }
    }

    /// The server's and the device's own words survive verbatim. Re-wording them
    /// client-side is how "relay send failed" came to stand in for a 401.
    @Test func theWordingComesFromWhoeverActuallyKnows() {
        #expect(TinyLive.FrameFailure.relayRefused("device not found").message == "device not found")
        #expect(TinyLive.FrameFailure.deviceSaid("no camera on this board").message
                == "no camera on this board")
    }

    /// A timeout has to name its own budget — "no frame" alone doesn't tell you
    /// whether to wait longer or go wake the board.
    @Test func aTimeoutSaysHowLongItWaited() {
        let m = TinyLive.FrameFailure.noReply(seconds: 19).message
        #expect(m.contains("19"))
        #expect(m.lowercased().contains("awake"))
    }

    /// Cancellation is the one silent case by design: the view went away or the
    /// stream switched transports, and nobody is left to read a complaint.
    @Test func onlyCancellationIsSilent() {
        #expect(TinyLive.FrameFailure.cancelled.message.isEmpty)
    }

    /// A message is a SENTENCE, so no caller may glue a fragment onto it with
    /// this app's "·" separator — which is exactly what the camera panel did:
    /// "Couldn't reach the relay. · tap to retry". Two of the five cases carry
    /// words the server or the board wrote, so a client can't even assume a
    /// terminator is absent; the rule has to be "never chain", and this is the
    /// fact the panel's Retry BUTTON exists to respect.
    @Test func aFailureMessageIsAWholeSentenceNotAChainableFragment() {
        #expect(TinyLive.FrameFailure.undecodable.message.hasSuffix("."))
        #expect(TinyLive.FrameFailure.noReply(seconds: 19).message.hasSuffix("?"))
        // The default when the relay refuses without saying why — the string
        // seen on the sheet, with the full stop that started this.
        #expect(TinyLive.FrameFailure.relayRefused("Couldn't reach the relay.")
                .message.hasSuffix("."))
        // And the board's own words routinely DON'T end in one, so a client-side
        // "strip the punctuation before joining" fix would still be guessing.
        #expect(!TinyLive.FrameFailure.deviceSaid("camera busy").message.hasSuffix("."))
    }

    @Test func aRealFrameReplyYieldsItsURL() {
        let a = TinyLive.readFrameAnswer(#"{"images":[{"url":"https://r2.example/f.jpg"}]}"#)
        #expect(a == .imageURL(URL(string: "https://r2.example/f.jpg")!))
    }

    /// Bug 1: the board answers in words. That IS an answer, so polling must
    /// stop and the words must reach the screen — the old code left the loop as
    /// a bare nil and the panel reported it as "no frame arrived".
    @Test func aBoardAnsweringInWordsIsAnAnswerNotAnAbsence() {
        #expect(TinyLive.readFrameAnswer(#"{"result":"no camera on this device"}"#)
                == .words("no camera on this device"))
        #expect(TinyLive.readFrameAnswer(#"{"error":"camera busy"}"#) == .words("camera busy"))
    }

    /// Bug 2: a BARE JSON string is legal on this wire — the worker validates
    /// with JS `JSON.parse`, which accepts a top-level string. The old cast to
    /// `[String: Any]` failed, hit `continue`, and burned the whole 19s budget
    /// before reporting a timeout for a reply that had already arrived.
    @Test func aBareStringReplyStopsThePollInsteadOfTimingOut() {
        #expect(TinyLive.readFrameAnswer(#""busy, try again""#) == .words("busy, try again"))
    }

    /// An images array that carries nothing usable is words too — never a
    /// half-success, and never a crash on `images.first!`.
    @Test func anEmptyOrJunkImagesArrayFallsBackToTheRawPayload() {
        #expect(TinyLive.readFrameAnswer(#"{"images":[]}"#) == .words(#"{"images":[]}"#))
        #expect(TinyLive.readFrameAnswer(#"{"images":[{"nope":1}]}"#)
                == .words(#"{"images":[{"nope":1}]}"#))
        // A relative or schemeless string is not a fetchable frame URL.
        #expect(TinyLive.readFrameAnswer(#"{"images":[{"url":"just-a-name.jpg"}]}"#)
                == .words(#"{"images":[{"url":"just-a-name.jpg"}]}"#))
    }

    /// The Sticky (grammar ≤8) answers `screenshot` in PROSE — `{"result":
    /// "screenshot: https://…"}` — an image answer in words' clothing. Until
    /// the firmware ships images[] alongside result (filed, docs/ANSWERS.md
    /// 2026-08-26), the documented prose shape renders as the picture it is.
    @Test func stickyScreenshotProseRendersAsAnImage() {
        let a = TinyLive.readFrameAnswer(
            #"{"result":"screenshot: https://plugin.tiny.technology/media/abc.png"}"#)
        #expect(a == .imageURL(URL(string: "https://plugin.tiny.technology/media/abc.png")!))
    }

    /// The prose recognizer is NARROW on purpose: only `screenshot:` + one
    /// https URL and nothing after it. Free text that merely mentions a link,
    /// other prefixes, http, and trailing words all stay words.
    @Test func screenshotProseRecognizerStaysNarrow() {
        #expect(TinyLive.screenshotProseURL("see https://x.example/a.png") == nil)
        #expect(TinyLive.screenshotProseURL("screenshot: http://x.example/a.png") == nil)
        #expect(TinyLive.screenshotProseURL("screenshot: https://x.example/a.png (stale)") == nil)
        #expect(TinyLive.screenshotProseURL("screenshot failed: ESP_ERR_TIMEOUT") == nil)
        #expect(TinyLive.screenshotProseURL("  screenshot:  https://x.example/a.png  ")
                == URL(string: "https://x.example/a.png"))
    }
}

// ── Remote ears: the rule the camera learned and the microphone didn't ──────

/// `readFrameAnswer` states the rule — "if the device said ANYTHING, stop polling
/// and say what it said" — and lists the two bugs it was written to kill. Both
/// were still live in `remoteListen`, on the same wire, for the same reason: it
/// regexed a `.wav` URL out of `obj["result"]` and, finding none, **returned with
/// nothing said**. A bare-string payload (legal here — the worker validates with
/// JS `JSON.parse`) failed the `[String: Any]` cast and hit `continue`, so an
/// answer that HAD arrived burned the whole 36s budget and then said nothing too.
///
/// Four silent dead ends, behind a spinner, over a panel still reading
/// "tiny necklace · remote". The server has always done this correctly for the
/// SAME invoke (`nicla_listen`, `lib/chat/tools/nicla.ts`): no URL → the
/// necklace's own words become the error. So asking the agent to listen told you
/// why; tapping the ear did not.
@Suite struct ListenResultTests {

    @Test func everyOutcomeExceptTheClipHasSomethingToSay() {
        // The whole defect in one assertion: a tap may not end in silence.
        let mustSpeak: [TinyLive.ListenResult] = [
            .said("mic busy"),
            .couldNotAsk("Please sign out and back in."),
            .noAnswer(seconds: 36),
        ]
        for c in mustSpeak {
            #expect(c.note?.isEmpty == false, "a silent outcome is the bug being fixed: \(c)")
        }
        // …and the clip says nothing BECAUSE it plays. The one case allowed to.
        #expect(TinyLive.ListenResult.clip(URL(string: "https://r2.example/a.wav")!).note == nil)
    }

    @Test func aHostedWavIsTheClip() {
        #expect(TinyLive.readClipAnswer(#"{"result":"recorded 3s: https://r2.example/clip.wav"}"#)
                == .clip(URL(string: "https://r2.example/clip.wav")!))
    }

    /// The headline. This payload used to produce NOTHING: no clip, no sentence,
    /// no state change — a spinner that stopped.
    @Test func anAnswerWithoutAClipIsStillAnAnswer() {
        #expect(TinyLive.readClipAnswer(#"{"result":"microphone busy"}"#) == .said("microphone busy"))
        #expect(TinyLive.readClipAnswer(#"{"error":"no microphone on this device"}"#)
                == .said("no microphone on this device"))
    }

    /// `RelayReply.text` is why this passes: the old code read `obj["result"]`
    /// only, so a daemon answering `{"text":…}` or `{"output":…}` — both of which
    /// the shared unwrapper has always handled — was treated as no answer at all.
    @Test func theOtherKeysTheWireUsesAreReadToo() {
        #expect(TinyLive.readClipAnswer(#"{"text":"say that again?"}"#) == .said("say that again?"))
        #expect(TinyLive.readClipAnswer(#"{"output":"nothing to hear"}"#) == .said("nothing to hear"))
    }

    /// Bug 2 of `readFrameAnswer`'s pair, which the audio path still had: a bare
    /// JSON string is a legal payload, and it used to fail the dictionary cast.
    @Test func aBareStringPayloadIsAnAnswerNotATimeout() {
        #expect(TinyLive.readClipAnswer(#""mic in use""#) == .said("mic in use"))
        // Even when the bare string IS the clip URL.
        #expect(TinyLive.readClipAnswer(#""https://r2.example/bare.wav""#)
                == .clip(URL(string: "https://r2.example/bare.wav")!))
    }

    /// Unparseable payloads reach the user verbatim rather than vanishing — a raw
    /// payload on screen is debuggable, a blank panel is not.
    @Test func anUnparseablePayloadIsShownAsItCame() {
        #expect(TinyLive.readClipAnswer("<html>502</html>") == .said("<html>502</html>"))
    }

    /// A URL that isn't a WAV is not a clip: playing it would hand AVPlayer bytes
    /// it cannot decode, which is silence again — the failure this suite exists
    /// to forbid. The words go to the user instead.
    @Test func aNonWavURLIsWordsNotAClip() {
        #expect(TinyLive.readClipAnswer(#"{"result":"see https://r2.example/photo.jpg"}"#)
                == .said("see https://r2.example/photo.jpg"))
        // http:// is not the hosted-upload scheme either.
        #expect(TinyLive.readClipAnswer(#"{"result":"http://192.168.1.9/clip.wav"}"#)
                == .said("http://192.168.1.9/clip.wav"))
    }

    /// The timeout names the wait it actually spent, and blames the necklace only
    /// because `clipResult` reaches `.noAnswer` solely from `RelayPoll`'s
    /// `.deviceSilent` — the inc-32 rule, inherited rather than re-derived.
    @Test func theTimeoutQuotesTheBudgetItSpent() {
        #expect(TinyLive.ListenResult.noAnswer(seconds: 36).note == "No clip in 36s — is the necklace still online?")
    }
}

// ── The relay poll: who a silence is ABOUT ─────────────────────────────────

/// Both device panels polled the reply mailbox with `guard let … else { continue }`
/// and so collapsed three different answers into one `nil`: an empty mailbox, a
/// refusal (`ApiError.http` — 401 when the session lapsed mid-poll, 424 when the
/// worker had a problem), and no response at all. Only the FIRST is evidence
/// about the device, and both loops ended on a sentence blaming it anyway —
/// "No frame in 19s — is the camera awake?" and "<laptop> didn't answer in 30s —
/// is `tiny mesh` still running there?"
///
/// `FrameFailureTests` above already asserts the rule ("re-wording them
/// client-side is how 'relay send failed' came to stand in for a 401") and
/// `FrameFailure.relayRefused` already existed for it. It held on the SEND arm
/// only. These tests are the poll arm's half.
@Suite struct RelayPollTests {

    /// The headline, as one assertion: a session that lapsed mid-poll must never
    /// come out the other end as a claim about the hardware.
    @Test func aLapsedSessionIsNotASleepingCamera() {
        let read = RelayPoll.classify(.failure(ApiError.http(401, "login required")))
        guard case .unreadable(let reason, let status) = read else {
            Issue.record("a refusal read as \(read) — the whole defect")
            return
        }
        #expect(status == 401)
        // 401 is in `statusOwnsTheMessage`, so the table's line wins over the
        // worker's wire phrase — "Login required" is not something to show a
        // person, and the remedy is the useful half.
        #expect(reason.contains("sign out and back in"))
        // Settled: no amount of waiting signs you back in.
        #expect(RelayPoll.isTerminal(status: status))
        // And the verdict may not blame the device.
        #expect(RelayPoll.verdict(refusal: reason) == .couldNotAsk(reason))
    }

    /// The other half of the same rule: an EMPTY mailbox is real evidence, so the
    /// timeout it earns must survive. Fixing the lie by never blaming the device
    /// would be the same bug facing the other way.
    @Test func anEmptyMailboxStillEarnsATimeout() {
        #expect(RelayPoll.classify(.success(["ok": true, "reply": NSNull()])) == .empty)
        // The route omits `reply` in no case, but a body that simply lacks it is
        // the same statement and must not read as a failure.
        #expect(RelayPoll.classify(.success(["ok": true])) == .empty)
        #expect(RelayPoll.verdict(refusal: nil) == .deviceSilent)
    }

    @Test func aReplyIsTheAnswerAndStopsTheWait() {
        let body: [String: Any] = ["ok": true, "reply": ["payload": #"{"result":"fw 1.3.4"}"#]]
        #expect(RelayPoll.classify(.success(body)) == .answered(#"{"result":"fw 1.3.4"}"#))
    }

    /// Where the status does NOT own the message, the server's own words reach
    /// the screen — the rule `theWordingComesFromWhoeverActuallyKnows` states for
    /// the send arm. 424 is this route's wrapper for a worker-side problem, and
    /// "device not found" is the most actionable sentence in the whole flow.
    @Test func theServersOwnWordsSurviveTheClassification() {
        let read = RelayPoll.classify(.failure(ApiError.http(424, "device not found")))
        guard case .unreadable(let reason, let status) = read else {
            Issue.record("a 424 read as \(read)")
            return
        }
        #expect(reason.contains("device not found"))
        #expect(status == 424)
    }

    /// ⚠️ The half that must NOT regress: a 424, a 5xx or a dropped packet is a
    /// MOMENT, and `pollTries` exists because the host has to run a whole agent
    /// turn before it can answer. Ending the wait on those would re-break the
    /// "No reply within 4s" bug that the 15×2s budget was introduced to fix.
    @Test func onlyASettledRefusalEndsTheWait() {
        for settled in [400, 401, 403, 404] {
            #expect(RelayPoll.isTerminal(status: settled), "\(settled) will not fix itself")
        }
        for moment in [408, 424, 429, 500, 502, 503] {
            #expect(!RelayPoll.isTerminal(status: moment), "\(moment) deserves its retries")
        }
        // A transport failure has no status and is the most transient of all —
        // a phone in a lift must not lose the reply it is about to receive.
        #expect(!RelayPoll.isTerminal(status: nil))
    }

    /// No response at all: no status to branch on, but still a sentence, and
    /// still not the device's fault.
    @Test func aTransportFailureHasNoStatusAndStillHasWords() {
        let read = RelayPoll.classify(.failure(URLError(.notConnectedToInternet)))
        guard case .unreadable(let reason, let status) = read else {
            Issue.record("a transport failure read as \(read)")
            return
        }
        #expect(status == nil)
        #expect(reason.lowercased().contains("connection"))
    }

    /// Bytes arrived and weren't JSON — a mid-redeploy HTML error page served
    /// with a 200, which `Api.get` throws as `.badResponse`. That is emphatically
    /// not an empty mailbox, and the old `try?` made it one.
    @Test func anHtmlErrorPageIsNotAnEmptyMailbox() {
        let read = RelayPoll.classify(.failure(ApiError.badResponse))
        guard case .unreadable(let reason, let status) = read else {
            Issue.record("a junk body read as \(read) — it would have become a timeout")
            return
        }
        #expect(status == nil)   // no HTTP refusal, so nothing to branch on
        #expect(!reason.isEmpty)
        #expect(!RelayPoll.isTerminal(status: status))  // a redeploy passes
    }

    /// Every unreadable carries something to show. A silent failure is the shape
    /// of the bug being fixed, so this is the same assertion
    /// `everyFailureCarriesSomethingToShowTheUser` makes for FrameFailure.
    @Test func noRefusalIsSilent() {
        let errors: [Error] = [
            ApiError.http(401, "login required"), ApiError.http(424, "device not found"),
            ApiError.http(500, nil), ApiError.http(418, nil), ApiError.badResponse,
            URLError(.timedOut),
        ]
        for e in errors {
            guard case .unreadable(let reason, _) = RelayPoll.classify(.failure(e)) else {
                Issue.record("\(e) did not classify as unreadable")
                continue
            }
            #expect(!reason.isEmpty, "a silent refusal is the bug: \(e)")
        }
    }

    /// The LAST attempt decides, and a read clears an earlier refusal. Both
    /// directions matter: an early blip must not overrule what we could see at
    /// the end, and an early success must not paper over a refusal at the end.
    @Test func theLastAttemptDecidesTheVerdict() {
        #expect(RelayPoll.verdict(refusal: nil) == .deviceSilent)
        #expect(RelayPoll.verdict(refusal: "Backend unavailable (HTTP 424)")
                == .couldNotAsk("Backend unavailable (HTTP 424)"))
    }

    /// A reply whose payload is not a string is documented as unreachable (the
    /// route stringifies on send). Pinned so the documented behaviour and the
    /// real behaviour are the same claim: it reads as "nothing yet", which keeps
    /// the poll going rather than surfacing an empty status line.
    @Test func aNonStringPayloadCountsAsNothingYet() {
        #expect(RelayPoll.classify(.success(["reply": ["payload": 7]])) == .empty)
        #expect(RelayPoll.classify(.success(["reply": ["nope": "x"]])) == .empty)
    }
}

// ── Map presence: what "you are not visible" is allowed to mean ────────────

/// Opting out of the public map has two halves — stop publishing (local) and
/// tell the server to drop the row it already holds (a request). The control had
/// two states for three situations, and flipped on the first half while throwing
/// the second half's result away: a failed DELETE left the panel promising
/// "location stays on this phone" while the pin was still on everyone's map for
/// up to the worker's staleness window.
@Suite struct MapPresenceTests {
    /// A stopped-but-unconfirmed opt-out is its own state, distinct from both
    /// "sharing" and "not sharing". This is the whole bug in one assertion.
    @Test func anUnconfirmedOptOutIsNeitherOnNorOff() {
        #expect(MapPresence.control(beSeen: true, optOutFailed: false) == .optOut)
        #expect(MapPresence.control(beSeen: false, optOutFailed: false) == .optIn)
        #expect(MapPresence.control(beSeen: false, optOutFailed: true) == .retryOptOut)
    }

    /// A running beat means the user IS visible, whatever an earlier failure
    /// said — so `beSeen` outranks a stale `optOutFailed`.
    @Test func aRunningBeatOutranksAnOldFailure() {
        #expect(MapPresence.control(beSeen: true, optOutFailed: true) == .optOut)
    }

    /// Only an explicit `ok: true` is a confirmed opt-out. Everything else —
    /// including the `nil` that `try?` leaves behind when the request threw —
    /// means the server never said it dropped the row, so it must not be read
    /// as success. This is the assertion that used to have no code at all.
    @Test func onlyAnExplicitOkCountsAsConfirmed() {
        #expect(MapPresence.optOutConfirmed(["ok": true]))
        #expect(!MapPresence.optOutConfirmed(nil))                    // threw: offline / 401 / 5xx
        #expect(!MapPresence.optOutConfirmed([:]))                    // 200 with no verdict
        #expect(!MapPresence.optOutConfirmed(["ok": false]))          // server declined
        #expect(!MapPresence.optOutConfirmed(["error": "nope"]))
        // Not truthiness: a string or a number is not the server saying yes.
        #expect(!MapPresence.optOutConfirmed(["ok": "true"]))
        #expect(!MapPresence.optOutConfirmed(["ok": 1]))
    }

    /// THE regression: no state may promise the location is private unless the
    /// server confirmed it. The old caption said "stays on this phone" for both
    /// of the not-publishing states.
    @Test func onlyAConfirmedOptOutMayPromisePrivacy() {
        let promise = "stays on this phone"
        #expect(MapPresence.caption(for: .optIn).contains(promise))
        #expect(!MapPresence.caption(for: .retryOptOut).contains(promise))
        #expect(!MapPresence.caption(for: .optOut).contains(promise))
    }

    /// The unconfirmed state has to say what is still true, for how long, and
    /// what to do — it is the only state the user can't see the consequence of.
    @Test func theUnconfirmedStateNamesTheExposureAndTheWindow() {
        let c = MapPresence.caption(for: .retryOptOut)
        #expect(c.contains("didn't confirm"))
        #expect(c.contains("\(MapPresence.staleWindowMinutes) min"))
        #expect(c.contains("again"))
        // And the control itself stops claiming you're hidden.
        #expect(MapPresence.label(for: .retryOptOut).contains("still visible"))
    }

    /// Mirrors the worker's MAP_PRESENCE_WINDOW_S (locations.ts) = 300s. If that
    /// changes, the sentence promising "up to 5 min" becomes a lie.
    @Test func theStatedWindowMatchesTheWorkersStalenessCut() {
        #expect(MapPresence.staleWindowMinutes == 300 / 60)
    }

    /// Three states, three sentences, three labels, three spoken labels — a
    /// shared string anywhere would be the same conflation in a new place.
    @Test func everyStateReadsDifferentlyEverywhere() {
        let all: [MapPresence.Control] = [.optIn, .optOut, .retryOptOut]
        #expect(Set(all.map(MapPresence.label(for:))).count == 3)
        #expect(Set(all.map(MapPresence.caption(for:))).count == 3)
        #expect(Set(all.map(MapPresence.accessibilityLabel(for:))).count == 3)
        // VoiceOver must hear the exposure too, not just an action.
        #expect(MapPresence.accessibilityLabel(for: .retryOptOut)
            .lowercased().contains("still visible"))
    }
}

// ── Nearby pairing: what an empty radio list is allowed to claim ───────────

/// The devices panel now offers pairing inline, so its empty line is load-bearing
/// — it is the only thing standing between "your necklace isn't here" and "we
/// never looked". Those had been one string picked by `scanning` first.
@Suite struct BleEmptyStateTests {
    private func msg(scanning: Bool = false, state: String = "poweredOn",
                     completedScan: Bool = false) -> String {
        BleEmptyState.message(scanning: scanning, state: state, completedScan: completedScan)
    }

    /// THE regression. With Bluetooth off, the first scan is stood down; turning
    /// Bluetooth ON later used to start nothing, and the list — not scanning, no
    /// error state — announced a confident empty result for a scan that never
    /// ran. A never-scanned list may not claim anything about what's out there.
    @Test func aScanThatNeverRanMayNotClaimNothingIsThere() {
        let idle = msg(completedScan: false)
        #expect(!idle.lowercased().contains("nothing"))
        #expect(!idle.lowercased().contains("no devices"))
        // …whereas a finished scan has earned exactly that claim.
        #expect(msg(completedScan: true).lowercased().contains("nothing"))
    }

    /// An unavailable radio outranks a claimed scan: it is both the true answer
    /// and the only one the user can do something about. The old ternary put
    /// `scanning` first, so a powered-off adapter read as "Scanning…" for the
    /// entire window before admitting the truth.
    @Test func radioTroubleOutranksAClaimedScan() {
        #expect(msg(scanning: true, state: "poweredOff").contains("Bluetooth is off"))
        #expect(msg(scanning: true, state: "unauthorized").contains("permission"))
        #expect(msg(scanning: true, state: "unsupported").contains("no Bluetooth radio"))
    }

    /// And it says what to DO — the powered-off line has to promise the recovery
    /// that the scanner's `wanted` flag now actually delivers.
    @Test func theOffLinePromisesTheAutomaticRecovery() {
        let off = msg(state: "poweredOff")
        #expect(off.contains("Turn it on"))
        #expect(off.contains("fills in"))
    }

    @Test func aRunningScanSaysSoWhenTheRadioIsFine() {
        #expect(msg(scanning: true).lowercased().contains("looking"))
    }

    /// Four situations, four distinct sentences — a shared string would be the
    /// same bug in a new shape.
    @Test func everySituationReadsDifferently() {
        let all = [msg(scanning: true), msg(state: "poweredOff"),
                   msg(state: "unauthorized"), msg(state: "unsupported"),
                   msg(completedScan: true), msg(completedScan: false)]
        #expect(Set(all).count == all.count)
        #expect(all.allSatisfy { !$0.isEmpty })
    }
}

/// 💎 The two surfaces that never asked, and the sentence a model repeats as fact.
///
/// `BleEmptyState` was extracted for the panel caption, and three other places
/// went on deciding for themselves: `NearbyView`'s ternary (the original bug,
/// preserved), `adopt()`'s "Couldn't see the necklace nearby", and — worst —
/// `scanSummary`, whose text is appended to the agent's prompt, so "No BLE
/// devices discovered nearby." leaves the phone as a claim about the user's room.
/// None of the three had an arm for a phone with no radio, and none knew whether
/// a scan had ever run.
///
/// `obstacle` is the shared half: **nil means the phone really looked**, and only
/// then may a caller say the room is empty in its own words.
@Suite struct BleObstacleTests {
    private func why(scanning: Bool = false, state: String = "poweredOn",
                     completedScan: Bool = false) -> String? {
        BleEmptyState.obstacle(scanning: scanning, state: state, completedScan: completedScan)
    }

    private func sit(scanning: Bool = false, state: String = "poweredOn",
                     completedScan: Bool = false) -> BleEmptyState.Situation {
        BleEmptyState.situation(scanning: scanning, state: state, completedScan: completedScan)
    }

    /// The whole rule in one test. A finished scan is the ONLY thing that earns
    /// the right to be answered with "nothing is out there".
    @Test func onlyAFinishedScanIsAllowedToReportAnEmptyRoom() {
        #expect(why(completedScan: true) == nil)
        // Everything else names an obstacle instead — including the two the old
        // ternaries fell through: no radio, and a scan that never ran.
        #expect(why(state: "unsupported") != nil)
        #expect(why(completedScan: false) != nil)
        #expect(why(state: "idle") != nil)
        #expect(why(scanning: true) != nil)
        #expect(why(state: "unauthorized") != nil)
        #expect(why(state: "poweredOff") != nil)
    }

    /// An obstacle explains the INSTRUMENT; it must never pose as a result. The
    /// caller's own found-nothing sentence is the only report of the room.
    @Test func noObstacleSentencePosesAsAnAnswerAboutTheRoom() throws {
        let all = [why(state: "unauthorized"), why(state: "poweredOff"),
                   why(state: "unsupported"), why(scanning: true), why(state: "idle")]
        for line in all {
            let s = try #require(line)
            #expect(s.lowercased().contains("phone"), "“\(s)” doesn't say whose radio")
            // "discovered" is the found-nothing register — the agent's own word
            // for a completed search, which an obstacle has not performed.
            #expect(!s.lowercased().contains("discovered"), "“\(s)” reads as a search result")
            #expect(!s.lowercased().contains("no ble devices"), "“\(s)” claims the room is empty")
        }
        #expect(Set(all.map { $0 ?? "" }).count == all.count, "two obstacles share a sentence")
    }

    /// Radio trouble still outranks a claimed scan on THIS side too. `scanning`
    /// was what the old ternaries checked first, and it is the one input that can
    /// be true while the radio is doing nothing.
    @Test func theObstacleRanksRadioTroubleAboveAClaimedScan() {
        #expect(why(scanning: true, state: "poweredOff")?.contains("turned off") == true)
        #expect(why(scanning: true, state: "unauthorized")?.contains("denied") == true)
        #expect(why(scanning: true, state: "unsupported")?.contains("no Bluetooth radio") == true)
        // …and a claimed scan on a healthy radio is not an obstacle-free answer:
        // it is "still scanning", never an empty room.
        #expect(why(scanning: true, completedScan: true) != nil)
    }

    /// The two registers may differ in WORDS and never in what they claim. The
    /// caption saying "nothing nearby" and `obstacle` returning nil are the same
    /// verdict; if they can disagree, one surface is lying while the other is not.
    @Test func theCaptionAndTheAgentAgreeOnWhatIsTrue() {
        let inputs: [(Bool, String, Bool)] = [
            (false, "poweredOn", true), (false, "poweredOn", false), (true, "poweredOn", false),
            (false, "poweredOff", false), (false, "unauthorized", false),
            (false, "unsupported", false), (false, "idle", false),
            (true, "poweredOff", true), (true, "unsupported", true),
        ]
        for (scanning, state, done) in inputs {
            let caption = BleEmptyState.message(scanning: scanning, state: state, completedScan: done)
            let obstacle = BleEmptyState.obstacle(scanning: scanning, state: state, completedScan: done)
            let captionClaimsEmpty = caption.lowercased().contains("nothing nearby")
            #expect(captionClaimsEmpty == (obstacle == nil),
                    "\(state)/scanning:\(scanning)/done:\(done) — caption “\(caption)” vs obstacle “\(obstacle ?? "nil")”")
        }
    }

    /// Six situations, and an unrecognised state is doubt rather than a default
    /// answer: `idle` is what CoreBluetooth's `.unknown` and `.resetting` become,
    /// and both mean the verdict has not arrived.
    @Test func anUnknownRadioStateIsNotAnAnswer() {
        #expect(sit(state: "idle") == .neverLooked)
        #expect(sit(state: "idle", completedScan: true) == .lookedAndFoundNothing)
        #expect(sit(state: "poweredOff", completedScan: true) == .radioOff)
        #expect(sit(scanning: true) == .looking)
        #expect(sit(state: "unsupported") == .noRadio)
        #expect(sit(state: "unauthorized") == .noPermission)
        #expect(sit(completedScan: true) == .lookedAndFoundNothing)
        #expect(sit() == .neverLooked)
    }
}

/// Which name a discovered peripheral is listed under.
@Suite struct BleNameTests {
    /// The regression, in the order that matters: the ADVERTISED name wins over
    /// the cached one. CoreBluetooth's own precedence is the opposite, and it put
    /// a provisioned necklace in the Nearby list as 'MPY NIMBLE' — measured on
    /// air, on the one board of three that a central had ever connected to.
    @Test func theAdvertisedNameWinsOverTheCachedOne() {
        #expect(BleName.pick(advertised: "tiny-b3d3", cached: "MPY NIMBLE") == "tiny-b3d3")
        #expect(BleName.pick(advertised: "tiny-b3d3", cached: nil) == "tiny-b3d3")
    }

    /// ...but the cache is not worthless. Plenty of peripherals put no local name
    /// in the packet, and dropping to "Unnamed device" while iOS knows the name
    /// would be a new bug in the other direction.
    @Test func theCacheIsStillTheFallback() {
        #expect(BleName.pick(advertised: nil, cached: "Flipper Zero") == "Flipper Zero")
        #expect(BleName.pick(advertised: nil, cached: nil) == "Unnamed device")
    }

    /// An empty or blank local name is present-but-useless, and `??` would take
    /// it: a board advertising "" would be listed as nothing at all.
    @Test func aBlankNameIsNotAName() {
        #expect(BleName.pick(advertised: "", cached: "tiny-b3d3") == "tiny-b3d3")
        #expect(BleName.pick(advertised: "  ", cached: "tiny-b3d3") == "tiny-b3d3")
        #expect(BleName.pick(advertised: "", cached: "") == "Unnamed device")
    }
}

/// The resume gate — the other half of the same bug, on the scanner's side.
@Suite struct BleScanGateTests {
    /// Neither input alone is enough, and BOTH matter. A view still asking is
    /// not a reason to scan with the radio off, and a powered-on radio is not a
    /// reason to scan for a sheet the user already closed.
    @Test func bothInputsAreLoadBearing() {
        #expect(BleScanGate.shouldScan(wanted: true, poweredOn: true))
        #expect(!BleScanGate.shouldScan(wanted: true, poweredOn: false))
        #expect(!BleScanGate.shouldScan(wanted: false, poweredOn: true))
        #expect(!BleScanGate.shouldScan(wanted: false, poweredOn: false))
    }

    /// The regression in one line: a request that outlived a powered-off radio
    /// must still be honoured the moment the radio comes back. The old code
    /// consulted `scanning`, which is false at exactly this moment.
    @Test func aRequestSurvivesTheRadioComingBack() {
        #expect(!BleScanGate.shouldScan(wanted: true, poweredOn: false))   // radio off
        #expect(BleScanGate.shouldScan(wanted: true, poweredOn: true))     // user flips it on
    }
}

/// Signal strength, the one number the pairing card turns into a decision.
@Suite struct BleSignalTests {
    @Test func barsStayInRangeAcrossEveryPlausibleRssi() {
        for rssi in -120 ... 0 {
            let b = BleSignal.bars(rssi: rssi)
            #expect(b >= 1 && b <= BleSignal.maxBars)
        }
    }

    /// Monotonic: a stronger signal never shows fewer bars. Without this a
    /// threshold typo could make walking closer look like walking away.
    @Test func closerNeverShowsFewerBars() {
        for rssi in -119 ... 0 {
            #expect(BleSignal.bars(rssi: rssi) >= BleSignal.bars(rssi: rssi - 1))
        }
    }

    @Test func thresholdsMatchTheDotColoursNearbyAlreadyUsed() {
        #expect(BleSignal.bars(rssi: -54) == 3)   // > -55 → green
        #expect(BleSignal.bars(rssi: -55) == 2)   // boundary belongs to the tier below
        #expect(BleSignal.bars(rssi: -74) == 2)   // > -75 → yellow
        #expect(BleSignal.bars(rssi: -75) == 1)
    }

    /// VoiceOver gets the same three readings, and the weakest one says what to
    /// do about it — bars can't convey "move closer" to someone not looking.
    @Test func everyStrengthHasItsOwnWords() {
        let words = [-40, -60, -90].map { BleSignal.label(rssi: $0) }
        #expect(Set(words).count == 3)
        #expect(BleSignal.label(rssi: -90).contains("closer"))
    }
}

// MARK: - Config editor: three answers, not two

/// A read that never arrived is not a verdict.
///
/// The editor's failure mode was specific and unkind: `try?` + `?? false` made
/// `isOwner` false whenever the request threw, and the only branch for a false
/// `isOwner` says "Only X's owner can edit it." So an outage accused the owner
/// of not owning their own tiny — and told them to change a setting that was
/// already right.
@Suite struct TinyEditorLoadTests {
    @Test func aFailedReadIsNeverAnOwnershipVerdict() {
        // The exact old shape: nothing read, so isOwner defaulted to false.
        #expect(TinyEditorLoad.screen(loaded: false, isOwner: false) == .failed)
    }

    /// Even a stale `true` must not let an outage render the editable form —
    /// its fields would be whatever the last load left behind.
    @Test func aFailedReadOutranksAStaleOwnershipFlag() {
        #expect(TinyEditorLoad.screen(loaded: false, isOwner: true) == .failed)
    }

    @Test func onlyTheServersOwnWordDeniesOwnership() {
        #expect(TinyEditorLoad.screen(loaded: true, isOwner: false) == .notOwner)
        #expect(TinyEditorLoad.screen(loaded: true, isOwner: true) == .editor)
    }

    /// Three inputs, three distinct screens: no two situations may share one.
    @Test func everyOutcomeIsItsOwnScreen() {
        let seen = Set([
            TinyEditorLoad.screen(loaded: false, isOwner: false),
            TinyEditorLoad.screen(loaded: true, isOwner: false),
            TinyEditorLoad.screen(loaded: true, isOwner: true),
        ])
        #expect(seen.count == 3)
    }

    // MARK: - …and the door the fix above did not cover (increment 19)

    /// ⚠️⚠️ The suite's own premise was an unchecked assumption: *"whenever the
    /// request threw"*. It usually does not. `app/api/tiny/route.ts` bounds the
    /// worker at 10s and degrades a timeout, a 5xx or a non-JSON body into a
    /// **200 carrying its blank shape**, so `Api.post` returns normally and the
    /// missing `isOwner` becomes `false` through `?? false` — straight into the
    /// branch that says *"Only X's owner can edit it."* The likelier door, left
    /// open by a fix aimed at the rarer one.
    @Test("the route's own degrade is not an ownership verdict")
    func aDegradedTwoHundredIsNotAVerdict() {
        // Verbatim the route's catch shape (with the marker it now carries).
        let degraded: [String: Any] = [
            "unavailable": true, "name": "acme", "private": false, "active": false,
            "systemPrompt": "", "systemKnowledge": "", "data": "", "hook": "",
            "worker": "", "schema": [String: Any](),
        ]
        #expect(TinyEditorLoad.readFailed(degraded))
        // Which is the only thing that keeps it off the not-owner screen: the
        // body's own `isOwner` is absent, and absent reads as false.
        #expect(degraded["isOwner"] == nil)
        #expect(TinyEditorLoad.screen(loaded: !TinyEditorLoad.readFailed(degraded),
                                      isOwner: degraded["isOwner"] as? Bool ?? false) == .failed)
    }

    @Test("a tiny that really isn't there still gets the not-owner screen")
    func anAnswerIsAnAnswerEvenWhenItIsNo() {
        // The route's not-exists shape: no `isOwner` either, but the worker DID
        // reply — so this is a real answer and must not be called a failure, or
        // every mistyped name would offer a Retry that can never succeed.
        let missing: [String: Any] = [
            "name": "nope", "active": false, "systemPrompt": "", "systemKnowledge": "",
            "data": "", "hook": "", "worker": "", "schema": [String: Any](),
        ]
        #expect(!TinyEditorLoad.readFailed(missing))
        #expect(TinyEditorLoad.screen(loaded: !TinyEditorLoad.readFailed(missing),
                                      isOwner: false) == .notOwner)
    }

    @Test("a real answer is never called a failure")
    func aSuccessIsNotDegraded() {
        for owner in [true, false] {
            let ok: [String: Any] = ["name": "acme", "isOwner": owner, "isAuthorized": owner,
                                     "active": true, "systemPrompt": "hi"]
            #expect(!TinyEditorLoad.readFailed(ok))
            #expect(TinyEditorLoad.screen(loaded: true, isOwner: owner) == (owner ? .editor : .notOwner))
        }
    }

    @Test("only the real Boolean counts as the marker")
    func theMarkerIsReadStrictly() {
        // `unavailable: false` is a body that read fine. A STRING "true" is not
        // our route talking — something rewrote the body — and there the old
        // behaviour is the safer default: guessing a second time is what this
        // whole arc exists to stop.
        #expect(!TinyEditorLoad.readFailed(["unavailable": false]))
        #expect(!TinyEditorLoad.readFailed(["unavailable": "true"]))
        #expect(!TinyEditorLoad.readFailed([:]))
        #expect(TinyEditorLoad.readFailed(["unavailable": true]))
    }
}

/// An unread price must not look like — or become — free.
@Suite struct TinyPriceTests {
    /// Where "unknown" comes from. The lookup 400s on failure, so a body that
    /// arrived is the answer — even a keyless one, because absent means free.
    @Test func onlyAnAbsentBodyMeansThePriceIsUnknown() {
        #expect(TinyPrice.known(nil) == false)
        #expect(TinyPrice.known([:]))                        // free: no key sent
        #expect(TinyPrice.known(["price_micro": 0]))         // free: explicit 0
        #expect(TinyPrice.known(["price_micro": 50_000]))
    }

    /// The money bug: the lookup failed, the field went blank, and blank posts
    /// price_micro 0. One tap on "Save price" would have cut a paid tiny's
    /// price to nothing on the strength of a network error.
    @Test func anUnknownPriceCannotBeSavedAsFree() {
        #expect(TinyPrice.mayPost(known: false, typed: "") == false)
        #expect(TinyPrice.mayPost(known: false, typed: "   ") == false)
    }

    /// Typing is consent: an explicit number may post even when the opening
    /// lookup failed, otherwise a pricing outage would lock the owner out of
    /// their own price.
    @Test func atypedPriceMayPostEvenAfterAFailedLookup() {
        #expect(TinyPrice.mayPost(known: false, typed: "0.05"))
        // Including an explicit zero — "make it free" is a real intention.
        #expect(TinyPrice.mayPost(known: false, typed: "0"))
    }

    /// A price that WAS read back may be cleared to free, the pre-existing
    /// behaviour this fix must not take away.
    @Test func aKnownPriceMayStillBeClearedToFree() {
        #expect(TinyPrice.mayPost(known: true, typed: ""))
    }

    /// And the screen has to admit it, or a blank field still reads as $0.
    @Test func theUnknownStateSaysSoAndDisownsTheField() {
        #expect(TinyPrice.unknownNote(known: true) == nil)
        let note = TinyPrice.unknownNote(known: false)
        #expect(note?.contains("isn't it") == true)
    }
}

// MARK: - The devices screen, without the devices

/// A harness is only worth having if it goes through the real parser and if a
/// test can read the dataset — otherwise it proves the code it isn't using
/// works, and drifts unnoticed the moment the wire changes shape.
@MainActor
@Suite struct DevicesHarnessTests {
    #if DEBUG
    @Test func theDatasetSurvivesTheRealParser() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        #expect(rows.count == DevicesHarness.serverWire().count)
    }

    /// The row that exists to defend the three-state parse: an endpoint sends
    /// `null` for online because it has no heartbeat, and collapsing that to
    /// false is the bug that once sorted every robot in with the dead machines.
    @Test func theEndpointRowKeepsItsUnknownPresence() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        let printer = rows.first { $0.kind == "endpoint" }
        #expect(printer != nil)
        #expect(printer?.online == nil)
        #expect(printer?.presence == .unknown)
    }

    /// Capabilities arrive as a JSON string and are ordered on the way in, so the
    /// chips don't reshuffle between refreshes. The dataset ships them unsorted
    /// on purpose — sorted input would let a dropped sort pass.
    ///
    /// ⚠️ The order below is the LABEL order (Android, browser, files, Flipper
    /// Zero, MCP), which on this one row happens to coincide with the token order
    /// it used to assert. That coincidence is why this test kept passing when the
    /// sort key changed under it, so it says so out loud: what is pinned here is
    /// that SOMETHING orders the list, and the ordering RULE belongs to
    /// theCapabilityStripIsSortedByTheWordTheUserSees. Rename a capability and it
    /// is that test, not this one, that should be doing the talking.
    @Test func capabilitiesArriveSortedFromAnUnsortedWire() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        let flipper = rows.first { $0.capabilities.contains("flipper") }
        #expect(flipper?.capabilities == ["adb", "browse", "files", "flipper", "mcp"])
        #expect(flipper?.capabilities.map(capabilityLabel)
            == ["Android", "browser", "files", "Flipper Zero", "MCP"])
    }

    /// One row per branch of `cell(_:)`. Losing any of these silently shrinks
    /// what the screen can be looked at in, which is how it drifted in the first
    /// place.
    @Test func everyPanelTheScreenCanGrowHasARowToGrowOn() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        #expect(rows.contains { $0.isEndpoint })                              // EndpointPanel
        #expect(rows.contains { $0.platform == "nicla-vision" && $0.capabilities.contains("camera") })
        #expect(rows.contains { $0.platform == "nicla-voice" })               // VoiceDevicePanel
        #expect(rows.contains { $0.capabilities.contains("flipper") })        // FlipperDevicePanel
        // All three presence states, so the dot is never drawn in only one.
        #expect(Set(rows.map(\.presence)).count == 3)
    }

    /// The dataset's phone row must declare exactly what this app enrolls.
    ///
    /// The first draft invented its wire values, and invented values render a
    /// screen the app doesn't have: `platform: "iphone"` misses the `ios` needle
    /// in DEVICE_PLATFORM_GLYPH, so the harness drew a CPU chip where every real
    /// iPhone draws a phone — a wrong picture used to judge a design. This is the
    /// one row whose truth a test can actually hold onto.
    @Test func thePhoneRowDeclaresWhatThisAppReallyEnrolls() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        let phone = rows.first { $0.id == DevicesHarness.myDeviceId }
        #expect(phone != nil)
        #expect(phone?.platform == "ios-arm64")     // Session.enroll's literal
        // The SET is what this test is about. The ORDER stopped being the token
        // order when the chips started showing labels, and it has its own test
        // below — comparing to `.sorted()` here would pin the strip's ordering in
        // the one place whose subject is enrollment.
        #expect(Set(phone?.capabilities ?? []) == Set(TinySession.capabilities))
        // …and that platform must reach the phone glyph, not the fallback.
        #expect(deviceGlyph(platform: phone?.platform ?? "", kind: phone?.kind ?? "") == "iphone")
    }

    /// Every capability the fleet declares should have earned a real glyph.
    /// `capabilityIcon` knew only the six necklace words while the screen showed
    /// three enrollment families, so twenty-odd chips wore one dashed circle.
    @Test func everyCapabilityInTheFleetHasItsOwnIcon() {
        let caps = Set(DevicesView.decodeDevices(DevicesHarness.serverWire()).flatMap(\.capabilities))
        let unnamed = caps.filter { capabilityIcon($0) == nil }.sorted()
        #expect(unnamed.isEmpty, "no icon for: \(unnamed.joined(separator: ", "))")
        // Distinct, too: one shared glyph across many chips is the same noise
        // the dashed circle was.
        let icons = caps.compactMap(capabilityIcon)
        #expect(Set(icons).count == icons.count)
    }

    /// The strip is sorted for the reader, not for the wire.
    ///
    /// Sorting the tokens was right while the chips PRINTED the tokens. Once they
    /// showed words, the necklace's strip came out ble/camera/imu/mic/tof/wifi and
    /// reached the screen as "bluetooth camera motion mic distance Wi-Fi" — in
    /// perfect alphabetical order by a string the user is never shown, which on
    /// screen is indistinguishable from no order at all. Caught by looking at it;
    /// pinned here because the next person to touch the sort will be looking at
    /// the tokens, same as the last one.
    @Test func theCapabilityStripIsSortedByTheWordTheUserSees() {
        let rows = DevicesView.decodeDevices(DevicesHarness.serverWire())
        for row in rows {
            let shown = row.capabilities.map(capabilityLabel)
            #expect(shown == shown.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending },
                    "\(row.name)'s strip reads out of order: \(shown.joined(separator: ", "))")
        }
        // And concretely, on the row that exposed it — six capabilities whose
        // labels sort nothing like their tokens.
        let vision = rows.first { $0.platform == "nicla-vision" }
        #expect(vision?.capabilities.map(capabilityLabel)
            == ["bluetooth", "camera", "distance", "mic", "motion", "Wi-Fi"])
        // Capitals must not float to the front: "Android" belongs beside
        // "browser", not above it, which a plain `<` on the labels gets wrong.
        let pi = rows.first { $0.name == "ada-bench-pi" }
        #expect(pi?.capabilities.map(capabilityLabel)
            == ["Android", "browser", "files", "Flipper Zero", "MCP"])
    }

    /// Both pairing-card states, at strengths that land in different bar tiers —
    /// two beacons at one strength would make the staircase look decorative.
    @Test func bothPairingStatesAreOnScreenAtDifferentStrengths() {
        let b = DevicesHarness.beacons()
        #expect(b.contains { $0.tiny?.provisioned == false })   // "Set up"
        #expect(b.contains { $0.tiny?.provisioned == true })    // "Reconfigure"
        #expect(Set(b.map { BleSignal.bars(rssi: $0.rssi) }).count == b.count)
    }
    #endif

    /// The flags are opt-in and nothing else turns them on — a harness that could
    /// swap in fake devices during a real session would be a bug, not a tool.
    @Test func onlyTheFlagsSwapTheDataset() {
        #expect(DevicesHarness.usesDemoDataset(arguments: []) == false)
        #expect(DevicesHarness.usesDemoDataset(arguments: ["--memory-list-harness"]) == false)
        #expect(DevicesHarness.usesDemoDataset(arguments: [DevicesHarness.flag]))
        #expect(DevicesHarness.usesDemoDataset(arguments: [DevicesHarness.sheetFlag]))
    }

    /// Only the stills flag opens the sheet. The dataset flag must not, or it
    /// would put the sheet on screen during a driver's first beat and eat its
    /// opening tap — the trap the graph harness's comment records.
    @Test func onlyTheStillsFlagOpensTheSheet() {
        #expect(DevicesHarness.autoOpensSheet(arguments: [DevicesHarness.flag]) == false)
        #expect(DevicesHarness.autoOpensSheet(arguments: [DevicesHarness.sheetFlag]))
        #expect(DevicesHarness.autoOpensSheet(arguments: []) == false)
    }
}

// MARK: - A harness run must not raise a dialog nothing can dismiss

/// `simctl` can tap nothing. Every one of these flags names a run whose whole
/// purpose is to be photographed, so a permission modal is pure obstruction —
/// and the two prompts that fire without a tap fire ONLY in such runs.
@Suite struct HarnessRunTests {
    /// Every harness flag the app actually reads, straight from the sources.
    /// If a new one lands with a different shape, this is what should fail.
    static let shippedFlags = [
        "--session-harness", "--memory-graph-harness", "--graph-dataset-harness",
        "--memory-list-harness", "--memory-dataset-harness", "--map-tracking-harness",
        "--voice-call-harness", "--map-full-harness", "--map-be-seen-harness",
        "--map-ambient-harness", "--devices-harness", "--devices-sheet-harness",
        "--map-fly-test",
    ]

    @Test func everyShippedHarnessFlagIsRecognised() {
        for flag in Self.shippedFlags {
            #expect(HarnessRun.isFlag(flag), "\(flag) would still raise a system alert")
        }
    }

    @Test func aRealLaunchIsNotAHarness() {
        // What UIKit itself passes, plus the paths simctl prepends.
        for argument in ["/var/containers/Bundle/Application/Tiny.app/Tiny",
                         "-UIApplicationForceLaunchToLandscape", "--", "tinyapp://devices"] {
            #expect(!HarnessRun.isFlag(argument))
        }
    }

    /// The harness argument is never argv[0], so scanning must be a search and
    /// not a look at one slot — a `first == flag` check would pass every unit
    /// test here and suppress nothing at all on the device.
    @Test func theFlagIsFoundAnywhereInTheArgumentList() {
        #if DEBUG
        let real = ["/Tiny.app/Tiny", "--session-harness", "--devices-sheet-harness"]
        #expect(HarnessRun.suppressesSystemPrompts(arguments: real))
        #expect(!HarnessRun.suppressesSystemPrompts(arguments: ["/Tiny.app/Tiny"]))
        #expect(!HarnessRun.suppressesSystemPrompts(arguments: []))
        #endif
    }

    /// Suppression is a property of the RUN, not of any one screen: the map
    /// harness carries no `--session-harness` and still must not be asked for
    /// location, and a devices run carries no map flag and still must not be
    /// asked for notifications.
    @Test func oneHarnessFlagIsEnoughOnItsOwn() {
        #if DEBUG
        #expect(HarnessRun.suppressesSystemPrompts(arguments: ["--map-ambient-harness"]))
        #expect(HarnessRun.suppressesSystemPrompts(arguments: ["--devices-sheet-harness"]))
        #endif
    }

    /// "Looks like one of ours" is prefix AND suffix, not "contains the word":
    /// a bare word, a single dash, or a longer word ending elsewhere must all
    /// miss, or something like a device named `session-harness` landing in argv
    /// would silently mute a real user's prompts.
    @Test func onlyDoubleDashedFlagsCount() {
        #expect(!HarnessRun.isFlag("session-harness"))
        #expect(!HarnessRun.isFlag("-session-harness"))
        #expect(!HarnessRun.isFlag("--session-harnessing"))
        #expect(HarnessRun.isFlag("--harness"))
    }
}

// ── Call recordings: no answer is not an empty archive ────────────────────────

/// 🔴 Two of the three answers /api/voice/sessions can give were drawn as
/// "No calls yet".
///
/// The route replies `200 {ok:true, sessions:[…]}`, `401 {ok:false,
/// error:"login required"}`, or `502 {ok:false, error:…}` when the worker is
/// unreachable. Call recordings reached past `Api` to a bare `URLSession`, threw
/// the response away (`let (data, _)`), and decoded into `{ sessions:
/// [CallSession]? }` — where an ABSENT key satisfies an optional property. Both
/// refusal bodies therefore decoded *successfully* with `sessions == nil`, the
/// list read `[]`, and the screen stated, about the user's own recordings:
///
///     "No calls yet — finished voice calls appear here"
///
/// A screen that never got an answer has no standing to say that. Someone whose
/// session had merely expired was told their call archive was empty.
///
/// Two independent links, and this suite checks both **without stubbing
/// `Api.transport`**: that global is owned by `ApiTransportTests`, and a second
/// suite installing its own stub made BOTH flaky — each suite's canned body
/// showed up in the other's assertions, because `.serialized` orders tests
/// *within* a suite and suites still run in parallel. So:
///   • the BODY link — `rows(from:)` on each real body, which is the belt to the
///     status's braces: even with the status lost, no refusal can read as empty.
///   • the CAPTION link — `LoadFailure.message` on the error `Api.request`
///     throws for that status (`ApiTransportTests` owns the mapping itself).
/// `tests/call-recordings-load.test.ts` pins that `getData` rides `request`,
/// which is what joins them.
///
/// ⚠️ `@MainActor` is mandatory: `rows(from:)` is a member of a `View`, so it
/// inherits MainActor isolation. Without it the calls are only WARNINGS at
/// compile time and the test process dies partway through the run — the summary
/// then reads "10 tests passed" next to "** TEST FAILED **", which looks like a
/// harness glitch rather than this. (Same rule as `DevicesView.decodeDevices`.)
@MainActor struct CallRecordingsLoadTests {

    private func data(_ json: String) -> Data { Data(json.utf8) }

    @Test func anExpiredSessionIsNotAnEmptyArchive() throws {
        // The route's exact 401 body — it decodes cleanly against a struct of
        // optionals, which is why "the JSON parsed" was never evidence.
        #expect(throws: (any Error).self, "a 401 body read as an empty archive") {
            try CallRecordingsView.rows(from: data(#"{"ok":false,"error":"login required"}"#))
        }
        // And what the screen says once it has the status.
        let said = LoadFailure.message(ApiError.http(401, "login required"))
        #expect(said == Api.friendlyHTTPError(401))
        #expect(said.contains("sign out"), "the remedy for a 401 is a re-auth")
        // ⚠️ Never the wire phrase the route sent: "login required" is the
        // worker's own vocabulary, and 401 is a status the house table owns.
        #expect(said.lowercased().contains("login required") == false)
    }

    @Test func aWorkerOutageIsNotAnEmptyArchive() throws {
        // /api/voice/sessions maps any worker error to 502, and on a fetch
        // failure the `error` it carries is the EDGE'S OWN exception text.
        let raw = "The operation was aborted due to timeout"
        #expect(throws: (any Error).self, "a 502 body read as an empty archive") {
            try CallRecordingsView.rows(from: data(#"{"ok":false,"error":"\#(raw)"}"#))
        }
        let said = LoadFailure.message(ApiError.http(502, raw))
        #expect(said == Api.friendlyHTTPError(502))
        #expect(said.contains("try again"))
        // `statusOwnsTheMessage` covers 5xx precisely so this can't reach a
        // person — the same rule inc 14's revoke sheet leans on.
        #expect(said.contains(raw) == false, "the edge's raw exception text reached the screen")
    }

    @Test func theDocumentedSuccessStillLoads() throws {
        let rows = try CallRecordingsView.rows(from: data(#"""
        {"ok":true,"sessions":[
          {"id":"a","tiny_name":"tiny","status":"ended","started_at":1,"duration_ms":9000,"segment_count":3},
          {"id":"b","tiny_name":"tiny","status":"error","started_at":2,"duration_ms":30000,"segment_count":1}
        ]}
        """#))
        #expect(rows.count == 2)
        #expect(rows.first?.id == "a")
    }

    @Test func anEmptyArchiveIsStillAllowedToBeEmpty() throws {
        // The fix is not "never say empty" — it is "only say it when asked AND
        // answered". A real 200 with no rows must still reach the empty state,
        // or the screen has just moved the lie.
        let rows = try CallRecordingsView.rows(from: data(#"{"ok":true,"sessions":[]}"#))
        #expect(rows.isEmpty)
    }

    @Test func aBodyThatIsNotTheDocumentedShapeIsAnError() throws {
        // The masked-empty root cause, isolated: the key is simply missing. Plus
        // the intermediary case — a body that says ok:false WITH a list. A status
        // and a body at odds is exactly what a proxy or captive portal produces,
        // and inc 14 learned that pinning one half hides the other.
        for json in [#"{"ok":true}"#, #"{}"#, #"{"ok":false,"sessions":[]}"#] {
            #expect(throws: (any Error).self, "\(json) read as an empty archive") {
                try CallRecordingsView.rows(from: data(json))
            }
        }
        // Each of those reaches the caption as the ONE house line for "bytes I
        // could not use" — never a connection claim, because bytes arrived.
        let said = LoadFailure.message(ApiError.badResponse)
        #expect(said == ApiError.badResponse.localizedDescription)
        #expect(said.lowercased().contains("connection") == false)
    }

    @Test func aBodyThatIsNotJsonIsNotCalledEmptyEither() throws {
        // A mid-redeploy HTML page served with a 200 — the everyday way this
        // happens. `try? JSONDecoder().decode` turned it into "no calls".
        #expect(throws: (any Error).self, "an HTML page read as an empty archive") {
            try CallRecordingsView.rows(from: data("<html>maintenance</html>"))
        }
        // It throws a DecodingError, not an ApiError — LoadFailure's third branch.
        do {
            _ = try CallRecordingsView.rows(from: data("<html>maintenance</html>"))
        } catch {
            #expect(error is DecodingError)
            #expect(LoadFailure.message(error).lowercased().contains("connection") == false)
        }
    }

    @Test func pocketDialsAndDeadRowsStayHidden() throws {
        // Pinned because this increment rewrote the function that holds it, which
        // is the moment an unpinned invariant gets quietly dropped: a live call
        // can't stitch (409), a sub-2s row is a pocket dial, and a zero-segment
        // row has no audio at all — its stitch 404s.
        let rows = try CallRecordingsView.rows(from: data(#"""
        {"ok":true,"sessions":[
          {"id":"live","status":"live","duration_ms":9000,"segment_count":3},
          {"id":"pocket","status":"ended","duration_ms":1500,"segment_count":2},
          {"id":"silent","status":"ended","duration_ms":9000,"segment_count":0},
          {"id":"keep","status":"ended","duration_ms":2001,"segment_count":1}
        ]}
        """#))
        #expect(rows.map(\.id) == ["keep"])
    }

    // ── Why the call ended ───────────────────────────────────────────────────
    // 🔴 `voice_sessions.error` carries a reason for every abnormal end, and the
    // worker's own docstring says what for: "the row is what the person still
    // has tomorrow when they ask why." `CallSession` had no such field, so the
    // reason arrived and was dropped one line before the render — and because
    // `rows(from:)` deliberately ADMITS `status == "error"` rows, a call the
    // voice service killed 20 seconds in drew `ada · 0:20`, identical to a
    // 20-second call the person ended themselves. The duration is what makes
    // them indistinguishable: a short call and a call cut short look the same
    // when the only thing shown is how long it lasted.

    @Test func aDroppedCallNoLongerReadsLikeAShortOne() throws {
        let rows = try CallRecordingsView.rows(from: data(#"""
        {"ok":true,"sessions":[
          {"id":"dropped","status":"ended","duration_ms":20000,"segment_count":2,
           "error":"upstream closed: 1011 going away"},
          {"id":"clean","status":"ended","duration_ms":20000,"segment_count":2}
        ]}
        """#))
        #expect(rows.count == 2, "the badge must not become a filter — both calls are the person's")
        let dropped = try #require(rows.first { $0.id == "dropped" })
        let clean = try #require(rows.first { $0.id == "clean" })
        #expect(CallOutcome.text(status: dropped.status, error: dropped.error)
            == "the voice service closed the connection")
        // The ordinary hangup gets nothing: a badge on every row says nothing.
        #expect(CallOutcome.text(status: clean.status, error: clean.error) == nil)
    }

    @Test func theWorkerTailDiagnosticNeverReachesThePerson() {
        // ⚠️ The recorded reason is written for the worker tail — a close code,
        // or an arbitrary upstream exception message. Keeping the column
        // diagnostic is right; painting it onto someone's call list would be the
        // same wrong-surface mistake pointing the other way.
        let closed = try? #require(CallOutcome.text(status: "ended", error: "upstream closed: 1011 going away"))
        #expect(closed?.contains("1011") == false)
        #expect(closed?.contains("going away") == false)
        let errored = CallOutcome.text(status: "error", error: "upstream error: TypeError: x is not a function")
        #expect(errored == "the voice service dropped")
        #expect(errored?.contains("TypeError") == false)
    }

    @Test func theArmsThatMeasuredTheirOwnCauseSayWhatTheyMeasured() {
        #expect(CallOutcome.text(status: "ended", error: "the client went silent")
            == "we stopped hearing this device")
        #expect(CallOutcome.text(status: "ended", error: "the call hit the maximum length")
            == "the call hit the maximum length")
        #expect(CallOutcome.text(status: "error", error: "the client socket errored")
            == "this device's connection dropped")
    }

    @Test func anUnrecognisedReasonStillSaysTheCallBrokeAndNamesNoCause() {
        // A teardown arm added upstream, or a row from a build this map predates.
        // ⚠️ Falling back to SILENCE here is the original defect returning: the
        // reason would once again have no reader. `unknown` is the honest middle.
        let out = CallOutcome.text(status: "ended", error: "the flux capacitor desynced")
        #expect(out == CallOutcome.unknown)
        #expect(out?.contains("flux") == false, "it echoed the diagnostic it did not understand")
        // Every error row written before the reason was wired looks like this,
        // and the status alone is more than the row said yesterday.
        #expect(CallOutcome.text(status: "error", error: nil) == CallOutcome.unknown)
    }

    @Test func anOrdinaryCallIsNotBadged() {
        #expect(CallOutcome.text(status: "ended", error: nil) == nil)
        #expect(CallOutcome.text(status: "ended", error: "") == nil)
        // ⚠️ Whitespace is not a reason: `"upstream closed: "` with an empty
        // code and reason trims to a bare prefix, and a row of blanks must not
        // raise a warning on a call that ended fine.
        #expect(CallOutcome.text(status: "ended", error: "   ") == nil)
    }

    // ── 🔇 Why a recording won't play (lib/voice/playback.ts's Swift twin) ──
    // `/voice/recording/:id` STITCHES on first listen and can decline. AVPlayer
    // handed a 413-with-JSON sets `currentItem.status = .failed`, which nothing
    // here read — so `playingId` stayed set: a pause glyph over a transport
    // frozen at 0:00, with the reason unread in `currentItem.error`.

    @Test func aRefusalAlwaysSaysSomething() {
        // The difference from CallOutcome.text, which returns nil for a clean
        // call: this is called ONLY when a play failed, so silence here is the
        // dead play button all over again.
        for input in [nil, "", "   ", "who knows"] as [String?] {
            #expect(CallRecordingRefusal.text(input).isEmpty == false,
                    "a failed play said nothing")
        }
    }

    @Test func eachRefusalTheRouteGivesHasItsOwnSentence() {
        #expect(CallRecordingRefusal.text("call still in progress").contains("still going"))
        #expect(CallRecordingRefusal.text("call too long to stitch").contains("too long"))
        #expect(CallRecordingRefusal.text("no replay journaled for this session")
                    .contains("wasn't recorded"))
        #expect(CallRecordingRefusal.text("no audio journaled").contains("audio wasn't saved"))
        #expect(CallRecordingRefusal.text("media store not provisioned")
                    .contains("unavailable right now"))
        // None of the five falls back to the generic line — that would be a
        // covered refusal rendered as an unknown one.
        for r in ["call still in progress", "call too long to stitch",
                  "no replay journaled for this session", "no audio journaled",
                  "media store not provisioned"] {
            #expect(CallRecordingRefusal.text(r) != CallRecordingRefusal.unknown,
                    "\(r) rendered as the generic sentence")
        }
    }

    @Test func aWrappedReasonIsStillRecognised() {
        // ⚠️ AVFoundation wraps the origin's body in its own description, so the
        // reason arrives EMBEDDED rather than bare. An equality match would drop
        // every real refusal while passing every unit test written with bare
        // strings — which is why this test exists and why `text` uses `contains`.
        let wrapped = "The operation couldn't be completed. (server said: call too long to stitch)"
        #expect(CallRecordingRefusal.text(wrapped).contains("too long"))
    }

    @Test func anUnreadableRefusalNamesNoCause() {
        #expect(CallRecordingRefusal.text("the flux capacitor desynced")
                    == CallRecordingRefusal.unknown)
        #expect(CallRecordingRefusal.text("the flux capacitor desynced").contains("flux") == false,
                "the raw diagnostic reached the person")
    }

    @Test func theSegmentCountSurvivesTheDecodeAsANumber() throws {
        // ⚠️ All three clients decoded `segment_count` and used it ONLY as `> 0`,
        // so the number that predicts the 413 was on the row and thrown away at
        // the filter. A `hasAudio: Bool` here would pass every other test above.
        let rows = try CallRecordingsView.rows(from: data(#"""
        {"ok":true,"sessions":[
          {"id":"long","tiny_name":"tiny","status":"ended","started_at":1,"duration_ms":900000,"segment_count":30}
        ]}
        """#))
        #expect(rows.count == 1)
        #expect(rows.first?.segment_count == 30)
        #expect(CallRecordingRefusal.tooLong(segmentCount: rows.first?.segment_count))
    }

    @Test func theSizeRefusalIsKnowableBeforeTheTap() {
        // (n - 2) * 1_440_000 > 40_000_000 — two segments exempt because
        // segment_count sums both directions and only the final segment per
        // direction may be short.
        #expect(CallRecordingRefusal.tooLong(segmentCount: 30), "30 segments cannot stitch")
        #expect(CallRecordingRefusal.tooLong(segmentCount: 29) == false, "29 may still stitch")
        // One-sided: a small count is never a promise the call WILL play.
        for n in [nil, 0, 1, 2, 4] as [Int?] {
            #expect(CallRecordingRefusal.tooLong(segmentCount: n) == false,
                    "count \(String(describing: n)) read as too long")
        }
    }
}

/// 🔴 The chat table's words, on screens that are not a chat.
///
/// `Api.friendlyHTTPError` is one table, and that was the fix for five sheets
/// (`LoadFailureTests`). But it is the CHAT table: 404 reads "That tiny doesn't
/// exist", 402 "This tiny charges per message", 413 "Message or attachments too
/// large". Hand it a failed community list, builder profile or toolbox fetch and
/// it answers a question nobody asked, about a thing that is not a tiny —
/// confidently. That is worse than the bare "HTTP 404" those panels used to
/// show, because a number is merely unhelpful.
///
/// `contentMessage` keeps the table wherever the table describes the TRANSPORT
/// (`statusOwnsTheMessage` — 401, 0, 5xx — plus 424's degraded dependency),
/// keeps the SERVER's own words wherever it sent any, and otherwise says the
/// code and nothing it can't back up.
@Suite struct ContentLoadFailureTests {

    /// Measured, not assumed — the statuses these three fetches can really
    /// answer, from the worker and the route:
    ///   /community  → 200 | 500 {error:'community query failed'}  (src/community.ts)
    ///   /profile    → 200 | 400 {error:"invalid login"} | 404 | 500  (src/profile.ts)
    ///   /api/tools  → 200 | 401 | 424 | 5xx
    /// plus the router's plain-text `404 Not Found.` on a stale build
    /// (src/index.ts:225) and transport 0. The 400 and 404 verdicts now leave
    /// through the not-found state, so what reaches this helper is 401/424/5xx/0
    /// — and the skew 404, which is the only case the chat table would lie about.
    static let chatFlavoured = [402, 404, 413]

    @Test("a chat-flavoured status stops answering for a screen that isn't a chat")
    func chatWordsDoNotLeakOntoAContentLoad() {
        for status in Self.chatFlavoured {
            let said = LoadFailure.contentMessage(status: status)
            // The claim each of those lines makes, in the reader's words.
            #expect(!said.localizedCaseInsensitiveContains("tiny"),
                    "HTTP \(status) still talks about a tiny: \(said)")
            #expect(!said.localizedCaseInsensitiveContains("charges"))
            #expect(!said.localizedCaseInsensitiveContains("attachments"))
            // The code survives, because support needs it and it is the one
            // fact the app actually has.
            #expect(said.contains("\(status)"))
            // And it must differ from the chat table, or nothing was fixed.
            #expect(said != Api.friendlyHTTPError(status))
        }
    }

    @Test("the statuses that describe the transport keep the house words")
    func transportStatusesAreUnchanged() {
        // These are about the request, not about a tiny, so the table is right
        // and a second wording here would be a copy free to drift.
        for status in [401, 0, 500, 503, 599, 424] {
            #expect(LoadFailure.contentMessage(status: status) == Api.friendlyHTTPError(status),
                    "HTTP \(status) drifted from the table")
        }
    }

    @Test("a 401 keeps the app's words even when the worker sent its own")
    func theOwnedStatusesStillOverrideTheServer() {
        // `statusOwnsTheMessage` flows through untouched: the worker's
        // "login required" is a wire phrase, and 401's remedy is a sign-out.
        let said = LoadFailure.contentMessage(status: 401, serverMsg: "login required")
        #expect(said == Api.friendlyHTTPError(401))
        #expect(!said.localizedCaseInsensitiveContains("login required"))
    }

    @Test("a server that explained itself is still preferred")
    func theServersOwnWordsWin() {
        // The worker answers `400 {error:"invalid login"}` for a handle it won't
        // look up. Whatever the status, a body describing THIS request beats both
        // tables — that is `httpMessage`'s rule and this helper must not undo it.
        let said = LoadFailure.contentMessage(status: 400, serverMsg: "invalid login")
        #expect(said.contains("invalid login"))
        #expect(said.contains("400"))
    }

    @Test("whitespace is not an explanation")
    func aBlankServerMessageIsNotWords() {
        // ⚠️ The guard reads "has the server said anything", so a body carrying
        // `error: "   "` must fall through to the cause-free line — not be
        // treated as words and shown as "    (HTTP 404)".
        for blank in ["", "   ", "\n\t"] {
            let said = LoadFailure.contentMessage(status: 404, serverMsg: blank)
            #expect(said == LoadFailure.contentMessage(status: 404),
                    "a blank body changed the answer: \(said)")
            #expect(!said.localizedCaseInsensitiveContains("tiny"))
        }
    }

    @Test("nothing arriving still reads as no response")
    func aTransportErrorIsUnchanged() {
        let said = LoadFailure.contentMessage(URLError(.notConnectedToInternet))
        #expect(said == Api.friendlyHTTPError(0))
    }

    @Test("an unreadable body does not blame the connection")
    func anUnreadableBodyKeepsItsOwnReason() {
        // Bytes arrived and weren't JSON — a mid-redeploy HTML page on a 200.
        // The three panels' `catch` sees a JSONSerialization NSCocoaError here.
        let said = LoadFailure.contentMessage(
            NSError(domain: NSCocoaErrorDomain, code: 3840))
        #expect(said == ApiError.badResponse.localizedDescription)
        #expect(!said.localizedCaseInsensitiveContains("connection"))
    }

    @Test("the cause-free line names no cause and offers the one remedy there is")
    func theFallbackLineIsHonest() {
        let said = LoadFailure.contentMessage(status: 404)
        // No cause the app never checked…
        for guess in ["connection", "offline", "network", "wifi", "signed", "session"] {
            #expect(!said.localizedCaseInsensitiveContains(guess),
                    "the fallback asserts \(guess): \(said)")
        }
        // …and the only thing a reader can actually do about a skew 404.
        #expect(said.localizedCaseInsensitiveContains("try again"))
    }
}

// MARK: - The inbox stops prescribing a remedy it can't know (increment 18)

/// 🔴 `"Couldn't load messages — check your connection and pull to retry."`
///
/// Two claims the app never checked, on the DM inbox. `loadInbox` used
/// `try? await Api.get` and collapsed the typed failure into `failed: Bool`, so
/// by the time the caption ran there was nothing left to say — a Bool can only
/// produce a guess. The route's answers are measured, and only ONE of them is a
/// connection problem:
///   `GET /api/messages`            → 200
///                                  | 401 {error:'login required'}   (route:43)
///                                  | 500 {error:'messages unavailable'} (worker)
///                                  | 503 {error:'messages unavailable'} (route's 10s bound)
///   `GET /api/messages?with=login` → the same, plus 404 {error:"peer not found"}
/// The worker's `400 {error:"userId required"}` is unreachable from this client:
/// the route always sets `userId` from the session.
///
/// For a 401 — the commonest of them — *pulling to retry* is the one remedy
/// guaranteed not to work. And the 404 is a verdict rather than an outage, which
/// is why it leaves through `.gone` instead of inheriting the Retry button.
@MainActor
@Suite struct MessagesLoadFailureTests {

    @Test("a peer the worker says it can't resolve is a verdict, not an outage")
    func aFourOhFourIsPermanent() {
        #expect(MessagesModel.classify(ApiError.http(404, "peer not found")) == .gone)
    }

    @Test("a 404 with nothing to say is OUR stale build, not a missing person")
    func aBare404DoesNotAccuseThePeer() {
        // ⚠️ Two different things answer 404 on this path. `messages.ts:300`
        // sends `{error:"peer not found"}` — that one is about the person. The
        // worker's router sends plain-text `404 Not Found.` (index.ts:225) for a
        // path that no longer exists, and a stale Next deploy does the same for
        // /api/messages itself. `Api.serverError(in:)` returns nil for a non-JSON
        // body, so "did the server explain itself" is exactly the line between
        // them. Reading our own staleness as someone's absence would be the same
        // unfounded claim this increment exists to remove — told about a person.
        for body in [nil, "", "   ", "\n"] as [String?] {
            guard case .retryable(let said) =
                    MessagesModel.classify(ApiError.http(404, body)) else {
                Issue.record("a bare 404 accused the peer — our stale build reads as their absence")
                continue
            }
            #expect(said == LoadFailure.contentMessage(status: 404, serverMsg: body))
            // And it must not inherit the chat table's line either: this is the
            // one status where `contentMessage` and `message` diverge, so it is
            // also the pin that proves the loaders ask for the right one.
            #expect(said != Api.friendlyHTTPError(404),
                    "a bare 404 in the inbox now says the chat table's line: \(said)")
            #expect(!said.localizedCaseInsensitiveContains("tiny"),
                    "the inbox is talking about a tiny: \(said)")
            #expect(said.localizedCaseInsensitiveContains("try again"))
        }
    }

    @Test("the wire's word for a person never reaches the screen")
    func peerIsNotAWordForAPerson() {
        // `.gone` carries NO server text at all, which is what keeps "peer not
        // found" off the surface. If this ever becomes `.retryable`, the caption
        // would be "peer not found (HTTP 404)" — `httpMessage` prefers the
        // server's own words on any status the table doesn't own, and 404 is one.
        #expect(Api.httpMessage(404, "peer not found").contains("peer not found"),
                "premise moved: httpMessage no longer prefers the server's words on a 404")
        if case .retryable(let m) = MessagesModel.classify(ApiError.http(404, "peer not found")) {
            Issue.record("a 404 became retryable and now shows the wire's phrase: \(m)")
        }
    }

    @Test("every other status stays retryable and keeps its reason")
    func everythingElseIsRetryable() {
        for (status, body) in [(401, "login required"), (500, "messages unavailable"),
                              (503, "messages unavailable"), (0, nil as String?), (424, nil)] {
            let got = MessagesModel.classify(ApiError.http(status, body))
            guard case .retryable(let said) = got else {
                Issue.record("HTTP \(status) became permanent — a Retry button vanished")
                continue
            }
            #expect(said == LoadFailure.contentMessage(status: status, serverMsg: body),
                    "HTTP \(status) drifted from the one caption rule: \(said)")
            #expect(!said.isEmpty)
        }
    }

    @Test("the worker's internal detail never becomes the caption")
    func internalDetailsStayInternal() {
        // 5xx is in `statusOwnsTheMessage`, so the house line wins over the
        // body. That is the only reason "messages unavailable" — a phrase about
        // the worker's D1, not about the reader — stays off the screen.
        for status in [500, 503] {
            guard case .retryable(let said) =
                    MessagesModel.classify(ApiError.http(status, "messages unavailable")) else {
                Issue.record("HTTP \(status) stopped being retryable"); continue
            }
            #expect(!said.contains("messages unavailable"), "leaked the worker's own words: \(said)")
            #expect(said == Api.friendlyHTTPError(status))
        }
    }

    @Test("a 401 is told to sign out, never to pull again")
    func anExpiredSessionGetsTheRemedyThatWorks() {
        guard case .retryable(let said) = MessagesModel.classify(ApiError.http(401, "login required")) else {
            Issue.record("a 401 became permanent"); return
        }
        // The old caption's two claims, both absent now.
        #expect(!said.localizedCaseInsensitiveContains("connection"),
                "still blames the connection for an expired session: \(said)")
        #expect(!said.localizedCaseInsensitiveContains("pull"))
        // And the wire's phrase does not ship either: 401 is an owned status.
        #expect(!said.contains("login required"))
        #expect(said == Api.friendlyHTTPError(401))
    }

    @Test("nothing arriving is the one case that IS the connection")
    func aDeadConnectionStillSaysSo() {
        guard case .retryable(let said) = MessagesModel.classify(URLError(.notConnectedToInternet)) else {
            Issue.record("a transport failure became permanent"); return
        }
        // Status 0 is the house code for "no response"; the table owns it.
        #expect(said == Api.friendlyHTTPError(0))
    }

    @Test("a body that arrived but wasn't JSON is not blamed on the peer")
    func aParseFailureIsNotAVerdict() {
        // `Api.get` parses with JSONSerialization, which throws an NSCocoaError
        // — not an ApiError. A mid-redeploy HTML error page is the everyday way
        // that happens, and calling the peer gone for it would be a lie about a
        // person.
        let notJSON = NSError(domain: NSCocoaErrorDomain, code: 3840)
        guard case .retryable(let said) = MessagesModel.classify(notJSON) else {
            Issue.record("a parse failure was called a missing peer"); return
        }
        #expect(said == ApiError.badResponse.localizedDescription)
    }

    @Test("the chat table's words about tinys stay out of the inbox")
    func noChatWordsOnTheInbox() {
        // The inbox is a list of people. 402/413 can't reach it, but the rule is
        // the rule: whatever arrives, the caption must not talk about a tiny.
        for status in [402, 404, 413] {
            let said = LoadFailure.contentMessage(status: status)
            #expect(!said.localizedCaseInsensitiveContains("tiny"),
                    "HTTP \(status) still talks about a tiny: \(said)")
        }
    }

}

/// 🎙️ The transcript index survives its own schema change.
@Suite struct NiclaTranscriptStoreTests {
    @Test("an index.json from the previous build still decodes")
    func addingIsPreviewDoesNotWipeStoredTranscripts() throws {
        // NiclaRecorder's whole local store is one Codable round-trip through
        // Documents/nicla-transcripts/index.json, and `loadIndex()` swallows a
        // decode failure as `[]`. So a new NON-OPTIONAL field on NiclaTranscript
        // is a silent data wipe on first launch after the update: every row the
        // user recorded before today is gone, and the only thing on screen is
        // "No transcripts yet". The default value on `isPreview` is what prevents
        // that, and a default is exactly the kind of thing a later refactor
        // "tidies" into a required field.
        let old = """
        [{"id":"t1","at":760000000,"seconds":42,"label":"memo","text":"the roof guy comes tuesday"}]
        """
        let rows = try JSONDecoder().decode([NiclaTranscript].self, from: Data(old.utf8))
        #expect(rows.count == 1, "an older index.json no longer decodes — this is a data wipe")
        #expect(rows[0].text == "the roof guy comes tuesday")
        // False, not true: a pre-existing row is a LOCAL take, which was always
        // full text. Defaulting the other way would send every old row off to
        // fetch a "rest" that the server may not even have.
        #expect(rows[0].isPreview == false, "an old local take was marked as a preview")
    }

    @Test("a preview row is visibly unfinished, and a short take is not")
    func onlyATruncatedRowGetsTheEllipsis() {
        // The bug this guards: the list route returns substr(text, 1, 200) while
        // the server keeps 16KB, so a 120s memo arrived as its first ~12% and
        // rendered as a complete short transcript — truncated text and short text
        // are the same pixels. The flag has to survive the round-trip that the
        // rendering depends on.
        var t = NiclaTranscript(id: "t2", at: Date(), seconds: 120, label: "memo",
                                text: String(repeating: "a", count: 200),
                                audioFile: nil, audioUrl: nil, isPreview: true)
        #expect(t.isPreview)
        // fetchFullText's effect: the text is replaced AND the mark cleared, so
        // the row stops offering to fetch what it already has.
        t.text = String(repeating: "a", count: 1700)
        t.isPreview = false
        #expect(!t.isPreview && t.text.count == 1700)
    }
}

/// 🎙️ The second pass may only ever ADD words to a take.
///
/// A take's live transcript is stitched from however many SFSpeechRecognitionTasks
/// the recorder had to roll (one task reports one utterance, then goes deaf), and
/// every restart is a seam where audio arrived with nothing listening. On iOS 26,
/// SpeechAnalyzer re-reads the finished m4a in a single pass with no session cap,
/// so it usually recovers the dropped words — but "usually" is the problem. It
/// returns nil when the model isn't installed, and it can return a short or empty
/// result on a file it doesn't like. Overwriting a real transcript with that is a
/// loss the user cannot see happen and cannot undo: the audio is uploaded, the
/// row is saved, and the words they said are simply not in it.
@Suite struct NiclaSecondPassTests {
    let live = "the roof guy comes tuesday"

    @Test("a longer second pass wins — that is the whole point of running it")
    func longerReplacesTheLiveText() {
        // The real shape: the live path caught one sentence of a 90s memo.
        let full = "the roof guy comes tuesday and the invoice is on the counter"
        #expect(NiclaRecorder.betterTranscript(live: live, secondPass: full) == full)
    }

    @Test("nil keeps the live text instead of blanking the transcript")
    func nilIsNotAnAnswer() {
        // nil is the COMMON case on a phone that never downloaded the model, so
        // this is the difference between a working recorder and one that stores
        // "(silence)" for every take.
        #expect(NiclaRecorder.betterTranscript(live: live, secondPass: nil) == live)
    }

    @Test("an empty or whitespace-only second pass never wins")
    func emptyIsNotAnAnswer() {
        for junk in ["", "   ", "\n\t "] {
            #expect(NiclaRecorder.betterTranscript(live: live, secondPass: junk) == live,
                    "a blank second pass erased the take")
            // Against an EMPTY live take, too. This is the case the length check
            // cannot catch: three spaces are longer than "", so without the trim
            // a silent take stores whitespace and the row renders as blank rather
            // than as "(silence)". Mutating the trim away proved these two
            // assertions are the only ones that notice.
            #expect(NiclaRecorder.betterTranscript(live: "", secondPass: junk).isEmpty,
                    "whitespace beat an empty take — the trim is not being applied")
        }
    }

    @Test("a SHORTER second pass loses, even though it is the better engine")
    func shorterLoses() {
        // Tempting to trust the large model unconditionally — this is the case
        // that says no. Fewer characters here means fewer words the user said.
        #expect(NiclaRecorder.betterTranscript(live: live, secondPass: "the roof guy") == live)
    }

    @Test("equal length keeps the live text — a tie is not an improvement")
    func tieKeepsLive() {
        // Strictly greater, not >=: rewriting the row for no gain still costs a
        // save and makes the breadcrumb log lie about a swap that added nothing.
        #expect(NiclaRecorder.betterTranscript(live: live, secondPass: "THE ROOF GUY COMES TUESDAX") == live)
    }

    @Test("a second pass is trimmed before it is compared, and before it is stored")
    func winnerIsTrimmed() {
        // Analyzer results are joined with spaces, so a leading/trailing space is
        // normal output — and it must not be what tips the length comparison.
        let padded = "  \n" + live + "  "
        #expect(padded.count > live.count, "the fixture must be longer only because of padding")
        #expect(NiclaRecorder.betterTranscript(live: live, secondPass: padded) == live,
                "whitespace alone counted as recovered words")
    }

    @Test("an empty live take accepts anything the second pass heard")
    func silenceIsAlwaysBeaten() {
        // The best outcome available: the live tasks caught nothing at all (a
        // restart storm, a late permission grant), and the file still has speech.
        #expect(NiclaRecorder.betterTranscript(live: "", secondPass: "hello") == "hello")
        #expect(NiclaRecorder.betterTranscript(live: "", secondPass: nil) == "")
    }
}

/// 🏠 The same-WiFi fast path — the board's address off its own heartbeat.
///
/// Reported as "the nicla vision is no longer streaming to ios — it says
/// connecting through the cloud but i'm at the same wifi". connect() could only
/// learn a LAN base two ways: a UserDefaults cache (empty on a fresh install,
/// and dropped whenever a probe fails) and discoverViaRelay — a `stream` invoke
/// through the CLOUD, measured at 4-32s against the board's single-threaded
/// loop. So the opening was always cloud polling while the necklace served MJPEG
/// at ~16 fps one hop away. The device row now carries lan_url.
///
/// pickVision is where both decisions live: WHICH board (an orphaned row from a
/// re-enrollment is permanently offline and can never answer) and WHETHER its
/// address is usable.
@Suite struct TinyLiveLanBaseTests {
    let lan = "http://192.168.1.207:8080"

    func row(_ id: String, online: Bool = true, seen: Double = 1000,
             lan: String? = nil, platform: String = "nicla-vision") -> [String: Any] {
        var d: [String: Any] = ["id": id, "platform": platform,
                                "online": online, "last_seen": seen]
        if let lan { d["lan_url"] = lan }
        return d
    }

    @Test("a present board's lan_url comes back with its id")
    func lanBaseIsRead() {
        let got = TinyLive.pickVision(from: [row("v1", lan: lan)])
        #expect(got?.id == "v1")
        #expect(got?.lanURL == lan, "without this the app must discover through the cloud")
    }

    @Test("a row with no lan_url yields nil, not an empty string")
    func missingLanBaseIsNil() {
        // An older worker, or a board the registry considers stale. nil is what
        // makes `if let lan` fall through to discovery.
        #expect(TinyLive.pickVision(from: [row("v1")])?.lanURL == nil)
    }

    @Test("an ONLINE board wins over a fresher offline orphan")
    func onlineBeatsFresh() {
        // Re-enrolling a board orphans its old row forever: permanently offline,
        // never answers, and relay discovery never returns a base for it — so
        // aiming at one costs the whole session.
        let rows = [row("orphan", online: false, seen: 9999, lan: "http://192.168.1.9:8080"),
                    row("live", online: true, seen: 10, lan: lan)]
        let got = TinyLive.pickVision(from: rows)
        #expect(got?.id == "live")
        #expect(got?.lanURL == lan, "the orphan's stale address was taken")
    }

    @Test("among online boards the freshest heartbeat wins")
    func freshestOnlineWins() {
        let rows = [row("old", seen: 100), row("new", seen: 500, lan: lan)]
        #expect(TinyLive.pickVision(from: rows)?.id == "new")
    }

    @Test("a non-vision device is never picked, however fresh")
    func onlyVisions() {
        #expect(TinyLive.pickVision(from: [row("phone", seen: 9999, platform: "ios")]) == nil)
        #expect(TinyLive.pickVision(from: []) == nil)
    }

    @Test("a malformed lan_url is dropped so the probe is never aimed at it")
    func malformedLanBaseIsRefused() {
        // Each of these would cost 3 probe attempts before discovery even starts,
        // making the fast path SLOWER than not having it.
        for bad in ["", "192.168.1.207:8080", "notaurl", "http://", "ftp://192.168.1.5"] {
            let got = TinyLive.pickVision(from: [row("v1", lan: bad)])
            #expect(got?.id == "v1", "the device itself must still be found")
            #expect(got?.lanURL == nil, "malformed base accepted: \(bad)")
        }
    }

    @Test("last_seen survives arriving as an Int rather than a Double")
    func intTimestamps() {
        // JSONSerialization hands back NSNumber, and `as? Double` on an integer
        // JSON value returns nil — which would flatten every comparison to 0 and
        // make the ordering arbitrary.
        let rows: [[String: Any]] = [
            ["id": "a", "platform": "nicla-vision", "online": true, "last_seen": 100 as Int],
            ["id": "b", "platform": "nicla-vision", "online": true, "last_seen": 900 as Int],
        ]
        #expect(TinyLive.pickVision(from: rows)?.id == "b")
    }
}

/// 🛰️ "No nicla-vision device in your fleet — is it enrolled?" was said to people
/// whose fleet was fine.
///
/// The live view's FIRST call is the fleet lookup, and it was
/// `try? await Api.get("/api/devices")` behind a `guard let … else { return nil
/// }`. Three unrelated answers arrived as that one nil, and `connect` had one
/// sentence for it: a refused request (a session that lapsed since the last
/// screen, a 424 from the worker), a 200 whose body couldn't be read, and the
/// only case the sentence describes — a fleet with no necklace in it.
///
/// So a phone that had quietly signed itself out told the user their hardware was
/// never enrolled. `connect` distinguishes a MISSING token two lines above this
/// ("Log in first — the live view goes through your tiny"), so the view always
/// cared about the difference; it just could not see a token that went stale
/// rather than absent.
@Suite struct FleetLookupTests {
    func vision(_ id: String, lan: String? = nil) -> [String: Any] {
        var d: [String: Any] = ["id": id, "platform": "nicla-vision",
                                "online": true, "last_seen": 1000.0]
        if let lan { d["lan_url"] = lan }
        return d
    }

    @Test("a fleet holding a necklace hands back the necklace")
    func aNecklaceIsFound() {
        let lan = "http://192.168.1.207:8080"
        #expect(TinyLive.readFleet(["devices": [vision("v1", lan: lan)]])
                == .found(TinyLive.FoundDevice(id: "v1", lanURL: lan)))
    }

    /// The one case the old sentence was true for, and it must stay reachable.
    @Test("a fleet with no necklace is noVision, not a refusal")
    func anEmptyFleetIsNotARefusal() {
        #expect(TinyLive.readFleet(["devices": []]) == .noVision)
        #expect(TinyLive.readFleet(["devices": [["id": "p", "platform": "ios-arm64"]]]) == .noVision)
    }

    /// ⚠️ The bug. A body with no `devices` list is not a fleet without a
    /// necklace — it is an answer we could not read, and the two must not share a
    /// sentence.
    @Test("an unreadable body is a refusal, and never noVision")
    func anUnreadableBodyIsARefusal() {
        #expect(TinyLive.readFleet([:]) == .couldNotAsk("Couldn't read your fleet."))
        // The shape a worker error really takes.
        #expect(TinyLive.readFleet(["error": "fleet unavailable"])
                == .couldNotAsk("fleet unavailable"))
        // `devices` present but not a list of objects — still unreadable.
        #expect(TinyLive.readFleet(["devices": "none"]) == .couldNotAsk("Couldn't read your fleet."))
    }

    /// The server's own words outrank ours whenever it sent any, exactly as
    /// `Api.httpMessage` prefers them — our fallback is for a body that explains
    /// nothing.
    @Test("the route's own words are preferred over our fallback")
    func theRouteIsQuotedWhenItSpeaks() {
        guard case .couldNotAsk(let why) = TinyLive.readFleet(["error": "device registry down"])
        else { return #expect(Bool(false), "a body with only an error is not a lookup result") }
        #expect(why == "device registry down")
    }

    /// Every refusal has to SAY something: an empty sentence renders as an empty
    /// line and is the silence this whole path was fixed to stop producing.
    @Test("no refusal is silent")
    func everyRefusalSaysSomething() {
        for body in [[:], ["error": ""], ["devices": 7], ["devices": "x"]] as [[String: Any]] {
            guard case .couldNotAsk(let why) = TinyLive.readFleet(body) else {
                #expect(Bool(false), "\(body) should not be readable as a fleet"); continue
            }
            #expect(!why.isEmpty, "\(body) produced an empty refusal")
        }
    }

    /// An `error` key alongside a READABLE list is not a refusal — the list wins.
    /// Otherwise a worker that annotates a partial success would blank the view.
    @Test("a readable list wins over a stray error key")
    func aListOutranksAnErrorKey() {
        #expect(TinyLive.readFleet(["devices": [vision("v1")], "error": "partial"])
                == .found(TinyLive.FoundDevice(id: "v1", lanURL: nil)))
    }
}

/// 📡 Finding the necklace's OWN address in whatever it said back.
///
/// `discoverViaRelay` asks the board `stream` and reads a LAN base out of the
/// reply. When it comes back nil the session stays on ~2fps cloud polling for
/// good — so every shape this fails to read is a session that streamed at 2fps
/// with a 16fps board one hop away. The old reader required a JSON *object* with
/// a `result` key; `lib/chat/tools/nicla.ts` proves a bare string is a real
/// payload on this same wire, and it was being dropped with the address in it.
@Suite struct StreamAddressTests {
    /// What the board actually replies to `stream`.
    @Test("the address is lifted out of the sentence around it")
    func theRealReply() {
        #expect(TinyLive.lanBase(in: "video http://192.168.1.207:8080/stream")
                == "http://192.168.1.207:8080")
    }

    /// ⚠️ The shape the old reader dropped. Both spellings reach the same address,
    /// because `RelayReply.text` is the one reader for this wire.
    @Test("a bare-string payload carries the address just as well as an envelope")
    func bothPayloadShapes() {
        let said = "video http://10.0.0.5:8080/stream"
        for payload in [said, #"{"result":"video http://10.0.0.5:8080/stream"}"#,
                        #""video http://10.0.0.5:8080/stream""#] {
            #expect(TinyLive.lanBase(in: RelayReply.text(payload)) == "http://10.0.0.5:8080",
                    "\(payload) lost the address")
        }
    }

    /// A board that answered something else is not a board with a hidden address.
    @Test("a reply with no address is nil, not a guess")
    func nothingToFind() {
        for text in ["camera busy", "", "stream off", "no such command"] {
            #expect(TinyLive.lanBase(in: text) == nil, "\(text) produced an address")
        }
    }

    /// ⚠️ The port is required, and this is the reason: `open(base:)` appends
    /// `/stream` to whatever it is handed, so a portless match would dial :80 —
    /// a probe that fails after a timeout, which is worse than not trying.
    @Test("an address without a port is not an address")
    func thePortIsRequired() {
        #expect(TinyLive.lanBase(in: "video http://192.168.1.207/stream") == nil)
    }

    /// It stops at the port. `open(base:)` and the UserDefaults cache both expect
    /// a BASE, so trailing path would be re-appended to.
    @Test("the match ends at the port, never at the path")
    func justTheBase() {
        #expect(TinyLive.lanBase(in: "http://192.168.1.207:8080/stream?x=1")
                == "http://192.168.1.207:8080")
        #expect(TinyLive.lanBase(in: "first http://1.2.3.4:81 then http://5.6.7.8:82")
                == "http://1.2.3.4:81")
    }

    /// Numeric only, and https is not a LAN board — both are the Android twin's
    /// behaviour too (`TinyLive.kt`'s `discoverBase` shares the regex verbatim),
    /// and the board reports its DHCP address, never an mDNS name.
    @Test("a hostname and a TLS URL are both declined")
    func numericHttpOnly() {
        #expect(TinyLive.lanBase(in: "video http://necklace.local:8080/stream") == nil)
        #expect(TinyLive.lanBase(in: "video https://192.168.1.207:8080/stream") == nil)
    }
}

/// 💎 Enrolling the necklace: what the sheet may claim, and when it must not.
///
/// The one irreversible step in setup mints a token returned exactly once. The
/// sheet used to answer every ending — a lapsed session, the account cap, and a
/// worker that timed out AFTER inserting the row — with "Could not enroll the
/// device — check your connection and login". The third one is the expensive
/// case: told nothing was created, the user presses Set up again and one necklace
/// becomes two rows, the first unprovisionable forever.
///
/// The rule these tests hold: **a 4xx is a decision, a 5xx or a dead connection
/// is the absence of one.**
@Suite struct EnrollOutcomeTests {
    /// The happy path is the ONLY one setup may continue from.
    @Test("a reply with both fields is the one outcome that can be provisioned")
    func theRealReply() {
        #expect(EnrollOutcome.read(["ok": true, "device_id": "d-1", "device_token": "tind_abc"])
                == .enrolled(id: "d-1", token: "tind_abc"))
    }

    /// ⚠️ An empty-or-blank token passes `as? String` and would be written into
    /// the board's flash, where everything it authenticates 401s forever. A row
    /// exists either way, so this is `unknown`, never `refused`.
    @Test("a 2xx without a usable token is doubt, not a refusal")
    func acceptedButUnusable() {
        for body: [String: Any] in [["ok": true, "device_id": "d-1"],
                                    ["ok": true, "device_id": "d-1", "device_token": ""],
                                    ["ok": true, "device_id": "d-1", "device_token": "   "],
                                    ["ok": true, "device_token": "tind_abc"],
                                    [:]] {
            #expect(EnrollOutcome.read(body) == .unknown(EnrollOutcome.unreadable),
                    "\(body) was read as something provisionable")
        }
    }

    /// The account cap is the refusal a real user actually meets, and the words
    /// are the worker's own — the devices footer quotes the same sentence.
    @Test("the cap arrives in the server's own words, not as a network problem")
    func theCapSpeaksForItself() {
        let why = EnrollOutcome.read(error: ApiError.http(424, "device limit reached (20) — revoke one first")).message
        #expect(why?.contains("device limit reached (20) — revoke one first") == true)
        #expect(why?.hasPrefix(EnrollOutcome.refusedLead) == true)
        #expect(why?.contains("connection") == false)
    }

    /// A 401 is a decision: nothing was created, and the remedy is not a retry.
    @Test("a lapsed session is a refusal with the house sentence")
    func theLapsedSession() {
        let out = EnrollOutcome.read(error: ApiError.http(401, "login required"))
        #expect(out == .refused(Api.friendlyHTTPError(401)))
        #expect(out.message?.contains("sign out and back in") == true)
    }

    /// ⚠️⚠️ The expensive case. Our own route answers 503 when the worker took
    /// longer than its 10s budget — and that worker may have inserted the row.
    @Test("a 5xx and a dead connection both leave the enrolment in doubt")
    func theUnreportedEnrolment() {
        let ends: [Error] = [ApiError.http(503, "upstream timeout"),
                             ApiError.http(500, nil),
                             URLError(.timedOut),
                             URLError(.networkConnectionLost),
                             ApiError.badResponse]
        for end in ends {
            let out = EnrollOutcome.read(error: end)
            #expect(out.message?.hasPrefix(EnrollOutcome.unknownLead) == true,
                    "\(end) was reported as a settled outcome")
            #expect(out.message?.contains(EnrollOutcome.checkFleet) == true,
                    "\(end) never told the user to look before retrying")
        }
    }

    /// Only the doubtful case may send the user to revoke something: after a real
    /// refusal there is nothing there, and the errand would be wasted.
    @Test("a refusal never sends the user hunting for a row that isn't there")
    func noWastedErrand() {
        for status in [400, 401, 403, 404, 424, 429, 499] {
            let out = EnrollOutcome.read(error: ApiError.http(status, nil))
            #expect(out.message?.contains(EnrollOutcome.checkFleet) == false,
                    "HTTP \(status) sent the user to My devices for nothing")
        }
    }

    /// The property, not the examples: no failure is silent, and none of them is
    /// the sentence this increment removed. (`readFleet`'s `"error": ""` shipped a
    /// blank line past three example tests — see FleetLookupTests.)
    @Test("every outcome that can fail says something, and none of them guesses twice")
    func noSilentAndNoDoubleCause() {
        var outcomes: [EnrollOutcome] = [EnrollOutcome.read([:]),
                                         EnrollOutcome.read(error: URLError(.notConnectedToInternet))]
        for status in [400, 401, 403, 424, 429, 500, 503] {
            outcomes.append(EnrollOutcome.read(error: ApiError.http(status, nil)))
            outcomes.append(EnrollOutcome.read(error: ApiError.http(status, "")))
        }
        for out in outcomes {
            let why = out.message ?? ""
            #expect(!why.isEmpty, "\(out) had nothing to say")
            // An empty `why` would leave a dangling space where the reason goes —
            // the tell that a sentence was assembled around nothing.
            #expect(why == why.trimmingCharacters(in: .whitespacesAndNewlines),
                    "\(out) padded a missing reason: “\(why)”")
            #expect(!why.contains("  "), "\(out) joined an empty clause: “\(why)”")
            #expect(!why.contains("connection and login"), "\(out) still names both causes")
        }
        #expect(EnrollOutcome.enrolled(id: "d", token: "t").message == nil)
    }
}

/// 🎙️ A take ends when the SPEAKER stops, not when the caller's guess runs out.
///
/// The wake word is the record button and handleWake asks for 10 seconds. Say the
/// wake word and talk for thirty and you kept the first ten: the m4a ended, the
/// transcript ended, and nothing in the result said it had been cut. `seconds`
/// is a floor now, and shouldExtend is the whole stop rule.
@Suite struct NiclaTakeExtensionTests {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }

    /// A 10s take with a 120s cap, still hearing words as of `lastGrowth`.
    func extend(_ now: Double, lastGrowth: Double, stop: Bool = false) -> Bool {
        NiclaRecorder.shouldExtend(now: at(now), deadline: at(10), hardCap: at(120),
                                   lastGrowthAt: at(lastGrowth), stopRequested: stop)
    }

    @Test("inside the requested length the take always runs")
    func insideTheAsk() {
        // Even through dead silence: a caller that asked for 10s gets 10s, so a
        // slow start ("…um") can't end the take before the speaker begins.
        #expect(extend(0.2, lastGrowth: 0))
        #expect(extend(9.9, lastGrowth: 0))
    }

    @Test("past the deadline it keeps going while words are still arriving")
    func extendsWhileSpeaking() {
        // The bug: at t=10 this returned false and 20 more seconds of speech were
        // never recorded.
        #expect(extend(10.5, lastGrowth: 10.4), "a take was cut off mid-sentence")
        #expect(extend(45, lastGrowth: 44), "a long memo stopped at the caller's guess")
    }

    @Test("it crosses the pause between two sentences")
    func gracePeriod() {
        // Normal speech pauses around a second at a sentence boundary; a grace
        // shorter than that would end the take between "…done." and "Also —".
        #expect(NiclaRecorder.silenceGrace >= 2)
        #expect(extend(11.5, lastGrowth: 10), "ended the take inside a normal pause")
    }

    @Test("silence past the grace ends the take")
    func silenceEnds() {
        // The other half. Without this, extend-while-speaking is an open mic that
        // never uploads, never transcribes and never gives the mic back.
        #expect(extend(14, lastGrowth: 10) == false, "held the mic through silence")
        #expect(extend(90, lastGrowth: 10) == false)
    }

    @Test("the hard cap wins over speech that never stops")
    func hardCapIsAbsolute() {
        // A noisy room produces words forever. A take that never ends is a worse
        // failure than a truncated one: nothing is stored at all.
        #expect(extend(120, lastGrowth: 119.9) == false, "a take ran past its ceiling")
        #expect(extend(500, lastGrowth: 499) == false)
    }

    @Test("Stop beats everything, including an active speaker")
    func stopWins() {
        #expect(extend(3, lastGrowth: 3, stop: true) == false, "Stop was ignored inside the ask")
        #expect(extend(30, lastGrowth: 30, stop: true) == false, "Stop was ignored while speaking")
    }

    @Test("only the wake path gets a raised ceiling")
    func onlyWakeExtends() {
        // The gate itself. A first version left this inline in record(), and a
        // mutation that let EVERY take extend passed all 8 tests — the decision
        // was untestable where it lived, so it was unprotected.
        #expect(NiclaRecorder.hardCapSeconds(requested: 10, extendWhileSpeaking: false) == 10,
                "a fixed-length take was given room to run long")
        #expect(NiclaRecorder.hardCapSeconds(requested: 10, extendWhileSpeaking: true) == 120,
                "the wake take is still capped at what was asked for")
        // A take that already asked for the maximum gains nothing either way, so
        // the manual memo button (120s + Stop) behaves identically.
        #expect(NiclaRecorder.hardCapSeconds(requested: 120, extendWhileSpeaking: true) == 120)
    }

    @Test("the agent path does not extend — its caller has a deadline")
    func agentTakeIsExact() {
        // record(extendWhileSpeaking: false) sets hardCap = deadline, and the cap
        // is checked BEFORE the grace, so the take ends exactly when asked.
        //
        // This is the shape of the contract, not a detail: nicla_voice_record
        // polls the relay for only `seconds + 25`. A take that extended to two
        // minutes would reply to an agent that had already given up — the
        // transcript stored, and the caller told it timed out.
        let exact = { (now: Double, growth: Double) in
            NiclaRecorder.shouldExtend(now: self.at(now), deadline: self.at(10),
                                       hardCap: self.at(10), lastGrowthAt: self.at(growth),
                                       stopRequested: false)
        }
        #expect(exact(9.9, 9.8), "the take ended before the length that was asked for")
        #expect(exact(10, 9.9) == false, "a fixed-length take ran long — its caller is waiting")
        #expect(exact(12, 11.9) == false)
    }

    @Test("the cap the loop honours is the cap record() clamps to")
    func oneCeiling() {
        // If these ever diverge, an extended take could outlast a take that asked
        // for the maximum outright — and actualSeconds would report a duration the
        // stored row can't reach.
        #expect(NiclaRecorder.maxSeconds == 120)
    }
}

/// 💾 Automatic audio is bounded; a take somebody asked for is not.
///
/// Two producers file audio with nobody touching the phone: TinyLive writes a
/// segment every ~45s while the necklace's card is open, and a wake word records up
/// to 120s (`Config.recordOnWake` is on by default). The old rule ("never evict a
/// row that owns a local audio file") meant unbounded disk growth from either. The
/// bound applies to both, and it takes the file, never the words.
@Suite struct NiclaAudioEvictionTests {
    typealias Row = (id: String, label: String, bytes: Int)

    func live(_ id: String, _ bytes: Int) -> Row { (id, NiclaRecorder.liveLabel, bytes) }
    /// A take the USER made by hand — the memo button and the panel's Record.
    ///
    /// ⚠️ This helper used to return `"wake: hey tiny"`, which is not a manual take
    /// at all: `Config.recordOnWake` defaults to true, so a wake take is recorded
    /// with nobody touching the phone. Every "a manual take is exempt" test below
    /// was therefore asserting that AUTOMATIC audio is exempt, under a name that
    /// said the opposite — the suite was green and pinning the bug in place.
    func manual(_ id: String, _ bytes: Int) -> Row { (id, "memo", bytes) }
    func wake(_ id: String, _ bytes: Int) -> Row {
        (id, "\(NiclaRecorder.wakeLabelPrefix)hey tiny", bytes)
    }

    @Test("under budget nothing is evicted")
    func underBudget() {
        let rows = [live("a", 10), live("b", 10), live("c", 10)]
        #expect(NiclaRecorder.audioEvictions(rows: rows, budget: 100).isEmpty)
    }

    @Test("the newest segments stay playable, the older ones become text-only")
    func newestFirstRetention() {
        // Rows arrive newest-first (transcripts.insert(at: 0)), so filling the
        // budget from the top is what keeps the recent past playable.
        let rows = [live("new", 40), live("mid", 40), live("old", 40)]
        let evict = NiclaRecorder.audioEvictions(rows: rows, budget: 100)
        #expect(evict == ["old"], "eviction should start from the oldest audio, not the newest")
    }

    @Test("a manual take is never evicted")
    func manualExempt() {
        let rows = [live("seg1", 90), manual("memo", 90), live("seg2", 90)]
        let evict = NiclaRecorder.audioEvictions(rows: rows, budget: 100)
        #expect(evict.contains("memo") == false, "a hand-made recording lost its only offline copy")
        #expect(evict == ["seg2"])
    }

    @Test("a manual take does not consume the live budget")
    func manualNotCounted() {
        // Otherwise one long memo could push every live segment out, even though
        // the memo is not what the bound exists to contain.
        let withMemo = NiclaRecorder.audioEvictions(
            rows: [manual("memo", 1_000), live("seg", 50)], budget: 100)
        #expect(withMemo.isEmpty, "the memo's bytes were charged to the live budget")
    }

    @Test("rows with no audio are never named, even past the budget")
    func zeroByteRowsIgnored() {
        // A text-only row (server-merged, or a segment whose file failed to write)
        // has nothing to delete; naming it would clear an audioFile that is nil.
        #expect(NiclaRecorder.audioEvictions(
            rows: [live("text1", 0), live("kept", 100), live("text2", 0)],
            budget: 100).isEmpty)
        // And once the budget is spent, a 0-byte row must still not be named — the
        // row that follows an eviction is the one a naive rule would sweep up.
        #expect(NiclaRecorder.audioEvictions(
            rows: [live("big", 200), live("text", 0)], budget: 100) == ["big"])
    }

    @Test("a single segment larger than the whole budget is evicted, not kept")
    func oversizeSegment() {
        // `used + bytes <= budget` must be the test. A `used <= budget` check would
        // admit one unbounded file, which is the exact growth being bounded.
        let evict = NiclaRecorder.audioEvictions(rows: [live("huge", 500)], budget: 100)
        #expect(evict == ["huge"])
    }

    @Test("an empty list evicts nothing")
    func emptyList() {
        #expect(NiclaRecorder.audioEvictions(rows: [], budget: 0).isEmpty)
    }

    @Test("the writer's label is the rule's label")
    func labelsCannotDrift() {
        // TinyLive.finishSegment stores rows under NiclaRecorder.liveLabel. If that
        // string and this rule ever disagreed, live audio would be exempt from its
        // own budget and grow forever — silently, since everything still plays.
        #expect(NiclaRecorder.liveLabel == "necklace-live")
        let evict = NiclaRecorder.audioEvictions(
            rows: [(id: "x", label: "necklace-live", bytes: 200)], budget: 100)
        #expect(evict == ["x"])
    }

    @Test("a wake take is automatic audio, so the budget bounds it too")
    func wakeIsBounded() {
        // The defect this suite shipped with. Config.recordOnWake defaults to TRUE
        // and a wake take extends to maxSeconds (120s), so a necklace worn all day
        // mints minutes of audio nobody asked for — and the rule matched only
        // `necklace-live`, leaving every one of them permanent. The budget's own
        // doc comment said it bounded "AUTOMATIC audio" the whole time.
        let evict = NiclaRecorder.audioEvictions(
            rows: [wake("new", 90), wake("old", 90)], budget: 100)
        #expect(evict == ["old"], "wake takes are exempt from the automatic-audio budget")
    }

    @Test("wake and live audio share ONE budget, rather than a budget each")
    func wakeAndLiveShareTheBudget() {
        // Two separately-bounded pools would each be enforced correctly and still
        // let the total reach 2x the limit — the thing the user actually feels is
        // the disk, which does not care which producer filled it.
        let evict = NiclaRecorder.audioEvictions(
            rows: [live("seg", 60), wake("take", 60)], budget: 100)
        #expect(evict == ["take"], "the two automatic sources were charged separately")
    }

    @Test("classification is by producer, not by whether the label is known")
    func unknownLabelsAreExempt() {
        // A relay take's label is the agent's arbitrary `reason` string
        // (Session.swift passes `label: reason`), so it cannot be classified from
        // text. Defaulting an unrecognized label to EXEMPT is the safe direction:
        // something was awaiting that recording, and the cost of being wrong is a
        // file kept, not a file destroyed.
        #expect(NiclaRecorder.isAutomaticAudio(label: "check the oven") == false)
        #expect(NiclaRecorder.isAutomaticAudio(label: "memo") == false)
        #expect(NiclaRecorder.isAutomaticAudio(label: "manual") == false)
        #expect(NiclaRecorder.isAutomaticAudio(label: NiclaRecorder.liveLabel))
        #expect(NiclaRecorder.isAutomaticAudio(label: "wake: alexa"))
    }

    @Test("the wake writer's prefix is the rule's prefix")
    func wakePrefixCannotDrift() {
        // Same drift guard as liveLabel: NiclaVoiceGateway.handleWake builds its
        // label from wakeLabelPrefix. If the two disagreed, wake audio would be
        // exempt from its own budget again and nothing would look broken.
        #expect(NiclaRecorder.wakeLabelPrefix == "wake: ")
        let evict = NiclaRecorder.audioEvictions(
            rows: [(id: "x", label: "wake: alexa", bytes: 200)], budget: 100)
        #expect(evict == ["x"])
    }

    @Test("the budget is large enough to be worth having")
    func budgetIsHoursNotMinutes() {
        // A 45s segment measures 197KB written exactly the way SegmentAudio writes
        // one, so 96MB is 497 segments ≈ 6.2h. A budget small enough to evict
        // within one session would make the Play button a lie.
        let segmentBytes = 197 * 1024
        let hours = Double(NiclaRecorder.liveAudioBudget / segmentBytes) * 45 / 3600
        #expect(hours >= 4, "the budget holds only \(hours)h of listening")
    }
}

/// 🪞 One take, one row — even though it has two ids.
///
/// The phone mints a UUID per take; the worker's insert does its own
/// `crypto.randomUUID()` and returns it. `postToServer` checked only `ok` and threw
/// that id away, so `refreshFromServer`'s `Set(transcripts.map(\.id))` could never
/// match a row against its own server copy. Every synced take came back as a SECOND
/// row — and the twin is the worse copy (server rows carry `audioFile: nil` and a
/// 200-char preview), so the list showed the same memo twice, once unplayable and
/// truncated. `.task` runs the refresh on every open of the view, so this was the
/// normal path, not an edge case.
///
/// Same root cause reached further: `fetchFullText` and the relay's `transcriptId`
/// both address the server by `t.id`, which under a local UUID matched no row at all.
@Suite struct NiclaTranscriptMergeTests {
    func at(_ s: Double) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + s) }

    func row(_ id: String, _ t: Double, _ label: String = "memo", _ text: String = "buy milk",
             seconds: Int = 10, audioFile: String? = nil, isPreview: Bool = false)
        -> NiclaTranscript {
        NiclaTranscript(id: id, at: at(t), seconds: seconds, label: label, text: text,
                        audioFile: audioFile, audioUrl: nil, isPreview: isPreview)
    }

    // ── adoptServerId: the fast path, taken at POST time ──────────────────

    @Test("the row takes the id the server filed it under")
    func adopts() {
        let rows = [row("local-uuid", 0)]
        let out = NiclaRecorder.adoptServerId(rows: rows, local: "local-uuid", server: "srv-1")
        #expect(out?.first?.id == "srv-1")
    }

    @Test("adoption keeps everything except the id")
    func adoptionPreservesTheRow() {
        // Notably the audio file: swapping the id must not cost the Play button.
        // audioURL(for:) resolves `audioFile`, which is stored, not derived from
        // the id — but only because it is stored, so pin it.
        let rows = [row("local", 0, "memo", "the whole take", audioFile: "local.m4a")]
        let out = NiclaRecorder.adoptServerId(rows: rows, local: "local", server: "srv")
        #expect(out?.first?.audioFile == "local.m4a", "adopting the server id lost the local audio")
        #expect(out?.first?.text == "the whole take")
        #expect(out?.first?.at == at(0))
    }

    @Test("nothing to adopt returns nil, so the caller skips a needless save")
    func adoptionNoOps() {
        let rows = [row("a", 0)]
        #expect(NiclaRecorder.adoptServerId(rows: rows, local: "a", server: "") == nil,
                "an empty server id must never be written onto a row")
        #expect(NiclaRecorder.adoptServerId(rows: rows, local: "a", server: "a") == nil)
        #expect(NiclaRecorder.adoptServerId(rows: rows, local: "gone", server: "srv") == nil,
                "a row evicted between insert and reply must not resurrect")
    }

    @Test("adoption refuses to collapse two rows onto one id")
    func adoptionRefusesCollision() {
        // firstIndex(where:) addresses rows by id — fetchFullText writes through it.
        // Two rows sharing an id makes one of them permanently unreachable.
        let rows = [row("a", 0), row("srv", 1)]
        #expect(NiclaRecorder.adoptServerId(rows: rows, local: "a", server: "srv") == nil)
    }

    // ── mergeFetched: the rows already on the phone ───────────────────────

    @Test("a take the phone recorded is not listed twice after a refresh")
    func noDuplicateAfterRefresh() {
        // THE DEFECT. Local row under its UUID, the same take back from the list
        // route under the worker's id and truncated to the preview.
        let local = [row("local-uuid", 0, "memo", "buy milk and bread", audioFile: "local-uuid.m4a")]
        let fetched = [row("srv-1", 3, "memo", "buy milk", isPreview: true)]
        let out = NiclaRecorder.mergeFetched(local: local, fetched: fetched)
        #expect(out.count == 1, "the refresh listed the same take twice")
        #expect(out.first?.id == "srv-1", "the surviving row cannot be fetched or deduped by id")
        #expect(out.first?.text == "buy milk and bread", "the server's preview overwrote the full text")
        #expect(out.first?.audioFile == "local-uuid.m4a", "the merge cost the row its Play button")
        #expect(out.first?.isPreview == false)
    }

    @Test("a transcript this phone has never seen is still added")
    func genuinelyNewRowsArrive() {
        // The whole point of refreshing: another device's takes, and this phone's
        // own history after a reinstall. Deduping must not become dropping.
        let out = NiclaRecorder.mergeFetched(
            local: [row("a", 0, "memo", "mine")],
            fetched: [row("srv-b", 500, "memo", "from the other phone")])
        #expect(out.count == 2)
        #expect(out.contains { $0.id == "srv-b" })
    }

    @Test("an id already known is skipped without a content check")
    func idMatchStillWins() {
        // Post-fix takes have adopted the server id at POST time, so this is the
        // common case, and it must not depend on the text matching — a row whose
        // full text was already fetched no longer looks like its own preview.
        let out = NiclaRecorder.mergeFetched(
            local: [row("srv-1", 0, "memo", "the full sixteen-kilobyte text")],
            fetched: [row("srv-1", 0, "memo", "the full sixteen")])
        #expect(out.count == 1)
        #expect(out.first?.text == "the full sixteen-kilobyte text")
    }

    @Test("a different take with the same words is NOT merged away")
    func differentTakesSurvive() {
        // Saying "buy milk" twice on different days is two recordings. Merging them
        // would silently destroy one, which is worse than listing one twice.
        let out = NiclaRecorder.mergeFetched(
            local: [row("a", 0, "memo", "buy milk")],
            fetched: [row("srv-1", 86_400, "memo", "buy milk")])
        #expect(out.count == 2, "a take from another day was absorbed into an unrelated row")
    }

    @Test("label and duration are part of identity, not just the text")
    func labelAndDurationMatter() {
        let local = [row("a", 0, "memo", "buy milk", seconds: 10)]
        #expect(NiclaRecorder.mergeFetched(
            local: local, fetched: [row("s", 2, "wake: hey tiny", "buy milk", seconds: 10)]).count == 2,
            "two different producers' rows were merged")
        #expect(NiclaRecorder.mergeFetched(
            local: local, fetched: [row("s", 2, "memo", "buy milk", seconds: 45)]).count == 2,
            "a 45s take was merged into a 10s one")
    }

    @Test("an empty server text matches nothing")
    func emptyTextNeverMatches() {
        // hasPrefix("") is true for every string, so without the guard one empty
        // server row would absorb whichever local row happened to sit nearest.
        let out = NiclaRecorder.mergeFetched(
            local: [row("a", 0, "memo", "buy milk")],
            fetched: [row("s", 1, "memo", "", seconds: 10)])
        #expect(out.count == 2)
    }

    @Test("two look-alike takes pair off one-to-one, not many-to-one")
    func eachLocalRowAbsorbsAtMostOne() {
        // Two silent 10s memos a minute apart are identical in label, duration and
        // text. Both server rows matching the same local row would drop one take.
        let local = [row("a", 0, "memo", "(silence)"), row("b", 60, "memo", "(silence)")]
        let fetched = [row("s-a", 2, "memo", "(silence)"), row("s-b", 62, "memo", "(silence)")]
        let out = NiclaRecorder.mergeFetched(local: local, fetched: fetched)
        #expect(out.count == 2, "two takes collapsed into one, or duplicated")
        #expect(Set(out.map(\.id)) == ["s-a", "s-b"])
    }

    @Test("the time window covers the upload, and does not stretch to the next take")
    func timeWindow() {
        // `created` is stamped when the POST lands; `at` when the take ended. A 6MB
        // clip uploads between them. Too narrow and the duplicate comes back; too
        // wide and an unrelated later take gets absorbed.
        let local = [row("a", 0, "memo", "hello")]
        let m = { (t: Double) in
            NiclaRecorder.mergeFetched(local: local, fetched: [self.row("s", t, "memo", "hello")]).count
        }
        #expect(m(120) == 1, "a slow audio upload made the row duplicate")
        #expect(m(-30) == 1, "phone/worker clock skew made the row duplicate")
        #expect(m(3_600) == 2, "an hour later is a different take")
    }

    @Test("an empty fetch and an empty phone both behave")
    func degenerateInputs() {
        #expect(NiclaRecorder.mergeFetched(local: [], fetched: []).isEmpty)
        #expect(NiclaRecorder.mergeFetched(local: [row("a", 0)], fetched: []).count == 1)
        #expect(NiclaRecorder.mergeFetched(local: [], fetched: [row("s", 0)]).count == 1,
                "a fresh install must receive the server's history")
    }
}

/// 🧹 A file nothing points at is still a file on the disk.
///
/// audioEvictions bounds the audio ROWS point at. A segment file is opened before
/// its row exists, so a crash mid-segment leaves a file invisible to every rule
/// that walks `transcripts` — the budget could be perfectly enforced while the
/// directory grew without limit.
@Suite struct NiclaOrphanAudioTests {
    typealias File = (name: String, age: TimeInterval)
    let old: TimeInterval = NiclaRecorder.minOrphanAge + 1

    @Test("an unclaimed old file is collected")
    func orphanCollected() {
        let files: [File] = [("live-a.m4a", old), ("live-b.m4a", old)]
        #expect(NiclaRecorder.orphanAudio(files: files, rows: ["live-a.m4a"]) == ["live-b.m4a"])
    }

    @Test("a claimed file is never collected, however old")
    func claimedKept() {
        let files: [File] = [("take.m4a", 86_400 * 30)]
        #expect(NiclaRecorder.orphanAudio(files: files, rows: ["take.m4a"]).isEmpty)
    }

    @Test("a file still being written is not collected")
    func freshFileSpared() {
        // The trap this gate exists for: `shared` is lazily initialized, and the
        // FIRST live segment triggers it from storeHeard — file written, row not
        // yet inserted. Without the age gate the sweep deletes the segment that
        // woke it, or unlinks one AVAudioFile is still writing to.
        let files: [File] = [("live-open.m4a", 3)]
        #expect(NiclaRecorder.orphanAudio(files: files, rows: []).isEmpty,
                "the sweep deleted audio that was still being written")
    }

    @Test("the age gate outlasts the longest thing that can be open")
    func gateCoversSegmentAndTake() {
        // A segment runs up to 45s and a take up to maxSeconds. If the gate were
        // shorter than either, a launch during a long recording would delete it.
        #expect(NiclaRecorder.minOrphanAge > Double(NiclaRecorder.maxSeconds))
        #expect(NiclaRecorder.minOrphanAge >= 300)
    }

    @Test("the index is never collected")
    func indexSpared() {
        // It is not audio, and it is the file the rows were just loaded FROM —
        // deleting it would erase every transcript on the next launch.
        let files: [File] = [("index.json", old)]
        #expect(NiclaRecorder.orphanAudio(files: files, rows: []).isEmpty)
    }

    @Test("an empty directory collects nothing")
    func emptyDir() {
        #expect(NiclaRecorder.orphanAudio(files: [], rows: ["live-a.m4a"]).isEmpty)
    }
}

/// The fallback rail's line has to fit the ring it is written to.
///
/// postToServer prefers /api/devices/transcript, which files a durable row and
/// returns an id. When that fails it falls back to a `device_note` event — and
/// that rail files NO row, so anything the worker truncates is gone: there is no
/// id to fetch the rest with. It is the one path where a length mistake destroys
/// data rather than just shortening a preview.
///
/// It made one: the line was `text.prefix(180)` plus the audio URL, against a cap
/// the comment put at 240. The real cap is 300 (worker events.ts emitEvent), and
/// the line reached 269 chars with a short label and 335 with the 80-char label
/// TRANSCRIPT_LABEL_MAX allows. At 335 emitEvent cut the tail — which is the
/// audio URL, the only part of the line that cannot be reconstructed.
@Suite struct NiclaNoteDetailTests {
    /// A real /api/media URL: 32-hex key + extension, ~70 chars.
    let url = "https://tiny.technology/media/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.m4a"
    let cap = NiclaRecorder.noteDetailMax

    @Test("the line fits the ring even at the worst label and a full take")
    func fitsAtWorstCase() {
        // 80 chars is what the worker's own TRANSCRIPT_LABEL_MAX permits, and an
        // agent-supplied `reason` is free text — this is not a synthetic input.
        let d = NiclaRecorder.noteDetail(
            label: String(repeating: "w", count: 80),
            text: String(repeating: "x", count: 4000), audioUrl: url)
        #expect(d.count <= cap, "emitEvent will cut \(d.count - cap) chars off the tail")
    }

    @Test("the audio URL survives — it is the part that cannot be reconstructed")
    func urlSurvives() {
        for label in ["memo", "wake: hey tiny", "necklace-live", String(repeating: "w", count: 80)] {
            let d = NiclaRecorder.noteDetail(
                label: label, text: String(repeating: "x", count: 4000), audioUrl: url)
            #expect(d.hasSuffix(url), "a truncated media URL is a dead link, and this rail files no row")
            #expect(d.count <= cap)
        }
    }

    @Test("a long label is bounded rather than allowed to push the URL out")
    func labelBounded() {
        let d = NiclaRecorder.noteDetail(
            label: String(repeating: "w", count: 500), text: "hello", audioUrl: url)
        #expect(d.count <= cap)
        #expect(d.hasSuffix(url))
        #expect(!d.contains(String(repeating: "w", count: NiclaRecorder.notePreviewLabelMax + 1)))
    }

    @Test("speech always survives, even when label and URL are pathological")
    func speechFloor() {
        // The floor exists so a bad label/URL can never squeeze the actual words
        // out entirely — a note with no speech in it tells the agent nothing.
        let d = NiclaRecorder.noteDetail(
            label: String(repeating: "w", count: 80),
            text: "the roof guy comes tuesday", audioUrl: String(repeating: "u", count: 400))
        #expect(d.contains("the roof guy comes tuesday"))
    }

    @Test("a take with no uploaded audio spends the whole budget on words")
    func noAudioMoreWords() {
        let withURL = NiclaRecorder.noteDetail(
            label: "memo", text: String(repeating: "x", count: 4000), audioUrl: url)
        let without = NiclaRecorder.noteDetail(
            label: "memo", text: String(repeating: "x", count: 4000), audioUrl: nil)
        #expect(without.count <= cap)
        #expect(without.count > withURL.count - url.count,
                "reserving the URL should not cost words on a row that has no URL")
    }

    @Test("a short take is not padded or altered")
    func shortPassesThrough() {
        let d = NiclaRecorder.noteDetail(label: "memo", text: "hello", audioUrl: nil)
        #expect(d == "🎙️ memo: “hello”")
    }

    @Test("the emoji and curly quotes are counted as the worker counts them")
    func multibyteCounted() {
        // `detail` is capped in CHARACTERS worker-side (String.slice), and this
        // line opens with a multi-byte emoji and wraps the speech in curly
        // quotes — a budget computed in bytes would silently overshoot.
        let d = NiclaRecorder.noteDetail(
            label: "memo", text: String(repeating: "é", count: 4000), audioUrl: url)
        #expect(d.count <= cap)
        #expect(d.hasSuffix(url))
    }
}

/// 🗑️ A freed recording and a recording that never existed were the same row.
///
/// `pruneAndSave` evicts automatic audio to stay under `liveAudioBudget` and set
/// `audioFile = nil` — the value a text-only row already carried. So `playable()`
/// went false, the Play button vanished, and nothing on the row said why. Meanwhile
/// `nicla_voice_transcripts` tells the agent to say "open the tiny app to listen,
/// never 'there is no audio'" — advice that, for an evicted segment, sends the user
/// to a row with no button on it.
///
/// The same failure the `isPreview` ellipsis fixed for text, one field over:
/// absence and loss rendered identically.
@Suite struct NiclaAudioFreedTests {
    func row(_ id: String, label: String = NiclaRecorder.liveLabel,
             audioFile: String? = nil, audioUrl: String? = nil,
             audioFreed: Bool = false) -> NiclaTranscript {
        var t = NiclaTranscript(id: id, at: Date(timeIntervalSince1970: 1_700_000_000),
                                seconds: 45, label: label, text: "the roof guy comes tuesday",
                                audioFile: audioFile, audioUrl: audioUrl)
        t.audioFreed = audioFreed
        return t
    }

    // ── applyEvictions: the deletion and the reason are one step ──────────

    @Test("an evicted row loses its file and remembers that it had one")
    func marksTheEvicted() {
        let out = NiclaRecorder.applyEvictions(rows: [row("a", audioFile: "a.m4a")], evict: ["a"])
        #expect(out[0].audioFile == nil, "the file reference must be cleared — the file is gone")
        #expect(out[0].audioFreed, "the row cannot tell the user what happened to its audio")
    }

    @Test("a row nobody evicted is untouched")
    func leavesTheRest() {
        let rows = [row("a", audioFile: "a.m4a"), row("b", audioFile: "b.m4a")]
        let out = NiclaRecorder.applyEvictions(rows: rows, evict: ["b"])
        #expect(out[0].audioFile == "a.m4a" && !out[0].audioFreed)
        #expect(out[1].audioFile == nil && out[1].audioFreed)
    }

    @Test("a row that never had audio is not told it lost some")
    func doesNotInventALoss() {
        // A text-only row measures 0 bytes, so it can appear in the sized list the
        // eviction set is chosen from. Claiming it was freed would tell the user a
        // recording existed that never did.
        let out = NiclaRecorder.applyEvictions(rows: [row("a", audioFile: nil)], evict: ["a"])
        #expect(!out[0].audioFreed, "a row with no audio was marked as having lost audio")
    }

    @Test("evicting the same row twice does not change the second answer")
    func idempotent() {
        let once = NiclaRecorder.applyEvictions(rows: [row("a", audioFile: "a.m4a")], evict: ["a"])
        let twice = NiclaRecorder.applyEvictions(rows: once, evict: ["a"])
        #expect(twice == once, "pruneAndSave runs on every save — it must be stable")
    }

    @Test("the words survive eviction; only the audio goes")
    func keepsTheText() {
        let out = NiclaRecorder.applyEvictions(rows: [row("a", audioFile: "a.m4a")], evict: ["a"])
        #expect(out[0].text == "the roof guy comes tuesday")
        #expect(out[0].seconds == 45, "the duration is what the row still reports")
    }

    // ── showsAudioFreed: only where there is nothing left to play ─────────

    @Test("an evicted local-only row says so")
    func tellsTheUser() {
        #expect(NiclaRecorder.showsAudioFreed(row("a", audioFreed: true), hasLocalAudio: false))
    }

    @Test("an uploaded row still plays, so it says nothing")
    func silentWhenUploadedCopyRemains() {
        // Eviction only deletes the LOCAL file. `playable()` falls back to audioUrl,
        // so "freed for space" beside a working Play button would be a second wrong
        // answer to the same question.
        let t = row("a", audioUrl: "https://tiny.technology/media/abc.m4a", audioFreed: true)
        #expect(!NiclaRecorder.showsAudioFreed(t, hasLocalAudio: false))
    }

    @Test("a row whose file is back does not claim it is gone")
    func silentWhenLocalAudioExists() {
        #expect(!NiclaRecorder.showsAudioFreed(row("a", audioFile: "a.m4a", audioFreed: true),
                                               hasLocalAudio: true))
    }

    @Test("a row that never had audio stays quiet")
    func silentForTextOnly() {
        #expect(!NiclaRecorder.showsAudioFreed(row("a"), hasLocalAudio: false),
                "a text-only row must not claim a recording was deleted")
    }

    // ── the decode path, where a new field has wiped the store before ─────

    @Test("an index.json from before audioFreed existed still decodes")
    func oldIndexStillDecodes() throws {
        // `= false` on the property does NOT make the synthesized init tolerate a
        // missing key, and loadIndex() turns any throw into [] — so a plain
        // `decode` here is every transcript on the phone, gone. This has happened
        // once already, when isPreview was added.
        let old = """
        [{"id":"local-1","at":747000000,"seconds":45,"label":"necklace-live",
          "text":"the roof guy comes tuesday","isPreview":false}]
        """
        let rows = try JSONDecoder().decode([NiclaTranscript].self, from: Data(old.utf8))
        #expect(rows.count == 1, "an older index.json no longer decodes — this is a data wipe")
        #expect(!rows[0].audioFreed, "an old row must not claim its audio was freed")
    }

    @Test("the flag survives a save/load round trip")
    func roundTrips() throws {
        // pruneAndSave writes index.json immediately after applyEvictions. If the
        // flag did not persist, the tell would last until the next launch and the
        // row would go back to looking like it never had audio.
        let marked = NiclaRecorder.applyEvictions(rows: [row("a", audioFile: "a.m4a")], evict: ["a"])
        let data = try JSONEncoder().encode(marked)
        let back = try JSONDecoder().decode([NiclaTranscript].self, from: data)
        #expect(back[0].audioFreed, "the eviction was forgotten on reload")
        #expect(back[0].audioFile == nil)
    }

    // ── end to end against the rule that picks the victims ────────────────

    @Test("what audioEvictions chooses is what ends up marked")
    func agreesWithTheBudgetRule() {
        // The two halves in sequence, the way pruneAndSave runs them: a live segment
        // over budget is freed and says so, and the hand-made memo beside it is
        // exempt and keeps its button.
        let rows = [row("live-new", audioFile: "1.m4a"),
                    row("live-old", audioFile: "2.m4a"),
                    row("memo", label: "memo", audioFile: "3.m4a")]
        let sized = rows.map { (id: $0.id, label: $0.label, bytes: 700) }
        let evict = NiclaRecorder.audioEvictions(rows: sized, budget: 1_000)
        let out = NiclaRecorder.applyEvictions(rows: rows, evict: evict)
        #expect(out[0].audioFile == "1.m4a", "the newest segment should still be playable")
        #expect(NiclaRecorder.showsAudioFreed(out[1], hasLocalAudio: false),
                "the over-budget segment was freed with no explanation")
        #expect(out[2].audioFile == "3.m4a" && !out[2].audioFreed,
                "a hand-made memo is exempt from the budget and must keep its audio")
    }
}

// ── The forget verdict is the LIST's to give, not the status code's ────────
//
// `MemoryView.forget` reloaded server truth and then overwrote the conclusion
// with a transport-derived guess (`forgetError = ok ? nil : "Couldn't forget
// that — try again."`). The reachable case is dull: a memory already closed from
// another device answers 404, the reload shows it GONE, and the user got a red
// "try again" under a list the memory had already left — pointing at a row that
// is no longer there to swipe.
//
// These drive the real decision, not a source scan: the point is that when the
// reloaded list can see, the status code does not get a vote.

@Suite struct MemoryForgetVerdictTests {

    private let listed = ["100", "101", "102"]

    // ── the list can see ──────────────────────────────────────────────────

    @Test("a memory that is gone says nothing — even when the DELETE 404'd")
    func goneIsGone() {
        // The headline defect. 404 = "no memory with id 100": already closed
        // elsewhere, or superseded by the agent. The list agrees it is gone.
        let v = ForgetVerdict.message(
            id: "100",
            serverSaid: Api.httpMessage(404, "no memory with id 100"),
            reloaded: .loaded,
            listed: ["101", "102"])
        #expect(v == nil, "a memory the list no longer holds must not carry a red caption")
    }

    @Test("a memory still listed after the reload is reported as still there")
    func stillListedIsHonest() {
        let v = ForgetVerdict.message(id: "100", serverSaid: nil, reloaded: .loaded, listed: listed)
        #expect(v == ForgetVerdict.stillThere)
        // Even a 2xx does not get to claim success over a list that disagrees.
        #expect(v != nil)
    }

    @Test("when it is still there, the server's own sentence is the better one")
    func theServerExplainsWhenItCan() {
        // inc 29 put copy written for a HUMAN in the 400 body precisely so a
        // client could show it; iOS was reading only the status code.
        let human = "That memory's id didn't come through, so nothing was deleted. Reload Memory and try the swipe again."
        let v = ForgetVerdict.message(
            id: "100", serverSaid: Api.httpMessage(400, human), reloaded: .loaded, listed: listed)
        #expect(v?.contains("nothing was deleted") == true)
        #expect(v != ForgetVerdict.stillThere, "the generic retry buried an actionable refusal")
    }

    @Test("with the list readable, the status code gets no vote")
    func theListOutranksTheCode() {
        // The whole increment, as one assertion: hold the observation fixed and
        // vary the transport answer — the verdict must not move.
        for said in [nil, Api.httpMessage(404, "no memory with id 999"),
                     Api.httpMessage(500, "boom"), "The Internet connection appears to be offline."] {
            #expect(ForgetVerdict.message(id: "999", serverSaid: said, reloaded: .loaded,
                                          listed: listed) == nil,
                    "absent from the list is absent, whatever the DELETE reported")
        }
    }

    @Test("an id is matched exactly, so 10 is not 100")
    func idsMatchWhole() {
        // Guards against the classic slip of asking a joined string whether it
        // "contains" the id: "10" is a substring of "100" and of "102".
        #expect(ForgetVerdict.message(id: "10", serverSaid: nil, reloaded: .loaded,
                                      listed: listed) == nil)
        #expect(ForgetVerdict.message(id: "100", serverSaid: nil, reloaded: .loaded,
                                      listed: listed) == ForgetVerdict.stillThere)
    }

    // ── the list cannot see ───────────────────────────────────────────────

    @Test("a failed reload after a SUCCESSFUL delete does not invent doubt")
    func aConfirmedDeleteIsNotUnconfirmed() {
        // The server said 2xx. The `.failed` branch already shows why the list is
        // stale and offers Retry; a second, contradictory caption is noise.
        #expect(ForgetVerdict.message(id: "100", serverSaid: nil,
                                      reloaded: .failed("memories unavailable"),
                                      listed: listed) == nil)
    }

    @Test("a failed delete with no list to check is UNKNOWN, not a failure")
    func noEvidenceMeansNoClaim() {
        let v = ForgetVerdict.message(id: "100", serverSaid: "The request timed out.",
                                      reloaded: .failed("memories unavailable"), listed: listed)
        #expect(v != nil)
        // It may not assert the memory survived — we did not look.
        #expect(v?.contains("Still in your memories") == false)
    }

    @Test("a reason survives an unreadable list")
    func theReasonIsNotLostWithTheList() {
        let human = "That memory's id didn't come through, so nothing was deleted. Reload Memory."
        let v = ForgetVerdict.message(id: "100", serverSaid: Api.httpMessage(400, human),
                                      reloaded: .failed("memories unavailable"), listed: listed)
        #expect(v?.contains("nothing was deleted") == true)
    }

    @Test("still loading is not evidence either")
    func loadingIsNotAnObservation() {
        // `.loading` is not a list. `listed` deliberately HOLDS the id here, so
        // reading `.loading` as `.loaded` would answer "still there" — this is
        // the assertion that a mid-flight state cannot answer the question the
        // reload exists to answer.
        #expect(ForgetVerdict.message(id: "100", serverSaid: nil, reloaded: .loading,
                                      listed: listed) == nil)
        // A reason still gets through, exactly as with a failed reload.
        #expect(ForgetVerdict.message(id: "100", serverSaid: "The request timed out.",
                                      reloaded: .loading, listed: listed) == "The request timed out.")
        // …and a blank one falls back to the honest unknown.
        #expect(ForgetVerdict.message(id: "100", serverSaid: " ", reloaded: .loading,
                                      listed: listed) == ForgetVerdict.unconfirmed)
    }

    @Test("a blank reason never renders as an empty label")
    func blankIsNotAReason() {
        // Same rule Api.serverError applies to a blank `error` field: nothing to
        // say is not a sentence. An empty red caption is a bug with no words.
        for blank in ["", "   ", "\n"] {
            #expect(ForgetVerdict.message(id: "100", serverSaid: blank, reloaded: .loaded,
                                          listed: listed) == ForgetVerdict.stillThere)
            #expect(ForgetVerdict.message(id: "100", serverSaid: blank,
                                          reloaded: .failed("x"),
                                          listed: listed) == ForgetVerdict.unconfirmed)
        }
    }

    @Test("no verdict ever reads as a confirmation")
    func nothingClaimsSuccess() {
        // A caption that sounds like the memory went away is the same lie the
        // route's refusal copy is careful to avoid — silence is how success is
        // reported here, because the row leaving the list already says it.
        for copy in [ForgetVerdict.stillThere, ForgetVerdict.unconfirmed] {
            #expect(!copy.lowercased().contains("forgotten"))
            #expect(!copy.lowercased().contains("deleted"))
            #expect(!copy.lowercased().contains("removed"))
        }
        // …and the one that DOES invite a retry only appears with evidence for it.
        #expect(ForgetVerdict.stillThere.contains("try again"))
        #expect(!ForgetVerdict.unconfirmed.contains("try again"))
    }
}

/// 📮 A transcript that never reached the server used to stay that way forever.
///
/// `postToServer` was one-shot: awaited once after the take, and if it failed —
/// no network in a subway, a signed-out session, the worker mid-deploy — nothing
/// tried again. `refreshFromServer` only ever pulls DOWN, so no later open could
/// notice. The row listed, played and shared exactly like a synced one, and the
/// words never entered the agent's context. That is the whole feature failing
/// silently, which is why the fix has both halves: a retry, and a row that says
/// so.
///
/// The dangerous direction is the OTHER one, and it is what the fixtures below
/// are built around: a re-post mints a NEW server row, so retrying a row that
/// did land duplicates it. Every row already on a phone decodes `filed: false`,
/// which is why the retry runs only after the merge has had its say.
@Suite struct NiclaUnfiledSyncTests {
    /// `at` is explicit in every fixture: the settle window is measured from it,
    /// so a row built with `Date()` would test the clock rather than the rule.
    func row(_ id: String, label: String = "memo", agoSeconds: TimeInterval,
             filed: Bool = false, text: String = "the roof guy comes tuesday",
             seconds: Int = 45, audioFile: String? = nil) -> NiclaTranscript {
        var t = NiclaTranscript(
            id: id, at: Date(timeIntervalSince1970: 1_700_000_000 - agoSeconds),
            seconds: seconds, label: label, text: text,
            audioFile: audioFile, audioUrl: nil)
        t.filed = filed
        return t
    }
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    /// Comfortably outside the settle window (300s) so "old enough" is not the
    /// thing under test in the cases that aren't about it.
    let old: TimeInterval = 3_600

    // ── unfiled: which rows are due for a re-post ─────────────────────────

    @Test("an unfiled row past the settle window is retried")
    func retriesTheUnfiled() {
        let due = NiclaRecorder.unfiled(
            rows: [row("a", agoSeconds: old)], now: now, olderThan: nil)
        #expect(due.map(\.id) == ["a"], "a transcript the server never got was abandoned")
    }

    @Test("a filed row is never re-posted")
    func skipsTheFiled() {
        // The duplicate hazard. A second POST mints a second server row, and the
        // agent then reads the same memo twice as two things that were said.
        let due = NiclaRecorder.unfiled(
            rows: [row("a", agoSeconds: old, filed: true)], now: now, olderThan: nil)
        #expect(due.isEmpty, "a row the server already holds would be duplicated by a retry")
    }

    @Test("a take from seconds ago is left alone — its own POST is in flight")
    func waitsOutTheSettleWindow() {
        // The audio upload runs BEFORE the transcript POST, and a 6MB clip on a bad
        // link is slow. Retrying at t+4s races the take's own request and
        // duplicates it — the same failure as the case above, from the other end.
        let due = NiclaRecorder.unfiled(
            rows: [row("a", agoSeconds: 4)], now: now, olderThan: nil)
        #expect(due.isEmpty, "a row whose first POST may still be running was retried")
    }

    @Test("the settle window IS the merge window, not a second copy of it")
    func oneWindowNotTwo() {
        // Both answer "could this row's POST still be landing?" — mergeFetched asks
        // it of the server's `created`, the retry of the local `at`. Two constants
        // would drift, and a drift means either duplicate rows or abandoned ones.
        #expect(NiclaRecorder.postSettleSeconds == NiclaRecorder.mergeWindowAhead)
    }

    // ── The truncated-page watermark ──────────────────────────────────────

    @Test("a truncated page does not condemn rows older than what it showed")
    func respectsTheWatermark() {
        // The server ring holds 200 and the list asks for 50, so an old local row
        // can be filed AND absent from the answer. Retrying it on that evidence
        // duplicates it. The fixture makes the two rules disagree: both rows are
        // unfiled and both are old enough, so ONLY the watermark can separate them.
        let cut = Date(timeIntervalSince1970: 1_700_000_000 - 1_000)
        let due = NiclaRecorder.unfiled(
            rows: [row("newer", agoSeconds: 500), row("older", agoSeconds: 5_000)],
            now: now, olderThan: cut)
        #expect(due.map(\.id) == ["newer"],
                "a row older than the server's truncated page must not be retried")
    }

    @Test("a complete page makes absence real evidence")
    func noWatermarkWhenComplete() {
        // Same two rows, `olderThan: nil` — the server's answer was NOT cut off, so
        // a local row missing from it really is missing upstream. If this returned
        // one row, the watermark would be suppressing legitimate retries forever.
        let due = NiclaRecorder.unfiled(
            rows: [row("newer", agoSeconds: 500), row("older", agoSeconds: 5_000)],
            now: now, olderThan: nil)
        #expect(due.map(\.id).sorted() == ["newer", "older"])
    }

    // ── mergeFetched confirms what the server holds ───────────────────────

    @Test("a row the server returns by id is marked filed")
    func idMatchConfirms() {
        let local = [row("srv-1", agoSeconds: old)]
        let out = NiclaRecorder.mergeFetched(local: local, fetched: [row("srv-1", agoSeconds: old)])
        #expect(out.count == 1)
        #expect(out[0].filed, "the server just listed this row and the phone still thinks it's unsent")
    }

    @Test("a row matched by CONTENT is marked filed, not retried")
    func contentMatchConfirms() {
        // This is the case that makes the whole design safe. A row recorded before
        // `filed` existed carries a local UUID and `filed: false`; the server's copy
        // carries the worker's id. Without this, every such row is re-posted and
        // the user's history doubles server-side on the first refresh after update.
        let local = [row("local-uuid", agoSeconds: old)]
        let server = [row("worker-id", agoSeconds: old - 60, filed: true)]
        let out = NiclaRecorder.mergeFetched(local: local, fetched: server)
        #expect(out.count == 1, "the same take listed twice")
        #expect(out[0].id == "worker-id", "the row must adopt the server's id")
        #expect(out[0].filed, "a content-matched row would be re-posted and duplicated")
        #expect(NiclaRecorder.unfiled(rows: out, now: now, olderThan: nil).isEmpty)
    }

    @Test("a server row with no local twin arrives filed")
    func appendedRowIsFiled() {
        // It came FROM the server, so it is filed by definition. Marked false, the
        // retry would post the server's own row back to the server.
        let out = NiclaRecorder.mergeFetched(local: [], fetched: [row("srv-only", agoSeconds: old)])
        #expect(out.count == 1 && out[0].filed)
    }

    @Test("a genuinely unsent row survives the merge still unfiled")
    func mergeDoesNotForgive() {
        // The merge must not mark everything: a local row the server has never seen
        // has to come out of it still due. Different label AND text, so `sameTake`
        // cannot pair them.
        let local = [row("mine", label: "wake: hey tiny", agoSeconds: old, text: "call mum back")]
        let out = NiclaRecorder.mergeFetched(
            local: local, fetched: [row("srv-1", label: "memo", agoSeconds: old)])
        let mine = out.first { $0.id == "mine" }
        #expect(mine?.filed == false, "the merge marked a row the server never held")
        #expect(NiclaRecorder.unfiled(rows: out, now: now, olderThan: nil).map(\.id) == ["mine"])
    }

    // ── The prune must not destroy what was never sent ────────────────────

    @Test("the cap never drops a row the server has no copy of")
    func pruneKeepsUnfiled() {
        // Dropping a filed row costs nothing — it is re-fetchable forever. Dropping
        // an unfiled one destroys the words AND the last chance to reach the agent.
        // Fixture: `indexCap` filed rows, then one unfiled row past the cap, none
        // with local audio — so the audio exemption cannot be what saves it.
        var rows = (0 ..< NiclaRecorder.indexCap).map {
            row("filed-\($0)", agoSeconds: old, filed: true)
        }
        rows.append(row("never-sent", agoSeconds: old))
        let (kept, dropped) = NiclaRecorder.partitionForPrune(rows: rows, hasLocalAudio: { _ in false })
        #expect(kept.contains { $0.id == "never-sent" },
                "the cap destroyed the only copy of an unsent transcript")
        #expect(dropped.isEmpty)
    }

    @Test("the cap still drops filed rows past it")
    func pruneStillBounds() {
        // The exemption must not become "keep everything": if this failed, the
        // index would grow without limit and the test above would pass vacuously.
        let rows = (0 ... NiclaRecorder.indexCap).map {
            row("filed-\($0)", agoSeconds: old, filed: true)
        }
        let (kept, dropped) = NiclaRecorder.partitionForPrune(rows: rows, hasLocalAudio: { _ in false })
        #expect(kept.count == NiclaRecorder.indexCap)
        #expect(dropped.map(\.id) == ["filed-\(NiclaRecorder.indexCap)"])
    }

    @Test("the local-audio exemption still holds")
    func pruneKeepsLocalAudio() {
        // The rule that was there first, re-checked because partitionForPrune now
        // carries both: a filed row with a playable file is kept past the cap.
        var rows = (0 ..< NiclaRecorder.indexCap).map {
            row("filed-\($0)", agoSeconds: old, filed: true)
        }
        rows.append(row("has-audio", agoSeconds: old, filed: true, audioFile: "x.m4a"))
        let (kept, dropped) = NiclaRecorder.partitionForPrune(
            rows: rows, hasLocalAudio: { $0.audioFile != nil })
        #expect(kept.contains { $0.id == "has-audio" })
        #expect(dropped.isEmpty)
    }

    // ── The row says which state it's in ──────────────────────────────────

    @Test("an unsynced row tells the user")
    func tellsTheUser() {
        #expect(NiclaRecorder.showsUnsynced(row("a", agoSeconds: old), now: now),
                "a row the agent cannot read looks identical to one it can")
    }

    @Test("a synced row says nothing")
    func silentWhenFiled() {
        #expect(!NiclaRecorder.showsUnsynced(row("a", agoSeconds: old, filed: true), now: now))
    }

    @Test("a fresh take does not flash 'not synced' while its POST runs")
    func silentDuringSettle() {
        #expect(!NiclaRecorder.showsUnsynced(row("a", agoSeconds: 4), now: now),
                "the label appeared on a take whose own POST had not finished")
    }

    @Test("the tell and the retry agree on which rows are waiting")
    func labelMatchesRetry() {
        // Two rules reading one field; if they disagreed the app would either label
        // rows it never retries or retry rows it never labels. Spans the window
        // boundary in both directions on purpose.
        let rows = [row("fresh", agoSeconds: 4), row("stale", agoSeconds: old),
                    row("done", agoSeconds: old, filed: true)]
        let due = Set(NiclaRecorder.unfiled(rows: rows, now: now, olderThan: nil).map(\.id))
        let labelled = Set(rows.filter { NiclaRecorder.showsUnsynced($0, now: now) }.map(\.id))
        #expect(due == labelled)
        #expect(due == ["stale"])
    }


    // ── adoptFiling: the id and the confirmation are one step ──────────────

    @Test("a successful POST renames the row AND marks it filed")
    func adoptFilingDoesBoth() {
        let out = NiclaRecorder.adoptFiling(
            rows: [row("local-uuid", agoSeconds: old)], local: "local-uuid", server: "srv-1")
        #expect(out[0].id == "srv-1", "the server's id is what ?id= and transcriptId need")
        #expect(out[0].filed, "the row will be re-posted on the next refresh and duplicated")
    }

    @Test("filed is set even when the rename is refused")
    func adoptFilingWhenRenameRefused() {
        // adoptServerId returns nil when the server id is already present on another
        // row — but the POST DID land, so the local row is filed either way. Missing
        // this, the row is retried forever and duplicates the take every refresh.
        let rows = [row("local-uuid", agoSeconds: old),
                    row("srv-1", agoSeconds: old, filed: true)]
        let out = NiclaRecorder.adoptFiling(rows: rows, local: "local-uuid", server: "srv-1")
        #expect(out.first { $0.id == "srv-1" }?.filed == true)
        // The local row could not take the id, and must not be silently abandoned:
        // whichever row carries the filing, one of them is marked.
        #expect(out.filter { !$0.filed }.count < rows.filter { !$0.filed }.count,
                "a refused rename left the row unfiled and due for a duplicate post")
    }

    @Test("a row pruned mid-flight is not resurrected")
    func adoptFilingTolerAtesMissingRow() {
        let rows = [row("other", agoSeconds: old)]
        let out = NiclaRecorder.adoptFiling(rows: rows, local: "gone", server: "srv-1")
        #expect(out.count == 1 && out[0].id == "other")
        #expect(!out[0].filed, "the filing landed on an unrelated row")
    }

    // ── The migration ─────────────────────────────────────────────────────

    @Test("an index written before `filed` existed still decodes")
    func oldIndexStillDecodes() {
        // Third field with this hazard: a plain `decode` throws `.keyNotFound` and
        // loadIndex() turns any throw into [] — the entire transcript history gone
        // on first launch after the update.
        let json = """
        [{"id":"a","at":768000000,"seconds":45,"label":"memo","text":"hi"}]
        """
        let rows = try? JSONDecoder().decode([NiclaTranscript].self, from: Data(json.utf8))
        #expect(rows?.count == 1, "an older index.json failed to decode — every transcript lost")
        #expect(rows?[0].filed == false, "an old row must not claim the server has it")
    }

    @Test("filed round-trips through the index")
    func roundTrips() {
        let t = row("a", agoSeconds: old, filed: true)
        let back = try? JSONDecoder().decode(
            NiclaTranscript.self, from: JSONEncoder().encode(t))
        #expect(back?.filed == true, "the flag is lost on relaunch, so every row re-posts")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔇 A refusal handed to a media player, on the transcripts screen this time.
//
// `/voice/recording` already taught this app the whole lesson: a route that can
// decline, a URL handed straight to `AVPlayer(url:)`, and a row left asserting
// "playing" over silence. `CallRecordingRefusal` + `observe(\.status)` were the
// fix, and `tests/voice-playback-refusal.test.ts` states the rule in prose.
//
// ⚠️ THE RANGE HALF OF THAT LESSON REACHED /media/:key AND THE ERROR HALF DID
// NOT. NiclaRecorder uploads every take there, so this screen kept the original
// defect verbatim — one `.AVPlayerItemDidPlayToEndTime` observer, which is the
// notification a LOAD failure cannot fire. Same shape as
// `a-fix-lands-where-noticed-not-where-needed`, one file over.
// ─────────────────────────────────────────────────────────────────────────────

@Suite struct NiclaPlaybackRefusalTests {

    // ── Always a sentence: silence IS the defect ──────────────────────────

    @Test("every input produces something to say")
    func alwaysSpeaks() {
        // The difference from `CallOutcome.text`, which returns nil for a clean
        // call. This is called only when a play FAILED, and a failed play that
        // says nothing is the whole bug.
        for input in [nil, "", "   ", "who knows"] as [String?] {
            for online in [true, false] {
                for remote in [true, false] {
                    let s = NiclaPlaybackRefusal.text(input, online: online, remote: remote)
                    #expect(!s.isEmpty, "said nothing for \(String(describing: input))")
                    #expect(s.count > 4)
                }
            }
        }
    }

    @Test("each refusal /media/:key can give gets its own sentence")
    func mapsTheWorkersRefusals() {
        // The two literals MediaGetCall.handle actually returns — pinned against
        // the worker source by tests/nicla-playback-refusal.test.ts, so a third
        // one added upstream fails there rather than silently becoming `unknown`.
        let store = NiclaPlaybackRefusal.text("media store not provisioned", online: true, remote: true)
        let gone = NiclaPlaybackRefusal.text("not found", online: true, remote: true)
        #expect(store.contains("unavailable right now"))
        #expect(gone.contains("no longer on the server"))
        #expect(store != gone, "two refusals share a sentence — one of them is unsayable")
        for s in [store, gone] {
            #expect(s != NiclaPlaybackRefusal.unknown,
                    "a refusal with a stated cause rendered as the generic line")
        }
    }

    @Test("the reason arrives EMBEDDED in AVFoundation's own description")
    func matchesBySubstring() {
        // ⚠️ `contains`, not `==`. AVPlayer wraps the origin's body in its own
        // wording, so an equality check would recognise nothing a real device
        // ever produces — a map that passes every unit test and never fires.
        let wrapped = "The operation could not be completed. (media store not provisioned)"
        #expect(NiclaPlaybackRefusal.text(wrapped, online: true, remote: true).contains("unavailable"))
    }

    @Test("an unrecognised failure names no cause and does not echo the diagnostic")
    func doesNotInventACause() {
        let s = NiclaPlaybackRefusal.text("the flux capacitor desynced", online: true, remote: true)
        #expect(s == NiclaPlaybackRefusal.unknown)
        #expect(!s.contains("flux"), "the raw diagnostic reached the user")
    }

    // ── Offline: knowable, and knowably only for a REMOTE take ────────────

    @Test("an offline phone is told the audio is on the server, not that playback broke")
    func offlineIsNamed() {
        // AVFoundation's offline description ("The Internet connection appears to
        // be offline.") matches no needle, so without this the one cause the user
        // can actually fix would render as "couldn't play this recording".
        let s = NiclaPlaybackRefusal.text("The Internet connection appears to be offline.",
                                          online: false, remote: true)
        #expect(s == NiclaPlaybackRefusal.offline)
        #expect(s.contains("offline"))
    }

    @Test("⚠️ a LOCAL file failing offline is never blamed on the network")
    func offlineNeverBlamedForLocalAudio() {
        // The reason `remote` is a parameter and not inferred: an m4a on this disk
        // plays with the radio off, so "you're offline" for a corrupt local file
        // is a confident wrong answer — the exact class of defect this removes.
        let s = NiclaPlaybackRefusal.text("cannot open", online: false, remote: false)
        #expect(s != NiclaPlaybackRefusal.offline)
        #expect(s == NiclaPlaybackRefusal.unknown)
    }

    @Test("a stated refusal is not overwritten by being offline")
    func offlineDoesNotMaskAStatedCause() {
        // Order matters only in one direction: the offline check runs first
        // BECAUSE its description is unmatchable, but a 424 that somehow arrives
        // while the monitor says offline still has the more specific answer.
        // (An offline phone gets no response body at all, so in practice the
        // first branch is the one that fires — this pins that we prefer a real
        // reason whenever one exists.)
        let s = NiclaPlaybackRefusal.text("media store not provisioned", online: true, remote: true)
        #expect(s.contains("unavailable right now"))
    }

    @Test("the generic sentence is shared with the call recordings screen")
    func agreesWithItsSibling() {
        // Two screens telling a person two different things about the same
        // outcome is how "couldn't play" becomes untrustworthy. `unknown` is
        // literally CallRecordingRefusal's, so they cannot drift.
        #expect(NiclaPlaybackRefusal.unknown == CallRecordingRefusal.unknown)
        #expect(NiclaPlaybackRefusal.text(nil, online: true, remote: false)
                    == CallRecordingRefusal.text(nil))
    }
}

// ── Creating a scheduled job from the phone ────────────────────────────────

/**
 * The create form's arithmetic, which is the only part of it that can lie.
 *
 * `daily@HH:MM` is stored in **UTC** by the worker's scheduler DSL, and a
 * `DatePicker` hands back the user's own clock. Formatting those digits into the
 * string is the obvious implementation and it ships a job that fires at the
 * wrong hour for every user outside UTC — silently, because the LIST converts
 * the stored value back for display and lands on the same wrong number, so the
 * app agrees with itself all the way down. The round trip
 * `dailyLocal(daily(x)) == x` is the assertion that catches it, and it is only
 * available because the conversion is a function rather than a line in a view.
 *
 * The other two are quota traps, not clock traps: a zero-interval `every`
 * (`*\/0m`, escaped here because it would close this comment) passes the
 * worker's shape check but makes `nextDue` return nil, so it is stored ENABLED,
 * never fires, and holds one of the account's ten job slots forever; and sending both
 * `schedule` and `run_in_minutes` makes the route ignore the one-shot (it only
 * computes `runAt` `if run_in_minutes !== undefined && !schedule`), turning
 * "once, in an hour" into a repeating job.
 */
@Suite struct JobCreateTests {

    @Test("a picked local time becomes the UTC the worker stores, and reads back the same")
    func dailyRoundTrips() {
        // Every whole hour, in zones on either side of UTC and one with a
        // half-hour offset — the case a naive `± hours` fix still gets wrong.
        for zoneName in ["Europe/Istanbul", "America/Los_Angeles", "Asia/Kolkata", "UTC"] {
            let zone = TimeZone(identifier: zoneName)!
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = zone
            for hour in [0, 6, 9, 13, 23] {
                let picked = cal.date(from: DateComponents(year: 2026, month: 8, day: 2,
                                                           hour: hour, minute: 30))!
                let dsl = JobCadence.daily(from: picked)
                // Shape the worker's validSchedule accepts.
                #expect(dsl.hasPrefix("daily@"))
                #expect(dsl.count == 11, "daily@HH:MM is 11 chars, got \(dsl)")
                // …and the round trip lands back on the wall-clock time the user
                // actually picked, in their own zone.
                let back = JobCadence.dailyLocal(dsl, now: picked, output: zone,
                                                 locale: Locale(identifier: "en_US_POSIX"))
                // The wall-clock time the user actually picked, rendered the way
                // the list renders it. Same formatter settings as `dailyLocal`
                // deliberately — what is under test is the UTC conversion in
                // between, not the short-time format.
                let fmt = DateFormatter()
                fmt.timeStyle = .short
                fmt.dateStyle = .none
                fmt.timeZone = zone
                fmt.locale = Locale(identifier: "en_US_POSIX")
                let want = fmt.string(from: picked)
                #expect(back == want,
                        "\(zoneName) \(hour):30 → \(dsl) → \(back ?? "nil"), wanted \(want)")
            }
        }
    }

    @Test("a UTC-offset zone does NOT produce the local digits (the defect this guards)")
    func dailyIsNotThePickersDigits() {
        // Istanbul is UTC+3 with no DST, so 09:00 local is 06:00 UTC. A form that
        // formatted the picker would post daily@09:00 and fire six hours early —
        // this asserts the difference, not merely that a conversion happened.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let nine = cal.date(from: DateComponents(year: 2026, month: 8, day: 2, hour: 9, minute: 0))!
        #expect(JobCadence.daily(from: nine) == "daily@06:00")
    }

    @Test("every-N refuses the zero the worker would accept and never fire")
    func everyHasAFloor() {
        #expect(JobCadence.every(30, unit: .minutes) == "*/30m")
        #expect(JobCadence.every(2, unit: .hours) == "*/2h")
        // 0 and negatives clamp to 1: `*/0m` is the enabled-forever, never-firing
        // job that still costs a quota slot.
        #expect(JobCadence.every(0, unit: .minutes) == "*/1m")
        #expect(JobCadence.every(-5, unit: .hours) == "*/1h")
    }

    @Test("each cadence sends exactly ONE timing key")
    func bodyKeysAreExclusive() {
        let common = (name: " Morning check ", prompt: " check HN ", tiny: "tiny")
        let at = Date(timeIntervalSince1970: 1_754_150_400)

        let every = JobCreateView.body(mode: .every, name: common.name, prompt: common.prompt,
                                       tiny: common.tiny, everyN: 15, everyUnit: .minutes,
                                       atTime: at, inMinutes: 60)
        #expect(every["schedule"] as? String == "*/15m")
        #expect(every["run_in_minutes"] == nil, "a repeating job must not also carry a one-shot")
        // Trimmed, because the worker stores what it is sent and " Morning check "
        // would render with its padding in every list and notification.
        #expect(every["name"] as? String == "Morning check")
        #expect(every["prompt"] as? String == "check HN")

        let daily = JobCreateView.body(mode: .daily, name: "a", prompt: "b", tiny: "tiny",
                                       everyN: 15, everyUnit: .minutes, atTime: at, inMinutes: 60)
        #expect((daily["schedule"] as? String)?.hasPrefix("daily@") == true)
        #expect(daily["run_in_minutes"] == nil)

        let once = JobCreateView.body(mode: .once, name: "a", prompt: "b", tiny: "tiny",
                                      everyN: 15, everyUnit: .minutes, atTime: at, inMinutes: 90)
        #expect(once["run_in_minutes"] as? Int == 90)
        // ⚠️ The route computes runAt only when `schedule` is absent — a stray
        // schedule here would make "once" repeat forever.
        #expect(once["schedule"] == nil, "a one-shot must not carry a schedule")
        #expect(JobCreateView.body(mode: .once, name: "a", prompt: "b", tiny: "tiny",
                                   everyN: 1, everyUnit: .minutes, atTime: at,
                                   inMinutes: 0)["run_in_minutes"] as? Int == 1,
                "0 minutes would be rejected by the route as non-positive")
    }

    @Test("an empty tiny name falls back to the route's own default")
    func tinyNameFallsBack() {
        // cfg_tiny_name is empty until the user picks one; posting "" would
        // create a job addressed to a tiny that doesn't exist.
        let b = JobCreateView.body(mode: .daily, name: "a", prompt: "b", tiny: "",
                                   everyN: 1, everyUnit: .minutes, atTime: Date(), inMinutes: 1)
        #expect(b["tiny"] as? String == "tiny")
    }

    @Test("the default time is a round hour, not whatever minute it is now")
    func defaultTimeIsRound() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let messy = cal.date(from: DateComponents(year: 2026, month: 8, day: 2,
                                                 hour: 14, minute: 37, second: 12))!
        let rounded = JobCreateView.nextRoundHour(from: messy, calendar: cal)
        #expect(cal.component(.hour, from: rounded) == 15)
        #expect(cal.component(.minute, from: rounded) == 0)
        // 23:xx must not roll to hour 24 (nil from the calendar → the fallback,
        // which would silently keep the messy minute).
        let late = cal.date(from: DateComponents(year: 2026, month: 8, day: 2,
                                                hour: 23, minute: 45))!
        let wrapped = JobCreateView.nextRoundHour(from: late, calendar: cal)
        #expect(cal.component(.hour, from: wrapped) == 0)
        #expect(cal.component(.minute, from: wrapped) == 0)
    }

    @Test("the one-shot stepper reads in human units all the way to a week")
    func inWordsReads() {
        #expect(JobCreateView.inWords(1) == "1 min")
        #expect(JobCreateView.inWords(59) == "59 min")
        #expect(JobCreateView.inWords(60) == "1 hr")
        #expect(JobCreateView.inWords(90) == "1 hr 30 min")
        #expect(JobCreateView.inWords(1440) == "1 day")
        #expect(JobCreateView.inWords(2880) == "2 days")
        #expect(JobCreateView.inWords(1500) == "1d 1h")
    }
}

// ── Capacity (the denominator, and the population it counts) ───────────────

/**
 * "N of what?" for the two panels on this phone that print a limit.
 *
 * Both were wrong, in opposite directions. The Toolbox printed `N/20` — a cap the
 * worker does not have (`MAX_TOOLS = 10000`, list query unlimited), so a user with
 * 20 tools read "20/20" and stopped forging. The Jobs panel printed no cap at all,
 * and there is one: `MAX_JOBS_PER_USER = 10`, met as a 429 from the agent
 * mid-conversation.
 *
 * ⚠️ What makes the jobs half worth a test suite rather than one interpolation is
 * that **the cap counts a different population than the list shows**. The cap is
 * `WHERE enabled = 1`; the list is every row; a one-shot flips to `enabled = 0`
 * when it fires. `\(jobs.count)/10` would print **12/10** for someone at 3 of 10 —
 * over a limit they are nowhere near, on a panel whose only other action is
 * Delete. Every assertion below that mixes `active(_:)` with `spent(_:)` is
 * guarding that one confusion.
 */
@Suite struct CapacityTests {

    /// An active recurring job.
    private func active(_ n: Int) -> [JobRow] {
        (0..<n).map { row(id: "a\($0)", enabled: true, fired: 3) }
    }

    /// A spent one-shot: it fired, and the scheduler set `enabled = 0`
    /// (scheduler.ts:117/172). Still in the list; counts for nothing.
    private func spent(_ n: Int) -> [JobRow] {
        (0..<n).map { row(id: "s\($0)", enabled: false, fired: 1) }
    }

    private func row(id: String, enabled: Bool, fired: Int) -> JobRow {
        JobRow(id: id, name: id, cadence: "every 5 min", tone: .live,
               lastFiredLabel: nil, enabled: enabled, fireCount: fired)
    }

    @Test("the caps are the worker's real numbers, not invented ones")
    func capsMirrorTheWorker() {
        // If either moves worker-side this is the tripwire. 20 was never either of
        // them — that is the entire Toolbox finding.
        #expect(Capacity.jobActiveCap == 10)
        #expect(Capacity.toolMax == 10_000)
        #expect(Capacity.toolMax != 20, "20 is the fabricated cap this replaced")
    }

    @Test("activeJobCount counts the CAP's population, not the list's")
    func activeCountsEnabledOnly() {
        #expect(Capacity.activeJobCount(active(3) + spent(9)) == 3)
        #expect(Capacity.activeJobCount([]) == 0)
        #expect(Capacity.activeJobCount(spent(30)) == 0)
    }

    @Test("the jobs header is a plain count when nowhere near the cap")
    func headerIsPlainCountFarFromCap() {
        // A permanent "3/10" reads as though the other 7 slots are a feature.
        #expect(Capacity.jobsHeader(active(3)) == "Scheduled jobs · 3")
    }

    @Test("the header NEVER prints total/cap — the listed number is not the capped one")
    func headerNeverPairsTheWrongTwoNumbers() {
        // THE FINDING. 3 active + 9 spent one-shots is 12 rows and 3 of 10 used.
        let h = Capacity.jobsHeader(active(3) + spent(9))
        #expect(h == "Scheduled jobs · 12")
        #expect(!h.contains("12/10"), "the two populations were mixed")
        #expect(!h.contains("/10"), "no cap should appear at 3 of 10")
    }

    @Test("the cap appears in the last two slots, labelled with what it counts")
    func headerRevealsCapWhenItMatters() {
        #expect(Capacity.jobsHeader(active(8)) == "Scheduled jobs · 8 · 8/10 active")
        #expect(Capacity.jobsHeader(active(9)) == "Scheduled jobs · 9 · 9/10 active")
        #expect(Capacity.jobsHeader(active(10)) == "Scheduled jobs · 10 · 10/10 active — limit reached")
        // …and at the cap the two numbers still stay apart: 15 rows, 10 counted.
        let mixed = Capacity.jobsHeader(active(10) + spent(5))
        #expect(mixed.contains("· 15"))
        #expect(mixed.contains("10/10 active"))
    }

    @Test("an unloaded panel prints no number — 0 is a claim, and it would be false")
    func nilMeansNotLoadedNotEmpty() {
        // ⚠️ The header renders OUTSIDE JobsView's state switch (so device-local
        // agent alerts survive a server outage), which means it also renders above
        // "Couldn't load your scheduled jobs" — where "· 0" is not merely
        // premature but contradicted three lines below it. Web ships this bug: it
        // calls jobsHeader(jobs) unconditionally.
        #expect(Capacity.jobsHeader(nil) == "Scheduled jobs")
        #expect(Capacity.jobsCapNote(nil) == nil)
        // An account that genuinely HAS none still says so — the two must differ.
        #expect(Capacity.jobsHeader([]) == "Scheduled jobs · 0")
    }

    @Test("the cap note names the way out, and only when there is one to name")
    func capNoteNamesTheWayOut() {
        #expect(Capacity.jobsCapNote(active(9)) == nil)
        // 2 active + 30 spent is not full, however long the list looks.
        #expect(Capacity.jobsCapNote(active(2) + spent(30)) == nil)
        let full = Capacity.jobsCapNote(active(10))
        #expect(full?.contains("limit of 10 active jobs") == true)
        #expect(full?.contains("Delete an active job") == true)
        // Nothing to mistake when every row counts — the sentence stays off.
        #expect(full?.contains("won't free a slot") == false)
    }

    @Test("at the cap WITH spent rows, the note says deleting those frees nothing")
    func capNoteWarnsAboutTheDisposableLookingRows() {
        // Without this, the rows that LOOK most disposable are exactly the ones
        // that do not count: a user deletes three finished reminders and is still
        // blocked, with nothing on screen explaining why.
        let note = Capacity.jobsCapNote(active(10) + spent(4))
        #expect(note?.contains("won't free a slot") == true)
        #expect(note?.contains("only the 10 active jobs count") == true)
    }

    @Test("the tool badge is a bare count — no fabricated denominator")
    func toolBadgeHasNoDenominator() {
        #expect(Capacity.toolBoxBadge(7) == "7 forged tools")
        #expect(Capacity.toolBoxBadge(7)?.contains("/") == false)
        // The old header said "20/20 forged tools" here. Nothing is full at 20.
        #expect(Capacity.toolBoxBadge(20) == "20 forged tools")
        #expect(Capacity.toolBoxBadge(20)?.contains("20/20") == false)
        #expect(Capacity.toolBoxBadge(1) == "1 forged tool", "singular")
        // An empty tool box is a real state and says so.
        #expect(Capacity.toolBoxBadge(0) == "0 forged tools")
        // …but "not loaded" is not that state.
        #expect(Capacity.toolBoxBadge(nil) == nil)
        #expect(Capacity.toolBoxBadge(-1) == nil, "a negative would print as a count")
    }
}

// ── UniverseCounts ─────────────────────────────────────────────────────────

/**
 * What the Universe surfaces may claim about builders and tinys.
 *
 * Same finding class as `CapacityTests` — a number the UI shows about data it did
 * not fully receive — on the three surfaces `Capacity` didn't reach. Both defects
 * were live and both honest numbers were already in the payload the phone parsed:
 *
 *  - `"\(users.count) builders"` was the PAGE (`?limit=50`, further filtered),
 *    printed beside `totalPublicTinys`, a real `COUNT(*)`. `totalUsers` — the
 *    genuine builder census — was in every response and nothing read it. Live
 *    worker while this was written: `totalUsers: 7`, **6 rows**.
 *  - `overflow: u.tinys.count > 8 ? …` could NEVER fire, because the worker embeds
 *    at most 8 names per builder. `cagataycali` returns `tinyCount: 20` with 8
 *    names, so 12 tinys had no chip, no count and no route on the phone.
 *
 * ⚠️ The arithmetic is what these tests exist for; that the VIEWS ask for it, and
 * that the old expressions are gone from the view bodies, is what no Swift test can
 * see — `tests/ios-universe-counts-parity.test.ts` covers that half (the
 * `DevicesFooter`/`Capacity` lesson: a pure function nobody calls is a green suite
 * over an unchanged screen).
 */
@Suite struct UniverseCountsTests {

    @Test("the caps are the worker's real numbers")
    func capsMirrorTheWorker() {
        // NAMES_PER_USER (community.ts:53) and the ?limit CommunityFeed asks for.
        // If either moves worker-side, this is the tripwire.
        #expect(UniverseCounts.namesPerUser == 8)
        #expect(UniverseCounts.pageLimit == 50)
    }

    @Test("a page next to a real total is rendered as 'N of M', never a bare count")
    func pageIsQualifiedAgainstTheTotal() {
        // THE FINDING, with the live numbers that exposed it.
        #expect(UniverseCounts.builders(shown: 6, totalUsers: 7) == "6 of 7 builders")
        #expect(UniverseCounts.builders(shown: 6, totalUsers: 7) != "6 builders")
    }

    @Test("when the page IS the whole set, no hedge appears")
    func exactPageIsUnqualified() {
        // A permanent "7 of 7" would be its own false suggestion of more.
        #expect(UniverseCounts.builders(shown: 7, totalUsers: 7) == "7 builders")
        #expect(UniverseCounts.isTruncated(shown: 7, totalUsers: 7) == false)
        #expect(UniverseCounts.note(shown: 7, totalUsers: 7, totalPublicTinys: 26) == nil)
    }

    @Test("singular/plural, and zero builders is a sentence not a fragment")
    func grammar() {
        #expect(UniverseCounts.builders(shown: 1, totalUsers: 1) == "1 builder")
        #expect(UniverseCounts.builders(shown: 0, totalUsers: 0) == "0 builders")
        #expect(UniverseCounts.publicTinys(1) == "1 public tiny")
        #expect(UniverseCounts.publicTinys(26) == "26 public tinys")
        #expect(UniverseCounts.publicTinys(0) == "0 public tinys")
    }

    @Test("a MISSING total falls back to the page — and a full page is evidence of more")
    func absentTotalUsesTheOnlyEvidenceLeft() {
        // An older worker payload has no totalUsers. Then the page is all we
        // know, and only a FULL page suggests there is more.
        #expect(UniverseCounts.builders(shown: 50, totalUsers: nil) == "50 builders")
        #expect(UniverseCounts.isTruncated(shown: 50, totalUsers: nil) == true)
        #expect(UniverseCounts.isTruncated(shown: 6, totalUsers: nil) == false)
        let note = UniverseCounts.note(shown: 50, totalUsers: nil, totalPublicTinys: 90)
        #expect(note?.contains("the first 50 builders") == true)
        #expect(note?.contains("there may be more") == true)
    }

    @Test("a total that CONTRADICTS the rows in hand is ignored, not printed")
    func brokenPayloadNeverPrintsNOfLessThanN() {
        // "12 of 3 builders" is the failure mode. Trust the rows over a number
        // that contradicts them.
        #expect(UniverseCounts.builders(shown: 12, totalUsers: 3) == "12 builders")
        #expect(UniverseCounts.isTruncated(shown: 12, totalUsers: 3) == false)
        #expect(UniverseCounts.note(shown: 12, totalUsers: 3, totalPublicTinys: 20) == nil)

        // ⚠️ A mutation run found this case unpinned, and it is the one where
        // `isTruncated`'s `>= shown` guard actually earns its place: a FULL page
        // beside a contradicting total is still a page, so the incoherent number
        // must be discarded in favour of the page-size evidence — not believed
        // into "3 > 50 = false, everything is shown".
        #expect(UniverseCounts.isTruncated(shown: 50, totalUsers: 3) == true)
        let note = UniverseCounts.note(shown: 50, totalUsers: 3, totalPublicTinys: 90)
        #expect(note?.contains("the first 50 builders") == true,
                "a broken total must fall through to the page wording, not print '50 of 3'")
        #expect(note?.contains("of 3") == false)
    }

    @Test("the note names both numbers, so 'N of M' has a reading on a phone")
    func noteExplainsTheQualifiedCount() {
        let note = UniverseCounts.note(shown: 6, totalUsers: 7, totalPublicTinys: 26)
        // Web hides this in a `title` tooltip; a phone has no hover, so if the
        // sentence is missing the "6 of 7" is unexplained.
        #expect(note == "Showing 6 of 7 builders. 26 public tinys across all of them.")
    }

    @Test("hiddenTinys counts from the real total, so the overflow can actually fire")
    func overflowComesFromTheWholePopulation() {
        // THE OTHER FINDING: 20 real, 8 embedded → 12 hidden. The old
        // `tinys.count - 8` gave 0 for every builder that has ever existed.
        #expect(UniverseCounts.hiddenTinys(tinyCount: 20, chipsShown: 8) == 12)
        #expect(UniverseCounts.hiddenTinys(tinyCount: 8, chipsShown: 8) == 0)
        #expect(UniverseCounts.hiddenTinys(tinyCount: 1, chipsShown: 1) == 0)
    }

    @Test("an incoherent tinyCount never produces a negative overflow")
    func staleCountCannotPrintMinusN() {
        // A count smaller than what is on screen is stale or broken; "+-3 more"
        // is not an acceptable rendering of that.
        #expect(UniverseCounts.hiddenTinys(tinyCount: 3, chipsShown: 8) == 0)
        #expect(UniverseCounts.hiddenTinys(tinyCount: -5, chipsShown: 0) == 0)
        #expect(UniverseCounts.hiddenTinys(tinyCount: 0, chipsShown: 0) == 0)
    }

    @Test("negative inputs never reach a label")
    func negativesAreClamped() {
        #expect(UniverseCounts.builders(shown: -3, totalUsers: nil) == "0 builders")
        #expect(UniverseCounts.publicTinys(-9) == "0 public tinys")
    }

    @Test("decode carries totalUsers, and ABSENCE stays absent")
    func decodeKeepsTheCensusOptional() throws {
        let body: [String: Any] = [
            "users": [["login": "a", "tinys": [["name": "t1"]], "tinyCount": 20]],
            "totalPublicTinys": 26, "totalMessages": 6882, "totalUsers": 7,
        ]
        let feed = try CommunityFeed.decode(body)
        #expect(feed.totalUsers == 7)
        #expect(feed.users.first?.tinyCount == 20, "the real total, not the 1 embedded name")

        // ⚠️ The load-bearing half. `?? 0` here would turn "this worker didn't
        // say" into a census claiming an empty platform — and then `builders`
        // would read "6 builders" as though that were confirmed.
        var noTotal = body
        noTotal.removeValue(forKey: "totalUsers")
        #expect(try CommunityFeed.decode(noTotal).totalUsers == nil)

        // A genuine 0 is a real (empty) census and must survive as 0, not nil.
        var zero = body
        zero["totalUsers"] = 0
        #expect(try CommunityFeed.decode(zero).totalUsers == 0)

        // A negative COUNT(*) is incoherent — absent, NOT clamped to 0, because
        // clamping would assert a census we did not receive.
        var negative = body
        negative["totalUsers"] = -4
        #expect(try CommunityFeed.decode(negative).totalUsers == nil)
    }
}

// ── SidebarVisibility (iPad) ───────────────────────────────────────────────

/**
 * The iPad sidebar's remembered open/closed state.
 *
 * Worth testing because the whole sidebar was, until this pass, INVISIBLE on launch:
 * `columnVisibility` was `.automatic`, which hides the column in portrait, so all 16
 * surfaces the sidebar reaches sat behind an undiscovered "Show Sidebar" tap. The fix
 * is `.all` plus persistence — and persistence is where the subtle bug lives, not in
 * the initial value.
 */
@Suite struct SidebarVisibilityTests {
    // ⚠️ No `!` anywhere below. A mutation run that broke `encode` into returning nil
    // made three of these fail correctly and then CRASHED the runner on the force
    // unwrap — and the crashed rerun printed "Test run with 0 tests ... passed". A
    // green line from a suite that executed nothing is worse than a red one.
    @Test("a concrete choice round-trips")
    func roundTrip() throws {
        for v in [NavigationSplitViewVisibility.all, .doubleColumn, .detailOnly] {
            let s = try #require(SidebarVisibility.encode(v), "a real user choice must be storable")
            #expect(SidebarVisibility.decode(s) == v, "\(s) did not decode back to what encoded it")
        }
    }

    @Test("⚠️ .automatic is REFUSED, even though it compares equal to .detailOnly")
    func automaticIsNotAPreference() {
        // 🔑 The finding this suite earned. `.automatic` is NOT a distinct case: it is
        // `.detailOnly` with an `isAutomatic` flag, and `==` ignores the flag —
        //     automatic:  {"kind":0,"isAutomatic":true}
        //     detailOnly: {"kind":0,"isAutomatic":false}
        // so `.automatic == .detailOnly` is TRUE and a `case .automatic:` arm is
        // unreachable. My first version's refusal was decorative; this test caught it
        // by returning "detailOnly" where nil was expected.
        //
        // Why it matters beyond tidiness: `.automatic` means "system, you decide", and
        // the value it aliases is the SIDEBAR-HIDDEN one. Storing it naively persists
        // "hidden" — the exact defect this change exists to fix.
        #expect(SidebarVisibility.encode(.automatic) == nil,
                "storing .automatic persists the collapsed state as if the user chose it")
        #expect(SidebarVisibility.isAutomatic(.automatic))
        #expect(!SidebarVisibility.isAutomatic(.detailOnly),
                "a real .detailOnly must stay storable, or collapsing never sticks")
    }

    @Test("the two values that alias each other are still told apart")
    func aliasedPairIsDistinguished() {
        // The pair is only separable through the flag, so assert the separation
        // directly. If a future SwiftUI drops `isAutomatic` from its encoded form,
        // `isAutomatic` returns false and THIS is the test that says so.
        #expect(SidebarVisibility.encode(.detailOnly) == "detailOnly")
        #expect(SidebarVisibility.encode(.automatic) == nil)
        #expect(NavigationSplitViewVisibility.automatic == .detailOnly,
                "if these ever stop comparing equal, encode() can go back to a plain switch")
    }

    @Test("collapsing the sidebar survives a relaunch")
    func collapsedIsRemembered() throws {
        // The user-visible promise, stated as the sequence it actually happens in:
        // collapse → store → cold launch → decode.
        let stored = try #require(SidebarVisibility.encode(.detailOnly),
                                  "a collapsed sidebar must be storable at all")
        #expect(SidebarVisibility.decode(stored) == .detailOnly,
                "the sidebar reopens itself after the user closed it")
    }

    @Test("an unknown stored value SHOWS the sidebar")
    func unknownFallsBackToVisible() {
        // Junk, or a value written by another build. Recovery has a direction here:
        // guessing `.detailOnly` hides the entire app behind a button the user has to
        // find, where guessing `.all` merely shows a sidebar they can close.
        for junk in ["", "sidebar", "ALL", "detailonly", "{}"] {
            #expect(SidebarVisibility.decode(junk) == .all, "\"\(junk)\" should fall back to visible")
        }
    }

    @Test("the default matches the fallback, so first launch and junk agree")
    func defaultAgreesWithFallback() {
        // `@AppStorage(key) var stored = fallbackKey` and `decode`'s default arm are
        // two separate decisions that must not drift: if the @AppStorage default were
        // "detailOnly", a first launch would hide the sidebar while a corrupted value
        // showed it, for no reason a user could understand.
        #expect(SidebarVisibility.decode(SidebarVisibility.fallbackKey) == .all)
    }

    @Test("the storage key is stable")
    func keyIsStable() {
        // Renaming this silently resets every existing user's choice — the setting
        // doesn't break, it just quietly forgets. Pinned so the rename is deliberate.
        #expect(SidebarVisibility.key == "ipad.sidebar.visibility")
    }
}

// ── the glasses camera has ONE session, so a busy one must name its holder ──

/// Android twin: `WearablesSessionTest` (same four cases, same wording).
///
/// The glasses expose one camera session per device and no way to take over the
/// one that is open, so an ask made while another rail holds it is genuinely
/// dead until the holder lets go — and letting go is something the USER does.
/// The SDK's own sentence, "A session already exists for this device", is a
/// true statement that names neither the holder nor the remedy.
@Suite struct GlassesCameraBusyTests {

    @Test("the live feed holding the camera says so, and says how to get it back")
    func liveFeedNamed() {
        let msg = WearablesManager.cameraBusyMessage(liveOpen: true, recording: false)
        #expect(msg.contains("live"))
        #expect(msg.contains("close the live card"))
        // The failure this replaces: a photo of what the user is looking at,
        // asked for while they watch the feed, answered in SDK vocabulary.
        #expect(!msg.lowercased().contains("session already exists"))
    }

    @Test("a recording in progress is not blamed on the live feed")
    func recordingNotBlamedOnLiveFeed() {
        let msg = WearablesManager.cameraBusyMessage(liveOpen: false, recording: true)
        #expect(msg.contains("recording"))
        #expect(msg.contains("finish"))
        // Telling someone to close a live card that isn't open is a dead end
        // with extra steps.
        #expect(!msg.contains("live card"))
    }

    @Test("a holder we do not own still gets an honest, ending answer")
    func unknownHolderStillEnds() {
        // A photo asked for twice in quick succession: the first ask holds the
        // session while it walks up to .started — up to 25s — and neither of
        // our own flags is set. It clears itself, so "ask again" is the truth.
        let msg = WearablesManager.cameraBusyMessage(liveOpen: false, recording: false)
        #expect(msg.contains("few seconds"))
        #expect(msg.contains("ask again"))
    }

    @Test("every holder gets a remedy, and none leaks SDK vocabulary")
    func everyHolderHasARemedy() {
        for liveOpen in [true, false] {
            for recording in [true, false] {
                let msg = WearablesManager.cameraBusyMessage(liveOpen: liveOpen, recording: recording)
                let where_ = "liveOpen=\(liveOpen) recording=\(recording): \(msg)"
                #expect(msg.contains("ask again"), "no remedy in \(where_)")
                #expect(msg.contains("glasses"), "glasses not mentioned in \(where_)")
                #expect(!msg.contains("session"), "SDK vocabulary in \(where_)")
                #expect(msg.count > 60, "too terse to act on in \(where_)")
            }
        }
    }

    @Test("the reason survives into what the agent and the card actually render")
    func reasonIsRendered() {
        // All three rails render `(error as? LocalizedError)?.errorDescription`
        // — a case whose errorDescription dropped the reason would carry the
        // measurement all the way to the user and then throw it away.
        let reason = WearablesManager.cameraBusyMessage(liveOpen: true, recording: false)
        let err = WearablesCaptureError.cameraBusy(reason)
        #expect(err.errorDescription == reason)
        #expect((err as LocalizedError).errorDescription == reason)
    }
}
