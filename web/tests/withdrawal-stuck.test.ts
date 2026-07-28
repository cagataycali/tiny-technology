// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('withdrawal-stuck')

/**
 * 💸 THE THIRD MONEY RAIL: A WITHDRAWAL NOBODY WILL EVER TOUCH AGAIN.
 *
 * ⚠️ THE FINDING, MEASURED BEFORE THE FIX. `withdrawals` is the only money rail
 * in this platform with NO SWEEP. Grep for `FROM withdrawals`: the daily-cap
 * subquery, the two guarded UPDATEs, and nothing else. A `pending` row is advanced
 * ONLY by the single HTTP request that created it (`app/api/wallet/withdraw`,
 * `maxDuration` 60s, receipt wait 45s), so once that request is over the row is
 * TERMINAL — and it is terminal AFTER the user's ledger was already debited.
 *
 * Both reachable paths are ordinary, not exotic:
 *   • `tx_hash IS NULL` — debit committed, payout never went out. The route's own
 *     `.catch()` comment says the row is "visible in withdrawals table for
 *     repair"; nothing was ever built to look.
 *   • `tx_hash IS NOT NULL` — the deliberate 202 `pending_confirmation` path,
 *     never auto-refunded (that would double-pay a landing tx) and explicitly
 *     handed to "reconciliation to resolve" — a reconciler that did not exist.
 *
 * RENDERED, with one $50 withdrawal pending for three days, BEFORE this change:
 *   `healthy: true` · `alarmConditions(status)` → `[]` · the pager's own words
 *   "✅ x402 reconciliation is clear again" — while the ledger read -50000000.
 *
 * ⚠️ SO THE LOAD-BEARING ASSERTIONS ARE THE RENDERED STRINGS AND THE TWO SPLIT
 * COUNTS. Split, because the two cases need OPPOSITE hands: unbroadcast is safe to
 * refund, broadcast must be checked on-chain first or the user is paid twice. A
 * single "N stuck" total would invite the dangerous half — so no test here is
 * allowed to be satisfied by the total alone.
 *
 * Recipe as ever: the REAL migration against node:sqlite, the REAL exported SQL,
 * the REAL status function the endpoint serves and the REAL decision module.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const USDC = '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec'
const TXH = '0x' + 'ef'.repeat(32)
const NOW = 1_800_000_500
const USER = 'u-withdrawer'

let wd: any, pay: any, alarm: any, db: any

beforeAll(async () => {
  if (!present) return
  wd = await import(workerFile('withdrawals.ts') /* @vite-ignore */)
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
  alarm = await import(workerFile('reconcile-alarm.ts') /* @vite-ignore */)
})

/** The queues `reconcileStatus` reads live here too — the status body is one object. */
const SCHEMA = ['0014_payments.sql', '0015_withdrawals.sql', '0021_deposit_integrity.sql',
  '0024_trial_taint.sql', '0025_spend_sent.sql', '0026_spend_sent_identity.sql',
  '0027_spend_sent_resolved.sql', '0028_settle_unknown.sql']

