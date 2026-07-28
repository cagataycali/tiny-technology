"use client";

/**
 * Follow button (memory graph stage 6 — the user-gesture social edge).
 * Client island on the server-rendered profile page. States:
 *   unknown (probe in flight) → renders nothing (no layout flash)
 *   logged out → hidden (the profile is public; following requires identity)
 *   self → hidden (can't follow yourself)
 *   in → Following (tap to unfollow — bitemporal close, history survives)
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { deadlineFor } from "../lib/deadlines";

export default function FollowButton({ login }: { login: string }) {
  // null = probing/hidden, false = not following, true = following
  const [following, setFollowing] = useState<boolean | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // `cancelled` guards two races: (a) unmount mid-flight → no setState on a
    // gone component; (b) `login` changes while a probe is in flight — cleanup
    // flips the OLD request's flag before the effect re-runs, so a slower
    // earlier response can't resolve last and commit the wrong builder's
    // follow state (+ setVisible) over the newer one. Shared cancelled-flag
    // pattern (Chat namePreview / UniverseDrawer).
    let cancelled = false;
    // Deadlined: `visible` only ever flips true in the success path below, so a
    // hung probe leaves the button rendering nothing — permanently. There is no
    // spinner and no error to notice; the profile simply looks like a page with
    // no follow affordance, which is indistinguishable from "logged out" and
    // from "this is you".
    fetch(`/api/follow?login=${encodeURIComponent(login)}`, { signal: AbortSignal.timeout(deadlineFor("/api/follow")) })
      .then((r) => {
        if (r.status === 401) return null;         // logged out → stay hidden
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        if (!d) return;
        if (d.error === "cannot follow yourself") return; // self → hidden
        if (d.ok === false && d.error) return;      // unknown builder etc.
        setFollowing(!!d.following);
        setVisible(true);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [login]);

  if (!visible || following === null) return null;

  const toggle = () => {
    if (busy) return;
    setBusy(true);
    const next = !following;
    // Deadlined: the `busy` latch above is released only in `.finally`, so a
    // hung toggle disables the button forever while it still shows the OLD
    // label — the user taps "Following ✓", nothing happens, and it stays
    // un-tappable. Timing out reaches the catch, which both toasts and clears
    // the latch.
    fetch("/api/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, action: next ? "follow" : "unfollow" }),
      signal: AbortSignal.timeout(deadlineFor("/api/follow")),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setFollowing(next);
          if (next) {
            toast(`Following @${login}`);
          } else {
            // The "Unfollow" reveal is hover-only — on TOUCH the resting
            // label still reads "Following ✓" when the tap lands, so an
            // accidental unfollow needs a one-tap way back. Undo re-follows
            // in place (cheaper than a confirm on a low-stakes edge, and the
            // bitemporal graph keeps history either way).
            toast(`Unfollowed @${login}`, {
              action: {
                label: "Undo",
                onClick: () => {
                  // Deadlined too: the toast dismisses on click, so a hung Undo
                  // is the one failure the user can't retry — the affordance is
                  // already gone. The catch's error toast is the only signal
                  // that the recovery didn't take.
                  fetch("/api/follow", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login, action: "follow" }),
                    signal: AbortSignal.timeout(deadlineFor("/api/follow")),
                  })
                    .then((r) => r.json())
                    .then((u) => {
                      if (u.ok) { setFollowing(true); toast(`Following @${login}`); }
                      else toast.error(u.error || "Couldn't re-follow — try again");
                    })
                    .catch(() => toast.error("Couldn't re-follow — try again"));
                },
              },
            });
          }
        } else {
          toast.error(d.error || "Couldn't update — try again");
        }
      })
      .catch(() => toast.error("Couldn't update — try again"))
      .finally(() => setBusy(false));
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={following}
      aria-busy={busy}
      className={`group px-4 py-2 min-h-11 rounded-full text-sm font-semibold border transition-all hover:scale-105 active:scale-100 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-wait ${
        following
          ? "bg-transparent text-[var(--tiny-accent)] border-[rgba(var(--tiny-accent-rgb),0.4)] hover:text-red-400 hover:bg-red-500/10 hover:border-red-400/50 active:bg-red-500/16"
          : "text-black border-transparent bg-[var(--tiny-accent)] hover:brightness-110 active:brightness-95"
      }`}
      style={following ? undefined : { boxShadow: "0 0 16px rgba(var(--tiny-accent-rgb),0.22)" }}
    >
      {following ? (
        /* Hover/focus reveals the destructive intent ("Unfollow") the resting
           "Following ✓" hides — standard follow-button affordance. Both labels
           occupy the same grid cell so the wider one fixes the width and the
           swap never jumps the button. The label never changes IN-FLIGHT
           (busy) — disabled + cursor-wait carry that; only pointer/keyboard
           focus flips it. aria-pressed already exposes state to AT, so the
           visual-only labels stay aria-hidden. */
        <span className="grid place-items-center" aria-hidden="true">
          <span className="col-start-1 row-start-1 group-hover:opacity-0 group-focus-visible:opacity-0 transition-opacity">Following ✓</span>
          <span className="col-start-1 row-start-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">Unfollow</span>
        </span>
      ) : (
        "Follow"
      )}
      {/* Accessible name tracks the action state directly (the visual labels
          above are decorative/aria-hidden). */}
      <span className="sr-only">{following ? `Following @${login} — activate to unfollow` : `Follow @${login}`}</span>
    </button>
  );
}
