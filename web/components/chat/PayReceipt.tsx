"use client";

/**
 * 🤝 x402 payment — quote → USER approval → receipt (pay_x402 tool).
 *
 * Confirm-every-payment: the agent CANNOT spend. pay_x402 returns a signed
 * QUOTE (requires_confirmation), and this card renders Approve / Decline. Only
 * the user's tap on Approve calls the execute route (PUT /api/x402/pay) with
 * the quote — that is the sole money-moving path. The agent has no way to press
 * this button, so a runaway agent can never drain the wallet unattended.
 *
 * States: awaiting (quote, buttons) → paying (spinner) → paid (receipt) /
 * failed (reason) / declined. A quote that arrives already expired, or an
 * already-settled result, short-circuits to the right terminal state.
 *
 * Visual language mirrors the paywall card (accent glass, IconWallet) so all
 * payment surfaces read as one family.
 */
import { useRef, useState } from "react";
import { IconWallet } from "./icons";
// Canonical money formatter (finite-guarded — a malformed price_micro/paid_micro
// renders "$0.00", never "$NaN"); the local copy this replaces had no guard.
import { usd } from "../../lib/utils";
import { explorerHref, explorerLinkLabel } from "@/lib/x402/explorer";
import { networkLabel, type PayNetwork } from "@/lib/x402/top-up";
import { deadlineFor } from "@/lib/deadlines";
// A quote's 5-min TTL has to be re-checked as time passes, not once at first
// paint — a card can sit in a transcript through its whole expiry with nothing
// to re-render it. See lib/chat/quote-expiry.ts.
import { isQuoteExpired } from "@/lib/chat/quote-expiry";
import { useQuoteExpiry } from "@/lib/chat/use-quote-expiry";

/**
 * Human label for the quote's network — "Tiny Chain (trial credit)" vs
 * "Base (real USDC)": what approving SPENDS, on the card whose whole job is
 * informed approval. Only exact known names map; anything else renders raw
 * rather than through asNetwork(), whose default-to-base would label an
 * unknown chain as real money — the one direction this card must never err.
 */
const KNOWN_NETWORKS = new Set(["base", "base-sepolia", "tiny"]);
const netLabel = (n?: string): string | undefined =>
  n && KNOWN_NETWORKS.has(n) ? networkLabel(n as PayNetwork) : n;

type PayResult = {
  ok?: boolean;
  requires_confirmation?: boolean;
  quote?: string;
  price_micro?: number;
  paid_micro?: number;
  network?: string;
  payee?: string;
  expires_at?: number;
  message?: string;
  url?: string;
  payment_required?: boolean;
  // Set on the recoverable dead-ends: the quote's 5-min TTL lapsed (410) or the
  // service changed its price/terms (409, reservation already reversed). Both are
  // safe to re-quote in place — no money moved. Drives the "Get fresh quote" button.
  expired?: boolean;
  terms_changed?: boolean;
  // On-chain proof of a settled payment — the tx hash + a network-correct
  // BaseScan link the execute route derives from the X-PAYMENT-RESPONSE header.
  // Present only when the service returned a settlement receipt.
  tx_hash?: string;
  explorer?: string;
  // P2P send (make_payment): payee is a @login and settlement is the worker's
  // atomic internal-ledger transfer — no x402 leg, so the copy must not say
  // "over the x402 protocol". url carries the `transfer:@login` sentinel that
  // keeps reQuote's existing plumbing working.
  transfer?: boolean;
  to?: string;
  detail?: any;
  error?: string;
};


/** 0xabcd…1234 — enough to recognize a payee without a wall of hex. A P2P
 *  payee is a @login, not hex — show it whole (truncating "@my-cool-login"
 *  would hide exactly the identity the approval is about). */
