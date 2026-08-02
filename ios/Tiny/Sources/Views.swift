/**
 * Views — login + chat. Dark, minimal, tiny-branded (🌱 + green accent).
 *
 * Web-parity pass 1: the agent's `speak` tool renders a native speech card
 * (play/stop + transcript, spoken via AVSpeechSynthesizer), suggest_followups
 * become tappable chips above the composer, and history persists across
 * launches (Documents/chat-history.json).
 */
import SwiftUI
import CoreBluetooth
import WidgetKit
import PhotosUI
import AVFoundation
import ImageIO
import WebKit
import UniformTypeIdentifiers

// ── Login ─────────────────────────────────────────────────────────────────

/// "phone" reads wrong when this binary is a desktop — the login tagline and
/// the devices footnote both name the machine they run on.
private var deviceNoun: String {
    #if targetEnvironment(macCatalyst)
    "Mac"
    #else
    "phone"
    #endif
}

struct LoginView: View {
    @EnvironmentObject var session: TinySession
    @State private var busy = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            // the brand mark (NeonMark, Onboarding.swift) replaced the 🌱
            // emoji when the logo moved to the meta-agent orbit node
            NeonMark(size: 96)
            Text("tiny").font(.system(size: 40, weight: .bold, design: .rounded))
            Text("Your AI. This \(deviceNoun) becomes\na node of your tiny identity.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                busy = true
                Task { await session.login(); busy = false }
            } label: {
                HStack {
                    if busy { ProgressView().tint(.black) }
                    Text(busy ? "Authorizing…" : "Sign in with tiny.technology")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.green)
                .foregroundStyle(.black)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(busy)
            .padding(.horizontal, 24)
            Text("GitHub login in a secure browser sheet.\nNo passwords touch this app.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 32)
        }
    }
}

// ── Chat ──────────────────────────────────────────────────────────────────

struct SpeechItem: Identifiable, Equatable, Codable {
    let id: String    // toolUseId
    let text: String
    /// Agent-chosen Kokoro voice id — replays keep the same voice (optional:
    /// old histories decode to nil and fall back to the locale's best voice)
    var voice: String? = nil
}

struct ChatMessage: Identifiable, Equatable, Codable {
    var id = UUID()
    let role: String       // user | assistant
    var text: String
    var tools: [String] = []
    var speech: [SpeechItem] = []
    var ui: [RenderUiItem] = []
    var spawns: [SpawnTreeItem] = []
    /// pay_x402 quotes awaiting the user's Approve/Decline (confirm-every-payment)
    var payQuotes: [PayQuoteItem] = []
    /// pay_x402 TERMINAL outcomes with no quote to approve — a tool failure or a
    /// free target. Rendered as an inert card (web PayReceipt toolFailed / "No
    /// payment needed"); without this the outcome was invisible on iOS.
    var payResults: [PayResultItem] = []
    var reasoning: String = ""
    var inTok: Int = 0
    var outTok: Int = 0
    /// Cached input tokens (billed at a fraction) + resolved model id — used
    /// only to price the turn (ModelPricing); mirror web/android's per-turn ~$.
    var cacheReadTok: Int = 0
    var modelId: String?
    /// 96px base64 previews of photos sent with this message
    var thumbs: [String] = []
    /// Names of documents sent with this message (bytes not persisted)
    var docs: [String] = []
    /// generate_image results — 512px preview persists, full image lives at
    /// the hosted URL (cloud-persisted so every client renders the same media)
    var images: [GeneratedImage] = []
    /// Stream failed — holds the user prompt so it can be retried (web parity)
    var failedPrompt: String?
    /// 402 paywall — a paid tiny with a short/absent balance. Drives a native
    /// paywall card (price + balance + Add funds / Retry, or Sign in) in place
    /// of a dead error string, and holds the prompt so Retry can re-send once
    /// funded. Web parity: Chat.tsx's per-message `paywall` field.
    var paywall: Paywall?
    /// This bubble was still STREAMING when it was persisted (the debounced
    /// partial saves + the backgrounding flush write it; the stream epilogue
    /// clears it). If a load() ever sees it true, the app died mid-reply —
    /// reconcileInterrupted() turns that into an honest ⚠️ marker + Retry.
    var liveAtSave: Bool = false

    init(role: String, text: String) {
        self.role = role
        self.text = text
    }

    // decodeIfPresent everywhere: histories saved by older builds lack newer
    // keys (e.g. `ui`) — one missing key must not wipe the whole transcript
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        tools = try c.decodeIfPresent([String].self, forKey: .tools) ?? []
        speech = try c.decodeIfPresent([SpeechItem].self, forKey: .speech) ?? []
        ui = try c.decodeIfPresent([RenderUiItem].self, forKey: .ui) ?? []
        spawns = try c.decodeIfPresent([SpawnTreeItem].self, forKey: .spawns) ?? []
        payQuotes = try c.decodeIfPresent([PayQuoteItem].self, forKey: .payQuotes) ?? []
        payResults = try c.decodeIfPresent([PayResultItem].self, forKey: .payResults) ?? []
        reasoning = try c.decodeIfPresent(String.self, forKey: .reasoning) ?? ""
        inTok = try c.decodeIfPresent(Int.self, forKey: .inTok) ?? 0
        outTok = try c.decodeIfPresent(Int.self, forKey: .outTok) ?? 0
        cacheReadTok = try c.decodeIfPresent(Int.self, forKey: .cacheReadTok) ?? 0
        modelId = try c.decodeIfPresent(String.self, forKey: .modelId)
        thumbs = try c.decodeIfPresent([String].self, forKey: .thumbs) ?? []
        docs = try c.decodeIfPresent([String].self, forKey: .docs) ?? []
        images = try c.decodeIfPresent([GeneratedImage].self, forKey: .images) ?? []
        failedPrompt = try c.decodeIfPresent(String.self, forKey: .failedPrompt)
        paywall = try c.decodeIfPresent(Paywall.self, forKey: .paywall)
        liveAtSave = try c.decodeIfPresent(Bool.self, forKey: .liveAtSave) ?? false
    }
}

/// 402 paywall state riding a ChatMessage (web: the `paywall` message field).
/// Codable so a persisted transcript still shows the card; `prompt` lets Retry
/// re-send the exact turn once the wallet is funded.
struct Paywall: Equatable, Codable {
    let priceMicro: Int
    let balanceMicro: Int
    let signedOut: Bool
    let prompt: String
}

