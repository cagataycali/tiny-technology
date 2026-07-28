"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { listModels, FALLBACKS, type ModelSource } from "@/lib/model-registry";
import { webgpuSupported, WEBLLM_MODELS, searchWebllmModels, type CatalogModel, type CatalogSort } from "@/lib/webllm";
import { freeTierRequestsPhrase } from "@/lib/free-tier";
import {
  normalizeStanding, allowancePhrase, standingDetail, standingNextStep, type Standing,
} from "@/lib/standing";
import { useAuthValue } from "../../lib/chat/use-auth-value";
import { Control } from "./Control";
import TelegramSettings from "./TelegramSettings";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { useRadioGroup } from "../../lib/chat/use-radio-group";

import {
  PROVIDER_PRESETS,
  REALTIME_VOICES,
  MODEL_CONFIG_KEY,
  defaultModelConfig,
  loadModelConfig,
  saveModelConfigRemote,
  loadModelConfigRemote,
  modelConfigHeaders,
  loadAccountVoice,
  saveAccountVoice,
  type ModelConfig,
} from "../../lib/chat/model-config";

// Compat re-exports — the config moved to lib/chat/model-config (pure, no
// panel code) so Chat/Onboarding stop paying for this module at first paint.
export {
  MODEL_CONFIG_KEY, defaultModelConfig, loadModelConfig, modelConfigHeaders,
  saveModelConfigRemote, loadModelConfigRemote, loadAccountVoice,
  saveAccountVoice, REALTIME_VOICES,
};
export type { ModelConfig };

export default function ModelSettings({
  open,
  onClose,
  tinyName,
}: {
  open: boolean;
  onClose: () => void;
  tinyName?: string; // enables the "Your AI" tab (tiny config panel)
}) {
  // Remount on every open: config loads fresh from localStorage in the
  // initial state, tab resets to "model" — no reset effects needed.
  if (!open) return null;
  return <SettingsPanel onClose={onClose} tinyName={tinyName} />;
}

