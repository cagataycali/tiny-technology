"use client";

/**
 * Platform layer: service worker registration, push subscription, and the
 * cross-tab session mesh (agi-diy agent-mesh.js patterns: BroadcastChannel
 * envelope, heartbeat + stale peer eviction, shared ring context).
 */

import { deadlineFor, failureMessage } from "../../lib/deadlines";

// ── Service worker + push ───────────────────────────────────────────────────

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  // Dev: the SW caches /_next/static/ cache-first, but dev chunk URLs are
  // not content-hashed — after a dependency change the SW keeps serving the
  // stale chunk ("module factory is not available") until it's manually
  // unregistered. Don't register locally; also evict any leftover one.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* best effort */ }
    return null;
  }
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(Array.prototype.map.call(raw, (c: string) => c.charCodeAt(0)) as number[]);
}

/** Subscribe to Web Push (logged-in users) and register with the backend. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!("Notification" in window)) return { ok: false, reason: "Notifications unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "Permission denied" };

  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: "No service worker" };

  // Distinguish a transient failure (network/5xx fetching the VAPID key → the
  // user should retry) from a genuine "server has no VAPID configured" (a 200
  // with key:null → nothing to retry). Telling a retryable blip "not configured
  // on server" reads as a permanent misconfiguration and the user gives up —
  // the outage-vs-empty lesson (JobsPanel/Telegram/push GET is always 200 with
  // an env fallback, so key:null only surfaces on a real outage OR true absence).
  let key: string | null = null;
  let keyFetchFailed = false;
  try {
    // Deadlined: this whole fn's contract is "never reject, always resolve to
    // {ok,reason}" so AuthButton's loading toast can clear — but a fetch that
    // never SETTLES breaks that contract just as badly as a throw would, and
    // the toast spins forever. A timeout lands in the catch below and reads as
    // the retryable failure it is.
    const r = await fetch("/api/push", { signal: AbortSignal.timeout(deadlineFor("/api/push")) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    key = (await r.json())?.key ?? null;
  } catch {
    keyFetchFailed = true;
  }
  if (!key) {
    return {
      ok: false,
      reason: keyFetchFailed
        ? "Couldn't reach the push service — try again in a moment."
        : "Push not configured on server",
    };
  }

  // A leftover subscription made with a different VAPID key makes
  // subscribe() throw InvalidStateError — drop it and re-subscribe.
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const cur = existing.options?.applicationServerKey
      ? btoa(Array.from(new Uint8Array(existing.options.applicationServerKey as ArrayBuffer), (b) => String.fromCharCode(b)).join(""))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      : null;
    if (cur && cur !== key) await existing.unsubscribe().catch(() => {});
  }

  // subscribe() REJECTS (not returns) on a push-service failure, an iOS-PWA
  // edge case, or a leftover-key InvalidStateError; urlBase64ToUint8Array
  // throws on a malformed key. This fn's contract is Promise<{ok,reason}> —
  // it must never reject, or the caller's loading toast (AuthButton
  // doEnablePush) spins forever and an unhandled rejection escapes. Catch and
  // report as a normal result, like every other branch above.
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    });

    // Same reasoning, and worse if it hangs: the browser subscription EXISTS by
    // now, so a request that never settles leaves the user subscribed locally
    // with nothing registered server-side and no toast to say so.
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
      signal: AbortSignal.timeout(deadlineFor("/api/push")),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: failureMessage(e, "") || "" }));

    return res.ok ? { ok: true } : { ok: false, reason: res.error || "Subscribe failed" };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "Couldn't subscribe to notifications" };
  }
}

// ── Cross-tab session mesh (agi-diy pattern) ────────────────────────────────

const CHANNEL_NAME = "tiny-mesh";
const RING_KEY = "tiny_mesh_ring";
const MAX_RING = 50;
const HEARTBEAT_MS = 5000;
const STALE_MS = 15000;

export type RingEntry = { tinyName: string; tabId: string; text: string; timestamp: number };
type Peer = { tabId: string; tinyName: string; lastSeen: number };
type MeshMessage = {
  type: "ping" | "pong" | "ring-update" | "persisted";
  payload: any;
  source: { tabId: string; tinyName: string };
  timestamp: number;
};

let memTabId: string | null = null;
function getTabId(): string {
  // sessionStorage access can THROW (sandboxed iframe without
  // allow-same-origin, hardened privacy modes) — the embed path must not
  // take the whole Chat component down over a tab id. Fall back to an
  // in-memory id: stable for this tab's lifetime, which is all it's for.
  try {
    let id = sessionStorage.getItem("tiny-mesh-tab-id");
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem("tiny-mesh-tab-id", id);
    }
    return id;
  } catch {
    if (!memTabId) memTabId = Math.random().toString(36).slice(2, 8);
    return memTabId;
  }
}

export function getRing(): RingEntry[] {
  // Guard SHAPE, not just parse: a corrupted RING_KEY that's valid-but-non-array
  // JSON ({} or "5") would otherwise flow to .filter/.push and throw at the
  // call site. Coerce anything that isn't an array to [].
  try {
    const parsed = JSON.parse(localStorage.getItem(RING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// The ring lives in localStorage, so it survives across days — without an
// age gate a beat from last week reads as "recent activity" in the prompt.
const RING_FRESH_MS = 30 * 60 * 1000;

/** Cross-tab ring context for the agent — what other tabs are discussing. */
export function ringContextForPrompt(excludeTab: string, maxEntries = 5): string {
  const cutoff = Date.now() - RING_FRESH_MS;
  const relevant = getRing()
    .filter((r) => r.tabId !== excludeTab && (r.timestamp || 0) >= cutoff)
    .slice(-maxEntries);
  if (relevant.length === 0) return "";
  const lines = relevant.map((r) => `• [/${r.tinyName}] ${r.text.slice(0, 150)}`);
  return `## 🔗 Other open tabs (this browser) — recent activity:\n${lines.join("\n")}`;
}

