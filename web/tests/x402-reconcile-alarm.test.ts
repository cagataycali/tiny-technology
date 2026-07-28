// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-reconcile-alarm')

/**
 * 🚨 THE PAGER FOR THE MONEY RAILS — two x402 queues plus WITHDRAWALS (c32).
 *
 * c53 shipped the SURFACE (`GET /pay/reconcile-status`) and said so: the
 * threshold is a judgement call about what should wake somebody. But an endpoint
 * nobody polls is unread, which is the same failure it exists to fix one level
 * down — migrations 0027/0028 each paid a design cost so queue depth would be a
 * meaningful alarm, and nothing ever looked.
 *
 * ⚠️ SO THE LOAD-BEARING TESTS HERE ARE THE ONES WHERE NOTHING HAPPENS. An alarm
 * that fires on a healthy state gets muted, and the mute is invisible. Three
 * silences are asserted as hard invariants:
 *
 *   (1) `open > 0` NEVER pages — 500 open rows with nothing blocked is the
 *       DESIGNED state of settle_unknown ("waiting for a confirmation that is
 *       very likely coming"), on every tick, forever.
 *   (2) one tick never pages — a condition must hold across two.
 *   (3) ZERO RPC — the endpoint asks the chain nothing on purpose, and an alarm
 *       that costs an eth_call per minute is an alarm somebody turns off. Every
 *       outbound fetch except the Telegram delivery is a test failure.
 *
 * Recipe as ever: the REAL migrations against node:sqlite, the REAL status
 * function the endpoint serves, the REAL decision module, plus comment-stripped
 * source assertions for the properties that live in control flow.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const USDC = '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec'
const PAYER = '0x' + 'ab'.repeat(20)
const TXH = '0x' + 'ef'.repeat(32)
const SLUG = 'demo'
const PRICE = 2_000_000
const OWNER = 'owner-1'
const OPS = 'ops-user-9'
const NOW = 1_800_000_500

/**
 * The THIRD rail, quiet. Spread into every synthetic status body below, because a
 * body missing this rail is genuinely unreadable now (same doctrine as a missing
 * `spend_sent`) — omitting it would make each of those tests assert its own
 * subject PLUS a `withdrawals_unreadable` it never meant to talk about.
 *
 * ⚠️ `unbroadcast: 0` and `broadcast_unconfirmed: 0` are the quiet values, and
 * they are DIFFERENT fields from `stuck` — the conditions read the two split
 * counts, never the total, because refunding the wrong half pays a user twice.
 */
const WD_CLEAR = {
  withdrawals: {
    present: true, stuck: 0, stuck_micro: 0, oldest_stuck_age_s: null,
    unbroadcast: 0, unbroadcast_micro: 0, broadcast_unconfirmed: 0, broadcast_unconfirmed_micro: 0,
  },
}

let alarm: any, pay: any, db: any

beforeAll(async () => {
  if (!present) return
  alarm = await import(workerFile('reconcile-alarm.ts') /* @vite-ignore */)
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
})

const SCHEMA = ['0014_payments.sql', '0015_withdrawals.sql', '0021_deposit_integrity.sql',
  '0024_trial_taint.sql', '0025_spend_sent.sql', '0026_spend_sent_identity.sql',
  '0027_spend_sent_resolved.sql', '0028_settle_unknown.sql']

const applySchema = async (mig: string[] = SCHEMA) => {
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  for (const m of mig) db.exec(migration(m))
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_bots (
    user_id TEXT PRIMARY KEY, token TEXT, allowed_chats TEXT, enabled INTEGER DEFAULT 1, offset INTEGER)`)
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, detail TEXT)`)
  db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?, ?, ?, 1)")
    .run(`tiny:${SLUG}`, OWNER, PRICE)
}

beforeEach(async () => {
  if (!present) return
  await applySchema()
  kv = new Map()
})

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

/** The KV `tiny` binding the alarm keeps its between-ticks state in. */
let kv: Map<string, string> = new Map()
const kvBinding = (opts: { getThrows?: boolean; putThrows?: boolean } = {}) => ({
  async get(k: string) { if (opts.getThrows) throw new Error('kv down'); return kv.get(k) ?? null },
  async put(k: string, v: string) { if (opts.putThrows) throw new Error('kv down'); kv.set(k, v) },
})

const ENV = (over: any = {}) => ({
  DB: d1(),
  tiny: kvBinding(),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: USDC,
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
  RECONCILE_ALARM_USER: OPS,
  ...over,
})

/**
 * Every outbound fetch is recorded. Telegram is permitted (that IS the delivery);
 * anything resembling an RPC call is a contract violation and the assertion below
 * names it, rather than a generic "no fetch" that a future delivery rail would
 * break for the wrong reason.
 */
let restoreFetch: (() => void) | null = null
const captureFetch = () => {
  const calls: { url: string; body: any }[] = []
  const orig = globalThis.fetch
  restoreFetch = () => { globalThis.fetch = orig }
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'Content-Type': 'application/json' } })
  }) as any
  return calls
}
afterEach(() => { restoreFetch?.(); restoreFetch = null })

const rpcCalls = (calls: { url: string }[]) =>
  calls.filter(c => !c.url.startsWith('https://api.telegram.org/'))

