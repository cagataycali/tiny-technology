// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { iconFor, EMITTED_KINDS, KIND_ICONS } from '../lib/chat/event-icons'

/**
 * 💻 THE TASK THAT NEVER REACHED THE DEVICE.
 *
 * `use_device` waits 45s, then hands the agent a claim ticket whose note says,
 * verbatim: *"The task was delivered; fetch the outcome with use_device
 * action:'result' … later in this conversation"*. But `delivered` flips in
 * exactly ONE place — RELAY_MARK_SQL, inside RelayPollCall, which only the
 * DEVICE calls. Send-time cannot catch a device that is away, because
 * RELAY_TARGET_CHECK_SQL gates on (id, owner, revoked) and deliberately NOT on
 * presence: a mailbox whose whole point is that the device can be asleep.
 *
 * So for a device that never polls again, the sequence was:
 *   - the agent is told the task was DELIVERED,
 *   - RELAY_SWEEP_SQL DELETEs the envelope an hour later (a bare
 *     `created_at < ?`, on the write path, best-effort),
 *   - redeeming the promised ticket finds nothing and answers *"No result yet —
 *     the task may still be running"*,
 *   - and nothing ever emits, pushes, or logs a word about it.
 *
 * Every sentence the user could see described work in progress. The work never
 * started, and the evidence was gone.
 *
 * The rail: at EXPIRY (not at send — see above), report once per owner and reap
 * what was reported. Pinned below, each with its own case:
 *   1. the end-to-end regression, driven through the real sweep;
 *   2. ONLY invokes — notify banners are push fan-out with no waiter, and
 *      reporting them would be a notification about an undelivered notification
 *      (a feedback loop); replies (to_device = '') are delivered = 0 by
 *      construction, so counting them would report answered tasks as lost;
 *   3. NEVER before the window — an undelivered row inside SWEEP_AGE_S is a
 *      laptop that hasn't polled for a few seconds, i.e. the healthy state;
 *   4. reporting is idempotent BECAUSE it reaps (there is no `reported` column);
 *   5. the write-path sweep must not destroy the evidence first;
 *   6. the glyph cannot inherit 💻 ("your laptop finished") on any surface.
 */
warnIfWorkerAbsent('relay-missed')

let relay: any, sweepMissedTasks: any
let db: any

const NOW = 1_800_000_000
const HOUR = 3600

beforeAll(async () => {
  if (!present) return
  relay = await import(workerFile('relay.ts') /* @vite-ignore */)
  sweepMissedTasks = (await import(workerFile('relay-missed.ts') /* @vite-ignore */)).sweepMissedTasks
})

/** node:sqlite binds `?N` as NAMED params; D1's .bind() is positional. */
const d1 = () => ({
  prepare(sql: string) {
    const binds: any[] = []
    const args = () => {
      const clean = binds.map(b => (b === undefined ? null : b))
      if (!/\?\d/.test(sql)) return clean
      const named: any = {}
      clean.forEach((v, i) => { named[String(i + 1)] = v })
      return [named]
    }
    const stmt: any = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() {
        const r = db.prepare(sql).run(...args())
        return { meta: { changes: Number(r.changes || 0) } }
      },
      async first() { return db.prepare(sql).get(...args()) ?? null },
      async all() { return { results: db.prepare(sql).all(...args()) } },
    }
    return stmt
  },
})

let events: Array<{ userId: string; kind: string; detail: string }>
let pushes: Array<{ userId: string; payload: any }>

const makeEnv = () => ({
  DB: d1(),
  // The rail's two output surfaces. Recording them (rather than stubbing the
  // modules) keeps the assertions about what the USER receives.
  __events: events,
  __pushes: pushes,
})

