/**
 * 💵 Money events — the rail that told the user when money moved.
 *
 * ⚠️ WHY THIS FILE EXISTS. Before it, `payments.ts`, `deposits.ts` and
 * `withdrawals.ts` — 3,400 lines, every path that moves real value — contained
 * ZERO calls to `emitEvent`, `sendPushToUser` or any other notification. Grep
 * them; that is how this was found. Meanwhile `visit.ts` gives a PAGE VIEW a
 * ring event, a throttled web push AND a social-graph edge.
 *
 * So: someone looking at your tiny pinged your phone. Someone paying you real,
 * withdrawable USDC was silent. The money arrived correctly — the ledger work in
 * payments.ts is the most carefully-guarded code in the repo — and then nobody
 * was told. You found out by opening /wallet on a hunch.
 *
 * Four moments now speak, chosen because each is a fact the user cannot infer:
 *   1. someone paid you        (invoke_credit — you EARNED, possibly real money)
 *   2. someone sent you money  (transfer_credit — P2P, a person chose to)
 *   3. your withdrawal landed  (a real on-chain tx; the money has LEFT us)
 *   4. your withdrawal failed  (and was refunded — otherwise it reads as loss)
 *
 * DELIBERATELY SILENT: your own spend (you initiated it and the UI already
 * confirmed it), the faucet drip (you tapped a button and watched it), and the
 * platform-fee rows (not the user's money). A rail that fires on everything
 * teaches people to ignore it — c19's rule about severity that reads as noise.
 *
 * ── Design rules this file obeys ────────────────────────────────────────────
 *
 * 🔑 NEVER LIE ABOUT WHAT THE MONEY IS. On a trial deployment (base-sepolia, or
 * our own `tiny` chain) a balance is NOT withdrawable, and `economyBlock` in the
 * web prompt goes to real lengths to stop the agent claiming otherwise. A push
 * saying "you earned $0.02" that turns out to be unspendable play money is worse
 * than no push, so `moneyEventText` takes the network and says "trial credit"
 * when that is what it is. The caller passes the network it actually settled on;
 * this module has no second opinion about it (the c42 delegation rule).
 *
 * 🔑 EVERY RAIL IS ISOLATED. `emitEvent` already swallows its own errors, and the
 * push leg is wrapped separately, because a Telegram/VAPID outage must not fail a
 * settle that has ALREADY MOVED MONEY. The ledger write is the source of truth;
 * notification is strictly downstream of it. `notifyMoney` therefore returns a
 * report and never throws — it is called AFTER the batch, never inside it.
 *
 * 🔑 THE TEXT IS PURE AND TESTED. `moneyEventText` does no I/O so the copy can be
 * asserted directly (tests/money-events.test.ts) — including the four things a
 * money notification must never do: round a real amount to $0.00, call trial
 * credit withdrawable, name a counterparty we didn't verify, or claim a chain.
 */
import { emitEvent } from "./events";
import { sendPushToUser } from "./push";
import { isTrialNetwork, type PayNetwork } from "./deposits";

/**
 * The four kinds. These strings are a PUBLISHED CONTRACT, not internal labels:
 * they land on the user's event ring and every client maps them to a glyph.
 *
 * ⚠️ Adding a kind here means adding it to the roster in the web repo's
 * `lib/chat/event-icons.ts` (`EMITTED_KINDS`) and its Swift/Kotlin mirrors, or
 * it renders as ⚡ — indistinguishable from a corrupt event — on all three HUDs
 * and as ℹ ("informational") in the agent's own prompt. That is not a
 * hypothetical: `pay_alarm` shipped that way and the roster exists because of it.
 */
export const MONEY_EVENT_KINDS = ["pay_earned", "pay_received", "pay_withdrawn", "pay_refunded"] as const;
export type MoneyEventKind = (typeof MONEY_EVENT_KINDS)[number];

