"use client";

/**
 * Telegram connection panel (Settings → Connect tab).
 *
 * Mirrors the agent's `telegram` tool but as a form: paste a BotFather
 * token, pick which tiny answers, manage the allowed-chat allowlist.
 * While the allowlist is empty the bot is in PAIRING mode — it replies to
 * any Telegram message with that chat's id so the owner can authorize it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { reportAuthFailure } from "../../lib/chat/whoami";

type BotConfig = {
  tiny: string;
  allowedChats: string;
  enabled: boolean;
  token: string; // masked (…abc123)
};

export default function TelegramSettings({ tinyName }: { tinyName?: string }) {
  const [loading, setLoading] = useState(true);
  const [loggedOut, setLoggedOut] = useState(false);
  // A failed config load left `bot` null → the render showed the new-connection
  // onboarding form ("/newbot…"), so a user who ALREADY has a bot was told to
  // set one up (and might re-paste their token). The transient toast was the
  // only signal. Track the failure so we can show a retryable error instead of
  // the misleading empty/onboarding state.
  const [loadError, setLoadError] = useState(false);
  const [bot, setBot] = useState<BotConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  // Form state (new connection or edits)
  const [token, setToken] = useState("");
  const [tiny, setTiny] = useState(tinyName || "");
  const [allowedChats, setAllowedChats] = useState("");

  const refresh = () => {
    setLoading(true);
    setLoadError(false);
    // Deadline the read: without it a hung worker leaves the fetch pending
    // forever — .finally never runs, so `loading` never clears and the panel
    // spins on "Loading…" with no path to the .catch. 10s → AbortError →
    // catch. Same convention as the SSR /get + UniverseDrawer fetches.
    fetch("/api/telegram", { signal: AbortSignal.timeout(10_000) })
      .then((r) => {
        // Report the expiry too (v6 E2) — this panel knowing it's signed out
        // while the rest of the page doesn't is the half-signed-in state.
        if (r.status === 401) { setLoggedOut(true); reportAuthFailure(r.status); return { bot: null }; }
        // Any other non-ok is the worker failing, not "no bot connected". The
        // proxy answers an outage with a PARSEABLE 503 {bot:null,error} body,
        // so without this throw r.json() succeeds → bot=null → the panel shows
        // the "set up a bot" form to an ALREADY-connected user on a transient
        // blip. Throw so the .catch → loadError retry fires (as the proxy's own
        // comment already assumes it does).
        if (!r.ok) throw new Error(`telegram ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setBot(d.bot || null);
        if (d.bot) {
          setTiny(d.bot.tiny || "");
          setAllowedChats(d.bot.allowedChats || "");
        }
      })
      // Flag the failure so we render a retry instead of the new-connection
      // form (which would tell an already-connected user to set up a bot).
      .catch(() => { setLoadError(true); toast.error("Couldn't load the Telegram config — try again"); })
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const save = async () => {
    if (!bot && !token.trim()) { toast.error("Paste your BotFather token first"); return; }
    if (!tiny.trim()) { toast.error("Which tiny should answer?"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token.trim() ? { token: token.trim() } : {}),
          tiny: tiny.trim(),
          allowedChats,
          enabled: true,
        }),
        // Deadline the write: without it a hung worker never rejects, so the
        // finally never runs and `busy` stays true — every button stays
        // disabled and the panel bricks with no recovery. 10s → catch → toast.
        signal: AbortSignal.timeout(10_000),
      });
      const d = await res.json();
      if (d.ok) {
        setToken("");
        toast.success(d.pairing
          ? "🤖 Bot connected in pairing mode — message it on Telegram to get your chat id"
          : "🤖 Telegram bot updated");
        refresh();
      } else {
        toast.error(d.error || "Couldn't save — try again");
      }
    } catch {
      toast.error("Couldn't save — try again");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (!bot) return;
    setBusy(true);
    try {
      const d = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !bot.enabled }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      if (d.ok) { toast(bot.enabled ? "⏸ Bot paused" : "▶️ Bot resumed"); refresh(); }
      else toast.error(d.error || "Couldn't update the bot — try again");
    } catch {
      // No catch meant a network/non-JSON failure threw silently — Pause/Resume
      // looked like a dead no-op. Surface it like save() does.
      toast.error("Network error — try again.");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!(await confirm({
      title: "Disconnect Telegram bot?",
      message: "The token is removed and conversations on Telegram stop.",
      confirmLabel: "Disconnect",
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const d = await fetch("/api/telegram", { method: "DELETE", signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
      if (d.ok) { setBot(null); setToken(""); setAllowedChats(""); toast("🔌 Telegram disconnected"); }
      else toast.error(d.error || "Couldn't disconnect — try again");
    } catch {
      toast.error("Network error — try again.");
    } finally { setBusy(false); }
  };

  const inputStyle = {
    background: "rgba(0,0,0,0.5)",
    border: "1px solid rgba(var(--tiny-accent-rgb),0.2)",
    color: "white",
  };

  if (loggedOut) {
    return (
      <p className="text-sm opacity-60">
        Sign in with GitHub to connect a Telegram bot — the connection attaches to your account.
      </p>
    );
  }
  if (loading) return <p role="status" className="text-sm opacity-60">Loading…</p>;
  // Load failed and we have nothing cached to show — a retryable error, NOT the
  // new-connection form (which would imply an existing bot vanished). Once a
  // config has loaded, a later poll blip keeps the last-good render instead.
  if (loadError && !bot) {
    return (
      <div role="alert" className="text-sm text-gray-400 space-y-3">
        <p>Couldn&apos;t load your Telegram settings.</p>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
          style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  const pairing = !!bot && !bot.allowedChats;

  return (
    <div className="space-y-4">
      {bot ? (
        <div
          className="rounded-lg p-3 text-sm space-y-1"
          style={{ background: "rgba(var(--tiny-accent-rgb),0.08)", border: "1px solid rgba(var(--tiny-accent-rgb),0.2)" }}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold" style={{ color: "var(--tiny-accent)" }}>
              {bot.enabled ? "🟢 Connected" : "⏸ Paused"}
            </span>
            <span className="opacity-50 text-xs">token {bot.token}</span>
          </div>
          {/* break-words: an all-one-word tiny slug (no hyphen soft-wrap
              opportunity) would otherwise overflow this status card. */}
          <div className="opacity-70 break-words">Answering as <b>/{bot.tiny}</b></div>
          {pairing && (
            <div className="text-xs mt-1 p-2 rounded" style={{ background: "rgba(255,200,0,0.1)", color: "rgb(255,220,120)" }}>
              ⚠️ Pairing mode — no chats authorized yet. Send your bot any message on
              Telegram; it replies with the chat id. Paste that id below and save.
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm opacity-70 space-y-2">
          <p>Put your tiny on Telegram: it answers messages as a real bot.</p>
          <ol className="list-decimal list-inside space-y-1 text-xs opacity-80">
            <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--tiny-accent)" }}>@BotFather</a> on Telegram → <code>/newbot</code></li>
            <li>Paste the token below and choose which tiny answers</li>
            <li>Message your bot — it replies with your chat id (pairing)</li>
            <li>Add that chat id here and save</li>
          </ol>
        </div>
      )}

      <div>
        <label htmlFor="tg-token" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
          Bot token {bot && <span className="normal-case opacity-60">(leave empty to keep current)</span>}
        </label>
        <input
          id="tg-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
          placeholder="123456789:AA…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="tg-tiny" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">Answering tiny</label>
        <input
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
          id="tg-tiny"
          placeholder={tinyName || "your-tiny"}
          value={tiny}
          onChange={(e) => setTiny(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="tg-chats" className="block text-xs uppercase tracking-wider mb-1.5 opacity-60">
          Allowed chat ids <span className="normal-case opacity-60">(comma-separated; empty = pairing mode)</span>
        </label>
        <input
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
          id="tg-chats"
          placeholder="123456789, -100987654321"
          value={allowedChats}
          onChange={(e) => setAllowedChats(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-100 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-wait"
          style={{ background: "rgba(var(--tiny-accent-rgb),0.15)", color: "var(--tiny-accent)", border: "1px solid rgba(var(--tiny-accent-rgb),0.4)" }}
        >
          {busy ? "Working…" : bot ? "Save changes" : "Connect bot"}
        </button>
        {bot && (
          <>
            <button
              onClick={toggle}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm transition-all disabled:opacity-50 hover:text-white hover:bg-white/5"
              style={{ background: "transparent", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              {bot.enabled ? "Pause" : "Resume"}
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm transition-all disabled:opacity-50 hover:bg-[rgba(var(--tiny-danger-rgb),0.12)]"
              style={{ background: "transparent", color: "var(--tiny-danger)", border: "1px solid rgba(var(--tiny-danger-rgb),0.3)" }}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      <p className="text-[11px] opacity-40">
        The worker polls your bot every minute; messages run through your tiny and replies
        go back to Telegram. Only allowlisted chats are answered.
      </p>
      {dialog}
    </div>
  );
}
