/**
 * 💸 Payments — ledger-core (docs/payments-x402-erc8004.md PR1).
 *
 * Balance = SUM(ledger.delta_micro), micro-USDC (1e6 = $1). All money paths
 * are INTERNAL (X-Internal-Key) except the read-only public price lookup.
 *
 * Invariants (trust-boundary rules §6 of the design doc):
 *  - Ledger writes happen ONLY in a single D1 batch() — atomic. A partial
 *    debit (debit lands, credit doesn't) is stolen money.
 *  - Idempotency: /pay/invoke requires a ref (invocation id). The partial
 *    UNIQUE index (user_id, kind, ref) makes retries no-ops, detected and
 *    reported as already_settled instead of double-charging.
 *  - The flat platform fee (PLATFORM_FEE_MICRO) applies per PAID invocation,
 *    never as a percentage: price 0 = free = no ledger rows at all.
 */
import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import {
  TRIAL_DEPOSITS_SUM_SQL, isTrialNetwork, normalizeNetwork,
  namedNetwork, defaultNetwork, counterpartyFor,
  reserveTx, releaseTx, claimedTxHolders, isTxHash, isAddress,
  authorizationRedeemed, authorizationFate, blockNumber, type PayNetwork,
} from "./deposits";
import { alarmView } from "./reconcile-alarm";
import { notifyMoney, loginOf } from "./money-events";
// The withdrawal rail's own reader. Imported straight (not lazily like
// reconcile-alarm's back-import) because withdrawals.ts imports deposits +
// money-events and NEVER this file, so there is no cycle to break.
import { withdrawalsStatus } from "./withdrawals";

export const PLATFORM_FEE_MICRO = 1000; // $0.001 flat per paid invocation
const MAX_PRICE_MICRO = 100_000_000;    // $100/invocation sanity cap

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const unauthorized = () => json({ error: "unauthorized" }, 401);

/** Pure: compute the three-way split for a paid invocation. */
export function splitInvoke(priceMicro: number, feeMicro: number = PLATFORM_FEE_MICRO) {
  const price = Math.floor(priceMicro);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Fee can never exceed the price — tiny prices below the fee pay it all
  // to the platform (owner gets 0) rather than going negative.
  const fee = Math.min(Math.floor(feeMicro), price);
  return { debit: -price, ownerCredit: price - fee, fee };
}

/**
 * 🧪→🧪 How much of a just-settled invocation could ONLY have come from trial
 * money — the amount to taint the PAYEE with (migration 0024).
 *
 * Evaluated after the debit row exists (a later statement in a D1 batch sees the
 * earlier ones), so it reads the payer's POST-debit state:
 *
 *   trialTerm − balance   = how far the payer's remaining balance has fallen
 *                           below the trial value they hold. Positive means real
 *                           money could not have covered this payment.
 *
 * Capped at ?4 (the payee's credit — they can't pass on more than they got) and
 * skipped entirely when ≤ 0, which is the overwhelmingly common case: a payer
 * with real balance to spare taints nobody.
 *
 * `trialTerm` is the SHARED fragment, so it already counts taint the payer
 * themselves received — relaying trial money through a chain of accounts gains
 * nothing, each hop passes the taint along.
 */
const TAINT_MICRO_EXPR =
  `MIN(?4, ${TRIAL_DEPOSITS_SUM_SQL} - COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1),0))`;

/**
 * The taint row, written in the SAME batch as the invoke settle.
 *
 * Bindings: ?1 payer (the placeholder the shared fragment requires), ?2 ref,
 * ?3 payee, ?4 the payee's credit. Contiguous and all referenced — a statement
 * that binds a placeholder it never uses is rejected outright by some drivers.
 *
 * OR IGNORE + the (user, kind, ref) unique index is the idempotency guard: a
 * retried /pay/invoke is already a ledger no-op and must be one here too, or the
 * retry would double-taint the payee. Gating on the debit row (EXISTS) keeps the
 * batch all-or-nothing — no taint without a settlement.
 *
 * Concurrency note: two simultaneous paid sends from one payer (distinct refs, so
 * the unique index does NOT serialize them) can both read a post-debit state that
 * already includes the other's debit, over-tainting. That is the safe direction —
 * the same deliberate conservatism as the deposit term, which assumes the real
 * dollars stayed. Trial money over-excluded costs nobody real value; under-
 * excluded it becomes real USDC.
 */
export const TAINT_INVOKE_SQL =
  `INSERT OR IGNORE INTO trial_taint (user_id, micro, kind, ref)
   SELECT ?3, ${TAINT_MICRO_EXPR}, 'invoke', ?2
   WHERE ${TAINT_MICRO_EXPR} > 0
     AND EXISTS (SELECT 1 FROM ledger WHERE user_id = ?1 AND kind='invoke_debit' AND ref = ?2)`;

/** Pure: validate a resource key. 'tiny:<slug>' | 'tool:<login>/<name>' */
export function validResource(resource: string): boolean {
  return /^tiny:[a-z0-9-]{1,64}$/.test(resource) || /^tool:[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9_-]{1,64}$/.test(resource);
}

/** Max a single P2P transfer can move — same $100 ceiling as MAX_PRICE_MICRO. */
export const MAX_TRANSFER_MICRO = 100_000_000;

/** Pure: a P2P transfer amount must be an integer micro in 1..MAX. */
export function validTransferAmount(amountMicro: number): boolean {
  return Number.isInteger(amountMicro) && amountMicro > 0 && amountMicro <= MAX_TRANSFER_MICRO;
}

/**
 * 🧪→🧪 The transfer twin of TAINT_INVOKE_SQL — identical bindings (?1 payer,
 * ?2 ref, ?3 payee, ?4 payee credit), gated on the transfer debit instead of
 * the invoke debit. Without it, P2P sends would be a taint-laundering hole:
 * faucet credit hops one account and comes out withdrawable. Kind 'transfer'
 * keeps refund/audit queries able to tell the two flows apart.
 */
export const TAINT_TRANSFER_SQL =
  `INSERT OR IGNORE INTO trial_taint (user_id, micro, kind, ref)
   SELECT ?3, ${TAINT_MICRO_EXPR}, 'transfer', ?2
   WHERE ${TAINT_MICRO_EXPR} > 0
     AND EXISTS (SELECT 1 FROM ledger WHERE user_id = ?1 AND kind='transfer_debit' AND ref = ?2)`;

async function balanceOf(env: any, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(delta_micro), 0) AS bal FROM ledger WHERE user_id = ?"
  ).bind(userId).first();
  return Number(row?.bal || 0);
}

/** GET /pay/balance?userId= (internal) → { ok, balance_micro, history } */
export class PayBalanceCall extends OpenAPIRoute {
  static schema = {
    tags: ["payments"], summary: "Internal: user balance + recent ledger",
    parameters: { userId: Query(String, { required: true }) },
  };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);

    const bal = await balanceOf(env, userId);
    const rows = await env.DB.prepare(
      "SELECT delta_micro, kind, ref, counterparty, created FROM ledger WHERE user_id = ? ORDER BY created DESC, id DESC LIMIT 50"
    ).bind(userId).all();

    // Lazy wallet row — the user "has a wallet" from first touch
    await env.DB.prepare(
      "INSERT OR IGNORE INTO wallets (user_id) VALUES (?)"
    ).bind(userId).run();

    return json({ ok: true, balance_micro: bal, history: rows?.results || [] });
  }
}

