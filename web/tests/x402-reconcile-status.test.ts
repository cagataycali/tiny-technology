// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-reconcile-status')

/**
 * 🩺 THE READER BOTH RECONCILIATION QUEUES NEVER HAD.
 *
 * Migrations 0027 and 0028 each paid a real design cost for one sentence, which
 * both of them state in their own comments: **the queue's depth is the alarm.**
 * 0027 added a terminal-mark column rather than reuse an existing one precisely so
 * a settled row would stop matching the open query, because "a queue permanently
 * full of already-settled rows is an alarm that is always on, i.e. no alarm at
 * all." Then nothing ever read the number. An alarm nobody looks at is not an
 * alarm either.
 *
 * ⚠️ The metric this cycle is really about is NOT depth. Both sweeps take the
 * OLDEST rows (LIMIT 10 / LIMIT 5) and skip the unresolvable ones IN PLACE, so a
 * few permanently-blocked rows at the HEAD of the queue consume the whole batch
 * every tick and nothing behind them is ever reached. The resolver runs, logs
 * work, drains nothing. A queue of 6 with 5 blocked at the head is more broken
 * than a queue of 400, and depth cannot show that.
 *
 * ⚠️ And a missing table must not read as a healthy zero: on a deployment with
 * this code but not migration 0028, reporting `open: 0` would describe the calmest
 * possible state for the deployment least able to reconcile anything.
 *
 * Recipe as ever: the REAL exported SQL and predicates, the REAL migrations, the
 * REAL route handler against node:sqlite, plus comment-stripped source assertions
 * for the properties that live in control flow rather than in output.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const USDC = '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec'
const PAYER = '0x' + 'ab'.repeat(20)
const NONCE = '0x' + 'cd'.repeat(32)
const TXH = '0x' + 'ef'.repeat(32)
const SLUG = 'demo'
const PRICE = 2_000_000
const OWNER = 'owner-1'
const NOW = 1_800_000_500

let pay: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
})

/** Which migrations the deployment under test has applied. Defaults to all of
 *  them; a test that wants the "code ahead of schema" case omits one. */
const SCHEMA = ['0014_payments.sql', '0015_withdrawals.sql', '0021_deposit_integrity.sql',
  '0024_trial_taint.sql', '0025_spend_sent.sql', '0026_spend_sent_identity.sql',
  '0027_spend_sent_resolved.sql', '0028_settle_unknown.sql']

const applySchema = async (mig: string[] = SCHEMA) => {
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  for (const m of mig) db.exec(migration(m))
  db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?, ?, ?, 1)")
    .run(`tiny:${SLUG}`, OWNER, PRICE)
}

beforeEach(async () => {
  if (!present) return
  await applySchema()
})

const d1 = () => ({
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
    const stmt = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() { const r = db.prepare(sql).run(...args()); return { meta: { changes: Number(r.changes || 0) } } },
      async first() { return db.prepare(sql).get(...args()) ?? null },
      async all() { return { results: db.prepare(sql).all(...args()) } },
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
const ENV = () => ({
  DB: d1(),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: USDC,
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
})

/** The clock the route reads. Frozen so ages are exact rather than approximate. */
let restoreNow: (() => void) | null = null
const freezeClock = (sec: number = NOW) => {
  const orig = Date.now
  restoreNow = () => { Date.now = orig }
  Date.now = () => sec * 1000
}
afterEach(() => { restoreNow?.(); restoreNow = null })

/** Any fetch at all is a failure of this endpoint's contract — it is a pure
 *  reader, and an operator must be able to poll it without touching the chain. */
let restoreFetch: (() => void) | null = null
const forbidFetch = () => {
  const calls: string[] = []
  const orig = globalThis.fetch
  restoreFetch = () => { globalThis.fetch = orig }
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); throw new Error('no network') }) as any
  return calls
}
afterEach(() => { restoreFetch?.(); restoreFetch = null })

const status = async (env: any = ENV(), key: string | null = KEY) => {
  const headers: any = {}
  if (key) headers['x-internal-key'] = key
  const req = new Request('https://w.internal/pay/reconcile-status', { headers })
  const res: Response = await new pay.PayReconcileStatusCall({ skipValidation: true }).handle(req, env)
  return { res, body: await res.json().catch(() => ({})) as any }
}

// ── row factories ──────────────────────────────────────────────────────────────

/** A payer-side open instrument: identity recorded, deadline passed. */
const sentRow = (o: {
  // payer/nonce are nullable on purpose: /pay/spend-sent stores a mark even when
  // identity is malformed, and those rows are exactly the ones the open query
  // cannot see. The bodies already branch on `=== null`; the types must allow it.
  ref?: string; user?: string; payer?: string | null; nonce?: string | null; validBefore?: number | null;
  resolved?: number | null; resolution?: string | null;
} = {}) => {
  db.prepare(
    `INSERT INTO spend_sent (ref, user_id, payee, payer, nonce, valid_before, resolved, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.ref ?? `x402pay:u1:eip155:8469:${Math.random().toString(16).slice(2)}`,
    o.user ?? 'u1', '0x' + '11'.repeat(20),
    o.payer === null ? null : (o.payer ?? PAYER),
    o.nonce === null ? null : (o.nonce ?? NONCE),
    o.validBefore === null ? null : (o.validBefore ?? NOW - 60),
    o.resolved ?? null, o.resolution ?? null,
  )
}

/** A receiver-side open unknown. */
const unknownRow = (o: {
  payer?: string; nonce?: string; slug?: string; price?: number; value?: number | null;
  network?: string | null; created?: number; resolved?: number | null; resolution?: string | null;
  txHash?: string;
} = {}) => {
  db.prepare(
    `INSERT INTO settle_unknown (payer, nonce, tx_hash, slug, price_micro, value_micro, network, created, resolved, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.payer ?? PAYER,
    o.nonce ?? '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
    o.txHash ?? TXH, o.slug ?? SLUG, o.price ?? PRICE,
    o.value === null ? null : (o.value ?? PRICE),
    o.network === null ? null : (o.network ?? 'tiny'),
    o.created ?? NOW - 300, o.resolved ?? null, o.resolution ?? null,
  )
}

describe.skipIf(!present)('/pay/reconcile-status — the alarm both migrations were shaped to preserve', () => {
  it('refuses without the internal key: queue depth is operational intelligence', async () => {
    freezeClock()
    const { res } = await status(ENV(), null)
    expect(res.status).toBe(401)
    const bad = await status(ENV(), 'wrong-key')
    expect(bad.res.status).toBe(401)
  })

  it('reports BOTH queues empty and healthy on a fully-migrated, quiet deployment', async () => {
    freezeClock()
    const { res, body } = await status()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.now).toBe(NOW)
    expect(body.spend_sent.present).toBe(true)
    expect(body.settle_unknown.present).toBe(true)
    expect(body.spend_sent.open).toBe(0)
    expect(body.settle_unknown.open).toBe(0)
    expect(body.healthy).toBe(true)
  })

  it('asks the chain NOTHING — polling a monitor must not touch the money path', async () => {
    freezeClock()
    sentRow(); unknownRow()
    const calls = forbidFetch()
    const { res, body } = await status()
    expect(res.status).toBe(200)
    expect(body.spend_sent.open).toBe(1)
    expect(body.settle_unknown.open).toBe(1)
    expect(calls).toEqual([])
  })

  it('writes nothing: the rows are byte-identical after a poll', async () => {
    freezeClock()
    sentRow(); unknownRow()
    const before = JSON.stringify([
      db.prepare('SELECT * FROM spend_sent').all(),
      db.prepare('SELECT * FROM settle_unknown').all(),
      db.prepare('SELECT * FROM ledger').all(),
    ])
    await status()
    const after = JSON.stringify([
      db.prepare('SELECT * FROM spend_sent').all(),
      db.prepare('SELECT * FROM settle_unknown').all(),
      db.prepare('SELECT * FROM ledger').all(),
    ])
    expect(after).toBe(before)
  })
})

