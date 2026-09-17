/**
 * Continuity — iOS port of components/chat/continuity.ts.
 *
 * Turn log (200 max, last 20 injected) + persistent memories (100 max),
 * both scoped per-tiny in Documents JSON files. They survive Clear chat
 * and the server's 31-message trim by riding a system message every
 * request (the chat route folds system messages into the agent prompt) —
 * byte-compatible with the web's buildContinuityContext so one identity
 * spans both surfaces.
 */
import Foundation

struct TurnEntry: Codable {
    let q: String
    let a: String
    let ts: Double   // ms since epoch, matching web's Date.now()
}

struct MemoryEntry: Codable, Identifiable, Equatable {
    let id: String
    let content: String
    var tags: [String]?
    let ts: Double
}

/// Port of web's `ForgetOutcome` (components/chat/continuity.ts) so all three
/// surfaces answer the model in the same three cases.
///
/// ⚠️ A count of "3 removed" is the same lie in a more confident wrapper when
/// the write never landed — the number describes an in-memory array, not the
/// store on disk.
enum ForgetOutcome {
    case forgotten, noMatch, blocked

    /// The user-facing sentence. A no-match is NOT an error: calling it a storage
    /// problem sends someone to clear app data over a typo'd match string (web
    /// Chat.tsx:1290 "Three outcomes, three messages"). Only `.blocked` warns,
    /// and it must say the memory SURVIVED.
    var line: String {
        switch self {
        case .forgotten: return "🧠 Memory forgotten"
        case .noMatch: return "no memory matched"
        case .blocked: return "couldn't forget that — the memory is still there"
        }
    }
}

extension Notification.Name {
    /// Posted by `Continuity.scrubAllLocal()` — a DIFFERENT user just signed in
    /// and every local per-tiny store has been erased from disk.
    ///
    /// Deleting the files is not sufficient on its own. `ChatModel` holds the
    /// transcript in memory and re-persists it on every `save()`, and it can be
    /// constructed BEFORE the scrub runs: `TinySession.signIn` sets `token`
    /// (mounting ChatView → `ChatModel.init` → `load()`) and only then awaits
    /// `loadMe()`, which is where the scrub lives. So a live model can be holding
    /// the previous user's messages at the moment their file is deleted, and the
    /// next save would write them straight back under the new user's session.
    static let tinyLocalDataScrubbed = Notification.Name("tiny.localDataScrubbed")

    /// Posted by `TinySession.logout()` — the session is over, but no identity
    /// change has been observed and nothing on disk has been erased.
    ///
    /// The distinction from `tinyLocalDataScrubbed` is deliberate: signing back
    /// in as the SAME user must keep their transcripts, so this one drops only
    /// what must not survive the session boundary — chiefly the offline send
    /// queue, which `flushQueue` would otherwise drain under whoever's token is
    /// current when the network returns.
    static let tinySessionEnded = Notification.Name("tiny.sessionEnded")
}

enum Continuity {
    private static let turnMax = 200
    private static let turnInject = 20
    private static let memoryMax = 100

    // Shared app-group container — Continuity.swift is compiled into the
    // widget + watch-widget EXTENSIONS too (project.yml), and their briefing/
    // followup intents call buildContext/appendTurn. Extensions get their own
    // per-sandbox Documents dir, so the old .documentDirectory path meant the
    // extensions read/wrote a container the app never saw: briefings ran with
    // zero continuity and extension turns were invisible to the phone. The
    // group container (same one WidgetStore uses) is shared across all targets.
    private static let group = "group.technology.tiny.app"

    private static func dir() -> URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private static func url(_ kind: String, _ name: String) -> URL {
        let shared = dir().appendingPathComponent("tiny_\(kind)_\(name).json")
        // One-time migration: hoist any file the app wrote to its old private
        // Documents dir into the group container so existing users keep their
        // memories + turn log. Only runs while the legacy file exists and the
        // shared one doesn't (the app can reach both; extensions can't see the
        // legacy dir, so this is a no-op there — harmless).
        let legacy = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tiny_\(kind)_\(name).json")
        let fm = FileManager.default
        if fm.fileExists(atPath: legacy.path), !fm.fileExists(atPath: shared.path) {
            try? fm.moveItem(at: legacy, to: shared)
        }
        return shared
    }