function shortAddr(a?: string): string {
  if (!a || a.length < 12 || !a.startsWith("0x")) return a || "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type Phase = "awaiting" | "paying" | "paid" | "failed" | "declined" | "pending";

const ACCENT = { bg: "rgba(var(--tiny-accent-rgb, 0,255,136),0.06)", border: "rgba(var(--tiny-accent-rgb, 0,255,136),0.35)", fg: "var(--tiny-accent)" };
const DANGER = { bg: "rgba(var(--tiny-danger-rgb), 0.08)", border: "rgba(var(--tiny-danger-rgb), 0.3)", fg: "var(--tiny-danger)" };

/** The persisted terminal outcome (C3) — a paid/pending/declined tap survives a
 * reload so the card comes back as its receipt, not a dead expired-quote gate.
 * A `failed` attempt is never persisted (no money moved, quote may still be
 * spendable → a reload re-offers approval). Mirrors iOS PayQuoteItem.settled. */
type PaySettled = { phase: "paid" | "pending" | "declined"; result?: PayResult; error?: string };

export default function PayReceipt({
  status,
  result,
  error,
  settled: persisted,
  onSettled,
}: {
  status: "calling" | "success" | "error";
  result?: PayResult;
  error?: string;
  settled?: PaySettled;
  onSettled?: (s: PaySettled) => void;
}) {
  // Local phase drives the approval flow AFTER the quote lands. The final
  // settlement result lives here (not in the tool result) since the user's tap
  // — not the stream — triggers it. Seed from a persisted outcome (C3) so a
  // reload restores the receipt instead of resetting to the approval gate.
  const [phase, setPhase] = useState<Phase>(persisted?.phase ?? "awaiting");
  const [settled, setSettled] = useState<PayResult | null>(persisted?.result ?? null);
  const [settleErr, setSettleErr] = useState(persisted?.error ?? "");
  // Synchronous in-flight latch: setPhase("paying") is async, so a fast
  // double-tap could fire two PUTs before the re-render hides the button. The
  // server dedupes on the quote's jti, but we stop the second request here too.
  const inFlight = useRef(false);
  // A client-side re-minted quote (see reQuote). When set it REPLACES the streamed
  // `result` as the live quote, so an expired/terms-changed dead-end can recover
  // in place without a fresh agent turn. `active` is the quote every render + tap
  // reads from. We carry url/message forward because the POST response omits them.
  const [fresh, setFresh] = useState<PayResult | null>(null);
  const [reQuoting, setReQuoting] = useState(false);
  const active = fresh ?? result;
  // Live expiry. Hooks can't be conditional, so this runs for every phase —
  // it costs nothing on a card with no live quote (no deadline → no timer), and
  // it must be armed for `failed` as well as `awaiting`: the Retry button in
  // that branch is only safe while the quote is still valid.
  const { expired } = useQuoteExpiry(active?.expires_at);

  const quoting = status === "calling" || (!result && !error);
  // A quote awaiting the user's decision.
  const isQuote = Boolean(active?.requires_confirmation && active?.quote);
  // P2P send vs x402 service payment — steers copy only (the flow is identical).
  const isTransfer = Boolean(active?.transfer || settled?.transfer || active?.url?.startsWith("transfer:"));
  // The tool itself failed to even produce a quote.
  const toolFailed = !quoting && !isQuote && !result?.ok;

  // Re-mint a quote for the same service (POST is quote-only — moves no money) when
  // the current one is unusable: expired (410) or the service changed its terms
  // (409 terms_changed, reservation already reversed server-side). The tool result
  // carries the original url + message, so this needs no new agent turn.
  async function reQuote() {
    const url = active?.url;
    if (!url || reQuoting) return;
    setReQuoting(true);
    try {
      const r = await fetch("/api/x402/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Hand back the expired quote token as `prior_quote` so the server can
        // decode its (HMAC-bound, un-forgeable) maxSpendMicro and carry the
        // agent's ORIGINAL spend cap into the fresh quote. Without it a re-quote
        // reverts to the $25 platform ceiling, so a price hike between quotes
        // could show an approval over the cap the agent was told to stay under.
        body: JSON.stringify({ url, message: active?.message ?? "", prior_quote: active?.quote }),
        // Deadline it, or `reQuoting` never clears and "Get a fresh quote" — the
        // only way out of an expired-quote card — stays disabled for good.
        // 195s from lib/deadlines: longer than the route's maxDuration=180.
        signal: AbortSignal.timeout(deadlineFor("/api/x402/pay")),
      }).then((res) => res.json()).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (r?.ok && r?.requires_confirmation && r?.quote) {
        // Carry url/message forward (the POST response omits them) so a further
        // re-quote still works, then drop back to the fresh approval gate.
        setFresh({ ...r, url, message: active?.message ?? "" });
        setSettled(null);
        setSettleErr("");
        setPhase("awaiting");
      } else {
        setSettleErr(r?.error || r?.detail || "Couldn't get a fresh quote — try asking again.");
        setPhase("failed");
      }
    } finally {
      setReQuoting(false);
    }
  }

  async function approve() {
    if (!active?.quote) return;
    if (inFlight.current) return; // guard: one PUT per approval
    // Re-check expiry against a FRESH clock at the moment of the tap — not the
    // hook's `expired`, whose next tick may not have fired yet (up to
    // EXPIRY_TICK_MAX_MS behind). This is the authoritative client guard; the
    // server enforces exp too, so it's a friendlier refusal, not the only one.
    if (isQuoteExpired(active.expires_at, Date.now())) {
      setSettleErr("This quote expired — ask again for a fresh price.");
      setPhase("failed");
      return;
    }
    inFlight.current = true;
    setPhase("paying");
    setSettleErr("");
    try {
      // No inner .catch here: a transport failure (dropped connection) or a
      // non-JSON body must THROW to the outer catch below, NOT be swallowed
      // into a flag-less { ok:false } object. That object would fall into the
      // else branch and setSettled(r) would CLOBBER a retained recoverable
      // result (payment_required / expired / terms_changed), collapsing the
      // card to a dead-end with no Add funds / Retry / Get fresh quote button —
      // exactly when the user just topped up and tapped Retry through a blip.
      // The outer catch leaves `settled` untouched, mirroring iOS
      // (PayQuote.swift guard-let-else) and Android (WalletCore.networkFailure).
      const r = await fetch("/api/x402/pay", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote: active.quote, message: active.message ?? "" }),
        // 195s (lib/deadlines), deliberately ABOVE the route's maxDuration=180.
        // Without any deadline `inFlight` never clears and the card is stuck on
        // "Paying…" with no retry; with a SHORTER one we'd abort settlements the
        // server was completing and land in the catch below, which tells the user
        // to try again — inviting a double-pay to a third party. The deadline
        // only fires once the server has provably given up.
        signal: AbortSignal.timeout(deadlineFor("/api/x402/pay")),
      }).then((res) => res.json());
      if (r?.ok) {
        setSettled(r);
        setPhase("paid");
        onSettled?.({ phase: "paid", result: r });
      } else if (r?.already_paid) {
        // 409: this exact quote already settled on-chain (a re-approve after a
        // dropped response, a double-tap that raced, or a retry whose first
        // attempt secretly succeeded). The money DID move — showing "not sent"
        // would be the opposite of the truth and could push the user to pay
        // again. Treat it as paid, not failed. jti makes the server settle once.
        setSettled(r);
        setPhase("paid");
        onSettled?.({ phase: "paid", result: r });
      } else if (r?.pending_confirmation) {
        // The signed authorization LEFT us — the service may have settled it
        // on-chain but didn't confirm in time (202). This is NOT "not sent":
        // retrying could double-pay a third-party. Show an "on its way" state
        // and suppress the retry, mirroring the withdraw card's pending handling.
        setSettled(r);
        setSettleErr(r?.error || "Payment was sent — confirming on-chain.");
        setPhase("pending");
        onSettled?.({ phase: "pending", result: r, error: r?.error || "Payment was sent — confirming on-chain." });
      } else {
        // Keep the failed result — payment_required drives the "Add funds" path
        // below, and the quote is still spendable (an insufficient-balance spend
        // wrote NO ledger row, so a retry after top-up is not a double-charge).
        setSettled(r);
        setSettleErr(r?.error || "The payment could not be completed.");
        setPhase("failed");
      }
    } catch {
      // Transport / parse failure. Deliberately do NOT touch `settled` — a blip
      // during a RETRY (the first attempt already learned it was a funds
      // shortfall / re-quotable) must keep the recovery path visible; the quote
      // moved no money and is still spendable. iOS parity: PayQuote.swift's
      // guard-let-else sets only settleErr/phase and leaves needsFunds/canReQuote.
      setSettleErr("No response — check your connection and try again.");
      setPhase("failed");
    } finally {
      inFlight.current = false; // allow a retry after a recoverable failure
    }
  }

  // ── Terminal: the tool never produced a quote (login/allowlist/parse error).
  if (toolFailed) {
    return (
      <Shell tone={DANGER} icon live="alert">
        <Title tone={DANGER}>Payment not sent</Title>
        <Body>{result?.error || error || "Couldn't prepare the payment."}</Body>
      </Shell>
    );
  }

  // ── Quoting (streaming) — the quote is still being fetched.
  if (quoting) {
    return (
      <Shell tone={ACCENT} spinner>
        <Title tone={ACCENT}>Preparing payment…</Title>
        <Body>Fetching the price over x402…</Body>
      </Shell>
    );
  }

  // ── Paid — the user approved and settlement succeeded. The already_paid (409)
  // path lands here too; it carries only price_micro (no paid_micro/payee/network),
  // so fall back to the bound quote's values — the payee/network the quote fixed
  // are HMAC-identical to what settled, so the receipt shows the full
  // "to 0x… on base" line instead of dropping it (iOS parity: PayQuote.swift
  // approve() already_paid branch reads `r["payee"] ?? active.payee` etc.).
  if (phase === "paid" && settled) {
    const amount = settled.paid_micro || settled.price_micro || active?.price_micro || 0;
    const payee = settled.payee || active?.payee;
    const network = settled.network || active?.network;
    // Not `settled.explorer` raw: explorerHref is what decides this is linkable
    // (http/https and parseable) and explorerLinkLabel names wherever it points —
    // on a self-hosted chain that's the deployment's own explorer, not BaseScan.
    const explorer = explorerHref(settled.explorer);
    return (
      <Shell tone={ACCENT} icon live="status">
        <Title tone={ACCENT}>Payment sent</Title>
        <Body>
          {isTransfer ? "Sent " : "Paid "}<span className="font-semibold" style={{ color: ACCENT.fg }}>{usd(amount)}</span>
          {payee ? <> to <span className="font-mono">{shortAddr(payee)}</span></> : null}
          {network ? <> on {netLabel(network)}</> : null}
          {isTransfer ? " from your wallet." : " over the x402 protocol."}
        </Body>
        {explorer ? (
          <a href={explorer} target="_blank" rel="noopener noreferrer"
            className="inline-block mt-1 text-xs font-semibold no-underline"
            style={{ color: ACCENT.fg }}>
            {explorerLinkLabel(explorer)} →
          </a>
        ) : null}
      </Shell>
    );
  }

  // ── Paying — approved, settlement in flight.
  if (phase === "paying") {
    return (
      <Shell tone={ACCENT} spinner>
        <Title tone={ACCENT}>Sending payment…</Title>
        <Body>{isTransfer ? "Moving the money between wallets — don’t close this." : "Settling USDC over x402 — don’t close this."}</Body>
      </Shell>
    );
  }

  // ── Pending — the payment was SENT but not yet confirmed (202). Not a
  // failure and NOT retryable (a retry could double-pay). Accent, not danger.
  if (phase === "pending") {
    return (
      <Shell tone={ACCENT} icon live="status">
        <Title tone={ACCENT}>Payment sent — confirming</Title>
        <Body>{settleErr || "The payment was sent and is confirming on-chain. It'll be verified shortly — no need to retry."}</Body>
      </Shell>
    );
  }

  // ── Failed settlement after approval.
  if (phase === "failed") {
    // An insufficient-balance failure is recoverable: the quote is still valid
    // (no ledger row was written) so a top-up + retry settles it. Only offer
    // this while the quote hasn't expired — past exp the server 410s the retry.
    // `expired` re-evaluates as the TTL lapses, so a user who leaves this card
    // open while topping up in another tab sees Retry become "Get fresh quote"
    // instead of tapping a Retry the server will refuse.
    const nowExpired = expired;
    const needsFunds = Boolean(settled?.payment_required);
    const stillValid = !nowExpired;
    // Re-quotable dead-ends: the server said the quote expired (410) or the
    // service's terms changed (409, reservation reversed) — or the client-side
    // expiry guard fired. All move no money, so a fresh POST quote is safe.
    // Needs the original url (carried on the tool result) to re-mint.
    const canReQuote = Boolean(active?.url) && (settled?.expired || settled?.terms_changed || (nowExpired && !needsFunds));
    return (
      <Shell tone={DANGER} icon live="alert">
        <Title tone={DANGER}>Payment not sent</Title>
        <Body>{settleErr || "The payment could not be completed."}</Body>
        {needsFunds && stillValid ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <a
              href="/wallet"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-transform hover:scale-105 active:scale-100"
              style={{ background: "var(--tiny-accent)", color: "#000" }}
            >
              💳 Add funds
            </a>
            <button
              onClick={approve}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "#bbb" }}
            >
              ↻ Retry
            </button>
          </div>
        ) : canReQuote ? (
          <div className="mt-2.5">
            <button
              onClick={reQuote}
              disabled={reQuoting}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-transform hover:scale-105 active:scale-100 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed"
              style={{ background: "var(--tiny-accent)", color: "#000" }}
            >
              {reQuoting ? "Getting a fresh quote…" : "↻ Get fresh quote"}
            </button>
          </div>
        ) : null}
      </Shell>
    );
  }

  // ── Declined by the user.
  if (phase === "declined") {
    return (
      <Shell tone={DANGER} icon live="status">
        <Title tone={DANGER}>Payment declined</Title>
        <Body>You declined this payment. Nothing was charged.</Body>
      </Shell>
    );
  }

  // ── A succeeded tool result that carries NO quote means no confirmation is
  // needed — e.g. the target turned out to be free (the x402 POST relayed a 200
  // rather than a 402, so no quote was minted). Render a terminal note. Without
  // this guard we'd fall through to the approval gate below and show a phantom
  // "$0 Approve" whose button is dead (approve() no-ops when result.quote is
  // absent) — an actionable control that does nothing.
  if (!isQuote) {
    return (
      <Shell tone={ACCENT} icon live="status">
        <Title tone={ACCENT}>No payment needed</Title>
        <Body>This service responded without charging — nothing was paid.</Body>
      </Shell>
    );
  }

  // ── Awaiting approval — the default for a fresh quote. THE approval gate.
  // Reads `active` so a client re-minted quote (reQuote) renders in place.
  const price = active?.price_micro || 0;
  // An already-expired quote must not present a live Approve button that
  // dead-ends on tap — flip it to "Get fresh quote" and say so (parity with iOS
  // PayQuoteCard's `.disabled(expired)` + note, and the header contract that an
  // expired quote short-circuits to the right state). `expired` comes from
  // useQuoteExpiry, so this holds for a card that was ALREADY expired at mount
  // (persisted/slow-stream) *and* for one that expires while on screen — the
  // latter used to keep a live Approve button for as long as nothing else
  // re-rendered the card, and the tap then failed the payment card into red.
  // approve() still re-checks against a fresh clock at tap.

  return (
    <Shell tone={ACCENT} icon>
      <Title tone={ACCENT}>Approve payment?</Title>
      <Body>
        This will {isTransfer ? "send" : "pay"} <span className="font-semibold" style={{ color: ACCENT.fg }}>{usd(price)}</span>
        {active?.payee ? <> to <span className="font-mono">{shortAddr(active.payee)}</span></> : null}
        {active?.network ? <> on {netLabel(active.network)}</> : null}
        {isTransfer ? " from your wallet. It only happens when you tap Approve." : " from your wallet, over x402. It only happens when you tap Approve."}
      </Body>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          onClick={expired ? reQuote : approve}
          disabled={reQuoting || (expired && !active?.url)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-transform hover:scale-105 active:scale-100 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed"
          style={{ background: "var(--tiny-accent)", color: "#000" }}
        >
          {expired ? (reQuoting ? "Getting a fresh quote…" : "↻ Get fresh quote") : `✓ Approve ${usd(price)}`}
        </button>
        <button
          onClick={() => { setPhase("declined"); onSettled?.({ phase: "declined" }); }}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border"
          style={{ borderColor: "rgba(255,255,255,0.2)", color: "#bbb" }}
        >
          Decline
        </button>
      </div>
      {expired ? (
        <div className="mt-2 text-xs" style={{ color: DANGER.fg }}>
          This quote expired — get a fresh price to continue.
        </div>
      ) : null}
    </Shell>
  );
}