describe.skipIf(!present)('the count IS the queue — one predicate, not a lookalike', () => {
  it('both queue queries are composed from the sweep\'s own exported predicate', () => {
    // The point of the refactor: a monitor that disagrees with the sweep about
    // which rows are open is worse than no monitor.
    expect(pay.SPEND_SENT_OPEN_SQL).toContain(pay.SPEND_SENT_OPEN_WHERE)
    expect(pay.SETTLE_UNKNOWN_OPEN_SQL).toContain(pay.SETTLE_UNKNOWN_OPEN_WHERE)
    const src = code('payments.ts')
    // The route interpolates the fragments rather than restating the clauses.
    expect(src).toMatch(/COUNT\(\*\) AS n[^`]*FROM spend_sent \$\{SPEND_SENT_OPEN_WHERE\}/)
    expect(src).toMatch(/COUNT\(\*\) AS n[^`]*FROM settle_unknown \$\{SETTLE_UNKNOWN_OPEN_WHERE\}/)
  })

  it('counts exactly what the payer sweep would take — resolved and refunded rows excluded', async () => {
    freezeClock()
    sentRow({ ref: 'x402pay:u1:eip155:8469:aaa' })                              // open
    sentRow({ ref: 'x402pay:u1:eip155:8469:bbb', resolved: NOW - 5, resolution: 'settled' }) // done
    sentRow({ ref: 'x402pay:u1:eip155:8469:ccc' })                              // refunded below
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 100, 'spend_refund', 'x402pay:u1:eip155:8469:ccc')").run()
    const { body } = await status()
    // The sweep's own query agrees, row for row.
    const swept = db.prepare(pay.SPEND_SENT_OPEN_SQL.replace(/\?1/g, String(NOW)).replace(/\?2/g, '10')).all()
    expect(body.spend_sent.open).toBe(1)
    expect(swept.length).toBe(1)
    expect(body.spend_sent.total).toBe(3)
  })

  it('counts exactly what the receiver sweep would take — resolved rows excluded', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + 'a1'.repeat(32) })
    unknownRow({ nonce: '0x' + 'a2'.repeat(32), resolved: NOW - 5, resolution: 'credited' })
    unknownRow({ nonce: '0x' + 'a3'.repeat(32), resolved: NOW - 5, resolution: 'cancelled' })
    const { body } = await status()
    expect(body.settle_unknown.open).toBe(1)
    expect(body.settle_unknown.total).toBe(3)
  })
})