@MainActor
final class ChatModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var streaming = false
    @Published var activeTool: String?
    @Published var followups: [String] = []
    /// Which tiny this surface talks to — the web's /{slug} equivalent.
    /// Switching persists the old transcript and loads the new one.
    @Published var tiny: String = "tiny"
    /// Per-tiny accent (web theme.accent) — tints the whole chat surface
    @Published var accent: Color = .green
    /// Per-tiny hero banner (web top-level `hero` field — an owner-set
    /// https image URL, "profile banner" style). nil = no banner; shown
    /// only on the turn-zero landing hero, never as chat chrome.
    @Published var heroURL: URL?
    /// Per-tiny landing logo (top-level `logo`, same https guard as hero) —
    /// replaces the brand mark on the turn-zero landing. nil = no media.
    @Published var logoURL: URL?
    /// Per-tiny intro haptic (top-level `intro_vibe`, a Haptic pattern
    /// name) — plays once per tiny-switch/app-open when the landing shows.
    @Published var introVibe: String?
    /// Owner-set starter chips (top-level `chips`, 1–4 strings ≤60 chars) —
    /// replace the default landingChips on the landing when present.
    @Published var customChips: [String]?
    /// Owner-set landing subtitle (top-level `tagline`, ≤200 chars) — replaces
    /// the generic landingTagline line under the tiny's name when present.
    @Published var customTagline: String?
    /// Private tiny (worker `private`) — hidden from search/list; only the
    /// owner can chat. Drives the darkened chat treatment + lock glyph.
    @Published var isPrivate = false
    /// Whether THIS device is vouched for the private tiny (worker
    /// `isAuthorized`, echoed via /api/tiny). Only meaningful when
    /// `isPrivate`; a private tiny with `!isAuthorized` shows the lock
    /// screen instead of the composer. Non-private tinys leave it false
    /// (unused). Set from loadTheme, which now sends the session token so
    /// the proxy can vouch an owner (was `token: nil` → always locked).
    @Published var isAuthorized = false
    /// Whether the signed-in account OWNS this tiny (worker `isOwner`, echoed
    /// via /api/tiny only when the internal key + userId vouched a match).
    /// Gates owner-only edit surfaces like the realtime-voice picker.
    @Published var isOwner = false
    /// Per-tiny realtime-voice (worker `voice`) — which OpenAI voice the tiny
    /// speaks with in a live call. Owner-editable; '' / nil = the marin
    /// default. Read here so the picker shows the active selection.
    @Published var voice: String = ""
    /// Owner-only: the tiny's full persona, echoed to owners by /api/tiny.
    /// Held so a voice-only save can RE-SEND them — the worker's D1 mirror
    /// writes raw body.systemPrompt, so an upsert omitting them would blank
    /// the relational persona columns (KV is preserved, but D1 isn't).
    var ownerSystemPrompt = ""
    var ownerSystemKnowledge = ""
    /// 💵 Up-front per-message price (micro-USDC, worker /pay/pricing) — lets
    /// the composer warn BEFORE a send hits the 402 paywall (web Chat.tsx:213
    /// parity, so a paid tiny is never a surprise). nil = free / not yet
    /// looked up; only ever set when the lookup finds a price > 0. Reset on
    /// every tiny switch so a paid tiny's badge never strands over a free one.
    @Published var priceMicro: Int?
    /// Which tiny the intro vibe already played for this surface — reset by
    /// switchTiny so a new tiny greets once, re-renders/refreshes don't.
    private var introVibePlayedFor: String?
    /// Haptic triggers (P1.3) — bumped on events; views observe via
    /// .sensoryFeedback(trigger:). Int wraps are fine, only change matters.
    @Published var hapticSend = 0
    @Published var hapticDone = 0
    @Published var hapticError = 0

    /// Screen-capture consent (screenshot tool). Consent is asked EVERY
    /// capture: when the agent calls `screenshot`, the stream loop publishes a
    /// pending request and awaits the user's tap. The ChatView binds an alert
    /// to this and calls `resolveScreenshotConsent(_:)` on Allow/Don't allow.
    struct ScreenshotConsent: Identifiable { let id = UUID(); let reason: String }
    @Published var pendingScreenshot: ScreenshotConsent?
    private var screenshotConsent: CheckedContinuation<Bool, Never>?

    /// Publish the consent request and suspend until the user decides.
    private func askScreenshotConsent(reason: String) async -> Bool {
        // A stale continuation (shouldn't happen — captures are serialized by
        // the round-trip) is declined so it can't leak.
        screenshotConsent?.resume(returning: false)
        screenshotConsent = nil
        return await withCheckedContinuation { cont in
            screenshotConsent = cont
            pendingScreenshot = ScreenshotConsent(reason: reason)
        }
    }

    /// The ChatView's alert calls this on Allow (true) / Don't Allow (false).
    func resolveScreenshotConsent(_ allow: Bool) {
        pendingScreenshot = nil
        screenshotConsent?.resume(returning: allow)
        screenshotConsent = nil
    }

    /// In-flight streams keyed by their assistant bubble id (web
    /// stream-registry parity, Option B concurrent turns): each send owns
    /// its own task + cancellation handle, so stopping one bubble leaves
    /// its siblings streaming. URLSession.bytes cancellation closes that
    /// stream's connection, so server-side token burn stops per turn too.
    private var streamTasks: [UUID: Task<Void, Never>] = [:]
    /// Live registry — which bubbles are still streaming (per-bubble Stop
    /// UI reads this) + when each was claimed (feeds the "started Ns ago"
    /// sibling-partial annotation).
    @Published var liveIds: Set<UUID> = []
    private var liveStartedAt: [UUID: Date] = [:]

    /// Claim a slot for a new stream. SYNCHRONOUS on the MainActor — every
    /// send claims before any await, so `streaming` (kept as a flag derived
    /// from the registry: several UI sites + voice barge-in read it) can
    /// never miss a 0→N or N→0 transition.
    private func claimStream(_ id: UUID) {
        liveStartedAt[id] = Date()
        liveIds.insert(id)
        streaming = true
        beginBackgroundHold()
    }

    private func releaseStream(_ id: UUID) {
        liveStartedAt[id] = nil
        liveIds.remove(id)
        streamTasks[id] = nil
        streaming = !liveIds.isEmpty
        if liveIds.isEmpty { endBackgroundHold() }
    }

    /// ONE shared background-time token spanning the whole 0→N→0 live-stream
    /// window (per-stream tokens would overlap and leak identifiers). No
    /// UIBackgroundModes claim — this is the honest time-extension API: iOS
    /// grants ~30s after the user leaves, enough for a typical reply to
    /// finish streaming instead of being cut the instant the app backgrounds.
    private var bgHold: UIBackgroundTaskIdentifier = .invalid

    private func beginBackgroundHold() {
        guard bgHold == .invalid else { return }
        bgHold = UIApplication.shared.beginBackgroundTask(withName: "chat-stream") { [weak self] in
            // Expiration: endBackgroundTask MUST be called here or the
            // watchdog kills the app. Streams still live simply get
            // suspended mid-flight — the transport catch marks them
            // ⚠️ + Retry when the user comes back.
            self?.endBackgroundHold()
        }
    }

    private func endBackgroundHold() {
        guard bgHold != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgHold)
        bgHold = .invalid
    }

    /// How a still-streaming sibling reply appears in a concurrent turn's
    /// history (web annotateLivePartial — strings byte-identical): the
    /// partial so far, clearly marked as in-progress so the model neither
    /// treats it as final nor re-answers it.
    nonisolated static func annotateLivePartial(_ content: String, startedAt: Date, now: Date = Date()) -> String {
        let secs = max(1, Int(now.timeIntervalSince(startedAt).rounded()))
        let body = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty
            ? "[⏳ You are still working on a reply to the previous message in a parallel turn (started \(secs)s ago) — nothing written yet. Answer the new message on its own.]"
            : "[⏳ You are STILL WRITING this reply in a parallel turn (started \(secs)s ago). Partial text so far — do not repeat it, but you may build on it:]\n\(body)"
    }

    /// Build one turn's outgoing history (web buildTurnHistory parity).
    /// `prior` is the transcript snapshot minus this turn's own user msg +
    /// placeholder. Sibling LIVE placeholders ride along even when empty,
    /// wrapped as annotated partials; other empty bubbles keep the
    /// placeholder substitution (Bedrock rejects empty text blocks — see
    /// the history comment in send()).
    nonisolated static func turnHistory(prior: [ChatMessage], live: [UUID: Date], now: Date = Date()) -> [[String: Any]] {
        prior.suffix(30).map { m in
            let t: String
            if let started = live[m.id] {
                t = annotateLivePartial(m.text, startedAt: started, now: now)
            } else if m.text.isEmpty {
                t = m.role == "user" ? "Have a look." : "…"
            } else {
                t = m.text
            }
            return ["role": m.role, "content": [["text": t]]]
        }
    }

    /// Write the streaming reply bubble by ID, not by captured index — the
    /// array can shrink or be swapped mid-stream (delete / Clear chat /
    /// tiny switch), and a stale index write was an Index-out-of-range crash.
    /// Bubble gone → the write drops silently, which is exactly right.
    private func setReply(_ reply: ChatMessage) {
        if let i = messages.lastIndex(where: { $0.id == reply.id }) {
            messages[i] = reply
            // Debounced partial persistence: a kill mid-stream should cost
            // at most ~2s of text, not the whole reply. Send + epilogue
            // still save unconditionally; the backgrounding flush covers
            // whatever the debounce still owes when the user leaves.
            if Date().timeIntervalSince(lastStreamSave) >= 2 {
                lastStreamSave = Date()
                save()
            }
        }
    }

    /// Persist a pay_x402 quote's terminal outcome onto its message (C3): the
    /// Approve card writes the receipt back so a reload shows "Payment sent",
    /// not a dead expired-quote card that invites a double-pay. Saves at once —
    /// this is a money event, not a debounce-able stream partial.
    func settlePayQuote(messageId: UUID, quoteId: String, _ settled: PaySettled) {
        guard let i = messages.firstIndex(where: { $0.id == messageId }),
              let q = messages[i].payQuotes.firstIndex(where: { $0.id == quoteId })
        else { return }
        messages[i].payQuotes[q].settled = settled
        save()
    }

    private var lastStreamSave = Date.distantPast

    /// Persist in-flight partials the moment the app leaves the foreground —
    /// the debounce may owe up to ~2s of text, and if iOS never resumes us
    /// this save is exactly what load()'s reconcile pass works from.
    func flushForBackground() {
        guard streaming else { return }
        save()
    }

    /// Turn-zero landing tagline (web hero parity, Chat.tsx heroMode): the
    /// line under the big accent-colored tiny name. Web copy verbatim. The
    /// web's third branch — UNCLAIMED names ("Nobody has claimed … yet") —
    /// has no iOS analog: this surface only opens tinys that exist.
    nonisolated static func landingTagline(for tiny: String) -> String {
        tiny == "tiny"
            ? "Create your own AI by chatting — free, forever."
            : "A tiny — a living AI at tiny.technology/\(tiny). Say anything."
    }

    /// Turn-zero starter chips (web heroMode chips — same texts, same order).
    nonisolated static func landingChips(for tiny: String) -> [String] {
        tiny == "tiny"
            ? ["Create an AI named …", "What is this place?", "Show me what a tiny can do"]
            : ["What can you do?", "Who made you?", "Surprise me"]
    }

    /// A chip ending in "…" SEEDS the composer instead of sending (web:
    /// `chip.endsWith('…')` → setInput(chip.replace('…','')) + focus —
    /// the trailing space survives so the user just types the name).
    /// Returns the seed text, or nil for a plain send-this-chip.
    nonisolated static func landingSeed(for chip: String) -> String? {
        chip.hasSuffix("…") ? chip.replacingOccurrences(of: "…", with: "") : nil
    }

    /// Gate the owner-supplied banner URL exactly like the web render guard
    /// (Chat.tsx: `^https://[^\s"'\\<>]+$`) — https only, no whitespace,
    /// quotes, backslashes or angle brackets. Anything else → nil, no banner.
    nonisolated static func heroURL(from raw: String) -> URL? {
        guard raw.range(of: #"^https://[^\s"'\\<>]+$"#, options: .regularExpression) != nil
        else { return nil }
        return URL(string: raw)
    }

    /// Owner-supplied starter chips (top-level `chips`): exactly 1–4
    /// strings, each trimmed, non-empty and ≤60 chars — anything else
    /// (wrong type, empty array, oversize entry) → nil, default chips.
    nonisolated static func customChips(from raw: Any?) -> [String]? {
        guard let arr = raw as? [String] else { return nil }
        let trimmed = arr.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard (1...4).contains(trimmed.count),
              trimmed.allSatisfy({ !$0.isEmpty && $0.count <= 60 }) else { return nil }
        return trimmed
    }

    /// Owner-supplied landing subtitle (top-level `tagline`): a trimmed,
    /// non-empty string ≤200 chars replaces the generic landingTagline line.
    /// Anything else (wrong type, empty, oversize) → nil, generic line.
    nonisolated static func customTagline(from raw: Any?) -> String? {
        guard let s = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty, s.count <= 200 else { return nil }
        return s
    }

    /// The Haptic pattern vocabulary (Haptic.events(for:)) — "tap" is its
    /// default branch but still a legal name the server may send.
    nonisolated static let vibePatterns: Set<String> = [
        "tap", "double", "success", "warning", "error",
        "heartbeat", "sos", "long", "escalate", "wave",
    ]

    /// Validate `intro_vibe` against the Haptic vocabulary — unknown names
    /// → nil (graceful no-op) rather than a surprise default-tap.
    nonisolated static func introVibe(from raw: String?) -> String? {
        guard let v = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              vibePatterns.contains(v) else { return nil }
        return v
    }

    /// Classify the landing-logo media by extension so the view can pick a
    /// renderer: mp4/webm/mov → looping AVPlayer, gif → frame-animated
    /// UIImageView, everything else → AsyncImage (static).
    nonisolated static func logoKind(for url: URL) -> LogoKind {
        switch url.pathExtension.lowercased() {
        case "mp4", "webm", "mov", "m4v": return .video
        case "gif":                       return .gif
        case "svg":                       return .svg
        default:                          return .image
        }
    }

    /// Fetch the tiny's theme accent (public read; default green on any miss).
    /// Sends the session token so the proxy's owner-vouch path (getSession →
    /// isOwner → internal key) can fire — WITHOUT it, a private tiny always
    /// returns the locked/blanked shape and the owner can never chat (the iOS
    /// twin of the web "I can auth but can't send" bug).
    func loadTheme() async {
        let name = tiny
        let token = Keychain.get("tiny_token")
        guard let d: [String: Any] = try? await Api.post("/api/tiny", token: token, body: ["name": name]),
              name == tiny else { return }
        // Private + whether this device is vouched (default public/false on
        // any miss so a fetch failure never hard-locks a public tiny).
        isPrivate = d["private"] as? Bool ?? false
        isAuthorized = d["isAuthorized"] as? Bool ?? false
        isOwner = d["isOwner"] as? Bool ?? false
        voice = d["voice"] as? String ?? ""
        // Owners get full config back — stash the persona so a voice-only save
        // can re-send it (the worker's D1 mirror would otherwise blank it).
        ownerSystemPrompt = d["systemPrompt"] as? String ?? ""
        ownerSystemKnowledge = d["systemKnowledge"] as? String ?? ""
        // theme may arrive as an object or a JSON string — accept both
        var theme = d["theme"] as? [String: Any]
        if theme == nil, let s = d["theme"] as? String, let data = s.data(using: .utf8) {
            theme = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        let hex = theme?["accent"] as? String
        accent = hex.flatMap(Color.fromHex) ?? .green
        // hero is a TOP-LEVEL sibling of theme (not inside it); the
        // not-exists and error fallback responses omit it — absent == none
        heroURL = Self.heroURL(from: d["hero"] as? String ?? "")
        // Per-tiny identity trio — top-level like `hero`; every field is
        // optional and validated, absent == graceful no-op
        logoURL = Self.heroURL(from: d["logo"] as? String ?? "")
        introVibe = Self.introVibe(from: d["intro_vibe"] as? String)
        customChips = Self.customChips(from: d["chips"])
        customTagline = Self.customTagline(from: d["tagline"])
        playIntroVibeIfNeeded()
        // The watch mirrors the accent — stash it where WatchBridge's next
        // context push can pick it up (empty = brand green)
        UserDefaults.standard.set(hex.flatMap(Color.fromHex) != nil ? hex! : "", forKey: "cfg_accent_hex")
        WatchBridge.shared.sync(token: Keychain.get("tiny_token"))
    }

    /// Owner-only: set the tiny's realtime-voice (the OpenAI voice heard on a
    /// live call — a per-tiny server field, so everyone who calls this tiny
    /// hears it). Writes via /api/control (worker /upsert), re-sending the
    /// persona so the worker's D1 mirror can't blank it. Returns true on save.
    func saveVoice(_ next: String) async -> Bool {
        guard isOwner else { return false }
        let token = Keychain.get("tiny_token")
        let ok: [String: Any]? = try? await Api.post("/api/control", token: token, body: [
            "name": tiny,
            "voice": next,
            // Re-send persona — the D1 mirror writes raw body.systemPrompt.
            "systemPrompt": ownerSystemPrompt,
            "systemKnowledge": ownerSystemKnowledge,
        ])
        // The control route returns { message: "Success!" } on a good save.
        if (ok?["message"] as? String) == "Success!" {
            voice = next
            return true
        }
        return false
    }

    /// Intro vibration: the tiny greets the visitor once per tiny-switch /
    /// app-open, only while the turn-zero landing is showing. Deliberately
    /// NOT gated by quiet hours — vibration is silent, and the vibrate tool
    /// itself runs ungated ("vibrate stays allowed", Session.runDeviceEvent).
    private func playIntroVibeIfNeeded() {
        guard messages.isEmpty, let vibe = introVibe, introVibePlayedFor != tiny else { return }
        introVibePlayedFor = tiny
        Haptic.shared.play(pattern: vibe, times: 1, intensity: 0.6)
    }

    /// 👀 Visit beacon — tells the tiny's owner someone opened their page
    /// (web fires this once per chat mount / tiny switch, Chat.tsx:405; the
    /// proxy attaches OUR identity from the auth token so the worker can skip
    /// owner-self-visits and name the visitor). Fire-and-forget: a beacon
    /// failure must never surface. Sends the token so the visit is attributed
    /// (an anonymous visit still records, but the owner can't be told who).
    func sendVisit() {
        let name = tiny
        let token = Keychain.get("tiny_token")
        Task {
            let _: [String: Any]? = try? await Api.post("/api/visit", token: token,
                                                         body: ["name": name])
        }
    }

    /// 💵 Up-front price lookup — the composer badge warns before a send hits
    /// the 402 paywall (web Chat.tsx:213 parity). MUST send the session token:
    /// /api/wallet gates EVERY action (pricing included) behind getSession →
    /// 401 (route.ts:40), so a tokenless call always fails and the badge never
    /// shows. Web works only because the browser auto-attaches the cookie; here
    /// we attach it explicitly. Signed-out visitors simply get no badge (they'd
    /// hit the sign-in paywall on send anyway). Clear first so a re-run for a
    /// NEW tiny never leaves the OLD tiny's paid badge stranded; only set when
    /// THIS lookup finds a price > 0.
    func loadPrice() async {
        let name = tiny
        priceMicro = nil
        let token = Keychain.get("tiny_token")
        guard token != nil else { return }   // signed out → no badge (parity)
        let body: [String: Any] = ["action": "pricing", "resource": "tiny:\(name.lowercased())"]
        guard let d: [String: Any] = try? await Api.post("/api/wallet", token: token, body: body),
              name == tiny else { return }
        // price_micro usually decodes as Int, but a JSON number the worker
        // serialized as a float (or an absurd `1e999` → Double.infinity) arrives
        // as Double — and `Int(Double.infinity)`/`Int(.nan)`/`Int(1e300)` all
        // TRAP FATALLY in Swift (crash on opening a paid tiny). Guard finite +
        // in-range before converting, the same crash class the withdraw parser
        // documents at Wallet.swift:207. Non-finite / out-of-range → 0 (no badge).
        let p: Int
        if let i = d["price_micro"] as? Int {
            p = i
        } else if let dbl = d["price_micro"] as? Double, dbl.isFinite, dbl >= 0, dbl < Double(Int.max) {
            p = Int(dbl)
        } else {
            p = 0
        }
        if p > 0 { priceMicro = p }
    }

    // History survives relaunch (web keeps it in localStorage per tiny;
    // here a JSON file per tiny in Documents). Legacy chat-history.json
    // (pre-per-tiny builds) is adopted as the "tiny" transcript.
    private static func store(_ tiny: String) -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let scoped = dir.appendingPathComponent("chat-history-\(tiny).json")
        if tiny == "tiny", !FileManager.default.fileExists(atPath: scoped.path) {
            let legacy = dir.appendingPathComponent("chat-history.json")
            if FileManager.default.fileExists(atPath: legacy.path) {
                try? FileManager.default.moveItem(at: legacy, to: scoped)
            }
        }
        return scoped
    }

    init() {
        load()
        // Backgrounding flush: the scenePhase observer lives in TinyApp,
        // which only owns TinySession — this model is a ChatView @StateObject
        // it can't reach, so observe the UIKit notification directly. The
        // @Sendable closure hops back to the MainActor via an unstructured
        // Task (Haptic.swift's engine-reset bridge, same pattern).
        bgObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in self?.flushForBackground() }
        }
        // Account switch: Continuity.scrubAllLocal() has just deleted this
        // model's file, but the model itself outlives that (ChatView mounts
        // before the scrub runs) and would re-persist the prior user's messages
        // on its next save. See scrubForAccountSwitch.
        scrubObserver = NotificationCenter.default.addObserver(
            forName: .tinyLocalDataScrubbed, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in self?.scrubForAccountSwitch() }
        }
        // Sign-out, with no identity change: keep the transcript on disk (a
        // same-user sign-in should find it) but drop the offline queue, which
        // would otherwise flush under the NEXT token to arrive.
        endObserver = NotificationCenter.default.addObserver(
            forName: .tinySessionEnded, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor in self?.dropQueuedSends() }
        }
    }

    // nonisolated(unsafe): written once in init, read once in deinit —
    // deinit is nonisolated in Swift 6 and NSObjectProtocol isn't Sendable,
    // but this single-assign lifecycle can't race.
    private nonisolated(unsafe) var bgObserver: NSObjectProtocol?
    private nonisolated(unsafe) var scrubObserver: NSObjectProtocol?
    private nonisolated(unsafe) var endObserver: NSObjectProtocol?

    deinit {
        if let bgObserver { NotificationCenter.default.removeObserver(bgObserver) }
        if let scrubObserver { NotificationCenter.default.removeObserver(scrubObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    }

    private func load() {
        if let data = try? Data(contentsOf: Self.store(tiny)),
           let saved = try? JSONDecoder().decode([ChatMessage].self, from: data) {
            messages = Self.reconcileInterrupted(saved)
        } else {
            messages = []
        }
        followups = []
    }

    /// Marker a killed-mid-reply bubble restores with (matches the italic
    /// "*⏹ stopped*" honesty-marker style).
    nonisolated static let interruptedMarker = "*⚠️ interrupted — the app was closed mid-reply*"

    /// Load-time reconcile (web reconcileInterruptedTools parity, applied at
    /// the same restore boundary): a transcript can come back mid-stream in
    /// two shapes, and both must not masquerade as finished answers —
    ///  • flagged: `liveAtSave` persisted true by a partial save — the
    ///    stream never reached its epilogue, wherever the bubble sits;
    ///  • legacy tail: histories saved before the flag existed end with a
    ///    user message + a truly EMPTY assistant bubble (the old
    ///    save-at-send shape). Empty text alone is NOT enough — render_ui/
    ///    speak/spawn-only turns carry real content with text "" and stay
    ///    untouched, as do historic empties earlier in the transcript.
    /// A marked bubble keeps any partial text, gains the ⚠️ interrupted
    /// marker, and gets failedPrompt = the nearest preceding user message's
    /// text so the Retry button appears (transport-error parity).
    nonisolated static func reconcileInterrupted(_ saved: [ChatMessage]) -> [ChatMessage] {
        var out = saved
        for i in out.indices {
            let m = out[i]
            out[i].liveAtSave = false // nothing is live at load time
            guard m.role == "assistant", m.failedPrompt == nil else { continue }
            let bare = m.text.isEmpty && m.tools.isEmpty && m.speech.isEmpty
                && m.ui.isEmpty && m.spawns.isEmpty && m.reasoning.isEmpty
            let legacyTail = bare && i == out.count - 1 && i > 0 && out[i - 1].role == "user"
            guard m.liveAtSave || legacyTail else { continue }
            guard let prompt = out[..<i].last(where: { $0.role == "user" })?.text else { continue }
            out[i].text = m.text.isEmpty
                ? Self.interruptedMarker
                : m.text + "\n\n" + Self.interruptedMarker
            out[i].failedPrompt = prompt
        }
        return out
    }

    private func save() {
        var recent = Array(messages.suffix(200))
        // Stamp bubbles that are still streaming: if this save turns out to
        // be the LAST one (app killed), load() knows they were cut off. The
        // epilogue's save runs after releaseStream, so a finished reply
        // re-persists with the flag cleared.
        for i in recent.indices {
            recent[i].liveAtSave = liveIds.contains(recent[i].id)
        }
        if let data = try? JSONEncoder().encode(recent) {
            try? data.write(to: Self.store(tiny), options: .atomic)
        }
    }

    func clear() {
        // Live streams write into their reply bubbles — cancel them ALL
        // before the array empties (web /clear parity; writes are
        // id-guarded, but streams into a cleared chat are pure waste and
        // hold `streaming` on).
        stopAllStreams()
        messages = []
        followups = []
        try? FileManager.default.removeItem(at: Self.store(tiny))
    }

    /// A DIFFERENT user signed in and `Continuity.scrubAllLocal()` erased every
    /// local per-tiny store. Drop what this model holds in MEMORY too.
    ///
    /// Deleting the files is not enough on its own, for two reasons:
    ///
    ///  1. this model may already hold the previous user's `messages` — ChatView
    ///     mounts as soon as `token` is set, which happens BEFORE the scrub in
    ///     `loadMe()` — and the next `save()` would write them straight back
    ///     into the file the scrub just deleted;
    ///  2. `queuedSends` was never cleared by anything, and `flushQueue` reads
    ///     `session.token` at CALL time — so offline messages typed by user A
    ///     were sent, verbatim, under user B's token on the next reconnect.
    ///     That one leaves the prior user's words in the NEW user's account.
    ///
    /// Streams are cancelled first: a reply in flight belongs to the previous
    /// user's turn and writes into a bubble that must not exist any more.
    /// Session over: forget messages typed offline but never sent.
    ///
    /// Narrower than `scrubForAccountSwitch` on purpose — the transcript stays,
    /// on disk and on screen, because a same-user sign-in should find it. Only
    /// the queue is unsafe to keep, because it is the one piece of state that
    /// gets ACTED ON later, under a token chosen at flush time rather than at
    /// type time.
    func dropQueuedSends() {
        queuedSends = []
    }

    func scrubForAccountSwitch() {
        stopAllStreams()
        messages = []
        followups = []
        queuedSends = []
        // Identity fields belong to whatever tiny the prior user was looking at;
        // the reload below repopulates them for the new session.
        heroURL = nil
        logoURL = nil
    }

    /// Switch the chat surface to another tiny (Universe tap / /tiny cmd)
    func switchTiny(_ name: String) {
        let clean = name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean != tiny else { return }
        if streaming { stopAllStreams() } // streams belong to the OLD tiny's transcript
        save()
        tiny = clean
        load()
        accent = .green
        heroURL = nil  // never flash the OLD tiny's banner while the new theme loads
        logoURL = nil        // same rule for the identity fields — the OLD
        introVibe = nil      // tiny's logo/vibe/chips/tagline must never leak
        customChips = nil    // into the NEW tiny's landing while its theme
        customTagline = nil  // loads
        isPrivate = false    // don't flash the OLD tiny's lock over the NEW
        isAuthorized = false // one; loadTheme re-derives both below
        isOwner = false      // never expose the OLD tiny's owner tools on the NEW
        voice = ""; ownerSystemPrompt = ""; ownerSystemKnowledge = ""
        priceMicro = nil     // never strand the OLD tiny's price badge over the NEW
        introVibePlayedFor = nil  // the new tiny gets to greet once
        // iPad sidebar selection state (Split.swift reads currentTiny)
        Router.shared.currentTiny = clean
        // Promote to the MRU + re-publish Home-Screen quick actions (android
        // parity: long-press the app icon → recent tinys → deep-link back).
        RecentTinys.record(clean)
        Task { await loadTheme() }
        Task { await loadPrice() }   // 💵 re-fetch the new tiny's price for the badge
        sendVisit()   // notify the new tiny's owner (web parity, per switch)
    }

    // ── Inline voice-call turns (docs/voice-sessions-design.md, inline-chat) ──
    // A live 📞 call writes straight into THIS thread: every spoken/typed user
    // turn and every assistant reply becomes a real ChatMessage — visible
    // immediately, persisted to the same per-tiny history file, and logged to
    // Continuity so the agent remembers the call like any chat.
    private var voiceReplyId: UUID?
    private var voiceLastUser = ""

    /// A user utterance was transcribed (or typed mid-call) — append it.
    func voiceUserSaid(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        voiceLastUser = t
        messages.append(ChatMessage(role: "user", text: t))
        save()
    }

    /// A fresh assistant voice turn began — open its live bubble.
    func voiceAssistantStarted() {
        let m = ChatMessage(role: "assistant", text: "")
        voiceReplyId = m.id
        messages.append(m)
    }

    func voiceAssistantDelta(_ delta: String) {
        guard !delta.isEmpty else { return }
        if voiceReplyId == nil { voiceAssistantStarted() }
        guard let id = voiceReplyId, let idx = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[idx].text += delta
    }

    /// The assistant voice turn finished (or was barged over) — finalize.
    func voiceAssistantDone() {
        defer { voiceReplyId = nil }
        guard let id = voiceReplyId, let idx = messages.lastIndex(where: { $0.id == id }) else { return }
        if messages[idx].text.isEmpty && messages[idx].images.isEmpty && messages[idx].ui.isEmpty {
            // Nothing visible landed (cancelled turn) — no empty bubble.
            messages.remove(at: idx)
            return
        }
        save()
        if !messages[idx].text.isEmpty {
            Continuity.appendTurn(tiny, q: voiceLastUser, a: messages[idx].text)
        }
        voiceLastUser = ""
    }

    // ── Voice-bridge round-trip media tools ─────────────────────────────────
    // Same executors chat routes to (ImageGen / Screenshot + the consent
    // machinery above), but the result returns over the call WS instead of
    // the chat mailbox — and the card lands on the live voice bubble so the
    // user SEES what the tiny just made mid-call.

    func voiceGenerateImage(prompt: String, style: String, token: String?) async -> [String: Any] {
        guard ImageGen.isSupported else {
            return ["ok": false, "error": "this device can't generate images on-device"]
        }
        guard let img = await ImageGen.shared.run(toolUseId: "voice-\(UUID().uuidString)",
                                                  prompt: prompt, style: style, token: token) else {
            return ["ok": false, "error": "image generation failed"]
        }
        voiceAttach(img)
        return ["ok": true, "url": img.url, "note": "the image card is visible in the chat"]
    }

    func voiceScreenshot(reason: String, token: String?) async -> [String: Any] {
        guard await askScreenshotConsent(reason: reason) else {
            return ["denied": true, "note": "the user declined this capture"]
        }
        let fallback = Screenshot.keyWindowSnapshot()
        guard let img = await Screenshot.shared.run(toolUseId: "voice-\(UUID().uuidString)",
                                                    token: token, fallback: fallback) else {
            return ["ok": false, "error": "capture failed"]
        }
        voiceAttach(img)
        return ["ok": true, "url": img.url]
    }

    #if canImport(MWDATCore) && canImport(MWDATCamera)
    /// 🕶️ meta_take_photo over the voice bridge — same capture+upload the
    /// chat executor uses, answered over the call's WS instead of the
    /// mailbox; the photo card lands on the live voice bubble.
    func voiceMetaTakePhoto(token: String?) async -> [String: Any] {
        do {
            let img = try await WearablesManager.shared.captureAndUpload(
                id: "voice-\(UUID().uuidString)", token: token)
            voiceAttach(img)
            return ["ok": true, "url": img.url]
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return ["ok": false, "error": message]
        }
    }
    #endif

    /// Post a plain payload to the chat tool-result mailbox (the round-trip
    /// tools' reply channel) — shared by the glasses status case and any
    /// future device tool that answers from held state.
    func postToolPayload(_ toolUseId: String, token: String?, payload: [String: Any]) async {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
            "toolUseId": toolUseId, "payload": json,
        ]) as [String: Any]
    }

    /// Attach a media card to the live voice bubble (opens one if the tiny
    /// is acting without narrating).
    private func voiceAttach(_ img: GeneratedImage) {
        if voiceReplyId == nil { voiceAssistantStarted() }
        guard let id = voiceReplyId, let idx = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[idx].images.append(img)
        save()
    }

    /// render_ui over the voice bridge — on native the "execution" IS the
    /// display: append the props card to the live voice bubble exactly like
    /// the chat stream's .renderUi event does (RenderUiCard renders it).
    func voiceRenderUi(title: String?, props: Any?) -> [String: Any] {
        var propsJson = "{}"
        if let props, JSONSerialization.isValidJSONObject(props),
           let d = try? JSONSerialization.data(withJSONObject: props) {
            propsJson = String(data: d, encoding: .utf8) ?? "{}"
        }
        if voiceReplyId == nil { voiceAssistantStarted() }
        guard let id = voiceReplyId, let idx = messages.lastIndex(where: { $0.id == id }) else {
            return ["ok": false, "error": "no live reply to attach the card to"]
        }
        messages[idx].ui.append(RenderUiItem(id: "voice-\(UUID().uuidString)", title: title, propsJson: propsJson))
        save()
        return ["ok": true, "note": "the card is now visible in the chat — mention it briefly out loud"]
    }

    /// Offline queue (north-star P1.5): text sends wait for the network
    @Published var queuedSends: [String] = []

    func flushQueue(token: String?) {
        // Queued sends fire as their own concurrent turns on reconnect;
        // each stream's epilogue drains one more, so a backlog unwinds.
        guard Net.shared.online, !queuedSends.isEmpty else { return }
        send(queuedSends.removeFirst(), token: token)
    }

    func send(_ text: String, token: String?, attachments: [PendingAttachment] = []) {
        // Concurrent turns — "parallel exploration with cross-visibility"
        // (web stream-registry Option B): every send fires immediately, even
        // while other replies stream — composer, voice utterances and
        // attachments alike. Each turn snapshots history as of ITS send
        // time, with still-streaming sibling replies riding along as
        // annotated partials, so back-to-back questions see each other's
        // in-progress answers. Only offline stays queue-based (mobile-
        // specific; the web has no offline analog).
        if !Net.shared.online && attachments.isEmpty {
            queuedSends.append(text)
            return
        }
        var userMsg = ChatMessage(role: "user", text: text)
        userMsg.thumbs = attachments.compactMap(\.thumb) // tiny previews persist; full base64 does not
        userMsg.docs = attachments.compactMap(\.docName)
        messages.append(userMsg)
        hapticSend += 1
        AgentLive.shared.start(tiny: tiny, prompt: text)
        followups = []
        let reply0 = ChatMessage(role: "assistant", text: "")
        messages.append(reply0)
        let replyId = reply0.id
        claimStream(replyId) // synchronous, before any await (web claim())
        save()

        // History: prior turns in Converse shape (server trims to 31).
        // Text-only — images ride the CURRENT turn once, not every turn after.
        // A prior bubble's text is "" for image-only user turns (send() above
        // stores text:"") and for assistant turns that emitted only render_ui/
        // speak/spawn deltas. Bedrock Converse rejects an empty text block, so
        // a photo-then-text sequence would 400 on the follow-up — substitute a
        // placeholder (same convention as the outgoing AttachmentCodec.blocks
        // "Have a look.") rather than dropping the turn, which would break the
        // user/assistant role alternation Converse also requires. Sibling
        // LIVE placeholders instead ride as annotated partials — turnHistory.
        let history = Self.turnHistory(prior: Array(messages.dropLast(2)), live: liveStartedAt)
        let userBlocks = attachments.isEmpty ? nil : AttachmentCodec.blocks(text: text, attachments: attachments)

        streamTasks[replyId] = Task {
            var reply = reply0
            do {
                let continuity = Continuity.buildContext(tiny)
                // 📍 Location context (web Chat.tsx geoOn / Android parity) —
                // resolved here because the fix is async (30s-cached,
                // 5s-bounded); toggle off / no grant → extraSystem unchanged.
                let geoBlock = await Geo.shared.contextIfEnabled()
                // 🕶️ Glasses context (location's sibling): one line when
                // linked, nil (byte-identical request) when not.
                #if canImport(MWDATCore) && canImport(MWDATCamera)
                let glassesBlock = WearablesManager.shared.contextIfLinked()
                #else
                let glassesBlock: String? = nil
                #endif
                let extraSystem = [continuity, geoBlock, glassesBlock].compactMap { $0 }.joined(separator: "\n\n")
                for try await ev in Api.chatStream(token: token, message: text, tiny: tiny, history: history, extraSystem: extraSystem.isEmpty ? nil : extraSystem, userBlocks: userBlocks) {
                    if Task.isCancelled { break }
                    switch ev {
                    case .text(let t):
                        reply.text += t
                        setReply(reply)
                    case .reasoning(let r):
                        reply.reasoning += r
                        setReply(reply)
                    case .usage(let inTok, let outTok, let cacheRead, let modelId):
                        reply.inTok += inTok
                        reply.outTok += outTok
                        reply.cacheReadTok += cacheRead
                        if let modelId { reply.modelId = modelId }
                        setReply(reply)
                    case .toolStart(let n):
                        activeTool = n
                        AgentLive.shared.tool(n)
                        if !reply.tools.contains(n) { reply.tools.append(n); setReply(reply) }
                    case .toolEnd: activeTool = nil
                    case .speak(let id, let sText, let voice):
                        // Card + autoplay — live event only, so restored
                        // history renders cards without surprise audio
                        reply.speech.append(SpeechItem(id: id, text: sText, voice: voice))
                        setReply(reply)
                        Speech.shared.autoplay(sText, id: id, voice: voice)
                    case .followups(let chips):
                        followups = chips
                    case .remember(let content, let tags):
                        // Same client-side memory the web writes to localStorage
                        Continuity.addMemory(tiny, content: content, tags: tags)
                    case .forget(let match):
                        Continuity.forgetMemory(tiny, match)
                    case .spawnTasks(let id, let prompts):
                        AgentLive.shared.spawn(done: 0, total: prompts.count)
                        // Fan-out tree: all nodes start "running"
                        let nodes = prompts.enumerated().map { SpawnNode(id: $0.offset + 1, prompt: $0.element, ok: nil, result: nil) }
                        reply.spawns.append(SpawnTreeItem(id: id, nodes: nodes, elapsedMs: nil))
                        setReply(reply)
                    case .spawnResults(let id, let resultsJson):
                        if let i = reply.spawns.firstIndex(where: { $0.id == id }) {
                            reply.spawns[i].apply(resultsJson: resultsJson)
                            setReply(reply)
                            let done = reply.spawns[i].nodes.filter { $0.ok != nil }.count
                            AgentLive.shared.spawn(done: done, total: reply.spawns[i].nodes.count)
                        }
                    case .renderUi(let id, let title, let propsJson):
                        reply.ui.append(RenderUiItem(id: id, title: title, propsJson: propsJson))
                        setReply(reply)
                    case .payQuote(let id, let quote, let priceMicro, let network, let payee, let expiresAt, let message, let url):
                        // Confirm-every-payment: surface the quote as an
                        // Approve/Decline card. No money moves until the tap.
                        reply.payQuotes.append(PayQuoteItem(
                            id: id, quote: quote, priceMicro: priceMicro,
                            network: network, payee: payee, expiresAt: expiresAt, message: message, url: url))
                        setReply(reply)
                    case .payResult(let id, let failed, let error):
                        // A pay_x402 outcome with no quote to approve — a tool
                        // failure or a free target. Show a terminal card so it
                        // isn't invisible (web/Android render one too).
                        reply.payResults.append(PayResultItem(id: id, failed: failed, error: error))
                        setReply(reply)
                    case .note(let n):
                        reply.text += reply.text.isEmpty ? "_\(n)_" : "\n\n_\(n)_"
                        setReply(reply)
                    case .vibrate(let pattern, let times, let intensity):
                        Haptic.shared.play(pattern: pattern, times: times, intensity: intensity)
                    case .flashlight(let mode, let times, let seconds):
                        Torch.shared.run(mode: mode, times: times, seconds: seconds)
                    case .deviceAction(let name, let argsJson):
                        DeviceTools.shared.handle(name: name, argsJson: argsJson)
                    case .mapTool(let name, let argsJson):
                        // 🗺️ pins/camera land on TinyMapView + the ambient map;
                        // placed-while-hidden pins keep (they show when 📍 goes on)
                        AgentMap.shared.handle(name: name, argsJson: argsJson)
                        // Acting on a HIDDEN map would be invisible — say where
                        // to look, once per reply (web toasts "tap 📍 to see it")
                        if !AgentMap.shared.mapVisible, name != "clear_map_markers" {
                            let hint = "_🗺️ your tiny is using the map — turn on 'Share location' in Settings to see it_"
                            if !reply.text.contains(hint) {
                                reply.text += reply.text.isEmpty ? hint : "\n\n" + hint
                                setReply(reply)
                            }
                        }
                    case .generateImage(let id, let prompt, let style):
                        // ROUND-TRIP tool: the server callback is blocked
                        // polling for OUR result, so no other events arrive
                        // while we generate inline (keepalives keep the SSE
                        // open). run() always posts an outcome — success or
                        // a friendly error the model can relay.
                        activeTool = "generate_image"
                        if let img = await ImageGen.shared.run(toolUseId: id, prompt: prompt, style: style, token: token) {
                            reply.images.append(img)
                            setReply(reply)
                        }
                        activeTool = nil
                    case .screenshot(let id, let reason):
                        // ROUND-TRIP tool, consent EVERY capture: the server
                        // callback is blocked polling for OUR result, so ask
                        // the user inline. Decline posts {denied:true} (a
                        // first-class outcome, not a retryable error); allow
                        // captures the whole screen via ReplayKit (self-window
                        // fallback) and appends the same card generate_image
                        // uses. run()/postDenied() always post an outcome.
                        activeTool = "screenshot"
                        if await askScreenshotConsent(reason: reason) {
                            let fallback = Screenshot.keyWindowSnapshot()
                            if let img = await Screenshot.shared.run(toolUseId: id, token: token, fallback: fallback) {
                                reply.images.append(img)
                                setReply(reply)
                            }
                        } else {
                            await Screenshot.shared.postDenied(toolUseId: id, token: token)
                        }
                        activeTool = nil
                    case .metaTakePhoto(let id):
                        // 🕶️ ROUND-TRIP through the glasses camera. The user
                        // already consented at link time (Meta AI permission
                        // flow) and capture LEDs on the glasses make it
                        // visible; runPhotoTool posts an outcome on EVERY
                        // path, so the server poll never strands.
                        activeTool = "meta_take_photo"
                        #if canImport(MWDATCore) && canImport(MWDATCamera)
                        if let img = await WearablesManager.shared.runPhotoTool(toolUseId: id, token: token) {
                            reply.images.append(img)
                            setReply(reply)
                        }
                        #else
                        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
                            "toolUseId": id,
                            "payload": #"{"ok":false,"error":"Meta glasses aren't supported on this device."}"#,
                        ]) as [String: Any]
                        #endif
                        activeTool = nil
                    case .metaRecordVideo(let id):
                        // 🎥 Toggle recording — GlassesRecorder holds state
                        // between the agent's start and stop calls and posts
                        // an outcome on every path (LED on while rolling).
                        activeTool = "meta_record_video"
                        #if canImport(MWDATCore) && canImport(MWDATCamera)
                        await GlassesRecorder.shared.runTool(toolUseId: id, token: token)
                        #else
                        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
                            "toolUseId": id,
                            "payload": #"{"ok":false,"error":"Meta glasses aren't supported on this device."}"#,
                        ]) as [String: Any]
                        #endif
                        activeTool = nil
                    case .metaListen(let id, let seconds):
                        // 👂 N seconds of the glasses mic → on-device
                        // transcript. Audio never leaves the phone; every
                        // path posts (rides the HUD transcriber if running).
                        activeTool = "meta_listen"
                        #if canImport(MWDATCore) && canImport(MWDATCamera)
                        await GlassesListener.shared.runTool(toolUseId: id, seconds: seconds, token: token)
                        #else
                        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
                            "toolUseId": id,
                            "payload": #"{"ok":false,"error":"Meta glasses aren't supported on this device."}"#,
                        ]) as [String: Any]
                        #endif
                        activeTool = nil
                    case .metaGlassesStatus(let id):
                        // 🕶️ Instant facts from state the app already holds.
                        activeTool = "meta_glasses_status"
                        #if canImport(MWDATCore) && canImport(MWDATCamera)
                        await postToolPayload(id, token: token,
                                                   payload: WearablesManager.shared.statusFacts())
                        #else
                        await postToolPayload(id, token: token,
                                                   payload: ["ok": true, "linked": false, "note": "glasses unsupported on this device"])
                        #endif
                        activeTool = nil
                    case .manageMessages(let action, let from, let to, let summary):
                        // Surgery is deferred to stream end — mutating the
                        // array mid-stream would shift the reply index
                        pendingManage.append((action, from, to, summary))
                    case .paywall(let priceMicro, let balanceMicro, let signedOut):
                        // A paid tiny with a short/absent balance. Surface a
                        // native paywall card (not a red error) and hold the
                        // prompt so Retry re-sends once funded. Web parity:
                        // Chat.tsx:1255. This is a terminal, non-scary state, so
                        // don't set failedPrompt (that renders the ⚠️ retry
                        // banner) — the card owns the Retry affordance itself.
                        reply.paywall = Paywall(priceMicro: priceMicro, balanceMicro: balanceMicro,
                                                signedOut: signedOut, prompt: text)
                        setReply(reply)
                    case .error(let e):
                        if reply.text.isEmpty {
                            reply.text = "⚠️ \(e)"
                            reply.failedPrompt = text // enables Retry (web parity)
                            setReply(reply)
                        } else {
                            // Error AFTER partial text: don't swallow it — the
                            // user would otherwise see a silently-truncated
                            // answer as if complete. Append an honest marker and
                            // enable Retry (partial text stays, web parity).
                            reply.text += "\n\n⚠️ \(e)"
                            reply.failedPrompt = text
                            setReply(reply)
                        }
                    case .done: break
                    }
                }
            } catch {
                // A user Stop cancels the task → this throws CancellationError,
                // but stopStreaming(id:) already wrote the honest "*⏹ stopped*"
                // marker. Don't clobber it with a scary error + Retry.
                if !(error is CancellationError) && !Task.isCancelled {
                    if reply.text.isEmpty {
                        reply.text = "⚠️ \(error.localizedDescription)"
                        reply.failedPrompt = text
                        setReply(reply)
                    } else {
                        // Transport dropped AFTER partial text (cell handoff,
                        // tunnel, flaky Wi-Fi — the common mobile case). Mirror
                        // the .error SSE branch: don't leave a truncated answer
                        // looking complete — mark it and enable Retry.
                        reply.text += "\n\n⚠️ \(error.localizedDescription)"
                        reply.failedPrompt = text
                        setReply(reply)
                    }
                }
            }
            releaseStream(replyId) // every exit path lands here (web finally)
            // P1.3 haptics: per-stream — a success thud when a turn lands
            // cleanly, an error buzz when it failed (both observed via
            // .sensoryFeedback on the chat view). Mirrors the send tick.
            if reply.failedPrompt != nil || reply.paywall != nil { hapticError += 1 } else { hapticDone += 1 }
            // Idle-only work waits for the LAST live stream: transcript
            // surgery (manage_messages mid-sibling would fight the by-id
            // bubble writes) + the Live Activity / activeTool teardown.
            if liveIds.isEmpty {
                activeTool = nil
                AgentLive.shared.finish(error: reply.failedPrompt != nil || reply.paywall != nil)
                applyPendingManage()
            }
            save()
            // A failed turn's `text` is just an "⚠️ <error>" marker (or partial +
            // marker). It must never masquerade as an answer in any downstream
            // sink — the widget snapshot (below), /share (:459) and /save already
            // exclude it; the continuity log did NOT, so a failed turn's error
            // marker was written to the turn log and then injected as "you
            // previously answered: ⚠️ Server hiccup…" context into every future
            // request. Gate the log on the same condition as the snapshot.
            if reply.failedPrompt == nil, reply.paywall == nil {
                // Turn log — survives Clear chat and the 31-message trim,
                // injected as continuity context on every future request
                Continuity.appendTurn(tiny, q: text, a: reply.text)
            }
            // R4: phone turns feed the widgets + the watch face too —
            // last exchange, top followup and memories ride the snapshot.
            // PRIVACY: a PRIVATE tiny must NEVER feed the snapshot — the
            // lock-screen/home widgets and the watch face render it WITHOUT
            // any authentication (anyone holding the locked phone or glancing
            // at the wrist sees lastQ/lastA + memory snippets). isPrivate gates
            // the composer (:1939), price badge (:2540), lock overlay (:1765)
            // and /share everywhere else; this sink was the one gap. Skip the
            // write entirely so a private turn leaves the prior snapshot intact
            // rather than leaking its own Q/A/memories to an unlocked surface.
            if !reply.text.isEmpty, reply.failedPrompt == nil, !isPrivate {
                var snap = WidgetStore.read()
                snap.lastQ = String(text.prefix(60))
                snap.lastA = String(reply.text.prefix(120))
                snap.lastAt = Date()
                snap.followup = followups.first.map { String($0.prefix(60)) }
                snap.followupAt = followups.isEmpty ? nil : Date()
                snap.memories = Continuity.memories(tiny).suffix(12).map { String($0.content.prefix(100)) }
                WidgetStore.write(snap)
                WidgetCenter.shared.reloadAllTimelines()
                WatchBridge.shared.snapshot = snap
                // Assigning `snapshot` alone doesn't reach the wrist — push
                // the context now, or the "Last answer" complication stays
                // stale until the next fleet-count change (~20min dedup).
                WatchBridge.shared.sync(token: Keychain.get("tiny_token"))
            }
            // Replied while away (web tab-title "● {name} replied" parity):
            // the answer landed inside the background-hold window but the
            // user already left — leave a banner so they know it's ready.
            // LAST finishing stream only, so N concurrent turns don't stack
            // N banners. No quiet-hours gate: Config.isQuietNow covers
            // audible agent actions, and DM banners (the precedent) post
            // ungated too.
            if liveIds.isEmpty, reply.failedPrompt == nil, !reply.text.isEmpty,
               UIApplication.shared.applicationState != .active {
                await Notify.post(title: "\(tiny) replied",
                                  body: String(reply.text.prefix(100)))
            }
            flushQueue(token: token)
        }
    }

    /// manage_messages surgery, applied post-stream. from/to are 1-based
    /// inclusive indices into the transcript; the just-finished turn (last
    /// two bubbles) is protected so the agent can't erase its own answer.
    private var pendingManage: [(String, Int?, Int?, String?)] = []
    private func applyPendingManage() {
        let ops = pendingManage
        pendingManage = []
        for (action, from, to, summary) in ops {
            guard action == "drop" || action == "compact" else { continue } // stats = read-only
            let editable = max(0, messages.count - 2)
            guard editable > 0 else { continue }
            let lo = max(0, (from ?? 1) - 1)
            let hi = min(editable - 1, (to ?? editable) - 1)
            guard lo <= hi else { continue }
            let removed = hi - lo + 1
            if action == "compact" {
                let note = ChatMessage(role: "assistant",
                                       text: "🧹 \(removed) messages compacted\(summary.map { " — \($0)" } ?? "")")
                messages.replaceSubrange(lo...hi, with: [note])
            } else {
                messages.removeSubrange(lo...hi)
            }
        }
    }

    /// 📤 Markdown transcript for export (P2.5 — web's /export parity)
    func exportMarkdown() -> String {
        var out = "# 🌱 \(tiny) — conversation export\n"
        out += "_\(Date().formatted(date: .abbreviated, time: .shortened)) · tiny.technology/\(tiny)_\n\n"
        for m in messages {
            let who = m.role == "user" ? "**You**" : "**\(tiny)**"
            out += "\(who):\n\(m.text)\n\n"
            if !m.tools.isEmpty { out += "_tools: \(m.tools.joined(separator: ", "))_\n\n" }
        }
        return out
    }

    /// Delete one message (context menu). A still-streaming bubble is
    /// protected — stop it first, then delete.
    func delete(_ msg: ChatMessage) {
        if liveIds.contains(msg.id) { return }
        messages.removeAll { $0.id == msg.id }
        save()
    }

    /// Named sessions: replace the live transcript with an archive's
    /// messages (SessionsView auto-backs-up the current one first)
    func replaceTranscript(with newMessages: [ChatMessage]) {
        if streaming { stopAllStreams() }
        messages = newMessages
        followups = []
        save()
    }

    /// 🔗 Share this conversation — server-stored snapshot (same
    /// POST /api/share the web uses; server sanitizes). Returns the public
    /// URL. Failed/empty turns are dropped client-side too.
    func shareConversation() async throws -> URL {
        let payload = messages.compactMap { m -> [String: Any]? in
            guard !m.text.isEmpty, m.failedPrompt == nil else { return nil }
            return ["id": m.id.uuidString, "role": m.role, "content": m.text]
        }
        guard !payload.isEmpty else { throw ApiError.badResponse }
        let resp: [String: Any] = try await Api.post("/api/share", token: nil,
                                                     body: ["name": tiny, "messages": payload])
        guard let urlStr = resp["url"] as? String, let url = URL(string: urlStr) else {
            throw ApiError.badResponse
        }
        return url
    }

    /// Edit & resend support: remove a user message AND its reply (the
    /// assistant message right after it, if any) — the composer takes the
    /// text, this clears the superseded turn. A still-streaming reply in
    /// the removed range is stopped first (id-scoped; siblings unaffected).
    func removeTurn(startingAt msg: ChatMessage) {
        guard let idx = messages.firstIndex(where: { $0.id == msg.id }) else { return }
        var upTo = idx + 1
        if upTo < messages.count, messages[upTo].role == "assistant" { upTo += 1 }
        for m in messages[idx..<upTo] where liveIds.contains(m.id) {
            stopStreaming(id: m.id)
        }
        messages.removeSubrange(idx..<upTo)
        save()
    }

    /// ⏹ Stop ONE in-flight stream — partial text stays (web parity: stop
    /// cancels upstream billing, keeps what already arrived). Siblings keep
    /// streaming (per-bubble stop).
    func stopStreaming(id: UUID) {
        guard let task = streamTasks[id] else { return }
        task.cancel()
        releaseStream(id)
        if liveIds.isEmpty {
            AgentLive.shared.finish()
            activeTool = nil
        }
        // Mark the truncation honestly on THAT bubble
        if let idx = messages.lastIndex(where: { $0.id == id }) {
            var m = messages[idx]
            if !m.text.isEmpty, !m.text.hasSuffix("*⏹ stopped*") {
                m.text += "\n\n*⏹ stopped*"
                messages[idx] = m
            } else if m.text.isEmpty {
                m.text = "*⏹ stopped*"
                messages[idx] = m
            }
        }
        save()
    }

    /// ⏹⏹ Stop every live stream (⌘. / "stop all" chip / clear / switch)
    func stopAllStreams() {
        for id in Array(streamTasks.keys) { stopStreaming(id: id) }
    }

    /// Retry a failed turn: drop the error bubble + its user message
    /// (send() re-appends both), then resend the held prompt. Legal while
    /// OTHER turns stream — the retry becomes a new concurrent turn; only
    /// a bubble that is itself still live is blocked.
    func retry(_ failed: ChatMessage, token: String?) {
        // A failed turn holds its prompt in failedPrompt; a paywalled turn holds
        // it in paywall.prompt (a 402 isn't a "failure" — the card owns Retry).
        guard let prompt = failed.failedPrompt ?? failed.paywall?.prompt,
              !liveIds.contains(failed.id) else { return }
        if let i = messages.firstIndex(where: { $0.id == failed.id }) {
            messages.remove(at: i)
            if i > 0, messages[i - 1].role == "user", messages[i - 1].text == prompt {
                messages.remove(at: i - 1)
            }
        }
        send(prompt, token: token)
    }
}