/** POST /pay/invoke (internal) { payerId, resource, ref } — atomic settle */
export class PayInvokeCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: settle a paid invocation (atomic)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { payerId, resource, ref } = body;
    if (!payerId || !resource || !ref) return json({ error: "payerId, resource, ref required" }, 400);
    if (!validResource(String(resource))) return json({ error: "invalid resource" }, 400);

    const price = await env.DB.prepare(
      "SELECT owner_id, price_micro FROM prices WHERE resource = ? AND active = 1"
    ).bind(String(resource)).first();

    // Unpriced = free — no rows, no fee.
    if (!price || Number(price.price_micro) <= 0) {
      return json({ ok: true, free: true, charged_micro: 0 });
    }

    const ownerId = String(price.owner_id);
    // Self-invocation is free: owners don't pay themselves (and the platform
    // doesn't tax an owner testing their own tiny).
    if (ownerId === String(payerId)) {
      return json({ ok: true, free: true, self: true, charged_micro: 0 });
    }

    const split = splitInvoke(Number(price.price_micro));
    if (!split) return json({ ok: true, free: true, charged_micro: 0 });

    // Idempotency: same ref already settled → report success, charge nothing.
    const existing = await env.DB.prepare(
      "SELECT id FROM ledger WHERE user_id = ? AND kind = 'invoke_debit' AND ref = ?"
    ).bind(String(payerId), String(ref)).first();
    if (existing) {
      return json({ ok: true, already_settled: true, charged_micro: Number(price.price_micro) });
    }

    // ATOMIC three-way move, with the balance guard INSIDE the debit — NOT a
    // preceding balanceOf() read. A read-then-batch was a check-then-act TOCTOU:
    // the concurrent-sends feature issues paid turns with DISTINCT refs (each
    // send's ref embeds messages.length), so the UNIQUE(user,kind,ref) index
    // does NOT serialize them — two simultaneous paid sends both read the
    // pre-debit balance, both passed `bal < price`, and both debited, overdrawing
    // the payer below zero. And invoke_credit is withdrawable by the owner, so an
    // overdraft mints real money, not a cosmetic negative. Same fix deposits.ts +
    // withdrawals.ts already carry: evaluate the guard as a conditional
    // INSERT…SELECT…WHERE so the check and the debit are ONE atomic write — a
    // concurrent second send sees the first's debit row and its WHERE yields 0
    // rows. The credit + fee rows gate on the debit existing (EXISTS, seen within
    // the same in-order D1 batch), so the whole settle is all-or-nothing.
    let debited = false;
    // Row count from the TAINT statement — "was this credit marked trial-class?"
    // Read for the notification's WORDING only; nothing in the settle branches on
    // it. Batch index 3 (last of the four below): an off-by-one here reads the
    // platform-fee row instead, and since `results[4]` is simply `undefined`,
    // `tainted` would be silently false forever and every push would promise
    // withdrawability. tests/money-events.test.ts DERIVES this index by counting
    // the batch rather than restating it.
    let taintChanges = 0;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT ?1, ?2, 'invoke_debit', ?3, ?4
           WHERE (SELECT COALESCE(SUM(delta_micro),0) FROM ledger WHERE user_id = ?1) >= ?5`
        ).bind(String(payerId), split.debit, String(ref), ownerId, Number(price.price_micro)),
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT ?1, ?2, 'invoke_credit', ?3, ?4
           WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?4 AND kind='invoke_debit' AND ref = ?3)`
        ).bind(ownerId, split.ownerCredit, String(ref), String(payerId)),
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT 'platform', ?1, 'platform_fee', ?2, ?3
           WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?3 AND kind='invoke_debit' AND ref = ?2)`
        ).bind(split.fee, String(ref), String(payerId)),
        // 🧪→🧪 Trial money changed hands: if this payment could only have come
        // from trial balance, the payee's new credit is trial-class too and is
        // excluded from BOTH real-value exits (see TAINT_INVOKE_SQL). Last in the
        // batch so it reads the payer's post-debit state; a no-op for the ordinary
        // payer who has real balance to spare.
        env.DB.prepare(TAINT_INVOKE_SQL)
          .bind(String(payerId), String(ref), ownerId, split.ownerCredit),
      ]);
      debited = Number(results?.[0]?.meta?.changes || 0) > 0;
      taintChanges = Number(results?.[3]?.meta?.changes || 0);
    } catch (err: any) {
      // UNIQUE violation = concurrent retry with the SAME ref landed first —
      // that's an idempotent success, not a double-charge.
      if (String(err?.message || err).includes("UNIQUE")) {
        return json({ ok: true, already_settled: true, charged_micro: Number(price.price_micro) });
      }
      console.log(err, "pay/invoke batch");
      return json({ error: "settlement failed" }, 500);
    }

    // The debit's WHERE failed → insufficient balance. Recompute post-facto (no
    // race concern — purely to report the specific figure) for the 402 body.
    if (!debited) {
      const bal = await balanceOf(env, String(payerId));
      return json({
        ok: false, error: "insufficient_balance",
        balance_micro: bal, price_micro: Number(price.price_micro),
      }, 402);
    }

    // 💵 TELL THE OWNER THEY EARNED. Until this line, every path in this file
    // moved money in total silence: `visit.ts` gives a PAGE VIEW a ring event
    // and a push, while a real, withdrawable payment produced nothing but this
    // JSON body — which goes to the PAYER's client, not the payee. The owner
    // found out by opening /wallet on a hunch.
    //
    // AFTER the batch, never inside it (money that moved must not roll back
    // because a push endpoint was down), and `notifyMoney` never throws.
    //
    // `tainted` comes from the TAINT statement's own row count — last in the
    // batch — because on a MAINNET deployment a tainted credit is real-money
    // shaped but NOT withdrawable, and the copy must not promise otherwise. The
    // ledger already decided; we report its decision rather than re-deriving it.
    const network = defaultNetwork(env);
    const tainted = Number(taintChanges || 0) > 0;
    await notifyMoney(env, ownerId, {
      kind: "pay_earned",
      micro: split.ownerCredit,
      network,
      tainted,
      slug: String(resource).startsWith("tiny:") ? String(resource).slice(5) : undefined,
      who: await loginOf(env, String(payerId)),
    });

    return json({
      ok: true, charged_micro: Number(price.price_micro),
      owner_credit_micro: split.ownerCredit, fee_micro: split.fee,
      balance_micro: await balanceOf(env, String(payerId)),
    });
  }
}

/**
 * POST /pay/transfer (internal) { payerId, toLogin, amount_micro, ref } —
 * atomic P2P ledger move (the make_payment agent tool, behind the user's
 * confirm-card tap in /api/x402/pay PUT).
 *
 * Invoke's settle minus the price lookup and minus the platform fee: a P2P
 * send is not monetization, so debit + credit sum to zero with no fee row.
 * Same hardening set as invoke, because the threat model is identical:
 *  - balance guard INSIDE the debit INSERT (no read-then-batch TOCTOU),
 *  - credit gated on the debit row EXISTing (all-or-nothing batch),
 *  - idempotent by (payer, 'transfer_debit', ref) — the quote's jti rides in
 *    as the ref, so a double-tap/replay settles ONCE (already_settled),
 *  - taint follows the money (TAINT_TRANSFER_SQL) so trial credit can't
 *    launder into a withdrawable balance by hopping accounts.
 *
 * The recipient arrives as a LOGIN, resolved here at settle time: the login
 * is the identity the user read on the confirm card, and /profile (the mint-
 * time existence check) doesn't expose raw user ids. The 5-min quote TTL
 * bounds any rename race to a window narrower than the approval itself.
 */
export class PayTransferCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: atomic peer-to-peer balance transfer" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { payerId, toLogin, ref } = body;
    const amount = Math.floor(Number(body.amount_micro));
    if (!payerId || !toLogin || !ref) return json({ error: "payerId, toLogin, ref required" }, 400);
    if (!validTransferAmount(amount)) {
      return json({ error: `amount_micro must be an integer 1..${MAX_TRANSFER_MICRO}` }, 400);
    }

    const payee = await env.DB.prepare(
      "SELECT id, github_login FROM users WHERE LOWER(github_login) = LOWER(?)"
    ).bind(String(toLogin).trim().replace(/^@/, "")).first();
    // unknown_recipient (not a bare 404 string): money credited to an id no
    // account owns is money destroyed — refuse rather than guess.
    if (!payee) return json({ error: "unknown_recipient" }, 404);
    const payeeId = String(payee.id);
    if (payeeId === String(payerId)) return json({ error: "cannot send money to yourself" }, 400);

    // Idempotency: same ref already settled → report success, move nothing.
    // Report the ORIGINAL row's amount — a retry with a mutated amount must
    // echo what actually moved, not what the retry asked for.
    const existing = await env.DB.prepare(
      "SELECT delta_micro FROM ledger WHERE user_id = ? AND kind = 'transfer_debit' AND ref = ?"
    ).bind(String(payerId), String(ref)).first();
    if (existing) {
      return json({ ok: true, already_settled: true, transferred_micro: -Number(existing.delta_micro), to: payee.github_login });
    }

    let debited = false;
    let taintChanges = 0;   // TAINT_TRANSFER_SQL, last of the three — wording only
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT ?1, ?2, 'transfer_debit', ?3, ?4
           WHERE (SELECT COALESCE(SUM(delta_micro),0) FROM ledger WHERE user_id = ?1) >= ?5`
        ).bind(String(payerId), -amount, String(ref), payeeId, amount),
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT ?1, ?2, 'transfer_credit', ?3, ?4
           WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?4 AND kind='transfer_debit' AND ref = ?3)`
        ).bind(payeeId, amount, String(ref), String(payerId)),
        env.DB.prepare(TAINT_TRANSFER_SQL)
          .bind(String(payerId), String(ref), payeeId, amount),
      ]);
      debited = Number(results?.[0]?.meta?.changes || 0) > 0;
      taintChanges = Number(results?.[2]?.meta?.changes || 0);
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        return json({ ok: true, already_settled: true, transferred_micro: amount, to: payee.github_login });
      }
      console.log(err, "pay/transfer batch");
      return json({ error: "transfer failed" }, 500);
    }

    if (!debited) {
      const bal = await balanceOf(env, String(payerId));
      return json({
        ok: false, error: "insufficient_balance",
        balance_micro: bal, amount_micro: amount,
      }, 402);
    }

    // 🤝 TELL THE RECIPIENT. The payer tapped a confirm card and got this JSON;
    // the recipient — the one who gained money and did nothing to cause it — had
    // no way to learn about it at all. This is the least inferable of the four
    // moments: nothing in their session changes.
    await notifyMoney(env, payeeId, {
      kind: "pay_received",
      micro: amount,
      network: defaultNetwork(env),
      tainted: taintChanges > 0,
      // The payer's login is verified here (we hold their user row's id from an
      // authenticated call), so naming them is honest; missing → "Someone".
      who: await loginOf(env, String(payerId)),
    });

    return json({
      ok: true, transferred_micro: amount, to: payee.github_login,
      balance_micro: await balanceOf(env, String(payerId)),
    });
  }
}

/** POST /pay/refund (internal) { ref } — compensating rows for a failed invocation */
export class PayRefundCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: refund a settled invocation" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { ref } = body;
    if (!ref) return json({ error: "ref required" }, 400);

    const rows = await env.DB.prepare(
      "SELECT user_id, delta_micro, kind, counterparty FROM ledger WHERE ref = ? AND kind IN ('invoke_debit','invoke_credit','platform_fee')"
    ).bind(String(ref)).all();
    const entries: any[] = rows?.results || [];
    if (!entries.length) return json({ error: "nothing to refund" }, 404);

    // Already refunded? (refund rows share the ref; idempotency index blocks
    // duplicates anyway, but check for a clean answer)
    const done = await env.DB.prepare(
      "SELECT id FROM ledger WHERE ref = ? AND kind = 'refund' LIMIT 1"
    ).bind(String(ref)).first();
    if (done) return json({ ok: true, already_refunded: true });

    try {
      await env.DB.batch([
        ...entries.map((e: any) =>
          env.DB.prepare(
            "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'refund', ?, ?)"
          ).bind(e.user_id, -Number(e.delta_micro), String(ref), e.counterparty)
        ),
        // 🧪→🧪 Give the taint back with the money. The payee no longer holds this
        // invocation's credit, so leaving the taint would permanently shrink their
        // withdrawable balance for a payment that was undone — trial money they
        // never kept. A NEGATIVE row (not a DELETE) because trial_taint is
        // append-only for the same reason the ledger is: a reversal you can audit
        // beats a row that quietly disappeared. kind='refund' lets it share the ref
        // with the original 'invoke' row without colliding on the idempotency index,
        // and OR IGNORE makes a repeated refund a no-op.
        env.DB.prepare(
          `INSERT OR IGNORE INTO trial_taint (user_id, micro, kind, ref)
           SELECT user_id, -micro, 'refund', ref FROM trial_taint WHERE kind = 'invoke' AND ref = ?1`
        ).bind(String(ref)),
      ]);
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        return json({ ok: true, already_refunded: true });
      }
      console.log(err, "pay/refund batch");
      return json({ error: "refund failed" }, 500);
    }
    return json({ ok: true, refunded_entries: entries.length });
  }
}

/** POST /pay/price (internal) { ownerId, resource, price_micro } — set/clear a price */
export class PayPriceSetCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: set a resource price" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { ownerId, resource } = body;
    const priceMicro = Math.floor(Number(body.price_micro));
    if (!ownerId || !resource) return json({ error: "ownerId, resource required" }, 400);
    if (!validResource(String(resource))) return json({ error: "invalid resource" }, 400);
    if (!Number.isFinite(priceMicro) || priceMicro < 0 || priceMicro > MAX_PRICE_MICRO) {
      return json({ error: `price_micro must be 0..${MAX_PRICE_MICRO}` }, 400);
    }

    // Ownership enforcement: tiny prices only by the tiny's owner.
    if (String(resource).startsWith("tiny:")) {
      const name = String(resource).slice(5);
      const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(name).first();
      if (!row || row.user_id !== String(ownerId)) {
        return json({ error: "not the owner of this tiny" }, 403);
      }
    } else {
      // tool:<login>/<name> — verify the login belongs to ownerId and the tool exists
      const [login, toolName] = String(resource).slice(5).split("/");
      const user = await env.DB.prepare("SELECT id FROM users WHERE github_login = ?").bind(login).first();
      if (!user || user.id !== String(ownerId)) return json({ error: "not the owner of this tool" }, 403);
      const t = await env.DB.prepare("SELECT id FROM user_tools WHERE user_id = ? AND name = ?").bind(String(ownerId), toolName).first();
      if (!t) return json({ error: "tool not found" }, 404);
    }

    if (priceMicro === 0) {
      await env.DB.prepare("DELETE FROM prices WHERE resource = ?").bind(String(resource)).run();
      return json({ ok: true, resource, price_micro: 0, cleared: true });
    }

    await env.DB.prepare(
      "INSERT INTO prices (owner_id, resource, price_micro) VALUES (?, ?, ?) " +
      "ON CONFLICT(resource) DO UPDATE SET price_micro = excluded.price_micro, owner_id = excluded.owner_id, active = 1, updated = unixepoch()"
    ).bind(String(ownerId), String(resource), priceMicro).run();

    return json({ ok: true, resource, price_micro: priceMicro });
  }
}

/** GET /pay/pricing?resource= (PUBLIC, read-only) → { resource, price_micro } */
export class PayPricingCall extends OpenAPIRoute {
  static schema = {
    tags: ["payments"], summary: "Public: price of a resource",
    parameters: { resource: Query(String, { required: true }) },
  };
  async handle(request: Request, env: any) {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource") || "";
    if (!validResource(resource)) return json({ error: "invalid resource" }, 400);
    const row = await env.DB.prepare(
      "SELECT price_micro FROM prices WHERE resource = ? AND active = 1"
    ).bind(resource).first();
    return json({ resource, price_micro: Number(row?.price_micro || 0) });
  }
}

/**
 * ⚖️ WHICH COUNTERPARTY DOES A CREDIT LAND UNDER? — the one field that decides
 * whether credited money is real or trial.
 *
 * The entire trial exclusion keys on `counterparty`: `TRIAL_DEPOSITS_SUM_SQL`
 * sums `kind='deposit'` rows whose counterparty is in
 * `TRIAL_COUNTERPARTIES` (`chain:base-sepolia`, `chain:tiny`), and all three
 * real-value exits — withdrawals, outbound x402 spend, and the taint term that
 * follows trial money between accounts — subtract exactly that sum. So a deposit
 * row written with ANY other counterparty is invisible to all of them: real,
 * withdrawable money by construction.
 *
 * `/pay/credit` wrote `'platform'` unconditionally. On the settle path in
 * app/api/x402/chat/[slug]/route.ts that was a MINT on a `PAYMENTS_NETWORK=tiny`
 * deployment. The route knows the settlement network — it resolves
 * `matched.network` and echoes the CAIP-2 in the receipt and the
 * X-PAYMENT-RESPONSE header — and then credited without it:
 *
 *   payer signs TinyUSDC (a token WE mint, owner-only, faucet-issued free)
 *     → facilitator settles it on our own chain
 *     → /pay/credit writes the payer's funding deposit as counterparty='platform'
 *     → TRIAL_DEPOSITS_SUM_SQL sees 0 trial for that payer, so /pay/invoke's
 *       TAINT_INVOKE_SQL writes NO taint row
 *     → the tiny owner's invoke_credit is real, withdrawable USDC.
 *
 * Minted play money out as mainnet USDC, one HTTP request, no accomplice
 * signup — through the same door c-d (withdrawals) and c-f0b (taint) were built
 * to shut. Both guard the LEDGER; neither was wrong. The ledger simply wasn't
 * told, because the two authorities on "which chain?" were the settling route
 * and this write, and only one of them ever knew.
 *
 * So the settling authority now REPORTS and this one reads — the same delegation
 * c42 applied to the payout signature, and the reason there's no second copy of
 * the network table here. Resolution is `namedNetwork`, NOT `normalizeNetwork`:
 * the deployment default is right for a REQUEST and catastrophic for a REPORT.
 * `normalizeNetwork(env, undefined)` on a mainnet deployment returns 'base', so
 * an unstated network would resolve to the one counterparty that means "real
 * money" — precisely the mint, re-created by the fix meant to close it.
 *
 * Fail-closed, therefore, in the trial direction: a network we cannot name gets
 * the DEPLOYMENT's own counterparty when that is trial-class, so an unrecognized
 * report can only ever under-credit realness. `'platform'` survives only where
 * it always belonged — an `admin_credit`, or a deposit whose caller names no
 * network at all on a real-money deployment (the legacy shape: a Base settle,
 * where 'platform' and 'chain:base' are equally non-trial).
 */
export function creditCounterparty(env: any, network: unknown): string {
  // typeof first: `String(['tiny'])` is exactly "tiny", so a coercing parse would
  // let a JSON array name a chain. More importantly `String(undefined)` is
  // "undefined" — indistinguishable from junk, and both must fail closed here
  // rather than resolve to a real-money counterparty.
  if (typeof network !== "string" || !network) {
    // No claim made. Real-money deployments keep the historical 'platform' (a
    // Base settle is non-trial either way); a trial deployment must NOT, because
    // there 'platform' is the difference between play money and a payout.
    const def = defaultNetwork(env);
    return isTrialNetwork(def) ? counterpartyFor(def) : "platform";
  }
  const named = namedNetwork(env, network);
  // A name we don't recognize is not a licence to call it real. Same fallback as
  // above — trial deployment → its own trial counterparty.
  if (!named) {
    const def = defaultNetwork(env);
    return isTrialNetwork(def) ? counterpartyFor(def) : "platform";
  }
  // A named REAL network keeps 'platform' so existing rows and this one agree
  // (both are outside TRIAL_COUNTERPARTIES, which is what the exclusion reads);
  // a named TRIAL network gets the counterparty every exclusion already checks.
  return isTrialNetwork(named) ? counterpartyFor(named) : "platform";
}

/** POST /pay/credit (internal) { userId, amount_micro, ref, kind?, network? } —
 *  admin/deposit credit. `network` is the chain the money ARRIVED on: it decides
 *  the counterparty, hence whether the credit is withdrawable (creditCounterparty). */
export class PayCreditCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: credit a user (admin/deposit)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, ref } = body;
    const amount = Math.floor(Number(body.amount_micro));
    const kind = body.kind === "deposit" ? "deposit" : "admin_credit";
    if (!userId || !ref) return json({ error: "userId, ref required" }, 400);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      return json({ error: "amount_micro must be 1..1e9" }, 400);
    }
    // An admin_credit is a platform grant with no chain behind it — it has no
    // network to report and must not be reclassified by one a caller supplies.
    const counterparty = kind === "deposit" ? creditCounterparty(env, body.network) : "platform";

    // 🔒 A deposit whose ref IS an on-chain tx hash is a claim on that transfer,
    // so it takes the same global reservation /pay/claim takes. Without it the
    // one x402 settlement that funded a payer could ALSO be pasted into the
    // deposit-claim form and credited a second time: X402_PAY_TO and
    // DEPOSIT_ADDRESS are the same platform address (§1.1 of the gaps report,
    // and prod sets exactly one), and TinyUSDC/USDC `transferWithAuthorization`
    // ends in `_transfer`, which emits Transfer(payer → payTo) — precisely the
    // log findUsdcTransfer accepts. A payer who links the address they pay from
    // gets the money twice, and on `base` BOTH rows are counterparty='platform',
    // i.e. real, withdrawable mainnet USDC. No trial cap bounds it.
    //
    // Reserve BEFORE the insert and hand it back if the insert doesn't land, or
    // a failed credit would burn a real deposit. `kind='deposit'` only: an
    // admin_credit's ref is a grant id, never a chain fact.
    const txRef = kind === "deposit" && isTxHash(String(ref).toLowerCase())
      ? String(ref).toLowerCase() : "";
    if (txRef) {
      const reserved = await reserveTx(env, txRef, String(userId), namedNetwork(env, body.network));
      if (!reserved.ok) {
        if (reserved.error) return json({ error: "credit failed" }, 500);
        // Our own retry (durableWrite replays by design) → idempotent success.
        if (reserved.owner === String(userId)) return json({ ok: true, already_credited: true });
        return json({ error: "tx already claimed" }, 409);
      }
    }
    try {
      await env.DB.prepare(
        "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, ?, ?, ?)"
      ).bind(String(userId), amount, kind, String(ref), counterparty).run();
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        // We hold the reservation and the row already exists — the credit IS
        // recorded, so keep the hash reserved and report the idempotent success.
        return json({ ok: true, already_credited: true });
      }
      console.log(err, "pay/credit");
      // The credit did NOT land, so the transfer is still uncredited: hand the
      // reservation back or the payer can never claim their real deposit.
      if (txRef) await releaseTx(env, txRef, String(userId));
      return json({ error: "credit failed" }, 500);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO wallets (user_id) VALUES (?)").bind(String(userId)).run();
    return json({ ok: true, credited_micro: amount });
  }
}

// 🤝 x402 OUTBOUND max spend per single payment — a compromised session or a
// runaway agent can't drain a whale wallet on one call. Mirrors the withdrawal
// velocity philosophy; the app layer may impose a tighter per-request cap.
export const SPEND_MAX_MICRO = 100_000_000; // $100/payment sanity ceiling

/**
 * The atomic outbound-spend debit — the SECOND real-value exit, and until now
 * the one the trial exclusion missed.
 *
 * Guards inside the write: sufficient balance MINUS trial credits (scaled by
 * ?5, the trialFactor) — the same shape and the same shared
 * TRIAL_DEPOSITS_SUM_SQL fragment as withdrawals.ts's WITHDRAW_DEBIT_SQL.
 *
 * Why this must exist: /pay/spend makes the platform hot wallet front REAL USDC
 * to an external x402 service, reimbursed from the user's ledger. Guarding on
 * total balance alone let minted TinyUSDC (and faucet Sepolia USDC) pay for a
 * mainnet purchase — the platform ate the difference in real money. Unlike the
 * withdrawal leak this needs no second account and no payout signature: mint
 * trial credit, buy something real, done. The $1 lifetime trial cap was the only
 * thing bounding the loss, which is exactly the constant a gamified faucet wants
 * to raise.
 *
 * Exported so tests can run the real statement against real sqlite.
 */
export const SPEND_DEBIT_SQL =
  `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
   SELECT ?1, ?2, 'spend_debit', ?3, ?4
   WHERE (SELECT COALESCE(SUM(delta_micro),0) FROM ledger WHERE user_id = ?1)
         - ?5 * ${TRIAL_DEPOSITS_SUM_SQL}
         >= ?6`;

/** The spendable figure the 402 body reports — same exclusion as the debit. */
export const SPENDABLE_SQL =
  `SELECT COALESCE(SUM(delta_micro),0) - ${TRIAL_DEPOSITS_SUM_SQL} AS v
   FROM ledger WHERE user_id = ?1`;

/**
 * POST /pay/spend (internal) { userId, amount_micro, ref, payee?, network? }
 *
 * Reserve a user's balance to fund an OUTBOUND x402 payment: the platform hot
 * wallet fronts real USDC on-chain, so the user's ledger must be debited to
 * reimburse it BEFORE we sign. Atomic guarded debit — the balance check lives
 * INSIDE the INSERT…SELECT…WHERE (same TOCTOU-proof shape as withdraw-request),
 * so two concurrent spends can't both pass a stale read and overdraw. The
 * platform credit is the reimbursement for the USDC it's about to send.
 *
 * `network` selects whether trial credits may fund it: on a TRIAL network the
 * USDC we front is itself worthless (we minted it), so trial balance spends
 * freely; on a real network it is excluded. Same trialFactor split as
 * withdraw-request, and unknown/absent networks normalize to the deployment
 * default — never to "trial", so a missing field can't unlock trial money.
 *
 * Idempotent by (userId, kind='spend_debit', ref). If signing/settlement then
 * fails before money moves, /pay/spend-reverse undoes it.
 */
export class PaySpendCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: reserve balance for an outbound x402 payment (atomic)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, ref } = body;
    const amount = Math.floor(Number(body.amount_micro));
    const payee = String(body.payee || "external").slice(0, 80);
    // Which chain the platform is about to front USDC on. normalizeNetwork
    // resolves anything unknown (or absent) to the deployment default, so an
    // omitted/garbage field can never claim to be a trial network.
    const network = normalizeNetwork(env, body.network);
    if (!userId || !ref) return json({ error: "userId, ref required" }, 400);
    if (!Number.isFinite(amount) || amount <= 0 || amount > SPEND_MAX_MICRO) {
      return json({ error: `amount_micro must be 1..${SPEND_MAX_MICRO}` }, 400);
    }

    // Already reserved under this ref → idempotent success, charge nothing.
    const existing = await env.DB.prepare(
      "SELECT id FROM ledger WHERE user_id = ? AND kind = 'spend_debit' AND ref = ?"
    ).bind(String(userId), String(ref)).first();
    if (existing) return json({ ok: true, already_spent: true, charged_micro: amount });

    // 🧪 Trial credits can't fund a REAL outbound payment (see SPEND_DEBIT_SQL):
    // 1 on a real network excludes them, 0 on a trial network lets them spend —
    // there the USDC the platform fronts is worthless minted/faucet money too, so
    // nobody is out real value.
    const trialFactor = isTrialNetwork(network) ? 0 : 1;

    // ATOMIC: debit the user + credit the platform (reimbursement for the USDC
    // it fronts), guarded on sufficient SPENDABLE balance INSIDE the write. The
    // platform credit row gates on the debit having landed (EXISTS), so the pair
    // is all-or-nothing. A concurrent second spend sees the first's debit and its
    // WHERE yields 0 rows.
    let debited = false;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(SPEND_DEBIT_SQL)
          .bind(String(userId), -amount, String(ref), payee, trialFactor, amount),
        env.DB.prepare(
          `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
           SELECT 'platform', ?1, 'spend_reimburse', ?2, ?3
           WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?3 AND kind='spend_debit' AND ref = ?2)`
        ).bind(amount, String(ref), String(userId)),
      ]);
      debited = Number(results?.[0]?.meta?.changes || 0) > 0;
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        return json({ ok: true, already_spent: true, charged_micro: amount });
      }
      console.log(err, "pay/spend batch");
      return json({ error: "spend failed" }, 500);
    }

    if (!debited) {
      // Report what the guard actually enforced: on a real network a user with
      // $5 of trial credit and $0 real has balance $5 but spendable $0, and
      // saying "balance 5, need 1" would read as a platform bug. `spendable_micro`
      // is what the clients should surface. Post-facto recompute, no race concern.
      const bal = await balanceOf(env, String(userId));
      const spendRow = trialFactor
        ? await env.DB.prepare(SPENDABLE_SQL).bind(String(userId)).first()
        : null;
      const spendable = trialFactor ? Math.max(0, Number(spendRow?.v || 0)) : bal;
      return json({
        ok: false, error: "insufficient_balance",
        balance_micro: bal, spendable_micro: spendable, need_micro: amount,
        ...(spendable < bal ? { trial_excluded: true } : {}),
      }, 402);
    }
    return json({ ok: true, charged_micro: amount, balance_micro: await balanceOf(env, String(userId)) });
  }
}

/**
 * Mark a reservation's signed authorization as HANDED OUT (migration 0025).
 *
 * `ON CONFLICT DO NOTHING` because the payer route may legitimately re-send the
 * same reservation (an idempotency-keyed retry reuses the ref), and a second
 * mark must be a no-op rather than an error — the fact recorded is "this ref's
 * signature escaped at least once", which cannot be un-said.
 *
 * Exported so tests run the real statement against real sqlite.
 */
export const SPEND_SENT_SQL =
  `INSERT INTO spend_sent (ref, user_id, payee, payer, nonce, valid_before)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6)
   ON CONFLICT(ref) DO NOTHING`;

/** Has this reservation's authorization left us? The reverse gate. */
export const SPEND_SENT_LOOKUP_SQL =
  `SELECT ref, user_id, payee, created, payer, nonce, valid_before
   FROM spend_sent WHERE ref = ?1`;

/**
 * 🔍 The open instruments a reconciler can actually settle (migration 0026).
 *
 * "Open" means: we handed out a signature, we recorded WHICH one, and its signed
 * deadline has passed. Only rows meeting all three are answerable, and the
 * predicate says so column by column rather than filtering in JS:
 *
 *   nonce IS NOT NULL      — pre-0026 marks don't know what they signed. They are
 *                            genuinely unresolvable, so they must not be handed to
 *                            a resolver that would then guess.
 *   valid_before <= ?1     — the instrument is dead by the CONTRACT's own require
 *                            (TinyUSDC.sol `block.timestamp < validBefore`), not by
 *                            a timeout we chose. Before this, absence on-chain
 *                            means "not yet", which is not a verdict.
 *   no spend_refund row    — already reconciled (or reversed by an asserted
 *                            not_settled). Re-resolving would be a second refund;
 *                            the ledger's UNIQUE(user,kind,ref) would catch it, but
 *                            a sweep that repeatedly retries settled work is its own
 *                            bug — it never drains, so the queue depth stops being
 *                            a signal.
 *   resolved IS NULL       — and the SETTLED outcome writes no ledger row at all
 *                            (the debit was correct), so it needs its own terminal
 *                            mark or the resolver re-asks the chain about the same
 *                            landed payment every minute forever (migration 0027).
 *
 * `LIMIT ?2` bounds a cron tick: each row costs one eth_call, and a burst of sends
 * must not turn one scheduled run into an unbounded RPC fan-out. Oldest first, so
 * a backlog drains in order and no row can be starved by newer arrivals.
 */
/**
 * The predicate ITSELF, exported so "open" has exactly one definition.
 *
 * ⚠️ The status reader (/pay/reconcile-status) counts this queue, and a monitor
 * that disagrees with the sweep about which rows are open is worse than no
 * monitor: it would report a drained queue while the resolver still has work, or
 * an alarm nobody can act on. Two copies of a five-clause predicate WILL drift —
 * this arc has already paid for that lesson twice (0021's uniqueness guard keyed
 * on a different column than the index it was meant to interlock with; the
 * refund guard keyed on `ref` alone while the ledger's index keyed `(user, ref)`).
 * So the count query and the sweep query are composed from this one fragment, and
 * a test asserts both contain it.
 *
 * `?1` is the clock. Any query built on this must bind it first.
 */
export const SPEND_SENT_OPEN_WHERE =
  `WHERE nonce IS NOT NULL
      AND valid_before IS NOT NULL
      AND valid_before <= ?1
      AND resolved IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ledger
         WHERE ledger.ref = spend_sent.ref AND ledger.kind = 'spend_refund')`;

/** The sweep's own ordering, shared for the same reason as the predicate: the
 *  status reader must inspect the rows the NEXT tick will actually take, not a
 *  differently-sorted sample of the same set. */
export const SPEND_SENT_OPEN_ORDER = `ORDER BY valid_before ASC`;

export const SPEND_SENT_OPEN_SQL =
  `SELECT ref, user_id, payee, payer, nonce, valid_before
     FROM spend_sent
    ${SPEND_SENT_OPEN_WHERE}
    ${SPEND_SENT_OPEN_ORDER}
    LIMIT ?2`;

/**
 * POST /pay/spend-sent (internal) { userId, ref, payee?, payer?, nonce?, validBefore? }
 *
 * Records that the signed EIP-3009 authorization for `ref` has been handed to
 * someone else. Called by the payer route IMMEDIATELY BEFORE the request that
 * carries the X-PAYMENT header — before, not after, because a mark written after
 * the send is not a gate: the send could succeed while the mark is lost, and the
 * reverse would then read an unmarked ref and refund a payment in flight. Marking
 * first can only over-protect (a mark with no send freezes one reservation, which
 * an operator can see and release), and that is the safe direction.
 *
 * Idempotent, and deliberately NOT gated on the reservation existing: the mark is
 * about a signature, and refusing to record one because the ledger lookup blipped
 * would trade a real safety fact for a consistency check nothing needs.
 *
 * 🔍 `payer`/`nonce`/`validBefore` are the instrument's IDENTITY (migration 0026),
 * and they are what make a frozen reservation resolvable instead of permanent. The
 * mark alone said "a signature escaped"; it could not say WHICH, because the payer
 * route generated the nonce at the signing site and discarded it. Without them the
 * reconciler has no question to ask: `authorizationState(payer, nonce)` is the
 * chain's own redemption bit, and `validBefore` is the only thing that lets its
 * absence read as `not_settled` rather than "not yet" (it is signed INTO the
 * payload, so the deadline is the contract's rule, not a timeout we picked).
 *
 * All three are OPTIONAL and validated independently. A caller that supplies a
 * malformed one gets the mark WITHOUT identity rather than a rejected mark: the
 * safety fact ("this escaped") is strictly more important than the convenience
 * fact ("and here is how to check it"), so a validation failure must never be
 * able to leave the guard unarmed. Recording a bad nonce would be worse than
 * recording none — it makes an unresolvable row look resolvable, and the
 * reconciler would read `authorizationState(garbage) == false` past the deadline
 * as a proof of not_settled and refund a payment that may have landed.
 */
export class PaySpendSentCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: mark a reserved spend's authorization as sent (blocks reversal)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, ref } = body;
    if (!userId || !ref) return json({ error: "userId, ref required" }, 400);
    const payee = body.payee ? String(body.payee).slice(0, 80) : null;
    // Identity, all-or-nothing per field and never fatal. isAddress/isTxHash are
    // the SHAPE checks already used for on-chain identifiers elsewhere in this
    // worker (a bytes32 nonce has the same shape as a tx hash); anything else
    // stores NULL, which the reconciler reads as "unresolvable, needs a human".
    const payer = isAddress(String(body.payer || "")) ? String(body.payer).toLowerCase() : null;
    const nonce = isTxHash(String(body.nonce || "")) ? String(body.nonce).toLowerCase() : null;
    const vb = Math.floor(Number(body.validBefore));
    // A deadline is only useful if it can pass. Zero/negative/NaN would make the
    // row instantly "open" to the reconciler on the strength of a bad field.
    const validBefore = Number.isFinite(vb) && vb > 0 ? vb : null;
    // The three travel TOGETHER or not at all: a nonce with no deadline can never
    // be expired (so absence is never a verdict), and a deadline with no nonce has
    // nothing to ask about. Storing a half-set would put a row in the open queue
    // that the resolver must then re-check and skip on every single tick.
    const identity = payer && nonce && validBefore ? { payer, nonce, validBefore } : null;
    try {
      await env.DB.prepare(SPEND_SENT_SQL)
        .bind(String(ref), String(userId), payee,
              identity?.payer ?? null, identity?.nonce ?? null, identity?.validBefore ?? null)
        .run();
    } catch (err: any) {
      // A failed mark is reported as an ERROR, not swallowed: the caller is about
      // to hand out a bearer instrument and needs to know the guard isn't armed.
      console.log(err, "pay/spend-sent");
      return json({ error: "mark failed" }, 500);
    }
    return json({ ok: true, ref: String(ref) });
  }
}

/**
 * POST /pay/spend-reverse (internal) { userId, ref } — undo a reserved spend.
 *
 * ONLY valid when NO USDC can have moved — i.e. the signed authorization never
 * left us. Compensating rows mirror /pay/refund. Idempotent via the
 * 'spend_refund' kind + the UNIQUE(user,kind,ref) index.
 *
 * ⚠️ Until migration 0025 this endpoint could not tell whether money had moved.
 * It verified that spend rows exist, that no refund exists yet, and that the
 * caller holds the internal key — none of which is about settlement. "No USDC
 * moved" was purely the CALLER's claim (an open finding since the deposit
 * double-mint arc: "safety is purely caller-contract"). c46 fixed all three
 * callers; this makes the worker itself the last line of defence, against a
 * caller nobody has written yet.
 *
 * The gate is `spend_sent`: an EIP-3009 signature is a BEARER instrument, so the
 * knowable question is not "did it settle?" (unanswerable from here, and still
 * unanswerable on-chain at the moment of asking, since a pending tx may confirm
 * later) but "could it have?" — which the payer knows first-hand and marks. Same
 * doctrine as withdraw's "txHash set → never refund" and c46's settlement
 * classifier.
 *
 * `settlement` (optional, chain/settle-outcome.mjs' vocabulary) is the ONE
 * override: a positive `not_settled` from the payee itself means the instrument
 * came back dead — the authorization was rejected before submission, so it can
 * never settle even though it left us. That is the overwhelmingly common failure
 * (an authorization that expired between quote and send, a payer nonce already
 * used) and it must keep refunding automatically, or every ordinary failed payment
 * becomes a support ticket.
 *
 * The override is deliberately EXPLICIT and logged rather than inferred: what this
 * guard buys is that SILENCE means refuse. A caller must knowingly assert the one
 * fact that makes a post-send reversal safe, in the same words the shared
 * classifier uses, so the verdict TRAVELS from the authority that computed it
 * instead of being re-derived here (lens 8 — the fix for two authorities is
 * delegation, not a second copy of the reasoning). A caller that has never heard
 * of settlement gets refused by default.
 */
export class PaySpendReverseCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: reverse a reserved outbound spend (only if nothing was sent)" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, ref } = body;
    if (!userId || !ref) return json({ error: "userId, ref required" }, 400);

    // 🚧 The gate, BEFORE any write. A refusal must be distinguishable from a
    // success by the caller, so it answers 409 with the mark's own metadata — a
    // reconciliation record rather than a bare "no".
    let sent: any = null;
    try {
      sent = await env.DB.prepare(SPEND_SENT_LOOKUP_SQL).bind(String(ref)).first();
    } catch (err: any) {
      // Fail CLOSED. We cannot read the marker, so we cannot know the money
      // stayed put — and the whole point of this guard is that the expensive
      // mistake is refunding a payment that settled.
      console.log(err, "pay/spend-reverse sent-lookup");
      return json({ error: "cannot verify whether the payment was sent — not reversing" }, 503);
    }
    // The one asserted fact that makes a post-send reversal safe: the payee
    // reported the authorization DEAD (rejected before submission). Anything
    // else — including a plain omission, an `unknown`, or a `settled` — refuses.
    const asserted = String(body.settlement || "");
    if (sent && asserted === "not_settled") {
      console.log(JSON.stringify({
        tag: "spend-reverse-post-send", ref: String(ref), userId: String(userId),
        payee: sent.payee || null, settlement: asserted,
        note: "reversing an already-sent authorization on an asserted not_settled",
      }));
    } else if (sent) {
      // Already refunded earlier (before this guard existed, or by a caller that
      // marked after refunding) — report the truth rather than a fresh refusal.
      const refunded = await env.DB.prepare(
        "SELECT id FROM ledger WHERE ref = ? AND kind = 'spend_refund' LIMIT 1"
      ).bind(String(ref)).first().catch(() => null);
      // The refusal names the INSTRUMENT, not just the refusal. A frozen
      // reservation is only actionable if someone can ask the chain about it, and
      // `resolvable` states plainly whether anyone can: a pre-0026 mark has no
      // nonce, so it is stuck until a human decides — and saying so beats a 409
      // that reads identical to a resolvable one.
      console.log(JSON.stringify({
        tag: "spend-reverse-refused", ref: String(ref), userId: String(userId),
        payee: sent.payee || null, sent_at: sent.created || null,
        settlement: asserted || null, already_refunded: !!refunded,
        payer: sent.payer || null, nonce: sent.nonce || null,
        valid_before: sent.valid_before || null, resolvable: !!(sent.payer && sent.nonce && sent.valid_before),
      }));
      return json({
        error: "the signed authorization for this ref was already handed out — it may have settled on-chain, so it cannot be auto-reversed",
        sent: true, ref: String(ref), payee: sent.payee || null, sent_at: sent.created || null,
        ...(sent.payer && sent.nonce && sent.valid_before
          ? { payer: sent.payer, nonce: sent.nonce, valid_before: Number(sent.valid_before) }
          : {}),
        ...(refunded ? { already_reversed: true } : {}),
      }, 409);
    }

    const rows = await env.DB.prepare(
      "SELECT user_id, delta_micro FROM ledger WHERE ref = ? AND kind IN ('spend_debit','spend_reimburse')"
    ).bind(String(ref)).all();
    const entries: any[] = rows?.results || [];
    if (!entries.length) return json({ error: "nothing to reverse" }, 404);

    const done = await env.DB.prepare(
      "SELECT id FROM ledger WHERE ref = ? AND kind = 'spend_refund' LIMIT 1"
    ).bind(String(ref)).first();
    if (done) return json({ ok: true, already_reversed: true });

    try {
      await env.DB.batch(entries.map((e: any) =>
        env.DB.prepare(
          "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_refund', ?, 'platform')"
        ).bind(e.user_id, -Number(e.delta_micro), String(ref))
      ));
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) return json({ ok: true, already_reversed: true });
      console.log(err, "pay/spend-reverse batch");
      return json({ error: "reverse failed" }, 500);
    }
    return json({ ok: true, reversed_entries: entries.length });
  }
}

/**
 * 🔍 THE RESOLVER — the thing that makes c47's refusal temporary instead of
 * permanent. Runs on the per-minute cron (src/index.ts `scheduled`).
 *
 * For each open instrument (SPEND_SENT_OPEN_SQL: identity recorded, signed
 * deadline passed, not yet refunded) it asks the chain ONE question —
 * `authorizationState(payer, nonce)` — and acts only on a definite `false`:
 *
 *   true  → REDEEMED. The money moved (or the payer cancelled, equally final).
 *           The debit is correct and must stand. Mark it resolved so the queue
 *           drains; refunding here would be the unrecoverable mistake.
 *   false → NOT redeemed, and past a deadline the CONTRACT enforces
 *           (`require(block.timestamp < validBefore)`), so it can never be
 *           redeemed. This is the only refund case, and it is a proof rather
 *           than a timeout we chose.
 *   null  → UNKNOWN (RPC down, undecodable answer, a token address we don't
 *           have). Leave the row exactly as it is and try next tick. An
 *           unreachable authority is never evidence.
 *
 * ⚠️ THE FIRST LIVE MEASUREMENT SHAPED THIS FUNCTION. At the moment it was
 * written, prod held exactly one open row: identity recorded, deadline forty
 * seconds past, reservation frozen — and `authorizationState` answered **0x…01**.
 * It had SETTLED. The obvious resolver ("frozen past its deadline ⟹ the payment
 * failed ⟹ refund") would have refunded a payment that landed, on its very first
 * tick, with no error anywhere. The frozen state is not evidence of failure; it
 * is evidence that nobody asked. That is why `true` is the case this code treats
 * as expected and `false` as the exception, not the other way round.
 *
 * The refund itself reuses `spend_refund` — the SAME kind, ref and shape
 * /pay/spend-reverse writes — so the two paths cannot double-refund: the ledger's
 * UNIQUE(user_id, kind, ref) index is the arbiter, not a preceding SELECT, and
 * the queue's `NOT EXISTS` then stops re-reading the row. A human reversing by
 * hand at the same instant as a tick is a race the DB settles.
 */

/**
 * Which chain was this authorization signed for? A redemption bit is per-chain:
 * the same (payer, nonce) reads as UNREDEEMED on every chain except the one it
 * was signed on — so asking the wrong chain returns `false`, which is the refund
 * verdict. Getting this wrong is therefore a money bug, not a lookup bug.
 *
 * The payer route encodes it into the ref itself:
 *   x402pay:<sub>:<network>:<payTo>:<amountMicro>:<token>
 * where <network> is the CAIP-2 of the accept it selected (e.g. `eip155:8469`),
 * i.e. exactly the chainId baked into the EIP-712 domain that was signed. Since
 * CAIP-2 contains a colon, the field spans two segments.
 *
 * ⚠️ `namedNetwork`, NOT `normalizeNetwork` — lens 10. This is a REPORT about a
 * past signature, not a request for a default: a ref we cannot parse must yield
 * null ("don't know, don't ask") and never the deployment's current network. If
 * the deployment switched chains since the signature, defaulting would ask the
 * NEW chain about an OLD instrument, get `false`, and refund a payment that
 * settled on the old one.
 */
export function refNetwork(env: any, ref: string): PayNetwork | null {
  const parts = String(ref || "").split(":");
  if (parts[0] !== "x402pay" || parts.length < 4) return null;
  // Try the two-segment CAIP-2 form first (`eip155:8469`), then a bare name.
  return namedNetwork(env, `${parts[2]}:${parts[3]}`) ?? namedNetwork(env, parts[2]);
}

/** How many open instruments one cron tick will resolve. Each costs one
 *  eth_call, and a tick must stay well inside the worker's CPU budget — a
 *  backlog drains over successive minutes rather than in one unbounded fan-out. */
export const RECONCILE_BATCH = 10;

/**
 * Mark a resolved-but-NOT-refunded instrument so the queue stops re-reading it
 * (migration 0027).
 *
 * A redeemed authorization has no ledger row to write — the debit already stands
 * and is correct — so without a terminal state the queue returns the same row
 * every minute forever, one eth_call each, and its depth stops meaning "work
 * outstanding". That depth is the alarm for payments going unreconciled, so an
 * always-full queue is an alarm that is always on.
 *
 * ⚠️ It records WHICH WAY it resolved, not just that it did, because "settled"
 * is otherwise only inferable from the ABSENCE of a spend_refund row — and this
 * arc keeps deleting exactly that kind of inference. `resolved IS NULL` is
 * therefore the guard: an already-resolved row is never re-stamped, so the first
 * verdict and its timestamp are what a support ticket reads.
 *
 * ⚠️ Deliberately NOT applied to the refund case: there the `spend_refund`
 * ledger row IS the terminal state (the queue's NOT EXISTS sees it), and a
 * second record of the same fact is the split authority this arc keeps closing.
 */
export const SPEND_SENT_RESOLVE_SQL =
  `UPDATE spend_sent SET resolved = ?2, resolution = ?3
     WHERE ref = ?1 AND resolved IS NULL`;

/**
 * Reverse a resolved-dead reservation. One guarded statement per debited entry,
 * mirroring PaySpendReverseCall's compensating rows exactly.
 *
 * The guard is in the WHERE, not in a preceding read: a concurrent manual
 * /pay/spend-reverse makes this write zero rows instead of a second refund.
 *
 * ⚠️ IT IS KEYED (user_id, ref), NOT ref ALONE — a test caught the ref-only
 * version under-refunding. A reimbursed spend has TWO debited rows under one ref
 * (the payer's `spend_debit` plus the sponsor's `spend_reimburse`), and the batch
 * runs sequentially: the first insert creates a spend_refund for that ref, so a
 * ref-scoped NOT EXISTS turns every later statement into a silent no-op. The
 * payer gets whole, the sponsor stays out of pocket, and nothing errors.
 *
 * The per-user key is also exactly the ledger's own idempotency index
 * (UNIQUE(user_id, kind, ref) — migration 0014), so the guard and the backstop
 * behind it agree on what "already refunded" means, and a manual reverse — which
 * writes one row per debited entry, keyed the same way — still collides row for
 * row rather than doubling anything.
 */
export const RECONCILE_REFUND_SQL =
  `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
   SELECT ?1, ?2, 'spend_refund', ?3, 'platform'
   WHERE NOT EXISTS (
     SELECT 1 FROM ledger
      WHERE ref = ?3 AND kind = 'spend_refund' AND user_id = ?1)`;

/**
 * One reconciliation pass. Returns a summary for the cron log.
 *
 * Never throws: it runs inside `ctx.waitUntil` alongside the other cron work,
 * and a reconcile failure must not take down job dispatch or the Telegram poll.
 */
export async function reconcileSentSpends(
  env: any, nowSec: number, limit: number = RECONCILE_BATCH,
): Promise<{ checked: number; settled: number; refunded: number; unknown: number; skipped: number }> {
  const out = { checked: 0, settled: 0, refunded: 0, unknown: 0, skipped: 0 };
  let rows: any[] = [];
  try {
    const res = await env.DB.prepare(SPEND_SENT_OPEN_SQL).bind(nowSec, limit).all();
    rows = res?.results || [];
  } catch (err: any) {
    // Includes "no such column: resolved" on a deployment that has the code but
    // not migration 0027 — reconcile nothing rather than poison the cron.
    console.log(err, "reconcile: open-queue read");
    return out;
  }
  const resolve = async (ref: string, resolution: string) => {
    await env.DB.prepare(SPEND_SENT_RESOLVE_SQL).bind(ref, nowSec, resolution).run()
      .catch((err: any) => { console.log(err, "reconcile: resolve mark"); });
  };
  for (const r of rows) {
    out.checked++;
    const ref = String(r.ref);
    const network = refNetwork(env, ref);
    if (!network) {
      // Unparseable ref → we cannot know WHICH chain to ask, so we ask nothing.
      // Left in the queue on purpose: a human can still resolve it, and marking
      // it resolved would hide a debited user behind a clean-looking sweep.
      out.skipped++;
      console.log(JSON.stringify({ tag: "reconcile-skip", ref, reason: "unknown network in ref" }));
      continue;
    }
    const redeemed = await authorizationRedeemed(env, String(r.payer), String(r.nonce), network);
    if (redeemed === null) { out.unknown++; continue; }
    if (redeemed) {
      // ✅ THE COMMON CASE — see the live measurement in the header. It settled:
      // the debit is correct, nothing to write to the ledger, so record the
      // verdict itself and let the queue drain.
      out.settled++;
      await resolve(ref, "settled");
      console.log(JSON.stringify({
        tag: "reconcile-settled", ref, userId: String(r.user_id),
        payee: r.payee || null, network,
      }));
      continue;
    }
    // ❌ Not redeemed, and the contract will no longer accept it. Refund.
    let entries: any[] = [];
    try {
      const res = await env.DB.prepare(
        "SELECT user_id, delta_micro FROM ledger WHERE ref = ? AND kind IN ('spend_debit','spend_reimburse')"
      ).bind(ref).all();
      entries = res?.results || [];
    } catch (err: any) {
      // Couldn't read what to reverse — that is not permission to reverse
      // nothing and call it done. Stay open, try next tick.
      console.log(err, "reconcile: entries read");
      out.unknown++;
      continue;
    }
    if (!entries.length) {
      // Nothing was ever debited under this ref (reversed by hand before the
      // mark, or a reservation that never committed). There is no money to give
      // back, so this is resolved — but it is NOT "settled", and recording it as
      // such would claim a payment landed when the chain just said it didn't.
      out.settled++;
      await resolve(ref, "no_reservation");
      console.log(JSON.stringify({
        tag: "reconcile-no-reservation", ref, userId: String(r.user_id), network,
      }));
      continue;
    }
    try {
      await env.DB.batch(entries.map((e: any) =>
        env.DB.prepare(RECONCILE_REFUND_SQL).bind(e.user_id, -Number(e.delta_micro), ref)
      ));
      out.refunded++;
      console.log(JSON.stringify({
        tag: "reconcile-refunded", ref, userId: String(r.user_id),
        payee: r.payee || null, network, entries: entries.length,
        valid_before: Number(r.valid_before) || null,
      }));
    } catch (err: any) {
      // A UNIQUE violation means someone refunded it between the queue read and
      // now — the correct outcome, already achieved.
      if (String(err?.message || err).includes("UNIQUE")) { out.refunded++; continue; }
      console.log(err, "reconcile: refund");
      out.unknown++;
    }
  }
  if (out.checked) console.log(JSON.stringify({ tag: "reconcile-sweep", ...out }));
  return out;
}

/**
 * 🔍 POST /pay/settle-unknown (internal)
 *   { payer, nonce, slug, priceMicro, txHash?, valueMicro?, network?, payTo?, validBefore? }
 *
 * Records that OUR receiver took a payment whose settlement was submitted but
 * never confirmed — the receiver-side mirror of /pay/spend-sent, and the last
 * unreconciled money surface in the x402 loop (migration 0028).
 *
 * ⚠️ THE FAILURE DIRECTION IS INVERTED, and that is the whole reason this is a
 * separate table and not a row in `spend_sent`. On the payer side an `unknown`
 * risks refunding money that landed: we hold the float, so the safe move is to do
 * nothing. Here the risk is the mirror image — the transfer very probably DID
 * confirm (it was verified, signed, accepted and broadcast; we merely stopped
 * watching at 60s), the USDC is at X402_PAY_TO, and the tiny's owner was never
 * credited because the route 402s before Step 4. Doing nothing costs a creator
 * their earnings, silently. So this side must record ENOUGH to pay them later.
 *
 * "Enough" is the point of the strict validation below. A row here has exactly one
 * purpose — to be resolved into a credit — so a row that cannot be resolved is not
 * a safety net, it is a queue entry nobody can retire. Hence the deliberate
 * INVERSION of /pay/spend-sent's rule: that endpoint stores a mark even when the
 * identity fields are garbage, because the mark itself was the safety fact and
 * refusing it would leave a bearer-instrument guard disarmed. This endpoint
 * refuses instead, and the caller keeps its `x402-reconcile` log line either way.
 *
 * It records; it does NOT credit. Crediting requires distinguishing a transfer
 * from a cancellation, and `authorizationState` — the whole basis of the payer-side
 * resolver — cannot: TinyUSDC.sol sets that same bit in _transferWithAuthorization
 * (money moved) AND in cancelAuthorization (money did not). The events differ where
 * the boolean cannot (AuthorizationUsed vs AuthorizationCanceled), so proof of
 * VALUE is a log/receipt read, not a state read. Writing the resolver against the
 * boolean would mint. Left to its own increment.
 */
export const SETTLE_UNKNOWN_SQL =
  `INSERT INTO settle_unknown
     (payer, nonce, tx_hash, slug, price_micro, value_micro, network, pay_to, valid_before)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
   ON CONFLICT(payer, nonce) DO NOTHING`;

/** The open predicate, exported for the same reason as SPEND_SENT_OPEN_WHERE: the
 *  status reader must count exactly the set the sweep takes. Trivial today (one
 *  clause) — shared anyway, because it is the day someone adds a second clause
 *  that a duplicated predicate starts lying. */
export const SETTLE_UNKNOWN_OPEN_WHERE = `WHERE resolved IS NULL`;

/** The open queue: unknowns nobody has resolved yet, oldest first. */
export const SETTLE_UNKNOWN_OPEN_SQL =
  `SELECT payer, nonce, tx_hash, slug, price_micro, value_micro, network, valid_before, created
     FROM settle_unknown
    ${SETTLE_UNKNOWN_OPEN_WHERE}
    ORDER BY created ASC
    LIMIT ?1`;

export class PaySettleUnknownCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: record an unconfirmed inbound settlement for reconciliation" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    // Identity is REQUIRED and shape-checked. `unknown` is only reachable after
    // the facilitator answered isValid on a decoded payload, so a verified
    // authorization is in hand at every call site — a missing one means the
    // caller is not who it claims to be, or the payload shape drifted, and a row
    // without it can never be resolved.
    const payer = isAddress(String(body.payer || "")) ? String(body.payer).toLowerCase() : null;
    const nonce = isTxHash(String(body.nonce || "")) ? String(body.nonce).toLowerCase() : null;
    const slug = String(body.slug || "").slice(0, 80);
    const priceMicro = Math.floor(Number(body.priceMicro));
    if (!payer || !nonce) return json({ error: "payer, nonce required" }, 400);
    if (!slug) return json({ error: "slug required" }, 400);
    // A zero/negative price would resolve into a credit of nothing (or a
    // negative one) — there is no unknown worth reconciling for a free tiny.
    if (!Number.isFinite(priceMicro) || priceMicro <= 0) return json({ error: "priceMicro required" }, 400);
    // The hash is OPTIONAL because the transport-failure branch of the receiver's
    // settlePayment reports `unknown` with no hash at all: the facilitator may have
    // submitted and lost the response. Storing a malformed one would be worse than
    // storing none — the resolver would ask for a receipt that can never exist and
    // read the miss as evidence.
    const txHash = isTxHash(String(body.txHash || "")) ? String(body.txHash).toLowerCase() : null;
    // The chain to ask, stored as the worker's OWN network name (`base` /
    // `base-sepolia` / `tiny`) — the form every chain read in this worker takes
    // (`authorizationRedeemed(env, payer, nonce, network)`, `usdcContract`,
    // `rpcUrl`), so the resolver never has to re-parse a CAIP-2 string it could
    // get wrong. The caller may send either form; `namedNetwork` accepts both.
    //
    // `namedNetwork`, never `normalizeNetwork`: the latter falls back to the
    // deployment default, and asking the WRONG chain about an authorization
    // returns a confident answer about a different ledger. NULL means "we could
    // not identify the chain" — unresolvable, and honest about it.
    const network = namedNetwork(env, body.network);
    const vm = Math.floor(Number(body.valueMicro));
    const valueMicro = Number.isFinite(vm) && vm > 0 ? vm : null;
    const vb = Math.floor(Number(body.validBefore));
    const validBefore = Number.isFinite(vb) && vb > 0 ? vb : null;
    const payTo = isAddress(String(body.payTo || "")) ? String(body.payTo).toLowerCase() : null;
    try {
      await env.DB.prepare(SETTLE_UNKNOWN_SQL)
        .bind(payer, nonce, txHash, slug, priceMicro, valueMicro, network, payTo, validBefore)
        .run();
    } catch (err: any) {
      // Reported, not swallowed: the caller is about to answer 402 for a payment
      // that may well have landed, and it needs to know whether the only record
      // of that is its own log line.
      console.log(err, "pay/settle-unknown");
      return json({ error: "record failed" }, 500);
    }
    // Structured, greppable, and complete — the alarm for a growing backlog until
    // the resolver exists.
    console.log(JSON.stringify({
      tag: "settle-unknown-recorded", payer, nonce, txHash, slug, priceMicro, network,
    }));
    return json({ ok: true, payer, nonce });
  }
}

/**
 * The terminal mark for a resolved inbound unknown (migration 0028). Same
 * `resolved IS NULL` guard and the same reason as SPEND_SENT_RESOLVE_SQL: the
 * FIRST verdict and its timestamp are what a support ticket reads, and a row that
 * is never marked comes back every minute forever, so the queue's depth stops
 * being the alarm for creators going unpaid.
 */
export const SETTLE_UNKNOWN_RESOLVE_SQL =
  `UPDATE settle_unknown SET resolved = ?3, resolution = ?4
     WHERE payer = ?1 AND nonce = ?2 AND resolved IS NULL`;

/** Attach the settling hash we learned from the log to a row that had none, so
 *  the credit's ref is recorded where a human can see it too. Never overwrites a
 *  hash we already stored — that one is what the payer's client was told. */
export const SETTLE_UNKNOWN_HASH_SQL =
  `UPDATE settle_unknown SET tx_hash = ?3
     WHERE payer = ?1 AND nonce = ?2 AND tx_hash IS NULL`;

/**
 * How far back a log query may reach, in blocks. The tiny-chain mints a block per
 * second-ish, so ~24h of history is generous for an instrument whose signed
 * deadline is minutes away, and it keeps a single `eth_getLogs` inside what any
 * node will answer. A row older than this is left OPEN rather than resolved: the
 * queue is the alarm, and "too old to prove" is not a licence to guess.
 */
export const FATE_LOOKBACK_BLOCKS = 100_000;

/** Inbound unknowns resolved per cron tick. One eth_getLogs each (plus one shared
 *  eth_blockNumber per network), so the same reasoning as RECONCILE_BATCH. */
export const SETTLE_UNKNOWN_BATCH = 5;

/**
 * 💸 THE VERDICTS WHERE THE MONEY ARRIVED AND THE CREATOR WAS NEVER PAID (c63).
 *
 * `reconcileSettleUnknown` writes exactly four terminal verdicts, and they fall
 * into two groups that a report must not blur:
 *
 *   credited            the creator WAS paid. Done.
 *   cancelled           the payer voided the instrument — nothing ever arrived.
 *                       A non-sale, not a loss.
 *   split_underfunded   ⚠️ the transfer HAPPENED (AuthorizationUsed, measured),
 *                       the payer was credited, and `/pay/invoke` then refused
 *                       the split because the owner raised their price in
 *                       between (c61). The owner got nothing.
 *   tx_claimed_elsewhere ⚠️ the transfer HAPPENED and another account already
 *                       holds the settling hash in `claimed_txs` (c60). Nobody
 *                       was credited for it here at all.
 *
 * The last two are the only states in this whole arc where real USDC landed at
 * X402_PAY_TO and no creator was paid for it. Both were made TERMINAL on purpose
 * — they can never resolve themselves, and leaving them open starved the queue —
 * and that correct decision is what makes them invisible: `unpaid_micro` only
 * sums the OPEN queue, `blocked_reasons` only describes rows still on it, and
 * `resolutions` counts rows without ever naming the money. So the moment the
 * sweep marks one, every number in this report goes calm.
 *
 * Exported as ONE list, and asserted exhaustive against the sweep's own
 * `resolve(...)` literals, because a predicate written against today's verdicts
 * goes quietly false the day a cycle invents a third one.
 */
export const STRANDED_RESOLUTIONS = ["split_underfunded", "tx_claimed_elsewhere"] as const;

/** The verdicts that are deliberately NOT stranded, for the same exhaustiveness
 *  check: a creator was paid, or nothing ever arrived to pay them with. */
export const SETTLED_RESOLUTIONS = ["credited", "cancelled"] as const;

/**
 * What the stranded rows are WORTH — count and money, in one read.
 *
 * `price_micro` is the right figure for both verdicts: it is what our own 402
 * challenge demanded, what the payer signed against, and therefore exactly what
 * the creator is owed. Money stays in SQL and the resolutions are module
 * constants interpolated in, the `WITHDRAW_DEBIT_SQL` shape.
 */
export const SETTLE_UNKNOWN_STRANDED_SQL =
  `SELECT COUNT(*) AS n, COALESCE(SUM(price_micro), 0) AS micro FROM settle_unknown
     WHERE resolved IS NOT NULL
       AND resolution IN (${STRANDED_RESOLUTIONS.map((r) => `'${r}'`).join(", ")})`;

/**
 * 🩺 Pure: WHY the sweep will refuse to credit this row on value grounds, or null
 * if it won't.
 *
 * Extracted so one function answers the question for both readers. The sweep asks
 * it to decide; /pay/reconcile-status asks it to REPORT — and those two answers
 * must be the same answer, because the whole purpose of the status endpoint is to
 * show which rows are stuck. A monitor that re-derives "stuck" from its own copy
 * of the rule would eventually report a row as actionable that the sweep silently
 * skips every minute, which is the invisible failure this endpoint exists to end.
 *
 * These blockers are PERMANENT for a given row: nothing about a stored price or a
 * stored signed value changes on its own. That is exactly why they matter more
 * than an ordinary open row — an unresolvable row is a creator who will never be
 * paid unless a human intervenes, and until now the only trace was one log line
 * per minute, discarded.
 */
export function settleUnknownValueBlocker(row: any): string | null {
  const priceMicro = Math.floor(Number(row?.price_micro));
  const valueMicro = Math.floor(Number(row?.value_micro));
  if (!Number.isFinite(priceMicro) || priceMicro <= 0) return "no price";
  if (!Number.isFinite(valueMicro) || valueMicro < priceMicro) {
    return "authorized value does not cover price";
  }
  return null;
}

/**
 * The credit pair, run IN-PROCESS rather than over HTTP.
 *
 * The live route reaches /pay/credit and /pay/invoke with `durableWrite` because
 * it is a different service (the Next.js app) talking to this worker across the
 * network. The cron is already inside the worker, so a self-`fetch` would need a
 * self-URL var that nothing else in this codebase has — and an UNSET one would
 * make the resolver silently do nothing, which is the failure this whole arc
 * exists to delete. Invoking the route classes directly runs the exact same
 * handler code (and therefore the same idempotency, the same tx reservation, the
 * same balance guards) with no new configuration surface and no round trip.
 *
 * `skipValidation` is set because these routes declare no request schema and read
 * `request.json()` themselves; the internal-key header is supplied because the
 * handlers check it, and inside the worker `env.INTERNAL_API_KEY` IS that key.
 */
async function internalPost(
  env: any, Route: any, path: string, body: any,
): Promise<{ ok: boolean; status: number; data: any }> {
  const request = new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": String(env.INTERNAL_API_KEY || "") },
    body: JSON.stringify(body),
  });
  const res: Response = await new Route({ skipValidation: true }).handle(request, env);
  const data: any = await res.json().catch(() => ({}));
  // ⚠️ The STATUS is part of the answer, not decoration. A caller has to tell a
  // permanent refusal (409: this tx belongs to another account, forever) from a
  // transient one (5xx: ask again next tick), and the body alone cannot say which
  // — both are `{error: "…"}`. Returning only `ok` forced callers to retry
  // permanent failures forever; see the 409 branch in reconcileSettleUnknown.
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
}

/**
 * 🔍 THE RECEIVER'S RESOLVER — the last unreconciled money surface in the x402
 * loop, and the mirror of `reconcileSentSpends` in every respect except the one
 * that matters: what a wrong answer costs.
 *
 * On the payer side a wrong verdict refunds money that landed — we leak our own
 * float. Here a wrong verdict credits a tiny's owner (plus a platform fee) for
 * USDC that never arrived — we MINT. So this function asks a strictly stronger
 * question than the payer's:
 *
 *   payer side:    authorizationState(payer, nonce) → bool
 *   receiver side: eth_getLogs for AuthorizationUsed | AuthorizationCanceled
 *
 * ⚠️ WHY NOT THE BOOLEAN. `authorizationState` is set to true by BOTH
 * `_transferWithAuthorization` (money moved) and `cancelAuthorization` (money did
 * not) — TinyUSDC.sol:151 and :128. Measured on a live chain in
 * chain/scripts/authorization-proof-e2e.mjs: two same-shaped authorizations, one
 * transferred and one cancelled, read back `true` and `true`, and only the logs
 * differ. Crediting on that bit would pay a creator out of a cancellation.
 *
 * ⚠️ AND WHY THE EVENT IS NOT THE WHOLE ANSWER EITHER. `AuthorizationUsed` has
 * **no amount** — both its args are indexed, `data` is empty (same measurement).
 * It proves the instrument was consumed BY A TRANSFER, not how much arrived. So
 * the credit is for `price_micro` — what our own 402 challenge demanded and what
 * the live path would have credited — and only after `value_micro`, the amount the
 * payer actually signed for, is checked to cover it. A payload authorizing less
 * than the price is not a paid request.
 *
 * The credit is the SAME PAIR the live route runs at Step 4, in the same order:
 * `/pay/credit` (deposit, keyed by the settling tx) then `/pay/invoke` (which
 * debits that credit and splits it owner/platform). Both are idempotent by ref,
 * and the ref IS the on-chain hash — so if the live request somehow also credited,
 * this collides with it instead of doubling it. That is the whole reason the ref
 * must come from the chain and never be synthesized.
 *
 * Never throws: it runs in `ctx.waitUntil` beside job dispatch and the Telegram
 * poll.
 */
export async function reconcileSettleUnknown(
  env: any, nowSec: number, limit: number = SETTLE_UNKNOWN_BATCH,
): Promise<{ checked: number; credited: number; cancelled: number; unknown: number; skipped: number }> {
  const out = { checked: 0, credited: 0, cancelled: 0, unknown: 0, skipped: 0 };
  let rows: any[] = [];
  try {
    const res = await env.DB.prepare(SETTLE_UNKNOWN_OPEN_SQL).bind(limit).all();
    rows = res?.results || [];
  } catch (err: any) {
    // Includes "no such table: settle_unknown" on a deployment that has the code
    // but not migration 0028 — resolve nothing rather than poison the cron.
    console.log(err, "settle-unknown: open-queue read");
    return out;
  }
  if (!rows.length) return out;
  // One head read per network, shared across the batch — the lookback anchor.
  const heads = new Map<string, number | null>();
  const headFor = async (network: PayNetwork) => {
    if (!heads.has(network)) heads.set(network, await blockNumber(env, network));
    return heads.get(network) ?? null;
  };
  const resolve = async (payer: string, nonce: string, resolution: string) => {
    await env.DB.prepare(SETTLE_UNKNOWN_RESOLVE_SQL).bind(payer, nonce, nowSec, resolution).run()
      .catch((err: any) => { console.log(err, "settle-unknown: resolve mark"); });
  };
  for (const r of rows) {
    out.checked++;
    const payer = String(r.payer || "");
    const nonce = String(r.nonce || "");
    const network = namedNetwork(env, r.network);
    if (!network) {
      // We stored no chain, or one this deployment can't name. Asking the default
      // chain about someone else's instrument returns a confident wrong answer, so
      // ask nothing and leave the row for a human — exactly the payer side's
      // `reconcile-skip`.
      out.skipped++;
      console.log(JSON.stringify({ tag: "settle-unknown-skip", payer, nonce, reason: "unknown network" }));
      continue;
    }
    const head = await headFor(network);
    if (head === null) { out.unknown++; continue; }
    const from = Math.max(0, head - FATE_LOOKBACK_BLOCKS);
    const fate = await authorizationFate(env, payer, nonce, network, `0x${from.toString(16)}`);
    if (!fate) {
      // Not yet on-chain, or the node can't answer. NEVER read as "not settled":
      // the money is most likely in flight, and this row's whole purpose is to
      // survive until the chain says so (c48).
      out.unknown++;
      continue;
    }
    if (fate.fate === "canceled") {
      // ❌ The payer voided the instrument. Nothing arrived and — measured — it can
      // never arrive now: a cancelled nonce can never settle. Terminal, and NOT
      // 'not_settled': recording it as such would lose the fact that the payer
      // acted, which is the difference between a lost tx and a withdrawn payment.
      out.cancelled++;
      await resolve(payer, nonce, "cancelled");
      console.log(JSON.stringify({
        tag: "settle-unknown-cancelled", payer, nonce, slug: String(r.slug || ""), network,
        tx_hash: fate.txHash,
      }));
      continue;
    }
    // ✅ AuthorizationUsed — the transfer happened. Now the amount, which the
    // event does not carry: credit `price_micro`, but only if what the payer
    // SIGNED covers it. A payload authorizing less than the price never bought
    // this request, and crediting the full price against it would mint the
    // difference. A row with no recorded value is not proof either way, so it
    // stays open for a human rather than being credited on assumption.
    const valueBlock = settleUnknownValueBlocker(r);
    if (valueBlock) {
      out.skipped++;
      console.log(JSON.stringify({
        tag: "settle-unknown-skip", payer, nonce, reason: valueBlock,
        priceMicro: Number(r.price_micro) || null,
        valueMicro: Number(r.value_micro) || null,
      }));
      continue;
    }
    const priceMicro = Math.floor(Number(r.price_micro));
    // The ref is the SETTLING TX from the log — the same key Step 4 would have
    // used, so a live credit and this one are the same row.
    const ref = fate.txHash;
    // Record the hash we learned, for the rows that arrived without one.
    await env.DB.prepare(SETTLE_UNKNOWN_HASH_SQL).bind(payer, nonce, ref).run().catch(() => {});
    try {
      const credited = await internalPost(env, PayCreditCall, "/pay/credit", {
        userId: `x402:${payer}`, amount_micro: priceMicro, kind: "deposit", ref, network,
      });
      if (!credited.ok) {
        // ⚠️ TWO VERY DIFFERENT FAILURES ARRIVE HERE, and treating them alike is
        // what c60 fixed. A 5xx/transport failure is transient — retry next tick.
        // A **409 is permanent**: `claimed_txs` has this settling hash reserved to
        // ANOTHER account, the reservation is only ever released by the account
        // that holds it (`releaseTx` is `WHERE tx_hash = ? AND user_id = ?`), and
        // nothing about a stored row changes by itself. So the retry can never
        // succeed — and because `unknown` leaves `resolved IS NULL`, the row came
        // back every minute forever: one `eth_getLogs` per tick, at the HEAD of an
        // oldest-first queue whose batch is 5, starving every resolvable payment
        // behind it. Invisible, too: `settleUnknownBlocker` only knows about the
        // network and value gates, so `/pay/reconcile-status` reported it as a
        // healthy open row and c59's pager stayed silent by design.
        //
        // Terminal, and recorded as its OWN verdict: it is NOT `credited` (no
        // creator was paid) and NOT `not_settled` (the transfer really did happen
        // — someone else banked it). A human has to decide who owns the money,
        // and `resolution` is what their support ticket reads.
        const claimed = credited.status === 409;
        if (claimed) await resolve(payer, nonce, "tx_claimed_elsewhere");
        else out.unknown++;
        console.log(JSON.stringify({
          tag: claimed ? "settle-unknown-tx-claimed" : "settle-unknown-credit-failed",
          payer, nonce, ref, network,
          error: String(credited.data?.error || "credit failed"),
        }));
        continue;
      }
      // Funded — now the split. `resource: tiny:<slug>` is what carries the
      // owner's identity and price; invoke looks both up itself.
      const invoked = await internalPost(env, PayInvokeCall, "/pay/invoke", {
        payerId: `x402:${payer}`, resource: `tiny:${String(r.slug || "")}`, ref,
      });
      if (!invoked.ok) {
        // ⚠️ THE SAME TWO-FAILURES-IN-ONE-BRANCH SHAPE AS THE CREDIT ABOVE, and the
        // comment that used to sit here ("the split can still be made") was a claim,
        // not a measurement. It is false for one reachable case.
        //
        // A **402 is permanent.** `/pay/invoke` charges the price that is live NOW;
        // we credited `price_micro`, the price our 402 challenge demanded when the
        // payer signed. An owner raising their price between those two moments is an
        // ordinary product action (`PaySetPriceCall` upserts whenever they like), and
        // it leaves the payer credited for the old price and billed for the new one:
        // the debit's `WHERE … >= price` yields 0 rows, invoke answers 402
        // `insufficient_balance`, and NOTHING about the retry can change either
        // number — the credit is idempotent by `ref`, so the next tick re-credits
        // nothing, and the stored price only ever moves further away. Measured: two
        // consecutive sweeps, payer credited once, owner paid nothing, row still open.
        //
        // So it is terminal, under its own verdict, for the same reason the 409 above
        // is: `unknown` leaves `resolved IS NULL`, which puts the row back at the HEAD
        // of an oldest-first queue whose batch is 5 — one `eth_getLogs` per tick,
        // forever, starving every resolvable payment behind it.
        //
        // It is NOT `credited` (no creator was paid) and NOT `not_settled` (the
        // transfer happened, and the payer's deposit stands — that credit is theirs
        // and marking this terminal does not touch it). What a human has to decide is
        // which price this invocation owed, and `resolution` is what their ticket
        // reads. Every other failure — 5xx, transport — is transient: retry next tick.
        const underfunded = invoked.status === 402;
        if (underfunded) await resolve(payer, nonce, "split_underfunded");
        else out.unknown++;
        console.log(JSON.stringify({
          tag: underfunded ? "settle-unknown-split-underfunded" : "settle-unknown-invoke-failed",
          payer, nonce, ref, network,
          creditedMicro: priceMicro,
          priceMicro: Number(invoked.data?.price_micro) || null,
          error: String(invoked.data?.error || "invoke failed"),
        }));
        continue;
      }
      out.credited++;
      await resolve(payer, nonce, "credited");
      console.log(JSON.stringify({
        tag: "settle-unknown-credited", payer, nonce, ref, network,
        slug: String(r.slug || ""), priceMicro,
      }));
    } catch (err: any) {
      // A transport failure mid-pair leaves an idempotent state: the credit either
      // landed (and re-credits nothing) or didn't. Either way, not resolved.
      console.log(err, "settle-unknown: credit pair");
      out.unknown++;
    }
  }
  if (out.checked) console.log(JSON.stringify({ tag: "settle-unknown-sweep", ...out }));
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 🩺 GET /pay/reconcile-status — the reader both queues never had.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many open rows the status reader will CLASSIFY (as opposed to count).
 *
 * Counting is SQL and costs nothing; deciding whether a row is permanently stuck
 * needs the same per-row logic the sweep uses (`namedNetwork`, the value check),
 * so it reads rows. Bounded, and the response says when it truncated — a monitor
 * that silently classified the first N rows and reported "0 blocked" would be the
 * same silent-cap failure this endpoint exists to delete.
 */
export const STATUS_SCAN_LIMIT = 200;

/** Migrations 0025/0027/0028 may be absent on a deployment running ahead of its
 *  schema. Every read is individually guarded, and the ABSENCE is reported rather
 *  than smoothed into a zero — see the route's doc comment. */
async function tableStatus(
  env: any, sql: string, binds: any[],
): Promise<{ ok: true; rows: any[] } | { ok: false; error: string }> {
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return { ok: true, rows: res?.results || [] };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * 🩺 GET /pay/reconcile-status (internal) — queue depth, backlog age, resolution
 * histograms, and the rows that will NEVER resolve on their own.
 *
 * ⚠️ WHY THIS EXISTS. Migrations 0027 and 0028 were both shaped around one
 * sentence, written twice, in their own comments: *the queue's depth is the
 * alarm.* 0027 added a terminal mark specifically so a settled row would stop
 * matching the open query, because "a queue permanently full of already-settled
 * rows is an alarm that is always on, i.e. no alarm at all." Both migrations paid
 * a real design cost to keep that number meaningful — and then nothing ever read
 * it. An alarm nobody looks at is not an alarm either. This is the look.
 *
 * ⚠️ AND IT REPORTS THE THING THE SWEEP LOGS AND THROWS AWAY. Both resolvers have
 * a `skipped` branch for rows they CANNOT resolve — an unnameable network, a
 * missing price, a signed value that does not cover the price (c52), an
 * unparseable ref (c50). Those are not transient: nothing about a stored row
 * changes by itself, so a skipped row is skipped again every minute, forever, and
 * the only trace was a log line per tick that no consumer read. Each one is a
 * creator who will not be paid until a human intervenes.
 *
 * ⚠️ THE METRIC THAT MATTERS MOST IS NOT DEPTH — IT IS `blocked_in_next_batch`.
 * Both sweeps take the OLDEST rows (`LIMIT 5` / `LIMIT 10`) and skip the
 * unresolvable ones in place. So a handful of permanently-blocked rows at the head
 * of the queue consume the entire batch every tick and no younger row is ever
 * reached: the resolver runs, reports work, drains nothing, and a perfectly
 * resolvable payment behind them waits forever. Depth alone cannot show that —
 * a queue of 6 with 5 blocked at the head is more broken than a queue of 400.
 *
 * ⚠️ A MISSING TABLE MUST NOT READ AS A HEALTHY ZERO. On a deployment that has
 * this code but not migration 0028, `SELECT … FROM settle_unknown` throws, and
 * returning `{open: 0}` would report the calmest possible state for the
 * deployment least able to reconcile anything. So each queue reports `present`,
 * and its counts are `null` — not `0` — when the table cannot be read.
 *
 * Read-only by construction: it writes nothing, resolves nothing and asks the
 * chain nothing (no RPC at all), so polling it is free and cannot perturb the
 * money paths it observes.
 */
export class PayReconcileStatusCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: reconciliation queue depth + stuck rows" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const nowSec = Math.floor(Date.now() / 1000);
    const status = await reconcileStatus(env, nowSec);
    // The pager's own view of itself, on the surface an operator already polls —
    // because the alarm's destination is an env var, and an unset env var is a
    // silent OFF switch that looks exactly like "nothing is wrong" forever.
    return json({ ...status, alarm: await alarmView(env, status, nowSec) });
  }
}

/**
 * The body `/pay/reconcile-status` serves, as a plain value.
 *
 * Extracted from the route so the per-minute alarm (`sweepReconcileAlarm`) reads
 * the SAME summary an operator does — not a second implementation that could
 * drift into disagreeing with the endpoint about whether anything is wrong. Zero
 * RPC, zero writes, so calling it every minute costs one set of D1 reads.
 */
export async function reconcileStatus(env: any, nowSec: number): Promise<any> {
  // ── spend_sent (payer side, migrations 0025/0026/0027) ────────────────────
  const sent: any = {
    present: false, open: null, oldest_due_age_s: null, batch: RECONCILE_BATCH,
    blocked_in_next_batch: null, unresolvable: null, not_yet_due: null,
    // `refunded` is separate from `resolutions` on purpose — see the query below.
    // null, not 0, when the table cannot be read: the same rule as every other
    // count here (a missing table is not a healthy zero).
    resolutions: null, refunded: null, total: null,
  };
  // The SAME predicate the sweep uses, so this count is that queue and not a
  // lookalike. `?1` is the clock; the fragment binds it first.
  const sentOpen = await tableStatus(
    env,
    `SELECT COUNT(*) AS n, MIN(valid_before) AS oldest FROM spend_sent ${SPEND_SENT_OPEN_WHERE}`,
    [nowSec],
  );
  if (sentOpen.ok) {
    sent.present = true;
    const row: any = sentOpen.rows[0] || {};
    sent.open = Number(row.n || 0);
    // Age since the instrument became ANSWERABLE (its signed deadline), not
    // since it was created: before the deadline there was no work to do, so
    // counting that time would report a backlog that did not exist.
    sent.oldest_due_age_s = row.oldest == null ? null : Math.max(0, nowSec - Number(row.oldest));
  } else {
    sent.error = sentOpen.error;
  }
  if (sent.present) {
    // Head-of-line waste: of the rows the NEXT tick will actually take, how many
    // will it skip? `refNetwork` is the sweep's own gate, so this is a report of
    // that decision rather than a second opinion about it.
    const head = await tableStatus(env, SPEND_SENT_OPEN_SQL, [nowSec, RECONCILE_BATCH]);
    if (head.ok) {
      sent.blocked_in_next_batch = head.rows.filter(
        (r: any) => !refNetwork(env, String(r.ref || "")),
      ).length;
    }
    // Rows the open query CANNOT SEE. `/pay/spend-sent` deliberately stores a
    // mark even when identity is malformed (the mark itself is the safety fact),
    // and pre-0026 rows have no identity at all — both are excluded by
    // `nonce IS NOT NULL`, so they hold a reservation frozen with nothing on any
    // queue to ever release it. Invisible to the sweep by design; visible here.
    const stuck = await tableStatus(
      env,
      `SELECT COUNT(*) AS n FROM spend_sent
        WHERE resolved IS NULL
          AND (nonce IS NULL OR valid_before IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM ledger
             WHERE ledger.ref = spend_sent.ref AND ledger.kind = 'spend_refund')`,
      [],
    );
    if (stuck.ok) sent.unresolvable = Number(stuck.rows[0]?.n || 0);
    // Waiting on the CONTRACT's clock, not on us — healthy, and counted apart so
    // it can never be mistaken for a backlog.
    const pending = await tableStatus(
      env,
      `SELECT COUNT(*) AS n FROM spend_sent
        WHERE resolved IS NULL AND nonce IS NOT NULL
          AND valid_before IS NOT NULL AND valid_before > ?1`,
      [nowSec],
    );
    if (pending.ok) sent.not_yet_due = Number(pending.rows[0]?.n || 0);
    const hist = await tableStatus(
      env,
      `SELECT resolution, COUNT(*) AS n FROM spend_sent
        WHERE resolved IS NOT NULL GROUP BY resolution`,
      [],
    );
    if (hist.ok) sent.resolutions = histogram(hist.rows);
    // ⚠️ THE ONE VERDICT THE HISTOGRAM ABOVE CANNOT CONTAIN — and it is the only
    // one that moves money (c62).
    //
    // `SPEND_SENT_RESOLVE_SQL` is deliberately NOT applied to the refund case:
    // there the `spend_refund` ledger row IS the terminal state (the open query's
    // NOT EXISTS sees it), and writing a second record of the same fact would be
    // the split authority this arc keeps closing. Correct — but it means the
    // refunded rows have `resolved IS NULL`, so `WHERE resolved IS NOT NULL`
    // excludes every single one of them. The report therefore listed `settled` and
    // `no_reservation` — the two outcomes where nothing happened — and omitted the
    // outcome where the platform paid a user back out of its own float.
    //
    // ⚠️ AND IT IS NOT RECOVERABLE BY ARITHMETIC, which is what made this worth a
    // query rather than a note. `total - open - Σresolutions` looks like it should
    // yield the refunds, and it does not: `not_yet_due` rows and `unresolvable`
    // rows are both counted in `total` while matching neither `open` (the queue
    // predicate excludes them) nor any resolution. Measured on a four-row fixture
    // with exactly ONE refund: total 4, open 0, Σresolutions 1 ⇒ the difference is
    // 3. An operator doing that subtraction gets a number that is wrong in the
    // direction that overstates money returned.
    //
    // Counted from the ledger, the same `(ref, kind)` join the open predicate
    // uses, so this is a report of the sweep's own terminal state and not a second
    // opinion about it. `DISTINCT ref` because a reimbursed spend writes one
    // spend_refund row PER debited entry (payer + sponsor) under a single ref —
    // counting rows would report two refunds for one reconciled instrument.
    const refunded = await tableStatus(
      env,
      `SELECT COUNT(DISTINCT ledger.ref) AS n FROM ledger
         JOIN spend_sent ON spend_sent.ref = ledger.ref
        WHERE ledger.kind = 'spend_refund'`,
      [],
    );
    if (refunded.ok) sent.refunded = Number(refunded.rows[0]?.n || 0);
    const total = await tableStatus(env, `SELECT COUNT(*) AS n FROM spend_sent`, []);
    if (total.ok) sent.total = Number(total.rows[0]?.n || 0);
  }

  // ── settle_unknown (receiver side, migration 0028) ────────────────────────
  const unknown: any = {
    present: false, open: null, oldest_open_age_s: null, batch: SETTLE_UNKNOWN_BATCH,
    blocked_in_next_batch: null, blocked: null, blocked_reasons: null,
    scanned: null, scan_truncated: null, resolutions: null, total: null,
    unpaid_micro: null,
    // ⚠️ `unpaid_micro` above is about the OPEN queue only. These two are about
    // rows that are CLOSED and still owe a creator money — see the query below.
    // null, not 0, when the table cannot be read (c62's rule).
    stranded: null, stranded_micro: null,
  };
  const unkOpen = await tableStatus(
    env,
    `SELECT COUNT(*) AS n, MIN(created) AS oldest FROM settle_unknown ${SETTLE_UNKNOWN_OPEN_WHERE}`,
    [],
  );
  if (unkOpen.ok) {
    unknown.present = true;
    const row: any = unkOpen.rows[0] || {};
    unknown.open = Number(row.n || 0);
    unknown.oldest_open_age_s = row.oldest == null ? null : Math.max(0, nowSec - Number(row.oldest));
  } else {
    unknown.error = unkOpen.error;
  }
  if (unknown.present) {
    const scan = await tableStatus(env, SETTLE_UNKNOWN_OPEN_SQL, [STATUS_SCAN_LIMIT]);
    if (scan.ok) {
      unknown.scanned = scan.rows.length;
      // No silent caps: say so when there is more than we looked at, or a
      // reported `blocked: 0` would read as "nothing is stuck" about a queue
      // that was only sampled.
      unknown.scan_truncated = scan.rows.length >= STATUS_SCAN_LIMIT;
      // c60's third blocker needs one lookup the other two don't: who holds each
      // settling hash. Asked through `deposits.ts`, which OWNS `claimed_txs` — the
      // reservation regime a monitor describes has to be the one being enforced,
      // and this file is asserted never to name that table. One query for the
      // whole scan, and a failure yields an EMPTY map: under-reporting rather
      // than inventing a blocker, the direction every guard here errs in.
      //
      // ⚠️ Case-exact, a KNOWN under-report: 0021's backfill copied `ledger.ref`
      // with no `LOWER()` and /pay/credit writes that row verbatim, so a
      // historical hash can be mixed case and is simply missed. Fixing it with
      // `LOWER(tx_hash)` would make the polled path a table scan, and the sweep's
      // own 409 resolves such a row regardless.
      const claimedBy = await claimedTxHolders(
        env, scan.rows.map((r: any) => String(r.tx_hash || "")),
      );
      // The fourth gate's lookup (see settleUnknownBlocker). Same one-query-per-
      // scan shape, same empty-map-on-failure direction.
      const livePrices = await livePricesFor(
        env, scan.rows.map((r: any) => String(r.slug || "")),
      );
      const reasons: Record<string, number> = {};
      // Oldest-first, so the first `batch` rows of this scan ARE the next tick's
      // batch — the same query, the same order, the same limit semantics.
      let headBlocked = 0;
      scan.rows.forEach((r: any, i: number) => {
        const reason = settleUnknownBlocker(env, r, claimedBy, livePrices);
        if (!reason) return;
        reasons[reason] = (reasons[reason] || 0) + 1;
        if (i < SETTLE_UNKNOWN_BATCH) headBlocked++;
      });
      const blocked = Object.values(reasons).reduce((a, b) => a + b, 0);
      unknown.blocked = blocked;
      unknown.blocked_reasons = reasons;
      unknown.blocked_in_next_batch = headBlocked;
      // What the open queue is WORTH — the money creators have not been paid.
      // Rows that will never resolve are excluded: their price is not owed to
      // anyone by this mechanism, and summing them would inflate the one number
      // an operator is most likely to act on.
      unknown.unpaid_micro = scan.rows.reduce(
        (sum: number, r: any) => sum + (settleUnknownBlocker(env, r, claimedBy, livePrices) ? 0 : Math.floor(Number(r.price_micro)) || 0),
        0,
      );
    }
    const hist = await tableStatus(
      env,
      `SELECT resolution, COUNT(*) AS n FROM settle_unknown
        WHERE resolved IS NOT NULL GROUP BY resolution`,
      [],
    );
    if (hist.ok) unknown.resolutions = histogram(hist.rows);
    // ⚠️ THE MONEY THAT ARRIVED AND WAS NEVER PAID ON (c63) — and, unlike every
    // other number in this block, it describes rows that are CLOSED.
    //
    // Everything above is a report about the OPEN queue: `unpaid_micro` sums it,
    // `blocked_reasons` describes rows still on it, `blocked_in_next_batch` is
    // the head of it. That was right while the only failure was a row that never
    // drains. c60 and c61 then made two failures TERMINAL, correctly — they can
    // never resolve themselves and leaving them open starved everything behind
    // them — and in both of them the transfer really happened (AuthorizationUsed,
    // measured) while the creator got nothing. So resolving them takes them off
    // the queue, and taking them off the queue is what silences every number here.
    //
    // ⚠️ MEASURED, and it is not merely a gap in the report: two alarm ticks paged
    // `unknown_blocker:price raised above the credited amount`, the sweep then
    // marked the row `split_underfunded`, and two ticks later the pager DELIVERED
    // "✅ x402 reconciliation is clear again" — with the owner's balance still 0
    // and the payer's $2 sitting as a deposit. A retraction is worse than the
    // silence it replaces: an operator who acts on it closes the ticket.
    //
    // ⚠️ AND THE AMOUNT IS NOT DERIVABLE FROM WHAT WAS ALREADY REPORTED. The
    // resolution histogram counts ROWS; money is not rows × anything, because
    // every row carries its own `price_micro`. Measured: `{split_underfunded: 1}`
    // alongside `unpaid_micro: 0` and `total: 1` — three numbers, none of which
    // contains the $2.00 owed. So it takes a query, not a note.
    //
    // Counted with the sweep's OWN verdict strings (STRANDED_RESOLUTIONS,
    // asserted exhaustive against its `resolve(...)` calls) so this is a report of
    // the sweep's decisions and not a second opinion about them. `cancelled` is
    // deliberately excluded: the payer voided the instrument, so nothing arrived
    // — a non-sale is not a loss, and folding it in here would inflate the one
    // figure an operator would escalate on.
    const stranded = await tableStatus(env, SETTLE_UNKNOWN_STRANDED_SQL, []);
    if (stranded.ok) {
      unknown.stranded = Number(stranded.rows[0]?.n || 0);
      unknown.stranded_micro = Number(stranded.rows[0]?.micro || 0);
    }
    const total = await tableStatus(env, `SELECT COUNT(*) AS n FROM settle_unknown`, []);
    if (total.ok) unknown.total = Number(total.rows[0]?.n || 0);
  }

  // ── withdrawals (migration 0015) ──────────────────────────────────────────
  //
  // ⚠️ THE THIRD RAIL, AND THE ONLY ONE WHERE THE STUCK MONEY IS THE USER'S OWN.
  // The two queues above are unreconciled INBOUND payments; a withdrawal is a
  // ledger debit that already left the user's balance. And unlike those two, it
  // has no sweep at all: `pending` is advanced only by the single HTTP request
  // that created it, so a request that dies takes the row's only mover with it
  // (see WITHDRAWAL_STUCK_S). Measured before this block existed: $50 debited and
  // pending for three days, with `healthy: true` and the pager saying "clear".
  const withdrawals = await withdrawalsStatus(env, nowSec);

  // `healthy` is deliberately CONSERVATIVE: it is false whenever a queue cannot
  // be read, because "I could not look" is not "nothing is wrong". A monitor
  // wants one boolean to page on; it must never be true for a deployment whose
  // tables are missing.
  //
  // ⚠️ A STUCK WITHDRAWAL MAKES IT FALSE. Every other term here is about a row
  // that will not drain; this one is about a debit that already happened, which is
  // strictly worse for the person it happened to. `healthy` is the boolean a
  // monitor pages on, so leaving it green while a user is down real money would
  // make the summary's headline claim the thing it is least entitled to say.
  const healthy = sent.present && unknown.present && withdrawals.present
    && !sent.blocked_in_next_batch && !unknown.blocked_in_next_batch
    && !sent.unresolvable && !unknown.blocked
    && !withdrawals.stuck;
  return { ok: true, now: nowSec, healthy, spend_sent: sent, settle_unknown: unknown, withdrawals };
}

/** Rows → `{resolution: count}`, with NULL resolutions named rather than dropped
 *  (a resolved row with no recorded verdict is itself worth seeing). */
function histogram(rows: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r?.resolution ?? "unrecorded")] = Number(r?.n || 0);
  return out;
}

/**
 * 🩺 Pure-ish: why the receiver's sweep will never resolve this open row, or null.
 *
 * Deliberately assembled from the sweep's OWN gates, in the sweep's order, so it
 * cannot become a second opinion: the network gate is `namedNetwork` (the same
 * call, with the same env), and the value gate is `settleUnknownValueBlocker`
 * (literally the function the sweep branches on). If either rule changes, this
 * follows automatically.
 *
 * Note what is NOT here: "no logs on chain yet" is the sweep's `unknown` branch
 * and is entirely transient — the row is waiting for a confirmation that is very
 * likely coming, which is the normal, healthy state of this queue.
 *
 * ⚠️ `claimedBy` (c60) is the THIRD gate, and it needs a lookup the other two
 * don't, so the caller supplies it: `tx_hash → the account holding that hash in
 * claimed_txs`. When the holder is someone OTHER than this row's own payer
 * account, `/pay/credit` answers 409 every single time — a reservation is released
 * only by the account that holds it — so the row can never resolve itself. Rows
 * stuck this way before c60 have no verdict recorded, which is exactly why the
 * REPORT has to be able to name the condition on its own.
 */
export function settleUnknownBlocker(
  env: any, row: any, claimedBy?: Map<string, string>, livePrices?: Map<string, number>,
): string | null {
  if (!namedNetwork(env, row?.network)) return "unknown network";
  const value = settleUnknownValueBlocker(row);
  if (value) return value;
  const hash = String(row?.tx_hash || "").toLowerCase();
  const holder = hash && claimedBy ? claimedBy.get(hash) : undefined;
  // Our own account holding it is the idempotent-success path, not a blocker.
  if (holder && holder !== `x402:${String(row?.payer || "").toLowerCase()}`) {
    return "settling tx already claimed by another account";
  }
  // The FOURTH gate: what we would credit vs what the split would charge. The
  // sweep credits `price_micro` (the challenge's price) and then invokes, which
  // charges whatever the owner's price is NOW — and a raise between those two
  // moments makes the split permanently unaffordable. Same supplied-lookup shape
  // as `claimedBy`, and an ABSENT entry is not a blocker: an unpriced resource is
  // invoke's `free: true` path, which resolves fine.
  const live = livePrices?.get(`tiny:${String(row?.slug || "")}`);
  if (live !== undefined && live > Math.floor(Number(row?.price_micro))) {
    return "price raised above the credited amount";
  }
  return null;
}

/**
 * `tiny:<slug> → the price that is ACTIVE now`, for the blocker's fourth gate.
 *
 * Chunked at 50 like `claimedTxHolders`, and for the same measured reason: D1
 * caps a statement near 100 bound parameters, and `STATUS_SCAN_LIMIT` is 200, so
 * one `IN (…)` over a full scan throws on exactly the deepest queues this report
 * exists to describe. A failure yields an EMPTY map — under-reporting rather than
 * inventing a blocker, the direction every guard in this reader errs in. Note the
 * `.catch()` cannot live on the await alone: `prepare()` itself throws when the
 * table is missing, so the try must wrap both.
 */
export async function livePricesFor(
  env: any, slugs: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [...new Set(slugs.map((s) => `tiny:${String(s || "")}`).filter((k) => k !== "tiny:"))];
  const CHUNK = 50;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      const res = await env.DB.prepare(
        `SELECT resource, price_micro FROM prices
          WHERE active = 1 AND resource IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all();
      for (const r of res?.results || []) out.set(String(r.resource), Math.floor(Number(r.price_micro)));
    } catch (err: any) {
      console.log(err, "livePricesFor");
    }
  }
  return out;
}
