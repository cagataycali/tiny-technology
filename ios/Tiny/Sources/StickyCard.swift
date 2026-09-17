/**
 * 🃏 StickyCard — a native composer for the Sticky's card grammar.
 *
 * The glass renders JSON card specs (tiny_display.cpp, grammar v4 — read
 * 2026-08-26):
 *
 *   text  {title, body}
 *   list  {title, items:["…", …]}
 *   kv    {title, rows:{"k":"v", …}}
 *   chart {title, data:[n,…], labels?:["…"], style?:"bar"|"line"}
 *   + optional on ANY card: buttons:["Yes","No", …]  (max 4, bottom touch
 *     bar — taps come back as ui_tap events with the card_id)
 *
 * The composer is a FORM, not a JSON editor: the phone's keyboard writes
 * lines, and pure functions turn lines into the spec — one item per line
 * for a list, `key: value` per line for kv, comma-separated numbers for a
 * chart. Everything the firmware will parse with cJSON is built with a
 * real serializer here; nothing is interpolated (StickySay's rule).
 *
 * Refusals are sentences with numbers in them (the house rule): a fifth
 * button names the four-slot bar, an unparseable chart line echoes the
 * token that refused, an empty card says which field it needs. Nothing is
 * silently dropped — a card the user watched themselves compose must reach
 * the glass whole or not at all (DmMedia rule 1, same reason).
 */
import SwiftUI

// ── The draft and its pure compiler ──────────────────────────────────────────

enum StickyCardKind: String, CaseIterable, Identifiable {
    case text, list, kv, chart
    var id: String { rawValue }
}

struct StickyCardDraft: Equatable {
    var kind: StickyCardKind = .text
    var title = ""
    /// text: the body. list: one item per line. kv: `key: value` per line.
    /// chart: comma/space-separated numbers, optional `label` after each
    /// number as `label=value`? No — labels ride a second line (see labels).
    var content = ""
    /// chart only: one label per data point, comma-separated. Optional.
    var labels = ""
    /// Comma-separated button captions — the bottom touch bar, max 4.
    var buttons = ""
}

enum StickyCardSpec {
    static let maxButtons = 4

    /// A compiled thing or the sentence refusing it. A plain enum, NOT
    /// Result<_, String>: a refusal here is panel copy, not an Error, and
    /// String-as-Error has bitten this codebase before (the compiler agrees —
    /// String doesn't conform, on purpose).
    enum Outcome<T> {
        case ok(T)
        case refused(String)
    }

    /// list lines → items. Blank lines are line-spacing, not empty bullets.
    static func items(_ content: String) -> [String] {
        content.split(separator: "\n").map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
    }

