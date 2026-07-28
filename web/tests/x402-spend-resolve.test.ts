// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-spend-resolve')

/**
 * 💸 THE FROZEN MONEY GETS RESOLVED — and the live probe said the opposite of
 * what the obvious resolver assumes.
 *
 * The arc so far: c47 (migration 0025) made `/pay/spend-reverse` refuse any ref
 * whose signed EIP-3009 authorization had left us, because a bearer instrument
 * may settle without us hearing. Safe, and permanent — nothing could ever lift
 * the refusal. c49 (0026) made the instrument NAMEABLE (payer, nonce, the signed
 * validBefore) and exposed the queue of open ones. Neither wrote a refund.
 *
 * This is the increment that writes money on the strength of an on-chain read.
 * `reconcileSentSpends` runs on the per-minute cron, and for each open row asks
 * the chain the one question that has an answer:
 *
 *   authorizationState(payer, nonce) → bool     (chain/contracts/TinyUSDC.sol:31)
 *
 * ⚠️ THE MEASUREMENT THAT SHAPED THE CODE. Before this was written, production
 * held exactly ONE open row: identity recorded, deadline ~150s past, reservation
 * frozen, no error anywhere. The obvious resolver — "past its deadline and still
 * frozen ⟹ the payment failed ⟹ refund" — is wrong, and prod proved it on the
 * first row it would ever have met. `eth_call` on chain 8469 answered:
 *
 *   authorizationState(<that payer>, <that nonce>) → 0x…01    ← IT SETTLED
 *   authorizationState(<that payer>, 0x11…)        → 0x…00    (control)
 *
 * The money had moved. The frozen state was not evidence of failure; it was
 * evidence that nobody had asked. A resolver that treated the freeze itself as
 * the signal would have refunded a landed payment on its very first tick, and
 * the platform would have eaten it silently. So `true` is the case this code
 * treats as EXPECTED and `false` as the exception — and the first test below is
 * the settled-must-not-refund direction, not the refund one.
 *
 * The suite runs the REAL exported function against the REAL migrations on
 * node:sqlite with a stubbed JSON-RPC, and asserts on what was ASKED as well as
 * what was concluded: the selector, the padded payer word and the nonce word are
 * the three things a silent encoding bug corrupts, and a corrupted call answers
 * `false`, which is the answer that authorizes a refund.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const USDC = '0x' + '4f'.repeat(20)
const PAYER = '0x' + 'ab'.repeat(20)
const NONCE = '0x' + 'cd'.repeat(32)
/** The refs the payer route actually builds: x402pay:<sub>:<CAIP-2>:<payTo>:<micro>:<token> */
const REF = 'x402pay:user-1:eip155:8469:0xpayee:2000000:jti-abc'
const NOW = 1_800_000_000
const VB = NOW - 60          // dead by the contract's own rule
const MICRO = 2_000_000

let pay: any, dep: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
  dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  for (const m of ['0014_payments.sql', '0015_withdrawals.sql', '0021_deposit_integrity.sql',
    '0024_trial_taint.sql', '0025_spend_sent.sql', '0026_spend_sent_identity.sql',
    '0027_spend_sent_resolved.sql']) db.exec(migration(m))
})

const d1 = (opts: { failOn?: RegExp } = {}) => ({
  prepare(sql: string) {
    const binds: any[] = []
    // D1 binds ?1..?N positionally; node:sqlite treats them as NAMED params.
    const args = () => {
      const clean = binds.map(b => (b === undefined ? null : b))
      if (!/\?\d/.test(sql)) return clean
      const named: any = {}
      clean.forEach((v, i) => { named[i + 1] = v })
      return [named]
    }
    const fail = () => { if (opts.failOn?.test(sql)) throw new Error('D1_ERROR: storage unavailable') }
    const stmt = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() { fail(); const r = db.prepare(sql).run(...args()); return { meta: { changes: Number(r.changes || 0) } } },
      async first() { fail(); return db.prepare(sql).get(...args()) ?? null },
      async all() { fail(); return { results: db.prepare(sql).all(...args()) } },
    }
    return stmt
  },
  async batch(stmts: any[]) {
    const out: any[] = []
    for (const s of stmts) out.push(await s.run())
    return out
  },
})

