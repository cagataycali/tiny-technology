package technology.tiny.app.net

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * BYO-model configuration — the native port of web components/chat/ModelSettings.tsx.
 * Bring-your-own-key providers let the user bypass the free tier's rate limits and
 * pick any model; the config rides the /api/chat request as `x-tiny-model-*` headers
 * (server reads them per-request, never persists them). WebLLM/WebGPU (on-device
 * inference) is browser-only and deliberately NOT ported — no native equivalent.
 *
 * The API key is a SECRET, so this lives in EncryptedSharedPreferences (Keystore
 * master key), same store discipline as the auth JWT — never plain cfg prefs.
 */
class ModelConfigStore(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "tiny_model",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var provider: String
        get() = prefs.getString("provider", "default") ?: "default"
        set(v) = prefs.edit().putString("provider", v).apply()

    var apiKey: String
        get() = prefs.getString("api_key", "") ?: ""
        set(v) = prefs.edit().putString("api_key", v).apply()

    var modelId: String
        get() = prefs.getString("model_id", "") ?: ""
        set(v) = prefs.edit().putString("model_id", v).apply()

    var baseUrl: String
        get() = prefs.getString("base_url", "") ?: ""
        set(v) = prefs.edit().putString("base_url", v).apply()

    var maxTokens: String
        get() = prefs.getString("max_tokens", "") ?: ""
        set(v) = prefs.edit().putString("max_tokens", v).apply()

    var region: String
        get() = prefs.getString("region", "us-west-2") ?: "us-west-2"
        set(v) = prefs.edit().putString("region", v).apply()

    var additionalFields: String
        get() = prefs.getString("additional_fields", "") ?: ""
        set(v) = prefs.edit().putString("additional_fields", v).apply()

    /**
     * Dedicated OpenAI key for live voice calls (📞). Voice (speech-to-speech) is
     * OpenAI-ONLY and independent of the chat provider selection above — a user who
     * runs chat on Bedrock/Anthropic/etc. would otherwise have no way to enable voice
     * without abandoning their chat setup. Device-local (not synced) like the chat key.
     */
    var voiceOpenAiKey: String
        get() = prefs.getString("voice_openai_key", "") ?: ""
        set(v) = prefs.edit().putString("voice_openai_key", v).apply()

    /** Reset to the free default model (web reset()). */
    fun reset() {
        prefs.edit().clear().apply()
    }

    // ── Account-default live-call voice (cross-device, /api/account-voice) ──────
    // The fallback for tinys with no per-tiny voice (per-tiny → account → marin).
    // Non-secret + account-scoped, so it's NOT cached in prefs — read/written live.

    /** Fetch the account-default call voice. "" = unset. Best-effort (signed out → ""). */
    suspend fun loadAccountVoice(api: TinyApi): String {
        val res = runCatching { api.getJson("/api/account-voice") }.getOrNull() ?: return ""
        return res.optString("voice", "")
    }

    /** Persist the account-default call voice ("" clears). Best-effort. */
    suspend fun saveAccountVoice(api: TinyApi, voice: String) {
        runCatching { api.postJson("/api/account-voice", JSONObject().put("voice", voice)) }
    }

    // ── Cross-device sync (mirrors web saveModelConfigRemote/loadModelConfigRemote) ──
    // The account holds the selection server-side; the api key is encrypted at rest
    // and NEVER returned to any client (only hasKey). Cross-device chat works even
    // before hydration because a signed-in request with no x-tiny-model-* headers
    // gets the synced config (incl. the key) applied server-side by
    // app/api/chat/route.ts — hydrate() below is cosmetic (shows the real provider).

    /**
     * Push the current selection to the account so other devices inherit it.
     * `default` clears the synced row (nothing to carry). The key is sent ONLY when
     * non-empty — an omitted api_key preserves the server's stored key (worker
     * "omit = keep"), so saving non-key settings never wipes the real key. Best-effort.
     */
    suspend fun saveRemote(api: TinyApi) {
        val cfg = JSONObject()
        if (provider == "default") {
            cfg.put("provider", "")
        } else {
            cfg.put("provider", provider)
            cfg.put("modelId", modelId)
            cfg.put("baseUrl", baseUrl)
            cfg.put("region", region)
            cfg.put("maxTokens", maxTokens)
            cfg.put("additionalFields", additionalFields)
            if (apiKey.isNotEmpty()) cfg.put("apiKey", apiKey)
        }
        runCatching { api.postJson("/api/model-config", JSONObject().put("config", cfg)) }
    }

    /**
     * Fresh-device hydration: pull the account's synced selection (non-secret fields
     * + hasKey; the key stays server-side) into the store so headers() and the UI
     * reflect it. Only hydrates a device still on the free default — never clobbers
     * a local BYOK selection. Returns whether a config was applied. Best-effort.
     */
    suspend fun hydrateFromRemote(api: TinyApi): Boolean {
        if (provider != "default") return false
        val res = runCatching { api.getJson("/api/model-config") }.getOrNull() ?: return false
        val cfg = res.optJSONObject("config") ?: return false
        val p = cfg.optString("provider")
        if (p.isEmpty()) return false
        provider = p
        modelId = cfg.optString("model_id", "")
        baseUrl = cfg.optString("base_url", "")
        val mt = cfg.optInt("max_tokens", 0)
        maxTokens = if (mt > 0) mt.toString() else ""
        region = cfg.optString("region", "").ifEmpty { "us-west-2" }
        additionalFields = cfg.optString("additional_fields", "")
        return true
    }

    /**
     * The `x-tiny-model-*` headers for a chat request — a Kotlin port of web's
     * modelConfigHeaders(). Empty map when on the default (free) tier, so the
     * server uses its own model. Carries web's security guards verbatim:
     *  - only emit when a non-default provider AND a key are set;
     *  - a `custom` provider with NO base URL emits NOTHING — otherwise the key
     *    would be sent to OpenAI's default endpoint server-side (wrong origin,
     *    key leak). Fall back to the free default rather than leak the key.
     *  - additional-fields must parse to a non-empty JSON object; strip anything
     *    else (a malformed value is silently dropped, matching web).
     */
    fun headers(): Map<String, String> = buildHeaders(
        provider = provider,
        apiKey = apiKey,
        modelId = modelId,
        baseUrl = baseUrl,
        maxTokens = maxTokens,
        region = region,
        additionalFields = additionalFields,
    )

    /**
     * The `x-tiny-model-*` headers for a voice-call session (/api/voice/session).
     * Voice is OpenAI-ONLY, so this ALWAYS emits an `openai` provider — never the
     * chat provider (a Bedrock/Anthropic chat key can't drive OpenAI's realtime API).
     * The dedicated voiceOpenAiKey wins; if it's blank but chat already runs on
     * OpenAI, reuse that key so the single-key user isn't asked twice. Empty map
     * when neither is available → the route returns the actionable BYOK prompt.
     */
    fun voiceHeaders(): Map<String, String> = buildVoiceHeaders(
        voiceKey = voiceOpenAiKey,
        chatProvider = provider,
        chatKey = apiKey,
        chatModelId = modelId,
    )

    data class Preset(
        val label: String,
        val baseUrl: String,
        val modelPlaceholder: String,
        val keyPlaceholder: String,
    )

    companion object {
        /**
         * The `x-tiny-model-*` headers for a chat request — a pure Kotlin port of
         * web's modelConfigHeaders(), extracted from headers() so it's unit-testable
         * without EncryptedSharedPreferences. Empty map when on the default (free)
         * tier, so the server uses its own model. Carries web's security guards:
         *  - only emit when a non-default provider AND a key are set;
         *  - a `custom` provider with NO base URL emits NOTHING — otherwise the key
         *    would be sent to OpenAI's default endpoint server-side (wrong origin,
         *    key leak). Fall back to the free default rather than leak the key.
         *  - additional-fields must parse to a non-empty JSON object; strip anything
         *    else (a malformed value is silently dropped, matching web).
         */
        fun buildHeaders(
            provider: String,
            apiKey: String,
            modelId: String,
            baseUrl: String,
            maxTokens: String,
            region: String,
            additionalFields: String,
        ): Map<String, String> {
            if (provider == "default" || apiKey.isEmpty()) return emptyMap()
            val resolvedBase = baseUrl.ifEmpty { PROVIDER_PRESETS[provider]?.baseUrl ?: "" }
            if (provider == "custom" && resolvedBase.isEmpty()) return emptyMap()

            val h = LinkedHashMap<String, String>()
            h["x-tiny-model-provider"] = provider
            h["x-tiny-model-api-key"] = apiKey
            if (modelId.isNotEmpty()) h["x-tiny-model-id"] = modelId
            if (resolvedBase.isNotEmpty()) h["x-tiny-model-base-url"] = resolvedBase
            if (maxTokens.isNotEmpty()) h["x-tiny-model-max-tokens"] = maxTokens
            if (provider == "bedrock" && region.isNotEmpty()) h["x-tiny-model-region"] = region
            // Only emit a valid, non-empty JSON object; HTTP headers are single-line
            // so re-serialize (JSONObject.toString drops newlines) — matches web.
            val extra = additionalFields.trim()
            if (extra.isNotEmpty()) {
                runCatching { JSONObject(extra) }.getOrNull()?.let { obj ->
                    if (obj.length() > 0) h["x-tiny-model-additional-fields"] = obj.toString()
                }
            }
            return h
        }

        /**
         * The `x-tiny-model-*` headers for a voice session — pure, unit-testable half
         * of voiceHeaders(). Voice is OpenAI-ONLY: the server's resolveOpenAIKey gates
         * on `provider === 'openai'`, so we NEVER forward a Bedrock/Anthropic chat key.
         * Precedence: the dedicated voice key first; else the chat key ONLY when chat
         * itself is on OpenAI (single-key convenience). Empty map when neither exists.
         * A realtime model id is passed through only when chat is OpenAI+realtime;
         * otherwise the DO's default realtime model is right.
         */
        fun buildVoiceHeaders(
            voiceKey: String,
            chatProvider: String,
            chatKey: String,
            chatModelId: String,
        ): Map<String, String> {
            val key = voiceKey.trim().ifEmpty {
                if (chatProvider.equals("openai", true)) chatKey.trim() else ""
            }
            if (key.isEmpty()) return emptyMap()
            val h = LinkedHashMap<String, String>()
            h["x-tiny-model-provider"] = "openai"
            h["x-tiny-model-api-key"] = key
            // Only carry a model id when it's a realtime one from an OpenAI chat config
            // (the route ignores non-realtime ids anyway); the dedicated-key path leaves
            // model to the DO default.
            if (voiceKey.trim().isEmpty() && chatProvider.equals("openai", true) &&
                chatModelId.contains("realtime", true)
            ) {
                h["x-tiny-model-id"] = chatModelId.trim()
            }
            return h
        }

        /**
         * Provider presets mirroring web PROVIDER_PRESETS, minus `webllm` (browser
         * on-device inference — no native path). Order = the UI dropdown order.
         */
        val PROVIDER_PRESETS: Map<String, Preset> = linkedMapOf(
            "default" to Preset("Tiny (free, rate-limited)", "", "gpt-5.6-luna", "No key needed"),
            "openai" to Preset("OpenAI", "", "gpt-5-mini-2025-08-07", "sk-..."),
            "anthropic" to Preset("Anthropic", "https://api.anthropic.com/v1/", "claude-sonnet-4-5", "sk-ant-..."),
            // No base URL — Bedrock routes through ConverseStream server-side.
            "bedrock" to Preset("Amazon Bedrock (API key)", "", "global.anthropic.claude-opus-4-8", "bedrock-api-key..."),
            "openrouter" to Preset("OpenRouter", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4.5", "sk-or-..."),
            "groq" to Preset("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "gsk_..."),
            "deepseek" to Preset("DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat", "sk-..."),
            "mistral" to Preset("Mistral", "https://api.mistral.ai/v1", "mistral-large-latest", "..."),
            "xai" to Preset("xAI (Grok)", "https://api.x.ai/v1", "grok-2-latest", "xai-..."),
            "perplexity" to Preset("Perplexity", "https://api.perplexity.ai", "sonar-pro", "pplx-..."),
            "gemini" to Preset("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-2.5-flash", "AIzaSy..."),
            "custom" to Preset("Custom (OpenAI-compatible)", "", "model-id", "api-key"),
        )

        val BEDROCK_REGIONS = listOf(
            "us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1", "ap-southeast-2",
        )
    }
}
