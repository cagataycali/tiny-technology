// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('reputation')

/**
 * 🏅 REPUTATION — the user's "just give people reputation when they follow each
 * other" (loop item p-c), which is what will let the login walls relax for
 * builders the network vouched for instead of treating everyone as an anon IP.
 *
 * Two things can go wrong, and both are what these tests exist to prevent:
 *
 *  1. **Points become money.** Balance is `SUM(delta_micro)` over ALL ledger
 *     kinds at five money sites, so a `reputation` ledger kind (what the gap
 *     report first suggested) would have inflated spendable balance AND slipped
 *     past the withdrawal trial-exclusion (which filters kind='deposit') —
 *     minting withdrawable USDC out of follows. Reputation gets its own table;
 *     the last describe block pins that the money statements never see it.
 *
 *  2. **Points get farmed.** A re-follow legitimately opens a FRESH graph edge
 *     (unfollow closes it bitemporally), so "did an edge just get created?" is
 *     NOT a safe grant signal — follow/unfollow/re-follow would pay every
 *     round. The grant is keyed by the PAIR and guarded by a UNIQUE index, so
 *     the farm is a no-op at the DB.
 *
 * Same recipe as tests/deposit-integrity.test.ts: import the worker's REAL
 * exported SQL and run it, plus the REAL migration file, against node:sqlite.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')

let rep: any, wd: any, db: any

beforeAll(async () => {
  if (!present) return
  rep = await import(workerFile('reputation.ts') /* @vite-ignore */)
  wd = await import(workerFile('withdrawals.ts') /* @vite-ignore */)
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(migration('0014_payments.sql'))    // ledger (the money table)
  db.exec(migration('0015_withdrawals.sql'))
  db.exec(migration('0024_trial_taint.sql'))  // the trial exclusion reads it
  db.exec(migration('0022_reputation.sql'))  // the new table under test
})

/** The route's grant, with node:sqlite's NAMED binding for ?1..?4 (D1 binds these positionally). */
const grant = (userId: string, kind: string, ref: string, points?: number) =>
  db.prepare(rep.GRANT_SQL).run({
    1: userId, 2: points ?? rep.REP_POINTS[kind], 3: kind, 4: ref,
  }).changes

const score = (userId: string) => db.prepare(rep.SCORE_SQL).get(userId).v

