"use client";

/**
 * Memory Panel — the Inline Memory Chip surface.
 *
 * Every memory renders as a chip with bitemporal provenance: 🟢 live
 * (valid_to IS NULL) vs ⚪ closed (superseded/unlearned — history, not
 * recall). Tapping a chip expands source text + validity window + linked
 * memories (a 1-hop subgraph walk) + actions (forget = close, never
 * delete). "Show history" reveals closed facts. Contradictions surface as
 * a one-tap Conflict Prompt above the list: pick the current fact, the
 * losers close bitemporally.
 *
 * Replaces the old /memory clipboard-toast. Same overlay grammar as
 * MessagesHUD: portaled (the header's backdrop-filter is a containing
 * block), full-screen sheet on mobile, Escape/backdrop dismiss.
 */
import { IconDoc, IconGraph, IconConflict } from "./icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import MemoryGraph, { type VizNode, type VizEdge } from "./MemoryGraph";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { useConfirm } from "./ConfirmDialog";
import { deadlineFor } from "../../lib/deadlines";
import { memoryHeader, MEMORY_PANEL_LIMIT } from "../../lib/chat/memory-list";

type MemoryRow = {
  id: number | string;
  content: string;
  created: number;
  valid_from?: number;
  valid_to?: number | null;
  freshness?: "live" | "closed";
};

type ConflictCandidate = {
  edgeId: string;
  dst: string;
  validFrom: number;
  node: { label: string; source: string | null; freshness: string } | null;
};

type Conflict = {
  // 'subject': one src, competing objects · 'target': competing facts about
  // one dst (the worker's two detection shapes). Absent → treat as subject.
  shape?: "subject" | "target";
  src: string;
  rel: string;
  scope: string | null;
  srcNode: { label: string; source: string | null } | null;
  candidates: ConflictCandidate[];
};

type GraphEdge = { src: string; rel: string; dst: string; scope?: string | null };
type GraphNode = { id: string; label: string; freshness: "live" | "closed" };
// `key` tags which expanded chip these connections belong to, so a slow
// earlier /api/graph response can't paint chip A's neighbors under chip B —
// the render only shows connections whose key matches the open chip. This
// render-time filter is paired with a connReqRef generation token (below) that
// suppresses the stale WRITE itself; the key filter alone stops A painting
// under B but not A overwriting-and-blanking B. The key lives in state (read
// during the chip .map() render, where a ref read would trip react-hooks/refs);
// the token is read only inside loadConnections' async callback, so it's fine.
type Connections =
  | { key: string; edges: GraphEdge[]; nodes: Map<string, GraphNode> }
  | { key: string; state: "loading" | "none" }
  | null;

const REL_LABEL: Record<string, [string, string]> = {
  // rel → [outgoing phrasing, incoming phrasing]
  supersedes: ["replaced", "replaced by"],
  part_of: ["part of", "contains"],
  authored: ["authored", "authored by"],
  relates_to: ["relates to", "related from"],
  about: ["about", "referenced by"],
};

function when(ts?: number): string {
  // Coerce + validate (> 0, seconds-since-1970): `!ts` alone lets a non-numeric
  // string (validFrom/validTo/created taken raw off /api/learnings) through →
  // `ts * 1000` NaN → "Invalid Date". Mirrors JobsPanel when() / ActivityHUD ago().
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Remount per open (ModelSettings pattern): fresh state each time, no
  // reset-in-effect needed — mounted = open, cleanup = close.
  if (!open) return null;
  return <MemoryPanelInner onClose={onClose} />;
}

