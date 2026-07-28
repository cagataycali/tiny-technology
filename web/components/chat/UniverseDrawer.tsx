"use client";

/**
 * 🌌 Universe drawer — the Tiny Universe moved from a home-page footer
 * section (which overlapped the fixed composer) into a header-left
 * slide-in panel, careless-AgentsPanel style. Lists builders + their
 * public tinys; every row links to /{slug} or /@{login}.
 *
 * Follows the DESIGN_NOTES overlay grammar: role=dialog + label, riseIn
 * enter, Escape + outside-click dismiss, focus returns to the opener.
 */

import { IconBolt, IconGlobe } from "./icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { normalizeCommunity, compact, githubAvatar, hexRgb, type CommunityData } from "@/lib/community";
import { universeCounts, hiddenTinyCount, COMMUNITY_PAGE } from "@/lib/chat/universe-counts";
import nextDynamic from "next/dynamic";
// Lazy: the constellation (force sim + SVG, ~10KB) is only needed once the
// drawer opens with data — statically imported it rode in EVERY chat page's
// first-load bundle (c17 bundle audit). The placeholder keeps the 150px slot
// so the starfield pop-in doesn't shift the list below.
const UniverseConstellation = nextDynamic(() => import("../UniverseConstellation"), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden="true"
      className="rounded-[14px] border h-[172px] animate-pulse"
      style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
    />
  ),
});
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";

/** Chips per card in the narrow drawer (the grid on /universe shows 8). */
const DRAWER_CHIPS = 6;

