// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-spend-reverse-sent')

/**
 * 🖊️→💸 "NO USDC MOVED" WAS PURELY THE CALLER'S WORD — /pay/spend-reverse had no
 * way to know, and it is the one money path whose entire safety argument lived
 * OUTSIDE the worker.
 *
 * `/pay/spend` reserves a user's balance so the platform hot wallet can front real
 * USDC to an x402 service. `/pay/spend-reverse` undoes that reservation, and its
 * own docstring said "ONLY call this when NO USDC moved". Everything it actually
 * checked:
 *
 *   1. spend_debit / spend_reimburse rows exist for the ref
 *   2. no spend_refund row exists yet   (idempotency, not safety)
 *   3. the caller holds the internal key
 *
 * None of the three is about settlement. Any holder of INTERNAL_API_KEY — or any
 * future caller written by someone who read the summary line and not the
 * docstring — could reverse a spend whose signed authorization was already on its
 * way to the payee. The platform fronts real USDC on-chain AND hands the user
 * their money back: an unrecoverable mint, in the direction that costs us twice.
 *
 * c46 fixed all three existing callers (refund only on a positive
 * `settlement: not_settled` from our own receiver). That is exactly what makes
 * this worth adding rather than redundant: it stops being a second copy of a
 * correct caller's reasoning and becomes the LAST line of defence, against a
 * caller nobody has written yet.
 *
 * WHAT IS KNOWABLE, AND WHERE THE LINE FALLS
 *
 * An EIP-3009 `transferWithAuthorization` signature is a BEARER instrument. Once
 * it leaves us, anyone holding it can submit it — the payee, the facilitator, an
 * observer — at any time within its validity window. So "did it settle?" is
 * unanswerable from the worker, and unanswerable even on-chain at the instant of
 * asking (a pending tx can confirm a block later). But "COULD it have settled?"
 * has a crisp answer the payer knows first-hand and cannot be wrong about: did we
 * hand the signed header to anyone?
 *
 *   before the send → nothing can settle. Reverse freely.
 *   after the send  → it may settle at any time. Never auto-reverse.
 *
 * Hence `spend_sent` (migration 0025), written by the payer route in the same
 * breath as the send, which a reverse must find ABSENT. Third money path, same
 * doctrine as withdraw's "txHash set → never refund" and c46's inbound
 * classifier.
 *
 * Recipe as ever: the REAL exported SQL, the REAL migrations and the REAL route
 * handlers against node:sqlite. D1 binds ?1..?N positionally from .bind();
 * node:sqlite binds them as NAMED parameters.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (six cycles running now). */
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const appCode = (rel: string) => readFileSync(join(WORKER_SRC, '..', '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const KEY = 'internal-test-key-0123456789'
const REF = 'x402pay:user-1:base:0xpayee:2000000:jti-abc'
const PAYEE = '0x' + '22'.repeat(20)

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
  // 0026 adds the instrument's identity (payer/nonce/valid_before). Applied here
  // because SPEND_SENT_SQL now names those columns — the real statement against a
  // pre-0026 schema would throw, which is precisely the drift this suite exists to
  // catch. See x402-spend-reconcile.test.ts for what the columns are FOR.
  db.exec(migration('0026_spend_sent_identity.sql'))
})

/**
 * A D1 shim over the real sqlite db. `.run()` reports meta.changes the way D1
 * does, and `.batch()` runs statements in order — the reverse writes its
 * compensating rows through batch(), so a shim without it would test nothing.
 */
