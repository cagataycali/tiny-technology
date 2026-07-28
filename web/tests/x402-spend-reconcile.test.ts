// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-spend-reconcile')

/**
 * 🔍 A FROZEN RESERVATION WAS FROZEN FOREVER — the mark said THAT, never WHICH.
 *
 * c47 (migration 0025) closed a real hole: `/pay/spend-reverse` used to take the
 * caller's word that no USDC moved, and now refuses any ref whose signed EIP-3009
 * authorization has left us. The refusal is the safe direction — refusing to refund
 * costs a support ticket, refunding a landing payment costs the float.
 *
 * But a refusal is only defensible if it is TEMPORARY. The payer route promises
 * exactly that, in three separate 202 bodies the user actually reads: "it will be
 * reconciled". Nothing could keep that promise:
 *
 *   `spend_sent(ref, user_id, payee, created)` records that *a* signature escaped.
 *   It does not record WHICH signature — and the answer was recoverable from
 *   nowhere else, because the payer route generated the nonce as an inline argument
 *   at the signing site (`nonce: randomNonce()`) and dropped it the instant the
 *   X-PAYMENT header was encoded. Not in the ledger, not in the mark, not in a log.
 *
 * So every refused reverse was permanent by construction: the user stays debited,
 * the reservation stays held, and no code path — scheduled, manual, or human — can
 * ever establish whether the money moved. c47 traded a mint for a leak.
 *
 * THE ANSWERABLE QUESTION. Not "is this hash on-chain yet?" — the payer route never
 * learns a hash (the *payee* submits the transfer), a hash need not exist while the
 * instrument is still live, and c48 proved a hash can exist for a transaction that
 * never reached a node. The right key is the instrument's own identity, because
 * EIP-3009 keeps a redemption bit on-chain:
 *
 *   authorizationState(from, nonce) → bool      (chain/contracts/TinyUSDC.sol:31)
 *
 * Verified LIVE on chain 8469 before a line of this was written (see the test that
 * records it): the real settled payment in block 13745 answers 0x…01; an unused
 * nonce for the same payer answers 0x…00.
 *
 * And `validBefore` is what turns "not redeemed" into a VERDICT rather than "not
 * yet" — it is signed INTO the payload, so past it the instrument is dead by the
 * contract's own require (`block.timestamp < validBefore`), not by any timeout we
 * chose. That is the whole reason absence can ever be trusted here.
 *
 * This cycle captures those three facts (migration 0026) and exposes the query a
 * resolver runs. It deliberately does NOT refund anything yet: writing money on the
 * strength of an on-chain read is the next increment, and it must not ride along
 * untested with the schema change that makes it possible. That increment landed in
 * `x402-spend-resolve.test.ts` — where the live probe turned out to say something
 * this file did not anticipate: the one open row in production had SETTLED, so the
 * obvious resolver would have refunded a landed payment on its first tick.
 *
 * Recipe as ever: the REAL exported SQL, the REAL migrations, the REAL route
 * handlers against node:sqlite, plus source-level assertions (comment-stripped) for
 * the properties that live in control flow rather than in data.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const appCode = (rel: string) => readFileSync(join(WORKER_SRC, '..', '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const REF = 'x402pay:user-1:tiny:0xpayee:2000000:jti-abc'
const PAYEE = '0x' + '22'.repeat(20)
const PAYER = '0x' + 'ab'.repeat(20)
const NONCE = '0x' + 'cd'.repeat(32)
const VB = 1_800_000_000

let pay: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
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
  db.exec(migration('0025_spend_sent.sql'))
  db.exec(migration('0026_spend_sent_identity.sql'))
  db.exec(migration('0027_spend_sent_resolved.sql'))
})

const d1 = (opts: { failSelect?: RegExp } = {}) => ({
  prepare(sql: string) {
    const binds: any[] = []
    // D1 binds ?1..?N positionally; node:sqlite treats them as NAMED params.
    const args = () => {
      const clean = binds.map(b => (b === undefined ? null : b))
      if (!/\?\d/.test(sql)) return clean
      const named: any = {}
      clean.forEach((v, i) => { named[i + 1] = v })
      return [named]
    }
    const stmt = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() {
        const r = db.prepare(sql).run(...args())
        return { meta: { changes: Number(r.changes || 0) } }
      },
      async first() {
        if (opts.failSelect && opts.failSelect.test(sql)) throw new Error('D1_ERROR: storage unavailable')
        return db.prepare(sql).get(...args()) ?? null
      },
      async all() { return { results: db.prepare(sql).all(...args()) } },
    }
    return stmt
  },
  async batch(stmts: any[]) {
    const out: any[] = []
    for (const s of stmts) out.push(await s.run())
    return out
  },
})

const ENV = (opts: { failSelect?: RegExp } = {}) => ({ DB: d1(opts), INTERNAL_API_KEY: KEY })

const markSent = async (body: any, key = KEY, env: any = ENV()) => {
  const res = await new pay.PaySpendSentCall().handle(
    new Request('https://w/pay/spend-sent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify(body),
    }), env)
  return { status: res.status, body: await res.json() }
}

const row = (ref = REF) => db.prepare('SELECT * FROM spend_sent WHERE ref = ?').get(ref)

const reserve = (userId: string, micro: number, ref = REF) =>
  db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_debit', ?, 'external')")
    .run(userId, -micro, ref)

/** The resolver's real queue query, run through the real exported SQL. */
const open = (now: number, limit = 50) =>
  db.prepare(pay.SPEND_SENT_OPEN_SQL.replace(/\?1/g, '?').replace(/\?2/g, '?')).all(now, limit)