describe.skipIf(!present)('THE METRIC THAT MATTERS — head-of-line starvation', () => {
  it('reports how many rows the NEXT receiver batch will skip, not just how many exist', async () => {
    freezeClock()
    // Five unresolvable rows, oldest — they will consume every batch, forever.
    for (let i = 0; i < 5; i++) {
      unknownRow({ nonce: '0x' + `b${i}`.padEnd(64, '0'), network: null, created: NOW - 9000 + i })
    }
    // One perfectly resolvable payment behind them. It will NEVER be reached.
    unknownRow({ nonce: '0x' + 'c9'.repeat(32), created: NOW - 100 })
    const { body } = await status()
    const u = body.settle_unknown
    expect(u.open).toBe(6)
    expect(u.batch).toBe(pay.SETTLE_UNKNOWN_BATCH)
    // The whole finding in one number: the next tick does five rows of nothing.
    expect(u.blocked_in_next_batch).toBe(5)
    expect(u.blocked).toBe(5)
    expect(u.blocked_reasons).toEqual({ 'unknown network': 5 })
    expect(body.healthy).toBe(false)
  })

  it('a queue with blocked rows BEHIND the batch is not starving — depth alone would confuse them', async () => {
    freezeClock()
    // Newest rows are blocked; the head is a full batch of resolvable ones, so
    // the sweep spends every slot on real work and the blocked rows sit behind it.
    const batch = pay.SETTLE_UNKNOWN_BATCH
    for (let i = 0; i < batch; i++) unknownRow({ nonce: '0x' + `d${i}`.padEnd(64, '0'), created: NOW - 9000 + i })
    for (let i = 0; i < 4; i++) unknownRow({ nonce: '0x' + `e${i}`.padEnd(64, '0'), network: null, created: NOW - 10 + i })
    const { body } = await status()
    expect(body.settle_unknown.open).toBe(batch + 4)
    expect(body.settle_unknown.blocked).toBe(4)
    // Head of the queue is clean — this tick makes full progress. The blocked
    // rows are still reported (they never resolve), but they are not STARVING
    // anything, which is the distinction depth alone cannot draw.
    expect(body.settle_unknown.blocked_in_next_batch).toBe(0)
    expect(body.healthy).toBe(false)
  })

  it('a PARTIALLY blocked head is reported as partially wasted, not all-or-nothing', async () => {
    freezeClock()
    // Two resolvable rows, then blocked ones: the batch does 2 rows of work and
    // 3 rows of nothing. Progress, but degrading — and an operator should see the
    // slots being burned before the queue stops draining entirely.
    for (let i = 0; i < 2; i++) unknownRow({ nonce: '0x' + `g${i}`.padEnd(64, '0'), created: NOW - 9000 + i })
    for (let i = 0; i < 6; i++) unknownRow({ nonce: '0x' + `h${i}`.padEnd(64, '0'), network: null, created: NOW - 8000 + i })
    const { body } = await status()
    expect(body.settle_unknown.blocked_in_next_batch).toBe(pay.SETTLE_UNKNOWN_BATCH - 2)
    expect(body.settle_unknown.blocked).toBe(6)
  })

  it('reports the payer sweep\'s head-of-line waste too — an unparseable ref is its skip', async () => {
    freezeClock()
    // c50's skip: `refNetwork` cannot name a chain, so the sweep asks nothing.
    for (let i = 0; i < 3; i++) sentRow({ ref: `not-an-x402-ref-${i}`, validBefore: NOW - 9000 + i })
    sentRow({ ref: 'x402pay:u1:eip155:8469:good', validBefore: NOW - 50 })
    const { body } = await status()
    expect(body.spend_sent.open).toBe(4)
    expect(body.spend_sent.blocked_in_next_batch).toBe(3)
    expect(body.healthy).toBe(false)
  })

  it('c60: a row whose settling tx is banked by another account reports as starving', async () => {
    freezeClock()
    // ⚠️ THE INVISIBLE ONE. Before c60 this row had no verdict and no blocker, so
    // the report called it a healthy open payment while the sweep burned an
    // `eth_getLogs` on it every minute at the HEAD of the queue, forever.
    const stuck = '0x' + 'f1'.repeat(32)
    unknownRow({ nonce: '0x' + 'aa'.repeat(32), txHash: stuck, created: NOW - 9000 })
    db.prepare('INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?)')
      .run(stuck, 'someone-else', 'tiny')
    // A resolvable payment behind it, whose price IS owed.
    unknownRow({ nonce: '0x' + 'bb'.repeat(32), txHash: '0x' + 'f2'.repeat(32), created: NOW - 100 })
    const { body } = await status()
    const u = body.settle_unknown
    expect(u.open).toBe(2)
    expect(u.blocked).toBe(1)
    expect(u.blocked_in_next_batch).toBe(1)
    expect(u.blocked_reasons).toEqual({ 'settling tx already claimed by another account': 1 })
    // Its price is NOT money this mechanism owes a creator — someone banked it.
    expect(u.unpaid_micro).toBe(PRICE)
    expect(body.healthy).toBe(false)
  })

  it('c60: our OWN account holding the hash is not a blocker — that row still drains', async () => {
    freezeClock()
    // The other direction, and the one that would generate false alarms: the sweep
    // credited, `claimed_txs` holds the hash for THIS payer, and /pay/credit
    // answers `already_credited`. Nothing is stuck.
    const mine = '0x' + 'f3'.repeat(32)
    unknownRow({ nonce: '0x' + 'cc'.repeat(32), txHash: mine, created: NOW - 9000 })
    db.prepare('INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?)')
      .run(mine, `x402:${PAYER.toLowerCase()}`, 'tiny')
    const { body } = await status()
    expect(body.settle_unknown.blocked).toBe(0)
    expect(body.settle_unknown.unpaid_micro).toBe(PRICE)
    expect(body.healthy).toBe(true)
  })

  it('c60: the holder lookup is ONE query and the endpoint still touches no chain', async () => {
    freezeClock()
    const calls = forbidFetch()
    // Ten open rows: a per-row lookup would be ten statements, and this endpoint is
    // polled by a monitor — cost is part of its contract.
    let prepared = 0
    for (let i = 0; i < 10; i++) {
      unknownRow({ nonce: '0x' + `7${i}`.padEnd(64, '0'), txHash: '0x' + `e${i}`.padEnd(64, '0') })
    }
    const env = ENV()
    const realPrepare = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => {
      if (/FROM claimed_txs/i.test(sql)) prepared++
      return realPrepare(sql)
    }
    const { body } = await status(env)
    expect(body.settle_unknown.open).toBe(10)
    expect(prepared).toBe(1)
    expect(calls).toEqual([])
  })

  it('c60: a FAILED holder lookup under-reports rather than inventing a blocker', async () => {
    freezeClock()
    // ⚠️ The direction every other guard here errs in. If `claimed_txs` cannot be
    // read (an unmigrated deployment, a storage blip), the map is empty and no row
    // is called claimed. The alternative — treating an unreadable table as "claimed"
    // — would page an operator about the whole queue on a transient error.
    await applySchema(SCHEMA.filter(m => m !== '0021_deposit_integrity.sql'))
    unknownRow({ nonce: '0x' + 'dd'.repeat(32) })
    const { body } = await status()
    expect(body.settle_unknown.blocked).toBe(0)
    expect(body.settle_unknown.blocked_in_next_batch).toBe(0)
    expect(body.settle_unknown.unpaid_micro).toBe(PRICE)
  })

  it('blocked_in_next_batch derives from the sweep\'s OWN gates, not a second opinion', () => {
    const src = code('payments.ts')
    // The receiver-side reporter calls the same two gates the sweep branches on.
    expect(src).toMatch(/export function settleUnknownBlocker[\s\S]{0,400}namedNetwork\(env, row\?\.network\)/)
    expect(src).toMatch(/export function settleUnknownBlocker[\s\S]{0,400}settleUnknownValueBlocker\(row\)/)
    // And the sweep itself branches on that shared value function — so the report
    // cannot drift from the decision.
    const sweep = src.slice(src.indexOf('export async function reconcileSettleUnknown'))
    expect(sweep).toContain('settleUnknownValueBlocker(r)')
    // The payer-side report uses refNetwork, which is that sweep's own gate.
    const route = src.slice(src.indexOf('class PayReconcileStatusCall'))
    expect(route).toContain('refNetwork(env, String(r.ref')
  })
})

