"use client";

import { IconMoon, IconSparkles, IconLock } from "./icons";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import copy from "copy-to-clipboard";
import { toast, Toaster } from "sonner";
import "katex/dist/katex.min.css";
// Async-light build: language grammars code-split + fetched on demand at
// first highlight instead of ALL of Prism's languages riding the main
// chat bundle. Unknown languages still fall back to plain text.
// a11y-dark: WCAG-contrast dark theme — coy (light, white bg) was a
// blinding block inside dark bubbles
import nextDynamic from "next/dynamic";
// Lazy: DynamicUI closes over ALL of recharts — load it only when an
// agent actually render_ui's something; most conversations never do.
const DynamicUI = nextDynamic(() => import("./DynamicUI"), { ssr: false });
// 💳 In-chat top-up overlay — lazy (money UI is off the first-paint path).
const WalletSheet = nextDynamic(() => import("./WalletSheet"), { ssr: false });
// Settings/memory/jobs/palette panels — ~3,500 lines of component code that
// render null until opened; lazy like DynamicUI/WalletSheet so first paint
// of / and /[slug] doesn't parse them. (UniverseDrawer stays static: it owns
// its always-visible header trigger — ssr:false would pop it in late.)
// The pure config half lives in lib/chat/model-config (send() needs it sync).
const ModelSettings = nextDynamic(() => import("./ModelSettings"), { ssr: false });
const MemoryPanel = nextDynamic(() => import("./MemoryPanel"), { ssr: false });
const JobsPanel = nextDynamic(() => import("./JobsPanel"), { ssr: false });
const CommandPalette = nextDynamic(() => import("./CommandPalette"), { ssr: false });
import { loadModelConfig, modelConfigHeaders } from "../../lib/chat/model-config";
import { isAuthed, whoami } from "../../lib/chat/whoami";
import { ownsTiny, mayRunPageJs } from "../../lib/chat/page-code-trust";
import { useAuthValue } from "../../lib/chat/use-auth-value";
import { shouldRelock } from "../../lib/chat/auth-events";
import { shouldSendOnEnter } from "../../lib/chat/composer";
import { dropTurnPair, dropTurnPairAt } from "../../lib/chat/turns";
import { persistTranscript, deriveChatMeta, chatMetaKey, parseChatMeta, shouldAdoptPersisted, shouldWriteTranscript } from "../../lib/chat/persist";
import { draftKey, draftWrite, draftRestore } from "../../lib/chat/draft";
import { gateSend, describeStreamFailure, failureBannerLabel } from "../../lib/chat/connectivity";
import { restoreAttachments } from "../../lib/chat/composer-restore";
import { pendingAttachmentsKey, receiptFor, parseReceipt, describeLostAttachments } from "../../lib/chat/pending-attachments";
import { usePrintDetails } from "../../lib/chat/use-print-details";
import { usd, usdRate } from "../../lib/utils";
import { EXTERNAL_MS, deadlineFor, fetchWithDeadline, isDeadlineError, isTaggedDeadline } from "../../lib/deadlines";
import { decideDeepLink, stripDeepLinkParams } from "../../lib/chat/deep-link";
import { decideOpenUrl, OPEN_URL_BLOCKED_NOTE, OPEN_URL_BLOCKED_TOAST, OPEN_URL_BLOCKED_ACTION } from "../../lib/chat/open-url";
import { decideClipboardWrite, clipboardConfirmToast, clipboardNote, CLIPBOARD_DENIED_TOAST, CLIPBOARD_DENIED_NOTE } from "../../lib/chat/clipboard-write";
import { useConfirm } from "./ConfirmDialog";
import { trySlashCommand as runSlashCommand, PALETTE_COMMANDS } from "../../lib/chat/slash-commands";
import { walletAction, priceMicroOf } from "../../lib/x402/wallet-client";
import MarkdownContent from "./MarkdownContent";
import {
  appendTurn,
  buildContinuityContext,
  addMemory,
  forgetMemoryOutcome,
  getMemories,
  clearMemories,
  clearTurnLog,
} from "./continuity";
import { registerServiceWorker, enablePush, TabMesh } from "./platform";
import AuthButton from "./AuthButton";
import ActivityHUD from "./ActivityHUD";
import MessagesHUD from "./MessagesHUD";
import TaskTree from "./TaskTree";
import PayReceipt from "./PayReceipt";
import UniverseDrawer from "./UniverseDrawer";
// 🎙️ Voice mode (on-device): whisper STT + VAD auto-send live in
// lib/voice/live.ts; kokoro TTS + playback state in lib/voice/tts.ts
// (speechSynthesis fallback inside). The old Web-Speech dictation
// (./voice) is superseded — tts.ts still uses it as the fallback voice.
import { startLiveVoice, liveVoiceSupported, type LiveVoiceHandle } from "../../lib/voice/live";
// 📞 Inline voice call (real S2S over the worker's VoiceSession DO) — the
// call lives IN this chat: transcripts land in the thread, typed composer
// text joins the call. Aliased so it can't clash with other Voice* symbols.
import { VoiceCall as LiveCall } from "../../lib/voice/realtime";
import { playSpeech, stopSpeech, getSpeechState, subscribeSpeech } from "../../lib/voice/tts";
import SpeechCard from "./SpeechCard";
import { createSSEDecoder, createSeqTracker } from "../../lib/sse";
import { geoWatcher, mergeLocationMeta, type GeoFix } from "../../lib/geo";
import { tinyMapBridge } from "../MapBackground";
import { mapEnabled, setMapEnabled, subscribeMapEnabled } from "../../lib/map-pref";
import { applyStrandsEvent, applyMessageSurgery, type StrandsEffect } from "../../lib/chat/strands-events";
import { createStreamRegistry, buildTurnHistory, type StreamRegistry } from "../../lib/chat/stream-registry";
import ReplayBar from "./ReplayBar";
import { estimateCost, formatCost } from "../../lib/model-pricing";
import { kgRecall } from "./kg";
import { webllmStream, WEBLLM_MODELS } from "../../lib/webllm";
import InstallPrompt from "./InstallPrompt";
import { AmbientRunner, consumeAmbientFindings, type AmbientState } from "./ambient";
import { isBangExpr, runBang } from "./bang";
import { downloadArchive, pickAndLoadArchive, sanitizeMessages, shareSnapshot, reconcileInterruptedTools } from "../../lib/session-archive";
import { compact } from "../../lib/community";
import {
  applyTheme, resolveTheme, saveThemeLocal, loadThemeLocal, loadThemeRemote,
  applyCustomCss, saveCustomCssLocal, loadCustomCssLocal,
  runCustomJs, saveCustomJsLocal, loadCustomJsLocal,
  isCustomJsApproved, approveCustomJs, loadCustomizationRemote,
} from "../../lib/theme";
import {
  ingestFiles,
  buildContentBlocks,
  attachmentsPayloadBytes,
  persistableAttachments,
  MAX_PAYLOAD_BYTES,
  type Attachment,
} from "../../lib/file-attachments";

export type Message = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  uiComponents?: UIComponent[];
  /** 🔊 speak tool calls — playback cards (text + voice, audio re-synthesized on demand) */
  speech?: SpeechItem[];
  followups?: string[];
  /** 📎 Photos/documents shared with the agent (base64 stripped on persist) */
  attachments?: Attachment[];
  /** Stream failed — holds the user prompt so it can be retried */
  failedPrompt?: string;
  /** 💸 Paywall (HTTP 402): this priced tiny needs a funded wallet. Renders an
   *  in-chat payment card (price + balance + Add funds + Retry) instead of a
   *  generic "connection lost" error. `prompt` re-sends once funded. */
  paywall?: { priceMicro: number; balanceMicro: number; signedOut: boolean; prompt: string };
  /** Token usage from the provider (modelMetadataEvent) */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens?: number };
  /** Resolved model id for this turn — drives the $ cost estimate */
  modelId?: string;
};

type ToolCall = {
  id: string;
  name: string;
  input?: any;
  status: 'calling' | 'success' | 'error';
  result?: any;
  error?: string;
  /** pay_x402 ONLY: the terminal outcome of the user's Approve/Decline tap,
   * persisted so a reload shows the receipt — not a dead expired-quote card
   * that invites paying the counterparty twice (C3). Settlement lives in
   * PayReceipt's local state (the tap, not the stream, triggers it), so it must
   * be written back here to survive localStorage. Only paid/pending/declined
   * persist; a failed attempt moved no money and its quote may still be
   * spendable, so a reload re-offers approval. Mirrors iOS PayQuoteItem.settled. */
  paySettled?: { phase: 'paid' | 'pending' | 'declined'; result?: any; error?: string };
};

type UIComponent = {
  id: string;
  componentCode?: string; // Dynamic React code
  props?: any;
  title?: string;
};

type SpeechItem = {
  id: string; // toolUseId
  text: string;
  voice?: string;
};

