// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('faucet')

/**
 * 🚰 THE IN-HOUSE FAUCET (loop item c-f) — the top-up that replaces the
 * Coinbase / MoonPay / faucet.circle.com links, which point at real-money rails a
 * chain we own has nothing to do with (docs/e2e-gaps-report-2026-07-25.md §1.2).
 *
 * This is the first route in the platform that creates spendable balance with no
 * on-chain transaction behind it, so what's asserted here is the bounding, not
 * the happy path:
 *
 *  1. **One drip per user per UTC day** — enforced by the ledger's
 *     UNIQUE(user_id, kind, ref) index on `faucet:d<epochDay>`, i.e. by a write,
 *     not by a read a concurrent writer can't see (the shape migrations 0021 and
 *     0024 had to fix elsewhere).
 *  2. **A lifetime ceiling the faucet SHARES with on-chain claims** — one
 *     counterparty sum, one statement (TRIAL_CREDIT_SQL). Separate budgets would
 *     make real exposure claimCap + faucetCap while every comment still claimed
 *     one lifetime allowance.
 *  3. **A zero-reputation account is capped at exactly the pre-faucet $1** — so
 *     turning the faucet on doesn't widen a fresh signup's exposure at all; only
 *     builders other people followed earn more room.
 *  4. **Every drip stays trial money** — it's written as a plain
 *     `kind='deposit'`, `counterparty='chain:tiny'` row precisely so all three
 *     real-value exits exclude it with no new safety code (c-d withdrawals,
 *     c-f0 outbound spend, c-f0b taint). The last block pins that: a maxed-out
 *     faucet balance is worth zero withdrawable dollars.
 *
 * Recipe as ever: run the REAL exported SQL and the REAL migrations against
 * node:sqlite (tests/worker-tiny-network.test.ts, tests/trial-taint-propagation.test.ts).
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')

let dep: any, wd: any, db: any

beforeAll(async () => {
  if (!present) return
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
  // Every statement embedding the shared exclusion fragment reads trial_taint.
  db.exec(migration('0024_trial_taint.sql'))
})

/** The real grant statement both the claim path and the faucet run. */
const grant = (userId: string, micro: number, cap: number, ref: string, counterparty: string) => {
  try {
    return {
      changes: db.prepare(dep.TRIAL_CREDIT_SQL).run({
        1: userId, 2: micro, 3: cap, 4: ref, 5: counterparty,
      }).changes,
      unique: false,
    }
  } catch (e: any) {
    // UNIQUE(user_id, kind, ref) — a duplicate ref, i.e. a same-day drip or a
    // claim retry. A different answer for the caller than "ceiling spent".
    if (String(e?.message || e).includes('UNIQUE')) return { changes: 0, unique: true }
    throw e
  }
}

const balance = (userId: string): number =>
  db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get(userId).v

const trialGranted = (userId: string, counterparty: string): number =>
  db.prepare(dep.TRIAL_GRANTED_SQL).get({ 1: userId, 2: counterparty }).v

