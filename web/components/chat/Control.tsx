import { Switch } from "@headlessui/react";
import { useState, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { parseOpenAPI } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { purgeTinyKeys } from "@/lib/chat/local-keys";
import { toolBoxBadge } from "@/lib/chat/capacity";
import { isCurrentSubject, gateSubjectMutation } from "@/lib/chat/config-subject";
import {
  THEME_PRESETS, applyTheme, saveThemeLocal, saveThemeRemote, loadThemeLocal,
  applyCustomCss, saveCustomCssLocal, loadCustomCssLocal,
  saveCustomJsLocal, loadCustomJsLocal, saveCustomizationRemote,
  type TinyTheme,
} from "@/lib/theme";

function classNames(...classes: any[]) {
  return classes.filter(Boolean).join(' ')
}

// The vibrate tool's canonical pattern names (lib/chat/tools/client-side.ts) —
// the worker allowlists intro_vibe against this exact set.
const INTRO_VIBES = ['tap', 'double', 'success', 'warning', 'error', 'heartbeat', 'sos', 'long', 'escalate', 'wave'];

// Logo preview: mp4/webm render as a looping <video>, everything else as <img>
const isVideoUrl = (u: string) => /\.(mp4|webm)([?#]|$)/i.test(u);

export function Control({
  name,
  compact,
}: {
  name?: string;
  compact?: boolean; // rendered inside the Settings modal — no full-page chrome
}) {
  const [nameForm, setNameForm] = useState(name || "");
  const [systemPromptForm, setSystemPromptForm] = useState(
    ""
  );
  const [systemKnowledgeForm, setSystemKnowledgeForm] = useState(
    ""
  );
  const [dataForm, setDataForm] = useState("");
  const [hookForm, setHookForm] = useState("");
  // 🖼️ Per-tiny branding: hero banner URL + {accent,bg} colors visitors see
  const [heroForm, setHeroForm] = useState("");
  // Preview error is React state, not imperative style.display: setting
  // display:none on the DOM node in onError meant a corrected URL never
  // re-showed the preview (React only owns the element's borderColor, so it
  // never reset display). Reset this in onChange so a fixed URL previews again.
  const [heroBroken, setHeroBroken] = useState(false);
  // 🎭 Per-tiny identity: logo media + intro haptic + starter chips
  const [logoForm, setLogoForm] = useState("");
  const [logoBroken, setLogoBroken] = useState(false);
  const [introVibeForm, setIntroVibeForm] = useState("");
  const [chipsForm, setChipsForm] = useState<string[]>(["", "", "", ""]);
  const [taglineForm, setTaglineForm] = useState("");
  // 🎙️ Per-tiny live-call voice — the OpenAI Realtime voice this tiny speaks
  // with on 📞 calls. '' = inherit (caller's account voice, else marin).
  const [voiceForm, setVoiceForm] = useState("");
  const [tinyAccentForm, setTinyAccentForm] = useState("");
  const [tinyBgForm, setTinyBgForm] = useState("");
  // 🔐 Session auth (GitHub/WebAuthn) replaces the legacy API key
  const [me, setMe] = useState<{ authenticated: boolean; user?: { login: string; avatar?: string }; tinys?: { name: string }[] } | null>(null);
  // Worker start
  const [workerForm, setWorkerForm] = useState("");
  const [APISchema, setAPISchema] = useState({} as any);
  const [isWorkerActive, setIsWorkerActive] = useState(false);
  const [paths, setPaths] = useState([] as any);
  const [skills, setSkills] = useState([] as any);
  // parseOpenAPI walks paths × methods and resolves $refs — non-trivial, and
  // it sat in the render path (:717), re-running on every keystroke across the
  // ~10 form inputs. Memo on the schema so it recomputes only when the worker's
  // OpenAPI actually changes.
  const workerFns = useMemo(() => parseOpenAPI(APISchema), [APISchema]);
  // Worker end
  const [mcpForm, setMcpForm] = useState("");
  const [mcpError, setMcpError] = useState("");
  // 🔧 Forged tools (create_tool / install) — account-level, not per-tiny
  const [myTools, setMyTools] = useState<{ name: string; description: string; created: number }[] | null>(null);
  // Distinguish a load FAILURE from a genuinely empty box — else an outage
  // renders as the calm "No forged tools yet" hint (tools look deleted). The
  // worker now fails honestly (500 → proxy 424 → d.ok false); surface that.
  const [myToolsFailed, setMyToolsFailed] = useState(false);
  // 🎨 Appearance — same pref the agent's set_theme tool writes
  const [activeTheme, setActiveTheme] = useState<string>(() => loadThemeLocal()?.preset || 'tiny');
  const { confirm, dialog } = useConfirm();

  const pickTheme = (presetName: string) => {
    const p = THEME_PRESETS[presetName];
    if (!p) return;
    const theme: TinyTheme | null = presetName === 'tiny' ? null : { preset: presetName, accent: p.accent, bg: p.bg };
    applyTheme(theme);
    saveThemeLocal(theme);
    saveThemeRemote(theme); // no-ops signed-out
    setActiveTheme(presetName);
    toast(`🎨 ${presetName} theme applied`);
  };

  // 🖌️ customize_page artifacts (custom CSS/JS) — surfaced so users can audit/remove
  const [hasCustomCss, setHasCustomCss] = useState(false);
  const [hasCustomJs, setHasCustomJs] = useState(false);
  useEffect(() => {
    setHasCustomCss(!!loadCustomCssLocal());
    setHasCustomJs(!!loadCustomJsLocal());
  }, []);

  const clearCustomizations = () => {
    applyCustomCss(null);
    saveCustomCssLocal(null);
    saveCustomJsLocal(null);
    saveCustomizationRemote('custom_css', null); // no-op signed-out
    saveCustomizationRemote('custom_js', null);
    setHasCustomCss(false);
    setHasCustomJs(false);
    toast('🖌️ Custom CSS/JS removed (JS stops on next reload)');
  };
  const [privateForm, setPrivateForm] = useState(false)
  const [activeForm, setActiveForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingTool, setDeletingTool] = useState<string | null>(null);
  const [deletingTiny, setDeletingTiny] = useState(false);
  // 💸 Per-message price (x402). Read via the wallet proxy's `pricing` action,
  // written via `set_price` — the same POST /api/wallet contract iOS/Android
  // and the chat set_price tool use. Kept OUT of the /api/control save:
  // pricing lives in the worker's pay tables, not the tiny record, so it has
  // its own load + save path here. priceMicroLoaded null = unknown (signed
  // out / lookup failed) — the badge just stays hidden.
  const [priceForm, setPriceForm] = useState("");
  const [priceMicroLoaded, setPriceMicroLoaded] = useState<number | null>(null);
  // Which tiny `priceForm` belongs to. Separate from loadedNameRef because the
  // price is a SECOND fetch that can fail or still be in flight while the
  // config has already applied — set_price must not post a price the user
  // never saw for this tiny.
  const [priceLoadedFor, setPriceLoadedFor] = useState<string | null>(null);
  const [savingPrice, setSavingPrice] = useState(false);
  // The name-field blur loads THAT tiny's stored config into the form so you
  // can edit an existing one. Track which name we last loaded: blurring the
  // field without changing the name must NOT re-fetch and clobber unsaved
  // edits to the prompt/memory/etc. (data-loss bug — you'd lose your work
  // just by tabbing through the name input).
  const loadedNameRef = useRef<string | null>(null);
  // The name of the load that is currently IN FLIGHT (v12: subject staleness).
  // `loadedNameRef` says which tiny the form holds; this says which one we last
  // asked for, and only that one's response may paint. Without it, blurring
  // "b" then "a" applied whichever GET finished last — so tiny b's prompt,
  // worker, theme and MCP config could sit under the name "a", and Save would
  // then write them to a. Keyed on the NAME rather than a counter on purpose:
  // the response is a pure function of the name, so a slow reply for the name
  // the field still holds (b → a → b) is the right answer, not a stale one.
  const requestedNameRef = useRef<string | null>(null);

  // Apply a loaded /api/tiny config to the form. Split out of the fetch so the
  // early-return error guard lives in the .catch (not as a top-level
  // if/return in the async body, which the set-state-in-effect analyzer traces
  // as a synchronous effect path and warns on).
  const applyTinyData = (target: string, data: any) => {
    loadedNameRef.current = target;
    setSystemPromptForm(data.systemPrompt || '');
    setSystemKnowledgeForm(data.systemKnowledge || '');
    setDataForm(data.data || '');
    setHookForm(data.hook || '');
    setHeroForm(data.hero || '');
    // Reset the broken-image flag on programmatic load too: the onChange handler
    // clears it for manual edits, but loading a *different* tiny's config here
    // would otherwise leave a prior tiny's onError=true stale, falsely showing
    // "Couldn't load that image" over the new tiny's perfectly valid hero.
    setHeroBroken(false);
    // 🎭 Identity fields — same programmatic-load rules as hero above
    setLogoForm(data.logo || '');
    setLogoBroken(false);
    setIntroVibeForm(data.intro_vibe || '');
    const loadedChips: string[] = Array.isArray(data.chips) ? data.chips : [];
    setChipsForm([0, 1, 2, 3].map((i) => loadedChips[i] || ''));
    setTaglineForm(data.tagline || '');
    setVoiceForm(data.voice || '');
    setTinyAccentForm(data.theme?.accent || '');
    setTinyBgForm(data.theme?.bg || '');
    // Worker start
    setWorkerForm(data.worker || '');
    setAPISchema(data.schema || {});
    setIsWorkerActive(data.worker && data.worker.length > 0);
    setPaths(Object.keys(data.schema?.paths || {}));
    setSkills(data.skills || []);
    // Worker end
    setPrivateForm(data.private || false);
    setActiveForm(data.active || false);
    // MCP servers — owner sees full config (headers included); others see redacted
    setMcpForm(data.mcpServers ? JSON.stringify(data.mcpServers, null, 2) : "");
    setMcpError("");
  };

  // 💸 Load the tiny's current per-message price. The proxy canonicalizes the
  // `tiny:` slug server-side (app/api/wallet/route.ts) so this reads the same
  // key set_price wrote. A clean {ok:false} (signed out / outage) leaves the
  // price unknown rather than painting a false "FREE".
  const loadPrice = (target: string) => {
    if (!target) return;
    setPriceMicroLoaded(null);
    setPriceLoadedFor(null);
    fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pricing", resource: `tiny:${target.toLowerCase()}` }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .then((d) => {
        // Same latest-wins rule as the config load: this writes `priceForm`,
        // which `savePrice` posts, so an out-of-order reply would put one
        // tiny's price in the field under another tiny's name.
        if (!isCurrentSubject(target, requestedNameRef.current)) return;
        if (d?.ok === false) return; // unknown — keep the badge hidden
        const micro = Math.max(0, Math.floor(Number(d?.price_micro) || 0));
        setPriceMicroLoaded(micro);
        setPriceLoadedFor(target);
        setPriceForm(micro > 0 ? String(micro / 1_000_000) : "");
      })
      .catch(() => { /* stays null — badge hidden, input still usable */ });
  };

  const handleBlurFormItem = (force = false) => {
    const target = nameForm;
    if (!force && loadedNameRef.current === target) return; // same tiny — keep edits
    requestedNameRef.current = target;
    // The .catch is the fix: without it a transient network/non-JSON failure
    // (a worker 502 HTML page, etc.) rejected out of this handler, skipping
    // EVERY setState → the config form rendered blank with no feedback and
    // loadedNameRef was never set, so the mount effect couldn't recover. Now a
    // failure surfaces a toast and keeps whatever's on screen.
    fetch(`/api/tiny`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: target,
      }),
      // House rule: a worker that connects but never responds would leave this
      // promise pending forever — the .catch (blank-form recovery) never fires.
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.json())
      .then((data) => {
        // Latest-wins: only the newest requested name may repaint the form.
        // Two blurs in flight used to apply in RESPONSE order, so the slower
        // one won and left another tiny's whole config under this name.
        if (!isCurrentSubject(target, requestedNameRef.current)) return;
        applyTinyData(target, data);
        loadPrice(target);
      })
      .catch(() => toast.error("Couldn't load your tiny — check your connection and try again."));
  };

  const handleBlurFormWorker = () => {
    // Parse OpenAPI schema
    fetch(`/api/worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: nameForm,
        worker: workerForm
      }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.message === 'Worker is active.') {
          setIsWorkerActive(true);
          setAPISchema(data.schema);
          // Guard .paths — an "active" worker that returns schema:null would
          // otherwise TypeError out of this handler.
          setPaths(Object.keys(data.schema?.paths || {}));
          setSkills(data.skills || []);
        } else {
          setIsWorkerActive(false);
          if (data.message) toast.error(data.message); // surface validation errors
        }
      })
      .catch(() => {
        // The .catch is the fix — a failed worker-ingest fetch used to reject
        // silently, leaving the Worker field's active state frozen with no cue.
        setIsWorkerActive(false);
        toast.error("Couldn't validate the worker URL — try again.");
      });
  };

  useEffect(() => {
    if (name) {
      handleBlurFormItem();
    }
  }, [name])

  // Load session — ownership is checked server-side, this drives the UI state
  useEffect(() => {
    fetch("/api/me", { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, [])

  const loadMyTools = () => {
    // Timeout so a hung /api/tools can't strand myTools at null — the body
    // would spin "Loading tools…" forever AND the refresh button is
    // disabled={myTools === null}, leaving no in-UI path back (only reload).
    setMyToolsFailed(false);
    fetch("/api/tools", { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json())
      .then((d) => {
        // d.ok false = login/outage (proxy 401/424); don't paint it as "empty".
        if (d.ok) { setMyTools(d.tools); }
        else { setMyTools([]); setMyToolsFailed(true); }
      })
      .catch(() => { setMyTools([]); setMyToolsFailed(true); });
  };

  useEffect(() => {
    if (me?.authenticated) loadMyTools();
  }, [me?.authenticated])

  const deleteMyTool = async (toolName: string) => {
    if (!(await confirm({
      title: `Delete my_${toolName}?`,
      message: "Your tinys lose this tool immediately.",
      confirmLabel: "Delete",
      danger: true,
    }))) return;
    setDeletingTool(toolName);
    fetch("/api/tools", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: toolName }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          toast(`🗑️ my_${toolName} deleted`);
          loadMyTools();
        } else toast.error(d.error || "Couldn't delete — try again");
      })
      .catch(() => toast.error("Couldn't delete — try again"))
      .finally(() => setDeletingTool(null));
  };

  // 💸 Set/clear the per-message price. Separate from the big Save button on
  // purpose: set_price is its own idempotent, owner-authorized endpoint — and
  // pricing shouldn't silently change because someone re-saved their prompt.
  const savePrice = () => {
    // The price in the field was loaded FOR a tiny; refuse if that isn't the
    // tiny the request will charge (lib/chat/config-subject).
    const gate = gateSubjectMutation('price', { loaded: priceLoadedFor, form: nameForm });
    if (!gate.ok) { toast.error(gate.message); return; }
    const usd = priceForm.trim() === "" ? 0 : Number(priceForm);
    // Mirror the server contract ($100 cap, app/api/wallet/route.ts) so the
    // user gets the honest reason here instead of a proxied 400.
    if (!Number.isFinite(usd) || usd < 0 || usd > 100) {
      toast.error("Price must be between $0 and $100 per message.");
      return;
    }
    const priceMicro = Math.round(usd * 1_000_000);
    setSavingPrice(true);
    fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_price", resource: `tiny:${nameForm.toLowerCase()}`, price_micro: priceMicro }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setPriceMicroLoaded(priceMicro);
          toast.success(priceMicro > 0
            ? `💸 ${nameForm} now charges $${priceMicro / 1_000_000} per message`
            : `${nameForm} is free again`);
        } else toast.error(d.error || "Couldn't set the price — try again.");
      })
      .catch(() => toast.error("Couldn't set the price — try again."))
      .finally(() => setSavingPrice(false));
  };

  // Compare against the lowercased name the save path actually sends
  // (line ~772 does nameForm.toLowerCase(); the worker stores lowercase
  // slugs). Comparing the raw nameForm meant typing your own tiny with any
  // uppercase (e.g. "MyTiny") read as "OWNED BY SOMEONE ELSE" — hiding the
  // delete button and warning that a save that will actually succeed will be
  // rejected. me.tinys names come back already lowercased.
  const ownsThisTiny = !!me?.tinys?.some((t) => t.name === nameForm.toLowerCase());

  return <div className={compact ? "text-white" : "min-h-screen bg-black text-white"} id="control">
    <div className={compact ? "" : "max-w-3xl mx-auto px-4 py-8"}>
      {!compact && (
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--tiny-accent)', textShadow: '0 0 10px rgba(var(--tiny-accent-rgb),0.5)' }}>Configure Your AI</h1>
          <p className="text-gray-400">
            Customize your Tiny AI's personality and capabilities
          </p>
        </div>
      )}

      <div className="space-y-6">
        {/* 🔧 My Forged Tools — account-level, so it leads the panel */}
        {me?.authenticated && (
          <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
            <div className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
              My Forged Tools
              {/* Was `{myTools.length}/20`. There is no cap of 20: the worker's
                  is MAX_TOOLS = 10000 and /api/tools has no LIMIT, so the
                  denominator was invented — a rule the product appeared to
                  enforce and didn't. A bare count is the whole truth here. */}
              {toolBoxBadge(myTools?.length) && (
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' }}>
                  {toolBoxBadge(myTools?.length)}
                </span>
              )}
              <button
                onClick={(e) => { e.preventDefault(); setMyTools(null); loadMyTools(); }}
                disabled={myTools === null}
                className="ml-auto text-xs px-2 py-0.5 rounded border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)] hover:border-[rgba(var(--tiny-accent-rgb),0.45)] disabled:opacity-50"
                style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' }}
              >
                {/* Spin the glyph while (re)loading — matches JobsPanel/MemoryPanel;
                    the body "Loading tools…" only shows when the list is empty. */}
                <span className={myTools === null ? "inline-block animate-spin mr-1" : "inline-block mr-1"} aria-hidden="true">↻</span>
                {myTools === null ? "refreshing…" : "refresh"}
              </button>
            </div>
            {myTools === null ? (
              <p role="status" className="text-xs text-gray-400">Loading tools…</p>
            ) : myToolsFailed ? (
              // Load failed (login/outage) — DON'T show the calm "no tools yet"
              // hint, which reads as "your tools were deleted". Offer a retry.
              <p role="alert" className="text-xs" style={{ color: 'var(--tiny-danger)' }}>
                Couldn&apos;t load your tools — check your connection and{' '}
                <button
                  onClick={(e) => { e.preventDefault(); loadMyTools(); }}
                  className="underline underline-offset-2"
                >
                  retry
                </button>.
              </p>
            ) : myTools.length === 0 ? (
              <p className="text-xs text-gray-400">
                No forged tools yet — ask any tiny to create one (create_tool), or install one from a builder profile.
              </p>
            ) : (
              <div className="space-y-2">
                {myTools.map((t) => (
                  <div
                    key={t.name}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2"
                    style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.15)' }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs font-semibold truncate" style={{ color: 'var(--tiny-accent)' }}>my_{t.name}</div>
                      {t.description && <div className="text-xs text-gray-400 truncate">{t.description}</div>}
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); deleteMyTool(t.name); }}
                      disabled={deletingTool === t.name}
                      className="text-xs px-2 py-1 rounded border transition-colors hover:bg-[rgba(var(--tiny-danger-rgb),0.1)] hover:border-[rgba(var(--tiny-danger-rgb),0.5)] disabled:opacity-50"
                      style={{ borderColor: 'rgba(var(--tiny-danger-rgb),0.3)', color: 'var(--tiny-danger)' }}
                    >
                      {deletingTool === t.name ? 'deleting…' : 'delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-400 mt-2">
              Tools follow your account across all your tinys as my_&lt;name&gt;.
              {me.user?.login && (
                <> They're public on <a href={`/@${me.user.login}`} className="hover:opacity-80" style={{ color: 'var(--tiny-accent)' }}>your profile</a>.</>
              )}
            </p>
          </div>
        )}

        {/* 🎨 Appearance — presets the agent's set_theme tool also uses */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <div className="block text-sm font-semibold text-white mb-2">
            Appearance
            <span className="ml-2 px-2 py-0.5 text-xs rounded" style={{ background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' }}>
              {activeTheme}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(THEME_PRESETS).map(([key, p]) => (
              <button
                key={key}
                onClick={(e) => { e.preventDefault(); pickTheme(key); }}
                title={p.description}
                aria-pressed={key === activeTheme}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-all hover:scale-105 active:scale-100"
                style={{
                  background: key === activeTheme ? 'rgba(var(--tiny-accent-rgb),0.15)' : p.bg,
                  borderColor: key === activeTheme ? 'var(--tiny-accent)' : 'rgba(var(--tiny-accent-rgb),0.25)',
                  color: p.accent,
                }}
              >
                {/* aria-hidden: the dot is decorative, the label names the theme */}
                <span className="w-3 h-3 rounded-full inline-block" aria-hidden="true" style={{ background: p.accent }} />
                {key}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Or just ask your tiny — "make the page cyberpunk", "use an orange accent" (set_theme). Signed in, the theme follows you everywhere.
          </p>
          {(hasCustomCss || hasCustomJs) && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border px-3 py-2" style={{ borderColor: 'rgba(255,180,0,0.3)' }}>
              <div className="text-xs" style={{ color: '#ffb400' }}>
                Custom {[hasCustomCss && 'CSS', hasCustomJs && 'JS'].filter(Boolean).join(' + ')} active (customize_page)
              </div>
              <button
                onClick={(e) => { e.preventDefault(); clearCustomizations(); }}
                className="ml-auto text-xs px-2 py-1 rounded border hover:opacity-80"
                style={{ borderColor: 'rgba(var(--tiny-danger-rgb),0.3)', color: 'var(--tiny-danger)' }}
              >
                remove
              </button>
            </div>
          )}
        </div>

        {/* 🔐 Ownership — session auth replaces the legacy API key */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <div className="block text-sm font-semibold text-white mb-2">
            Ownership
            {me?.authenticated && activeForm && (
              <span className="ml-2 px-2 py-1 text-xs rounded" style={ownsThisTiny ? { background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' } : { background: 'rgba(255,180,0,0.15)', color: '#ffb400' }}>
                {ownsThisTiny ? 'YOU OWN THIS' : 'OWNED BY SOMEONE ELSE'}
              </span>
            )}
          </div>
          {me === null ? (
            <p className="text-xs text-gray-400">Checking session…</p>
          ) : me.authenticated ? (
            <div className="flex items-center gap-3">
              {me.user?.avatar && (

                <img src={me.user.avatar} alt={me.user.login} className="w-8 h-8 rounded-full border" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.4)' }} />
              )}
              <div className="text-sm text-gray-300">
                Signed in as <span style={{ color: 'var(--tiny-accent)' }}>@{me.user?.login}</span>
                <p className="text-xs text-gray-400 mt-0.5">
                  {activeForm
                    ? ownsThisTiny
                      ? 'You can edit and save this tiny.'
                      : 'This tiny belongs to another account — saving will be rejected.'
                    : 'This name is free — saving will create it under your account.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-300">
              <a href={`/api/auth?return_to=${encodeURIComponent(`/${nameForm || ''}`)}`} className="underline hover:opacity-80" style={{ color: 'var(--tiny-accent)' }}>
                Sign in with GitHub
              </a>{' '}
              to create or modify your AI — free, no keys needed.
            </div>
          )}
        </div>

        {/* AI Name */}
        <div className="border rounded-xl p-6" style={{
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(10px)',
          borderColor: 'rgba(var(--tiny-accent-rgb),0.2)'
        }}>
          <label htmlFor="tinyName" className="block text-sm font-semibold text-white mb-2">
            AI Name
          </label>
          {nameForm.length > 0 && (
            <a href={`/${nameForm}`} className="text-xs  mb-2 block" style={{ color: 'var(--tiny-accent)' }}>
              tiny.technology/{nameForm} →
            </a>
          )}
          <div className="flex rounded-lg overflow-hidden border transition-colors" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
            <span className="inline-flex items-center px-4 text-gray-400 text-sm font-medium" style={{ background: 'rgba(0,0,0,0.3)' }}>
              tiny.technology/
            </span>
            <input
              type="text"
              name="tinyName"
              id="tinyName"
              value={nameForm}
              autoFocus={false}
              onBlur={() => handleBlurFormItem()}
              onChange={(e) => setNameForm(e.target.value)}
              className="flex-1 bg-transparent text-white px-4 py-3 focus:outline-none placeholder-gray-500"
              placeholder="your-ai-name"
            />
          </div>
        </div>

        {/* Privacy Toggle */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <Switch.Group as="div" className="flex items-center justify-between">
            <div className="flex-1 mr-4">
              <Switch.Label as="div" className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                Privacy Mode
                <span className={`px-2 py-0.5 rounded text-xs font-bold`} style={privateForm ? { background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' } : { background: 'rgba(75,85,99,1)', color: 'rgba(156,163,175,1)' }}>
                  {privateForm ? 'PRIVATE' : 'PUBLIC'}
                </span>
              </Switch.Label>
              <Switch.Description as="p" className="text-sm text-gray-400">
                {privateForm ? 'Only you can interact with your AI' : 'Anyone can interact with your AI'}
              </Switch.Description>
            </div>
            <Switch
              checked={privateForm}
              onChange={setPrivateForm}
              className={classNames(
                // Engaged (private ON) = accent-filled track; OFF = neutral
                // gray. The old ON state was bg-transparent — invisible on the
                // dark card, inverting the usual "colored = on" affordance on
                // the primary privacy control.
                privateForm ? 'bg-[var(--tiny-accent)]' : 'bg-gray-700',
                'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900'
              )}
            >
              <span
                className={classNames(
                  privateForm ? 'translate-x-5' : 'translate-x-0',
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out'
                )}
              />
            </Switch>
          </Switch.Group>
        </div>
        {/* 💸 Pricing — x402 per-message price. Owners of an existing tiny only
            (same gate as the danger zone): the worker rejects set_price on
            someone else's resource anyway, this just never renders a dead
            control. Parity with Android's /price command and the chat
            set_price tool — same proxy, same $100 cap. */}
        {activeForm && ownsThisTiny && (
          <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
            <label htmlFor="tinyPrice" className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
              Pricing
              {priceMicroLoaded !== null && (
                <span className="text-xs px-2 py-0.5 rounded font-bold" style={priceMicroLoaded > 0 ? { background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' } : { background: 'rgba(75,85,99,1)', color: 'rgba(156,163,175,1)' }}>
                  {priceMicroLoaded > 0 ? `$${(priceMicroLoaded / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}/message` : 'FREE'}
                </span>
              )}
            </label>
            <p className="text-sm text-gray-400 mb-3">
              Charge callers per message — their wallet is charged automatically and your earnings land in{' '}
              <a href="/wallet" className="hover:opacity-80" style={{ color: 'var(--tiny-accent)' }}>your wallet</a>.
              Flat $0.001 platform fee per paid message, never a percentage.
            </p>
            <div className="flex gap-2">
              <div className="flex flex-1 rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
                <span className="inline-flex items-center px-4 text-gray-400 text-sm font-medium" style={{ background: 'rgba(0,0,0,0.3)' }}>$</span>
                <input
                  type="number"
                  name="tinyPrice"
                  id="tinyPrice"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  value={priceForm}
                  onChange={(e) => setPriceForm(e.target.value)}
                  className="flex-1 w-full bg-transparent text-white px-3 py-3 focus:outline-none placeholder-gray-500"
                  placeholder="0.00 (free)"
                />
                <span className="inline-flex items-center px-4 text-gray-400 text-sm" style={{ background: 'rgba(0,0,0,0.3)' }}>/ message</span>
              </div>
              <button
                onClick={(e) => { e.preventDefault(); savePrice(); }}
                disabled={savingPrice}
                className="px-5 rounded-lg text-sm font-semibold border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)] hover:border-[rgba(var(--tiny-accent-rgb),0.45)] disabled:opacity-50"
                style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.3)', color: 'var(--tiny-accent)' }}
              >
                {savingPrice ? 'Saving…' : 'Set price'}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              $0 – $100 per message. Set 0 (or clear the field) to make it free again.{' '}
              {privateForm
                ? 'Heads up: this tiny is private, so only you can chat with it — pricing mostly matters for public tinys.'
                : 'Priced tinys are also payable by outside AI agents over x402 — your agent-payable URLs are listed in the wallet.'}
            </p>
          </div>
        )}

        {/* System Prompt */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="systemPrompt" className="block text-sm font-semibold text-white mb-2">
            First Message
          </label>
          <textarea
            name="systemPrompt"
            id="systemPrompt"
            rows={4}
            value={systemPromptForm}
            onChange={(e) => setSystemPromptForm(e.target.value)}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500 resize-none"
            placeholder="I'm a fitness instructor..."
          />
          <p className="text-xs text-gray-400 mt-2">
            <span className="font-semibold">Tip:</span> Keep it short and engaging. Example: "I'm a fitness instructor"
          </p>
        </div>

        {/* System Knowledge */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="systemKnowledge" className="block text-sm font-semibold text-white mb-2">
            Second Message
          </label>
          <textarea
            name="systemKnowledge"
            id="systemKnowledge"
            rows={4}
            value={systemKnowledgeForm}
            onChange={(e) => setSystemKnowledgeForm(e.target.value)}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500 resize-none"
            placeholder="I can guide you on your fitness journey..."
          />
          <p className="text-xs text-gray-400 mt-2">
            <span className="font-semibold">Tip:</span> Describe what you can do. Example: "I can guide you on your fitness journey"
          </p>
        </div>

        {/* Memory/Data */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="data" className="block text-sm font-semibold text-white mb-2">
            Memory / Context
          </label>
          <textarea
            name="data"
            id="data"
            rows={6}
            value={dataForm}
            onChange={(e) => setDataForm(e.target.value)}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500 resize-none"
            placeholder="Additional context about your AI..."
          />
          <p className="text-xs text-gray-400 mt-2">
            <span className="font-semibold">Tip:</span> Provide detailed information. Example: "Contact me at [URL] to schedule a training session"
          </p>
          <p className="text-xs mt-1" style={{ color: '#ffb400' }}>
            ⚠️ Public on public tinys — the AI shares this freely. Never put API keys or passwords here (make the tiny private for sensitive context).
          </p>
        </div>

        {/* Webhook */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="tinyHook" className="block text-sm font-semibold text-white mb-2">
            Webhook URL (Optional)
          </label>
          <input
            type="url"
            name="tinyHook"
            id="tinyHook"
            value={hookForm}
            onChange={(e) => setHookForm(e.target.value)}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500"
            placeholder="https://your-webhook.com/endpoint"
          />
          <p className="text-xs text-gray-400 mt-2">
            Listen to every chat interaction. Need a test webhook? <a href="https://webhook-test.com/" target="_blank" rel="noopener noreferrer" className="hover:opacity-80">Create one here</a>
          </p>
        </div>

        {/* 🖼️ Branding — hero banner + the colors visitors see */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="tinyHero" className="block text-sm font-semibold text-white mb-2">
            Hero Image (Optional)
          </label>
          <input
            type="url"
            name="tinyHero"
            id="tinyHero"
            value={heroForm}
            onChange={(e) => { setHeroForm(e.target.value); setHeroBroken(false); }}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500"
            placeholder="https://example.com/banner.jpg"
          />
          <p className="text-xs text-gray-400 mt-2">
            Shown behind your tiny&apos;s landing hero — like a Twitter profile banner. https image URLs only.
          </p>
          {heroForm.trim() && /^https:\/\/\S+$/.test(heroForm.trim()) && !heroBroken && (
            <img
              src={heroForm.trim()}
              alt="Hero preview"
              className="mt-3 w-full h-32 object-cover rounded-lg border"
              style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}
              onError={() => setHeroBroken(true)}
            />
          )}
          {heroForm.trim() && /^https:\/\/\S+$/.test(heroForm.trim()) && heroBroken && (
            // role="alert" so a screen reader announces the load failure — the
            // preview <img> is silent to AT, so without this the only signal
            // that the URL is bad is the missing picture. Matches this file's
            // MCP-URL validation (role="alert" on reject, below).
            <p role="alert" className="text-xs text-gray-400 mt-3">Couldn&apos;t load that image — check the URL.</p>
          )}

          {/* 📝 Tagline — custom subtitle under the tiny's name (replaces the generic "A tiny — a living AI at …" line) */}
          <div className="mt-5">
            <label htmlFor="tinyTagline" className="block text-xs font-semibold text-white mb-1.5">
              Tagline (Optional)
            </label>
            <input
              type="text"
              name="tinyTagline"
              id="tinyTagline"
              value={taglineForm}
              maxLength={200}
              onChange={(e) => setTaglineForm(e.target.value)}
              className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500"
              placeholder="A living AI that knows my work inside out."
            />
            <p className="text-xs text-gray-400 mt-2">
              A short line shown under your tiny&apos;s name on its landing page — your own words instead of the generic &quot;A tiny — a living AI at …&quot; line. Leave blank for the default.
            </p>
          </div>

          {/* 🎙️ Live-call voice — the OpenAI Realtime voice this tiny speaks with on 📞 calls */}
          <div className="mt-5">
            <label htmlFor="tinyVoice" className="block text-xs font-semibold text-white mb-1.5">
              Live-call voice (Optional)
            </label>
            <select
              name="tinyVoice"
              id="tinyVoice"
              value={voiceForm}
              onChange={(e) => setVoiceForm(e.target.value)}
              className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none"
            >
              <option value="" className="bg-black">Inherit (caller&apos;s voice, else marin)</option>
              {["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"].map((v) => (
                <option key={v} value={v} className="bg-black">{v}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-2">
              The voice this tiny speaks with on a live voice call (📞) — everyone who calls it hears this. Leave on &quot;Inherit&quot; to use each caller&apos;s own default voice.
            </p>
          </div>

          {/* 🎭 Logo — media shown centered above the tiny's name on its landing hero */}
          <div className="mt-5">
            <label htmlFor="tinyLogo" className="block text-xs font-semibold text-white mb-1.5">
              Logo (Optional)
            </label>
            <input
              type="url"
              name="tinyLogo"
              id="tinyLogo"
              value={logoForm}
              onChange={(e) => { setLogoForm(e.target.value); setLogoBroken(false); }}
              className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500"
              placeholder="https://example.com/logo.svg"
            />
            <p className="text-xs text-gray-400 mt-2">
              Shown above your tiny&apos;s name on its landing page. https URLs only — svg, gif, png, jpg, webp, mp4 and webm all work.
            </p>
            {logoForm.trim() && /^https:\/\/\S+$/.test(logoForm.trim()) && !logoBroken && (
              isVideoUrl(logoForm.trim()) ? (
                <video
                  src={logoForm.trim()}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="mt-3 h-24 mx-auto rounded-lg border object-contain"
                  style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}
                  onError={() => setLogoBroken(true)}
                />
              ) : (
                <img
                  src={logoForm.trim()}
                  alt="Logo preview"
                  className="mt-3 h-24 mx-auto rounded-lg border object-contain"
                  style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}
                  onError={() => setLogoBroken(true)}
                />
              )
            )}
            {logoForm.trim() && /^https:\/\/\S+$/.test(logoForm.trim()) && logoBroken && (
              // role="alert" — same reason as the hero preview above: the
              // failed <img>/<video> is silent to AT, so announce the bad URL.
              <p role="alert" className="text-xs text-gray-400 mt-3">Couldn&apos;t load that logo — check the URL.</p>
            )}
          </div>

          {/* 📳 Intro vibe — haptic greeting played when the tiny opens on mobile */}
          <div className="mt-5">
            <label htmlFor="tinyIntroVibe" className="block text-xs font-semibold text-white mb-1.5">
              Intro Vibe (Optional)
            </label>
            <select
              name="tinyIntroVibe"
              id="tinyIntroVibe"
              value={introVibeForm}
              onChange={(e) => setIntroVibeForm(e.target.value)}
              className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none"
              style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}
            >
              <option value="" className="bg-black">None</option>
              {INTRO_VIBES.map((v) => (
                <option key={v} value={v} className="bg-black">{v}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-2">
              A haptic pattern visitors feel when your tiny opens on mobile apps. Browsers ignore it.
            </p>
          </div>

          {/* 💬 Starter chips — replace the default suggestion chips on the landing hero */}
          <div className="mt-5">
            <div className="block text-xs font-semibold text-white mb-1.5">
              Starter Chips (Optional)
            </div>
            <div className="space-y-2">
              {chipsForm.map((chip, i) => (
                <input
                  key={i}
                  type="text"
                  value={chip}
                  maxLength={60}
                  onChange={(e) => setChipsForm((prev) => prev.map((c, j) => (j === i ? e.target.value : c)))}
                  className="w-full border bg-transparent text-white px-4 py-2.5 rounded-lg focus:outline-none placeholder-gray-500"
                  placeholder={i === 0 ? 'What can you do?' : `Chip ${i + 1} (optional)`}
                  aria-label={`Starter chip ${i + 1}`}
                />
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Up to 4 tappable suggestions shown before the first message — they replace the defaults. End one with &quot;…&quot; to pre-fill the composer instead of sending.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="tinyAccent" className="block text-xs font-semibold text-white mb-1.5">Accent color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  id="tinyAccent"
                  value={/^#[0-9a-fA-F]{6}$/.test(tinyAccentForm) ? tinyAccentForm : '#00FF88'}
                  onChange={(e) => setTinyAccentForm(e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border"
                  style={{ borderColor: 'rgba(255,255,255,0.18)' }}
                />
                <input
                  type="text"
                  value={tinyAccentForm}
                  onChange={(e) => setTinyAccentForm(e.target.value)}
                  placeholder="#00FF88"
                  maxLength={7}
                  className="w-24 border bg-transparent text-white px-2 py-2 rounded-lg text-sm font-mono focus:outline-none placeholder-gray-600"
                  style={{ borderColor: 'rgba(255,255,255,0.18)' }}
                  aria-label="Accent hex"
                />
              </div>
            </div>
            <div>
              <label htmlFor="tinyBg" className="block text-xs font-semibold text-white mb-1.5">Background color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  id="tinyBg"
                  value={/^#[0-9a-fA-F]{6}$/.test(tinyBgForm) ? tinyBgForm : '#000000'}
                  onChange={(e) => setTinyBgForm(e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border"
                  style={{ borderColor: 'rgba(255,255,255,0.18)' }}
                />
                <input
                  type="text"
                  value={tinyBgForm}
                  onChange={(e) => setTinyBgForm(e.target.value)}
                  placeholder="#000000"
                  maxLength={7}
                  className="w-24 border bg-transparent text-white px-2 py-2 rounded-lg text-sm font-mono focus:outline-none placeholder-gray-600"
                  style={{ borderColor: 'rgba(255,255,255,0.18)' }}
                  aria-label="Background hex"
                />
              </div>
            </div>
            {(tinyAccentForm || tinyBgForm) && (
              <button
                onClick={(e) => { e.preventDefault(); setTinyAccentForm(''); setTinyBgForm(''); }}
                className="px-3 py-2 rounded-lg text-xs border text-gray-400 transition-colors hover:text-white"
                style={{ borderColor: 'rgba(255,255,255,0.18)' }}
              >
                Reset colors
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Visitors see these colors on your tiny&apos;s page by default (their own theme choice still wins).
          </p>
        </div>

        {/* MCP Servers */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="tinyMcp" className="block text-sm font-semibold text-white mb-2 flex items-center gap-2">
            MCP Servers (Optional)
            {/* Announce live validity as the user edits — a blind user pasting
                MCP JSON otherwise gets no signal that it's valid or why it's
                rejected. Valid = polite status; error = assertive alert. */}
            {mcpForm.trim() && !mcpError ? (
              <span role="status" className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' }}>✓ VALID</span>
            ) : null}
            {mcpError ? (
              <span role="alert" className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(var(--tiny-danger-rgb),0.15)', color: 'var(--tiny-danger)' }}>{mcpError}</span>
            ) : null}
          </label>
          <textarea
            name="tinyMcp"
            id="tinyMcp"
            rows={6}
            value={mcpForm}
            onChange={(e) => {
              const v = e.target.value;
              setMcpForm(v);
              if (!v.trim()) { setMcpError(""); return; }
              try {
                const parsed = JSON.parse(v);
                const entries = parsed?.mcpServers ?? parsed;
                if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
                  setMcpError("must be an object of servers"); return;
                }
                for (const [k, sv] of Object.entries(entries as Record<string, any>)) {
                  if (!sv || typeof sv !== "object" || typeof sv.url !== "string") {
                    setMcpError(`'${k}' needs a url`); return;
                  }
                  if (!sv.url.startsWith("https://")) {
                    setMcpError(`'${k}' url must be https`); return;
                  }
                }
                setMcpError("");
              } catch { setMcpError("invalid JSON"); }
            }}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500 font-mono text-xs"
            placeholder={'{\n  "my-tools": {\n    "url": "https://my-mcp-server.com/mcp",\n    "headers": { "Authorization": "Bearer sk-..." }\n  }\n}'}
          />
          <p className="text-xs text-gray-400 mt-2">
            Plug any remote <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="hover:opacity-80" style={{ color: 'var(--tiny-accent)' }}>MCP server</a> (streamable-http) into your tiny — its tools become your tiny's tools.
            <span className="font-semibold"> Headers are private:</span> only you (the owner) can see them; other users get a redacted view.
          </p>
        </div>

        {/* Worker */}
        <div className="border rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)', borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
          <label htmlFor="tinyWorker" className="block text-sm font-semibold text-white mb-2 flex items-center gap-2">
            {/* Announce validity when it flips on blur-validation — mirrors the
                MCP field's ✓ VALID role="status" above. The success path has no
                toast, so without this a blind user pasting a worker URL gets no
                signal it validated. INACTIVE is the resting default (not an
                async failure), so it stays unannounced — only the ACTIVE flip
                is news. */}
            Worker API {isWorkerActive ? <span role="status" className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(var(--tiny-accent-rgb),0.2)', color: 'var(--tiny-accent)' }}>✓ ACTIVE</span> : <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(128,128,128,0.2)', color: '#888' }}>INACTIVE</span>}
          </label>
          <input
            type="url"
            name="tinyWorker"
            id="tinyWorker"
            value={workerForm}
            onBlur={handleBlurFormWorker}
            onChange={(e) => setWorkerForm(e.target.value)}
            className="w-full border bg-transparent text-white px-4 py-3 rounded-lg focus:outline-none placeholder-gray-500"
            placeholder="https://your-api.com/openapi.json"
          />

          {Object.keys(APISchema || {}).length > 0 ? (
            <div className="mt-4 p-4 bg-black/30 rounded-lg">
              <h4 className="text-sm font-semibold text-white mb-3">Worker Details</h4>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-gray-400">Host:</span>{' '}
                  <span className="text-gray-300 break-all">{workerForm.split('/').slice(0, 3).join('/')}</span>
                </div>
                <div>
                  <span className="text-gray-400">Endpoints:</span>{' '}
                  {/* break-words like the Host row above: paths come from the
                      worker's OpenAPI — a long single path with no break
                      opportunities would otherwise push the Worker Details box
                      wider than the settings panel. */}
                  <span className="text-gray-300 break-words">{paths.join(', ')}</span>
                </div>
                <div className="mt-4 space-y-3">
                  <h5 className="text-gray-400 font-semibold">Functions:</h5>
                  {workerFns.map((func: any) => (
                    <div key={func.name} className="pl-3 border-l-2 border-gray-700">
                      <div className="font-mono" style={{ color: 'var(--tiny-accent)' }}>{func.name}</div>
                      <div className="text-gray-400 mt-1">{func.description}</div>
                      {Object.keys(func.parameters.properties).length > 0 && (
                        <div className="text-gray-400 mt-1">
                          Params: {Object.keys(func.parameters.properties).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 p-4 bg-black/20 rounded-lg text-xs text-gray-400 space-y-2">
              <p>Connect your worker to extend your AI's capabilities with custom functions.</p>
              <div className="pt-2">
                <p className="font-semibold text-gray-300 mb-2">Quick Setup:</p>
                <ol className="list-decimal list-inside space-y-1 ml-2">
                  <li>Deploy your worker: <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/TinyAI-ID/tiny-ai-worker" className="hover:opacity-80" target="_blank" rel="noopener noreferrer">Deploy to Cloudflare</a></li>
                  <li>Enter your OpenAPI.json URL above (<a href="https://plugin.tiny.technology/openapi.json" className="hover:opacity-80" target="_blank" rel="noopener noreferrer">example</a>)</li>
                </ol>
              </div>
            </div>
          )}
        </div>

        {/* Save Button */}
        <button
          disabled={saving || (activeForm && me?.authenticated === true && !ownsThisTiny)}
          onClick={(e) => {
            e.preventDefault();
            // Validate BEFORE announcing — "Saving..." followed by a
            // validation error reads as a failed save, not a rejected form
            if (nameForm?.length === 0) {
              toast.error("Name is required.");
              return;
            }
            if (systemPromptForm?.length === 0) {
              toast.error("First message is required.");
              return;
            }
            if (!me?.authenticated) {
              toast.error("Sign in with GitHub first — it's free!");
              return;
            }
            // Someone else's existing tiny — the worker rejects this save.
            // Say so here instead of firing a request that dead-ends.
            if (activeForm && !ownsThisTiny) {
              toast.error(`${nameForm} belongs to another account — pick a name you own or a free one.`);
              return;
            }

            if (mcpError) {
              toast.error(`Fix MCP config first: ${mcpError}`);
              return;
            }
            // 🎯 Subject check (v12). Everything below — prompt, knowledge,
            // worker, skills, chips, theme, MCP servers — was loaded FOR one
            // tiny, while the request addresses whatever the name field says
            // now. Only fire when those agree; a mismatch writes one tiny's
            // content onto another and reports success.
            const subject = gateSubjectMutation('save', { loaded: loadedNameRef.current, form: nameForm });
            if (!subject.ok) {
              toast.error(subject.message);
              return;
            }
            let mcpServers: any = undefined;
            if (mcpForm.trim()) {
              try {
                const parsed = JSON.parse(mcpForm);
                mcpServers = parsed?.mcpServers ?? parsed;
              } catch { /* validated above */ }
            } else {
              mcpServers = null; // explicit clear
            }

            toast(activeForm ? "Saving your AI..." : "Creating your AI...");
            setSaving(true);

            const tinyName = nameForm.toLowerCase();
            fetch(`/api/control`, {
              method: "POST",
              headers: { accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({
                name: tinyName,
                systemPrompt: systemPromptForm,
                systemKnowledge: systemKnowledgeForm,
                priv: privateForm,
                data: dataForm,
                hook: hookForm,
                // '' = explicit clear (worker preserves undefined, overwrites '')
                hero: heroForm.trim(),
                tagline: taglineForm.trim(),
                // '' = inherit (caller's account voice, else marin)
                voice: voiceForm,
                logo: logoForm.trim(),
                intro_vibe: introVibeForm,
                // [] = explicit clear (proxy stringifies; worker treats [] as clear)
                chips: chipsForm.map((c) => c.trim()).filter(Boolean),
                theme: (tinyAccentForm || tinyBgForm)
                  ? { ...(tinyAccentForm ? { accent: tinyAccentForm } : {}), ...(tinyBgForm ? { bg: tinyBgForm } : {}) }
                  : "",
                worker: workerForm,
                schema: APISchema,
                skills: skills,
                ...(mcpServers !== undefined ? { mcpServers } : {}),
              }),
              // Without a deadline a hung worker leaves "Saving…" frozen — the
              // .finally that clears setSaving never runs (house rule).
              signal: AbortSignal.timeout(10_000),
            })
              .then((response) => response.json())
              .then((data) => {
                if (!data.name) {
                  // `message` is this route's own field; `error` is the shared
                  // limiter's (lib/rate-limit.ts) — a 429 here carries the
                  // reputation sentence and used to toast `undefined`.
                  toast.error(data.message || data.error || "Couldn't save — try again.");
                  return;
                }
                // A bare window.open() here is inside the fetch .then — no
                // longer in the synchronous user-gesture context, so browsers
                // popup-block it and "saved!" dead-ends with no tab. Surface a
                // persistent toast whose action opens the tiny from a real
                // click gesture (never blocked).
                toast("Tiny AI saved! 🎉", {
                  duration: 8000,
                  action: {
                    label: "View your tiny →",
                    onClick: () => window.open(`/${data.name}`, "_blank"),
                  },
                });
              })
              .catch((error) => {
                console.error("Error:", error);
                toast.error("Error on our end. Please try again.");
              })
              .finally(() => setSaving(false));
          }}
          className="w-full relative overflow-hidden font-bold py-4 px-6 rounded-xl transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100 disabled:cursor-wait"
          style={{
            background: 'var(--tiny-accent)',
            color: '#000',
            boxShadow: '0 0 20px rgba(var(--tiny-accent-rgb),0.3)'
          }}
        >
          <div className="relative z-10 flex items-center justify-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {saving ? 'Saving…' : (activeForm && me?.authenticated && !ownsThisTiny) ? 'Owned by someone else' : activeForm ? 'Save Changes' : 'Create AI'}
          </div>
        </button>

        {/* 🗑️ Danger zone — owners only, existing tinys only */}
        {activeForm && ownsThisTiny && (
          <button
            onClick={async (e) => {
              e.preventDefault();
              if (!(await confirm({
                title: "Delete this tiny forever?",
                message: `This permanently deletes ${nameForm} — config, search index, everything. Type the name below to confirm.`,
                confirmLabel: "Delete forever",
                danger: true,
                requireText: nameForm,
                requirePlaceholder: nameForm,
              }))) return;
              setDeletingTiny(true);
              fetch(`/api/delete`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: nameForm }),
                signal: AbortSignal.timeout(10_000),
              })
                .then((r) => r.json())
                .then((d) => {
                  if (d.ok) {
                    toast("🗑️ Deleted forever");
                    // "config, search index, everything" — including every key
                    // this browser holds for it (v5 D4). Removing only the
                    // transcript left the continuity turn log and memories
                    // behind, and those are injected into EVERY request as
                    // "survives resets": re-register the name and a new
                    // persona inherits a stranger's past. The inventory lives
                    // in lib/chat/local-keys so the next key family added
                    // can't miss this path again.
                    purgeTinyKeys({ local: localStorage, session: sessionStorage }, nameForm);
                    window.location.href = "/";
                  } else { toast.error(d.error || "Couldn't delete — try again"); setDeletingTiny(false); }
                })
                .catch(() => { toast.error("Couldn't delete — try again"); setDeletingTiny(false); });
            }}
            disabled={deletingTiny}
            className="w-full py-3 px-6 rounded-xl text-sm transition-all border hover:bg-[rgba(var(--tiny-danger-rgb),0.12)] hover:border-[rgba(var(--tiny-danger-rgb),0.5)] disabled:opacity-60"
            style={{ background: 'rgba(var(--tiny-danger-rgb),0.06)', borderColor: 'rgba(var(--tiny-danger-rgb),0.3)', color: 'var(--tiny-danger)' }}
          >
            {deletingTiny ? 'Deleting…' : 'Delete this tiny permanently'}
          </button>
        )}
      </div>
    </div>
    {dialog}
  </div>
}