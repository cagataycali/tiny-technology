// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('trial-spend-exclusion')

/**
 * 🧪→💵 THE SECOND REAL-VALUE EXIT (loop item c-f's prerequisite).
 *
 * Trial credits — Sepolia faucet USDC and the self-hosted tiny-chain's TinyUSDC,
 * which we MINT ourselves (chain/contracts/TinyUSDC.sol, owner-only mint) — are
 * spendable inside the economy but must never become real money. c-d closed the
 * withdrawal exit (WITHDRAW_DEBIT_SQL subtracts unspent trial deposits).
 *
 * But there are TWO ways real value leaves the platform, and /pay/spend was the
 * other one: it makes the platform hot wallet front REAL USDC to an external
 * x402 service and reimburses itself from the user's ledger. Its guard summed
 * TOTAL balance, so:
 *
 *   mint TinyUSDC → claim it → pay a real mainnet x402 service with it
 *
 * …and the platform ate the difference in real USDC. That needs no accomplice
 * account and no payout signature — one call. It was strictly WORSE than the
 * withdrawal leak c-d fixed, and the $1 lifetime trial cap was the only thing
 * bounding it, which is exactly the constant a gamified faucet wants to raise.
 * So this must be closed BEFORE TRIAL_CAP_MICRO.tiny goes up.
 *
 * Both exits now derive their exclusion from ONE shared fragment
 * (deposits.ts TRIAL_DEPOSITS_SUM_SQL), so a future trial network can't close one
 * exit and leave the other open — the last describe block pins that.
 *
 * Recipe as ever (tests/worker-tiny-network.test.ts): run the REAL exported SQL
 * and the REAL migrations against node:sqlite.
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
  // The shared exclusion fragment gained a second term that reads `trial_taint`
  // (migration 0024 — trial money that changed hands; see
  // tests/trial-taint-propagation.test.ts). Every statement embedding the
  // fragment now needs the table to exist, which is also the deploy ordering:
  // 0024 must be applied BEFORE the worker that references it.
  db.exec(migration('0024_trial_taint.sql'))
})

/** A deposit row, exactly as PayClaimCall writes one. */
const credit = (userId: string, micro: number, counterparty: string, ref: string) =>
  db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'deposit', ?, ?)")
    .run(userId, micro, ref, counterparty)

/**
 * The route's outbound-spend reservation, with node:sqlite's NAMED binding for
 * ?1..?6 (D1 binds these positionally from .bind()).
 * trialFactor: 1 = real network (exclude trial credit), 0 = trial network.
 */
const spend = (userId: string, amount: number, trialFactor: number, ref = `x402-${userId}-${amount}`) =>
  db.prepare(pay.SPEND_DEBIT_SQL).run({
    1: userId, 2: -amount, 3: ref, 4: 'external', 5: trialFactor, 6: amount,
  }).changes

const spendable = (userId: string) => db.prepare(pay.SPENDABLE_SQL).get({ 1: userId }).v

