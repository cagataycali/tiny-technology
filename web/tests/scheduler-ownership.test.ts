// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('scheduler-ownership')

/**
 * 💵 JobsCreateCall ownership gate (scheduler.ts) — you may NOT schedule a
 * PAID tiny you don't own.
 *
 * The scheduled runner (app/api/job-run) executes the target tiny's full
 * persona + skills on server model credentials with NO x402 settle. Without
 * this gate, a user could schedule someone else's priced PUBLIC tiny to run
 * every minute for free — the owner earns nothing (cross-creator free-compute
 * + revenue leak). `prices.owner_id` is authoritative (only the
 * ownership-verifying PayPriceSetCall writes it).
 *
 * This pins the REAL decision predicate the handler runs (the priced-lookup +
 * owner compare) against sqlite, mirroring scheduler-cas.test.ts's approach for
 * load-bearing worker SQL. Reject iff a row exists AND its owner != caller.
 */
let db: any

// The exact resource-key normalization the handler uses before the lookup.
const slugKey = (tiny: string) =>
  `tiny:${String(tiny).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)}`

// Mirrors the handler's gate: SELECT owner_id FROM prices WHERE resource=? AND
// active=1; reject iff a row exists and its owner isn't the caller.
const maySchedule = (tiny: string, userId: string): boolean => {
  const priced = db.prepare(
    'SELECT owner_id FROM prices WHERE resource = ? AND active = 1'
  ).get(slugKey(tiny))
  if (priced && String(priced.owner_id) !== String(userId)) return false
  return true
}

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node@17 predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE prices (
      resource TEXT PRIMARY KEY, owner_id TEXT, price_micro INTEGER,
      active INTEGER DEFAULT 1, updated INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO prices (resource, owner_id, price_micro, active) VALUES
      ('tiny:alice-paid', 'alice', 50000, 1),
      ('tiny:bob-inactive', 'bob', 50000, 0);
  `)
})

describe.skipIf(!present)('JobsCreateCall ownership gate (real sqlite)', () => {
  it("rejects scheduling someone else's PAID tiny (the revenue-leak fix)", () => {
    expect(maySchedule('alice-paid', 'mallory')).toBe(false)
  })

  it('allows the OWNER to schedule their own paid tiny', () => {
    expect(maySchedule('alice-paid', 'alice')).toBe(true)
  })

  it('allows any user to schedule a FREE tiny (no active price row)', () => {
    expect(maySchedule('some-free-tiny', 'mallory')).toBe(true)
    expect(maySchedule('tiny', 'anyone')).toBe(true)
  })

  it('an INACTIVE price row does not gate (price cleared → free again)', () => {
    // active=0 means the price was cleared; the tiny is free, anyone may schedule.
    expect(maySchedule('bob-inactive', 'mallory')).toBe(true)
  })

  it("casing is normalized so the gate can't be dodged by uppercasing the slug", () => {
    // 'Alice-Paid' lowercases to the priced key 'alice-paid' → still gated.
    expect(maySchedule('Alice-Paid', 'mallory')).toBe(false)
  })
})