/** Insert an envelope through the REAL insert statement. */
const send = (id: string, opts: Partial<{
  user: string; toDevice: string; payload: any; ageS: number; delivered: number; replyTo: string | null
}> = {}) => {
  const {
    user = 'u1', toDevice = 'd1', payload = { type: 'invoke', prompt: 'deploy the worker' },
    ageS = 2 * HOUR, delivered = 0, replyTo = null,
  } = opts
  db.prepare(relay.RELAY_INSERT_SQL.replace(/\?(\d)/g, '?')).run(
    id, user, toDevice, replyTo,
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    NOW - ageS,
  )
  if (delivered) db.prepare(`UPDATE relay_messages SET delivered = 1 WHERE id = ?`).run(id)
}

const rows = () => db.prepare(`SELECT id FROM relay_messages ORDER BY id`).all().map((r: any) => r.id)

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // REAL migrations, not hand-written approximations: `push_subscriptions` is
  // the table sendPushToUser reads, and a test that invents `push_subs` instead
  // makes the push path throw — which then passes as "push failed gracefully"
  // while never exercising a push at all.
  const mig = (n: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', n), 'utf8')
  db.exec(mig('0014_relay.sql'))
  db.exec(mig('0006_background.sql'))   // push_subscriptions + events
  db.exec(mig('0013_devices.sql'))      // devices (relayPushToDevices' presence gate)
  events = []
  pushes = []
})

/**
 * Run the real sweep. `emitEvent` and `sendPushToUser` both hit the DB we just
 * built (events / push_subs / devices are all present), so this exercises the
 * real modules rather than a mock of them — and the assertions read the tables.
 */
const sweep = (env: any, now = NOW) => sweepMissedTasks(env, now)

const emitted = () =>
  db.prepare(`SELECT user_id, kind, detail FROM events ORDER BY id`).all()

describe.skipIf(!present)('the task that never reached the device', () => {
  it('THE REGRESSION: an invoke no device polled is reported, once, before it is destroyed', async () => {
    const env = makeEnv()
    send('env-1', { payload: { type: 'invoke', prompt: 'deploy the worker to production' } })

    // Precondition — this is the state the old code deleted in silence.
    expect(db.prepare(`SELECT delivered FROM relay_messages WHERE id='env-1'`).get().delivered).toBe(0)

    const res = await sweep(env)
    expect(res).toMatchObject({ users: 1, envelopes: 1 })

    const ev = emitted()
    expect(ev).toHaveLength(1)
    expect(ev[0].kind).toBe(relay.MISSED_KIND)
    expect(ev[0].user_id).toBe('u1')
    // RENDER the detail the user actually reads: it must name the lost task and
    // must NOT claim the thing the old tool note claimed.
    expect(ev[0].detail).toContain('deploy the worker to production')
    expect(ev[0].detail.toLowerCase()).toContain('never delivered')
    // It must carry ITS OWN glyph, not the one for a task that finished.
    expect(ev[0].detail).toContain('🚫')
    expect(ev[0].detail).not.toContain('💻')

    // …and the evidence is reaped in the same breath, so it cannot double-report.
    expect(rows()).toEqual([])
  })

  it('the report does not say "failed" — the task never ran, there is nothing to inspect', async () => {
    // A user told a task FAILED goes looking for a result and an error. There is
    // neither: it was never started. The wording has to send them to the one
    // action that helps (ask again once the device is online).
    const env = makeEnv()
    send('env-1')
    await sweep(env)
    const { title, body } = relay.missedText(
      relay.missedReports([{ id: 'x', user_id: 'u1', payload: JSON.stringify({ type: 'invoke', prompt: 'ship it' }), created_at: NOW - 2 * HOUR }])[0]
    )
    expect(`${title} ${body}`.toLowerCase()).not.toContain('fail')
    expect(body.toLowerCase()).toContain('never picked it up')
    expect(body.toLowerCase()).toContain('not run')
    expect(body).toContain("use_device action:'list'")
  })

  it('several lost tasks for one owner are ONE report that counts them', async () => {
    const env = makeEnv()
    send('env-1', { payload: { type: 'invoke', prompt: 'first thing' }, ageS: 3 * HOUR })
    send('env-2', { payload: { type: 'invoke', prompt: 'second thing' }, ageS: 2 * HOUR })
    send('env-3', { payload: { type: 'invoke', prompt: 'third thing' }, ageS: 2 * HOUR })

    const res = await sweep(env)
    expect(res).toMatchObject({ users: 1, envelopes: 3 })
    expect(emitted()).toHaveLength(1)
    // The OLDEST is the one quoted: it is the one the user is least likely to
    // still have on screen. Rows arrive created_at ASC, so it is the first seen.
    expect(emitted()[0].detail).toContain('first thing')
    expect(emitted()[0].detail).toContain('+2 more')
  })

  it('is per-owner: two users get their own report, each naming their own task', async () => {
    const env = makeEnv()
    send('a', { user: 'u1', payload: { type: 'invoke', prompt: 'u1 secret task' } })
    send('b', { user: 'u2', toDevice: 'd2', payload: { type: 'invoke', prompt: 'u2 secret task' } })

    const res = await sweep(env)
    expect(res).toMatchObject({ users: 2, envelopes: 2 })
    const ev = emitted()
    const byUser = Object.fromEntries(ev.map((e: any) => [e.user_id, e.detail]))
    expect(byUser.u1).toContain('u1 secret task')
    expect(byUser.u1).not.toContain('u2 secret task')   // no cross-owner leak
    expect(byUser.u2).toContain('u2 secret task')
    expect(byUser.u2).not.toContain('u1 secret task')
  })
})

