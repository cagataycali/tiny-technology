/**
 * Model config — the pure half of ModelSettings (types, presets, localStorage
 * load/save, request headers, account sync). Extracted so Chat.tsx and
 * Onboarding can use the CONFIG without statically pulling the 1,000-line
 * settings PANEL (plus Control + TelegramSettings) into the first-paint
 * bundle — ModelSettings itself is now loaded via next/dynamic.
 * ModelSettings re-exports everything here for compat (tests import through
 * it); new code imports this module directly.
 */
export type ModelConfig = {
  provider: string;
  apiKey: string;
  modelId: string;
  baseUrl: string;
  maxTokens: string;
  region?: string;
  /** Provider-specific request fields as a JSON object string — e.g.
   *  Bedrock 1M context: {"anthropic_beta": ["context-1m-2025-08-07"]} */
  additionalFields?: string;
};

export const MODEL_CONFIG_KEY = "tiny_model_config";

export const defaultModelConfig: ModelConfig = {
  provider: "default",
  apiKey: "",
  modelId: "",
  baseUrl: "",
  maxTokens: "",
  region: "us-west-2",
  additionalFields: "",
};

export const PROVIDER_PRESETS: Record<
  string,
  { label: string; baseUrl: string; modelPlaceholder: string; keyPlaceholder: string }
> = {
  default: {
    label: "Tiny (free, rate-limited)",
    baseUrl: "",
    modelPlaceholder: "gpt-5.6-luna",
    keyPlaceholder: "No key needed",
  },
  webllm: {
    label: "🔒 On-device (WebLLM, offline)",
    baseUrl: "",
    modelPlaceholder: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    keyPlaceholder: "No key — runs in your browser via WebGPU",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "",
    modelPlaceholder: "gpt-5-mini-2025-08-07",
    keyPlaceholder: "sk-...",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1/",
    modelPlaceholder: "claude-sonnet-4-5",
    keyPlaceholder: "sk-ant-...",
  },
  bedrock: {
    label: "Amazon Bedrock (API key)",
    // No base URL — Bedrock goes through the edge-safe ConverseStream model
    // server-side (Claude models are NOT on Bedrock's /openai/v1 endpoint).
    baseUrl: "",
    modelPlaceholder: "global.anthropic.claude-opus-4-8",
    keyPlaceholder: "bedrock-api-key... (Console → Bedrock → API keys)",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
    keyPlaceholder: "sk-or-...",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelPlaceholder: "llama-3.3-70b-versatile",
    keyPlaceholder: "gsk_...",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelPlaceholder: "deepseek-chat",
    keyPlaceholder: "sk-...",
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    modelPlaceholder: "mistral-large-latest",
    keyPlaceholder: "...",
  },
  xai: {
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    modelPlaceholder: "grok-2-latest",
    keyPlaceholder: "xai-...",
  },
  perplexity: {
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    modelPlaceholder: "sonar-pro",
    keyPlaceholder: "pplx-...",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    modelPlaceholder: "gemini-2.5-flash",
    keyPlaceholder: "AIzaSy...",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    modelPlaceholder: "model-id",
    keyPlaceholder: "api-key",
  },
};

/** OpenAI Realtime voices a live call can use (mirrors the worker allowlist).
 *  '' = unset → calls fall back to the tiny's own voice, then 'marin'. */
export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

/** Read the account-default call voice (cross-device). '' = unset. */
export async function loadAccountVoice(): Promise<string> {
  try {
    const res = await fetch("/api/account-voice");
    if (!res.ok) return "";
    const data = await res.json();
    return String(data?.voice || "");
  } catch { return ""; }
}

/** Persist the account-default call voice. Fire-and-forget; no-ops signed out. */
export function saveAccountVoice(voice: string): void {
  try {
    fetch("/api/account-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice }),
    }).catch(() => {});
  } catch {}
}

export function loadModelConfig(): ModelConfig {
  if (typeof window === "undefined") return defaultModelConfig;
  try {
    const raw = localStorage.getItem(MODEL_CONFIG_KEY);
    if (raw) {
      const cfg = { ...defaultModelConfig, ...JSON.parse(raw) };
      // Migrate stale configs: Bedrock no longer uses the /openai/v1 compat
      // endpoint (Claude models aren't served there) — server routes it via
      // ConverseStream instead.
      if (cfg.provider === "bedrock" && cfg.baseUrl?.includes("/openai/v1")) {
        cfg.baseUrl = "";
      }
      return cfg;
    }
  } catch {}
  return defaultModelConfig;
}

