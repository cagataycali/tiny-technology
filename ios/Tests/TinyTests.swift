/**
 * TinyTests — unit tests for the pure logic (north-star hygiene).
 * Swift Testing framework (Xcode 16+); zero UI, zero network.
 */
import Testing
import Foundation
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
    @Test func resultsFlipNodes() {
        var item = SpawnTreeItem(id: "t1", nodes: [
            SpawnNode(id: 1, prompt: "a", ok: nil, result: nil),
            SpawnNode(id: 2, prompt: "b", ok: nil, result: nil),
        ], elapsedMs: nil)
        item.apply(resultsJson: #"{"elapsed_ms": 1500, "results": [{"task": 1, "ok": true, "result": "done"}]}"#)
        #expect(item.nodes[0].ok == true)
        #expect(item.nodes[0].result == "done")
        // Unreported task = failure (batch timeout isolation)
        #expect(item.nodes[1].ok == false)
        #expect(item.elapsedMs == 1500)
    }

    @Test func malformedJsonIsNoop() {
        var item = SpawnTreeItem(id: "t1", nodes: [SpawnNode(id: 1, prompt: "a", ok: nil, result: nil)], elapsedMs: nil)
        item.apply(resultsJson: "not json")
        #expect(item.nodes[0].ok == nil)
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
        // A >3MB file:// doc → named oversize reason with its size + the 3MB cap
        // (matches web "<name> is X.XMB — documents must be under 3.0MB" and
        // Android's MAX_DOC_LABEL copy), instead of vanishing silently.
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("big-\(UUID().uuidString).pdf")
        let big = Data(count: MAX_DOCUMENT_BYTES + 1_000)
        try? big.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard case .err(let message) = AttachmentCodec.encodeDocument(url: tmp) else {
            Issue.record("expected .err for an oversize doc"); return
        }
        // "2.9MB" is the CANONICAL cross-client copy: web renders the cap in MiB
        // (`(MAX_DOCUMENT_BYTES/1024/1024).toFixed(1)` → "2.9MB") and Android's
        // MAX_DOC_LABEL computes the same. A hardcoded "3MB" here was the exact
        // self-contradiction Android's Attachments.kt docblock documents: the
        // message reports the FILE's size in MiB, so a stated "3MB" limit read
        // HIGHER than the 2.9MB file it just refused.
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

    /// The loudest event in the system needs a glyph nothing else shares: a
    /// reconciliation page that looks like a page view is a page nobody reads.
    @Test func payAlarmIsTheSirenAndNothingElseIs() {
        #expect(EventGlyph.icon(for: "pay_alarm") == "🚨")
        for kind in EventGlyph.emittedKinds where kind != "pay_alarm" {
            #expect(EventGlyph.icon(for: kind) != "🚨", "\(kind) also renders 🚨")
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