function SettingsPanel({
  onClose,
  tinyName,
}: {
  onClose: () => void;
  tinyName?: string;
}) {
  const [cfg, setCfg] = useState<ModelConfig>(loadModelConfig);
  const [models, setModels] = useState<string[]>([]);
  const [modelSource, setModelSource] = useState<ModelSource>("fallback");
  const [tab, setTab] = useState<"model" | "tiny" | "connect">("model");
  const [showKey, setShowKey] = useState(false);
  // Account-default live-call voice (cross-device). '' = unset → calls fall
  // back to a tiny's own voice, then 'marin'. Hydrated from the account below.
  const [accountVoice, setAccountVoice] = useState("");
  // 🏅 The signed-in caller's own daily allowance (base + what reputation
  // earned). null = signed out, or a server that predates /api/me's `standing`.
  //
  // Reads the shared /api/me probe (no extra request; signed out it resolves
  // {authenticated:false} → null → the deployment-wide phrase). Why it matters:
  // the allowance line below is the only place we quote a number BEFORE the
  // wall, and it quoted the deployment's base — so a builder with standing was
  // told 50 while their window was 250. v6 E4: it was a one-shot mount read, so
  // signing in/out with the panel open left that number stale; useAuthValue
  // re-reads it on `tiny:auth`.
  const standing = useAuthValue<Standing | null>((me) => normalizeStanding((me as any)?.standing));

  // Exit choreography (shared pass-97 pattern) for DISMISSALS; Save/Reset
  // keep the instant onClose — focus follows the action's outcome. The
  // opener-focus cleanup below covers restoration on every path.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose);
  // Roving-tabindex + arrow keys for the on-device model radiogroup (honest
  // keyboard contract for the role="radio" quick-pick below).
  const modelRadio = useRadioGroup(
    WEBLLM_MODELS.map((m) => m.id),
    cfg.modelId || WEBLLM_MODELS[0].id,
    (id) => setCfg({ ...cfg, modelId: id }),
  );

  // Escape closes — the modal had backdrop-click only (keyboard users
  // were stuck with the ✕). Mounted = open, so no gate needed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Focus management (shared overlay pattern): move focus INTO the dialog on
  // open so it's announced and Tab starts inside — otherwise focus stays on
  // the gear trigger, now behind an aria-modal surface the AT treats as inert.
  // On close, hand focus back to the opener (else it falls to <body> and a
  // keyboard user restarts tabbing from the top of the page).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { try { opener?.focus(); } catch { } };
  }, []);
  // Trap Tab inside (WCAG 2.4.3). Mounted only while open; aria-modal marks
  // the page behind inert. The tablist's own arrow-key roving is untouched —
  // the trap only intercepts Tab.
  useFocusTrap(dialogRef, true);

  // 🧠 Fresh-device hydration: if this browser has NO local config (still on
  // the free default), pull the account's synced config so Settings reflects
  // what the server will actually use. Guarded to default-only so we never
  // clobber a device that has its own local BYOK. The raw key never comes
  // back (server holds it encrypted) — hasKey drives the "key stored on your
  // account" hint; requests still work because the server supplies the key.
  useEffect(() => {
    if (loadModelConfig().provider !== "default") return; // local settings win
    let alive = true;
    loadModelConfigRemote().then((remote) => {
      if (!alive || !remote || remote.provider === "default") return;
      setCfg((prev) => (prev.provider === "default" ? { ...prev, ...remote } : prev));
    });
    return () => { alive = false; };
  }, []);

  // 🎙️ Hydrate the account-default call voice (independent of provider — voice
  // calls need an OpenAI key but the voice preference lives on the account).
  useEffect(() => {
    let alive = true;
    loadAccountVoice().then((v) => { if (alive) setAccountVoice(v); });
    return () => { alive = false; };
  }, []);

  // 📋 Live model listing — fetch from the provider's API when possible
  // Generation token: each call bumps it and captures the value; a slow
  // listModels() resolving after a newer call (or provider switch) sees the
  // mismatch and drops its result. Without this, switching provider mid-fetch
  // (OpenAI → Groq) let OpenAI's slower response land last and paint OpenAI's
  // model list + "N live" badge under the Groq selection (WebllmBrowser's
  // effect already guards this way).
  const modelReqRef = useRef(0);
  const refreshModels = useCallback(
    async (force = false) => {
      if (cfg.provider === "default") {
        setModels([]);
        return;
      }
      const req = ++modelReqRef.current;
      setModelSource("loading");
      const { models: list, source } = await listModels(cfg.provider, cfg.apiKey || undefined, {
        region: cfg.region,
        baseUrl: cfg.baseUrl || undefined,
        force,
      });
      if (modelReqRef.current !== req) return; // superseded by a newer request
      setModels(list);
      setModelSource(source);
    },
    [cfg.provider, cfg.apiKey, cfg.region, cfg.baseUrl]
  );

  useEffect(() => {
    // Debounce so we don't fire a request per keystroke while typing the key
    const t = setTimeout(() => refreshModels(), 400);
    return () => clearTimeout(t);
  }, [refreshModels]);

  const preset = PROVIDER_PRESETS[cfg.provider] || PROVIDER_PRESETS.custom;
  // webllm: BYOK UI (model picker etc.) without the key requirement —
  // inference never leaves the browser
  const isLocal = cfg.provider === "webllm";
  const byok = cfg.provider !== "default" && !isLocal;

  const save = () => {
    if (byok && !cfg.apiKey.trim()) {
      toast.error("API key required for this provider");
      return;
    }
    // Custom provider has no preset base URL — without one, modelConfigHeaders
    // sends no base-url header and the server falls back to OpenAI's endpoint,
    // transmitting the user's third-party key to api.openai.com. Require it so
    // the key only ever reaches the endpoint the user actually chose.
    if (cfg.provider === "custom" && !cfg.baseUrl?.trim()) {
      toast.error("Base URL required for a custom provider (e.g. https://api.example.com/v1)");
      return;
    }
    if (isLocal && !webgpuSupported()) {
      toast.error("This browser has no WebGPU — on-device models need Chrome/Edge 113+ or Safari 18+");
      return;
    }
    // Additional fields must be a JSON object — catch typos at save time
    // rather than silently dropping the field at request time.
    if (cfg.additionalFields?.trim()) {
      try {
        const parsed = JSON.parse(cfg.additionalFields);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      } catch {
        toast.error('Additional request fields must be a JSON object, e.g. {"anthropic_beta": ["context-1m-2025-08-07"]}');
        return;
      }
    }
    // Guard the write like every sibling setItem site (Onboarding/ActivityHUD/
    // theme.ts): a QuotaExceededError (Safari Private Browsing, or storage full
    // from large chat_messages_* blobs) would otherwise throw out of the click
    // handler — toast + onClose never run, the modal looks stuck with no signal
    // the save failed.
    try {
      localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify(cfg));
    } catch {
      toast.error("Couldn't save — browser storage is full or blocked");
      return;
    }
    // 🧠 Sync to the account so other devices inherit this config (encrypted
    // key at rest; no-ops when signed out). localStorage above is the instant
    // local truth; this is the cross-device copy.
    saveModelConfigRemote(cfg);
    toast.success(
      isLocal ? "🔒 On-device model — private, offline-capable. First message downloads weights."
        : byok ? "✅ Using your API key (rate limits bypassed)" : "Using default model"
    );
    onClose();
  };

  const reset = () => {
    // removeItem throws SecurityError when site data is fully blocked — the
    // in-memory reset below is what matters, so swallow the storage error.
    try { localStorage.removeItem(MODEL_CONFIG_KEY); } catch { }
    setCfg(defaultModelConfig);
    // Clear the synced row too, or a fresh device would re-pull the old config.
    saveModelConfigRemote(defaultModelConfig);
    toast("Reset to default model");
    onClose();
  };

  const inputStyle = {
    background: "rgba(0,0,0,0.5)",
    border: "1px solid rgba(var(--tiny-accent-rgb),0.2)",
    color: "white",
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={`w-full rounded-2xl p-6 border max-h-[85vh] overflow-y-auto outline-none ${exitClass} ${tab === "tiny" ? "max-w-2xl" : "max-w-md"}`}
        onAnimationEnd={onAnimationEnd}
        style={{
          background: "rgba(10,10,10,0.95)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
          boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2
            className="text-lg font-bold"
            style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}
          >
            Settings
          </h2>
          <button
            onClick={requestClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:scale-105 active:scale-100 transition-all"
            style={{ color: "var(--tiny-accent)" }}
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* Tabs — Model config | Your AI (tiny config) | Connect (Telegram…).
            Full ARIA tabs contract: each tab owns an id + aria-controls to the
            panel, the panel is role="tabpanel" aria-labelledby its tab, and
            ←/→ (with Home/End) rove focus across the tablist (roving tabindex —
            the selected tab is the single tab stop). Without the panel wiring a
            SR announced "tab, selected" with no associated region; without
            arrows the role advertised keyboard nav it didn't have. */}
        {tinyName && (
          <div
            role="tablist"
            aria-label="Settings sections"
            className="flex gap-1 mb-5 p-1 rounded-lg"
            style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(var(--tiny-accent-rgb),0.15)" }}
            onKeyDown={(e) => {
              const keys = ["model", "tiny", "connect"] as const;
              const cur = keys.indexOf(tab);
              let next = -1;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % keys.length;
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + keys.length) % keys.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = keys.length - 1;
              if (next === -1) return;
              e.preventDefault();
              setTab(keys[next]);
              (e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))[next]?.focus();
            }}
          >
            {([["model", "Model"], ["tiny", "Your AI"], ["connect", "Connect"]] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                id={`settings-tab-${key}`}
                aria-selected={tab === key}
                aria-controls="settings-tabpanel"
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
                className="flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-all hover:text-white"
                style={
                  tab === key
                    ? { background: "rgba(var(--tiny-accent-rgb),0.15)", color: "var(--tiny-accent)" }
                    : { background: "transparent", color: "rgba(255,255,255,0.5)" }
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* One panel region (only the active tab's content mounts). It's
            labelled by whichever tab is live; tinyName gates the tablist, so
            with no tinyName this is just the model config with no aria-* noise. */}
        <div
          {...(tinyName ? { role: "tabpanel", id: "settings-tabpanel", "aria-labelledby": `settings-tab-${tab}` } : {})}
        >
        {tab === "connect" && tinyName ? (
          <TelegramSettings tinyName={tinyName} />
        ) : tab === "tiny" && tinyName ? (
          <Control name={tinyName} compact />
        ) : (
        <>
        <div className="space-y-4">
          <div>
            <label htmlFor="model-provider" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
              Provider
            </label>
            <select
              id="model-provider"
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
              value={cfg.provider}
              onChange={(e) => {
                const provider = e.target.value;
                setCfg({
                  ...cfg,
                  provider,
                  baseUrl: PROVIDER_PRESETS[provider]?.baseUrl || "",
                });
              }}
            >
              {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          {isLocal && (
            <div className="rounded-lg px-3 py-2.5 text-xs leading-relaxed" style={{
              background: "rgba(var(--tiny-accent-rgb),0.06)",
              border: "1px solid rgba(var(--tiny-accent-rgb),0.2)",
              color: "#aaa",
            }}>
              🔒 Runs entirely in your browser via WebGPU — private, free, works offline
              after the one-time model download. Latest small models included: Qwen3.5,
              Qwen3, Gemma 3, Llama 3.2, Phi-4 — or browse the full catalog below.
              Plain chat only: no tools, web access, or sub-agents.
              {!webgpuSupported() && (
                <span className="block mt-1 text-red-400">⚠️ This browser has no WebGPU — try Chrome/Edge 113+ or Safari 18+.</span>
              )}
            </div>
          )}
          {isLocal && (
            <div>
              <label className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                Model
              </label>
              {/* Single-select quick-pick → radiogroup (mirrors Onboarding's
                  model picker + this dialog's BYOK provider grammar); plain
                  aria-pressed buttons would read as independent toggles. */}
              <div role="radiogroup" aria-label="On-device model" onKeyDown={modelRadio.onKeyDown} className="rounded-lg border overflow-hidden" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
                {WEBLLM_MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={(cfg.modelId || WEBLLM_MODELS[0].id) === m.id}
                    tabIndex={modelRadio.tabIndex(m.id)}
                    onClick={() => setCfg({ ...cfg, modelId: m.id })}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5 flex justify-between items-center"
                    style={{
                      color: (cfg.modelId || WEBLLM_MODELS[0].id) === m.id ? "var(--tiny-accent)" : "rgba(255,255,255,0.7)",
                      background: (cfg.modelId || WEBLLM_MODELS[0].id) === m.id ? "rgba(var(--tiny-accent-rgb),0.08)" : "transparent",
                    }}
                  >
                    <span>{m.label}</span>
                    <span className="opacity-50 font-mono">{m.size}</span>
                  </button>
                ))}
              </div>
              <WebllmBrowser
                selected={cfg.modelId || WEBLLM_MODELS[0].id}
                onPick={(id) => setCfg({ ...cfg, modelId: id })}
              />
            </div>
          )}

          {byok && (
            <>
              <div>
                <label htmlFor="byok-api-key" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                  API Key
                </label>
                <div className="relative">
                  <input
                    id="byok-api-key"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg px-3 py-2 pr-16 text-sm outline-none"
                    style={inputStyle}
                    placeholder={preset.keyPlaceholder}
                    value={cfg.apiKey}
                    onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                  />
                  {/* Reveal toggle — pasting a key blind makes typos
                      undiscoverable (the only feedback is a provider 401) */}
                  {cfg.apiKey && (
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      aria-pressed={showKey}
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded border transition-colors hover:bg-white/10"
                      style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.25)", color: "var(--tiny-accent)" }}
                    >
                      {showKey ? "hide" : "show"}
                    </button>
                  )}
                </div>
                <p className="text-[11px] mt-1 opacity-40">
                  Stored only in your browser (localStorage). Sent directly per
                  request, never persisted server-side.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="model-id" className="block text-xs uppercase tracking-wider opacity-60">
                    Model
                  </label>
                  <div className="flex items-center gap-2">
                    <span
                      // Announce the count when a refresh / provider switch
                      // resolves — otherwise "N live" swaps in and the whole
                      // model list changes silently for a SR user who just
                      // pressed Refresh. The badge is the right granularity
                      // (announcing all 100 model buttons would be noise).
                      role="status"
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={
                        modelSource === "api"
                          ? { background: "rgba(var(--tiny-accent-rgb),0.15)", color: "var(--tiny-accent)" }
                          : modelSource === "cache"
                          ? { background: "rgba(0,150,255,0.15)", color: "#66bbff" }
                          : modelSource === "loading"
                          ? { background: "rgba(255,255,255,0.1)", color: "#888" }
                          : { background: "rgba(255,180,0,0.15)", color: "#ffb400" }
                      }
                      title="Where this model list came from"
                    >
                      {modelSource === "api"
                        ? `${models.length} live`
                        : modelSource === "cache"
                        ? `${models.length} cached`
                        : modelSource === "loading"
                        ? "loading…"
                        : "fallback"}
                    </span>
                    <button
                      type="button"
                      onClick={() => refreshModels(true)}
                      disabled={modelSource === "loading"}
                      className="text-xs transition-colors hover:opacity-80 disabled:opacity-50"
                      style={{ color: "var(--tiny-accent)" }}
                      title="Refresh model list from the provider API"
                      aria-label="Refresh model list"
                    >
                      {/* Standardized glyph ↻ + spin-while-loading, matching the
                          JobsPanel/MemoryPanel/Control refresh grammar (was a
                          lone ⟳ that scaled on hover instead of spinning). */}
                      <span className={modelSource === "loading" ? "inline-block animate-spin" : "inline-block"} aria-hidden="true">↻</span>
                    </button>
                  </div>
                </div>
                <input
                  id="model-id"
                  type="text"
                  list="tiny-model-suggestions"
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none font-mono"
                  style={inputStyle}
                  placeholder={models[0] || preset.modelPlaceholder}
                  value={cfg.modelId}
                  onChange={(e) => setCfg({ ...cfg, modelId: e.target.value })}
                />
                <datalist id="tiny-model-suggestions">
                  {(models.length ? models : FALLBACKS[cfg.provider] || []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {models.length > 0 && (
                  <div className="mt-2 max-h-36 overflow-y-auto rounded-lg border" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
                    {models.slice(0, 100).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setCfg({ ...cfg, modelId: m })}
                        className="w-full text-left px-3 py-1.5 text-xs font-mono transition-colors hover:bg-white/5"
                        style={{
                          color: cfg.modelId === m ? "var(--tiny-accent)" : "rgba(255,255,255,0.7)",
                          background: cfg.modelId === m ? "rgba(var(--tiny-accent-rgb),0.08)" : "transparent",
                        }}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {cfg.provider === "bedrock" && (
                <div>
                  <label htmlFor="model-region" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                    Region
                  </label>
                  <select
                    id="model-region"
                    className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                    style={inputStyle}
                    value={cfg.region || "us-west-2"}
                    onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
                  >
                    {["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1", "ap-southeast-2"].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <p className="text-[11px] mt-1 opacity-40">
                    Bearer-token API key — no AWS SigV4 needed. Generate at Bedrock Console → API keys.
                  </p>
                </div>
              )}

              {(cfg.provider === "custom" || cfg.baseUrl) && (
                <div>
                  <label htmlFor="model-base-url" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                    Base URL
                  </label>
                  <input
                    id="model-base-url"
                    type="text"
                    className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                    style={inputStyle}
                    placeholder="https://api.example.com/v1"
                    value={cfg.baseUrl}
                    onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                  />
                </div>
              )}

              <div>
                <label htmlFor="model-max-tokens" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                  Max Tokens (optional)
                </label>
                <input
                  id="model-max-tokens"
                  type="number"
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={inputStyle}
                  placeholder="8192"
                  value={cfg.maxTokens}
                  onChange={(e) => setCfg({ ...cfg, maxTokens: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="model-additional-fields" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
                  Additional Request Fields (optional, JSON)
                </label>
                <textarea
                  id="model-additional-fields"
                  rows={2}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none font-mono"
                  style={inputStyle}
                  spellCheck={false}
                  placeholder='{"anthropic_beta": ["context-1m-2025-08-07"]}'
                  value={cfg.additionalFields || ""}
                  onChange={(e) => setCfg({ ...cfg, additionalFields: e.target.value })}
                />
                <p className="text-[11px] mt-1 opacity-40">
                  Provider-specific extras sent with every request.
                  {cfg.provider === "bedrock"
                    ? " Bedrock Claude: the example above unlocks the 1M-token context window."
                    : " Merged into the request body (e.g. beta flags, reasoning options)."}
                </p>
              </div>
            </>
          )}

          {!byok && (
            <p className="text-xs opacity-50 leading-relaxed">
              Using Tiny&apos;s default model — free but limited to{" "}
              {/* 🏅 The caller's OWN window when we know it. `freeTierRequestsPhrase()`
                  is the deployment's base and knows nothing about who's asking, so a
                  builder with 40 points read "50 requests a day" while their limit was
                  250 — a correct number under a label naming something else, on the one
                  screen that explains the free tier. Signed out (standing === null) it
                  is still exactly right: the window IS the base, IP-keyed and shared. */}
              {standing ? allowancePhrase(standing) : freeTierRequestsPhrase()}
              {standing && standingDetail(standing) ? ` — ${standingDetail(standing)}` : "."}{" "}
              Bring your own API key to bypass rate limits and pick any model.
              {/* What earning more is worth, and nothing at all once the bonus is
                  capped: dangling a spent lever is worse than silence (same rule the
                  429 follows — lib/limit-message.ts). */}
              {standing && standingNextStep(standing) ? ` ${standingNextStep(standing)}` : ""}
            </p>
          )}

          {/* 🎙️ Account-default live-call voice — the OpenAI Realtime voice used
              on 📞 calls to any tiny that hasn't set its own. Separate from the
              per-tiny voice (Your AI tab) and the on-device TTS. Applies across
              all your devices. */}
          <div className="pt-2 border-t" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.12)" }}>
            <label htmlFor="account-voice" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
              📞 Live-call voice
            </label>
            <select
              id="account-voice"
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
              value={accountVoice}
              onChange={(e) => {
                const v = e.target.value;
                setAccountVoice(v);
                saveAccountVoice(v);
                toast.success(v ? `📞 Calls default to ${v}` : "📞 Calls use each tiny's own voice");
              }}
            >
              <option value="">Default (each tiny's own, else marin)</option>
              {REALTIME_VOICES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <p className="text-[11px] mt-1 opacity-40 leading-relaxed">
              Your default voice for live calls (📞), synced across devices. A
              tiny that sets its own voice (its owner, in the Your AI tab) still
              wins. Live calls need an OpenAI key above.
            </p>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={save}
            className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-100"
            style={{
              background: "rgba(var(--tiny-accent-rgb),0.15)",
              border: "1px solid rgba(var(--tiny-accent-rgb),0.4)",
              color: "var(--tiny-accent)",
            }}
          >
            Save
          </button>
          <button
            onClick={reset}
            className="rounded-lg px-4 py-2 text-sm transition-all hover:scale-[1.02] active:scale-100"
            style={{
              background: "rgba(0,0,0,0.5)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Reset
          </button>
        </div>
        </>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * 🔎 WebLLM catalog browser — the full runnable model list (this web-llm
 * version's prebuiltAppConfig, ~160 models: Qwen3/3.5, Gemma, Llama 3.2,
 * Phi-4, DeepSeek-R1 distills…) joined with HuggingFace popularity, so
 * people can pick by downloads/likes instead of trusting our shortlist.
 * Collapsed by default; loads catalog + stats on first expand.
 */
function WebllmBrowser({ selected, onPick }: { selected: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<CatalogSort>("downloads");
  // null renders as loading — no sync setState in the effect body; rows
  // only ever transition inside the debounce callback
  const [rows, setRows] = useState<CatalogModel[] | "error" | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    // Debounce keystrokes; catalog+stats are module-cached after first load
    const t = setTimeout(() => {
      searchWebllmModels(q, sort)
        .then((models) => { if (!stale) setRows(models); })
        .catch(() => { if (!stale) setRows("error"); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [open, q, sort]);

  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-[11px] transition-colors hover:opacity-80"
        style={{ color: "rgba(var(--tiny-accent-rgb),0.8)" }}
      >
        {open ? "▾ browse all models" : "▸ browse all models (Qwen3, Gemma, Phi-4, DeepSeek…)"}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border overflow-hidden" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
          <div className="flex gap-1.5 p-2 border-b" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.1)" }}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search — qwen3, gemma, coder, deepseek…"
              aria-label="Search on-device models"
              className="flex-1 rounded-md px-2 py-1 text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(var(--tiny-accent-rgb),0.2)", color: "#fff" }}
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CatalogSort)}
              aria-label="Sort models by"
              className="rounded-md px-1.5 py-1 text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(var(--tiny-accent-rgb),0.2)", color: "rgba(255,255,255,0.8)" }}
            >
              <option value="downloads">↓ downloads</option>
              <option value="likes">♥ likes</option>
              <option value="size">size</option>
            </select>
          </div>
          <div className="max-h-52 overflow-y-auto" aria-live="polite">
            {rows === null ? (
              <div role="status" className="px-3 py-4 text-xs text-center opacity-40 text-white">Loading catalog + HuggingFace stats…</div>
            ) : rows === "error" ? (
              <div role="alert" className="px-3 py-4 text-xs text-center opacity-60 text-red-400">Couldn&apos;t load the catalog — check your connection and reopen.</div>
            ) : rows.length === 0 ? (
              <div role="status" className="px-3 py-4 text-xs text-center opacity-40 text-white">No models match &quot;{q}&quot;</div>
            ) : (
              rows.slice(0, 60).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onPick(m.id)}
                  className="w-full text-left px-3 py-1.5 text-[11px] transition-colors hover:bg-white/5 flex items-center gap-2"
                  style={{
                    color: selected === m.id ? "var(--tiny-accent)" : "rgba(255,255,255,0.75)",
                    background: selected === m.id ? "rgba(var(--tiny-accent-rgb),0.08)" : "transparent",
                  }}
                >
                  <span className="flex-1 truncate font-mono">{m.id.replace(/-MLC$/, "")}</span>
                  {/* VRAM is the honest "will it run" number (weights + KV cache) */}
                  <span className="opacity-50 whitespace-nowrap">{gb(m.vramMB)}</span>
                  <span className="opacity-40 whitespace-nowrap w-12 text-right">↓{fmt(m.downloads)}</span>
                  {m.likes > 0 && <span className="opacity-40 whitespace-nowrap">♥{fmt(m.likes)}</span>}
                </button>
              ))
            )}
          </div>
          <div className="px-3 py-1.5 text-[10px] opacity-40 text-white border-t" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.1)" }}>
            VRAM = memory needed to run · stats from huggingface.co/mlc-ai
          </div>
        </div>
      )}
    </div>
  );
}
