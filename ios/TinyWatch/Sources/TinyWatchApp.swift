/**
 * TinyWatch — tiny on the wrist.
 *
 * Auth: the phone pushes the session token over WatchConnectivity
 * (applicationContext survives offline delivery); the watch keeps its own
 * Keychain copy, so it works away from the phone once linked.
 *
 * v1 surfaces: chat (dictation/scribble via TextFieldLink → the same
 * /api/chat loop as every tiny surface, steered to answer wrist-short)
 * and an unread-DMs line. Complications ride a later pass.
 */
import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit
import AVFoundation

@main
struct TinyWatchApp: App {
    @StateObject private var link = WatchLink.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(link)
        }
    }
}

@MainActor
final class WatchLink: NSObject, ObservableObject {
    static let shared = WatchLink()

    @Published var token: String?
    @Published var turns: [WatchTurn] = []
    @Published var busy = false
    @Published var unread = 0
    /// Theme accent mirrored from the phone (per-tiny); green fallback
    @Published var accent: Color = .green

    override private init() {
        super.init()
        #if DEBUG
        // Screenshot harness, mirroring the phone's (`TinyApp.swift`):
        //   SIMCTL_CHILD_TINY_HARNESS_TOKEN=… xcrun simctl launch <watch-sim> \
        //     technology.tiny.app.watchkitapp --session-harness
        // The whole wrist UI is gated on `link.token == nil` → the "Open tiny on
        // your iPhone to link this watch" placeholder, and the token normally
        // arrives ONLY as a WatchConnectivity push from a PAIRED phone. A watch
        // simulator has no pairing, so without this there is no way to capture the
        // linked UI at all — and Apple requires a watch screenshot set for any app
        // that ships a watchOS app. Seeded BEFORE the Keychain read below, because
        // that read is what decides which screen renders. Debug-only; the token
        // rides the environment, never disk.
        if ProcessInfo.processInfo.arguments.contains("--session-harness"),
           let harnessToken = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"],
           !harnessToken.isEmpty {
            Keychain.set("tiny_token", harnessToken)
        }
        #endif
        token = Keychain.get("tiny_token")
        if let hex = UserDefaults.standard.string(forKey: "accent_hex"),
           let c = Color.fromHex(hex) { accent = c }
        loadTurns()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // ── Transcript survives relaunch (phone parity, wrist-sized) ─────────

    private static var turnsStore: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("watch-turns.json")
    }

    private func loadTurns() {
        guard let data = try? Data(contentsOf: Self.turnsStore),
              let saved = try? JSONDecoder().decode([WatchTurn].self, from: data) else { return }
        // A turn killed mid-stream must not spin forever on restore
        turns = WatchCore.sanitize(saved)
    }

    private func saveTurns() {
        if let data = try? JSONEncoder().encode(Array(turns.suffix(20))) {
            try? data.write(to: Self.turnsStore, options: .atomic)
        }
    }

    /// Mutate/read the streaming turn by id — never by captured index (the
    /// array can be emptied by a logout context push mid-stream).
    private func withTurn(_ id: UUID, _ mutate: (inout WatchTurn) -> Void) {
        if let i = turns.firstIndex(where: { $0.id == id }) { mutate(&turns[i]) }
    }
    private func turnText(_ id: UUID) -> String {
        turns.first(where: { $0.id == id })?.a ?? ""
    }

    func apply(token newToken: String?, loggedOut: Bool) {
        if loggedOut {
            Keychain.delete("tiny_token")
            token = nil
            turns = []
            unread = 0
            followups = []
            try? FileManager.default.removeItem(at: Self.turnsStore)
            // The phone's logout() scrubs its unread/badge/widget state so the
            // NEXT user (or the logged-out gap) never sees the prior identity.
            // The wrist mirror must do the same — otherwise the previous user's
            // memories keep rotating on the 🧠 complication and their last
            // exchange + unread linger on the face, all rendered without the
            // app ever opening. Clear the Continuity mirror AND blank the
            // snapshot the extension reads, then poke the complications.
            Continuity.clearMemories(Config.tinyName)
            Continuity.clearTurnLog(Config.tinyName)
            WidgetStore.write(WatchCore.loggedOut(WidgetStore.read(), now: Date()))
            WidgetCenter.shared.reloadAllTimelines()
            return
        }
        guard let newToken else { return }
        Keychain.set("tiny_token", newToken)
        token = newToken
    }

