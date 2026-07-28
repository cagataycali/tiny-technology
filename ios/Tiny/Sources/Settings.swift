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
    @Environment(\.horizontalSizeClass) private var hSize

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
                } header: {
                    Text("Tiny")
                } footer: {
                    Text("Which tiny this app chats as (tiny.technology/<name>). Empty = tiny.")
                }

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
                    Text("🤖 Model & API key")
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
                    Text("📞 Voice-call OpenAI key")
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
                    Text("🎙 Live-call voice")
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
                    Text("💳 Wallet")
                } footer: {
                    Text("Your USDC balance, deposits, withdrawals, and earnings — the AI economy on tiny.technology. Paid tinys charge from here; price your own to earn.")
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
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