// Session id doubles as the cross-tab ring key on the worker (ring:<session>),
// which is keyed purely on this value. A Date.now()-based id is trivially
// guessable, so a random id keeps one client's ring from being read/poisoned
// by guessing a timestamp. Falls back to time+random if crypto is unavailable.
const clientId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `tinyai-${crypto.randomUUID()}`
    : `tinyai-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function Chat({
  systemPrompt,
  name,
  systemKnowledge,
  query,
  metadata,
  priv,
  tiny,
  unclaimed,
}: {
  systemPrompt: string;
  name: string;
  systemKnowledge: string;
  query?: string;
  metadata: any;
  priv?: boolean;
  tiny: any;
  /** Rendered from NotFound — the name has no tiny behind it (yet) */
  unclaimed?: boolean;
}) {
  const [session] = useState(clientId);
  const [key, setKey] = useState("");
  const [isAuthorized, setIsAuthorized] = useState(false);
  // Synchronous mirror of isAuthorized — the auto-unlock effect + its
  // `tiny:auth` re-probe read it without re-subscribing on every auth change
  // (avoids re-probing an already-vouched session).
  const isAuthorizedRef = useRef(false);
  useEffect(() => { isAuthorizedRef.current = isAuthorized; }, [isAuthorized]);
  // 🔒 Does the signed-in visitor OWN this tiny? Gates `customize_page`'s
  // arbitrary JS at the point of execution (lib/chat/page-code-trust.ts).
  //
  // A ref, not state, and deliberately so: the check runs inside
  // runStrandsEffects, which reads live stream events — it needs the current
  // value synchronously, not a render-cycle-old closure. Starts FALSE, which is
  // the safe answer while the probe is in flight.
  //
  // NOT `isAuthorized` (that means "this tab may talk to a private tiny",
  // which a shared legacy key also grants) and not the server's mount decision
  // either: the effect that runs this code is emitted from
  // beforeToolCallEvent, before the server callback runs, so the client must
  // decide for itself.
  const ownsThisTinyRef = useRef(false);
  useEffect(() => {
    let alive = true;
    ownsThisTinyRef.current = false;  // re-probe per tiny; never inherit the last one's answer
    const probe = () => {
      whoami().then((me) => {
        if (!alive) return;
        const owned = Array.isArray(me?.tinys) ? (me.tinys as unknown[]) : [];
        ownsThisTinyRef.current = ownsTiny(name, owned.map((t: any) => t?.name));
      }).catch(() => { /* stays false — fail closed */ });
    };
    probe();
    // Passkey/GitHub sign-in lands client-side with no reload (same signal the
    // private-mode unlock listens for), so an owner who signs in mid-session
    // must stop being refused.
    const onAuth = () => probe();
    window.addEventListener("tiny:auth", onAuth);
    return () => { alive = false; window.removeEventListener("tiny:auth", onAuth); };
  }, [name]);
  // Concurrent turns (docs/concurrent-sends-implementation.md, Option B):
  // the set of assistant-message ids currently streaming. The registry ref
  // is the synchronous authority (claim happens before any await); this
  // state is its render mirror.
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const [showModelSettings, setShowModelSettings] = useState(false);
  // 💳 In-chat wallet top-up sheet — opened from a paywall card or the composer
  // price badge, so a priced tiny funds inline instead of a full-page /wallet nav.
  const [showWallet, setShowWallet] = useState(false);
  // 💵 Up-front price: a paid tiny's per-message price (micro-USDC), so the
  // paywall is never a surprise. null = free / unpriced / not yet loaded.
  const [priceMicro, setPriceMicro] = useState<number | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  // 🧬 Memory panel — inline chips w/ freshness + history
  const [showMemory, setShowMemory] = useState(false);
  const [showJobs, setShowJobs] = useState(false);

  // Edit state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // Viewing someone's shared conversation — read-only until "Continue here"
  // (prevents the snapshot from clobbering the visitor's own saved history)
  const [viewingShare, setViewingShare] = useState(false);
  // The cross-tab adopt handler is built once per `name` (mount effect), so it
  // can't read the viewingShare STATE — a visitor who opened a share link
  // after mount would keep a stale `false` and have the shared snapshot
  // replaced under them by a peer's history. Ref, updated below.
  const viewingShareRef = useRef(false);
  useEffect(() => { viewingShareRef.current = viewingShare; }, [viewingShare]);
  // 🎬 Replay scrubber (issue #7): null = off; otherwise messages shown so far
  const [replayVisible, setReplayVisible] = useState<number | null>(null);
  // 📖 Seeded knowledge message (id "1"): clamped to ~3 lines until expanded
  // (design agenda item 4 — a wall of reference text shouldn't open the chat)
  const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
  // 📈 Hero social proof (item 5): "1.9M" style compact message count.
  // Home page only, and only while the hero can still render (turn zero) —
  // no point fetching stats for a hero that a saved conversation replaced.
  const [heroStats, setHeroStats] = useState<string | null>(null);
  useEffect(() => {
    if (name !== "tiny") return;
    if (localStorage.getItem(`chat_messages_${name}`)) return;
    // limit=1: the deployed worker returns a true COUNT(*) totalUsers
    // (community.ts 67efafb, verified live) independent of ?limit, so
    // one row is enough for the count. 60s-cached worker-side.
    // Direct call to the worker host — no route of ours in the middle, so this
    // deadline IS the only budget (EXTERNAL_MS). CommandPalette/UniverseDrawer
    // already capped their calls to the same host by hand; these two were the
    // holdouts.
    fetch("https://plugin.tiny.technology/community?limit=1", { signal: AbortSignal.timeout(EXTERNAL_MS) })
      .then((r) => r.json())
      .then((d) => {
        const n = Number(d.totalUsers) || 0;
        // ≥2: "1 users" is both broken grammar and anti-proof
        if (n >= 2) setHeroStats(compact(n));
      })
      .catch(() => { });
  }, [name]);

  // 💵 Up-front price signal: fetch this tiny's per-message price once so the
  // composer can warn BEFORE a send hits the 402 paywall. Public read-only
  // lookup (no session needed); unclaimed names have no resource to price.
  useEffect(() => {
    if (!name || unclaimed) return;
    let alive = true;
    // Clear any prior tiny's price first: this effect re-runs on `name`, but
    // setPriceMicro only ever SET a nonzero price — so navigating from a paid
    // tiny to a free one (or a lookup that fails) left the old paid badge
    // stranded over the new tiny. Reset to null so the badge reflects only the
    // tiny currently being priced, and reappears only if THIS lookup finds > 0.
    setPriceMicro(null);
    // Signed out, /api/wallet is a guaranteed 401 (c12 anon-visit QA) and
    // the badge never showed anon anyway — skip via the shared probe.
    isAuthed().then((ok) => {
      if (!ok || !alive) return;
      walletAction({ action: "pricing", resource: `tiny:${name.toLowerCase()}` })
        .then((d) => { if (alive) { const p = priceMicroOf(d); if (p > 0) setPriceMicro(p); } })
        .catch(() => { });
    });
    return () => { alive = false; };
  }, [name, unclaimed]);

  const controllersRef = useRef<Record<string, AbortController>>({});
  const streamsRef = useRef<StreamRegistry | null>(null);
  if (!streamsRef.current) {
    streamsRef.current = createStreamRegistry(undefined, setLiveIds);
  }
  const streams = streamsRef.current;
  const genId = () =>
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [input, setInput] = useState("");

  // 🏷️ Endowment moment (design item 6): typing "create an ai named X"
  // shows a live tiny.technology/X availability preview — the name feels
  // claimed before it exists. Debounced probe against /get.
  const [namePreview, setNamePreview] = useState<{ slug: string; free: boolean } | null>(null);
  const namePreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Id of the paywall bubble whose "💳 Add funds" opened the wallet sheet, so a
  // successful top-up auto-continues the held turn instead of dropping the user
  // back onto a now-stale paywall card (the funded-path analog of the iOS
  // signed-out auto-retry). Only set from the paywall card — badge/`/wallet`
  // openers leave it null so onFunded is a plain refresh there. Cleared on use.
  const paywallAwaitingFundsRef = useRef<string | null>(null);
  // Claim honesty: signed out, the free-name banner used to promise "send to
  // claim it" — then the agent replied "Login required" and the user had to sign
  // in AND re-type. So the banner offers sign-in up front, carrying the draft as
  // ?q=&send=0 so it survives the OAuth round-trip.
  //
  // v6 E3: this probe was latched by a ref — once per mount. Login is
  // client-side, so taking the banner's OWN sign-in offer left it still offering
  // it. useAuthValue re-reads on `tiny:auth` (through the shared cache, so still
  // no extra request); `when` defers the read until a free name is previewed.
  const claimAuthed = useAuthValue((d) => !!d?.user, { when: !!namePreview?.free });
  useEffect(() => {
    // "create/make/build … named/called/name X" — first capture wins
    const m = input.match(/\b(?:create|make|build)\b.{0,40}?\b(?:named|called|name)\s+["']?([a-zA-Z0-9][a-zA-Z0-9-_]{1,30})["']?/i);
    if (namePreviewTimer.current) clearTimeout(namePreviewTimer.current);
    // All setState goes through the timer — never synchronously in the effect
    if (!m) {
      namePreviewTimer.current = setTimeout(() => setNamePreview(null), 0);
      return () => { if (namePreviewTimer.current) clearTimeout(namePreviewTimer.current); };
    }
    const slug = m[1].toLowerCase();
    // The debounce only prevents overlap WHILE counting down; once the fetch has
    // fired it is in flight and unaborted. Without this guard a slower response
    // for an earlier name can resolve AFTER a newer one and commit a stale slug —
    // the claim CTA below would then point at "tiny.technology/<old slug>" while
    // the composer already reads a different name. `cancelled` flips in cleanup
    // (which runs on every `input` change), so a superseded fetch is ignored.
    let cancelled = false;
    namePreviewTimer.current = setTimeout(() => {
      fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(EXTERNAL_MS) })
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setNamePreview({ slug, free: typeof d?.response === "string" }); })
        .catch(() => { if (!cancelled) setNamePreview(null); });
    }, 450);
    return () => { cancelled = true; if (namePreviewTimer.current) clearTimeout(namePreviewTimer.current); };
  }, [input]);

  // 📎 Pending attachments (photos/documents) staged in the composer
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Image attachments whose src failed to load (corrupt/evicted dataUrl after a
  // restore). Tracked in React state — keyed by `${msg.id}:${attIndex}` — so the
  // "unavailable" fallback renders through React. The old handler did
  // `el.outerHTML = "<span…>"`, an imperative DOM swap React holds NO fiber
  // reference to: React still thinks an <img> sits there, so the next
  // reconciliation that removes/reorders that message (routine under streaming +
  // concurrent sends) calls removeChild on a node the parent no longer owns →
  // NotFoundError → render crash → route error boundary → blank page.
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // 🎙️ Voice mode (COMPARISON.md §2.14, upgraded on-device): the mic keeps
  // an always-open transcription loop — whisper in a worker, VAD-segmented;
  // a 3s pause sends the utterance as a message (concurrent turns already
  // exist, so speaking WHILE the agent streams just becomes another turn and
  // the context keeps growing with the voice).
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"listening" | "speech" | "transcribing">("listening");
  const [voiceProgress, setVoiceProgress] = useState<string | null>(null);
  const [voicePartial, setVoicePartial] = useState("");
  // Capability resolved in an effect: SSR and first client render must agree
  // on "no mic" or the button is a hydration mismatch (full client re-render).
  const [canVoice, setCanVoice] = useState(false);
  useEffect(() => { setCanVoice(liveVoiceSupported()); }, []);
  const liveVoiceRef = useRef<LiveVoiceHandle | null>(null);
  const voiceModeRef = useRef(false);
  // 📞 Inline voice call (lib/voice/realtime) — distinct from voiceMode
  // above (on-device dictation): this is a live S2S call whose transcripts
  // land in the message thread while the composer stays usable.
  const liveCallRef = useRef<LiveCall | null>(null);
  const [callStatus, setCallStatus] = useState<"off" | "connecting" | "live">("off");
  // 📍 Location context (agi-diy grammar) — while on, the shared watchPosition
  // singleton (lib/geo) feeds a ref, and each send folds coords/speed/heading
  // into x-tiny-metadata via mergeLocationMeta. The pref is the app-wide
  // ambient-map preference (lib/map-pref): GlobalMapBackdrop in the root
  // layout mounts the map + owns html.map-mode; this toggle (and SiteHeader's)
  // just flips the shared pref. Ref not state: a moving device would
  // re-render every GPS tick.
  const [geoOn, setGeoOn] = useState(false);
  const geoFixRef = useRef<GeoFix | null>(null);
  useEffect(() => {
    setGeoOn(mapEnabled());
    return subscribeMapEnabled(setGeoOn);
  }, []);
  useEffect(() => {
    if (!geoOn) { geoFixRef.current = null; return; }
    return geoWatcher.subscribe((fix) => { geoFixRef.current = fix; });
  }, [geoOn]);
  const toggleGeo = () => setMapEnabled(!mapEnabled());
  const [callLevel, setCallLevel] = useState(0);
  // The "reply landed while backgrounded" title-restore listener, tracked so a
  // stale one is removed before a new reply installs another AND so it can't
  // outlive the component (it's added to `document` outside the effect system;
  // if the tab is closed/navigated while still hidden, `restore` never fires).
  const titleRestoreRef = useRef<(() => void) | null>(null);
  // Throttle the mic-level meter to ~10/s — level events fire per audio frame
  const callLevelTsRef = useRef(0);
  // In-flight voice assistant message id + last user utterance (for appendTurn)
  const voiceAsstIdRef = useRef<string | null>(null);
  const voiceLastUserRef = useRef("");
  // Mic level meter: driven via ref + transform, not state — 10Hz setState
  // for a cosmetic bar would re-render the whole transcript
  const voiceLevelRef = useRef<HTMLDivElement | null>(null);
  // onUtterance closures outlive renders — always call the freshest send()
  const sendRef = useRef<(text: string) => void>(() => {});
  // Which message/tool-call is speaking — read from the tts module's store
  // so SpeechCards, read-aloud buttons and autoplay all agree
  const speakingMsgId = useSyncExternalStore(
    subscribeSpeech,
    () => getSpeechState().id,
    () => null
  );

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMessageRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-scroll: follow the stream unless the user scrolled up to read
  const autoScrollRef = useRef(true);
  // Batch streaming updates to one React render per frame — SSE can deliver
  // hundreds of deltas/sec and each setMessages re-parses all markdown
  const flushScheduledRef = useRef(false);
  // 🔗 Cross-tab mesh (agi-diy pattern): presence + shared ring context
  const meshRef = useRef<TabMesh | null>(null);
  // Two tabs on the same tiny share chat_messages_<name> (v4 C5). A tab that
  // has authored nothing since its last sync may adopt a peer's newer
  // snapshot; while it's a mirror of that peer it also stops writing, so its
  // stale in-memory copy can't clobber the turns you're having next door.
  // Decisions live in lib/chat/persist (shouldAdoptPersisted / shouldWriteTranscript).
  const authoredRef = useRef(false);
  const mirroringRef = useRef(false);
  // Authorship is sticky: once this tab owns turns of its own it keeps
  // writing them. Two tabs both being typed into still resolves
  // last-writer-wins — merging divergent transcripts isn't something we can
  // do without inventing an order the user never chose. What C5 fixes is the
  // silent case: a tab nobody touched overwriting the tab they're using.
  const markAuthored = () => {
    authoredRef.current = true;
    mirroringRef.current = false;
  };
  // 🌙 Ambient mode (issue #12): background thinking while the user is idle
  const ambientRef = useRef<AmbientRunner | null>(null);
  const [ambientState, setAmbientState] = useState<AmbientState>("off");
  // 📡 Live connectivity (v5 D3). The retry banner outlives the failure that
  // created it, so it can't read a snapshot taken in the catch — a user who
  // reconnects should stop being told they're offline. SSR-safe default:
  // `true` (the reliable-direction rule means an optimistic default only ever
  // costs us the old generic copy, never a false "you're offline").
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Register SW (PWA/push) + start the tab mesh + ambient runner
  useEffect(() => {
    registerServiceWorker();
    const mesh = new TabMesh(name);
    meshRef.current = mesh;
    // A peer on this tiny saved history: adopt it if this tab has nothing of
    // its own at stake (v4 C5) — otherwise reloading here would show the
    // stale copy this tab is still holding.
    mesh.onPersisted = () => {
      const decision = shouldAdoptPersisted({
        localCount: (messagesRef.current || []).length,
        remoteCount: parseChatMeta(localStorage.getItem(chatMetaKey(name)))?.count ?? null,
        authored: authoredRef.current,
        streaming: (streamsRef.current?.size() ?? 0) > 0,
        viewingShare: viewingShareRef.current,
      });
      if (!decision.adopt) return;
      try {
        const raw = localStorage.getItem(`chat_messages_${name}`);
        if (!raw) return;
        const adopted = reconcileInterruptedTools(sanitizeMessages(JSON.parse(raw)));
        if (adopted.length === 0) return;
        messagesRef.current = adopted;
        setMessages(adopted);
        // Mirror until this tab authors something: see the persist guard.
        mirroringRef.current = true;
      } catch { /* corrupt peer write — keep what we have */ }
    };
    mesh.start();
    const ambient = new AmbientRunner({
      tinyName: name,
      getLastTopic: () => {
        const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
        return lastUser?.content || null;
      },
      isStreaming: () => (streamsRef.current?.size() ?? 0) > 0,
      headers: () => modelConfigHeaders(loadModelConfig()),
      onStateChange: setAmbientState,
    });
    ambientRef.current = ambient;
    return () => {
      mesh.stop();
      ambient.cancel();
      liveVoiceRef.current?.stop();
      liveVoiceRef.current = null;
      voiceModeRef.current = false;
      // 📞 Hang up the inline call — its own 'ended' event resets the state
      liveCallRef.current?.stop();
      liveCallRef.current = null;
      stopSpeech();
      // Drop a pending "…replied" title-restore listener that would otherwise
      // outlive the component (added to `document` outside the effect system).
      if (titleRestoreRef.current) {
        document.removeEventListener("visibilitychange", titleRestoreRef.current);
        titleRestoreRef.current = null;
      }
      // Abort every in-flight chat stream. Without this, navigating away (or
      // switching `name`) mid-reply orphans the fetch: the abort signal never
      // fires, so the server keeps generating (token/cost + held-open
      // connection) and the delta/finally handlers setState on an unmounted
      // component. Same idiom as stopAllStreams(); each stream's finally does
      // the registry release on abort→throw. No toast — this is teardown, not
      // a user gesture.
      Object.values(controllersRef.current).forEach((c) => { try { c.abort(); } catch { } });
      controllersRef.current = {};
    };
  }, [name]);

  // 🎨 Theme: local copy applies instantly; account copy (if signed in)
  // wins and refreshes the local cache — so themes follow the user.
  useEffect(() => {
    // Per-tiny branding: the owner's theme is this page's DEFAULT — the
    // visitor's own theme (local/account) still wins when they've set one.
    const ownerTheme = tiny?.theme && (tiny.theme.accent || tiny.theme.bg)
      ? resolveTheme({ accent: tiny.theme.accent, background: tiny.theme.bg })
      : null;
    applyTheme(loadThemeLocal() || ownerTheme);
    loadThemeRemote().then((remote) => {
      if (remote) { applyTheme(remote); saveThemeLocal(remote); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // House confirm dialog — Chat was the LAST surface still calling native
  // confirm(), which breaks the portaled/blurred overlay grammar and the
  // focus-return choreography every other destructive flow already has.
  // Shadowing the global on purpose: a bare confirm("string") no longer
  // typechecks here, so a native call can't sneak back in.
  const { confirm, dialog: confirmDialogEl } = useConfirm();

  // 🖨️ Print opens the tool/reasoning <details> and restores after —
  // globals.css unclamps heights for paper but CSS can't open a disclosure.
  usePrintDetails();

  // 🖌️ Custom page CSS/JS (customize_page): CSS auto-applies; stored JS
  // only auto-runs after a one-time per-script user approval — a tiny must
  // never silently plant code that executes on every visit.
  useEffect(() => {
    const applyStoredJs = async (js: string) => {
      // 🔒 Stored JS is the user's OWN account state (saved with persist:true
      // while they were the owner), so ownership isn't re-checked here — the
      // per-script approval gate below is this path's consent. What it must NOT
      // do is run before that gate; see the approval branch.
      if (await isCustomJsApproved(js)) {
        const r = runCustomJs(js);
        if (!r.ok) toast.error(`custom JS failed: ${r.error}`);
        return;
      }
      const preview = js.length > 300 ? js.slice(0, 300) + "…" : js;
      if (await confirm({
        title: "Saved custom JavaScript",
        message: `This page has saved custom JavaScript that wants to run on load:\n\n${preview}`,
        confirmLabel: "Run now + on future visits",
        cancelLabel: "Delete it",
      })) {
        await approveCustomJs(js);
        const r = runCustomJs(js);
        if (!r.ok) toast.error(`custom JS failed: ${r.error}`);
      } else {
        saveCustomJsLocal(null);
        fetch("/api/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "custom_js", value: "" }),
          signal: AbortSignal.timeout(deadlineFor("/api/prefs")),
        }).catch(() => {});
        toast("Saved custom JS removed");
      }
    };

    applyCustomCss(loadCustomCssLocal());
    loadCustomizationRemote("custom_css").then((css) => {
      if (css) { applyCustomCss(css); saveCustomCssLocal(css); }
    });
    const localJs = loadCustomJsLocal();
    loadCustomizationRemote("custom_js").then((remoteJs) => {
      const js = remoteJs || localJs;
      if (!js) return;
      if (remoteJs) saveCustomJsLocal(remoteJs);
      applyStoredJs(js);
    });
    // `confirm` is a stable useCallback — listed to satisfy exhaustive-deps,
    // never re-fires this mount-once effect.
  }, [confirm]);

  // (streams registry is the live-state ref — ambient/auto read it directly)

  // ⚡ Scroll neon mode: while scrolling, bubbles invert to border-only
  // neon (data-scrolling on <html>, styles in globals.css). rAF-throttled;
  // reverts 180ms after the last scroll event. Skipped entirely for
  // prefers-reduced-motion users.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          document.documentElement.setAttribute("data-scrolling", "");
          ticking = false;
        });
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => document.documentElement.removeAttribute("data-scrolling"), 180);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
      document.documentElement.removeAttribute("data-scrolling");
    };
  }, []);

  // 👀 Visit beacon — lets the owner know someone opened their tiny
  // (server skips self-visits and throttles pushes; once per mount)
  useEffect(() => {
    // Fire-and-forget beacon, but still deadlined: an unsettled request keeps
    // its connection + JSON body alive for as long as the tab lives, and this
    // one fires on every mount.
    fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(deadlineFor("/api/visit")),
    }).catch(() => {});
  }, [name]);

  // Load messages from URL (shared conversation) or localStorage
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);

    // Server-stored share link (?share=<id>) — view-only until adopted
    const shareId = urlParams.get('share');
    if (shareId) {
      // The whole view depends on this one read — a hang leaves an empty chat
      // with no error and no retry, as if the share had been silently ignored.
      fetch(`/api/share?id=${encodeURIComponent(shareId)}`, { signal: AbortSignal.timeout(deadlineFor("/api/share")) })
        .then((r) => r.json())
        .then((data) => {
          // Strip uiComponents from a FOREIGN conversation — componentCode runs
          // via new Function (DynamicUI); a viewer didn't author it, so an old
          // or crafted share carrying it would be stored XSS. Own/live messages
          // keep their render_ui output; a viewed share is a read-only transcript.
          const msgs = sanitizeMessages(data.messages).map(({ uiComponents, ...m }: any) => m);
          if (msgs.length > 0) {
            setMessages(msgs);
            messagesRef.current = msgs;
            setViewingShare(true);
            // A shared conversation is a story — start the reader at the
            // top, not the ending. Suppress the stream-follow autoscroll
            // for this initial render (it re-arms on the next user scroll
            // to bottom / their own messages).
            autoScrollRef.current = false;
            requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
          } else {
            toast.error(data.error || "Share link not found or expired");
          }
        })
        .catch(() => toast.error("Couldn't load the shared conversation — try again"));
      return;
    }

    // Legacy base64-in-URL share (?chat=)
    const sharedConversation = urlParams.get('chat');

    if (sharedConversation) {
      try {
        // Decode from base64 (Unicode-safe)
        const decoded = decodeURIComponent(atob(sharedConversation).split('').map((c) => {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));

        // Same as ?share= — strip foreign uiComponents (new Function XSS).
        const parsed = sanitizeMessages(JSON.parse(decoded)).map(({ uiComponents, ...m }: any) => m);
        if (parsed.length === 0) throw new Error("empty or malformed share");
        setMessages(parsed);
        messagesRef.current = parsed;
        setViewingShare(true); // same read-only flow as ?share= links
        return;
      } catch (e) {
        console.warn("Failed to parse shared conversation:", e);
        toast("Couldn't load the shared conversation — the link may be damaged");
      }
    }
    
    // Then check localStorage
    const storageKey = `chat_messages_${name}`;
    const savedMessages = localStorage.getItem(storageKey);
    
    if (savedMessages) {
      try {
        // reconcile: a reload mid-stream persists tools at 'calling' — no
        // stream exists anymore to resolve them, so the spinner would hang
        const restored = reconcileInterruptedTools(sanitizeMessages(JSON.parse(savedMessages)));
        // The saved transcript carries the systemPrompt AS OF the first
        // visit in message id "0" — the "essence" caption would show a
        // stale prompt forever after the owner edits their tiny. The
        // agent already gets the fresh prompt server-side; align display.
        const remapped = restored.map((m: Message) =>
          m.id === "0" && m.role === "system" && !priv && systemPrompt
            ? { ...m, content: systemPrompt }
            : m
        );
        // Signed-out paywall resume: the "Sign in" button navigates away with
        // ?q=<held prompt>&send=1, then the auto-send effect re-asks on return.
        // The persisted transcript still carries that turn's stale signed-out
        // paywall card (+ its user prompt), which would (a) duplicate the prompt
        // the auto-send re-adds and (b) show a dead "Sign in" button. When the
        // resume deep-link is present, drop the stale signed-out paywall pair so
        // the fresh send owns the turn — mirrors iOS/Android in-place auto-resume.
        const resuming = new URLSearchParams(window.location.search).get("send") === "1"
          && !!new URLSearchParams(window.location.search).get("q");
        let parsed = remapped;
        if (resuming) {
          const pwIdx = remapped.findIndex((m) => m.role === "assistant" && m.paywall?.signedOut);
          parsed = dropTurnPairAt(remapped, pwIdx).messages;
        }
        if (parsed.length > 0) {
          setMessages(parsed);
          messagesRef.current = parsed;
          // Open at the LATEST message, not the top. The stream-follow effect
          // only fires while autoScrollRef is pinned and can lose the race with
          // layout on a cold mount, leaving a long restored thread scrolled to
          // its oldest message — the returning user then has to scroll all the
          // way down every visit (user feedback). Force it here, after paint.
          autoScrollRef.current = true;
          requestAnimationFrame(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
          });
          // Orient the returning user: quietly say what was restored.
          // Only for real conversations (a user turn exists) — seeded
          // system/knowledge alone isn't "picking up where you left off".
          const userTurns = parsed.filter((m: Message) => m.role === "user").length;
          if (userTurns > 0) {
            toast(`↺ Resumed — ${userTurns} message${userTurns === 1 ? "" : "s"} from your last visit`, { duration: 2000 });
          }
          return;
        }
        // corrupt/empty localStorage → fall through to a fresh initial state
      } catch (e) {
        console.warn("Failed to parse saved messages:", e);
      }
    }
    
    // Initial messages (if no saved messages)
    const initial: Message[] = [
      { id: "0", role: "system", content: priv ? "This AI is private." : systemPrompt },
    ];
    if (systemKnowledge?.length > 0) {
      initial.push({ id: "1", role: "assistant", content: systemKnowledge });
    }
    setMessages(initial);
    messagesRef.current = initial;
  }, [priv, systemKnowledge, systemPrompt, name]);

  // Save messages to localStorage whenever they change — but never while
  // viewing someone else's share (would clobber the visitor's own history).
  // Debounced 400ms: during streaming this effect fires once per rAF flush
  // (per live stream), and stringifying the whole transcript 60×/s is real
  // main-thread work on long conversations. Trailing write always runs, and
  // pagehide flushes immediately so a mid-debounce navigation loses nothing.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One quota warning per mount — the persist effect fires constantly during
  // streaming; a toast per debounce would be a wall.
  const quotaWarnedRef = useRef(false);
  const warnQuota = (outcome: { ok: boolean; dropped?: number }) => {
    if ((outcome.ok && !outcome.dropped) || quotaWarnedRef.current) return;
    quotaWarnedRef.current = true;
    toast.error(outcome.ok
      ? "Browser storage is full — older messages were dropped from the saved copy. /save downloads the full session."
      : "Browser storage is full — this conversation won't survive a reload. /save downloads it.");
  };
  useEffect(() => {
    if (viewingShare) return;
    if (messages.length === 0) return;
    const persist = () => {
      const storageKey = `chat_messages_${name}`;
      // A mirror tab (adopted a peer's history, authored nothing since) must
      // not write: its copy is at best identical and at worst older than what
      // the tab you're actually using just saved (v4 C5).
      if (!shouldWriteTranscript({
        localCount: (messagesRef.current || []).length,
        remoteCount: parseChatMeta(localStorage.getItem(chatMetaKey(name)))?.count ?? null,
        authored: authoredRef.current,
        streaming: (streamsRef.current?.size() ?? 0) > 0,
        viewingShare,
        mirroring: mirroringRef.current,
      })) return;
      // Strip base64/dataUrl payloads — a single photo would eat the ~5MB
      // localStorage quota. Thumbs + metadata survive for history previews.
      const persistable = (messagesRef.current || []).map((m) =>
        m.attachments?.length ? { ...m, attachments: persistableAttachments(m.attachments) } : m
      );
      // Quota degradation lives in lib/chat/persist: drop the oldest turns,
      // keep the seed + the recent half — and SAY so, once (the old catch
      // console-whispered while every session evaporated on reload).
      warnQuota(persistTranscript((k, v) => localStorage.setItem(k, v), storageKey, persistable));
      // Palette meta rides every persist — a tiny blob so ⌘K never has to
      // parse this transcript again (a cache: quota failure is ignorable).
      try { localStorage.setItem(chatMetaKey(name), JSON.stringify(deriveChatMeta(persistable))); } catch { }
      // Tell sibling tabs the shared key moved (the beat carries no
      // transcript — peers re-read storage if they decide to adopt).
      meshRef.current?.announcePersisted();
    };
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(persist, 400);
    window.addEventListener("pagehide", persist);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      window.removeEventListener("pagehide", persist);
    };
  }, [messages, name, viewingShare]);

  // ✍️ Composer draft (c43): the transcript has always survived a reload; the
  // sentence you hadn't sent yet did not — web was the only client that lost
  // it (iOS keeps the composer, Android mirrors every keystroke to disk). A
  // reload, a crash, or a tap through to /wallet mid-message threw away long
  // unsent text with no trace. Rules are pure in lib/chat/draft.
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (viewingShare) return;
    const save = () => {
      const w = draftWrite(input);
      // A quota failure is ignorable here — unlike the transcript, a lost
      // draft is what we're already degrading from, and the transcript's own
      // budget must not be spent on a warning about a convenience.
      try {
        if (w.action === 'remove') localStorage.removeItem(draftKey(name));
        else localStorage.setItem(draftKey(name), w.value);
      } catch { }
    };
    // Debounced like the transcript: a write per keystroke is real
    // main-thread work on a long draft. pagehide flushes, so closing the tab
    // mid-debounce (the exact case this feature exists for) loses nothing.
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(save, 400);
    window.addEventListener("pagehide", save);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      window.removeEventListener("pagehide", save);
    };
  }, [input, name, viewingShare]);

  // Restore it once per tiny. Runs before the ?q= deep-link effect below can
  // matter: draftRestore yields to a deep link (a fresher intent) and to
  // anything the user has already typed this mount.
  const draftRestoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftRestoredRef.current === name) return;
    draftRestoredRef.current = name;
    let saved: string | null = null;
    try { saved = localStorage.getItem(draftKey(name)); } catch { }
    const text = draftRestore({
      saved,
      hasDeepLink: !!query || !!new URLSearchParams(window.location.search).get("q"),
      viewingShare,
      currentInput: input,
    });
    if (text !== null) setInput(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per tiny; input/viewingShare read as of that moment
  }, [name]);

  // 📎 Staged files can't ride along (v5 D2): base64 is exactly what every
  // transcript write strips for quota reasons, so persisting the payloads
  // would evict the conversation itself. We keep a NAMES-ONLY receipt and say
  // what was lost — a restored draft that reads "here are the shots" with an
  // empty paperclip row otherwise sends an empty promise. Rules are pure in
  // lib/chat/pending-attachments.
  // Declared before both effects: the writer reads it to avoid clearing the
  // receipt the notice hasn't consumed yet.
  const lostFilesNotedRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewingShare) return;
    // Don't let the mount pass (attachments always [] then) delete the receipt
    // the notice effect below still has to read — effects fire in declaration
    // order, and depending on that order for correctness is a trap.
    if (attachments.length === 0 && lostFilesNotedRef.current !== name) return;
    const w = receiptFor(attachments);
    try {
      if (w.action === 'remove') localStorage.removeItem(pendingAttachmentsKey(name));
      else localStorage.setItem(pendingAttachmentsKey(name), JSON.stringify(w.value));
    } catch { /* a notice must never cost the transcript its quota */ }
  }, [attachments, name, viewingShare]);

  // Tell them once, on arrival. Keyed per tiny like the draft restore, and
  // the key is consumed immediately so the notice can't reappear later.
  useEffect(() => {
    if (lostFilesNotedRef.current === name) return;
    lostFilesNotedRef.current = name;
    if (viewingShare) return;
    try {
      const note = describeLostAttachments(
        parseReceipt(localStorage.getItem(pendingAttachmentsKey(name))),
        attachments.length,
      );
      if (note) {
        localStorage.removeItem(pendingAttachmentsKey(name));
        toast(note, { duration: 6000 });
      }
    } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per tiny, on arrival
  }, [name]);

  // Adopt the shared conversation as your own and keep chatting
  const continueFromShare = async () => {
    // Destructive when you already have a saved conversation with this
    // tiny: adopting overwrites chat_messages_${name}. Confirm first.
    let hasExisting = false;
    try {
      const existing = JSON.parse(localStorage.getItem(`chat_messages_${name}`) || "[]");
      hasExisting = Array.isArray(existing) && existing.some((m: any) => m?.role === "user");
    } catch { /* unreadable store — nothing to protect */ }
    if (hasExisting) {
      if (!(await confirm({ message: `Continuing replaces your saved conversation with ${name}.`, confirmLabel: "Continue" }))) return;
    }
    setViewingShare(false);
    viewingShareRef.current = false; // the write below is this tab's own now
    markAuthored(); // adopting a share is authorship: it must reach storage
    setReplayVisible(null); // exit replay — full history becomes yours
    const url = new URL(window.location.href);
    url.searchParams.delete('share');
    url.searchParams.delete('chat'); // legacy base64 links
    window.history.replaceState({}, '', url);
    // Match the main persistence path: strip base64 payloads (a photo-heavy
    // shared convo would blow the ~5MB quota) and degrade through
    // persistTranscript — adopting a share must not silently half-complete.
    {
      const persistable = (messagesRef.current || []).map((m) =>
        m.attachments?.length ? { ...m, attachments: persistableAttachments(m.attachments) } : m
      );
      warnQuota(persistTranscript((k, v) => localStorage.setItem(k, v), `chat_messages_${name}`, persistable));
    }
    toast("💬 Continuing this conversation as yours");
    // "Continue" means "type next" — the composer replaces the share bar
    // this click was on; hand focus + scroll to it
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
    });
  };

  useEffect(() => {
    console.log(`Welcome to the Tiny AI platform...`)
  }, []);

  // ⚠️ Do NOT add a `messagesRef.current = messages` sync effect here.
  // messagesRef is the streaming source of truth and every setMessages call
  // site assigns it explicitly. An effect syncs AFTER commit — during fast
  // streams, deltas that landed on the ref between the rAF flush and the
  // commit get rolled back, splicing/scrambling the rendered text.

  // Track whether the user is pinned to the bottom; only auto-follow then
  useEffect(() => {
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 150;
      autoScrollRef.current = nearBottom;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Follow the conversation as messages stream in (unless user scrolled up).
  // behavior:'instant' — the CSS `scroll-behavior: smooth` would otherwise
  // animate EVERY stream tick, queueing overlapping eased scrolls that
  // visibly rubber-band while tokens arrive. Smooth is for user actions;
  // following a stream should feel attached, not chased.
  useEffect(() => {
    if (!autoScrollRef.current) return;
    try {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
    } catch { }
  }, [messages]);

  // 📎 Read files (picker / camera / paste / drop) into pending attachments,
  // enforcing the total-payload cap so the edge request body stays deliverable
  const handleIngestFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    try {
      // Failures are per-file now — one corrupt image or oversized doc
      // no longer drops the sibling files picked alongside it
      const { attachments: incoming, errors } = await ingestFiles(files);
      errors.forEach((msg) => toast.error(msg));
      if (incoming.length === 0) return;
      setAttachments((prev) => {
        const merged = [...prev, ...incoming];
        if (attachmentsPayloadBytes(merged) > MAX_PAYLOAD_BYTES) {
          toast.error(`Attachments exceed ${(MAX_PAYLOAD_BYTES / 1024 / 1024).toFixed(1)}MB total — remove some first`);
          return prev;
        }
        return merged;
      });
    } catch (e: any) {
      toast.error(e?.message || "Couldn't read the file");
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items || [])) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      handleIngestFiles(files);
    }
  };

  // 📎 Page-wide drag-and-drop (careless intended this but left the drop
  // handler a stub — here it actually ingests). Depth counter avoids the
  // overlay flickering as dragenter/leave fire on child elements.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragOver(false);
      if (e.dataTransfer?.files?.length) handleIngestFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const adjustHeight = () => {
    const textarea = inputRef.current as HTMLTextAreaElement | null;
    try {
      if (!textarea) return;
      // Reset first so the measure can SHRINK too — gating on
      // scrollHeight > clientHeight only ever grew, leaving the composer
      // tall after deleting text or sending (stale height until reload)
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
    } catch { }
  };
  useEffect(() => {
    adjustHeight();
  }, [input]);

  // Focus the composer on mount and when a turn FINISHES — but NOT on every
  // streamed frame. `messages` changes once per animation frame during a
  // stream, so depending on it refocused continuously: on mobile the keyboard
  // kept reopening, and clicking an edit box / tool <details> lost focus on
  // the next frame. Depend only on the streaming transition, and never steal
  // focus while editing a message or while a reply is still streaming.
  useEffect(() => {
    // Concurrent sends: the composer is live during streams (that's the
    // point) — refocus when the LAST stream ends, never mid-stream (mobile
    // keyboard would reopen per frame) and never while editing.
    if (liveIds.size > 0 || editingMessageId) return;
    try {
      if (inputRef.current) inputRef.current.focus();
    } catch { }
  }, [liveIds, editingMessageId]);

  // Focus edit textarea when editing starts
  useEffect(() => {
    if (editingMessageId && editTextareaRef.current) {
      editTextareaRef.current.focus();
    }
  }, [editingMessageId]);

  // Reveal the real prompts once /api/login authorized us (session or key)
  const applyUnlock = (data: any) => {
    const newMsgs = [...messagesRef.current];
    if (newMsgs[0]) newMsgs[0] = { ...newMsgs[0], content: data.systemPrompt };
    if (data.systemKnowledge?.length > 0) {
      if (newMsgs[1]) {
        newMsgs[1] = { ...newMsgs[1], content: data.systemKnowledge };
      } else {
        newMsgs.push({ id: "1", role: "assistant", content: data.systemKnowledge });
      }
    }
    setMessages(newMsgs);
    messagesRef.current = newMsgs;
    setIsAuthorized(true);
  };

  const login = async (e: any) => {
    e.preventDefault();
    const providedKey = e.target[0].value;
    let data: any = null;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: providedKey, name }),
        signal: AbortSignal.timeout(deadlineFor("/api/login")),
      });
      // /api/login returns PLAIN TEXT on rate-limit (429) — res.json() throws
      // on it, so without this the 429 fell into the catch below and read as a
      // connectivity failure ("Couldn't reach the server"). Name the real cause
      // so the owner knows to wait, not to retry a "wrong key".
      if (res.status === 429) {
        toast.error("Too many unlock attempts — try again tomorrow.");
        return;
      }
      // Other error paths can also be plain text; distinguish "rejected"
      // (wrong key) from "couldn't even ask".
      data = await res.json();
    } catch {
      toast.error("Couldn't reach the server — try again in a moment.");
      return;
    }

    if (data?.isAuthorized) {
      sessionStorage.setItem(`${name}:key`, providedKey);
      toast("Logged in!");
      setKey(providedKey);
      setInput("");
      applyUnlock(data);
    } else {
      setIsAuthorized(false);
      sessionStorage.removeItem(`${name}:key`);
      toast("Wrong key!");
    }
  };

  // Auto-unlock for priv mode: session ownership first (no key needed for
  // logged-in owners), then any stashed legacy key as fallback.
  // Declared after login/applyUnlock so the effect closes over real bindings.
  useEffect(() => {
    if (!priv) return;
    let cancelled = false;
    const tryUnlock = async () => {
      // Already vouched — don't re-probe (a stray auth event mustn't reset).
      if (isAuthorizedRef.current) return;
      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(deadlineFor("/api/login")),
        });
        if (cancelled) return;
        // 429 is PLAIN TEXT — res.json() would throw into the catch, which
        // silently falls through to the stashed-key branch and burns ANOTHER
        // rate-limited request, leaving the owner locked with zero feedback
        // (the flagged silent-unlock-fail). Name it and stop — retrying a
        // stashed key can't beat an IP daily cap.
        if (res.status === 429) {
          toast.error("Unlock rate-limited — refresh in a bit to try again.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data.isAuthorized) {
          applyUnlock(data);
          toast("🔓 Unlocked — you own this tiny");
          return;
        }
      } catch { /* fall through to key */ }
      if (cancelled) return;
      const k = sessionStorage.getItem(`${name}:key`);
      if (k) {
        setKey(k);
        login({ preventDefault: () => { }, target: [{ value: k }] });
      }
    };
    tryUnlock();
    // Sign-in on a private page is client-side (passkey/GitHub set the session
    // cookie with no reload), so this effect — keyed on [priv, name] — never
    // re-ran and a just-signed-in OWNER stayed locked out ("can auth but can't
    // send"). AuthButton now emits `tiny:auth` on login; re-probe ownership
    // when it fires so the lock lifts in place, no manual refresh.
    // Signing OUT has to revoke a vouch this tab already granted (v6 E1):
    // `isAuthorized` used to survive a sign-out, leaving the owner's revealed
    // systemPrompt/systemKnowledge — the entire point of the lock — on screen
    // until a manual reload. Re-lock by restoring the sealed seed messages.
    const onAuth = (e: Event) => {
      if (shouldRelock(e as CustomEvent)) {
        if (!isAuthorizedRef.current) return;
        setIsAuthorized(false);
        const sealed = [...messagesRef.current];
        if (sealed[0]) sealed[0] = { ...sealed[0], content: "This AI is private." };
        // The knowledge bubble only exists because the unlock revealed it.
        const relocked = sealed.filter((m, i) => !(i === 1 && m.role === "assistant"));
        messagesRef.current = relocked;
        setMessages(relocked);
        // A stashed legacy key would auto-unlock again on the next probe —
        // signing out means this browser stops vouching for this tiny.
        try { sessionStorage.removeItem(`${name}:key`); } catch { }
        setKey("");
        return;
      }
      if (!isAuthorizedRef.current) tryUnlock();
    };
    window.addEventListener("tiny:auth", onAuth);
    return () => { cancelled = true; window.removeEventListener("tiny:auth", onAuth); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per tiny + on auth events
  }, [priv, name]);

  // Stream-event core: the pure reducer lives in lib/chat/strands-events
  // (tested); the effects it returns — everything that touches the world —
  // run here, where the component's closures live.
  const runStrandsEffects = (effects: StrandsEffect[], asstId: string) => {
    for (const ef of effects) {
      switch (ef.kind) {
        case 'memory-add':
          // The toast follows the WRITE, not the attempt (v13 G2): memories
          // live in localStorage, which throws in Safari Private Browsing and
          // when storage is full — and a false "stored" is how a user loses a
          // fact they were told was kept.
          if (addMemory(name, ef.content, ef.tags)) toast("🧠 Memory stored");
          else toast.error("Couldn't store that memory — browser storage is full or blocked");
          break;
        case 'memory-forget': {
          // Three outcomes, three messages. A no-match is not a failure worth
          // an error toast, and calling it a storage problem would send someone
          // to clear their browser data over a typo'd match string.
          const outcome = forgetMemoryOutcome(name, ef.match);
          if (outcome === 'forgotten') toast("🧠 Memory forgotten");
          else if (outcome === 'blocked') toast.error("Couldn't forget that — browser storage is full or blocked");
          break;
        }
        case 'map': {
          // 🗺️ No bridge = map is off: hint instead of silently eating the
          // agent's gesture (📍 map-mode or /map mounts the bridge).
          const bridge = tinyMapBridge();
          const input = ef.input;
          if (!bridge) {
            toast("🗺️ your tiny is using the map — tap 📍 to see it");
          } else if (ef.name === "add_map_marker") {
            bridge.addMarker(input);
          } else if (ef.name === "fly_to_location") {
            bridge.flyTo(input.lat, input.lng, input.zoom);
          } else if (ef.name === "remove_map_marker") {
            bridge.removeMarker(String(input.id ?? ""));
          } else if (ef.name === "fly_to_marker") {
            bridge.flyToMarker(String(input.id ?? ""), input.zoom);
          } else if (ef.name === "tour_markers") {
            bridge.tourMarkers(Array.isArray(input.ids) ? input.ids.map(String) : [], input.pause_ms);
          } else {
            bridge.clearMarkers();
          }
          break;
        }
        case 'message-surgery':
          // ✂️ Defer a tick so we don't mutate mid-event; messagesRef stays
          // the source of truth. The math is applyMessageSurgery (pure).
          setTimeout(() => {
            const r = applyMessageSurgery(
              messagesRef.current, ef.input, asstId,
              (content): Message => ({ id: genId(), role: "system", content }),
            );
            if (r.messages) {
              messagesRef.current = r.messages;
              setMessages(r.messages);
            }
            if (r.note) (r.error ? toast.error : toast)(r.note);
          }, 0);
          break;
        case 'customize-page': {
          // 🖌️ applies live: CSS injected, JS executed (same trust as
          // render_ui — the user is watching this conversation).
          const inp = ef.input as { action?: string; css?: string; js?: string; persist?: boolean; target?: string };
          if (inp.action === 'clear') {
            const target = inp.target || 'both';
            if (target !== 'js') { applyCustomCss(null); saveCustomCssLocal(null); }
            if (target !== 'css') saveCustomJsLocal(null);
            toast('🖌️ Page customizations cleared');
          } else {
            if (inp.css) {
              applyCustomCss(inp.css);
              if (inp.persist) saveCustomCssLocal(inp.css);
            }
            if (inp.js) {
              // 🔒 Only the tiny's OWNER runs code in this origin. The server
              // no longer mounts customize_page for visitors, but this effect
              // is emitted from beforeToolCallEvent — BEFORE the server
              // callback — so a fabricated or replayed tool call would still
              // reach here. The stream is the least trustworthy input we have,
              // so the decision is made locally, from the shared /api/me probe.
              const verdict = mayRunPageJs({ tinyName: name, isOwner: ownsThisTinyRef.current });
              if (!verdict.allowed) {
                // Named, not silent: the user watched a tool call happen, and a
                // refusal they can't see reads as the feature being broken.
                toast.error(verdict.reason);
                break;
              }
              const r = runCustomJs(inp.js);
              if (!r.ok) toast.error(`custom JS failed: ${r.error}`);
              // Persist the content, but do NOT auto-approve startup execution:
              // the live run is fine (the user is watching this turn), but
              // silently approving would let a prompt-injected tiny plant code
              // that auto-runs on EVERY future visit from one observed call —
              // exactly what the approval gate exists to prevent. On next load,
              // applyStoredJs() asks the user to confirm before it ever runs.
              else if (inp.persist) saveCustomJsLocal(inp.js);
            }
          }
          break;
        }
        case 'set-theme':
          // 🎨 live client-side apply (the server persisted to account)
          applyTheme(ef.theme);
          saveThemeLocal(ef.theme);
          break;
        case 'speak':
          // 🔊 autoplay — live call only; restored history renders cards
          // without sound, since these effects never re-run on restore
          void playSpeech(ef.id, ef.text, { voice: ef.voice, mode: 'neural' });
          break;
        case 'log-error':
          console.error('Agent error:', ef.error);
          break;
      }
    }
  };

  const processStrandsEvent = (event: any, asstId: string, promptText: string) => {
    const { messages: updated, effects } = applyStrandsEvent(messagesRef.current || [], event, asstId, promptText);
    messagesRef.current = updated;
    runStrandsEffects(effects, asstId);
    // Coalesce bursts of deltas into one render per animation frame.
    // messagesRef always holds the latest state, so the flush is lossless.
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      requestAnimationFrame(() => {
        flushScheduledRef.current = false;
        setMessages(messagesRef.current);
      });
    }
  };

  // Enhanced streaming with all event types
  const send = async (text: string, sendAttachments?: Attachment[], opts?: { keepsDraft?: boolean }) => {
    if ((!text || !text.trim()) && !sendAttachments?.length) return;
    // 📡 Offline (v5 D3): a send that cannot leave the machine used to burn a
    // turn and blame the server ("Connection lost: Failed to fetch"). Decline
    // it instead and name the real cause. Only `navigator.onLine === false`
    // gates — `true` is unreliable (an interface being up ≠ reachable), so a
    // captive portal still takes the normal error path. On-device inference
    // (WebLLM) needs no network at all, so it is deliberately exempt.
    if (loadModelConfig().provider !== "webllm") {
      const gate = gateSend(
        typeof navigator === "undefined" ? undefined : navigator.onLine,
        !!opts?.keepsDraft,
        { hasText: !!text.trim(), hasAttachments: !!sendAttachments?.length },
      );
      if (!gate.send) {
        if (opts?.keepsDraft) {
          setInput(text); // put their words back
          // …and their FILES (c71). onSubmit clears `attachments` before
          // dispatch, so a declined send used to drop them silently while the
          // toast claimed the message was still in the composer. A pasted
          // image has no source file to re-pick, so this is unrecoverable
          // unless we hand it back.
          setAttachments((prev) => {
            const r = restoreAttachments(sendAttachments, prev);
            return r.restore ? r.next : prev;
          });
        }
        toast.error(gate.message);
        return;
      }
    }
    // This tab now owns turns no peer knows about — it persists, and stops
    // adopting peers' snapshots (v4 C5).
    markAuthored();
    // 📞 Live call: typed text joins the call as a user turn — the reply
    // arrives as voice + assistant_transcript events, not an /api/chat
    // stream. Attachment sends fall through to the normal turn (the call
    // has no attachment path; dropping files silently would be worse).
    if (liveCallRef.current?.live && !sendAttachments?.length) {
      const spoken = text.trim();
      voiceLastUserRef.current = spoken;
      const inCall = [
        ...(messagesRef.current || []),
        { id: `voice-u-${Date.now()}`, role: "user", content: spoken } as Message,
      ];
      messagesRef.current = inCall;
      setMessages(inCall);
      autoScrollRef.current = true;
      liveCallRef.current.sendUserText(spoken);
      return;
    }
    // Concurrent turns (docs/concurrent-sends-implementation.md, Option B —
    // "parallel exploration with cross-visibility"): unbounded — every send
    // streams immediately. Each turn's history is snapshotted at send time
    // and INCLUDES any sibling's partial reply, annotated as in-progress
    // (annotateLivePartial), so back-to-back questions see and can build on
    // each other. Claim is SYNCHRONOUS (before any append/await) so each
    // same-tick submit gets its own stream. (/auto + ambient run via
    // /api/chat directly and gate on isStreaming() = any live stream.)
    const asstId = genId();
    streams.claim(asstId);

    // The user just sent — re-engage stream-follow even if they'd scrolled up
    // to re-read history. Without this, their own new bubble and the streaming
    // reply never scroll into view (composer is fixed at the bottom, so they
    // can submit from anywhere) and it looks like nothing happened.
    autoScrollRef.current = true;

    const userMsg: Message = {
      id: genId(),
      role: "user",
      content: text,
      ...(sendAttachments?.length ? { attachments: sendAttachments } : {}),
    };

    const appended = [
      ...(messagesRef.current || []),
      userMsg,
      { id: asstId, role: "assistant", content: "", reasoning: "", toolCalls: [], uiComponents: [] } as Message,
    ];
    messagesRef.current = appended;
    setMessages(appended);

    // Setup (content blocks + continuity/KG recall) runs before either
    // stream branch's try/finally — a throw here (e.g. a malformed attachment
    // reaching buildContentBlocks) would strand the synchronous lock at
    // 'pending' and freeze the composer forever. Guard it: release the lock,
    // drop the empty assistant placeholder, and let the user retry.
    let history: any[] = [];
    let continuity = "";
    try {
      // History rules (sibling-partial annotation, empty/deleted filtering)
      // live in lib/chat/stream-registry.ts — pure + tested.
      history = buildTurnHistory(appended, asstId, streamsRef.current!, buildContentBlocks);

      // 🧠 Inject continuity context (turn log + memories) as a system message
      // 🌙 Inject buffered ambient findings into this turn, then clear them
      const ambientFindings = consumeAmbientFindings(name);

      continuity = buildContinuityContext(name);
      // 🕸️ KG association recall (§2.12): graph co-occurrence surfaces older
      // memories/turns the last-20 window and substring match both miss
      const associations = kgRecall(name, text, 4);
      if (associations.length > 0) {
        const kgNote =
          "## 🕸️ Associated memories (recalled by knowledge-graph links to this prompt):\n" +
          associations.map((a) => `- (${a.kind}) ${a.text}`).join("\n");
        continuity = continuity ? `${continuity}\n\n${kgNote}` : kgNote;
      }
      // Cross-tab ring: what other open tabs are discussing (agi-diy pattern)
      const ringCtx = meshRef.current?.ringContext() || "";
      if (ringCtx) continuity = continuity ? `${continuity}\n\n${ringCtx}` : ringCtx;
      if (ambientFindings) {
        const note = `## 🌙 Ambient thinking (you explored this while the user was away — surface anything relevant naturally):\n${ambientFindings}`;
        continuity = continuity ? `${continuity}\n\n${note}` : note;
      }
      // 🎙️ Voice mode: the message was spoken (on-device whisper transcript),
      // and the user is listening, not reading — steer the agent to speak
      if (voiceModeRef.current) {
        const voiceNote =
          "## 🎙️ Voice mode is ON: this message was spoken aloud and transcribed on-device. The user is listening, not reading. Call the `speak` tool with a short conversational version of your answer (plain prose, no markdown) — the written reply can stay brief. Their mic stays open while you work, so more spoken messages may arrive mid-turn.";
        continuity = continuity ? `${continuity}\n\n${voiceNote}` : voiceNote;
      }
      if (continuity) {
        history.unshift({ role: "system", content: [{ text: continuity }] });
      }
    } catch (err: any) {
      streams.release(asstId); // release the synchronous send-claim
      const cleaned = (messagesRef.current || []).filter((m) => m.id !== asstId);
      messagesRef.current = cleaned;
      setMessages(cleaned);
      toast.error("Couldn't prepare the message — try again.");
      return;
    }

    ambientRef.current?.cancel();
    const controller = new AbortController();
    controllersRef.current[asstId] = controller;

    // 🔒 On-device provider (WebLLM, §2.16): inference stays in the browser.
    // Plain chat only — no tools/RAG/sub-agents; the tiny's personality and
    // continuity context still apply. Separate path, then shared cleanup.
    const modelCfg = loadModelConfig();
    if (modelCfg.provider === "webllm") {
      try {
        const modelId = modelCfg.modelId || WEBLLM_MODELS[0].id;
        const sysParts = [
          priv ? "" : systemPrompt,
          continuity,
          "\n[You are running fully on-device in the user's browser — no tools, no web access. Answer from knowledge and context only.]",
        ].filter(Boolean);
        const localMsgs = [
          { role: "system" as const, content: sysParts.join("\n\n") },
          ...history.filter((h) => h.role !== "system").map((h) => ({
            role: h.role as "user" | "assistant",
            content: (h.content || []).map((b: any) => b.text || "").join(" ").trim() || "…",
          })),
          { role: "user" as const, content: text },
        ];
        await webllmStream(
          modelId,
          localMsgs,
          (delta) => processStrandsEvent({ type: "modelContentBlockDeltaEvent", textDelta: delta }, asstId, text),
          (status) => {
            // Model download/compile progress as a replaceable status line
            const updated = (messagesRef.current || []).map((m) =>
              m.id === asstId && !m.content?.includes("\n") && (m.content === "" || m.content?.startsWith("⏳"))
                ? { ...m, content: status ? `⏳ ${status}` : "" }
                : m
            );
            messagesRef.current = updated;
            setMessages(updated);
          },
          controller.signal
        );
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          processStrandsEvent({ type: "error", error: e?.message || String(e) }, asstId, text);
        }
      } finally {
        delete controllersRef.current[asstId];
        streams.release(asstId); // release the synchronous send-claim
        if (streams.size() === 0) ambientRef.current?.poke();
        const finalMsg = (messagesRef.current || []).find((m) => m.id === asstId);
        if (finalMsg?.content && !finalMsg.content.startsWith("⏳")) {
          appendTurn(name, text, finalMsg.content);
          meshRef.current?.addToRing(`Q: ${text.slice(0, 120)} → A: ${finalMsg.content.slice(0, 200)}`);
        }
      }
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tiny-name": name,
          "x-tiny-session": session,
          "x-tiny-metadata": `${JSON.stringify(mergeLocationMeta(metadata, geoFixRef.current))}`,
          "x-tiny-key": key,
          ...modelConfigHeaders(loadModelConfig()),
        },
        signal: controller.signal,
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        // Surface the server's actual message (rate limit, bad key, 400…)
        // instead of a generic "connection lost" — the body is meaningful
        // and the distinction changes what the user should do.
        let msg = `HTTP ${res.status}`;
        let parsed: any = null;
        try {
          const body = await res.text();
          if (body) {
            try { parsed = JSON.parse(body); msg = parsed.error || parsed.message || body; }
            catch { msg = body; }
          }
        } catch { }
        const err: any = new Error(String(msg).slice(0, 300));
        err.status = res.status;
        // 💸 Paywall (402): carry the price/balance so the catch can render a
        // proper payment card (top-up + retry) instead of a "connection lost"
        // toast. The server sends { payment_required, price_micro, balance_micro }.
        if (res.status === 402 && parsed?.payment_required) {
          err.payment = {
            priceMicro: Number(parsed.price_micro || 0),
            balanceMicro: Number(parsed.balance_micro || 0),
            // Prefer the server's authoritative signed_out flag; fall back to the
            // copy+balance derivation only for older servers that predate it (iOS
            // Api.swift / Android WalletCore.parsePaywall do the same). The signed-out
            // 402 omits balance_micro and says "Sign in"; the insufficient-balance
            // 402 carries balance_micro and omits the flag — string-matching the copy
            // alone silently flips to a dead-end "Add funds" the moment it changes.
            signedOut: typeof parsed.signed_out === "boolean"
              ? parsed.signed_out
              : !parsed.balance_micro && /sign in/i.test(String(parsed.error || "")),
          };
        }
        throw err;
      }
      if (!res.body) throw new Error('HTTP no body');

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const decoder = createSSEDecoder();
      // Server stamps every event with seq — a gap means events were lost
      // on the wire (scrambled-streaming report), which we surface instead
      // of silently rendering scrambled text
      const seqTracker = createSeqTracker();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        for (const data of decoder.feed(value)) {
          try {
            const event = JSON.parse(data);
            const gap = seqTracker.check(event.seq);
            if (gap) {
              console.warn(`SSE seq gap: expected ${gap.expected}, got ${gap.got}`);
              // One toast per STREAM — a lossy connection produces several
              // gaps in one reply and used to stack identical toasts.
              if (gap.first) toast.error("Stream glitch — some text may be missing. Retry if it reads wrong.");
            }
            processStrandsEvent(event, asstId, text);
          } catch (e) {
            console.warn("Failed to parse SSE event:", data, e);
          }
        }
      }

      // The server sends `data: [DONE]` on EVERY exit path before closing —
      // a body that ended without it was cut off (proxy timeout, mobile
      // tab-sleep connection drop), not finished. Without this check the
      // truncated reply rendered as a clean answer: finally even reconciled
      // the stuck tools, so nothing LOOKED wrong and there was no retry.
      if (!decoder.sawDone()) {
        const truncated: any = new Error("The reply was cut off — the connection closed early. Retry to continue.");
        truncated.truncated = true;
        throw truncated;
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        // 💸 Paywall (402): a priced tiny with an unfunded wallet. NOT a lost
        // connection and NOT retriable-as-is — render a payment card (price,
        // balance, Add funds, retry-once-funded) instead of the red error
        // banner + futile retry. The card owns re-sending after top-up.
        const isPaywall = e.status === 402 && e.payment;
        // Rate limit (429): not retriable right now — don't offer a retry
        // button (it'd just fail again); show the server's message plainly.
        const isRateLimit = e.status === 429;
        const updated = (messagesRef.current || []).map((m) =>
          m.id === asstId
            ? {
                ...m,
                content: isRateLimit ? `⚠️ ${e.message}` : m.content,
                ...(isPaywall
                  ? { paywall: { priceMicro: e.payment.priceMicro, balanceMicro: e.payment.balanceMicro, signedOut: !!e.payment.signedOut, prompt: text } }
                  : isRateLimit ? {} : { failedPrompt: text }),
              }
            : m
        );
        messagesRef.current = updated;
        setMessages(updated);
        // Paywall gets its own inline card — a toast on top would be noise.
        // A truncation carries its own complete copy; "Connection lost:"
        // would double-prefix it.
        // 📡 Name the side of the wire that failed (v5 D3) — a drop while the
        // browser reports itself offline is OURS, not the server hanging up.
        if (!isPaywall) {
          toast.error(isRateLimit
            ? e.message
            : describeStreamFailure({
                online: typeof navigator === "undefined" ? undefined : navigator.onLine,
                truncated: e.truncated,
                status: e.status,
                message: e.message,
              }));
        }
      }
    } finally {
      delete controllersRef.current[asstId];
      streams.release(asstId); // release the synchronous send-claim

      // Reconcile any tool left mid-flight — if the stream ended (Stop,
      // dropped connection, or the provider hung after beforeToolCallEvent)
      // a tool stuck at 'calling' would spin its spinner forever. Mark it
      // errored so the card resolves instead of hanging.
      const withStuckTools = (messagesRef.current || []).map((mm) =>
        mm.id === asstId && mm.toolCalls?.some((t) => t.status === 'calling')
          ? { ...mm, toolCalls: mm.toolCalls.map((t) => t.status === 'calling' ? { ...t, status: 'error' as const, error: 'interrupted' } : t) }
          : mm
      );
      messagesRef.current = withStuckTools;
      setMessages(withStuckTools);

      // Idle countdown restarts when the LAST live turn ends — a sibling
      // stream still running means the agent is not idle.
      if (streams.size() === 0) ambientRef.current?.poke();

      // 📬 Reply landed while the tab was in the background — flip the
      // title so the tab strip shows it; restore when the user returns.
      // Only on the LAST finishing stream (siblings would re-flip and
      // capture the flipped title as prevTitle).
      if (document.hidden && streams.size() === 0) {
        // Drop any prior pending restore first (back-to-back background replies
        // would otherwise stack listeners, each capturing a flipped title).
        if (titleRestoreRef.current) {
          document.removeEventListener("visibilitychange", titleRestoreRef.current);
        }
        const prevTitle = document.title;
        document.title = `● ${name} replied`;
        const restore = () => {
          if (!document.hidden) {
            document.title = prevTitle;
            document.removeEventListener("visibilitychange", restore);
            titleRestoreRef.current = null;
          }
        };
        titleRestoreRef.current = restore;
        document.addEventListener("visibilitychange", restore);
      }

      // 🧠 Append to persistent turn log
      const finalMsg = (messagesRef.current || []).find((m) => m.id === asstId);
      if (finalMsg?.content) {
        appendTurn(name, text, finalMsg.content);
        // Publish to the cross-tab ring so other tabs' agents see this beat
        meshRef.current?.addToRing(`Q: ${text.slice(0, 120)} → A: ${finalMsg.content.slice(0, 200)}`);
      }
    }
  };

  // ?q= deep link: auto-send the question so shared "ask my AI" links land
  // on an answer, not an unsent input box (rules in lib/chat/deep-link).
  // Declared after send() so the effect closes over a real binding.
  //
  // Once per (tiny, query) via a keyed REF — three failure modes, one guard:
  // the old module-scope flag ran once per JS SESSION, so client-side nav to
  // a second tiny with ?q= dropped the deep link entirely (not even prefill);
  // a bare per-mount ref still misses App-Router navs that REUSE this
  // component instance (same position, new props — no remount, ref survives);
  // and StrictMode's dev double-effect keeps the ref, so no double-send.
  const deepLinkHandledRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${name}\u0000${query ?? ''}`;
    if (deepLinkHandledRef.current === key) return;
    deepLinkHandledRef.current = key;
    const decision = decideDeepLink({
      query,
      search: window.location.search,
      locked: !!(priv && !isAuthorized),
      viewingShare,
    });
    if (decision.action === 'send') {
      // strip ?q= so refresh doesn't re-ask
      window.history.replaceState({}, '', stripDeepLinkParams(window.location.href));
      send(decision.text);
    } else if (decision.action === 'prefill') {
      setInput(decision.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per (name, query) view
  }, [name, query]);


  // ⚡ Slash commands (careless-style)
  // ⚡ Slash commands (careless-style) — the dispatch, parsing, and worker
  // calls live in lib/chat/slash-commands (tested); this wiring hands the
  // module the component's closures. Same contract: true = consumed.
  const trySlashCommand = (text: string): boolean => runSlashCommand(text, {
    name,
    getMessages: () => messagesRef.current || [],
    setMessages: (msgs) => {
      const m = msgs as Message[];
      // Slash commands that rewrite history (/load an archive, /prune) are
      // this tab's own edit — it owns the shared key from here (v4 C5).
      markAuthored();
      messagesRef.current = m;
      setMessages(m);
    },
    buildSystemMessage: () => ({ id: "0", role: "system", content: priv ? "This AI is private." : systemPrompt }),
    reconcileInterruptedTools: (msgs) => reconcileInterruptedTools(msgs as Message[]),
    streamingCount: () => streamsRef.current?.size() ?? 0,
    toast: { show: (msg, opts) => { toast(msg, opts); }, error: (msg) => { toast.error(msg); } },
    confirm,
    openPanel: (panel) => {
      if (panel === "settings") setShowModelSettings(true);
      else if (panel === "memory") setShowMemory(true);
      else if (panel === "jobs") setShowJobs(true);
      else if (panel === "wallet") setShowWallet(true);
      else setShowPalette(true);
    },
    navigate: (path) => { window.location.href = path; },
    downloadFile: (filename, content) => {
      // Browser-only download plumbing stays here (Blob + anchor click);
      // the module builds the document, this hands it to the user.
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    clearConversation: handleClear,
    share: handleShare,
    startLiveCall,
    startAutonomous: (task, onIter) => ambientRef.current?.startAutonomous(task, onIter),
    // Live read, not the render-time `input`: an /auto run resolves minutes
    // later, and the restore must not clobber whatever they've typed since.
    getInput: () => inputRef.current?.value ?? "",
    setInput,
    getMemories,
    clearLocalMemories: clearMemories,
    clearTurnLog,
    downloadArchive: (n, msgs) => downloadArchive(n, msgs as Message[]),
    pickAndLoadArchive,
    estimateCost,
    formatCost,
  });

  // Abort every live stream (stop-all chip + ⌘. shortcut). Registry
  // releases happen in each stream's finally (abort → throw).
  const stopAllStreams = () => {
    const live = Object.keys(controllersRef.current).length;
    if (!live) return;
    Object.values(controllersRef.current).forEach((c) => { try { c.abort(); } catch { } });
    controllersRef.current = {};
    toast(`⏹️ Stopped ${live > 1 ? `all ${live} replies` : ""}`.trim() + "!");
  };

  // ⌨️ Global keyboard shortcuts (careless-style)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowModelSettings(true);
      } else if (mod && e.key === ".") {
        // ⌘. — the classic macOS cancel; stops every live stream (works
        // from the composer too, where per-bubble stops may be off-screen)
        e.preventDefault();
        stopAllStreams();
      } else if (e.key === "Escape") {
        setShowPalette(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSubmit = (e: any) => {
    e.preventDefault();
    const text = input;
    const pending = attachments;
    if (!text.trim() && !pending.length) return;
    setInput("");
    // 📎 Attachments ride along with whatever the user typed
    if (pending.length) {
      setAttachments([]);
      send(text, pending, { keepsDraft: true });
      return;
    }
    if (trySlashCommand(text)) return;
    if (isBangExpr(text)) {
      // ⚡ Zero-token local eval (careless bang pattern)
      const userMsg: Message = { id: genId(), role: "user", content: text };
      const resultId = genId();
      const pending = [...messagesRef.current, userMsg, { id: resultId, role: "assistant", content: "…" } as Message];
      messagesRef.current = pending;
      setMessages(pending);
      runBang(text).then((result) => {
        const updated = messagesRef.current.map((m) =>
          m.id === resultId ? { ...m, content: "⚡ `" + text.trim() + "`\n```\n" + result + "\n```" } : m
        );
        messagesRef.current = updated;
        setMessages(updated);
      });
      return;
    }
    // keepsDraft: onSubmit already cleared the composer, so an offline
    // decline has to put the text back for that promise to be true.
    send(text, undefined, { keepsDraft: true });
  };

  // True once the user has actually exchanged messages (beyond the seeded
  // system/knowledge intro) — drives share/clear visibility
  const hasConversation = messages.some((m) => m.role === "user");

  // Edit message handler
  const handleEditMessage = (messageId: string, currentContent: string) => {
    setEditingMessageId(messageId);
    setEditContent(currentContent);
  };

  // Save edited message. Map over messagesRef, NOT the `messages` state —
  // state lags the ref by a frame (rAF flush), so with a sibling stream
  // live, a state-based copy would overwrite the ref and wipe the deltas
  // that streamed since the last flush.
  const handleSaveEdit = (messageId: string) => {
    const updated = messagesRef.current.map((m) =>
      m.id === messageId ? { ...m, content: editContent } : m
    );
    setMessages(updated);
    messagesRef.current = updated;
    setEditingMessageId(null);
    setEditContent("");
    toast("✏️ Message updated!");
  };

  // Cancel edit
  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditContent("");
  };

  // Delete message handler (messagesRef, not state — see handleSaveEdit)
  const handleDeleteMessage = async (messageId: string) => {
    if (await confirm({ message: "Delete this message?", confirmLabel: "Delete", danger: true })) {
      const updated = messagesRef.current.map((m) =>
        m.id === messageId ? { ...m, content: "_deleted..._" } : m
      );
      setMessages(updated);
      messagesRef.current = updated;
      toast("🗑️ Message deleted!");
    }
  };

  // Voice utterances fire from a closure created once at mic-start — keep it
  // pointed at the freshest send() (which closes over auth key, model config…)
  useEffect(() => { sendRef.current = (text: string) => { void send(text); }; });

  // 🎙️ Voice mode toggle — always-open mic, on-device whisper, 3s-pause send.
  // The transcript does NOT fill the composer: it shows live in the voice
  // strip and goes straight to the agent as a message.
  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    liveVoiceRef.current?.stop();
    liveVoiceRef.current = null;
    setVoiceMode(false);
    setVoicePartial("");
    setVoiceProgress(null);
  };

  const toggleVoiceMode = async () => {
    if (voiceModeRef.current) { stopVoiceMode(); return; }
    voiceModeRef.current = true;
    setVoiceMode(true);
    setVoiceStatus("listening");
    setVoiceProgress("Preparing on-device speech model…");
    ambientRef.current?.cancel();
    try {
      const handle = await startLiveVoice({
        onProgress: (label, pct) => setVoiceProgress(pct != null ? `${label} ${pct}%` : label),
        onStatus: (s) => { setVoiceStatus(s); setVoiceProgress(null); },
        // Barge-in: the user talking over the agent's voice mutes it — and
        // keeps the echo of our own TTS from ever reaching the transcript
        onSpeechStart: () => stopSpeech(),
        onPartial: setVoicePartial,
        onUtterance: (text) => { setVoicePartial(""); sendRef.current(text); },
        onLevel: (rms) => {
          const el = voiceLevelRef.current;
          if (el) el.style.transform = `scaleX(${Math.min(1, rms * 8)})`;
        },
        onError: (msg) => toast.error(msg),
      });
      // User toggled off while the model was still downloading
      if (!voiceModeRef.current) { handle.stop(); return; }
      liveVoiceRef.current = handle;
    } catch (e: any) {
      toast.error(e?.message || "Voice mode failed to start");
      stopVoiceMode();
    }
  };

  // 📞 Voice-call tool bridge: tool_call frames from the live call execute
  // with the same client logic chat's beforeToolCallEvent branch uses.
  // ALWAYS returns a result object — the caller replies via sendToolResult
  // so the model is never left hanging on an unknown/unsupported tool.
  const runVoiceTool = async (toolName: string, args: any): Promise<any> => {
    try {
      switch (toolName) {
        case "remember": {
          if (!args?.content) return { ok: false, error: "content required" };
          // ⚠️ This result is spoken. The model reads `stored` and says "I'll
          // remember that" in the call — so an unconditional `true` made the
          // agent promise out loud something localStorage had just refused
          // (Safari Private Browsing, storage full). Report the write.
          if (!addMemory(name, args.content, args.tags)) {
            toast.error("Couldn't store that memory — browser storage is full or blocked");
            return { ok: false, stored: false, error: "browser storage is full or blocked — tell the user you could not keep this" };
          }
          toast("🧠 Memory stored");
          return { ok: true, stored: true };
        }
        case "forget": {
          if (!args?.match) return { ok: false, error: "match required" };
          const outcome = forgetMemoryOutcome(name, args.match);
          if (outcome === "forgotten") { toast("🧠 Memory forgotten"); return { ok: true, removed: true }; }
          if (outcome === "no-match") return { ok: true, removed: false, reason: "no memory matched" };
          toast.error("Couldn't forget that — browser storage is full or blocked");
          return { ok: false, removed: false, error: "browser storage is full or blocked — the memory is still there; tell the user" };
        }
        case "copy_to_clipboard": {
          // The clipboard is the WIDEST third-party-string sink here — its
          // value gets pasted into another program, so a wrong one is spent
          // where this code can't see it. `String(args?.text ?? "")` wrote on
          // every input: a missing `text` became "" and ERASED whatever the
          // user had copied (reported as success), and an object landed as
          // "[object Object]". The tool's `.max(10_000)` lives in a zod schema
          // that is only DESCRIBED to the model — this is where it's enforced.
          const c = decideClipboardWrite(args?.text);
          if (!c.ok) return c;
          try {
            await navigator.clipboard.writeText(c.text);
          } catch {
            // The write REJECTS on an insecure context, a denied permission,
            // or an unfocused document. The old code let the raw DOMException
            // reach the outer catch, which hands `e.message` to the voice
            // agent to read aloud; this says what happened in words the model
            // can narrate, and tells the user their clipboard is intact.
            toast.error(CLIPBOARD_DENIED_TOAST);
            return { ok: false, error: CLIPBOARD_DENIED_NOTE };
          }
          // Quote what landed: the failure mode this toast exists for is a
          // SUBSTITUTION (the tiny's own address over the one the user meant),
          // and "Copied!" cannot surface that — the value can.
          toast(clipboardConfirmToast(c.text, c.truncated));
          return { ok: true, note: clipboardNote(c.truncated) };
        }
        case "open_url": {
          // The persona may be someone ELSE's public tiny, so `args.url` is
          // third-party content aimed at this origin (session cookie + BYOK
          // keys) — every other sink here gates its string (markdown a/img,
          // wallet's explorerHref, the attachment lightbox) and this one
          // didn't. `decideOpenUrl` refuses non-http(s) schemes and the
          // path-shaped forms that leave the site (`//evil.com`), and the
          // refusal text is written for the MODEL, since it's the tool result.
          const d = decideOpenUrl(args?.url);
          if (!d.ok) return d;
          // A tool call arrives on a websocket frame, NOT in a click handler,
          // so this open is popup-blocked in the common case and returns null.
          // Returning {ok:true} regardless is what made the agent say "I've
          // opened it" about a tab that doesn't exist. Same lesson as the save
          // flow at :1161 — and the same fix: a toast whose action opens from a
          // real user gesture, which is never blocked.
          const w = window.open(d.href, "_blank", "noopener");
          if (!w) {
            toast(OPEN_URL_BLOCKED_TOAST, {
              duration: 8000,
              action: { label: OPEN_URL_BLOCKED_ACTION, onClick: () => window.open(d.href, "_blank", "noopener") },
            });
            return { ok: true, note: OPEN_URL_BLOCKED_NOTE };
          }
          return { ok: true };
        }
        case "render_ui": {
          // Attach to the current voice assistant bubble — or create one if
          // the call renders UI outside a spoken turn (same shape as chat's
          // render_ui branch in processStrandsEvent).
          const ui: UIComponent = {
            id: `voice-ui-${Date.now()}`,
            componentCode: args?.componentCode,
            props: args?.props,
            title: args?.title,
          };
          const targetId = voiceAsstIdRef.current;
          if (targetId && messagesRef.current.some((m) => m.id === targetId)) {
            const next = messagesRef.current.map((m) =>
              m.id === targetId ? { ...m, uiComponents: [...(m.uiComponents || []), ui] } : m
            );
            messagesRef.current = next;
            setMessages(next);
          } else {
            const msg: Message = { id: `voice-a-${Date.now()}`, role: "assistant", content: "", uiComponents: [ui] };
            voiceAsstIdRef.current = msg.id;
            const next = [...messagesRef.current, msg];
            messagesRef.current = next;
            setMessages(next);
          }
          return { ok: true, note: "rendered" };
        }
        case "learn":
        case "recall":
        case "unlearn":
        case "send_message":
        case "read_messages": {
          // Server tools (worker-backed memory + DMs) — same session-bound
          // tool objects chat mounts, executed by /api/voice/tool.
          // name: toolName — the bare `name` here is the TINY's slug (it
          // shadowed the tool name and 404'd every server tool on this
          // bridge); viaTiny stamps the sender surface for send_message.
          // Deadlined so a stalled tool call doesn't leave the VOICE agent
          // waiting on a promise that never settles (it can't narrate what it
          // can't observe). ⚠️ /api/voice/tool declares no maxDuration and its
          // lib/chat/tools/* worker fetches pass no signal, so before this the
          // server had no ceiling either. The error text goes to the model, not
          // a user, so String(e) stays — but a timeout must be legible to it.
          // isDeadlineError (not the tag): nothing else here can abort, so the
          // name is unambiguous at this one site.
          const r = await fetch("/api/voice/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: toolName, args, viaTiny: name }),
            signal: AbortSignal.timeout(deadlineFor("/api/voice/tool")),
          }).then((res) => res.json()).catch((e) => ({
            ok: false,
            error: isDeadlineError(e) ? "the tool timed out" : String(e),
          }));
          return r?.ok ? r.result : r;
        }
        default:
          // vibrate / flashlight / set_brightness / play_sound / screenshot /
          // generate_image … — mobile-app device tools this surface lacks
          return { ok: false, error: "not available on this device" };
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  };

  // 📞 Start the inline voice call — the call is part of THIS chat: live
  // transcription lands in the thread, the composer stays usable (typed
  // text joins the call), and tool calls run with chat's client executors.
  const startLiveCall = () => {
    if (liveCallRef.current) return;
    const call = new LiveCall();
    liveCallRef.current = call;
    setCallStatus("connecting");
    ambientRef.current?.cancel();
    call.on((e) => {
      switch (e.type) {
        case "status": {
          if (e.status === "live") setCallStatus("live");
          if (e.status === "ended" || e.status === "error") {
            liveCallRef.current = null;
            voiceAsstIdRef.current = null;
            setCallStatus("off");
            setCallLevel(0);
          }
          break;
        }
        case "error": {
          toast.error(`📞 ${e.error}`);
          break;
        }
        case "user_transcript": {
          // What the mic heard, as a real user message. Does NOT trigger an
          // agent turn — the DO already drives the model; the reply arrives
          // as voice + assistant_transcript.
          if (!e.text) break;
          voiceLastUserRef.current = e.text;
          const next = [
            ...messagesRef.current,
            { id: `voice-u-${Date.now()}`, role: "user", content: e.text } as Message,
          ];
          messagesRef.current = next;
          setMessages(next);
          break;
        }
        case "response_started": {
          const id = `voice-a-${Date.now()}`;
          voiceAsstIdRef.current = id;
          const next = [
            ...messagesRef.current,
            { id, role: "assistant", content: "" } as Message,
          ];
          messagesRef.current = next;
          setMessages(next);
          break;
        }
        case "assistant_transcript": {
          if (!e.delta) break;
          let id = voiceAsstIdRef.current;
          if (!id || !messagesRef.current.some((m) => m.id === id)) {
            // Missed response_started (or render_ui swapped bubbles) —
            // create the assistant bubble on the fly
            id = `voice-a-${Date.now()}`;
            voiceAsstIdRef.current = id;
            messagesRef.current = [
              ...messagesRef.current,
              { id, role: "assistant", content: "" } as Message,
            ];
          }
          const next = messagesRef.current.map((m) =>
            m.id === id ? { ...m, content: (m.content || "") + e.delta } : m
          );
          messagesRef.current = next;
          setMessages(next);
          break;
        }
        case "response_done": {
          // Mirror the normal send() epilogue: persistent turn log + ring
          const id = voiceAsstIdRef.current;
          const finalMsg = id ? messagesRef.current.find((m) => m.id === id) : undefined;
          if (finalMsg?.content) {
            appendTurn(name, voiceLastUserRef.current, finalMsg.content);
            meshRef.current?.addToRing(`Q: ${voiceLastUserRef.current.slice(0, 120)} → A: ${finalMsg.content.slice(0, 200)}`);
          }
          voiceAsstIdRef.current = null;
          voiceLastUserRef.current = "";
          break;
        }
        case "barge_in": {
          // User talked over the reply — keep the partial text as-is
          voiceAsstIdRef.current = null;
          break;
        }
        case "level": {
          // ~10/s cap: level fires per audio frame; full-rate setState
          // would re-render the whole transcript as a render storm
          const now = Date.now();
          if (now - callLevelTsRef.current >= 100) {
            callLevelTsRef.current = now;
            setCallLevel(e.level);
          }
          break;
        }
        case "tool_call": {
          void runVoiceTool(e.name, e.args).then((result) => call.sendToolResult(e.id, result));
          break;
        }
      }
    });
    // Continuity rides into the session instructions — the voice agent starts
    // knowing what the chat agent knows (memories + recent turns).
    void call.start(name, modelConfigHeaders(loadModelConfig()), buildContinuityContext(name));
  };

  // 📞 Hang up — stop() emits 'ended', which the listener above uses to
  // clear the ref/status; the explicit resets keep this safe to call twice.
  const endLiveCall = () => {
    liveCallRef.current?.stop();
    liveCallRef.current = null;
    voiceAsstIdRef.current = null;
    voiceLastUserRef.current = "";
    setCallStatus("off");
    setCallLevel(0);
  };

  // 🔊 Per-message read-aloud — neural voice when it's already warm, instant
  // speechSynthesis otherwise (a read-aloud click shouldn't cost a ~90MB
  // model download; the speak tool and voice mode are what warm it up).
  const toggleSpeak = (m: Message) => {
    if (speakingMsgId === m.id) {
      stopSpeech();
      return;
    }
    void playSpeech(m.id, m.content, { mode: "auto" });
  };

  const handleStopStreaming = (messageId: string) => {
    const controller = controllersRef.current[messageId];
    if (controller) {
      controller.abort();
      delete controllersRef.current[messageId];
      // registry release happens in that stream's finally (abort → throw)
      toast("⏹️ Stopped!");
    }
  };

  // Clear conversation history (confirm + reset to initial messages)
  const handleClear = async () => {
    if (!(await confirm({ message: "Clear conversation history?", confirmLabel: "Clear", danger: true }))) return;
    // Abort any live streams first — their placeholders are about to be
    // deleted, so orphaned fetches would burn tokens into nothing (events
    // route by id and find no message). Registry releases in each finally.
    stopAllStreams();
    // A clear is this tab's own decision about the key — it must persist even
    // if the tab had been mirroring a peer (v4 C5).
    markAuthored();
    const storageKey = `chat_messages_${name}`;
    localStorage.removeItem(storageKey);
    // The palette meta mirrors the transcript — remove both or /clear
    // leaves a ghost conversation in ⌘K.
    try { localStorage.removeItem(chatMetaKey(name)); } catch { }

    const initial: Message[] = [
      { id: "0", role: "system", content: priv ? "This AI is private." : systemPrompt },
    ];
    if (systemKnowledge?.length > 0) {
      initial.push({ id: "1", role: "assistant", content: systemKnowledge });
    }
    setMessages(initial);
    messagesRef.current = initial;
    toast("History cleared — fresh start");
    // Fresh start looks like one: back to the hero at the top (after a
    // long conversation the viewport would otherwise be stranded at the
    // bottom of a now-short page)
    autoScrollRef.current = false;
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));

    // Clear URL parameter if present
    const url = new URL(window.location.href);
    url.searchParams.delete('chat');
    window.history.replaceState({}, '', url);
  };

  // Share conversation — server-stored snapshot, short URL (no size cap)
  const handleShare = async () => {
    try {
      // A snapshot mid-stream would freeze a half-written reply into the
      // share (concurrent sends make this reachable — composer stays live)
      if ((streamsRef.current?.size() ?? 0) > 0) {
        toast("⏳ Wait for the streaming replies to finish before sharing.");
        return;
      }
      if (messages.filter(m => m.role !== 'system').length === 0) {
        toast("No messages to share yet!");
        return;
      }

      // Public snapshot — drops system messages (private-prompt leak) and
      // tool/reasoning/failure fields. Pure + tested in session-archive.
      const snapshot = shareSnapshot(messages);

      toast("Creating share link…");
      // fetchWithDeadline, not a bare signal: the catch below silences
      // `AbortError` on purpose, because that is how `navigator.share` reports
      // "the user dismissed the sheet". A deadline that rejected with the same
      // name would inherit that silence and leave "Creating share link…" as the
      // last thing the user ever heard. The tag says whose abort it was.
      const res = await fetchWithDeadline("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, messages: snapshot }),
      });
      const data = await res.json();
      if (!data.url) {
        toast.error(data.error || "Couldn't create the share link — try again");
        return;
      }

      // Remember the revoke token so /shares can revoke this link later
      if (data.id && data.revokeToken) {
        try {
          const mine = JSON.parse(localStorage.getItem("tiny_my_shares") || "[]");
          mine.push({ id: data.id, name, revokeToken: data.revokeToken, created: Date.now() });
          localStorage.setItem("tiny_my_shares", JSON.stringify(mine.slice(-50)));
        } catch { }
      }

      if (navigator.share) {
        await navigator.share({
          title: `Conversation with ${name}`,
          text: `Check out this conversation with ${name}!`,
          url: data.url,
        });
        toast("Shared successfully!");
      } else {
        await navigator.clipboard.writeText(data.url);
        toast("📋 Share link copied to clipboard!");
      }
    } catch (err: any) {
      if (isTaggedDeadline(err)) {
        // Ask "was this MY deadline?" BEFORE "was this an abort?" — both are
        // AbortError-shaped, only one of them is worth telling the user about.
        console.error("Share failed:", err);
        toast("Couldn't share — the link never came back. Try again.");
      } else if (err.name !== 'AbortError') {
        console.error("Share failed:", err);
        toast("Couldn't share — try again");
      }
    }
  };

  // 🎯 heroMode: turn zero — the composer renders centered inside the
  // hero ("Google opening") instead of docked at the bottom. It drops to
  // the dock on the first user message (heroMode flips).
  const heroMode = !hasConversation && !viewingShare;

  // 🖼️ Per-tiny hero image (Twitter-banner style): owner-set https URL.
  // Worker validates on write (no quotes/backslashes/whitespace) — re-check
  // here anyway since this string lands inside a CSS url("").
  const heroImage = typeof tiny?.hero === 'string' && /^https:\/\/[^\s"'\\<>]+$/.test(tiny.hero) ? tiny.hero : '';

  // 🎭 Per-tiny identity: logo media above the big name + owner-set starter
  // chips (replace the hardcoded defaults). Same URL re-check as hero.
  const logoUrl = typeof tiny?.logo === 'string' && /^https:\/\/[^\s"'\\<>]+$/.test(tiny.logo) ? tiny.logo : '';
  const logoIsVideo = /\.(mp4|webm)([?#]|$)/i.test(logoUrl);
  const customChips: string[] = Array.isArray(tiny?.chips)
    ? tiny.chips.filter((c: any) => typeof c === 'string' && c.trim()).slice(0, 4)
    : [];
  // 📝 Owner-set landing subtitle — replaces the generic "A tiny — a living AI
  // at …" line when present (matches the worker's 200-char cap).
  const customTagline: string =
    typeof tiny?.tagline === 'string' ? tiny.tagline.trim().slice(0, 200) : '';
  const heroBgStyle = heroImage
    ? {
        backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.45), rgba(0,0,0,0.7) 55%, var(--tiny-bg, #000) 96%), url("${heroImage}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
      }
    : undefined;

  // One composer block, two homes (hero-centered / bottom-docked). All the
  // composer-status chips (streams/ambient/namePreview) travel with it.
  const composerBlock = (
    <>
              {/* ⚡ Concurrent streams status — with multiple replies live the
                  per-bubble spinners can all be off-screen; this chip is the
                  one fixed place that says work is happening, and stops it */}
              {liveIds.size > 1 && (
                <div role="status" className="flex items-center gap-2 px-4 py-1.5 mb-2 rounded-xl border text-xs w-fit animate-riseIn"
                  style={{ background: 'rgba(0,0,0,0.6)', borderColor: 'rgba(var(--tiny-accent-rgb),0.25)', color: 'var(--tiny-accent)' }}>
                  <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                  {liveIds.size} replies streaming
                  <button
                    onClick={stopAllStreams}
                    title="Stop all (⌘.)"
                    className="ml-1 px-2 py-0.5 rounded-md border text-red-400 hover:bg-red-500/10 transition-colors"
                    style={{ borderColor: 'rgba(var(--tiny-danger-rgb), 0.4)' }}
                  >
                    stop all
                  </button>
                </div>
              )}
              {/* 🌙 Ambient indicator (issue #12) — background thinking status */}
              {(ambientState === "running" || ambientState === "autonomous") && (
                <div role="status" className="flex items-center gap-2 px-4 py-1.5 mb-2 rounded-xl border text-xs w-fit animate-riseIn"
                  style={{ background: 'rgba(0,0,0,0.6)', borderColor: 'rgba(var(--tiny-accent-rgb),0.25)', color: 'var(--tiny-accent)' }}>
                  <IconMoon className="w-3.5 h-3.5 animate-pulse" />
                  {ambientState === "autonomous" ? "working autonomously — type to stop" : "thinking in the background…"}
                </div>
              )}
              {/* 🏷️ Live name claim preview (design item 6) — endowment
                  before creation: the URL renders as already theirs */}
              {namePreview && (
                <div aria-live="polite" className="flex items-center gap-2 px-4 py-1.5 mb-2 rounded-xl border text-xs w-fit animate-riseIn"
                  style={{ background: 'rgba(0,0,0,0.6)', borderColor: 'rgba(var(--tiny-accent-rgb),0.25)' }}>
                  {namePreview.free ? (
                    <>
                      <IconSparkles className="w-3.5 h-3.5" style={{ color: 'var(--tiny-accent)' }} />
                      <span className="font-mono" style={{ color: 'var(--tiny-accent)' }}>tiny.technology/{namePreview.slug}</span>
                      {claimAuthed === false ? (
                        <span className="text-gray-400">
                          is available —{' '}
                          <a
                            className="underline hover:opacity-80"
                            style={{ color: 'var(--tiny-accent)' }}
                            href={`/api/auth?return_to=${encodeURIComponent(`${window.location.pathname}?q=${encodeURIComponent(input)}&send=0`)}`}
                          >
                            sign in to claim it
                          </a>
                        </span>
                      ) : (
                        <span className="text-gray-400">is yours — send to claim it</span>
                      )}
                    </>
                  ) : (
                    <>
                      <IconLock className="w-3.5 h-3.5 text-gray-400" />
                      <span className="font-mono text-gray-400">tiny.technology/{namePreview.slug}</span>
                      <span className="text-gray-500">is taken — try another name</span>
                    </>
                  )}
                </div>
              )}
              {/* 🔗 Shared-conversation banner — replaces the input while viewing */}
              {viewingShare && replayVisible !== null ? (
                /* 🎬 Replay scrubber — plays the share back message-by-message */
                <ReplayBar
                  total={messages.length}
                  visible={replayVisible}
                  onVisibleChange={setReplayVisible}
                  onExit={() => setReplayVisible(null)}
                />
              ) : viewingShare ? (
                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border" style={{
                  background: 'rgba(0,0,0,0.6)',
                  backdropFilter: 'blur(10px)',
                  borderColor: 'rgba(var(--tiny-accent-rgb),0.3)',
                }}>
                  <span className="text-sm text-gray-300">
                    👀 You&apos;re viewing a <span style={{ color: 'var(--tiny-accent)' }}>shared conversation</span> — read-only.
                  </span>
                  <button
                    onClick={() => setReplayVisible(0)}
                    className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-105 whitespace-nowrap border"
                    style={{ color: 'var(--tiny-accent)', borderColor: 'rgba(var(--tiny-accent-rgb),0.4)' }}
                    title="Play the conversation back message-by-message"
                  >
                    🎬 Replay
                  </button>
                  <button
                    onClick={continueFromShare}
                    className="px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-105 whitespace-nowrap"
                    style={{ background: 'var(--tiny-accent)', color: '#000', boxShadow: '0 0 16px rgba(var(--tiny-accent-rgb),0.22)' }}
                  >
                    Continue here →
                  </button>
                </div>
              ) : (
              <>
              {/* (The endowment preview lives above as the namePreview
                  banner — availability-checked "is yours / is taken".
                  A second regex-only copy rendered here until pass 74:
                  two banners, and this one claimed taken names.) */}
              <form
                onSubmit={
                  priv && !isAuthorized
                    ? login
                    : onSubmit
                }
                className="w-full"
              >
                {/* 📎 Hidden pickers — camera input opens the iOS/Android
                    camera directly via capture="environment" */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  accept="image/*,.pdf,.csv,.doc,.docx,.xls,.xlsx,.txt,.md,.json,.xml,.html,text/*"
                  onChange={(e) => { if (e.target.files) handleIngestFiles(e.target.files); e.target.value = ''; }}
                />
                <input
                  ref={cameraInputRef}
                  type="file"
                  hidden
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => { if (e.target.files) handleIngestFiles(e.target.files); e.target.value = ''; }}
                />
                {/* The composer is the page's figural element — the only
                    animated glow (composer-breathe, globals.css). Toolbar sits
                    ABOVE the textarea so the full card width belongs to the
                    text — smooth typing, no flanking buttons. */}
                {/* rounded-[22px] = the iOS composer signature (Views.swift:2230
                    r22 on ultraThinMaterial) — cards 14 / bubbles 18 / composer 22 */}
                <div className="border rounded-[22px] transition-colors composer-breathe" style={{
                  background: 'rgba(0,0,0,0.5)',
                  backdropFilter: 'blur(10px)',
                  borderColor: 'rgba(var(--tiny-accent-rgb),0.3)'
                }}>
                  {/* 📎 Pending attachment chips */}
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-4 pt-3">
                      {attachments.map((att, i) => (
                        <div key={i} className="relative group">
                          {att.type === 'image' && (att.dataUrl || att.thumb) ? (
                            <img
                              src={att.thumb || att.dataUrl}
                              // A pasted/dropped image often has no filename
                              // (empty in Safari), so `att.name || ''` gave an
                              // EMPTY alt — marking the chip decorative, so a
                              // screen reader never announced the pending image.
                              // Fall back to "image attachment" (the message-
                              // bubble twin at :3346 already does this).
                              alt={att.name || 'image attachment'}
                              className="h-14 w-14 object-cover rounded-lg border"
                              style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.3)' }}
                            />
                          ) : (
                            <div className="h-14 min-w-[3.5rem] max-w-[8rem] rounded-lg border flex flex-col items-center justify-center px-2"
                              title={att.name || 'file'}
                              style={{ background: 'rgba(var(--tiny-accent-rgb),0.05)', borderColor: 'rgba(var(--tiny-accent-rgb),0.3)' }}>
                              <span className="text-sm">📄</span>
                              <span className="text-[9px] text-gray-400 truncate w-full text-center">{att.name || 'file'}</span>
                            </div>
                          )}
                          {/* focus-visible keeps the button findable for
                              keyboard users — hidden-until-hover is a
                              mouse-only affordance */}
                          <button
                            type="button"
                            aria-label={`Remove ${att.name || 'attachment'}`}
                            onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                            // Hit target ≥ the mark: the tappable button is
                            // 28px while the visible badge stays the 16px dot
                            // (same fix both natives shipped — the bare badge
                            // was tap-only on its tiny glyph, e03224f).
                            className="absolute -top-2.5 -right-2.5 w-7 h-7 flex items-center justify-center transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <span
                              aria-hidden="true"
                              className="w-4 h-4 rounded-full text-[10px] leading-none flex items-center justify-center"
                              style={{ background: 'var(--tiny-danger)', color: '#fff' }}
                            >
                              ×
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 📞 In-call strip — the live call is part of THIS chat:
                      transcripts land in the thread above, and typing joins
                      the call. End hangs up; the composer stays usable. */}
                  {callStatus !== "off" && (
                    <div className="px-3 pt-2" aria-live="polite">
                      <div className="flex items-center gap-2 text-[12px] text-gray-400">
                        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "var(--tiny-accent)" }} />
                          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "var(--tiny-accent)" }} />
                        </span>
                        <span className="shrink-0" style={{ color: "var(--tiny-accent)" }}>📞 In call with {name}</span>
                        {callStatus === "connecting" ? (
                          <span className="shrink-0">connecting…</span>
                        ) : (
                          /* Mic level — state-driven but throttled to ~10/s */
                          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                            <div
                              className="h-full w-full origin-left"
                              style={{ background: "var(--tiny-accent)", transform: `scaleX(${Math.min(1, callLevel)})`, transition: "transform 120ms linear" }}
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={endLiveCall}
                          className="ml-auto shrink-0 px-2 py-0.5 rounded-md border text-red-400 hover:bg-red-500/10 transition-colors"
                          style={{ borderColor: "rgba(var(--tiny-danger-rgb), 0.4)" }}
                        >
                          End
                        </button>
                      </div>
                    </div>
                  )}
                  {/* 🎙️ Voice strip — live status + partial transcript while
                      voice mode is open. The transcript does not touch the
                      composer; it auto-sends after a 3s pause. */}
                  {voiceMode && (
                    <div className="px-3 pt-2" aria-live="polite">
                      <div className="flex items-center gap-2 text-[12px] text-gray-400">
                        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "var(--tiny-accent)" }} />
                          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: "var(--tiny-accent)" }} />
                        </span>
                        <span className="shrink-0">
                          {voiceProgress
                            ? voiceProgress
                            : voiceStatus === "transcribing"
                            ? "Transcribing…"
                            : voiceStatus === "speech"
                            ? "Hearing you…"
                            : "Listening — pause 3s to send"}
                        </span>
                        {/* Level meter: ref-driven transform, no re-renders */}
                        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                          <div
                            ref={voiceLevelRef}
                            className="h-full w-full origin-left"
                            style={{ background: "var(--tiny-accent)", transform: "scaleX(0)", transition: "transform 120ms linear" }}
                          />
                        </div>
                      </div>
                      {voicePartial && (
                        <div className="mt-1 text-[13px] text-gray-300 italic">“{voicePartial}”</div>
                      )}
                    </div>
                  )}
                  {/* 🧰 Toolbar — attach/camera/mic left, token count + send right */}
                  <div className="flex items-center gap-0.5 px-2 pt-2">
                    {!(priv && !isAuthorized) && (
                      <>
                        <button
                          type="button"
                          aria-label="Attach files"
                          title="Attach files"
                          onClick={() => fileInputRef.current?.click()}
                          className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label="Take photo"
                          title="Take photo"
                          onClick={() => cameraInputRef.current?.click()}
                          className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
                          </svg>
                        </button>
                        {/* 🎙️ Voice mode (hidden where getUserMedia/workers are
                            missing). canVoice (effect-resolved), NOT
                            liveVoiceSupported() inline — the direct call
                            differs between SSR and client = hydration error */}
                        {canVoice && (
                          <button
                            type="button"
                            aria-label={voiceMode ? "Stop voice mode" : "Start voice mode"}
                            aria-pressed={voiceMode}
                            title={voiceMode ? "Stop voice mode" : "Voice mode — on-device transcription; pause 3s to send"}
                            onClick={() => void toggleVoiceMode()}
                            className={`p-2 rounded-lg transition-colors ${voiceMode ? "animate-pulse" : "text-gray-500 hover:text-white hover:bg-gray-800"}`}
                            style={voiceMode ? { color: "var(--tiny-accent)", background: "rgba(var(--tiny-accent-rgb),0.15)" } : undefined}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                            </svg>
                          </button>
                        )}
                        {/* 📍 Location context — same toggle grammar as voice
                            mode. Enabling starts the shared GPS watch (browser
                            permission prompt fires here, on the tap); while on,
                            every send carries position/speed/heading to the
                            tiny via x-tiny-metadata. */}
                        <button
                          type="button"
                          aria-label={geoOn ? "Stop sharing location with this tiny" : "Share location with this tiny"}
                          aria-pressed={geoOn}
                          title={geoOn ? "Location on — position/speed ride along with each message" : "Share location — lets this tiny see your position and speed"}
                          onClick={toggleGeo}
                          className={`p-2 rounded-lg transition-colors ${geoOn ? "" : "text-gray-500 hover:text-white hover:bg-gray-800"}`}
                          style={geoOn ? { color: "var(--tiny-accent)", background: "rgba(var(--tiny-accent-rgb),0.15)" } : undefined}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                          </svg>
                        </button>
                      </>
                    )}
                    <div className="flex-1" />
                    {/* 💵 Paid-tiny price badge — surfaces the per-message cost
                        up front so the paywall is never a surprise; taps open
                        the top-up sheet. Hidden for free tinys (priceMicro null). */}
                    {priceMicro !== null && !(priv && !isAuthorized) && (
                      <button
                        type="button"
                        onClick={() => setShowWallet(true)}
                        title="This tiny charges per message — tap to add funds"
                        // The visible label is just "💵 $X/msg"; a screen reader would
                        // otherwise announce that raw glyph string with no hint that
                        // it's a charge or that it's actionable (title= is a tooltip,
                        // not a reliable accessible name). Spell it out with the price
                        // — byte-parity with iOS's accessibilityLabel (Views.swift:2551
                        // "This tiny charges $X per message — tap to add funds").
                        aria-label={`This tiny charges ${usdRate(priceMicro)} per message — tap to add funds`}
                        className="tabular-nums text-[11px] mr-1.5 px-1.5 py-0.5 rounded-md select-none transition-colors hover:brightness-125"
                        style={{ color: 'var(--tiny-accent)', background: 'rgba(var(--tiny-accent-rgb),0.1)' }}
                      >
                        💵 {usdRate(priceMicro)}/msg
                      </button>
                    )}
                    {/* 💵 Draft token estimate (~4 chars/token) */}
                    {input.trim().length > 0 && (
                      <span className="tabular-nums text-[11px] text-gray-600 mr-1 select-none" title="Estimated tokens in the draft (~4 chars/token)">
                        ~{Math.ceil(input.length / 4)} tok
                      </span>
                    )}
                    <button
                      type="submit"
                      disabled={!input.trim() && attachments.length === 0}
                      aria-label="Send"
                      title="Send (Enter) — Shift+Enter for a new line"
                      className="p-2 rounded-xl transition-all hover:scale-105 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                      style={{
                        background: (input.trim() || attachments.length) ? 'var(--tiny-accent)' : 'rgba(var(--tiny-accent-rgb),0.15)',
                        color: (input.trim() || attachments.length) ? '#000' : '#666',
                        boxShadow: (input.trim() || attachments.length) ? '0 0 14px rgba(var(--tiny-accent-rgb),0.25)' : 'none'
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
                      </svg>
                    </button>
                  </div>
                  <textarea
                    id="composer-input"
                    dir="auto"
                    // Mobile keyboards label the return key "send" — Enter DOES
                    // send here (shouldSendOnEnter), and the DM composer
                    // (MessagesHUD) already says so; the app's single most-used
                    // input shouldn't be the one with a generic key. Spread-cast
                    // because @types/react 18.2.8 has enterKeyHint on <input>
                    // but not <textarea>; React's runtime supports both.
                    {...({ enterKeyHint: "send" } as Record<string, string>)}
                    aria-label={`Message ${name}`}
                    className="w-full bg-transparent px-4 pb-3 pt-1.5 text-[17px] text-white placeholder-gray-500 focus:outline-none resize-none"
                    value={input}
                    autoFocus
                    ref={inputRef}
                    placeholder={
                      priv && !isAuthorized
                        ? "Private AI — sign in or enter key"
                        : voiceMode
                        ? "🎙️ Voice mode — speak; typing still works"
                        : `Message ${name}...`
                    }
                    onChange={(e) => { setInput(e.target.value); ambientRef.current?.cancel(); }}
                    onPaste={handlePaste}
                    rows={1}
                    style={{ minHeight: '56px', maxHeight: '240px' }}
                    onKeyDown={(e: any) => {
                      // Escape stops voice mode — the mic button shouldn't be
                      // the only way out while focus is in the composer
                      if (e.key === "Escape" && voiceMode) {
                        e.preventDefault();
                        stopVoiceMode();
                        return;
                      }
                      if (shouldSendOnEnter(e)) {
                        e.preventDefault();
                        if (priv && !isAuthorized) {
                          login({ preventDefault: () => { }, target: [{ value: e.currentTarget.value }] });
                          return;
                        }
                        onSubmit(e);
                      }
                    }}
                  />
                </div>
                {/* ⌨️ Visible hints (careless pattern) — tooltips alone
                    don't teach; one quiet line under the card does */}
                <div className="mt-1.5 px-2 text-[11px] text-gray-600 select-none">
                  <span className="hidden sm:inline">enter send · shift+enter newline · <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-gray-400 transition-colors" onClick={() => setShowPalette(true)}>/ commands</button> · paste/drop files</span>
                  <span className="sm:hidden">enter send · <button type="button" className="underline decoration-dotted underline-offset-2" onClick={() => setShowPalette(true)}>/ commands</button></span>
                </div>
              </form>
              </>
              )}
    </>
  );

  return (
    <div className="min-h-screen bg-black text-white">
      {/* ⏭️ Skip link — visible only on keyboard focus; jumps past the
          header (and any long conversation) straight to the composer */}
      <a
        href="#composer-input"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-4 focus:py-2 focus:rounded-lg"
        style={{ background: 'var(--tiny-accent)', color: '#000' }}
      >
        Skip to message input
      </a>
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.2)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3 sm:py-4 flex items-center justify-between gap-3">
          {/* 🌌 Universe drawer — builders & public tinys, header-left
              (careless AgentsPanel slot). Replaces the old home-page footer
              section that overlapped the fixed composer. */}
          <UniverseDrawer />
          {/* The page's ONE h1 (the hero's big name is decorative — it comes
              and goes with turn zero; a page title shouldn't). Tapping
              scrolls to top — expected "home" affordance. */}
          <h1 className="text-lg sm:text-xl font-bold truncate min-w-0 flex-1">
            {/* No aria-label: it would REPLACE the name as the accessible
                text, making the page's h1 read "Scroll to top". title=
                hints the behavior without renaming the heading. */}
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              title="Scroll to top"
              className="max-w-full truncate text-left cursor-pointer select-none"
              style={{ color: 'var(--tiny-accent)', textShadow: '0 0 10px rgba(var(--tiny-accent-rgb),0.4)' }}
            >
              {name}
            </button>
          </h1>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* 💬 Messages HUD — user↔user DMs (inbox/thread/reply) */}
            <MessagesHUD tinyName={name} />
            {/* ⚡ Activity HUD — background events (jobs/telegram/visits) */}
            <ActivityHUD />
            {/* 🔐 Auth — logged in: settings gear + avatar menu (share/clear
                inside); logged out: login buttons only */}
            <AuthButton
              onOpenSettings={() => setShowModelSettings(true)}
              onOpenMemory={() => setShowMemory(true)}
              onOpenJobs={() => setShowJobs(true)}
              onShare={handleShare}
              onClear={handleClear}
              // Not while viewing a share: "Clear history" would wipe YOUR
              // saved conversation while looking at someone else's, and
              // re-sharing a share is adopt-first ("Continue here") anyway
              hasMessages={hasConversation && !viewingShare}
            />
          </div>
        </div>
      </header>

      {/* Toasts follow the neon theme instead of sonner's stock white.
          offset clears the fixed header (toasts were covering the tiny's
          name); 3 visible + 2.5s keeps ~60 call sites from stacking a
          wall during rapid tool sequences. */}
      <Toaster
        position="top-center"
        offset={72}
        visibleToasts={3}
        duration={2500}
        toastOptions={{
          style: {
            background: "rgba(0,0,0,0.85)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(var(--tiny-accent-rgb),0.3)",
            color: "#fff",
            boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb),0.15)",
          },
        }}
      />
      <InstallPrompt name={name} />
      {/* 🛑 House confirm dialog (useConfirm) — portaled, focus-trapped */}
      {confirmDialogEl}

      {/* 📎 Drag-and-drop overlay */}
      {dragOver && (
        <div role="status" className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="px-10 py-8 rounded-2xl border-2 border-dashed text-lg font-semibold animate-riseIn" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.6)', color: 'var(--tiny-accent)' }}>
            📎 Drop files to share with {name}
          </div>
        </div>
      )}
      <ModelSettings open={showModelSettings} onClose={() => setShowModelSettings(false)} tinyName={name} />
      {showWallet && <WalletSheet
        onClose={() => { paywallAwaitingFundsRef.current = null; setShowWallet(false); }}
        onFunded={(balanceMicro) => {
          setShowWallet(false);
          // If the sheet was opened from a paywall card's "💳 Add funds" and the
          // top-up now covers that tiny's price, auto-continue the held turn —
          // otherwise the user funds their wallet then stares at a stale paywall
          // and has to hunt for Retry. Only fires for the paywall opener (ref set
          // at :3515); badge/`/wallet` openers leave it null → plain refresh.
          const awaitingId = paywallAwaitingFundsRef.current;
          paywallAwaitingFundsRef.current = null;
          if (!awaitingId) return;
          const msgs = messagesRef.current;
          const idx = msgs.findIndex((msg) => msg.id === awaitingId);
          const pw = idx >= 0 ? msgs[idx].paywall : undefined;
          // Don't auto-send if funds still fall short — leave the card so the
          // user sees the (now-smaller) shortfall and can top up again or Retry.
          if (!pw || Number(balanceMicro) < pw.priceMicro) return;
          const { messages: updated, attachments: retryAttachments } = dropTurnPairAt(msgs, idx);
          messagesRef.current = updated;
          setMessages(updated);
          send(pw.prompt, retryAttachments);
        }}
      />}
      {/* 🧬 Memory Panel — chips, freshness, closed history */}
      <MemoryPanel open={showMemory} onClose={() => setShowMemory(false)} />
      {/* ⏰ Jobs Panel — scheduled background jobs: cadence, runs, delete */}
      <JobsPanel open={showJobs} onClose={() => setShowJobs(false)} />
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        commands={PALETTE_COMMANDS.map((c) => ({
          // Derived from the slash dispatch's own manifest (lib/chat/
          // slash-commands) — this array was a second hand-maintained copy
          // before c15. `slash` runs the command; `prefill` seeds the
          // composer for commands that take arguments (/auto, /loop).
          name: c.name,
          description: c.description,
          shortcut: c.shortcut,
          action: () => {
            if (c.invoke.kind === "slash") trySlashCommand(c.invoke.command);
            else { setInput(c.invoke.text); inputRef.current?.focus(); }
          },
        }))}
        onAsk={(text) => send(text)}
        currentTiny={name}
      />

      <main className="max-w-4xl mx-auto pt-20 pb-32">
          {/* 🌅 First-visit hero — replaces the raw system-prompt bubble at
              turn zero (recognition over recall: starter chips beat a blank
              box). Gone forever after the first user message. */}
          {/* 🔒 Private tiny, locked, turn zero: a calm lock hero instead of
              the bare "This AI is private." system bubble. No starter chips —
              chatting is gated; the one action is signing in. */}
          {!hasConversation && !viewingShare && priv && !isAuthorized && (
            /* Composer renders INSIDE this hero (heroMode) — center within
               the viewport minus the header only; no bottom dock to clear. */
            <div className="px-4 pb-2 text-center flex flex-col justify-center min-h-[calc(100dvh-10rem)]" style={heroBgStyle}>
              <div className="mb-3 flex justify-center" aria-hidden="true"><IconLock className="w-10 h-10" style={{ color: "var(--tiny-accent)", opacity: 0.8 }} /></div>
              {/* Presentational — the page's h1 lives in the header */}
              <div
                className="text-4xl sm:text-5xl font-bold mb-3"
                style={{ color: 'var(--tiny-accent)', textShadow: '0 0 24px rgba(var(--tiny-accent-rgb),0.45)' }}
              >
                {name}
              </div>
              <p className="text-sm text-gray-400">
                This tiny is private — its owner decides who can talk to it.
              </p>
              <p className="text-xs text-gray-500 mt-1.5">
                Sign in if it's yours, or enter its access key.
              </p>
              <div className="w-full max-w-2xl mx-auto mt-8 text-left">
                {composerBlock}
              </div>
            </div>
          )}
          {!hasConversation && !viewingShare && (!priv || isAuthorized) && (
            /* Google-style opening: the composer renders INSIDE this hero
               (heroMode) — one centered composition, no dead gulf. dvh so
               mobile URL bars don't push it off balance.
               `|| isAuthorized`: an owner who has unlocked their OWN private
               tiny gets the normal hero + composer. Without it, the state
               (priv && isAuthorized && turn-zero) matched neither this hero
               (needs !priv) nor the lock hero above (needs !isAuthorized),
               and the dock only shows when !heroMode → no composer, the
               "I can auth but can't send" bug. */
            <div className="px-4 pb-2 text-center flex flex-col justify-center min-h-[calc(100dvh-10rem)]" style={heroBgStyle}>
              {/* 🎭 Owner-set logo — decorative (the name right below is the label).
                  Fixed-height slot: the tiny RECORD (server-rendered) already says a
                  logo exists before its bytes arrive, so reserve the 96px up front —
                  the marquee title must not jump down when a slow logo lands (CLS).
                  Small logos center in the slot rather than collapsing it. */}
              {logoUrl && (
                <div className="mx-auto mb-4 h-24 flex items-center justify-center" style={{ maxWidth: '80%' }} aria-hidden="true">
                  {logoIsVideo ? (
                    <video
                      src={logoUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="max-h-full max-w-full rounded-xl object-contain"
                    />
                  ) : (
                    <img
                      src={logoUrl}
                      alt=""
                      decoding="async"
                      className="max-h-full max-w-full rounded-xl object-contain"
                    />
                  )}
                </div>
              )}
              {/* Presentational — the page's h1 lives in the header */}
              <div
                className="text-4xl sm:text-5xl font-bold mb-3"
                style={{ color: 'var(--tiny-accent)', textShadow: '0 0 24px rgba(var(--tiny-accent-rgb),0.45)' }}
              >
                {name}
              </div>
              <p className="text-sm text-gray-400 mb-6">
                {unclaimed
                  ? <>Nobody has claimed <span className="font-mono" style={{ color: 'var(--tiny-accent)' }}>tiny.technology/{name}</span> yet — it could be yours.</>
                  : customTagline // 📝 owner-set tagline wins over the generic line
                  ? customTagline
                  : name === 'tiny'
                  ? 'Create your own AI by chatting — free, forever.'
                  : `A tiny — a living AI at tiny.technology/${name}. Say anything.`}
                {/* 📈 Social proof (design item 5) — home page, above the fold */}
                {name === 'tiny' && heroStats && (
                  <span className="block mt-1.5 text-xs text-gray-500">
                    <span style={{ color: 'var(--tiny-accent)' }}>{heroStats}</span> users and counting — building their own AIs by chatting
                  </span>
                )}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {(customChips.length
                  ? customChips // 🎭 owner-set starter chips replace the defaults
                  : unclaimed
                  ? [
                      `Create an AI named ${name} …`,
                      'What is this place?',
                    ]
                  : name === 'tiny'
                  ? [
                      'Create an AI named …',
                      'What is this place?',
                      'Show me what a tiny can do',
                    ]
                  : [
                      `What can you do?`,
                      `Who made you?`,
                      `Surprise me`,
                    ]
                ).map((chip) => (
                  <button
                    key={chip}
                    onClick={() => {
                      if (chip.endsWith('…')) {
                        setInput(chip.replace('…', ''));
                        inputRef.current?.focus();
                      } else {
                        send(chip);
                      }
                    }}
                    className="px-4 py-2 rounded-full text-sm transition-all hover:scale-105 border neon-chip"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              {/* 🎯 Turn-zero composer — centered with the hero,
                  Google-style. Same block as the docked composer. */}
              <div className="w-full max-w-2xl mx-auto mt-8 text-left">
                {composerBlock}
              </div>
              {/* Power-user hint — desktop only (no ⌘⇧K on touch); quiet
                  enough to skip, present enough to teach */}
              <p className="hidden sm:block text-[11px] text-gray-600 mt-8 select-none">
                <kbd className="px-1.5 py-0.5 rounded border font-mono text-[10px]" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>⌘K</kbd> universe · <kbd className="px-1.5 py-0.5 rounded border font-mono text-[10px]" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>⌘⇧K</kbd> commands · <kbd className="px-1.5 py-0.5 rounded border font-mono text-[10px]" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>/</kbd> slash commands
              </p>
            </div>
          )}
          {/* Messages — replay mode (share views) slices to the scrub position */}
          <div className="px-4 space-y-6 py-6">
            {messages.length > 0 &&
              (replayVisible === null ? messages : messages.slice(0, replayVisible)).map((m, index, rendered) => {
                const isUser = m.role === 'user';
                const isSystem = m.role === 'system';
                const isEditing = editingMessageId === m.id;
                const isStreaming = liveIds.has(m.id);

                // A deleted message is a tombstone — a quiet caption, no bubble
                // and no action row. The old path rendered "_deleted..._" as a
                // normal editable bubble (Copy gave the sentinel, Edit could
                // un-delete). Keep it in the list for stable keys/positions.
                if (m.content === "_deleted..._" && !m.attachments?.length) {
                  return (
                    <div key={m.id} className="flex justify-center">
                      <span className="text-xs italic cursor-default" style={{ color: '#555' }}>
                        🗑️ message deleted
                      </span>
                    </div>
                  );
                }

                if (isSystem) {
                  // Turn zero: a hero already introduces the tiny (public
                  // hero, or the locked hero for private ones) — the raw
                  // system message is redundant there.
                  if (!hasConversation && !viewingShare && (!priv || !isAuthorized)) return null;
                  // Mid-conversation: a quiet one-line caption, not a gray box
                  // of prompt text. Details stay a hover/tap away (title).
                  const raw = typeof m.content === "string" ? m.content : String(m.content ?? "");
                  return (
                    <div key={m.id} className="flex justify-center">
                      <span
                        className="text-xs italic text-center max-w-md truncate cursor-default"
                        style={{ color: '#666' }}
                        title={raw}
                      >
                        {priv ? raw : `⌁ ${name}'s essence — hover to peek`}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={m.id}
                    ref={index === messages.length - 1 ? lastMessageRef : null}
                    className={`flex group ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={isUser ? 'max-w-[70%]' : 'w-full'}>
                      {/* Tool calls */}
                      {m.toolCalls && m.toolCalls.length > 0 && (
                        <div className="mb-3 space-y-2">
                          {m.toolCalls.filter(tool => tool.name !== 'render_ui' && tool.name !== 'suggest_followups').map((tool) => (
                            tool.name === 'spawn_agents' ? (
                              /* 🌳 Fan-out task tree — per-sub-agent status */
                              <TaskTree key={tool.id} input={tool.input} result={tool.result} status={tool.status} />
                            ) : tool.name === 'pay_x402' || tool.name === 'make_payment' ? (
                              /* 🤝 Agent payments — x402 (pay_x402) and P2P sends
                                 (make_payment) share the confirm card: both spend
                                 the user's balance only on the Approve tap, so
                                 both get the receipt card, not a JSON blob. */
                              <PayReceipt
                                key={tool.id}
                                status={tool.status}
                                result={tool.result}
                                error={tool.error}
                                settled={tool.paySettled}
                                onSettled={(s) => setMessages((prev) => prev.map((mm) =>
                                  mm.id === m.id
                                    ? { ...mm, toolCalls: mm.toolCalls?.map((t) =>
                                        t.id === tool.id ? { ...t, paySettled: s } : t) }
                                    : mm))}
                              />
                            ) : (
                            <div
                              key={tool.id}
                              className="px-4 py-3 rounded-xl border"
                              style={{
                                background: 'rgba(0,0,0,0.5)',
                                backdropFilter: 'blur(10px)',
                                borderColor: tool.status === 'calling' ? 'rgba(var(--tiny-accent-rgb),0.5)' : 
                                           tool.status === 'success' ? 'rgba(var(--tiny-accent-rgb),0.3)' : 'rgba(255,0,0,0.5)'
                              }}
                            >
                              <div className="flex items-center gap-2 mb-2">
                                {tool.status === 'calling' && (
                                  <span role="status" aria-label={`${tool.name} running`} className="inline-block w-3 h-3 rounded-full animate-spin" style={{
                                    border: '2px solid rgba(var(--tiny-accent-rgb),0.3)',
                                    borderTopColor: 'var(--tiny-accent)'
                                  }}></span>
                                )}
                                {tool.status === 'success' && (
                                  <span aria-label="succeeded" style={{ color: 'var(--tiny-accent)' }}>✓</span>
                                )}
                                {tool.status === 'error' && (
                                  <span aria-label="failed" style={{ color: 'var(--tiny-danger)' }}>✗</span>
                                )}
                                <span className="font-mono text-xs font-semibold" style={{ color: 'var(--tiny-accent)' }}>{tool.name}</span>
                              </div>
                              {tool.input && (
                                <details className="text-xs text-gray-400 mt-2">
                                  <summary className="cursor-pointer hover:text-gray-300">Input</summary>
                                  {/* max-h: multi-KB payloads scroll inside instead of
                                      making the expanded card a screen-tall wall */}
                                  <pre className="mt-2 p-2 rounded-lg overflow-auto max-h-56 bg-black/50 text-gray-300">
                                    {JSON.stringify(tool.input, null, 2)}
                                  </pre>
                                </details>
                              )}
                              {tool.result && (
                                <details className="text-xs text-gray-400 mt-2">
                                  <summary className="cursor-pointer hover:text-gray-300">Result</summary>
                                  <pre className="mt-2 p-2 rounded-lg overflow-auto max-h-56 bg-black/50 text-gray-300">
                                    {JSON.stringify(tool.result, null, 2)}
                                  </pre>
                                </details>
                              )}
                              {tool.error && (
                                <div className="text-xs text-red-400 mt-2">
                                  Error: {tool.error}
                                </div>
                              )}
                            </div>
                            )
                          ))}
                        </div>
                      )}

                      {/* Reasoning block — muted glass, not a foreign hue:
                          the site has ONE accent; hardcoded purple clashed
                          under theme swaps. 💭 + dim styling carry the
                          "internal monologue" signal instead. */}
                      {m.reasoning && m.reasoning.length > 0 && (
                        <details className="mb-3 px-4 py-3 rounded-xl border" style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.1)' }}>
                          <summary className="cursor-pointer font-semibold text-xs text-gray-400 hover:text-gray-200 transition-colors">💭 Reasoning</summary>
                          <div className="mt-2 text-xs text-gray-400 whitespace-pre-wrap max-h-56 overflow-y-auto">
                            {m.reasoning}
                          </div>
                        </details>
                      )}

                      {/* UI Components - 100% Dynamic */}
                      {m.uiComponents && m.uiComponents.length > 0 && (
                        <div className="mb-3 space-y-3">
                          {m.uiComponents.map((uiComponent) => (
                            <DynamicUI
                              key={uiComponent.id}
                              id={uiComponent.id}
                              componentCode={uiComponent.componentCode}
                              props={uiComponent.props}
                              title={uiComponent.title}
                            />
                          ))}
                        </div>
                      )}

                      {/* 🔊 Spoken replies (speak tool) — play button + transcript */}
                      {m.speech && m.speech.length > 0 && (
                        <div className="mb-3 space-y-2">
                          {m.speech.map((s) => (
                            <SpeechCard key={s.id} id={s.id} text={s.text} voice={s.voice} />
                          ))}
                        </div>
                      )}


                      {/* 📎 Attachments (photos/documents shared with the agent) */}
                      {m.attachments && m.attachments.length > 0 && (
                        <div className={`mb-2 flex flex-wrap gap-2 ${isUser ? 'justify-end' : ''}`}>
                          {m.attachments.map((att, ai) => {
                            const src = att.dataUrl || att.thumb;
                            // Full image while in-session; thumb after reload.
                            // Titled tab + Esc-to-close — behave like a real page.
                            //
                            // XSS GUARD: att.dataUrl is NOT always self-generated.
                            // A restored `?chat=` deep-link (Chat.tsx:538 →
                            // sanitizeMessages keeps `attachments`, stripping only
                            // uiComponents) is ATTACKER-CONTROLLED, so interpolating
                            // it raw into document.write let a crafted
                            // `dataUrl='"><script>…'` break out of the src attribute
                            // and run script in this window.open() document — which
                            // inherits tiny.technology's origin → localStorage
                            // (provider API keys / session). Only open a value with
                            // a safe media scheme, and set it as a PROPERTY (img.src)
                            // via DOM APIs — never as interpolated HTML — so no markup
                            // is ever parsed from the URL.
                            const openFull = () => {
                              const imgSrc = att.dataUrl || att.thumb || '';
                              if (!/^(data:image\/|https:\/\/|blob:)/i.test(imgSrc)) return;
                              const w = window.open();
                              if (!w) return;
                              const doc = w.document;
                              doc.title = `${att.name || 'image'} · tiny`;
                              doc.body.style.cssText = 'margin:0;background:#000;display:grid;place-items:center;height:100vh';
                              const img = doc.createElement('img');
                              img.src = imgSrc; // property assignment — not HTML parsing
                              img.style.cssText = 'max-width:100%;max-height:100%';
                              doc.body.appendChild(img);
                              doc.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') w.close(); });
                            };
                            const imgKey = `${m.id}:${ai}`;
                            return att.type === 'image' && src && !failedImages.has(imgKey) ? (
                              <img
                                key={ai}
                                src={src}
                                alt={att.name || 'attachment'}
                                className="h-24 w-24 object-cover rounded-xl border cursor-pointer"
                                style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.3)' }}
                                // Keyboard/switch users must be able to open the
                                // lightbox too — a bare <img onClick> is pointer-only
                                // and invisible to the tab order and screen readers.
                                // role="button" + tabIndex + Enter/Space parity make
                                // the thumbnail an operable control (the popup already
                                // has its own Esc-to-close handler above).
                                role="button"
                                tabIndex={0}
                                aria-label={`View ${att.name || 'image'} full size`}
                                // Corrupt/evicted dataUrl after restore → flag it in
                                // React state so the "unavailable" fallback renders
                                // BELOW through the normal tree. NEVER mutate
                                // el.outerHTML here: that swaps a node React holds no
                                // fiber ref to, and a later reconciliation removing/
                                // reordering this message removeChild()s a node the
                                // parent no longer owns → NotFoundError → blank page.
                                onError={() => setFailedImages((prev) => {
                                  if (prev.has(imgKey)) return prev;
                                  const next = new Set(prev);
                                  next.add(imgKey);
                                  return next;
                                })}
                                onClick={openFull}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault(); // Space must activate, not scroll
                                    openFull();
                                  }
                                }}
                              />
                            ) : att.type === 'image' && src ? (
                              // Load-failed image (in failedImages) — the declarative
                              // twin of the old outerHTML swap, same glyph + sizing.
                              <span
                                key={ai}
                                className="h-24 w-24 rounded-xl border flex flex-col items-center justify-center text-xs text-gray-500"
                                style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.3)' }}
                              >
                                🖼️<span className="text-[9px] mt-1">unavailable</span>
                              </span>
                            ) : (
                              <div
                                key={ai}
                                className="h-24 min-w-[6rem] max-w-[10rem] rounded-xl border flex flex-col items-center justify-center px-3 gap-1"
                                style={{ background: 'rgba(0,0,0,0.5)', borderColor: 'rgba(var(--tiny-accent-rgb),0.3)' }}
                              >
                                <span className="text-xl">📄</span>
                                <span className="text-[10px] text-gray-400 truncate w-full text-center">{att.name || 'file'}</span>
                                {att.format && <span className="text-[9px] uppercase" style={{ color: 'var(--tiny-accent)' }}>{att.format}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Message bubble or edit mode (hidden for attachment-only sends) */}
                      {!isEditing && !m.content && !isStreaming && m.attachments?.length ? null : isEditing ? (
                        <div className="space-y-2">
                          <textarea
                            ref={editTextareaRef}
                            dir="auto"
                            className="w-full px-4 py-3 rounded-2xl border text-base resize-none"
                            style={{
                              background: 'rgba(0,0,0,0.5)',
                              backdropFilter: 'blur(10px)',
                              borderColor: 'rgba(var(--tiny-accent-rgb),0.4)',
                              color: '#fff',
                              minHeight: '100px'
                            }}
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                handleCancelEdit();
                              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                handleSaveEdit(m.id);
                              }
                            }}
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => handleCancelEdit()}
                              className="px-4 py-2 rounded-lg text-sm border transition-colors hover:text-white hover:bg-white/5"
                              style={{
                                background: 'rgba(0,0,0,0.5)',
                                borderColor: 'rgba(255,255,255,0.2)',
                                color: '#9ca3af'
                              }}
                            >
                              Cancel (Esc)
                            </button>
                            <button
                              onClick={() => handleSaveEdit(m.id)}
                              className="px-4 py-2 rounded-lg text-sm transition-all hover:scale-105"
                              style={{
                                background: 'var(--tiny-accent)',
                                color: '#000',
                                boxShadow: '0 0 16px rgba(var(--tiny-accent-rgb),0.22)'
                              }}
                            >
                              {/* navigator.platform is fine here: label-only hint */}
                              Save ({typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter)
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          // Bubble grammar tracks the iOS app (Views.swift:2802):
                          // r18; user = accent tint 0.22 (not solid accent — the
                          // accent stays chrome, the words stay white); assistant
                          // = elevated neutral (secondarySystemBackground equiv),
                          // hairline. No glow — glows belong to the composer/send.
                          className={`px-3.5 py-2.5 rounded-[18px] ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'} ${m.id === "1" && (m.content?.length || 0) > 280 ? (knowledgeExpanded ? 'knowledge-expandable' : 'knowledge-expandable knowledge-clamped') : ''}`}
                          style={
                            isUser
                              ? {
                                  background: 'rgba(var(--tiny-accent-rgb),0.22)',
                                  color: '#fff',
                                  border: '1px solid rgba(var(--tiny-accent-rgb),0.15)'
                                }
                              : {
                                  background: 'rgba(255,255,255,0.06)',
                                  backdropFilter: 'blur(10px)',
                                  color: '#fff',
                                  border: '1px solid rgba(255,255,255,0.08)'
                                }
                          }
                        >
                          {/* Typing indicator while waiting for the first token */}
                          {isStreaming && !m.content && (!m.toolCalls || m.toolCalls.length === 0) && (
                            <span role="status" className="inline-flex gap-1 items-center py-1" aria-label="Assistant is thinking">
                              {[0, 1, 2].map((d) => (
                                <span
                                  key={d}
                                  className="w-2 h-2 rounded-full animate-bounce"
                                  style={{ background: 'var(--tiny-accent)', animationDelay: `${d * 0.15}s` }}
                                />
                              ))}
                            </span>
                          )}
                          {/* .msg-md: the knowledge clamp's CSS hook. The old
                              hook was .prose — removed as a "phantom" in
                              02609a7 (typography plugin never installed),
                              which silently killed the clamp: every tiny page
                              rendered its FULL system knowledge (c28 QA). */}
                          <div className="msg-md">
                          <MarkdownContent content={typeof m.content === "string" ? m.content : String(m.content ?? "")} />
                          </div>
                          {/* 📖 Knowledge expand toggle (clamped seeded message) */}
                          {m.id === "1" && (m.content?.length || 0) > 280 && (
                            <button
                              aria-expanded={knowledgeExpanded}
                              onClick={(e) => {
                                const collapsing = knowledgeExpanded;
                                setKnowledgeExpanded(!knowledgeExpanded);
                                // Collapsing a long expansion can leave the
                                // viewport stranded mid-page — bring the
                                // bubble back into view
                                if (collapsing) {
                                  (e.currentTarget.closest('.msg-bubble-assistant') as HTMLElement | null)
                                    ?.scrollIntoView({ block: 'nearest' });
                                }
                              }}
                              className="mt-1 text-xs font-semibold hover:underline"
                              style={{ color: 'var(--tiny-accent)' }}
                            >
                              {knowledgeExpanded ? "Show less ↑" : "Read more ↓"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* 💸 Paywall — this priced tiny needs a funded wallet.
                          Shows the price, the current balance, and turns the
                          dead-end into a top-up + retry flow inline. */}
                      {m.role === "assistant" && m.paywall && !isStreaming && (
                        <div role="alert" className="mt-3 rounded-xl border p-4 animate-riseIn" style={{
                          background: 'rgba(var(--tiny-accent-rgb, 0,255,136),0.06)',
                          borderColor: 'rgba(var(--tiny-accent-rgb, 0,255,136),0.35)',
                        }}>
                          <div className="flex items-start gap-3">
                            <span className="text-xl leading-none" aria-hidden="true">💸</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold" style={{ color: 'var(--tiny-accent)' }}>
                                {m.paywall.signedOut ? "Sign in to chat with this tiny" : "This tiny is paid"}
                              </div>
                              <div className="mt-0.5 text-xs text-gray-300">
                                {(() => {
                                  // Money surface → canonical usd() (pads to 2 decimals, up to 6
                                  // sub-cent), matching the wallet ledger + native paywall copy. The
                                  // strip-zeros rule (usdRate) is only for the price BADGE, a rate.
                                  const price = usd(m.paywall.priceMicro);
                                  const bal = usd(m.paywall.balanceMicro);
                                  if (m.paywall.signedOut) return `It charges ${price} per message. Sign in and add funds to continue.`;
                                  // Surface the exact shortfall so the user knows how much to top up,
                                  // rather than mentally subtracting balance from price on a money
                                  // surface. Guard on shortfall>0 — an insufficient-balance 402 always
                                  // has balance<price, but if the two ever read equal (rounding/stale),
                                  // fall back to the plain price·balance line instead of "add $0.00".
                                  const shortfallMicro = m.paywall.priceMicro - m.paywall.balanceMicro;
                                  if (shortfallMicro > 0) return `It charges ${price} per message · your balance is ${bal} — add at least ${usd(shortfallMicro)} to continue.`;
                                  return `It charges ${price} per message · your balance is ${bal}.`;
                                })()}
                              </div>
                              <div className="mt-2.5 flex flex-wrap gap-2">
                                {m.paywall.signedOut ? (
                                  <button
                                    onClick={() => {
                                      // Carry the held prompt through sign-in as a resume
                                      // deep-link so the returning (now-authed) page auto-continues
                                      // this exact turn — matching iOS (Views.swift:3398) / Android
                                      // auto-resume. The web sign-in navigates away and back, so the
                                      // card's baked-in signedOut flag can't flip in place; ?q&send=1
                                      // makes the intent survive the round-trip. Only the explicit
                                      // Sign-in tap produces it — a cold reload has no ?q, so a paid
                                      // turn is never re-charged without the user asking.
                                      const resume = m.paywall?.prompt
                                        ? `?q=${encodeURIComponent(m.paywall.prompt)}&send=1`
                                        : "";
                                      window.location.href = `/api/auth?return_to=${encodeURIComponent(`${window.location.pathname}${resume}`)}`;
                                    }}
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-transform hover:scale-105 active:scale-100"
                                    style={{ background: 'var(--tiny-accent)', color: '#000' }}
                                  >
                                    Sign in
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      onClick={() => { paywallAwaitingFundsRef.current = m.id; setShowWallet(true); }}
                                      className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-transform hover:scale-105 active:scale-100"
                                      style={{ background: 'var(--tiny-accent)', color: '#000' }}
                                    >
                                      💳 Add funds
                                    </button>
                                    <button
                                      onClick={() => {
                                        // Retry the paid send: drop this paywall bubble (and its
                                        // user prompt — send re-adds both) then re-send.
                                        const prompt = m.paywall!.prompt;
                                        const { messages: updated, attachments: retryAttachments } = dropTurnPair(messagesRef.current, m.id);
                                        messagesRef.current = updated;
                                        setMessages(updated);
                                        send(prompt, retryAttachments);
                                      }}
                                      className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border"
                                      style={{ borderColor: 'rgba(var(--tiny-accent-rgb, 0,255,136),0.4)', color: 'var(--tiny-accent)' }}
                                    >
                                      ↻ Retry
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ⚠️ Stream failed — retry banner */}
                      {m.role === "assistant" && m.failedPrompt && !isStreaming && (
                        <div role="alert" className="mt-3 flex items-center gap-3 px-4 py-3 rounded-xl border animate-riseIn" style={{
                          background: 'rgba(var(--tiny-danger-rgb), 0.08)',
                          borderColor: 'rgba(var(--tiny-danger-rgb), 0.3)',
                        }}>
                          <span className="text-xs text-red-400">
                            {failureBannerLabel({ online, hasContent: !!m.content })}
                          </span>
                          <button
                            onClick={() => {
                              const prompt = m.failedPrompt!;
                              const { messages: updated, attachments: retryAttachments } = dropTurnPair(messagesRef.current, m.id);
                              messagesRef.current = updated;
                              setMessages(updated);
                              send(prompt, retryAttachments);
                            }}
                            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-105"
                            style={{ background: 'rgba(var(--tiny-danger-rgb), 0.15)', color: 'var(--tiny-danger)', border: '1px solid rgba(var(--tiny-danger-rgb), 0.4)' }}
                          >
                            ↻ Retry
                          </button>
                        </div>
                      )}

                      {/* 💡 Follow-up suggestion chips */}
                      {/* Followups only on the LATEST rendered message —
                          stale chips from turns ago suggest actions out of
                          context and compete with the fresh ones */}
                      {m.role === "assistant" && m.followups && m.followups.length > 0 && !isStreaming && index === rendered.length - 1 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {m.followups.map((chip, ci) => (
                            <button
                              key={ci}
                              onClick={() => {
                                // Clear chips on this message and send
                                const updated = messagesRef.current.map((msg) =>
                                  msg.id === m.id ? { ...msg, followups: [] } : msg
                                );
                                messagesRef.current = updated;
                                setMessages(updated);
                                send(chip);
                              }}
                              className="px-3 py-1.5 rounded-full text-xs transition-all hover:scale-105 border neon-chip"
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Action buttons (stop, copy, edit, delete) — fade in
                          on hover/focus (always visible on touch via sm:
                          gate): five gray icon rows under every message were
                          the loudest thing on re-read. Stays visible while
                          streaming (Stop) AND while speaking (Stop-speaking) —
                          a control you might need RIGHT NOW can't hide
                          behind hover. */}
                      {index > 0 && !isEditing && (
                        <div className={`mt-2 flex justify-end gap-1 items-center transition-opacity ${isStreaming || speakingMsgId === m.id ? '' : 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100'}`}>
                          {/* 📊 Token usage + $ estimate — subtle, assistant messages only */}
                          {m.role === "assistant" && m.usage && m.usage.totalTokens > 0 && !isStreaming && (() => {
                            const cost = estimateCost(m.modelId, m.usage);
                            return (
                              <span className="text-[10px] text-gray-600 mr-2 font-mono" title={`input: ${m.usage.inputTokens} · output: ${m.usage.outputTokens}${m.modelId ? ` · ${m.modelId}` : ""}${cost !== null ? " · list-price estimate" : ""}`}>
                                {m.usage.totalTokens >= 1000 ? `${(m.usage.totalTokens / 1000).toFixed(1)}K` : m.usage.totalTokens} tok
                                {cost !== null && ` · ~${formatCost(cost)}`}
                              </span>
                            );
                          })()}
                          {/* Stop button - only visible when streaming this specific message */}
                          {isStreaming && (
                            <button
                              className="p-1.5 rounded-lg hover:bg-gray-800 text-red-500 hover:text-red-400 transition-colors"
                              onClick={() => handleStopStreaming(m.id)}
                              aria-label="Stop streaming"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
                              </svg>
                            </button>
                          )}
                          {/* 🔊 Speak (assistant messages, when synthesis exists) */}
                          {!isUser && !isSystem && m.content && !isStreaming && (
                            <button
                              className={`p-1.5 rounded-lg hover:bg-gray-800 transition-colors ${speakingMsgId === m.id ? "" : "text-gray-500 hover:text-gray-300"}`}
                              style={speakingMsgId === m.id ? { color: "var(--tiny-accent)" } : undefined}
                              onClick={() => toggleSpeak(m)}
                              aria-label={speakingMsgId === m.id ? "Stop speaking" : "Read aloud"}
                              aria-pressed={speakingMsgId === m.id}
                            >
                              {speakingMsgId === m.id ? (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                                </svg>
                              )}
                            </button>
                          )}
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
                            onClick={() => {
                              copy(m.content);
                              toast("📋 Copied!");
                            }}
                            aria-label="Copy message"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                            </svg>
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-blue-400 transition-colors"
                            onClick={() => handleEditMessage(m.id, m.content)}
                            aria-label="Edit message"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                            </svg>
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-red-400 transition-colors"
                            onClick={() => handleDeleteMessage(m.id)}
                            aria-label="Delete message"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Input — docked at the bottom during conversations. On turn
              zero the composer lives inside the hero instead (heroMode). */}
          {!heroMode && (
            <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black to-transparent pb-safe">
              <div className="max-w-4xl mx-auto px-4 py-4">
                {composerBlock}
              </div>
            </div>
          )}
      </main>
    </div>
  );
}
