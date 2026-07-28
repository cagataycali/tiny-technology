/**
 * TinyDesign — the app's own design language, one place.
 *
 * Rules of the house:
 *   - CHROME speaks SF Symbols (toolbars, nav titles, buttons). Emojis are
 *     personality and belong to CONTENT (messages, empty states, the mark).
 *   - Every shared surface wears the same card chrome (.tinyCard()) —
 *     14pt radius, secondary background, accent hairline.
 *   - Gestures feel physical: soft haptic on drawer opens, edge swipes
 *     mirror the toolbar so nothing needs a reach.
 *   - The tiny's accent (Environment(\.tinyAccent)) is the ONLY brand color;
 *     green is just its default.
 */
import SwiftUI
import UIKit

enum TinyDesign {
    // ── Iconography (chrome only — never emoji) ────────────────────────────
    static let iconUniverse = "circle.hexagongrid"
    static let iconMessages = "bubble.left.and.bubble.right"
    static let iconNearby = "dot.radiowaves.left.and.right"
    static let iconJobs = "clock"
    static let iconMemory = "brain"
    static let iconDevices = "iphone.radiowaves.left.and.right"
    static let iconSettings = "gearshape"
    static let iconRelay = "antenna.radiowaves.left.and.right"

    /// Soft impact for fluent moments (edge-swipe opens, long-press actions)
    @MainActor
    static func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .soft) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}

/// Online/enabled/live status shown as an SF Symbol dot, not a 🟢/⚪️ emoji.
/// Two wins over the emoji: (1) it carries an .accessibilityLabel so VoiceOver
/// says "online"/"offline" instead of "green circle"; (2) filled-vs-hollow is
/// a shape difference, so it survives color-blindness and the forced dark
/// theme — color alone was the only signal before. Chrome speaks SF Symbols.
struct StatusDot: View {
    let on: Bool
    /// What the state means, spoken by VoiceOver (e.g. "online"/"offline").
    var onLabel = "on"
    var offLabel = "off"

    var body: some View {
        Image(systemName: on ? "circle.fill" : "circle")
            .font(.caption2)
            .foregroundStyle(on ? Color.green : Color.secondary)
            .accessibilityLabel(on ? onLabel : offLabel)
    }
}

/// The one card chrome — speech cards, charts, doc chips' container, relay
/// history rows all share it so the app reads as a single system.
struct TinyCard: ViewModifier {
    @Environment(\.tinyAccent) private var accent

    func body(content: Content) -> some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(accent.opacity(0.15), lineWidth: 1))
    }
}

extension View {
    func tinyCard() -> some View { modifier(TinyCard()) }
}
