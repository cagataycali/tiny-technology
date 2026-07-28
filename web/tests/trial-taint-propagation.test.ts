// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('trial-taint-propagation')

/**
 * 🧪→💵 THE THIRD REAL-VALUE EXIT — trial money that changes hands (loop c-f's
 * last prerequisite, migration 0024).
 *
 * c-d closed the two exits where a user takes their OWN money out: withdrawals
 * and /pay/spend both subtract unspent trial deposits. Both key on `user_id` AND
 * `kind='deposit'` — and a paid invocation moves value to a DIFFERENT user under
 * a different kind:
 *
 *   A claims minted TinyUSDC (we own the mint) → A invokes B's paid tiny
 *   → B receives `invoke_credit`, which nothing excluded → B withdraws REAL USDC.
 *
 * Two free signups launder minted money into a payout. The only bound was
 * TRIAL_CAP_MICRO ($1 lifetime), which is exactly the constant the gamified
 * faucet exists to raise — so this had to close before the cap moves.
 *
 * The fix propagates taint: an invocation that could only have been funded by
 * trial balance writes a `trial_taint` row on the PAYEE, and the shared exclusion
 * fragment both exits already embed gained that term. One edit, both exits, and
 * any future exit built from the fragment inherits it.
 *
 * Recipe as ever (tests/trial-spend-exclusion.test.ts): run the REAL exported SQL
 * and the REAL migrations against node:sqlite. D1 binds ?1..?N positionally from
 * .bind(); node:sqlite binds them as NAMED parameters.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')

let pay: any, dep: any, wd: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
  dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
  wd = await import(workerFile('withdrawals.ts') /* @vite-ignore */)
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(migration('0014_payments.sql'))
  db.exec(migration('0015_withdrawals.sql'))
  db.exec(migration('0024_trial_taint.sql'))
})

/** A deposit row, exactly as PayClaimCall writes one. */
const credit = (userId: string, micro: number, counterparty: string, ref: string) =>
  db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'deposit', ?, ?)")
    .run(userId, micro, ref, counterparty)

/**
 * One paid invocation, run as the route's real batch — in order, so the taint
 * statement sees the payer's post-debit state the way it does in D1.
 * Returns { debited, tainted } row counts.
 */
const invoke = (payer: string, payee: string, priceMicro: number, ref: string) => {
  const split = pay.splitInvoke(priceMicro)
  const debited = db.prepare(
    `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
     SELECT ?1, ?2, 'invoke_debit', ?3, ?4
     WHERE (SELECT COALESCE(SUM(delta_micro),0) FROM ledger WHERE user_id = ?1) >= ?5`
  ).run({ 1: payer, 2: split.debit, 3: ref, 4: payee, 5: priceMicro }).changes
  if (!debited) return { debited: 0, tainted: 0 }
  db.prepare(
    `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
     SELECT ?1, ?2, 'invoke_credit', ?3, ?4
     WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?4 AND kind='invoke_debit' AND ref = ?3)`
  ).run({ 1: payee, 2: split.ownerCredit, 3: ref, 4: payer })
  db.prepare(
    `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
     SELECT 'platform', ?1, 'platform_fee', ?2, ?3
     WHERE EXISTS (SELECT 1 FROM ledger WHERE user_id = ?3 AND kind='invoke_debit' AND ref = ?2)`
  ).run({ 1: split.fee, 2: ref, 3: payer })
  const tainted = db.prepare(pay.TAINT_INVOKE_SQL).run({
    1: payer, 2: ref, 3: payee, 4: split.ownerCredit,
  }).changes
  return { debited, tainted }
}

const taintOf = (userId: string) =>
  db.prepare('SELECT COALESCE(SUM(micro),0) v FROM trial_taint WHERE user_id = ?').get(userId).v

const spend = (userId: string, amount: number, trialFactor: number, ref = `x402-${userId}-${amount}`) =>
  db.prepare(pay.SPEND_DEBIT_SQL).run({
    1: userId, 2: -amount, 3: ref, 4: 'external', 5: trialFactor, 6: amount,
  }).changes

const spendable = (userId: string) => db.prepare(pay.SPENDABLE_SQL).get({ 1: userId }).v

/** The real withdrawal debit — ?5 trialFactor, ?6 amount, ?7 daily cap. */
const withdraw = (userId: string, amount: number, trialFactor = 1, ref = `wd-${userId}-${amount}`) =>
  db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
    1: userId, 2: -amount, 3: ref, 4: 'base', 5: trialFactor, 6: amount, 7: wd.WITHDRAW_DAILY_CAP_MICRO,
  }).changes

