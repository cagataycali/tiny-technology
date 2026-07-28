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