/** The deployment prod actually runs: the self-hosted chain, selected by default. */
const ENV = (opts: { failOn?: RegExp } = {}) => ({
  DB: d1(opts),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: USDC,
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
})

const WORD = (n: number) => '0x' + n.toString(16).padStart(64, '0')

/**
 * Stub the chain. `answer` sees the decoded JSON-RPC body, so a test can reply
 * differently per (payer, nonce) — and every call is recorded, because WHAT was
 * asked matters as much as what was concluded here.
 */
let restoreFetch: (() => void) | null = null
const stubChain = (answer: (body: any, url: string) => any) => {
  const calls: any[] = []
  const orig = globalThis.fetch
  restoreFetch = () => { globalThis.fetch = orig }
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ url: String(url), method: body.method, params: body.params })
    const r = answer(body, String(url))
    if (r instanceof Error) throw r
    const payload = r && typeof r === 'object' && 'error' in r ? r : { jsonrpc: '2.0', id: 1, result: r }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  }) as any
  return calls
}
afterEach(() => { restoreFetch?.(); restoreFetch = null })

const mark = (o: { ref?: string; userId?: string; payer?: string | null; nonce?: string | null; vb?: number | null } = {}) =>
  db.prepare('INSERT INTO spend_sent (ref, user_id, payee, payer, nonce, valid_before) VALUES (?, ?, ?, ?, ?, ?)')
    .run(o.ref ?? REF, o.userId ?? 'user-1', '0x' + '22'.repeat(20),
      o.payer === undefined ? PAYER : o.payer,
      o.nonce === undefined ? NONCE : o.nonce,
      o.vb === undefined ? VB : o.vb)

const reserve = (userId = 'user-1', micro = MICRO, ref = REF) =>
  db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_debit', ?, 'external')")
    .run(userId, -micro, ref)

const row = (ref = REF) => db.prepare('SELECT * FROM spend_sent WHERE ref = ?').get(ref)
const refundRows = (ref = REF) => db.prepare("SELECT * FROM ledger WHERE ref = ? AND kind = 'spend_refund'").all(ref)
const balance = (userId = 'user-1') =>
  db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get(userId).v

/** Every reachable answer, as the shipped resolver would see it. */
const REDEEMED = WORD(1)
const UNREDEEMED = WORD(0)

describe.skipIf(!present)('THE MEASURED CASE: a settled instrument must never be refunded', () => {
  it('authorizationState → 1 ⟹ NO refund, and the debit stands', async () => {
    // This is production's actual row, reproduced: identity recorded, deadline
    // past, reservation frozen — and the chain says it settled.
    reserve()
    mark()
    const env = ENV()
    stubChain(() => REDEEMED)
    const out = await pay.reconcileSentSpends(env, NOW)

    expect(out.settled).toBe(1)
    expect(out.refunded).toBe(0)
    expect(refundRows().length).toBe(0)
    expect(balance()).toBe(-MICRO)      // the user stays debited, correctly
  })

  it('NON-VACUITY — the naive resolver refunds it, so this test can never pass by accident', async () => {
    // The rule the obvious implementation would use, spelled out: "past the
    // deadline and still frozen ⟹ refund". It has no access to the redemption
    // bit, so it cannot tell prod's settled row from a dead one — and prod's one
    // row was settled. This is the mistake the suite exists to prevent.
    reserve()
    mark()
    const naive = (r: any, now: number) => (r.valid_before <= now ? 'refund' : 'wait')
    expect(naive(row(), NOW)).toBe('refund')

    stubChain(() => REDEEMED)
    await pay.reconcileSentSpends(ENV(), NOW)
    expect(refundRows().length).toBe(0)  // the shipped code disagrees with `naive`
  })

  it('a settled row is marked resolved, so the queue DRAINS', async () => {
    // The settled outcome writes no ledger row (there is nothing to correct), so
    // without a terminal mark it matches the open query forever: one eth_call per
    // minute, and a queue depth that stops meaning "work outstanding".
    reserve()
    mark()
    const env = ENV()
    const calls = stubChain(() => REDEEMED)
    await pay.reconcileSentSpends(env, NOW)
    expect(row().resolved).toBe(NOW)
    expect(row().resolution).toBe('settled')

    const second = await pay.reconcileSentSpends(env, NOW + 60)
    expect(second.checked).toBe(0)
    expect(calls.length).toBe(1)         // asked ONCE, ever
  })

  it('and the resolution mark keeps the SIGNED deadline intact', async () => {
    // The tempting shortcut was `valid_before = NULL` (no migration needed — the
    // queue already filters on it). It would erase the only thing that licenses
    // reading absence as a verdict, AND manufacture the half-set identity row the
    // table forbids, which /pay/spend-reverse reports as `resolvable: false` —
    // i.e. "nobody can ever resolve this" about the row that just was resolved.
    reserve()
    mark()
    stubChain(() => REDEEMED)
    await pay.reconcileSentSpends(ENV(), NOW)
    expect(row().valid_before).toBe(VB)
    expect(row().payer).toBe(PAYER)
    expect(row().nonce).toBe(NONCE)
  })

  it('the first verdict wins — a resolved row is never re-stamped', async () => {
    reserve()
    mark()
    stubChain(() => REDEEMED)
    await pay.reconcileSentSpends(ENV(), NOW)
    // Force it back into the queue the only way a bug could, and re-run.
    db.prepare('UPDATE spend_sent SET resolved = NULL WHERE ref = ?').run(REF)
    db.prepare("UPDATE spend_sent SET resolved = ?, resolution = 'settled' WHERE ref = ?").run(NOW, REF)
    await pay.reconcileSentSpends(ENV(), NOW + 999)
    expect(row().resolved).toBe(NOW)
  })
})