describe.skipIf(!present)('the rows that will NEVER resolve — c52\'s skipped branch, finally visible', () => {
  it('names each blocker and counts them separately', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + 'f1'.repeat(32), network: null })          // unknown network
    unknownRow({ nonce: '0x' + 'f2'.repeat(32), network: 'not-a-chain' }) // ditto
    unknownRow({ nonce: '0x' + 'f3'.repeat(32), value: null })            // no signed value
    unknownRow({ nonce: '0x' + 'f4'.repeat(32), value: PRICE - 1 })       // value < price
    unknownRow({ nonce: '0x' + 'f5'.repeat(32) })                         // fine
    const { body } = await status()
    expect(body.settle_unknown.open).toBe(5)
    expect(body.settle_unknown.blocked).toBe(4)
    expect(body.settle_unknown.blocked_reasons).toEqual({
      'unknown network': 2,
      'authorized value does not cover price': 2,
    })
  })

  it('a healthy queue of unconfirmed payments is NOT blocked — waiting is the normal state', async () => {
    freezeClock()
    // Three rows the chain simply has not confirmed yet: the sweep's `unknown`
    // branch, entirely transient. Reporting these as stuck would page an operator
    // for the queue working exactly as designed.
    for (let i = 0; i < 3; i++) unknownRow({ nonce: '0x' + `1${i}`.padEnd(64, '0') })
    const { body } = await status()
    expect(body.settle_unknown.open).toBe(3)
    expect(body.settle_unknown.blocked).toBe(0)
    expect(body.settle_unknown.blocked_reasons).toEqual({})
    expect(body.healthy).toBe(true)
  })

  it('sums the money creators are owed, EXCLUDING rows that can never pay out', async () => {
    freezeClock()
    // ⚠️ CONTRACT UPDATE (c61). These two rows used to be recorded at 1.5 and 0.5
    // while `tiny:demo`'s LIVE price stayed at PRICE (2.0) — a combination the new
    // fourth blocker correctly calls unresolvable, because the sweep credits the
    // recorded price and the split then charges the live one, so invoke 402s
    // forever. The fixture, not the assertion, was what had gone stale: it wanted
    // "two payable rows of different sizes", so give them their own tinys at their
    // own live prices and keep the sum the same.
    db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?, ?, ?, 1)")
      .run('tiny:big', OWNER, 1_500_000)
    db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?, ?, ?, 1)")
      .run('tiny:small', OWNER, 500_000)
    unknownRow({ nonce: '0x' + '21'.repeat(32), slug: 'big', price: 1_500_000, value: 1_500_000 })
    unknownRow({ nonce: '0x' + '22'.repeat(32), slug: 'small', price: 500_000, value: 500_000 })
    unknownRow({ nonce: '0x' + '23'.repeat(32), price: 9_000_000, network: null }) // never payable
    const { body } = await status()
    // 1.5 + 0.5 — the blocked row's price is not owed to anyone by this mechanism,
    // and including it would inflate the one number an operator acts on.
    expect(body.settle_unknown.unpaid_micro).toBe(2_000_000)
  })

  it('names a price RAISED above the credited amount (c61) — end to end through the route', async () => {
    freezeClock()
    // The blocker the sweep gained in c61, asserted where an operator would read
    // it. `tiny:demo` is live at PRICE; record a row at half that, and the split
    // can never be afforded out of what we would credit.
    unknownRow({ nonce: '0x' + '31'.repeat(32), price: PRICE / 2, value: PRICE / 2 })
    const { body } = await status()
    expect(body.settle_unknown.blocked).toBe(1)
    expect(body.settle_unknown.blocked_reasons).toEqual({ 'price raised above the credited amount': 1 })
    // …and its price is excluded from what creators are owed: this money is not
    // payable by this mechanism, so counting it would inflate the actionable number.
    expect(body.settle_unknown.unpaid_micro).toBe(0)
    expect(body.healthy).toBe(false)
  })

  it('an UNPRICED tiny is not blocked — invoke reports free, and the row resolves', async () => {
    freezeClock()
    // The direction that must NOT fire, or the report would invent a blocker for
    // rows that drain perfectly well. Under-reporting is this reader's chosen error.
    db.prepare('DELETE FROM prices').run()
    unknownRow({ nonce: '0x' + '32'.repeat(32) })
    const { body } = await status()
    expect(body.settle_unknown.blocked).toBe(0)
    expect(body.settle_unknown.unpaid_micro).toBe(PRICE)
  })

  it('surfaces the payer-side rows the open query CANNOT SEE — a frozen reservation with no identity', async () => {
    freezeClock()
    // /pay/spend-sent stores a mark even with malformed identity, on purpose (the
    // mark IS the safety fact). Those rows fail `nonce IS NOT NULL`, so no sweep
    // will ever touch them, and the reservation stays frozen with nothing to
    // release it. Invisible to the resolver by design; visible here.
    sentRow({ ref: 'x402pay:u1:eip155:8469:noident', nonce: null, validBefore: null })
    sentRow({ ref: 'x402pay:u1:eip155:8469:halfset', nonce: NONCE, validBefore: null })
    sentRow({ ref: 'x402pay:u1:eip155:8469:open' })
    const { body } = await status()
    expect(body.spend_sent.open).toBe(1)          // only the resolvable one
    expect(body.spend_sent.unresolvable).toBe(2)  // the two nobody can retire
    expect(body.healthy).toBe(false)
  })

  it('an unresolvable payer row that was already refunded by hand is NOT reported as stuck', async () => {
    freezeClock()
    sentRow({ ref: 'x402pay:u1:eip155:8469:fixed', nonce: null, validBefore: null })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 100, 'spend_refund', 'x402pay:u1:eip155:8469:fixed')").run()
    const { body } = await status()
    expect(body.spend_sent.unresolvable).toBe(0)
    expect(body.healthy).toBe(true)
  })
})

describe.skipIf(!present)('backlog AGE — and which clock it is measured from', () => {
  it('payer-side age runs from the SIGNED DEADLINE, not from creation', async () => {
    freezeClock()
    // Created long ago but only answerable 120s ago: before its deadline there was
    // no work to do, so counting that wait would report a backlog that never was.
    sentRow({ ref: 'x402pay:u1:eip155:8469:aged', validBefore: NOW - 120 })
    const { body } = await status()
    expect(body.spend_sent.oldest_due_age_s).toBe(120)
  })

  it('reports rows waiting on the CONTRACT\'s clock apart from the backlog', async () => {
    freezeClock()
    sentRow({ ref: 'x402pay:u1:eip155:8469:future', validBefore: NOW + 600 })
    const { body } = await status()
    // Not yet answerable — healthy, and never counted as a backlog.
    expect(body.spend_sent.open).toBe(0)
    expect(body.spend_sent.not_yet_due).toBe(1)
    expect(body.spend_sent.oldest_due_age_s).toBe(null)
    expect(body.healthy).toBe(true)
  })

  it('receiver-side age runs from creation — the row is answerable the moment it exists', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + '31'.repeat(32), created: NOW - 45 })
    unknownRow({ nonce: '0x' + '32'.repeat(32), created: NOW - 3600 })
    const { body } = await status()
    expect(body.settle_unknown.oldest_open_age_s).toBe(3600)
  })

  it('a clock that has gone backwards reports 0, never a negative age', async () => {
    freezeClock(NOW)
    unknownRow({ nonce: '0x' + '41'.repeat(32), created: NOW + 500 })
    sentRow({ ref: 'x402pay:u1:eip155:8469:skew', validBefore: NOW - 1 })
    const { body } = await status()
    expect(body.settle_unknown.oldest_open_age_s).toBe(0)
    expect(body.spend_sent.oldest_due_age_s).toBe(1)
  })
})

