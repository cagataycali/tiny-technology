/**
 * 💬 StickySay — put words on the Sticky's glass, straight from the phone.
 *
 * The firmware gives two doors (tiny_node.cpp dispatch, read 2026-08-26):
 *
 *   say <text>          → text card titled "tiny", ack chime. Zero parsing
 *                         risk — the text rides raw after the verb.
 *   render_ui {json}    → the same card with OUR title. The body goes
 *                         through JSON, so it is built with a real
 *                         serializer, never string interpolation: a quote
 *                         in a sentence must not become a wire error.
 *
 * `StickySayCard.command` picks the door: no title = `say` (the simpler,
 * unbreakable path), title = `render_ui`. Pure, so the choice is a test.
 *
 * History keeps the LAST FIVE sends per device — a fridge message is
 * usually one of the same few ("dinner's ready", "call me"), and retyping
 * on glass-latency round trips is the thing this composer exists to kill.
 * Tap an entry to reload it into the fields; the send itself stays one
 * explicit button. Stored in UserDefaults keyed by device id: fridge
 * phrases are not secrets, and a Keychain round-trip for them is ceremony.
 */
import SwiftUI

// ── Command building (pure — unit-testable) ──────────────────────────────────

enum StickySayCard {
    /// Longest body the composer will send. The relay payload cap is 8000B;
    /// the PANEL is the real limit — a 4-gray 800×480 text card holds a few
    /// hundred readable characters, and silently scrolling is not a thing
    /// e-ink does. Refuse with the count rather than truncate: a fridge note
    /// with its ending cut off reads as an accident.
    static let maxChars = 500

    /// The refusal, or nil when it fits — the DmMedia wording pattern.
    static func refusal(_ text: String) -> String? {
        let n = text.count
        guard n > maxChars else { return nil }
        return "That's \(n) characters — the glass card fits \(maxChars). Nothing was sent."
    }

    /// The exact relay prompt for (text, title). Nil only when the text is
    /// empty after trimming — the caller's button should already be disabled.
    static func command(text: String, title: String) -> String? {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return nil }
        let head = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if head.isEmpty { return "say \(body)" }
        // A real serializer, not interpolation: the title and body are the
        // user's own words, quotes and all.
        let spec: [String: String] = [
            "type": "text", "card_id": "say", "title": head, "body": body,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: spec,
                                                     options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return "render_ui \(json)"
    }
}

// ── History (pure core + a UserDefaults skin) ────────────────────────────────

struct StickySayEntry: Codable, Equatable, Identifiable {
    let text: String
    let title: String
    let stamp: Date
    var id: String { "\(title)|\(text)" }
}

enum StickySayHistory {
    static let cap = 5

    /// Newest first, deduped by (title, text) — resending "dinner's ready"
    /// moves it to the top rather than filling all five slots with it.
    static func pushed(_ list: [StickySayEntry], _ entry: StickySayEntry) -> [StickySayEntry] {
        var out = list.filter { !($0.text == entry.text && $0.title == entry.title) }
        out.insert(entry, at: 0)
        return Array(out.prefix(cap))
    }

    private static func key(_ deviceId: String) -> String { "sticky.say.\(deviceId)" }

    static func load(_ deviceId: String) -> [StickySayEntry] {
        guard let data = UserDefaults.standard.data(forKey: key(deviceId)),
              let list = try? JSONDecoder().decode([StickySayEntry].self, from: data)
        else { return [] }
        return list
    }

    static func save(_ list: [StickySayEntry], deviceId: String) {
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: key(deviceId))
        }
    }
}

// ── The composer view ────────────────────────────────────────────────────────

struct StickySayComposer: View {
    let deviceId: String
    let deviceName: String
    let token: String?
    /// Re-mirror after the glass changed — same contract as the image sender.
    var onGlassChanged: (() async -> Void)?

    @State private var title = ""
    @State private var text = ""
    @State private var busy = false
    @State private var note: String?
    @State private var history: [StickySayEntry] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Title (optional — plain say without one)", text: $title)
                .font(.caption)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 6) {
                TextField("Words for the glass…", text: $text, axis: .vertical)
                    .font(.caption)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1 ... 4)
                    .submitLabel(.send)
                    .onSubmit { Task { await send() } }
                Button("Send") { Task { await send() } }
                    .font(.caption2)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let note {
                Text(note)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !history.isEmpty {
                ForEach(history) { e in
                    Button {
                        title = e.title
                        text = e.text
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.system(size: 9))
                            Text(e.title.isEmpty ? e.text : "\(e.title): \(e.text)")
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Reload \"\(e.text)\" into the composer")
                }
            }
        }
        .onAppear { history = StickySayHistory.load(deviceId) }
    }

    private func send() async {
        guard !busy else { return }
        if let refusal = StickySayCard.refusal(text) {
            note = refusal
            return
        }
        guard let cmd = StickySayCard.command(text: text, title: title) else { return }
        busy = true
        note = nil
        defer { busy = false }
        switch await StickyRelay.invoke(cmd, deviceId: deviceId,
                                        deviceName: deviceName, token: token) {
        case .refused(let why):
            note = why
        case .answered(let payload):
            note = RelayReply.text(payload)
            history = StickySayHistory.pushed(
                history,
                StickySayEntry(text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                               title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                               stamp: Date()))
            StickySayHistory.save(history, deviceId: deviceId)
            text = ""
            // The glass takes its 1-2s full refresh before a mirror can show
            // the card rather than the wipe.
            try? await Task.sleep(for: .seconds(2))
            await onGlassChanged?()
        }
    }
}
