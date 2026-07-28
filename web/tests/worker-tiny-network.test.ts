// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('worker-tiny-network')

/**
 * 🔗 THE WORKER'S HALF of the self-hosted tiny-chain (loop item c-d).
 *
 * Cycle 3 taught the Next.js app about `tiny` (lib/x402/tiny-chain.ts) but the
 * worker — which owns the LEDGER — still knew only the two Base chains, and its
 * network parsing coerced anything unknown to `base`. That mismatch is a mint:
 *
 *   - a `tiny` DEPOSIT claim credited 1:1 as REAL money (the trial branch was
 *     `network === 'base-sepolia'`), and TinyUSDC is minted by us at will
 *     (chain/contracts/TinyUSDC.sol, owner-only mint);
 *   - a `tiny` WITHDRAWAL was recorded as `base` (`=== 'base-sepolia' ? … :
 *     'base'`) and its trialFactor of 1... except the exclusion clause only
 *     named `chain:base-sepolia`, so minted credits were withdrawable as real
 *     USDC.
 *
 * So `tiny` is TRIAL-class, exactly like Sepolia: spendable inside the economy,
 * lifetime-capped, never withdrawable. These tests pin that — the network
 * helpers as pure functions, and the two money statements against real sqlite
 * (the tests/scheduler-cas.test.ts recipe: run the REAL exported SQL).
 */

const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3' // deterministic anvil deploy addr
const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')

let dep: any, wd: any, db: any

/** A tiny-chain deployment. */
const TINY_ENV = { TINY_CHAIN_ID: '31337', TINY_CHAIN_USDC_ADDRESS: USDC, PAYMENTS_NETWORK: 'tiny' }

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
  // The trial exclusion fragment reads `trial_taint` too (migration 0024 — trial
  // money that changed hands via a paid invocation).
  db.exec(migration('0024_trial_taint.sql'))
})

describe.skipIf(!present)('tinyChain(env) — fail-closed, mirrors the app config', () => {
  it('parses a valid deployment into CAIP-2 + lowercased USDC + default RPC', () => {
    expect(dep.tinyChain(TINY_ENV)).toEqual({
      caip2: 'eip155:31337', chainId: 31337, usdc: USDC.toLowerCase(), rpc: 'http://127.0.0.1:8545',
    })
  })

  it.each([
    ['no env at all', {}],
    ['missing chain id', { TINY_CHAIN_USDC_ADDRESS: USDC }],
    ['non-integer chain id', { TINY_CHAIN_ID: '31337.5', TINY_CHAIN_USDC_ADDRESS: USDC }],
    ['negative chain id', { TINY_CHAIN_ID: '-1', TINY_CHAIN_USDC_ADDRESS: USDC }],
    ['missing usdc', { TINY_CHAIN_ID: '31337' }],
    ['junk usdc', { TINY_CHAIN_ID: '31337', TINY_CHAIN_USDC_ADDRESS: 'nope' }],
  ])('%s → null (never a half-configured chain)', (_l, env: any) => {
    expect(dep.tinyChain(env)).toBeNull()
  })

  it('usdcContract("tiny") is "" without config — which matches NO Transfer log', () => {
    expect(dep.usdcContract('tiny', {})).toBe('')
    // '' can never equal a log's lowercased address, so the claim is refused
    // rather than credited on a chain the worker knows nothing about.
    const log = {
      address: USDC.toLowerCase(),
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x' + '0'.repeat(24) + 'a'.repeat(40),
        '0x' + '0'.repeat(24) + 'd'.repeat(40),
      ],
      data: '0x' + (1_000_000).toString(16),
    }
    const from = '0x' + 'a'.repeat(40), to = '0x' + 'd'.repeat(40)
    expect(dep.findUsdcTransfer([log], dep.usdcContract('tiny', {}), to, from)).toBeNull()
    expect(dep.findUsdcTransfer([log], dep.usdcContract('tiny', TINY_ENV), to, from)).toEqual({ amount_micro: 1_000_000 })
  })
})