describe.skipIf(!present)('resolution histograms — what the resolvers have actually DONE', () => {
  it('groups both queues by verdict, keeping cancelled distinct from not_settled', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + '51'.repeat(32), resolved: NOW - 9, resolution: 'credited' })
    unknownRow({ nonce: '0x' + '52'.repeat(32), resolved: NOW - 8, resolution: 'credited' })
    unknownRow({ nonce: '0x' + '53'.repeat(32), resolved: NOW - 7, resolution: 'cancelled' })
    sentRow({ ref: 'x402pay:u1:eip155:8469:s1', resolved: NOW - 6, resolution: 'settled' })
    sentRow({ ref: 'x402pay:u1:eip155:8469:s2', resolved: NOW - 5, resolution: 'no_reservation' })
    const { body } = await status()
    expect(body.settle_unknown.resolutions).toEqual({ credited: 2, cancelled: 1 })
    // `no_reservation` (0027) was written and never read until now.
    expect(body.spend_sent.resolutions).toEqual({ settled: 1, no_reservation: 1 })
  })

  it('a resolved row with NO recorded verdict is named, not dropped', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + '61'.repeat(32), resolved: NOW - 5, resolution: null })
    const { body } = await status()
    // Silently omitting it would hide a row whose terminal mark is half-written.
    expect(body.settle_unknown.resolutions).toEqual({ unrecorded: 1 })
  })
})

/**
 * 💸 c62 — THE ONE PAYER VERDICT THAT MOVES MONEY WAS THE ONE THE REPORT COULD
 * NOT SEE.
 *
 * `SPEND_SENT_RESOLVE_SQL` is deliberately not applied to the refund case: the
 * `spend_refund` ledger row is itself the terminal state (the open predicate's
 * NOT EXISTS sees it), and a second record of the same fact would be the split
 * authority this arc keeps closing. Correct — and it means a refunded row keeps
 * `resolved IS NULL`, so the `WHERE resolved IS NOT NULL` histogram excluded
 * every one of them. The endpoint listed `settled` and `no_reservation` (the two
 * outcomes where nothing happened) and omitted the outcome where the platform
 * paid a user back out of its own float.
 *
 * Measured before the fix, on the four-row fixture below: one refund, and
 * `total - open - Σresolutions` = 3. So it was not recoverable by arithmetic
 * either — `not_yet_due` and `unresolvable` rows are in `total` while matching
 * neither `open` nor any resolution, and the subtraction errs in the direction
 * that OVERSTATES money returned.
 */
describe.skipIf(!present)('c62: refunds are reported, and reported once', () => {
  it('a REFUNDED row is counted — the histogram alone cannot contain it', async () => {
    freezeClock()
    const ref = 'x402pay:u1:eip155:8469:refunded'
    sentRow({ ref })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 2000000, 'spend_refund', ?)").run(ref)
    const { body } = await status()
    expect(body.spend_sent.refunded).toBe(1)
    // NON-VACUITY: the pre-c62 surface. If `resolutions` ever starts containing
    // it, that means someone made the refund path write a terminal mark too — a
    // deliberate change, and this assertion is where it gets noticed.
    expect(body.spend_sent.resolutions).toEqual({})
  })

  it('and it is NOT recoverable from total - open - Σresolutions', async () => {
    // The exact fixture the probe measured. Four rows, one refund.
    freezeClock()
    const refunded = 'x402pay:u1:eip155:8469:c62-refunded'
    sentRow({ ref: refunded })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 2000000, 'spend_refund', ?)").run(refunded)
    sentRow({ ref: 'x402pay:u1:eip155:8469:c62-settled', resolved: NOW - 5, resolution: 'settled' })
    sentRow({ ref: 'x402pay:u1:eip155:8469:c62-future', validBefore: NOW + 9999 })
    sentRow({ ref: 'x402pay:u1:eip155:8469:c62-noid', payer: null, nonce: null, validBefore: null })
    const { body } = await status()
    const s = body.spend_sent
    const sum = Object.values(s.resolutions as Record<string, number>).reduce((a, b) => a + b, 0)
    expect(s.total).toBe(4)
    expect(s.open).toBe(0)
    expect(sum).toBe(1)
    // The subtraction an operator would reach for yields 3 for ONE refund — which
    // is why this is a query and not a note in a docblock.
    expect(s.total - s.open - sum).toBe(3)
    expect(s.refunded).toBe(1)
  })

  it('a REIMBURSED spend counts as ONE refund, not two', async () => {
    // ⚠️ The reason it is COUNT(DISTINCT ref). A reimbursed spend has TWO debited
    // ledger rows under one ref (the payer's `spend_debit` and the sponsor's
    // `spend_reimburse`), and the reconciler's refund batch writes one
    // compensating row PER entry — measured: 2 ledger rows, 1 reconciled
    // instrument. Counting rows would report the platform returning money twice.
    freezeClock()
    const ref = 'x402pay:u1:eip155:8469:reimbursed'
    sentRow({ ref })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 2000000, 'spend_refund', ?)").run(ref)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('sponsor', 2000000, 'spend_refund', ?)").run(ref)
    const { body } = await status()
    expect(body.spend_sent.refunded).toBe(1)
  })

  it('a DEBITED but unrefunded row is not counted — the kind filter, not the JOIN', async () => {
    // ⚠️ A mutant that replaced `kind = 'spend_refund'` with `kind IS NOT NULL`
    // SURVIVED the tests above, and it was not equivalence: those fixtures wrote
    // no `spend_debit` rows, while in production EVERY marked ref has one (the
    // reservation). So the loosened filter would have counted every open row as
    // refunded — the platform reported as having returned money it still holds.
    freezeClock()
    const ref = 'x402pay:u1:eip155:8469:c62-debited'
    sentRow({ ref })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', -2000000, 'spend_debit', ?)").run(ref)
    const { body } = await status()
    expect(body.spend_sent.refunded).toBe(0)
    expect(body.spend_sent.open).toBe(1)   // non-vacuous: the row IS in the queue
  })

  it('a hand-reversed ref that was never MARKED is not counted as reconciler work', async () => {
    // /pay/spend-reverse writes `spend_refund` for refs whose authorization never
    // left us — those never got a spend_sent mark, are not this queue's business,
    // and counting them would inflate the number with ordinary cancellations. The
    // JOIN is what keeps this honest.
    freezeClock()
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 100, 'spend_refund', 'x402pay:u1:eip155:8469:never-marked')").run()
    const { body } = await status()
    expect(body.spend_sent.refunded).toBe(0)
    expect(body.spend_sent.present).toBe(true)   // non-vacuous: we DID look
  })

  it('a missing spend_sent table reports refunded: null, never 0', async () => {
    // Same rule as every other count here: "I could not look" is not "no refunds".
    await applySchema(SCHEMA.filter(m => !m.startsWith('0025') && !m.startsWith('0026') && !m.startsWith('0027')))
    freezeClock()
    const { body } = await status()
    expect(body.spend_sent.present).toBe(false)
    expect(body.spend_sent.refunded).toBe(null)
    expect(body.spend_sent.refunded).not.toBe(0)
  })

  it('a refund does NOT page — it is a completed outcome, not distress', async () => {
    // Rule 1 of the pager. A refund is the reconciler working exactly as designed;
    // a condition here would be an alarm that fires on success.
    freezeClock()
    const ref = 'x402pay:u1:eip155:8469:c62-quiet'
    sentRow({ ref })
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref) VALUES ('u1', 2000000, 'spend_refund', ?)").run(ref)
    const { body } = await status()
    expect(body.spend_sent.refunded).toBe(1)
    expect(body.healthy).toBe(true)
    expect(body.alarm.conditions).toEqual([])
  })
})