/// Centered wrapping chip row — the web hero's `flex flex-wrap
/// justify-center`. A plain HStack overflows narrow phones ("Show me what
/// a tiny can do"), and a horizontal ScrollView can't center its content;
/// greedy-pack chips into rows and center each row instead.
private struct CenteredFlow: Layout {
    var spacing: CGFloat = 8

    /// Greedy row packing: subview indices per row at the given width.
    private func rows(_ sizes: [CGSize], in width: CGFloat) -> [[Int]] {
        var out: [[Int]] = [[]]
        var x: CGFloat = 0
        for (i, s) in sizes.enumerated() {
            if !out[out.count - 1].isEmpty, x + s.width > width {
                out.append([])
                x = 0
            }
            out[out.count - 1].append(i)
            x += s.width + spacing
        }
        return out
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.replacingUnspecifiedDimensions().width
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let packed = rows(sizes, in: width)
        let height = packed.map { row in row.map { sizes[$0].height }.max() ?? 0 }
            .reduce(0, +) + spacing * CGFloat(max(0, packed.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        var y = bounds.minY
        for row in rows(sizes, in: bounds.width) {
            let rowWidth = row.reduce(CGFloat(0)) { $0 + sizes[$1].width }
                + spacing * CGFloat(max(0, row.count - 1))
            let rowHeight = row.map { sizes[$0].height }.max() ?? 0
            // Center the row, but never start left of the bounds: at large
            // Dynamic Type a single chip can be wider than the container, and
            // a negative offset would clip the START of the label (hiding the
            // readable beginning). Clamp so an over-wide row left-aligns and
            // clips only its trailing edge.
            var x = bounds.minX + max(0, (bounds.width - rowWidth) / 2)
            for i in row {
                subviews[i].place(at: CGPoint(x: x, y: y + (rowHeight - sizes[i].height) / 2),
                                  anchor: .topLeading, proposal: .unspecified)
                x += sizes[i].width + spacing
            }
            y += rowHeight + spacing
        }
    }
}

/// Turn-zero landing banner (web hero parity, Chat.tsx render): the owner's
/// image cover-fills the hero area anchored center-top, under a darkening
/// gradient — black 0.45 at the top → black 0.7 at 55% → the page background
/// by 96% — so the text above stays readable and the image fades into the bg.
/// Failure/empty AsyncImage phases render NOTHING (plain background): these
/// are arbitrary third-party URLs that may 404 or hotlink-block, and the web
/// shows no placeholder either.
/// ChatView's whole-surface overlay, extracted (type-checker budget — see the
/// .overlay call site): the private-room scrim + the map's fullScreenCover
/// host. The fade animation is scoped to THIS subtree, not the whole
/// ChatView — an .animation(value: isPrivate) on the outer view swept every
/// in-flight layout change into a 0.25s transaction when the theme fetch
/// flipped isPrivate, so the composer visibly glided in from the top-left.
/// The cover rides a zero-size clear host (allowsHitTesting(false) affects
/// this layer only — the presented modal lives in its own hierarchy).
/// Full-screen, not a sheet: map pan/zoom and sheet drag-to-dismiss fight
/// over the same gestures (Android MapSheet is a Dialog for the same reason).
private struct PrivateScrimMapHost: View {
    let isPrivate: Bool
    @Binding var showMap: Bool
    let token: String?

    var body: some View {
        ZStack {
            if isPrivate {
                Color.black
                    .opacity(0.22)
                    .ignoresSafeArea()
                    .transition(.opacity)
            }
            Color.clear
                .fullScreenCover(isPresented: $showMap) { TinyMapView(token: token) }
        }
        .allowsHitTesting(false)
        .animation(.easeInOut(duration: 0.25), value: isPrivate)
    }
}

private struct HeroBanner: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            if case .success(let image) = phase {
                Color.clear
                    .overlay(alignment: .top) {
                        image.resizable().scaledToFill()
                    }
                    .clipped()
                    .overlay {
                        LinearGradient(stops: [
                            .init(color: .black.opacity(0.45), location: 0),
                            .init(color: .black.opacity(0.7), location: 0.55),
                            .init(color: Color(.systemBackground), location: 0.96),
                            .init(color: Color(.systemBackground), location: 1),
                        ], startPoint: .top, endPoint: .bottom)
                    }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// ── Per-tiny landing logo (top-level `logo`) ──────────────────────────────

/// What renderer a logo URL needs (ChatModel.logoKind — pure, unit-tested).
enum LogoKind: Equatable { case video, gif, svg, image }

/// The owner's logo, centered above the tiny's name on the turn-zero
/// landing: ≤96pt tall, rounded-rect clipped, silent on any failure (these
/// are arbitrary third-party URLs — no placeholder, exactly like HeroBanner).
/// Static images ride AsyncImage; .svg renders in a transparent WKWebView
/// (UIImage can't decode SVG data, but WebKit can — matches web + Android's
/// Coil SvgDecoder path); .gif animates via CGImageSource frames; .mp4/.webm
/// loop muted via AVPlayerLooper (webm is not an AVFoundation codec on iOS,
/// so it degrades to nothing too).
/// Reduce Motion: animated formats show their first/poster frame instead.
private struct LandingLogo: View {
    let url: URL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch ChatModel.logoKind(for: url) {
            case .video:
                LogoVideoView(url: url, animate: !reduceMotion)
                    .frame(width: 220, height: 96)
            case .gif:
                LogoGIFView(url: url, animate: !reduceMotion)
                    .frame(width: 220, height: 96)
            case .svg:
                LogoSVGView(url: url)
                    .frame(width: 220, height: 96)
            case .image:
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFit()
                    }
                }
                .frame(maxWidth: 220, maxHeight: 96)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityHidden(true)
    }
}

/// Animated-GIF logo: fetch → CGImageSource frames → UIImageView (SwiftUI's
/// Image/AsyncImage only ever show a GIF's first frame). With Reduce Motion
/// the first frame is used alone. Failures render nothing.
private struct LogoGIFView: UIViewRepresentable {
    let url: URL
    let animate: Bool

    func makeUIView(context: Context) -> UIImageView {
        let v = UIImageView()
        v.contentMode = .scaleAspectFit
        v.clipsToBounds = true
        // UIImageView's intrinsic size is the image's — cap it so a huge
        // GIF can't blow the landing open before the .frame clips in
        v.setContentHuggingPriority(.defaultLow, for: .horizontal)
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        let url = url, animate = animate
        Task { @MainActor [weak v] in
            guard let (data, resp) = try? await URLSession.shared.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true
            else { return }
            v?.image = animate ? GIFDecoder.animatedImage(data) : UIImage(data: data)
        }
        return v
    }

    func updateUIView(_ uiView: UIImageView, context: Context) {}
}

/// GIF frame extraction (pure-ish — Data in, UIImage out, no UI touched).
enum GIFDecoder {
    /// Multi-frame GIF data → an animated UIImage; single-frame or non-GIF
    /// image data → its static image; garbage → nil.
    nonisolated static func animatedImage(_ data: Data) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(src)
        guard count > 1 else { return UIImage(data: data) }
        var frames: [UIImage] = []
        var duration: TimeInterval = 0
        for i in 0..<count {
            guard let cg = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
            frames.append(UIImage(cgImage: cg))
            duration += frameDelay(src, i)
        }
        guard !frames.isEmpty else { return nil }
        return UIImage.animatedImage(with: frames, duration: max(duration, 0.1))
    }

    /// Per-frame delay: unclamped preferred; browsers floor near-zero
    /// delays to 100ms, match that so hyperactive GIFs don't strobe.
    nonisolated static func frameDelay(_ src: CGImageSource, _ index: Int) -> TimeInterval {
        let props = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any]
        let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let d = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
            ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
        return d < 0.011 ? 0.1 : d
    }
}

