"use client";

/**
 * /wallet — your tiny balance + ledger (payments PR1, docs/payments-x402-erc8004.md).
 *
 * Ledger-phase wallet: balance is SUM(ledger) in the worker's D1; deposits
 * (real USDC on Base) arrive in PR2 — until then the deposit card explains
 * what's coming. Session-gated end to end, /devices pattern.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../../components/chat/ConfirmDialog";
import { useRadioGroup } from "../../lib/chat/use-radio-group";
import { parseDecimalInput, usd } from "../../lib/utils";
import { relativeAgo } from "../../lib/relative-time";
import { relativeTickKey } from "../../lib/relative-tick";
import { useRelativeTick } from "../../lib/use-relative-tick";
import { explorerHref } from "../../lib/x402/explorer";
import { deadlineFor } from "../../lib/deadlines";
import { useFaucetCountdown } from "../../lib/x402/use-faucet-countdown";
import { walletAction, faucetClaim, getWallet, priceMicroOf, type DepositInfoResponse } from "../../lib/x402/wallet-client";
import {
  asNetwork,
  ceilingNote,
  faucetCta,
  faucetNoAnswerNote,
  networkChoices,
  networkLabel,
  networkShort,
  topUpRoute,
  walletIntro,
  type FaucetInfo,
  type PayNetwork,
} from "../../lib/x402/top-up";

type LedgerEntry = {
  delta_micro: number;
  kind: string;
  ref?: string;
  counterparty?: string;
  created?: number;
};

const KIND_LABEL: Record<string, string> = {
  deposit: "⬇️ Deposit",
  admin_credit: "🎁 Credit",
  invoke_debit: "🤖 Invocation",
  invoke_credit: "💰 Earned",
  platform_fee: "🏛️ Fee",
  withdrawal: "⬆️ Withdrawal",
  refund: "↩️ Refund",
  // First-party x402 payer (pay_x402): the user pays ANOTHER agent, so their
  // ledger gets a spend_debit; a reversal (no USDC moved) is a spend_refund.
  spend_debit: "🤝 Agent payment",
  spend_refund: "↩️ Payment refund",
};

/** The kind label WITHOUT its leading emoji, for a screen reader — VoiceOver
 * otherwise announces the pictograph literally ("down-arrow Deposit"). Every
 * KIND_LABEL is "<emoji> <words>", so drop through the first space; an unknown
 * kind (no space) reads verbatim. Derived from KIND_LABEL so the two can't drift. */
function kindA11y(kind: string): string {
  const label = KIND_LABEL[kind] || kind;
  const sp = label.indexOf(" ");
  return sp === -1 ? label : label.slice(sp + 1);
}

// Ledger rows omit the time entirely on a malformed `created` (fallback "").
const relative = (sec?: number) => relativeAgo(sec, "");

/** Open a withdrawal's explorer link, if the server sent one we can open.
 *  Routed through explorerHref because this navigates on the server's string
 *  WITHOUT a user click on the URL itself — the one place a bad scheme would
 *  fire unprompted. `noopener` was already set; the scheme check is the part
 *  that was missing. */
function openExplorer(url: unknown): void {
  const href = explorerHref(url);
  if (href) window.open(href, "_blank", "noopener");
}

