"use client";

/**
 * 🚪 First-visit onboarding — how do you want to run your tiny?
 *
 * Shows ONCE per browser (tiny_onboarded flag), on the first tiny page a
 * visitor ever opens, and offers the three ways to power chat:
 *   ⚡ free tier   — server default model, the deployment's daily allowance
 *                   (lib/free-tier.ts — 50/day unless the operator raised it),
 *                   zero setup
 *   🔒 on-device  — WebLLM via WebGPU: a HuggingFace model runs IN the
 *                   browser through the OpenAI-compatible client. Free
 *                   forever, private, offline once cached.
 *   🔑 your key   — BYOK (OpenAI/Anthropic/Bedrock/Gemini + more in
 *                   Settings); skips the free-tier rate limit.
 *
 * Writes the SAME localStorage config ModelSettings owns, so Settings
 * remains the single source of truth afterwards. Dismissal = free tier
 * (never nags again). Mounted from the PAGE components — it needs nothing
 * from Chat's state, and a portal overlays identically from anywhere.
 */
import { IconBolt, IconLock, IconKey } from "./icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
// Config module directly — importing through ModelSettings would statically
// pull the whole settings panel into Onboarding's (first-visit!) bundle.
import { MODEL_CONFIG_KEY, defaultModelConfig } from "../../lib/chat/model-config";
import { webgpuSupported, WEBLLM_MODELS, WEBLLM_DEFAULT_FAST, WEBLLM_DEFAULT_QUALITY } from "../../lib/webllm";
import { freeTierRequestsPhrase } from "../../lib/free-tier";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { useRadioGroup } from "../../lib/chat/use-radio-group";

const ONBOARDED_KEY = "tiny_onboarded";

const KEY_PROVIDERS: { id: string; label: string; keyPlaceholder: string }[] = [
  { id: "openai", label: "OpenAI", keyPlaceholder: "sk-..." },
  { id: "anthropic", label: "Anthropic", keyPlaceholder: "sk-ant-..." },
  { id: "bedrock", label: "AWS Bedrock", keyPlaceholder: "Bedrock API key" },
  { id: "gemini", label: "Gemini", keyPlaceholder: "AIza..." },
];

export default function Onboarding({ name }: { name: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(ONBOARDED_KEY)) return;
      // Already configured a model, or already has a conversation here —
      // a veteran, not a first-time visitor. Mark and stay quiet.
      if (localStorage.getItem(MODEL_CONFIG_KEY) || localStorage.getItem(`chat_messages_${name}`)) {
        localStorage.setItem(ONBOARDED_KEY, "1");
        return;
      }
      // Share links are someone ELSE's conversation — don't gate reading it.
      // ?q= deep links AUTO-SEND on load — a modal over a firing message is
      // noise; no flag is set, so these visitors onboard on their next visit.
      const params = new URLSearchParams(window.location.search);
      if (params.has("share") || params.has("q")) return;
      // Let the hero paint first — the modal rises over a settled page
      const t = setTimeout(() => setOpen(true), 800);
      return () => clearTimeout(t);
    } catch { /* storage unavailable → never show */ }
  }, [name]);

  if (!open) return null;
  return <OnboardingInner onClose={() => setOpen(false)} name={name} />;
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { }
}

function saveConfig(patch: Partial<typeof defaultModelConfig>) {
  try {
    localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify({ ...defaultModelConfig, ...patch }));
  } catch { }
}