/// SVG logo: UIImage can't decode SVG, so it rides a transparent WKWebView
/// that loads the URL and CSS-fits the vector into the frame (web + Android
/// render SVG logos too). Non-interactive, no scroll bounce, silent on any
/// failure. Animated SVGs (SMIL/CSS) animate for free — WebKit runs them.
private struct LogoSVGView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.isUserInteractionEnabled = false
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // Center + contain the vector in a transparent page (object-fit for
        // <img>) so any aspect ratio fits the 220×96 box like scaledToFit.
        let html = """
        <!DOCTYPE html><html><head><meta name="viewport" \
        content="width=device-width, initial-scale=1"><style>\
        html,body{margin:0;height:100%;background:transparent;overflow:hidden}\
        body{display:flex;align-items:center;justify-content:center}\
        img{max-width:100%;max-height:100%;object-fit:contain}\
        </style></head><body><img src="\(url.absoluteString)"></body></html>
        """
        web.loadHTMLString(html, baseURL: url)
    }
}

/// Looping muted video logo (mp4; webm URLs route here but AVFoundation
/// can't decode webm on iOS → blank). AVPlayerLooper + AVQueuePlayer for
/// gapless looping; with Reduce Motion the player never starts, so the
/// layer just shows the poster (first) frame once the item is ready.
private struct LogoVideoView: UIViewRepresentable {
    let url: URL
    let animate: Bool

    final class PlayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
        var looper: AVPlayerLooper?  // must outlive makeUIView or looping dies
    }

    func makeUIView(context: Context) -> PlayerView {
        let v = PlayerView()
        v.playerLayer.videoGravity = .resizeAspect
        let player = AVQueuePlayer()
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        v.looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        v.playerLayer.player = player
        if animate { player.play() }
        return v
    }

    func updateUIView(_ uiView: PlayerView, context: Context) {}

    static func dismantleUIView(_ uiView: PlayerView, coordinator: ()) {
        uiView.playerLayer.player?.pause()
        uiView.playerLayer.player = nil
        uiView.looper = nil
    }
}

/// A slash command surfaced in the composer autocomplete (web CommandPalette.tsx
/// + Android SlashCommand parity). `insert` is the text seeded when picked;
/// `runsImmediately` false = takes an argument, so we prefill + keep focus
/// (/tiny <name>) instead of sending. The catalog is scoped to EXACTLY the
/// commands ChatView.runSlashCommand handles — advertising one iOS can't run
/// would send it to the agent as literal text (a dead pick).
struct SlashCommand: Identifiable {
    let name: String
    let description: String
    let insert: String
    var runsImmediately = true
    var id: String { name }

    /// Fuzzy subsequence match on name+description (web fuzzyScore / Android
    /// `subseq` parity, case-insensitive). Empty query matches everything.
    func matches(_ query: String) -> Bool {
        score(query) != nil
    }

    /// Best (lowest) fuzzy score of the query against name OR description — the
    /// EXACT port of web's `fuzzyScore` (CommandPalette.tsx:70) folded over both
    /// fields (`min(fuzzyScore(q,name), fuzzyScore(q,description))`, palette
    /// `sections` useMemo). Lower is better; nil = no match. The palette ranks by
    /// this so the best match is the top row — the row Return runs. iOS + Android
    /// previously filtered by a boolean subseq in STATIC declaration order, so a
    /// query like "mem" surfaced /memory below whatever was declared first that
    /// happened to contain m-e-m, and Enter could fire the wrong command.
    func score(_ query: String) -> Int? {
        let q = query.lowercased()
        if q.isEmpty { return 0 }
        let n = Self.fuzzyScore(q, name.lowercased())
        let d = Self.fuzzyScore(q, description.lowercased())
        switch (n, d) {
        case let (n?, d?): return min(n, d)
        case let (n?, nil): return n
        case let (nil, d?): return d
        default: return nil
        }
    }

    /// Subsequence fuzzy score (web CommandPalette.tsx:70 `fuzzyScore`): a
    /// substring hit scores its index (earlier = better); a scattered
    /// subsequence scores `100 + gaps` so ANY substring hit outranks ANY
    /// subsequence. nil = the query isn't even a subsequence of the target.
    private static func fuzzyScore(_ q: String, _ target: String) -> Int? {
        if q.isEmpty { return 0 }
        let t = Array(target)
        let qc = Array(q)
        // Substring beats scattered subsequence — score = start index.
        if let r = target.range(of: q) { return target.distance(from: target.startIndex, to: r.lowerBound) }
        var ti = 0, gaps = 0, last = -1
        for ch in qc {
            var found = -1
            var i = ti
            while i < t.count {
                if t[i] == ch { found = i; break }
                i += 1
            }
            if found == -1 { return nil }
            if last != -1 { gaps += found - last - 1 }
            last = found
            ti = found + 1
        }
        return 100 + gaps  // any subsequence ranks below any substring hit
    }
}

/// The iOS palette catalog — kept in sync with ChatView.runSlashCommand's switch.
let IOS_SLASH_COMMANDS: [SlashCommand] = [
    SlashCommand(name: "clear", description: "Clear conversation history", insert: "/clear"),
    SlashCommand(name: "tiny", description: "Switch to another tiny by name", insert: "/tiny ", runsImmediately: false),
    SlashCommand(name: "loop", description: "Background loop — /loop [5m|2h] <prompt> on a schedule", insert: "/loop ", runsImmediately: false),
    SlashCommand(name: "memory", description: "Memory panel — facts, history, provenance", insert: "/memory"),
    SlashCommand(name: "graph", description: "Memory graph — facts & links, force-directed", insert: "/graph"),
    SlashCommand(name: "jobs", description: "Scheduled background jobs & loop history", insert: "/jobs"),
    SlashCommand(name: "devices", description: "Paired devices", insert: "/devices"),
    SlashCommand(name: "activity", description: "Activity feed — background run results", insert: "/activity"),
    SlashCommand(name: "universe", description: "Universe — browse & switch tinys", insert: "/universe"),
    SlashCommand(name: "map", description: "Live map — you, your tiny's pins, tiny users", insert: "/map"),
    SlashCommand(name: "cost", description: "Token usage & spend this session", insert: "/cost"),
    SlashCommand(name: "forgetall", description: "Erase all memories (irreversible)", insert: "/forgetall"),
    SlashCommand(name: "help", description: "List the slash commands", insert: "/help"),
]

struct ChatView: View {
    @EnvironmentObject var session: TinySession
    @StateObject private var chat = ChatModel()
    @State private var input = ""
    @State private var showNearby = false
    @State private var showMap = false
    @State private var showSettings = false
    @State private var showVoicePicker = false
    // 💳 Native wallet top-up sheet — opened from a paywall card's "Add funds",
    // the composer price badge, or a pay_x402 insufficient-funds card. Web opens
    // an in-app WalletSheet here (Chat.tsx showWallet:2574) rather than a
    // full-page /wallet nav; iOS used to kick out to Safari at every money
    // moment — jarring when a native WalletView already exists. Present it in
    // place so funding never leaves the chat, then Retry re-sends.
    @State private var showWallet = false
    // The paywalled message whose "Add funds" opened the wallet sheet, so a
    // successful top-up auto-continues the held turn instead of dropping the
    // user back onto a now-stale paywall card (web Cycle-92 onFunded parity).
    // Set ONLY from a paywall card's Add funds — the composer price badge opener
    // (:2516) leaves it nil, so dismissing there is a plain price refresh. The
    // sheet's onDismiss checks the FRESH balance before re-sending (iOS dismiss
    // fires on any close, funded or not — unlike web's success-only onFunded).
    @State private var paywallAwaitingFunds: ChatMessage?
    @State private var showUniverse = false
    @State private var showJobs = false
    @State private var showMemory = false
    @State private var showToolbox = false
    @State private var showDevices = false
    @State private var showMessages = false
    @State private var showRelayLog = false
    @State private var showActivity = false
    @State private var showGraph = false
    @State private var banner: String?
    // 🕶️ Glasses live HUD (absent on Catalyst — Wearables.swift explains).
    // Both pieces are pre-built small views: ChatView's body is AT the
    // type-checker's budget (voice-sessions arc) — inline closures here
    // tipped it into "unable to type-check in reasonable time".
    #if canImport(MWDATCore) && canImport(MWDATCamera)
    @State private var showGlassesLive = false
    @ObservedObject private var wearablesState = WearablesManager.shared

    @ViewBuilder private var glassesLiveOverlayView: some View {
        if showGlassesLive {
            GlassesLiveOverlay(shown: $showGlassesLive)
        }
    }

    private var glassesToolbarButton: some View {
        Button {
            TinyDesign.haptic()
            showGlassesLive.toggle()
        } label: {
            Image(systemName: "eyeglasses")
                .foregroundStyle(showGlassesLive ? Color.green : Color.primary)
        }
        .accessibilityLabel("Glasses live view")
    }
    #endif

    // 💎 The necklace's glasses-style live view (TinyLive.swift): LAN MJPEG +
    // PCM from the Nicla — same PiP card pattern, no MWDAT dependency.
    @State private var showTinyLive = false

    @ViewBuilder private var tinyLiveOverlayView: some View {
        if showTinyLive {
            TinyLiveOverlay(shown: $showTinyLive)
        }
    }