describe.skipIf(!present)('trialCapMicro — the reputation-scaled ceiling', () => {
  it('a zero-reputation account gets exactly the pre-faucet flat cap', () => {
    // THE invariant that makes shipping the faucet safe without re-auditing
    // exposure: an account nobody vouched for can obtain no more trial credit in
    // total than it could before this cycle existed.
    expect(dep.trialCapMicro('tiny', 0)).toBe(dep.TESTNET_TRIAL_CAP_MICRO)
    expect(dep.trialCapMicro('tiny')).toBe(dep.TESTNET_TRIAL_CAP_MICRO)
  })

  it('every reputation point buys FAUCET_MICRO_PER_POINT of ceiling', () => {
    const base = dep.TESTNET_TRIAL_CAP_MICRO
    expect(dep.trialCapMicro('tiny', 10)).toBe(base + 10 * dep.FAUCET_MICRO_PER_POINT)
    // 10 points is one follower (reputation.ts REP_POINTS.follow_received).
    expect(dep.trialCapMicro('tiny', 10)).toBeGreaterThan(dep.trialCapMicro('tiny', 0))
  })

  it('the curve is monotone and clamped at FAUCET_MAX_MICRO', () => {
    // Monotone matters beyond tidiness: it's what makes it safe to enforce a PAST
    // drip against a PRESENT ceiling. reputation is append-only with positive
    // grants only, so a score never falls and an earlier credit can never end up
    // exceeding a later allowance (no retroactive overdraft).
    let prev = 0
    for (const score of [0, 1, 5, 10, 50, 200, 5_000, 1e9]) {
      const cap = dep.trialCapMicro('tiny', score)
      expect(cap).toBeGreaterThanOrEqual(prev)
      expect(cap).toBeLessThanOrEqual(dep.FAUCET_MAX_MICRO)
      prev = cap
    }
    expect(dep.trialCapMicro('tiny', 1e9)).toBe(dep.FAUCET_MAX_MICRO)
  })

  it('junk / negative / non-finite scores degrade to the flat cap, never above it', () => {
    // reputationScore() returns 0 on any failure, but a corrupt read must not be
    // able to hand out the maximum either (the same rule reputationFor() follows
    // in lib/rate-limit.ts, where Infinity → base, not cap).
    for (const bad of [NaN, Infinity, -Infinity, -50, undefined, null, 'lots' as any, {} as any]) {
      expect(dep.trialCapMicro('tiny', bad as any)).toBe(dep.TESTNET_TRIAL_CAP_MICRO)
    }
  })

  it('base-sepolia never scales — its cap bounds somebody ELSE’s free money', () => {
    // Sepolia USDC comes from a third party's faucet. Standing on our network is
    // no reason to widen our exposure to a token we can't issue.
    expect(dep.trialCapMicro('base-sepolia', 500)).toBe(dep.TRIAL_CAP_MICRO['base-sepolia'])
    expect(dep.trialCapMicro('base', 500)).toBe(dep.TESTNET_TRIAL_CAP_MICRO)
  })
})

describe.skipIf(!present)('faucetNetwork — fail-closed, and narrower than isTrialNetwork', () => {
  it('drips only on the chain we can mint, and only when it is configured', () => {
    const configured = { TINY_CHAIN_ID: '31337', TINY_CHAIN_USDC_ADDRESS: '0x' + '11'.repeat(20) }
    expect(dep.faucetNetwork(configured)).toBe('tiny')
    expect(dep.faucetNetwork({})).toBe(null)
    // Half-configured is NOT half-available.
    expect(dep.faucetNetwork({ TINY_CHAIN_ID: '31337' })).toBe(null)
    expect(dep.faucetNetwork({ TINY_CHAIN_USDC_ADDRESS: configured.TINY_CHAIN_USDC_ADDRESS })).toBe(null)
    expect(dep.faucetNetwork({ ...configured, TINY_CHAIN_ID: 'nope' })).toBe(null)
  })

  it('never drips on base-sepolia, even though it IS a trial network', () => {
    // The distinction is backing, not trial-ness: a drip promises credit matched
    // by TinyUSDC we mint. Sepolia USDC only a third party can issue, so a drip
    // there would be unbackable by design rather than merely unconfigured.
    expect(dep.isTrialNetwork('base-sepolia')).toBe(true)
    expect(dep.FAUCET_NETWORK).toBe('tiny')
    expect(dep.faucetNetwork({ PAYMENTS_NETWORK: 'base-sepolia', PAYMENTS_TESTNET: '1' })).toBe(null)
  })
})

describe.skipIf(!present)('the daily ref — one drip per UTC day, keyed by a write', () => {
  it('epochDay/faucetRef roll over exactly at UTC midnight', () => {
    const day = 20_000
    const midnight = day * 86_400_000
    expect(dep.epochDay(midnight)).toBe(day)
    expect(dep.epochDay(midnight + 86_399_999)).toBe(day)
    expect(dep.epochDay(midnight + 86_400_000)).toBe(day + 1)
    expect(dep.faucetRef(midnight)).toBe(`faucet:d${day}`)
    expect(dep.faucetRef(midnight + 86_400_000)).toBe(`faucet:d${day + 1}`)
  })

  it('the ref is distinguishable from an on-chain claim in an audit', () => {
    // Drips and claims deliberately SHARE the counterparty (that's what makes
    // every exclusion cover a drip for free), so the ref is the only thing that
    // tells them apart afterwards.
    expect(dep.faucetRef(Date.now())).toMatch(/^faucet:d\d+$/)
    expect(dep.faucetRef(Date.now())).not.toMatch(/^0x/)
  })

  it('a second drip on the same day hits UNIQUE, not the ceiling', () => {
    const cp = dep.counterpartyFor('tiny')
    const cap = dep.trialCapMicro('tiny', 100) // room to spare, so only the ref can refuse
    const ref = dep.faucetRef(0)
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, ref, cp)).toEqual({ changes: 1, unique: false })
    // Same ref → the index refuses. The route reports 429 "already claimed today"
    // for this and 400 "ceiling reached" for 0-changes-no-throw; collapsing them
    // would tell a user to earn reputation when all they need is to wait a day.
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, ref, cp)).toEqual({ changes: 0, unique: true })
    expect(balance('u1')).toBe(dep.FAUCET_DRIP_MICRO)
  })

  it('tomorrow’s ref drips again', () => {
    const cp = dep.counterpartyFor('tiny')
    const cap = dep.trialCapMicro('tiny', 100)
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(0), cp).changes).toBe(1)
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(86_400_000), cp).changes).toBe(1)
    expect(balance('u1')).toBe(2 * dep.FAUCET_DRIP_MICRO)
  })

  it('nextDripInSeconds counts down to UTC midnight and never goes negative', () => {
    const midnight = 20_000 * 86_400_000
    expect(dep.nextDripInSeconds(midnight)).toBe(86_400)
    expect(dep.nextDripInSeconds(midnight + 86_399_000)).toBe(1)
    expect(dep.nextDripInSeconds(midnight + 86_400_000)).toBe(86_400)
    expect(dep.nextDripInSeconds(Date.now())).toBeGreaterThan(0)
  })
})

