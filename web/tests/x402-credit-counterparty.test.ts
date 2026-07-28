// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-credit-counterparty')

/**
 * 🧪→💵 THE FOURTH REAL-VALUE EXIT — an INBOUND x402 settle on the chain we mint.
 *
 * c-d closed withdrawals, c-f0 closed outbound spend, c-f0b closed trial money
 * changing hands between accounts, and c42 stopped a payout signing on a chain
 * other than the one the ledger debited. All four guard the same field: every
 * exclusion sums `kind='deposit'` rows whose `counterparty` is in
 * `TRIAL_COUNTERPARTIES` (`chain:base-sepolia`, `chain:tiny`). A deposit row
 * written under any OTHER counterparty is invisible to all of them — real,
 * withdrawable money by construction.
 *
 * `/pay/credit` wrote `counterparty='platform'`, unconditionally, and the inbound
 * x402 route funds every external payer through it:
 *
 *   an internet agent signs TinyUSDC — a token we mint, owner-only, and hand out
 *   free from our own faucet — for a priced tiny
 *     → the facilitator settles it on our own chain
 *     → /pay/credit records the payer's funding deposit as 'platform'
 *     → TRIAL_DEPOSITS_SUM_SQL reads 0 trial for that payer, so /pay/invoke's
 *       TAINT_INVOKE_SQL writes no taint row on the payee
 *     → the tiny owner withdraws the invoke_credit as REAL mainnet USDC.
 *
 * Play money out as real money, one HTTP request, no accomplice account — through
 * the door all three earlier guards were built to shut. None of them was wrong.
 * The LEDGER was never told which chain the money arrived on, because two
 * authorities answered that question and only one of them knew: the route
 * resolved `matched.network` and echoed the CAIP-2 in the receipt and the
 * X-PAYMENT-RESPONSE header, then credited without it.
 *
 * So the settling authority reports and the ledger reads — the c42 delegation
 * again, and the reason there is no second network table in payments.ts.
 *
 * The subtle half is WHICH resolver. `normalizeNetwork` falls back to the
 * deployment default, which is correct for a REQUEST (a withdrawal naming no
 * chain means "the usual one") and catastrophic for a REPORT: on a mainnet
 * deployment `normalizeNetwork(env, undefined)` is 'base', so an unstated
 * network would resolve to the counterparty that means real money — re-creating
 * the mint inside the fix. Hence `namedNetwork`, which returns null, and a
 * fallback that leans trial.
 *
 * Recipe as ever (tests/trial-taint-propagation.test.ts): the REAL exported SQL
 * and the REAL migrations against node:sqlite. D1 binds ?1..?N positionally from
 * .bind(); node:sqlite binds them as NAMED parameters.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (four cycles running now). */
const code = (rel: string) => source(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const ROUTE = 'app/api/x402/chat/[slug]/route.ts'

/** A deployment on the chain we mint — production's actual shape. */
const TINY_ENV = {
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec',
  PAYMENTS_NETWORK: 'tiny',
}
/** …and a real-money deployment, where 'platform' was always harmless. */
const BASE_ENV = { PAYMENTS_NETWORK: 'base' }
const SEPOLIA_ENV = { PAYMENTS_NETWORK: 'base-sepolia' }

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

/** The credit row exactly as PayCreditCall writes it, counterparty and all. */
const credit = (userId: string, micro: number, counterparty: string, ref: string, kind = 'deposit') =>
  db.prepare('INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, ?, ?, ?)')
    .run(userId, micro, kind, ref, counterparty)

/** One paid invocation as the route's real batch — in order, so the taint
 *  statement reads the payer's post-debit state the way it does in D1. */
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
  const tainted = db.prepare(pay.TAINT_INVOKE_SQL).run({
    1: payer, 2: ref, 3: payee, 4: split.ownerCredit,
  }).changes
  return { debited, tainted }
}