describe.skipIf(!present)('c63: money that ARRIVED and reached no creator', () => {
  /**
   * ⚠️ c62's lens turned on the receiver, and it found the mirror image of c62's
   * bug — with the direction of the loss reversed.
   *
   * On the payer side the invisible verdict was a REFUND: the platform paying a
   * user back. Here it is a payment that LANDED at X402_PAY_TO and reached no
   * creator at all. c60 (`tx_claimed_elsewhere`) and c61 (`split_underfunded`)
   * both made that state TERMINAL, and both were right to — the row can never
   * resolve itself, and leaving it open starved everything behind it in an
   * oldest-first queue of 5. But every number the report and the pager consult
   * describes the OPEN queue, so resolving the row is what SILENCES them.
   *
   * Probe-measured, and this is the part that made it a bug rather than a gap:
   * the pager alerted, the sweep marked the row terminal, and two ticks later it
   * DELIVERED "✅ x402 reconciliation is clear again" with the owner's balance
   * still 0. A false retraction is worse than silence — it invites closing the
   * ticket.
   */
  const strandedRow = (o: { nonce?: string; price?: number; resolution?: string } = {}) =>
    unknownRow({
      nonce: o.nonce ?? '0x' + 'e1'.padEnd(64, '0'),
      price: o.price ?? PRICE,
      resolved: NOW - 30,
      resolution: o.resolution ?? 'split_underfunded',
    })

  it('a split_underfunded row is reported as stranded, with its money', async () => {
    freezeClock()
    strandedRow()
    const { body } = await status()
    expect(body.settle_unknown.stranded).toBe(1)
    expect(body.settle_unknown.stranded_micro).toBe(PRICE)
    // NON-VACUITY, and the whole point: every OTHER number has gone calm. The row
    // left the queue, so `unpaid_micro` — which sums the open queue only — is 0,
    // and nothing is blocked because nothing is open.
    expect(body.settle_unknown.open).toBe(0)
    expect(body.settle_unknown.unpaid_micro).toBe(0)
    expect(body.settle_unknown.blocked).toBe(0)
  })

  it('a tx_claimed_elsewhere row counts too — both verdicts, one figure', async () => {
    freezeClock()
    strandedRow({ nonce: '0x' + 'e2'.padEnd(64, '0'), price: 5_000_000, resolution: 'tx_claimed_elsewhere' })
    strandedRow({ nonce: '0x' + 'e3'.padEnd(64, '0'), price: 2_000_000, resolution: 'split_underfunded' })
    const { body } = await status()
    expect(body.settle_unknown.stranded).toBe(2)
    expect(body.settle_unknown.stranded_micro).toBe(7_000_000)
  })

  it('⚠️ and it is NOT derivable from the histogram — money is not rows × anything', async () => {
    freezeClock()
    // Three stranded rows at three different prices. The histogram can only ever
    // say "3"; no arithmetic over the reported numbers yields $10.00, because the
    // per-row price is exactly what the histogram throws away. This is what makes
    // it worth a query rather than a docblock note (c62's rule, restated).
    strandedRow({ nonce: '0x' + 'f1'.padEnd(64, '0'), price: 1_000_000 })
    strandedRow({ nonce: '0x' + 'f2'.padEnd(64, '0'), price: 3_000_000, resolution: 'tx_claimed_elsewhere' })
    strandedRow({ nonce: '0x' + 'f3'.padEnd(64, '0'), price: 6_000_000 })
    const { body } = await status()
    expect(body.settle_unknown.resolutions).toEqual({ split_underfunded: 2, tx_claimed_elsewhere: 1 })
    expect(body.settle_unknown.stranded).toBe(3)
    expect(body.settle_unknown.stranded_micro).toBe(10_000_000)
    // The histogram's own counts, multiplied by ANY single price, cannot reach it.
    expect(3 * PRICE).not.toBe(body.settle_unknown.stranded_micro)
  })

  it('a CANCELLED row is not stranded — the payer voided it, nothing arrived', async () => {
    freezeClock()
    // The direction that must NOT fire. A cancel is a non-sale, not a loss, and
    // folding it in would inflate the one figure an operator escalates on.
    unknownRow({ nonce: '0x' + 'c1'.padEnd(64, '0'), resolved: NOW - 30, resolution: 'cancelled' })
    const { body } = await status()
    expect(body.settle_unknown.stranded).toBe(0)
    expect(body.settle_unknown.stranded_micro).toBe(0)
    // Non-vacuous: the row IS resolved and IS in the histogram.
    expect(body.settle_unknown.resolutions).toEqual({ cancelled: 1 })
  })

  it('a CREDITED row is not stranded — the creator was paid', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + 'c2'.padEnd(64, '0'), resolved: NOW - 30, resolution: 'credited' })
    const { body } = await status()
    expect(body.settle_unknown.stranded).toBe(0)
    expect(body.settle_unknown.resolutions).toEqual({ credited: 1 })
  })

  it('an OPEN row is not stranded — it is still `unpaid_micro`, and may yet pay', async () => {
    freezeClock()
    // ⚠️ A mutant dropping `resolved IS NOT NULL` from the stranded query
    // SURVIVES this whole file, and that is CORRECT, not a gap: it is an
    // EQUIVALENT mutant. `SETTLE_UNKNOWN_RESOLVE_SQL` is the only writer of
    // `resolution` and it sets both columns in one UPDATE, so no reachable row
    // can have a resolution while `resolved` is NULL. The clause is
    // defense-in-depth against a future writer, and no fixture can distinguish
    // it without first inventing a row the schema's own writers cannot produce.
    // What this test DOES pin is the disjointness an operator reads: the same
    // dollar is either still-collectable (`unpaid_micro`) or lost (`stranded`),
    // never both, never neither.
    unknownRow({ nonce: '0x' + 'c3'.padEnd(64, '0') })
    const { body } = await status()
    expect(body.settle_unknown.stranded).toBe(0)
    expect(body.settle_unknown.stranded_micro).toBe(0)
    expect(body.settle_unknown.open).toBe(1)
    expect(body.settle_unknown.unpaid_micro).toBe(PRICE)
  })

  it('the verdict list is EXHAUSTIVE against the sweep\'s own resolve() calls', () => {
    // ⚠️ The reusable half of this fix. A predicate written against today's four
    // verdicts goes quietly false the day a cycle invents a fifth — and the
    // failure direction is under-reporting money owed to a creator, which is the
    // silence this whole arc exists to delete. So the constants are asserted to
    // PARTITION what the sweep can actually write.
    const src = code('payments.ts')
    const fn = src.slice(src.indexOf('export async function reconcileSettleUnknown'))
    const body = fn.slice(0, fn.indexOf('export const STATUS_SCAN_LIMIT'))
    const written = Array.from(
      new Set(Array.from(body.matchAll(/resolve\(payer, nonce, "([a-z_]+)"\)/g), (m) => m[1])),
    ).sort()
    expect(written.length).toBeGreaterThan(2) // non-vacuous: the regex found them
    const declared = [...pay.STRANDED_RESOLUTIONS, ...pay.SETTLED_RESOLUTIONS].sort()
    expect(declared).toEqual(written)
    // …and the two halves are disjoint, or a verdict could be counted both ways.
    for (const r of pay.STRANDED_RESOLUTIONS) expect(pay.SETTLED_RESOLUTIONS).not.toContain(r)
  })

  it('the query is built FROM those constants, not from a duplicated literal', () => {
    // The c9 shape: one shared fragment both readers embed, so "adding a verdict"
    // can never be a per-file edit that misses a site.
    for (const r of pay.STRANDED_RESOLUTIONS) {
      expect(pay.SETTLE_UNKNOWN_STRANDED_SQL).toContain(`'${r}'`)
    }
    for (const r of pay.SETTLED_RESOLUTIONS) {
      expect(pay.SETTLE_UNKNOWN_STRANDED_SQL).not.toContain(`'${r}'`)
    }
    const src = code('payments.ts')
    expect(src).toMatch(/STRANDED_RESOLUTIONS\.map\(/)
    // The route uses the exported SQL rather than restating it.
    const route = src.slice(src.indexOf('export async function reconcileStatus'))
    expect(route).toContain('SETTLE_UNKNOWN_STRANDED_SQL')
  })

  it('a missing settle_unknown table reports stranded: null, never 0', async () => {
    // c62's rule: a table that cannot be read is not a healthy zero — and here 0
    // would specifically mean "no creator is owed anything" on the deployment
    // least able to know.
    await applySchema(SCHEMA.filter(m => m !== '0028_settle_unknown.sql'))
    freezeClock()
    const { body } = await status()
    expect(body.settle_unknown.present).toBe(false)
    expect(body.settle_unknown.stranded).toBe(null)
    expect(body.settle_unknown.stranded_micro).toBe(null)
    expect(body.healthy).toBe(false)
  })

  it('stranded rows do NOT page — rule 1 holds, because no sweep can clear them', async () => {
    freezeClock()
    strandedRow()
    const { body } = await status()
    // Deliberate. `alarmConditions` only reads what a sweep can still fix; a
    // terminal row cannot be fixed by any tick, so a condition here would fire
    // forever and get the pager muted — the failure c59's whole design avoids.
    // The money is carried in the alarm TEXT instead (see the alarm suite).
    expect(body.alarm.conditions).toEqual([])
    expect(body.settle_unknown.stranded).toBe(1)
  })
})