    private var tinyLiveToolbarButton: some View {
        Button {
            TinyDesign.haptic()
            showTinyLive.toggle()
        } label: {
            Image(systemName: "sparkles.tv")
                .foregroundStyle(showTinyLive ? Color.green : Color.primary)
        }
        .accessibilityLabel("Necklace live view")
    }
    @ObservedObject private var voice = VoiceMode.shared
    // 📞 Real speech-to-speech call (VoiceCall.swift) — a full-screen call
    // surface, distinct from VoiceMode's dictation-and-send.
    @StateObject private var call = VoiceCall()
    @ObservedObject private var net = Net.shared
    @ObservedObject private var updater = Updater.shared
    // 📎 Photos headed to the agent with the next message
    @State private var pending: [PendingAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showPhotos = false
    @State private var showFiles = false
    /// Highlighted row in the slash-command palette for hardware-keyboard nav
    /// (web CommandPalette `selected` / Android `paletteIndex`). ArrowUp/Down
    /// move it, Return runs the highlighted command — clamped to the live match
    /// count. iPad Magic-Keyboard users otherwise had no way to pick without
    /// tapping the screen.
    @State private var paletteIndex = 0
    /// Escape dismisses the slash-command palette without clearing the draft
    /// (web CommandPalette closes on Escape, CommandPalette.tsx:294). Set true
    /// when Escape fires while the palette is open; cleared the moment the draft
    /// changes so typing another character re-opens it. Lets a hardware-keyboard
    /// user who typed "/c" back out to send it literally instead of Enter
    /// running the highlighted command.
    @State private var paletteDismissed = false
    @FocusState private var focused: Bool
    /// Mirror of `focused` mutated one update LATER (onChange + withAnimation)
    /// so the border/glow fade runs in its own transaction. Animating off
    /// `focused` directly ran in the same transaction as the keyboard's
    /// safe-area shift, sweeping the composer's relocation into the fade —
    /// the box glided toward the top-left / down on every focus change.
    @State private var glowFocused = false
    /// Drives the voice-strip dot's expanding "ping" ring (web animate-ping).
    @State private var voicePing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    // iPad sidebar mailbox (Split.swift) — consumed via .onReceive below
    @ObservedObject private var router = Router.shared
    /// Transcript search (pull down on the title bar) — filters bubbles live
    @State private var searchQuery = ""
    /// True while a drag hovers the chat — drives the drop-target overlay
    /// (web parity: Chat.tsx's "Drop files to share" full-page veil)
    @State private var dropTargeted = false
    /// Server share link just created — presents the system share sheet
    @State private var shareURL: URL?
    /// Named sessions sheet (web's /save + /load)
    @State private var showSessions = false
    @State private var showCallRecordings = false
    @State private var showTranscripts = false
    /// /forgetall is irreversible (wipes ALL memories + the turn log) — web
    /// gates it behind confirm() (Chat.tsx:1602), android behind a re-run
    /// token. iOS wiped on the first bare /forgetall with no guard; hold it
    /// behind a native confirmation dialog instead.
    @State private var confirmForgetAll = false
    @State private var confirmClear = false

    private var visibleMessages: [ChatMessage] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return chat.messages }
        return chat.messages.filter { $0.text.localizedCaseInsensitiveContains(q) }
    }

    /// First half of the old `body` chain (NavigationStack + content + the
    /// sheet links). Split at a seam so each half type-checks as its OWN
    /// expression: the single chain sat exactly at the compiler's budget and
    /// went over three times (c9, c17×2) — every new `.sheet`/link was
    /// another "unable to type-check in reasonable time". `body` continues
    /// the chain from this opaque value at a fraction of the cost.
    private var chatCore: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcriptScroll

                // Command feedback banner (slash commands / tiny switch)
                if let b = banner {
                    Text(b)
                        .font(.caption2).foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal).padding(.vertical, 4)
                        .background(.green.opacity(0.1))
                        .onTapGesture { banner = nil }
                        .task {
                            try? await Task.sleep(for: .seconds(4))
                            banner = nil
                        }
                }

                // Offline / queued banner (north-star P1.5) — chrome speaks SF
                // Symbols (wifi.slash / arrow.up.circle), not emoji.
                if !net.online {
                    Label(chat.queuedSends.isEmpty ? "Offline — messages will queue and send when you're back"
                                                   : "Offline — \(chat.queuedSends.count) queued",
                          systemImage: "wifi.slash")
                        .font(.caption2).foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal).padding(.vertical, 4)
                        .background(.orange.opacity(0.1))
                } else if !chat.queuedSends.isEmpty {
                    Label("back online — sending \(chat.queuedSends.count) queued…",
                          systemImage: "arrow.up.circle")
                        .font(.caption2).foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal).padding(.vertical, 4)
                        .background(.green.opacity(0.1))
                }

                // Relay activity strip (web agent reached this phone) —
                // tap for the full history of what the fleet asked
                if !session.relayActivity.isEmpty {
                    Button {
                        showRelayLog = true
                    } label: {
                        Text(session.relayActivity)
                            .font(.caption2).foregroundStyle(.green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal).padding(.vertical, 4)
                            .background(.green.opacity(0.1))
                    }
                    .accessibilityLabel("Relay activity — show history")
                }

                // Followup chips (suggest_followups) — tap to send
                if !chat.followups.isEmpty && !chat.streaming {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(chat.followups, id: \.self) { chip in
                                Button {
                                    chat.send(chip, token: session.token)
                                } label: {
                                    Text(chip)
                                        .font(.footnote)
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(chat.accent.opacity(0.12), in: Capsule())
                                        .overlay(Capsule().stroke(chat.accent.opacity(0.35), lineWidth: 1))
                                        .foregroundStyle(chat.accent)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                    .padding(.vertical, 6)
                }

                // 🎙️ Voice strip (web parity): live transcript, auto-send on
                // a 3s pause — never fills the composer. Tinted with the per-tiny
                // accent (web `var(--tiny-accent)` Chat.tsx:2325), NOT a hardcoded
                // green, so it matches the Send button / mic / border on themed
                // tinys. The dot pulses like web's `animate-ping`, held static
                // under reduce-motion.
                if voice.active {
                    voiceStrip
                }

                // 📞 In-call strip (inline-chat design): the live call is part
                // of THIS chat, not a separate full-screen surface. Transcripts
                // land in the thread above as real messages; the composer stays
                // fully usable (typed text joins the call — see send()). Pulled
                // into its own property (callStrip) — inlined here it pushed
                // the container past SwiftUI's type-check budget.
                if call.status != .idle && call.status != .ended {
                    callStrip
                }

                // ⬆️ OTA update available — one tap, iOS swaps the app in place
                if let v = updater.available {
                    Button {
                        updater.installUpdate()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.down.circle.fill")
                            Text("Update available (build \(v)) — tap to install")
                                .font(.caption.weight(.semibold))
                            Spacer()
                        }
                        .foregroundStyle(.black)
                        .padding(.horizontal).padding(.vertical, 8)
                        .background(.green)
                    }
                }

                // 📎 Pending attachments preview moved INSIDE composerBox, above
                // the field (web Chat.tsx:2283 parity) — see the pendingStrip view.

                // ⏹⏹ "N replies streaming · stop all" (web Chat.tsx parity)
                // — only when more than one turn is live; a single stream's
                // stop lives on its bubble + in the composer button slot
                if chat.liveIds.count > 1 {
                    Button {
                        chat.stopAllStreams()
                    } label: {
                        Label("\(chat.liveIds.count) replies streaming · stop all", systemImage: "stop.circle")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.red.opacity(0.12), in: Capsule())
                            .foregroundStyle(.red)
                    }
                    .accessibilityLabel("Stop all \(chat.liveIds.count) streaming replies")
                    .padding(.top, 6)
                }

                // 💵 Up-front price badge moved INTO the composer toolbar next to
                // Send (composerToolbar, web Chat.tsx:2403 parity) — no longer a
                // separate banner row above the composer.

                // 🔒 Private tiny, this device NOT vouched: the composer is
                // replaced by a lock panel (web Chat.tsx:2580 lock-hero parity).
                // The owner never sees this — loadTheme sends their token, the
                // proxy vouches them (isAuthorized), and they get the normal
                // composer below (just under the darkened private treatment).
                if chat.isPrivate && !chat.isAuthorized {
                    PrivateLockPanel(
                        tiny: chat.tiny,
                        accent: chat.accent,
                        signedIn: session.token != nil,
                        onUnlock: { key in
                            Task { await unlockPrivate(key: key) }
                        }
                    )
                    .padding(.horizontal).padding(.vertical, 8)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                } else {
                // Web composer parity (Chat.tsx:2277, matching Android 679dd47):
                // ONE bordered rounded box owns the full width. The field spans
                // the top; the toolbar row ("+" attach left; camera/call + a
                // single morphing send/stop/mic right) sits BELOW it inside the
                // same border, so the icons never steal the field's horizontal
                // space. The border shows the tiny's accent — a steady glow,
                // brighter while focused (the old repeatForever "breathe" was
                // removed: it read as the whole bar throbbing up/down).
                composerBox
                .padding(.horizontal).padding(.vertical, 8)
                // P2.4 follow-through: the composer shares the transcript's
                // 760pt readable measure — full-width input under a centered
                // column read as misaligned on 11"+ canvases
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                // Multi-select up to the remaining capacity — web's file input is
                // `multiple` (Chat.tsx:2507), so picking 4 photos took ONE trip
                // there but FOUR separate picker opens on iOS (single item). Cap
                // the selection at the free slots so the picker itself stops the
                // user at MAX_ATTACHMENTS rather than silently dropping overflow.
                .photosPicker(isPresented: $showPhotos, selection: $photoItems,
                              maxSelectionCount: photoPickerLimit, matching: .images)
                .onChange(of: photoItems) { _, items in ingestPickedPhotos(items) }
                // 🎙️ Mic/speech permission denied → surface it (handler hoisted
                // out; an inline closure here tips the composer body past
                // SwiftUI's type-check budget — same reason composerField/
                // handleReturnKey are extracted).
                .onChange(of: voice.status) { _, s in handleVoiceStatusChange(s) }
                .fullScreenCover(isPresented: $showCamera) {
                    CameraPicker { image in
                        // appendAttachment enforces the total-payload cap (web
                        // parity) and sets the banner if the batch is too heavy.
                        if let att = AttachmentCodec.encode(image), appendAttachment(att) {
                            // Tactile confirm on attach — the drop/paste paths
                            // already buzz (1784/2592); the primary "+" menu
                            // paths (camera/library/document) were silent, so a
                            // dragged photo felt better than a tapped one.
                            TinyDesign.haptic()
                        }
                    }
                    .ignoresSafeArea()
                }
                .fileImporter(isPresented: $showFiles, allowedContentTypes: composerDocTypes, allowsMultipleSelection: false) { result in
                    guard case .success(let urls) = result, let url = urls.first else { return }
                    // Surface WHY a pick was rejected (oversize / unreadable) in the
                    // composer banner — web toasts it, Android sets vm.error; iOS used
                    // to drop the nil silently, so a >3MB doc pick just vanished.
                    switch AttachmentCodec.encodeDocument(url: url) {
                    case .ok(let att): if appendAttachment(att) { TinyDesign.haptic() }
                    case .err(let message): banner = message
                    }
                }
                } // end else (composer shown when not a locked private tiny)
            }
            // 🗺️ Ambient map (phase 2) — Color.clear until the Settings
            // location toggle is on; single-initializer host on the VStack's
            // (short) chain, NOT ChatView's outer chain (type-check budget).
            .background { AmbientMapHost() }
            // 📎 iPad drag-and-drop (web parity: page-wide drop overlay) —
            // drag images OR documents from Photos/Files/Safari in Split
            // View; each lands as a pending attachment, capped at
            // MAX_ATTACHMENTS like every other intake path. Data payloads
            // are images; URL payloads (Files/Mail drags) route through the
            // same encodeDocument the file picker uses (PDF/CSV/txt/…).
            .dropDestination(for: Data.self) { items, _ in
                var accepted = false
                for data in items {
                    guard pending.count < MAX_ATTACHMENTS else { break }
                    if let image = UIImage(data: data),
                       let att = AttachmentCodec.encode(image),
                       appendAttachment(att) {
                        accepted = true
                    }
                }
                if accepted { TinyDesign.haptic() }
                return accepted
            } isTargeted: { dropTargeted = $0 }
            .dropDestination(for: URL.self) { urls, _ in
                // Routing decisions are pure (AttachmentCodec.routeDrop,
                // unit-tested); this closure only executes them
                var accepted = false
                for intake in AttachmentCodec.routeDrop(urls: urls, pendingCount: pending.count) {
                    switch intake {
                    case .document(let url):
                        switch AttachmentCodec.encodeDocument(url: url) {
                        case .ok(let att): if appendAttachment(att) { accepted = true }
                        case .err(let message): banner = message
                        }
                    case .composerText(let link):
                        // Safari/Mail link drags: not a document — land the
                        // URL in the composer so it rides the next message
                        input = AttachmentCodec.mergeLink(input, link)
                        accepted = true
                    case .overCapacity:
                        break
                    }
                }
                if accepted { TinyDesign.haptic() }
                return accepted
            } isTargeted: { dropTargeted = $0 }
            // 📎 Drop-target veil (web's "Drop files to share" overlay):
            // an accent border + hint while a drag hovers; allowsHitTesting
            // false so the drop still lands on the destinations below
            .overlay {
                if dropTargeted { dropVeil }
            }
            .animation(.easeOut(duration: 0.15), value: dropTargeted)
            // Soft tick the moment the veil appears — the drag "landed"
            // on a live target (drop-accept has its own stronger haptic)
            .onChange(of: dropTargeted) { _, hovering in
                if hovering { TinyDesign.haptic() }
            }
            .searchable(text: $searchQuery, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search this chat")
            // Fluent edges: swipe in from the left → Universe, from the
            // right → Messages — the toolbar without the reach
            .simultaneousGesture(
                DragGesture(minimumDistance: 40)
                    .onEnded { v in
                        let w = UIScreen.main.bounds.width
                        if v.startLocation.x < 30, v.translation.width > 70 {
                            TinyDesign.haptic()
                            showUniverse = true
                        } else if v.startLocation.x > w - 30, v.translation.width < -70 {
                            TinyDesign.haptic()
                            showMessages = true
                        }
                    }
            )
            .navigationTitle(chat.tiny)
            // Sidebar picks (iPad split view) — route into this surface
            .onReceive(router.$openTiny) { picked in
                guard let picked else { return }
                router.openTiny = nil
                chat.switchTiny(picked)
                banner = "🌱 now chatting with \(chat.tiny)"
            }
            .onReceive(router.$openPanel) { panel in
                guard let panel else { return }
                router.openPanel = nil
                switch panel {
                case .memory: showMemory = true
                case .jobs: showJobs = true
                case .toolbox: showToolbox = true
                case .devices: showDevices = true
                case .messages: showMessages = true
                case .nearby: showNearby = true
                case .map: showMap = true
                case .settings: showSettings = true
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            // 🕶️ Floating live-glasses card, above the chat, draggable.
            // Rendering it via overlay (not a sheet) keeps the chat usable
            // while watching the stream — the PiP the user asked for.
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            .overlay(alignment: .topTrailing) {
                VStack(alignment: .trailing, spacing: 8) {
                    glassesLiveOverlayView
                    tinyLiveOverlayView
                }
            }
            #endif
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showUniverse = true } label: {
                        Image(systemName: TinyDesign.iconUniverse)
                            .fontWeight(.medium)
                    }
                    .accessibilityLabel("Tiny Universe")
                    // ⌘K — iPad hardware keyboard: universe is the palette
                    .keyboardShortcut("k", modifiers: .command)
                    .hoverEffect(.highlight)
                }
                // 🔒 Private-tiny title: the slug next to a lock glyph so the
                // owner always knows they're in a private room (the darkened
                // surface reinforces it). Only shown when private, so a public
                // tiny keeps the plain navigationTitle.
                if chat.isPrivate {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 5) {
                            Image(systemName: chat.isAuthorized ? "lock.open.fill" : "lock.fill")
                                .font(.caption2)
                                .foregroundStyle(chat.accent)
                            Text(chat.tiny)
                                .font(.headline)
                        }
                        .accessibilityLabel(chat.isAuthorized
                            ? "\(chat.tiny), private, unlocked"
                            : "\(chat.tiny), private, locked")
                    }
                }
                #if canImport(MWDATCore) && canImport(MWDATCamera)
                // 🕶️ The glasses icon appears the moment glasses are linked;
                // tap = live picture-in-picture from the glasses camera.
                ToolbarItem(placement: .topBarTrailing) {
                    if wearablesState.isLinked {
                        glassesToolbarButton
                    }
                }
                #endif
                // 💎 Necklace live view — the glasses button's sibling.
                ToolbarItem(placement: .topBarTrailing) {
                    if session.deviceId != nil || session.token != nil {
                        tinyLiveToolbarButton
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let u = session.user {
                            Text("@\(u.login)")
                        }
                        Button {
                            showMessages = true
                        } label: {
                            Label(
                                session.unreadDms > 0 ? "Messages (\(session.unreadDms))" : "Messages",
                                systemImage: session.unreadDms > 0 ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right"
                            )
                        }
                        Button {
                            showDevices = true
                        } label: {
                            Label("My devices", systemImage: "iphone.radiowaves.left.and.right")
                        }
                        Button {
                            showMemory = true
                        } label: {
                            Label("Memory", systemImage: "brain")
                        }
                        Button {
                            showJobs = true
                        } label: {
                            Label("Scheduled jobs", systemImage: "clock")
                        }
                        Button {
                            showToolbox = true
                        } label: {
                            Label("Toolbox", systemImage: "wrench.and.screwdriver")
                        }
                        Button {
                            showSettings = true
                        } label: {
                            Label("Settings", systemImage: "gearshape")
                        }
                        // Account menu order (user ask 2026-08-02): Messages in
                        // the first row, then My devices, Memory, Scheduled
                        // jobs, Toolbox, Settings — every
                        // other entry lives one level down in More. The interior
                        // keeps its pre-wrap indentation on purpose: this region
                        // is co-edited by a concurrent session and re-indenting
                        // would entangle the two diffs.
                        Menu {
                        if session.deviceId != nil {
                            Label("Device enrolled — live", systemImage: "iphone.radiowaves.left.and.right")
                        }
                        if chat.tiny != "tiny" {
                            Button {
                                chat.switchTiny("tiny")
                            } label: {
                                Label("Back to tiny", systemImage: "arrow.uturn.backward")
                            }
                        }
                        // Nearby left this menu when pairing moved into My
                        // devices (fe618556) — one place answers "what's
                        // around", not two. NearbyView itself stays for the
                        // iPad sidebar route.
                        Button {
                            showMap = true
                        } label: {
                            Label("Map", systemImage: "map")
                        }
                        Button {
                            showActivity = true
                        } label: {
                            Label(
                                session.unreadEvents > 0 ? "Activity (\(session.unreadEvents))" : "Activity",
                                systemImage: session.unreadEvents > 0 ? "bolt.fill" : "bolt"
                            )
                        }
                        // Owner-only: the live-call voice is a per-tiny server
                        // field — everyone who calls this tiny hears it.
                        if chat.isOwner {
                            Button {
                                showVoicePicker = true
                            } label: {
                                Label("Call voice", systemImage: "waveform.circle")
                            }
                        }
                        Button {
                            showSessions = true
                        } label: {
                            Label("Sessions", systemImage: "square.stack.3d.up")
                        }
                        // Group: the ViewBuilder is at its 10-child limit —
                        // Call recordings + Transcripts share a slot.
                        Group {
                            Button {
                                showCallRecordings = true
                            } label: {
                                Label("Call recordings", systemImage: "recordingtape")
                            }
                            Button {
                                showTranscripts = true
                            } label: {
                                Label("Transcripts", systemImage: "waveform.badge.mic")
                            }
                        }
                        if !chat.messages.isEmpty {
                            Button {
                                Task {
                                    do {
                                        let url = try await chat.shareConversation()
                                        shareURL = url
                                        UIPasteboard.general.string = url.absoluteString
                                        banner = "🔗 Share link copied"
                                    } catch {
                                        banner = "Share failed: \(error.localizedDescription)"
                                    }
                                }
                            } label: {
                                Label("Share link", systemImage: "link")
                            }
                            ShareLink(item: chat.exportMarkdown()) {
                                Label("Export conversation", systemImage: "square.and.arrow.up")
                            }
                            .keyboardShortcut("e", modifiers: [.command, .shift])
                        }
                        Button {
                            confirmClear = true
                        } label: {
                            Label("Clear chat", systemImage: "trash")
                        }
                        // ⌘N — hardware keyboard "new conversation"; the
                        // chord surfaces in the iPad ⌘-hold shortcut HUD
                        .keyboardShortcut("n", modifiers: .command)
                        } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                        Button(role: .destructive) { session.logout() } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "person.crop.circle").foregroundStyle(.green)
                    }
                    .accessibilityLabel("Account and chat options")
                }
            }
            .sheet(isPresented: $showSessions) { SessionsView(chat: chat) }
            .sheet(isPresented: $showCallRecordings) { CallRecordingsView() }
            .sheet(isPresented: $showTranscripts) { NiclaTranscriptsView() }
            .sheet(item: $shareURL) { url in
                // System share sheet for the fresh tiny.technology link
                ActivitySheet(items: [url])
                    .presentationDetents([.medium])
            }
            .sheet(isPresented: $showNearby) { NearbyView() }
            .sheet(isPresented: $showMessages) { MessagesView() }
            .sheet(isPresented: $showUniverse) {
                UniverseView(onPick: { picked in
                    chat.switchTiny(picked)
                    banner = "🌱 now chatting with \(picked)"
                }, token: session.token)
            }
            .sheet(isPresented: $showJobs) { JobsView(token: session.token) }
            .sheet(isPresented: $showToolbox) { ToolboxView(token: session.token) }
            .sheet(isPresented: $showMemory) { MemoryView(token: session.token, tiny: chat.tiny) }
            .sheet(isPresented: $showGraph) { MemoryGraphView(token: session.token) }
            .sheet(isPresented: $showDevices) { DevicesView(token: session.token, myDeviceId: session.deviceId) }
            .sheet(isPresented: $showSettings) { SettingsView() }
            // 💳 In-chat wallet top-up (web WalletSheet parity) — WalletView owns
            // a NavigationStack toolbar, so wrap it. On dismiss the price badge
            // re-loads so a just-funded balance is reflected without a full reload.
            .sheet(isPresented: $showWallet, onDismiss: handleWalletDismiss) {
                NavigationStack { WalletView(token: session.token) }
            }
            .sheet(isPresented: $showVoicePicker) {
                VoicePickerSheet(chat: chat)
                    .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showRelayLog) { RelayLogView() }
            .sheet(isPresented: $showActivity) {
                ActivityView(token: session.token) { maxId in session.markEventsSeen(maxId: maxId) }
            }
        }
    }

    var body: some View {
        chatCore
            // Extracted to a ViewModifier NOT for style: this modifier chain
            // sits at the type-checker's time budget — the Call-recordings
            // sheet addition tipped it into "unable to type-check in
            // reasonable time". Each extraction buys the chain slack.
            .modifier(ForgetAllDialog(chat: chat, confirm: $confirmForgetAll, banner: $banner))
            .confirmationDialog(
                "Clear conversation history?",
                isPresented: $confirmClear,
                titleVisibility: .visible
            ) {
                Button("Clear", role: .destructive) {
                    chat.clear()
                    banner = "🧹 Chat cleared"
                }
                Button("Cancel", role: .cancel) {}
            }
            // Screen-capture consent — asked EVERY time the agent calls the
            // screenshot tool (a screen can hold anything private). Allow
            // captures the whole screen (ReplayKit); Don't Allow posts a
            // decline the model treats as "the user said no", not an error.
            .alert(
                "Let \(chat.tiny) see your screen?",
                isPresented: Binding(
                    get: { chat.pendingScreenshot != nil },
                    set: { if !$0 { chat.resolveScreenshotConsent(false) } }
                ),
                presenting: chat.pendingScreenshot
            ) { _ in
                Button("Allow once") { chat.resolveScreenshotConsent(true) }
                Button("Don't allow", role: .cancel) { chat.resolveScreenshotConsent(false) }
            } message: { consent in
                Text(consent.reason.isEmpty
                     ? "It will capture your screen once and can read what's shown."
                     : "\(consent.reason)\n\nIt will capture your screen once and can read what's shown.")
            }
            // Widget/Shortcut deep links (tinyapp://voice|ask|messages) —
            // RootView catches the URL (survives cold launches) and parks it
            // in session.pendingRoute; consume on appear AND on change so
            // warm and cold paths both land.
            .onAppear { consumeRoute() }
            .onChange(of: session.pendingRoute) { consumeRoute() }
            // 📞🕸 Store-screenshot harnesses (DEBUG only).
            //
            // `--voice-call-harness` → VoiceCall.startHarnessCall: renders the real
            // in-call strip without placing a call, so an Apple-set voice capture
            // costs the user no OpenAI credit and writes nothing into their history.
            //
            // `--memory-graph-harness` → opens the Graph sheet (MemoryGraph.load
            // substitutes the demo dataset there). It has to be a launch flag and
            // not a deep link: `simctl openurl tinyapp://graph` puts a system
            // "Open in "tiny"?" confirmation ON TOP of the shot, and dismissing it
            // needs a tap the simulator CLI can't send.
            //
            // Both live in ONE .onAppear on purpose — this modifier chain is at the
            // type-checker's budget (see the .overlay note below), and a second
            // modifier here is what tips it over.
            .onAppear {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--voice-call-harness") {
                    call.startHarnessCall()
                }
                // Only the STILLS flag auto-opens. `--graph-dataset-harness`
                // swaps the dataset and opens nothing, so a video driver can
                // navigate to the sheet itself (auto-opening would put it on
                // screen during beat 1 and eat the driver's first tap).
                if GraphHarness.autoOpensSheet(arguments: ProcessInfo.processInfo.arguments) {
                    showGraph = true
                }
                // 🧠 Same split for the memory LIST sheet (MemoryHarness): only
                // the STILLS flag opens it. The list sheet draws the user's real
                // learnings just like the graph did, and it had no harness at all
                // until now — which is why every video's memory beat is on hold.
                if MemoryHarness.autoOpensSheet(arguments: ProcessInfo.processInfo.arguments) {
                    showMemory = true
                }
                // 💎 Same split again for My devices (DevicesHarness). This one
                // needs the auto-open more than the others: simctl can't send a
                // tap, and `openurl tinyapp://devices` puts an "Open in tiny?"
                // system alert in front of the screen being photographed.
                if DevicesHarness.autoOpensSheet(arguments: ProcessInfo.processInfo.arguments) {
                    showDevices = true
                }
                // `--map-tracking-harness` → opens the map full-screen with tracking
                // already on (TinyMapView.init sets it, since permission has to fire
                // on the "locate me" TAP and the CLI can't send one). Without this the
                // store shot was an idle basemap under the caption "Your phone becomes
                // a node" — no dot, no pins, no HUD.
                if ProcessInfo.processInfo.arguments.contains("--map-tracking-harness") {
                    showMap = true
                }
                #endif
            }
            // 📞 Switching tinys hangs up: the live call is bound to the OLD
            // tiny (its persona, its WS), but the transcript hooks write into
            // whatever thread is CURRENT — without this, a mid-call switch
            // bled the old tiny's call into the new tiny's history.
            .onChange(of: chat.tiny) {
                if call.status == .live || call.status == .connecting { call.stop() }
            }
            .onChange(of: net.online) {
                if net.online { chat.flushQueue(token: session.token) }
            }
        .tint(chat.accent)
        .environment(\.tinyAccent, chat.accent)
        // 🕶️ Private-mode treatment (user request: "the ui will look slightly
        // dark"): a soft dark scrim over the whole surface so a private room
        // FEELS different from the open universe. Non-hit-testing so it never
        // eats a tap; ignoresSafeArea so it reaches the edges under the bars.
        // Public tinys get nothing (opacity gates the whole overlay out).
        .overlay {
            // Extracted subview (not inline): the outer modifier chain sits at
            // the type-checker's budget — c9's one extra link broke the build,
            // so the whole scrim+map-host became a single initializer call.
            PrivateScrimMapHost(isPrivate: chat.isPrivate, showMap: $showMap, token: session.token)
        }
        .task { await chat.loadTheme() }
        .task { await chat.loadPrice() }   // 💵 price badge (web parity, per mount)
        .task { chat.sendVisit() }   // 👀 beacon once per mount (web parity)
        // Cold-start seed: the resident tiny never flows through switchTiny
        // (its clean != tiny guard), so record it here to publish the launcher
        // shortcuts on first mount too (android "refreshes on cold start").
        .task { RecentTinys.record(chat.tiny) }
    }

    private func consumeRoute() {
        // Quick-action deep link (tinyapp://tiny?name=<slug>) — switch first,
        // independent of the panel-route below.
        if let slug = session.pendingTiny {
            session.pendingTiny = nil
            chat.switchTiny(slug)
        }
        guard let route = session.pendingRoute else { return }
        session.pendingRoute = nil
        switch route {
        case "voice":
            if !voice.active {
                voice.toggle { text in chat.send(text, token: session.token) }
            }
        case "ask":
            // 💻/🤖 A trusted banner tap stashed its redeem turn (RedeemStash —
            // the text never rides the URL, so a Safari tinyapp://ask cannot
            // inject a prompt: empty stash → just focus, today's behavior).
            if let q = RedeemStash.take() {
                chat.send(q, token: session.token)
            } else {
                focused = true
            }
        case "messages":
            showMessages = true
        case "memory":
            // Memories widget deep link (tinyapp://memory) — was silently
            // consumed by the default branch, tap went nowhere
            showMemory = true
        default:
            break
        }
    }

    /// 📎 Pre-send attachment preview — image thumbnails + doc chips, each with
    /// its own ✕ remove (web Chat.tsx:2283). Rendered inside composerBox above
    /// the field so it reads as part of the message being composed.
    private var pendingStrip: some View {
        // Wrap the picks (FlexWrap, the project's flow layout) instead of a
        // horizontal ScrollView — web (flex-wrap, Chat.tsx:2540) and Android
        // (FlowRow) both wrap so EVERY pick stays visible, but iOS hid the
        // overflow behind a scroll: two 160pt doc chips (or 4 thumbs on a narrow
        // phone) slid a pick off-screen with no scroll affordance, so the user
        // couldn't see — or ✕-remove — what they'd staged. Wrapping grows the
        // strip down a row instead, matching both references. Capped at
        // MAX_ATTACHMENTS (4), so it's at most two short rows.
        FlexWrap(spacing: 8, lineSpacing: 8) {
            ForEach(Array(pending.enumerated()), id: \.element.id) { idx, att in
                    // Name each pick for VoiceOver (web `Remove ${att.name}` /
                    // Android "remove ${doc.name}" parity) — docs read by filename,
                    // images by position, so the remove buttons aren't an
                    // indistinguishable row of "Remove attachment".
                    let attName = att.docName ?? "image \(idx + 1)"
                    Group {
                        if let thumb = att.thumb {
                            AttachmentThumb(base64: thumb)
                                .accessibilityLabel("Attached \(attName)")
                        } else {
                            DocChip(name: att.docName ?? "document")
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        Button {
                            pending.removeAll { $0.id == att.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(.white, .red)
                                // The 16pt glyph alone is a cramped tap target in a
                                // thumbnail corner (cycle-34 sibling of the Send hit
                                // area). Center it in a 28pt tappable frame so the
                                // remove ✕ is comfortably hittable without growing
                                // the visible badge over the preview.
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Remove \(attName)")
                        .offset(x: 10, y: -10)
                    }
                }
            }
            .padding(.horizontal, 10).padding(.top, 8)
    }

    /// The whole composer: web Chat.tsx:2277 layout — a bordered rounded box
    /// with the field on top and the toolbar row below, a steady accent border.
    /// Matches Android 679dd47.
    private var composerBox: some View {
        // Steady accent border + glow — brighter while focused. The old
        // web-parity "breathe" (a repeatForever pulse on opacity + shadow
        // radius) was removed: even isolated onto this decorative overlay it
        // oscillated the glow silhouette 6↔12pt forever, which read as the
        // whole bar throbbing up/down (user-reported, twice). A constant glow
        // keeps the accent presence without any perpetual motion; only the
        // focus change animates, once.
        let borderOpacity = glowFocused ? 0.55 : 0.22
        let glowOpacity = glowFocused ? 0.28 : 0.10
        let glowRadius: CGFloat = glowFocused ? 12 : 6
        return VStack(spacing: 2) {
            // Slash-command autocomplete sits at the very top of the box (web
            // CommandPalette dropdown / Android CommandPalette). Non-empty only
            // while the draft is a bare "/token" — see paletteMatches.
            commandPalette
            // 📎 Pending attachments preview lives INSIDE the box, above the
            // field (web Chat.tsx:2283 — thumbnails read as "attached to THIS
            // message", not a floating strip above the composer). Empty → no row.
            if !pending.isEmpty { pendingStrip }
            composerField
            composerToolbar
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
        // Accent border + glow on a NON-hit-testing overlay so it can never
        // interfere with the composer's layout or taps. NO .animation here:
        // the fade is driven by the withAnimation in onChange below, in its
        // own transaction — an animation keyed on `focused` itself swept the
        // keyboard's relocation of the box into the fade (the top-left glide).
        .overlay(
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(chat.accent.opacity(borderOpacity), lineWidth: 1)
                .shadow(color: chat.accent.opacity(glowOpacity), radius: glowRadius)
                .allowsHitTesting(false)
        )
        // The box, its border overlay and the toolbar move/resize as ONE unit
        // when the keyboard or a collapsing multiline draft shifts the frame —
        // without this, the toolbar's own .animation(value:) transactions
        // could animate those ancestor-driven moves independently, detaching
        // pieces of the composer mid-flight.
        .geometryGroup()
        .onChange(of: focused) { _, now in
            if reduceMotion { glowFocused = now }
            else { withAnimation(.easeInOut(duration: 0.25)) { glowFocused = now } }
        }
    }

    /// True when the draft holds nothing sendable — whitespace/newlines don't
    /// count (web `input.trim()` Chat.tsx:2415/2422, Android `input.isNotBlank()`).
    /// Gates the camera↔send morph and the token estimate so a spaces-only draft
    /// doesn't surface a dead Send button (send() already refuses to fire it).
    private var draftEmpty: Bool {
        input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Content-driven text alignment (web textarea dir="auto", Chat.tsx:2737;
    /// Android TextDirection.Content, MainActivity.kt:1724): right-align the
    /// draft when its first strong-directional letter is RTL so an Arabic /
    /// Hebrew / Persian message lays out naturally even in an LTR-locale app.
    /// SwiftUI's TextField has no dir="auto" equivalent — resolve it from the
    /// first strong character the way the HTML/CSS "auto" rule does: skip
    /// neutrals (digits, punctuation, spaces, emoji), the first letter decides,
    /// LTR until one appears. Hoisted out of the body: inline scanning tips the
    /// composer expression past SwiftUI's type-check budget (same reason
    /// composerField / draftEmpty are hoisted).
    private var composerTextAlignment: TextAlignment {
        for ch in input {
            guard ch.isLetter, let v = ch.unicodeScalars.first?.value else { continue }
            // Strong RTL blocks: Hebrew/Arabic/Syriac/Thaana/N'Ko/Samaritan
            // (0590–08FF) + Arabic presentation forms A/B (FB1D–FDFF, FE70–FEFF).
            let rtl = (0x0590...0x08FF).contains(v) || (0xFB1D...0xFDFF).contains(v) || (0xFE70...0xFEFF).contains(v)
            return rtl ? .trailing : .leading
        }
        return .leading
    }

    /// Live slash-command matches for the composer autocomplete (web
    /// CommandPalette.tsx + Android `paletteMatches` parity). Open only while the
    /// draft is a bare "/token" with no space yet — once you type an argument
    /// (`/tiny bob`) the palette closes, exactly like Android (`startsWith("/")
    /// && !contains(" ")`). Empty when the composer isn't a command.
    private var paletteMatches: [SlashCommand] {
        guard !paletteDismissed else { return [] }
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("/"), !t.contains(" ") else { return [] }
        let q = String(t.dropFirst())
        // Rank by fuzzy score, best (lowest) first — web CommandPalette `sections`
        // useMemo (score → filter non-null → sort ascending). Previously a boolean
        // `.filter { $0.matches(q) }` kept STATIC declaration order, so for "mem"
        // the top row (the one Return runs) was whatever was declared first that
        // merely contained m-e-m, not the closest match /memory. A score tie keeps
        // declaration order (idx tiebreak = stable sort). Broken into typed steps —
        // the one-liner tripped the Swift type-checker's timeout.
        var scored: [(cmd: SlashCommand, score: Int, idx: Int)] = []
        for (idx, cmd) in IOS_SLASH_COMMANDS.enumerated() {
            if let s = cmd.score(q) { scored.append((cmd: cmd, score: s, idx: idx)) }
        }
        scored.sort { a, b in a.score != b.score ? a.score < b.score : a.idx < b.idx }
        return scored.map { $0.cmd }
    }

    /// Pick a palette command: run-immediately ones send straight through
    /// (send() routes them to runSlashCommand); arg-taking ones (/tiny, /loop)
    /// prefill the composer and keep focus so you can type the argument (web
    /// /auto prefill + Android pickCommand parity).
    private func pickCommand(_ cmd: SlashCommand) {
        if cmd.runsImmediately {
            input = cmd.insert
            send()
        } else {
            input = cmd.insert
            focused = true
        }
    }

    /// The autocomplete list rendered above the field inside composerBox (web
    /// CommandPalette dropdown / Android CommandPalette). Tap fills/runs a row;
    /// on a hardware keyboard ArrowUp/Down move the highlight (paletteIndex) and
    /// Return runs it (see handleReturnKey). The highlighted row gets an accent
    /// tint so the keyboard selection is visible (web `selected` highlight).
    @ViewBuilder private var commandPalette: some View {
        let matches = paletteMatches
        if !matches.isEmpty {
            let sel = min(max(paletteIndex, 0), matches.count - 1)
            // Cap the list and make it scroll — a bare "/" matches all 12
            // commands, which as an uncapped VStack overflowed above the
            // composer with no way to reach the bottom rows (Android
            // heightIn(max = 260.dp) + LazyColumn parity). ScrollViewReader keeps
            // the keyboard-highlighted row on screen as the selection moves (web
            // scrollIntoView({block:"nearest"}) / Android animateScrollToItem).
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(matches.enumerated()), id: \.element.id) { idx, cmd in
                            Button { pickCommand(cmd) } label: {
                                HStack(spacing: 8) {
                                    Text("/\(cmd.name)")
                                        .font(.system(.footnote, design: .monospaced).weight(.semibold))
                                        .foregroundStyle(chat.accent)
                                    Text(cmd.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(idx == sel ? chat.accent.opacity(0.12) : .clear)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .id(idx)
                            // VoiceOver parity with the visual highlight (web
                            // aria-selected + aria-activedescendant, Android
                            // semantics { selected } ffb5567): announce the moving
                            // keyboard selection and read the command + description
                            // as ONE element instead of two loose text leaves, so
                            // ArrowUp/Down through the palette isn't silent.
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("/\(cmd.name), \(cmd.description)")
                            .accessibilityAddTraits(idx == sel ? [.isButton, .isSelected] : .isButton)
                            if cmd.id != matches.last?.id {
                                Divider().opacity(0.4)
                            }
                        }
                    }
                }
                .frame(maxHeight: 260)
                .onChange(of: sel) { _, now in
                    withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(now, anchor: .center) }
                }
            }
            .padding(.top, 4)
            // Reset the highlight to the top whenever the live filter changes
            // the match set, so ArrowUp/Down never point past the list (Android
            // LaunchedEffect(paletteMatches.size) parity).
            .onChange(of: matches.count) { _, _ in paletteIndex = 0 }
        }
    }

    /// Toolbar row beneath the field (web Chat.tsx:2352): "+" attach on the
    /// left, then camera + voice-call (idle only) and the single morphing
    /// send/stop/mic action on the right.
    private var composerToolbar: some View {
        let composerEmpty = draftEmpty && pending.isEmpty
        return HStack(spacing: 4) {
            // ➕ One attach entry point: library / camera / files
            Menu {
                Button { showPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                }
                Button { showFiles = true } label: { Label("Document (PDF, CSV…)", systemImage: "doc") }
                // 📋 Paste a copied image (web Chat.tsx:2453 onPaste parity) —
                // shown only when the pasteboard actually holds an image, so it
                // never dead-ends. Cmd+V while the menu button is focused also
                // routes here via the standard paste action.
                if UIPasteboard.general.hasImages {
                    Button { pasteImages() } label: { Label("Paste Image", systemImage: "doc.on.clipboard") }
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(pending.count >= MAX_ATTACHMENTS ? .gray.opacity(0.4) : .gray)
                    .frame(minWidth: 40, minHeight: 40)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Attach photo or document")
            .disabled(pending.count >= MAX_ATTACHMENTS)
            .hoverEffect(.highlight)

            Spacer()

            // 📷 Quick camera + 📞 voice call — only while the composer is empty
            // and nothing streams; typing collapses them so the send action
            // owns the trailing slot and the toolbar stays uncluttered.
            if composerEmpty && !chat.streaming {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: {
                        Image(systemName: "camera")
                            .font(.system(size: 20))
                            // Dim + disable at the cap, matching the "+" attach
                            // menu (2419) and Android's quick-camera (`!atCap`) —
                            // a live camera button at 4/4 promises an intake the
                            // append then rejects.
                            .foregroundStyle(pending.count >= MAX_ATTACHMENTS ? .gray.opacity(0.4) : .gray)
                            .frame(minWidth: 40, minHeight: 40)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Take photo")
                    .disabled(pending.count >= MAX_ATTACHMENTS)
                    .hoverEffect(.highlight)
                    .transition(.scale.combined(with: .opacity))
                }
                Button { startInlineCall() } label: {
                    Image(systemName: "phone")
                        .font(.system(size: 20))
                        .foregroundStyle(.gray)
                        .frame(minWidth: 40, minHeight: 40)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Start a voice call")
                .hoverEffect(.highlight)
                .transition(.scale.combined(with: .opacity))
            }

            // 💵 Up-front price badge — folded INTO the toolbar next to Send
            // (web Chat.tsx:2403), replacing the old separate banner row above
            // the composer. Hidden for free tinys / behind the private lock.
            if let price = chat.priceMicro, !(chat.isPrivate && !chat.isAuthorized) {
                Button {
                    showWallet = true
                } label: {
                    Text("💵 \(priceLabel(price))/msg")
                        .font(.caption2.weight(.medium))
                        .monospacedDigit()
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(chat.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                        .foregroundStyle(chat.accent)
                }
                .accessibilityLabel("This tiny charges \(priceLabel(price)) per message — tap to add funds")
            }

            // 🪙 Draft token estimate (~4 chars/token, web Chat.tsx:2415) — only
            // while there's a real draft (whitespace-only doesn't count, web
            // `input.trim().length > 0`); a quiet cost cue right beside Send.
            if !draftEmpty {
                Text("~\(max(1, Int((Double(input.count) / 4).rounded(.up)))) tok")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.gray.opacity(0.7))
                    .padding(.trailing, 2)
                    .accessibilityLabel("About \(max(1, Int((Double(input.count) / 4).rounded(.up)))) tokens in the draft")
            }

            composerRightAction
        }
        .padding(.horizontal, 4).padding(.bottom, 2)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: composerEmpty)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: chat.streaming)
    }

    /// ⬆️/⏹/🎙️ The single morphing right action — Send when the composer holds
    /// text or attachments (wins even mid-stream, web parity), Stop-all when a
    /// reply streams behind an empty composer (⌘.), Mic (voice mode) otherwise.
    @ViewBuilder private var composerRightAction: some View {
        let composerEmpty = draftEmpty && pending.isEmpty
        if !composerEmpty {
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 34))
                    // Per-tiny accent (web Chat.tsx Send parity — var(--tiny-accent))
                    // with an accent glow (box-shadow 0 0 14px accent@0.25) so the
                    // ready-to-send button visibly "lights up".
                    .foregroundStyle(chat.accent)
                    .shadow(color: chat.accent.opacity(0.45), radius: 7)
                    // 44pt hit target (Apple HIG minimum) — the 34pt glyph alone
                    // gave Send a SMALLER tappable area than the mic it replaces
                    // (siblings all set a 40pt frame), so a tap where the mic just
                    // was could miss the primary action. contentShape makes the
                    // whole frame, not just the glyph, tappable.
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Send")
            .hoverEffect(.lift)
            .transition(.scale.combined(with: .opacity))
            // ⌘. must survive the Send swap while replies stream behind a
            // non-empty composer — invisible twin button.
            .background {
                if chat.streaming {
                    Button("") { chat.stopAllStreams() }
                        .keyboardShortcut(".", modifiers: .command)
                        .frame(width: 0, height: 0)
                        .opacity(0)
                        .accessibilityHidden(true)
                }
            }
        } else if chat.streaming {
            Button {
                chat.stopAllStreams()
            } label: {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(.red)
                    // Match Send's 44pt hit target (HIG) — same slot, same reach.
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Stop generating")
            .keyboardShortcut(".", modifiers: .command)
            .hoverEffect(.lift)
            .transition(.scale.combined(with: .opacity))
        } else {
            Button {
                // Entering/leaving voice mode is a mode switch with no send
                // glyph to confirm it — a firmer .rigid tick (vs the .soft attach
                // ticks) marks "mic engaged", so every composer action now has a
                // distinct tactile ack. The mic was the ONE silent control.
                TinyDesign.haptic(.rigid)
                voice.toggle { text in chat.send(text, token: session.token) }
            } label: {
                Image(systemName: voice.active ? "mic.fill" : "mic")
                    .font(.system(size: 22))
                    .foregroundStyle(voice.active ? chat.accent : .gray)
                    .symbolEffect(.pulse, isActive: voice.active && !reduceMotion)
                    .frame(minWidth: 40, minHeight: 40)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(voice.active ? "Stop voice mode" : "Start voice mode")
            // Toggle state for VoiceOver (web aria-pressed, Chat.tsx:2675) — the
            // "voice mode is ON" state was conveyed only visually (accent tint +
            // pulse); .isSelected makes VoiceOver announce "selected" so the
            // persistent on/off is perceivable, not just the next action.
            .accessibilityAddTraits(voice.active ? [.isButton, .isSelected] : .isButton)
            .hoverEffect(.highlight)
            .transition(.scale.combined(with: .opacity))
        }
    }

    /// The text composer, pulled out of the toolbar HStack so its modifier
    /// chain type-checks on its own (the inline expression blew SwiftUI's
    /// type-check budget once .onKeyPress was added).
    private var composerField: some View {
        // Borderless field — the bordered composer box (VStack) IS the frame
        // now (web Chat.tsx:2277 parity, matching Android 679dd47). The field
        // spans the full width on top; the toolbar row lives below it, so the
        // icons never steal the text's horizontal space. The breathing accent
        // glow moved to the container (see composerBox).
        // State-aware placeholder (web Chat.tsx:2445): voice mode names the
        // dictation affordance, otherwise it greets the tiny by name — a
        // static "ask tiny anything" lost both cues. (The private-locked case
        // web handles here shows a lock panel on iOS instead of the composer.)
        let placeholder = voice.active
            ? "🎙️ Voice mode — speak; typing still works"
            : "Message \(chat.tiny)…"
        return TextField(placeholder, text: $input, axis: .vertical)
            .lineLimit(1...5)
            // Content-driven alignment (web dir="auto" / Android
            // TextDirection.Content) — an RTL draft right-aligns as you type.
            .multilineTextAlignment(composerTextAlignment)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .focused($focused)
            // A multiline TextField (axis: .vertical) inserts a newline on
            // Return and NEVER fires .onSubmit, so a hardware-keyboard user's
            // Return did nothing — they had to reach for the send button (the
            // gap android fixed in 9d98e51). Intercept a bare Return to send;
            // Shift+Return still inserts a newline. Soft-keyboard unaffected.
            .onKeyPress(keys: [.return], action: handleReturnKey)
            // ⎋ Escape stops voice mode while focus is in the composer (web
            // Chat.tsx:2459 — "the mic button shouldn't be the only way out").
            // On the iPad hardware keyboard the mic tap was the sole exit. Only
            // swallow Escape while voice is live; otherwise let it pass through.
            .onKeyPress(keys: [.escape], action: handleEscapeKey)
            // ↑/↓ move the slash-command palette highlight (web CommandPalette /
            // Android paletteIndex). Only intercepted while the palette is open;
            // otherwise the arrows pass through for normal caret movement.
            .onKeyPress(keys: [.upArrow, .downArrow], action: handlePaletteArrow)
            // Any edit re-arms the palette after an Escape dismiss — typing a
            // character means the user wants suggestions again (web reopens as
            // the query changes). Keeps the flag from latching the palette shut.
            .onChange(of: input) { _, _ in if paletteDismissed { paletteDismissed = false } }
    }

    /// 📋 Paste image(s) from the system pasteboard → pending attachments (web
    /// Chat.tsx:2453 onPaste → handleIngestFiles). iOS had drag-and-drop but no
    /// paste — a copied screenshot/photo couldn't reach the composer. Mirrors
    /// the dropDestination encode path, honoring the same MAX_ATTACHMENTS cap;
    /// a light haptic confirms. Surfaced as a "+" menu item (gated on
    /// hasImages) so it's discoverable and works with Cmd+V's paste target.
    /// Free attachment slots for the photo picker's multi-select cap (≥1 so
    /// the picker never opens with a zero limit). Kept out of the view body:
    /// the inline `max(1, …)` tipped the composer expression over SwiftUI's
    /// type-check budget (the file already hoists composerField for this).
    private var photoPickerLimit: Int { max(1, MAX_ATTACHMENTS - pending.count) }

    /// Document types the "+" → Document picker accepts. Mirrors web's file
    /// `accept` list (Chat.tsx:2517) + Android's DOC_MIME_TYPES (Attachments.kt):
    /// pdf, csv, plain text, markdown, html, json, xml, and the Office formats
    /// (doc/docx/xls/xlsx). Was just [.pdf, .csv, .plainText, .html] — so a user
    /// literally COULDN'T pick a .docx/.xls/.xlsx/.md/.json/.xml that both other
    /// clients (and the backend) accept; those are built from MIME ids since the
    /// Office/markdown types have no stock UTType constant. Hoisted out of the
    /// view body (a long inline array tips SwiftUI's type-check budget).
    private var composerDocTypes: [UTType] {
        var types: [UTType] = [.pdf, .commaSeparatedText, .plainText, .html, .json, .xml]
        if let md = UTType(filenameExtension: "md") { types.append(md) }
        for mime in [
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ] {
            if let t = UTType(mimeType: mime) { types.append(t) }
        }
        return types
    }

    /// Stage one attachment unless it would push the batch past the total
    /// payload cap (web `attachmentsPayloadBytes(merged) > MAX_PAYLOAD_BYTES`,
    /// Chat.tsx:707). The per-item caps don't stop several large picks summing
    /// past the request budget, so a too-heavy set used to fail server-side on
    /// send; this rejects it up front with a banner naming the limit. Returns
    /// whether it was accepted so the callers gate their haptic/`added` flag.
    @discardableResult
    private func appendAttachment(_ att: PendingAttachment) -> Bool {
        // Count cap FIRST — the single-item camera + document-import callers
        // reach here without their own guard (unlike paste/drop/multi-photo,
        // which loop under `pending.count < MAX_ATTACHMENTS`). Without this a
        // capture/pick at the cap silently added a 5th attachment as long as it
        // fit the byte budget — Android's quick-camera is `enabled = !atCap`
        // and the "+" menu is `.disabled` at cap, so this centralizes parity.
        guard pending.count < MAX_ATTACHMENTS else {
            banner = "Up to \(MAX_ATTACHMENTS) attachments — remove one first"
            return false
        }
        guard pending.payloadBytes + att.payloadBytes <= MAX_ATTACHMENTS_PAYLOAD_BYTES else {
            let mb = Double(MAX_ATTACHMENTS_PAYLOAD_BYTES) / 1_048_576
            banner = String(format: "Attachments exceed %.1fMB total — remove some first", mb)
            return false
        }
        pending.append(att)
        return true
    }

    /// Ingest a multi-photo pick (web's `multiple` file input, Chat.tsx:2507):
    /// decode each up to the cap and append. The picker bounds the selection to
    /// photoPickerLimit, but the same MAX_ATTACHMENTS guard the paste/drop paths
    /// use protects against a fast re-pick before the strip updates.
    private func ingestPickedPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photoItems = []
        Task {
            var added = false
            for item in items {
                guard pending.count < MAX_ATTACHMENTS else { break }
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data),
                   let att = AttachmentCodec.encode(image),
                   appendAttachment(att) {
                    added = true
                }
            }
            // One tactile confirm for the whole pick — matches the drop/paste
            // and camera/document paths so every attach entry point buzzes.
            if added { TinyDesign.haptic() }
        }
    }

    private func pasteImages() {
        var added = false
        for image in UIPasteboard.general.images ?? [] {
            guard pending.count < MAX_ATTACHMENTS else { break }
            if let att = AttachmentCodec.encode(image), appendAttachment(att) { added = true }
        }
        if added { TinyDesign.haptic() }
    }

    /// Hardware-keyboard Return: when the slash-command palette is open it runs
    /// the highlighted row (web CommandPalette Enter / Android Key.Enter parity);
    /// otherwise it sends. Shift+Return always inserts a newline. Kept out of the
    /// view body so the composer expression stays type-checkable.
    private func handleReturnKey(_ press: KeyPress) -> KeyPress.Result {
        if press.modifiers.contains(.shift) { return .ignored }
        let matches = paletteMatches
        if !matches.isEmpty {
            let sel = min(max(paletteIndex, 0), matches.count - 1)
            pickCommand(matches[sel])
            return .handled
        }
        send()
        return .handled
    }

    /// ↑/↓ walk the palette highlight, clamped to the match count. Ignored when
    /// the palette is closed so the arrows keep their normal caret behavior.
    private func handlePaletteArrow(_ press: KeyPress) -> KeyPress.Result {
        let count = paletteMatches.count
        guard count > 0 else { return .ignored }
        let sel = min(max(paletteIndex, 0), count - 1)
        paletteIndex = press.key == .downArrow
            ? min(sel + 1, count - 1)
            : max(sel - 1, 0)
        return .handled
    }

    /// Hardware-keyboard Escape: first dismiss an open slash-command palette
    /// (web CommandPalette closes on Escape) so a "/c" draft can be sent
    /// literally instead of Enter running the highlighted command; else stop
    /// voice mode (web parity); else pass through so Escape keeps its normal
    /// behavior elsewhere.
    /// Surface a denied mic/speech permission. VoiceMode.start sets
    /// status="denied" and returns WITHOUT active=true, so the voice strip
    /// (gated on voice.active) never shows and the tap produced ZERO feedback —
    /// a silent dead-end. Web toasts on voice failure (Chat.tsx:2059); the
    /// banner is our transient channel (same one attachment errors use). Copy
    /// points at Settings since only the user can grant it.
    /// Wallet-sheet dismiss (extracted — the sheet chain sits at the
    /// type-checker's budget; this closure inline was the c17 straw). The
    /// price badge re-loads so a just-funded balance is reflected without a
    /// full reload. If Add funds was tapped from a paywall card and the
    /// wallet now COVERS that tiny's price, auto-continue the held turn —
    /// otherwise the user funds up and stares at a stale paywall, hunting
    /// for Retry (web Cycle-92 onFunded parity). iOS dismiss fires on any
    /// close, so gate on the FRESH balance: a user who just peeked (or
    /// funded too little) keeps the card, now showing the smaller shortfall
    /// (Cycle-91 copy).
    private func handleWalletDismiss() {
        let awaiting = paywallAwaitingFunds
        paywallAwaitingFunds = nil
        Task {
            await chat.loadPrice()
            guard let msg = awaiting, let pw = msg.paywall else { return }
            // Fetch failed → leave the card (don't auto-send on unknown balance).
            guard let d: [String: Any] = try? await Api.get("/api/wallet", token: session.token) else { return }
            let bal = (d["balance_micro"] as? NSNumber)?.intValue ?? -1
            if bal >= pw.priceMicro { chat.retry(msg, token: session.token) }
        }
    }

    private func handleVoiceStatusChange(_ status: String) {
        if status == "denied" {
            banner = "Microphone or speech access is off — enable it in Settings to use voice"
        }
    }

    private func handleEscapeKey(_ press: KeyPress) -> KeyPress.Result {
        if !paletteMatches.isEmpty {
            paletteDismissed = true
            paletteIndex = 0
            return .handled
        }
        guard voice.active else { return .ignored }
        voice.toggle { text in chat.send(text, token: session.token) }
        return .handled
    }

    /// micro-USDC → a trimmed "$0.01"/"$0.5" dollar string for the price badge
    /// (web Chat.tsx:2395 parity — toFixed(6) then strip trailing zeros so a
    /// sub-cent price isn't rounded to "$0.00").
    private func priceLabel(_ micro: Int) -> String {
        var s = String(format: "%.6f", Double(micro) / 1_000_000)
        while s.contains("."), s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return "$\(s.isEmpty ? "0" : s)"
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pending.isEmpty else { return }
        // Tactile send ack — Android's sendComposer buzzes (TextHandleMove,
        // MainActivity.kt) and the attach/mic paths here already tick, so Send,
        // the composer's PRIMARY action, was the one control with no haptic
        // (the mic-haptic note even claimed "every composer action" had one).
        // .soft = the gentle "content committed" tick the attach paths use; the
        // mic keeps .rigid for the mode-switch. Fires here so both the Send
        // button and the hardware-Return path get it, and only on a real send
        // (after the empty guard).
        TinyDesign.haptic()
        input = ""
        if text.hasPrefix("/"), runSlashCommand(text) { return }
        // 📞 In-call composer routing (inline-chat design): a TYPED message
        // joins the live call — the tiny hears it and answers in voice; the
        // reply lands in this same thread via the transcript hooks. Attachments
        // can't ride a realtime session, so they take the normal chat turn.
        if call.status == .live, pending.isEmpty, !text.isEmpty {
            chat.voiceUserSaid(text)
            call.sendUserText(text)
            return
        }
        let attachments = pending
        pending = []
        chat.send(text, token: session.token, attachments: attachments)
    }

    /// 🎙️ The live-voice strip body (kept out of the main VStack expression —
    /// SwiftUI's type-checker exceeded its budget with it inlined, same as
    /// callStrip). Live transcript + pulsing dot + mic-level meter.
    private var voiceStrip: some View {
        HStack(spacing: 8) {
            ZStack {
                // Expanding ring (web animate-ping) — a decorative pulse
                // behind the solid dot; only while actively listening.
                Circle().fill(chat.accent)
                    .frame(width: 7, height: 7)
                    .scaleEffect(voicePing ? 2.4 : 1)
                    .opacity(voicePing ? 0 : 0.6)
                Circle().fill(chat.accent).frame(width: 7, height: 7)
                    .opacity(voice.status == "hearing" ? 1 : 0.5)
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) {
                    voicePing = true
                }
            }
            .onDisappear { voicePing = false }
            Text(voice.partial.isEmpty
                 ? (voice.status == "hearing" ? "Hearing you…" : "Listening — pause 3s to send")
                 : voice.partial)
                .font(.caption)
                .foregroundStyle(voice.partial.isEmpty ? .secondary : .primary)
                .lineLimit(2)
            Spacer(minLength: 8)
            // Live mic level meter (web Chat.tsx:2340 voiceLevelRef,
            // scaleX(min(1,rms*8))) — a 44×3 accent bar filling from
            // the left, smoothed so it tracks speech without jitter.
            Capsule().fill(chat.accent.opacity(0.15))
                .frame(width: 44, height: 3)
                .overlay(alignment: .leading) {
                    Capsule().fill(chat.accent)
                        .frame(width: 44 * CGFloat(voice.level), height: 3)
                }
                .animation(.linear(duration: 0.12), value: voice.level)
        }
        .padding(.horizontal).padding(.vertical, 6)
        .background(chat.accent.opacity(0.08))
    }

    /// 📞 The in-call strip body (kept out of the main VStack expression —
    /// SwiftUI's type-checker gave up with it inlined).
    private var callStrip: some View {
        HStack(spacing: 8) {
            Image(systemName: call.status == .error ? "phone.down.fill" : "phone.fill")
                .font(.caption)
                .foregroundStyle(call.status == .error ? Color.red : chat.accent)
                .symbolEffect(.pulse, isActive: call.status == .live && !reduceMotion)
            Text(call.status == .connecting ? "Calling \(chat.tiny)…"
                 : call.status == .live ? "In call with \(chat.tiny) — recorded; type or talk"
                 : (call.errorText ?? "Call failed"))
                .font(.caption)
                .foregroundStyle(call.status == .error ? Color.red : Color.primary)
                .lineLimit(2)
            Spacer(minLength: 8)
            if call.status == .live {
                // Mic level — same 44×3 meter as the voice strip above.
                Capsule().fill(chat.accent.opacity(0.15))
                    .frame(width: 44, height: 3)
                    .overlay(alignment: .leading) {
                        Capsule().fill(chat.accent)
                            .frame(width: 44 * CGFloat(call.level), height: 3)
                    }
                    .animation(.linear(duration: 0.12), value: call.level)
            }
            if call.byokRequired {
                Button("Add key") { call.dismiss(); showSettings = true }
                    .font(.caption.weight(.semibold))
            }
            Button {
                if call.status == .error { call.dismiss() } else { call.stop() }
            } label: {
                Text(call.status == .error ? "Dismiss" : "End")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.red)
            }
            .accessibilityLabel(call.status == .error ? "Dismiss call error" : "End the call")
        }
        .padding(.horizontal).padding(.vertical, 6)
        .background((call.status == .error ? Color.red : chat.accent).opacity(0.08))
    }

    /// 📞 Start the call INSIDE this chat (inline-chat design, replaces the
    /// old full-screen VoiceCallView): transcripts land in the thread as real
    /// messages (visible + persisted + Continuity), typed composer text joins
    /// the call, and tool calls run on the same device executors chat uses.
    private func startInlineCall() {
        guard call.status == .idle || call.status == .ended || call.status == .error else { return }
        call.onUserTranscript = { [weak chat] in chat?.voiceUserSaid($0) }
        call.onResponseStarted = { [weak chat] in chat?.voiceAssistantStarted() }
        call.onAssistantDelta = { [weak chat] in chat?.voiceAssistantDelta($0) }
        call.onResponseDone = { [weak chat] in chat?.voiceAssistantDone() }
        call.onBargeIn = { [weak chat] in chat?.voiceAssistantDone() }
        call.onToolCall = { id, name, args in runVoiceTool(id: id, name: name, args: args) }
        // Continuity rides into the session instructions — the voice agent
        // starts knowing what the chat agent knows (memories + recent turns).
        // Resolve the "tiny" default to the user's configured tiny the SAME
        // way Api.chat routes requests — otherwise a custom-default user
        // chats with THEIR tiny but the call answers as the meta-agent.
        // Continuity stays keyed by chat.tiny: that's the key this surface
        // reads/writes turns under (see buildContext/appendTurn call sites).
        let target = chat.tiny != "tiny" ? chat.tiny : Config.tinyName
        // 🕶️ Glasses context rides into the session instructions beside
        // continuity — the voice agent starts a call knowing whether the
        // glasses are worn and ready, exactly like the chat agent does.
        #if canImport(MWDATCore) && canImport(MWDATCamera)
        let voiceContext = [Continuity.buildContext(chat.tiny), WearablesManager.shared.contextIfLinked()]
            .compactMap { $0 }.joined(separator: "\n\n")
        #else
        let voiceContext = Continuity.buildContext(chat.tiny)
        #endif
        call.start(tiny: target, token: session.token, context: voiceContext)
    }

    /// Voice-call tool bridge: execute with the SAME executors the chat stream
    /// routes to (Haptic/Torch/DeviceTools + the ChatModel media round-trips),
    /// then return the result up the WS. Every path MUST reply — an
    /// unanswered tool_call leaves the model hanging mid-call.
    private func runVoiceTool(id: String, name: String, args: [String: Any]) {
        switch name {
        case "render_ui":
            // The roster advertises the NATIVE props-only contract — the card
            // lands on the live voice bubble; without this case the default
            // arm told the model "not available on this device yet".
            call.sendToolResult(id: id, output: chat.voiceRenderUi(title: args["title"] as? String,
                                                                   props: args["props"]))
            return
        case "generate_image":
            Task {
                let out = await chat.voiceGenerateImage(prompt: args["prompt"] as? String ?? "",
                                                        style: args["style"] as? String ?? "",
                                                        token: session.token)
                call.sendToolResult(id: id, output: out)
            }
            return
        case "screenshot":
            Task {
                let out = await chat.voiceScreenshot(reason: args["reason"] as? String ?? "",
                                                     token: session.token)
                call.sendToolResult(id: id, output: out)
            }
            return
        case "meta_take_photo":
            // 🕶️ Every path replies (the manager throws words, not silence);
            // on a build without the SDK the default arm below answers.
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            Task {
                let out = await chat.voiceMetaTakePhoto(token: session.token)
                call.sendToolResult(id: id, output: out)
            }
            return
            #else
            break
            #endif
        case "meta_record_video":
            // 🎥 Same toggle core as chat, answered over the call's WS.
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            Task {
                let out = await GlassesRecorder.shared.toggle(token: session.token)
                call.sendToolResult(id: id, output: out)
            }
            return
            #else
            break
            #endif
        case "meta_glasses_status":
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            call.sendToolResult(id: id, output: WearablesManager.shared.statusFacts())
            return
            #else
            break
            #endif
        case "learn", "recall", "unlearn", "send_message", "read_messages",
             "nicla_take_photo", "nicla_take_video", "nicla_listen", "nicla_status":
            // Server tools (worker-backed memory + DMs + the 💎 necklace) —
            // /api/voice/tool runs the same session-bound tool objects chat
            // mounts. viaTiny stamps the sender surface for send_message.
            Task {
                let out: [String: Any]
                do {
                    let r: [String: Any] = try await Api.post("/api/voice/tool", token: session.token,
                                                              body: ["name": name, "args": args, "viaTiny": chat.tiny])
                    out = (r["ok"] as? Bool == true) ? (r["result"] as? [String: Any] ?? r) : r
                } catch {
                    out = ["ok": false, "error": error.localizedDescription]
                }
                call.sendToolResult(id: id, output: out)
            }
            return
        default: break
        }
        var output: [String: Any] = ["ok": true]
        switch name {
        case "vibrate":
            Haptic.shared.play(pattern: args["pattern"] as? String ?? "success",
                               times: args["times"] as? Int ?? 1,
                               intensity: args["intensity"] as? Double ?? 1.0)
        case "flashlight":
            Torch.shared.run(mode: args["mode"] as? String ?? "blink",
                             times: args["times"] as? Int ?? 1,
                             seconds: args["seconds"] as? Double ?? 1.0)
        case "copy_to_clipboard", "set_brightness", "play_sound",
             "schedule_alert", "cancel_alerts", "open_url":
            let json = (try? JSONSerialization.data(withJSONObject: args))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            DeviceTools.shared.handle(name: name, argsJson: json)
        case "remember":
            // Same Continuity store the chat stream's remember/forget route to.
            let content = (args["content"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if content.isEmpty {
                output = ["ok": false, "error": "content required"]
            } else {
                Continuity.addMemory(chat.tiny, content: content, tags: args["tags"] as? [String])
                output = ["ok": true, "note": "remembered"]
            }
        case "forget":
            let match = (args["match"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if match.isEmpty {
                output = ["ok": false, "error": "match required"]
            } else {
                output = ["ok": true, "removed": Continuity.forgetMemory(chat.tiny, match)]
            }
        default:
            // A roster tool this build doesn't know locally — forward to the
            // voice bridge proxy instead of dead-ending: server-roster
            // additions then work on STALE builds, and a truly unknown name
            // gets the proxy's honest 404 note back.
            Task {
                let out: [String: Any]
                do {
                    let r: [String: Any] = try await Api.post("/api/voice/tool", token: session.token,
                                                              body: ["name": name, "args": args, "viaTiny": chat.tiny])
                    out = (r["ok"] as? Bool == true) ? (r["result"] as? [String: Any] ?? r) : r
                } catch {
                    out = ["ok": false, "error": error.localizedDescription]
                }
                call.sendToolResult(id: id, output: out)
            }
            return
        }
        call.sendToolResult(id: id, output: output)
    }

    /// Unlock a private tiny for this device — mirrors web's /api/login
    /// (Chat.tsx applyUnlock): a signed-in OWNER unlocks with no key (their
    /// session vouches them); a visitor supplies the access key. On success
    /// (`isAuthorized`) the lock panel gives way to the composer and the
    /// slug's lock glyph flips open. `key` is "" for the owner sign-in path.
    private func unlockPrivate(key: String) async {
        var body: [String: Any] = ["name": chat.tiny]
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["key"] = trimmed }
        let d: [String: Any]
        do {
            d = try await Api.post("/api/login", token: session.token, body: body)
        } catch ApiError.http(429, _) {
            // IP daily cap — "try again" wrongly invites an immediate retry that
            // can't win. Name the rate-limit apart from a reach-the-server
            // failure (web Chat.tsx / Android unlockPrivate 429 parity).
            banner = "Too many unlock attempts — try again tomorrow."
            return
        } catch {
            banner = "Couldn't reach the server — try again."
            return
        }
        if d["isAuthorized"] as? Bool == true {
            chat.isAuthorized = true
            TinyDesign.haptic()
            banner = "🔓 unlocked \(chat.tiny)"
        } else {
            banner = session.token != nil
                ? "This tiny isn't yours — the owner decides who can talk to it."
                : "Wrong key."
        }
    }

    /// Slash commands — same vocabulary as the web's Chat.tsx. Returns
    /// true when handled locally (no agent round-trip).
    private func runSlashCommand(_ raw: String) -> Bool {
        let parts = raw.dropFirst().split(separator: " ").map(String.init)
        guard let cmd = parts.first?.lowercased() else { return false }
        switch cmd {
        case "clear":
            // Wiping the conversation is easy to trigger by mistake — gate it
            // behind a confirm, mirroring web's confirm("Clear conversation
            // history?") (Chat.tsx handleClear).
            confirmClear = true
            return true
        case "memory", "memories":
            showMemory = true
            return true
        case "jobs":
            showJobs = true
            return true
        case "devices":
            showDevices = true
            return true
        case "activity":
            showActivity = true
            return true
        case "graph":
            showGraph = true
            return true
        case "universe":
            showUniverse = true
            return true
        case "map":
            // Same screen the account menu / iPad ⌘8 open (Android /map parity)
            showMap = true
            return true
        case "tiny":
            // /tiny <name> — switch surface (web: navigate to /{slug})
            if parts.count > 1 {
                chat.switchTiny(parts[1])
                banner = "🌱 now chatting with \(chat.tiny)"
            } else {
                showUniverse = true
            }
            return true
        case "forgetall":
            // Irreversible — defer the wipe to the confirmation dialog.
            confirmForgetAll = true
            return true
        case "loop":
            // "/loop [5m|2h] <prompt>" — a recurring background loop on the
            // worker scheduler (web Chat.tsx + Android parity; bare digits =
            // minutes; no interval → every 5m). Runs never touch this chat:
            // results land in ⚡ activity + push, run history in /jobs. Up to
            // 10 concurrent loops (worker quota, shared with scheduled jobs).
            let largs = Array(parts.dropFirst())
            guard !largs.isEmpty else {
                banner = "usage: /loop [5m|30m|2h] <prompt> — background loop; watch it in /jobs, results in /activity"
                return true
            }
            var schedule = "*/5m"
            var promptWords = largs
            if largs.count > 1, let parsed = Self.loopSchedule(largs[0]) {
                schedule = parsed
                promptWords = Array(largs.dropFirst())
            }
            let loopPrompt = promptWords.joined(separator: " ")
            let sched = schedule
            Task {
                let body: [String: Any] = [
                    "tiny": chat.tiny,
                    "name": "loop: \(String(loopPrompt.prefix(40)))",
                    "prompt": String(loopPrompt.prefix(2000)),
                    "schedule": sched,
                ]
                if let d: [String: Any] = try? await Api.post("/api/jobs", token: session.token, body: body),
                   (d["ok"] as? Bool) == true {
                    banner = "🔁 loop armed — \(sched) as \(chat.tiny) · results in ⚡ activity, history in /jobs"
                    showJobs = true
                } else {
                    banner = "⚠️ couldn't create the loop — up to 10 jobs+loops; check /jobs and try again"
                }
            }
            return true
        case "cost":
            // Session spend so far — sum the priced assistant turns (web parity).
            var inTok = 0, outTok = 0, usd = 0.0, priced = 0
            for m in chat.messages where m.role == "assistant" {
                inTok += m.inTok; outTok += m.outTok
                if let c = ModelPricing.estimateCost(modelId: m.modelId, inputTokens: m.inTok, outputTokens: m.outTok, cacheReadInputTokens: m.cacheReadTok) {
                    usd += c; priced += 1
                }
            }
            if inTok + outTok == 0 {
                banner = "🪙 No usage yet this session"
            } else if priced > 0 {
                banner = "🪙 \(inTok)→\(outTok) tok · ~\(ModelPricing.formatCost(usd)) this session"
            } else {
                banner = "🪙 \(inTok)→\(outTok) tok this session"
            }
            return true
        case "help":
            banner = "/clear /memory /graph /jobs /devices /activity /universe /tiny <name> /loop [5m] <prompt> /forgetall /cost"
            return true
        default:
            return false   // unknown slash → send to the agent as text
        }
    }

    /// "/loop" interval token → worker schedule DSL: "5m"/"2h"/"30" (bare
    /// digits = minutes) → "*/5m"/"*/2h"/"*/30m"; nil when the token isn't an
    /// interval (it's then part of the prompt). Manual parse — no Regex
    /// builder — so it mirrors Android's `^(\d{1,4})(m|h)?$` exactly.
    static func loopSchedule(_ token: String) -> String? {
        var digits = token.lowercased()
        var unit = "m"
        if digits.hasSuffix("m") || digits.hasSuffix("h") {
            unit = String(digits.removeLast())
        }
        guard !digits.isEmpty, digits.count <= 4, digits.allSatisfy(\.isNumber),
              let n = Int(digits), n >= 1 else { return nil }
        return "*/\(n)\(unit)"
    }

    // The scrolling transcript (turn-zero hero → messages → streaming row) plus
    // its scroll/refresh/haptic modifiers. Extracted whole from `body` — inlined,
    // the LazyVStack + its modifier chain pushed the Swift type-checker past its
    // budget ("unable to type-check in reasonable time"). Same fix as callStrip.
    private var transcriptScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if chat.messages.isEmpty {
                        landingHero
                    }
                    if !searchQuery.isEmpty && visibleMessages.isEmpty && !chat.messages.isEmpty {
                        Text("No messages match “\(searchQuery)”.")
                            .foregroundStyle(.secondary)
                            .font(.callout)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    }
                    ForEach(visibleMessages) { msg in
                        // Extracted to a helper: this call passes 9 closures, and
                        // inline the Swift type-checker exceeded its budget here
                        // ("unable to type-check in reasonable time" at the
                        // MessageBubble init). Its own function isolates the solve.
                        messageBubble(for: msg)
                            .id(msg.id)
                    }
                    if chat.streaming {
                        streamingIndicator
                    }
                }
                .padding(.vertical, 12)
                // P2.4 — readable measure on iPad/landscape: chat column caps at
                // ~760pt and centers (web max-w-4xl)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            // Drag down on the transcript pulls the keyboard away with the finger
            // (Messages-style); tap anywhere also dismisses
            .scrollDismissesKeyboard(.interactively)
            // ⟳ One gesture re-checks everything ambient: the tiny's theme, a
            // pending OTA build, and unread DMs
            .refreshable {
                async let ota: Void = Updater.shared.check()
                async let theme: Void = chat.loadTheme()
                async let dms: Void = session.refreshUnread()
                _ = await (ota, theme, dms)
            }
            .onTapGesture { focused = false }
            // Open at the LATEST message. load() fills chat.messages from disk in
            // init — BEFORE this ScrollViewReader mounts — so onChange never fires
            // for a restored transcript and a long thread would open scrolled to
            // its oldest message (user feedback). Jump to the bottom on appear, no
            // animation (it should already look settled there).
            .onAppear {
                guard let last = chat.messages.last else { return }
                proxy.scrollTo(last.id, anchor: .bottom)
            }
            .onChange(of: chat.messages) {
                guard let last = chat.messages.last else { return }
                if reduceMotion { proxy.scrollTo(last.id, anchor: .bottom) }
                else { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            // P1.3 haptics — the ChatModel bumps these counters on send / clean
            // finish / error; .sensoryFeedback fires the matching Taptic pattern
            // (the counters only need to change, hence Int triggers). Parity with
            // the drag-drop and edge-swipe paths that already buzz via TinyDesign.
            .sensoryFeedback(.impact, trigger: chat.hapticSend)
            .sensoryFeedback(.success, trigger: chat.hapticDone)
            .sensoryFeedback(.error, trigger: chat.hapticError)
        }
    }

    // 📎 Drop-target veil (web's "Drop files to share" overlay): an accent
    // border + hint while a drag hovers; allowsHitTesting false so the drop
    // still lands on the destinations below. Extracted from `body` for the
    // type-checker budget (same reason as callStrip / landingHero).
    private var dropVeil: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 20)
                .stroke(chat.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                .padding(6)
            Label("Drop to share with \(chat.tiny)", systemImage: "paperclip")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(chat.accent.opacity(0.5), lineWidth: 1))
                .foregroundStyle(chat.accent)
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    // Turn-zero landing (web heroMode parity): big accent name + glow, tagline,
    // starter chips. The brand sprout is GONE from the landing (user request) —
    // when the owner set a `logo` it crowns the name instead; NeonMark keeps
    // living in Onboarding/Login. Extracted from `body` for the type-checker
    // budget (same reason as callStrip / messageBubble).
    private var landingHero: some View {
        VStack(spacing: 0) {
            if let logo = chat.logoURL {
                LandingLogo(url: logo)
                    .padding(.bottom, 14)
            }
            // Web: text-4xl/5xl bold in var(--tiny-accent) with textShadow
            // 0 0 24px rgba(accent,0.45)
            Text(chat.tiny)
                .font(.system(size: 40, weight: .bold))
                .foregroundStyle(chat.accent)
                .shadow(color: chat.accent.opacity(0.45), radius: 12)
                .padding(.bottom, 10)
            Text(chat.customTagline ?? ChatModel.landingTagline(for: chat.tiny))
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .font(.callout)
                .padding(.bottom, 22)
            // Starter chips — "…" chips seed the composer; the rest send as their
            // own concurrent turns (same path as the followup chips below the
            // transcript). Owner-set `chips` replace the defaults.
            CenteredFlow(spacing: 8) {
                ForEach(chat.customChips ?? ChatModel.landingChips(for: chat.tiny), id: \.self) { chip in
                    Button {
                        if let seed = ChatModel.landingSeed(for: chip) {
                            input = seed
                            focused = true
                        } else {
                            chat.send(chip, token: session.token)
                        }
                    } label: {
                        Text(chip)
                            .font(.footnote)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(chat.accent.opacity(0.12), in: Capsule())
                            .overlay(Capsule().stroke(chat.accent.opacity(0.35), lineWidth: 1))
                            .foregroundStyle(chat.accent)
                    }
                }
            }
            .padding(.horizontal)
            // iOS-only quiet footnote — fills the slot the web gives its ⌘⇧K hint
            Text("This \(deviceNoun) is a live node — the web agent can reach it too.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.tertiary)
                .font(.caption2)
                .padding(.top, 22)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.bottom, 16)
        // Per-tiny hero banner (web parity) — a landing element only: it lives
        // behind THIS turn-zero hero and vanishes with it once a message exists.
        .background {
            if let hero = chat.heroURL {
                HeroBanner(url: hero)
            }
        }
    }

    // The "thinking…/running X…" row under the transcript while streaming.
    // Extracted from `body` for the same type-checker-budget reason as
    // messageBubble(for:) — the map/?? interpolation was the flagged expression.
    private var streamingIndicator: some View {
        let label = chat.activeTool.map { "running \($0)…" } ?? "thinking…"
        return HStack(spacing: 6) {
            ProgressView().scaleEffect(0.7)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal)
    }

    // One transcript row. Extracted from the ForEach in `body` because passing
    // MessageBubble's 9 closures inline pushed the Swift type-checker past its
    // budget ("unable to type-check in reasonable time"). Solving it in its own
    // function keeps the transcript builder tractable.
    @ViewBuilder
    private func messageBubble(for msg: ChatMessage) -> some View {
        MessageBubble(
            msg: msg,
            onRetry: { (m: ChatMessage) in chat.retry(m, token: session.token) },
            onDelete: { (m: ChatMessage) in chat.delete(m) },
            onEdit: { (edited: ChatMessage) in
                input = edited.text
                chat.removeTurn(startingAt: edited)
                focused = true
            },
            isLive: chat.liveIds.contains(msg.id),
            onStop: { (m: ChatMessage) in chat.stopStreaming(id: m.id) },
            onSignIn: { Task {
                await session.login()
                // After a signed-out paywall's Sign in, continue the held turn
                // automatically — web reloads via return_to into a clean authed
                // page (Chat.tsx:3499); here login() is in-place, so the card's
                // baked-in signedOut flag never flips and the held prompt would
                // sit dead behind a now-stale "Sign in" button. Re-send drops the
                // stale bubble and lands the correct next state (a real-balance
                // Add funds / Retry card, or the paid turn itself).
                if session.token != nil { chat.retry(msg, token: session.token) }
            } },
            onAddFunds: {
                // Arm auto-continue only when this is a PAYWALL card's Add funds
                // (a paywall message renders no pay_x402 card, so no misfire);
                // the composer badge opener leaves paywallAwaitingFunds nil.
                if msg.paywall != nil { paywallAwaitingFunds = msg }
                showWallet = true
            },
            onSettlePay: { (qid: String, settled: PaySettled) in
                chat.settlePayQuote(messageId: msg.id, quoteId: qid, settled)
            }
        )
    }
}

/// 🔒 Lock panel shown in the composer's place for a private tiny this device
/// isn't vouched for (web Chat.tsx lock-hero parity). A signed-in visitor taps
/// "Unlock" (their session vouches an owner with no key); anyone can also type
/// the access key. Sits on the darkened private surface — the whole room reads
/// as gated, not just this panel.
private struct PrivateLockPanel: View {
    let tiny: String
    let accent: Color
    /// Whether a session token exists — an owner unlocks with no key, so we
    /// lead with a one-tap "Unlock" and treat the key field as the fallback.
    let signedIn: Bool
    let onUnlock: (String) -> Void
    @State private var key = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "lock.fill")
                .font(.system(size: 30))
                .foregroundStyle(accent.opacity(0.85))
            Text("\(tiny) is private")
                .font(.headline)
            Text(signedIn
                 ? "If it's yours, unlock it. Otherwise enter its access key."
                 : "Its owner decides who can talk to it. Enter the access key, or sign in if it's yours.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            HStack(spacing: 8) {
                SecureField("access key", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                    .focused($focused)
                    .onSubmit { onUnlock(key) }
                Button {
                    onUnlock(key)
                } label: {
                    // A signed-in owner needs no key — "Unlock" stays enabled
                    // for them; a visitor's button waits for a non-empty key.
                    Text("Unlock")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(accent, in: Capsule())
                        .foregroundStyle(.black)
                }
                .disabled(!signedIn && key.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.vertical, 20).padding(.horizontal, 16)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(accent.opacity(0.25), lineWidth: 1))
    }
}

struct MessageBubble: View {
    let msg: ChatMessage
    var onRetry: ((ChatMessage) -> Void)? = nil
    var onDelete: ((ChatMessage) -> Void)? = nil
    /// User bubbles: "Edit & resend" — puts the text back in the composer
    /// and removes this turn (web's edit affordance, phone-shaped)
    var onEdit: ((ChatMessage) -> Void)? = nil
    /// This bubble's reply is still streaming (ChatModel.liveIds) — shows
    /// the per-bubble Stop; sibling turns keep going (concurrent sends)
    var isLive: Bool = false
    var onStop: ((ChatMessage) -> Void)? = nil
    /// A signed-out paywall card's "Sign in" tap (web navigates to /api/auth;
    /// here we run the native consent flow). nil hides the button.
    var onSignIn: (() -> Void)? = nil
    /// Paywall "Add funds" tap — presents the native WalletView sheet in place
    /// of bouncing to Safari (web opens the in-app WalletSheet, Chat.tsx:2574).
    var onAddFunds: (() -> Void)? = nil
    /// A pay_x402 quote reached a terminal outcome (paid/pending/declined) —
    /// persist it onto the message so a reload shows the receipt (C3). Args:
    /// the quote's id + the settled outcome.
    var onSettlePay: ((String, PaySettled) -> Void)? = nil
    // Read-aloud state (web's per-message 🔊) — same store the speech cards use
    @ObservedObject private var speech = Speech.shared
    @Environment(\.tinyAccent) private var accent
    @Environment(\.openURL) private var openURL
    // Message delete is a hard remove + persist (ChatModel.delete → save()),
    // irreversible with no soft-delete. Web confirms it (Chat.tsx:1798) and
    // android added a dialog (e53b7a6); gate the iOS long-press Delete too.
    @State private var confirmDelete = false

    private var readAloudId: String { "read-\(msg.id.uuidString)" }

    var body: some View {
        VStack(alignment: msg.role == "user" ? .trailing : .leading, spacing: 4) {
            if !msg.tools.isEmpty {
                // Horizontal scroll so a many-tool turn doesn't push the chip
                // row past the screen edge (it used to clip); mirrors the
                // followups row. The gear is an SF Symbol, not an emoji —
                // chrome speaks icons (TinyDesign).
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(msg.tools, id: \.self) { t in
                            Label(t, systemImage: "gearshape")
                                .labelStyle(.titleAndIcon)
                                .font(.caption2)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(accent.opacity(0.15), in: Capsule())
                                .foregroundStyle(accent)
                        }
                    }
                }
            }
            ForEach(msg.speech) { item in
                SpeechCardView(item: item)
            }
            ForEach(msg.ui) { item in
                RenderUiCard(item: item)
            }
            // 🤝 pay_x402 — Approve/Decline gate; the tap spends real USDC
            ForEach(msg.payQuotes) { item in
                PayQuoteCard(item: item, onAddFunds: onAddFunds,
                             onSettled: { onSettlePay?(item.id, $0) })
            }
            // 🤝 pay_x402 terminal outcomes with no quote (failed / free target)
            ForEach(msg.payResults) { item in
                PayResultCard(item: item)
            }
            // 🖼️ generate_image results — preview renders instantly from
            // base64; long-press shares the durable hosted URL
            ForEach(msg.images) { item in
                GeneratedImageCard(item: item)
            }
            // 📎 Photos/documents that rode with this message
            if !msg.thumbs.isEmpty || !msg.docs.isEmpty {
                HStack(spacing: 6) {
                    ForEach(msg.thumbs.indices, id: \.self) { i in
                        AttachmentThumb(base64: msg.thumbs[i])
                    }
                    ForEach(msg.docs.indices, id: \.self) { i in
                        DocChip(name: msg.docs[i])
                    }
                }
            }
            ForEach(msg.spawns) { item in
                TaskTreeCard(item: item)
            }
            // 🧠 P1.1 — collapsible thinking section (web parity)
            if !msg.reasoning.isEmpty {
                ReasoningDisclosure(reasoning: msg.reasoning)
            }
            if !msg.text.isEmpty {
                // 🖼️ Media the agent embedded (necklace photos/GIF clips/WAVs,
                // glasses MP4s) render as real players — the prose keeps only
                // the words. Users: `![…](url)` no longer prints literally.
                let split = msg.role == "assistant"
                    ? ChatMedia.extract(from: msg.text) : (msg.text, [])
                ForEach(split.1) { item in
                    ChatMediaCard(media: item)
                }
                if !split.0.isEmpty || msg.role != "assistant" {
                Group {
                    if msg.role == "assistant" {
                        // Real markdown: fenced code → cards w/ copy,
                        // prose → AttributedString (clickable links)
                        MarkdownText(text: split.0)
                    } else {
                        Text(msg.text)
                    }
                }
                .textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(
                    msg.role == "user" ? accent.opacity(0.22) : Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 18)
                )
                // P0.3 — long-press menu (web's hover actions, phone-shaped)
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = msg.text
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    if msg.role == "user", let onEdit {
                        Button {
                            onEdit(msg)
                        } label: {
                            Label("Edit & resend", systemImage: "pencil")
                        }
                    }
                    ShareLink(item: msg.text) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    if msg.role == "assistant" {
                        Button {
                            Speech.shared.toggle(Speech.scrub(msg.text), id: readAloudId)
                        } label: {
                            Label("Read aloud", systemImage: "speaker.wave.2")
                        }
                    }
                    if onDelete != nil {
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                }   // end prose (skipped when the whole message was media)
                // 🪙 P1.2 — token usage tag (web's per-message tok display),
                // with a per-turn ~$ estimate when the model is priceable
                // (ModelPricing) — web/android parity.
                if msg.role == "assistant", msg.inTok + msg.outTok > 0 {
                    let cost = ModelPricing.estimateCost(modelId: msg.modelId, inputTokens: msg.inTok, outputTokens: msg.outTok, cacheReadInputTokens: msg.cacheReadTok)
                    Text(cost.map { "\(msg.inTok)→\(msg.outTok) tok · ~\(ModelPricing.formatCost($0))" } ?? "\(msg.inTok)→\(msg.outTok) tok")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                // 🔁 Failed turn → retry with the held prompt (web parity)
                if msg.failedPrompt != nil, let onRetry {
                    Button {
                        onRetry(msg)
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(accent.opacity(0.15), in: Capsule())
                            .foregroundStyle(accent)
                    }
                }
                // 🔊 Read-aloud (web's per-message speaker) — assistant only
                if msg.role != "user", msg.failedPrompt == nil {
                    Button {
                        speech.toggle(msg.text, id: readAloudId)
                    } label: {
                        Image(systemName: speech.speakingId == readAloudId ? "stop.circle.fill" : "speaker.wave.2")
                            .font(.system(size: 14))
                            .foregroundStyle(speech.speakingId == readAloudId ? .green : .gray.opacity(0.7))
                    }
                    .accessibilityLabel(speech.speakingId == readAloudId ? "Stop reading" : "Read aloud")
                }
            }
            // 💸 402 paywall — a paid tiny with a short/absent balance. Native
            // card in place of a dead error string (web: Chat.tsx paywall).
            if let pw = msg.paywall, !isLive {
                PaywallCard(paywall: pw,
                            onAddFunds: onAddFunds ?? { if let u = URL(string: "\(Config.serverBase)/wallet") { openURL(u) } },
                            onRetry: onRetry.map { cb in { cb(msg) } },
                            onSignIn: onSignIn)
            }
            // ⏹ Stop just THIS reply while it streams — sibling turns keep
            // going (web parity: per-bubble stop under concurrent sends)
            if isLive, let onStop {
                Button {
                    onStop(msg)
                } label: {
                    Label("Stop", systemImage: "stop.circle")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(.red.opacity(0.12), in: Capsule())
                        .foregroundStyle(.red)
                }
                .accessibilityLabel("Stop this reply")
            }
            // 🎵 Spotify links in replies → native deep-link chips
            let spotify = Media.spotifyLinks(in: msg.text)
            ForEach(spotify, id: \.absoluteString) { url in
                Link(destination: url) {
                    Label("Open in Spotify", systemImage: "music.note")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(accent.opacity(0.15), in: Capsule())
                        .foregroundStyle(accent)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: msg.role == "user" ? .trailing : .leading)
        .padding(.horizontal)
        .confirmationDialog(
            "Delete this message?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { onDelete?(msg) }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// 💸 402 paywall — a paid tiny with a short/absent balance (or a signed-out
/// visitor). Renders in the assistant bubble in place of a dead red error, with
/// the same affordances the web card offers (Chat.tsx): Add funds + Retry when
/// funded, or a Sign in prompt. Retry re-sends the held prompt (ChatModel.retry
/// reads paywall.prompt); the card is inert display otherwise.
struct PaywallCard: View {
    let paywall: Paywall
    var onAddFunds: () -> Void
    /// Re-send the held prompt (nil in read-only contexts, e.g. /share preview).
    var onRetry: (() -> Void)? = nil
    /// Native sign-in consent flow (only shown for a signed-out paywall).
    var onSignIn: (() -> Void)? = nil
    @Environment(\.tinyAccent) private var accent

    private static let usdFmt: NumberFormatter = {
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"
        f.maximumFractionDigits = 6; f.minimumFractionDigits = 2
        // Pin en_US so the paywall/receipt money format is device-locale-INDEPENDENT
        // ("$0.50", not a de/fr/tr phone's "0,50 $"); currencyCode alone doesn't fix
        // separators/symbol placement. Web pins toLocaleString("en-US"), Android Locale.US.
        f.locale = Locale(identifier: "en_US")
        return f
    }()
    private func usd(_ micro: Int) -> String {
        Self.usdFmt.string(from: NSNumber(value: Double(micro) / 1_000_000)) ?? "$0.00"
    }

    private var title: String {
        paywall.signedOut ? "Sign in to chat with this tiny" : "This tiny is paid"
    }
    private var detail: String {
        if paywall.signedOut {
            return "It charges \(usd(paywall.priceMicro)) per message. Sign in and add funds to continue."
        }
        // Surface the exact top-up shortfall so the user doesn't have to subtract
        // balance from price in their head on a money-critical card. Guard on
        // shortfall > 0: an insufficient-balance 402 always has balance < price,
        // but if the two ever read equal (stale/rounding) fall back to the plain
        // price·balance line rather than telling them to "add $0.00". Mirrors web
        // (Chat.tsx paywall detail).
        let shortfall = paywall.priceMicro - paywall.balanceMicro
        if shortfall > 0 {
            return "It charges \(usd(paywall.priceMicro)) per message · your balance is \(usd(paywall.balanceMicro)) — add at least \(usd(shortfall)) to continue."
        }
        return "It charges \(usd(paywall.priceMicro)) per message · your balance is \(usd(paywall.balanceMicro))."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Group the 💸 + title + detail into ONE VoiceOver announcement and
            // hide the decorative emoji — otherwise a screen reader hears "money
            // with wings" then each text fragment in isolation on a money-
            // critical card. Mirrors web (role="alert" + aria-hidden on 💸,
            // Chat.tsx:3474/3479) and the composer price badge's own a11y label
            // (:2525). The buttons stay OUTSIDE this group so each remains a
            // distinct actionable element.
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text("💸").accessibilityHidden(true)
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(accent)
                }
                Text(detail)
                    .font(.caption).foregroundStyle(.primary.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            if paywall.signedOut {
                if let onSignIn {
                    Button(action: onSignIn) {
                        filledLabel("Sign in")
                    }
                }
            } else {
                // accessibilityLabel strips the decorative ↻ glyph so
                // VoiceOver reads a clean "Retry" instead of the
                // glyph name as noise before the verb — matching the care the
                // card title already takes hiding its 💸 (:3765).
                let addFunds = Button(action: onAddFunds) {
                    filledLabel("Add funds")
                }
                .accessibilityLabel("Add funds")
                if let onRetry {
                    let retry = Button(action: onRetry) {
                        Text("↻ Retry")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .overlay(Capsule().stroke(accent.opacity(0.4), lineWidth: 1))
                            .foregroundStyle(accent)
                    }
                    .accessibilityLabel("Retry")
                    // Two capsules side-by-side can overflow a narrow phone at the
                    // largest Dynamic Type sizes. ViewThatFits keeps them in a row
                    // when they fit and stacks them vertically (leading-aligned,
                    // matching the card) when they don't — no clipping, no manual
                    // size-class branch.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { addFunds; retry }
                        VStack(alignment: .leading, spacing: 8) { addFunds; retry }
                    }
                } else {
                    addFunds
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(accent.opacity(0.35), lineWidth: 1))
    }

    private func filledLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(accent, in: Capsule())
            .foregroundStyle(.black)
    }
}

/// Which tiny board this beacon is, in words. An `unknown` version means
/// firmware newer than this build — say so rather than guessing a board, since
/// the guess would send the user into the wrong setup flow.
func niclaKindLabel(_ info: TinyBeaconInfo) -> String {
    switch info.kind {
    case .vision: return "Nicla Vision"
    case .voice: return "Nicla Voice"
    case .unknown: return "tiny hardware"
    }
}

/// Nearby BLE devices (menu → Nearby devices) — the same scan the web agent
/// gets when it asks the phone what's around.
struct NearbyView: View {
    @ObservedObject private var ble = Bluetooth.shared
    @Environment(\.dismiss) private var dismiss
    @State private var setupTarget: BleDevice?

    var body: some View {
        NavigationStack {
            List {
                if ble.devices.isEmpty {
                    Text(ble.scanning ? "Scanning…"
                         : ble.state == "unauthorized" ? "Bluetooth permission denied — enable it in Settings."
                         : ble.state == "poweredOff" ? "Bluetooth is off."
                         : "No devices found yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(ble.devices.sorted { $0.rssi > $1.rssi }) { d in
                    HStack(spacing: 10) {
                        Circle()
                            .fill(d.rssi > -55 ? Color.green : d.rssi > -75 ? .yellow : .gray)
                            .frame(width: 9, height: 9)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Text(d.name).font(.subheadline)
                                if d.tiny != nil { Text("💎").font(.caption) }
                            }
                            // Name the BOARD, not just "tiny hardware": the two
                            // necklaces need different setup (the Voice has no
                            // WiFi), so the row should already say which one is
                            // in front of you — the beacon's version byte
                            // carries it, no connection needed.
                            Text(d.tiny == nil ? "RSSI \(d.rssi) dBm"
                                 : "\(niclaKindLabel(d.tiny!)) · \(d.tiny!.provisioned ? "configured" : "ready to set up") · RSSI \(d.rssi) dBm")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        if let t = d.tiny {
                            Spacer()
                            Button(t.provisioned ? "Reconfigure" : "Set up") { setupTarget = d }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.borderedProminent)
                                .controlSize(.mini)
                        }
                    }
                }
            }
            .sheet(item: $setupTarget) { d in TinySetupView(beacon: d) }
            .navigationTitle("Nearby")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        ble.startScan()
                    } label: {
                        if ble.scanning { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(ble.scanning)
                    .accessibilityLabel(ble.scanning ? "Scanning for nearby devices" : "Rescan for nearby devices")
                }
            }
            .onAppear { ble.startScan() }
            .onDisappear { ble.stopScan() }
        }
    }
}

/// Speech card (speak tool) — play button + transcript, the same native
/// player-plus-text card the web renders for spoken replies.
struct SpeechCardView: View {
    let item: SpeechItem
    @ObservedObject private var speech = Speech.shared
    @Environment(\.tinyAccent) private var accent

    private var playing: Bool { speech.speakingId == item.id }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                speech.toggle(item.text, id: item.id, voice: item.voice)
            } label: {
                Image(systemName: playing ? "stop.fill" : "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 36, height: 36)
                    .background(accent, in: Circle())
            }
            .accessibilityLabel(playing ? "Stop" : "Play spoken reply")
            VStack(alignment: .leading, spacing: 3) {
                Text(playing ? "SPEAKING" : "SPOKEN REPLY")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .kerning(0.8)
                Text(item.text)
                    .font(.subheadline)
                    .foregroundStyle(.primary.opacity(0.85))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(accent.opacity(0.25), lineWidth: 1))
    }
}

/// Generated-image card (generate_image tool) — the on-device render, made
/// on THIS phone's Neural Engine. Preview draws from the persisted base64
/// (instant, offline-safe); tap opens the durable hosted copy, long-press
/// shares the URL every other client renders from.
struct GeneratedImageCard: View {
    let item: GeneratedImage
    @Environment(\.tinyAccent) private var accent
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let data = Data(base64Encoded: item.preview), let img = UIImage(data: data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 320, maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .onTapGesture {
                        if let url = URL(string: item.url) { openURL(url) }
                    }
                    .contextMenu {
                        if let url = URL(string: item.url) {
                            ShareLink(item: url) { Label("Share image link", systemImage: "square.and.arrow.up") }
                            Button {
                                UIPasteboard.general.string = item.url
                            } label: { Label("Copy link", systemImage: "link") }
                        }
                    }
                    .accessibilityLabel("Generated image: \(item.prompt)")
            }
            Label(item.prompt, systemImage: "sparkles")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(8)
        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.25), lineWidth: 1))
    }
}