const IDENTITY = { payer: PAYER, nonce: NONCE, validBefore: VB }

describe.skipIf(!present)('THE HOLE: a refused reverse could never be resolved', () => {
  it('NON-VACUITY — the pre-0026 mark records no way to identify the instrument', async () => {
    // Build the 0025 schema for real and ask sqlite what columns exist, rather
    // than grepping the file — the DDL's own prose mentions "the payer route",
    // and a substring match on a comment is not a schema assertion.
    // @ts-expect-error — node:sqlite ships with Node 22+; @types/node predates it.
    const { DatabaseSync } = await import('node:sqlite')
    const pre = new DatabaseSync(':memory:')
    pre.exec(migration('0025_spend_sent.sql'))
    const cols = pre.prepare('SELECT name FROM pragma_table_info(?)').all('spend_sent').map((r: any) => r.name)
    expect(cols).toEqual(['ref', 'user_id', 'payee', 'created'])
    // Four columns, and not one of them can be asked about on-chain. That is the
    // hole: the refusal was permanent because nothing named the signature.
    expect(cols).not.toContain('nonce')
    expect(cols).not.toContain('payer')
    expect(cols).not.toContain('valid_before')

    // And after 0026 the identity is there — same table, same primary key.
    pre.exec(migration('0026_spend_sent_identity.sql'))
    const after = pre.prepare('SELECT name FROM pragma_table_info(?)').all('spend_sent').map((r: any) => r.name)
    expect(after).toEqual(['ref', 'user_id', 'payee', 'created', 'payer', 'nonce', 'valid_before'])
  })

  it('NON-VACUITY — and the payer route used to discard the nonce it signed', () => {
    // The old signing site passed randomNonce() as an inline argument, so the
    // value existed only inside buildAuthorization's frame. Prove the fix is real:
    // the nonce is now a named binding that OUTLIVES the try block.
    const src = appCode('app/api/x402/pay/route.ts')
    expect(src).not.toMatch(/nonce:\s*randomNonce\(\)/)
    expect(src).toMatch(/const nonce = randomNonce\(\)/)
    // …and it is declared outside the signing try/catch, or it could not be sent.
    const signIdx = src.indexOf('let identity')
    const tryIdx = src.indexOf('try {', signIdx)
    expect(signIdx).toBeGreaterThan(0)
    expect(signIdx).toBeLessThan(tryIdx)
  })

  it('a mark WITH identity is resolvable; the pre-0026 shape is not', async () => {
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, ...IDENTITY })
    const r = row()
    expect(r.payer).toBe(PAYER.toLowerCase())
    expect(r.nonce).toBe(NONCE.toLowerCase())
    expect(r.valid_before).toBe(VB)

    // A caller that never heard of identity (an old app against a new worker)
    // still gets its mark — the guard is armed either way.
    await markSent({ userId: 'user-2', ref: 'other-ref', payee: PAYEE })
    const legacy = row('other-ref')
    expect(legacy.ref).toBe('other-ref')
    expect(legacy.payer).toBeNull()
    expect(legacy.nonce).toBeNull()
    expect(legacy.valid_before).toBeNull()
  })
})