describe.skipIf(!present)('rule 1 — only invoke envelopes', () => {
  it('a notify banner is NOT a lost task (no waiter, and reporting it would loop)', async () => {
    // push.ts relayPushToDevices writes one {type:'notify'} envelope per fresh
    // device for EVERY push — including the push this rail itself sends. A
    // device that went away mid-window leaves those undelivered forever. Report
    // them and the rail feeds itself.
    const env = makeEnv()
    send('n-1', { payload: { type: 'notify', title: 'you were paid', body: '$3' } })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
    // Still reaped — it is past the window and re-scanning it every tick forever
    // would starve real invokes out of the LIMIT.
    expect(rows()).toEqual([])
  })

  it('a REPLY is not a lost task, even though it is delivered = 0 by construction', async () => {
    // to_device = '' means "addressed to the user". Replies are NEVER marked
    // delivered — RELAY_MARK_SQL runs only in RelayPollCall, and recv does not
    // flip anything — so every reply in the table looks exactly like an
    // undelivered envelope. Counting them would report every ANSWERED task as a
    // lost one: the exact inverse error, and the loudest possible false alarm.
    //
    // ⚠️ The payload here is `type:'invoke'` ON PURPOSE. RelayReplyCall accepts
    // ANY valid JSON from the device (sanitizeRelayPayload checks syntax and
    // size, not shape), so a device that echoes the request back — or is simply
    // buggy — produces a reply row that the invoke check alone cannot reject. A
    // `type:'result'` payload here would be excluded by rule (1) instead, and
    // this test would pass with the address clause deleted.
    const env = makeEnv()
    send('r-1', {
      toDevice: '', replyTo: 'env-1',
      payload: { type: 'invoke', prompt: 'echoed back by the device' },
    })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
  })

  it('an ANSWERED task is never reported as lost — the whole exchange, aged out', async () => {
    // End-to-end version of the same trap: the device polled the invoke (so it
    // is delivered) and replied (so a to_device='' row exists, delivered = 0
    // forever). Both rows are past the window. Neither is a lost task.
    const env = makeEnv()
    send('env-1', { delivered: 1, payload: { type: 'invoke', prompt: 'ran fine' } })
    send('rep-1', { toDevice: '', replyTo: 'env-1', payload: { type: 'invoke', result: 'done' } })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
  })

  it('an unparseable payload is not provably an invoke, so it is not news', async () => {
    const env = makeEnv()
    send('bad', { payload: 'not json at all' })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
  })

  it('the type test is NOT a SQL LIKE — a PROMPT cannot forge its envelope class', async () => {
    // `payload LIKE '%"type":"invoke"%'` would let the text of a notify banner
    // (or any future envelope type) claim to be an invoke. The class is not the
    // caller's to declare, so it is parsed, not pattern-matched.
    const env = makeEnv()
    send('forge', {
      payload: { type: 'notify', title: 'heads up', body: 'contains "type":"invoke" verbatim' },
    })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
    // And the statement itself must not carry the shortcut.
    expect(relay.RELAY_UNDELIVERED_SQL).not.toContain('LIKE')
    expect(relay.RELAY_UNDELIVERED_SQL).not.toContain('invoke')
  })

  it('a delivered invoke is never reported — the device did its job', async () => {
    const env = makeEnv()
    send('done', { delivered: 1 })
    const res = await sweep(env)
    expect(res.envelopes).toBe(0)
    expect(emitted()).toEqual([])
  })
})