export class TabMesh {
  private channel: BroadcastChannel | null = null;
  private peers = new Map<string, Peer>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  readonly tabId: string;

  /** Set by the owner to hear "another tab on this tiny just saved history". */
  onPersisted?: (tinyName: string) => void;

  constructor(private tinyName: string, private onChange?: () => void) {
    this.tabId = typeof window !== "undefined" ? getTabId() : "ssr";
  }

  start() {
    if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e: MessageEvent<MeshMessage>) => this.onMessage(e.data);
    this.send("ping", {});
    this.heartbeat = setInterval(() => {
      this.send("ping", {});
      const now = Date.now();
      this.peers.forEach((p, k) => { if (now - p.lastSeen > STALE_MS) this.peers.delete(k); });
      this.onChange?.();
    }, HEARTBEAT_MS);
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.channel?.close();
    this.channel = null;
  }

  peerCount(): number {
    return this.peers.size;
  }

  /** Publish a conversation beat to the shared ring (other tabs' agents see it). */
  addToRing(text: string) {
    if (!text?.trim()) return;
    const ring = getRing();
    ring.push({
      tinyName: this.tinyName,
      tabId: this.tabId,
      text: text.slice(0, 500),
      timestamp: Date.now(),
    });
    try { localStorage.setItem(RING_KEY, JSON.stringify(ring.slice(-MAX_RING))); } catch { }
    this.send("ring-update", {});
  }

  ringContext(): string {
    return ringContextForPrompt(this.tabId);
  }

  /**
   * Announce that this tab just wrote chat_messages_<tiny> (v4 C5). Peers on
   * the same tiny use it to adopt the newer snapshot instead of overwriting
   * it from their stale in-memory copy. The transcript itself never rides the
   * channel — a beat is a nudge to re-read storage, so a multi-MB history
   * doesn't get structured-cloned to every tab on every debounce.
   */
  announcePersisted() {
    this.send("persisted", {});
  }

  private send(type: MeshMessage["type"], payload: any) {
    try {
      this.channel?.postMessage({
        type,
        payload,
        source: { tabId: this.tabId, tinyName: this.tinyName },
        timestamp: Date.now(),
      } satisfies MeshMessage);
    } catch { }
  }

  private onMessage(msg: MeshMessage) {
    if (!msg?.source || msg.source.tabId === this.tabId) return;
    this.peers.set(msg.source.tabId, {
      tabId: msg.source.tabId,
      tinyName: msg.source.tinyName,
      lastSeen: Date.now(),
    });
    if (msg.type === "ping") this.send("pong", {});
    if (msg.type === "ring-update" || msg.type === "ping") this.onChange?.();
    // Only tabs on the SAME tiny share a transcript key — a peer saving
    // /alpha says nothing about /beta's history.
    if (msg.type === "persisted" && msg.source.tinyName === this.tinyName) {
      this.onPersisted?.(msg.source.tinyName);
    }
  }
}