describe.skipIf(!present)('THE LEAK: trial credit laundered through a paid invocation', () => {
  it('a payee paid from trial balance cannot withdraw that money as real USDC', () => {
    credit('mallory', 1_000_000, 'chain:tiny', 'tx-minted')   // $1 of USDC we minted
    // Mallory buys $1 of her own accomplice's paid tiny.
    expect(invoke('mallory', 'accomplice', 1_000_000, 'inv-1').debited).toBe(1)
    // The accomplice holds real-looking invoke_credit…
    expect(db.prepare('SELECT SUM(delta_micro) s FROM ledger WHERE user_id = ?').get('accomplice').s).toBe(999_000)
    // …but it is trial-class, so the payout is refused.
    expect(withdraw('accomplice', 999_000)).toBe(0)
  })

  it('the taint equals the credit when the payment was ENTIRELY trial-funded', () => {
    credit('mallory', 2_000_000, 'chain:base-sepolia', 'tx-faucet')
    invoke('mallory', 'bob', 2_000_000, 'inv-1')
    expect(taintOf('bob')).toBe(1_999_000)   // price minus the platform fee
  })

  it('a payer with REAL balance taints nobody — the ordinary case stays clean', () => {
    credit('alice', 5_000_000, 'chain:base', 'tx-real')
    expect(invoke('alice', 'bob', 2_000_000, 'inv-1').tainted).toBe(0)
    expect(taintOf('bob')).toBe(0)
    // Bob's earnings are real money and withdraw normally.
    expect(withdraw('bob', 1_999_000)).toBe(1)
  })

  it('a MIXED payer taints only the portion real money could not cover', () => {
    // $3 real + $2 trial = $5 balance. A $4 payment leaves $1 — below the $2
    // trial the payer holds, so $1 of it could only have been trial money.
    credit('mallory', 3_000_000, 'chain:base', 'tx-real')
    credit('mallory', 2_000_000, 'chain:tiny', 'tx-minted')
    invoke('mallory', 'bob', 4_000_000, 'inv-1')
    expect(taintOf('bob')).toBe(1_000_000)
    // So Bob may withdraw his earnings MINUS that dollar.
    expect(withdraw('bob', 3_999_000 - 1_000_000 + 1)).toBe(0)
    expect(withdraw('bob', 3_999_000 - 1_000_000)).toBe(1)
  })

  it('taint never exceeds what the payee actually received', () => {
    // A payer holding far more trial money than this invocation is worth must not
    // taint the payee for more than the payee got — that would confiscate the
    // payee's own unrelated real balance.
    credit('mallory', 900_000_000, 'chain:tiny', 'tx-whale')
    credit('bob', 10_000_000, 'chain:base', 'tx-bob-real')
    invoke('mallory', 'bob', 1_000_000, 'inv-1')
    expect(taintOf('bob')).toBe(999_000)
    expect(withdraw('bob', 10_000_000)).toBe(1)   // Bob's own $10 is untouched
  })
})

describe.skipIf(!present)('taint travels — relaying through more accounts gains nothing', () => {
  it('a tainted payee passes the taint on when they spend it', () => {
    // The whole point of using the SHARED fragment inside the taint expression:
    // it already counts taint the payer received, so hop 2 is taint-funded too.
    credit('mallory', 1_000_000, 'chain:tiny', 'tx-minted')
    invoke('mallory', 'hop1', 1_000_000, 'inv-1')
    expect(taintOf('hop1')).toBe(999_000)
    invoke('hop1', 'hop2', 999_000, 'inv-2')
    expect(taintOf('hop2')).toBe(998_000)
    expect(withdraw('hop2', 998_000)).toBe(0)
  })

  it('a hop funded by a mix of taint and real money splits the same way', () => {
    credit('mallory', 1_000_000, 'chain:tiny', 'tx-minted')
    credit('hop1', 1_000_000, 'chain:base', 'tx-hop-real')
    invoke('mallory', 'hop1', 1_000_000, 'inv-1')   // hop1: $1.999 balance, $0.999 tainted
    invoke('hop1', 'hop2', 1_500_000, 'inv-2')      // leaves $0.499 < $0.999 taint
    expect(taintOf('hop2')).toBe(500_000)
  })
})