const applySchema = async (mig: string[] = SCHEMA) => {
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  for (const m of mig) db.exec(migration(m))
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, detail TEXT)`)
}

beforeEach(async () => { if (present) await applySchema() })

/** D1's positional `?1..?N` → node:sqlite named params (the shared shim). */
const d1 = () => ({
  prepare(sql: string) {
    const binds: any[] = []
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

const ENV = (over: any = {}) => ({
  DB: d1(),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: USDC,
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
  ...over,
})

/** Zero RPC is this whole surface's contract — the alarm runs every minute. */
let restoreFetch: (() => void) | null = null
const forbidFetch = () => {
  const calls: string[] = []
  const orig = globalThis.fetch
  restoreFetch = () => { globalThis.fetch = orig }
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); throw new Error('no network') }) as any
  return calls
}
afterEach(() => { restoreFetch?.(); restoreFetch = null })

let seq = 0
/**
 * A withdrawal row, written the way the handler writes it — plus the LEDGER DEBIT
 * that is atomic with it, because the debit is the thing that makes a stuck row
 * cost the user money rather than merely being untidy.
 */
const withdrawal = (o: {
  status?: string; micro?: number; txHash?: string | null; ageS?: number; updated?: number | null; user?: string;
} = {}) => {
  const id = `wd-${++seq}`
  const created = NOW - (o.ageS ?? 0)
  const micro = o.micro ?? 50_000_000
  db.prepare(
    `INSERT INTO withdrawals (id, user_id, amount_micro, fee_micro, to_address, network, status, tx_hash, created, updated)
     VALUES (?, ?, ?, 100000, ?, 'tiny', ?, ?, ?, ?)`
  ).run(id, o.user ?? USER, micro, '0x' + 'cc'.repeat(20), o.status ?? 'pending',
    o.txHash === undefined ? null : o.txHash, created,
    o.updated === undefined ? created : o.updated)
  db.prepare(
    "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'withdrawal', ?, 'chain:tiny')"
  ).run(o.user ?? USER, -micro, id)
  return id
}

const balance = (user = USER) =>
  Number(db.prepare("SELECT COALESCE(SUM(delta_micro),0) AS v FROM ledger WHERE user_id = ?").get(user).v)

const kinds = (s: any) => alarm.alarmConditions(s).map((c: any) => c.kind)

const statusBody = (env: any = ENV(), nowSec = NOW) => pay.reconcileStatus(env, nowSec)

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 THE REGRESSION ITSELF — rendered, not diffed
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 a debited withdrawal frozen for days', () => {
  it('is no longer invisible to the operator surface', async () => {
    withdrawal({ ageS: 3 * 86400 })          // $50, pending, three days, no hash
    forbidFetch()
    const status = await statusBody()

    // The money really is gone from the user's side. This is what makes the
    // silence expensive rather than cosmetic.
    expect(balance()).toBe(-50_000_000)

    expect(status.healthy).toBe(false)
    expect(status.withdrawals.present).toBe(true)
    expect(status.withdrawals.stuck).toBe(1)
    expect(status.withdrawals.stuck_micro).toBe(50_000_000)
    expect(status.withdrawals.oldest_stuck_age_s).toBe(3 * 86400)
    // Before the fix, this string did not exist anywhere in the body.
    expect(JSON.stringify(status)).toContain('withdraw')
  })

  it('and the PAGER says so, in words an operator can act on', async () => {
    withdrawal({ ageS: 3 * 86400 })
    forbidFetch()
    const status = await statusBody()
    const conds = alarm.alarmConditions(status)
    expect(conds.map((c: any) => c.kind)).toEqual(['withdrawal_never_broadcast'])

    const { short, full } = alarm.formatAlarmText('alert', conds, status)
    // RENDERED. The old text read "✅ x402 reconciliation is clear again" for
    // exactly this state, so the assertion is on the sentence, not the fields.
    expect(full).toContain('$50.0000')
    expect(full).toContain('safe to refund')
    expect(full).toContain('already debited from user balances')
    expect(short).toContain('withdrawal_never_broadcast')
    expect(short.length).toBeLessThanOrEqual(300)   // survives emitEvent's slice
  })

  it('🔴 and a recovery message can never claim "clear" while one is frozen', async () => {
    // The c63 rule, one rail over: a retraction that omits the money is worse than
    // the silence it replaces. Here the guard is structural — a frozen withdrawal
    // is a CONDITION, so `alarmDecide` cannot reach a recovery at all.
    withdrawal({ ageS: 3 * 86400 })
    forbidFetch()
    const status = await statusBody()
    let state = alarm.EMPTY_ALARM_STATE
    for (let t = 0; t < 6; t++) {
      const d = alarm.alarmDecide({ conditions: alarm.alarmConditions(status), prev: state, nowSec: NOW + t * 60 })
      expect(d.fire).not.toBe('recovery')
      state = d.state
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 THE SPLIT: two counts, two hands. Never one total.
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 unbroadcast and broadcast are never merged', () => {
  it('a broadcast-but-unconfirmed row says CHECK THE CHAIN, not refund', async () => {
    withdrawal({ ageS: 3600, txHash: TXH, micro: 7_000_000 })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.broadcast_unconfirmed).toBe(1)
    expect(status.withdrawals.broadcast_unconfirmed_micro).toBe(7_000_000)
    expect(status.withdrawals.unbroadcast).toBe(0)
    expect(status.withdrawals.unbroadcast_micro).toBe(0)

    const conds = alarm.alarmConditions(status)
    expect(conds.map((c: any) => c.kind)).toEqual(['withdrawal_unconfirmed'])
    const { full } = alarm.formatAlarmText('alert', conds, status)
    expect(full).toContain('CHECK THE CHAIN')
    expect(full).toContain('paid twice')
    // ⚠️ THE DANGEROUS SENTENCE MUST NOT APPEAR. Telling an operator a broadcast
    // withdrawal is "safe to refund" pays the user twice out of platform float.
    expect(full).not.toContain('safe to refund')
  })

  it('one of each is TWO conditions with the right money on each', async () => {
    withdrawal({ ageS: 3600, micro: 3_000_000 })                 // no hash
    withdrawal({ ageS: 7200, txHash: TXH, micro: 11_000_000 })   // hash
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.unbroadcast).toBe(1)
    expect(status.withdrawals.unbroadcast_micro).toBe(3_000_000)
    expect(status.withdrawals.broadcast_unconfirmed).toBe(1)
    expect(status.withdrawals.broadcast_unconfirmed_micro).toBe(11_000_000)
    expect(status.withdrawals.stuck).toBe(2)
    expect(status.withdrawals.stuck_micro).toBe(14_000_000)
    // Oldest across BOTH groups, not per group.
    expect(status.withdrawals.oldest_stuck_age_s).toBe(7200)

    const conds = alarm.alarmConditions(status)
    expect(conds.map((c: any) => c.kind).sort())
      .toEqual(['withdrawal_never_broadcast', 'withdrawal_unconfirmed'])
    const { full } = alarm.formatAlarmText('alert', conds, status)
    expect(full).toContain('$3.0000')
    expect(full).toContain('$11.0000')
    expect(full).toContain('$14.0000')        // the context total
  })

  it('an empty-string tx_hash counts as NEVER broadcast', async () => {
    // A `''` hash is not a transaction. If it grouped as broadcast, the operator
    // would be told to check a chain for a tx that was never sent — and would
    // leave a refundable debit frozen out of caution.
    withdrawal({ ageS: 3600, txHash: '' })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.unbroadcast).toBe(1)
    expect(status.withdrawals.broadcast_unconfirmed).toBe(0)
  })

  it('many rows aggregate per group in SQL, not per row in JS', async () => {
    for (let i = 0; i < 5; i++) withdrawal({ ageS: 3600 + i, micro: 1_000_000 })
    for (let i = 0; i < 3; i++) withdrawal({ ageS: 3600 + i, txHash: TXH, micro: 2_000_000 })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.unbroadcast).toBe(5)
    expect(status.withdrawals.unbroadcast_micro).toBe(5_000_000)
    expect(status.withdrawals.broadcast_unconfirmed).toBe(3)
    expect(status.withdrawals.broadcast_unconfirmed_micro).toBe(6_000_000)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 SILENCE, WHERE SILENCE IS CORRECT — rule 1 through a different door
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 a payout in flight is the HEALTHY state', () => {
  it('a withdrawal requested seconds ago pages nobody and keeps healthy true', async () => {
    withdrawal({ ageS: 5 })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.present).toBe(true)
    expect(status.withdrawals.stuck).toBe(0)
    expect(status.withdrawals.oldest_stuck_age_s).toBe(null)
    expect(status.healthy).toBe(true)
    expect(alarm.alarmConditions(status)).toEqual([])
  })

  it('the boundary belongs to the request, not the pager', async () => {
    // 60s `maxDuration` + 45s receipt wait — a row younger than the window must
    // never be called stuck, or the alarm fires on the system working and gets
    // muted, which is the failure the whole module is arranged around.
    expect(wd.WITHDRAWAL_STUCK_S).toBe(900)
    withdrawal({ ageS: wd.WITHDRAWAL_STUCK_S - 1 })
    forbidFetch()
    expect((await statusBody()).withdrawals.stuck).toBe(0)

    await applySchema()
    withdrawal({ ageS: wd.WITHDRAWAL_STUCK_S })
    expect((await statusBody()).withdrawals.stuck).toBe(1)
  })

  it('paid and failed rows are finished business, at any age', async () => {
    withdrawal({ ageS: 30 * 86400, status: 'paid', txHash: TXH })
    withdrawal({ ageS: 30 * 86400, status: 'failed' })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.stuck).toBe(0)
    expect(status.healthy).toBe(true)
    expect(alarm.alarmConditions(status)).toEqual([])
  })

  it('`updated` wins over `created` — a retried row is not an abandoned one', async () => {
    // The guarded UPDATEs stamp `updated`, so this measures time since anything
    // last happened to the row rather than since the user asked. A row created two
    // days ago but touched a minute ago is in flight.
    withdrawal({ ageS: 2 * 86400, updated: NOW - 60 })
    forbidFetch()
    expect((await statusBody()).withdrawals.stuck).toBe(0)
  })

  it('a NULL `updated` falls back to `created` rather than vanishing', async () => {
    // COALESCE, not `updated <= ?`: a NULL would silently fail the comparison and
    // the oldest possible abandoned row would be the one that never reports.
    withdrawal({ ageS: 3 * 86400, updated: null })
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.stuck).toBe(1)
    expect(kinds(status)).toEqual(['withdrawal_never_broadcast'])
  })

  it('an empty table is a real, earned zero', async () => {
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.present).toBe(true)
    expect(status.withdrawals.stuck).toBe(0)
    expect(status.healthy).toBe(true)
    const { short, full } = alarm.formatAlarmText('recovery', [], status)
    expect(short).toContain('clear again')
    expect(full).toBe(short)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 A MISSING TABLE IS NOT A HEALTHY ZERO (c62's rule, third rail)
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 unreadable ≠ calm', () => {
  it('reports null counts and pages, on a deployment with no withdrawals table', async () => {
    // A deployment running ahead of its schema is the deployment LEAST able to pay
    // anyone. Reporting a calm zero there is the mistake c62 named.
    await applySchema(SCHEMA.filter(m => m !== '0015_withdrawals.sql'))
    forbidFetch()
    const status = await statusBody()
    expect(status.withdrawals.present).toBe(false)
    expect(status.withdrawals.stuck).toBe(null)
    expect(status.withdrawals.unbroadcast).toBe(null)
    expect(status.withdrawals.broadcast_unconfirmed).toBe(null)
    expect(status.withdrawals.stuck_micro).toBe(null)
    expect(String(status.withdrawals.error)).toContain('withdrawals')
    expect(status.healthy).toBe(false)
    expect(kinds(status)).toEqual(['withdrawals_unreadable'])
    // The reason reaches the reader, not just the fact.
    expect(alarm.alarmConditions(status)[0].detail).toContain('withdrawals')
  })

  it('a DB that throws does not take the whole status body down with it', async () => {
    // The endpoint serves three rails; one unreadable rail must not blind the
    // operator to the other two.
    const env = ENV({ DB: { prepare: () => { throw new Error('D1 exploded') } } })
    const out = await wd.withdrawalsStatus(env, NOW)
    expect(out.present).toBe(false)
    expect(out.stuck).toBe(null)
    expect(String(out.error)).toContain('D1 exploded')
    expect(out.stuck_after_s).toBe(900)      // the threshold is still reported
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// The contract: zero RPC, real SQL, and the conditions read the SPLIT fields
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('contract', () => {
  it('asks the chain nothing', async () => {
    withdrawal({ ageS: 3 * 86400 })
    withdrawal({ ageS: 3 * 86400, txHash: TXH })
    const calls = forbidFetch()
    await statusBody()
    expect(calls).toEqual([])
  })

  it('the status reader runs the EXPORTED statement, not a lookalike', () => {
    // Same rule as `deposits.ts` owning `claimed_txs`: a second copy of this SQL
    // is a second thing to keep in step with the state machine.
    const src = code('withdrawals.ts')
    expect(src).toContain('WITHDRAWALS_STUCK_SQL')
    expect(src).toContain('env.DB.prepare(WITHDRAWALS_STUCK_SQL)')
    expect(wd.WITHDRAWALS_STUCK_SQL).toContain("status = 'pending'")
    expect(wd.WITHDRAWALS_STUCK_SQL).toContain('GROUP BY broadcast')
    // And payments.ts delegates rather than re-deriving it.
    const paySrc = code('payments.ts')
    expect(paySrc).toContain('withdrawalsStatus(env, nowSec)')
    expect(paySrc).not.toContain('FROM withdrawals')
  })

  it('🔴 the conditions read the SPLIT counts and never the total', () => {
    // The load-bearing source guard. `stuck` is a context number for the text; if
    // a future edit made it a condition, the two verdicts would collapse into one
    // and an operator would be told to refund a broadcast payout.
    const src = code('reconcile-alarm.ts')
    const body = src.slice(src.indexOf('export function alarmConditions'), src.indexOf('export function alarmSignature'))
    // Non-vacuity first: the slice really is the function and it really reads the
    // split fields (a comment-stripped body, so no docblock can satisfy this).
    expect(body).toContain('wd.unbroadcast')
    expect(body).toContain('wd.broadcast_unconfirmed')
    expect(body.length).toBeGreaterThan(500)
    expect(body).not.toContain('wd.stuck')
    // …and depth-style fields stay out, exactly as for the other two rails.
    expect(body).not.toContain('oldest_stuck_age_s')
  })

  it('END TO END: the real cron pages the real operator, then retracts honestly', async () => {
    // Everything above tests the pieces. This drives `sweepReconcileAlarm` — the
    // function `scheduled()` actually calls — so the wiring is proven, not assumed:
    // a rail that computes perfectly and is never reached by the cron is the c53
    // failure (an endpoint nobody polls) one level up.
    const id = withdrawal({ ageS: 3 * 86400 })
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_bots (
      user_id TEXT PRIMARY KEY, token TEXT, allowed_chats TEXT, enabled INTEGER DEFAULT 1, offset INTEGER)`)
    const kv = new Map<string, string>()
    const env = ENV({
      tiny: { async get(k: string) { return kv.get(k) ?? null }, async put(k: string, v: string) { kv.set(k, v) } },
      RECONCILE_ALARM_USER: 'ops-user-9',
    })
    forbidFetch()

    expect((await alarm.sweepReconcileAlarm(env, NOW)).fire).toBe(null)            // one tick never pages
    const second = await alarm.sweepReconcileAlarm(env, NOW + 60)
    expect(second.fire).toBe('alert')
    expect(second.delivered).toBe(true)
    const ring = db.prepare("SELECT kind, detail FROM events ORDER BY id").all()
    expect(ring.length).toBe(1)
    expect(ring[0].kind).toBe('pay_alarm')
    expect(String(ring[0].detail)).toContain('withdrawal_never_broadcast')

    // A human refunds it the only way the platform can: the fail handler.
    db.prepare("UPDATE withdrawals SET status = 'failed', updated = ? WHERE id = ?").run(NOW + 120, id)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'refund', ?, 'platform')")
      .run(USER, 50_000_000, id)
    expect(balance()).toBe(0)

    expect((await alarm.sweepReconcileAlarm(env, NOW + 60 * 60)).fire).toBe(null)
    expect((await alarm.sweepReconcileAlarm(env, NOW + 61 * 60)).fire).toBe('recovery')
    const last = db.prepare("SELECT detail FROM events ORDER BY id DESC LIMIT 1").get()
    // ⚠️ The retraction now has to be true about withdrawals too — it used to say
    // "no blocked rows in either queue", a sentence with no room for a third rail.
    expect(String(last.detail)).toContain('no stuck withdrawals')
  })

  it('healthy requires ALL THREE rails, and any one of them can veto', async () => {
    withdrawal({ ageS: 3 * 86400 })
    forbidFetch()
    expect((await statusBody()).healthy).toBe(false)
    const paySrc = code('payments.ts')
    const line = paySrc.slice(paySrc.indexOf('const healthy ='), paySrc.indexOf('return { ok: true, now: nowSec'))
    expect(line).toContain('withdrawals.present')
    expect(line).toContain('!withdrawals.stuck')
  })
})