    /// Phone pushed its memories — mirror into the wrist's Continuity
    /// store so buildContext sees ONE identity (phone wins on conflicts:
    /// wipe-and-replace, the phone store is the richer source of truth)
    func applyMemories(_ json: String?) {
        guard let json, let data = json.data(using: .utf8),
              let items = try? JSONDecoder().decode([MemoryEntry].self, from: data) else { return }
        Continuity.replaceMemories(Config.tinyName, with: items)
        // Refresh the Memories glance with the new set
        var snap = WidgetStore.read()
        snap.memories = items.suffix(12).map { String($0.content.prefix(100)) }
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
    }

    func applyAccent(_ hex: String?) {
        guard let hex, let c = Color.fromHex(hex) else { return }
        accent = c
        UserDefaults.standard.set(hex, forKey: "accent_hex")
    }

    /// Phone pushed fresh fleet/unread numbers — complications update even
    /// when this app never opens.
    func absorbSnapshot(online: Int, total: Int, unreadCount: Int, updated: Double,
                        lastQ: String? = nil, lastA: String? = nil, lastAt: Double? = nil,
                        followup: String? = nil, followupAt: Double? = nil) {
        unread = unreadCount
        let old = WidgetStore.read()
        var snap = FleetSnapshot(online: online, total: total, unread: unreadCount,
                                 login: "", updated: Date(timeIntervalSince1970: updated))
        snap.accentHex = UserDefaults.standard.string(forKey: "accent_hex")
        // Phone exchange only wins when NEWER than what the wrist has
        // (the user may have chatted on the watch since)
        let phoneAt = lastAt.map { Date(timeIntervalSince1970: $0) }
        if let phoneAt, phoneAt > (old.lastAt ?? .distantPast) {
            snap.lastQ = lastQ; snap.lastA = lastA; snap.lastAt = phoneAt
            snap.followup = followup
            snap.followupAt = followupAt.map { Date(timeIntervalSince1970: $0) }
        } else {
            snap.lastQ = old.lastQ; snap.lastA = old.lastA; snap.lastAt = old.lastAt
            snap.followup = old.followup; snap.followupAt = old.followupAt
        }
        snap.memories = old.memories
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Follow-up chips (suggest_followups) — tap to ask
    @Published var followups: [String] = []

    /// Live tool status ("running shell…") — shown under the spinner
    @Published var activeTool: String?

    func ask(_ prompt: String) {
        let q = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !busy else { return }
        turns.append(WatchTurn(q: q, a: ""))
        // Track the streaming turn by ID — a remote-logout context push
        // clears `turns` mid-stream, so a captured index would crash.
        let turnId = turns[turns.count - 1].id
        busy = true
        followups = []
        Task {
            // Streaming (was chatOnce): words land as they arrive, and the
            // agent's tools reach the wrist — speak, vibrate, followups
            var spoken: String?
            // 🧠 One identity across surfaces: the phone syncs its memories
            // + turn log into the watch's Continuity store (WatchConnectivity);
            // injecting it here means the wrist KNOWS you — and prior wrist
            // turns ride as real history (the "ask again" amnesia fix)
            let continuity = Continuity.buildContext(Config.tinyName)
            let history = WatchCore.history(from: Array(turns.dropLast()))
            do {
                for try await ev in Api.chatStream(
                    token: token,
                    message: "[Asked from Apple Watch — answer in 1-2 short sentences, no markdown] \(q)",
                    tiny: Config.tinyName, history: history, extraSystem: continuity
                ) {
                    switch ev {
                    case .text(let t):
                        withTurn(turnId) { $0.a += t }
                    case .toolStart(let n):
                        activeTool = n
                    case .toolEnd:
                        activeTool = nil
                    case .speak(_, let text, _):
                        spoken = text
                    case .vibrate(let pattern, let times, _):
                        playHaptic(pattern: pattern, times: times)
                    case .followups(let chips):
                        followups = chips
                    case .remember(let content, let tags):
                        // Wrist memories persist locally AND sync back to the
                        // phone (context push on next link refresh)
                        Continuity.addMemory(Config.tinyName, content: content, tags: tags)
                    case .forget(let match):
                        Continuity.forgetMemory(Config.tinyName, match)
                    case .spawnTasks(_, let prompts):
                        activeTool = "\(prompts.count) agents working"
                    case .reasoning:
                        break // thinking is invisible at wrist size
                    case .error(let e):
                        withTurn(turnId) { if $0.a.isEmpty { $0.a = "⚠️ \(e)" } }
                    default:
                        break // phone-only gadgets (torch, clipboard…) no-op here
                    }
                }
            } catch {
                withTurn(turnId) { if $0.a.isEmpty { $0.a = "⚠️ couldn't reach tiny" } }
            }
            // Logged out mid-stream → the turn is gone; nothing to finish.
            guard turns.contains(where: { $0.id == turnId }) else {
                busy = false
                activeTool = nil
                return
            }
            withTurn(turnId) {
                $0.a = $0.a.trimmingCharacters(in: .whitespacesAndNewlines)
                if $0.a.isEmpty { $0.a = "(no answer)" }
                $0.done = true
            }
            if turns.count > 20 { turns.removeFirst(turns.count - 20) }
            busy = false
            activeTool = nil
            saveTurns()
            // Turn log — continuity for the NEXT ask, wrist or phone
            Continuity.appendTurn(Config.tinyName, q: q, a: turnText(turnId))
            // Last exchange → snapshot → "Last answer" complication refreshes
            var snap = WidgetStore.read()
            snap.lastQ = String(q.prefix(60))
            snap.lastA = String(turnText(turnId).prefix(120))
            snap.lastAt = Date()
            // Memories glance (W5) reads from the snapshot too
            snap.memories = Continuity.memories(Config.tinyName).suffix(12).map { String($0.content.prefix(100)) }
            // Top followup chip → interactive face button for 30 min (W7)
            snap.followup = followups.first.map { String($0.prefix(60)) }
            snap.followupAt = followups.isEmpty ? nil : Date()
            WidgetStore.write(snap)
            WidgetCenter.shared.reloadAllTimelines()
            // The wrist looks away while tiny thinks — tap when it's back
            WKInterfaceDevice.current().play(.notification)
            // The agent asked to be heard — the wrist obliges (unless muted)
            if let spoken, UserDefaults.standard.object(forKey: "watch_auto_speak") as? Bool ?? true {
                speak(spoken)
            }
        }
    }

    /// vibrate-tool parity: WKHaptic's fixed vocabulary stands in for the
    /// phone's CoreHaptics patterns; repeats spaced so they read as beats
    private func playHaptic(pattern: String, times: Int) {
        let kind: WKHapticType
        switch pattern {
        case "success":            kind = .success
        case "error", "warning":   kind = .failure
        case "heartbeat", "sos":   kind = .notification
        default:                   kind = .click
        }
        let reps = max(1, min(times, 10))
        Task {
            for i in 0..<reps {
                WKInterfaceDevice.current().play(kind)
                if i < reps - 1 { try? await Task.sleep(for: .milliseconds(450)) }
            }
        }
    }

    // ── Speak an answer (watch speaker / paired AirPods) ─────────────────

    private let synth = AVSpeechSynthesizer()

    func speak(_ text: String) {
        synth.stopSpeaking(at: .immediate)
        // Mini-scrub: the ear doesn't want markdown (phone Speech.scrub kin)
        var clean = text
        for pattern in ["```[\\s\\S]*?```", "`([^`]+)`", "[*_#>|]"] {
            clean = clean.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        let utterance = AVSpeechUtterance(string: String(clean.prefix(1000)))
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")
        synth.speak(utterance)
    }

    func refreshUnread() async {
        guard token != nil,
              let d: [String: Any] = try? await Api.get("/api/messages", token: token),
              let threads = d["threads"] as? [[String: Any]] else { return }
        unread = threads.reduce(0) { $0 + (($1["unread"] as? Int) ?? 0) }
        // Keep the complication honest with what the wrist just learned
        var snap = WidgetStore.read()
        snap.unread = unread
        snap.updated = Date()
        snap.accentHex = UserDefaults.standard.string(forKey: "accent_hex") ?? snap.accentHex
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
    }
}

extension WatchLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Context that arrived while the app was dead is waiting here. Route it
        // through the SAME ingest as a live delivery — a cold launch must apply
        // the snapshot/memories/accent that rode the last push too, not just
        // token/loggedOut (didReceiveApplicationContext isn't guaranteed to
        // fire for a context delivered while the app was not running).
        ingest(session.receivedApplicationContext)
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        ingest(applicationContext)
    }