// ── Per-tiny accent environment (cards read it; ChatView sets it) ─────────

private struct TinyAccentKey: EnvironmentKey {
    static let defaultValue = Color.green
}

extension EnvironmentValues {
    var tinyAccent: Color {
        get { self[TinyAccentKey.self] }
        set { self[TinyAccentKey.self] = newValue }
    }
}

/// What the web agent asked this phone (tap the relay strip) — session-
/// scoped log; envelopes answered while backgrounded appear as notifications
/// instead (BGAppRefresh has no session UI).
struct RelayLogView: View {
    @EnvironmentObject var session: TinySession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if session.relayLog.isEmpty {
                    Text("No relay activity this session. When your web agent uses this phone, the requests land here.")
                        .foregroundStyle(.secondary)
                }
                ForEach(session.relayLog) { ev in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Label(ev.prompt, systemImage: TinyDesign.iconRelay)
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(ev.ts.formatted(date: .omitted, time: .shortened))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        Text(ev.result)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .navigationTitle("Relay history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}


/// Collapsible "thinking" section (P1.1) — reasoning deltas stream in
/// collapsed; expanding shows the model's chain of thought in muted mono.
struct ReasoningDisclosure: View {
    let reasoning: String
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "brain")
                        .font(.system(size: 10))
                    Text(open ? "thinking" : "thought for a bit")
                        .font(.caption2)
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8))
                }
                .foregroundStyle(.secondary)
            }
            if open {
                Text(reasoning)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}

