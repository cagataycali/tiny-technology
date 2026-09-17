/**
 * ✉️ StickyMessages — the Sticky's DM surface, driven from the phone.
 *
 * Firmware verbs (tiny_node.cpp, read 2026-08-26 — the device reads DMs
 * with its OWN token, so none of this needs an owner-side process):
 *
 *   messages                → inbox card ON THE GLASS
 *   messages unread         → badge JSON back over the relay, nothing drawn
 *   messages thread <login> → that conversation on the glass
 *
 * The unread reply has TWO shapes, both firmware-honest and both handled:
 *
 *   {"op":"unread","http":200,"body":{"unread":2,"from":["a","b"]}, …}
 *   {"op":"unread","http":200,"unread":12,"from_count":9,
 *    "body_dropped":true, …}          ← too many senders to echo verbatim;
 *                                       the firmware parses the two numbers
 *                                       a badge needs and SAYS it dropped
 *                                       the list ("a small true answer
 *                                       beats a large broken one")
 *
 * `null` in that contract means "could not read it", never zero — the
 * parser keeps that distinction: unread=nil renders as "couldn't read",
 * unread=0 as "no unread". Sender logins double as buttons: tapping one
 * puts that thread on the glass and the mirror follows.
 */
import SwiftUI

// ── The badge, parsed (pure) ─────────────────────────────────────────────────

struct StickyUnreadBadge: Equatable {
    /// nil = the firmware could not read the count (its `null`), NOT zero.
    var unread: Int?
    var senders: [String] = []
    /// Set when the sender list was dropped (body_dropped) — count survives.
    var senderCount: Int?
    var http: Int?

    /// One footer-sized line, keeping the wire contract's null/0 distinction.
    var line: String {
        guard let unread else {
            if let http, http != 200 { return "couldn't read the badge (http \(http))" }
            return "couldn't read the badge"
        }
        if unread == 0 { return "no unread messages" }
        if !senders.isEmpty {
            return "\(unread) unread — \(senders.map { "@\($0)" }.joined(separator: ", "))"
        }
        if let senderCount {
            return "\(unread) unread from \(senderCount) senders (list too long to echo)"
        }
        return "\(unread) unread"
    }
}

enum StickyMessages {
    /// Both wire shapes → the badge; anything else → nil (the caller shows
    /// the generic reply text instead of a guessed badge).
    static func badge(_ payload: String) -> StickyUnreadBadge? {
        guard let obj = try? JSONSerialization.jsonObject(
                  with: Data(payload.utf8), options: [.fragmentsAllowed]),
              let d = obj as? [String: Any],
              d["op"] as? String == "unread"
        else { return nil }

        var b = StickyUnreadBadge()
        b.http = d["http"] as? Int
        if let body = d["body"] as? [String: Any] {
            // Shape 1: the backend body echoed verbatim.
            b.unread = body["unread"] as? Int
            b.senders = (body["from"] as? [Any])?.compactMap { $0 as? String } ?? []
        } else {
            // Shape 2: body dropped, counts parsed device-side. Absent keys
            // stay nil — "could not read", never zero.
            b.unread = d["unread"] as? Int
            b.senderCount = d["from_count"] as? Int
        }
        return b
    }
}

// ── The row ──────────────────────────────────────────────────────────────────

struct StickyMessagesRow: View {
    let deviceId: String
    let deviceName: String
    let token: String?
    /// The glass changed (inbox/thread card rendered) — re-mirror.
    var onGlassChanged: (() async -> Void)?

    @State private var badge: StickyUnreadBadge?
    @State private var note: String?
    @State private var busy = false
    @State private var fetched = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.mini) }
                Text(badge?.line ?? note ?? "checking the badge…")
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button {
                    Task { await fetchBadge() }
                } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityLabel("Refresh unread badge")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                Button("Inbox → glass") { Task { await onGlass("messages") } }
                    .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                    .disabled(busy)
                // Each sender is a button: the thread lands on the glass.
                ForEach(badge?.senders ?? [], id: \.self) { who in
                    Button("@\(who)") { Task { await onGlass("messages thread \(who)") } }
                        .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
                        .disabled(busy)
                        .accessibilityLabel("Show the \(who) conversation on the glass")
                }
                Spacer(minLength: 0)
            }
        }
        // Fetch on first expand only — every envelope is a relay round-trip
        // and the row lives inside a DisclosureGroup the user opened on
        // purpose. The refresh arrow re-asks.
        .task { if !fetched { fetched = true; await fetchBadge() } }
    }

    private func fetchBadge() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        note = nil
        switch await StickyRelay.invoke("messages unread", deviceId: deviceId,
                                        deviceName: deviceName, token: token) {
        case .refused(let why):
            badge = nil
            note = why
        case .answered(let payload):
            if let b = StickyMessages.badge(payload) {
                badge = b
            } else {
                badge = nil
                note = RelayReply.text(payload)
            }
        }
    }

    /// `messages` / `messages thread <login>` draw on the glass — send, show
    /// the receipt, let the mirror follow after the e-ink refresh.
    private func onGlass(_ verb: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        switch await StickyRelay.invoke(verb, deviceId: deviceId,
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
