/**
 * 💸 Self-serve withdrawals (fully automatic, no approval) — worker half.
 *
 * The worker owns the LEDGER state machine; the app's Node route owns the
 * SIGNING (viem + PAYOUT_PRIVATE_KEY, never here). Flow:
 *
 *   1. POST /pay/withdraw-request  { userId, amount_micro, network? }
 *      → atomic batch: ledger debit (withdrawal, -gross) + pending row.
 *        Destination is FORCED to the user's linked address — no
 *        model/client-supplied address can redirect funds.
 *   2. App signs + broadcasts USDC transfer of (gross - fee).
 *   3. POST /pay/withdraw-complete { id, txHash } → status=paid
 *      POST /pay/withdraw-fail     { id, error }  → status=failed +
 *      compensating refund row (idempotent via UNIQUE ledger index).
 *
 * Limits: min $1, max $500/day per user (velocity cap — a compromised
 * session can't drain a whale account in one shot), flat WITHDRAW_FEE
 * ($0.10) covers gas.
 */
import { OpenAPIRoute } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import {
  isAddress, normalizeNetwork, isTrialNetwork,
  TRIAL_COUNTERPARTY_SQL_LIST, TRIAL_DEPOSITS_SUM_SQL,
} from "./deposits";
import { notifyMoney } from "./money-events";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const unauthorized = () => json({ error: "unauthorized" }, 401);

export const WITHDRAW_FEE_MICRO = 100_000;        // $0.10 flat (covers gas)
export const WITHDRAW_MIN_MICRO = 1_000_000;      // $1 minimum
export const WITHDRAW_DAILY_CAP_MICRO = 500_000_000; // $500/day/user

/**
 * The atomic debit. Balance guard + daily-cap guard + trial exclusion all live
 * INSIDE the write (see the long note at the call site) — and the trial
 * exclusion comes from deposits.ts's shared TRIAL_DEPOSITS_SUM_SQL, the SAME
 * fragment payments.ts's outbound-spend guard uses, so adding a trial network
 * can't leave one real-value exit open while closing the other. The IN-list
 * inside it interpolates module constants only (never request input); the money
 * values stay bound parameters.
 *
 * Exported so tests can run the real statement against real sqlite.
 */
export const WITHDRAW_DEBIT_SQL =
  `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
   SELECT ?1, ?2, 'withdrawal', ?3, 'chain:' || ?4
   WHERE (SELECT COALESCE(SUM(delta_micro),0) FROM ledger WHERE user_id = ?1)
         - ?5 * ${TRIAL_DEPOSITS_SUM_SQL}
         >= ?6
     AND COALESCE((SELECT SUM(amount_micro) FROM withdrawals WHERE user_id = ?1 AND status != 'failed' AND created > unixepoch() - 86400),0) + ?6 <= ?7`;

/**
 * The excluded total the error path reports — **the same expression the debit
 * subtracts**, which is the whole point and was NOT true before c35.
 *
 * ⚠️ It must be `TRIAL_DEPOSITS_SUM_SQL` itself, not a hand-written copy of one
 * of its terms. This statement used to spell out only the DEPOSIT half:
 *
 *     SUM(delta_micro) … kind='deposit' AND counterparty IN (…)
 *
 * while the debit above subtracts deposits **+ taint** (migration 0024's
 * `trial_taint`, the value trial money carried to somebody ELSE's balance). For
 * a payee whose earnings are tainted, the two disagreed — and the report was the
 * loose one, so it over-promised. Measured, $2.00 of tainted `invoke_credit` and
 * nothing else: the debit refuses $1.50, and the reported figure was $2.00.
 *
 * That figure is not diagnostic decoration. `app/api/wallet/withdraw` turns this
 * ONE error into the sentence all three clients render, and it branches on
 * `balance > withdrawable` to decide whether to say "trial credits aren't
 * withdrawable". With the taint term missing, `balance === withdrawable`, so the
 * user was told **"You can withdraw $2.00 right now. Lower the amount or add
 * funds."** — a figure that is refused, advice that cannot succeed at any amount,
 * and the one explanation that would have made sense suppressed. A tainted payee
 * could only conclude the payout was broken.
 *
 * Keyed on `?1` because the shared fragment is (every guarded statement here
 * binds the user id there); the call site binds positionally to match.
 */