describe.skipIf(!present)('rule 2 — never before the window', () => {
  it('an undelivered invoke INSIDE the window is the healthy state, and is left alone', async () => {
    // A laptop that hasn't polled for 30s. Reporting this would mean crying lost
    // for every task in flight.
    const env = makeEnv()
    send('fresh', { ageS: 30 })
    const res = await sweep(env)
    expect(res).toMatchObject({ users: 0, envelopes: 0 })
    expect(emitted()).toEqual([])
    expect(rows()).toEqual(['fresh'])   // and NOT reaped
  })

  it('the cutoff is the sweep\'s own age, so the two can never disagree', async () => {
    // Only a row the sweep is entitled to delete is provably terminal. Sharing
    // the constant is what makes that true by construction rather than by
    // two numbers that happen to match today.
    const env = makeEnv()
    expect(relay.RELAY_SWEEP_AGE_S).toBe(3600)
    // Just inside → silent; just outside → reported.
    send('inside', { ageS: relay.RELAY_SWEEP_AGE_S - 5 })
    expect((await sweep(env)).envelopes).toBe(0)
    send('outside', { ageS: relay.RELAY_SWEEP_AGE_S + 5 })
    expect((await sweep(env)).envelopes).toBe(1)
  })
})

describe.skipIf(!present)('reporting is idempotent because it reaps', () => {
  it('a second tick says nothing — the row did not survive being reported', async () => {
    const env = makeEnv()
    send('env-1')
    expect((await sweep(env)).envelopes).toBe(1)
    expect(emitted()).toHaveLength(1)

    // The push the user gets is the thing that must not repeat every minute.
    expect((await sweep(env, NOW + 60)).envelopes).toBe(0)
    expect((await sweep(env, NOW + 120)).envelopes).toBe(0)
    expect(emitted()).toHaveLength(1)
  })

  it('the reap is scoped BY ID, so a row past the scan LIMIT is never destroyed unreported', async () => {
    // This is the whole bug wearing a bound: a blind `created_at < ?` delete
    // after a LIMITed read would silently lose the overflow. Assert the
    // statement is id-scoped and that overflow SURVIVES to the next tick.
    const env = makeEnv()
    expect(relay.relayDeleteByIdsSql(2)).toContain('id IN (?1, ?2)')
    expect(relay.relayDeleteByIdsSql(2)).not.toContain('created_at')

    const N = relay.UNDELIVERED_SCAN_MAX
    for (let i = 0; i < N + 3; i++) {
      send(`e${String(i).padStart(4, '0')}`, {
        user: `u${i}`, payload: { type: 'invoke', prompt: `task ${i}` }, ageS: 2 * HOUR - i,
      })
    }
    const first = await sweep(env)
    expect(first.scanned).toBe(N)
    expect(first.reaped).toBe(N)
    expect(rows()).toHaveLength(3)          // survived, unreported

    const second = await sweep(env, NOW + 60)
    expect(second.envelopes).toBe(3)        // …and reported on the next tick
    expect(rows()).toEqual([])
    // Nobody was skipped: every owner heard exactly once.
    expect(emitted()).toHaveLength(N + 3)
  })
})

