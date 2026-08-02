/**
 * SettingsView (menu → Settings) — the config surface the web keeps in
 * ModelSettings/prefs: which tiny to talk to, voice behavior, and a dev
 * server override. Device identity is shown read-only; revocation lives
 * on the web's /devices page.
 */
import SwiftUI
import AVFoundation

struct SettingsView: View {
    @EnvironmentObject var session: TinySession
    @Environment(\.dismiss) private var dismiss
    // Group container: widget-extension intents must read this too
    @AppStorage("cfg_tiny_name", store: UserDefaults(suiteName: WidgetStore.suite)) private var tinyName = ""
    @AppStorage("cfg_auto_speak") private var autoSpeak = true
    @AppStorage("cfg_location_context") private var locationContext = false
    @AppStorage("cfg_quiet_hours") private var quietHours = true
    @AppStorage("cfg_voice_id") private var voiceId = ""

    /// User-locale voices first, then English; deduped, name-sorted
    private static let voices: [AVSpeechSynthesisVoice] = {
        let langPrefix = String((Locale.preferredLanguages.first ?? "en").prefix(2))
        let all = AVSpeechSynthesisVoice.speechVoices()
        let relevant = all.filter { $0.language.hasPrefix(langPrefix) || $0.language.hasPrefix("en") }
        return relevant.sorted { ($0.language, $0.name) < ($1.language, $1.name) }
    }()
    @AppStorage("cfg_server") private var server = ""
    @State private var showTour = false
    @State private var showAbout = false
    @Environment(\.horizontalSizeClass) private var hSize

    // 🕶️ Meta glasses (absent on Catalyst — Wearables.swift explains)
    #if canImport(MWDATCore) && canImport(MWDATCamera)
    @ObservedObject private var wearables = WearablesManager.shared
    #endif

    // ── BYO-model (mirrors web ModelSettings; key in Keychain) ──────────────
    @AppStorage(ModelConfigStore.keyProvider) private var modelProvider = "default"
    @AppStorage(ModelConfigStore.keyModelId) private var modelId = ""
    @AppStorage(ModelConfigStore.keyBaseUrl) private var modelBaseUrl = ""
    @AppStorage(ModelConfigStore.keyMaxTokens) private var modelMaxTokens = ""
    @AppStorage(ModelConfigStore.keyRegion) private var modelRegion = "us-west-2"
    @AppStorage(ModelConfigStore.keyAdditional) private var modelAdditional = ""
    @State private var modelKey = Keychain.get("tiny_model_api_key") ?? ""
    @State private var showKey = false
    @State private var modelError: String?

    // ── Dedicated voice-call OpenAI key (Keychain, device-local) ────────────
    // Voice is OpenAI-only and independent of the chat provider, so a user on a
    // Bedrock/Anthropic chat model can still enable calls without switching chat.
    @State private var voiceKey = ModelConfigStore.loadVoiceKey()
    @State private var showVoiceKey = false
    @State private var voiceKeySaved = false

    // ── Account-default live-call voice (cross-device, /api/account-voice) ───
    // The fallback for tinys with no per-tiny voice (per-tiny → account → marin).
    @State private var accountVoice = ""

    private var byokActive: Bool { modelProvider != "default" }
    /// Chat already runs on OpenAI → voice reuses that key, so the voice field is optional.
    private var chatIsOpenAi: Bool { modelProvider.lowercased() == "openai" && !modelKey.isEmpty }
    private var currentPreset: ModelProvider { ModelProvider.preset(modelProvider) ?? ModelProvider.all[0] }

    /// Persist the key to the Keychain + validate, mirroring web save() guards:
    /// a BYOK provider needs a key; a custom provider needs a base URL (else the
    /// key would leak to OpenAI's default endpoint).
    private func saveModelKey() {
        modelError = nil
        let key = modelKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if byokActive && key.isEmpty { modelError = "API key required for this provider"; return }
        if modelProvider == "custom" && modelBaseUrl.trimmingCharacters(in: .whitespaces).isEmpty {
            modelError = "Base URL required for a custom provider (e.g. https://api.example.com/v1)"; return
        }
        if key.isEmpty { Keychain.delete("tiny_model_api_key") }
        else { Keychain.set("tiny_model_api_key", key) }
        // Carry the selection to the account so other devices inherit it. The
        // key is encrypted server-side and never comes back; an empty key here
        // preserves whatever's stored (worker treats omit as keep).
        ModelConfigStore.saveRemote(ModelConfigStore.load(), token: session.token)
    }