/**
 * 🧠 Cross-device sync (mirrors theme.ts saveThemeRemote). localStorage stays
 * the primary/instant store; this pushes a copy to the account so a fresh
 * device pulls the config instead of falling back to the free default. Signed
 * out → the bridge 401s and we silently no-op. Fire-and-forget.
 *
 * The apiKey is INCLUDED here (it's how another device gets a usable key) but
 * the server encrypts it at rest and NEVER returns it to any client — the GET
 * side only ever exposes hasKey. WebLLM ('local') is device-bound, so it's not
 * synced (it'd be meaningless on a device without that downloaded weight).
 */
export function saveModelConfigRemote(cfg: ModelConfig): void {
  try {
    // provider 'default'/'local' → clear the synced row (nothing to carry).
    const sync: Record<string, unknown> = (cfg.provider === "default" || cfg.provider === "local" || cfg.provider === "webllm")
      ? { provider: "" }
      : {
          provider: cfg.provider,
          modelId: cfg.modelId,
          baseUrl: cfg.baseUrl,
          region: cfg.region,
          maxTokens: cfg.maxTokens,
          additionalFields: cfg.additionalFields,
        };
    // Only send the key when the user actually entered one. An empty key on a
    // synced-config save (e.g. saving after fresh-device hydration, where the
    // key never came back down) must PRESERVE the server's stored key, not
    // clear it — so omit the field entirely (the worker keeps it on omit).
    if (cfg.provider !== "default" && cfg.provider !== "local" && cfg.provider !== "webllm" && cfg.apiKey) {
      sync.apiKey = cfg.apiKey;
    }
    fetch("/api/model-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: sync }),
    }).catch(() => {});
  } catch {}
}

/**
 * Pull the account's synced config for a fresh device. Returns the non-secret
 * fields + hasKey (the raw key never leaves the server). null if signed out /
 * none set. The caller merges this into localStorage so subsequent loads and
 * the request headers work; when hasKey is true but no key is present locally,
 * the SERVER supplies the key from its encrypted store (no header needed).
 */
export async function loadModelConfigRemote(): Promise<(ModelConfig & { hasKey?: boolean }) | null> {
  try {
    const res = await fetch("/api/model-config");
    if (!res.ok) return null;
    const data = await res.json();
    const c = data?.config;
    if (!c?.provider) return null;
    return {
      provider: c.provider,
      apiKey: "", // never returned — the server holds it encrypted
      modelId: c.model_id || "",
      baseUrl: c.base_url || "",
      maxTokens: c.max_tokens ? String(c.max_tokens) : "",
      region: c.region || "us-west-2",
      additionalFields: c.additional_fields || "",
      hasKey: Boolean(c.hasKey),
    };
  } catch {}
  return null;
}

export function modelConfigHeaders(cfg: ModelConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (cfg.provider !== "default" && cfg.apiKey) {
    const baseUrl = cfg.baseUrl || PROVIDER_PRESETS[cfg.provider]?.baseUrl || "";
    // A custom provider with no base URL would send the key to OpenAI's
    // default endpoint server-side (wrong origin). Don't emit the key at all
    // in that case — fall back to the free default rather than leak it. This
    // backstops the save() guard against a hand-edited localStorage config.
    if (cfg.provider === "custom" && !baseUrl) return h;
    h["x-tiny-model-provider"] = cfg.provider;
    h["x-tiny-model-api-key"] = cfg.apiKey;
    if (cfg.modelId) h["x-tiny-model-id"] = cfg.modelId;
    if (baseUrl) h["x-tiny-model-base-url"] = baseUrl;
    if (cfg.maxTokens) h["x-tiny-model-max-tokens"] = cfg.maxTokens;
    if (cfg.provider === "bedrock" && cfg.region) h["x-tiny-model-region"] = cfg.region;
    // Only emit valid JSON objects — a malformed value would 400 nothing
    // (the server ignores bad JSON) but there's no point sending it. Strip
    // newlines: HTTP headers must be single-line.
    if (cfg.additionalFields?.trim()) {
      try {
        const parsed = JSON.parse(cfg.additionalFields);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length) {
          h["x-tiny-model-additional-fields"] = JSON.stringify(parsed);
        }
      } catch { /* invalid JSON — save() blocks this, but guard hand-edited configs */ }
    }
  }
  return h;
}