describe.skipIf(!present)('minted trial USDC cannot buy real goods', () => {
  it('THE LEAK: tiny-chain credit cannot fund a REAL outbound x402 payment', () => {
    credit('u1', 5_000_000, 'chain:tiny', 'tx-tiny')   // $5 of USDC we minted ourselves
    // trialFactor 1 = a real network: the platform would front real USDC here.
    expect(spend('u1', 4_000_000, 1)).toBe(0)
    // Sanity: the same balance in REAL deposits spends fine.
    credit('u2', 5_000_000, 'chain:base', 'tx-real')
    expect(spend('u2', 4_000_000, 1)).toBe(1)
  })

  it('sepolia faucet credit is excluded too — it is free money for anyone', () => {
    credit('u1', 1_000_000, 'chain:base-sepolia', 'tx-sep')
    expect(spend('u1', 1_000_000, 1)).toBe(0)
  })

  it('trial credit from BOTH chains sums into the exclusion — neither hides the other', () => {
    credit('u1', 900_000, 'chain:base-sepolia', 'tx-sep')
    credit('u1', 900_000, 'chain:tiny', 'tx-tiny')
    credit('u1', 1_500_000, 'chain:base', 'tx-real')   // only $1.50 is genuinely real
    expect(spend('u1', 1_600_000, 1, 'r-over')).toBe(0)  // $1.60 > spendable $1.50
    expect(spend('u1', 1_500_000, 1, 'r-exact')).toBe(1) // exactly the real portion clears
  })

  it('a TRIAL-network payment spends trial credit freely — we front worthless USDC', () => {
    // On the tiny-chain the "real USDC" the platform fronts is TinyUSDC it minted,
    // so letting trial balance pay for it costs nobody anything. This is what makes
    // the self-hosted chain usable as a full end-to-end x402 sandbox.
    credit('u1', 1_000_000, 'chain:tiny', 'tx-tiny')
    expect(spend('u1', 1_000_000, 0)).toBe(1)
  })

  it('real deposits are never over-excluded (the guard does not eat real balance)', () => {
    credit('u1', 10_000_000, 'chain:base', 'tx-real')
    expect(spend('u1', 10_000_000, 1)).toBe(1)
    expect(db.prepare('SELECT SUM(delta_micro) s FROM ledger WHERE user_id = ?').get('u1').s).toBe(0)
  })

  it('earned invoke_credit IS spendable — only trial DEPOSITS are excluded', () => {
    // Money a builder earned by being invoked is real (the payer funded it with
    // real balance). Excluding it would break the whole point of earning.
    credit('u1', 2_000_000, 'chain:base', 'tx-real')
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('u2', 3000000, 'invoke_credit', 'inv-1', 'u1')").run()
    expect(spend('u2', 3_000_000, 1)).toBe(1)
  })

  it('the overdraft guard still fires on a trial network (0 does not disable it)', () => {
    // trialFactor 0 removes the trial term, NOT the balance check.
    credit('u1', 1_000_000, 'chain:tiny', 'tx-tiny')
    expect(spend('u1', 2_000_000, 0)).toBe(0)
  })

  it('a spent-down trial balance stops excluding — the term tracks DEPOSITS, not history', () => {
    // $2 trial + $2 real. A trial-network payment burns $2 of balance; the trial
    // deposit total is unchanged, so the remaining $2 real is no longer spendable
    // on a real network. Deliberately conservative: the exclusion can't tell WHICH
    // dollars left, so it assumes the real ones stayed — the platform never loses.
    credit('u1', 2_000_000, 'chain:tiny', 'tx-tiny')
    credit('u1', 2_000_000, 'chain:base', 'tx-real')
    expect(spend('u1', 2_000_000, 0, 'trial-buy')).toBe(1)
    expect(spendable('u1')).toBe(0)
    expect(spend('u1', 2_000_000, 1, 'real-buy')).toBe(0)
  })
})

describe.skipIf(!present)('SPENDABLE_SQL — the figure the 402 body reports', () => {
  it('reports total minus trial deposits, matching what the debit enforces', () => {
    credit('u1', 700_000, 'chain:base-sepolia', 'tx-sep')
    credit('u1', 300_000, 'chain:tiny', 'tx-tiny')
    credit('u1', 5_000_000, 'chain:base', 'tx-real')
    expect(spendable('u1')).toBe(5_000_000)
    // The boundary the debit agrees on, to the micro-dollar.
    expect(spend('u1', 5_000_001, 1, 'over')).toBe(0)
    expect(spend('u1', 5_000_000, 1, 'exact')).toBe(1)
  })

  it('a trial-only user reads 0 spendable while holding a balance', () => {
    // The reason the 402 carries spendable_micro at all: "balance $5, need $1"
    // would read as a platform bug to a user whose $5 is all trial credit.
    credit('u1', 5_000_000, 'chain:tiny', 'tx-tiny')
    expect(spendable('u1')).toBe(5_000_000 - 5_000_000)
    expect(db.prepare('SELECT SUM(delta_micro) s FROM ledger WHERE user_id = ?').get('u1').s).toBe(5_000_000)
  })

  it('an unknown user reads 0, not null (safe to render)', () => {
    expect(spendable('nobody')).toBe(0)
  })
})