const d1 = (opts: { failSelect?: RegExp } = {}) => ({
  prepare(sql: string) {
    const binds: any[] = []
    // D1 binds ?1..?N positionally from .bind(); node:sqlite binds them as NAMED
    // parameters, so numbered SQL has to be re-shaped into { 1: …, 2: … }.
    const args = () => {
      const clean = binds.map(b => (b === undefined ? null : b))
      if (!/\?\d/.test(sql)) return clean
      const named: any = {}
      clean.forEach((v, i) => { named[i + 1] = v })
      return [named]
    }
    const stmt = {
      _sql: sql,
      get _binds() { return binds },
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

const req = (body: any, key: string = KEY) => new Request('https://w/pay/spend-reverse', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-key': key },
  body: JSON.stringify(body),
})

/** The reservation /pay/spend writes: a debit on the user. */
const reserve = (userId: string, micro: number, ref = REF) =>
  db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_debit', ?, 'external')")
    .run(userId, -micro, ref)

const balance = (userId: string) =>
  db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get(userId).v

const refundRows = (ref = REF) =>
  db.prepare("SELECT COUNT(*) c FROM ledger WHERE ref = ? AND kind = 'spend_refund'").get(ref).c

const reverse = async (userId: string, ref = REF, env: any = ENV(), settlement?: string) => {
  const res = await new pay.PaySpendReverseCall().handle(req({ userId, ref, ...(settlement ? { settlement } : {}) }), env)
  return { status: res.status, body: await res.json() }
}

const markSent = async (userId: string, ref = REF, payee: string | undefined = PAYEE, env: any = ENV()) => {
  const res = await new pay.PaySpendSentCall().handle(
    new Request('https://w/pay/spend-sent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: JSON.stringify({ userId, ref, payee }),
    }), env)
  return { status: res.status, body: await res.json() }
}

describe.skipIf(!present)('THE HOLE: a reverse after the authorization left us', () => {
  it('NON-VACUITY — the pre-fix reverse succeeded on a spend that was already sent', async () => {
    // Reconstruct the OLD handler exactly: rows exist, no refund yet, key valid.
    // Nothing in it consults spend_sent, so the sent marker is irrelevant to it.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const old = async () => {
      const rows = await db.prepare(
        "SELECT user_id, delta_micro FROM ledger WHERE ref = ? AND kind IN ('spend_debit','spend_reimburse')"
      ).all(REF)
      if (!rows.length) return { ok: false }
      const done = db.prepare("SELECT id FROM ledger WHERE ref = ? AND kind = 'spend_refund' LIMIT 1").get(REF)
      if (done) return { ok: true, already_reversed: true }
      for (const e of rows) {
        db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_refund', ?, 'platform')")
          .run(e.user_id, -Number(e.delta_micro), REF)
      }
      return { ok: true, reversed_entries: rows.length }
    }
    expect(await old()).toEqual({ ok: true, reversed_entries: 1 })
    // The user is whole again while the payee holds a settleable signature.
    expect(balance('user-1')).toBe(0)
  })

  it('the fixed reverse REFUSES a sent ref, and writes no compensating row', async () => {
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const { status, body } = await reverse('user-1')
    expect(status).toBe(409)
    expect(body.sent).toBe(true)
    expect(body.ok).toBeUndefined()
    expect(refundRows()).toBe(0)
    expect(balance('user-1')).toBe(-2_000_000)   // the debit stands
  })

  it('the refusal carries reconciliation metadata, not a bare no', async () => {
    // A refusal is the start of an operator's investigation: it must say WHICH
    // payee holds the instrument and WHEN it left, or the ref is a dead end.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const { body } = await reverse('user-1')
    expect(body.ref).toBe(REF)
    expect(body.payee).toBe(PAYEE)
    expect(typeof body.sent_at).toBe('number')
    expect(String(body.error)).toMatch(/may have settled/i)
  })

  it('a DIFFERENT user cannot slip a reverse past a mark for the same ref', async () => {
    // Why spend_sent.ref is the PRIMARY KEY and not a (user, ref) pair: the fact
    // recorded is about the SIGNATURE, not about who asked for it. A per-user key
    // would reproduce the claimed_txs-vs-idx_ledger_idem mismatch 0021 had to fix
    // — a uniqueness guard keyed on one column does not interlock with an index
    // keyed on another.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const { status } = await reverse('attacker-9')
    expect(status).toBe(409)
    expect(refundRows()).toBe(0)
  })
})

describe.skipIf(!present)('the honest path is untouched — every genuinely pre-send reverse still refunds', () => {
  it('an UNSENT reservation reverses exactly as before', async () => {
    // This is the terms-changed and signing-threw case: both reverse sites in the
    // payer route sit above the send, so neither ref is ever marked.
    reserve('user-1', 2_000_000)
    const { status, body } = await reverse('user-1')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, reversed_entries: 1 })
    expect(balance('user-1')).toBe(0)
  })

  it('a reimbursement row is reversed too, unchanged', async () => {
    reserve('user-1', 2_000_000)
    db.prepare("INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'spend_reimburse', ?, 'platform')")
      .run('other', 500_000, REF)
    const { body } = await reverse('user-1')
    expect(body.reversed_entries).toBe(2)
  })

  it('a ref with no reservation still answers 404, not the new refusal', async () => {
    const { status, body } = await reverse('user-1')
    expect(status).toBe(404)
    expect(body.error).toBe('nothing to reverse')
  })

  it('the internal-key gate still runs FIRST — an unauthorized caller learns nothing', async () => {
    // Ordering matters: if the sent-lookup ran first, a 409-vs-404 difference
    // would be an unauthenticated oracle on which refs exist.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const res = await new pay.PaySpendReverseCall().handle(req({ userId: 'user-1', ref: REF }, 'wrong-key-wrong-length'), ENV())
    expect(res.status).toBe(401)
    const marked = await new pay.PaySpendSentCall().handle(
      new Request('https://w/pay/spend-sent', {
        method: 'POST', headers: { 'x-internal-key': 'nope' }, body: '{}',
      }), ENV())
    expect(marked.status).toBe(401)
  })

  it('validation still precedes the gate — a missing ref is a 400', async () => {
    const res = await new pay.PaySpendReverseCall().handle(req({ userId: 'user-1' }), ENV())
    expect(res.status).toBe(400)
    const m = await new pay.PaySpendSentCall().handle(
      new Request('https://w/pay/spend-sent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
        body: JSON.stringify({ ref: REF }),
      }), ENV())
    expect(m.status).toBe(400)
  })

  it('idempotency survives: a second reverse of an unsent ref is still already_reversed', async () => {
    reserve('user-1', 2_000_000)
    expect((await reverse('user-1')).body.reversed_entries).toBe(1)
    const second = await reverse('user-1')
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ ok: true, already_reversed: true })
    expect(refundRows()).toBe(1)
    expect(balance('user-1')).toBe(0)   // not refunded twice
  })
})