describe.skipIf(!present)('THE REFUND: unredeemed past the signed deadline is a proof', () => {
  it('authorizationState → 0 past validBefore ⟹ the reservation is refunded', async () => {
    reserve()
    mark()
    const out = await (async () => { stubChain(() => UNREDEEMED); return pay.reconcileSentSpends(ENV(), NOW) })()
    expect(out.refunded).toBe(1)
    expect(out.settled).toBe(0)
    const rows = refundRows()
    expect(rows.length).toBe(1)
    expect(rows[0].delta_micro).toBe(MICRO)        // the debit was -MICRO
    expect(rows[0].counterparty).toBe('platform')
    expect(balance()).toBe(0)                      // whole again
  })

  it('the refund uses the SAME kind/ref as a manual reverse — one refund, whoever writes it', async () => {
    // The queue excludes any ref with a spend_refund row, so the refund is its own
    // terminal state; and the ledger's UNIQUE(user_id, kind, ref) makes a manual
    // /pay/spend-reverse and a cron tick collide rather than double-pay.
    reserve()
    mark()
    stubChain(() => UNREDEEMED)
    await pay.reconcileSentSpends(ENV(), NOW)
    expect(refundRows().length).toBe(1)
    const again = await pay.reconcileSentSpends(ENV(), NOW)
    expect(again.checked).toBe(0)
    expect(refundRows().length).toBe(1)
  })

  it('a human reverse landing between the queue read and the write does not double-refund', async () => {
    // The real race: `reconcileSentSpends` read the row, then a support engineer
    // reversed it by hand. The guard is in the WHERE (NOT EXISTS), not in a
    // preceding SELECT, so the tick writes zero rows instead of a second refund.
    reserve()
    mark()
    stubChain(() => {
      // Simulate the concurrent write happening DURING the eth_call.
      db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('user-1', ?, 'spend_refund', ?, 'platform')")
        .run(MICRO, REF)
      return UNREDEEMED
    })
    await pay.reconcileSentSpends(ENV(), NOW)
    expect(refundRows().length).toBe(1)
    expect(balance()).toBe(0)                      // refunded exactly once
  })

  it('every debited entry is reversed, not just the payer’s own', async () => {
    // A reimbursed spend has two rows under one ref (spend_debit + the sponsor's
    // spend_reimburse). Refunding one and not the other leaves the ledger skewed.
    reserve('user-1', 2_000_000)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('sponsor', ?, 'spend_reimburse', ?, 'external')")
      .run(-500_000, REF)
    mark()
    stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(out.refunded).toBe(1)
    expect(refundRows().length).toBe(2)
    expect(balance('user-1')).toBe(0)
    expect(balance('sponsor')).toBe(0)
  })

  it('REGRESSION — the idempotency guard is per (user, ref); ref alone UNDER-refunds', () => {
    // 🐛 This test caught the shipped-in-progress version. The batch runs
    // sequentially, so a ref-scoped `NOT EXISTS (… kind='spend_refund')` sees the
    // FIRST statement's own row and turns every later one into a silent no-op:
    // the payer is made whole, the sponsor is left out of pocket, and nothing
    // errors. Replayed here against the real SQL so it cannot regress.
    reserve('user-1', 2_000_000)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('sponsor', ?, 'spend_reimburse', ?, 'external')")
      .run(-500_000, REF)
    const REF_ONLY =
      `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
       SELECT ?, ?, 'spend_refund', ?, 'platform'
       WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE ref = ? AND kind = 'spend_refund')`
    for (const e of [['user-1', 2_000_000], ['sponsor', 500_000]] as any[]) {
      db.prepare(REF_ONLY).run(e[0], e[1], REF, REF)
    }
    expect(refundRows().length).toBe(1)          // the bug, reproduced
    expect(balance('sponsor')).toBe(-500_000)    // …and the sponsor eats it

    // The shipped SQL keys on the user too — the same key as the ledger's own
    // UNIQUE(user_id, kind, ref) idempotency index, so guard and backstop agree.
    expect(pay.RECONCILE_REFUND_SQL).toMatch(/user_id = \?1/)
    db.exec("DELETE FROM ledger WHERE kind = 'spend_refund'")
    // node:sqlite binds ?N as NAMED params (D1 binds them positionally).
    for (const e of [['user-1', 2_000_000], ['sponsor', 500_000]] as any[]) {
      db.prepare(pay.RECONCILE_REFUND_SQL).run({ 1: e[0], 2: e[1], 3: REF })
    }
    expect(refundRows().length).toBe(2)
    expect(balance('sponsor')).toBe(0)
  })

  it('a mark with no reservation resolves as no_reservation, NOT as settled', async () => {
    // Nothing was ever debited (reversed by hand before the mark, or a reservation
    // that never committed). There is no money to return — but recording it as
    // "settled" would claim the payment landed when the chain just said it hadn't.
    mark()
    stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(refundRows().length).toBe(0)
    expect(row().resolution).toBe('no_reservation')
    expect(out.refunded).toBe(0)
  })
})