function OnboardingInner({ onClose, name }: { onClose: () => void; name: string }) {
  const [view, setView] = useState<"choose" | "webllm" | "byok">("choose");
  // Default by device: roomy machines (deviceMemory is Chromium-only and
  // capped at 8 — treat 8 as "roomy") get the newest mid-size model,
  // everyone else the fastest/smallest. Named ids, not list positions.
  const [webllmModel, setWebllmModel] = useState(
    () => ((navigator as any).deviceMemory >= 8 ? WEBLLM_DEFAULT_QUALITY : WEBLLM_DEFAULT_FAST),
  );
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  // Masked by default (ModelSettings pattern): first-run users paste keys on
  // shared/projected screens; reveal stays one tap away because pasting blind
  // makes typos undiscoverable (the only feedback is a provider 401).
  const [showKey, setShowKey] = useState(false);
  const [region, setRegion] = useState("us-west-2");
  const gpu = webgpuSupported();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose);
  // Roving-tabindex + arrow keys for the two radiogroups (honest keyboard
  // contract for the role="radio" markup below).
  const modelRadio = useRadioGroup(WEBLLM_MODELS.map((m) => m.id), webllmModel, setWebllmModel);
  const providerRadio = useRadioGroup(KEY_PROVIDERS.map((p) => p.id), provider, setProvider);

  // Focus restore (ModelSettings pattern) + Escape = "not now"
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Move focus INTO the dialog on open — it's aria-modal, so SR must
    // announce it and Tab must start inside (without this, focus stays on
    // the background page). Focus the container, not an action button, so
    // no choice is pre-selected; the aria-label reads as the entry point.
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { dismissRef.current?.(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      try { opener?.focus(); } catch { }
    };
  }, [requestClose]);
  // Trap Tab inside (WCAG 2.4.3). Mounted only while open; aria-modal marks
  // the page behind inert.
  useFocusTrap(dialogRef, true);

  // Follow focus into each sub-view. The button that switched views unmounts
  // on the transition, dropping focus to <body> — a keyboard/SR user would
  // then have to Tab back in. BYOK exists to paste a key (Enter-to-submit is
  // wired), so land the cursor there; the model picker re-focuses the dialog
  // so its heading + first radio are the announced entry point.
  useEffect(() => {
    if (view === "byok") keyInputRef.current?.focus();
    else if (view === "webllm") dialogRef.current?.focus();
  }, [view]);

  // Every dismissal path (Escape / backdrop / "Not now") commits the free
  // tier silently — leave a breadcrumb so the choice isn't a mystery later.
  const dismiss = () => {
    markOnboarded();
    toast("⚡ Using the free tier — change anytime in ⚙️ Settings");
    requestClose();
  };
  // Keep the Escape listener pointed at the latest dismiss without
  // re-subscribing. Writing the ref in an effect (not during render) keeps
  // the render pure — the rule forbids ref mutation in the render body.
  const dismissRef = useRef(dismiss);
  useEffect(() => { dismissRef.current = dismiss; });

  const pickFreeTier = () => {
    markOnboarded();
    // The number comes from the deployment, not from this file: a self-hosted
    // operator can raise the wall, and copy that still promised 50 would be the
    // first thing they'd have to go fix by hand.
    toast(`⚡ You're on the free tier — ${freeTierRequestsPhrase()}, no setup`);
    requestClose();
  };

  const pickWebllm = () => {
    saveConfig({ provider: "webllm", modelId: webllmModel });
    markOnboarded();
    const m = WEBLLM_MODELS.find((x) => x.id === webllmModel);
    // 8s: this toast sets a multi-GB expectation for the FIRST message —
    // the global 2.5s blip cap would kill it before it lands (pass-75 class)
    toast.success(`🔒 On-device model set — your first message downloads it once (${m?.size}), then it's free forever`, { duration: 8000 });
    requestClose();
  };

  const pickKey = () => {
    if (!apiKey.trim()) { toast.error("Paste an API key first — or go back and pick a free option"); return; }
    saveConfig({ provider, apiKey: apiKey.trim(), ...(provider === "bedrock" ? { region } : {}) });
    markOnboarded();
    toast.success("✅ Using your API key — rate limits bypassed");
    requestClose();
  };

  const card = (selected: boolean) => ({
    borderColor: selected ? "var(--tiny-accent)" : "rgba(var(--tiny-accent-rgb),0.25)",
    background: selected ? "rgba(var(--tiny-accent-rgb),0.08)" : "rgba(0,0,0,0.4)",
  });

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={dismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose how your AI runs"
        tabIndex={-1}
        className={`w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl p-6 border outline-none ${exitClass}`}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
          boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.1)",
        }}
        onAnimationEnd={onAnimationEnd}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="text-lg font-bold mb-1"
          style={{ color: "var(--tiny-accent)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb),0.5)" }}
        >
          {view === "choose" ? (name === "tiny" ? "How should chat run for you?" : `How should /${name} run for you?`) : view === "webllm" ? "Pick your on-device model" : "Bring your own key"}
        </h2>
        <p className="text-xs text-gray-400 mb-5">
          {view === "choose"
            ? "Pick once — change anytime in ⚙️ Settings."
            : view === "webllm"
              ? "Runs in your browser via WebGPU. Downloads once, then it's private, offline-capable, and free forever."
              : "Your key stays in this browser and goes only to your provider. Skips the free-tier limit."}
        </p>

        {view === "choose" && (
          <div className="space-y-3">
            <button
              onClick={pickFreeTier}
              className="w-full text-left rounded-xl border p-4 transition-all hover:scale-[1.02] active:scale-100"
              style={card(false)}
            >
              <div className="text-sm font-semibold text-white inline-flex items-center gap-1.5"><IconBolt className="w-4 h-4" style={{ color: "var(--tiny-accent)" }} /> Just start chatting</div>
              <div className="text-xs text-gray-400 mt-1">Free tier — {freeTierRequestsPhrase()}, zero setup.</div>
            </button>

            <button
              onClick={() => gpu && setView("webllm")}
              disabled={!gpu}
              aria-disabled={!gpu}
              className="w-full text-left rounded-xl border p-4 transition-all hover:scale-[1.02] active:scale-100 disabled:opacity-50 disabled:hover:scale-100"
              style={card(false)}
            >
              <div className="text-sm font-semibold text-white inline-flex items-center gap-1.5"><IconLock className="w-4 h-4" style={{ color: "var(--tiny-accent)" }} /> Free forever — runs in your browser</div>
              <div className="text-xs text-gray-400 mt-1">
                {gpu
                  ? "An open model runs on YOUR device via WebGPU. Private, offline once downloaded, unlimited."
                  : "Needs WebGPU — Chrome/Edge 113+ or Safari 18+. This browser doesn't support it."}
              </div>
            </button>

            <button
              onClick={() => setView("byok")}
              className="w-full text-left rounded-xl border p-4 transition-all hover:scale-[1.02] active:scale-100"
              style={card(false)}
            >
              <div className="text-sm font-semibold text-white inline-flex items-center gap-1.5"><IconKey className="w-4 h-4" style={{ color: "var(--tiny-accent)" }} /> Bring your own key</div>
              <div className="text-xs text-gray-400 mt-1">OpenAI, Anthropic, Bedrock, Gemini and more — no rate limit.</div>
            </button>

            <button onClick={dismiss} className="w-full text-center text-xs text-gray-400 hover:text-white transition-colors py-1">
              Not now
            </button>
          </div>
        )}

        {view === "webllm" && (
          <div className="space-y-3">
            {/* Single-select among the quick-pick models → a radiogroup, not
                a row of independent toggles (mirrors the BYOK provider picker
                below). aria-pressed here would tell a SR user each button is
                an on/off toggle, hiding that choosing one deselects the rest. */}
            <div className="space-y-3" role="radiogroup" aria-label="On-device model" onKeyDown={modelRadio.onKeyDown}>
            {WEBLLM_MODELS.map((m) => (
              <button
                key={m.id}
                role="radio"
                onClick={() => setWebllmModel(m.id)}
                aria-checked={webllmModel === m.id}
                tabIndex={modelRadio.tabIndex(m.id)}
                className="w-full text-left rounded-xl border px-4 py-3 transition-all hover:scale-[1.02] active:scale-100"
                style={card(webllmModel === m.id)}
              >
                <div className="text-sm font-semibold text-white flex items-center justify-between">
                  <span>{m.label}</span>
                  <span className="text-xs font-normal text-gray-400">{m.size} download</span>
                </div>
              </button>
            ))}
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setView("choose")} className="flex-1 px-4 py-2.5 rounded-xl text-sm border text-gray-400 transition-colors hover:text-white hover:border-white/40" style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(255,255,255,0.2)" }}>
                ← Back
              </button>
              <button onClick={pickWebllm} className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100" style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb),0.3)" }}>
                Run on my device
              </button>
            </div>
          </div>
        )}

        {view === "byok" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Provider" onKeyDown={providerRadio.onKeyDown}>
              {KEY_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={provider === p.id}
                  tabIndex={providerRadio.tabIndex(p.id)}
                  onClick={() => setProvider(p.id)}
                  className="px-3 py-1.5 rounded-full text-xs border transition-all hover:scale-105 active:scale-100"
                  style={card(provider === p.id)}
                >
                  <span className={provider === p.id ? "" : "text-gray-300"} style={provider === p.id ? { color: "var(--tiny-accent)" } : undefined}>{p.label}</span>
                </button>
              ))}
            </div>
            <div className="relative">
              <input
                ref={keyInputRef}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); pickKey(); } }}
                placeholder={KEY_PROVIDERS.find((p) => p.id === provider)?.keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                aria-label="API key"
                className="w-full rounded-lg px-3 py-2.5 pr-16 text-base sm:text-sm outline-none border focus:border-[rgba(var(--tiny-accent-rgb),0.5)]"
                style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(var(--tiny-accent-rgb),0.2)", color: "white" }}
              />
              {apiKey && (
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
            {provider === "bedrock" && (
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); pickKey(); } }}
                placeholder="AWS region (us-west-2)"
                autoComplete="off"
                spellCheck={false}
                aria-label="AWS region"
                className="w-full rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none border focus:border-[rgba(var(--tiny-accent-rgb),0.5)]"
                style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(var(--tiny-accent-rgb),0.2)", color: "white" }}
              />
            )}
            <p className="text-[11px] text-gray-400">More providers, model pick and base URLs live in Settings.</p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setView("choose")} className="flex-1 px-4 py-2.5 rounded-xl text-sm border text-gray-400 transition-colors hover:text-white hover:border-white/40" style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(255,255,255,0.2)" }}>
                ← Back
              </button>
              <button onClick={pickKey} className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100" style={{ background: "var(--tiny-accent)", color: "#000", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb),0.3)" }}>
                Use my key
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
