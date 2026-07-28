/**
 * ContentWidgets — R1/R2/R3: the phone home screen catches up to the
 * watch face. Three widgets off the shared snapshot:
 *   - ⚡ Briefing (interactive, systemSmall + lock circular): runs the
 *     briefing prompt headless via PhoneBriefingIntent
 *   - 💬 Last answer (systemMedium + lock rectangular): newest exchange
 *   - 🧠 Memories (systemMedium): remembered facts rotate every 20 min
 */
import WidgetKit
import SwiftUI
import AppIntents

// ── ⚡ Briefing (interactive) ───────────────────────────────────────────────

/// Phone twin of the watch BriefingIntent: headless ask, answer lands in
/// the snapshot (Last-answer widget shows it), no app launch.
struct PhoneBriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "tiny briefing"
    static let description = IntentDescription(
        "Run your briefing prompt without opening the app.",
        categoryName: "Chat"
    )
    static let openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        guard let token = Keychain.get("tiny_token") else { return .result() }
        let prompt = UserDefaults(suiteName: WidgetStore.suite)?.string(forKey: "watch_briefing_prompt")
            ?? "Give me a tiny briefing: anything new, plus one useful or interesting thing. 2 sentences max."
        let continuity = await MainActor.run { Continuity.buildContext(Config.tinyName) }
        let answer = (try? await Api.chatOnce(
            token: token,
            message: "[Briefing widget on iPhone — answer in 1-2 short sentences, no markdown] \(prompt)",
            tiny: Config.tinyName,
            extraSystem: continuity
        )) ?? ""
        let clean = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return .result() }
        var snap = WidgetStore.read()
        snap.lastQ = "briefing"
        snap.lastA = String(clean.prefix(160))
        snap.lastAt = Date()
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
        await MainActor.run { Continuity.appendTurn(Config.tinyName, q: prompt, a: clean) }
        return .result()
    }
}

struct PhoneBriefingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TinyEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                Button(intent: PhoneBriefingIntent()) {
                    ZStack {
                        AccessoryWidgetBackground()
                        VStack(spacing: -1) {
                            Image(systemName: "bolt.fill").font(.caption)
                            Text("brief").font(.system(size: 8, weight: .semibold))
                        }
                    }
                }
                .buttonStyle(.plain)
            default:
                Button(intent: PhoneBriefingIntent()) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 5) {
                            Image(systemName: "bolt.fill")
                                .foregroundStyle(entry.snap.accentColor)
                            Text("briefing")
                                .font(.system(.headline, design: .rounded).weight(.bold))
                                .foregroundStyle(entry.snap.accentColor)
                            Spacer()
                        }
                        Spacer()
                        Text("Tap to run — the answer\nlands in Last answer.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .accessibilityLabel("Run tiny briefing")
    }
}

struct PhoneBriefingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyPhoneBriefing", provider: TinyProvider()) { entry in
            PhoneBriefingView(entry: entry)
        }
        .configurationDisplayName("Briefing")
        .description("One tap runs your briefing — no app open.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

// ── 💬 Last answer ──────────────────────────────────────────────────────────

struct PhoneLastAnswerView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TinyEntry

    private var hasAnswer: Bool { !(entry.snap.lastA ?? "").isEmpty }

    var body: some View {
        Group {
            if family == .accessoryRectangular {
                lockRect
            } else {
                medium
            }
        }
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "tinyapp://ask"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hasAnswer ? "tiny's last answer: \(entry.snap.lastA ?? "")" : "tiny: no conversations yet")
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Text("🌱")
                Text(hasAnswer ? (entry.snap.lastQ ?? "") : "tiny")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.snap.accentColor)
                    .lineLimit(1)
                Spacer()
                if let at = entry.snap.lastAt {
                    Text(at, style: .relative)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            if hasAnswer {
                Text(entry.snap.lastA ?? "")
                    .font(.caption)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("Ask anything — the newest answer lives here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
    }

    private var lockRect: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(hasAnswer ? (entry.snap.lastQ ?? "") : "🌱 tiny")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(entry.snap.accentColor)
                .lineLimit(1)
            Text(hasAnswer ? (entry.snap.lastA ?? "") : "ask anything")
                .font(.caption2)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PhoneLastAnswerWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyPhoneLastAnswer", provider: TinyProvider()) { entry in
            PhoneLastAnswerView(entry: entry)
        }
        .configurationDisplayName("Last answer")
        .description("tiny's newest reply on your home screen.")
        .supportedFamilies([.systemMedium, .accessoryRectangular])
    }
}

// ── 🧠 Memories ─────────────────────────────────────────────────────────────

struct PhoneMemoryEntry: TimelineEntry {
    let date: Date
    let content: String
    let accent: Color
    let index: Int
    let total: Int
}

struct PhoneMemoryProvider: TimelineProvider {
    func placeholder(in context: Context) -> PhoneMemoryEntry {
        PhoneMemoryEntry(date: .now, content: "Your remembered facts rotate here.", accent: .green, index: 1, total: 3)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (PhoneMemoryEntry) -> Void) {
        let snap = WidgetStore.read()
        completion(PhoneMemoryEntry(date: .now,
                                    content: snap.memories?.last ?? "Tell tiny to remember things.",
                                    accent: snap.accentColor,
                                    index: (snap.memories?.isEmpty ?? true) ? 0 : 1,
                                    total: snap.memories?.count ?? 0))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<PhoneMemoryEntry>) -> Void) {
        let snap = WidgetStore.read()
        let mems = snap.memories ?? []
        let accent = snap.accentColor
        guard !mems.isEmpty else {
            completion(Timeline(entries: [PhoneMemoryEntry(date: .now, content: "Tell tiny to remember things — they rotate here.", accent: accent, index: 0, total: 0)], policy: .after(.now + 3600)))
            return
        }
        let slice = Array(mems.suffix(12))
        let entries = slice.enumerated().map { i, m in
            PhoneMemoryEntry(date: .now + TimeInterval(i * 20 * 60), content: m, accent: accent, index: i + 1, total: slice.count)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct PhoneMemoryView: View {
    let entry: PhoneMemoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Image(systemName: "brain")
                    .font(.caption)
                    .foregroundStyle(entry.accent)
                Text("memory")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.accent)
                Spacer()
                if entry.total > 1 {
                    Text("\(entry.index)/\(entry.total)")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            Text(entry.content)
                .font(.caption)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "tinyapp://memory"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("tiny memory: \(entry.content)")
    }
}

struct PhoneMemoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyPhoneMemory", provider: PhoneMemoryProvider()) { entry in
            PhoneMemoryView(entry: entry)
        }
        .configurationDisplayName("Memories")
        .description("Your remembered facts rotate on the home screen.")
        .supportedFamilies([.systemMedium])
    }
}