describe.skipIf(!present)('NO ANSWER IS NOT A NO — every unknown leaves the money alone', () => {
  const NOT_REFUNDED = async (answer: (body: any, url: string) => any) => {
    reserve()
    mark()
    stubChain(answer)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(refundRows().length).toBe(0)
    expect(balance()).toBe(-MICRO)
    // …and crucially it stays OPEN: an unknown is a retry, not a resolution.
    expect(row().resolved).toBeNull()
    return out
  }

  it('a dead RPC leaves it open', async () => {
    const out = await NOT_REFUNDED(() => new Error('connect ECONNREFUSED'))
    expect(out.unknown).toBe(1)
  })

  it('a JSON-RPC error object leaves it open', async () => {
    const out = await NOT_REFUNDED(() => ({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }))
    expect(out.unknown).toBe(1)
  })

  it('EMPTY DATA ("0x") leaves it open — the case that would have refunded everything', async () => {
    // What a node returns for a call to an address with no such function: a wrong
    // token address, a chain where TinyUSDC isn't deployed, a proxy that didn't
    // forward. A decoder that read "0x" as falsy would refund EVERY open row on a
    // misconfigured deployment — the largest possible blast radius in this file.
    const out = await NOT_REFUNDED(() => '0x')
    expect(out.unknown).toBe(1)
    expect(dep.decodeAuthorizationState('0x')).toBeNull()
    expect(dep.decodeAuthorizationState('0x')).not.toBe(false)
  })

  it('a truncated or oversized word leaves it open', async () => {
    for (const bad of ['0x01', '0x' + '00'.repeat(31), '0x' + '00'.repeat(33), '', null, undefined, 'nope']) {
      expect(dep.decodeAuthorizationState(bad)).toBeNull()
    }
    // Only 0 and 1 are bools; 2 is not "truthy", it is unintelligible.
    expect(dep.decodeAuthorizationState(WORD(2))).toBeNull()
    expect(dep.decodeAuthorizationState(UNREDEEMED)).toBe(false)
    expect(dep.decodeAuthorizationState(REDEEMED)).toBe(true)
  })

  it('an unconfigured chain asks NOTHING rather than calling the zero address', async () => {
    reserve()
    mark()
    const calls = stubChain(() => UNREDEEMED)
    const env: any = { ...ENV(), TINY_CHAIN_USDC_ADDRESS: '' }
    // A tinyChain() that can't be built means the ref's network resolves to null,
    // so the row is SKIPPED — not asked, not refunded.
    const out = await pay.reconcileSentSpends(env, NOW)
    expect(calls.length).toBe(0)
    expect(refundRows().length).toBe(0)
    expect(out.skipped + out.unknown).toBe(1)
  })

  it('a ref naming a chain this deployment does not know is skipped, not defaulted', async () => {
    // ⚠️ The money bug this prevents: authorizationState is PER-CHAIN, so the same
    // (payer, nonce) reads UNREDEEMED on every chain except the one it was signed
    // for. Defaulting an unrecognised ref to the deployment's current network asks
    // the WRONG chain, gets `false`, and refunds a payment that settled elsewhere.
    const foreign = 'x402pay:user-1:eip155:8453:0xpayee:2000000:jti-xyz'
    reserve('user-1', MICRO, foreign)
    mark({ ref: foreign })
    const calls = stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    // 'base' IS a network this worker knows, so it asks Base — never tiny.
    expect(out.refunded + out.unknown + out.settled).toBe(1)
    if (calls.length) expect(calls[0].url).not.toContain('8545')

    // And a genuinely unparseable ref is skipped outright.
    db.exec('DELETE FROM spend_sent'); db.exec('DELETE FROM ledger')
    reserve('user-1', MICRO, 'legacy-ref-with-no-network')
    mark({ ref: 'legacy-ref-with-no-network' })
    const calls2 = stubChain(() => UNREDEEMED)
    const out2 = await pay.reconcileSentSpends(ENV(), NOW)
    expect(out2.skipped).toBe(1)
    expect(calls2.length).toBe(0)
    expect(refundRows('legacy-ref-with-no-network').length).toBe(0)
  })

  it('a failed queue read reconciles nothing and does not throw', async () => {
    // Includes the pre-0027 deployment ("no such column: resolved"): worker code
    // ahead of the migration must no-op, not poison the cron beside it.
    reserve()
    mark()
    stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV({ failOn: /FROM spend_sent/ }), NOW)
    expect(out).toEqual({ checked: 0, settled: 0, refunded: 0, unknown: 0, skipped: 0 })
    expect(refundRows().length).toBe(0)
  })

  it('a failed entries read does NOT resolve the row — it retries', async () => {
    // "I couldn't read what to reverse" is not permission to reverse nothing and
    // call it done: that would mark a genuinely dead payment resolved with the
    // user still debited.
    reserve()
    mark()
    stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV({ failOn: /spend_debit/ }), NOW)
    expect(out.unknown).toBe(1)
    expect(row().resolved).toBeNull()
    expect(balance()).toBe(-MICRO)
  })
})