export default function WalletPage() {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState("");
  const [balance, setBalance] = useState(0);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  // ⬇️ Deposit flow (PR2): link sender address → send USDC → claim tx hash
  // `faucet` is the self-hosted chain's in-house top-up (worker /pay/faucet,
  // advertised by deposit_info). The union below includes "tiny" because a
  // deployment that owns its chain settles on it — while these types said
  // `"base" | "base-sepolia"` the deployment's OWN network was unselectable.
  const [depositInfo, setDepositInfo] = useState<DepositInfoResponse | null>(null);
  const [linkAddr, setLinkAddr] = useState("");
  const [claimTx, setClaimTx] = useState("");
  const [claimNetwork, setClaimNetwork] = useState<PayNetwork>("base");
  const [depositMsg, setDepositMsg] = useState("");
  // 💧 In-house faucet (self-hosted chain): claim state + its own message line,
  // kept apart from depositMsg so a faucet refusal doesn't overwrite a claim
  // result (they sit in different cards).
  const [faucetMsg, setFaucetMsg] = useState("");
  const [faucetBusy, setFaucetBusy] = useState(false);
  // ⬆️ Withdraw (self-serve, automatic)
  const [withdrawUsd, setWithdrawUsd] = useState("");
  const [withdrawNetwork, setWithdrawNetwork] = useState<PayNetwork>("base");
  const [withdrawMsg, setWithdrawMsg] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  // 📖 First-visit explainer: open by default until the user has any
  // activity (balance or history) — then it folds away but stays reachable
  const [showIntro, setShowIntro] = useState(false);
  const [busy, setBusy] = useState(false);
  // 🪪 Owned tinys + which are priced — so the "monetize" card can surface the
  // concrete x402 endpoint + ERC-8004 registration URL a caller/minter needs.
  const [myTinys, setMyTinys] = useState<{ name: string; priceMicro: number; isPrivate: boolean }[]>([]);
  const [copied, setCopied] = useState("");
  // Spoken copy-success for screen readers (visible feedback is a "✓ copied"
  // swap under a static aria-label, which announces nothing). Fed by copyUrl.
  const [copiedMsg, setCopiedMsg] = useState("");
  const { confirm, dialog } = useConfirm();

  // Roving-tabindex + arrow-key movement for the two network pickers. Both
  // declare role="radiogroup"/role="radio"+aria-checked (the correct ARIA), but
  // without this each radio was an independent Tab stop with no arrow handling —
  // behavior that contradicts the announced radio role for keyboard/SR users on
  // a money surface. Same shared hook the on-device-model / BYOK pickers use.
  //
  // The id list is the DEPLOYMENT's networks (its own chain + real Base), not a
  // hardcoded pair — see networkChoices(). It must stay in the same order as the
  // rendered radios, since the hook maps ids[n] → the nth [role=radio].
  const NET_IDS = networkChoices(depositInfo?.default_network);
  const claimRadio = useRadioGroup(NET_IDS, claimNetwork, (id) => setClaimNetwork(asNetwork(id)));
  const withdrawRadio = useRadioGroup(NET_IDS, withdrawNetwork, (id) => setWithdrawNetwork(asNetwork(id)));

  // 💧 The faucet's countdown, driven by a clock instead of by whenever this
  // page last loaded. `next_drip_in_seconds` is a server DELTA measured at
  // fetch time and this page never polls, so without this the label froze and —
  // worse — the Claim button stayed disabled across UTC midnight, when the drip
  // is claimable again. See lib/x402/faucet-countdown.ts.
  const { remainingSeconds: dripLeft } = useFaucetCountdown(depositInfo?.faucet?.next_drip_in_seconds);

  // ⏱️ The ledger's "5m ago" labels, same defect one card over and cosmetic
  // rather than gating: this page loads once and never polls, so every row froze
  // at first paint — an hour later the whole list still read "5m ago", and the
  // row's SR label disagreed with the absolute time printed beside it. The wake-
  // ups are computed from these very timestamps (the next second any row's
  // bucket changes), so an old ledger costs one render a minute rather than one
  // every 30s. See lib/relative-tick.ts.
  useRelativeTick(relativeTickKey(history.map((e) => e.created)));

  const load = useCallback(async () => {
    // Classification (401/424/error/guarded numerics) lives in
    // wallet-client's parseWalletSnapshot — shared with WalletSheet.
    const snap = await getWallet();
    if (snap.status === "unauthorized") {
      window.location.href = `/api/auth?return_to=${encodeURIComponent("/wallet")}`;
      return;
    }
    if (snap.status === "unavailable") { setStatus("unavailable"); return; }
    if (snap.status === "failed") {
      // Only escalate to the full-screen error state on the INITIAL load
      // (status still "loading"). load() re-runs after every claim/withdraw —
      // a blip there must not tear down an already-populated wallet; the
      // deposit/withdraw cards surface their own inline messages. Mirrors the
      // /devices poll-failure guard.
      setError("Couldn't reach the wallet service.");
      setStatus((prev) => (prev === "loading" ? "error" : prev));
      return;
    }
    setBalance(snap.balanceMicro);
    setHistory(snap.history);
    // Newcomers (no balance, no activity) get the explainer opened
    setShowIntro(snap.balanceMicro === 0 && !snap.history.length);
    setStatus("ready");
  }, []);

  // The deposit + on-ramp UI hangs entirely off deposit_info. It's a SEPARATE
  // call from load(), so a transient failure used to leave depositInfo null and
  // render the misleading "deposits aren't configured yet" card on a fully-
  // configured deployment. Retry once on a network/parse blip (but NOT on a
  // clean {ok:false} — that's the honest "not configured" answer) so a single
  // hiccup doesn't blank the whole deposit surface. Isolated from the wallet
  // status like load()'s guard: a deposit_info miss never tears down the wallet.
  const loadDepositInfo = useCallback(async (): Promise<void> => {
    // Try twice on a network/parse blip (but stop on a clean {ok:false} — that's
    // the honest "not configured" answer, not a transient failure).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const d = await walletAction({ action: "deposit_info" });
        if (d.ok === false) return;
        setDepositInfo(d);
        // Seed both network selectors to the deployment's default. On a testnet
        // (PAYMENTS_TESTNET) deployment the deposit header reads "Base Sepolia"
        // but the selectors defaulted to mainnet — so a user pasting a Sepolia
        // tx hash hit the permanent 400 "no matching USDC transfer on base".
        // Follow the header the worker already reports — for ANY non-mainnet
        // network, not just Sepolia: the same mismatch (and the same permanent
        // 400) applies verbatim to a self-hosted `tiny` chain, which this used to
        // miss because the check named one network instead of asking what the
        // default was. asNetwork() also keeps a garbled value on mainnet.
        setClaimNetwork(asNetwork(d.default_network));
        setWithdrawNetwork(asNetwork(d.default_network));
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
    // Owned tinys + their per-message price → the monetize card lists the
    // agent-payable/on-chain URLs for each (pricing is what turns x402 on).
    // Deadlined like every other read on this page (c50 did the money calls
    // via wallet-client; this one loads the monetize card's owned-tiny list and
    // was the last bare fetch left in the file).
    fetch("/api/me", { cache: "no-store", signal: AbortSignal.timeout(deadlineFor("/api/me")) })
      .then(r => (r.ok ? r.json() : null))
      .then(async (me) => {
        // Keep the `private` flag alongside the name — a private tiny is walled
        // off from x402/chat AND its ERC-8004 registration (both 403 by design),
        // so its "agent-payable" URLs are dead-on-arrival and must be excluded.
        // `private` arrives as a D1 integer (0/1) — `!!` is the right coercion
        // for a real row (0→public, 1→private). Fail CLOSED only on the
        // degenerate missing/null case (field renamed or dropped upstream):
        // treat an absent flag as private so a priced tiny's payable URLs are
        // never surfaced on a guess. Mirrors the server 403 gates' posture.
        const owned: { name: string; isPrivate: boolean }[] = (me?.tinys || [])
          .map((t: { name: string; private?: boolean | number | null }) => ({
            name: t.name,
            isPrivate: t.private == null ? true : !!t.private,
          }))
          .filter((t: { name: string }) => t.name);
        if (!owned.length) return;
        const priced = await Promise.all(owned.map(async ({ name, isPrivate }) => {
          const p = await walletAction({ action: "pricing", resource: `tiny:${name}` }).catch(() => null);
          return { name, priceMicro: priceMicroOf(p), isPrivate };
        }));
        setMyTinys(priced);
      }).catch(() => {});
  }, [load, loadDepositInfo]);

  const copyUrl = async (url: string, tag: string, label?: string) => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(tag);
      // Announce success to screen readers — the visible "✓ copied" swap is
      // purely visual + the button's aria-label is static, so without this a
      // blind user gets no confirmation the copy landed (the gap iOS closed in
      // its copyableUrl accessibilityValue). The label distinguishes which URL
      // was copied when there are several buttons.
      setCopiedMsg(`${label || "Value"} copied`);
      setTimeout(() => {
        setCopied((c) => (c === tag ? "" : c));
        // Clear the announcement so re-copying the SAME label later changes the
        // live-region text (identical text back-to-back won't re-announce).
        setCopiedMsg("");
      }, 1500);
    } catch { /* clipboard blocked — the URL is still visible to copy by hand */ }
  };

  const linkAddress = async () => {
    if (busy) return;
    setBusy(true); setDepositMsg("");
    try {
      const d = await walletAction({ action: "link_address", address: linkAddr.trim() });
      if (d.ok) {
        setDepositInfo(prev => prev ? { ...prev, linked_address: d.address } : prev);
        setDepositMsg("✓ Address linked — send USDC on Base, then claim with the tx hash.");
        setLinkAddr("");
      } else setDepositMsg(`⚠️ ${d.error || "link failed"}`);
    } catch { setDepositMsg("⚠️ link failed"); }
    finally { setBusy(false); }
  };

  const claimDeposit = async () => {
    if (busy) return;
    setBusy(true); setDepositMsg("");
    try {
      const d = await walletAction({ action: "claim", txHash: claimTx.trim(), network: claimNetwork });
      if (d.ok) {
        if (d.already_credited) {
          setDepositMsg("Already credited — this tx was claimed before.");
        } else {
          // A base-sepolia claim credits capped TRIAL balance and the amount
          // may be clamped to what's left of the $1 lifetime cap — say so, or
          // the user thinks they hold real, withdrawable USDC (deposits.ts:242,
          // iOS Wallet.swift parity).
          const trial = d.testnet_trial === true;
          // Quote the ceiling the SERVER enforced (trial_cap_micro), not a
          // hardcoded "$1": on the self-hosted chain reputation widens it, so a
          // user with reputation was being told their cap was $1 while the worker
          // had already allowed them more.
          const trialCap = Number(d.trial_cap_micro);
          // Format the credited amount through usd() (2–6dp), the same MONEY
          // formatter the Balance card + the withdraw toast use — a hand-rolled
          // toFixed(2) reported "$10.12" for a 10_123_456-micro deposit while the
          // balance rendered the true "$10.123456", two numbers for one event on
          // a money screen. Mirrors withdraw()'s `usd(d.net_micro)` toast.
          setDepositMsg(
            `✓ Credited ${usd(Number(d.credited_micro || 0))}` +
            (trial
              ? ` (trial credit${Number.isFinite(trialCap) && trialCap > 0 ? ` — ${usd(trialCap)} lifetime cap` : ""}, not withdrawable as real USDC)`
              : "")
          );
        }
        setClaimTx("");
        load();
      } else setDepositMsg(`⚠️ ${d.error || "claim failed"}${d.retry ? " — try again in a minute" : ""}`);
    } catch { setDepositMsg("⚠️ claim failed"); }
    finally { setBusy(false); }
  };

  // 💧 Claim the daily drip from the in-house faucet. This is the ONLY way to
  // get balance on a chain we own — nobody sells the token, so the fiat on-ramps
  // this replaced could never deliver it.
  const claimFaucet = async () => {
    if (faucetBusy) return;
    setFaucetBusy(true); setFaucetMsg("");
    try {
      const d = await faucetClaim();
      if (d.ok) {
        setFaucetMsg(`✓ Credited ${usd(Number(d.credited_micro || 0))} trial credit — spendable inside tiny, not withdrawable as real USDC.`);
        // Refresh BOTH: the balance (load) and the faucet's own remaining/
        // claimed_today figures, or the button would still read "Claim $1" after
        // a successful claim and 429 on the next press.
        load();
        loadDepositInfo();
      } else {
        // Pass the server's own refusal through — it distinguishes 429
        // (already_claimed, with next_drip_in_seconds) from 400 (ceiling_reached)
        // on purpose, and re-wording them here would collapse two different
        // instructions into one. Re-read deposit_info either way so the button
        // settles into the matching disabled state.
        setFaucetMsg(`⚠️ ${d.error || "faucet unavailable"}`);
        loadDepositInfo();
      }
    } catch {
      // 💧 No readable answer — an UNKNOWN outcome, not a refusal, and not the
      // "couldn't reach the faucet" this used to assert (see faucetNoAnswerNote:
      // the throw is equally a delivered-then-timed-out request, whose credit is
      // already in the ledger). Refresh BOTH like the ok path does — this branch
      // used to refresh NEITHER, so the balance stayed stale AND the button kept
      // reading "Claim $1" over credit the user already held, which is the state
      // that turns one unanswered POST into a 429 and a user who thinks they were
      // refused twice.
      setFaucetMsg(faucetNoAnswerNote);
      load();
      loadDepositInfo();
    }
    finally { setFaucetBusy(false); }
  };

  const withdraw = async () => {
    if (withdrawing) return;
    // parseDecimalInput normalizes a comma-locale keypad's decimal comma to a dot
    // (parseFloat is locale-invariant — "10,50" → 10, dropping the cents). Same
    // fix iOS Wallet.swift:188-204 applies. See lib/utils for the why.
    const amount = parseDecimalInput(withdrawUsd);
    if (!Number.isFinite(amount) || amount < 1) { setWithdrawMsg("⚠️ minimum withdrawal is $1"); return; }
    // Cap at the balance BEFORE the confirm — parity with iOS Wallet.swift:205-212.
    // Without it the on-brand confirm below promises "$500.00 leaves your balance…
    // $499.90 arrives on-chain… can't be undone" for money the balance can't pay,
    // and the user commits an irreversible-sounding action only for the server to
    // reject it. Guard on the quantized micro value so the check matches the exact
    // figure the confirm + payload use (a typed "5.0000004" rounds to 5000000)
    // — the same quantized value the confirm dialog + POST body reuse below.
    const amountMicro = Math.round(amount * 1_000_000);
    if (amountMicro > balance) { setWithdrawMsg(`⚠️ you have ${usd(balance)} to withdraw`); return; }
    if (!depositInfo?.linked_address) { setWithdrawMsg("⚠️ link your wallet address first (in the Deposit card) — it's your withdrawal destination"); return; }
    // On-brand confirm (portaled, focus-trapped, exit choreography) — matches
    // the /devices revoke flow instead of a native window.confirm() that breaks
    // the app's blurred/neon overlay grammar. Destructive styling: moves money.
    // Show the exact split the worker will apply: the FULL amount leaves the
    // balance, a flat $0.10 covers gas, and only the NET lands on-chain. The
    // success toast reports net_micro too — the confirm must match it, or the
    // pre-commit number ($10) contradicts the post-commit number ($9.90) on an
    // irreversible action. (net = amount − flat fee; worker is source of truth.)
    // Quantize to micro-USDC FIRST and format both the confirm and the payload
    // off that one value via usd() — a typed "12.3456" must not show "$12.35" in
    // the dialog while 12345600 micro actually leaves the balance.
    const netMicro = Math.max(0, amountMicro - 100_000); // flat $0.10 gas = 100_000 micro
    const ok = await confirm({
      title: "Withdraw USDC?",
      // networkShort() so a `tiny` withdrawal doesn't get confirmed as "Base
      // Sepolia" — the old ternary called every non-mainnet network Sepolia.
      message: `${usd(amountMicro)} leaves your balance on ${networkShort(withdrawNetwork)}. After a flat $0.10 gas fee, ${usd(netMicro)} USDC arrives at your linked address:\n${depositInfo.linked_address}\n\nThis is instant and can't be undone.`,
      confirmLabel: "Withdraw",
      danger: true,
    });
    if (!ok) return;
    setWithdrawing(true); setWithdrawMsg("Signing and broadcasting…");
    try {
      const d = await fetch("/api/wallet/withdraw", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_micro: amountMicro, network: withdrawNetwork }),
        // 75s, from lib/deadlines — deliberately LONGER than the route's own
        // maxDuration=60. A hung request otherwise leaves `withdrawing` true
        // forever (the finally never runs), stranding the card on "Signing and
        // broadcasting…" with the button disabled and no way to learn what
        // happened. The deadline is a backstop for a server that stopped
        // answering, NOT a competitor to one still signing: a shorter cap would
        // abort payouts mid-broadcast and report the pending copy below for
        // withdrawals that were about to succeed.
        signal: AbortSignal.timeout(deadlineFor("/api/wallet/withdraw")),
      }).then(r => r.json());
      if (d.ok) {
        setWithdrawMsg(`✓ Paid — ${usd(d.net_micro)} sent on-chain. `);
        setWithdrawUsd("");
        load();
        openExplorer(d.explorer);
      } else if (d.pending_confirmation) {
        // The tx broadcast but confirmation timed out (server withheld the
        // refund on purpose — the transfer is in the mempool and will likely
        // land). NOT a failure: don't scare the user or invite a double-spend
        // retry. Neutral tone + the explorer link so they can watch it confirm.
        setWithdrawMsg("⏳ Sent — confirming on-chain. Don't retry; it'll settle shortly. ");
        setWithdrawUsd("");
        load();
        openExplorer(d.explorer);
      } else {
        setWithdrawMsg(`⚠️ ${d.error || "withdrawal failed"}`);
        load(); // refund may have adjusted balance display
      }
    } catch {
      // UNKNOWN outcome — fetch rejected (transport drop) or the body wasn't
      // JSON (a 504 / proxy error at the platform cap makes r.json() throw).
      // Unlike a STRUCTURED non-ok body (the `else` above, where the route has
      // provably refunded any broadcast-that-moved-nothing), here we do NOT
      // know whether the transfer broadcast — money MAY be in the mempool. A
      // hard "failed" would invite a double-pay retry on an irreversible payout,
      // re-entering the exact double-spend the server's 202 path guards against.
      // Treat as pending: neutral tone, no retry nudge, point at Activity — the
      // same split iOS (Wallet.swift `d == nil`) + Android (WalletCore null) make.
      setWithdrawMsg("⏳ Couldn't confirm the withdrawal. It may still be processing — check Activity before retrying.");
      setWithdrawUsd("");
      load();
    }
    finally { setWithdrawing(false); }
  };

  const accent = "var(--tiny-accent, #00FF88)";

  // Explainer copy, gated on the chain this deployment actually settles on —
  // every sentence in that card is a claim about what the money IS.
  const intro = walletIntro(depositInfo?.default_network);
  // The explorer exists only on our own chain (elsewhere BaseScan is the
  // explorer, and it's already linked per-transaction from each receipt).
  const showChainLink = asNetwork(depositInfo?.default_network) === "tiny";

  return (
    <main className="min-h-screen bg-black text-white px-4 py-10 sm:py-16">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="space-y-2">
          {/* Link, not <a>: a raw anchor full-reloads the app (black flash) —
              the same anti-pattern the devices page's own comment warns about */}
          <Link
            href="/"
            className="inline-block text-2xl font-bold transition-transform hover:scale-105 active:scale-100 rounded"
            style={{ color: accent, textShadow: "0 0 10px rgba(var(--tiny-accent-rgb, 0,255,136),0.5)" }}
          >
            tiny
          </Link>
          <h1 className="text-lg font-semibold">Your wallet</h1>
          <p className="text-sm text-gray-400">
            Every tiny account has a wallet — it&apos;s how the AI economy on
            tiny.technology moves money: pay creators&apos; AIs, sell access to
            yours, cash out real USDC.
          </p>
        </header>

        {/* Shared polite live region — announces copy success to screen readers
            (every "copy" button flips only VISIBLE text under a static aria-label,
            so without this a blind user gets no confirmation). Mirrors iOS's
            copyableUrl spoken "Copied". */}
        <span role="status" aria-live="polite" className="sr-only">{copiedMsg}</span>

        {status === "loading" && (
          // Skeleton shell mirroring the ready layout (balance card + a couple
          // of section cards) — same perceived-perf pattern as /devices, so the
          // real content swaps IN calm rather than popping over a bare text
          // line. Visual bones are aria-hidden; one sr-only status carries the
          // meaning. animate-pulse is neutralized by the reduced-motion global.
          <div className="space-y-8">
            <span role="status" className="sr-only">Loading your wallet…</span>
            <div className="rounded-2xl border p-6 animate-pulse" aria-hidden="true" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)", background: "rgba(0,0,0,0.5)" }}>
              <div className="h-2.5 w-16 rounded mb-3" style={{ background: "rgba(255,255,255,0.08)" }} />
              <div className="h-9 w-40 rounded" style={{ background: "rgba(var(--tiny-accent-rgb, 0,255,136),0.15)" }} />
            </div>
            {[0, 1].map((i) => (
              <div key={i} className="rounded-2xl border p-5 space-y-3 animate-pulse" aria-hidden="true" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                <div className="h-3.5 w-40 rounded" style={{ background: "rgba(255,255,255,0.1)" }} />
                <div className="h-2.5 w-full rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
                <div className="h-2.5 w-2/3 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
              </div>
            ))}
          </div>
        )}
        {status === "error" && (
          // Honest error + in-body Retry — the shared grammar every panel and
          // the /devices page follow. A wallet-service blip would otherwise
          // strand the user with no recovery but a full reload.
          <div role="alert" className="rounded-2xl border p-6 space-y-3 text-center" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => { setStatus("loading"); load(); }}
              className="tap-target px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb,0,255,136),0.1)]"
              style={{ color: accent, borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.3)" }}
            >
              Retry
            </button>
          </div>
        )}
        {status === "unavailable" && (
          <div className="rounded-2xl border p-6" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            <p className="text-sm text-gray-300">The wallet service isn&apos;t available yet.</p>
          </div>
        )}

        {status === "ready" && (
          <>
            {/* Balance */}
            <div className="rounded-2xl border p-6" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)", background: "rgba(0,0,0,0.5)" }}>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Balance</div>
              <div className="text-4xl font-bold" style={{ color: accent, textShadow: "0 0 20px rgba(var(--tiny-accent-rgb, 0,255,136),0.4)" }}>
                {usd(balance)}
              </div>
              <div className="text-xs text-gray-500 mt-1">tiny credits (micro-USDC ledger)</div>
              {/* 🔍 The chain explorer, but described HONESTLY: this number is a
                  ledger row, and /chain shows the on-chain settlements and the
                  reserve backing them (mintReserve credits the platform deposit
                  address, not a per-user account). Calling it "your wallet on
                  chain" would promise a balance the explorer can't show. */}
              {showChainLink && (
                <Link
                  href="/chain"
                  className="inline-block text-xs mt-3 text-sky-300 hover:underline rounded"
                >
                  🔍 See the settlements on the chain explorer →
                </Link>
              )}
            </div>

            {/* 📖 What is this? — expandable explainer, auto-open for
                newcomers (zero balance + zero history) */}
            <div className="rounded-2xl border" style={{ borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.2)" }}>
              <button
                onClick={() => setShowIntro(v => !v)}
                aria-expanded={showIntro}
                className="w-full flex items-center justify-between px-5 py-3.5 text-sm font-semibold text-white"
              >
                <span>🌱 What is the tiny wallet?</span>
                <span aria-hidden className="text-gray-500 text-xs">{showIntro ? "▲" : "▼"}</span>
              </button>
              {showIntro && (
                <div className="px-5 pb-5 space-y-4 text-sm text-gray-300">
                  <p>
                    Your wallet holds <strong style={{ color: accent }}>tiny credits</strong> —
                    dollar-denominated balance (USDC) that powers the AI economy here.
                    Everything is optional: free tinys stay free forever.
                  </p>

                  <div className="space-y-2.5">
                    <div className="flex gap-3">
                      <span aria-hidden>🤖</span>
                      <div>
                        <div className="font-semibold text-white text-xs uppercase tracking-wide mb-0.5">Use paid AIs</div>
                        <p className="text-xs text-gray-400">
                          Some creators charge per message (e.g. $0.01) for specialized tinys —
                          legal helpers, trading analysts, tutors. Your balance pays automatically
                          as you chat; the price is always shown up front.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span aria-hidden>💰</span>
                      <div>
                        <div className="font-semibold text-white text-xs uppercase tracking-wide mb-0.5">Earn with your AIs</div>
                        <p className="text-xs text-gray-400">
                          Tell any tiny you own <span className="font-mono text-gray-300">&quot;charge $0.01 per message&quot;</span> —
                          done, it&apos;s monetized. Every visitor message pays you. Sell your forged
                          tools on the marketplace too (one-time purchases). You keep the full price
                          minus a flat $0.001 — never a percentage cut.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span aria-hidden>🌐</span>
                      <div>
                        <div className="font-semibold text-white text-xs uppercase tracking-wide mb-0.5">Get paid by other agents</div>
                        <p className="text-xs text-gray-400">{intro.reach}</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span aria-hidden>🏦</span>
                      <div>
                        <div className="font-semibold text-white text-xs uppercase tracking-wide mb-0.5">{intro.custodyTitle}</div>
                        <p className="text-xs text-gray-400">{intro.custody}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl px-4 py-3 text-xs text-gray-400" style={{ background: "rgba(255,255,255,0.04)" }}>
                    <span className="font-semibold text-white">Quick start:</span> {intro.quickStart}
                  </div>

                  <p className="text-[11px] text-gray-600">
                    Fees: $0.001 flat per paid message (charged to the earner) · $0.10 flat per
                    withdrawal (covers blockchain gas) · deposits free · everything else free.
                    Limits: $1 min withdrawal, $500/day. Balance unit: micro-USDC (1,000,000 = $1).
                  </p>
                </div>
              )}
            </div>

            {/* 💧 Get credit. THREE mutually-exclusive routes, chosen by
                topUpRoute() from what the server says it can actually do:

                  faucet  — we host the chain, so we issue the credit. No card or
                            bridge can deliver a token only this deployment mints,
                            so offering one alongside would be a dead end dressed
                            up as a choice.
                  testnet — Sepolia: the public faucet is the one true source;
                            fiat on-ramps deliver MAINNET USDC the claim scanner
                            can't see.
                  fiat    — real Base: cards/bridges work, and a faucet is noise.

                Keyed on faucet.available (the server's answer), NOT on the
                network name, because a half-configured tiny chain reports `tiny`
                with no faucet — and a claim button there 424s on every press. */}
            {topUpRoute(depositInfo) === "faucet" ? (
              <div className="rounded-2xl border p-5 space-y-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                <div className="text-sm font-semibold text-white">💧 Get credit (free daily top-up)</div>
                <p className="text-xs text-gray-400">
                  This deployment runs its own chain, so credit comes straight
                  from us — no card, no exchange, no wallet needed. It&apos;s
                  spendable on any tiny; it isn&apos;t withdrawable as real USDC.
                </p>
                {(() => {
                  // One call, used for the label, the disabled state AND the
                  // reason — so the button can't say "Claim $1" while the reason
                  // line says the ceiling is spent.
                  const cta = faucetCta(depositInfo?.faucet, { remainingSeconds: dripLeft });
                  return (
                    <>
                      <button
                        onClick={claimFaucet}
                        disabled={faucetBusy || !cta.enabled}
                        className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                        style={{ background: accent, color: "#000" }}
                      >
                        {faucetBusy ? "Claiming…" : cta.label}
                      </button>
                      {cta.reason && <p className="text-xs text-gray-400">{cta.reason}</p>}
                    </>
                  );
                })()}
                {/* Shown in EVERY state, including right after a claim: the
                    ceiling is reputation-scaled, so "get followed" is the one
                    durable answer to "how do I get more?". */}
                <p className="text-[11px] text-gray-600">{ceilingNote(depositInfo?.faucet)}</p>
                {faucetMsg && <p role="status" className="text-xs" style={{ color: faucetMsg.startsWith("⚠️") ? "var(--tiny-warn)" : accent }}>{faucetMsg}</p>}
              </div>
            ) : (
            <div className="rounded-2xl border p-5 space-y-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
              <div className="text-sm font-semibold text-white">💳 Get USDC (buy with card)</div>
              {!depositInfo?.linked_address ? (
                <p className="text-xs text-gray-500">Link your wallet address below first — purchases are delivered there, then you deposit from it.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {topUpRoute(depositInfo) === "testnet" ? (
                    <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"
                      className="px-4 py-2 rounded-lg text-xs font-semibold no-underline"
                      style={{ background: accent, color: "#000" }}>
                      🧪 Get free testnet USDC →
                    </a>
                  ) : (
                    <>
                      {process.env.NEXT_PUBLIC_ONRAMP_APP_ID && (
                        <a
                          href={`https://pay.coinbase.com/buy/select-asset?appId=${process.env.NEXT_PUBLIC_ONRAMP_APP_ID}&addresses=${encodeURIComponent(JSON.stringify({ [depositInfo.linked_address]: ["base"] }))}&assets=${encodeURIComponent('["USDC"]')}&defaultNetwork=base&defaultAsset=USDC&presetFiatAmount=20`}
                          target="_blank" rel="noopener noreferrer"
                          className="px-4 py-2 rounded-lg text-xs font-semibold no-underline"
                          style={{ background: accent, color: "#000" }}
                        >
                          Buy on Coinbase →
                        </a>
                      )}
                      {process.env.NEXT_PUBLIC_MOONPAY_KEY && (
                        <a
                          href={`https://buy.moonpay.com?apiKey=${process.env.NEXT_PUBLIC_MOONPAY_KEY}&currencyCode=usdc_base&walletAddress=${encodeURIComponent(depositInfo.linked_address)}&baseCurrencyAmount=20`}
                          target="_blank" rel="noopener noreferrer"
                          className="px-4 py-2 rounded-lg text-xs font-semibold border no-underline"
                          style={{ borderColor: accent, color: accent }}
                        >
                          Buy with MoonPay →
                        </a>
                      )}
                      {/* Always-available fallbacks — zero API keys needed */}
                      <a href="https://www.coinbase.com/price/usdc" target="_blank" rel="noopener noreferrer"
                        className="px-4 py-2 rounded-lg text-xs border text-gray-300 no-underline"
                        style={{ borderColor: "rgba(255,255,255,0.18)" }}>
                        Coinbase app
                      </a>
                      <a href="https://bridge.base.org" target="_blank" rel="noopener noreferrer"
                        className="px-4 py-2 rounded-lg text-xs border text-gray-300 no-underline"
                        style={{ borderColor: "rgba(255,255,255,0.18)" }}>
                        Bridge from Ethereum
                      </a>
                    </>
                  )}
                </div>
              )}
              <p className="text-[11px] text-gray-600">
                {topUpRoute(depositInfo) === "testnet"
                  ? <>Testnet USDC lands in <span className="font-mono">{depositInfo?.linked_address ? `${depositInfo.linked_address.slice(0, 8)}…` : "your wallet"}</span> on Base Sepolia — then use the Deposit card below to credit your tiny balance.</>
                  : <>Purchases land in <span className="font-mono">{depositInfo?.linked_address ? `${depositInfo.linked_address.slice(0, 8)}…` : "your wallet"}</span> on Base — then use the Deposit card below to credit your tiny balance.</>}
              </p>
            </div>
            )}

            {/* ⬇️ Deposit (PR2): link sender → send USDC on Base → claim by tx hash */}
            <div className="rounded-2xl border p-5 space-y-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
              <div className="text-sm font-semibold text-white">⬇️ Deposit USDC on {networkShort(asNetwork(depositInfo?.default_network))}</div>
              {!depositInfo?.configured ? (
                <p className="text-xs text-gray-500">
                  USDC deposits are rolling out — the deposit address isn&apos;t configured yet.
                  Until then, credits are granted by the platform.
                </p>
              ) : (
                <>
                  <div className="text-xs text-gray-400 space-y-2">
                    <p>1. Link the wallet address you&apos;ll send <em>from</em> (this is what makes your deposit claimable by you alone):</p>
                    {depositInfo.linked_address ? (
                      <p className="font-mono text-[11px] break-all" style={{ color: accent }}>✓ {depositInfo.linked_address}</p>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          value={linkAddr}
                          onChange={(e) => setLinkAddr(e.target.value)}
                          placeholder="0xYourAddress"
                          spellCheck={false}
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          className="flex-1 min-w-0 rounded-lg border px-3 py-2 text-xs font-mono bg-transparent text-white placeholder-gray-600 focus:outline-none"
                          style={{ borderColor: "rgba(255,255,255,0.18)" }}
                          aria-label="Your sending address"
                        />
                        <button onClick={linkAddress} disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(linkAddr.trim())}
                          className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                          style={{ background: accent, color: "#000" }}>
                          Link
                        </button>
                      </div>
                    )}
                    <p>2. Send USDC to the platform deposit address:</p>
                    <div className="flex items-start gap-2">
                      <code className="flex-1 min-w-0 rounded-lg px-3 py-2 text-[11px] font-mono break-all text-gray-200" style={{ background: "rgba(255,255,255,0.06)" }}>
                        {depositInfo.deposit_address}
                      </code>
                      {depositInfo.deposit_address && (
                        <button
                          onClick={() => copyUrl(depositInfo.deposit_address!, "deposit-addr", "Deposit address")}
                          className="tap-target text-[10px] px-2 py-2 rounded-md shrink-0 transition-opacity hover:opacity-80"
                          style={{ background: "rgba(255,255,255,0.06)", color: copied === "deposit-addr" ? accent : "#9ca3af" }}
                          aria-label="Copy the platform deposit address"
                        >
                          {copied === "deposit-addr" ? "✓ copied" : "copy"}
                        </button>
                      )}
                    </div>
                    <p>3. Paste the transaction hash to credit your balance:</p>
                    <div className="flex gap-2 items-center" role="radiogroup" aria-label="Deposit network" onKeyDown={claimRadio.onKeyDown}>
                      {/* NET_IDS, not a hardcoded pair: the deployment's own
                          chain must be selectable (it wasn't for `tiny`), and the
                          OTHER trial chain must not be — a hash from one is
                          invisible to the other's scanner. Same order as NET_IDS,
                          which the roving-tabindex hook indexes positionally. */}
                      {NET_IDS.map(id => {
                        const n = asNetwork(id);
                        return (
                          <button key={n} onClick={() => setClaimNetwork(n)}
                            role="radio" aria-checked={claimNetwork === n} tabIndex={claimRadio.tabIndex(n)}
                            className="tap-target px-2.5 py-1 rounded-lg text-[11px] border transition-colors"
                            style={claimNetwork === n
                              ? { borderColor: accent, color: accent }
                              : { borderColor: "rgba(255,255,255,0.15)", color: "#888" }}>
                            {networkLabel(n)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={claimTx}
                        onChange={(e) => setClaimTx(e.target.value)}
                        placeholder="0xTransactionHash"
                        spellCheck={false}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        className="flex-1 min-w-0 rounded-lg border px-3 py-2 text-xs font-mono bg-transparent text-white placeholder-gray-600 focus:outline-none"
                        style={{ borderColor: "rgba(255,255,255,0.18)" }}
                        aria-label="Deposit transaction hash"
                      />
                      <button onClick={claimDeposit} disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(claimTx.trim())}
                        className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                        style={{ background: accent, color: "#000" }}>
                        {busy ? "…" : "Claim"}
                      </button>
                    </div>
                  </div>
                </>
              )}
              {depositMsg && <p role="status" className="text-xs" style={{ color: depositMsg.startsWith("⚠️") ? "var(--tiny-warn)" : accent }}>{depositMsg}</p>}
            </div>

            {/* ⬆️ Withdraw — fully self-serve, signs + broadcasts immediately */}
            <div className="rounded-2xl border p-5 space-y-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
              <div className="text-sm font-semibold text-white">⬆️ Withdraw USDC</div>
              <p className="text-xs text-gray-500">
                Sends to your linked address instantly — no approval step. Min $1,
                flat $0.10 fee (gas), $500/day. Trial credits (Tiny Chain, Base
                Sepolia, faucet top-ups) aren&apos;t withdrawable as real USDC.
              </p>
              <div className="flex flex-wrap gap-2 items-center">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">$</span>
                  <input
                    value={withdrawUsd}
                    onChange={(e) => setWithdrawUsd(e.target.value)}
                    placeholder="10.00"
                    inputMode="decimal"
                    className="w-28 rounded-lg border pl-6 pr-3 py-2 text-sm font-mono bg-transparent text-white placeholder-gray-600 focus:outline-none"
                    style={{ borderColor: "rgba(255,255,255,0.18)" }}
                    aria-label="Withdrawal amount in USD"
                  />
                </div>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Withdrawal network" onKeyDown={withdrawRadio.onKeyDown}>
                  {NET_IDS.map(id => {
                    const n = asNetwork(id);
                    return (
                      <button key={n} onClick={() => setWithdrawNetwork(n)}
                        role="radio" aria-checked={withdrawNetwork === n} tabIndex={withdrawRadio.tabIndex(n)}
                        className="tap-target px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors"
                        style={withdrawNetwork === n
                          ? { borderColor: accent, color: accent }
                          : { borderColor: "rgba(255,255,255,0.15)", color: "#888" }}>
                        {networkShort(n)}
                      </button>
                    );
                  })}
                </div>
                <button onClick={withdraw}
                  disabled={withdrawing || !(parseDecimalInput(withdrawUsd) >= 1)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ background: accent, color: "#000" }}>
                  {withdrawing ? "Sending…" : "Withdraw"}
                </button>
              </div>
              {withdrawMsg && <p role="status" className="text-xs" style={{ color: withdrawMsg.startsWith("⚠️") ? "var(--tiny-warn)" : accent }}>{withdrawMsg}</p>}
            </div>

            {/* How pricing works + the agent-payable / on-chain URLs */}
            <div className="rounded-2xl border p-5 space-y-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
              <div className="text-sm font-semibold text-white">💰 Monetize your tinys</div>
              <p className="text-xs text-gray-500">
                To price a tiny you own, just tell it in chat:{" "}
                <span className="font-mono text-gray-300">&quot;charge $0.01 per message&quot;</span> —
                or <span className="font-mono text-gray-300">&quot;make yourself free again&quot;</span> to turn it off.
                Callers pay from their wallet; you earn the price minus the flat fee.
              </p>

              {myTinys.length > 0 && (() => {
                // Only priced AND public tinys are actually x402-payable. A
                // private tiny 403s on both /api/x402/chat and its ERC-8004
                // registration file (by design — its persona is masked), so its
                // URLs are dead-on-arrival; never advertise them as payable.
                const priced = myTinys.filter((t) => t.priceMicro > 0 && !t.isPrivate);
                const pricedPrivate = myTinys.filter((t) => t.priceMicro > 0 && t.isPrivate);
                if (!priced.length) {
                  return (
                    <p className="text-[11px] text-gray-600 border-t pt-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                      {pricedPrivate.length ? (
                        <>Make a priced tiny public to unlock its x402 endpoint + on-chain (ERC-8004)
                        registration URL — a private tiny stays walled off from agent payments.</>
                      ) : (
                        <>Price a tiny to unlock its x402 endpoint + on-chain (ERC-8004) registration URL —
                        they&apos;ll appear here so any AI agent can discover and pay it.</>
                      )}
                    </p>
                  );
                }
                return (
                  <div className="border-t pt-3 space-y-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                    <p className="text-[11px] text-gray-500">
                      🌐 These tinys are payable by <span className="text-gray-300">any AI agent</span> over
                      the open x402 protocol, and registerable on-chain via ERC-8004. Share the URLs or
                      point <span className="font-mono text-gray-400">register_agent</span> at the registration file:
                    </p>
                    {priced.map((t) => {
                      const x402 = `https://tiny.technology/api/x402/chat/${t.name}`;
                      const reg = `https://tiny.technology/api/erc8004/registration/${t.name}`;
                      return (
                        <div key={t.name} className="space-y-1.5">
                          <div className="text-xs font-semibold" style={{ color: accent }}>
                            /{t.name} · {usd(t.priceMicro)}/msg
                          </div>
                          {[
                            { label: "x402 endpoint", url: x402, tag: `x402:${t.name}` },
                            { label: "ERC-8004 registration", url: reg, tag: `reg:${t.name}` },
                          ].map(({ label, url, tag }) => (
                            <div key={tag} className="flex items-center gap-2">
                              <span className="text-[10px] uppercase tracking-wide text-gray-600 w-28 shrink-0">{label}</span>
                              <code className="text-[11px] text-gray-400 truncate flex-1 font-mono">{url}</code>
                              <button
                                onClick={() => copyUrl(url, tag, `${label} URL for ${t.name}`)}
                                className="tap-target text-[10px] px-2 py-1 rounded-md shrink-0 transition-opacity hover:opacity-80"
                                style={{ background: "rgba(255,255,255,0.06)", color: copied === tag ? accent : "#9ca3af" }}
                                aria-label={`Copy ${label} URL for ${t.name}`}
                              >
                                {copied === tag ? "✓ copied" : "copy"}
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Ledger */}
            <div>
              <h2 className="text-sm font-semibold mb-2">Activity</h2>
              {history.length === 0 ? (
                <p className="text-sm text-gray-500 py-3">No activity yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((e, i) => {
                    // One coherent announcement per row: the sign is conveyed by
                    // color visually, so spell out credit/debit in words for a SR
                    // (WCAG 1.4.1 — never color-alone), name the kind WITHOUT its
                    // emoji, and read the amount + when. The visual spans are
                    // aria-hidden so VoiceOver speaks the label once, not four
                    // disjoint fragments with a literal pictograph.
                    const credit = e.delta_micro >= 0;
                    // Absolute time rides along everywhere the relative one
                    // goes: hover (title), print (a "3d ago" on paper is
                    // anchored to an unknown moment — and the ledger is the
                    // one page users print), and the SR row label. Viewer
                    // locale — client page (c36 rule).
                    const when = e.created
                      ? new Date(e.created * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "";
                    const rowLabel =
                      `${kindA11y(e.kind)}: ${credit ? "credit" : "debit"} ${usd(Math.abs(e.delta_micro))}` +
                      (e.created ? `, ${relative(e.created)} (${when})` : "");
                    return (
                      <li
                        key={i}
                        aria-label={rowLabel}
                        className="flex items-center gap-3 rounded-xl border px-4 py-2.5"
                        style={{ borderColor: "rgba(255,255,255,0.1)" }}
                      >
                        <span className="text-sm" aria-hidden="true">{KIND_LABEL[e.kind] || e.kind}</span>
                        <span className="text-xs text-gray-600 truncate flex-1" aria-hidden="true">{e.ref || ""}</span>
                        <span className="text-xs text-gray-500" aria-hidden="true" title={when || undefined}>
                          {relative(e.created)}
                          {when && <span className="hidden print:inline"> · {when}</span>}
                        </span>
                        <span
                          className="text-sm font-mono font-semibold"
                          aria-hidden="true"
                          style={{ color: credit ? accent : "var(--tiny-danger)" }}
                        >
                          {credit ? "+" : ""}{usd(e.delta_micro)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {dialog}
    </main>
  );
}
