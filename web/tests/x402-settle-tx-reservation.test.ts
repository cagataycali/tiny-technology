// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-settle-tx-reservation')

/**
 * 💵💵 ONE ON-CHAIN TRANSFER, CREDITED TWICE — and on `base` both credits are
 * REAL mainnet USDC. No trial cap bounds this one; no minted token is involved.
 *
 * `claimed_txs` (migration 0021, `tx_hash` PRIMARY KEY) exists to answer ONE
 * question: has this on-chain transfer already been credited? Its own backfill
 * states the invariant — "one deposit tx → one credit, across ALL users" — and it
 * seeded itself from EVERY hash-shaped `kind='deposit'` ref in the ledger.
 *
 * But TWO paths credit an on-chain transfer, and only one reserved:
 *
 *   /pay/claim         — user pastes a tx hash. Verifies the receipt, RESERVES
 *                        the hash, credits `userId`.
 *   /pay/credit        — the inbound x402 settle funds the payer, ref = the
 *                        settlement tx hash, userId = `x402:<payer>`. Reserved
 *                        nothing.
 *
 * The two credits land under DIFFERENT user_ids, and the ledger's only unique
 * index is (user_id, kind, ref) — so nothing collides. Two namespaces, one
 * transfer, zero interlock:
 *
 *   1. an agent pays a priced tiny over x402. `X402_PAY_TO` and
 *      `DEPOSIT_ADDRESS` are the SAME platform address (§1.1 of the gaps
 *      report; prod configures exactly one), and USDC/TinyUSDC
 *      `transferWithAuthorization` ends in `_transfer`, which emits
 *      `Transfer(payer → payTo)` — exactly the log findUsdcTransfer accepts.
 *   2. /pay/credit funds `x402:0xpayer` keyed on that settlement hash.
 *   3. the SAME human links `0xpayer` to their tiny account and pastes the SAME
 *      hash into the deposit form. The receipt verifies — it really is a USDC
 *      transfer from their linked address to the deposit address.
 *   4. /pay/claim reserves (nobody took it) and credits AGAIN, 1:1, on `base`
 *      with counterparty='chain:base' — outside TRIAL_COUNTERPARTIES, i.e. real
 *      withdrawable money, same as the first credit's 'platform'.
 *
 * They paid once and hold the balance twice. c43 fixed which counterparty a
 * settle credit lands under; this is the same edge asking a different question,
 * and the answer had two authorities again — except here one of them wasn't
 * answering at all. Lens 11 exactly: the policy keys on `claimed_txs.tx_hash`,
 * and the audit has to cover every WRITER of a row that hash governs.
 *
 * Fix: `reserveTx`/`releaseTx` in deposits.ts (the module that owns the table),
 * called by BOTH writers. One statement, one answer.
 *
 * Recipe as ever: the REAL exported SQL and the REAL migrations against
 * node:sqlite. D1 binds ?1..?N positionally from .bind(); node:sqlite binds them
 * as NAMED parameters.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (five cycles running now). */
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const TX = '0x' + 'ab'.repeat(32)
const PAYER_ADDR = '0x' + '11'.repeat(20)
const PRICE = 2_000_000 // $2 tiny

let pay: any, dep: any, wd: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
  dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
  wd = await import(workerFile('withdrawals.ts') /* @vite-ignore */)
})

beforeEach(async () => {
  if (!present) return
  // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  db.exec(migration('0014_payments.sql'))
  db.exec(migration('0015_withdrawals.sql'))
  db.exec(migration('0021_deposit_integrity.sql'))
  db.exec(migration('0024_trial_taint.sql'))
})

/**
 * A D1 shim over the real sqlite db — enough for reserveTx/releaseTx, which are
 * the only worker functions under test here. `.run()` must report
 * meta.changes the way D1 does, because that value IS the race verdict.
 */
const d1 = () => ({
  prepare(sql: string) {
    const binds: any[] = []
    const stmt = {
      bind(...args: any[]) { binds.push(...args); return stmt },
      async run() {
        const st = db.prepare(sql)
        const r = st.run(...binds.map(b => (b === null || b === undefined ? null : b)))
        return { meta: { changes: Number(r.changes || 0) } }
      },
      async first() {
        const row = db.prepare(sql).get(...binds)
        return row ?? null
      },
      async all() { return { results: db.prepare(sql).all(...binds) } },
    }
    return stmt
  },
})