const events = () => db.prepare("SELECT user_id, kind, detail FROM events ORDER BY id").all()

// ── row factories (same shapes as x402-reconcile-status.test.ts) ───────────────

const sentRow = (o: {
  ref?: string; user?: string; payer?: string | null; nonce?: string | null; validBefore?: number | null;
  resolved?: number | null; resolution?: string | null;
} = {}) => {
  db.prepare(
    `INSERT INTO spend_sent (ref, user_id, payee, payer, nonce, valid_before, resolved, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.ref ?? `x402pay:u1:eip155:8469:${nextId()}`,
    o.user ?? 'u1', '0x' + '11'.repeat(20),
    o.payer === null ? null : (o.payer ?? PAYER),
    o.nonce === null ? null : (o.nonce ?? '0x' + 'cd'.repeat(32)),
    o.validBefore === null ? null : (o.validBefore ?? NOW - 60),
    o.resolved ?? null, o.resolution ?? null,
  )
}

const unknownRow = (o: {
  nonce?: string; network?: string | null; price?: number; value?: number | null; created?: number;
  resolved?: number | null; resolution?: string | null;
} = {}) => {
  db.prepare(
    `INSERT INTO settle_unknown (payer, nonce, tx_hash, slug, price_micro, value_micro, network, pay_to, valid_before, created, resolved, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    PAYER, o.nonce ?? `0x${nextId().padStart(64, '0')}`, TXH, SLUG,
    o.price ?? PRICE,
    o.value === null ? null : (o.value ?? PRICE),
    o.network === null ? null : (o.network ?? 'eip155:8469'),
    '0x' + '22'.repeat(20), NOW - 60, o.created ?? NOW - 300,
    o.resolved ?? null, o.resolution ?? null,
  )
}

let seq = 0
const nextId = () => String(++seq).padStart(6, '0')

/** One cron tick. */
const tick = (env: any = ENV(), nowSec: number = NOW) => alarm.sweepReconcileAlarm(env, nowSec)

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 (1) DEPTH IS NOT DISTRESS — the rule that keeps the alarm believable
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 open rows NEVER page', () => {
  it('a huge healthy backlog produces no conditions at all', () => {
    // The designed state of settle_unknown: rows waiting for a confirmation that
    // was signed, accepted and broadcast — we merely failed to see the receipt
    // inside 60s. Paging on this would page for the system working.
    const conds = alarm.alarmConditions({
      spend_sent: { present: true, open: 400, oldest_due_age_s: 999_999, blocked_in_next_batch: 0, unresolvable: 0, not_yet_due: 12 },
      settle_unknown: { present: true, open: 500, oldest_open_age_s: 999_999, blocked_in_next_batch: 0, blocked: 0, blocked_reasons: {}, unpaid_micro: 900_000_000 },
      ...WD_CLEAR,
    })
    expect(conds).toEqual([])
  })

  it('stays silent across MANY ticks with a deep healthy queue', async () => {
    for (let i = 0; i < 40; i++) unknownRow({ created: NOW - 3600 })
    const env = ENV()
    const calls = captureFetch()
    for (let t = 0; t < 5; t++) {
      const r = await tick(env, NOW + t * 60)
      expect(r.fire).toBe(null)
    }
    expect(events()).toEqual([])
    expect(calls).toEqual([])
  })

  it('the decision function reads none of the depth/age/value fields', () => {
    // Source-level, because a future edit that adds `open` to the conditions
    // would pass every behavioural test above only until someone had a backlog.
    const src = code('reconcile-alarm.ts')
    const body = src.slice(src.indexOf('export function alarmConditions'), src.indexOf('export function alarmSignature'))
    for (const forbidden of ['.open', 'oldest_due_age_s', 'oldest_open_age_s', 'unpaid_micro', '.total', 'not_yet_due']) {
      expect(body).not.toContain(forbidden)
    }
    // And it DOES read the head-of-line metric c53 argued is the one that matters.
    expect(body).toContain('blocked_in_next_batch')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 (2) TWO CONSECUTIVE TICKS
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 a condition must persist across two ticks', () => {
  const blocked = () => alarm.alarmConditions({
    spend_sent: { present: true, blocked_in_next_batch: 3, unresolvable: 0, batch: 10 },
    settle_unknown: { present: true, blocked_in_next_batch: 0, blocked: 0, blocked_reasons: {} },
    ...WD_CLEAR,
  })

  it('tick 1 records and stays silent; tick 2 fires', () => {
    const first = alarm.alarmDecide({ conditions: blocked(), prev: alarm.EMPTY_ALARM_STATE, nowSec: NOW })
    expect(first.fire).toBe(null)
    expect(first.streak).toBe(1)
    expect(first.suppressed).toContain('1/2')

    const second = alarm.alarmDecide({ conditions: blocked(), prev: first.state, nowSec: NOW + 60 })
    expect(second.fire).toBe('alert')
    expect(second.streak).toBe(2)
  })

  it('a one-tick blip never pages, however many times it blips', () => {
    let state = alarm.EMPTY_ALARM_STATE
    const fires: any[] = []
    for (let i = 0; i < 10; i++) {
      const conds = i % 2 === 0 ? blocked() : []
      const d = alarm.alarmDecide({ conditions: conds, prev: state, nowSec: NOW + i * 60 })
      state = d.state
      if (d.fire) fires.push(d.fire)
    }
    expect(fires).toEqual([])
  })

  it('end to end: two real ticks over a blocked head produce one page', async () => {
    // A settle_unknown row whose network cannot be named is skipped identically
    // every minute forever — and it is at the HEAD, so it eats the batch.
    unknownRow({ network: 'eip155:999999', created: NOW - 3600 })
    unknownRow({ created: NOW - 100 })
    const env = ENV()
    const calls = captureFetch()

    const t1 = await tick(env, NOW)
    expect(t1.fire).toBe(null)
    expect(events()).toEqual([])

    const t2 = await tick(env, NOW + 60)
    expect(t2.fire).toBe('alert')
    expect(t2.delivered).toBe(true)
    const ring = events()
    expect(ring.length).toBe(1)
    expect(ring[0].user_id).toBe(OPS)
    expect(ring[0].kind).toBe(alarm.ALARM_EVENT_KIND)
    expect(String(ring[0].detail)).toContain('unknown_head_blocked')
    // ⚠️ ZERO RPC, on a tick that actually paged.
    expect(rpcCalls(calls)).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 (3) ZERO RPC
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 the alarm never asks the chain anything', () => {
  it('makes no non-Telegram request even with both queues full of blocked rows', async () => {
    for (let i = 0; i < 6; i++) unknownRow({ network: null, created: NOW - 1000 + i })
    sentRow({ ref: 'not-a-ref-with-a-network' })
    sentRow({ nonce: null })
    const env = ENV()
    const calls = captureFetch()
    await tick(env, NOW)
    await tick(env, NOW + 60)
    expect(rpcCalls(calls)).toEqual([])
  })

  it('the module imports no RPC helper', () => {
    const src = code('reconcile-alarm.ts')
    expect(src).not.toContain('./deposits')
    expect(src).not.toMatch(/eth_[a-zA-Z]/)
    expect(src).not.toContain('RPC_URL')
  })

  it('the status function it reads is the endpoint`s own, not a second reader', () => {
    // The alarm and the operator must never disagree about whether anything is
    // wrong — so there is exactly one implementation of the summary.
    const src = code('reconcile-alarm.ts')
    expect(src).toContain('reconcileStatus')
    expect(typeof pay.reconcileStatus).toBe('function')
    // …and the route serves that same value plus the alarm's own view.
    const payments = code('payments.ts')
    expect(payments).toContain('const status = await reconcileStatus(env, nowSec)')
    expect(payments).toContain('alarm: await alarmView(env, status, nowSec)')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// What DOES page — one condition per thing that cannot clear on its own
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('alarmConditions — the selection rule', () => {
  const base = {
    spend_sent: { present: true, blocked_in_next_batch: 0, unresolvable: 0, batch: 10, open: 3 },
    settle_unknown: { present: true, blocked_in_next_batch: 0, blocked: 0, blocked_reasons: {}, batch: 5, open: 9 },
    ...WD_CLEAR,
  }
  const kinds = (s: any) => alarm.alarmConditions(s).map((c: any) => c.kind)

  it('head-of-line waste on either side', () => {
    expect(kinds({ ...base, spend_sent: { ...base.spend_sent, blocked_in_next_batch: 2 } })).toEqual(['sent_head_blocked'])
    expect(kinds({ ...base, settle_unknown: { ...base.settle_unknown, blocked_in_next_batch: 1 } })).toEqual(['unknown_head_blocked'])
  })

  it('identity-less reservations, which no queue can ever release', () => {
    expect(kinds({ ...base, spend_sent: { ...base.spend_sent, unresolvable: 4 } })).toEqual(['sent_unresolvable'])
  })

  it('an unreadable table is a condition, not a healthy zero', () => {
    // "I could not look" is not "nothing is wrong" — the endpoint's own doctrine.
    expect(kinds({ ...base, settle_unknown: { present: false, error: 'no such table' } }))
      .toEqual(['unknown_unreadable'])
    expect(kinds({ ...base, withdrawals: { present: false, error: 'no such table: withdrawals' } }))
      .toEqual(['withdrawals_unreadable'])
    expect(kinds({ spend_sent: {}, settle_unknown: {}, withdrawals: {} }).sort())
      .toEqual(['sent_unreadable', 'unknown_unreadable', 'withdrawals_unreadable'])
    // A totally malformed body must not read as calm either — and the count is
    // per RAIL, so a body that mentions none of the three says so three times.
    expect(alarm.alarmConditions(null).map((c: any) => c.kind).sort())
      .toEqual(['sent_unreadable', 'unknown_unreadable', 'withdrawals_unreadable'])
    expect(alarm.alarmConditions(undefined).length).toBe(3)
    // ⚠️ And the reason must reach the reader: an unreadable withdrawals table on
    // a deployment that cannot pay anyone is the worst place for "no reason
    // reported" to be the whole message.
    expect(alarm.alarmConditions({ ...base, withdrawals: { present: false, error: 'no such table: withdrawals' } })[0].detail)
      .toContain('no such table: withdrawals')
  })

  it('each named blocker gets its OWN kind, sorted', () => {
    // So a NEW kind of blocker appearing is new information: the signature
    // changes and it re-pages instead of hiding inside an unchanged total.
    expect(kinds({
      ...base,
      settle_unknown: { ...base.settle_unknown, blocked: 3, blocked_reasons: { 'unknown network': 2, 'value below price': 1 } },
    })).toEqual(['unknown_blocker:unknown network', 'unknown_blocker:value below price'])
  })

  it('a blocked TOTAL with no breakdown still pages', () => {
    // Otherwise a status body that reports the count but not the reasons reads as
    // healthy — the exact "renders as its calmest value" shape.
    expect(kinds({ ...base, settle_unknown: { ...base.settle_unknown, blocked: 7, blocked_reasons: {} } }))
      .toEqual(['unknown_blocked'])
    expect(kinds({ ...base, settle_unknown: { ...base.settle_unknown, blocked: 7, blocked_reasons: null } }))
      .toEqual(['unknown_blocked'])
  })

  it('a zero-count reason is not a blocker', () => {
    expect(kinds({ ...base, settle_unknown: { ...base.settle_unknown, blocked: 0, blocked_reasons: { 'unknown network': 0 } } }))
      .toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Signature: KINDS only — the mistake that would cause silence AND a flood
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('alarmSignature is counts-free', () => {
  it('a growing count does not change the signature', () => {
    // If it did, the streak would reset every tick (never reaching 2 → silence)
    // AND every tick would look like a new problem (defeating re-notify → flood).
    const sig = (n: number) => alarm.alarmSignature(alarm.alarmConditions({
      spend_sent: { present: true, blocked_in_next_batch: n, unresolvable: 0 },
      settle_unknown: { present: true, blocked: 0, blocked_reasons: {} },
      ...WD_CLEAR,
    }))
    expect(sig(1)).toBe(sig(99))
    expect(sig(1)).toBe('sent_head_blocked')
  })

  it('a growing queue never defeats the two-tick rule', () => {
    let state = alarm.EMPTY_ALARM_STATE
    let fired = 0
    for (let i = 1; i <= 4; i++) {
      const conditions = alarm.alarmConditions({
        spend_sent: { present: true, blocked_in_next_batch: i, unresolvable: 0 },
        settle_unknown: { present: true, blocked: 0, blocked_reasons: {} },
      })
      const d = alarm.alarmDecide({ conditions, prev: state, nowSec: NOW + i * 60 })
      state = d.state
      if (d.fire) fired++
    }
    expect(fired).toBe(1)   // fires once on tick 2, then held quiet
  })

  it('order does not change the signature', () => {
    expect(alarm.alarmSignature([{ kind: 'b', detail: '' }, { kind: 'a', detail: '' }])).toBe('a|b')
    expect(alarm.alarmSignature([])).toBe('')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Bounded re-notification — both gates
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('the same problem does not page every minute', () => {
  const conds = [{ kind: 'sent_head_blocked', detail: 'x' }]

  it('re-pages only after ALARM_RENOTIFY_S', () => {
    const prev = { sig: 'sent_head_blocked', streak: 5, notifiedSig: 'sent_head_blocked', notifiedAt: NOW }
    expect(alarm.alarmDecide({ conditions: conds, prev, nowSec: NOW + 3600 }).fire).toBe(null)
    expect(alarm.alarmDecide({ conditions: conds, prev, nowSec: NOW + alarm.ALARM_RENOTIFY_S - 1 }).fire).toBe(null)
    expect(alarm.alarmDecide({ conditions: conds, prev, nowSec: NOW + alarm.ALARM_RENOTIFY_S }).fire).toBe('alert')
  })

  it('🔴 a DIFFERENT problem still waits out the short gap', () => {
    // A flapping blocker that keeps changing its name must not become a
    // per-minute feed — the tighter gate always applies.
    const prev = { sig: 'sent_unresolvable', streak: 5, notifiedSig: 'sent_head_blocked', notifiedAt: NOW }
    const other = [{ kind: 'sent_unresolvable', detail: 'x' }]
    expect(alarm.alarmDecide({ conditions: other, prev, nowSec: NOW + 60 }).fire).toBe(null)
    expect(alarm.alarmDecide({ conditions: other, prev, nowSec: NOW + alarm.ALARM_MIN_GAP_S }).fire).toBe('alert')
    // …but sooner than the same problem would have.
    expect(alarm.ALARM_MIN_GAP_S).toBeLessThan(alarm.ALARM_RENOTIFY_S)
  })

  it('a first-ever page is not gated by an empty clock', () => {
    const prev = { sig: 'sent_head_blocked', streak: 1, notifiedSig: '', notifiedAt: 0 }
    expect(alarm.alarmDecide({ conditions: conds, prev, nowSec: NOW }).fire).toBe('alert')
  })

  it('over an hour of blocked ticks, exactly one page goes out', async () => {
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV()
    const calls = captureFetch()
    for (let m = 0; m < 60; m++) await tick(env, NOW + m * 60)
    expect(events().length).toBe(1)
    expect(rpcCalls(calls)).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Recovery — gated symmetrically, because "resolved" is the most believed message
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('recovery', () => {
  it('says so once, after two clear ticks, only if it had paged', () => {
    const notified = { sig: 'sent_head_blocked', streak: 9, notifiedSig: 'sent_head_blocked', notifiedAt: NOW - 100 }
    const c1 = alarm.alarmDecide({ conditions: [], prev: notified, nowSec: NOW })
    expect(c1.fire).toBe(null)
    const c2 = alarm.alarmDecide({ conditions: [], prev: c1.state, nowSec: NOW + 60 })
    expect(c2.fire).toBe('recovery')
    // And then nothing more — the outstanding problem is cleared from state.
    const c3 = alarm.alarmDecide({ conditions: [], prev: c2.state, nowSec: NOW + 120 })
    expect(c3.fire).toBe(null)
    expect(c2.state.notifiedSig).toBe('')
  })

  it('🔴 a one-tick clear between blocked ticks is NOT a recovery', () => {
    const notified = { sig: 'sent_head_blocked', streak: 9, notifiedSig: 'sent_head_blocked', notifiedAt: NOW - 100 }
    const clear = alarm.alarmDecide({ conditions: [], prev: notified, nowSec: NOW })
    expect(clear.fire).toBe(null)
    const again = alarm.alarmDecide({
      conditions: [{ kind: 'sent_head_blocked', detail: 'x' }], prev: clear.state, nowSec: NOW + 60,
    })
    expect(again.fire).toBe(null)   // still outstanding, still quiet
  })

  it('never announces a recovery it never paged about', () => {
    const never = { sig: '', streak: 50, notifiedSig: '', notifiedAt: 0 }
    expect(alarm.alarmDecide({ conditions: [], prev: never, nowSec: NOW }).fire).toBe(null)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 The env var is a silent OFF switch — the mitigations, asserted
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('🔴 an unconfigured destination is said OUT LOUD', () => {
  it('the tick still runs and still decides with no RECONCILE_ALARM_USER', async () => {
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV({ RECONCILE_ALARM_USER: '' })
    captureFetch()
    const t1 = await tick(env, NOW)
    expect(t1.configured).toBe(false)
    const t2 = await tick(env, NOW + 60)
    // It decided to fire — and delivered nothing, because there is nowhere.
    expect(t2.fire).toBe('alert')
    expect(t2.delivered).toBe(false)
    expect(events()).toEqual([])
  })

  it('/pay/reconcile-status reports the pager as off', async () => {
    const env = ENV({ RECONCILE_ALARM_USER: '  ' })   // whitespace is not a user
    const status = await pay.reconcileStatus(env, NOW)
    const view = await alarm.alarmView(env, status, NOW)
    expect(view.configured).toBe(false)
    expect(String(view.note)).toContain(alarm.ALARM_USER_VAR)
  })

  it('and as ON when it is', async () => {
    const env = ENV()
    const view = await alarm.alarmView(env, await pay.reconcileStatus(env, NOW), NOW)
    expect(view.configured).toBe(true)
    expect(view.note).toBeUndefined()
  })

  it('🔴 the view REPORTS the streak, it does not advance it', async () => {
    // A monitor curling the endpoint must not satisfy the two-tick rule on the
    // cron's behalf — that would page on a single bad tick that a human polled.
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV()
    captureFetch()
    await tick(env, NOW)                                   // streak 1
    const before = kv.get(alarm.ALARM_KV_KEY)
    for (let i = 0; i < 5; i++) await alarm.alarmView(env, await pay.reconcileStatus(env, NOW), NOW)
    expect(kv.get(alarm.ALARM_KV_KEY)).toBe(before)         // untouched
    const view = await alarm.alarmView(env, await pay.reconcileStatus(env, NOW), NOW)
    expect(view.streak).toBe(1)
    expect(view.conditions).toContain('unknown_head_blocked')
  })

  it('the route body carries the alarm block', async () => {
    unknownRow({ network: null })
    const req = new Request('https://w.internal/pay/reconcile-status', { headers: { 'x-internal-key': KEY } })
    const res: Response = await new pay.PayReconcileStatusCall({ skipValidation: true }).handle(req, ENV())
    const body: any = await res.json()
    // The c53 contract is intact…
    expect(body.ok).toBe(true)
    expect(body.spend_sent.present).toBe(true)
    expect(body.settle_unknown.present).toBe(true)
    expect(typeof body.healthy).toBe('boolean')
    // …and the pager is visible on it.
    expect(body.alarm.configured).toBe(true)
    expect(body.alarm.conditions).toContain('unknown_head_blocked')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// State handling: a lost state costs a tick of delay, never a false page
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('parseAlarmState tolerates absence and garbage', () => {
  it('missing / unparseable / wrong-typed all become the empty state', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '3', JSON.stringify({ sig: 7, streak: 'x', notifiedAt: 'y' })]) {
      const s = alarm.parseAlarmState(raw)
      expect(s.sig).toBe('')
      expect(s.streak).toBe(0)
      expect(s.notifiedAt).toBe(0)
    }
  })

  it('round-trips a real state', () => {
    const s = { sig: 'a|b', streak: 3, notifiedSig: 'a|b', notifiedAt: NOW }
    expect(alarm.parseAlarmState(JSON.stringify(s))).toEqual(s)
  })

  it('a negative or fractional streak is clamped, not trusted', () => {
    expect(alarm.parseAlarmState(JSON.stringify({ streak: -5 })).streak).toBe(0)
    expect(alarm.parseAlarmState(JSON.stringify({ streak: 2.9 })).streak).toBe(2)
  })

  it('🔴 KV failure never fires an alarm, and never throws into the cron', async () => {
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV({ tiny: kvBinding({ getThrows: true }) })
    captureFetch()
    // Every tick starts from scratch → the streak never reaches 2 → silence.
    for (let i = 0; i < 5; i++) {
      const r = await tick(env, NOW + i * 60)
      expect(r).not.toBe(null)
      expect(r.fire).toBe(null)
    }
    expect(events()).toEqual([])
  })

  it('🔴 state is persisted BEFORE delivery', () => {
    // Two overlapping crons must not each send the same page, and a delivery that
    // half-fails must not re-page every minute afterwards (the sweepToolUpdates
    // rule). Source-level because the ordering is control flow.
    const src = code('reconcile-alarm.ts')
    const sweep = src.slice(src.indexOf('export async function sweepReconcileAlarm'))
    const put = sweep.indexOf('env.tiny.put(ALARM_KV_KEY')
    const deliver = sweep.indexOf('deliverAlarm(')
    expect(put).toBeGreaterThan(0)
    expect(deliver).toBeGreaterThan(put)
  })

  it('a put failure does not throw into the cron', async () => {
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV({ tiny: kvBinding({ putThrows: true }) })
    captureFetch()
    const r = await tick(env, NOW)
    expect(r).not.toBe(null)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Delivery: ring first, Telegram opportunistic, rails isolated
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('delivery', () => {
  const arm = async (env: any) => { await tick(env, NOW); return tick(env, NOW + 60) }

  it('lands on the ring with no bot configured at all', async () => {
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV()
    const calls = captureFetch()
    const r = await arm(env)
    expect(r.delivered).toBe(true)
    expect(events().length).toBe(1)
    expect(calls).toEqual([])            // no bot ⇒ no outbound anything
  })

  it('also reaches the operator`s own allowlisted Telegram chats', async () => {
    db.prepare("INSERT INTO telegram_bots (user_id, token, allowed_chats, enabled) VALUES (?, ?, ?, 1)")
      .run(OPS, 'bot-token-123', '111, 222')
    unknownRow({ network: null, created: NOW - 3600 })
    const env = ENV()
    const calls = captureFetch()
    await arm(env)
    const tgCalls = calls.filter(c => c.url.includes('api.telegram.org'))
    expect(tgCalls.length).toBe(2)
    expect(tgCalls.map(c => String(c.body.chat_id)).sort()).toEqual(['111', '222'])
    expect(tgCalls[0].url).toContain('/sendMessage')
    expect(String(tgCalls[0].body.text)).toContain('a money rail needs a human')
  })

  it('🔴 never sends to a chat the operator has not confirmed', async () => {
    // Pairing mode (empty allowlist) and a disabled bot both mean "no".
    db.prepare("INSERT INTO telegram_bots (user_id, token, allowed_chats, enabled) VALUES (?, ?, ?, 1)")
      .run(OPS, 'bot-token-123', '')
    unknownRow({ network: null, created: NOW - 3600 })
    const calls = captureFetch()
    await arm(ENV())
    expect(calls).toEqual([])
    expect(events().length).toBe(1)      // the ring still got it
  })

  it('a disabled bot is not used', async () => {
    db.prepare("INSERT INTO telegram_bots (user_id, token, allowed_chats, enabled) VALUES (?, ?, ?, 0)")
      .run(OPS, 'bot-token-123', '111')
    unknownRow({ network: null, created: NOW - 3600 })
    const calls = captureFetch()
    await arm(ENV())
    expect(calls).toEqual([])
  })

  it('🔴 a Telegram outage does not swallow the page already on the ring', async () => {
    db.prepare("INSERT INTO telegram_bots (user_id, token, allowed_chats, enabled) VALUES (?, ?, ?, 1)")
      .run(OPS, 'bot-token-123', '111')
    unknownRow({ network: null, created: NOW - 3600 })
    const orig = globalThis.fetch
    restoreFetch = () => { globalThis.fetch = orig }
    globalThis.fetch = (async () => { throw new Error('telegram down') }) as any
    const r = await arm(ENV())
    expect(r.delivered).toBe(true)
    expect(events().length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// The text: the actionable part must survive emitEvent's 300-char slice
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('formatAlarmText', () => {
  const conds = [
    { kind: 'unknown_head_blocked', detail: '3 of the next 5 settle_unknown rows will be skipped again' },
    { kind: 'sent_unresolvable', detail: '2 spend_sent reservation(s) have no identity to resolve' },
  ]
  const status = { spend_sent: { open: 4 }, settle_unknown: { open: 11, unpaid_micro: 3_500_000 } }

  it('names every condition kind in the ring line, within the slice', () => {
    const { short } = alarm.formatAlarmText('alert', conds, status)
    expect(short.length).toBeLessThanOrEqual(300)
    expect(short).toContain('unknown_head_blocked')
    expect(short).toContain('sent_unresolvable')
    expect(short).toContain('/pay/reconcile-status')
  })

  it('the long form carries every detail and the money owed', () => {
    const { full } = alarm.formatAlarmText('alert', conds, status)
    for (const c of conds) expect(full).toContain(c.detail)
    expect(full).toContain('$3.5000')
    // Depth appears as CONTEXT and never as a cause (rule 1).
    expect(full).toContain('settle_unknown open 11')
  })

  it('omits the money line when nothing resolvable is owed', () => {
    const { full } = alarm.formatAlarmText('alert', conds, { settle_unknown: { unpaid_micro: 0 } })
    expect(full).not.toContain('unpaid to creators')
  })

  it('survives a status body with nothing in it', () => {
    const { short, full } = alarm.formatAlarmText('alert', conds, null)
    expect(short).toContain('unknown_head_blocked')
    expect(full).toContain('open 0')
  })

  it('recovery is short and unambiguous', () => {
    const { short, full } = alarm.formatAlarmText('recovery', [], status)
    expect(short).toContain('clear again')
    expect(full).toBe(short)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 💸 c63 — THE RECOVERY THAT WAS FALSE
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('💸 a recovery must not retract a real loss', () => {
  /**
   * ⚠️ MEASURED, not reasoned. The sequence is entirely ordinary:
   *
   *   1. an owner raises their price after a payer's 402 was signed (c61)
   *   2. the pager alerts: `unknown_blocker:price raised above the credited amount`
   *   3. the sweep marks the row `split_underfunded` — CORRECTLY; it can never
   *      resolve itself, and leaving it open starved an oldest-first queue of 5
   *   4. two ticks later the pager delivered "✅ x402 reconciliation is clear
   *      again — no blocked rows in either queue"
   *
   * …with the owner's balance still 0 and the payer's USDC sitting on-chain at our
   * pay-to address. Every field `alarmConditions` reads had genuinely gone quiet,
   * because all of them describe the OPEN queue and the row had left it.
   *
   * The DECISION is right and is not touched here: nothing is blocked, so nothing
   * should page again (rule 1 — a terminal row cannot be fixed by any tick, so a
   * condition would fire forever and get the pager muted). What was wrong was the
   * CLAIM. "Clear again" invites an operator to close the ticket, so a retraction
   * that omits the money is worse than the silence it replaces.
   */
  const strandedStatus = (over: any = {}) => ({
    spend_sent: { present: true, open: 0, blocked_in_next_batch: 0, unresolvable: 0 },
    settle_unknown: {
      present: true, open: 0, blocked_in_next_batch: 0, blocked: 0, blocked_reasons: {},
      unpaid_micro: 0, stranded: 1, stranded_micro: 2_000_000, ...over,
    },
    ...WD_CLEAR,
  })

  it('the recovery message NAMES the money that reached no creator', () => {
    const { short, full } = alarm.formatAlarmText('recovery', [], strandedStatus())
    expect(short).toContain('clear again')       // still true: nothing is blocked
    expect(short).toContain('$2.0000')           // …and no longer the whole story
    expect(full).toContain('reached NO creator')
    expect(full).toContain('split_underfunded')
    expect(full).toContain('/pay/reconcile-status')
    // The ring slices at 300 chars, so the money must survive the slice.
    expect(short.length).toBeLessThanOrEqual(300)
  })

  it('a genuinely clean recovery is still the one short sentence', () => {
    // The direction that must NOT change. Appending a warning to every recovery
    // would be its own cry-wolf, and `full === short` is what the existing test
    // above pins for the clean case.
    const { short, full } = alarm.formatAlarmText('recovery', [], strandedStatus({ stranded: 0, stranded_micro: 0 }))
    expect(short).toContain('clear again')
    expect(short).not.toContain('reached NO creator')
    expect(full).toBe(short)
  })

  it('an ALERT carries it too — the money is context on both messages', () => {
    const conds = [{ kind: 'sent_unresolvable', detail: '2 reservations have no identity' }]
    const { full } = alarm.formatAlarmText('alert', conds, strandedStatus({ stranded: 2, stranded_micro: 7_500_000 }))
    expect(full).toContain('$7.5000')
    expect(full).toContain('reached NO creator')
    // …and it did not BECOME a condition (rule 1).
    expect(full).toContain(conds[0].detail)
  })

  it('🔴 and stranded rows still never PAGE — the decision is untouched', () => {
    // Load-bearing. If this ever became a condition it would fire on every tick
    // forever, because no sweep can clear a terminal row — and a muted pager is
    // the failure this module's whole design is arranged around.
    expect(alarm.alarmConditions(strandedStatus())).toEqual([])
    expect(alarm.alarmConditions(strandedStatus({ stranded: 9_999, stranded_micro: 1e12 }))).toEqual([])
  })

  it('the decision function reads NEITHER stranded field', () => {
    // The same source-level guard rule 1 already has for `open`/`unpaid_micro`: a
    // future edit adding these to the conditions would pass every behavioural
    // test above until someone actually had a stranded row.
    const src = code('reconcile-alarm.ts')
    const body = src.slice(src.indexOf('export function alarmConditions'), src.indexOf('export function alarmSignature'))
    expect(body).not.toContain('stranded')
    // Non-vacuity: the slice really is the function, and it does read the metric
    // rule 1 says it should.
    expect(body).toContain('blocked_in_next_batch')
  })

  it('END TO END: the alert, the sweep, and a recovery that tells the truth', async () => {
    // The measured sequence, driven through the real sweep and the real pager.
    db.prepare(`INSERT INTO settle_unknown
        (payer, nonce, tx_hash, slug, price_micro, value_micro, network, pay_to, valid_before, created)
        VALUES (?, ?, ?, ?, ?, ?, 'tiny', ?, ?, ?)`)
      .run(PAYER.toLowerCase(), '0x' + 'cd'.repeat(32), TXH.toLowerCase(), SLUG, PRICE, PRICE,
        '0x' + '22'.repeat(20), NOW - 60, NOW - 300)
    db.prepare('UPDATE prices SET price_micro = ? WHERE resource = ?').run(PRICE * 4, `tiny:${SLUG}`)

    // The chain says the transfer HAPPENED — that is what makes this a loss.
    const USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
    const topicFor = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const orig = globalThis.fetch
    restoreFetch = () => { globalThis.fetch = orig }
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).startsWith('https://api.telegram.org/')) {
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      }
      const b = JSON.parse(String(init?.body || '{}'))
      const result = b.method === 'eth_blockNumber' ? '0x7a120' : [{
        address: USDC, topics: [USED_TOPIC, topicFor(PAYER), '0x' + 'cd'.repeat(32)],
        data: '0x', transactionHash: TXH.toLowerCase(),
      }]
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
    }) as any

    const env = ENV()
    expect((await tick(env, NOW)).fire).toBe(null)               // one tick is never a page
    expect((await tick(env, NOW + 60)).fire).toBe('alert')        // …two is
    expect(events().length).toBe(1)
    expect(events()[0].detail).toContain('price raised above the credited amount')

    // The sweep now retires the row — correctly, and the creator stays unpaid.
    const out = await pay.reconcileSettleUnknown(env, NOW + 120)
    expect(out.credited).toBe(0)
    expect(db.prepare("SELECT resolution FROM settle_unknown").get().resolution).toBe('split_underfunded')
    expect(db.prepare("SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?").get(OWNER).v).toBe(0)

    // …and the recovery that follows must not say the coast is clear and stop.
    expect((await tick(env, NOW + 60 * 60)).fire).toBe(null)
    expect((await tick(env, NOW + 61 * 60)).fire).toBe('recovery')
    const last = events()[events().length - 1]
    expect(last.detail).toContain('clear again')
    expect(last.detail).toContain('reached NO creator')
    expect(last.detail).toContain('$2.0000')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// The cron is the spec — wiring properties that live in index.ts
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('the cron is the spec', () => {
  const idx = () => code('index.ts')

  it('the alarm runs on the per-minute scheduled handler', () => {
    expect(idx()).toContain('sweepReconcileAlarm(env')
    expect(code('reconcile-alarm.ts')).toContain('export async function sweepReconcileAlarm')
  })

  it('🔴 it runs AFTER both reconcilers, not beside them', () => {
    // Reading the queues first would page about rows the same tick was about to
    // retire — a page for work in progress, which is the fastest way to get muted.
    const src = idx()
    expect(src).toContain('Promise.all([sentSpends, settleUnknown])')
    // ⚠️ Anchor to the CALL, not the identifier: `indexOf` would otherwise find
    // the import line at the top of the file and this ordering check would pass
    // for any wiring at all.
    const alarmAt = src.indexOf('sweepReconcileAlarm(env')
    expect(alarmAt).toBeGreaterThan(0)
    expect(src.indexOf('const settleUnknown = reconcileSettleUnknown')).toBeLessThan(alarmAt)
    expect(src.indexOf('const sentSpends = reconcileSentSpends')).toBeLessThan(alarmAt)
  })

  it('🔴 it can never take down job dispatch or either sweep', () => {
    const src = idx()
    const clause = src.slice(src.indexOf('Promise.all([sentSpends, settleUnknown])'))
    expect(clause.slice(0, 400)).toContain('.catch(')
    // Both reconcilers keep their own catch — the alarm's await must not make an
    // upstream rejection the alarm's problem, or a sweep failure kills the page
    // about that very failure.
    expect(src).toContain('console.log(err, "reconcileSentSpends")')
    expect(src).toContain('console.log(err, "reconcileSettleUnknown")')
  })

  it('the sweep returns null rather than throwing, on any internal failure', async () => {
    const broken = { ...ENV(), DB: { prepare() { throw new Error('d1 gone') } } }
    const r = await alarm.sweepReconcileAlarm(broken, NOW)
    // A D1 that cannot be read at all: the status reader reports both queues
    // unreadable (itself a condition), so this must still be a decision, not a
    // crash. Either shape is acceptable; a throw is not.
    expect(r === null || typeof r === 'object').toBe(true)
  })

  it('wrangler.toml documents the destination var without setting it empty', () => {
    const toml = readFileSync(join(WORKER_SRC, '..', 'wrangler.toml'), 'utf8')
    expect(toml).toContain('RECONCILE_ALARM_USER')
    // ⚠️ An empty assignment would be a var that EXISTS and is falsy — the same
    // silent off switch, but now invisible to the `configured: false` report in
    // one env while set in the other.
    expect(toml).not.toMatch(/^RECONCILE_ALARM_USER\s*=/m)
  })
})