    /// Extract the plist-safe scalars off the context and apply them on the
    /// main actor. Shared by cold-launch (activationDidComplete) and live
    /// (didReceiveApplicationContext) delivery so both stay in lockstep.
    nonisolated private func ingest(_ context: [String: Any]) {
        let t = context["token"] as? String
        let out = context["loggedOut"] as? Bool ?? false
        // Fleet snapshot piggybacks on the same context (plist-safe scalars)
        let snap = context["snap"] as? [String: Any]
        let online = snap?["online"] as? Int
        let total = snap?["total"] as? Int
        let unread = snap?["unread"] as? Int
        let updated = snap?["updated"] as? Double
        let accentHex = context["accent"] as? String
        let memories = context["memories"] as? String
        // Extract Sendable scalars BEFORE the Task — [String: Any] must not
        // cross the isolation boundary (Swift 6 region check)
        let lastQ = snap?["lastQ"] as? String
        let lastA = snap?["lastA"] as? String
        let lastAt = snap?["lastAt"] as? Double
        let followup = snap?["followup"] as? String
        let followupAt = snap?["followupAt"] as? Double
        // Nothing to do for an empty context (cold launch, phone never pushed):
        // every apply below early-returns on nil, so this is a cheap no-op.
        guard t != nil || out || snap != nil || accentHex != nil || memories != nil else { return }
        Task { @MainActor in
            WatchLink.shared.apply(token: t, loggedOut: out)
            // A logout context scrubs the wrist identity — never re-apply the
            // (possibly prior-user) memories/snapshot that rode along, or the
            // scrub is silently undone. The phone now omits them on logout;
            // this guards a stale/legacy context that still carries both.
            guard !out else { return }
            WatchLink.shared.applyAccent(accentHex)
            WatchLink.shared.applyMemories(memories)
            if let online, let total, let unread, let updated {
                WatchLink.shared.absorbSnapshot(
                    online: online, total: total, unreadCount: unread, updated: updated,
                    lastQ: lastQ, lastA: lastA, lastAt: lastAt,
                    followup: followup, followupAt: followupAt)
            }
        }
    }
}

