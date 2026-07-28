"use client";

/**
 * 💳 WalletSheet — in-chat top-up overlay (payments integration).
 *
 * The /wallet page is the full ledger + withdraw surface; this is its
 * compact sibling that lives INSIDE the chat so a paywall doesn't punt the
 * user out to a standalone island. It carries just the fund-your-wallet
 * path: current balance, link a sending address, claim a USDC deposit by tx
 * hash. Everything else (history, withdraw, onramps) stays on /wallet, which
 * this links to for the full picture.
 *
 * Overlay grammar matches ModelSettings/ConfirmDialog: portal, backdrop +
 * blur, Escape/backdrop close, focus trapped inside and returned to the
 * opener, riseOut exit choreography. Same API shapes as app/wallet/page.tsx
 * (POST /api/wallet {action}) so the two never drift.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { walletAction, faucetClaim, getWallet, type DepositInfoResponse } from "../../lib/x402/wallet-client";
import { usd } from "../../lib/utils";
import {
  asNetwork,
  ceilingNote,
  faucetCta,
  networkChoices,
  networkLabel,
  networkShort,
  topUpRoute,
  type FaucetInfo,
  type PayNetwork,
} from "../../lib/x402/top-up";
import { useFaucetCountdown } from "../../lib/x402/use-faucet-countdown";

// Both the response TYPE and the money formatter come from shared modules —
// this file used to carry byte-identical local copies of each, "kept in sync
// by comment" with app/wallet/page.tsx (the drift class item 13 closes).
type DepositInfo = DepositInfoResponse;

export default function WalletSheet({
  onClose,
  onFunded,
}: {
  onClose: () => void;
  /** Fired after a successful claim so the opener (e.g. the paywall card)
   *  can refresh balance / re-enable send. Receives the new balance_micro. */
  onFunded?: (balanceMicro: number) => void;
}) {
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** False once the sheet unmounts — async loaders check it before setState. */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [balance, setBalance] = useState(0);
  const [depositInfo, setDepositInfo] = useState<DepositInfo | null>(null);
  const [linkAddr, setLinkAddr] = useState("");
  const [claimTx, setClaimTx] = useState("");
  const [claimNetwork, setClaimNetwork] = useState<PayNetwork>("base");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // 💧 Same clock the /wallet page uses: `next_drip_in_seconds` is a server
  // delta frozen at fetch, and this sheet loads once with no poll — so without
  // it, a sheet opened before UTC midnight keeps the Claim button disabled after
  // the drip becomes claimable. See lib/x402/faucet-countdown.ts.
  const { remainingSeconds: dripLeft } = useFaucetCountdown(depositInfo?.faucet?.next_drip_in_seconds);

  const load = useCallback(async () => {
    // Classification lives in wallet-client's parseWalletSnapshot. 401
    // in-chat maps to "unavailable" copy — don't full-reload to the OAuth
    // dance (it'd nuke the conversation); the paywall card already handles
    // the signed-out case with its own copy.
    const snap = await getWallet();
    if (snap.status === "ok") {
      setBalance(snap.balanceMicro);
      setStatus("ready");
    } else setStatus("unavailable");
  }, []);

  // Try twice on a network/parse blip (but stop on a clean {ok:false} — that's
  // the honest "not configured" answer, not a transient failure). Without the
  // retry a single dropped POST left depositInfo null while status is "ready",
  // stranding the sheet with only the balance card + footer link — no
  // link/claim UI and no explanation of why. Mirrors the main page's
  // loadDepositInfo retry-twice (app/wallet/page.tsx:137-164).
  //
  // Also called again after a faucet claim: it carries the drip/ceiling figures,
  // so without a re-read the button would still offer credit it just spent.
  const loadDepositInfo = useCallback(async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const d = await walletAction({ action: "deposit_info" });
        // The sheet is a dismissable dialog: an in-flight response can land after
        // the user closes it, so don't write state into an unmounted component
        // (the `cancelled` flag this loader was hoisted out of).
        if (!mountedRef.current || d.ok === false) return;
        setDepositInfo(d);
        // Seed the claim-network selector to the deployment's default. On a
        // testnet (PAYMENTS_TESTNET) deployment the pickers otherwise default
        // to mainnet "base", so a user pasting a Sepolia tx hash hits the
        // permanent 400 "no matching USDC transfer on base". The main page +
        // iOS both seed this on deposit_info load (app/wallet/page.tsx:154,
        // Wallet.swift:684). Follow whatever the default IS rather than naming
        // one network — the same mismatch bites a self-hosted `tiny` chain.
        setClaimNetwork(asNetwork(d.default_network));
        return;
      } catch {
        // fall through to a single retry; a persistent failure leaves
        // depositInfo null → the card shows its own "not configured" state.
      }
    }
  }, []);

  useEffect(() => {
    load();
    loadDepositInfo();
  }, [load, loadDepositInfo]);

  // Escape closes (mirrors ModelSettings). stopPropagation so a chat-level
  // Escape handler underneath doesn't also fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); requestClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Move focus into the sheet on open, return it to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { try { opener?.focus(); } catch { } };
  }, []);
  useFocusTrap(dialogRef, true);

  const linkAddress = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const d = await walletAction({ action: "link_address", address: linkAddr.trim() });
      if (d.ok) {
        setDepositInfo(prev => prev ? { ...prev, linked_address: d.address } : prev);
        setMsg("✓ Address linked — send USDC on Base, then claim with the tx hash below.");
        setLinkAddr("");
      } else setMsg(`⚠️ ${d.error || "link failed"}`);
    } catch { setMsg("⚠️ link failed"); }
    finally { setBusy(false); }
  };

  // 💧 One-tap credit from the in-house faucet. This matters most HERE: the
  // sheet is what a 402 paywall opens, and asking a blocked user to acquire
  // USDC and paste a tx hash — on a chain where no exchange sells the token —
  // was an unfinishable errand at the moment they wanted to send a message.
  const claimFaucet = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const d = await faucetClaim();
      if (d.ok) {
        setMsg(`✓ Credited ${usd(Number(d.credited_micro || 0))} trial credit — spendable on any tiny, not withdrawable as real USDC.`);
        // Tell the opener immediately: the whole point is that the blocked send
        // becomes possible without leaving the conversation. Only an OK
        // snapshot writes — a blipped re-read must not zero a just-credited
        // balance (the old raw read did exactly that on a non-ok body).
        const fresh = await getWallet();
        if (fresh.status === "ok") {
          setBalance(fresh.balanceMicro);
          onFunded?.(fresh.balanceMicro);
        }
      } else {
        // The worker's own words: 429 already-claimed and 400 ceiling-reached are
        // different instructions ("come back tomorrow" vs "get followed"), and
        // rewording them here would flatten them into one.
        setMsg(`⚠️ ${d.error || "faucet unavailable"}`);
      }
      // Either way, re-read the drip/ceiling figures so the button lands in the
      // state that matches what just happened.
      loadDepositInfo();
    } catch { setMsg("⚠️ couldn't reach the faucet"); }
    finally { setBusy(false); }
  };

  const claimDeposit = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const d = await walletAction({ action: "claim", txHash: claimTx.trim(), network: claimNetwork });
      if (d.ok) {
        // Format through usd() (2–6dp, en-US) — the SAME money formatter the
        // balance card uses — not a hand-rolled toFixed(2) that reported
        // "$10.12" for a 10_123_456-micro deposit while the balance rendered
        // the true "$10.123456" (two numbers for one event on a money screen).
        // And surface the testnet-trial cap: a base-sepolia claim credits capped
        // TRIAL balance that isn't withdrawable as real USDC — without this the
        // user thinks they hold real funds (worker deposits.ts:242, mirrored on
        // /wallet page.tsx:227 + iOS Wallet.swift:758).
        setMsg(
          d.already_credited
            ? "Already credited — this tx was claimed before."
            : `✓ Credited ${usd(Number(d.credited_micro || 0))}` +
              // Quote the cap the SERVER enforced (trial_cap_micro) — reputation
              // widens it on the self-hosted chain, so a hardcoded "$1" understates
              // it for anyone with reputation.
              (d.testnet_trial === true
                ? ` (trial credit${Number.isFinite(Number(d.trial_cap_micro)) && Number(d.trial_cap_micro) > 0 ? ` — ${usd(Number(d.trial_cap_micro))} lifetime cap` : ""}, not withdrawable as real USDC)`
                : "")
        );
        setClaimTx("");
        // Re-read the balance and notify the opener so a blocked send can
        // retry. OK snapshots only — same zero-guard as the faucet path.
        const fresh = await getWallet();
        if (fresh.status === "ok") {
          setBalance(fresh.balanceMicro);
          onFunded?.(fresh.balanceMicro);
        }
      } else setMsg(`⚠️ ${d.error || "claim failed"}${d.retry ? " — try again in a minute" : ""}`);
    } catch { setMsg("⚠️ claim failed"); }
    finally { setBusy(false); }
  };

  const accent = "var(--tiny-accent, #00FF88)";
  const linked = depositInfo?.linked_address;
  const addrOk = /^0x[0-9a-fA-F]{40}$/.test(linkAddr.trim());
  const txOk = /^0x[0-9a-fA-F]{64}$/.test(claimTx.trim());

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add funds to your wallet"
        tabIndex={-1}
        className={`w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border p-5 outline-none ${exitClass}`}
        style={{ background: "rgba(10,10,10,0.98)", borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.3)" }}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={onAnimationEnd}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <span aria-hidden="true">💳</span> Add funds
          </h2>
          <button
            onClick={requestClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Balance */}
        <div className="rounded-xl border p-4 mb-4" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)", background: "rgba(0,0,0,0.4)" }}>
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Balance</div>
          {status === "loading"
            ? <div className="h-7 w-28 rounded animate-pulse" style={{ background: "rgba(var(--tiny-accent-rgb, 0,255,136),0.15)" }} />
            : <div className="text-2xl font-bold" style={{ color: accent }}>{usd(balance)}</div>}
        </div>

        {status === "unavailable" && (
          <p className="text-sm text-gray-400">
            Wallet service is unreachable, or you&apos;re signed out. Open the{" "}
            <Link href="/wallet" className="font-semibold hover:underline" style={{ color: accent }}>full wallet</Link>{" "}
            to sign in and try again.
          </p>
        )}

        {/* Suppressed when the faucet is up: "deposits aren't configured" reads as
            "you can't add funds" while a working top-up button sits above it. */}
        {status === "ready" && depositInfo && !depositInfo.configured && topUpRoute(depositInfo) !== "faucet" && (
          <p className="text-sm text-gray-400">
            On-chain deposits aren&apos;t configured on this deployment yet. See the{" "}
            <Link href="/wallet" className="font-semibold hover:underline" style={{ color: accent }}>full wallet</Link>.
          </p>
        )}

        {/* 💧 In-house faucet — FIRST, and shown even when on-chain deposits
            aren't configured (it needs no deposit address). On a chain we host
            this is the whole funding story: one tap, no wallet, no tx hash. The
            three-step link→send→claim flow below stays for real-USDC deposits.
            Gated on the server's faucet.available via topUpRoute(), not on the
            network name — a half-configured tiny chain has no faucet, and a
            button that 424s is worse than no button. */}
        {status === "ready" && topUpRoute(depositInfo) === "faucet" && (() => {
          const cta = faucetCta(depositInfo?.faucet, { remainingSeconds: dripLeft });
          return (
            <div className="rounded-xl border p-4 mb-4 space-y-2" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)" }}>
              <div className="text-xs font-medium text-gray-300">Free daily top-up</div>
              <button
                onClick={claimFaucet}
                disabled={busy || !cta.enabled}
                className="w-full px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-transform hover:scale-105 active:scale-100"
                style={{ background: accent, color: "#000" }}
              >
                {busy ? "Claiming…" : cta.label}
              </button>
              {cta.reason && <p className="text-[11px] text-gray-400">{cta.reason}</p>}
              <p className="text-[11px] text-gray-600">{ceilingNote(depositInfo?.faucet)}</p>
            </div>
          );
        })()}

        {status === "ready" && depositInfo?.configured && (
          <div className="space-y-4">
            {/* Step 1 — link sending address */}
            {!linked ? (
              <div>
                <label htmlFor="wallet-link-addr" className="block text-xs font-medium text-gray-300 mb-1.5">
                  1. Link the address you&apos;ll send USDC from
                </label>
                <div className="flex gap-2">
                  <input
                    id="wallet-link-addr"
                    value={linkAddr}
                    onChange={(e) => setLinkAddr(e.target.value)}
                    placeholder="0x…"
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="flex-1 min-w-0 rounded-lg border bg-black/40 px-3 py-2 text-sm font-mono outline-none focus:border-[var(--tiny-accent)]"
                    style={{ borderColor: "rgba(255,255,255,0.15)" }}
                  />
                  <button
                    onClick={linkAddress}
                    disabled={busy || !addrOk}
                    className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-transform hover:scale-105 active:scale-100"
                    style={{ background: accent, color: "#000" }}
                  >
                    Link
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-400">
                Linked: <span className="font-mono text-gray-300">{linked.slice(0, 6)}…{linked.slice(-4)}</span>
              </div>
            )}

            {/* Deposit address + claim */}
            {depositInfo.deposit_address && (
              <div>
                <label className="block text-xs font-medium text-gray-300 mb-1.5">
                  2. Send USDC on {networkShort(asNetwork(depositInfo.default_network))} to
                </label>
                <button
                  onClick={async () => {
                    // writeText returns a promise that REJECTS on a blocked
                    // permission — the old sync try/catch couldn't see that and
                    // painted "✓ copied" on a failed copy. await it, and only
                    // claim success if it resolved (else a truthful ⚠️).
                    try { await navigator.clipboard?.writeText(depositInfo.deposit_address!); setMsg("✓ Deposit address copied"); }
                    catch { setMsg("⚠️ Couldn't copy — select the address and copy manually."); }
                  }}
                  className="w-full text-left rounded-lg border bg-black/40 px-3 py-2 text-xs font-mono break-all hover:border-[var(--tiny-accent)] transition-colors"
                  style={{ borderColor: "rgba(255,255,255,0.15)" }}
                  title="Tap to copy"
                >
                  {depositInfo.deposit_address} <span className="text-gray-500">⧉</span>
                </button>
              </div>
            )}

            <div>
              <label htmlFor="wallet-claim-tx" className="block text-xs font-medium text-gray-300 mb-1.5">
                3. Claim it — paste the transaction hash
              </label>
              <input
                id="wallet-claim-tx"
                value={claimTx}
                onChange={(e) => setClaimTx(e.target.value)}
                placeholder="0x… (tx hash)"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm font-mono outline-none focus:border-[var(--tiny-accent)] mb-2"
                style={{ borderColor: "rgba(255,255,255,0.15)" }}
              />
              <div className="flex items-center gap-2">
                {/* The deployment's own networks (its chain + real Base), never a
                    hardcoded pair: `tiny` was unselectable, and offering the OTHER
                    trial chain only invites a hash its scanner can't see. */}
                <select
                  value={claimNetwork}
                  onChange={(e) => setClaimNetwork(asNetwork(e.target.value))}
                  className="rounded-lg border bg-black/40 px-2 py-2 text-xs outline-none"
                  style={{ borderColor: "rgba(255,255,255,0.15)" }}
                  aria-label="Network"
                >
                  {networkChoices(depositInfo.default_network).map(n => (
                    <option key={n} value={n}>{networkLabel(n)}</option>
                  ))}
                </select>
                <button
                  onClick={claimDeposit}
                  disabled={busy || !txOk}
                  className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-transform hover:scale-105 active:scale-100"
                  style={{ background: accent, color: "#000" }}
                >
                  {busy ? "Claiming…" : "Claim deposit"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* role=status + aria-live so a screen reader announces the outcome of
            the most money-critical in-chat action ("✓ Credited $X", "⚠️ claim
            failed", "✓ Address linked") — a plain text swap is silent otherwise.
            Matches the main page's depositMsg/withdrawMsg live regions
            (app/wallet/page.tsx:647,690) + iOS announceOutcome. */}
        {msg && <p role="status" aria-live="polite" className="mt-3 text-xs" style={{ color: msg.startsWith("⚠️") ? "var(--tiny-danger)" : accent }}>{msg}</p>}

        <div className="mt-4 pt-3 border-t text-center" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          <Link
            href="/wallet"
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            History, withdrawals & onramps → full wallet
          </Link>
        </div>
      </div>
    </div>,
    document.body
  );
}