describe.skipIf(!present)('the shared allowance — faucet and on-chain claim draw one budget', () => {
  const cp = () => dep.counterpartyFor('tiny')

  it('a zero-reputation user can never exceed $1 across BOTH paths', () => {
    const cap = dep.trialCapMicro('tiny', 0)
    // Day 1: the drip takes the whole flat allowance.
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(0), cp()).changes).toBe(1)
    // An on-chain claim of $5 the same day: fresh ref, so the index allows it —
    // and the ceiling refuses it. This is the assertion that makes "one shared
    // allowance" true rather than aspirational.
    expect(grant('u1', 5_000_000, cap, '0x' + 'ab'.repeat(32), cp()).changes).toBe(0)
    // And tomorrow's drip is refused too — the ceiling is a LIFETIME bound.
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(86_400_000), cp()).changes).toBe(0)
    expect(balance('u1')).toBe(dep.TESTNET_TRIAL_CAP_MICRO)
  })

  it('a claim that spent the allowance first blocks the drip too (order-independent)', () => {
    const cap = dep.trialCapMicro('tiny', 0)
    expect(grant('u1', 900_000, cap, '0x' + 'cd'.repeat(32), cp()).changes).toBe(1)
    // $0.10 left → MIN clamps the drip to exactly the remainder, never $1.
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(0), cp()).changes).toBe(1)
    expect(balance('u1')).toBe(cap)
    expect(db.prepare('SELECT delta_micro v FROM ledger WHERE ref = ?').get(dep.faucetRef(0)).v).toBe(100_000)
  })

  it('a followed builder’s wider ceiling lets the drip continue past $1', () => {
    const cap = dep.trialCapMicro('tiny', 20) // two followers → $1 + $4
    for (let day = 0; day < 5; day++) {
      expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(day * 86_400_000), cp()).changes).toBe(1)
    }
    expect(balance('u1')).toBe(5 * dep.FAUCET_DRIP_MICRO)
    expect(trialGranted('u1', cp())).toBe(5 * dep.FAUCET_DRIP_MICRO)
    // …and stops dead at the ceiling.
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(5 * 86_400_000), cp()).changes).toBe(0)
    expect(balance('u1')).toBe(cap)
  })

  it('the ceiling is per-network — a drip cannot eat sepolia’s allowance', () => {
    expect(grant('u1', dep.FAUCET_DRIP_MICRO, dep.trialCapMicro('tiny', 0), dep.faucetRef(0), cp()).changes).toBe(1)
    // Sepolia's own counterparty, its own untouched budget.
    const sep = dep.counterpartyFor('base-sepolia')
    expect(grant('u1', 1_000_000, dep.trialCapMicro('base-sepolia', 0), '0x' + 'ef'.repeat(32), sep).changes).toBe(1)
    expect(balance('u1')).toBe(dep.TESTNET_TRIAL_CAP_MICRO + dep.TRIAL_CAP_MICRO['base-sepolia'])
  })

  it('concurrent drips cannot mint past the ceiling (the guard is IN the write)', () => {
    // Distinct refs, so the unique index does NOT serialize them — this is the
    // check-then-act race a preceding SELECT would have lost. Interleave by
    // running both grants against a state neither has seen the other in: sqlite
    // serializes the writes, so the second must observe the first's row.
    const cap = dep.trialCapMicro('tiny', 0)
    const a = grant('u1', dep.FAUCET_DRIP_MICRO, cap, 'faucet:dA', cp())
    const b = grant('u1', dep.FAUCET_DRIP_MICRO, cap, 'faucet:dB', cp())
    expect(a.changes + b.changes).toBe(1)
    expect(balance('u1')).toBe(cap)
  })

  it('TRIAL_GRANTED_SQL reports exactly what the ceiling enforces against', () => {
    // The figure deposit-info shows as remaining_micro must agree with the debit
    // to the micro-dollar, or the UI promises credit the write refuses.
    const cap = dep.trialCapMicro('tiny', 30)
    grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(0), cp())
    grant('u1', 2_500_000, cap, '0x' + '12'.repeat(32), cp())
    const granted = trialGranted('u1', cp())
    expect(granted).toBe(dep.FAUCET_DRIP_MICRO + 2_500_000)
    expect(cap - granted).toBeGreaterThan(0)
  })
})

