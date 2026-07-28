// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('relay-sql')

/**
 * Worker relay statements (RELAY_*_SQL) against real sqlite — pins the
 * PR6 security invariants:
 *   - device auth: (id, token_hash, revoked=0) — revoked device can't poll/reply
 *   - send targets only the owner's devices
 *   - reply must reference a same-user envelope (no cross-user injection)
 *   - recv scoped to (in_reply_to, user_id)
 *   - poll only returns undelivered; mark flips delivered
 */
let SQL: any
let hashDeviceToken: (t: string) => Promise<string>
let sanitizeRelayPayload: (raw: unknown) => string | null
let db: any

beforeAll(async () => {
  if (!present) return
  const relay = await import(workerFile('relay.ts') /* @vite-ignore */)
  const devices = await import(workerFile('devices.ts') /* @vite-ignore */)
  SQL = relay
  sanitizeRelayPayload = relay.sanitizeRelayPayload
  hashDeviceToken = devices.hashDeviceToken
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0
    );
    CREATE TABLE relay_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_device TEXT NOT NULL,
      in_reply_to TEXT, payload TEXT NOT NULL, created_at INTEGER,
      delivered INTEGER DEFAULT 0
    );
  `)
})

const run = (sql: string, params: Record<number, any>) => db.prepare(sql).run(params)
const all = (sql: string, params: Record<number, any>) => db.prepare(sql).all(params)
const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)

const skip = () => !present

describe.skipIf(skip())('relay SQL invariants', () => {
  it('device auth honors token hash + revoked', async () => {
    const hash = await hashDeviceToken('tind_secret')
    db.prepare(`INSERT INTO devices (id, user_id, name, token_hash, revoked) VALUES ('d1','u1','laptop',?,0)`).run(hash)
    db.prepare(`INSERT INTO devices (id, user_id, name, token_hash, revoked) VALUES ('d2','u1','old',?,1)`).run(hash)

    const ok = first(SQL.RELAY_DEVICE_AUTH_SQL, { 1: 'd1', 2: hash })
    expect(ok?.user_id).toBe('u1')
    const revoked = first(SQL.RELAY_DEVICE_AUTH_SQL, { 1: 'd2', 2: hash })
    expect(revoked).toBeUndefined()
    const wrongToken = first(SQL.RELAY_DEVICE_AUTH_SQL, { 1: 'd1', 2: await hashDeviceToken('tind_wrong') })
    expect(wrongToken).toBeUndefined()
  })

  it('send target check is owner-scoped', () => {
    expect(first(SQL.RELAY_TARGET_CHECK_SQL, { 1: 'd1', 2: 'u1' })?.id).toBe('d1')
    expect(first(SQL.RELAY_TARGET_CHECK_SQL, { 1: 'd1', 2: 'u2' })).toBeUndefined()   // not your device
    expect(first(SQL.RELAY_TARGET_CHECK_SQL, { 1: 'd2', 2: 'u1' })).toBeUndefined()   // revoked
  })

  it('poll returns undelivered only; mark flips delivered', () => {
    const now = Math.floor(Date.now() / 1000)
    run(SQL.RELAY_INSERT_SQL, { 1: 'e1', 2: 'u1', 3: 'd1', 4: null, 5: '{"type":"invoke","prompt":"hi"}', 6: now })
    let rows = all(SQL.RELAY_POLL_SQL, { 1: 'd1', 2: 10 })
    expect(rows).toHaveLength(1)
    run(SQL.RELAY_MARK_SQL, { 1: 'e1' })
    rows = all(SQL.RELAY_POLL_SQL, { 1: 'd1', 2: 10 })
    expect(rows).toHaveLength(0)
  })

  it('reply lookup + recv are user-scoped (no cross-user injection)', () => {
    const now = Math.floor(Date.now() / 1000)
    // reply row addressed to the user (to_device='')
    run(SQL.RELAY_INSERT_SQL, { 1: 'r1', 2: 'u1', 3: '', 4: 'e1', 5: '{"result":"42"}', 6: now })
    // envelope owner check
    expect(first(SQL.RELAY_ENVELOPE_SQL, { 1: 'e1' })?.user_id).toBe('u1')
    // recv finds the reply for the right user…
    expect(JSON.parse(first(SQL.RELAY_RECV_SQL, { 1: 'e1', 2: 'u1' }).payload).result).toBe('42')
    // …and NOT for another user
    expect(first(SQL.RELAY_RECV_SQL, { 1: 'e1', 2: 'u2' })).toBeUndefined()
  })

  it('sweep removes old rows only — but SPARES undelivered device envelopes', () => {
    // ⚠️ The write-path sweep no longer reaps everything past the window. A row
    // that is still `delivered = 0` and addressed to a device is the evidence
    // that a task never reached its device, and `sweepMissedTasks` (relay-missed.ts,
    // per-minute cron) has to see it before it is destroyed — this sweep runs on
    // every SEND, i.e. exactly when an active device is around, so reaping here
    // would delete the evidence between ticks. See tests/relay-missed.test.ts.
    const now = Math.floor(Date.now() / 1000)
    const old = now - 7200
    run(SQL.RELAY_INSERT_SQL, { 1: 'stale', 2: 'u1', 3: 'd1', 4: null, 5: '{}', 6: old })
    run(SQL.RELAY_INSERT_SQL, { 1: 'done', 2: 'u1', 3: 'd1', 4: null, 5: '{}', 6: old })
    run(SQL.RELAY_MARK_SQL, { 1: 'done' })
    const args = { 1: now - 3600, 2: now - SQL.RELAY_HARD_AGE_S }
    run(SQL.RELAY_SWEEP_SQL, args)
    // delivered → gone; undelivered-to-a-device → kept for the reporter
    expect(db.prepare(`SELECT id FROM relay_messages WHERE id='done'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT id FROM relay_messages WHERE id='stale'`).get()?.id).toBe('stale')
    expect(db.prepare(`SELECT id FROM relay_messages WHERE id='r1'`).get()?.id).toBe('r1')

    // …and the hard backstop still bounds the table if the cron never runs.
    run(SQL.RELAY_SWEEP_SQL, { 1: now - 3600, 2: now - 1 })
    expect(db.prepare(`SELECT id FROM relay_messages WHERE id='stale'`).get()).toBeUndefined()
  })

  it('payload sanitizer: bounds + JSON validity', () => {
    expect(sanitizeRelayPayload({ a: 1 })).toBe('{"a":1}')
    expect(sanitizeRelayPayload('{"ok":true}')).toBe('{"ok":true}')
    expect(sanitizeRelayPayload('not json')).toBeNull()
    expect(sanitizeRelayPayload('x'.repeat(10000))).toBeNull()
  })
})