describe.skipIf(!present)('normalizeNetwork / defaultNetwork — one parser, no coercion surprises', () => {
  it('folds every tiny alias onto "tiny" when configured', () => {
    for (const alias of ['tiny', 'TINY', 'eip155:31337', '31337']) {
      expect(dep.normalizeNetwork(TINY_ENV, alias)).toBe('tiny')
    }
  })

  it('"tiny" WITHOUT the chain configured falls back to the default — never a fake tiny', () => {
    expect(dep.normalizeNetwork({}, 'tiny')).toBe('base')
    expect(dep.normalizeNetwork({ PAYMENTS_TESTNET: '1' }, 'tiny')).toBe('base-sepolia')
  })

  it('the Base chains still parse exactly as before (no regression)', () => {
    for (const [alias, out] of [
      ['base', 'base'], ['eip155:8453', 'base'],
      ['base-sepolia', 'base-sepolia'], ['base_sepolia', 'base-sepolia'],
      ['sepolia', 'base-sepolia'], ['eip155:84532', 'base-sepolia'],
    ] as const) {
      expect(dep.normalizeNetwork(TINY_ENV, alias)).toBe(out)
    }
  })

  it('defaultNetwork: PAYMENTS_NETWORK wins, legacy PAYMENTS_TESTNET honored', () => {
    expect(dep.defaultNetwork(TINY_ENV)).toBe('tiny')
    expect(dep.defaultNetwork({ ...TINY_ENV, PAYMENTS_NETWORK: 'base-sepolia' })).toBe('base-sepolia')
    expect(dep.defaultNetwork({ PAYMENTS_TESTNET: '1' })).toBe('base-sepolia')
    expect(dep.defaultNetwork({})).toBe('base')
    // PAYMENTS_NETWORK=tiny on a deployment with no chain must NOT select tiny.
    expect(dep.defaultNetwork({ PAYMENTS_NETWORK: 'tiny' })).toBe('base')
  })
})

describe.skipIf(!present)('trial classification — self-minted USDC is never real money', () => {
  it('tiny is trial-class alongside base-sepolia; only base is real', () => {
    expect(dep.isTrialNetwork('tiny')).toBe(true)
    expect(dep.isTrialNetwork('base-sepolia')).toBe(true)
    expect(dep.isTrialNetwork('base')).toBe(false)
  })

  it('every trial network has a cap and a counterparty (no silently-uncapped chain)', () => {
    for (const n of dep.TRIAL_NETWORKS) {
      expect(dep.TRIAL_CAP_MICRO[n]).toBeGreaterThan(0)
      expect(dep.counterpartyFor(n)).toBe(`chain:${n}`)
    }
    expect(dep.TRIAL_COUNTERPARTIES).toContain('chain:base-sepolia') // the historical literal
    expect(dep.TRIAL_COUNTERPARTIES).toContain('chain:tiny')
  })

  it("the withdrawal SQL's exclusion list covers EXACTLY the trial counterparties", () => {
    // The regression this guards: the clause used to hardcode
    // counterparty='chain:base-sepolia', so adding a trial network made its
    // credits withdrawable as real USDC.
    for (const c of dep.TRIAL_COUNTERPARTIES) {
      expect(wd.WITHDRAW_DEBIT_SQL).toContain(`'${c}'`)
      expect(wd.TRIAL_BALANCE_SQL).toContain(`'${c}'`)
    }
    expect(wd.WITHDRAW_DEBIT_SQL).not.toContain("'chain:base'")  // real money isn't excluded
  })
})