    private static func read<T: Decodable>(_ kind: String, _ name: String) -> [T] {
        guard let data = try? Data(contentsOf: url(kind, name)),
              let items = try? JSONDecoder().decode([T].self, from: data) else { return [] }
        return items
    }

    /// ⚠️ Returns WHETHER the bytes landed. It used to swallow both `try?`s, and
    /// the callers above state outcomes as fact — the voice `forget` tool answers
    /// the MODEL `{ ok: true }`. A full disk or a protected-data container made
    /// every one of those claims false, which is web's v13 G2 bug verbatim
    /// (continuity.ts:32-47): the array shrank in memory, the user was told the
    /// fact was forgotten, and `buildContext` kept injecting it into every later
    /// request. "I forgot your address" followed by the address, forever.
    @discardableResult
    private static func write<T: Encodable>(_ kind: String, _ name: String, _ items: [T]) -> Bool {
        guard let data = try? JSONEncoder().encode(items) else { return false }
        do {
            try data.write(to: url(kind, name), options: .atomic)
            return true
        } catch {
            print("⚠️ continuity write \(kind) failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Truncate on a CODE-POINT boundary — the only unit web, Android and iOS
    /// can agree on.
    ///
    /// ⚠️ `prefix(n)` is WRONG here and looks right: it counts GRAPHEME
    /// CLUSTERS, so `"a"*498 + "👨‍👩‍👧‍👦"` is 496 characters to Swift and 506 to
    /// web/Android (measured) — a cap of 500 cuts the three surfaces in three
    /// different places, and this file promises the opposite (line 8:
    /// "byte-compatible with the web's buildContinuityContext"). Code points are
    /// `unicodeScalars` here, `Array.from` on web, `codePointCount` on the JVM.
    ///
    /// The other direction is not available: web and the JVM count UTF-16 units,
    /// so their cut can split one emoji and leave a LONE SURROGATE, which each
    /// then encodes differently (U+FFFD in the browser, `?` on the JVM) — and
    /// Swift's String cannot hold one at all, substituting U+FFFD on
    /// construction (measured). So "never split a character" is the only rule
    /// all three can keep. Same rule as the DM rail's `clipToCodePoints`.
    static func clipToCodePoints(_ text: String, _ max: Int) -> String {
        let scalars = text.unicodeScalars
        guard scalars.count > max else { return text }
        return String(String.UnicodeScalarView(scalars.prefix(max)))
    }

    // ── Turn log ──────────────────────────────────────────────────────────

    static func appendTurn(_ name: String, q: String, a: String) {
        let qt = q.trimmingCharacters(in: .whitespacesAndNewlines)
        let at = a.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !qt.isEmpty, !at.isEmpty else { return }
        var log: [TurnEntry] = read("turnlog", name)
        log.append(TurnEntry(q: clipToCodePoints(qt, 500), a: clipToCodePoints(at, 800),
                             ts: Date().timeIntervalSince1970 * 1000))
        write("turnlog", name, Array(log.suffix(turnMax)))
    }

    static func clearTurnLog(_ name: String) {
        try? FileManager.default.removeItem(at: url("turnlog", name))
    }

    // ── Memories ──────────────────────────────────────────────────────────

    /// True only when the memory is actually durable — the caller's "remembered"
    /// claim is exactly as true as this write. An empty content is `false` too:
    /// nothing was stored (web continuity.ts `addMemory`).
    @discardableResult
    static func addMemory(_ name: String, content: String, tags: [String]? = nil) -> Bool {
        let c = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return false }
        var mems: [MemoryEntry] = read("memories", name)
        mems.append(MemoryEntry(id: UUID().uuidString.lowercased().prefix(12).description,
                                content: clipToCodePoints(c, 1000), tags: tags,
                                ts: Date().timeIntervalSince1970 * 1000))
        return write("memories", name, Array(mems.suffix(memoryMax)))
    }

    static func memories(_ name: String) -> [MemoryEntry] { read("memories", name) }

    /// The Boolean form, kept because it IS the `forget` tool's result contract
    /// (the model is told `{ removed }`). Delegates so the "did this match AND
    /// land?" predicate has exactly ONE implementation — two copies of that
    /// question is how the two answers drift apart (web continuity.ts:148).
    @discardableResult
    static func forgetMemory(_ name: String, _ idOrText: String) -> Bool {
        forgetOutcome(name, idOrText) == .forgotten
    }

    /// Substring/id match delete — same guard as the web: an empty match
    /// must never wipe the store (includes("") matches everything).
    ///
    /// Three states, not a Bool: "nothing matched" and "the disk refused the
    /// write" are different facts, and a caller that reports the wrong one has
    /// diagnosed the user confidently and wrongly. Only `.forgotten` means the
    /// fact stopped reaching the model.
    static func forgetOutcome(_ name: String, _ idOrText: String) -> ForgetOutcome {
        let mems: [MemoryEntry] = read("memories", name)
        // nil = nothing to do, so nothing is written and nothing can be .blocked:
        // a store that never needed changing cannot have refused.
        guard let filtered = survivors(mems, idOrText) else { return .noMatch }
        // The shrink is NECESSARY but not sufficient — the write has to land too.
        return write("memories", name, filtered) ? .forgotten : .blocked
    }

    /// Pure: which memories SURVIVE a forget for `idOrText`, or nil when the
    /// store must not be touched at all (blank needle, or nothing matched).
    ///
    /// ⚠️ The blank guard reads as redundant HERE and is not: Swift's
    /// `contains("")` returns FALSE, so an empty needle would fall through to the
    /// count check and return nil anyway. On the other two surfaces it is the
    /// whole store's safety catch — JS `includes("")` and JVM `contains("")` are
    /// both TRUE, so a blank needle matches EVERY memory and an empty forget
    /// wipes everything, then reports "forgotten" with a count. `idOrText` comes
    /// straight from the model's forget tool call. Keep it: it is the shape all
    /// three surfaces share, and a "simplification" here is a silent invitation
    /// to drop it on the surface where it is load-bearing (Android's was only
    /// reachable via a Context, so no test could have caught its removal).
    static func survivors(_ mems: [MemoryEntry], _ idOrText: String) -> [MemoryEntry]? {
        let needle = idOrText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return nil }
        let filtered = mems.filter { $0.id != idOrText && !$0.content.lowercased().contains(needle) }
        return filtered.count < mems.count ? filtered : nil
    }

    /// Watch sync: wipe-and-replace the store with the phone's copy
    /// (the phone is the richer source of truth; called from WatchLink)
    static func replaceMemories(_ name: String, with items: [MemoryEntry]) {
        write("memories", name, Array(items.suffix(memoryMax)))
    }

    /// Raw export for the WatchConnectivity context push (phone side)
    static func memoriesJson(_ name: String) -> String? {
        let mems: [MemoryEntry] = read("memories", name)
        guard !mems.isEmpty, let data = try? JSONEncoder().encode(mems) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clearMemories(_ name: String) {
        try? FileManager.default.removeItem(at: url("memories", name))
    }

    /// Does this directory entry hold per-tiny user data that must be wiped on
    /// an account switch?
    ///
    /// Pure and internal so the scrub's SCOPE is testable without a container —
    /// and the scope IS the correctness-sensitive part, because the defect this
    /// closes was a too-narrow one. Port of Android's
    /// `Continuity.isScrubbableLocalFile`, which has carried the full list since
    /// its own fix; iOS matched only the first two.
    ///
    /// Deliberately does NOT match anything else in either container: a scrub
    /// that over-reaches is unrecoverable data loss, not a privacy fix.
    static func isScrubbableLocalName(_ name: String) -> Bool {
        name.hasPrefix("tiny_turnlog_")     // injected as buildContext
            || name.hasPrefix("tiny_memories_")  // ditto, and user-authored facts
            || name.hasPrefix("chat-history-")   // the readable transcript, reloaded verbatim
            || name == "chat-history.json"       // pre-per-tiny builds (ChatModel.store's legacy)
            || name == "sessions"                // SessionStore archives — a directory
    }

    /// Wipe EVERY local turn-log, memory file, chat transcript and saved session
    /// (all tiny names). Called only when a *different* user signs in on this
    /// device — these stores are keyed by the device-level tiny name (not
    /// per-user) and never re-sync from the server, so without this the prior
    /// user's private data bleeds into the new user's session.
    /// (The widget-snapshot half of this identity leak was closed separately in
    /// TinySession.logout via WatchCore.loggedOut; this is the source-data half.)
    ///
    /// ⚠️ TWO ROOTS, NOT ONE, AND THAT WAS THE BUG. `dir()` resolves to the
    /// APP-GROUP container (shared with the widget + watch extensions), but the
    /// two highest-severity stores are written to the app's own Documents dir:
    ///
    ///   ChatModel.store   (Views.swift) → Documents/chat-history-<tiny>.json
    ///   SessionStore.dir  (Sessions.swift) → Documents/sessions/<tiny>/*.json
    ///
    /// Widening the prefix list alone would have matched NOTHING, because those
    /// names never appear in the container this used to enumerate — the visible
    /// message content (up to 200 messages per tiny, plus every named session)
    /// would still have survived an account switch. Documents also still holds
    /// legacy `tiny_turnlog_*`/`tiny_memories_*` files for any tiny name whose
    /// lazy migration in `url(_:_:)` never ran, so both roots need both prefixes.
    ///
    /// Recursive removal: `sessions` is a directory tree.
    static func scrubAllLocal() {
        let fm = FileManager.default
        var roots = [dir()]
        let documents = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        // In the extensions `dir()` IS a group container and Documents is their
        // own per-sandbox one; in the app they're distinct. Either way, dedupe
        // so a single root isn't enumerated twice.
        if !roots.contains(documents) { roots.append(documents) }
        for root in roots {
            guard let files = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { continue }
            for f in files where isScrubbableLocalName(f.lastPathComponent) {
                try? fm.removeItem(at: f)  // removeItem is recursive for directories
            }
        }
        // Tell whoever holds this data in MEMORY. See the notification's docs:
        // an already-constructed ChatModel would otherwise re-persist the prior
        // user's transcript on its next save, undoing the deletion above.
        NotificationCenter.default.post(name: .tinyLocalDataScrubbed, object: nil)
    }

    // ── Context injection ─────────────────────────────────────────────────

    /// Same section headers as the web so the model sees ONE continuity
    /// format regardless of surface.
    static func buildContext(_ name: String) -> String {
        var parts: [String] = []

        let mems: [MemoryEntry] = read("memories", name)
        if !mems.isEmpty {
            let lines = mems.map { m in
                "- \(m.content)\((m.tags?.isEmpty == false) ? " [\(m.tags!.joined(separator: ", "))]" : "")"
            }
            parts.append("## Persistent Memories (stored via remember tool, survives resets):\n" + lines.joined(separator: "\n"))
        }

        let log: [TurnEntry] = Array((read("turnlog", name) as [TurnEntry]).suffix(turnInject))
        if !log.isEmpty {
            let df = DateFormatter()
            // Pin en_US_POSIX (Apple QA1480): a fixed dateFormat without it is
            // reinterpreted for users who've toggled their 12/24-hour clock —
            // "H" can render as 12-hour or gain AM/PM, diverging from the web's
            // 24-hour getHours() string and breaking the byte-compatible
            // one-format-across-surfaces invariant this file promises. Timezone
            // stays device-local to match the web's local getHours()/getDate().
            df.locale = Locale(identifier: "en_US_POSIX")
            df.dateFormat = "M/d H:mm"
            let lines = log.map { t in
                "[\(df.string(from: Date(timeIntervalSince1970: t.ts / 1000)))] user: \(t.q)\n→ you: \(t.a)"
            }
            parts.append("## Continuous Turn Log (last \(log.count) turns, survives history clears):\n" + lines.joined(separator: "\n"))
        }

        return parts.joined(separator: "\n\n")
    }
}