describe.skipIf(!present)('the ONE override: an authorization that came back dead', () => {
  // A rejected authorization is the overwhelmingly common failure (expired between
  // quote and send, payer nonce reused). It left us, so the mark is there — but it
  // can never settle, and refusing to refund it would turn every ordinary failed
  // payment into a support ticket. So the caller may ASSERT not_settled, in the
  // shared classifier's own vocabulary.
  it('an asserted not_settled reverses a sent ref', async () => {
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const { status, body } = await reverse('user-1', REF, ENV(), 'not_settled')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, reversed_entries: 1 })
    expect(balance('user-1')).toBe(0)
  })

  it('SILENCE means refuse — the default is the safe one', async () => {
    // The whole value of the guard: a caller that has never heard of settlement
    // (the one we are defending against) cannot get a post-send refund by
    // accident. It has to knowingly say the word.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    expect((await reverse('user-1')).status).toBe(409)
    expect(refundRows()).toBe(0)
  })

  it('unknown and settled are REFUSED — only the dead-instrument verdict passes', async () => {
    // `unknown` is the exact case c46 was about: submitted, unconfirmed, may land.
    // Accepting any non-empty settlement string would re-open that hole from the
    // other end.
    for (const verdict of ['unknown', 'settled', 'none', 'not settled', 'NOT_SETTLED', 'true']) {
      db.exec('DELETE FROM ledger; DELETE FROM spend_sent')
      reserve('user-1', 2_000_000)
      await markSent('user-1')
      const { status } = await reverse('user-1', REF, ENV(), verdict)
      expect({ verdict, status }).toEqual({ verdict, status: 409 })
      expect(refundRows()).toBe(0)
    }
  })

  it('the override does not weaken the UNSENT path or its idempotency', async () => {
    reserve('user-1', 2_000_000)
    expect((await reverse('user-1', REF, ENV(), 'not_settled')).body.reversed_entries).toBe(1)
    expect((await reverse('user-1', REF, ENV(), 'not_settled')).body).toEqual({ ok: true, already_reversed: true })
    expect(refundRows()).toBe(1)
  })

  it('an override still cannot double-refund a sent ref', async () => {
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    await reverse('user-1', REF, ENV(), 'not_settled')
    await reverse('user-1', REF, ENV(), 'not_settled')
    expect(refundRows()).toBe(1)
    expect(balance('user-1')).toBe(0)
  })

  it('the asserted word is the classifier\'s own constant, not a local literal', async () => {
    // Lens 8: when a verdict is computed in one place and acted on in another, it
    // TRAVELS. A hand-typed 'not_settled' on either side is a second authority.
    const outcome = await import(join(WORKER_SRC, '..', '..', 'chain', 'settle-outcome.mjs') /* @vite-ignore */)
    expect(outcome.NOT_SETTLED).toBe('not_settled')
    expect(appCode('app/api/x402/pay/route.ts')).toContain('settlement: NOT_SETTLED')
    expect(code('payments.ts')).toContain('asserted === "not_settled"')
  })
})