const ENV = () => ({ DB: d1(), PAYMENTS_NETWORK: 'base' })

/** The ledger row /pay/credit writes, and the one /pay/claim writes for base. */
const creditRow = (userId: string, micro: number, counterparty: string, ref: string) =>
  db.prepare('INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, ?, ?, ?)')
    .run(userId, micro, 'deposit', ref, counterparty)

const balance = (userId: string) =>
  db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get(userId).v

const reservationCount = () => db.prepare('SELECT COUNT(*) c FROM claimed_txs').get().c
const reservationOwner = () =>
  db.prepare('SELECT user_id FROM claimed_txs WHERE tx_hash = ?').get(TX)?.user_id ?? null

describe.skipIf(!present)('THE DOUBLE CREDIT: one settlement, two crediting paths', () => {
  it('OLD behaviour — the x402 credit reserved nothing, so the claim credited again', () => {
    // Non-vacuity proof: the leak must be REPRODUCIBLE with the pre-fix writes,
    // or every assertion below could pass against code that never had the bug.
    // 1. the settle funds the payer — the OLD /pay/credit, verbatim: insert only.
    creditRow(`x402:${PAYER_ADDR}`, PRICE, 'platform', TX)
    expect(reservationCount()).toBe(0)          // ← the whole bug, in one line

    // 2. the same human pastes the same hash as a deposit claim. /pay/claim's
    //    reservation is uncontested because nobody told the table about step 1.
    expect(db.prepare(dep.CLAIM_TX_SQL).run(TX, 'human', 'base').changes).toBe(1)
    creditRow('human', PRICE, 'chain:base', TX)

    // Paid $2 once, holding $4 across two accounts they control.
    expect(balance(`x402:${PAYER_ADDR}`)).toBe(PRICE)
    expect(balance('human')).toBe(PRICE)
    // And on `base` it withdraws as real USDC: no trial counterparty involved.
    expect(dep.TRIAL_COUNTERPARTIES).not.toContain('chain:base')
    expect(dep.TRIAL_COUNTERPARTIES).not.toContain('platform')
    expect(db.prepare(wd.WITHDRAW_DEBIT_SQL).run({
      1: 'human', 2: -(PRICE - 1000), 3: 'wd1', 4: 'base',
      5: 1, 6: PRICE - 1000, 7: wd.WITHDRAW_DAILY_CAP_MICRO,
    }).changes).toBe(1)
  })

  it('NEW behaviour — the settle credit reserves, so the claim is refused', async () => {
    const env = ENV()
    // 1. the settle path now reserves the hash it credits.
    const first = await dep.reserveTx(env, TX, `x402:${PAYER_ADDR}`, 'base')
    expect(first).toEqual({ ok: true, owner: `x402:${PAYER_ADDR}` })
    creditRow(`x402:${PAYER_ADDR}`, PRICE, 'platform', TX)

    // 2. the deposit claim for the same transfer loses — and is TOLD who holds it,
    //    so /pay/claim answers 409 "tx already claimed" instead of crediting.
    const second = await dep.reserveTx(env, TX, 'human', 'base')
    expect(second.ok).toBe(false)
    expect(second.owner).toBe(`x402:${PAYER_ADDR}`)
    expect(second.error).toBeUndefined()

    // One transfer, one credit, one reservation.
    expect(balance('human')).toBe(0)
    expect(reservationCount()).toBe(1)
  })

  it('a RETRY of the same credit is idempotent, not a refusal', async () => {
    // durableWrite replays /pay/credit by design (up to 4 attempts). The second
    // attempt must read as already_credited, never as "someone stole my hash".
    const env = ENV()
    const a = await dep.reserveTx(env, TX, `x402:${PAYER_ADDR}`, 'base')
    const b = await dep.reserveTx(env, TX, `x402:${PAYER_ADDR}`, 'base')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
    // owner === self is exactly what both call sites turn into ok:true.
    expect(b.owner).toBe(`x402:${PAYER_ADDR}`)
  })

  it('releaseTx hands the transfer back so a failed credit is re-claimable', async () => {
    const env = ENV()
    await dep.reserveTx(env, TX, `x402:${PAYER_ADDR}`, 'base')
    expect(reservationOwner()).toBe(`x402:${PAYER_ADDR}`)
    await dep.releaseTx(env, TX, `x402:${PAYER_ADDR}`)
    expect(reservationCount()).toBe(0)
    // …and the real deposit is claimable again — the reason release exists.
    expect((await dep.reserveTx(env, TX, 'human', 'base')).ok).toBe(true)
  })

  it('releaseTx only releases YOUR reservation, never someone else\'s', async () => {
    const env = ENV()
    await dep.reserveTx(env, TX, 'human', 'base')
    await dep.releaseTx(env, TX, `x402:${PAYER_ADDR}`)
    // Still held. Otherwise a failed credit on one account would free a hash
    // another account legitimately owns.
    expect(reservationOwner()).toBe('human')
  })

  it('reserveTx reports a DB error distinctly from losing the race', async () => {
    // The two outcomes get opposite HTTP answers (500 vs 409), so conflating
    // them would turn an outage into "your deposit was already claimed".
    const boom = {
      DB: { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) }) },
    }
    const r = await dep.reserveTx(boom, TX, 'human', 'base')
    expect(r).toEqual({ ok: false, error: 'reserve failed' })
  })

  it('a NULL network still reserves — the reservation is about the hash', async () => {
    // namedNetwork() returns null for an unstated network (c43). That must not
    // block the reservation: claimed_txs.network is a note, tx_hash is the key.
    const env = ENV()
    expect(dep.namedNetwork(env, undefined)).toBeNull()
    expect((await dep.reserveTx(env, TX, 'u1', null)).ok).toBe(true)
    expect(db.prepare('SELECT network FROM claimed_txs WHERE tx_hash = ?').get(TX).network).toBeNull()
    // …and the hash is still taken for everyone else.
    expect((await dep.reserveTx(env, TX, 'u2', 'base')).ok).toBe(false)
  })
})

