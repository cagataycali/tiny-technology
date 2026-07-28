// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('locations-sql')

/**
 * Runs the worker's REAL map-presence statements (LOCATION_*_SQL exports)
 * against an in-memory sqlite — D1 is sqlite, so semantics match. Pins the
 * privacy invariants of the maps-location loop:
 *   - one row per user: a second heartbeat REPLACES the first (upsert),
 *     never accumulates a movement history
 *   - the list cuts on the presence window — a stale row is invisible even
 *     though it still exists (dead clients fall off the map on their own)
 *   - delete removes the row entirely (opt-out leaves nothing at rest)
 *   - sweep erases day-old rows (a client that died without its DELETE
 *     doesn't leave last-known coordinates behind forever)
 *   - sanitizers: coords coarsened to 4dp and range-checked, heading is an
 *     allowlist (not a parse), speed clamped
 */
let SQL: any
let db: any

const NOW = 1_753_400_000

beforeAll(async () => {
  if (!present) return
  SQL = await import(workerFile('locations.ts') /* @vite-ignore */)
  // @ts-expect-error — node:sqlite ships with Node 22+; repo pins @types/node@17.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, github_id TEXT, github_login TEXT,
      email TEXT, name TEXT, avatar TEXT, created INTEGER
    );
    CREATE TABLE locations (
      user_id TEXT PRIMARY KEY,
      lat REAL NOT NULL, lng REAL NOT NULL,
      speed_kmh REAL, heading TEXT, accuracy_m INTEGER,
      updated INTEGER NOT NULL
    );
    CREATE INDEX idx_locations_updated ON locations(updated);
  `)
  db.prepare(`INSERT INTO users (id, github_login, name, avatar) VALUES (?, ?, ?, ?)`)
    .run('u1', 'ada', 'Ada', 'https://a.png')
  db.prepare(`INSERT INTO users (id, github_login, name, avatar) VALUES (?, ?, ?, ?)`)
    .run('u2', 'grace', 'Grace', 'https://g.png')
})

describe.skipIf(!present)('locations sanitizers', () => {
  it('coords: coarsened to 4dp, range-checked, junk → null', () => {
    expect(SQL.sanitizeLat(37.77491234)).toBe(37.7749)
    expect(SQL.sanitizeLng(-122.41945678)).toBe(-122.4195)
    expect(SQL.sanitizeLat(91)).toBeNull()
    expect(SQL.sanitizeLat(-90.0001)).toBeNull()
    expect(SQL.sanitizeLng(181)).toBeNull()
    expect(SQL.sanitizeLat('junk')).toBeNull()
  })

  it('heading: allowlisted cardinals only', () => {
    expect(SQL.sanitizeHeading('NE')).toBe('NE')
    expect(SQL.sanitizeHeading('ne')).toBe('NE')
    expect(SQL.sanitizeHeading('north')).toBeNull()
    expect(SQL.sanitizeHeading('<script>')).toBeNull()
    expect(SQL.sanitizeHeading(null)).toBeNull()
  })

  it('speed: clamped [0,1200] at 1dp; accuracy: int, capped', () => {
    expect(SQL.sanitizeSpeed(23.44)).toBe(23.4)
    expect(SQL.sanitizeSpeed(9999)).toBe(1200)
    expect(SQL.sanitizeSpeed(-5)).toBeNull()
    expect(SQL.sanitizeSpeed(null)).toBeNull()
    expect(SQL.sanitizeAccuracy(15.7)).toBe(16)
    expect(SQL.sanitizeAccuracy(9e9)).toBe(100_000)
  })
})

// node:sqlite binds ?N params as an object keyed by number (devices-sql pattern)
const beat = (params: Record<number, any>) => db.prepare(SQL.LOCATION_UPSERT_SQL).run(params)

describe.skipIf(!present)('locations SQL', () => {
  it('heartbeat upserts — one row per user, no movement history', () => {
    beat({ 1: 'u1', 2: 37.7749, 3: -122.4194, 4: 23.4, 5: 'NE', 6: 15, 7: NOW - 60 })
    beat({ 1: 'u1', 2: 37.78, 3: -122.42, 4: null, 5: null, 6: 10, 7: NOW })
    const rows = db.prepare(`SELECT * FROM locations WHERE user_id = 'u1'`).all()
    expect(rows.length).toBe(1)
    expect(rows[0].lat).toBe(37.78)
    expect(rows[0].speed_kmh).toBeNull()
    expect(rows[0].updated).toBe(NOW)
  })

  it('list joins users, cuts on the window, freshest first', () => {
    // u2 beat long ago — visible row exists but is past the window
    beat({ 1: 'u2', 2: 40.7128, 3: -74.006, 4: null, 5: null, 6: null, 7: NOW - SQL.MAP_PRESENCE_WINDOW_S - 1 })
    const cutoff = NOW - SQL.MAP_PRESENCE_WINDOW_S
    const fresh = db.prepare(SQL.LOCATION_LIST_SQL).all({ 1: cutoff })
    expect(fresh.length).toBe(1)
    expect(fresh[0].login).toBe('ada')
    expect(fresh[0].name).toBe('Ada')
    expect(fresh[0].avatar).toBe('https://a.png')

    // u2 beats again inside the window → both visible, freshest first
    beat({ 1: 'u2', 2: 40.7128, 3: -74.006, 4: null, 5: null, 6: null, 7: NOW + 10 })
    const both = db.prepare(SQL.LOCATION_LIST_SQL).all({ 1: cutoff })
    expect(both.map((r: any) => r.login)).toEqual(['grace', 'ada'])
  })

  it('opt-out delete leaves nothing at rest', () => {
    db.prepare(SQL.LOCATION_DELETE_SQL).run({ 1: 'u1' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE user_id = 'u1'`).get().n).toBe(0)
    // other users untouched
    expect(db.prepare(`SELECT COUNT(*) AS n FROM locations`).get().n).toBe(1)
  })

  it('sweep erases rows a dead client left behind', () => {
    beat({ 1: 'u1', 2: 37.7749, 3: -122.4194, 4: null, 5: null, 6: null, 7: NOW - SQL.LOCATION_SWEEP_AGE_S - 1 })
    db.prepare(SQL.LOCATION_SWEEP_SQL).run({ 1: NOW - SQL.LOCATION_SWEEP_AGE_S })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE user_id = 'u1'`).get().n).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE user_id = 'u2'`).get().n).toBe(1)
  })
})
