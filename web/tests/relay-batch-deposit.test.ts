// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('relay-batch-deposit')

/**
 * 🤖 Batch deposits (spawn_agents async S1 —
 * docs/spawn-agents-async-design-2026-08-02.md).
 *
 * spawn_agents wait:false finishes its fan-out AFTER the stream closed
 * (next/server after()) and parks the aggregated result on the worker as a
 * reply row under a batch_* ticket — so the ENTIRE late-device-reply stack
 * (recv redemption, 24h settled sweep, self-redeeming push) is reused, not
 * re-invented. What this suite pins:
 *   - the ticket NAMESPACE: replies redeem oldest-first per (in_reply_to,
 *     user_id), so a deposit under a real envelope id could shadow a genuine
 *     device reply — isBatchTicket makes that structurally impossible.
 *   - the deposit row IS a reply row: same recv, same user scoping, same
 *     settled-tier retention.
 */
let relay: any
let db: any

beforeAll(async () => {
  if (!present) return
  relay = await import(workerFile('relay.ts') /* @vite-ignore */)
  // @ts-expect-error node:sqlite ships with Node 22+
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE relay_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_device TEXT NOT NULL,
      in_reply_to TEXT, payload TEXT NOT NULL, created_at INTEGER,
      delivered INTEGER DEFAULT 0
    );
  `)
})

describe.skipIf(!present)('isBatchTicket — the namespace that cannot shadow device replies', () => {
  it('accepts batch_ + uuid-ish ids', () => {
    expect(relay.isBatchTicket('batch_' + '0e10ab7a-957e-44e6-bd23-8bd68d7c36d5')).toBe(true)
    expect(relay.isBatchTicket('batch_abc12345')).toBe(true)
  })

  it('refuses real envelope ids and everything unshaped — the shadow-attack surface', () => {
    // A deposit under a device envelope's id would win recv's oldest-first
    // read and impersonate the device's answer. Plain uuids must never pass.
    expect(relay.isBatchTicket('0e10ab7a-957e-44e6-bd23-8bd68d7c36d5')).toBe(false)
    expect(relay.isBatchTicket('batch_')).toBe(false)          // no id
    expect(relay.isBatchTicket('batch_short')).toBe(false)     // <8 chars
    expect(relay.isBatchTicket('batch_' + 'x'.repeat(65))).toBe(false) // >64
    expect(relay.isBatchTicket("batch_a'; DROP TABLE--")).toBe(false)  // charset
    expect(relay.isBatchTicket('')).toBe(false)
    expect(relay.isBatchTicket(null)).toBe(false)
    expect(relay.isBatchTicket(42)).toBe(false)
  })
})

describe.skipIf(!present)('a deposit is a reply row — the whole late-reply stack reuses', () => {
  it('deposited payload redeems via the SAME recv, scoped to the user', () => {
    const now = 1_700_000_000
    db.prepare(relay.RELAY_INSERT_SQL).run({
      1: 'dep1', 2: 'u1', 3: '', 4: 'batch_ticket01', 5: '{"result":"3/3 sub-agents done"}', 6: now,
    })
    const mine = db.prepare(relay.RELAY_RECV_SQL).get({ 1: 'batch_ticket01', 2: 'u1' })
    expect(JSON.parse(mine.payload).result).toBe('3/3 sub-agents done')
    expect(db.prepare(relay.RELAY_RECV_SQL).get({ 1: 'batch_ticket01', 2: 'u2' })).toBeUndefined()
  })

  it('deposits never surface for device envelopes (disjoint namespaces in practice)', () => {
    const now = 1_700_000_000
    db.prepare(relay.RELAY_INSERT_SQL).run({
      1: 'env1', 2: 'u1', 3: 'dev_1', 4: null, 5: '{"type":"invoke","prompt":"x"}', 6: now,
    })
    db.prepare(relay.RELAY_INSERT_SQL).run({
      1: 'reply1', 2: 'u1', 3: '', 4: 'env1', 5: '{"result":"the real device answer"}', 6: now + 5,
    })
    // recv for the envelope sees the device's reply — untouched by deposits
    const r = db.prepare(relay.RELAY_RECV_SQL).get({ 1: 'env1', 2: 'u1' })
    expect(JSON.parse(r.payload).result).toBe('the real device answer')
  })

  it('a deposit gets the settled-tier retention: alive at 2h, gone after 24h', () => {
    const now = 1_700_100_000
    db.prepare(relay.RELAY_INSERT_SQL).run({
      1: 'dep2h', 2: 'u1', 3: '', 4: 'batch_ticket02', 5: '{"result":"r"}', 6: now - 7200,
    })
    db.prepare(relay.RELAY_INSERT_SQL).run({
      1: 'dep25h', 2: 'u1', 3: '', 4: 'batch_ticket03', 5: '{"result":"r"}', 6: now - 90_000,
    })
    db.prepare(relay.RELAY_SWEEP_SQL).run({ 1: now - relay.SWEEP_AGE_S, 2: now - relay.SWEEP_SETTLED_AGE_S })
    expect(db.prepare(relay.RELAY_RECV_SQL).get({ 1: 'batch_ticket02', 2: 'u1' })).toBeDefined()
    expect(db.prepare(relay.RELAY_RECV_SQL).get({ 1: 'batch_ticket03', 2: 'u1' })).toBeUndefined()
  })
})

describe.skipIf(!present)('wiring pins', () => {
  it('the deposit route is registered and the handler enforces the namespace', () => {
    const index = readFileSync(workerFile('index.ts'), 'utf8')
    expect(index).toContain("router.post('/device/relay/deposit', RelayDepositCall)")
    const src = readFileSync(workerFile('relay.ts'), 'utf8')
    const handler = src.slice(src.indexOf('class RelayDepositCall'))
    // the namespace gate must sit BEFORE the insert — order is the security
    expect(handler.indexOf('isBatchTicket')).toBeGreaterThan(-1)
    expect(handler.indexOf('isBatchTicket')).toBeLessThan(handler.indexOf('RELAY_INSERT_SQL'))
  })
})
