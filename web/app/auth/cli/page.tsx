"use client";

/**
 * /auth/cli — consent page for the npx tiny-tech CLI login flow.
 *
 * Opened by the CLI as /auth/cli?port=<loopback>&state=<nonce>. Logged-out
 * visitors bounce through GitHub OAuth and land back here. Approve mints a
 * one-time code (POST /api/auth/cli) and redirects to 127.0.0.1:<port> where
 * the CLI is listening. The explicit click is the consent — a drive-by
 * open() of this URL can't exfiltrate a token on its own.
 */

import { useEffect, useState } from "react";
import { EXTERNAL_MS, deadlineFor } from "@/lib/deadlines";

export default function CliAuthPage() {
  const [me, setMe] = useState<any>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "approving" | "granted" | "done" | "denied" | "error">("loading");
  const [error, setError] = useState("");
  const [params, setParams] = useState<{ port: string; state: string; scheme: string }>({ port: "", state: "", scheme: "" });
  // On approve we surface the one-time code (parsed from the loopback
  // redirect) so a REMOTE/SSH login can finish by pasting it into the
  // terminal — the browser is on a different machine than the CLI, so the
  // 127.0.0.1 redirect dead-ends there. Local logins still auto-complete
  // (the loopback fires in the background). See tiny-tech/src/auth.ts.
  const [grant, setGrant] = useState<{ code: string; redirect: string }>({ code: "", redirect: "" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const port = sp.get("port") || "";
    const state = sp.get("state") || "";
    const scheme = sp.get("scheme") || "";
    setParams({ port, state, scheme });

    if ((!port && scheme !== "tinyapp") || !state) {
      setError("Missing port/state — start this flow from the CLI: npx tiny-tech login");
      setStatus("error");
      return;
    }

    // Deadlined: `status` starts "loading" and this is the ONLY thing that
    // moves it, so a hung probe leaves "Checking your session…" on screen
    // permanently — no Approve button, no error, and the CLI waiting in the
    // terminal just times out with no idea why. Worse than a plain dead page,
    // because the user's next move is to re-run the login and meet it again.
    fetch("/api/me", { signal: AbortSignal.timeout(deadlineFor("/api/me")) })
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) {
          setMe(d.user);
          setStatus("ready");
        } else {
          // Round-trip through GitHub OAuth, then back here. `scheme` MUST ride
          // along: the iOS deep-link flow arrives with scheme=tinyapp and NO
          // port, so dropping it here means the post-OAuth return lands with
          // neither port nor scheme → the guard above trips "Missing port/state"
          // and the app login dead-ends for every logged-out user.
          const back = new URLSearchParams({ port, state });
          if (scheme) back.set("scheme", scheme);
          const returnTo = `/auth/cli?${back.toString()}`;
          window.location.href = `/api/auth?return_to=${encodeURIComponent(returnTo)}`;
        }
      })
      .catch(() => {
        setError("Couldn't check login state — refresh to retry");
        setStatus("error");
      });
  }, []);

  const approve = async () => {
    setStatus("approving");
    try {
      // Deadlined: `status` is already "approving" here, which disables BOTH
      // buttons — so a hung mint leaves the consent page frozen on
      // "Authorizing…" with Deny disabled too. There is no way out but a
      // reload, and a reload loses the CLI's port/state unless the user
      // re-runs the command.
      const res = await fetch("/api/auth/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: Number(params.port), state: params.state, ...(params.scheme === "tinyapp" ? { scheme: "tinyapp" } : {}) }),
        signal: AbortSignal.timeout(deadlineFor("/api/auth/cli")),
      });
      const data = await res.json();
      if (!data.ok || !data.redirect) {
        setError(data.error || "Authorization failed");
        setStatus("error");
        return;
      }
      // Deep-link scheme (iOS app) MUST navigate to fire the handler.
      if (params.scheme === "tinyapp") {
        window.location.href = data.redirect;
        setStatus("done");
        return;
      }
      // Loopback flow: pull the one-time code out of the redirect so we can
      // both (a) fire the local callback in the background — the common case,
      // CLI on this same machine — and (b) show the code for a remote/SSH
      // login to paste into its terminal. The code is safe to display: it's
      // single-use, 5-min-lived, and useless without the matching state the
      // CLI holds.
      let code = "";
      try { code = new URL(data.redirect).searchParams.get("code") || ""; } catch {}
      setGrant({ code, redirect: data.redirect });
      setStatus("granted");
      // Best-effort auto-finish for a LOCAL login: fire the loopback callback
      // in the background. no-cors keeps a cross-origin/mixed-content block
      // from throwing; if the CLI is on this machine it receives the code and
      // resolves. When it's remote this simply fails silently and the user
      // uses the copyable code / "finish on this machine" link below instead.
      // Deadlined even though nothing awaits it: the common REMOTE case is a
      // loopback address that isn't listening on THIS machine, which doesn't
      // refuse — it hangs until the OS gives up. Nothing in the UI depends on
      // it (the code + link below are the real path), so the deadline just
      // stops an abandoned socket outliving the visit.
      if (code) fetch(data.redirect, { mode: "no-cors", signal: AbortSignal.timeout(EXTERNAL_MS) }).catch(() => {});
    } catch {
      setError("Authorization failed — is the CLI still running?");
      setStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-4">
      <div
        className="max-w-md w-full rounded-2xl border p-8 space-y-6"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(10px)", borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)" }}
      >
        <div className="text-2xl font-bold" style={{ color: "var(--tiny-accent, #00FF88)", textShadow: "0 0 10px rgba(var(--tiny-accent-rgb, 0,255,136),0.5)" }}>
          tiny
        </div>

        {/* Announcement grammar: progress/success = role=status (polite),
            failures = role=alert (interrupting) */}
        {status === "loading" && <p role="status" className="text-gray-400 text-sm">Checking your session…</p>}

        {status === "error" && (
          <div className="space-y-3">
            <p role="alert" className="text-red-400 text-sm">⚠️ {error}</p>
            <p className="text-gray-500 text-xs">You can close this tab and re-run the CLI.</p>
          </div>
        )}

        {status === "denied" && (
          <p role="status" className="text-gray-400 text-sm">Denied. You can close this tab — the CLI will time out.</p>
        )}

        {status === "done" && (
          <p role="status" className="text-gray-300 text-sm">✅ Authorized — you can close this tab and return to your terminal.</p>
        )}

        {status === "granted" && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-semibold" style={{ color: "var(--tiny-accent, #00FF88)" }}>✅ Approved</h1>
              <p className="text-sm text-gray-300 mt-1">
                On <span className="text-gray-100">this machine</span>? You&apos;re likely done — check your terminal.
              </p>
              <p className="text-sm text-gray-400 mt-2">
                Signed in on a <span className="text-gray-100">different machine</span> (SSH / remote)? Paste this code
                into the terminal where <span className="font-mono">tiny-tech</span> is waiting:
              </p>
            </div>

            <div className="flex items-stretch gap-2">
              <code
                className="flex-1 min-w-0 rounded-lg border px-3 py-2.5 text-xs font-mono text-gray-100 break-all"
                style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)" }}
              >
                {grant.code}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(grant.code).then(
                    () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
                    () => {},
                  );
                }}
                className="px-3 rounded-lg text-sm font-semibold whitespace-nowrap transition-all hover:scale-105 active:scale-100"
                style={{ background: "var(--tiny-accent, #00FF88)", color: "#000" }}
                aria-label="Copy code"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {/* Local convenience: navigating to the loopback hands the code to
                a CLI listening on THIS machine, no paste needed. Harmless (and
                simply unreachable) when the CLI is remote. */}
            {grant.redirect && (
              <a
                href={grant.redirect}
                className="block text-center text-xs text-gray-400 hover:text-white transition-colors underline"
              >
                Finish automatically on this machine →
              </a>
            )}

            <p className="text-[11px] text-gray-600">This code is single-use and expires in a few minutes.</p>
          </div>
        )}

        {(status === "ready" || status === "approving") && (
          <>
            <div className="space-y-2">
              <h1 className="text-lg font-semibold">Authorize tiny-tech CLI?</h1>
              <p className="text-sm text-gray-400">
                A command-line tool on <span className="text-gray-200">this machine</span> (port{" "}
                <span className="font-mono text-gray-200">{params.port}</span>) is asking for access to your tiny
                account:
              </p>
            </div>

            {me && (
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.15)" }}>
                {me.avatar && <img src={me.avatar} alt="" className="w-8 h-8 rounded-full" />}
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{me.name || me.login}</div>
                  <div className="text-xs text-gray-500 truncate">@{me.login}</div>
                </div>
              </div>
            )}

            <ul className="text-xs text-gray-400 space-y-1.5">
              <li>✓ Chat with your tinys (full agent + tools)</li>
              <li>✓ Read &amp; write your memories (learn / recall)</li>
              <li>✓ Create, run and manage your forged tools</li>
              <li>✓ Manage tinys, scheduled jobs and shares</li>
            </ul>

            <p className="text-[11px] text-gray-600">
              Grants a 90-day token stored at <span className="font-mono">~/.tiny/credentials.json</span>. Only approve
              if you just ran <span className="font-mono">npx tiny-tech</span> yourself.
            </p>

            <div className="flex gap-3">
              {/* #888 was borderline AA (pass-28 precedent) → gray-400;
                  both buttons answer hover now, Approve carries the
                  in-flight cursor while the CLI round-trip runs */}
              <button
                onClick={() => setStatus("denied")}
                disabled={status === "approving"}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm border text-gray-400 transition-colors hover:text-white hover:border-white/40 disabled:opacity-60"
                style={{ background: "rgba(0,0,0,0.5)", borderColor: "rgba(255,255,255,0.2)" }}
              >
                Deny
              </button>
              <button
                onClick={approve}
                disabled={status === "approving"}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100 disabled:opacity-60 disabled:hover:scale-100 disabled:cursor-wait"
                style={{ background: "var(--tiny-accent, #00FF88)", color: "#000", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb, 0,255,136),0.3)" }}
              >
                {status === "approving" ? "Authorizing…" : "Approve"}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