export interface MoneyEvent {
  kind: MoneyEventKind;
  /** Micro-USDC, always POSITIVE — the direction is carried by `kind`, not the
   *  sign, so a copy bug can't render "you earned $-0.02". */
  micro: number;
  /** The chain this actually settled on. Decides real-money vs trial wording. */
  network: PayNetwork;
  /** GitHub login of the other party, WITHOUT the @. Omit when unverified: the
   *  copy falls back to "someone", which is honest, rather than naming an id. */
  who?: string;
  /** For pay_earned: the tiny slug that earned it, so the text can say WHICH. */
  slug?: string;
  /** For pay_refunded: the reason the withdrawal failed, already truncated. */
  reason?: string;
  /**
   * TRUE when this credit was marked trial-class by TAINT_INVOKE_SQL /
   * TAINT_TRANSFER_SQL — i.e. the payer could only have paid from faucet money,
   * so the payee's new credit is excluded from both real-value exits.
   *
   * ⚠️ This is why `network` alone is NOT enough to decide the wording. On a
   * MAINNET deployment (`network: 'base'`, so `isTrialNetwork` is false) a
   * tainted credit still cannot be withdrawn. Calling it "real USDC,
   * withdrawable" would be the exact lie this module exists to prevent, and the
   * taint row is the only place that fact lives. The settle batch already
   * reports it (the TAINT statement's `changes`), so the caller passes what the
   * ledger decided rather than this module guessing.
   */
  tainted?: boolean;
}

/**
 * Micro-USDC → a string that never rounds real money to nothing.
 *
 * The trap: prices start at $0.001 (`set_price`'s floor, and the flat platform
 * fee), so `toFixed(2)` renders a real earning as "$0.00" — a notification that
 * says you were paid nothing. Four decimals for anything under a dollar, two
 * above it (nobody wants "$12.5000"), and never fewer digits than the amount
 * needs. Mirrors reconcile-alarm.ts's `$${(x / 1e6).toFixed(4)}` choice.
 *
 * ⚠️ FOUR decimals is not enough either, and the shortfall is reachable: the
 * owner's cut is `price - fee`, so a price of $0.001001 credits ONE micro, which
 * `toFixed(4)` rounds to "0.0000" and the zero-strip turns into "$0" — the same
 * lie as "$0.00", one decimal place further out. So sub-dollar amounts render at
 * SIX decimals, which is not a safety margin but the ledger's own resolution: a
 * micro is the smallest thing the schema can hold, so six digits is exactly
 * lossless and no amount can round to nothing. Trailing zeros then come off, so
 * the common cases still read as "$0.01" / "$0.0125" rather than "$0.010000".
 */
