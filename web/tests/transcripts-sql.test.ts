// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('transcripts-sql')

/**
 * Worker transcript statements (TRANSCRIPT_*_SQL, migration 0030) against real
 * sqlite — pins the Nicla Voice recorder invariants:
 *   - get is scoped to (id, user_id): a leaked transcript id alone reads nothing
 *   - list is newest first and returns a PREVIEW, never the full text
 *   - ring semantics (events.ts RING_CAP shape): oldest pruned beyond the cap,
 *     and pruning one user never touches another's rows
 * A copied query string would drift; importing the exported constants means a
 * query change MUST keep these invariants or fail here.
 */
let SQL: any
let db: any

beforeAll(async () => {
  if (!present) return
  SQL = await import(workerFile('transcripts.ts') /* @vite-ignore */)
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  // Mirrors migrations/0030_transcripts.sql — a fixture frozen at an older
  // shape should fail on the real statement, not on the behaviour.
  db.exec(`
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      audio_url TEXT NOT NULL DEFAULT '',
      duration_s INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL
    );
    CREATE INDEX idx_transcripts_user ON transcripts (user_id, created DESC);
  `)
})

// node:sqlite binds ?1-numbered params as NAMED params; D1's positional
// .bind(v) is identical.
const run = (sql: string, params: Record<number, any>) => db.prepare(sql).run(params)
const all = (sql: string, params: Record<number, any>) => db.prepare(sql).all(params)
const first = (sql: string, params: Record<number, any>) => db.prepare(sql).get(params)

const insert = (id: string, userId: string, opts: any = {}) =>
  run(SQL.TRANSCRIPT_INSERT_SQL, {
    1: id, 2: userId, 3: opts.deviceId ?? 'phone-1', 4: opts.label ?? '',
    5: opts.text ?? 'hello there', 6: opts.audioUrl ?? '',
    7: opts.durationS ?? 10, 8: opts.created ?? 1000,
  })

describe.skipIf(!present)('worker TRANSCRIPT_*_SQL (real statements, real sqlite)', () => {
  it('insert → get roundtrips the FULL text and metadata', () => {
    insert('t1', 'u1', {
      label: 'wake: alexa', text: 'x'.repeat(500),
      audioUrl: 'https://media.example/a.m4a', durationS: 30, created: 1111,
    })
    const row: any = first(SQL.TRANSCRIPT_GET_SQL, { 1: 't1', 2: 'u1' })
    expect(row.text).toHaveLength(500) // full text — get is the un-truncated read
    expect(row.label).toBe('wake: alexa')
    expect(row.audio_url).toBe('https://media.example/a.m4a')
    expect(row.duration_s).toBe(30)
    expect(row.device_id).toBe('phone-1')
  })

  it('get is owner-scoped — an id alone is never enough', () => {
    expect(first(SQL.TRANSCRIPT_GET_SQL, { 1: 't1', 2: 'someone-else' })).toBeUndefined()
    expect(first(SQL.TRANSCRIPT_GET_SQL, { 1: 'no-such-id', 2: 'u1' })).toBeUndefined()
  })

  it('list is newest first, previews cut at 200, scoped to the user', () => {
    insert('t2', 'u1', { text: 'y'.repeat(300), created: 2222 })
    insert('t3', 'other-user', { created: 9999 })
    const rows = all(SQL.TRANSCRIPT_LIST_SQL, { 1: 'u1', 2: 10 })
    expect(rows.map((r: any) => r.id)).toEqual(['t2', 't1']) // newest first, no strangers
    expect(rows[0].preview).toHaveLength(200)                 // preview, not the 300-char text
    expect(rows[0]).not.toHaveProperty('text')                // full text stays behind /transcript
  })

  it('list honours the limit', () => {
    expect(all(SQL.TRANSCRIPT_LIST_SQL, { 1: 'u1', 2: 1 })).toHaveLength(1)
  })

  it('ring prune keeps the newest CAP rows and never touches another user', () => {
    const cap = SQL.TRANSCRIPT_RING_CAP
    expect(cap).toBe(200)
    for (let i = 0; i < cap + 5; i++) {
      insert(`ring-${i}`, 'u-ring', { created: 5000 + i })
    }
    insert('bystander', 'u-bystander', { created: 1 }) // oldest row in the table
    run(SQL.TRANSCRIPT_PRUNE_SQL, { 1: 'u-ring', 2: cap })

    const left = all(SQL.TRANSCRIPT_LIST_SQL, { 1: 'u-ring', 2: cap + 10 })
    expect(left).toHaveLength(cap)
    expect(left[0].id).toBe(`ring-${cap + 4}`)                          // newest kept
    const ids = new Set(left.map((r: any) => r.id))
    for (let i = 0; i < 5; i++) expect(ids.has(`ring-${i}`)).toBe(false) // oldest 5 pruned
    // the other user's ancient row survives someone else's prune
    expect(first(SQL.TRANSCRIPT_GET_SQL, { 1: 'bystander', 2: 'u-bystander' })).toBeTruthy()
  })

  it('same-second recordings prune by insertion order, not arbitrarily', () => {
    insert('tie-old', 'u-tie', { created: 7777 })
    insert('tie-new', 'u-tie', { created: 7777 })
    run(SQL.TRANSCRIPT_PRUNE_SQL, { 1: 'u-tie', 2: 1 })
    expect(first(SQL.TRANSCRIPT_GET_SQL, { 1: 'tie-new', 2: 'u-tie' })).toBeTruthy()
    expect(first(SQL.TRANSCRIPT_GET_SQL, { 1: 'tie-old', 2: 'u-tie' })).toBeUndefined()
  })
})
