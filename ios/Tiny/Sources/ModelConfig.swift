/**
 * BYO-model config — iOS port of web components/chat/ModelSettings.tsx's BYOK
 * half. A user can point the chat at their own provider + API key; the
 * selection travels as the same `x-tiny-model-*` headers the web sends, so
 * app/api/chat/route.ts routes it through lib/chat/model.ts unchanged.
 *
 * The API key is a SECRET → it lives in the Keychain (same discipline as the
 * auth token, never UserDefaults); the non-secret fields ride UserDefaults so
 * SettingsView can bind them with @AppStorage. `headers(...)` is PURE and
 * testable — it mirrors web modelConfigHeaders() byte-for-byte, including the
 * security guard that a custom provider with no base URL emits NOTHING (so the
 * key can't leak to OpenAI's default endpoint).
 */
import Foundation

/// Provider presets — label + default base URL, mirroring web PROVIDER_PRESETS.
/// `default` is the free rate-limited Tiny endpoint (no key, no headers).
/// WebLLM (browser/WebGPU on-device) is deliberately omitted — no iOS analogue.
struct ModelProvider: Identifiable {
    let id: String       // the x-tiny-model-provider value ("openai", "custom", …)
    let label: String
    let baseUrl: String  // preset base URL ("" = provider's own default / n/a)
    let modelPlaceholder: String
    let keyPlaceholder: String

    static let all: [ModelProvider] = [
        .init(id: "default", label: "Tiny (free, rate-limited)", baseUrl: "",
              modelPlaceholder: "gpt-5.6-luna", keyPlaceholder: "No key needed"),
        .init(id: "openai", label: "OpenAI", baseUrl: "",
              modelPlaceholder: "gpt-5-mini-2025-08-07", keyPlaceholder: "sk-…"),
        .init(id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1/",
              modelPlaceholder: "claude-sonnet-4-5", keyPlaceholder: "sk-ant-…"),
        .init(id: "bedrock", label: "Amazon Bedrock (API key)", baseUrl: "",
              modelPlaceholder: "global.anthropic.claude-opus-4-8",
              keyPlaceholder: "bedrock-api-key… (Console → Bedrock → API keys)"),
        .init(id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
              modelPlaceholder: "anthropic/claude-sonnet-4.5", keyPlaceholder: "sk-or-…"),
        .init(id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1",
              modelPlaceholder: "llama-3.3-70b-versatile", keyPlaceholder: "gsk_…"),
        .init(id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
              modelPlaceholder: "deepseek-chat", keyPlaceholder: "sk-…"),
        .init(id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1",
              modelPlaceholder: "mistral-large-latest", keyPlaceholder: "…"),
        .init(id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1",
              modelPlaceholder: "grok-2-latest", keyPlaceholder: "xai-…"),
        .init(id: "perplexity", label: "Perplexity", baseUrl: "https://api.perplexity.ai",
              modelPlaceholder: "sonar-pro", keyPlaceholder: "pplx-…"),
        .init(id: "gemini", label: "Google Gemini",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
              modelPlaceholder: "gemini-2.5-flash", keyPlaceholder: "AIzaSy…"),
        .init(id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "",
              modelPlaceholder: "model-id", keyPlaceholder: "api-key"),
    ]

    static func preset(_ id: String) -> ModelProvider? { all.first { $0.id == id } }
}

/// The user's selection. `apiKey` is loaded from the Keychain, never persisted
/// in this struct's UserDefaults mirror.
struct ModelConfig {
    var provider: String = "default"
    var apiKey: String = ""
    var modelId: String = ""
    var baseUrl: String = ""
    var maxTokens: String = ""
    var region: String = "us-west-2"
    var additionalFields: String = ""