describe.skipIf(!present)('the queue’s own rules still hold at the resolver', () => {
  it('a LIVE instrument is never touched — absence is not yet a verdict', async () => {
    reserve()
    mark({ vb: NOW + 300 })
    const calls = stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(out.checked).toBe(0)
    expect(calls.length).toBe(0)          // we don't even ask: the payee may still submit
    expect(refundRows().length).toBe(0)
  })

  it('a pre-0026 mark (no nonce) is never resolved automatically', async () => {
    reserve()
    mark({ payer: null, nonce: null, vb: null })
    const calls = stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(out.checked).toBe(0)
    expect(calls.length).toBe(0)
    expect(refundRows().length).toBe(0)
    // It stays visible to a human via /pay/spend-reverse's `resolvable: false`.
  })

  it('one tick is bounded — a backlog drains over minutes, oldest first', async () => {
    for (let i = 0; i < 5; i++) {
      reserve('user-1', 1_000, `x402pay:user-1:eip155:8469:0xp:1000:t${i}`)
      mark({ ref: `x402pay:user-1:eip155:8469:0xp:1000:t${i}`, vb: VB + i })
    }
    const calls = stubChain(() => REDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW, 2)
    expect(out.checked).toBe(2)
    expect(calls.length).toBe(2)
    expect(row('x402pay:user-1:eip155:8469:0xp:1000:t0').resolved).toBe(NOW)
    expect(row('x402pay:user-1:eip155:8469:0xp:1000:t2').resolved).toBeNull()
    // The default cap is small on purpose: one eth_call per row inside a cron tick.
    expect(pay.RECONCILE_BATCH).toBeLessThanOrEqual(25)
    expect(pay.RECONCILE_BATCH).toBeGreaterThan(0)
  })

  it('it sweeps ALL users — reconciliation is a platform job', async () => {
    const refB = 'x402pay:user-2:eip155:8469:0xp:1000:tb'
    reserve('user-1', MICRO); mark()
    reserve('user-2', 1_000, refB); mark({ ref: refB, userId: 'user-2' })
    stubChain(() => UNREDEEMED)
    const out = await pay.reconcileSentSpends(ENV(), NOW)
    expect(out.refunded).toBe(2)
    expect(balance('user-1')).toBe(0)
    expect(balance('user-2')).toBe(0)
  })
})

