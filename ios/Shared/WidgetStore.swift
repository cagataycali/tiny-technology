/**
 * WidgetStore — the app↔widget bridge. One JSON snapshot in the shared
 * app-group defaults; the APP is the only writer (its heartbeat/unread
 * loops know the truth), the widget extension only reads. Compiled into
 * BOTH targets (see project.yml sources).
 */
import Foundation
import SwiftUI

// ── Color from web theme hex (#RGB / #RRGGBB) — every target renders it ───

extension Color {
    static func fromHex(_ hex: String) -> Color? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt64(s, radix: 16) else { return nil }
        return Color(red: Double((v >> 16) & 0xFF) / 255,
                     green: Double((v >> 8) & 0xFF) / 255,
                     blue: Double(v & 0xFF) / 255)
    }
}

struct FleetSnapshot: Codable, Equatable {
    var online = 0
    var total = 0
    var unread = 0
    var login = ""
    var updated = Date.distantPast
    /// Theme accent hex (optional: snapshots from older builds lack it)
    var accentHex: String?
    /// Last exchange (watch writes after each turn) — powers the
    /// "last answer" complication so the wrist face shows the newest reply
    var lastQ: String?
    var lastA: String?
    var lastAt: Date?
    /// Memory contents for the Memories glance complication (W5) — the
    /// extension can't read the app's Documents, so they ride the snapshot
    var memories: [String]?
    /// Top suggest_followups chip from the last turn (W7) — becomes an
    /// interactive face button for 30 minutes, then decays
    var followup: String?
    var followupAt: Date?
}

extension FleetSnapshot {
    var accentColor: Color { accentHex.flatMap(Color.fromHex) ?? .green }
}

enum WidgetStore {
    static let suite = "group.technology.tiny.app"
    private static let key = "fleet_snapshot"

    static func read() -> FleetSnapshot {
        guard let d = UserDefaults(suiteName: suite)?.data(forKey: key),
              let s = try? JSONDecoder().decode(FleetSnapshot.self, from: d) else { return FleetSnapshot() }
        return s
    }

    static func write(_ snap: FleetSnapshot) {
        if let d = try? JSONEncoder().encode(snap) {
            UserDefaults(suiteName: suite)?.set(d, forKey: key)
        }
    }
}