/// Wipe-memories confirmation, split out of ChatView's main modifier chain —
/// the chain hit the compiler's type-check budget when the Call-recordings
/// sheet joined it ("unable to type-check in reasonable time", a hard error,
/// not style). Extractions like this buy the chain slack.
private struct ForgetAllDialog: ViewModifier {
    @ObservedObject var chat: ChatModel
    @Binding var confirm: Bool
    @Binding var banner: String?

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Wipe ALL memories and the turn log for \(chat.tiny)?",
            isPresented: $confirm,
            titleVisibility: .visible
        ) {
            Button("Wipe everything", role: .destructive) {
                Continuity.clearMemories(chat.tiny)
                Continuity.clearTurnLog(chat.tiny)
                banner = "🧠 Memories + turn log wiped for \(chat.tiny)"
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
    }
}

/// The AirPods moment (loop ask #5): an unprovisioned tiny beacon nearby
/// raises this bottom card while the app is open — name the hardware, offer
/// one-tap Connect, and hand off to the existing TinySetupView provisioner
/// in place. "Not now" (or a swipe down) stands it down for the session.
private struct PairingCardView: View {
    let d: BleDevice
    let onConnect: () -> Void
    let onNotNow: () -> Void
    @Environment(\.tinyAccent) private var accent
    @State private var connecting = false