describe.skipIf(!present)('WHAT WE ASK THE CHAIN — a corrupted call answers "false"', () => {
  it('the eth_call carries the selector, the padded payer and the nonce', async () => {
    reserve()
    mark()
    const calls = stubChain(() => REDEEMED)
    await pay.reconcileSentSpends(ENV(), NOW)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('eth_call')
    expect(calls[0].url).toContain('8545')                 // the tiny-chain RPC
    const [tx, block] = calls[0].params
    expect(String(tx.to).toLowerCase()).toBe(USDC)          // the token, not the payee
    expect(block).toBe('latest')
    const data = String(tx.data)
    expect(data.slice(0, 10)).toBe('0xe94a0102')            // authorizationState(address,bytes32)
    // 4-byte selector + two 32-byte words, exactly.
    expect(data.length).toBe(2 + 8 + 128)
    expect(data.slice(10, 74)).toBe(PAYER.slice(2).padStart(64, '0'))
    expect(data.slice(74)).toBe(NONCE.slice(2))
  })

  it('the selector is the one the contract exposes, and the encoding is left-padded', () => {
    const sol = readFileSync(join(WORKER_SRC, '..', '..', 'chain', 'contracts', 'TinyUSDC.sol'), 'utf8')
    expect(sol).toContain('mapping(address => mapping(bytes32 => bool)) public authorizationState')
    expect(dep.AUTHORIZATION_STATE_SELECTOR).toBe('0xe94a0102')
    const d = dep.encodeAuthorizationState(PAYER, NONCE)
    // An address is a uint160 in a 32-byte word: LEFT-padded. Right-padding it
    // (the natural mistake, since bytes32 IS right-aligned) yields a different
    // payer, an unredeemed answer, and a refund of someone else's settled money.
    expect(d.slice(10, 74)).toBe('0'.repeat(24) + 'ab'.repeat(20))
    expect(d.slice(10, 74)).not.toBe('ab'.repeat(20) + '0'.repeat(24))
  })

  it('a malformed payer or nonce encodes NOTHING rather than garbage', () => {
    // Garbage in the call means an authorization nobody signed, which is
    // unredeemed by definition — a guaranteed false, i.e. a guaranteed refund.
    for (const bad of [['nope', NONCE], [PAYER, '0xdeadbeef'], ['', ''], [PAYER, PAYER]]) {
      expect(dep.encodeAuthorizationState(bad[0], bad[1])).toBeNull()
    }
    expect(dep.encodeAuthorizationState(PAYER.toUpperCase().replace('0X', '0x'), NONCE))
      .toBe(dep.encodeAuthorizationState(PAYER, NONCE))
  })

  it('the network decides the RPC *and* the token together', async () => {
    // Asking chain A's node about chain B's token address is a call to a contract
    // that isn't there → empty data → (correctly) unknown. They must never be
    // resolved from different places.
    const src = code('deposits.ts')
    const fn = src.slice(src.indexOf('export async function authorizationRedeemed'))
    expect(fn).toMatch(/usdcContract\(network, env\)/)
    expect(fn).toMatch(/rpc\(env, "eth_call", \[\{ to: token, data \}, "latest"\], network\)/)
  })
})

