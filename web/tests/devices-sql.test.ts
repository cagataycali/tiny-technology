// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('devices-sql')

/**
 * Runs the worker's REAL device statements (DEVICE_*_SQL exports) against an
 * in-memory sqlite — D1 is sqlite, so semantics match. Pins the security
 * invariants of tiny-node PR2 (docs/tiny-node-goal.md §3):
 *   - heartbeat authenticates on (id, token_hash) AND revoked=0 — a revoked
 *     device and a wrong token are indistinguishable (0 rows changed, no oracle)
 *   - revoke is scoped to (id, user_id) — you cannot revoke another user's device
 *   - list excludes revoked and derives presence from last_seen
 *   - the SHA-256 token hash roundtrips (mint → hash → verify)
 * A copied query string would drift; the import means query changes MUST keep
 * these invariants or fail here.
 */
let SQL: any
let hashDeviceToken: (t: string) => Promise<string>
let sanitizeCapabilities: (raw: unknown) => string
let PRESENCE_WINDOW_S: number
let db: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('devices.ts') /* @vite-ignore */)
  SQL = mod
  hashDeviceToken = mod.hashDeviceToken
  sanitizeCapabilities = mod.sanitizeCapabilities
  PRESENCE_WINDOW_S = mod.PRESENCE_WINDOW_S
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // Schema must track migrations: url/secret arrived with 0029 (endpoint
  // devices), and DEVICE_LIST_SQL now selects `url` — a fixture frozen at the
  // old shape fails on the real statement rather than on the behaviour.
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT, kind TEXT, capabilities TEXT, token_hash TEXT NOT NULL,
      last_seen INTEGER, created_at INTEGER, revoked INTEGER DEFAULT 0,
      url TEXT, secret TEXT
    );
  `)
})

// node:sqlite binds ?1-numbered params as NAMED params; D1's positional
// .bind(v) is identical.
const run = (sql: string, params: Record<number, any>) => db.prepare(sql).run(params)
const all = (sql: string, params: Record<number, any>) => db.prepare(sql).all(params)
const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)

async function enroll(id: string, userId: string, token: string, opts: any = {}) {
  const now = opts.now ?? 1000
  run(SQL.DEVICE_INSERT_SQL, {
    1: id, 2: userId, 3: opts.name ?? id, 4: opts.platform ?? 'darwin',
    5: opts.kind ?? 'cli', 6: sanitizeCapabilities(opts.capabilities ?? []),
    7: await hashDeviceToken(token), 8: now,
  })
}

describe.skipIf(!present)('worker DEVICE_*_SQL (real statements, real sqlite)', () => {
  it('token hash roundtrips (mint form → hash → verify)', async () => {
    const h1 = await hashDeviceToken('tind_abc')
    const h2 = await hashDeviceToken('tind_abc')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex, no plaintext
    expect(await hashDeviceToken('tind_other')).not.toBe(h1)
  })

  it('count excludes revoked devices', async () => {
    await enroll('d1', 'u1', 'tind_1')
    await enroll('d2', 'u1', 'tind_2')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'd2', 2: 'u1' })
    expect((first(SQL.DEVICE_COUNT_SQL, { 1: 'u1' }) as any).n).toBe(1)
  })

  it('heartbeat succeeds only with the right token AND not revoked', async () => {
    await enroll('d3', 'u2', 'tind_live', { now: 1000 })
    // wrong token → 0 rows changed
    const wrong = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd3', 2: 2000, 3: null, 4: await hashDeviceToken('tind_wrong'),
    })
    expect(wrong.changes).toBe(0)
    // right token → 1 row, last_seen advances
    const ok = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd3', 2: 2000, 3: null, 4: await hashDeviceToken('tind_live'),
    })
    expect(ok.changes).toBe(1)
    expect((first('SELECT last_seen FROM devices WHERE id=?1', { 1: 'd3' }) as any).last_seen).toBe(2000)
  })

  it('a revoked device heartbeat is indistinguishable from a wrong token (0 rows, no oracle)', async () => {
    await enroll('d4', 'u2', 'tind_dead')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'd4', 2: 'u2' })
    const res = run(SQL.DEVICE_HEARTBEAT_SQL, {
      1: 'd4', 2: 3000, 3: null, 4: await hashDeviceToken('tind_dead'), // correct token!
    })
    expect(res.changes).toBe(0) // revoked=0 clause blocks it — same as a bad token
  })

  it('heartbeat with null capabilities keeps the existing value (COALESCE)', async () => {
    await enroll('d5', 'u2', 'tind_caps', { capabilities: ['shell', 'files'] })
    run(SQL.DEVICE_HEARTBEAT_SQL, { 1: 'd5', 2: 4000, 3: null, 4: await hashDeviceToken('tind_caps') })
    expect((first('SELECT capabilities FROM devices WHERE id=?1', { 1: 'd5' }) as any).capabilities)
      .toBe(JSON.stringify(['shell', 'files']))
  })

  it('revoke is scoped to the owner — cannot revoke another user\'s device', async () => {
    await enroll('d6', 'owner', 'tind_x')
    const attacker = run(SQL.DEVICE_REVOKE_SQL, { 1: 'd6', 2: 'not-owner' })
    expect(attacker.changes).toBe(0) // wrong user_id → no-op
    expect((first('SELECT revoked FROM devices WHERE id=?1', { 1: 'd6' }) as any).revoked).toBe(0)
    const owner = run(SQL.DEVICE_REVOKE_SQL, { 1: 'd6', 2: 'owner' })
    expect(owner.changes).toBe(1)
  })

  it('list returns only non-revoked devices, newest-seen first', async () => {
    await enroll('a', 'u3', 'tind_a', { now: 100 })
    await enroll('b', 'u3', 'tind_b', { now: 300 })
    await enroll('c', 'u3', 'tind_c', { now: 200 })
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'c', 2: 'u3' })
    const rows = all(SQL.DEVICE_LIST_SQL, { 1: 'u3' })
    expect(rows.map((r: any) => r.id)).toEqual(['b', 'a']) // c revoked, ordered by last_seen DESC
  })

  it('presence window is a positive number of seconds', () => {
    expect(PRESENCE_WINDOW_S).toBeGreaterThan(0)
  })
})

/**
 * 🎙️ DEVICE_EVENT_AUTH_SQL — the PUSH half of the device model (a Nicla Voice
 * wake word), so it carries the same invariants heartbeat does plus one more:
 * it resolves the OWNER. That resolution is the security boundary. The caller
 * holding the token may be a relaying phone rather than the device itself, so
 * the user id must come from the row, never from the request body — otherwise a
 * device token would be enough to write onto a stranger's event ring, and the
 * ring is what the agent reads as ground truth about what happened.
 */
describe.skipIf(!present)('worker DEVICE_EVENT_AUTH_SQL (device → owner\'s ring)', () => {
  it('resolves the owner from the token, never from the caller', async () => {
    await enroll('vc1', 'owner-a', 'tind_voice', { platform: 'nicla-voice', name: 'tiny voice' })
    const row: any = first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc1', 2: await hashDeviceToken('tind_voice') })
    expect(row?.user_id).toBe('owner-a')
    // The name is selected too: "heard 'alexa'" with no subject is
    // unattributable once a user owns two boards.
    expect(row?.name).toBe('tiny voice')
  })

  it('a wrong token and a revoked device are both simply no row (no oracle)', async () => {
    await enroll('vc2', 'owner-b', 'tind_live2', { platform: 'nicla-voice' })
    expect(first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc2', 2: await hashDeviceToken('tind_wrong') })).toBeFalsy()
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'vc2', 2: 'owner-b' })
    // Correct token, revoked device — must still be nothing.
    expect(first(SQL.DEVICE_EVENT_AUTH_SQL,
      { 1: 'vc2', 2: await hashDeviceToken('tind_live2') })).toBeFalsy()
  })

  it('kind is an allowlist, not free text', async () => {
    const mod: any = await import(workerFile('devices.ts') /* @vite-ignore */)
    // Anything holding a device token can reach this route. Free-text kinds
    // would let a device forge a `device_result` or a scheduler fire onto the
    // ring the agent trusts.
    expect(mod.DEVICE_EVENT_KINDS).toContain('nicla_wake')
    expect(mod.DEVICE_EVENT_KINDS).not.toContain('device_result')
    expect(mod.DEVICE_EVENT_KINDS).not.toContain('scheduler')
  })
})

/**
 * DEVICE_ROTATE_TOKEN_SQL — adopt a device you own from a client that has no
 * token, WITHOUT re-enrolling the hardware.
 *
 * The alternative it replaces was destructive: enrolling the same board twice
 * mints a second row and leaves the first permanently offline in the fleet. So
 * these tests pin the two things that make rotation safe to prefer — it must
 * keep the row identity (id, history, transcripts all hang off the id), and it
 * must be no easier to steal a device with than revoke is.
 */
describe.skipIf(!present)('worker DEVICE_ROTATE_TOKEN_SQL (adopt without re-enrolling)', () => {
  it('the new token works and the OLD one stops working', async () => {
    await enroll('rt1', 'u-rot', 'tind_old', { now: 1000 })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt1', 2: 'u-rot', 3: await hashDeviceToken('tind_new') })
    expect(res.changes).toBe(1)
    // Old credential is dead — a handover, not a share. Two clients holding
    // tokens for one BLE peripheral would fight over its single central slot.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt1', 2: 2000, 3: null, 4: await hashDeviceToken('tind_old') }).changes).toBe(0)
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt1', 2: 2000, 3: null, 4: await hashDeviceToken('tind_new') }).changes).toBe(1)
  })

  it('keeps the row: same id, name, kind, capabilities and history', async () => {
    await enroll('rt2', 'u-rot', 'tind_a', {
      name: 'tiny voice', platform: 'nicla-voice', kind: 'daemon', capabilities: ['wake', 'record'], now: 500,
    })
    run(SQL.DEVICE_ROTATE_TOKEN_SQL, { 1: 'rt2', 2: 'u-rot', 3: await hashDeviceToken('tind_b') })
    const row: any = first(
      'SELECT id, name, platform, kind, capabilities, created_at, last_seen FROM devices WHERE id=?1', { 1: 'rt2' })
    // This is the whole point: events and transcripts are keyed by device id, so
    // preserving the row is what makes adoption non-destructive.
    expect(row.id).toBe('rt2')
    expect(row.name).toBe('tiny voice')
    expect(row.platform).toBe('nicla-voice')
    expect(row.kind).toBe('daemon')
    expect(row.capabilities).toBe(JSON.stringify(['wake', 'record']))
    expect(row.created_at).toBe(500)
  })

  it('is owner-scoped — cannot rotate another user\'s device', async () => {
    await enroll('rt3', 'owner', 'tind_mine')
    const attacker = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt3', 2: 'not-owner', 3: await hashDeviceToken('tind_stolen') })
    expect(attacker.changes).toBe(0)
    // And the owner's token must be untouched by the attempt.
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt3', 2: 9000, 3: null, 4: await hashDeviceToken('tind_mine') }).changes).toBe(1)
  })

  it('refuses a REVOKED device — rotation must not resurrect a killed credential', async () => {
    await enroll('rt4', 'u-rot', 'tind_dead')
    run(SQL.DEVICE_REVOKE_SQL, { 1: 'rt4', 2: 'u-rot' })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'rt4', 2: 'u-rot', 3: await hashDeviceToken('tind_zombie') })
    // Revoke's guarantee is that the device is done. If rotate could re-key it,
    // "kill this device" would be undoable by the same session that killed it.
    expect(res.changes).toBe(0)
    expect(run(SQL.DEVICE_HEARTBEAT_SQL,
      { 1: 'rt4', 2: 9000, 3: null, 4: await hashDeviceToken('tind_zombie') }).changes).toBe(0)
  })

  it('refuses an ENDPOINT device — it has no inbound token by design', async () => {
    // Endpoint rows are inserted with token_hash = '' because they dial OUT and
    // authenticate via url+secret. Rotating one would mint a working INBOUND
    // credential for a device that must not have one.
    run(SQL.ENDPOINT_INSERT_SQL, {
      1: 'ep1', 2: 'u-rot', 3: 'printer', 4: 'http', 5: 'endpoint',
      6: sanitizeCapabilities(['print']), 7: 1000, 8: 'https://printer.example', 9: 'sekret',
    })
    const res = run(SQL.DEVICE_ROTATE_TOKEN_SQL,
      { 1: 'ep1', 2: 'u-rot', 3: await hashDeviceToken('tind_escalate') })
    expect(res.changes).toBe(0)
    expect((first('SELECT token_hash FROM devices WHERE id=?1', { 1: 'ep1' }) as any).token_hash).toBe('')
  })
})

describe.skipIf(!present)('sanitizeCapabilities (bounded, safe)', () => {
  it('passes a clean array through', () => {
    expect(sanitizeCapabilities(['shell', 'files'])).toBe(JSON.stringify(['shell', 'files']))
  })
  it('coerces non-array / garbage to []', () => {
    expect(sanitizeCapabilities('not json')).toBe('[]')
    expect(sanitizeCapabilities(null)).toBe('[]')
    expect(sanitizeCapabilities({ a: 1 })).toBe('[]')
  })
  it('parses a JSON-array string', () => {
    expect(sanitizeCapabilities('["a","b"]')).toBe(JSON.stringify(['a', 'b']))
  })
  it('bounds the entry count (<=32)', () => {
    const many = Array.from({ length: 100 }, (_, i) => `c${i}`)
    expect(JSON.parse(sanitizeCapabilities(many)).length).toBe(32)
  })
})