function MemoryPanelInner({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  // A failed learnings fetch toasted but then rested on the EMPTY state ("No
  // memories yet…") — after the toast faded, a user with real memories was
  // told they had none, with no in-panel retry. Track the failure so the empty
  // branch shows a retry instead. Only surfaced when rows is empty, so a poll
  // blip over a populated list never flips the screen to an error.
  const [loadError, setLoadError] = useState(false);
  const [total, setTotal] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Connections of the expanded chip (graph neighbors, lazy-loaded on expand)
  const [connections, setConnections] = useState<Connections>(null);
  // ⚔️ Conflict Prompt — contradictions detected in the graph (same subject
  // + relation → different facts, same scope). One tap keeps a candidate
  // and closes the rest bitemporally.
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [resolving, setResolving] = useState(false);
  const [closing, setClosing] = useState<number | string | null>(null);
  // 🕸️ Graph view — the whole memory graph as a force-directed picture
  // (list stays the default; the toggle swaps the body)
  const [view, setView] = useState<"list" | "graph">("list");
  const [graph, setGraph] = useState<{ nodes: VizNode[]; edges: VizEdge[] } | "loading" | null>(null);
  // Seeded true: the mount effect always loads (remount-per-open), so the
  // first paint is legitimately "loading" without a sync setState in-effect
  const [loading, setLoading] = useState(true);
  // Exit choreography (shared pass-97 pattern) for dismissals; the
  // login-required path keeps the instant onClose (a toast explains).
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose);
  const { confirm, dialog } = useConfirm();

  // Generation tokens (the modelReqRef pattern) for the two fetches that can be
  // re-fired before the prior resolves via the header toggles: graph (view +
  // history) and learnings (history). Read only inside async callbacks, and
  // these fns are called from effects/header handlers — not the chip .map() —
  // so the ref reads don't trip react-hooks/refs the way connections would.
  const graphReqRef = useRef(0);
  const loadReqRef = useRef(0);
  // Connections has BOTH mechanisms, and they solve DIFFERENT halves: the
  // state `key` (above) is a render-time filter so a response can only paint
  // under the chip it belongs to; this req token suppresses a stale WRITE. The
  // key alone can't do that — expand A (req A), then B (A auto-closes, req B);
  // if A resolves after B, setConnections({key:A}) overwrites B's state and,
  // since key A ≠ open chip B, B renders neither its edges nor "loading…" (it
  // falsely looks connection-less). loadConnections runs from the chip onClick,
  // and the token is read only in the async callback (not render), so it
  // doesn't trip react-hooks/refs the way a render-time ref read would.
  const connReqRef = useRef(0);

  // Focus management (shared overlay pattern): move focus INTO the panel on
  // open so it's announced and Tab starts inside — otherwise focus stays on
  // the opener (avatar-menu item or /memory command), now behind an aria-modal
  // surface the AT treats as inert. Restore it to the opener on unmount,
  // whatever the close path (else focus falls to <body>).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { try { opener?.focus(); } catch { } };
  }, []);
  // Trap Tab inside (WCAG 2.4.3). Remount-per-open → always active while
  // mounted; aria-modal marks the page behind inert.
  useFocusTrap(dialogRef, true);

  // Whole graph. Called only when there's no cached picture for the current
  // mode (see the view toggle's graph===null guard) or when history changes
  // the contents — history refetches with closed nodes so the grey/bitemporal
  // story is visible in the picture too.
  const loadGraph = (history: boolean) => {
    const req = ++graphReqRef.current;
    setGraph("loading");
    // Deadline it: `graph` is already set to "loading" above, and only the
    // .catch clears it back to null. A never-settling fetch = a picture stuck
    // mid-render with no way back to the list view.
    fetch(`/api/graph?all=1${history ? "&include_closed=1" : ""}`, { signal: AbortSignal.timeout(deadlineFor("/api/graph")) })
      .then((r) => r.json())
      .then((d) => {
        if (graphReqRef.current !== req) return;
        // A degraded proxy (10s-timeout 503 {error}) parses fine as JSON —
        // guard so it routes to .catch instead of painting an empty graph
        // (an outage must not read as "you have no memories").
        if (d.error) throw new Error(d.error);
        setGraph({
          nodes: Array.isArray(d.nodes) ? d.nodes : [],
          edges: Array.isArray(d.edges) ? d.edges : [],
        });
      })
      .catch(() => {
        if (graphReqRef.current !== req) return;
        toast.error("Couldn't load the graph — try again"); setGraph(null); setView("list");
      });
  };

  // Lazy: one /api/graph call per chip expand — the subgraph is small
  // (hops=1) and most chips are never expanded
  const loadConnections = (id: number | string, key: string) => {
    const req = ++connReqRef.current;
    setConnections({ key, state: "loading" });
    fetch(`/api/graph?node=${encodeURIComponent(String(id))}`, { signal: AbortSignal.timeout(deadlineFor("/api/graph")) })
      .then((r) => r.json())
      .then((d) => {
        if (connReqRef.current !== req) return; // a newer chip expand won
        if (d.error) throw new Error(d.error);
        const edges: GraphEdge[] = Array.isArray(d.edges) ? d.edges : [];
        if (!edges.length) { setConnections({ key, state: "none" }); return; }
        const nodes = new Map<string, GraphNode>(
          (Array.isArray(d.nodes) ? d.nodes : []).map((n: any) => [n.id, { id: n.id, label: n.label || n.source || n.id, freshness: n.freshness }])
        );
        setConnections({ key, edges, nodes });
      })
      .catch(() => { if (connReqRef.current === req) setConnections({ key, state: "none" }); });
  };

  const load = (history: boolean) => {
    const req = ++loadReqRef.current;
    setLoading(true);
    fetch(`/api/learnings?limit=${MEMORY_PANEL_LIMIT}${history ? "&include_closed=1" : ""}`, { signal: AbortSignal.timeout(deadlineFor("/api/learnings")) })
      .then((r) => r.json())
      .then((d) => {
        if (loadReqRef.current !== req) return;
        // Auth failure → close (nothing to show signed-out). Any OTHER error
        // (e.g. the proxy's 10s-timeout 503 "memories unavailable", or a worker
        // hiccup) is transient — surface the retry branch instead of yanking
        // the panel shut, matching the .catch() path below.
        if (d.error === "login required") { toast("Sign in to see your memories"); onClose(); return; }
        if (d.error) { setLoadError(true); toast.error(d.error); return; }
        setLoadError(false);
        setRows(Array.isArray(d.learnings) ? [...d.learnings].reverse() : []); // newest first
        setTotal(Number(d.total || 0));
      })
      .catch(() => { if (loadReqRef.current === req) { setLoadError(true); toast.error("Couldn't load memories — try again"); } })
      // Only the latest request clears the spinner — an older resolver must not
      // flip "loading" off while the newer fetch is still in flight.
      .finally(() => { if (loadReqRef.current === req) setLoading(false); });
  };

  // Conflict detection is a cheap indexed query — run it once per open;
  // resolving reloads it so the prompt disappears as sets clear.
  const loadConflicts = () => {
    fetch("/api/graph?conflicts=1", { signal: AbortSignal.timeout(deadlineFor("/api/graph")) })
      .then((r) => r.json())
      // Validate the ELEMENT shape too, not just the outer array: a half-built
      // conflict row without a candidates[] would crash the render at
      // `c.candidates.map` (bubbles past this panel to the route error boundary,
      // blanking the whole page). A conflict with no candidates has nothing to
      // resolve anyway, so dropping it is the correct behavior.
      .then((d) => setConflicts(
        Array.isArray(d.conflicts)
          ? d.conflicts.filter((c: Conflict) => Array.isArray(c?.candidates) && c.candidates.length > 0)
          : []
      ))
      .catch(() => { /* prompt is best-effort — the list still works */ });
  };

  const resolve = (keep: string, close: string[]) => {
    setResolving(true);
    fetch("/api/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, close }),
      signal: AbortSignal.timeout(deadlineFor("/api/graph")),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { toast.error(d.error || "Couldn't resolve — try again"); return; }
        toast("⚔️ Resolved — the rest closed as history");
        loadConflicts();
        load(showHistory);
      })
      .catch(() => toast.error("Couldn't resolve — try again"))
      .finally(() => setResolving(false));
  };

  useEffect(() => {
    load(false);
    loadConflicts();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forget = async (id: number | string) => {
    if (!(await confirm({
      title: "Close this memory?",
      message: "It leaves recall but stays in history — you can still see it under history.",
      confirmLabel: "Close memory",
      danger: true,
    }))) return;
    setClosing(id);
    fetch("/api/learnings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(deadlineFor("/api/learnings")),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { toast.error(d.error || "Couldn't close — try again"); return; }
        toast("🧬 Closed — kept as history");
        load(showHistory);
      })
      .catch(() => toast.error("Couldn't close — try again"))
      .finally(() => setClosing(null));
  };

  if (typeof document === "undefined") return null;

  const live = rows.filter((r) => r.freshness !== "closed");
  const closed = rows.filter((r) => r.freshness === "closed");
  // Closed rows only render in history mode, so the header must count what is
  // actually painted below — not every row that arrived.
  const header = memoryHeader({
    total,
    liveShown: live.length,
    closedShown: showHistory ? closed.length : 0,
    showHistory,
    limit: MEMORY_PANEL_LIMIT,
  });

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90] bg-black/40 sm:bg-transparent" onClick={requestClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Your memories"
        className={`fixed z-[95] outline-none ${exitClass} flex flex-col border
                   inset-0 h-[100dvh] w-full rounded-none
                   sm:inset-auto sm:top-[4.5rem] sm:h-auto sm:max-h-[70vh] sm:w-[28rem] sm:rounded-xl
                   sm:right-[max(1rem,calc((100vw-56rem)/2+1rem))]`}
        onAnimationEnd={onAnimationEnd}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
          boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
        }}
      >
        <div
          className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-white border-b flex items-center gap-2"
          style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
        >
          {/* The worker's `total` is a COUNT(*) of LIVE facts in EVERY mode
              (TOTALS_SQL: `valid_to IS NULL`) — there is no closed-inclusive
              total — while the LIST becomes live+closed under include_closed=1.
              So this line used to read "40 total" above 70 visible rows, and
              "250 live" above a page of 100. The header now describes what is
              on screen and names what isn't. See lib/chat/memory-list. */}
          <span className="opacity-60 min-w-0 truncate" title={header.title}>
            🧬 Memory · {header.label}
          </span>
          <button
            onClick={() => {
              const next = view === "list" ? "graph" : "list";
              setView(next);
              // Lazy for real: only fetch when we don't already hold a graph
              // for the current history mode. A plain list↔graph flip reuses
              // the cached picture instead of re-downloading it (and flashing
              // "Mapping your memories…") every time. The history toggle below
              // invalidates the cache when its params change, so `graph===null`
              // is a sufficient staleness check here.
              if (next === "graph" && graph === null) loadGraph(showHistory);
            }}
            className="ml-auto px-2 py-0.5 rounded-md border text-[11px] normal-case tracking-normal transition-colors hover:bg-white/5"
            style={{
              borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
              color: view === "graph" ? "var(--tiny-accent)" : "rgba(255,255,255,0.6)",
            }}
            aria-pressed={view === "graph"}
          >
            {view === "graph" ? (<span className="inline-flex items-center gap-1"><IconDoc className="w-3.5 h-3.5" /> list</span>) : (<span className="inline-flex items-center gap-1"><IconGraph className="w-3.5 h-3.5" /> graph</span>)}
          </button>
          <button
            onClick={() => {
              const next = !showHistory;
              setShowHistory(next);
              load(next);
              // History changes the graph's contents (include_closed), so the
              // cached picture is now stale. Refetch immediately if the graph
              // is on screen; otherwise drop the cache so the next switch-to-
              // graph re-fetches with the new mode (the toggle's graph===null
              // guard relies on this to stay correct).
              if (view === "graph") loadGraph(next);
              else setGraph(null);
            }}
            disabled={loading}
            aria-busy={loading}
            className="px-2 py-0.5 rounded-md border text-[11px] normal-case tracking-normal transition-colors hover:bg-white/5 disabled:opacity-50 inline-flex items-center gap-1"
            style={{
              borderColor: "rgba(var(--tiny-accent-rgb),0.3)",
              color: showHistory ? "var(--tiny-accent)" : "rgba(255,255,255,0.6)",
            }}
            aria-pressed={showHistory}
          >
            {/* Toggling history refetches with include_closed; the list keeps
                its current rows during the reload (the body spinner only fires
                when empty), so spin the glyph here to acknowledge the mode
                flip — same busy grammar as the JobsPanel refresh. */}
            {loading && <span className="inline-block animate-spin" aria-hidden="true">↻</span>}
            {showHistory ? "⚪ history shown" : "show history"}
          </button>
          <button onClick={requestClose} className="inline-flex items-center justify-center min-w-11 min-h-11 -m-1.5 opacity-60 hover:opacity-100 sm:hidden" aria-label="Close">✕</button>
        </div>

        {/* 🕸️ Graph view — the whole memory graph, force-directed. Fixed
            height on desktop (the list sizes to content; a graph needs a
            canvas); flex-fills the mobile sheet. */}
        {view === "graph" ? (
          <div className="flex flex-col flex-1 min-h-0 h-[70vh] sm:h-[26rem]">
            {graph === "loading" || graph === null ? (
              <div role="status" className="text-sm text-gray-400 text-center py-6">Mapping your memories…</div>
            ) : graph.nodes.length === 0 ? (
              // Empty-state parity with the list view below: a graph with no
              // nodes handed to MemoryGraph is a blank canvas with no signal.
              // Mirror the list's "No memories yet" nudge (same noun) so the
              // twin views are equally legible to a first-time / all-closed user.
              <div className="text-sm text-gray-400 text-center py-6 px-4">
                Nothing to map yet — memories and their links show up here as your tiny learns them
              </div>
            ) : (
              <MemoryGraph nodes={graph.nodes} edges={graph.edges} />
            )}
          </div>
        ) : (
        <div className="overflow-y-auto overscroll-contain flex-1 p-3 space-y-2">
          {/* ⚔️ Conflict Prompt — one tap picks the current fact; the rest
              close as history. Scope-compatible sets only (worker-side). */}
          {conflicts.map((c, ci) => (
            <div
              key={`conflict-${ci}`}
              className="rounded-xl border px-3 py-2 space-y-1.5"
              style={{ borderColor: "rgba(250,204,21,0.4)", background: "rgba(250,204,21,0.06)" }}
            >
              <div className="text-[11px] text-yellow-200/90">
                <IconConflict className="w-3.5 h-3.5 inline-block align-[-2px] mr-1" /> These facts contradict — which is current?
                {/* subject-shape: competing objects OF the anchor ("X · rel").
                    target-shape: competing facts ABOUT the anchor ("about X"). */}
                {/* break-words: src/label is free user/AI text (same class as
                    the list path's m.content at :459) — a long unbroken token
                    here would push the conflict card wider than the mobile
                    full-screen sheet → horizontal page scroll. */}
                <span className="opacity-60 break-words"> ({c.shape === "target" ? `about ${c.srcNode?.label || c.src}` : `${c.srcNode?.label || c.src} · ${c.rel}`}{c.scope ? ` · ${c.scope}` : ""})</span>
              </div>
              {c.candidates.map((cand) => (
                <button
                  key={cand.edgeId}
                  disabled={resolving}
                  onClick={() => resolve(cand.edgeId, c.candidates.filter((x) => x.edgeId !== cand.edgeId).map((x) => x.edgeId))}
                  className="w-full text-left rounded-lg border px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-white/10 disabled:opacity-50 break-words"
                  style={{ borderColor: "rgba(255,255,255,0.15)" }}
                >
                  {/* break-words: node.source is the same free user/AI text
                      guarded at :459; a long unbroken token in a candidate
                      would overflow this w-full button off the mobile sheet. */}
                  {cand.node?.source || cand.node?.label || cand.dst}
                  <span className="block text-[10px] text-gray-400 mt-0.5">since {when(cand.validFrom)} · tap to keep</span>
                </button>
              ))}
            </div>
          ))}
          {loading && rows.length === 0 ? (
            <div role="status" className="text-sm text-gray-400 text-center py-6">Loading…</div>
          ) : loadError && rows.length === 0 ? (
            /* Fetch failed — DON'T rest on "No memories yet" (an outage would
               tell a user with real memories they have none). Offer a retry. */
            <div role="alert" className="text-sm text-gray-400 text-center py-6 space-y-3">
              <div>Couldn&apos;t load your memories.</div>
              <button
                onClick={() => load(showHistory)}
                className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
              >
                Retry
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">
              No memories yet — your tiny stores them with <code>learn</code> as it gets to know you
            </div>
          ) : (
            [...live, ...(showHistory ? closed : [])].map((m) => {
              const isClosed = m.freshness === "closed";
              const key = String(m.id) + (isClosed ? ":c" : "");
              const isOpen = expanded === key;
              return (
                // Plain container — NOT a button: it holds two interactive
                // controls (the expand toggle + "close this memory"), and an
                // interactive element nested inside a <button> is invalid HTML
                // (browsers hoist it out, breaking SR/keyboard behavior).
                <div
                  key={key}
                  className={`rounded-xl border transition-colors ${isClosed ? "opacity-60" : ""}`}
                  style={{ borderColor: isClosed ? "rgba(255,255,255,0.12)" : "rgba(var(--tiny-accent-rgb),0.25)" }}
                >
                  <button
                    onClick={() => {
                      // Collapse: invalidate any in-flight request too, so a
                      // late response can't repaint connections under a chip
                      // the user just closed.
                      if (isOpen) { connReqRef.current++; setExpanded(null); setConnections(null); return; }
                      setExpanded(key);
                      loadConnections(m.id, key);
                    }}
                    aria-expanded={isOpen}
                    aria-busy={isOpen && connections?.key === key && "state" in connections && connections.state === "loading"}
                    className="w-full text-left rounded-xl px-3 py-2 transition-colors hover:bg-white/5"
                  >
                    <div className="flex items-start gap-2">
                      {/* Freshness badge: 🟢 live / ⚪ closed (bitemporal) */}
                      <span className="mt-0.5 text-[10px]" aria-label={isClosed ? "Closed (history)" : "Live"} title={isClosed ? "Closed — kept as history, not in recall" : "Live — currently true, active in recall"}>
                        {isClosed ? "⚪" : "🟢"}
                      </span>
                      {/* break-words: memory content is free user/AI text that
                          can hold a long unbroken token (URL/path/email). When
                          collapsed, line-clamp-2's overflow:hidden lets the
                          flex item shrink; when expanded the clamp is gone, so
                          without break-words a long token forces the span wider
                          than the mobile sheet → horizontal scroll. */}
                      <span className={`text-sm text-white flex-1 min-w-0 break-words ${isOpen ? "" : "line-clamp-2"}`}>{m.content}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="mt-1 mb-2 px-3 pl-9 text-[11px] text-gray-400 space-y-1">
                      <div>
                        #{m.id} · learned {when(m.valid_from ?? m.created)}
                        {isClosed && m.valid_to ? ` · closed ${when(m.valid_to)}` : ""}
                      </div>
                      {/* 🕸️ Graph connections — supersedes trail + links.
                          The chip's node id is mig12:<legacy id>; edges
                          touching it render as human phrases with the
                          neighbor's label + freshness dot. */}
                      {/* Only render connections tagged with THIS chip's key —
                          a stale earlier response carrying another chip's key
                          is ignored, so it can't paint under the wrong chip. */}
                      {connections?.key === key && "state" in connections && connections.state === "loading" && (
                        <div role="status" className="opacity-60">loading connections…</div>
                      )}
                      {connections?.key === key && "edges" in connections && (() => {
                        const selfId = `mig12:${m.id}`;
                        return (
                          // Announce the neighbor list when it swaps in — a SR
                          // user expanded the chip (aria-expanded flipped) but
                          // would otherwise never hear the connections arrived.
                          <div className="space-y-0.5" aria-live="polite">
                            {connections.edges.slice(0, 8).map((e, i) => {
                              const outgoing = e.src === selfId;
                              const otherId = outgoing ? e.dst : e.src;
                              const other = connections.nodes.get(otherId);
                              const phrase = (REL_LABEL[e.rel] || [e.rel, e.rel])[outgoing ? 0 : 1];
                              return (
                                <div key={i} className="flex items-center gap-1.5">
                                  {/* The dot is the ONLY open-vs-closed signal and
                                      is decorative to AT; the sr-only word carries
                                      that meaning so a SR user hears whether the
                                      connection is still live (UniverseDirectory
                                      trust-dot pattern). */}
                                  <span aria-hidden="true">{other?.freshness === "closed" ? "⚪" : "🟢"}</span>
                                  <span className="sr-only">{other?.freshness === "closed" ? "closed connection: " : "open connection: "}</span>
                                  <span className="opacity-70">{phrase}</span>
                                  <span className="text-gray-300 truncate">{other?.label || otherId}</span>
                                  {e.scope && <span className="opacity-50">· {e.scope}</span>}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                      {!isClosed && (
                        <button
                          type="button"
                          onClick={() => forget(m.id)}
                          disabled={closing === m.id}
                          className="inline-block text-red-400/80 hover:text-red-400 cursor-pointer disabled:opacity-50 disabled:cursor-default"
                        >
                          {closing === m.id ? "closing…" : "close this memory"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        )}
      </div>
      {dialog}
    </>,
    document.body
  );
}