describe.skipIf(!present)('the mark itself', () => {
  it('is idempotent — a retried send does not error', async () => {
    expect((await markSent('user-1')).status).toBe(200)
    expect((await markSent('user-1')).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) c FROM spend_sent WHERE ref = ?').get(REF).c).toBe(1)
  })

  it('never overwrites the first mark — the earliest crossing is the true one', async () => {
    // ON CONFLICT DO NOTHING, not an UPSERT: if a retry pointed at a different
    // payee, the ORIGINAL payee is the one holding a signature we can no longer
    // recall, so that is the fact worth keeping.
    await markSent('user-1', REF, PAYEE)
    await markSent('user-1', REF, '0x' + '99'.repeat(20))
    expect(db.prepare('SELECT payee FROM spend_sent WHERE ref = ?').get(REF).payee).toBe(PAYEE)
  })

  it('does not require the reservation to exist', async () => {
    // The mark is about a signature. Refusing to record one because a ledger
    // lookup blipped would trade a real safety fact for a consistency check
    // nothing needs — and would leave the guard unarmed at the worst moment.
    expect((await markSent('ghost', 'x402pay:ghost:base:0x0:1:zz')).status).toBe(200)
  })

  it('accepts a missing payee — the ref alone is enough to gate', async () => {
    expect((await markSent('user-1', REF, undefined)).status).toBe(200)
    reserve('user-1', 2_000_000)
    expect((await reverse('user-1')).status).toBe(409)
  })

  it('clamps the payee so a hostile caller cannot bloat the row', async () => {
    await markSent('user-1', REF, 'x'.repeat(500))
    expect(db.prepare('SELECT payee FROM spend_sent WHERE ref = ?').get(REF).payee.length).toBe(80)
  })

  it('is NOT summable as currency — it lives outside the ledger', async () => {
    // Migrations 0022 (reputation) and 0024 (trial_taint) established this:
    // balance is SUM(delta_micro) over ALL kinds at five money-critical sites, so
    // any annotation written as a ledger row inflates every balance and guard.
    reserve('user-1', 2_000_000)
    const before = balance('user-1')
    await markSent('user-1')
    expect(balance('user-1')).toBe(before)
    expect(db.prepare("SELECT COUNT(*) c FROM ledger WHERE kind LIKE '%sent%'").get().c).toBe(0)
  })
})

describe.skipIf(!present)('failure modes fail CLOSED', () => {
  it('an unreadable marker refuses the reverse rather than assuming it is safe', async () => {
    // The expensive mistake is refunding a payment that settled. If we cannot read
    // the marker we do not know the money stayed put, so 503 and let the caller
    // retry — never fall through to the refund.
    reserve('user-1', 2_000_000)
    await markSent('user-1')
    const { status, body } = await reverse('user-1', REF, ENV({ failSelect: /FROM spend_sent/ }))
    expect(status).toBe(503)
    expect(String(body.error)).toMatch(/cannot verify/i)
    expect(refundRows()).toBe(0)
  })

  it('a lookup failure blocks even an UNSENT ref — no evidence is not evidence', async () => {
    reserve('user-1', 2_000_000)
    const { status } = await reverse('user-1', REF, ENV({ failSelect: /FROM spend_sent/ }))
    expect(status).toBe(503)
    expect(refundRows()).toBe(0)
  })

  it('a sent ref that was ALREADY refunded reports both facts', async () => {
    // The pre-deploy history: a caller may have reversed a sent spend before this
    // guard existed. Answering a plain "already_reversed: true" would hide the
    // loss; answering only "sent" would hide that a refund is on the books.
    reserve('user-1', 2_000_000)
    await reverse('user-1')                 // legitimate at the time — unsent
    await markSent('user-1')                // …then the signature went out
    const { status, body } = await reverse('user-1')
    expect(status).toBe(409)
    expect(body.sent).toBe(true)
    expect(body.already_reversed).toBe(true)
    expect(refundRows()).toBe(1)            // and no second refund
  })
})