export default function UniverseDrawer() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CommunityData | null>(null);
  const [loading, setLoading] = useState(false);
  // A failed fetch used to collapse `data` to the empty shape → the render fell
  // through to the "Be the first builder" CTA, telling a returning user the
  // platform has zero builders. Track the failure so we show a calm retry
  // instead (mirrors Community.tsx's `failed` flag).
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again" to re-run the fetch effect (keeps its cancellation guard).
  const [reload, setReload] = useState(0);
  // 🔍 iOS parity: the native Universe panel is a `.searchable` List
  // (Panels.swift) — the web drawer had no way to find a builder or tiny
  // without scrolling all 50 cards. Client-side filter over login/name/tiny
  // names; resets on each open so a stale query never hides everyone.
  const [query, setQuery] = useState("");
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Exit choreography + focus-return-to-opener (shared pass-97 grammar) —
  // was riseIn-only with a manual focus() on close, so it vanished without
  // settling out. useOverlayExit gives the riseOut + focus return in one.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => setOpen(false), openerRef,
  );

  // Lazy fetch — only when the drawer first opens (and refresh per open;
  // creates/deletes must show immediately, mirroring the old server
  // component's cache: "no-store").
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    // Timeout + r.ok gate mirror the SSR Community.tsx fetch: a stalled worker
    // (connected but never responding) would otherwise leave the promise
    // pending forever — .catch never fires, so `failed` never flips and the
    // drawer spins indefinitely. A 5xx carrying a JSON error body would parse
    // fine and normalize to an empty-but-not-failed list; gate on ok so it
    // reaches the "couldn't load" retry instead.
    // limit=100 is the worker's hard cap — half the truncation of the old
    // 50 while a real cursor remains worker-side roadmap. `totalUsers` on the
    // response is the real census, so the header names it (v10 A4).
    fetch(`https://plugin.tiny.technology/community?limit=${COMMUNITY_PAGE}`, {
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => { if (!r.ok) throw new Error(`community ${r.status}`); return r.json(); })
      .then((j) => { if (!cancelled) { setData(normalizeCommunity(j)); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, reload]);

  // 👆 iOS parity (Views.swift:1848): a left-edge swipe opens the Universe.
  // Touch-only, passive (never blocks scroll), and armed only from the
  // 24px edge gutter with a mostly-horizontal 60px pull — a vertical
  // scroll that grazes the edge disarms instead of hijacking. iOS
  // Safari's own back-swipe wins at the hardware edge in browser tabs;
  // in the installed PWA (no back gesture) this is the native path in.
  useEffect(() => {
    if (open) return;
    let startX = -1, startY = -1;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t.clientX <= 24) { startX = t.clientX; startY = t.clientY; }
      else startX = -1;
    };
    const onMove = (e: TouchEvent) => {
      if (startX < 0) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = Math.abs(t.clientY - startY);
      if (dy >= 40) { startX = -1; return; }
      if (dx > 60) {
        startX = -1;
        setQuery("");
        setOpen(true);
        // soft haptic where the platform offers one (Android Chrome);
        // the iOS app plays UIImpactFeedbackGenerator soft here
        navigator.vibrate?.(10);
      }
    };
    const onEnd = () => { startX = -1; };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, [open]);

  // Escape dismisses (requestClose plays the exit + returns focus)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  // ⌘K toggles the Universe — the iOS toolbar shortcut (Views.swift:1894).
  // Plain K only: ⌘⇧K belongs to the slash-command palette (Chat.tsx:1916).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) requestClose();
        else { setQuery(""); setOpen(true); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  // Move focus INTO the panel on open — it's a role=dialog, so SR must
  // announce it and Tab must start inside (Onboarding pass-126 fix). Focus
  // the container, not a link, so no row is pre-selected.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);
  // Trap Tab inside the drawer (WCAG 2.4.3) — aria-modal marks the page inert.
  useFocusTrap(panelRef, open);

  const users = data?.users ?? [];
  const trust = data?.trust ?? {};
  const q = query.trim().toLowerCase();
  const shown = q
    ? users.filter((u) =>
        u.login.toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q) ||
        u.tinys.some((t) => t.name.toLowerCase().includes(q)))
    : users;
  // The header counts the fetched population, never the filtered `shown` — a
  // search narrows the view, it doesn't shrink the universe.
  const counts = universeCounts({
    shown: users.length,
    totalUsers: data?.totalUsers,
    totalPublicTinys: data?.totalPublicTinys ?? 0,
    limit: COMMUNITY_PAGE,
  });

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-label="Open the Tiny Universe"
        aria-expanded={open}
        title="Tiny Universe — builders & public tinys (⌘K)"
        onClick={() => { setQuery(""); setOpen(true); }}
        className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0 inline-flex items-center justify-center min-w-11 min-h-11"
      >
        <IconGlobe className="w-5 h-5" />
      </button>

      {/* Portal to <body>: the drawer is mounted inside the header, which
          has backdrop-blur — that creates a containing block, so a `fixed`
          child positions against the HEADER (z-50), not the viewport, and
          the panel opened trapped BEHIND the chat. Portaling escapes it, the
          same fix ActivityHUD uses. */}
      {open && typeof document !== "undefined" && createPortal(
        <>
          {/* Backdrop — outside-click dismiss */}
          <div
            className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
            onClick={requestClose}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Tiny Universe"
            tabIndex={-1}
            onAnimationEnd={onAnimationEnd}
            className={`fixed top-0 left-0 bottom-0 z-[100] w-[85vw] max-w-sm overflow-y-auto border-r outline-none ${exitClass}`}
            style={{
              background: "rgba(0,0,0,0.92)",
              backdropFilter: "blur(16px)",
              borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
            }}
          >
            <div className="sticky top-0 border-b"
              style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)", borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
              <div className="flex items-center gap-2 px-4 py-3">
                {/* nowrap + truncating stats: at phone width the stats span
                    used to squeeze the title onto two lines — a nav title
                    never wraps (c10 screenshot QA). */}
                <h2 className="text-sm font-bold font-rounded inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color: "var(--tiny-accent)" }}>
                  <IconGlobe className="w-4 h-4 flex-shrink-0" /> The Tiny Universe
                </h2>
                {data && (
                  <span
                    className="text-[11px] text-gray-400 tabular-nums truncate min-w-0"
                    {...(counts.title ? { title: counts.title } : {})}
                  >
                    {data.totalMessages > 0 && <>{compact(data.totalMessages)} msgs · </>}
                    {/* `users` is one page of a real COUNT(*) — universeCounts
                        renders "N of M builders" when the two differ (v10 A4). */}
                    {counts.builders}
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Close"
                  onClick={requestClose}
                  className="ml-auto inline-flex items-center justify-center min-w-11 min-h-11 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                >
                  ✕
                </button>
              </div>
              {/* Search rides in the sticky header (iOS .searchable pins under
                  the nav title the same way) so it stays reachable mid-scroll.
                  Only rendered once there's a list to filter. */}
              {users.length > 0 && (
                <div className="px-3 pb-2.5">
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    // Escape clears the query first; a second Escape falls
                    // through to the drawer's own dismiss (iOS .searchable
                    // grammar: clear, then close).
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && query) {
                        e.stopPropagation();
                        setQuery("");
                      }
                    }}
                    placeholder="Search builders & tinys"
                    aria-label="Search builders and tinys"
                    className="w-full rounded-[10px] border bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-500"
                    style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
                  />
                </div>
              )}
            </div>

            <div className="px-3 py-3 space-y-3">
              {/* 🌌 Mini-constellation header — the same starfield /universe
                  leads with, as a decorative teaser; tapping it goes to the
                  full interactive one. Clicks pass through the svg
                  (pointer-events-none in mini mode) to this link. */}
              {users.length > 0 && (
                <Link
                  href="/universe"
                  onClick={() => setOpen(false)}
                  aria-label="Open the full Tiny Universe"
                  className="block"
                  title="Open the full Tiny Universe"
                >
                  <UniverseConstellation users={users} trust={trust} consults={data?.consults ?? []} totalPublicTinys={data?.totalPublicTinys} mini />
                </Link>
              )}
              {loading && !data && (
                /* Skeleton cards, not a bare "Loading…" line — same treatment
                   the /universe route gets from its loading.tsx, sized to the
                   drawer's compact card so the swap is calm. animate-pulse is
                   neutralized under prefers-reduced-motion globally. */
                <div role="status" aria-label="Loading the Tiny Universe">
                  <div aria-hidden="true" className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="rounded-[14px] border p-3"
                        style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
                        <div className="flex items-center gap-2.5 mb-2">
                          <div className="w-8 h-8 rounded-full bg-white/10 animate-pulse" />
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="h-3.5 w-24 rounded bg-white/10 animate-pulse" />
                            <div className="h-2.5 w-16 rounded bg-white/5 animate-pulse" />
                          </div>
                          <div className="h-5 w-8 rounded-full bg-white/5 animate-pulse" />
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {Array.from({ length: 3 }).map((_, j) => (
                            <div key={j} className="h-6 w-16 rounded-full bg-white/5 animate-pulse" />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <span className="sr-only">Loading the Tiny Universe…</span>
                </div>
              )}
              {!loading && failed && users.length === 0 && (
                <div className="text-center py-8" role="alert">
                  <p className="text-xs text-gray-400 mb-4">Couldn&apos;t load the universe — check your connection.</p>
                  <button
                    type="button"
                    onClick={() => setReload((n) => n + 1)}
                    className="inline-block px-4 py-2 rounded-xl text-sm font-semibold border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                    style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {!loading && !failed && users.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-xs text-gray-400 mb-4">Be the first builder — create your AI by chatting. Free, forever.</p>
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, not a page */}
                  <a
                    href="/api/auth?return_to=/"
                    className="inline-block px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100"
                    style={{ background: "var(--tiny-accent)", color: "#000" }}
                  >
                    Sign in with GitHub →
                  </a>
                </div>
              )}
              {/* Live result count for AT — same rule as UniverseDirectory */}
              <p aria-live="polite" className="sr-only">
                {q ? `${shown.length} builder${shown.length === 1 ? "" : "s"} matching` : ""}
              </p>
              {q && shown.length === 0 && users.length > 0 && (
                <p role="status" className="text-xs text-gray-400 text-center py-6">
                  No builders or tinys match &ldquo;{query.trim()}&rdquo;
                </p>
              )}
              {shown.map((u) => (
                <div
                  key={u.login}
                  className="rounded-[14px] border p-3 neon-card"
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    {u.avatar ? (
                      // Size at the source (32px box × 2 DPR = s=64) — the drawer
                      // lists ~50 builders, so the raw 460px default was ~50
                      // full-res downloads into 32px boxes. Same helper Community
                      // uses (lib/community.githubAvatar).
                      <img src={githubAvatar(u.avatar, 32)} alt="" className="w-8 h-8 rounded-full border" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }} />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gray-800" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      {/* Link + instant close on activation: internal page nav
                          via next/link (client-side, no full reload). Per the
                          useOverlayExit grammar, item activation closes with
                          plain setOpen — focus follows the destination, not the
                          opener — so no riseOut/navigate double-fire. */}
                      <Link href={`/@${u.login}`} onClick={() => setOpen(false)} className="block text-sm font-semibold truncate hover:opacity-80" style={{ color: "var(--tiny-accent)" }}>
                        @{u.login}
                      </Link>
                      {u.name && <div className="text-[11px] text-gray-400 truncate">{u.name}</div>}
                    </div>
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap tabular-nums"
                      style={{ background: "rgba(var(--tiny-accent-rgb),0.1)", color: "var(--tiny-accent)" }}>
                      {u.tinyCount}
                    </span>
                  </div>
                  {u.tinys.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {u.tinys.slice(0, DRAWER_CHIPS).map((t) => (
                        <Link
                          key={t.name}
                          href={`/${t.name}`}
                          onClick={() => setOpen(false)}
                          className="px-2.5 py-1 rounded-full text-[11px] border transition-all hover:scale-105 active:scale-100 neon-chip"
                          // True-color chips (c26) — same rule as the grid:
                          // the chip wears its tiny's own accent.
                          style={t.accent ? {
                            background: `rgba(${hexRgb(t.accent)},0.12)`,
                            borderColor: `rgba(${hexRgb(t.accent)},0.35)`,
                            color: t.accent,
                          } : undefined}
                          {...(trust[t.name] ? { title: `Consulted by other tinys — trust ${Math.round(trust[t.name] * 100)}/100` } : {})}
                        >
                          {trust[t.name] ? (
                            <>
                              <IconBolt className="w-3 h-3 inline-block align-[-1px] mr-0.5" style={{ color: t.accent || "var(--tiny-accent)" }} />
                              <span className="sr-only">trusted — consulted by other tinys: </span>
                            </>
                          ) : null}/{t.name}
                        </Link>
                      ))}
                      {/* From tinyCount, not tinys.length: the worker embeds ≤8
                          tinys per builder, so a 20-tiny builder rendered 6
                          chips and "+2 →" when 14 were missing (v10 A4). */}
                      {hiddenTinyCount(u.tinyCount, Math.min(u.tinys.length, DRAWER_CHIPS)) > 0 && (
                        <Link href={`/@${u.login}`} onClick={() => setOpen(false)} className="px-2 py-1 text-[11px] text-gray-400 hover:text-white transition-colors no-underline">
                          +{hiddenTinyCount(u.tinyCount, Math.min(u.tinys.length, DRAWER_CHIPS))} →
                        </Link>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-gray-400">No public tinys yet</div>
                  )}
                </div>
              ))}
              {users.length > 0 && (
                <Link
                  href="/universe"
                  onClick={() => setOpen(false)}
                  className="block text-center text-xs text-gray-400 hover:text-white transition-colors py-3"
                >
                  see the full universe →
                </Link>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}