// ── UI ─────────────────────────────────────────────────────────────────────

struct WatchRootView: View {
    @EnvironmentObject var link: WatchLink
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Group {
                if link.token == nil { unlinked } else { chat }
            }
            .navigationTitle("🌱 tiny")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        WatchSettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.caption)
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
        .task {
            // Refresh while the app is on-wrist (watchOS suspends the task
            // when the app leaves the foreground; re-entry restarts it)
            while !Task.isCancelled {
                await link.refreshUnread()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private var unlinked: some View {
        VStack(spacing: 8) {
            Text("🌱").font(.system(size: 34))
            Text("Open tiny on your iPhone\nto link this watch.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if link.unread > 0 {
                        // Status strip = chrome → SF Symbol, not the 💬 emoji.
                        Label("\(link.unread) unread", systemImage: "bubble.left.and.bubble.right")
                            .font(.caption2)
                            .foregroundStyle(link.accent)
                    }
                    if link.turns.isEmpty {
                        Text("Ask anything — dictate,\nscribble, or type.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(link.turns) { turn in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(turn.q)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(link.accent)
                            if turn.a.isEmpty && !turn.done {
                                HStack(spacing: 4) {
                                    ProgressView().scaleEffect(0.7)
                                    if let tool = link.activeTool {
                                        Text(tool)
                                            .font(.system(size: 10))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                            } else {
                                Text(turn.a).font(.footnote)
                            }
                        }
                        .id(turn.id)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                        .contextMenu {
                            Button {
                                link.ask(turn.q)
                            } label: {
                                Label("Ask again", systemImage: "arrow.clockwise")
                            }
                            if turn.done && !turn.a.isEmpty {
                                Button {
                                    link.speak(turn.a)
                                } label: {
                                    Label("Speak", systemImage: "speaker.wave.2")
                                }
                            }
                        }
                    }

                    if !link.followups.isEmpty && !link.busy {
                        ForEach(link.followups, id: \.self) { chip in
                            Button(chip) { link.ask(chip) }
                                .font(.caption2)
                                .buttonStyle(.bordered)
                                .tint(link.accent.opacity(0.4))
                        }
                    }

                    TextFieldLink(prompt: Text("ask tiny")) {
                        Label("Ask tiny", systemImage: "mic.fill")
                            .font(.footnote.weight(.semibold))
                    } onSubmit: { text in
                        link.ask(text)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(link.accent.opacity(0.35))
                    .disabled(link.busy)
                }
            }
            .onChange(of: link.turns) {
                guard let last = link.turns.last else { return }
                if reduceMotion { proxy.scrollTo(last.id, anchor: .bottom) }
                else { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}