describe.skipIf(!present)('wiring — the guard is armed BEFORE the instrument leaves', () => {
  const payer = () => appCode('app/api/x402/pay/route.ts')

  it('the payer route marks sent before the X-PAYMENT fetch, not after', () => {
    const src = payer()
    const mark = src.indexOf('/pay/spend-sent')
    const send = src.indexOf("'X-PAYMENT': xPaymentHeader")
    expect(mark).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(0)
    // A mark written AFTER the send is not a gate at all: the send can succeed
    // while the mark is lost, and a later reverse would then read an unmarked ref.
    expect(mark).toBeLessThan(send)
  })

  it('the two pre-send reverse sites are still above the mark', () => {
    const src = payer()
    const mark = src.indexOf('/pay/spend-sent')
    const termsChanged = src.indexOf('terms_changed: true')
    const signFailed = src.indexOf('could not sign payment')
    expect(termsChanged).toBeGreaterThan(0)
    expect(signFailed).toBeGreaterThan(0)
    expect(termsChanged).toBeLessThan(mark)
    expect(signFailed).toBeLessThan(mark)
  })

  it('ONLY the post-send reverse asserts a settlement — the pre-send ones do not', () => {
    // A pre-send reverse needs no assertion (its ref is unmarked), and adding one
    // would spread the override to sites that have not earned it.
    const src = payer()
    const sites = src.split('/pay/spend-reverse')
    // sites[0] is the prologue; each subsequent chunk starts at a call site.
    const bodies = sites.slice(1).map(s => s.slice(0, 260))
    const asserting = bodies.filter(b => b.includes('settlement:'))
    expect(bodies.length).toBe(4)
    expect(asserting.length).toBe(1)
    expect(asserting[0]).toContain('NOT_SETTLED')
  })

  it('a failed mark aborts the payment — the header is never sent unguarded', () => {
    const src = payer()
    const guard = src.indexOf('if (!marked?.ok)')
    const send = src.indexOf("'X-PAYMENT': xPaymentHeader")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(send)
    // And it reverses, which is sound precisely because we are still pre-send.
    const after = src.slice(guard, send)
    expect(after).toContain('/pay/spend-reverse')
  })

  it('the reverse count is unchanged plus exactly the new pre-send abort', () => {
    // c46 left exactly 3 sites (terms changed, signing failed, first-party
    // not_settled). This cycle adds ONE, and it is on the pre-send side.
    const n = payer().match(/\/pay\/spend-reverse/g)?.length || 0
    expect(n).toBe(4)
  })

  it('the endpoint is registered next to the reverse it guards', () => {
    const idx = code('index.ts')
    expect(idx).toContain("router.post('/pay/spend-sent', PaySpendSentCall)")
    expect(idx).toContain('PaySpendSentCall')
  })

  it('the reverse consults spend_sent before it writes anything', () => {
    const src = code('payments.ts')
    const cls = src.slice(src.indexOf('class PaySpendReverseCall'))
    const body = cls.slice(0, cls.indexOf('\n}\n'))
    const lookup = body.indexOf('SPEND_SENT_LOOKUP_SQL')
    const write = body.indexOf('spend_refund')
    expect(lookup).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(0)
    expect(lookup).toBeLessThan(write)
  })

  it('the mark is an UPSERT-free insert on the ref alone', () => {
    expect(pay.SPEND_SENT_SQL).toContain('ON CONFLICT(ref) DO NOTHING')
    expect(pay.SPEND_SENT_SQL).not.toContain('UPDATE')
    expect(pay.SPEND_SENT_LOOKUP_SQL).toContain('WHERE ref = ?1')
    // Keyed on the ref, NOT on (user, ref) — see the cross-user test above.
    expect(pay.SPEND_SENT_LOOKUP_SQL).not.toContain('user_id = ?')
  })

  it('migration 0025 keys the table on ref and stays out of the ledger', () => {
    const sql = migration('0025_spend_sent.sql')
    expect(sql).toContain('ref     TEXT PRIMARY KEY')
    expect(sql).not.toMatch(/INSERT INTO ledger/)
    // Idempotent, like every other migration here — they are replayed on deploy.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS spend_sent')
  })
})