// ── Small presentational helpers (keep the state machine above readable) ──────
// `live` announces a terminal outcome to assistive tech. This is a MONEY card:
// on the web a plain <div> text-swap is silent to a screen reader (unlike
// SwiftUI/Compose, which announce tree updates), so a blind user who taps
// Approve would never hear whether their payment settled, failed, or is
// pending on-chain. Wrap the outcome states in the repo's house pattern —
// role="status"/aria-live="polite" for a success/pending/declined result,
// role="alert" (assertive) for a failure — matching ActivityHUD/Control/Chat.
// The approval GATE + streaming spinner pass no `live` (the gate is a prompt,
// not a result; the spinner already carries its own role="status").
function Shell({ tone, icon, spinner, live, children }: { tone: typeof ACCENT; icon?: boolean; spinner?: boolean; live?: "status" | "alert"; children: React.ReactNode }) {
  const liveProps = live === "alert"
    ? { role: "alert" as const, "aria-live": "assertive" as const }
    : live === "status"
    ? { role: "status" as const, "aria-live": "polite" as const }
    : {};
  return (
    <div className="px-4 py-3 rounded-xl border animate-riseIn" style={{ background: tone.bg, borderColor: tone.border }} {...liveProps}>
      <div className="flex items-start gap-3">
        {spinner ? (
          <span role="status" aria-label="working" className="inline-block w-4 h-4 rounded-full animate-spin mt-0.5" style={{ border: "2px solid rgba(var(--tiny-accent-rgb),0.3)", borderTopColor: "var(--tiny-accent)" }} />
        ) : icon ? (
          <span className="mt-0.5" style={{ color: tone.fg }} aria-hidden="true"><IconWallet /></span>
        ) : null}
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
function Title({ tone, children }: { tone: typeof ACCENT; children: React.ReactNode }) {
  return <div className="text-sm font-semibold" style={{ color: tone.fg }}>{children}</div>;
}
function Body({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 text-xs text-gray-300 break-words">{children}</div>;
}