/** The real withdrawal debit — ?5 trialFactor, ?6 amount, ?7 daily cap. */
const withdraw = (userId: string, amount: number, trialFactor = 1, ref = `wd-${userId}-${amount}`) =>
  db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
    1: userId, 2: -amount, 3: ref, 4: 'base', 5: trialFactor, 6: amount, 7: wd.WITHDRAW_DAILY_CAP_MICRO,
  }).changes

const taintOf = (userId: string) =>
  db.prepare('SELECT COALESCE(SUM(micro),0) v FROM trial_taint WHERE user_id = ?').get(userId).v

describe.skipIf(!present)('THE MINT: an x402 settle in a token we print, cashed out as real USDC', () => {
  const PRICE = 2_000_000 // $2 tiny

  it('OLD behaviour — a TinyUSDC settle credited as `platform` pays out real money', () => {
    // Exactly what /pay/credit wrote before this fix: no network, so 'platform'.
    // This is the non-vacuity proof — the leak must be REPRODUCIBLE here, or the
    // assertions below could pass against code that never had the bug.
    credit('x402:0xattacker', PRICE, 'platform', '0xsettle-tx')
    expect(invoke('x402:0xattacker', 'owner', PRICE, '0xsettle-tx').debited).toBe(1)
    // No taint: the exclusion never saw a trial deposit for this payer.
    expect(taintOf('owner')).toBe(0)
    // …so the owner's earnings withdraw as real USDC. The mint, in one line.
    expect(withdraw('owner', PRICE - 1000)).toBe(1)
  })

  it('NEW behaviour — the same settle, counterparty derived from the network', () => {
    const cp = pay.creditCounterparty(TINY_ENV, 'eip155:8469')
    expect(cp).toBe('chain:tiny')
    credit('x402:0xattacker', PRICE, cp, '0xsettle-tx')
    expect(invoke('x402:0xattacker', 'owner', PRICE, '0xsettle-tx').debited).toBe(1)
    // The payer's balance is now visibly trial, so the invocation taints the payee…
    expect(taintOf('owner')).toBe(PRICE - 1000)
    // …and the payout is refused. Same ledger, same SQL — only the counterparty moved.
    expect(withdraw('owner', PRICE - 1000)).toBe(0)
  })

  it('a REAL Base settle still pays out — the fix is not "everything is trial"', () => {
    const cp = pay.creditCounterparty(BASE_ENV, 'eip155:8453')
    expect(cp).toBe('platform')
    credit('x402:0xhonest', PRICE, cp, '0xreal-tx')
    invoke('x402:0xhonest', 'owner', PRICE, '0xreal-tx')
    expect(taintOf('owner')).toBe(0)
    expect(withdraw('owner', PRICE - 1000)).toBe(1)
  })

  it('the counterparty it writes is one the exclusion actually reads', () => {
    // The link that makes the whole fix work: a value that isn't in the SQL's
    // literal list excludes nothing, however trial-looking it reads.
    for (const env of [TINY_ENV, SEPOLIA_ENV]) {
      const cp = pay.creditCounterparty(env, undefined)
      expect(dep.TRIAL_COUNTERPARTIES, JSON.stringify(env)).toContain(cp)
      expect(wd.WITHDRAW_DEBIT_SQL).toContain(`'${cp}'`)
      expect(pay.SPEND_DEBIT_SQL).toContain(`'${cp}'`)
    }
  })
})