    /// iPad keyboard cheat row — chord in a keycap-style mono chip + what it does
    private func shortcutRow(_ chord: String, _ what: String) -> some View {
        HStack(spacing: 12) {
            Text(chord)
                .font(.caption.monospaced().weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.green.opacity(0.3), lineWidth: 1))
                .foregroundStyle(.green)
                .frame(minWidth: 64, alignment: .center)
            Text(what).font(.subheadline)
        }
        .padding(.vertical, 1)
    }

    private func discoveryRow(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(.green)
                .frame(width: 22)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("tiny", text: $tinyName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    NavigationLink {
                        TinyEditorView(
                            name: tinyName.trimmingCharacters(in: .whitespaces).isEmpty
                                ? "tiny" : tinyName.trimmingCharacters(in: .whitespaces),
                            token: session.token
                        )
                    } label: {
                        Label("Edit persona & visibility", systemImage: "pencil.and.outline")
                    }
                } header: {
                    Text("Tiny")
                } footer: {
                    Text("Which tiny this app chats as (tiny.technology/<name>). Empty = tiny.")
                }

                Section {
                    Picker("Provider", selection: $modelProvider) {
                        ForEach(ModelProvider.all) { p in Text(p.label).tag(p.id) }
                    }
                    .onChange(of: modelProvider) {
                        modelError = nil
                        // Reverting to the free tier clears the synced row so
                        // other devices don't keep inheriting a BYOK provider.
                        if modelProvider == "default" {
                            ModelConfigStore.saveRemote(ModelConfigStore.load(), token: session.token)
                        }
                    }
                    if byokActive {
                        HStack {
                            Group {
                                if showKey {
                                    TextField(currentPreset.keyPlaceholder, text: $modelKey)
                                } else {
                                    SecureField(currentPreset.keyPlaceholder, text: $modelKey)
                                }
                            }
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.caption.monospaced())
                            Button { showKey.toggle() } label: {
                                Image(systemName: showKey ? "eye.slash" : "eye")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(showKey ? "Hide API key" : "Show API key")
                        }
                        TextField(currentPreset.modelPlaceholder, text: $modelId)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.caption.monospaced())
                        if modelProvider == "bedrock" {
                            TextField("us-west-2", text: $modelRegion)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .font(.caption.monospaced())
                        }
                        if modelProvider == "custom" {
                            TextField("https://api.example.com/v1", text: $modelBaseUrl)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .keyboardType(.URL).font(.caption.monospaced())
                        }
                        TextField("Max tokens (optional)", text: $modelMaxTokens)
                            .keyboardType(.numberPad).font(.caption.monospaced())
                        if let e = modelError {
                            Text(e).font(.caption).foregroundStyle(.red)
                        }
                        Button("Save key") { saveModelKey() }
                            .font(.subheadline)
                    }
                } header: {
                    Text("Model & API key")
                } footer: {
                    // 🏅 The free-tier line quotes THIS account's own window and
                    // what its reputation earned, not a generic "rate-limited" —
                    // web's ModelSettings footer, ported. Before this, iOS named
                    // no number at all, so the one lever a builder can pull (get
                    // followed → more room) was discoverable only by being
                    // stopped by the 429. nil standing (signed out, older server)
                    // falls back to the old sentence: see Standing.swift.
                    Text(byokActive
                         ? "Bring your own provider + key — you pay them directly. The key is stored in the Keychain and sent only to tiny's chat endpoint. Takes effect on the next message.\n\nLive voice calls (📞) use their own OpenAI key — set it below (voice is OpenAI-only, independent of your chat model)."
                         : "\(Standing.freeTierFooter(session.standing))\n\nLive voice calls (📞) use their own OpenAI key — set it below (voice is OpenAI-only, independent of your chat model).")
                }

                // 📞 Dedicated voice-call OpenAI key — separate from the chat model
                // above so text can run on any provider while voice uses OpenAI.
                Section {
                    HStack {
                        Group {
                            if showVoiceKey {
                                TextField("sk-…", text: $voiceKey)
                            } else {
                                SecureField("sk-…", text: $voiceKey)
                            }
                        }
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.caption.monospaced())
                        Button { showVoiceKey.toggle() } label: {
                            Image(systemName: showVoiceKey ? "eye.slash" : "eye")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(showVoiceKey ? "Hide voice key" : "Show voice key")
                    }
                    Button("Save voice key") {
                        ModelConfigStore.saveVoiceKey(voiceKey)
                        voiceKey = ModelConfigStore.loadVoiceKey() // reflect the trim
                        voiceKeySaved = true
                    }
                    .font(.subheadline)
                    if voiceKeySaved {
                        Text(voiceKey.isEmpty ? "Voice key cleared." : "✅ Voice key saved.")
                            .font(.caption).foregroundStyle(.green)
                    }
                } header: {
                    Text("Voice-call OpenAI key")
                } footer: {
                    Text(chatIsOpenAi
                         ? "Live voice calls use your OpenAI chat key above. Set a different key here only to run voice on a separate OpenAI account.\n\nStored in the Keychain on this device, sent per-call to start the session."
                         : "Live voice calls (📞) need an OpenAI key — paste one here to enable calls. Voice is OpenAI-only and works no matter which provider your chat uses.\n\nStored in the Keychain on this device, sent per-call to start the session.")
                }

                // 🎙️ Account-default call voice — the OpenAI Realtime voice used
                // on 📞 calls to any tiny that hasn't set its own. Synced across
                // devices; separate from the on-device TTS voice above.
                Section {
                    Picker("Live-call voice", selection: $accountVoice) {
                        Text("Default (each tiny's own, else marin)").tag("")
                        ForEach(kAccountRealtimeVoices, id: \.self) { v in
                            Text(v.capitalized).tag(v)
                        }
                    }
                    .onChange(of: accountVoice) {
                        AccountVoiceStore.save(accountVoice, token: session.token)
                    }
                } header: {
                    Text("Live-call voice")
                } footer: {
                    Text("Your default voice for live calls (📞), synced across your devices. A tiny whose owner set its own voice still wins. The on-device \"Spoken replies\" voice above is separate.")
                }

                Section {
                    NavigationLink {
                        WalletView(token: session.token)
                    } label: {
                        Label("Wallet", systemImage: "creditcard")
                    }
                    // ⛓️ The chain the wallet's money moves on. Web has /chain;
                    // phone had nothing, so a user paying on our own chain could
                    // see their balance but never the ledger it lives on.
                    NavigationLink {
                        ChainView(token: session.token)
                    } label: {
                        Label("Chain", systemImage: "link")
                    }
                } header: {
                    Text("Wallet")
                } footer: {
                    Text("Your USDC balance, deposits, withdrawals, and earnings — the AI economy on tiny.technology. Paid tinys charge from here; price your own to earn.")
                }

                Section {
                    NavigationLink {
                        TelegramView(token: session.token)
                    } label: {
                        Label("Telegram bot", systemImage: "paperplane")
                    }
                } header: {
                    Text("Telegram")
                } footer: {
                    Text("Connect a BotFather bot and your tiny answers on Telegram too.")
                }

                Section {
                    if let u = session.user {
                        LabeledContent("Account", value: "@\(u.login)")
                    }
                    LabeledContent("Device") {
                        HStack(spacing: 6) {
                            StatusDot(on: session.deviceId != nil,
                                      onLabel: "enrolled", offLabel: "not enrolled")
                            Text(session.deviceId.map { "\($0.prefix(12))…" } ?? "not enrolled")
                                .font(.caption.monospaced())
                        }
                    }
                } header: {
                    Text("Fleet")
                } footer: {
                    Text("Manage or revoke devices at tiny.technology/devices.")
                }

                // ── This device ── the sections below configure THIS phone
                // (local Keychain/UserDefaults), not the account. Grouped after
                // the account cluster per the settings-restructure ask.
                Section {
                    Toggle("Speak replies aloud", isOn: $autoSpeak)
                    Picker("Voice", selection: $voiceId) {
                        Text("System default").tag("")
                        ForEach(Self.voices, id: \.identifier) { v in
                            Text("\(v.name) (\(v.language))").tag(v.identifier)
                        }
                    }
                    Button {
                        let sample = voiceId.isEmpty ? nil : voiceId
                        Speech.shared.preview("Hi, I'm tiny — this is how I sound.", voiceId: sample)
                    } label: {
                        Label("Preview voice", systemImage: "play.circle")
                            .font(.subheadline)
                    }
                } header: {
                    Text("Spoken replies (text-to-speech)")
                } footer: {
                    Text("The on-device voice for the speak tool — NOT the live voice-call voice. Download higher-quality voices in iOS Settings → Accessibility → Spoken Content → Voices — they appear here.")
                }

                Section {
                    // 📍 web composer 📍 / Android settings-toggle parity.
                    // Flipping on runs the system ask; an ON flag without a
                    // grant still injects nothing (Geo gates on authorized).
                    Toggle("Share location with your tiny", isOn: $locationContext)
                        .onChange(of: locationContext) { _, on in
                            if on { Geo.shared.requestPermission() }
                        }
                } header: {
                    Text("Location")
                } footer: {
                    Text("While on, each message quietly carries your position and speed so your tiny answers with real context. Off = nothing leaves the phone.")
                }

                // The cfg_quiet_hours flag has been honored since the relay
                // speak tool landed (Config.isQuietNow), but this toggle is the
                // first UI that lets the user change it.
                Section {
                    Toggle("Quiet hours (10pm–8am)", isOn: $quietHours)
                } header: {
                    Text("Quiet hours")
                } footer: {
                    Text("While on, remote audible actions — the web agent speaking or playing sounds through this phone — stay silent from 10pm to 8am. Vibration and silent tools still work; chatting in the app is unaffected.")
                }

                #if canImport(MWDATCore) && canImport(MWDATCamera)
                Section {
                    HStack {
                        Label("Status", systemImage: "eyeglasses")
                        Spacer()
                        Text(wearables.statusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if wearables.isLinked {
                        Button(role: .destructive) {
                            wearables.unlink()
                        } label: {
                            Label("Unlink glasses", systemImage: "xmark.circle")
                        }
                    } else {
                        Button {
                            wearables.link()
                        } label: {
                            Label("Link glasses via Meta AI", systemImage: "link")
                        }
                    }
                    if let err = wearables.lastError {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }
                } header: {
                    Text("Meta glasses")
                } footer: {
                    Text("Link your Meta AI glasses to give your tiny eyes — it can capture what you're looking at when you ask. The link is made by the Meta AI app with your permission; unlink here or there any time.")
                }
                #endif

                Section {
                    discoveryRow("mic.fill", "Control Center & Action button",
                                 "Settings → Control Center → add \"Ask tiny\" — one press opens the mic. Also assignable to the Action button.")
                    discoveryRow("square.grid.2x2", "Widgets",
                                 "Long-press the Home or Lock Screen → add \"tiny fleet\" or \"ask tiny\".")
                    discoveryRow("applewatch", "Apple Watch",
                                 "The watch app installs automatically. Add the \"tiny\" complication to your watch face for fleet + unread.")
                    discoveryRow("waveform", "Siri & Shortcuts",
                                 "Say \"Ask tiny\" — on the phone or the watch. Fleet status and DMs work from Shortcuts too.")
                    Button {
                        showTour = true
                    } label: {
                        Label("Replay the tour", systemImage: "play.circle")
                            .font(.subheadline)
                    }
                    Button {
                        showAbout = true
                    } label: {
                        Label("About tiny", systemImage: "info.circle")
                            .font(.subheadline)
                    }
                } header: {
                    Text("Get more from tiny")
                }

                if hSize == .regular {
                    Section {
                        shortcutRow("⌘K", "Open the Universe")
                        shortcutRow("⌘1 – ⌘6", "Sidebar surfaces — Memory, Jobs, Devices, Messages, Nearby, Settings")
                        shortcutRow("⌘N", "Clear chat (new conversation)")
                        shortcutRow("⌘⇧E", "Export conversation")
                        shortcutRow("⌘.", "Stop generating")
                        shortcutRow("⎋", "Dismiss any panel")
                    } header: {
                        Text("Keyboard shortcuts")
                    } footer: {
                        Text("Hold ⌘ anywhere for the system shortcut overlay.")
                    }
                }

                Section {
                    TextField(Config.defaultServer, text: $server)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.caption.monospaced())
                } header: {
                    Text("Advanced")
                } footer: {
                    Text("API server override (dev builds). Malformed values fall back to the default. Takes effect on the next message.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                // Fresh-device hydration: a device still on the free default
                // inherits the account's synced BYOK selection (key stays
                // server-side). Never clobbers a local BYOK config.
                if await ModelConfigStore.hydrateFromRemote(token: session.token) {
                    modelKey = Keychain.get("tiny_model_api_key") ?? ""
                }
                // Reflect the account-default call voice (cross-device).
                accountVoice = await AccountVoiceStore.load(token: session.token)
            }
            .sheet(isPresented: $showTour) { OnboardingView(preview: true) }
            .sheet(isPresented: $showAbout) { AboutView() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// What a config editor may claim when its read didn't come back.
///
/// A read has three answers, not two: it loaded and this is yours, it loaded
/// and it isn't, or it never loaded. The editor used to have branches for only
/// the first two and picked between them on `isOwner` — a field filled from a
/// `try?` body via `?? false`. So an outage, an expired token and a subway
/// tunnel all rendered "Only X's owner can edit it. Set the Tiny field to one
/// of your own tinys." — an accusation the app had no grounds for, carrying a
/// remedy that changes nothing. Every sibling loader on this screen already
/// refuses that collapse (Messages, MemoryGraph, learnings, devices, Telegram);
/// /api/graph's comment names the rule outright, masked-empty discipline. This
/// states it once, in a shape a test can hold, so the fourth branch can't be
/// quietly folded back into the third.
enum TinyEditorLoad {
    enum Screen: Equatable {
        case editor      // loaded, and it's yours
        case notOwner    // loaded, and the server said it isn't
        case failed      // never loaded — say so and offer a retry
    }

    static func screen(loaded: Bool, isOwner: Bool) -> Screen {
        // Ownership is only meaningful once something was really read.
        guard loaded else { return .failed }
        return isOwner ? .editor : .notOwner
    }
}

/// A price the editor may or may not know.
///
/// Pricing is a second request, so it fails independently of the persona above
/// it — and on this screen an empty field is not "no value", it is the value
/// FREE. Collapsing an unread price to "" therefore told the owner of a paid
/// tiny that it charges nothing, and left "Save price" armed to make that true:
/// one tap posts price_micro 0 and a read failure becomes a real price cut.
/// Unknown is its own state, it says so, and it cannot be posted until someone
/// types a number.
enum TinyPrice {
    /// Did the lookup actually answer? A returned body is the answer even when
    /// it carries no `price_micro` — 0 and absent both mean free — and the route
    /// 400s rather than handing back a bad body, so a throw is the only thing
    /// that means "unknown". Same rule as MapPresence.optOutConfirmed: nothing
    /// but the body's own arrival counts.
    static func known(_ body: [String: Any]?) -> Bool { body != nil }

    /// May a "Save price" tap post? Only when the figure on screen is one the
    /// server gave or one the user typed. Empty-over-unknown is neither.
    static func mayPost(known: Bool, typed: String) -> Bool {
        if known { return true }
        return !typed.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The line under an unknown price; nil when there is nothing to admit.
    static func unknownNote(known: Bool) -> String? {
        known ? nil
              : "Couldn't read the current price — this field isn't it. Type a price to set one."
    }
}

/// The first native slice of web's tiny editor (Control.tsx, the Settings
/// modal's "Your AI" tab): persona texts + visibility, over the same
/// POST /api/control the web editor and VoicePickerSheet already use.
/// Read side is POST /api/tiny — owners get the full config echoed back;
/// non-owners get the locked shape, so the form only renders on isOwner.
struct TinyEditorView: View {
    let name: String
    let token: String?

    @State private var loading = true
    /// The read never came back. Kept apart from `isOwner`, which is a verdict
    /// the server actually gave — see TinyEditorLoad.
    @State private var loadError = false
    @State private var isOwner = false
    @State private var systemPrompt = ""
    @State private var systemKnowledge = ""
    @State private var dataBlob = ""
    @State private var isPrivate = false
    @State private var tagline = ""
    @State private var chipsText = ""
    @State private var introVibe = ""
    @State private var logoUrl = ""
    @State private var heroUrl = ""
    @State private var accentHex = ""
    @State private var bgHex = ""
    @State private var saving = false
    @State private var status: String?
    @State private var failed = false
    @State private var confirmName = ""
    @State private var deleting = false
    @State private var deleteStatus: String?
    @State private var deleted = false
    @State private var priceUsd = ""
    /// Was the price on screen really read back? An empty field means "free",
    /// so an unread price must not be allowed to look like one — see TinyPrice.
    @State private var priceKnown = false
    @State private var savingPrice = false
    @State private var priceStatus: String?
    @State private var priceFailed = false
    @State private var hookUrl = ""
    @State private var mcpText = ""
    @State private var tinyVoice = ""
    @State private var workerUrl = ""
    @State private var loadedWorkerUrl = ""
    @State private var workerActive = false
    @State private var validatingWorker = false
    @State private var workerStatus: String?
    // Stored as serialized Data (Sendable): keeping the parsed Any here made
    // save()'s body dictionary share references with view state, which Swift 6
    // rejects at the Api.post send boundary ("sending 'body' risks data
    // races"). Deserializing a fresh copy at save time keeps the region clean.
    @State private var workerSchemaData: Data?
    @State private var workerSkillsData: Data?

    /// Which of the three answers the read gave. Never derived from `isOwner`
    /// alone — that would make an outage indistinguishable from a verdict.
    private var screen: TinyEditorLoad.Screen {
        TinyEditorLoad.screen(loaded: !loadError, isOwner: isOwner)
    }

    /// Web Control.tsx's live MCP validation, ported: empty is fine; else
    /// parse, unwrap an optional {mcpServers:{…}} envelope, require a
    /// non-array object whose every entry has an https url.
    private var mcpError: String? {
        let t = mcpText.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        guard let data = t.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else { return "invalid JSON" }
        let entries = (parsed as? [String: Any])?["mcpServers"] ?? parsed
        guard let dict = entries as? [String: Any] else { return "must be an object of servers" }
        for (k, v) in dict {
            guard let sv = v as? [String: Any], let url = sv["url"] as? String else { return "'\(k)' needs a url" }
            if !url.hasPrefix("https://") { return "'\(k)' url must be https" }
        }
        return nil
    }

    var body: some View {
        Form {
            if deleted {
                Section {
                    Text("\(name) is deleted. Its page, memory, and config are gone; this phone's local copies were wiped.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            } else if loading {
                Section { ProgressView("Loading \(name)…") }
            } else if screen == .failed {
                Section {
                    Text("Couldn't load \(name)'s settings — check the connection and try again. Nothing has been changed.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Retry") { Task { await load() } }
                }
            } else if screen == .notOwner {
                Section {
                    Text("Only \(name)'s owner can edit it. Set the Tiny field to one of your own tinys.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                Section {
                    TextEditor(text: $systemPrompt)
                        .font(.caption.monospaced())
                        .frame(minHeight: 120)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("First message (system prompt)")
                } footer: {
                    Text("Who your tiny is — personality, role, and how it should behave.")
                }
                Section {
                    TextEditor(text: $systemKnowledge)
                        .font(.caption.monospaced())
                        .frame(minHeight: 120)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Second message (knowledge)")
                } footer: {
                    Text("What your tiny knows — facts, links, and instructions it always carries.")
                }
                Section {
                    TextEditor(text: $dataBlob)
                        .font(.caption.monospaced())
                        .frame(minHeight: 80)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Context data")
                } footer: {
                    Text("Optional extra context your tiny carries into every conversation.")
                }
                Section {
                    Toggle("Private", isOn: $isPrivate)
                } footer: {
                    Text("A private tiny answers only you and the people you authorize.")
                }
                Section {
                    TextField("Landing subtitle", text: $tagline)
                    TextField("Starter chips (comma-separated)", text: $chipsText)
                        .textInputAutocapitalization(.never)
                    Picker("Intro vibe", selection: $introVibe) {
                        Text("None").tag("")
                        ForEach(ChatModel.vibePatterns.sorted(), id: \.self) { v in
                            Text(v.capitalized).tag(v)
                        }
                    }
                    TextField("Logo URL (https)", text: $logoUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).font(.caption.monospaced())
                    TextField("Hero banner URL (https)", text: $heroUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).font(.caption.monospaced())
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Tagline up to 200 characters; up to 4 chips, 60 characters each. The intro vibe is the haptic greeting the app plays when someone opens your tiny. Clearing a field removes it.")
                }
                Section {
                    HStack {
                        TextField("Accent hex (#22c55e)", text: $accentHex)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.caption.monospaced())
                        if let c = Color.fromHex(accentHex) {
                            RoundedRectangle(cornerRadius: 4).fill(c).frame(width: 22, height: 22)
                        }
                    }
                    HStack {
                        TextField("Background hex (#0b0f0c)", text: $bgHex)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.caption.monospaced())
                        if let c = Color.fromHex(bgHex) {
                            RoundedRectangle(cornerRadius: 4).fill(c).frame(width: 22, height: 22)
                        }
                    }
                } header: {
                    Text("Colors")
                } footer: {
                    Text("The tiny's accent and page background, everywhere it renders. Empty both to use the defaults.")
                }
                Section {
                    Picker("Call voice", selection: $tinyVoice) {
                        Text("Inherit (account default, else marin)").tag("")
                        ForEach(kAccountRealtimeVoices, id: \.self) { v in
                            Text(v.capitalized).tag(v)
                        }
                    }
                } header: {
                    Text("Live-call voice")
                } footer: {
                    Text("The voice \(name) speaks with on live calls — everyone who calls it hears this. The in-chat Call voice menu sets the same field.")
                }
                Section {
                    TextField("Webhook URL (optional)", text: $hookUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).font(.caption.monospaced())
                    TextEditor(text: $mcpText)
                        .font(.caption.monospaced())
                        .frame(minHeight: 120)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if let e = mcpError {
                        Text(e).font(.caption).foregroundStyle(.red)
                    } else if !mcpText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("Valid MCP JSON").font(.caption).foregroundStyle(.green)
                    }
                } header: {
                    Text("Integrations")
                } footer: {
                    Text("Webhook: your endpoint gets called on events. MCP servers: plug any remote streamable-http MCP server into \(name) — its tools become the tiny's tools. Shape: {\"my-tools\": {\"url\": \"https://…\", \"headers\": {…}}}. Headers stay owner-private.")
                }
                Section {
                    TextField("https://your-api.com/openapi.json", text: $workerUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).font(.caption.monospaced())
                        .onChange(of: workerUrl) { workerActive = false; workerStatus = nil }
                    Button {
                        Task { await validateWorker() }
                    } label: {
                        if validatingWorker { ProgressView() } else { Text("Validate") }
                    }
                    .disabled(validatingWorker || workerUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let s = workerStatus {
                        Text(s).font(.caption).foregroundStyle(workerActive ? .green : .red)
                    }
                } header: {
                    Text("Worker API (OpenAPI skills)")
                } footer: {
                    Text("Point at your API's openapi.json and its functions become \(name)'s skills. Validate first — Save only includes a worker the validator accepted; empty clears it.")
                }
                // Pricing keeps its own save button, like web's Control.tsx:
                // set_price is a separate idempotent endpoint, and a price
                // should never silently change because the prompt was re-saved.
                Section {
                    HStack {
                        Text("$")
                        TextField(priceKnown ? "0 (free)" : "unknown", text: $priceUsd)
                            .keyboardType(.decimalPad)
                            .font(.body.monospaced())
                    }
                    Button {
                        Task { await savePrice() }
                    } label: {
                        if savingPrice { ProgressView() } else { Text("Save price") }
                    }
                    .disabled(savingPrice || !TinyPrice.mayPost(known: priceKnown, typed: priceUsd))
                    if let s = priceStatus {
                        Text(s).font(.caption).foregroundStyle(priceFailed ? .red : .green)
                    } else if let c = TinyPrice.unknownNote(known: priceKnown) {
                        Text(c).font(.caption).foregroundStyle(.orange)
                    }
                } header: {
                    Text("Price per message")
                } footer: {
                    Text("What people — and other AIs — pay to message \(name), in USDC. Empty or 0 = free; $100 max. You earn it to your tiny wallet.")
                }
                // Group: the owner branch sits at SwiftUI's 10-child limit —
                // Save + Danger share a slot.
                Group {
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(saving || systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let s = status {
                        Text(s).font(.caption).foregroundStyle(failed ? .red : .green)
                    }
                } footer: {
                    Text("Saves to \(name) everywhere — web, phone, voice, and API.")
                }
                Section {
                    TextField("Type \(name) to confirm", text: $confirmName)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button(role: .destructive) {
                        Task { await deleteTiny() }
                    } label: {
                        if deleting { ProgressView() } else { Text("Delete \(name) forever") }
                    }
                    .disabled(deleting || confirmName.trimmingCharacters(in: .whitespaces) != name)
                    if let s = deleteStatus {
                        Text(s).font(.caption).foregroundStyle(.red)
                    }
                } header: {
                    Text("Danger zone")
                } footer: {
                    Text("Deletes \(name) permanently — its page, memory, and config everywhere. This phone's local chat history, saved sessions, and on-device memories for it are wiped too.")
                }
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        loading = true
        loadError = false
        // A read that never arrived may not be spread across the form. The old
        // `try?` + `?? ""` did exactly that: every field took its empty default
        // and `isOwner` took `false`, so a subway tunnel rendered the one branch
        // that tells an owner they don't own their tiny — and offers a remedy
        // ("set the Tiny field to one of your own") that fixes nothing. Every
        // other loader on this screen already refuses the collapse; /api/graph's
        // comment even names it, masked-empty discipline.
        guard let d: [String: Any] = try? await Api.post("/api/tiny", token: token, body: ["name": name]) else {
            loadError = true
            loading = false
            return
        }
        isOwner = d["isOwner"] as? Bool ?? false
        systemPrompt = d["systemPrompt"] as? String ?? ""
        systemKnowledge = d["systemKnowledge"] as? String ?? ""
        dataBlob = d["data"] as? String ?? ""
        isPrivate = d["private"] as? Bool ?? false
        tinyVoice = d["voice"] as? String ?? ""
        tagline = ChatModel.customTagline(from: d["tagline"]) ?? ""
        chipsText = (ChatModel.customChips(from: d["chips"]) ?? []).joined(separator: ", ")
        introVibe = ChatModel.introVibe(from: d["intro_vibe"] as? String) ?? ""
        logoUrl = d["logo"] as? String ?? ""
        heroUrl = d["hero"] as? String ?? ""
        // theme arrives as an object or a JSON string — accept both, like
        // ChatModel.loadTheme does.
        var theme = d["theme"] as? [String: Any]
        if theme == nil, let s = d["theme"] as? String, let data = s.data(using: .utf8) {
            theme = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        accentHex = theme?["accent"] as? String ?? ""
        bgHex = theme?["bg"] as? String ?? ""
        hookUrl = d["hook"] as? String ?? ""
        workerUrl = d["worker"] as? String ?? ""
        loadedWorkerUrl = workerUrl
        // mcpServers arrives as a JSON string or an object (owners get it
        // unredacted) — normalize to pretty JSON for the editor.
        if let raw = d["mcpServers"] {
            if let s = raw as? String {
                if let sd = s.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: sd),
                   let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
                    mcpText = String(data: pretty, encoding: .utf8) ?? s
                } else {
                    mcpText = s
                }
            } else if !(raw is NSNull),
                      let pretty = try? JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys]) {
                mcpText = String(data: pretty, encoding: .utf8) ?? ""
            }
        }
        // Current per-message price — a second, independent request, so it can
        // fail while the persona above loaded fine. A returned body is the
        // answer even when it carries no `price_micro` (0/absent = free); only
        // a throw means unknown, and the route 400s rather than lying, so the
        // two really are distinguishable here.
        let p: [String: Any]? = try? await Api.post("/api/wallet", token: token, body: [
            "action": "pricing", "resource": "tiny:\(name.lowercased())",
        ])
        priceKnown = TinyPrice.known(p)
        let micro = (p?["price_micro"] as? NSNumber)?.int64Value ?? 0
        priceUsd = micro > 0 ? Self.usdString(micro: micro) : ""
        loading = false
    }

    /// 1_500_000 → "1.5", 10_000 → "0.01" — no trailing zeros, no float drift.
    private static func usdString(micro: Int64) -> String {
        let s = String(format: "%.6f", Double(micro) / 1_000_000)
        var t = s
        while t.hasSuffix("0") { t.removeLast() }
        if t.hasSuffix(".") { t.removeLast() }
        return t
    }

    private func deleteTiny() async {
        deleting = true; deleteStatus = nil
        let ok: [String: Any]? = try? await Api.deleteJson("/api/delete", token: token, body: ["name": name])
        deleting = false
        if ok?["ok"] as? Bool == true {
            // Local purge — the iOS twin of web's purgeTinyKeys: on-device
            // memories + turn log, the per-tiny chat history file, saved
            // sessions, and the default-tiny pointer when it named this tiny.
            Continuity.clearMemories(name)
            Continuity.clearTurnLog(name)
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try? FileManager.default.removeItem(at: docs.appendingPathComponent("chat-history-\(name).json"))
            try? FileManager.default.removeItem(at: SessionStore.dir(name))
            let store = UserDefaults(suiteName: WidgetStore.suite)
            if store?.string(forKey: "cfg_tiny_name") == name { store?.set("", forKey: "cfg_tiny_name") }
            deleted = true
        } else {
            deleteStatus = (ok?["error"] as? String) ?? "Couldn't delete — try again."
        }
    }

    private func savePrice() async {
        priceStatus = nil
        let trimmed = priceUsd.trimmingCharacters(in: .whitespaces)
        let usd = trimmed.isEmpty ? 0 : Double(trimmed)
        // Mirror the server contract ($0–$100) so the owner sees the honest
        // reason here instead of a proxied 400.
        guard let usd, usd.isFinite, usd >= 0, usd <= 100 else {
            priceStatus = "Price must be between $0 and $100 per message."
            priceFailed = true
            return
        }
        savingPrice = true
        let micro = Int((usd * 1_000_000).rounded())
        let ok: [String: Any]? = try? await Api.post("/api/wallet", token: token, body: [
            "action": "set_price",
            "resource": "tiny:\(name.lowercased())",
            "price_micro": micro,
        ])
        savingPrice = false
        if ok?["ok"] as? Bool == true {
            priceStatus = micro > 0 ? "\(name) now charges $\(Self.usdString(micro: Int64(micro))) per message." : "\(name) is free again."
            priceFailed = false
            // Confirmed by the server, so the field is no longer a guess even if
            // the lookup that opened the screen had failed.
            priceKnown = true
        } else {
            priceStatus = (ok?["error"] as? String) ?? "Couldn't set the price — try again."
            priceFailed = true
        }
    }

    /// POST /api/worker — web's onBlur validate, behind an explicit button
    /// (mobile has no blur). Success stashes the fetched OpenAPI schema +
    /// parsed skills so save() can post exactly what web posts.
    private func validateWorker() async {
        validatingWorker = true; workerStatus = nil
        let url = workerUrl.trimmingCharacters(in: .whitespaces)
        let r: [String: Any]? = try? await Api.post("/api/worker", token: token, body: ["name": name, "worker": url])
        validatingWorker = false
        if (r?["message"] as? String) == "Worker is active." {
            workerActive = true
            workerSchemaData = (r?["schema"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            workerSkillsData = (r?["skills"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            let paths = ((r?["schema"] as? [String: Any])?["paths"] as? [String: Any])?.keys.sorted() ?? []
            workerStatus = "Worker is active — \(paths.count) endpoint\(paths.count == 1 ? "" : "s"): \(paths.joined(separator: ", "))"
        } else {
            workerActive = false
            workerStatus = (r?["message"] as? String) ?? "Couldn't validate the worker URL — try again."
        }
    }

    private func save() async {
        // Never post MCP JSON the validator rejects — the worker's
        // invalid-preserve rule would make the save look clean while
        // silently keeping the old servers.
        if let e = mcpError {
            status = "MCP servers: \(e)"
            failed = true
            return
        }
        // A CHANGED worker URL must be validated before it can save — the
        // schema posted alongside it comes from validation. An unchanged one
        // is simply omitted (server preserves).
        let worker = workerUrl.trimmingCharacters(in: .whitespaces)
        if worker != loadedWorkerUrl && !worker.isEmpty && !workerActive {
            status = "Validate the worker URL before saving."
            failed = true
            return
        }
        saving = true; status = nil
        // The persona pair rides on every save (the worker's D1 mirror writes
        // raw body fields — omitting them would blank the persona, the same
        // reason saveVoice re-sends them). "priv" is this route's name for
        // the private flag; fields not sent stay preserved server-side.
        // Chips: comma-separated text → array (route JSON-stringifies it);
        // clamp to the worker's 1–4 × ≤60-char rule so an oversize entry
        // doesn't silently no-op the save ([] = explicit clear).
        let chips = chipsText.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .prefix(4).map { String($0.prefix(60)) }
        // Theme: object when either color is set (route stringifies), '' clears.
        let a = accentHex.trimmingCharacters(in: .whitespaces)
        let b = bgHex.trimmingCharacters(in: .whitespaces)
        var theme: [String: String] = [:]
        if !a.isEmpty { theme["accent"] = a }
        if !b.isEmpty { theme["bg"] = b }
        var body: [String: Any] = [
            "name": name,
            "systemPrompt": systemPrompt,
            "systemKnowledge": systemKnowledge,
            "data": dataBlob,
            "priv": isPrivate,
            "tagline": tagline.trimmingCharacters(in: .whitespacesAndNewlines),
            "chips": Array(chips),
            "intro_vibe": introVibe,
            "logo": logoUrl.trimmingCharacters(in: .whitespaces),
            "hero": heroUrl.trimmingCharacters(in: .whitespaces),
            "theme": (theme.isEmpty ? "" : theme) as Any,
            "hook": hookUrl.trimmingCharacters(in: .whitespaces),
            "mcpServers": mcpText.trimmingCharacters(in: .whitespacesAndNewlines),
            "voice": tinyVoice,
        ]
        if worker.isEmpty {
            // Explicit clear only if one was stored; else leave untouched.
            if !loadedWorkerUrl.isEmpty {
                body["worker"] = ""; body["schema"] = ""; body["skills"] = ""
            }
        } else if workerActive, let schemaData = workerSchemaData,
                  let schema = try? JSONSerialization.jsonObject(with: schemaData) {
            // What web posts after a good validate: url + fetched schema +
            // parsed skills (route JSON-stringifies the objects).
            body["worker"] = worker
            body["schema"] = schema
            if let skillsData = workerSkillsData,
               let skills = try? JSONSerialization.jsonObject(with: skillsData) {
                body["skills"] = skills
            }
        }
        let ok: [String: Any]? = try? await Api.post("/api/control", token: token, body: body)
        saving = false
        if (ok?["message"] as? String) == "Success!" {
            status = "Saved."
            failed = false
            loadedWorkerUrl = worker
        } else {
            status = (ok?["message"] as? String) ?? "Save failed — check the connection and try again."
            failed = true
        }
    }
}

/// Telegram bot connection — the native mirror of web's TelegramSettings.tsx
/// over the same GET/POST/DELETE /api/telegram proxy. GET distinguishes
/// "no bot yet" ({bot:null} → setup form) from an outage (error → Retry),
/// because showing the setup form to an already-connected user on a blip
/// would invite them to clobber their own bot.
struct TelegramView: View {
    let token: String?

    @State private var loading = true
    @State private var loadError = false
    @State private var hasBot = false
    @State private var botEnabled = false
    @State private var botToken = ""
    @State private var tinyField = ""
    @State private var chatsField = ""
    @State private var busy = false
    @State private var status: String?
    @State private var failed = false
    @State private var confirmDisconnect = false

    var body: some View {
        Form {
            if loading {
                Section { ProgressView("Loading…") }
            } else if loadError {
                Section {
                    Text("Couldn't load the Telegram config.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Retry") { Task { await load() } }
                }
            } else {
                if hasBot {
                    Section {
                        LabeledContent("Status", value: botEnabled ? "Active" : "Paused")
                        Button(botEnabled ? "Pause bot" : "Resume bot") {
                            Task { await toggle() }
                        }
                        .disabled(busy)
                    }
                }
                Section {
                    Group {
                        if hasBot {
                            SecureField("New BotFather token (empty keeps current)", text: $botToken)
                        } else {
                            SecureField("BotFather token", text: $botToken)
                        }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.caption.monospaced())
                    TextField("Which tiny answers", text: $tinyField)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Allowed chat ids (comma-separated)", text: $chatsField)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.caption.monospaced())
                    Button {
                        Task { await save() }
                    } label: {
                        if busy { ProgressView() } else { Text(hasBot ? "Save" : "Connect") }
                    }
                    .disabled(busy)
                    if let s = status {
                        Text(s).font(.caption).foregroundStyle(failed ? .red : .green)
                    }
                } header: {
                    Text(hasBot ? "Bot settings" : "Connect a bot")
                } footer: {
                    Text("Create a bot with @BotFather on Telegram and paste its token. Leave chat ids empty for pairing mode — message the bot and it replies with your chat id.")
                }
                if hasBot {
                    Section {
                        Button("Disconnect", role: .destructive) { confirmDisconnect = true }
                            .disabled(busy)
                    } footer: {
                        Text("Removes the token; conversations on Telegram stop.")
                    }
                }
            }
        }
        .navigationTitle("Telegram")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog("Disconnect Telegram bot?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await disconnect() } }
        } message: {
            Text("The token is removed and conversations on Telegram stop.")
        }
    }

    private func load() async {
        loading = true; loadError = false
        let d: [String: Any]? = try? await Api.get("/api/telegram", token: token)
        loading = false
        guard let d else { loadError = true; return }
        if let bot = d["bot"] as? [String: Any] {
            hasBot = true
            botEnabled = bot["enabled"] as? Bool ?? false
            tinyField = bot["tiny"] as? String ?? ""
            chatsField = bot["allowedChats"] as? String ?? ""
        } else {
            hasBot = false
        }
    }

    private func save() async {
        status = nil
        let tok = botToken.trimmingCharacters(in: .whitespaces)
        if !hasBot && tok.isEmpty {
            status = "Paste your BotFather token first."; failed = true; return
        }
        if tinyField.trimmingCharacters(in: .whitespaces).isEmpty {
            status = "Which tiny should answer?"; failed = true; return
        }
        busy = true
        var body: [String: Any] = [
            "tiny": tinyField.trimmingCharacters(in: .whitespaces),
            "allowedChats": chatsField,
            "enabled": true,
        ]
        if !tok.isEmpty { body["token"] = tok }
        let d: [String: Any]? = try? await Api.post("/api/telegram", token: token, body: body)
        busy = false
        if d?["ok"] as? Bool == true {
            botToken = ""
            status = (d?["pairing"] as? Bool == true)
                ? "Bot connected in pairing mode — message it on Telegram to get your chat id."
                : "Telegram bot updated."
            failed = false
            await load()
        } else {
            status = (d?["error"] as? String) ?? "Couldn't save — try again."
            failed = true
        }
    }

    private func toggle() async {
        busy = true; status = nil
        let d: [String: Any]? = try? await Api.post("/api/telegram", token: token, body: ["enabled": !botEnabled])
        busy = false
        if d?["ok"] as? Bool == true {
            status = botEnabled ? "Bot paused." : "Bot resumed."
            failed = false
            await load()
        } else {
            status = (d?["error"] as? String) ?? "Couldn't update the bot — try again."
            failed = true
        }
    }

    private func disconnect() async {
        busy = true; status = nil
        let d: [String: Any]? = try? await Api.deleteJson("/api/telegram", token: token, body: [:])
        busy = false
        if d?["ok"] as? Bool == true {
            hasBot = false; botToken = ""; chatsField = ""
            status = "Telegram disconnected."
            failed = false
        } else {
            status = (d?["error"] as? String) ?? "Couldn't disconnect — try again."
            failed = true
        }
    }
}
