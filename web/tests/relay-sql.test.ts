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

  it('sweep is two-tier: stale UNDELIVERED requests die at the short cutoff; delivered work and replies get the settled window', () => {
    const now = Math.floor(Date.now() / 1000)
    // 2h-old UNDELIVERED request — a device that wasn't polling must not come
    // back hours later and execute a stale command
    run(SQL.RELAY_INSERT_SQL, { 1: 'stale', 2: 'u1', 3: 'd1', 4: null, 5: '{}', 6: now - 7200 })
    // 2h-old DELIVERED request — its device claimed it and is mid-task; the
    // reply handler still needs this row (before the two-tier sweep, deleting
    // it here made any >1h task's reply a silent 404 — G5)
    run(SQL.RELAY_INSERT_SQL, { 1: 'working', 2: 'u1', 3: 'd1', 4: null, 5: '{}', 6: now - 7200 })
    run(SQL.RELAY_MARK_SQL, { 1: 'working' })
    // 25h-old delivered request — even the settled window ends
    run(SQL.RELAY_INSERT_SQL, { 1: 'ancient', 2: 'u1', 3: 'd1', 4: null, 5: '{}', 6: now - 90_000 })
    run(SQL.RELAY_MARK_SQL, { 1: 'ancient' })
    // 2h-old reply (to_device='', never marked delivered) — the redemption
    // window must outlive the push notification the user may tap hours later
    run(SQL.RELAY_INSERT_SQL, { 1: 'r2', 2: 'u1', 3: '', 4: 'working', 5: '{"result":"done"}', 6: now - 7200 })

    run(SQL.RELAY_SWEEP_SQL, { 1: now - SQL.SWEEP_AGE_S, 2: now - SQL.SWEEP_SETTLED_AGE_S })
    const ids = (db.prepare(`SELECT id FROM relay_messages`).all() as any[]).map(r => r.id)
    expect(ids).not.toContain('stale')    // undelivered: short tier
    expect(ids).not.toContain('ancient')  // settled tier still bounded
    expect(ids).toContain('working')      // delivered + inside the window: kept
    expect(ids).toContain('r2')           // reply inside the window: kept
    expect(ids).toContain('r1')           // fresh reply from the earlier test: untouched
  })

  it('payload sanitizer: bounds + JSON validity', () => {
    expect(sanitizeRelayPayload({ a: 1 })).toBe('{"a":1}')
    expect(sanitizeRelayPayload('{"ok":true}')).toBe('{"ok":true}')
    expect(sanitizeRelayPayload('not json')).toBeNull()
    expect(sanitizeRelayPayload('x'.repeat(10000))).toBeNull()
  })
})
