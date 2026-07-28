/**
 * WatchWidgets — tiny on the watch face (complications, WidgetKit).
 *
 * Circular (🌱 + devices online), rectangular (fleet + unread lines),
 * inline (one-liner), corner (count + unread label). Reads the same
 * app-group snapshot the watch app writes — freshened whenever the watch
 * app opens or the phone pushes a WatchConnectivity context update.
 */
import WidgetKit
import SwiftUI

struct WatchEntry: TimelineEntry {
    let date: Date
    let snap: FleetSnapshot
}

struct WatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchEntry {
        WatchEntry(date: .now, snap: FleetSnapshot(online: 2, total: 3, unread: 1, login: "you", updated: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (WatchEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context)
                                     : WatchEntry(date: .now, snap: WidgetStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<WatchEntry>) -> Void) {
        let snap = WidgetStore.read()
        var entries = [WatchEntry(date: .now, snap: snap)]
        // W7: the followup chip is tappable for only 30 min (FollowupView gates
        // on WatchCore.isFresh). WidgetKit freezes a rendered entry until its
        // next reload — and any unrelated snapshot push (fleet/unread change)
        // re-anchors the .after(+30min) policy past the followup's real expiry,
        // leaving a STALE chip visible AND tappable (the intent asks an old
        // suggestion). Emit a second entry AT the expiry so the decayed state
        // renders deterministically at the boundary, independent of when the
        // last reload happened. FollowupView keys isFresh off entry.date so this
        // second entry evaluates as decayed.
        if let at = snap.followupAt, let f = snap.followup, !f.isEmpty {
            let expiry = at.addingTimeInterval(30 * 60)
            if expiry > .now { entries.append(WatchEntry(date: expiry, snap: snap)) }
        }
        completion(Timeline(entries: entries, policy: .after(.now + 30 * 60)))
    }

    /// Smart Stack: tiny surfaces itself when something needs eyes —
    /// unread DMs OR a fleet device dropping offline (W4). Re-evaluated
    /// whenever the app/phone reloads timelines with new data.
    func relevance() async -> WidgetRelevance<Void> {
        let snap = WidgetStore.read()
        let fresh = snap.updated > Date(timeIntervalSinceNow: -3600)
        let deviceDown = fresh && snap.total > 0 && snap.online < snap.total
        guard snap.unread > 0 || deviceDown else { return WidgetRelevance([]) }
        return WidgetRelevance([
            WidgetRelevanceAttribute(context: .date(from: .now, to: .now.addingTimeInterval(3600))),
        ])
    }
}

struct TinyComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchEntry

    private var stale: Bool {
        entry.snap.updated < Date(timeIntervalSinceNow: -3 * 3600)
    }

    private var accent: Color { entry.snap.accentColor }