    private var kindLabel: String {
        switch d.tiny?.kind {
        case .voice: return "Nicla Voice"
        case .vision: return "Nicla Vision"
        default: return "tiny hardware"
        }
    }

    /// Ripple drives the repeatForever ring animation; arrived drives the
    /// one-shot spring entrance. Separate flags: a repeating animation keyed
    /// on the same value as a spring would fight it.
    @State private var rippling = false
    @State private var arrived = false

    var body: some View {
        if connecting {
            TinySetupView(beacon: d)
        } else {
            VStack(spacing: 20) {
                // The AirPods proximity grammar: rings leave the device and
                // fade — "this is near you, right now" — over a soft accent
                // disc so the glyph reads as hardware, not an icon in space.
                ZStack {
                    ForEach(0..<3, id: \.self) { ring in
                        Circle()
                            .stroke(accent.opacity(0.5), lineWidth: 1.5)
                            .frame(width: 96, height: 96)
                            .scaleEffect(rippling ? 2.1 : 1.0)
                            .opacity(rippling ? 0 : 0.6)
                            .animation(
                                .easeOut(duration: 2.4)
                                    .repeatForever(autoreverses: false)
                                    .delay(Double(ring) * 0.8),
                                value: rippling
                            )
                    }
                    Circle()
                        .fill(LinearGradient(colors: [accent.opacity(0.28), accent.opacity(0.08)],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 96, height: 96)
                        .overlay(Circle().stroke(accent.opacity(0.35), lineWidth: 1))
                    Image(systemName: d.tiny?.kind == .voice ? "waveform.badge.mic" : "sparkles.tv")
                        .font(.system(size: 40, weight: .medium))
                        .foregroundStyle(accent)
                        .symbolEffect(.pulse)
                }
                .frame(height: 116)
                .padding(.top, 26)
                .scaleEffect(arrived ? 1 : 0.7)
                .opacity(arrived ? 1 : 0)
                VStack(spacing: 5) {
                    Text(kindLabel)
                        .font(.title2.weight(.semibold))
                    Text("\(d.name) · ready to set up")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Button {
                    connecting = true
                    onConnect()
                } label: {
                    Text("Connect")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(
                            LinearGradient(colors: [accent, accent.opacity(0.8)],
                                           startPoint: .top, endPoint: .bottom),
                            in: Capsule()
                        )
                        .foregroundStyle(.black)
                }
                .padding(.top, 2)
                Button("Not now") { onNotNow() }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)
            .onAppear {
                rippling = true
                withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) { arrived = true }
            }
        }
    }
}

/// Proximity pairing, attached once to ChatView's outer chain (a ViewModifier
/// — the chain sits at the type-checker's budget). A short sweep runs when the
/// app comes to the foreground (throttled to one per minute, and never while
/// signed out — enrollment would just 401); the first unprovisioned tiny
/// beacon raises PairingCardView with a soft haptic. Each beacon is offered
/// once per app run — a dismissed card must not nag.
struct ProximityPairing: ViewModifier {
    @ObservedObject private var ble = Bluetooth.shared
    @EnvironmentObject var session: TinySession
    @Environment(\.scenePhase) private var scenePhase
    @State private var target: BleDevice?
    @State private var offered: Set<UUID> = []
    @State private var lastSweep = Date.distantPast
    @State private var detent: PresentationDetent = .height(400)

    func body(content: Content) -> some View {
        content
            .onAppear { sweep() }
            .onChange(of: scenePhase) { _, p in
                if p == .active { sweep() }
            }
            .onChange(of: ble.devices) { _, devs in
                // Harness runs seed ble.devices with demo beacons
                // (DevicesHarness) — the card must not rise over their
                // screenshots, same rule as the permission asks (27b7cbc9).
                guard !HarnessRun.suppressesSystemPrompts(arguments: ProcessInfo.processInfo.arguments) else { return }
                guard target == nil, session.token != nil else { return }
                guard let d = devs.first(where: {
                    $0.tiny?.provisioned == false && !offered.contains($0.id)
                }) else { return }
                offered.insert(d.id)
                Haptic.shared.play(pattern: "success", times: 1, intensity: 0.6)
                target = d
            }
            .sheet(item: $target) { d in
                PairingCardView(
                    d: d,
                    onConnect: { detent = .large },
                    onNotNow: { target = nil }
                )
                .presentationDetents([.height(400), .large], selection: $detent)
                .presentationCornerRadius(28)
            }
    }

    private func sweep() {
        // Ambient sweeping must never be the thing that raises the Bluetooth
        // permission ask: CBCentralManager's CREATION is the prompt
        // (Bluetooth.startScan's own comment), and this sweep runs at app
        // open. Until the user grants BLE somewhere deliberate — My devices,
        // where they asked for a scan — stand down. Harness runs can't
        // answer dialogs at all (HarnessRun, same rule as 27b7cbc9).
        guard CBCentralManager.authorization == .allowedAlways else { return }
        guard !HarnessRun.suppressesSystemPrompts(arguments: ProcessInfo.processInfo.arguments) else { return }
        guard session.token != nil,
              Date().timeIntervalSince(lastSweep) > 60 else { return }
        lastSweep = Date()
        ble.startScan(duration: 10)
    }
}