describe.skipIf(!present)('/pay/credit reserves exactly the refs that are chain facts', () => {
  it('only a tx-hash-shaped deposit ref is a reservation', () => {
    // The gate is isTxHash, the same predicate /pay/claim validates with — so
    // the two paths agree on what "an on-chain transfer" even looks like.
    expect(dep.isTxHash(TX)).toBe(true)
    for (const ref of ['follow:a:b', 'faucet:d20000', '0xabc', TX.slice(0, 65), '']) {
      expect(dep.isTxHash(ref), ref).toBe(false)
    }
  })

  it('the reservation is case-insensitive on the hash', () => {
    // Hashes come from RPC receipts (lowercase) and from humans pasting
    // BaseScan's mixed case. Reserving the raw string would let 0xAB… and
    // 0xab… be two reservations for one transfer.
    const src = code('payments.ts')
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    expect(cls).toMatch(/isTxHash\(String\(ref\)\.toLowerCase\(\)\)/)
    expect(cls).toMatch(/String\(ref\)\.toLowerCase\(\)/)
    // /pay/claim lowercases too — same key space or the interlock is cosmetic.
    expect(code('deposits.ts')).toMatch(/String\(body\.txHash \|\| ""\)\.toLowerCase\(\)/)
  })

  it('an admin_credit never takes a deposit reservation', () => {
    // Rewards/grants are refs like 'follow:a:b'; nothing on-chain. And a caller
    // must not be able to burn a real tx hash by sending it as an admin_credit.
    const src = code('payments.ts')
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    expect(cls).toMatch(/kind === "deposit" && isTxHash\(/)
  })

  it('a failed INSERT releases, but a UNIQUE conflict does NOT', () => {
    // UNIQUE = the row is already there, i.e. the credit IS recorded: keep the
    // hash. Any other error = no credit landed: give it back or the payer's real
    // deposit is unclaimable forever.
    const src = code('payments.ts')
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    const cat = cls.slice(cls.indexOf('} catch (err: any) {'), cls.indexOf('INSERT OR IGNORE INTO wallets'))
    const uniqueBranch = cat.slice(0, cat.indexOf('console.log'))
    expect(uniqueBranch).not.toMatch(/releaseTx/)
    expect(cat).toMatch(/releaseTx\(env, txRef/)
  })

  it('reserves BEFORE the insert, never after', () => {
    // A reservation taken after the credit is not a gate: the concurrent claim
    // would already have read an unreserved hash and credited.
    const src = code('payments.ts')
    const cls = src.slice(src.indexOf('export class PayCreditCall'))
    expect(cls.indexOf('reserveTx(')).toBeGreaterThan(-1)
    expect(cls.indexOf('reserveTx(')).toBeLessThan(cls.indexOf('INSERT INTO ledger'))
  })
})

describe.skipIf(!present)('one reservation statement, called by both writers', () => {
  it('deposits.ts owns CLAIM_TX_SQL and nobody else writes claimed_txs', () => {
    // A second INSERT into claimed_txs is how the two paths drifted apart in the
    // first place. Every writer goes through reserveTx/releaseTx.
    for (const f of ['payments.ts', 'withdrawals.ts', 'index.ts']) {
      expect(code(f), f).not.toMatch(/INTO claimed_txs/)
      expect(code(f), f).not.toMatch(/FROM claimed_txs/)
    }
    const dsrc = code('deposits.ts')
    expect(dsrc.match(/INSERT INTO claimed_txs/g)?.length).toBe(1)
  })

  it('c60: the READER goes through this module too — claimedTxHolders', async () => {
    // ⚠️ A read is not exempt from the ownership rule, and this is the cycle that
    // tried to make it one. `/pay/reconcile-status` names a permanent blocker
    // ("this settling hash belongs to another account") off this table; if it
    // asked its own way, a monitor would describe a reservation regime that isn't
    // the one being enforced. The invariant above already covers it — payments.ts
    // may not name claimed_txs at all — so this pins the function it calls instead.
    expect(typeof dep.claimedTxHolders).toBe('function')
    const psrc = code('payments.ts')
    expect(psrc).toMatch(/claimedTxHolders\(/)

    const env = ENV()
    await dep.reserveTx(env, TX, 'someone-else', 'base')
    const held = await dep.claimedTxHolders(env, [TX])
    expect(held.get(TX)).toBe('someone-else')
    // Unreserved hashes are ABSENT, not null-valued — the caller's `if (holder)`
    // must not be satisfied by a key that merely exists.
    const other = '0x' + 'cd'.repeat(32)
    expect((await dep.claimedTxHolders(env, [TX, other])).has(other)).toBe(false)
    // Lowercased on the way in and out, and empty input asks nothing at all.
    expect((await dep.claimedTxHolders(env, [TX.toUpperCase().replace('0X', '0x')])).get(TX)).toBe('someone-else')
    expect((await dep.claimedTxHolders(env, [])).size).toBe(0)
    expect((await dep.claimedTxHolders(env, ['', null as any, undefined as any])).size).toBe(0)

    // …and an all-empty batch asks NOTHING. `IN ('')` matches nothing anyway, so
    // this is not about the answer — it is about a monitor-polled path not firing a
    // statement whose result is knowable without it. Rows without a settling hash
    // are the common case in this queue (that is what "unknown" often means).
    let asked = 0
    const real2 = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => { asked++; return real2(sql) }
    await dep.claimedTxHolders(env, ['', null as any, undefined as any])
    expect(asked).toBe(0)
  })

  it('c60: batched, not per-row — and CHUNKED under D1\'s parameter cap', async () => {
    // Two properties of a function on a POLLED path, and the second is the one this
    // cycle got wrong first. `/pay/reconcile-status` scans up to STATUS_SCAN_LIMIT
    // rows; D1 caps bound parameters per statement, so a single `IN (…)` over 200
    // hashes fails on the DEEPEST queues only — exactly when the report matters —
    // and this function's failure mode is silence. 50 is the house chunk.
    const env: any = ENV()
    await dep.reserveTx(env, TX, 'u1', 'base')
    const seen: string[] = []
    const real = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => { seen.push(sql); return real(sql) }

    // A batch that fits: one statement for many hashes, never one per hash.
    const eight = Array.from({ length: 8 }, (_, i) => '0x' + `${i}`.padEnd(64, 'e'))
    expect((await dep.claimedTxHolders(env, [TX, ...eight, TX])).get(TX)).toBe('u1')
    expect(seen.length).toBe(1)
    // Duplicates collapse — the caller passes raw row values.
    expect(seen[0].match(/\?/g)!.length).toBe(9)

    // A batch that does not fit: chunked, and every chunk stays within the cap.
    seen.length = 0
    const many = Array.from({ length: 200 }, (_, i) => '0x' + String(i).padStart(64, 'a'))
    const held = await dep.claimedTxHolders(env, [...many, TX])
    expect(held.get(TX)).toBe('u1')
    expect(seen.length).toBe(Math.ceil(201 / dep.CLAIMED_TX_LOOKUP_CHUNK))
    for (const sql of seen) expect(sql.match(/\?/g)!.length).toBeLessThanOrEqual(dep.CLAIMED_TX_LOOKUP_CHUNK)
    expect(dep.CLAIMED_TX_LOOKUP_CHUNK).toBeLessThanOrEqual(100)
  })

  it('c60: an unreadable table under-reports, even when prepare() itself throws', async () => {
    // A failure must say "nothing is claimed", not accuse every row — the
    // alternative pages an operator about a whole queue on a storage blip.
    // ⚠️ `prepare()` is what throws for a missing table on some drivers, so a guard
    // wrapped only around the await is no guard at all. This test found that.
    const atPrepare: any = { DB: { prepare: () => { throw new Error('D1_ERROR: no such table') } } }
    expect((await dep.claimedTxHolders(atPrepare, [TX])).size).toBe(0)

    const atAll: any = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: storage') } }) }) } }
    expect((await dep.claimedTxHolders(atAll, [TX])).size).toBe(0)

    // And a partial failure keeps what it did read: one bad chunk must not erase
    // the blockers the others found.
    const env: any = ENV()
    await dep.reserveTx(env, TX, 'u1', 'base')
    const real = env.DB.prepare.bind(env.DB)
    let n = 0
    env.DB.prepare = (sql: string) => {
      if (n++ === 0) throw new Error('D1_ERROR: storage')
      return real(sql)
    }
    const many = Array.from({ length: 60 }, (_, i) => '0x' + String(i).padStart(64, 'b'))
    expect((await dep.claimedTxHolders(env, [...many, TX])).get(TX)).toBe('u1')
  })

  it('PayClaimCall delegates instead of keeping its own copy', () => {
    // Behaviour-preserving: same statement, same race verdict, one implementation.
    const dsrc = code('deposits.ts')
    const cls = dsrc.slice(dsrc.indexOf('export class PayClaimCall'))
    expect(cls).toMatch(/reserveTx\(env, txHash, String\(userId\), network\)/)
    expect(cls).toMatch(/releaseTx\(env, txHash, String\(userId\)\)/)
    // The old inline reserve+release is gone from the handler.
    expect(cls).not.toMatch(/CLAIM_TX_SQL/)
    expect(cls).not.toMatch(/DELETE FROM claimed_txs/)
  })

  it('reserveTx uses the exported CLAIM_TX_SQL the migration constrains', () => {
    // The ON CONFLICT DO NOTHING + PRIMARY KEY pair is what makes the write the
    // verdict. A plain INSERT would throw instead of reporting 0 changes.
    expect(dep.CLAIM_TX_SQL).toMatch(/ON CONFLICT\(tx_hash\) DO NOTHING/)
    expect(migration('0021_deposit_integrity.sql')).toMatch(/tx_hash TEXT PRIMARY KEY/)
    const dsrc = code('deposits.ts')
    const fn = dsrc.slice(dsrc.indexOf('export async function reserveTx'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/CLAIM_TX_SQL/)
  })

  it('the migration already treated x402 credits as claims (the invariant was written down)', () => {
    // 0021 backfilled claimed_txs from EVERY hash-shaped deposit ref, x402
    // settle credits included — so the table has always considered them claims.
    // Only the WRITER never told it about new ones. This test pins that reading.
    db.exec(`INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
             VALUES ('x402:${PAYER_ADDR}', ${PRICE}, 'deposit', '${TX}', 'platform')`)
    db.exec(migration('0021_deposit_integrity.sql'))
    expect(reservationOwner()).toBe(`x402:${PAYER_ADDR}`)
  })
})
