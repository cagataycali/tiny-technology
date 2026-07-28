// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('messages-inbox-sql')

/**
 * Runs the worker's REAL inbox statement (INBOX_SQL export) against an
 * in-memory sqlite — D1 is sqlite, so semantics match. Pins the N+1→JOIN
 * rewrite (worker 9976e53): ordering, unread counts, last_body correlated
 * subquery, missing-user fallback. A copied query string would drift; the
 * import means query changes MUST keep these invariants or fail here.
 */
let INBOX_SQL: string
let db: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('messages.ts') /* @vite-ignore */)
  INBOX_SQL = mod.INBOX_SQL
  // @ts-expect-error — node:sqlite ships with Node 22+, but the repo pins
  // @types/node@17 (matching the Vercel edge target). Runtime is fine:
  // vitest runs on the local Node, and the suite skips when the worker
  // submodule is absent anyway.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, github_login TEXT, name TEXT, avatar TEXT);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT, to_user TEXT, via_tiny TEXT, body TEXT,
      read INTEGER DEFAULT 0, created INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO users VALUES
      ('u1','alice','Alice','a.png'),('u2','bob','Bob','b.png'),('u3','carol','Carol','');
    INSERT INTO messages (from_user,to_user,body,read,created) VALUES
      ('u2','u1','hey from bob',1,100),
      ('u1','u2','reply to bob',1,200),
      ('u3','u1','carol msg 1',0,150),
      ('u3','u1','carol msg 2',0,160);
  `)
})

// node:sqlite binds ?1-numbered params as NAMED parameters ({1: value});
// D1's .bind(v) does the same positionally — semantics are identical.
const inbox = (userId: string) => db.prepare(INBOX_SQL).all({ 1: userId })

describe.skipIf(!present)('worker INBOX_SQL (real statement, real sqlite)', () => {
  it('threads ordered by last activity, newest first', () => {
    const rows = inbox('u1')
    expect(rows.map((r: any) => r.peer)).toEqual(['u2', 'u3'])
    expect(rows[0].last_at).toBe(200)
  })

  it('unread counts only INBOUND unread (own sent replies never count)', () => {
    const rows = inbox('u1')
    expect(rows.find((r: any) => r.peer === 'u2').unread).toBe(0) // all read
    expect(rows.find((r: any) => r.peer === 'u3').unread).toBe(2)
    // and from carol's perspective her own sent messages aren't "unread"
    expect(inbox('u3')[0].unread).toBe(0)
  })

  it('last_body is the newest message in the pair regardless of direction', () => {
    const rows = inbox('u1')
    expect(rows.find((r: any) => r.peer === 'u2').last_body).toBe('reply to bob')
    expect(rows.find((r: any) => r.peer === 'u3').last_body).toBe('carol msg 2')
  })

  it('peer identity arrives via the JOIN (the N+1 replacement)', () => {
    const rows = inbox('u1')
    expect(rows.find((r: any) => r.peer === 'u2').login).toBe('bob')
    expect(rows.find((r: any) => r.peer === 'u3').name).toBe('Carol')
  })

  it('deleted/unknown peer degrades to NULL identity, not a dropped thread', () => {
    db.exec("INSERT INTO messages (from_user,to_user,body,read,created) VALUES ('ghost','u1','boo',0,300)")
    const rows = inbox('u1')
    const ghost = rows.find((r: any) => r.peer === 'ghost')
    expect(ghost).toBeTruthy()
    expect(ghost.login).toBeNull()
    expect(ghost.unread).toBe(1)
  })

  it('no threads → empty result, not an error', () => {
    expect(inbox('nobody')).toEqual([])
  })
})