    /// kv lines → ordered pairs, split on the FIRST colon — values keep
    /// theirs ("time: 09:30" is a pair, not three fragments).
    static func rows(_ content: String) -> [[String]] {
        items(content).compactMap { line in
            guard let colon = line.firstIndex(of: ":") else { return nil }
            let k = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let v = String(line[line.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            guard !k.isEmpty else { return nil }
            return [k, v]
        }
    }

    /// chart content → numbers, or the token that refused to be one.
    static func data(_ content: String) -> Outcome<[Double]> {
        let tokens = content.split(whereSeparator: { ", \n".contains($0) })
            .map(String.init)
        guard !tokens.isEmpty else { return .refused("no numbers yet") }
        var out: [Double] = []
        for t in tokens {
            guard let n = Double(t) else {
                return .refused("\"\(t)\" isn't a number — chart data is numbers separated by commas or spaces.")
            }
            out.append(n)
        }
        return .ok(out)
    }

    static func buttonList(_ buttons: String) -> [String] {
        buttons.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
    }

    /// The compiled `render_ui …` prompt, or the sentence explaining why not.
    static func compile(_ d: StickyCardDraft) -> Outcome<String> {
        var spec: [String: Any] = ["type": d.kind.rawValue, "card_id": "ios"]
        let title = d.title.trimmingCharacters(in: .whitespaces)
        if !title.isEmpty { spec["title"] = title }

        switch d.kind {
        case .text:
            let body = d.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty else { return .refused("A text card needs a body.") }
            spec["body"] = body
        case .list:
            let list = items(d.content)
            guard !list.isEmpty else {
                return .refused("A list card needs items — one per line.")
            }
            spec["items"] = list
        case .kv:
            let pairs = rows(d.content)
            guard !pairs.isEmpty else {
                return .refused("A kv card needs rows — `key: value`, one per line.")
            }
            // Pairs, not a dictionary: the firmware takes [["k","v"],…] too,
            // and a dictionary would shuffle the user's row order.
            spec["rows"] = pairs
        case .chart:
            switch data(d.content) {
            case .refused(let why): return .refused(why)
            case .ok(let numbers):
                spec["data"] = numbers
                let l = buttonListStyleLabels(d.labels)
                if !l.isEmpty {
                    guard l.count == numbers.count else {
                        return .refused("\(l.count) labels for \(numbers.count) data points — give one per point, or none.")
                    }
                    spec["labels"] = l
                }
            }
        }

        let taps = buttonList(d.buttons)
        if taps.count > maxButtons {
            return .refused("\(taps.count) buttons — the touch bar holds \(maxButtons).")
        }
        if !taps.isEmpty { spec["buttons"] = taps }

        guard let json = try? JSONSerialization.data(withJSONObject: spec,
                                                     options: [.sortedKeys]),
              let s = String(data: json, encoding: .utf8) else {
            return .refused("Couldn't serialize that card.")
        }
        return .ok("render_ui \(s)")
    }

    private static func buttonListStyleLabels(_ labels: String) -> [String] {
        buttonList(labels)
    }
}

// ── The composer view ────────────────────────────────────────────────────────

struct StickyCardComposer: View {
    let deviceId: String
    let deviceName: String
    let token: String?
    var onGlassChanged: (() async -> Void)?

    @State private var draft = StickyCardDraft()
    @State private var busy = false
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("", selection: $draft.kind) {
                ForEach(StickyCardKind.allCases) { k in
                    Text(k.rawValue).tag(k)
                }
            }
            .pickerStyle(.segmented)
            .controlSize(.mini)

            TextField("Title (optional)", text: $draft.title)
                .font(.caption)
                .textFieldStyle(.roundedBorder)

            TextField(contentHint, text: $draft.content, axis: .vertical)
                .font(.caption)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2 ... 6)

            if draft.kind == .chart {
                TextField("Labels (optional, one per point: mon, tue, wed)",
                          text: $draft.labels)
                    .font(.caption)
                    .textFieldStyle(.roundedBorder)
            }

            TextField("Buttons (optional, comma-separated, max 4)",
                      text: $draft.buttons)
                .font(.caption)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 6) {
                Button("Render on glass") { Task { await send() } }
                    .font(.caption2)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .disabled(busy || draft.content.trimmingCharacters(in: .whitespaces).isEmpty)
                if busy { ProgressView().controlSize(.mini) }
                Spacer(minLength: 0)
            }
            if let note {
                Text(note)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var contentHint: String {
        switch draft.kind {
        case .text: return "Body text…"
        case .list: return "One item per line…"
        case .kv: return "key: value — one per line…"
        case .chart: return "Numbers: 3, 7, 4, 9…"
        }
    }

    private func send() async {
        guard !busy else { return }
        note = nil
        let prompt: String
        switch StickyCardSpec.compile(draft) {
        case .refused(let why):
            note = why
            return
        case .ok(let p):
            prompt = p
        }
        busy = true
        defer { busy = false }
        switch await StickyRelay.invoke(prompt, deviceId: deviceId,
                                        deviceName: deviceName, token: token) {
        case .refused(let why):
            note = why
        case .answered(let payload):
            note = RelayReply.text(payload)
            try? await Task.sleep(for: .seconds(2))
            await onGlassChanged?()
        }
    }
}
