// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('scheduler-cas')

/**
 * Runs the scheduler's REAL claim statement (CLAIM_SQL export) against
 * sqlite — the double-fire guard is the most load-bearing SQL in the
 * worker (careless documented losing a job to exactly this race; the CAS
 * is the port plan's fix). Pins:
 *   - two runners with the same snapshot → exactly one claim
 *   - the IS-vs-= trap: a NULL last_fired_at row must be claimable
 *   - a stale snapshot (row advanced since read) never claims
 */
let CLAIM_SQL: string
let db: any

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('scheduler.ts') /* @vite-ignore */)
  CLAIM_SQL = mod.CLAIM_SQL
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node@17
  // (the repo pin) predates it. Runtime is the local Node, worker-gated.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, user_id TEXT, tiny_slug TEXT, name TEXT,
      schedule TEXT, run_at INTEGER, prompt TEXT, enabled INTEGER DEFAULT 1,
      once INTEGER DEFAULT 0, last_fired_at INTEGER, fire_count INTEGER DEFAULT 0,
      created INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO jobs (id, user_id, tiny_slug, name, schedule, last_fired_at) VALUES
      ('j-null', 'u1', 'tiny', 'never fired', '*/5m', NULL),
      ('j-800',  'u1', 'tiny', 'fired at 800', '*/5m', 800);
  `)
})

// node:sqlite: ?-anonymous params bind positionally via .run(...)
const claim = (now: number, id: string, snapshot: number | null) =>
  db.prepare(CLAIM_SQL).run(now, id, snapshot).changes

describe.skipIf(!present)('scheduler CLAIM_SQL (real statement, real sqlite)', () => {
  it('two runners, same snapshot → exactly one wins (the double-fire guard)', () => {
    const a = claim(900, 'j-800', 800)
    const b = claim(900, 'j-800', 800) // second region, same read snapshot
    expect(a + b).toBe(1)
    expect(a).toBe(1) // first claimant wins
    const row = db.prepare('SELECT last_fired_at, fire_count FROM jobs WHERE id = ?').get('j-800')
    expect(row.last_fired_at).toBe(900)
    expect(row.fire_count).toBe(1) // not 2 — the loser never incremented
  })

  it('the IS trap: NULL last_fired_at rows are claimable (= would skip forever)', () => {
    expect(claim(900, 'j-null', null)).toBe(1)
    expect(db.prepare('SELECT last_fired_at FROM jobs WHERE id = ?').get('j-null').last_fired_at).toBe(900)
    // and the equals-variant really would have failed — regression-proves the comment
    db.exec("UPDATE jobs SET last_fired_at = NULL WHERE id = 'j-null'")
    const eqVariant = CLAIM_SQL.replace('IS ?', '= ?')
    expect(db.prepare(eqVariant).run(950, 'j-null', null).changes).toBe(0)
  })

  it('a stale snapshot never claims (row advanced since the read)', () => {
    expect(claim(900, 'j-800', 800)).toBe(1)  // row is now at 900
    expect(claim(960, 'j-800', 800)).toBe(0)  // stale reader from the 800 era
    expect(claim(960, 'j-800', 900)).toBe(1)  // fresh reader claims normally
    expect(db.prepare('SELECT fire_count FROM jobs WHERE id = ?').get('j-800').fire_count).toBe(2)
  })
})