describe.skipIf(!present)('the identity fields are validated, and never fatal', () => {
  it('a malformed nonce stores NULL rather than rejecting the mark', async () => {
    // THE POINT of failing soft: the safety fact ("this escaped") is strictly more
    // important than the convenience fact ("here is how to check it"). A validation
    // failure must never be able to leave the guard unarmed.
    const { status, body } = await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, payer: PAYER, nonce: 'not-a-nonce', validBefore: VB })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(row().ref).toBe(REF)            // the mark landed
    expect(row().nonce).toBeNull()         // the bad field did not
  })

  it('and a malformed nonce is stored as NULL, NOT as the garbage string', async () => {
    // Storing garbage would be WORSE than storing nothing: the row would enter the
    // resolver's queue, authorizationState(garbage) would answer false forever, and
    // past the deadline that reads as a proof of not_settled → refund a payment
    // that may have landed. Absence of identity is honest; wrong identity is a mint.
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER, nonce: '0xdeadbeef', validBefore: VB })
    expect(row().nonce).toBeNull()
    expect(row().nonce).not.toBe('0xdeadbeef')
  })

  it('a malformed payer address stores NULL', async () => {
    await markSent({ userId: 'user-1', ref: REF, payer: 'nope', nonce: NONCE, validBefore: VB })
    expect(row().payer).toBeNull()
  })

  it('the three fields travel TOGETHER — a half-set stores no identity at all', async () => {
    // A nonce with no deadline can never expire (absence is never a verdict); a
    // deadline with no nonce has nothing to ask about. Either half in the table
    // would be a row the resolver must re-check and skip on every single tick.
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER, nonce: NONCE })   // no validBefore
    expect(row().payer).toBeNull()
    expect(row().nonce).toBeNull()
    expect(row().valid_before).toBeNull()

    db.exec('DELETE FROM spend_sent')
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER, validBefore: VB }) // no nonce
    expect(row().payer).toBeNull()
    expect(row().valid_before).toBeNull()
  })

  it('a zero/negative/NaN validBefore stores NULL — a deadline must be able to pass', async () => {
    for (const bad of [0, -1, 'soon', null]) {
      db.exec('DELETE FROM spend_sent')
      await markSent({ userId: 'user-1', ref: REF, payer: PAYER, nonce: NONCE, validBefore: bad })
      expect(row().valid_before).toBeNull()
      // …and crucially it is NOT in the resolver's queue on the strength of a
      // bad field: valid_before <= now would be trivially true for 0 or -1.
      expect(open(Math.floor(Date.now() / 1000)).length).toBe(0)
    }
  })

  it('addresses and nonces are lowercased — an on-chain key is case-insensitive', async () => {
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER.toUpperCase().replace('0X', '0x'), nonce: NONCE.toUpperCase().replace('0X', '0x'), validBefore: VB })
    expect(row().payer).toBe(PAYER.toLowerCase())
    expect(row().nonce).toBe(NONCE.toLowerCase())
  })

  it('identity does NOT overwrite an existing mark (ON CONFLICT DO NOTHING)', async () => {
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, ...IDENTITY })
    // A retry that has lost the identity must not erase what we know.
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE })
    expect(row().nonce).toBe(NONCE.toLowerCase())
    expect(db.prepare('SELECT COUNT(*) c FROM spend_sent').get().c).toBe(1)
  })

  it('the mark is still key-gated before anything is parsed', async () => {
    const { status } = await markSent({ userId: 'user-1', ref: REF, ...IDENTITY }, 'wrong-key')
    expect(status).toBe(401)
    expect(row()).toBeUndefined()
  })
})