export const TRIAL_EXCLUDED_SQL =
  `SELECT ${TRIAL_DEPOSITS_SUM_SQL} AS v`;

/**
 * @deprecated The DEPOSIT half alone — kept only because it is the honest name
 * for what it computes. Never use it to report withdrawable balance: it omits
 * the taint term the debit enforces. Prefer `TRIAL_EXCLUDED_SQL`.
 */
export const TRIAL_BALANCE_SQL =
  `SELECT COALESCE(SUM(delta_micro),0) AS v FROM ledger WHERE user_id = ? AND kind='deposit' AND counterparty IN (${TRIAL_COUNTERPARTY_SQL_LIST})`;

/**
 * ⏳ HOW LONG A `pending` WITHDRAWAL CAN HONESTLY BE CALLED "IN FLIGHT".
 *
 * ⚠️ NOTHING IN THIS PLATFORM EVER LOOKS AT A `pending` ROW AGAIN. Grep for
 * `FROM withdrawals`: the daily-cap subquery, the two guarded UPDATEs, and
 * nothing else. There is no sweep, no alarm and no cron — the row is advanced
 * ONLY by the one HTTP request that created it (`app/api/wallet/withdraw`), whose
 * `maxDuration` is 60s and whose receipt wait is 45s. So once that request is
 * over, `pending` does not mean "still working". It means **abandoned**, and it
 * is the terminal state of a row that already DEBITED the user's ledger.
 *
 * Both reachable paths are ordinary, not exotic:
 *   • `tx_hash IS NULL` — the debit committed and the payout never went out
 *     (the route's own `.catch()` on /pay/withdraw-fail leaves a comment saying
 *     "visible in withdrawals table for repair"; nothing was ever built to look).
 *     The user is simply DOWN the money until a human notices.
 *   • `tx_hash IS NOT NULL` — the 202 `pending_confirmation` path: broadcast, but
 *     the receipt timed out. Deliberately never auto-refunded (that would
 *     double-pay a landing tx) and explicitly handed to "reconciliation to
 *     resolve" — a reconciler that does not exist for this table.
 *
 * 15 minutes: comfortably past the 60s request ceiling and the 45s receipt wait,
 * so a withdrawal genuinely in progress can never be reported as stuck, while a
 * row nobody will ever touch again surfaces within one alarm cycle.
 */
export const WITHDRAWAL_STUCK_S = 15 * 60;

/**
 * The stuck-withdrawal census, split by the ONE distinction a human acts on.
 *
 * Grouped rather than totalled because the two cases need opposite hands:
 * `tx_hash IS NULL` is a refund (nothing left the payout wallet, so paying it
 * back is safe); a hash present means CHECK THE CHAIN FIRST, since refunding a
 * transfer that confirmed pays the user twice out of platform float — the exact
 * rule the route's `txHash`-gated catch is built around. A single "N stuck"
 * number would invite the dangerous half of that pair.
 *
 * `updated`, not `created`: the guarded UPDATEs stamp it, so this measures time
 * since anything last happened to the row rather than since the user asked.
 * Money stays in SQL. Exported so the status reader runs THIS statement rather
 * than a lookalike — the same reason `deposits.ts` owns `claimed_txs`.
 */
export const WITHDRAWALS_STUCK_SQL =
  `SELECT (tx_hash IS NOT NULL AND tx_hash != '') AS broadcast,
          COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS micro,
          MIN(updated) AS oldest
     FROM withdrawals
    WHERE status = 'pending' AND COALESCE(updated, created) <= ?1
    GROUP BY broadcast`;

