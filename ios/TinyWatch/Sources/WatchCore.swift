/**
 * WatchCore — pure logic extracted from WatchLink (W8): history building
 * and turn hygiene, testable without WatchConnectivity or UI.
 */
import Foundation

struct WatchTurn: Identifiable, Equatable, Codable {
    var id = UUID()
    let q: String
    var a: String
    var done = false
}

enum WatchCore {
    /// Converse-shaped history from prior turns: completed, non-error turns
    /// only, capped, as user/assistant text pairs. (Mirrors WatchLink.ask.)
    static func history(from turns: [WatchTurn], cap: Int = 10) -> [[String: Any]] {
        turns.suffix(cap).flatMap { t -> [[String: Any]] in
            guard t.done, !t.a.isEmpty, !t.a.hasPrefix("⚠️") else { return [] }
            return [["role": "user", "content": [["text": t.q]]],
                    ["role": "assistant", "content": [["text": t.a]]]]
        }
    }

    /// Restore hygiene: a turn killed mid-stream must not spin forever.
    static func sanitize(_ turns: [WatchTurn]) -> [WatchTurn] {
        turns.map { t in
            var t = t
            if !t.done {
                t.a = t.a.isEmpty ? "(interrupted)" : t.a
                t.done = true
            }
            return t
        }
    }

    /// Followup freshness window (W7): 30 minutes.
    static func isFresh(followupAt: Date?, now: Date = .now) -> Bool {
        guard let at = followupAt else { return false }
        return at > now.addingTimeInterval(-30 * 60)
    }

    /// Logout scrub: the identity fields a remote-logout context push must
    /// wipe from the widget snapshot so the prior user's memories/exchange/
    /// unread don't linger on complications that render without the app open
    /// (the phone's logout() scrubs its own state; the wrist mirror must too).
    /// Fleet counts (online/total/login) stay — they're not identity content
    /// and a stale count is harmless until the next push corrects it.
    static func loggedOut(_ snap: FleetSnapshot, now: Date) -> FleetSnapshot {
        var s = snap
        s.unread = 0
        s.memories = nil
        s.lastQ = nil; s.lastA = nil; s.lastAt = nil
        s.followup = nil; s.followupAt = nil
        s.updated = now
        return s
    }
}
