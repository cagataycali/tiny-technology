"use client";

/**
 * 🔐 Auth button — GitHub login, passkey login, passkey enrollment, session menu.
 *
 * Flow:
 *   - Not logged in → "Sign in" (GitHub) + fingerprint icon (passkey login)
 *   - Logged in     → avatar menu: my tinys, add passkey, logout
 */
import { IconSparkles, IconBrain, IconClock, IconDevice, IconWallet, IconShare, IconTrash, IconKey, IconBell } from "./icons";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { enablePush } from "./platform";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { whoami } from "../../lib/chat/whoami";
import { authEvent } from "../../lib/chat/auth-events";
import { deadlineFor, failureMessage } from "../../lib/deadlines";

type Me = {
  authenticated: boolean;
  user?: { id: string; login: string; name?: string; avatar?: string };
  tinys?: { name: string; created: number }[];
};

export default function AuthButton({
  onShare,
  onClear,
  onOpenSettings,
  onOpenMemory,
  onOpenJobs,
  hasMessages,
}: {
  onShare?: () => void;
  onClear?: () => void;
  onOpenSettings?: () => void; // renders the settings gear next to the avatar
  onOpenMemory?: () => void; // Memory panel entry in the account menu
  onOpenJobs?: () => void; // Jobs panel entry in the account menu
  hasMessages?: boolean; // share/clear only make sense with a conversation
} = {}) {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Exit choreography + focus return for DISMISSALS (shared pass-97
  // pattern); item activation closes instantly — focus follows the action
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(
    () => setOpen(false), avatarRef,
  );

  // Post-action refresh forces a fresh probe; mount rides the shared
  // cached whoami() so the page issues ONE /api/me total (c12: it fired
  // twice — here + Chat's claim probe — plus 5 more auth'd 401s anon).
  const refresh = () => whoami({ fresh: true }).then((m) => setMe(m as Me));

  useEffect(() => {
    whoami().then((m) => setMe(m as Me));
  }, []);

  // Menu dismissal: outside click + Escape (previously only the avatar
  // toggled it — expected dropdown behavior everywhere else on the web)
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, requestClose]);

  const loginGitHub = () => {
    // Keep the query string: signing in from /foo?share=abc (or a ?q=
    // prefill) must return to the same view, not a bare pathname
    window.location.href = `/api/auth?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  const loginPasskey = async () => {
    if (!browserSupportsWebAuthn()) {
      toast.error("This browser doesn't support passkeys");
      return;
    }
    setBusy(true);
    try {
      // Deadline the two FETCHES but never `startAuthentication` between them:
      // that call is the OS biometric sheet, and the user is allowed to take as
      // long as they like in front of it. `busy` only clears in the `finally`,
      // so a hung options request used to leave both sign-in buttons disabled
      // with no way back but a reload.
      const options = await fetch("/api/auth/webauthn/login", {
        signal: AbortSignal.timeout(deadlineFor("/api/auth/webauthn/login")),
      }).then((r) => r.json());
      const assertion = await startAuthentication({ optionsJSON: options });
      const res = await fetch("/api/auth/webauthn/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assertion),
        signal: AbortSignal.timeout(deadlineFor("/api/auth/webauthn/login")),
      }).then((r) => r.json());
      if (res.ok) {
        toast.success("🔐 Signed in with passkey!");
        refresh();
        // Passkey login is client-side (no reload, unlike GitHub's redirect),
        // so nothing else learns the session changed. Tell the page: a private
        // tiny the owner just signed into re-probes ownership and unlocks in
        // place instead of staying gated until a manual refresh.
        window.dispatchEvent(authEvent("signed-in"));
      } else {
        toast.error(res.error || "Passkey login failed");
      }
    } catch (e: any) {
      // A dismissed biometric sheet (NotAllowedError) stays silent; a timeout
      // must NOT surface as `e.message`, which reads "signal timed out".
      const msg = failureMessage(e, "Passkey login failed");
      if (msg) toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const enrollPasskey = async () => {
    if (!browserSupportsWebAuthn()) {
      toast.error("This browser doesn't support passkeys");
      return;
    }
    setBusy(true);
    try {
      // Same split as loginPasskey: deadline the fetches, leave the OS
      // enrollment prompt (`startRegistration`) untimed.
      const options = await fetch("/api/auth/webauthn/register", {
        signal: AbortSignal.timeout(deadlineFor("/api/auth/webauthn/register")),
      }).then((r) => r.json());
      if (options.error) throw new Error(options.error);
      const attestation = await startRegistration({ optionsJSON: options });
      const res = await fetch("/api/auth/webauthn/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestation),
        signal: AbortSignal.timeout(deadlineFor("/api/auth/webauthn/register")),
      }).then((r) => r.json());
      if (res.ok) toast.success("🔑 Passkey enrolled — biometric login enabled!");
      else toast.error(res.error || "Enrollment failed");
    } catch (e: any) {
      const msg = failureMessage(e, "Enrollment failed");
      if (msg) toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const doEnablePush = async () => {
    // Multi-step async flow (permission → SW register → key fetch →
    // subscribe → POST). Guard on `busy` like enrollPasskey so a second tap
    // can't fire a concurrent subscribe; a loading toast gives feedback even
    // after the menu closes on outside-click.
    if (busy) return;
    setBusy(true);
    const t = toast.loading("Enabling notifications…");
    try {
      const r = await enablePush();
      if (r.ok) toast.success("🔔 Notifications enabled — background jobs will ping you", { id: t });
      else toast.error(r.reason || "Push failed", { id: t });
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    // This `await` had no deadline AND no catch: a hung /api/logout meant every
    // line below it never ran, so the menu stayed open showing the avatar of a
    // user who had just asked to sign out — the one state where looking signed
    // in is actively misleading. The local sign-out proceeds either way (the
    // cookie is HttpOnly, so the server call is what actually clears it, but a
    // UI that keeps claiming a session it can't confirm is worse than one that
    // re-probes on next load).
    try {
      await fetch("/api/logout", {
        method: "POST",
        signal: AbortSignal.timeout(deadlineFor("/api/logout")),
      });
    } catch {
      toast.error("Couldn't reach the server — signing out on this device only");
    }
    setMe({ authenticated: false });
    setOpen(false);
    // Sign-out is client-side too, and it dispatched NOTHING (v6 E1): the
    // shared whoami cache kept answering "authenticated" to every consumer,
    // and on a private tiny the revealed systemPrompt stayed on screen for
    // someone who had just signed out. Same event login uses, now carrying
    // the direction so the lock knows to close rather than re-probe.
    window.dispatchEvent(authEvent("signed-out"));
    toast("Signed out");
  };

  const btnStyle = {
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(10px)",
    borderColor: "rgba(var(--tiny-accent-rgb),0.2)",
    color: "var(--tiny-accent)",
  } as const;

  if (!me) return null;

  if (!me.authenticated) {
    return (
      <div className="flex items-center gap-2">
        {/* Passkey (biometric) login — busy shows a spinner while the OS
            biometric sheet round-trips (was disabled with no indication) */}
        <button
          onClick={loginPasskey}
          disabled={busy}
          className="w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-105 border disabled:opacity-60 disabled:hover:scale-100"
          style={btnStyle}
          aria-label={busy ? "Signing in…" : "Sign in with passkey"}
          title="Sign in with passkey (Touch ID / Face ID)"
        >
          {busy ? (
            <span
              role="status"
              aria-hidden="true"
              className="inline-block w-4 h-4 rounded-full animate-spin"
              style={{ border: "2px solid rgba(var(--tiny-accent-rgb),0.3)", borderTopColor: "var(--tiny-accent)" }}
            />
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004.5 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
            </svg>
          )}
        </button>
        {/* GitHub login */}
        <button
          onClick={loginGitHub}
          className="px-4 h-10 rounded-full flex items-center gap-2 transition-all hover:scale-105 border text-sm font-semibold"
          style={btnStyle}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="relative flex items-center gap-2">
      {/* ⚙️ Settings (model + your AI) — one gear, one modal */}
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-105 border"
          style={btnStyle}
          aria-label="Settings"
          title="Settings (⌘,)"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      )}

      <button
        ref={avatarRef}
        onClick={() => (open ? requestClose() : setOpen(true))}
        className="w-10 h-10 rounded-full overflow-hidden border transition-all hover:scale-105"
        style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.4)" }}
        aria-label="Account menu"
        aria-expanded={open}
      >
        {me.user?.avatar ? (
           
          <img src={me.user.avatar} alt={me.user.login} className="w-full h-full object-cover" />
        ) : (
          <span style={{ color: "var(--tiny-accent)" }}>{(me.user?.login || "?")[0].toUpperCase()}</span>
        )}
      </button>

      {open && (
        <div
          // Disclosure popover, NOT an ARIA menu: the body is a profile header,
          // a scrollable link list, and mixed <a>/<button> actions the user TABS
          // through. role="menu" would oblige AT into arrow-key menuitem
          // navigation that doesn't exist here (no menuitem children, no roving
          // tabindex) — a screen-reader user would hear "menu", press arrows, and
          // find nothing navigable. role="group" + a name is the honest shape;
          // the trigger keeps aria-expanded (the disclosure signal) but drops
          // aria-haspopup="menu". Dismissal = Escape + outside-click (above).
          role="group"
          aria-label="Account menu"
          className={`absolute right-0 top-full mt-2 w-64 rounded-xl border overflow-hidden z-[120] ${exitClass}`}
          onAnimationEnd={onAnimationEnd}
          style={{
            background: "rgba(10,10,10,0.97)",
            borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
            boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.1)",
          }}
        >
          <div className="px-4 py-3 border-b" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
            <div className="text-sm font-semibold" style={{ color: "var(--tiny-accent)" }}>
              @{me.user?.login}
            </div>
            <div className="text-xs opacity-50 text-white">{me.user?.name}</div>
          </div>

          {/* Zero tinys: signed in but nothing created — the menu is the
              natural "what now?" moment; nudge toward the create flow */}
          {me.tinys && me.tinys.length === 0 && (
            <a
              // send=0: PRE-FILL the composer (they must finish the name) —
              // without it ?q= auto-sends the incomplete sentence
              href="/?q=I%20want%20to%20create%20an%20AI%20named%20&send=0"
              className="block px-4 py-2.5 text-sm border-b hover:bg-white/5 transition-colors no-underline"
              style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
            >
              <span className="inline-flex items-center gap-2"><IconSparkles className="w-4 h-4" /> Create your first tiny →</span>
            </a>
          )}
          {me.tinys && me.tinys.length > 0 && (
            <div className="px-4 py-2 border-b max-h-48 overflow-y-auto" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
              <div className="text-[10px] uppercase tracking-wider opacity-40 text-white mb-1">
                My tinys ({me.tinys.length})
              </div>
              {me.tinys.map((t) => (
                <a
                  key={t.name}
                  href={`/${t.name}`}
                  className="block py-1 text-sm hover:opacity-80"
                  style={{ color: "var(--tiny-accent)" }}
                >
                  /{t.name}
                </a>
              ))}
            </div>
          )}

          {/* 🧬 Memory — account-level (follows the user across tinys), so it
              lives with the account, not buried behind the /memory command */}
          {onOpenMemory && (
            <button
              onClick={() => { setOpen(false); onOpenMemory(); }}
              className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors border-b"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
            >
              <span className="inline-flex items-center gap-2"><IconBrain className="w-4 h-4 opacity-70" /> Memory — what tiny knows about you</span>
            </button>
          )}

          {/* ⏰ Jobs — account-level like Memory (jobs belong to the user,
              not the tiny), so the entry lives in the same menu */}
          {onOpenJobs && (
            <button
              onClick={() => { setOpen(false); onOpenJobs(); }}
              className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors border-b"
              style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
            >
              <span className="inline-flex items-center gap-2"><IconClock className="w-4 h-4 opacity-70" /> Jobs — your scheduled background tasks</span>
            </button>
          )}

          {/* 📟 Devices — account-level like Memory/Jobs: the machines
              (daemons/CLIs/browsers) enrolled to this identity live with
              the account menu, not behind a typed URL */}
          <a
            href="/devices"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors border-b no-underline"
            style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
          >
            <span className="inline-flex items-center gap-2"><IconDevice className="w-4 h-4 opacity-70" /> Devices — your enrolled machines</span>
          </a>

          {/* 💰 Wallet — balance, earnings, priced invocations */}
          <a
            href="/wallet"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors border-b no-underline"
            style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
          >
            <span className="inline-flex items-center gap-2"><IconWallet className="w-4 h-4 opacity-70" /> Wallet — balance and earnings</span>
          </a>

          {/* Conversation actions — only when there's something to act on */}
          {hasMessages && (onShare || onClear) && (
            <div className="border-b" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}>
              {onShare && (
                <button
                  onClick={() => { setOpen(false); onShare(); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
                >
                  <span className="inline-flex items-center gap-2"><IconShare className="w-4 h-4 opacity-70" /> Share conversation</span>
                </button>
              )}
              {onClear && (
                <button
                  onClick={() => { setOpen(false); onClear(); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
                >
                  <span className="inline-flex items-center gap-2"><IconTrash className="w-4 h-4 opacity-70" /> Clear history</span>
                </button>
              )}
            </div>
          )}

          <button
            onClick={enrollPasskey}
            disabled={busy}
            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2"><IconKey className="w-4 h-4 opacity-70" /> Add a passkey (biometric)</span>
          </button>
          <button
            onClick={doEnablePush}
            disabled={busy}
            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-2"><IconBell className="w-4 h-4 opacity-70" /> Enable notifications</span>
          </button>
          <button
            onClick={logout}
            className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-white/5 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