describe.skipIf(!present)('a drip is trial money — worth zero withdrawable dollars', () => {
  /** WITHDRAW_DEBIT_SQL exactly as WithdrawRequestCall binds it (trialFactor 1 = real network). */
  const withdraw = (userId: string, amount: number) =>
    db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
      1: userId, 2: -amount, 3: `w-${userId}-${amount}`, 4: 'base',
      5: 1, 6: amount, 7: wd.WITHDRAW_DAILY_CAP_MICRO,
    }).changes

  it('a maxed-out faucet balance withdraws NOTHING on a real network', () => {
    // The whole reason a drip is written as kind='deposit' with the trial
    // counterparty: it inherits every exclusion instead of needing a new one.
    const cap = dep.trialCapMicro('tiny', 1e9) // the most the faucet can ever grant
    for (let day = 0; day * dep.FAUCET_DRIP_MICRO < cap; day++) {
      grant('u1', dep.FAUCET_DRIP_MICRO, cap, dep.faucetRef(day * 86_400_000), dep.counterpartyFor('tiny'))
    }
    expect(balance('u1')).toBe(cap)
    expect(balance('u1')).toBeGreaterThan(wd.WITHDRAW_MIN_MICRO)
    expect(withdraw('u1', wd.WITHDRAW_MIN_MICRO)).toBe(0)
  })

  it('real USDC alongside a drip is still fully withdrawable', () => {
    // Over-exclusion is the safe direction, but it must not be over-BROAD: a
    // faucet user's real deposits are their own money.
    grant('u1', dep.FAUCET_DRIP_MICRO, dep.trialCapMicro('tiny', 0), dep.faucetRef(0), dep.counterpartyFor('tiny'))
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('u1', 5000000, 'deposit', '0xreal', 'chain:base')").run()
    expect(withdraw('u1', 5_000_000)).toBe(1)
  })

  it('the faucet ceiling can never exceed what the exclusion covers', () => {
    // An anti-drift check on the two constants: if FAUCET_MAX_MICRO were ever
    // raised above what a single drip's counterparty is excluded for, the ceiling
    // would be bounding a real-money vector again. Both figures derive from the
    // same trial counterparty, so this is really asserting the shared definition.
    expect(dep.TRIAL_COUNTERPARTIES).toContain(dep.counterpartyFor(dep.FAUCET_NETWORK))
    expect(dep.TRIAL_DEPOSITS_SUM_SQL).toContain(`'${dep.counterpartyFor(dep.FAUCET_NETWORK)}'`)
    expect(dep.FAUCET_DRIP_MICRO).toBeLessThanOrEqual(dep.FAUCET_MAX_MICRO)
  })

  it('the faucet uses the SAME statement the on-chain claim path does', () => {
    // c-f0's dividend, applied to the grant side: one definition means the two
    // paths cannot enforce different ceilings. If a future edit gives the faucet
    // its own INSERT, this fails.
    expect(typeof dep.TRIAL_CREDIT_SQL).toBe('string')
    expect(dep.TRIAL_CREDIT_SQL).toContain("kind='deposit'")
    expect(dep.TRIAL_CREDIT_SQL).toContain('MIN(?2')
    const claimSrc = readFileSync(join(WORKER_SRC, 'deposits.ts'), 'utf8')
    // Exactly two call sites bind it: the claim's trial branch and PayFaucetCall.
    expect(claimSrc.match(/prepare\(TRIAL_CREDIT_SQL\)/g)?.length).toBe(2)
  })
})