    var body: some View {
        Group {
            switch family {
            case .accessoryCorner: corner
            case .accessoryInline: inline
            case .accessoryRectangular: rectangular
            default: circular
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stale ? "tiny: open the app to sync"
                            : "tiny: \(entry.snap.online) of \(entry.snap.total) devices online, \(entry.snap.unread) unread messages")
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Text("🌱").font(.caption2)
                Text(stale ? "–" : "\(entry.snap.online)")
                    .font(.system(.title3, design: .rounded).weight(.bold))
            }
        }
    }

    private var corner: some View {
        Text("🌱")
            .font(.title3)
            .widgetLabel {
                Text(stale ? "open tiny" : "🟢\(entry.snap.online) 💬\(entry.snap.unread)")
            }
    }

    private var inline: some View {
        Text(stale ? "🌱 tiny" : "🌱 \(entry.snap.online) online · 💬 \(entry.snap.unread)")
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("🌱 tiny")
                .font(.headline)
                .foregroundStyle(accent)
            if stale {
                Text("open tiny to sync").font(.caption2).foregroundStyle(.secondary)
            } else {
                Text("🟢 \(entry.snap.online)/\(entry.snap.total) devices")
                    .font(.caption)
                Text(entry.snap.unread > 0 ? "💬 \(entry.snap.unread) unread" : "💬 inbox clear")
                    .font(.caption)
                    .foregroundStyle(entry.snap.unread > 0 ? accent : Color.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TinyComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyComplication", provider: WatchProvider()) { entry in
            TinyComplicationView(entry: entry)
        }
        .configurationDisplayName("tiny")
        .description("Fleet online + unread messages on the watch face.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
    }
}

// ── 💬 Last answer — the newest reply lives on the watch face ─────────────

struct LastAnswerView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchEntry

    private var hasAnswer: Bool { !(entry.snap.lastA ?? "").isEmpty }
    private var accent: Color { entry.snap.accentColor }

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular: rectangular
            default: inline
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hasAnswer
            ? "tiny's last answer: \(entry.snap.lastA ?? "")"
            : "tiny: no conversations yet")
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if hasAnswer {
                Text(entry.snap.lastQ ?? "")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(accent)
                    .lineLimit(1)
                Text(entry.snap.lastA ?? "")
                    .font(.caption2)
                    .lineLimit(2)
                if let at = entry.snap.lastAt {
                    Text(at, style: .relative)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("🌱 tiny").font(.headline).foregroundStyle(accent)
                Text("Ask anything — the answer\nlands here.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inline: some View {
        Text(hasAnswer ? "🌱 \(entry.snap.lastA ?? "")" : "🌱 ask tiny")
    }
}

struct LastAnswerComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyLastAnswer", provider: WatchProvider()) { entry in
            LastAnswerView(entry: entry)
        }
        .configurationDisplayName("Last answer")
        .description("tiny's newest reply, right on the face.")
        .supportedFamilies([.accessoryRectangular, .accessoryInline])
    }
}

// ── 🎙️ Ask tiny — one-tap launcher from the face ──────────────────────────

struct AskTinyView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCorner:
                Image(systemName: "mic.fill")
                    .font(.title3)
                    .foregroundStyle(entry.snap.accentColor)
                    .widgetLabel { Text("ask tiny") }
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: -1) {
                        Image(systemName: "mic.fill").font(.caption)
                        Text("ask").font(.system(size: 9, weight: .semibold))
                    }
                }
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .accessibilityLabel("Ask tiny")
    }
}