/**
 * 💸 What the withdrawal rail looks like to an operator. Read-only, zero RPC.
 *
 * ⚠️ `null`, NOT `0`, when the table cannot be read — migration 0015 may be absent
 * on a deployment running ahead of its schema, and reporting a calm zero for the
 * deployment least able to pay anyone is the `settle_unknown` mistake c62 named.
 * `present` carries "I could look"; the counts carry what was there.
 *
 * The shape mirrors the two x402 queues so the pager can treat all three rails
 * the same way — except that there is no `open` here on purpose: a withdrawal
 * inside its 15-minute window is invisible to this report, because depth is not
 * distress and a payout in flight is the healthy state.
 */
export async function withdrawalsStatus(env: any, nowSec: number): Promise<any> {
  const out: any = {
    present: false, stuck: null, stuck_micro: null, oldest_stuck_age_s: null,
    // Nothing was broadcast: safe to refund, and the user is currently down the money.
    unbroadcast: null, unbroadcast_micro: null,
    // Broadcast and never confirmed: verify on-chain BEFORE touching the ledger.
    broadcast_unconfirmed: null, broadcast_unconfirmed_micro: null,
    stuck_after_s: WITHDRAWAL_STUCK_S,
  };
  let rows: any[];
  try {
    const res = await env.DB.prepare(WITHDRAWALS_STUCK_SQL)
      .bind(Math.floor(Number(nowSec) || 0) - WITHDRAWAL_STUCK_S).all();
    rows = res?.results || [];
  } catch (err: any) {
    out.error = String(err?.message || err).slice(0, 200);
    return out;
  }
  out.present = true;
  out.unbroadcast = 0; out.unbroadcast_micro = 0;
  out.broadcast_unconfirmed = 0; out.broadcast_unconfirmed_micro = 0;
  let oldest: number | null = null;
  for (const r of rows) {
    const n = Number(r?.n || 0);
    const micro = Number(r?.micro || 0);
    // SQLite yields 1/0 for the boolean expression; Number() covers both it and a
    // driver that hands back true/false.
    if (Number(r?.broadcast)) { out.broadcast_unconfirmed += n; out.broadcast_unconfirmed_micro += micro; }
    else { out.unbroadcast += n; out.unbroadcast_micro += micro; }
    const o = r?.oldest == null ? null : Number(r.oldest);
    if (o != null && (oldest == null || o < oldest)) oldest = o;
  }
  out.stuck = out.unbroadcast + out.broadcast_unconfirmed;
  out.stuck_micro = out.unbroadcast_micro + out.broadcast_unconfirmed_micro;
  out.oldest_stuck_age_s = oldest == null ? null : Math.max(0, Math.floor(Number(nowSec) || 0) - oldest);
  return out;
}

