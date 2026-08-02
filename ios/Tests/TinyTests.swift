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
        let phone = row("me", "my-iphone", online: true, seen: 1_000)
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
        let phone = row("me", "my-iphone", online: true, seen: 900, platform: "ios-arm64")
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
            row("me", "my-iphone", online: true, seen: 5, platform: "ios-arm64"),
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
        let mine = row("me", "my-iphone", online: true, seen: 5, platform: "ios-arm64")
        #expect(DeviceOrder.rowLine(mine, isThisPhone: true) == "online · iOS")
        let stale = row("me", "my-iphone", online: false, seen: 5, platform: "ios-arm64")
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

    @Test("every failure leads with the token, not with the request")
    func failureNamesTheLiveToken() {
        // ⚠️ The whole point. Someone revoking a lost phone is told what is still
        // true of that phone, before any diagnosis of the HTTP call.
        for (status, body) in [(401, ["error": "login required"]),
                              (400, ["error": "deviceId required"]),
                              (424, ["error": "revoke failed"]),
                              (503, ["error": "aborted", "retryable": true] as [String: Any])] {
            let msg = RevokeFailure.message(status: status, body: body)
            #expect(msg?.hasPrefix(RevokeFailure.lead) == true,
                    "status \(status) buried the outcome")
            #expect(msg?.localizedCaseInsensitiveContains("still works") == true)
        }
    }

    @Test("no response is status 0, not a retry instruction")
    func noResponseUsesTheHouseCode() {
        // `try? URLSession.data` returning nil means nothing arrived — there is no
        // body to prefer, and the house table already has the words for it.
        let msg = RevokeFailure.message(status: nil, body: nil)
        #expect(msg == RevokeFailure.lead + " " + Api.friendlyHTTPError(0))
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
            #expect(RevokeFailure.message(status: status, body: ["error": server])
                    == RevokeFailure.lead + " " + Api.httpMessage(status, server))
        }
        // And a 401 does NOT tell the user to repeat an action that can only fail
        // again — it tells them what would actually fix it.
        let expired = RevokeFailure.message(status: 401, body: ["error": "login required"]) ?? ""
        #expect(expired.localizedCaseInsensitiveContains("sign out"))
        #expect(!expired.localizedCaseInsensitiveContains("login required"))
    }

    @Test("the lead is one sentence, terminated, and never diagnoses")
    func leadIsWellFormed() {
        // It gets a reason appended, so it must end cleanly — this is the `· tap to
        // retry` bug from inc 9, where a fragment with no terminator was joined to
        // the board's own words.
        #expect(RevokeFailure.lead.hasSuffix("."))
        #expect(!RevokeFailure.lead.localizedCaseInsensitiveContains("try again"))
        // Two spaces would mean the lead already carried its own separator.
        #expect(RevokeFailure.message(status: 424, body: ["error": "revoke failed"])?
                .contains("  ") != true)
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

/// 💾 Live segment audio is bounded; a hand-made take is not.
///
/// The necklace files a segment every ~45s for as long as its card is open, so the
/// old rule ("never evict a row that owns a local audio file") meant unbounded disk
/// growth on someone's phone. The bound applies to AUTOMATIC audio only, and it
/// takes the file, never the words.
@Suite struct NiclaAudioEvictionTests {
    typealias Row = (id: String, label: String, bytes: Int)

    func live(_ id: String, _ bytes: Int) -> Row { (id, NiclaRecorder.liveLabel, bytes) }
    func manual(_ id: String, _ bytes: Int) -> Row { (id, "wake: hey tiny", bytes) }

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