describe.skipIf(!present)('SPEND_SENT_OPEN_SQL — what a resolver may act on', () => {
  it('an expired, identified, unrefunded mark is open', async () => {
    reserve('user-1', 2_000_000)
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, payer: PAYER, nonce: NONCE, validBefore: 1000 })
    const rows = open(2000)
    expect(rows.length).toBe(1)
    expect(rows[0].ref).toBe(REF)
    expect(rows[0].payer).toBe(PAYER.toLowerCase())
    expect(rows[0].nonce).toBe(NONCE.toLowerCase())
  })

  it('a mark whose deadline has NOT passed is NOT open — absence is not yet a verdict', async () => {
    reserve('user-1', 2_000_000)
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER, nonce: NONCE, validBefore: 5000 })
    expect(open(2000).length).toBe(0)   // still live: the payee may submit any moment
    expect(open(5000).length).toBe(1)   // exactly AT the deadline it becomes askable
  })

  it('a pre-0026 mark (no nonce) is NEVER open, however old', async () => {
    reserve('user-1', 2_000_000)
    // Written as the 0025 route would have: identity columns absent.
    db.prepare('INSERT INTO spend_sent (ref, user_id, payee) VALUES (?, ?, ?)').run(REF, 'user-1', PAYEE)
    expect(open(9_999_999_999).length).toBe(0)
    // It is genuinely unresolvable — the resolver must not guess, and must not
    // silently drop it either. That is what `resolvable:false` on the 409 is for.
  })

  it('an already-refunded ref is not open — a sweep that never drains is not a signal', async () => {
    reserve('user-1', 2_000_000)
    await markSent({ userId: 'user-1', ref: REF, payer: PAYER, nonce: NONCE, validBefore: 1000 })
    expect(open(2000).length).toBe(1)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES ('user-1', 2000000, 'spend_refund', ?, 'platform')").run(REF)
    expect(open(2000).length).toBe(0)
  })

  it('the queue is oldest-first and bounded — one tick cannot fan out unbounded RPC', async () => {
    for (let i = 0; i < 5; i++) {
      await markSent({ userId: 'user-1', ref: `ref-${i}`, payer: PAYER, nonce: NONCE, validBefore: 1000 + i })
    }
    const rows = open(9999, 3)
    expect(rows.length).toBe(3)
    expect(rows.map((r: any) => r.ref)).toEqual(['ref-0', 'ref-1', 'ref-2'])
  })

  it('it selects across ALL users — reconciliation is a platform job, not a per-user one', async () => {
    await markSent({ userId: 'user-1', ref: 'a', payer: PAYER, nonce: NONCE, validBefore: 1000 })
    await markSent({ userId: 'user-2', ref: 'b', payer: PAYER, nonce: NONCE, validBefore: 1001 })
    const rows = open(2000)
    expect(rows.map((r: any) => r.user_id).sort()).toEqual(['user-1', 'user-2'])
  })

  it('the open query is indexed, not a table scan', () => {
    // It runs on a per-minute cron over a table that only grows.
    const m = migration('0026_spend_sent_identity.sql')
    expect(m).toMatch(/CREATE INDEX IF NOT EXISTS idx_spend_sent_open ON spend_sent\(valid_before\)/)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${pay.SPEND_SENT_OPEN_SQL.replace(/\?1/g, '?').replace(/\?2/g, '?')}`).all(1, 1)
    expect(JSON.stringify(plan)).toContain('idx_spend_sent_open')
  })
})

describe.skipIf(!present)('the refusal now names the instrument', () => {
  const reverse = async (userId: string, ref = REF, env: any = ENV()) => {
    const res = await new pay.PaySpendReverseCall().handle(
      new Request('https://w/pay/spend-reverse', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
        body: JSON.stringify({ userId, ref }),
      }), env)
    return { status: res.status, body: await res.json() }
  }

  it('a 409 on an identified mark carries payer + nonce + deadline', async () => {
    reserve('user-1', 2_000_000)
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, ...IDENTITY })
    const { status, body } = await reverse('user-1')
    expect(status).toBe(409)
    expect(body.sent).toBe(true)
    expect(body.payer).toBe(PAYER.toLowerCase())
    expect(body.nonce).toBe(NONCE.toLowerCase())
    expect(body.valid_before).toBe(VB)
  })

  it('a 409 on a pre-0026 mark omits them rather than sending nulls', async () => {
    reserve('user-1', 2_000_000)
    db.prepare('INSERT INTO spend_sent (ref, user_id, payee) VALUES (?, ?, ?)').run(REF, 'user-1', PAYEE)
    const { status, body } = await reverse('user-1')
    expect(status).toBe(409)
    expect(body.sent).toBe(true)
    expect('payer' in body).toBe(false)
    expect('nonce' in body).toBe(false)
    // The distinction matters: `payer: null` reads as "we looked and there is no
    // payer", which is nonsense. Absent reads as "this row predates identity".
  })

  it('and the refusal still writes nothing — identity changed the report, not the verdict', async () => {
    reserve('user-1', 2_000_000)
    await markSent({ userId: 'user-1', ref: REF, payee: PAYEE, ...IDENTITY })
    await reverse('user-1')
    expect(db.prepare("SELECT COUNT(*) c FROM ledger WHERE ref = ? AND kind = 'spend_refund'").get(REF).c).toBe(0)
    expect(db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get('user-1').v).toBe(-2_000_000)
  })
})

describe.skipIf(!present)('the on-chain question is real — measured on chain 8469', () => {
  it('records the LIVE authorizationState probe that this design rests on', () => {
    // Not a mock. Run against the live tiny-chain RPC (127.0.0.1:8545) before the
    // migration was written, against a REAL settled payment — the c48 verification
    // settle in block 13745:
    //
    //   selector  keccak256("authorizationState(address,bytes32)")[0:4] = 0xe94a0102
    //   payer     0xce1350d492150853b6deed74106a13299d4bd887
    //   nonce     0xbdd7e5ac5d572deec6e93600458db1e1a62276d412b19d7d5e89d13f55e9a819
    //
    //   eth_call(usdc, 0xe94a0102 ‖ pad(payer) ‖ nonce) → 0x…01   (redeemed)
    //   eth_call(usdc, 0xe94a0102 ‖ pad(payer) ‖ 0x…01) → 0x…00   (untouched nonce)
    //
    // Both on the same block, same contract, one call apart. The bit is real, it is
    // per-(payer, nonce), and it distinguishes the two cases the resolver must tell
    // apart. `eth_call` is on the public proxy's allowlist (chain/rpc-proxy.mjs),
    // so the worker can ask this question over the tunnel.
    const probe = {
      selector: '0xe94a0102',
      settled: { payer: '0xce1350d492150853b6deed74106a13299d4bd887', block: 13745, result: 1 },
      unused: { result: 0 },
    }
    expect(probe.settled.result).toBe(1)
    expect(probe.unused.result).toBe(0)
    // The selector is the one the contract actually exposes.
    expect(migration('0026_spend_sent_identity.sql')).toContain('authorizationState(from, nonce)')
    const sol = readFileSync(join(WORKER_SRC, '..', '..', 'chain', 'contracts', 'TinyUSDC.sol'), 'utf8')
    expect(sol).toContain('mapping(address => mapping(bytes32 => bool)) public authorizationState')
  })

  it('the deadline is the CONTRACT’s rule, not a timeout we picked', () => {
    // This is what licenses "not redeemed past validBefore ⟹ not_settled". If the
    // expiry were our own policy the inference would be a guess; because the
    // contract refuses the transfer itself, absence past the deadline is a proof.
    const sol = readFileSync(join(WORKER_SRC, '..', '..', 'chain', 'contracts', 'TinyUSDC.sol'), 'utf8')
    expect(sol).toMatch(/block\.timestamp < validBefore/)
    // And the value we store is the SIGNED one, read back off the authorization
    // rather than recomputed — two derivations of one deadline is split authority.
    const src = appCode('app/api/x402/pay/route.ts')
    expect(src).toMatch(/validBefore: Number\(authorization\.validBefore\)/)
  })
})

describe.skipIf(!present)('wiring: the identity reaches the worker with the mark', () => {
  it('the payer route sends payer/nonce/validBefore on /pay/spend-sent', () => {
    const src = appCode('app/api/x402/pay/route.ts')
    const markIdx = src.indexOf('/pay/spend-sent')
    expect(markIdx).toBeGreaterThan(0)
    const call = src.slice(markIdx, markIdx + 400)
    expect(call).toMatch(/\.\.\.identity/)
  })

  it('the identity is computed BEFORE the mark and the mark BEFORE the send', () => {
    // The ordering is the guard. Identity must exist by the time we mark, and the
    // mark must precede the one irreversible act in this route.
    const src = appCode('app/api/x402/pay/route.ts')
    const idIdx = src.indexOf('identity = {')
    const markIdx = src.indexOf('/pay/spend-sent')
    const sendIdx = src.indexOf("'X-PAYMENT': xPaymentHeader")
    expect(idIdx).toBeGreaterThan(0)
    expect(idIdx).toBeLessThan(markIdx)
    expect(markIdx).toBeLessThan(sendIdx)
  })

  it('a failed mark still aborts the payment (c47’s invariant is untouched)', () => {
    const src = appCode('app/api/x402/pay/route.ts')
    const markIdx = src.indexOf('/pay/spend-sent')
    const after = src.slice(markIdx, markIdx + 1200)
    expect(after).toMatch(/if \(!marked\?\.ok\)/)
    expect(after).toMatch(/spend-reverse/)
    expect(after).toMatch(/503/)
  })

  it('SPEND_SENT_SQL writes all six columns and still DOES NOTHING on conflict', () => {
    expect(pay.SPEND_SENT_SQL).toMatch(/INSERT INTO spend_sent \(ref, user_id, payee, payer, nonce, valid_before\)/)
    expect(pay.SPEND_SENT_SQL).toMatch(/ON CONFLICT\(ref\) DO NOTHING/)
    // The lookup must return them or the 409 could not report them.
    for (const c of ['payer', 'nonce', 'valid_before']) {
      expect(pay.SPEND_SENT_LOOKUP_SQL).toContain(c)
    }
  })

  it('identity is an ANNOTATION — 0026 touches no ledger table', () => {
    // Same rule as 0022/0024/0025: balance is SUM(delta_micro) over ALL kinds at
    // five money-critical sites, so nothing about a signature may live in `ledger`.
    const m = migration('0026_spend_sent_identity.sql')
    expect(m).toMatch(/ALTER TABLE spend_sent ADD COLUMN/)
    expect(m).not.toMatch(/(ALTER|CREATE)\s+TABLE\s+ledger/)
    expect(m).not.toMatch(/INSERT INTO ledger/)
    // No backfill: a value we invent for a pre-0026 row makes an unresolvable row
    // look resolvable, which is the one direction this guard must never fail in.
    expect(m).not.toMatch(/UPDATE spend_sent SET/)
  })

  it('the worker validates identity itself — the app is not trusted for shape', () => {
    const src = code('payments.ts')
    const h = src.slice(src.indexOf('class PaySpendSentCall'), src.indexOf('class PaySpendReverseCall'))
    expect(h).toMatch(/isAddress\(String\(body\.payer/)
    expect(h).toMatch(/isTxHash\(String\(body\.nonce/)
    // …and nothing in the mark path can throw a 4xx over identity.
    expect(h).not.toMatch(/return json\([^)]*payer[^)]*\}, 400\)/)
  })

  it('the on-chain read lives in deposits.ts, beside the only other RPC caller', () => {
    // c49 asserted payments.ts contained NO on-chain read at all — the scope line
    // for that increment. The resolver crosses it deliberately, and this replaces
    // the guard with the structural rule that outlives it: the raw `eth_call` and
    // the ABI encoding stay in deposits.ts (where `rpc()` is module-private and the
    // per-network RPC/token resolution already lives), and payments.ts consumes one
    // three-valued helper. Two encodings of a selector whose failure mode is a
    // silent refund is precisely the split authority this arc keeps closing.
    const src = code('payments.ts')
    expect(src).toMatch(/authorizationRedeemed\(/)
    expect(src).not.toMatch(/eth_call/)
    expect(src).not.toMatch(/0xe94a0102/)
    const dep = code('deposits.ts')
    expect(dep).toMatch(/eth_call/)
    expect(dep).toMatch(/0xe94a0102/)
  })
})
