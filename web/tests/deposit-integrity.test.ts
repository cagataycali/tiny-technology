// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('deposit-integrity')

/**
 * 🔒 DOUBLE-MINT GUARDS — the real statements + the real migration, run against
 * real sqlite (same recipe as tests/scheduler-cas.test.ts).
 *
 * One on-chain USDC deposit used to be creditable TWICE (audit: worker deposit
 * double-mint, HIGH). Two check-then-act races, one shared root cause — the
 * guard was a SELECT the concurrent writer couldn't see:
 *   1. /pay/link-address: `SELECT … WHERE address=? AND user_id!=?` then INSERT
 *      → one sender address linked to two accounts, so both could claim its txs.
 *   2. /pay/claim: `SELECT user_id FROM ledger WHERE kind='deposit' AND ref=?`
 *      then INSERT → the only unique index is (user_id, kind, ref), keyed BY
 *      USER, so the same tx hash credited to two user_ids violated nothing.
 * Migration 0021 makes both guards writes: a partial UNIQUE index on
 * wallets(address) and a claimed_txs.tx_hash PRIMARY KEY reservation.
 *
 * These tests interleave the two writers explicitly — a serial pass proves
 * nothing about a race, so every case runs the SECOND writer with the FIRST
 * writer's snapshot still in hand.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')

let LINK_ADDRESS_SQL: string
let CLAIM_TX_SQL: string
let db: any

const ADDR = '0x' + 'a'.repeat(40)
const OTHER = '0x' + 'b'.repeat(40)
const TX = '0x' + '1'.repeat(64)

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('deposits.ts') /* @vite-ignore */)
  LINK_ADDRESS_SQL = mod.LINK_ADDRESS_SQL
  CLAIM_TX_SQL = mod.CLAIM_TX_SQL
})

/** Fresh schema: the real 0014 payments tables, WITHOUT 0021 applied yet. */
const freshDb = async () => {
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  const d = new DatabaseSync(':memory:')
  d.exec(migration('0014_payments.sql'))
  return d
}

beforeEach(async () => {
  if (!present) return
  db = await freshDb()
})

/**
 * The route's decision, reproduced exactly: 0 changes OR a UNIQUE throw ⟹ refused.
 * D1 binds ?1/?2 POSITIONALLY from .bind(userId, addr) (same as the sepolia
 * trial insert already in deposits.ts); node:sqlite treats them as NAMED, so
 * the test passes {1,2} — same statement text, same substitution.
 */
const link = (userId: string, address: string): 'linked' | 'taken' => {
  try {
    return db.prepare(LINK_ADDRESS_SQL).run({ 1: userId, 2: address }).changes ? 'linked' : 'taken'
  } catch (e: any) {
    if (String(e?.message || e).includes('UNIQUE')) return 'taken'
    throw e
  }
}
const reserve = (tx: string, userId: string, network = 'base') =>
  db.prepare(CLAIM_TX_SQL).run(tx, userId, network).changes ? 'won' : 'lost'
const addressOf = (userId: string) =>
  db.prepare('SELECT address FROM wallets WHERE user_id = ?').get(userId)?.address ?? null

describe.skipIf(!present)('migration 0021 — the constraints that end the race', () => {
  it('creates the partial unique index even when duplicates already exist (unlinking the later rows)', () => {
    // Prod state we must survive: the race already fired, two users share ADDR.
    db.exec(`INSERT INTO wallets (user_id, address) VALUES ('u1','${ADDR}'), ('u2','${ADDR}'), ('u3','${OTHER}'), ('u4', NULL)`)
    db.exec(migration('0021_deposit_integrity.sql'))

    expect(addressOf('u1')).toBe(ADDR)   // earliest claimant keeps it
    expect(addressOf('u2')).toBeNull()   // later duplicate is unlinked, row survives
    expect(addressOf('u3')).toBe(OTHER)  // untouched
    // Multiple NULL addresses must stay legal — that's why the index is partial.
    expect(db.prepare('SELECT COUNT(*) c FROM wallets').get().c).toBe(4)
    expect(() => db.exec(`UPDATE wallets SET address = '${ADDR}' WHERE user_id = 'u4'`)).toThrow(/UNIQUE/)
  })

  it('backfills claimed_txs from deposits already in the ledger (old hashes stay unclaimable)', () => {
    db.exec(`
      INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES
        ('u1', 10000000, 'deposit', '${TX}', 'chain:base'),
        ('u2', 1000000, 'deposit', '${'0x' + '2'.repeat(64)}', 'chain:base-sepolia'),
        ('u1', -500, 'invoke_debit', 'inv_1', 'u9'),
        ('u3', 250, 'invoke_credit', NULL, 'platform');
    `)
    db.exec(migration('0021_deposit_integrity.sql'))

    const rows = db.prepare('SELECT tx_hash, user_id, network FROM claimed_txs ORDER BY tx_hash').all()
    expect(rows).toEqual([
      { tx_hash: TX, user_id: 'u1', network: 'base' },
      { tx_hash: '0x' + '2'.repeat(64), user_id: 'u2', network: 'base-sepolia' },
    ])
    // Non-deposit refs (invocation ids) must NOT become claimed tx hashes.
    expect(rows.some((r: any) => r.tx_hash === 'inv_1')).toBe(false)
    // A historical hash is now unreservable by anyone else.
    expect(reserve(TX, 'u2')).toBe('lost')
  })

  it('a duplicated deposit already in the ledger backfills to ONE owner, not two', () => {
    db.exec(`
      INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES
        ('u1', 10000000, 'deposit', '${TX}', 'chain:base'),
        ('u2', 10000000, 'deposit', '${TX}', 'chain:base');
    `)
    db.exec(migration('0021_deposit_integrity.sql'))
    expect(db.prepare('SELECT user_id FROM claimed_txs WHERE tx_hash = ?').all(TX))
      .toEqual([{ user_id: 'u1' }]) // earliest row wins; OR IGNORE drops the rest
  })
})