describe.skipIf(!present)('the real WITHDRAW_DEBIT_SQL against real sqlite', () => {
  const CAP = 500_000_000
  const credit = (userId: string, micro: number, counterparty: string, ref: string) =>
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'deposit', ?, ?)")
      .run(userId, micro, ref, counterparty)

  /** The route's call, with node:sqlite's named binding for ?1..?7 (D1 binds these positionally). */
  const debit = (userId: string, amount: number, trialFactor: number, network = 'base') =>
    db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
      1: userId, 2: -amount, 3: `w-${userId}-${amount}-${network}`, 4: network,
      5: trialFactor, 6: amount, 7: CAP,
    }).changes

  it('minted tiny-chain credits cannot be withdrawn as real USDC on base', () => {
    credit('u1', 5_000_000, 'chain:tiny', 'tx-tiny')          // $5 of USDC we minted
    // trialFactor 1 = real payout → the exclusion subtracts the tiny deposits.
    expect(debit('u1', 4_000_000, 1)).toBe(0)
    // Sanity: the SAME balance in REAL deposits withdraws fine.
    credit('u2', 5_000_000, 'chain:base', 'tx-real')
    expect(debit('u2', 4_000_000, 1)).toBe(1)
  })

  it('sepolia trial credits are still excluded (the original guard, unbroken)', () => {
    credit('u1', 1_000_000, 'chain:base-sepolia', 'tx-sep')
    expect(debit('u1', 1_000_000, 1)).toBe(0)
  })

  it('trial credits from BOTH chains sum into the exclusion — neither hides the other', () => {
    credit('u1', 900_000, 'chain:base-sepolia', 'tx-sep')
    credit('u1', 900_000, 'chain:tiny', 'tx-tiny')
    credit('u1', 1_500_000, 'chain:base', 'tx-real')  // only $1.50 is genuinely real
    expect(debit('u1', 1_600_000, 1)).toBe(0)          // $1.60 > withdrawable $1.50
    expect(debit('u1', 1_500_000, 1)).toBe(1)          // exactly the real portion clears
  })

  it('real deposits are NOT excluded (the exclusion never over-reaches)', () => {
    credit('u1', 10_000_000, 'chain:base', 'tx-real')
    expect(debit('u1', 10_000_000, 1)).toBe(1)
    const bal = db.prepare('SELECT SUM(delta_micro) s FROM ledger WHERE user_id = ?').get('u1').s
    expect(bal).toBe(0)
  })

  it('a trial-network payout (trialFactor 0) spends trial balance — costs no real money', () => {
    credit('u1', 1_000_000, 'chain:tiny', 'tx-tiny')
    expect(debit('u1', 1_000_000, 0, 'tiny')).toBe(1)
    expect(db.prepare("SELECT counterparty FROM ledger WHERE kind='withdrawal'").get().counterparty).toBe('chain:tiny')
  })

  it('the overdraft + daily-cap guards still fire (unchanged behavior)', () => {
    credit('u1', 2_000_000, 'chain:base', 'tx-real')
    expect(debit('u1', 3_000_000, 1)).toBe(0)  // more than the balance
    // Daily cap: a paid withdrawal row inside the window counts against it.
    db.prepare("INSERT INTO withdrawals (id, user_id, amount_micro, fee_micro, to_address, network, status) VALUES ('w-old', 'u2', ?, 0, '0xdead', 'base', 'paid')").run(CAP)
    credit('u2', 600_000_000, 'chain:base', 'tx-whale')
    expect(debit('u2', 1_000_000, 1)).toBe(0)
  })

  it('TRIAL_BALANCE_SQL reports the same excluded total the debit enforces', () => {
    credit('u1', 700_000, 'chain:base-sepolia', 'tx-sep')
    credit('u1', 300_000, 'chain:tiny', 'tx-tiny')
    credit('u1', 5_000_000, 'chain:base', 'tx-real')
    expect(db.prepare(wd.TRIAL_BALANCE_SQL).get('u1').v).toBe(1_000_000)
  })
})

describe.skipIf(!present)('the real trial-cap claim insert against real sqlite', () => {
  // Mirrors PayClaimCall's trial branch verbatim — the counterparty and cap are
  // BOUND (?5/?3), which is what makes one statement serve every trial network.
  const CLAIM_SQL =
    `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
     SELECT ?1, MIN(?2, ?3 - COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty=?5),0)), 'deposit', ?4, ?5
     WHERE ?3 - COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty=?5),0) > 0`

  const claim = (userId: string, micro: number, ref: string, network: string) =>
    db.prepare(CLAIM_SQL).run({
      1: userId, 2: micro, 3: dep.TRIAL_CAP_MICRO[network], 4: ref, 5: dep.counterpartyFor(network),
    }).changes

  const balance = (userId: string) =>
    db.prepare('SELECT COALESCE(SUM(delta_micro),0) s FROM ledger WHERE user_id = ?').get(userId).s

  it('clamps a tiny-chain claim to the lifetime cap (MIN inside the write)', () => {
    expect(claim('u1', 5_000_000, 'tx-1', 'tiny')).toBe(1)   // claims $5, capped at $1
    expect(balance('u1')).toBe(dep.TRIAL_CAP_MICRO.tiny)
    expect(claim('u1', 5_000_000, 'tx-2', 'tiny')).toBe(0)   // cap met → 0 rows
    expect(balance('u1')).toBe(dep.TRIAL_CAP_MICRO.tiny)
  })

  it('each trial network keeps its OWN allowance (per-counterparty cap)', () => {
    expect(claim('u1', 1_000_000, 'tx-sep', 'base-sepolia')).toBe(1)
    // Sepolia's cap is spent; tiny's must be untouched by it.
    expect(claim('u1', 1_000_000, 'tx-tiny', 'tiny')).toBe(1)
    expect(balance('u1')).toBe(dep.TRIAL_CAP_MICRO['base-sepolia'] + dep.TRIAL_CAP_MICRO.tiny)
  })

  it('a partial fill lands exactly the remainder, never more', () => {
    expect(claim('u1', 400_000, 'tx-1', 'tiny')).toBe(1)
    expect(claim('u1', 900_000, 'tx-2', 'tiny')).toBe(1)     // only $0.60 left
    expect(balance('u1')).toBe(dep.TRIAL_CAP_MICRO.tiny)
    expect(db.prepare('SELECT delta_micro v FROM ledger WHERE ref = ?').get('tx-2').v).toBe(600_000)
  })
})