describe.skipIf(!present)('a MISSING TABLE is not a healthy zero', () => {
  it('reports settle_unknown absent — and does NOT claim the queue is empty', async () => {
    // A deployment with c52's code but not migration 0028.
    await applySchema(SCHEMA.filter(m => m !== '0028_settle_unknown.sql'))
    freezeClock()
    const { res, body } = await status()
    expect(res.status).toBe(200)                    // still answers; a monitor needs a reply
    expect(body.settle_unknown.present).toBe(false)
    expect(body.settle_unknown.open).toBe(null)     // NOT 0 — we could not look
    expect(body.settle_unknown.blocked).toBe(null)
    expect(String(body.settle_unknown.error)).toMatch(/settle_unknown/)
    // The one boolean a monitor pages on must never be true here.
    expect(body.healthy).toBe(false)
    // The other queue is still reported normally — one missing table does not
    // blind the whole endpoint.
    expect(body.spend_sent.present).toBe(true)
  })

  it('reports spend_sent absent when 0027 has not been applied', async () => {
    // The exact case reconcileSentSpends guards for: "no such column: resolved".
    await applySchema(SCHEMA.filter(m => m !== '0027_spend_sent_resolved.sql'))
    freezeClock()
    const { body } = await status()
    expect(body.spend_sent.present).toBe(false)
    expect(body.spend_sent.open).toBe(null)
    expect(body.settle_unknown.present).toBe(true)
    expect(body.healthy).toBe(false)
  })

  it('never throws: a totally empty schema still answers 200', async () => {
    await applySchema(['0014_payments.sql'])
    freezeClock()
    const { res, body } = await status()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.spend_sent.present).toBe(false)
    expect(body.settle_unknown.present).toBe(false)
    expect(body.healthy).toBe(false)
  })
})

describe.skipIf(!present)('no silent caps', () => {
  it('says when it classified only part of the queue', async () => {
    freezeClock()
    const limit = pay.STATUS_SCAN_LIMIT
    expect(limit).toBeGreaterThan(0)
    for (let i = 0; i < limit + 5; i++) {
      unknownRow({ nonce: '0x' + i.toString(16).padStart(64, '0'), created: NOW - 5000 + i })
    }
    const { body } = await status()
    const u = body.settle_unknown
    // Depth is exact (it is SQL); classification is bounded and SAYS so.
    expect(u.open).toBe(limit + 5)
    expect(u.scanned).toBe(limit)
    expect(u.scan_truncated).toBe(true)
  })

  it('does not claim truncation when it saw everything', async () => {
    freezeClock()
    unknownRow({ nonce: '0x' + '71'.repeat(32) })
    const { body } = await status()
    expect(body.settle_unknown.scanned).toBe(1)
    expect(body.settle_unknown.scan_truncated).toBe(false)
  })

  it('the scan limit is bounded, and the route reports scanned + truncated together', () => {
    const src = code('payments.ts')
    expect(src).toMatch(/export const STATUS_SCAN_LIMIT = \d+/)
    const route = src.slice(src.indexOf('class PayReconcileStatusCall'))
    expect(route).toContain('scan_truncated')
    expect(route).toContain('STATUS_SCAN_LIMIT')
  })
})