describe.skipIf(!present)('the write-path sweep must not destroy the evidence first', () => {
  it('RELAY_SWEEP_SQL spares undelivered device envelopes, so the cron can still see them', () => {
    // `sweep()` runs on every relay SEND — precisely when an active device is
    // around. A blind delete there reaps lost tasks between cron ticks, and does
    // it most for the busiest users: the rail would look fine and fire least for
    // the people with the most at stake.
    const P = (s: string) => s.replace(/\?(\d)/g, '?')
    send('lost', { ageS: 2 * HOUR })                       // undelivered invoke
    send('done', { ageS: 2 * HOUR, delivered: 1 })         // delivered
    send('reply', { ageS: 2 * HOUR, toDevice: '', replyTo: 'x' })
    db.prepare(P(relay.RELAY_SWEEP_SQL)).run(NOW - relay.RELAY_SWEEP_AGE_S, NOW - relay.RELAY_HARD_AGE_S)
    expect(rows()).toEqual(['lost'])                       // the others are gone
  })

  it('but a hard backstop still bounds the table if the cron never runs', () => {
    // Unbounded growth is not an acceptable price for a notification. If the
    // reporting tick is broken/undeployed, a day-old row goes regardless.
    const P = (s: string) => s.replace(/\?(\d)/g, '?')
    expect(relay.RELAY_HARD_AGE_S).toBeGreaterThan(relay.RELAY_SWEEP_AGE_S)
    send('ancient', { ageS: relay.RELAY_HARD_AGE_S + HOUR })
    db.prepare(P(relay.RELAY_SWEEP_SQL)).run(NOW - relay.RELAY_SWEEP_AGE_S, NOW - relay.RELAY_HARD_AGE_S)
    expect(rows()).toEqual([])
  })
})

describe.skipIf(!present)('the sweep never throws — it shares a tick with job dispatch', () => {
  it('a DB failure returns zeros instead of taking down the cron', async () => {
    const env = { DB: { prepare() { throw new Error('D1 down') } } }
    await expect(sweep(env)).resolves.toMatchObject({ users: 0, envelopes: 0 })
  })

  it('the EVENT is written BEFORE the push, and survives a push that dies hard', async () => {
    // Ordering, pinned by observation rather than by hope. `sendPushToUser` has
    // a blanket try/catch, so the only way it throws is before that — and the
    // point of the ordering plus the per-call try/catch is that ANY future push
    // failure cannot cost the user the event. The ring is what every client
    // polls and what the next turn's system prompt carries; the push is a
    // best-effort banner on top.
    const env: any = makeEnv()
    send('env-1')
    const order: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => {
      if (/INSERT INTO events/i.test(sql)) order.push('event')
      // Kill the push the way an unguarded gap would: throw out of prepare on
      // the FIRST thing sendPushToUser touches (the notify fan-out's device
      // lookup), before its own catch can see it.
      if (/FROM devices/i.test(sql)) { order.push('push'); throw new Error('push path died') }
      return realPrepare(sql)
    }
    const res = await sweep(env)
    expect(res.envelopes).toBe(1)
    // The event exists…
    expect(emitted()).toHaveLength(1)
    // …and it was written FIRST. With the order reversed, 'push' comes first and
    // (unguarded) the event is never written at all.
    expect(order[0]).toBe('event')
    expect(order).toContain('push')
  })
})

