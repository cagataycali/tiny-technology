"use client";

/**
 * Messages HUD (ActivityHUD pattern) — user↔user DMs in the header.
 *
 * 💬 button with unread badge → dropdown:
 *   - inbox view: threads (peer avatar/name, last message, unread count)
 *   - thread view: full conversation + inline reply composer
 *
 * Backed by /api/messages (session-gated proxy → worker D1). Opening a
 * thread marks its inbound messages read server-side. Polls only while
 * open (+ one mount check for the badge, which doubles as login probe).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChat } from "./icons";
import { toast } from "sonner";
import { mergeThreadPoll, markThreadRead, optimisticId, type DmThread as Thread, type DmMessage as Msg } from "../../lib/chat/dm";
import { dmDraftKey, getDmDraft, setDmDraft, clearDmDraft, type DmDrafts } from "../../lib/chat/dm-drafts";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { useConfirm } from "./ConfirmDialog";
import { isAuthed, reportAuthFailure } from "../../lib/chat/whoami";
import { shouldSendOnEnter } from "../../lib/chat/composer";
import { ago } from "../../lib/relative-time";
import { deadlineFor } from "../../lib/deadlines";

// Open: snappy (you're watching the thread). Closed: relaxed — keeps the
// unread badge live without hammering the worker from every idle tab.
const POLL_OPEN_MS = 15_000;
const POLL_CLOSED_MS = 60_000;

export default function MessagesHUD({ tinyName }: { tinyName?: string }) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  // false until loadInbox first resolves — lets the inbox tell "still fetching"
  // apart from "fetched, genuinely no threads" so a user with conversations
  // isn't briefly told "No conversations yet" during the initial fetch.
  const [inboxLoaded, setInboxLoaded] = useState(false);
  // A failed inbox fetch used to fall through to "No conversations yet" (empty
  // threads + inboxLoaded=true) with NO toast and NO retry — an outage was
  // indistinguishable from having no DMs, and a user with real conversations
  // was told they had none. Track the failure so the empty branch can show a
  // retryable error instead (mirrors this file's own thread-view threadError).
  // Only read when threads.length===0, so a transient poll blip with a
  // populated inbox never flips the screen to an error.
  const [inboxError, setInboxError] = useState(false);
  const [unread, setUnread] = useState(0);
  const [peer, setPeer] = useState<Thread | null>(null); // open thread
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // false until loadThread resolves for the current peer — lets the body
  // tell "still fetching" apart from "fetched, genuinely empty" so a brand-new
  // (or ?dm= deep-linked) conversation shows an empty state, not "Loading…"
  // forever.
  const [threadLoaded, setThreadLoaded] = useState(false);
  // A failed thread fetch used to fall through to "No messages yet — say hi 👋"
  // (empty msgs + threadLoaded=true), so an existing conversation on a flaky
  // connection looked brand-new. Track the failure so the body can say so.
  const [threadError, setThreadError] = useState(false);
  // 🔴 Drafts are keyed BY PEER (lib/chat/dm-drafts.ts). A single shared string
  // survived every peer transition — row click, ← back, Escape, ?dm= deep link
  // all reset `msgs` and left the draft in place — so the composer showed
  // "Message B…" over text written for A and one tap of ↑ delivered it to B.
  const [drafts, setDrafts] = useState<DmDrafts>({});
  // Derived, not held: with the draft in state keyed on the peer, there is
  // nothing to keep in sync on a switch — the answer is the MAP plus whoever is
  // open, so a transition needs no reset at all and cannot forget one.
  const draftKeyNow = dmDraftKey(peer);
  const draft = getDmDraft(drafts, draftKeyNow);
  const [sending, setSending] = useState(false);
  const [deletingMsg, setDeletingMsg] = useState<number | null>(null);
  // null = unknown, false = signed out (render nothing), true = signed in
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLInputElement | null>(null);
  // Mirrors the peer currently being viewed so a slow loadThread resolver can
  // tell it's stale (user switched threads / went back to the inbox mid-fetch)
  // and drop its result instead of painting thread A's messages under thread
  // B's header + marking the wrong thread read. mergeThreadPoll only guards by
  // message-id maxima, which does NOT catch a cross-thread swap.
  const activePeerRef = useRef<string | null>(null);
  // Exit choreography + focus return (shared pass-97 pattern)
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => setOpen(false), openerRef,
  );
  const { confirm, dialog } = useConfirm();

  const loadInbox = () => {
    // Await the shared auth probe: signed out, /api/messages is a
    // guaranteed 401 (c12 — anon visits fired 7 auth'd endpoints). The
    // 401 branch below stays as the mid-session-expiry backstop.
    isAuthed().then((ok) => {
    if (!ok) { setLoggedIn(false); return; }
    // Deadline it: `inboxLoaded` only flips in the .finally, so a hung read
    // holds the inbox on its skeleton instead of the retry branch.
    fetch("/api/messages", { signal: AbortSignal.timeout(deadlineFor("/api/messages")) })
      .then((r) => {
        // See ActivityHUD: report the expiry so the shared cache and every
        // other consumer stop believing in a session that's gone (v6 E2).
        if (r.status === 401) { setLoggedIn(false); reportAuthFailure(r.status); return null; }
        setLoggedIn(true);
        // The proxy answers an outage with a JSON {error} body at status 503
        // (fetch timeout) — parseable, so it would slip past the .catch below
        // and mask as "No conversations yet". Route any non-ok into the error
        // branch explicitly.
        if (!r.ok) throw new Error(`inbox ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!d) return; // 401 → signed out, handled above
        setInboxError(false);
        const ts: Thread[] = Array.isArray(d.threads) ? d.threads : [];
        setThreads(ts);
        setUnread(ts.reduce((n, t) => n + (t.unread || 0), 0));
      })
      // Network reject / non-ok worker response: flag it so the empty branch
      // shows a retry instead of the misleading "No conversations yet".
      .catch(() => setInboxError(true))
      .finally(() => setInboxLoaded(true));
    });
  };

  // Passkey login lands client-side (no reload) — `tiny:auth` re-arms the
  // signed-out gate so the badge appears without a refresh.
  useEffect(() => {
    const onAuth = () => setLoggedIn(null);
    window.addEventListener("tiny:auth", onAuth);
    return () => window.removeEventListener("tiny:auth", onAuth);
  }, []);

  const loadThread = (p: Thread) => {
    const key = p.login || p.userId;
    setThreadError(false);
    fetch(`/api/messages?with=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(deadlineFor("/api/messages")) })
      // A worker outage is a JSON {error} 503 (see loadInbox) — throw on any
      // non-ok so it lands in the .catch → threadError, not a blank thread.
      .then((r) => { if (!r.ok) throw new Error(`thread ${r.status}`); return r.json(); })
      .then((d) => {
        // Drop a stale resolver: if the user switched threads (or went back to
        // the inbox) while this fetch was in flight, committing now would swap
        // in the wrong thread's messages and clear the wrong unread badge.
        if (activePeerRef.current !== key) return;
        const next: Msg[] = Array.isArray(d.messages) ? d.messages : [];
        // Poll/send race rules live in lib/chat/dm.ts (pure + tested):
        // stale-poll guard keeps the optimistic view; scroll only on new.
        setMsgs((prev) => {
          const merged = mergeThreadPoll(prev, next);
          if (merged.hasNew) {
            setTimeout(() => bottomRef.current?.scrollIntoView({ block: "nearest" }), 50);
          }
          return merged.messages;
        });
        // Opening marks read server-side — derive badge (idempotent per tick).
        // Use login||userId (same identity loadThread fetches with): the
        // ?dm=<login> deep-link peer carries userId=login, so keying on the
        // raw userId missed the inbox thread (numeric id) and left the badge
        // lit until the next poll. markThreadRead matches either field.
        setThreads((prev) => {
          const marked = markThreadRead(prev, p.login || p.userId);
          setUnread(marked.unread);
          return marked.threads;
        });
      })
      .catch(() => { if (activePeerRef.current === key) setThreadError(true); })
      .finally(() => { if (activePeerRef.current === key) setThreadLoaded(true); });
  };

  // Always-on poll (badge + login probe): fast while open, slow while
  // closed so the unread badge stays live on the page. Paused entirely
  // while the tab is hidden — visibilitychange refreshes immediately on
  // return, so backgrounded tabs don't burn worker requests.
  useEffect(() => {
    if (loggedIn === false) return;

    const tick = () => {
      if (document.hidden) return;
      loadInbox();
      if (open && peer) loadThread(peer);
    };
    tick();
    timerRef.current = setInterval(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);

    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, peer?.userId, loggedIn]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (peer) setPeer(null); else requestClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, peer, requestClose]);

  // Keep the stale-resolver guard in sync with the viewed thread. Covers every
  // peer transition — row click, ← back (null), ?dm= deep link — so loadThread
  // resolvers landing after a switch see the mismatch and bail.
  useEffect(() => {
    activePeerRef.current = peer ? (peer.login || peer.userId) : null;
  }, [peer]);

  // Move focus INTO the dialog on open AND follow the inbox↔thread view swap —
  // it's aria-modal, so a SR must announce it and Tab must start inside (shared
  // overlay grammar: ActivityHUD pass 133 / JobsPanel). Without following the
  // swap, clicking a thread row (or ← back) unmounts the clicked control and
  // drops focus to <body> — a keyboard/SR user loses their place every hop and
  // has to re-Tab in. Opening a thread lands focus on the composer (the view
  // exists to reply; Enter-to-send is wired) — same call as the Onboarding
  // byok-view fix (f200332); the inbox lands on the container so nothing is
  // pre-selected. useOverlayExit returns focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    if (peer) draftRef.current?.focus();
    else panelRef.current?.focus();
  }, [open, peer]);
  // Trap Tab inside (WCAG 2.4.3) — aria-modal marks the page behind inert.
  useFocusTrap(panelRef, open);

  // 📬 ?dm=<login> deep link — the push notification for an incoming DM
  // navigates here (worker messages.ts fan-out). Open that thread directly;
  // consume the param so reloads don't reopen it.
  useEffect(() => {
    if (loggedIn !== true) return;
    const url = new URL(window.location.href);
    const dm = url.searchParams.get("dm");
    if (!dm) return;
    url.searchParams.delete("dm");
    window.history.replaceState({}, "", url);
    const p: Thread = { userId: dm, login: dm.replace(/^@/, ""), name: dm.replace(/^@/, ""), avatar: "", unread: 0, lastBody: "", lastAt: 0 };
    setOpen(true);
    setPeer(p);
    setMsgs([]);
    setThreadLoaded(false);
    loadThread(p);
  }, [loggedIn]);

  const send = () => {
    const text = draft.trim();
    if (!text || !peer || sending) return;
    // Same stale-thread guard loadThread uses: the ← back / inbox rows stay
    // clickable while the POST is in flight, so capture who we're sending TO
    // now and bail on success if the user has since switched threads —
    // otherwise the optimistic bubble appends onto the NEW thread's list.
    const sentTo = peer.login || peer.userId;
    setSending(true);
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: sentTo, message: text, viaTiny: tinyName || "" }),
      // `sending` disables the send button until the .finally runs — without a
      // deadline a hung POST locks the composer with the draft still in it.
      signal: AbortSignal.timeout(deadlineFor("/api/messages")),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          // Clear by `sentTo`, and BEFORE the stale-peer bail: the message was
          // delivered, so holding its text would resurrect it in that thread's
          // composer the next time it's opened (and, under the old shared
          // draft, in whichever thread happened to be open now).
          setDrafts((prev) => clearDmDraft(prev, sentTo));
          if (activePeerRef.current !== sentTo) return;
          // Optimistic append — poll will reconcile (id rules in lib/chat/dm.ts)
          setMsgs((prev) => [...prev, {
            id: optimisticId(d.id),
            direction: "sent",
            body: text,
            created: Math.floor(Date.now() / 1000),
          }]);
          setTimeout(() => bottomRef.current?.scrollIntoView({ block: "nearest" }), 50);
        } else {
          // Was silent: the spinner just stopped and the draft stayed put, so a
          // failed send looked identical to a successful one. Surface it (every
          // other mutation here toasts) and KEEP the draft so it can be retried.
          toast.error(d.error || "Couldn't send — try again");
        }
      })
      .catch(() => toast.error("Couldn't send — check your connection"))
      .finally(() => setSending(false));
  };

  if (loggedIn !== true) return null;

  return (
    <div className="relative">
      <button
        ref={openerRef}
        onClick={() => {
          if (open) { requestClose(); return; }
          setOpen(true);
          setPeer(null);
          // No explicit loadInbox() here: setOpen(true) re-runs the poll effect
          // whose tick() loads the inbox immediately (the ActivityHUD open-
          // handler pattern — markSeen only, effect does the fetch). Calling it
          // here too fired two near-simultaneous /api/messages on every open.
        }}
        className="relative p-2 rounded-lg transition-colors hover:bg-white/10 inline-flex items-center justify-center min-w-11 min-h-11"
        aria-label={unread > 0 ? `Messages — ${unread} unread` : "Messages"}
        aria-expanded={open}
        aria-haspopup="true"
        title="Direct messages"
      >
        <IconChat className="w-5 h-5" />
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
              containing block, so a fixed overlay rendered inside it would
              only cover the header, not the viewport) */}
          <div className="fixed inset-0 z-[90] bg-black/40 sm:bg-transparent" onClick={requestClose} />
          {/* Mobile: full-screen sheet (100dvh — the composer must stay
              reachable above the keyboard). Desktop (sm+): dropdown pinned
              under the header, right-aligned to the header's max-w-4xl
              (56rem) content column. */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Direct messages"
            tabIndex={-1}
            className={`fixed z-[95] outline-none ${exitClass} flex flex-col border
                       inset-0 h-[100dvh] w-full rounded-none
                       sm:inset-auto sm:top-[4.5rem] sm:h-auto sm:max-h-[28rem] sm:w-96 sm:rounded-xl
                       sm:right-[max(1rem,calc((100vw-56rem)/2+1rem))]`}
            onAnimationEnd={onAnimationEnd}
            style={{
              background: "rgba(10,10,10,0.97)",
              borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
            }}
          >
            <div
              className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider opacity-60 text-white border-b flex items-center gap-2"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
            >
              {peer ? (
                <>
                  <button
                    onClick={() => setPeer(null)}
                    className="inline-flex items-center justify-center min-w-11 min-h-11 -m-1.5 hover:opacity-100 opacity-80"
                    aria-label="Back to inbox"
                  >←</button>
                  {peer.avatar && (
                    <img src={peer.avatar} alt="" className="w-4 h-4 rounded-full" />
                  )}
                  <span className="normal-case tracking-normal truncate">{peer.name} {peer.login ? `(@${peer.login})` : ""}</span>
                </>
              ) : (
                <><IconChat className="w-3.5 h-3.5" /> Messages</>
              )}
              {/* Close — the mobile sheet has no visible way out otherwise
                  (no click-away edge on a full-screen surface) */}
              <button
                onClick={requestClose}
                className="ml-auto inline-flex items-center justify-center min-w-11 min-h-11 -m-1.5 opacity-60 hover:opacity-100 sm:hidden"
                aria-label="Close messages"
              >✕</button>
            </div>

            {!peer ? (
              /* ── Inbox ── */
              <div className="overflow-y-auto overscroll-contain flex-1 sm:flex-none">
                {threads.length === 0 ? (
                  !inboxLoaded ? (
                    <div role="status" className="px-4 py-6 text-sm text-gray-400 text-center">Loading…</div>
                  ) : inboxError ? (
                    /* Fetch failed — DON'T show "no conversations" (an outage
                       would tell a user with real DMs they have none, with no
                       way to retry). Say what happened + offer a retry, matching
                       the thread view's threadError branch. */
                    <div role="alert" className="px-4 py-6 text-sm text-gray-400 text-center space-y-3">
                      <div>Couldn&apos;t load your messages.</div>
                      <button
                        onClick={loadInbox}
                        className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                        style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <div className="px-4 py-6 text-sm text-gray-400 text-center">
                      No conversations yet — ask your tiny to “send a message to &lt;user&gt;”
                    </div>
                  )
                ) : (
                  threads.map((t) => (
                    <button
                      key={t.userId}
                      onClick={() => { setPeer(t); setMsgs([]); setThreadLoaded(false); loadThread(t); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors border-b"
                      style={{ borderColor: "rgba(255,255,255,0.05)" }}
                    >
                      {t.avatar ? (
                        <img src={t.avatar} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm"
                          style={{ background: "rgba(var(--tiny-accent-rgb),0.2)" }}>
                          {/* First CODE POINT, not code unit: .slice(0,1) takes
                              half a surrogate pair when a display name starts
                              with an emoji/astral char (😀, 𝕄), rendering a broken
                              � in the avatar. Array.from iterates by code point. */}
                          {(Array.from(String(t.name || "?"))[0] || "?").toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-white font-medium truncate">{t.name}</span>
                          <span className="text-[10px] opacity-40 text-white flex-shrink-0">{ago(t.lastAt)}</span>
                        </div>
                        <div className="text-xs opacity-50 text-white truncate">{t.lastBody}</div>
                      </div>
                      {t.unread > 0 && (
                        <>
                          {/* The "9+" pill is decorative to AT — a bare trailing
                              number reads as a context-free "3" after the name +
                              preview. The sr-only text carries the meaning (mirrors
                              the toolbar badge's aria-label + JobsPanel/MemoryPanel
                              sr-only idiom); the real count, not the clamped "9+". */}
                          <span aria-hidden="true"
                            className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0"
                            style={{ background: "var(--tiny-accent)", color: "#000" }}>
                            {t.unread > 9 ? "9+" : t.unread}
                          </span>
                          <span className="sr-only">{t.unread} unread</span>
                        </>
                      )}
                    </button>
                  ))
                )}
              </div>
            ) : (
              /* ── Thread ── */
              <>
                {/* role="log" + aria-live: an open thread polls every 15s and
                    appends inbound messages (mergeThreadPoll); a new bubble
                    renders + auto-scrolls into view, but a blind user would
                    never hear a reply arrive without a live region. role="log"
                    is the message-stream idiom (announces additions, not the
                    whole list). The loading/error/empty children keep their own
                    role="status"/"alert" — those fire before any message row
                    exists, so they don't double-announce with appends. */}
                <div role="log" aria-live="polite" aria-label="Conversation" className="overflow-y-auto overscroll-contain px-3 py-3 space-y-2 flex-1" style={{ minHeight: "8rem" }}>
                  {msgs.length === 0 ? (
                    !threadLoaded ? (
                      <div role="status" className="text-sm opacity-40 text-white text-center py-4">Loading…</div>
                    ) : threadError ? (
                      /* Fetch failed — DON'T show "no messages" (an existing
                         thread on a flaky connection would look brand-new and
                         invite a redundant "hi"). Say what happened + offer a
                         retry. */
                      <div role="alert" className="text-sm text-gray-400 text-center py-6 space-y-3">
                        <div>Couldn&apos;t load this conversation.</div>
                        <button
                          onClick={() => peer && loadThread(peer)}
                          className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                          style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      /* Fetched and genuinely empty — a fresh or ?dm= deep-linked
                         thread. Invite the first message instead of implying the
                         view is stuck loading. */
                      <div className="text-sm text-gray-400 text-center py-6">
                        No messages yet — say hi 👋
                      </div>
                    )
                  ) : (
                    msgs.map((m) => (
                      <div key={m.id} className={`group flex items-center gap-1 ${m.direction === "sent" ? "justify-end" : "justify-start"}`}>
                        {/* 🗑️ Delete own sent message (worker verifies sender;
                            id > 0 = server-confirmed — an optimistic row can't
                            be deleted yet). Hover-reveal on desktop, always
                            visible on touch (no hover there). */}
                        {m.direction === "sent" && m.id > 0 && (
                          <button
                            onClick={async () => {
                              if (!(await confirm({
                                title: "Delete message?",
                                message: "The recipient will no longer see it.",
                                confirmLabel: "Delete",
                                danger: true,
                              }))) return;
                              setDeletingMsg(m.id);
                              fetch("/api/messages", {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: m.id }),
                                signal: AbortSignal.timeout(deadlineFor("/api/messages")),
                              })
                                .then((r) => r.json())
                                .then((d) => {
                                  if (d.ok) setMsgs((prev) => prev.filter((x) => x.id !== m.id));
                                  // Was silent: a failed delete looked identical to a
                                  // successful one (row stays, recipient still sees it).
                                  // Surface it like send() does.
                                  else toast.error(d.error || "Couldn't delete — try again");
                                })
                                .catch(() => toast.error("Couldn't delete — check your connection"))
                                .finally(() => setDeletingMsg(null));
                            }}
                            disabled={deletingMsg === m.id}
                            className="p-1.5 text-red-400/70 hover:text-red-400 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 transition-opacity"
                            aria-label="Delete message"
                            title="Delete (removes it for the recipient too)"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                          </button>
                        )}
                        {/* dir="auto" so a DM whose body starts RTL (Arabic/Hebrew)
                            renders right-aligned with correct punctuation/embedded-Latin
                            ordering — DMs are raw text nodes, not markdown, so they miss
                            the per-block dir="auto" the message renderer sets. Also gives
                            the standard bidi isolation that neutralizes U+202E spoofing. */}
                        <div
                          dir="auto"
                          className="max-w-[80%] px-3 py-2 rounded-xl text-sm text-white whitespace-pre-wrap break-words"
                          style={m.direction === "sent"
                            ? { background: "rgba(var(--tiny-accent-rgb),0.25)", border: "1px solid rgba(var(--tiny-accent-rgb),0.3)" }
                            : { background: "rgba(255,255,255,0.08)" }}
                        >
                          {m.body}
                          <div className="text-[10px] opacity-40 mt-1 text-right">
                            {ago(m.created)}{m.viaTiny ? ` · via ${m.viaTiny}` : ""}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={bottomRef} />
                </div>
                {/* padding-bottom adds the iOS home-indicator inset on top of
                    the base 0.5rem (pb-safe alone would REPLACE it with 0 on
                    non-notched devices); viewportFit=cover is set globally */}
                <div
                  className="p-2 border-t flex gap-2"
                  style={{
                    borderColor: "rgba(var(--tiny-accent-rgb),0.15)",
                    paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))",
                  }}
                >
                  <input
                    ref={draftRef}
                    value={draft}
                    onChange={(e) => setDrafts((prev) => setDmDraft(prev, draftKeyNow, e.target.value))}
                    onKeyDown={(e) => { if (shouldSendOnEnter(e)) { e.preventDefault(); send(); } }}
                    placeholder={`Message ${peer.name}…`}
                    aria-label={`Message ${peer.name}`}
                    maxLength={2000}
                    enterKeyHint="send"
                    // text-base on mobile: iOS zooms the page on focus of any
                    // input under 16px, which is what wedged the sheet half
                    // off-screen and made sending impossible
                    className="flex-1 min-w-0 bg-white/5 text-white text-base sm:text-sm rounded-lg px-3 py-2 outline-none border border-transparent focus:border-[rgba(var(--tiny-accent-rgb),0.4)]"
                  />
                  <button
                    onClick={send}
                    disabled={sending || !draft.trim()}
                    aria-busy={sending}
                    className="px-4 sm:px-3 py-2 rounded-lg text-sm font-semibold transition-all hover:scale-105 active:scale-100 disabled:opacity-50 disabled:hover:scale-100 grid place-items-center min-w-[2.75rem] sm:min-w-[2.25rem]"
                    style={{ background: "var(--tiny-accent)", color: "#000" }}
                    aria-label={sending ? "Sending message" : "Send message"}
                  >
                    {sending
                      ? <span className="inline-block w-4 h-4 rounded-full border-2 border-black/30 border-t-black animate-spin" aria-hidden="true" />
                      : "↑"}
                  </button>
                </div>
              </>
            )}
          </div>
          {dialog}
        </>,
        document.body
      )}
    </div>
  );
}