describe.skipIf(!present)('settleUnknownValueBlocker — pure, and the sweep\'s only value rule', () => {
  it('names the exact refusal for each unresolvable shape', () => {
    expect(pay.settleUnknownValueBlocker({ price_micro: PRICE, value_micro: PRICE })).toBe(null)
    expect(pay.settleUnknownValueBlocker({ price_micro: PRICE, value_micro: PRICE + 1 })).toBe(null)
    expect(pay.settleUnknownValueBlocker({ price_micro: PRICE, value_micro: PRICE - 1 }))
      .toBe('authorized value does not cover price')
    expect(pay.settleUnknownValueBlocker({ price_micro: PRICE, value_micro: null }))
      .toBe('authorized value does not cover price')
    expect(pay.settleUnknownValueBlocker({ price_micro: 0, value_micro: PRICE })).toBe('no price')
    expect(pay.settleUnknownValueBlocker({ price_micro: -1, value_micro: PRICE })).toBe('no price')
    expect(pay.settleUnknownValueBlocker({})).toBe('no price')
    expect(pay.settleUnknownValueBlocker(null)).toBe('no price')
  })

  it('a garbage price is refused, never coerced into a credit', () => {
    // The mint direction: any non-number must fail the price gate outright.
    expect(pay.settleUnknownValueBlocker({ price_micro: 'lots', value_micro: PRICE })).toBe('no price')
    expect(pay.settleUnknownValueBlocker({ price_micro: NaN, value_micro: PRICE })).toBe('no price')
    expect(pay.settleUnknownValueBlocker({ price_micro: Infinity, value_micro: Infinity })).toBe('no price')
  })

  it('c60: a settling hash held by ANOTHER account is a blocker — but only that case', () => {
    const env = ENV()
    const row = { network: 'tiny', price_micro: PRICE, value_micro: PRICE, tx_hash: TXH, payer: PAYER }
    const held = (owner: string) => new Map([[TXH.toLowerCase(), owner]])
    // No map, or a map that doesn't mention this hash: nothing is claimed.
    expect(pay.settleUnknownBlocker(env, row)).toBe(null)
    expect(pay.settleUnknownBlocker(env, row, new Map())).toBe(null)
    // ⚠️ OUR OWN account holding it is the idempotent-success path — /pay/credit
    // answers `already_credited: true`, not 409. Reporting it as blocked would
    // page an operator about a payment that is about to complete normally.
    expect(pay.settleUnknownBlocker(env, row, held(`x402:${PAYER.toLowerCase()}`))).toBe(null)
    // Someone else: 409 forever.
    expect(pay.settleUnknownBlocker(env, row, held('u-someone-else')))
      .toBe('settling tx already claimed by another account')
    // Case is not a get-out: the table is written lowercase by the reserving path,
    // but the payer column has been stored both ways over the schema's life.
    expect(pay.settleUnknownBlocker(env, { ...row, payer: PAYER.toUpperCase().replace('0X', '0x') },
      held(`x402:${PAYER.toLowerCase()}`))).toBe(null)
    // A row with no hash cannot be claimed by anyone — no lookup, no verdict.
    expect(pay.settleUnknownBlocker(env, { ...row, tx_hash: null }, held('u-someone-else'))).toBe(null)
    // And the earlier gates still win: a row that fails BOTH reports the first.
    expect(pay.settleUnknownBlocker(env, { ...row, network: null }, held('u-someone-else')))
      .toBe('unknown network')
  })

  it('settleUnknownBlocker layers the network gate on top, in the sweep\'s order', () => {
    const env = ENV()
    // A row that fails BOTH reports the network first — the same order the sweep
    // checks them, so the reason a human reads matches the reason it skipped.
    expect(pay.settleUnknownBlocker(env, { network: null, price_micro: 0 })).toBe('unknown network')
    expect(pay.settleUnknownBlocker(env, { network: 'tiny', price_micro: 0 })).toBe('no price')
    expect(pay.settleUnknownBlocker(env, { network: 'tiny', price_micro: PRICE, value_micro: PRICE })).toBe(null)
    // `namedNetwork` accepts CAIP-2 too, and must NOT fall back to the deployment
    // default — a row whose chain we cannot name is unresolvable, not "ours".
    expect(pay.settleUnknownBlocker(env, { network: 'eip155:8469', price_micro: PRICE, value_micro: PRICE })).toBe(null)
    expect(pay.settleUnknownBlocker(env, { network: 'eip155:999999', price_micro: PRICE, value_micro: PRICE }))
      .toBe('unknown network')
  })
})

describe.skipIf(!present)('healthy — conservative by construction', () => {
  it('is false whenever a queue could not be READ, not only when work is stuck', async () => {
    await applySchema(SCHEMA.filter(m => m !== '0028_settle_unknown.sql'))
    freezeClock()
    const { body } = await status()
    // Nothing is stuck (nothing is even visible) — and it still must not read green.
    expect(body.settle_unknown.blocked).toBe(null)
    expect(body.healthy).toBe(false)
  })

  it('stays true for a busy-but-draining pair of queues', async () => {
    freezeClock()
    for (let i = 0; i < 4; i++) unknownRow({ nonce: '0x' + `8${i}`.padEnd(64, '0') })
    for (let i = 0; i < 3; i++) sentRow({ ref: `x402pay:u1:eip155:8469:ok${i}` })
    const { body } = await status()
    expect(body.spend_sent.open).toBe(3)
    expect(body.settle_unknown.open).toBe(4)
    expect(body.healthy).toBe(true)
  })

  it('goes false on payer-side starvation alone', async () => {
    freezeClock()
    sentRow({ ref: 'unparseable-ref' })
    const { body } = await status()
    expect(body.healthy).toBe(false)
  })
})

describe.skipIf(!present)('wiring: the endpoint is reachable, internal, and read-only', () => {
  it('is registered as a GET on the router', () => {
    const idx = code('index.ts')
    expect(idx).toContain("router.get('/pay/reconcile-status', PayReconcileStatusCall)")
    expect(idx).toContain('PayReconcileStatusCall')
    // A POST would imply it mutates something. It does not.
    expect(idx).not.toContain("router.post('/pay/reconcile-status'")
  })

  it('checks the internal key before touching the DB', () => {
    const src = code('payments.ts')
    const route = src.slice(src.indexOf('class PayReconcileStatusCall'))
    const guard = route.indexOf('checkInternalKey')
    const firstRead = route.indexOf('tableStatus(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstRead)
  })

  it('contains no write verbs at all', () => {
    const src = code('payments.ts')
    const start = src.indexOf('class PayReconcileStatusCall')
    const route = src.slice(start, src.indexOf('function histogram', start))
    expect(route).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/)
    expect(route).not.toContain('.run()')
    expect(route).not.toContain('DB.batch')
  })
})