describe.skipIf(!present)('creditCounterparty — a REPORT, so silence is never "real"', () => {
  it('names the trial counterparty for every form of the trial chain', () => {
    for (const n of ['tiny', 'TINY', 'eip155:8469', '8469']) {
      expect(pay.creditCounterparty(TINY_ENV, n), n).toBe('chain:tiny')
    }
    for (const n of ['base-sepolia', 'base_sepolia', 'sepolia', 'eip155:84532']) {
      expect(pay.creditCounterparty(TINY_ENV, n), n).toBe('chain:base-sepolia')
    }
  })

  it('keeps `platform` for a named real network (matching every existing row)', () => {
    // 'chain:base' is deliberately NOT in the exclusion list, so 'platform' and
    // 'chain:base' are the same thing to every guard — and 'platform' is what
    // the last two years of rows already say.
    for (const n of ['base', 'eip155:8453']) {
      expect(pay.creditCounterparty(TINY_ENV, n), n).toBe('platform')
      expect(dep.TRIAL_COUNTERPARTIES).not.toContain('platform')
    }
  })

  it('⚠️ an ABSENT network on a TRIAL deployment falls back to TRIAL, not real', () => {
    // The trap this whole test file exists for. `normalizeNetwork(env, undefined)`
    // returns the deployment default — which is the RIGHT answer for a withdrawal
    // request and the mint itself for a credit. Here silence must never buy
    // realness on a deployment whose money is minted.
    for (const junk of [undefined, null, '', ' ', 0, false, NaN, {}, [], ['tiny']]) {
      expect(pay.creditCounterparty(TINY_ENV, junk), String(junk)).toBe('chain:tiny')
      expect(pay.creditCounterparty(SEPOLIA_ENV, junk), String(junk)).toBe('chain:base-sepolia')
    }
  })

  it('an UNRECOGNIZED network name is not a licence to call the money real', () => {
    for (const junk of ['ethereum', 'solana', 'eip155:1', 'mainnet', 'base-mainnet', '1']) {
      expect(pay.creditCounterparty(TINY_ENV, junk), junk).toBe('chain:tiny')
    }
  })

  it('an object / array network is refused, not coerced into a chain name', () => {
    // `String(['base']) === 'base'` — a coercing parse would let a JSON array
    // name mainnet and buy realness with it.
    expect(pay.creditCounterparty(TINY_ENV, ['base'])).toBe('chain:tiny')
    expect(pay.creditCounterparty(TINY_ENV, { network: 'base' })).toBe('chain:tiny')
    // And on a real-money deployment those same shapes get the legacy value,
    // which is non-trial there anyway — no behaviour change, no new realness.
    expect(pay.creditCounterparty(BASE_ENV, ['base'])).toBe('platform')
  })

  it('never resolves an inherited Object.prototype key as a network', () => {
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(pay.creditCounterparty(TINY_ENV, k), k).toBe('chain:tiny')
    }
  })

  it("'tiny' on a deployment WITHOUT the chain configured cannot name it", () => {
    // tinyChain() fails closed, so 'tiny' is unnameable — and on a real-money
    // deployment the fallback is the legacy 'platform'. Both halves matter: we
    // must not invent a chain:tiny counterparty for a chain we can't verify.
    expect(pay.creditCounterparty(BASE_ENV, 'tiny')).toBe('platform')
    expect(pay.creditCounterparty({ PAYMENTS_NETWORK: 'tiny' }, 'tiny')).toBe('platform')
  })

  it('a half-configured tiny-chain does not become a trial counterparty', () => {
    // Malformed USDC address → tinyChain() null → 'tiny' unnameable, default
    // resolves to base. Fail-closed in the same direction as everywhere else.
    const HALF = { TINY_CHAIN_ID: '8469', TINY_CHAIN_USDC_ADDRESS: 'nope', PAYMENTS_NETWORK: 'tiny' }
    expect(dep.tinyChain(HALF)).toBeNull()
    expect(pay.creditCounterparty(HALF, 'eip155:8469')).toBe('platform')
  })
})