export function formatMicro(micro: number): string {
  const n = Math.abs(Number(micro) || 0) / 1_000_000;
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * Is this money actually withdrawable? The ONE predicate the copy branches on.
 *
 * Two independent reasons it isn't: the whole deployment is a trial chain, OR
 * this specific credit carries a taint row (a mainnet payee paid from faucet
 * money). Either one alone makes "withdrawable" false, which is why this is an
 * OR and not a network check — a mainnet-only test would pass while shipping the
 * lie on the tainted path.
 */
export function isSpendableOnly(e: Pick<MoneyEvent, "network" | "tainted">): boolean {
  return isTrialNetwork(e.network) || e.tainted === true;
}

/**
 * The wording for "what kind of money is this", and the ONLY place that decides
 * it. A balance that can't be withdrawn must not be called plain USDC — saying
 * "you earned" without that qualification is the lie this guards against.
 */
function moneyNoun(e: Pick<MoneyEvent, "network" | "tainted">): string {
  return isSpendableOnly(e) ? "trial credit" : "USDC";
}

/**
 * `who` → display text. Unverified/absent → "Someone", never a raw user id.
 *
 * ⚠️ A uuid IS a syntactically valid GitHub login: `crypto.randomUUID()` is 36
 * characters of alphanumerics and single hyphens, no leading or trailing hyphen,
 * under the 39-char limit. So the login shape alone does NOT reject a raw user
 * id — the exact thing this function exists to keep out of a push — and a
 * `loginOf` that ever returned an id-shaped fallback would sail straight through.
 * Hence the explicit uuid veto: shape-checking cannot distinguish these two, so
 * the one that must never ship is named. GitHub also forbids consecutive hyphens,
 * which the anchored pattern now enforces.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;
function whoText(who?: string): string {
  const clean = String(who || "").trim().replace(/^@/, "");
  if (UUID_RE.test(clean) || !LOGIN_RE.test(clean)) return "Someone";
  return `@${clean}`;
}

export interface MoneyEventText {
  /** Ring detail — one line, reads as history in the activity feed. */
  detail: string;
  /** Push title + body + the page that answers the question it raises. */
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * The copy. Pure: no env, no I/O, no clock — so every string below is asserted
 * in tests rather than eyeballed in production.
 *
 * `url` is always `/wallet` because that is the page that can answer "is it
 * really there?", which is the only question any of these four raise. `tag`
 * collapses a burst per kind so ten payments in a minute don't stack ten
 * banners — the ring keeps all ten, the push is a nudge (visit.ts's split).
 */
export function moneyEventText(e: MoneyEvent): MoneyEventText {
  const amount = formatMicro(e.micro);
  const noun = moneyNoun(e);
  const who = whoText(e.who);
  const on = e.slug ? ` on /${e.slug}` : "";
  const spendableOnly = isSpendableOnly(e);

  switch (e.kind) {
    case "pay_earned":
      return {
        detail: `${who} paid ${amount} ${noun}${on}`,
        title: `💵 You earned ${amount}`,
        body: `${who} paid to use your tiny${on}. ${spendableOnly
          ? "This is trial credit — spendable on this deployment, NOT withdrawable."
          : "Real USDC, withdrawable from your wallet."}`,
        url: "/wallet",
        tag: "money-earned",
      };
    case "pay_received":
      return {
        detail: `${who} sent you ${amount} ${noun}`,
        title: `🤝 ${who} sent you ${amount}`,
        body: spendableOnly
          ? `Trial credit — spendable on this deployment, NOT withdrawable.`
          : `Real USDC — it's in your balance now.`,
        url: "/wallet",
        tag: "money-received",
      };
    case "pay_withdrawn":
      return {
        detail: `withdrawal of ${amount} paid out on-chain`,
        title: `✅ ${amount} is on its way`,
        body: `Your withdrawal was broadcast to the chain and is on its way to your wallet address.`,
        url: "/wallet",
        tag: "money-withdrawn",
      };
    case "pay_refunded":
      // The one that MUST be sent. A failed withdrawal already debited the
      // balance and then refunded it; a user who saw the debit and nothing else
      // has watched money disappear. Silence here reads as loss.
      return {
        detail: `withdrawal of ${amount} failed and was refunded${e.reason ? ` (${e.reason})` : ""}`,
        title: `↩️ ${amount} came back`,
        body: `Your withdrawal couldn't be sent, so the full amount — including the fee — is back in your balance. Nothing was lost.${e.reason ? ` Reason: ${e.reason}` : ""}`,
        url: "/wallet",
        tag: "money-refunded",
      };
  }
}

/**
 * userId → GitHub login, or undefined. Never throws and never falls back to the
 * id: a notification that says "@8f3c-…-a01 paid you" is worse than "Someone",
 * and `whoText` rejects an id-shaped string anyway. One indexed point read on a
 * path that has already committed a batch, so the cost is irrelevant; the
 * failure mode (missing row, D1 hiccup) degrades to the honest wording.
 */
export async function loginOf(env: any, userId: string): Promise<string | undefined> {
  try {
    const row: any = await env.DB.prepare("SELECT github_login FROM users WHERE id = ?")
      .bind(String(userId)).first();
    const login = String(row?.github_login || "").trim();
    return login || undefined;
  } catch (err) {
    console.log(err, "loginOf");
    return undefined;
  }
}

/**
 * Emit + push, both legs isolated. Returns a report; NEVER throws.
 *
 * Call this AFTER the ledger batch has committed, never inside it: money that
 * moved must not be rolled back because a push endpoint was down, and a user
 * notified about a settle that then failed is worse than a late notification.
 */
export async function notifyMoney(
  env: any,
  userId: string,
  e: MoneyEvent,
): Promise<{ ringAttempted: boolean; push: number }> {
  const out = { ringAttempted: false, push: 0 };
  // Skip a zero-value event rather than telling someone they earned $0 — a free
  // or self invocation reaches here as 0 on some paths.
  if (!Number(e.micro) || !userId) return out;
  const text = moneyEventText(e);
  // ⚠️ `ringAttempted`, NOT `ring`. `emitEvent` catches its own errors and
  // returns void — so a `try` around it can only ever succeed, and a field named
  // `ring` would report TRUE with D1 face-down and the row never written. The
  // caller has no way to tell the difference, which makes a confident `ring: true`
  // strictly worse than no field: it is the same "an all-clear narrower than its
  // wording" shape as the alarm this loop found in c27. The try/catch stays
  // (defence if emitEvent ever rethrows); the NAME is what carries the truth.
  try {
    await emitEvent(env, String(userId), e.kind, text.detail);
    out.ringAttempted = true;
  } catch (err) {
    console.log(err, `notifyMoney ring ${e.kind}`);
  }
  try {
    const r = await sendPushToUser(env, String(userId), {
      title: text.title,
      body: text.body,
      url: text.url,
      tag: text.tag,
    });
    out.push = Number(r?.sent || 0) + Number(r?.relayed || 0);
  } catch (err) {
    console.log(err, `notifyMoney push ${e.kind}`);
  }
  return out;
}