/** POST /pay/withdraw-request (internal) — atomic debit + pending row */
export class WithdrawRequestCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: request a withdrawal (atomic debit)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId } = body;
    const amount = Math.floor(Number(body.amount_micro));
    // Shared with deposits so a claim and a withdrawal can never disagree about
    // what network a request names (the old `=== 'base-sepolia' ? … : 'base'`
    // coerced 'tiny' to 'base', which would have recorded a self-hosted-chain
    // payout as a mainnet one).
    const network = normalizeNetwork(env, body.network);
    if (!userId) return json({ error: "userId required" }, 400);
    if (!Number.isFinite(amount) || amount < WITHDRAW_MIN_MICRO) {
      return json({ error: `minimum withdrawal is $${WITHDRAW_MIN_MICRO / 1_000_000}` }, 400);
    }

    // Destination: the user's linked address ONLY (same binding as deposits)
    const wallet = await env.DB.prepare("SELECT address FROM wallets WHERE user_id = ?").bind(String(userId)).first();
    if (!wallet?.address || !isAddress(String(wallet.address))) {
      return json({ error: "link a wallet address first (it becomes your withdrawal destination)" }, 400);
    }

    const id = crypto.randomUUID();
    const net = amount - WITHDRAW_FEE_MICRO;
    if (net <= 0) return json({ error: "amount does not cover the withdrawal fee" }, 400);

    // 🧪 Trial credits are NOT withdrawable as real money: a REAL-network payout
    // subtracts unspent trial deposits (Base Sepolia + the self-hosted tiny-chain,
    // whose USDC we mint ourselves) from withdrawable balance. `trialFactor`
    // folds the split into one guarded statement — 1 on a real network, 0 on a
    // trial network (where paying out trial USDC costs nobody anything).
    // Generalized from `network === 'base' ? 1 : 0`: with 'tiny' added, that
    // literal would have exempted tiny payouts from the exclusion, letting minted
    // TinyUSDC deposits be drained as real USDC on a mixed deployment.
    const trialFactor = isTrialNetwork(network) ? 0 : 1;

    // ATOMIC: debit + platform fee + pending row in ONE batch — AND the
    // balance/daily-cap guard lives INSIDE the debit as a conditional
    // INSERT…SELECT…WHERE, not a separate pre-read. A prior SELECT-then-batch
    // was a check-then-act TOCTOU: two concurrent withdraw requests (same
    // session) both read the pre-debit balance, both passed, both debited AND
    // both broadcast real USDC — overdrawing the account below zero and past
    // the $500/day cap (D1 serializes writes but NOT a read that precedes a
    // later write, so the batches interleave). Evaluating the guard within the
    // batch makes the check and the debit one atomic write: the second request
    // sees the first's debit and its WHERE fails → 0 rows. The fee + pending
    // rows gate on the debit row existing, so the batch is all-or-nothing.
    let debited = false;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(WITHDRAW_DEBIT_SQL)
          .bind(String(userId), -amount, id, network, trialFactor, amount, WITHDRAW_DAILY_CAP_MICRO),
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT 'platform', ?1, 'platform_fee', ?2, ?3
           WHERE EXISTS (SELECT 1 FROM ledger WHERE ref = ?2 AND kind='withdrawal' AND user_id = ?3)`
        ).bind(WITHDRAW_FEE_MICRO, id, String(userId)),
        env.DB.prepare(
          `INSERT INTO withdrawals (id, user_id, amount_micro, fee_micro, to_address, network)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE EXISTS (SELECT 1 FROM ledger WHERE ref = ?1 AND kind='withdrawal' AND user_id = ?2)`
        ).bind(id, String(userId), amount, WITHDRAW_FEE_MICRO, String(wallet.address), network),
      ]);
      debited = Number(results?.[0]?.meta?.changes || 0) > 0;
    } catch (err: any) {
      console.log(err, "withdraw-request batch");
      return json({ error: "withdrawal request failed" }, 500);
    }

    // The debit's WHERE failed → insufficient balance or over the daily cap.
    // Recompute (post-facto, no race concern — purely to pick the right error)
    // so the caller still gets the specific reason and balance figures.
    if (!debited) {
      const [balRow, trialRow, dayRow] = await Promise.all([
        env.DB.prepare("SELECT COALESCE(SUM(delta_micro),0) AS v FROM ledger WHERE user_id = ?").bind(String(userId)).first(),
        // The SAME exclusion the debit just enforced (deposits + taint), not the
        // deposit half of it — see TRIAL_EXCLUDED_SQL. Reporting the looser term
        // told a tainted payee they could withdraw a sum the debit refuses.
        env.DB.prepare(TRIAL_EXCLUDED_SQL).bind(String(userId)).first(),
        env.DB.prepare("SELECT COALESCE(SUM(amount_micro),0) AS v FROM withdrawals WHERE user_id = ? AND status != 'failed' AND created > unixepoch() - 86400").bind(String(userId)).first(),
      ]);
      const balance = Number(balRow?.v || 0);
      // `trialFactor`, not a second `isTrialNetwork(network)` read: the reported
      // figure has to be the debit's own arithmetic, and the debit multiplies the
      // exclusion by exactly this. Re-deriving it is how the two halves drift.
      const withdrawable = Math.max(0, balance - trialFactor * Number(trialRow?.v || 0));
      if (Number(dayRow?.v || 0) + amount > WITHDRAW_DAILY_CAP_MICRO) {
        return json({ error: `daily withdrawal cap is $${WITHDRAW_DAILY_CAP_MICRO / 1_000_000}` }, 429);
      }
      return json({ error: "insufficient_withdrawable_balance", balance_micro: balance, withdrawable_micro: withdrawable }, 400);
    }

    return json({
      ok: true, id,
      to_address: String(wallet.address),
      network,
      gross_micro: amount,
      fee_micro: WITHDRAW_FEE_MICRO,
      net_micro: net,
    });
  }
}

/** POST /pay/withdraw-complete (internal) { id, txHash } */
export class WithdrawCompleteCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: mark a withdrawal paid" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { id, txHash } = body;
    if (!id || !txHash) return json({ error: "id, txHash required" }, 400);
    const r = await env.DB.prepare(
      "UPDATE withdrawals SET status = 'paid', tx_hash = ?, updated = unixepoch() WHERE id = ? AND status = 'pending'"
    ).bind(String(txHash), String(id)).run();
    if (!r.meta?.changes) return json({ error: "not found or not pending" }, 404);

    // ✅ TELL THEM IT LANDED. Read the row AFTER the guarded UPDATE, never before:
    // `status = 'pending'` in the WHERE is what makes this handler idempotent, and
    // exactly one caller can flip it, so only the winner reaches here and only the
    // winner notifies. A pre-read would have been a second race on the same row.
    //
    // The amount announced is the NET — gross minus the fee — because that is the
    // number that will appear in their wallet. Saying the gross would overstate
    // what arrived by $0.10 on a message whose whole job is "the money is real now".
    const w: any = await env.DB.prepare(
      "SELECT user_id, amount_micro, fee_micro, network FROM withdrawals WHERE id = ?"
    ).bind(String(id)).first().catch(() => null);
    if (w) {
      await notifyMoney(env, String(w.user_id), {
        kind: "pay_withdrawn",
        micro: Math.max(0, Number(w.amount_micro) - Number(w.fee_micro)),
        network: normalizeNetwork(env, w.network),
      });
    }
    return json({ ok: true });
  }
}

/** POST /pay/withdraw-fail (internal) { id, error } — refund the debit */
export class WithdrawFailCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: fail a withdrawal and refund" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { id } = body;
    if (!id) return json({ error: "id required" }, 400);

    const w = await env.DB.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").bind(String(id)).first();
    if (!w) return json({ error: "not found or not pending" }, 404);

    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE withdrawals SET status = 'failed', error = ?, updated = unixepoch() WHERE id = ? AND status = 'pending'"
        ).bind(String(body.error || "broadcast failed").slice(0, 300), String(id)),
        // Compensating refund of the FULL gross (fee returns too — the
        // user paid for a service that didn't happen)
        env.DB.prepare(
          "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'refund', ?, 'platform')"
        ).bind(String(w.user_id), Number(w.amount_micro), String(id)),
        env.DB.prepare(
          "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('platform', ?, 'refund', ?, ?)"
        ).bind(-Number(w.fee_micro), `fee-${id}`, String(w.user_id)),
      ]);
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) return json({ ok: true, already_refunded: true });
      console.log(err, "withdraw-fail batch");
      return json({ error: "refund failed — MANUAL ATTENTION" }, 500);
    }

    // ↩️ THE ONE THAT MUST BE SENT. The debit already happened at request time and
    // is visible in the wallet; the refund above puts it back. A user who saw money
    // leave and then heard nothing has watched it disappear — silence here reads as
    // loss, which is the single worst thing a wallet can imply. The FULL gross is
    // announced (fee included) because that is what came back.
    await notifyMoney(env, String(w.user_id), {
      kind: "pay_refunded",
      micro: Number(w.amount_micro),
      network: normalizeNetwork(env, w.network),
      // Already length-capped at the DB write above; capped again here because the
      // push body is the copy's, not the ledger's, and a 300-char reason would bury
      // the sentence that says nothing was lost.
      reason: String(body.error || "").trim().slice(0, 80) || undefined,
    });
    return json({ ok: true, refunded_micro: Number(w.amount_micro) });
  }
}