describe.skipIf(!present)('ONE exclusion, both exits — the anti-drift invariant', () => {
  it('the shared fragment names every trial counterparty and no real one', () => {
    for (const c of dep.TRIAL_COUNTERPARTIES) {
      expect(dep.TRIAL_DEPOSITS_SUM_SQL).toContain(`'${c}'`)
    }
    expect(dep.TRIAL_DEPOSITS_SUM_SQL).not.toContain("'chain:base'")
  })

  it('BOTH real-value exits embed it — adding a trial network can never open one', () => {
    // The bug this pins: c-d fixed the withdrawal clause by hand and left
    // /pay/spend's guard summing total balance. Now both statements are built from
    // the same string, so they cannot disagree about what trial money is.
    expect(wd.WITHDRAW_DEBIT_SQL).toContain(dep.TRIAL_DEPOSITS_SUM_SQL)
    expect(pay.SPEND_DEBIT_SQL).toContain(dep.TRIAL_DEPOSITS_SUM_SQL)
    expect(pay.SPENDABLE_SQL).toContain(dep.TRIAL_DEPOSITS_SUM_SQL)
  })

  it('every trial network is covered by the fragment, via its counterparty', () => {
    for (const n of dep.TRIAL_NETWORKS) {
      expect(dep.TRIAL_DEPOSITS_SUM_SQL).toContain(`'${dep.counterpartyFor(n)}'`)
    }
  })

  it('the fragment keys on ?1, the user id both statements bind first', () => {
    // If it drifted to another placeholder the guard would silently read a
    // different user's trial total — a leak that still returns plausible numbers.
    expect(dep.TRIAL_DEPOSITS_SUM_SQL).toContain('user_id = ?1')
  })
})

describe.skipIf(!present)('normalizeNetwork at the spend boundary — absent ≠ trial', () => {
  const TINY_ENV = { TINY_CHAIN_ID: '31337', TINY_CHAIN_USDC_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }

  it('an omitted/garbage network never resolves to a trial network on a real deployment', () => {
    // The trialFactor comes from normalizeNetwork(env, body.network). If a missing
    // field fell through to 'tiny'/'base-sepolia', omitting it would UNLOCK trial
    // money on a mainnet deployment — the leak reopened by a dropped JSON key.
    const realEnv = { ...TINY_ENV, PAYMENTS_NETWORK: 'base' }
    for (const junk of [undefined, '', 'nonsense', 'eip155:1', 'mainnet']) {
      expect(dep.isTrialNetwork(dep.normalizeNetwork(realEnv, junk as any))).toBe(false)
    }
  })

  it('a CAIP-2 id (what the app actually sends) resolves to the right class', () => {
    // The app passes the quote's CAIP-2 network, not the short name.
    expect(dep.normalizeNetwork(TINY_ENV, 'eip155:8453')).toBe('base')
    expect(dep.normalizeNetwork(TINY_ENV, 'eip155:84532')).toBe('base-sepolia')
    expect(dep.normalizeNetwork(TINY_ENV, 'eip155:31337')).toBe('tiny')
    expect(dep.isTrialNetwork(dep.normalizeNetwork(TINY_ENV, 'eip155:8453'))).toBe(false)
    expect(dep.isTrialNetwork(dep.normalizeNetwork(TINY_ENV, 'eip155:31337'))).toBe(true)
  })

  it('tiny is refused on a deployment without the chain configured', () => {
    // No tiny-chain env → 'tiny' is not a network here, so it can't claim trial
    // status; it falls to the deployment default.
    expect(dep.normalizeNetwork({ PAYMENTS_NETWORK: 'base' }, 'tiny')).toBe('base')
  })
})