describe.skipIf(!present)('the point table — earned, auditable, append-only', () => {
  it('a follow grants the TARGET points; the score is the sum of grants', () => {
    expect(grant('target', 'follow_received', rep.followRef('a', 'target'))).toBe(1)
    expect(score('target')).toBe(rep.REP_POINTS.follow_received)
    // A second, different follower pays again — reputation grows with reach.
    expect(grant('target', 'follow_received', rep.followRef('b', 'target'))).toBe(1)
    expect(score('target')).toBe(rep.REP_POINTS.follow_received * 2)
  })

  it('a user with no grants scores 0 (not null — the read is safe to render)', () => {
    expect(score('nobody')).toBe(0)
  })

  it('every point kind is worth something positive (no silently-free kind)', () => {
    for (const [kind, points] of Object.entries(rep.REP_POINTS)) {
      expect(points, kind).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(!present)('farm resistance — the whole reason for the ref key', () => {
  it('follow → unfollow → RE-follow grants exactly ONCE', () => {
    const ref = rep.followRef('farmer', 'target')
    expect(grant('target', 'follow_received', ref)).toBe(1)
    // …unfollow closes the edge, re-follow opens a brand-new one; the route
    // recomputes the same pair ref, so the conflict guard eats the repeat.
    for (let round = 0; round < 50; round++) {
      expect(grant('target', 'follow_received', ref)).toBe(0)
    }
    expect(score('target')).toBe(rep.REP_POINTS.follow_received)
    expect(db.prepare('SELECT COUNT(*) c FROM reputation').get().c).toBe(1)
  })

  it('following 500 people earns the FOLLOWER nothing — only being followed pays', () => {
    // Mirrors the route: the grant's userId is always the TARGET.
    for (let i = 0; i < 500; i++) {
      grant(`t${i}`, 'follow_received', rep.followRef('sybil', `t${i}`))
    }
    expect(score('sybil')).toBe(0)
    expect(score('t0')).toBe(rep.REP_POINTS.follow_received)
  })

  it('the mutual ref is symmetric, so a mutual pair pays each side once', () => {
    // Whichever direction completes the mutual, both callers derive one key.
    expect(rep.mutualRef('a', 'b')).toBe(rep.mutualRef('b', 'a'))
    const ref = rep.mutualRef('a', 'b')
    expect(grant('a', 'mutual_follow', ref)).toBe(1)
    expect(grant('b', 'mutual_follow', ref)).toBe(1)   // per-USER row: not a conflict
    expect(grant('a', 'mutual_follow', ref)).toBe(0)   // …but a repeat for 'a' is
    expect(score('a')).toBe(rep.REP_POINTS.mutual_follow)
    expect(score('b')).toBe(rep.REP_POINTS.mutual_follow)
  })

  it('the same ref under a DIFFERENT kind is a separate grant (kind is part of the key)', () => {
    const ref = 'follow:a:b'
    expect(grant('b', 'follow_received', ref)).toBe(1)
    expect(grant('b', 'mutual_follow', ref)).toBe(1)
    expect(score('b')).toBe(rep.REP_POINTS.follow_received + rep.REP_POINTS.mutual_follow)
  })

  it('a mutual follow pays a pair 15 points total each — the full realistic path', () => {
    // a follows b: b earns 10, no mutual yet.
    grant('b', 'follow_received', rep.followRef('a', 'b'))
    // b follows back: a earns 10, and the mutual bonus lands on BOTH.
    grant('a', 'follow_received', rep.followRef('b', 'a'))
    const m = rep.mutualRef('a', 'b')
    grant('a', 'mutual_follow', m)
    grant('b', 'mutual_follow', m)
    const each = rep.REP_POINTS.follow_received + rep.REP_POINTS.mutual_follow
    expect(score('a')).toBe(each)
    expect(score('b')).toBe(each)
    // And re-running the whole exchange changes nothing.
    grant('b', 'follow_received', rep.followRef('a', 'b'))
    grant('a', 'mutual_follow', m)
    expect(score('a')).toBe(each)
    expect(score('b')).toBe(each)
  })
})

describe.skipIf(!present)('points are NOT money — the invariant that kept it out of the ledger', () => {
  const CAP = 500_000_000
  const debit = (userId: string, amount: number, trialFactor = 1) =>
    db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
      1: userId, 2: -amount, 3: `w-${userId}-${amount}`, 4: 'base',
      5: trialFactor, 6: amount, 7: CAP,
    }).changes

  it('a huge reputation score buys ZERO withdrawable balance', () => {
    for (let i = 0; i < 100; i++) grant('u1', 'follow_received', rep.followRef(`f${i}`, 'u1'))
    expect(score('u1')).toBe(100 * rep.REP_POINTS.follow_received) // 1000 points
    // The real withdrawal statement sees no money at all.
    expect(debit('u1', 1_000_000)).toBe(0)
    expect(db.prepare('SELECT COALESCE(SUM(delta_micro),0) s FROM ledger WHERE user_id = ?').get('u1').s).toBe(0)
  })

  it('reputation lives in its own table — the money SQL never names it', () => {
    // If reputation were a ledger kind, THIS is where it would leak: the debit's
    // balance term sums every kind, and its trial exclusion only filters
    // kind='deposit', so points would have been withdrawable real USDC.
    expect(wd.WITHDRAW_DEBIT_SQL).not.toMatch(/reputation/i)
    expect(wd.TRIAL_BALANCE_SQL).not.toMatch(/reputation/i)
    expect(rep.GRANT_SQL).toMatch(/INTO reputation/)
    expect(rep.GRANT_SQL).not.toMatch(/ledger/i)
    expect(rep.SCORE_SQL).not.toMatch(/ledger/i)
  })

  it('the breakdown explains WHERE standing came from, without touching money', () => {
    grant('u1', 'follow_received', rep.followRef('a', 'u1'))
    grant('u1', 'follow_received', rep.followRef('b', 'u1'))
    grant('u1', 'mutual_follow', rep.mutualRef('a', 'u1'))
    const rows = db.prepare(rep.BREAKDOWN_SQL).all('u1')
    expect(rows).toEqual([
      { kind: 'follow_received', points: rep.REP_POINTS.follow_received * 2, n: 2 },
      { kind: 'mutual_follow', points: rep.REP_POINTS.mutual_follow, n: 1 },
    ])
    // Same total the allowance curve consumes.
    expect(rows.reduce((s: number, r: any) => s + r.points, 0)).toBe(score('u1'))
    expect(rep.BREAKDOWN_SQL).not.toMatch(/ledger/i)
  })

  it('money and points coexist without interfering in either direction', () => {
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('u1', 5000000, 'deposit', 'tx1', 'chain:base')").run()
    grant('u1', 'follow_received', rep.followRef('f', 'u1'))
    expect(debit('u1', 5_000_000)).toBe(1)             // real money still spends
    expect(score('u1')).toBe(rep.REP_POINTS.follow_received) // spending doesn't burn points
  })
})