describe.skipIf(!present)('namedNetwork — the primitive, and normalizeNetwork built on it', () => {
  it('returns null for exactly the inputs normalizeNetwork would DEFAULT', () => {
    for (const junk of [undefined, null, '', 'ethereum', 'eip155:1', 'nonsense']) {
      expect(dep.namedNetwork(TINY_ENV, junk), String(junk)).toBeNull()
      // …and the wrapper still answers with the deployment default, unchanged.
      expect(dep.normalizeNetwork(TINY_ENV, junk as any), String(junk)).toBe('tiny')
    }
  })

  it('normalizeNetwork is behaviourally IDENTICAL after the extraction', () => {
    // The refactor must move zero behaviour: withdrawals resolve their network
    // through this, and a changed answer there is a changed chain to pay out on.
    const inputs = [
      undefined, null, '', ' ', 'tiny', 'TINY', 'base', 'BASE', 'base-sepolia',
      'base_sepolia', 'sepolia', 'eip155:8453', 'eip155:84532', 'eip155:8469',
      '8469', '8453', 'junk', 'ethereum', 0, false, ['base'], {},
    ]
    // The pre-extraction implementation, verbatim, as the oracle.
    const old = (env: any, requested?: any) => {
      const r = String(requested || '').toLowerCase()
      if (r === 'base-sepolia' || r === 'base_sepolia' || r === 'sepolia' || r === 'eip155:84532') return 'base-sepolia'
      if (r === 'base' || r === 'eip155:8453') return 'base'
      const t = dep.tinyChain(env)
      if (t && (r === 'tiny' || r === t.caip2 || r === String(t.chainId))) return 'tiny'
      return dep.defaultNetwork(env)
    }
    for (const env of [TINY_ENV, BASE_ENV, SEPOLIA_ENV, {}]) {
      for (const i of inputs) {
        expect(dep.normalizeNetwork(env, i as any), `${JSON.stringify(env)} ${String(i)}`)
          .toBe(old(env, i))
      }
    }
  })
})

describe('the settling authority reports the network it settled on', () => {
  const src = code(ROUTE)

  it('the /pay/credit body carries the settled network', () => {
    const call = src.slice(src.indexOf('/pay/credit'))
    const body = call.slice(0, call.indexOf("}, 'credit')"))
    expect(body).toMatch(/network: settledNetwork/)
    // Same variable the receipt and the X-PAYMENT-RESPONSE header use — one
    // resolution (matchRequirement), read by everything downstream.
    expect(src).toMatch(/settledNetwork = settled\.network \|\| ''/)
  })

  it('the route holds no counterparty logic of its own', () => {
    // A second authority on "is this money real?" is the bug, not the fix.
    expect(src).not.toMatch(/counterparty/)
    expect(src).not.toMatch(/chain:tiny/)
  })

  it('the credit is reported BEFORE the invoke that spends it', () => {
    // Ordering fact: /pay/invoke's taint term reads the payer's deposit rows, so
    // the counterparty must already be recorded when the invoke settles.
    expect(src.indexOf('/pay/credit')).toBeLessThan(src.indexOf('/pay/invoke'))
  })
})

describe.skipIf(!present)('payments.ts derives, never re-tabulates', () => {
  const src = readFileSync(join(WORKER_SRC, 'payments.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('builds the counterparty with counterpartyFor, not a string literal', () => {
    expect(src).toMatch(/counterpartyFor\(/)
    // No hand-written 'chain:...' anywhere — that literal is deposits.ts's job,
    // and a second copy is how the exclusion list drifted before (c-f0).
    expect(src).not.toMatch(/['"]chain:/)
  })

  it('resolves with namedNetwork — normalizeNetwork here would BE the mint', () => {
    const fn = src.slice(src.indexOf('export function creditCounterparty'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/namedNetwork\(/)
    // The trap, pinned: normalizeNetwork's default would turn "no network stated"
    // into the deployment's chain — 'base' on mainnet, i.e. real money.
    expect(body).not.toMatch(/normalizeNetwork\(/)
  })

  it('the INSERT binds the counterparty instead of hardcoding platform', () => {
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    const insert = cls.slice(cls.indexOf('INSERT INTO ledger'), cls.indexOf('.run()'))
    expect(insert).not.toMatch(/'platform'/)
    expect(insert).toMatch(/VALUES \(\?, \?, \?, \?, \?\)/)
  })

  it('an admin_credit is never reclassified by a caller-supplied network', () => {
    // A platform grant has no chain behind it; letting `network` colour it would
    // let a caller mark an admin credit trial (or, worse, real).
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    expect(cls).toMatch(/kind === "deposit" \? creditCounterparty\(env, body\.network\) : "platform"/)
  })
})