describe.skipIf(!present)('the taint write is idempotent and gated', () => {
  it('a retried invocation with the same ref does not double-taint', () => {
    credit('mallory', 2_000_000, 'chain:tiny', 'tx-minted')
    const split = pay.splitInvoke(1_000_000)
    invoke('mallory', 'bob', 1_000_000, 'inv-1')
    const before = taintOf('bob')
    // Replay just the taint statement — the ledger half is already a no-op via
    // the unique index, and this must be one too.
    db.prepare(pay.TAINT_INVOKE_SQL).run({ 1: 'mallory', 2: 'inv-1', 3: 'bob', 4: split.ownerCredit })
    expect(taintOf('bob')).toBe(before)
  })

  it('no taint without a settlement — it gates on the debit row existing', () => {
    // If the debit's balance guard failed, no money moved and no taint may land.
    credit('mallory', 2_000_000, 'chain:tiny', 'tx-minted')
    const split = pay.splitInvoke(1_000_000)
    const n = db.prepare(pay.TAINT_INVOKE_SQL).run({
      1: 'mallory', 2: 'never-settled', 3: 'bob', 4: split.ownerCredit,
    }).changes
    expect(n).toBe(0)
    expect(taintOf('bob')).toBe(0)
  })

  it('a refund gives the taint back — the payee no longer holds the money', () => {
    // Leaving it would permanently shrink the payee's withdrawable balance for a
    // payment that was undone. A negative row, not a DELETE: append-only audit.
    credit('mallory', 1_000_000, 'chain:tiny', 'tx-minted')
    invoke('mallory', 'bob', 1_000_000, 'inv-1')
    expect(taintOf('bob')).toBe(999_000)
    const reversal = db.prepare(
      `INSERT OR IGNORE INTO trial_taint (user_id, micro, kind, ref)
       SELECT user_id, -micro, 'refund', ref FROM trial_taint WHERE kind = 'invoke' AND ref = ?1`
    )
    reversal.run({ 1: 'inv-1' })
    expect(taintOf('bob')).toBe(0)
    // Rows are kept, not deleted — both halves are auditable.
    expect(db.prepare('SELECT COUNT(*) c FROM trial_taint WHERE ref = ?').get('inv-1').c).toBe(2)
    // And refunding twice changes nothing.
    reversal.run({ 1: 'inv-1' })
    expect(taintOf('bob')).toBe(0)
  })
})

describe.skipIf(!present)('ONE exclusion, EVERY exit — the anti-drift invariant', () => {
  it('both real-value exits pick up the taint term through the shared fragment', () => {
    // The bug shape this pins: c-d fixed the withdrawal clause by hand and left
    // /pay/spend summing total balance. Taint is added ONCE, to the fragment both
    // embed, so neither exit can be updated without the other.
    expect(dep.TRIAL_DEPOSITS_SUM_SQL).toContain(dep.TRIAL_TAINT_SUM_SQL)
    expect(wd.WITHDRAW_DEBIT_SQL).toContain(dep.TRIAL_TAINT_SUM_SQL)
    expect(pay.SPEND_DEBIT_SQL).toContain(dep.TRIAL_TAINT_SUM_SQL)
    expect(pay.SPENDABLE_SQL).toContain(dep.TRIAL_TAINT_SUM_SQL)
    expect(wd.TRIAL_BALANCE_SQL).not.toContain('trial_taint')  // reporting-only, see below
  })

  it('the taint term keys on ?1 like every other term in the fragment', () => {
    // Drift to another placeholder would silently read a DIFFERENT user's taint —
    // a leak that still returns plausible numbers.
    expect(dep.TRIAL_TAINT_SUM_SQL).toContain('user_id = ?1')
  })

  it('an untainted user is unaffected to the micro-dollar', () => {
    // The new term must be a true no-op for everyone who never touched trial
    // money, or it would quietly under-report every real balance on the platform.
    credit('alice', 7_500_000, 'chain:base', 'tx-real')
    expect(spendable('alice')).toBe(7_500_000)
    expect(spend('alice', 7_500_000, 1)).toBe(1)
  })

  it('the outbound x402 exit is closed too, not just withdrawals', () => {
    // Buying a real mainnet service with laundered trial credit costs the platform
    // real USDC out of its hot wallet — worse than a withdrawal, since it needs no
    // payout signature.
    credit('mallory', 1_000_000, 'chain:tiny', 'tx-minted')
    invoke('mallory', 'bob', 1_000_000, 'inv-1')
    expect(spendable('bob')).toBe(0)
    expect(spend('bob', 999_000, 1)).toBe(0)
    // …but it still spends fine on a trial network, where the USDC we front is
    // itself minted. Trial money stays usable INSIDE the economy.
    expect(spend('bob', 999_000, 0)).toBe(1)
  })

  it('a trial-network payout still ignores the exclusion entirely (factor 0)', () => {
    credit('mallory', 2_000_000, 'chain:tiny', 'tx-minted')
    invoke('mallory', 'bob', 2_000_000, 'inv-1')
    expect(withdraw('bob', 1_999_000, 0)).toBe(1)
  })
})