describe.skipIf(!present)('wiring: it actually runs, and it cannot take the cron down', () => {
  it('the scheduled handler calls the resolver', () => {
    const src = code('index.ts')
    const sched = src.slice(src.indexOf('async scheduled('), src.indexOf('async email('))
    expect(sched).toMatch(/reconcileSentSpends\(env, Math\.floor\(Date\.now\(\) \/ 1000\)\)/)
    expect(sched).toMatch(/ctx\.waitUntil\(/)
    // ⚠️ The blocker three NEXTs asserted did not exist: this surface was already
    // wired (wrangler.toml [triggers] crons = ["* * * * *"]).
    const wrangler = readFileSync(join(WORKER_SRC, '..', 'wrangler.toml'), 'utf8')
    expect(wrangler).toMatch(/crons\s*=\s*\[\s*"\* \* \* \* \*"/)
  })

  it('a resolver throw cannot kill job dispatch or the Telegram poll', () => {
    const src = code('index.ts')
    const sched = src.slice(src.indexOf('async scheduled('), src.indexOf('async email('))
    const call = sched.slice(sched.indexOf('reconcileSentSpends'))
    expect(call).toMatch(/\.catch\(/)
    // And the function itself is written not to throw: its own DB read is guarded.
    const pysrc = code('payments.ts')
    const fn = pysrc.slice(pysrc.indexOf('export async function reconcileSentSpends'))
    expect(fn.slice(0, 600)).toMatch(/try \{[\s\S]*SPEND_SENT_OPEN_SQL[\s\S]*\} catch/)
  })

  it('the refund SQL is guarded in the WHERE, not by a preceding read', () => {
    expect(pay.RECONCILE_REFUND_SQL).toMatch(/INSERT INTO ledger/)
    expect(pay.RECONCILE_REFUND_SQL).toMatch(/'spend_refund'/)
    expect(pay.RECONCILE_REFUND_SQL).toMatch(/WHERE NOT EXISTS/)
    // The resolution mark is likewise idempotent by its own WHERE.
    expect(pay.SPEND_SENT_RESOLVE_SQL).toMatch(/resolved IS NULL/)
  })

  it('0027 is an ANNOTATION — it never touches a ledger table', () => {
    // Same rule as 0022/0024/0025/0026: balance is SUM(delta_micro) over ALL kinds
    // at five money-critical sites, so nothing about a resolution may live in
    // `ledger` — except the refund itself, which IS a balance change.
    const m = migration('0027_spend_sent_resolved.sql')
    expect(m).toMatch(/ALTER TABLE spend_sent ADD COLUMN resolved INTEGER/)
    expect(m).toMatch(/ALTER TABLE spend_sent ADD COLUMN resolution TEXT/)
    expect(m).not.toMatch(/(ALTER|CREATE)\s+TABLE\s+ledger/)
    expect(m).not.toMatch(/INSERT INTO ledger/)
    expect(m).not.toMatch(/UPDATE spend_sent SET/)     // no backfill: nothing IS resolved yet
  })

  it('the open query stays indexed with the new predicate', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${pay.SPEND_SENT_OPEN_SQL.replace(/\?1/g, '?').replace(/\?2/g, '?')}`).all(1, 1)
    expect(JSON.stringify(plan)).toContain('idx_spend_sent_open')
  })
})