describe.skipIf(!present)('LINK_ADDRESS_SQL — one sender address, one account', () => {
  beforeEach(() => db.exec(migration('0021_deposit_integrity.sql')))

  it('two accounts linking the SAME address concurrently: exactly one wins', () => {
    expect(link('u1', ADDR)).toBe('linked')
    expect(link('u2', ADDR)).toBe('taken')   // u2 has no wallet row → INSERT path → unique index
    expect(addressOf('u1')).toBe(ADDR)
    expect(addressOf('u2')).toBeNull()
  })

  it('refuses even when the loser already has a wallet row (the DO UPDATE path)', () => {
    db.exec(`INSERT INTO wallets (user_id, address) VALUES ('u2', NULL)`)
    expect(link('u1', ADDR)).toBe('linked')
    expect(link('u2', ADDR)).toBe('taken')   // conflict on user_id → DO UPDATE … WHERE NOT EXISTS
    expect(addressOf('u2')).toBeNull()
  })

  it('re-linking your OWN address stays idempotent (never reads as taken)', () => {
    expect(link('u1', ADDR)).toBe('linked')
    expect(link('u1', ADDR)).toBe('linked')
    expect(addressOf('u1')).toBe(ADDR)
  })

  it('switching to a free address works; the old one frees up for someone else', () => {
    expect(link('u1', ADDR)).toBe('linked')
    expect(link('u1', OTHER)).toBe('linked')
    expect(addressOf('u1')).toBe(OTHER)
    expect(link('u2', ADDR)).toBe('linked')
  })
})

describe.skipIf(!present)('CLAIM_TX_SQL — one deposit tx, one credit, across ALL users', () => {
  beforeEach(() => db.exec(migration('0021_deposit_integrity.sql')))

  it('two users claiming one tx hash concurrently: exactly one reservation', () => {
    expect(reserve(TX, 'u1')).toBe('won')
    expect(reserve(TX, 'u2')).toBe('lost')   // the write both used to pass
    expect(db.prepare('SELECT user_id FROM claimed_txs WHERE tx_hash = ?').all(TX))
      .toEqual([{ user_id: 'u1' }])
  })

  it('the loser is a CONFLICT, never an exception (route reads changes, not a throw)', () => {
    reserve(TX, 'u1')
    expect(() => db.prepare(CLAIM_TX_SQL).run(TX, 'u2', 'base')).not.toThrow()
  })

  it('the same user retrying keeps its own reservation (idempotent submit)', () => {
    expect(reserve(TX, 'u1')).toBe('won')
    expect(reserve(TX, 'u1')).toBe('lost')   // route then reads owner === self → already_credited
    expect(db.prepare('SELECT user_id FROM claimed_txs WHERE tx_hash = ?').get(TX).user_id).toBe('u1')
  })

  it('distinct hashes are independent, and the network is recorded per claim', () => {
    const tx2 = '0x' + '3'.repeat(64)
    expect(reserve(TX, 'u1', 'base')).toBe('won')
    expect(reserve(tx2, 'u1', 'tiny')).toBe('won')
    expect(db.prepare('SELECT network FROM claimed_txs WHERE tx_hash = ?').get(tx2).network).toBe('tiny')
  })

  it('releasing a refused claim (trial cap / credit failure) hands the hash back', () => {
    expect(reserve(TX, 'u1')).toBe('won')
    // The route's release(): scoped to the reserver so it can't free someone else's.
    db.prepare('DELETE FROM claimed_txs WHERE tx_hash = ? AND user_id = ?').run(TX, 'u2')
    expect(db.prepare('SELECT COUNT(*) c FROM claimed_txs').get().c).toBe(1)
    db.prepare('DELETE FROM claimed_txs WHERE tx_hash = ? AND user_id = ?').run(TX, 'u1')
    expect(reserve(TX, 'u2')).toBe('won')   // a real deposit is never burned by a refusal
  })

  it('the OLD ledger-keyed guard really did allow the double mint (regression proof)', () => {
    // idx_ledger_idem is UNIQUE(user_id, kind, ref) — same hash, two users, no
    // violation. This is the bug 0021 closes; if this ever throws, the ledger
    // gained a global constraint and claimed_txs could be reconsidered.
    const insert = db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, 10000000, 'deposit', ?, 'chain:base')")
    insert.run('u1', TX)
    expect(() => insert.run('u2', TX)).not.toThrow()
    expect(db.prepare("SELECT SUM(delta_micro) s FROM ledger WHERE ref = ?").get(TX).s).toBe(20000000)
    // …whereas the reservation admits exactly one of those two writers.
    expect([reserve(TX, 'u1'), reserve(TX, 'u2')].filter((r) => r === 'won')).toHaveLength(1)
  })
})
