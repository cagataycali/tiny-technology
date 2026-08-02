/**
 * Activity feed — "what happened while you were away": the signed-in user's
 * event ring (scheduler fires, telegram, visits, learns, follows, DMs) from
 * GET /api/events. iOS port of the web ActivityHUD (components/chat/
 * ActivityHUD.tsx) + android's ActivitySheet.
 *
 * The kind→glyph prefix map and ago() live here as PURE, testable logic that
 * mirrors lib/chat/event-icons.ts + the HUD's ago() exactly (same prefix
 * semantics, same non-finite/≤0 degrade-to-"1s" floor).
 */
import SwiftUI

/// Pure event presentation — kept free of SwiftUI/URLSession so it's unit
/// testable and pinned against the worker's emitted kinds.
enum EventGlyph {
    /// kind→emoji, matched by PREFIX (so `job` covers job_result/job_error,
    /// `telegram` covers telegram/telegram_out/telegram_button). `tiny_visit`
    /// is keyed IN FULL because the bare `visit` prefix never matches it (the
    /// kind starts with "tiny"). `device` covers `device_result` — a use_device
    /// task whose reply landed after the 45s wait, which the event ring is the
    /// only surface for. share/learn/push are forward-looking reserves.
    ///
    /// 🚨 `pay_alarm` is keyed IN FULL, like tiny_visit: a bare `pay` prefix would
    /// also swallow a future pay_* kind that is NOT an emergency, and this glyph
    /// must mean exactly one thing. It drew the same ⚡ as a corrupt event until
    /// the roster in lib/chat/event-icons.ts (EMITTED_KINDS) made the gap fail a
    /// test — an unmapped SHIPPED kind is indistinguishable from an unknown one.
    ///
    /// ⛔ `job_missed` (a one-shot the scheduler GAVE UP on) is keyed in full for
    /// the same reason, and it is the sharper case: `job` is a real prefix of it,
    /// so it inherited ⏰ — the glyph of a job that RAN. `icon(for:)` therefore
    /// matches longest-key-first instead of trusting this array's order, because
    /// a correctness that depends on line position is one reorder from wrong.
    ///
    /// 🚫 `device_missed` is that same trap on the device side: `device` is a real
    /// prefix, so a task the laptop NEVER picked up would draw 💻, the glyph for
    /// one it FINISHED. Keyed in full.
    ///
    /// Mirrors lib/chat/event-icons.ts KIND_ICONS.
    static let icons: [(key: String, glyph: String)] = [
        ("job", "⏰"), ("job_missed", "⛔"), ("telegram", "✈️"), ("tiny_visit", "👀"), ("learn", "🧬"),
        ("device", "💻"), ("device_missed", "🚫"), ("pay_alarm", "🚨"),
        // 🗣️🎙️👁️ Keyed in full, not behind a shared `nicla` prefix: a wake, the
        // words that followed it, and the Vision seeing motion are three
        // different rows to a reader.
        //
        // 📝 `device_note` is the job_missed case again — `device` IS a prefix of
        // it, so it rendered 💻 ("your laptop finished a task") while carrying
        // TRANSCRIBED SPEECH: it is NiclaRecorder.postToServer's fallback rail
        // for when /api/devices/transcript isn't deployed, which is the state
        // production is in, so it is the kind real takes land under today.
        ("nicla_wake", "🗣️"), ("nicla_transcript", "🎙️"), ("nicla_sentry", "👁️"),
        ("device_note", "📝"),
        ("pay_earned", "💵"), ("pay_received", "💰"), ("pay_withdrawn", "🏦"), ("pay_refunded", "↩️"),
        ("push", "🔔"), ("share", "🔗"), ("tool", "🔧"), ("follow", "🤝"), ("dm", "💬"),
        // 🤖 `batch` covers `batch_result` — a spawn_agents wait:false fleet
        // that finished after its stream closed (web lib/chat/tools/spawn.ts).
        ("batch", "🤖"),
    ]

    /// Every kind the worker can emit — mirrors EMITTED_KINDS in
    /// lib/chat/event-icons.ts, so the pin below fails here too when the worker
    /// grows a kind this HUD has no glyph for.
    static let emittedKinds = [
        "job_result", "job_error", "dm", "follow", "tiny_visit", "device_result",
        "tool-update", "telegram", "telegram_out", "telegram_button", "pay_alarm",
        "pay_earned", "pay_received", "pay_withdrawn", "pay_refunded",
        "job_missed", "device_missed",
        "batch_result", // app-emitted via POST /events (spawn_agents wait:false)
        // 🗣️🎙️👁️📝 devices.ts DEVICE_EVENT_KINDS — and THIS app writes two of
        // them (NiclaVoiceGateway posts nicla_wake, NiclaRecorder posts
        // device_note). The glyphs above were added when the necklace shipped;
        // this list was not, so the parity pin that exists to catch exactly that
        // could never fire, and device_note kept inheriting 💻.
        "nicla_wake", "nicla_transcript", "nicla_sentry", "device_note",
    ]