    /// Pure header builder — the byte-for-byte iOS twin of web
    /// modelConfigHeaders(). No headers for the free default (or a keyless
    /// selection); a custom provider with no resolvable base URL emits NOTHING
    /// so the key can never leak to OpenAI's default endpoint.
    func headers() -> [String: String] {
        var h: [String: String] = [:]
        guard provider != "default", !apiKey.isEmpty else { return h }
        let baseUrl = self.baseUrl.isEmpty
            ? (ModelProvider.preset(provider)?.baseUrl ?? "")
            : self.baseUrl
        // Backstops the save() guard against a hand-edited config.
        if provider == "custom" && baseUrl.isEmpty { return h }
        h["x-tiny-model-provider"] = provider
        h["x-tiny-model-api-key"] = apiKey
        if !modelId.isEmpty { h["x-tiny-model-id"] = modelId }
        if !baseUrl.isEmpty { h["x-tiny-model-base-url"] = baseUrl }
        if !maxTokens.isEmpty { h["x-tiny-model-max-tokens"] = maxTokens }
        if provider == "bedrock" && !region.isEmpty { h["x-tiny-model-region"] = region }
        // Only emit a valid JSON OBJECT; strip to a single line (HTTP headers
        // can't span lines). Matches web's parse-and-restringify guard.
        let trimmed = additionalFields.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty,
           let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any], !dict.isEmpty,
           let reEncoded = try? JSONSerialization.data(withJSONObject: dict),
           let oneLine = String(data: reEncoded, encoding: .utf8) {
            h["x-tiny-model-additional-fields"] = oneLine
        }
        return h
    }
}