struct AskTinyComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyAsk", provider: WatchProvider()) { entry in
            AskTinyView(entry: entry)
        }
        .configurationDisplayName("Ask tiny")
        .description("One tap from the face into the mic.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

// ── ⚡ Briefing — interactive: runs the prompt FROM the face (W3) ──────────

struct BriefingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCorner:
                Button(intent: BriefingIntent()) {
                    Image(systemName: "bolt.fill")
                        .font(.title3)
                        .foregroundStyle(entry.snap.accentColor)
                }
                .buttonStyle(.plain)
                .widgetLabel { Text("briefing") }
            default:
                Button(intent: BriefingIntent()) {
                    ZStack {
                        AccessoryWidgetBackground()
                        VStack(spacing: -1) {
                            Image(systemName: "bolt.fill").font(.caption)
                            Text("brief").font(.system(size: 8, weight: .semibold))
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .accessibilityLabel("Run tiny briefing")
        .accessibilityHint("Asks your briefing question; the answer appears in the Last answer complication")
    }
}

struct BriefingComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyBriefing", provider: WatchProvider()) { entry in
            BriefingView(entry: entry)
        }
        .configurationDisplayName("Briefing")
        .description("One tap runs your briefing — the answer lands in Last answer. No app open.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

// ── 🧠 Memories glance — remembered facts rotate on the face (W5) ─────────

struct MemoryEntryW: TimelineEntry {
    let date: Date
    let content: String
    let accent: Color
    let index: Int
    let total: Int
}

struct MemoryProvider: TimelineProvider {
    func placeholder(in context: Context) -> MemoryEntryW {
        MemoryEntryW(date: .now, content: "Your remembered facts rotate here.", accent: .green, index: 1, total: 3)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (MemoryEntryW) -> Void) {
        completion(firstEntry())
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<MemoryEntryW>) -> Void) {
        // Continuity's store is a plain JSON file — readable off the widget
        // process (same container: the app group is the watch app's sandbox
        // sibling; Continuity writes to Documents which the extension can't
        // see, so memories ride the snapshot instead)
        let snap = WidgetStore.read()
        let mems = snap.memories ?? []
        let accent = snap.accentColor
        guard !mems.isEmpty else {
            completion(Timeline(entries: [MemoryEntryW(date: .now, content: "Tell tiny to remember things — they rotate here.", accent: accent, index: 0, total: 0)], policy: .after(.now + 3600)))
            return
        }
        // Rotate: one entry per 20 min through up to 12 memories
        let slice = Array(mems.suffix(12))
        let entries = slice.enumerated().map { i, m in
            MemoryEntryW(date: .now + TimeInterval(i * 20 * 60),
                         content: m, accent: accent, index: i + 1, total: slice.count)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    private func firstEntry() -> MemoryEntryW {
        let snap = WidgetStore.read()
        let mems = snap.memories ?? []
        return MemoryEntryW(date: .now,
                            content: mems.last ?? "Tell tiny to remember things.",
                            accent: snap.accentColor, index: mems.isEmpty ? 0 : 1, total: mems.count)
    }
}

struct MemoryGlanceView: View {
    let entry: MemoryEntryW

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                Image(systemName: "brain")
                    .font(.system(size: 9))
                    .foregroundStyle(entry.accent)
                Text("memory")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(entry.accent)
                Spacer()
                if entry.total > 1 {
                    Text("\(entry.index)/\(entry.total)")
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                }
            }
            Text(entry.content)
                .font(.caption2)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.black }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("tiny memory: \(entry.content)")
    }
}

struct MemoryGlanceComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyMemoryGlance", provider: MemoryProvider()) { entry in
            MemoryGlanceView(entry: entry)
        }
        .configurationDisplayName("Memories")
        .description("Your remembered facts rotate on the face.")
        .supportedFamilies([.accessoryRectangular])
    }
}

// ── 💡 Followup — the agent's suggested next question, tappable (W7) ──────

struct FollowupView: View {
    let entry: WatchEntry

    private var freshFollowup: String? {
        // Evaluate freshness against THIS entry's date, not wall-clock: WidgetKit
        // freezes a rendered entry, so a bare .now here can't decay the chip on
        // schedule. The provider emits an entry AT the 30-min expiry (entry.date)
        // so that render evaluates as decayed and the button disappears on time.
        guard let f = entry.snap.followup, !f.isEmpty,
              WatchCore.isFresh(followupAt: entry.snap.followupAt, now: entry.date) else { return nil }
        return f
    }

    var body: some View {
        Group {
            if let chip = freshFollowup {
                Button(intent: FollowupIntent()) {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 3) {
                            Image(systemName: "lightbulb.fill")
                                .font(.system(size: 9))
                            Text("tap to ask")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .foregroundStyle(entry.snap.accentColor)
                        Text(chip)
                            .font(.caption2)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Ask tiny's suggestion: \(chip)")
            } else {
                // Decayed: useful fallback instead of a dead tile
                VStack(alignment: .leading, spacing: 1) {
                    Text("🌱 tiny")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(entry.snap.accentColor)
                    Text("Chat on the wrist — suggestions\nland here, tappable.")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .containerBackground(for: .widget) { Color.black }
    }
}

struct FollowupComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyFollowup", provider: WatchProvider()) { entry in
            FollowupView(entry: entry)
        }
        .configurationDisplayName("Suggestion")
        .description("tiny's suggested next question — tap the face to ask it.")
        .supportedFamilies([.accessoryRectangular])
    }
}

@main
struct TinyWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        TinyComplication()
        LastAnswerComplication()
        AskTinyComplication()
        BriefingComplication()
        MemoryGlanceComplication()
        FollowupComplication()
    }
}