    /// Prefix-match a kind to its glyph; a missing/unknown kind degrades to ⚡
    /// (matches web iconFor's String() coercion + ⚡ fallback).
    static func icon(for kind: String) -> String {
        // Longest key first: a kind keyed IN FULL must beat a shorter prefix key
        // that also matches it (`job_missed` over `job`).
        for entry in icons.sorted(by: { $0.key.count > $1.key.count })
        where kind.hasPrefix(entry.key) { return entry.glyph }
        return "⚡"
    }

    /// Compact "12m"/"3h"/"2d" since a unix-seconds timestamp. A non-finite or
    /// ≤0 `created` (the worker stores INTEGER unixepoch(), but the payload is
    /// taken raw) degrades to the "1s" floor rather than "NaNd"/epoch-distance,
    /// matching the web HUD's ago() guard. `now` is injectable for tests.
    static func ago(_ created: Double, now: Double) -> String {
        let s: Int
        if created.isFinite, created > 0 {
            s = max(1, Int(now - created))
        } else {
            s = 1
        }
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        return "\(s / 86400)d"
    }
}

struct ActivityEvent: Identifiable {
    let id: Int
    let kind: String
    let detail: String
    let created: Double
}

struct ActivityView: View {
    let token: String?
    /// Called after a successful load with the newest event id in the ring —
    /// clears the ⚡ unread badge (web/android markSeen). Nil when the caller
    /// doesn't track unread.
    var onSeen: ((Int) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var events: [ActivityEvent] = []
    @State private var state: LoadState = .loading

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading: ProgressView("Loading activity…")
                case .failed(let e):
                    ContentUnavailableView {
                        Label("Couldn't load", systemImage: "bolt.slash")
                    } description: {
                        Text(e)
                    } actions: {
                        Button("Retry") { Task { state = .loading; await load() } }
                    }
                case .loaded:
                    if events.isEmpty {
                        ContentUnavailableView("Nothing yet", systemImage: "bolt",
                            description: Text("Schedule a job or pair Telegram —\nactivity shows up here."))
                    } else {
                        List(events) { e in
                            HStack(alignment: .top, spacing: 12) {
                                Text(EventGlyph.icon(for: e.kind))
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(e.detail.isEmpty ? e.kind : e.detail)
                                        .font(.subheadline)
                                    Text("\(e.kind) · \(EventGlyph.ago(e.created, now: Date().timeIntervalSince1970)) ago")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .refreshable { await load() }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
    }

    private func load() async {
        // The proxy (app/api/events) returns {ok:false},502 on a worker outage
        // and {ok:true, events} otherwise — gate on ok so an outage shows the
        // retry state, NOT a false "Nothing yet". Newest-first from the ring;
        // we render as-is (web reverses a growing list, but our fetch is
        // already id-DESC so newest is first).
        // ⚠️ `do/catch`, not `try?`: the thrown `ApiError` is the only thing that
        // knows whether this was an expired session or a dead connection, and
        // the two remedies are opposite ones (`LoadFailure`).
        //
        // The route pairs `ok:false` with a 502 and `error` with a 401, so a 2xx
        // that fails these two checks is an intermediary or a mid-redeploy page
        // — no server message is being discarded, and `badResponse` is the one
        // line in the house table that says exactly that.
        let raw: [[String: Any]]
        do {
            let d: [String: Any] = try await Api.get("/api/events", token: token)
            guard (d["ok"] as? Bool) == true,
                  let events = d["events"] as? [[String: Any]] else { throw ApiError.badResponse }
            raw = events
        } catch {
            state = .failed(LoadFailure.message(error)); return
        }
        events = raw.compactMap { ev in
            guard let id = (ev["id"] as? NSNumber)?.intValue ?? (ev["id"] as? Int) else { return nil }
            return ActivityEvent(
                id: id,
                kind: ev["kind"] as? String ?? "",
                detail: ev["detail"] as? String ?? "",
                created: (ev["created"] as? NSNumber)?.doubleValue ?? 0)
        }
        state = .loaded
        // Everything now on screen counts as seen — clear the badge against
        // the newest id (0 when empty is a no-op in markEventsSeen).
        onSeen?(events.map(\.id).max() ?? 0)
    }
}