/// Pure builder for the `x-tiny-model-*` headers a VOICE session carries. Voice
/// (speech-to-speech) is OpenAI-ONLY — the /api/voice/session route gates on
/// `provider === 'openai'` — so this ALWAYS emits an `openai` provider and NEVER
/// forwards a Bedrock/Anthropic chat key. The dedicated `voiceKey` wins; it falls
/// back to the chat key ONLY when chat is itself OpenAI (single-key convenience).
/// A realtime chat model id passes through only on that reuse path; the dedicated
/// path leaves the model to the DO default. Empty → the route returns the BYOK prompt.
func voiceModelHeaders(voiceKey: String, chatProvider: String, chatKey: String, chatModelId: String) -> [String: String] {
    let trimmedVoice = voiceKey.trimmingCharacters(in: .whitespacesAndNewlines)
    let chatIsOpenAi = chatProvider.lowercased() == "openai"
    let key = trimmedVoice.isEmpty
        ? (chatIsOpenAi ? chatKey.trimmingCharacters(in: .whitespacesAndNewlines) : "")
        : trimmedVoice
    guard !key.isEmpty else { return [:] }
    var h: [String: String] = [
        "x-tiny-model-provider": "openai",
        "x-tiny-model-api-key": key,
    ]
    // Carry a realtime model id only on the chat-reuse path (dedicated key → DO default).
    if trimmedVoice.isEmpty, chatIsOpenAi,
       chatModelId.lowercased().contains("realtime") {
        h["x-tiny-model-id"] = chatModelId.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return h
}

/// Loads/stores the selection: non-secret fields in UserDefaults (so
/// @AppStorage sees the same keys), the API key in the Keychain.
enum ModelConfigStore {
    static let keyProvider = "cfg_model_provider"
    static let keyModelId = "cfg_model_id"
    static let keyBaseUrl = "cfg_model_base_url"
    static let keyMaxTokens = "cfg_model_max_tokens"
    static let keyRegion = "cfg_model_region"
    static let keyAdditional = "cfg_model_additional"
    private static let keychainKey = "tiny_model_api_key"
    /// Dedicated OpenAI key for live voice calls (📞) — a SECRET, so Keychain like
    /// the chat key. Independent of the chat provider so voice works while chat runs
    /// on Bedrock/Anthropic/etc. Device-local (not synced), matching the chat key.
    private static let voiceKeychainKey = "tiny_voice_openai_key"

    static func load() -> ModelConfig {
        let d = UserDefaults.standard
        return ModelConfig(
            provider: d.string(forKey: keyProvider) ?? "default",
            apiKey: Keychain.get(keychainKey) ?? "",
            modelId: d.string(forKey: keyModelId) ?? "",
            baseUrl: d.string(forKey: keyBaseUrl) ?? "",
            maxTokens: d.string(forKey: keyMaxTokens) ?? "",
            region: d.string(forKey: keyRegion) ?? "us-west-2",
            additionalFields: d.string(forKey: keyAdditional) ?? "")
    }

    /// The headers for the CURRENT stored selection — what chatStream attaches.
    static func headers() -> [String: String] { load().headers() }

    // ── Dedicated voice-call OpenAI key (Keychain, device-local) ──────────────
    static func loadVoiceKey() -> String { Keychain.get(voiceKeychainKey) ?? "" }
    static func saveVoiceKey(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { Keychain.delete(voiceKeychainKey) }
        else { Keychain.set(voiceKeychainKey, trimmed) }
    }

    /// Headers for a VOICE session — OpenAI-only, dedicated key preferred, else the
    /// chat key iff chat is on OpenAI. See voiceModelHeaders(...).
    static func voiceHeaders() -> [String: String] {
        let cfg = load()
        return voiceModelHeaders(
            voiceKey: loadVoiceKey(),
            chatProvider: cfg.provider,
            chatKey: cfg.apiKey,
            chatModelId: cfg.modelId)
    }

    // ── Cross-device sync (mirrors web saveModelConfigRemote/loadModelConfigRemote) ──
    // The account holds the selection server-side; the api key is encrypted at
    // rest and NEVER returned to any client (only hasKey). This is why chat still
    // works on a fresh device even before hydration: a signed-in request with no
    // x-tiny-model-* headers gets the synced config (incl. the key) applied
    // server-side by app/api/chat/route.ts. Hydration below is cosmetic — it just
    // shows the real provider in Settings.

    /// Push the current selection to the account so other devices inherit it.
    /// `default`/`local`/`webllm` clear the synced row (nothing to carry). The key
    /// is sent ONLY when non-empty — an empty key preserves the server's stored
    /// key (the worker treats an omitted api_key as "keep"), so saving non-key
    /// settings on a hydrated fresh device never wipes the real key. Fire-and-forget.
    static func saveRemote(_ cfg: ModelConfig, token: String?) {
        guard let token else { return }
        var sync: [String: Any]
        if cfg.provider == "default" || cfg.provider == "local" || cfg.provider == "webllm" {
            sync = ["provider": ""]
        } else {
            sync = [
                "provider": cfg.provider,
                "modelId": cfg.modelId,
                "baseUrl": cfg.baseUrl,
                "region": cfg.region,
                "maxTokens": cfg.maxTokens,
                "additionalFields": cfg.additionalFields,
            ]
            if !cfg.apiKey.isEmpty { sync["apiKey"] = cfg.apiKey }
        }
        Task {
            _ = try? await Api.post("/api/model-config", token: token, body: ["config": sync]) as [String: Any]
        }
    }

    /// Fresh-device hydration: pull the account's synced selection (non-secret
    /// fields + hasKey; the key stays server-side) into UserDefaults so @AppStorage
    /// and headers() reflect it. Only hydrates a device still on the free default —
    /// never clobbers a local BYOK selection. Returns whether a config was applied.
    @discardableResult
    static func hydrateFromRemote(token: String?) async -> Bool {
        guard let token else { return false }
        let d = UserDefaults.standard
        guard (d.string(forKey: keyProvider) ?? "default") == "default" else { return false }
        guard let data: [String: Any] = try? await Api.get("/api/model-config", token: token),
              let cfg = data["config"] as? [String: Any],
              let provider = cfg["provider"] as? String, !provider.isEmpty
        else { return false }
        d.set(provider, forKey: keyProvider)
        d.set(cfg["model_id"] as? String ?? "", forKey: keyModelId)
        d.set(cfg["base_url"] as? String ?? "", forKey: keyBaseUrl)
        let maxTokens = (cfg["max_tokens"] as? NSNumber)?.intValue ?? 0
        d.set(maxTokens > 0 ? String(maxTokens) : "", forKey: keyMaxTokens)
        let region = cfg["region"] as? String ?? ""
        d.set(region.isEmpty ? "us-west-2" : region, forKey: keyRegion)
        d.set(cfg["additional_fields"] as? String ?? "", forKey: keyAdditional)
        return true
    }
}

/// The OpenAI Realtime voices a live call can use (mirrors the worker allowlist).
/// "" = unset → calls fall back to the tiny's own voice, then "marin".
let kAccountRealtimeVoices = ["alloy", "ash", "ballad", "coral", "echo",
                              "sage", "shimmer", "verse", "marin", "cedar"]

/// Account-default live-call voice, synced across devices via /api/account-voice.
/// The fallback for tinys with no per-tiny voice (per-tiny → account → marin).
/// Non-secret, so it round-trips in plain JSON (unlike the model api key).
enum AccountVoiceStore {
    /// Fetch the account-default call voice. "" = unset. nil-safe (signed out).
    static func load(token: String?) async -> String {
        guard let token else { return "" }
        guard let data: [String: Any] = try? await Api.get("/api/account-voice", token: token)
        else { return "" }
        return data["voice"] as? String ?? ""
    }

    /// Persist the account-default call voice ("" clears). Fire-and-forget.
    static func save(_ voice: String, token: String?) {
        guard let token else { return }
        Task {
            _ = try? await Api.post("/api/account-voice", token: token, body: ["voice": voice]) as [String: Any]
        }
    }
}
