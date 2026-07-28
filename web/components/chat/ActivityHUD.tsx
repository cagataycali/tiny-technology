"use client";

/**
 * Activity HUD (careless ContextHUD pattern) — "what happened while you
 * were away". A small ⚡ button near the header opens a dropdown of the
 * user's event ring (scheduler fires, telegram messages, visits, learns).
 *
 * Polls /api/events only while open (+one initial count check); sinceId
 * high-water mark in localStorage drives the unread badge.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconBolt } from "./icons";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { iconFor } from "../../lib/chat/event-icons";
import { isAuthed, reportAuthFailure } from "../../lib/chat/whoami";
import { ago } from "../../lib/relative-time";
import { deadlineFor } from "../../lib/deadlines";

type TinyEvent = { id: number; kind: string; detail: string; created: number };

const SEEN_KEY = "tiny_events_seen_id";
// Open: snappy. Closed: relaxed — keeps the ⚡ badge live (job results,
// telegram, DM events land while the user chats) without hammering the
// worker from idle tabs. Mirrors MessagesHUD's polling model.
const POLL_OPEN_MS = 20_000;
const POLL_CLOSED_MS = 90_000;

export default function ActivityHUD() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TinyEvent[]>([]);
  // false until the first /api/events response resolves — lets the panel tell
  // "still fetching" apart from "fetched, genuinely empty" so a user who DOES
  // have activity isn't briefly shown "Nothing yet" on first open.
  const [loaded, setLoaded] = useState(false);
  // The worker being down now surfaces as ok:false / 502 (was swallowed to an
  // empty ring). Track it so the panel shows "couldn't load" instead of the
  // "Nothing yet" empty state — but only when we have nothing cached, so a
  // transient poll blip never wipes a populated list.
  const [errored, setErrored] = useState(false);
  const [unread, setUnread] = useState(0);
  // null = unknown, false = signed out (render nothing), true = signed in
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // load() closes over poll-time state; the ref keeps it seeing the LIVE
  // open flag (events arriving while the panel is open are on-screen —
  // they count as seen immediately, or the poll re-lights the badge for
  // things the user is currently reading)
  const openRef = useRef(false);
  useEffect(() => { openRef.current = open; }, [open]);
  // Exit choreography + focus return (shared pass-97 pattern)
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => setOpen(false), openerRef,
  );

  const seenId = () => {
    try { return Number(localStorage.getItem(SEEN_KEY) || 0); } catch { return 0; }
  };

  const load = () => {
    // Await the shared auth probe: signed out, /api/events is a guaranteed
    // 401 (c12 — anon visits fired 7 auth'd endpoints). The 401 branch
    // below stays as the mid-session-expiry backstop.
    isAuthed().then((ok) => {
    if (!ok) { setLoggedIn(false); return; }
    // Deadline it: this poll drives `errored`, and a fetch that never settles
    // leaves the panel on its loading copy with no retry (the .catch below is
    // the only path that offers one).
    fetch("/api/events", { signal: AbortSignal.timeout(deadlineFor("/api/events")) })
      .then((r) => {
        // Mid-session expiry (v6 E2): flipping only OUR state left every other
        // consumer reading a whoami cache that still said authenticated. Report
        // it — one confirmation probe converges the whole page.
        if (r.status === 401) { setLoggedIn(false); reportAuthFailure(r.status); return null; }
        setLoggedIn(true);
        return r.json();
      })
      .then((d) => {
        if (!d?.ok) { setErrored(true); return; }
        setErrored(false);
        const evs: TinyEvent[] = d.events || [];
        setEvents(evs);
        if (openRef.current && evs.length) {
          // Panel open → everything visible is seen as it arrives
          const maxId = evs.reduce((m, e) => Math.max(m, e.id), 0);
          try { localStorage.setItem(SEEN_KEY, String(maxId)); } catch { }
          setUnread(0);
          return;
        }
        const last = seenId();
        setUnread(evs.filter((e) => e.id > last).length);
      })
      // A network reject or a worker 502 returning non-JSON HTML makes r.json()
      // throw — the empty catch used to swallow it, leaving errored=false so the
      // panel showed "Nothing yet" instead of the retry UI that already exists.
      // Flag it (only surfaced when events is empty, so a poll blip over a
      // populated ring never wipes the list).
      .catch(() => setErrored(true))
      .finally(() => setLoaded(true));
    });
  };

  // Passkey login lands client-side (no reload) — `tiny:auth` re-arms the
  // signed-out gate so the badge appears without a refresh.
  useEffect(() => {
    const onAuth = () => setLoggedIn(null);
    window.addEventListener("tiny:auth", onAuth);
    return () => window.removeEventListener("tiny:auth", onAuth);
  }, []);

  // Always-on poll (badge + login probe): fast while open, slow while
  // closed. Paused while the tab is hidden; visibilitychange refreshes
  // immediately on return. Mirrors MessagesHUD.
  useEffect(() => {
    if (loggedIn === false) return;
    const tick = () => { if (!document.hidden) load(); };
    tick();
    timerRef.current = setInterval(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loggedIn]);

  // Escape closes (outside click already handled by the backdrop div)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  // Move focus INTO the panel on open — it's a role=dialog, so a SR must
  // announce it and Tab must start inside (Onboarding pass-126 / UniverseDrawer
  // grammar). Focus the container, not a row, so nothing is pre-selected.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);
  // …and keep Tab inside it (WCAG 2.4.3) — aria-modal tells the AT the page
  // behind is inert, so focus must not walk out there.
  useFocusTrap(panelRef, open);

  const markSeen = () => {
    const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
    if (maxId) {
      try { localStorage.setItem(SEEN_KEY, String(maxId)); } catch { }
    }
    setUnread(0);
  };

  if (loggedIn !== true) return null;

  return (
    <div className="relative">
      <button
        ref={openerRef}
        onClick={() => {
          if (open) { requestClose(); return; }
          setOpen(true);
          markSeen();
        }}
        className="relative p-2 rounded-lg transition-colors hover:bg-white/10 inline-flex items-center justify-center min-w-11 min-h-11"
        aria-label={unread > 0 ? `Activity — ${unread} new event${unread === 1 ? "" : "s"}` : "Activity"}
        aria-expanded={open}
        aria-haspopup="true"
        title="Activity — what happened while you were away"
      >
        <IconBolt className="w-5 h-5" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
            style={{ background: "var(--tiny-accent)", color: "#000" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          {/* click-away (portaled: the header's backdrop-filter creates a
              containing block, so fixed inset-0 rendered inside it only
              covered the header strip — clicks below never dismissed) */}
          <div className="fixed inset-0 z-[90]" onClick={requestClose} />
          {/* Pinned under the header, right-aligned to its max-w-4xl content
              column (same geometry as MessagesHUD); viewport-capped width */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Activity"
            tabIndex={-1}
            className={`fixed top-[4.5rem] w-80 max-w-[calc(100vw-2rem)] max-h-96 overflow-y-auto overscroll-contain rounded-xl border z-[95] outline-none ${exitClass} right-[max(1rem,calc((100vw-56rem)/2+1rem))]`}
            onAnimationEnd={onAnimationEnd}
            style={{
              background: "rgba(10,10,10,0.97)",
              borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
            }}
          >
            <div
              className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider opacity-60 text-white border-b"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
            >
              <span className="inline-flex items-center gap-1.5"><IconBolt className="w-3.5 h-3.5" /> Activity</span>
            </div>
            {events.length === 0 ? (
              !loaded ? (
                <div role="status" className="px-4 py-6 text-sm text-gray-400 text-center">Loading…</div>
              ) : errored ? (
                <div role="alert" className="px-4 py-6 text-sm text-gray-400 text-center space-y-3">
                  <div>Couldn&apos;t load your activity — try again.</div>
                  <button
                    onClick={load}
                    className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                    style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                /* role="status" so the loading→"genuinely empty" resolution
                   announces, matching the "Loading…" sibling above (a blind
                   user otherwise can't tell "still fetching" from "empty"). */
                <div role="status" className="px-4 py-6 text-sm text-gray-400 text-center">
                  Nothing yet — schedule a job or pair Telegram and life shows up here
                </div>
              )
            ) : (
              /* role="log" + aria-live: the panel polls every 20s while open and
                 new activity rows append; a blind user who opened the feed would
                 otherwise never hear them land. Polite (queues, never interrupts)
                 + stable e.id keys mean only the added rows announce, not the
                 whole list on every poll. */
              <div role="log" aria-live="polite">
              {[...events].reverse().map((e) => (
                <div
                  key={e.id}
                  className="px-4 py-2.5 flex gap-3 items-start border-b last:border-0"
                  style={{ borderColor: "rgba(255,255,255,0.05)" }}
                >
                  {/* Decorative — the event kind is announced as visible text
                      just below, so hide the raw glyph from SR (it otherwise
                      reads "eyes"/"airplane"/… before every row). Matches the
                      aria-hidden trigger ⚡ + JobsPanel status-dot convention. */}
                  <span className="text-sm shrink-0" aria-hidden="true">{iconFor(e.kind)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-white break-words">{e.detail || e.kind}</div>
                    <div className="text-[10px] opacity-40 text-white mt-0.5">
                      {e.kind} · {ago(e.created)} ago
                    </div>
                  </div>
                </div>
              ))}
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