describe.skipIf(!present)('the rail does not feed itself', () => {
  it('its OWN push writes notify envelopes that a later tick must never report', async () => {
    // THE FEEDBACK LOOP, driven for real. sendPushToUser also relays a
    // {type:'notify'} envelope to every heartbeating device (push.ts
    // relayPushToDevices). So reporting a lost task WRITES new undelivered rows
    // addressed to a device. If rule (1) were wrong, the next tick past the
    // window would report those as lost tasks, push again, and never stop.
    const env = makeEnv()
    // A device that IS fresh, so relayPushToDevices actually writes.
    db.prepare(`INSERT INTO devices (id,user_id,name,kind,token_hash,last_seen,revoked)
                VALUES ('d1','u1','laptop','daemon','deadbeef',?,0)`).run(NOW)
    send('env-1', { payload: { type: 'invoke', prompt: 'the lost task' } })

    expect((await sweep(env)).envelopes).toBe(1)
    // The rail's own push really did land a notify envelope in the same table.
    const spawned = db.prepare(
      `SELECT id, payload FROM relay_messages WHERE delivered = 0 AND to_device != ''`
    ).all()
    expect(spawned.length).toBeGreaterThan(0)
    expect(JSON.parse(spawned[0].payload).type).toBe('notify')

    // Age those envelopes past the window and tick again: silence, and exactly
    // one report ever existed.
    db.prepare(`UPDATE relay_messages SET created_at = ?`).run(NOW - 2 * HOUR)
    expect((await sweep(env, NOW + 60)).envelopes).toBe(0)
    expect(emitted()).toHaveLength(1)
  })

  it('a real subscriber receives the push (the surface is not silently dead)', async () => {
    const env = makeEnv()
    db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, keys_json)
                VALUES ('https://push.example/x','u1','{}')`).run()
    send('env-1')
    // VAPID keys are unconfigured here, so no HTTP send happens — but the
    // subscriber row IS read, which is what proves the call reached the real
    // push path instead of throwing on a table this test invented.
    const res = await sweep(env)
    expect(res.envelopes).toBe(1)
    expect(emitted()).toHaveLength(1)
  })
})

describe.skipIf(!present)('missedReports — the pure decision', () => {
  it('a missing created_at is null, not epoch 0', () => {
    // `|| 0` would date every undatable row to 1970, which reads as "lost 56
    // years ago" — buildLateReplyEvent's rule.
    const [r] = relay.missedReports([
      { id: 'x', user_id: 'u1', payload: JSON.stringify({ type: 'invoke', prompt: 'p' }), created_at: null },
    ])
    expect(r.oldestAt).toBeNull()
  })

  it('a row with no owner is skipped rather than reported to ""', () => {
    expect(relay.missedReports([
      { id: 'x', user_id: '', payload: JSON.stringify({ type: 'invoke', prompt: 'p' }), created_at: 1 },
    ])).toEqual([])
  })

  it('null/undefined rows are handled', () => {
    expect(relay.missedReports(null)).toEqual([])
    expect(relay.missedReports(undefined)).toEqual([])
    expect(relay.missedReports([])).toEqual([])
  })

  it('a promptless invoke reports the loss without a quote', () => {
    const [r] = relay.missedReports([
      { id: 'x', user_id: 'u1', payload: JSON.stringify({ type: 'invoke' }), created_at: 1 },
    ])
    expect(r.ask).toBe('')
    const { body } = relay.missedText(r)
    expect(body).not.toContain('""')            // no empty quotes rendered
    expect(body.toLowerCase()).toContain('never picked it up')
  })

  it('a long or multi-line prompt is clamped and flattened for a notification', () => {
    const [r] = relay.missedReports([{
      id: 'x', user_id: 'u1', created_at: 1,
      payload: JSON.stringify({ type: 'invoke', prompt: 'line one\n\nline two ' + 'x'.repeat(300) }),
    }])
    expect(r.ask.length).toBeLessThanOrEqual(90)
    expect(r.ask).not.toContain('\n')
    expect(r.ask.startsWith('line one line two')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// The cron is the spec — wiring that lives in index.ts
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!present)('the cron is the spec', () => {
  const code = (f: string) =>
    readFileSync(join(WORKER_SRC, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the sweep actually runs on the per-minute scheduled handler', () => {
    // Everything else in this file tests a function. Without this, the whole
    // rail can be perfect and never execute — inert code that reports nothing,
    // which is the exact failure mode this cycle exists to fix. Anchored to the
    // CALL, not the identifier: matching the bare name would also match the
    // import line and pass for any wiring at all.
    const idx = code('index.ts')
    expect(idx.length).toBeGreaterThan(500)          // non-vacuity after stripping
    expect(idx).toContain('sweepMissedTasks(env')
    expect(code('relay-missed.ts')).toContain('export async function sweepMissedTasks')
  })

  it('it is registered with waitUntil — a floating promise may be cancelled', () => {
    // The relay's own sweep() carries this warning already: a promise not
    // registered with waitUntil can be killed when the response returns, so the
    // report would silently never run on some ticks.
    expect(code('index.ts')).toContain('ctx.waitUntil(sweepMissedTasks(env')
  })

  it('the reporting cutoff is the relay retention window, not a second opinion', () => {
    // Two constants that must agree cannot be two constants.
    const missed = code('relay-missed.ts')
    expect(missed).toContain('RELAY_SWEEP_AGE_S')
    expect(missed).not.toMatch(/nowSec\s*-\s*\d+/)   // no hand-rolled age
  })
})

describe('the glyph cannot mean "your laptop finished"', () => {
  it('device_missed is on the roster and keyed IN FULL, not inheriting device 💻', () => {
    expect(EMITTED_KINDS).toContain('device_missed')
    expect(iconFor('device_missed')).toBe('🚫')
    // The collision this guards: `device` IS a prefix of `device_missed`.
    expect(iconFor('device_result')).toBe('💻')
    expect(iconFor('device_missed')).not.toBe(iconFor('device_result'))
    expect(KIND_ICONS.device_missed).toBe('🚫')
  })

  it('the agent prompt distinguishes them too, and neither falls back to ℹ', async () => {
    const src = readFileSync(join(process.cwd(), 'lib/chat/prompt.ts'), 'utf8')
    const table = src.slice(src.indexOf('const EVENT_ICONS'), src.indexOf('export function buildSoulPrompt'))
    expect(table).toContain('device_missed')
    expect(table).toMatch(/device_missed:\s*'🚫'/)
    expect(table).toMatch(/device_result:\s*'💻'/)
  })

  it('all four surfaces carry the kind — web, prompt, iOS, Android', () => {
    // The roster rule: a new kind lands its glyph on every surface in the SAME
    // commit, or one client renders the highest-signal event as noise.
    //
    // ⚠️ Asserted against the TABLE and ROSTER regions, not the whole file. Both
    // mobile files DOCUMENT this collision in a docblock that names
    // `device_missed` and 🚫 — so a whole-file `toContain` passes with the icon
    // entry deleted, and the comment explaining the rule is what hides its
    // absence. Strip comments, then read the two declarations.
    const root = join(process.cwd(), '..')
    const decls = [
      {
        file: 'ios/Tiny/Sources/Activity.swift',
        icons: [/static let icons[\s\S]*?\n    \]/, /\("device_missed", "🚫"\)/],
        roster: [/static let emittedKinds[\s\S]*?\n    \]/, /"device_missed"/],
      },
      {
        file: 'android/app/src/main/java/technology/tiny/app/ui/Activity.kt',
        icons: [/val KIND_ICONS = listOf\([\s\S]*?\n\)/, /"device_missed" to "🚫"/],
        roster: [/val EMITTED_KINDS = listOf\([\s\S]*?\n\)/, /"device_missed"/],
      },
    ] as const
    for (const d of decls) {
      const body = readFileSync(join(root, d.file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*(\/\/\/?|\*).*$/gm, '')
      for (const [region, needle] of [d.icons, d.roster]) {
        const found = body.match(region as RegExp)?.[0]
        expect(found, `${d.file}: declaration not found — did it move?`).toBeTruthy()
        expect(found!, `${d.file}: ${needle}`).toMatch(needle as RegExp)
      }
    }
  })
})
