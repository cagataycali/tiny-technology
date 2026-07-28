// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('oauth-sql')

/**
 * Runs the worker's REAL OAuth token statements (OAUTH_*_SQL exports) against
 * an in-memory sqlite — D1 is sqlite, so semantics match. Pins the invariants
 * of the per-service token store (migration 0015_oauth_tokens.sql):
 *   - upsert REPLACES the access_token but never clobbers a good refresh_token
 *     with an empty one (Google only returns refresh_token on first consent)
 *   - expiry/skew: expires_at=0 means never; a token within REFRESH_SKEW_S of
 *     expiry counts as expired (so we refresh proactively)
 *   - delete is scoped to (user_id, service) — you can't drop another user's
 *   - the connection LIST projection never selects the raw token columns
 * A copied query string would drift; importing the exports means query changes
 * MUST keep these invariants or fail here.
 */
let SQL: any
let isExpired: (expiresAt: number, nowS: number) => boolean
let isSupportedService: (s: unknown) => boolean
let REFRESH_SKEW_S: number
let db: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('oauth.ts') /* @vite-ignore */)
  SQL = mod
  isExpired = mod.isExpired
  isSupportedService = mod.isSupportedService
  REFRESH_SKEW_S = mod.REFRESH_SKEW_S
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE oauth_tokens (
      user_id TEXT NOT NULL, service TEXT NOT NULL, access_token TEXT NOT NULL,
      refresh_token TEXT DEFAULT '', expires_at INTEGER DEFAULT 0,
      scope TEXT DEFAULT '', token_type TEXT DEFAULT 'Bearer',
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, service)
    );
  `)
})

// node:sqlite binds ?1-numbered params as NAMED params; D1's positional
// .bind(v) is identical.
const run = (sql: string, params: Record<number, any>) => db.prepare(sql).run(params)
const all = (sql: string, params: Record<number, any>) => db.prepare(sql).all(params)
const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)

// (userId, service, access, refresh, expiresAt, scope, tokenType, now)
const upsert = (u: string, svc: string, opts: Partial<{
  access: string; refresh: string; expiresAt: number; scope: string; tokenType: string; now: number
}> = {}) =>
  run(SQL.OAUTH_UPSERT_SQL, {
    1: u, 2: svc,
    3: opts.access ?? 'acc_1',
    4: opts.refresh ?? '',
    5: opts.expiresAt ?? 0,
    6: opts.scope ?? '',
    7: opts.tokenType ?? 'Bearer',
    8: opts.now ?? 1000,
  })

describe.skipIf(!present)('oauth_tokens SQL invariants', () => {
  it('stores and reads back a fresh connection', () => {
    upsert('u1', 'spotify', { access: 'acc_spotify', refresh: 'ref_1', expiresAt: 5000, scope: 'streaming' })
    const row = first(SQL.OAUTH_GET_SQL, { 1: 'u1', 2: 'spotify' }) as any
    expect(row.access_token).toBe('acc_spotify')
    expect(row.refresh_token).toBe('ref_1')
    expect(row.expires_at).toBe(5000)
    expect(row.scope).toBe('streaming')
  })

  it('upsert REPLACES the access token but PRESERVES an existing refresh_token when the new one is empty', () => {
    upsert('u2', 'google', { access: 'acc_old', refresh: 'ref_google', expiresAt: 2000, scope: 'calendar' })
    // A refresh grant returns a new access token but NO refresh_token ('') —
    // must keep ref_google, not wipe it (Google issues refresh only on consent).
    upsert('u2', 'google', { access: 'acc_new', refresh: '', expiresAt: 9000 })
    const row = first(SQL.OAUTH_GET_SQL, { 1: 'u2', 2: 'google' }) as any
    expect(row.access_token).toBe('acc_new')
    expect(row.refresh_token).toBe('ref_google') // preserved via COALESCE(NULLIF(...))
    expect(row.expires_at).toBe(9000)
    expect(row.scope).toBe('calendar') // empty scope also preserved
  })

  it('upsert overwrites the refresh_token when a new NON-empty one is provided (rotation)', () => {
    upsert('u3', 'spotify', { access: 'a1', refresh: 'ref_v1' })
    upsert('u3', 'spotify', { access: 'a2', refresh: 'ref_v2' })
    const row = first(SQL.OAUTH_GET_SQL, { 1: 'u3', 2: 'spotify' }) as any
    expect(row.refresh_token).toBe('ref_v2')
  })

  it('one row per (user, service) — same user, different services coexist', () => {
    upsert('u4', 'github', { access: 'gh' })
    upsert('u4', 'spotify', { access: 'sp' })
    const rows = all(SQL.OAUTH_LIST_SQL, { 1: 'u4' })
    expect(rows.map((r: any) => r.service)).toEqual(['github', 'spotify']) // ORDER BY service
  })

  it('the LIST projection never exposes the raw token columns', () => {
    upsert('u5', 'spotify', { access: 'secret_access', refresh: 'secret_refresh' })
    const rows = all(SQL.OAUTH_LIST_SQL, { 1: 'u5' }) as any[]
    for (const r of rows) {
      expect(r).not.toHaveProperty('access_token')
      expect(r).not.toHaveProperty('refresh_token')
    }
  })

  it('delete is scoped to (user, service) — cannot drop another user\'s token', () => {
    upsert('owner', 'google', { access: 'x' })
    const attacker = run(SQL.OAUTH_DELETE_SQL, { 1: 'not-owner', 2: 'google' })
    expect(attacker.changes).toBe(0)
    expect(first(SQL.OAUTH_GET_SQL, { 1: 'owner', 2: 'google' })).toBeTruthy()
    const owner = run(SQL.OAUTH_DELETE_SQL, { 1: 'owner', 2: 'google' })
    expect(owner.changes).toBe(1)
    expect(first(SQL.OAUTH_GET_SQL, { 1: 'owner', 2: 'google' })).toBeFalsy()
  })

  it('deleting one service leaves the user\'s other services intact', () => {
    upsert('u6', 'github', { access: 'gh' })
    upsert('u6', 'spotify', { access: 'sp' })
    run(SQL.OAUTH_DELETE_SQL, { 1: 'u6', 2: 'github' })
    const rows = all(SQL.OAUTH_LIST_SQL, { 1: 'u6' })
    expect(rows.map((r: any) => r.service)).toEqual(['spotify'])
  })
})

describe.skipIf(!present)('isExpired (skew-aware)', () => {
  it('expires_at=0 (never/unknown, e.g. github) is always fresh', () => {
    expect(isExpired(0, 999_999)).toBe(false)
  })
  it('a token comfortably in the future is fresh', () => {
    expect(isExpired(10_000, 1_000)).toBe(false)
  })
  it('a token within the skew window counts as expired (refresh proactively)', () => {
    // now is before real expiry, but inside REFRESH_SKEW_S → treat as expired
    expect(isExpired(1_000, 1_000 - Math.floor(REFRESH_SKEW_S / 2))).toBe(true)
  })
  it('a token past expiry is expired', () => {
    expect(isExpired(1_000, 2_000)).toBe(true)
  })
})

describe.skipIf(!present)('isSupportedService', () => {
  it('accepts the three ported providers', () => {
    expect(isSupportedService('github')).toBe(true)
    expect(isSupportedService('spotify')).toBe(true)
    expect(isSupportedService('google')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isSupportedService('facebook')).toBe(false)
    expect(isSupportedService('')).toBe(false)
    expect(isSupportedService(null)).toBe(false)
    expect(isSupportedService(42)).toBe(false)
  })
})
