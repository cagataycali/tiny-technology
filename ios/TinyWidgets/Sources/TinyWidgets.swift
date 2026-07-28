/**
 * TinyWidgets — home-screen + lock-screen presence for the fleet.
 *
 * One widget, three faces: systemSmall (🌱 fleet + unread card),
 * accessoryRectangular (lock screen line), accessoryCircular (online count
 * ring). Data comes from the app-group snapshot the app's heartbeat loops
 * publish — the widget itself never touches the network or credentials.
 */
import WidgetKit
import SwiftUI
import AppIntents

struct TinyEntry: TimelineEntry {
    let date: Date
    let snap: FleetSnapshot
}

struct TinyProvider: TimelineProvider {
    func placeholder(in context: Context) -> TinyEntry {
        TinyEntry(date: .now, snap: FleetSnapshot(online: 2, total: 3, unread: 1, login: "you", updated: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TinyEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context)
                                     : TinyEntry(date: .now, snap: WidgetStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TinyEntry>) -> Void) {
        // The app pushes reloads on every data change; this schedule is just
        // the fallback so a silent app still ages the "stale" hint honestly
        let entry = TinyEntry(date: .now, snap: WidgetStore.read())
        completion(Timeline(entries: [entry], policy: .after(.now + 30 * 60)))
    }
}

struct TinyStatusView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TinyEntry

    private var stale: Bool {
        entry.snap.updated < Date(timeIntervalSinceNow: -2 * 3600)
    }

    private var accent: Color { entry.snap.accentColor }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            default: small
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stale ? "tiny: open the app to sync"
                            : "tiny: \(entry.snap.online) of \(entry.snap.total) devices online, \(entry.snap.unread) unread messages")
        // Tap lands where the glance points: unread → Messages, else chat
        .widgetURL(URL(string: entry.snap.unread > 0 ? "tinyapp://messages" : "tinyapp://ask"))
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("🌱")
                Text("tiny")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                    .foregroundStyle(accent)
                Spacer()
            }
            Spacer()
            if stale {
                Text("Open tiny to sync")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 5) {
                    Circle().fill(entry.snap.online > 0 ? accent : Color.gray)
                        .frame(width: 8, height: 8)
                    Text("\(entry.snap.online)/\(entry.snap.total) online")
                        .font(.caption.weight(.medium))
                }
                HStack(spacing: 5) {
                    Text("💬")
                    Text(entry.snap.unread > 0 ? "\(entry.snap.unread) unread" : "no unread")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(entry.snap.unread > 0 ? accent : Color.secondary)
                }
            }
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("🌱 tiny")
                .font(.headline)
            Text(stale ? "open to sync"
                       : "🟢 \(entry.snap.online)/\(entry.snap.total) · 💬 \(entry.snap.unread)")
                .font(.caption)
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text("🌱").font(.caption2)
                Text(stale ? "–" : "\(entry.snap.online)")
                    .font(.system(.title3, design: .rounded).weight(.bold))
            }
        }
    }
}

struct TinyStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyStatus", provider: TinyProvider()) { entry in
            TinyStatusView(entry: entry)
                .containerBackground(for: .widget) { Color.black }
        }
        .configurationDisplayName("tiny fleet")
        .description("Devices online and unread messages, at a glance.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

/// One-tap voice question — home or lock screen straight into the open mic.
struct TinyAskView: View {
    @Environment(\.widgetFamily) private var family
    var entry: TinyEntry?

    private var accent: Color { entry?.snap.accentColor ?? .green }

    var body: some View {
        Group {
            if family == .accessoryCircular {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "mic.fill").font(.title3)
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(accent)
                    Text("ask tiny")
                        .font(.system(.subheadline, design: .rounded).weight(.bold))
                        .foregroundStyle(accent)
                    Text("tap · speak · 3s pause sends")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ask tiny by voice")
        .widgetURL(URL(string: "tinyapp://voice"))
    }
}

struct TinyAskWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TinyAsk", provider: TinyProvider()) { entry in
            TinyAskView(entry: entry)
                .containerBackground(for: .widget) { Color.black }
        }
        .configurationDisplayName("ask tiny")
        .description("One tap opens voice mode — speak, pause, sent.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

// ── Control Center / lock screen / Action-button control ──────────────────

/// Runs in the widget-extension process; opening the app + deep link is the
/// whole job (voice mode starts via the existing tinyapp://voice route).
struct OpenVoiceModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask tiny by voice"
    static let description = IntentDescription("Open tiny with the mic listening.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(URL(string: "tinyapp://voice")!))
    }
}

struct TinyAskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "TinyAskControl") {
            ControlWidgetButton(action: OpenVoiceModeIntent()) {
                Label("Ask tiny", systemImage: "leaf.fill")
            }
        }
        .displayName("Ask tiny")
        .description("One tap: tiny opens listening — speak, pause, sent.")
    }
}

@main
struct TinyWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentLiveWidget()
        TinyStatusWidget()
        TinyAskWidget()
        TinyAskControl()
        PhoneBriefingWidget()
        PhoneLastAnswerWidget()
        PhoneMemoryWidget()
    }
}
