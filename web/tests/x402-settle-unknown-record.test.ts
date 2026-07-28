// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { authorizationIdentity, POST } from '../app/api/x402/chat/[slug]/route'
import { asDeployment } from './_deployment'

warnIfWorkerAbsent('x402-settle-unknown-record')

/**
 * 🔍 THE RECEIVER'S UNKNOWN — the mirror-image failure, and the opposite danger.
 *
 * c46–c50 closed the PAYER side of "submitted but unconfirmed": don't reverse an
 * escaped instrument (0025), name it (0026), resolve it on a cron (0027). This is
 * the other end of the same wire, and nothing had ever recorded it.
 *
 * When OUR x402 door gets `settlement: unknown` back from the facilitator it
 * returns 402 — and Step 4, "credit the owner in the ledger", is never reached. If
 * that transaction then confirms (the LIKELY outcome: it was verified, signed,
 * accepted and broadcast; we merely stopped watching at 60s) the payer's USDC
 * lands at X402_PAY_TO and the tiny's owner is never paid for a request that
 * really was paid for. It is the exact silent creator-earnings loss `durableWrite`
 * exists to prevent twenty lines further down the same function, and the only
 * trace was a console line carrying a hash and nothing else — no payer, no nonce,
 * no slug, no price, no network. Unreplayable even by a human with the logs.
 *
 * ⚠️ AND THE PAYER'S RESOLVER CANNOT BE REUSED HERE. c50 resolves with
 * `authorizationState(payer, nonce) → bool`. On this side that bit is not enough
 * and acting on it would MINT: TinyUSDC.sol sets it in _transferWithAuthorization
 * (money moved) AND in cancelAuthorization (money did not). For the payer the
 * ambiguity is safe — true means "don't refund", we keep our float. For the
 * receiver, true would mean "credit the owner plus the platform fee" out of USDC
 * that a cancel never delivered. The events distinguish what the boolean cannot
 * (AuthorizationUsed vs AuthorizationCanceled), so proof of VALUE is a log read.
 *
 * This increment therefore RECORDS and does not credit. These tests lock the
 * recording: that it happens, that it carries everything a credit needs, that a
 * row which cannot be resolved is refused rather than stored, and that no other
 * settlement outcome writes one.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const appCode = readFileSync(join(WORKER_SRC, '..', '..', 'app', 'api', 'x402', 'chat', '[slug]', 'route.ts'), 'utf8')

const KEY = 'internal-test-key-0123456789'
const PAYER = '0x' + 'ab'.repeat(20)
const NONCE = '0x' + 'cd'.repeat(32)
const HASH = '0x' + 'ef'.repeat(32)
const PAY_TO = '0x' + '12'.repeat(20)

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
  for (const m of ['0014_payments.sql', '0028_settle_unknown.sql']) db.exec(migration(m))
})

const d1 = (opts: { failOn?: RegExp } = {}) => ({
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
    const fail = () => { if (opts.failOn?.test(sql)) throw new Error('D1_ERROR: storage unavailable') }
    const stmt = {
      bind(...a: any[]) { binds.push(...a); return stmt },
      async run() { fail(); const r = db.prepare(sql).run(...args()); return { meta: { changes: Number(r.changes || 0) } } },
      async first() { fail(); return db.prepare(sql).get(...args()) ?? null },
      async all() { fail(); return { results: db.prepare(sql).all(...args()) } },
    }
    return stmt
  },
})

/** The deployment prod runs: the self-hosted chain. */
const ENV = (opts: { failOn?: RegExp } = {}) => ({
  DB: d1(opts),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: '0x' + '4f'.repeat(20),
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
})

const mark = async (body: any, env: any = ENV(), key: string = KEY) =>
  new pay.PaySettleUnknownCall().handle(
    new Request('https://w/pay/settle-unknown', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
      body: JSON.stringify(body),
    }), env)

const OK = {
  payer: PAYER, nonce: NONCE, txHash: HASH, slug: 'acme', priceMicro: 50_000,
  valueMicro: 50_000, validBefore: 1_800_000_000, network: 'eip155:8469', payTo: PAY_TO,
}
const rows = () => db.prepare('SELECT * FROM settle_unknown').all()

describe.skipIf(!present)('the unknown is written down — with everything a later credit needs', () => {
  it('records the instrument, the tiny, the price, the chain and the hash', async () => {
    const res = await mark(OK)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, payer: PAYER, nonce: NONCE })
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      payer: PAYER, nonce: NONCE, tx_hash: HASH, slug: 'acme',
      price_micro: 50_000, value_micro: 50_000, pay_to: PAY_TO,
      valid_before: 1_800_000_000,
    })
    // 🔍 Stored as the WORKER's network name, not the CAIP-2 the caller sent:
    // every chain read in the worker takes this form (authorizationRedeemed,
    // usdcContract, rpcUrl), so the resolver never re-parses a string it could
    // get wrong. The caller may send either form.
    expect(r[0].network).toBe('tiny')
    // Unresolved on arrival — the whole point is that something must still act.
    expect(r[0].resolved).toBeNull()
    expect(r[0].resolution).toBeNull()
  })

  it('a caller that names the chain by our own short name records the same row', async () => {
    await mark({ ...OK, network: 'tiny' })
    expect(rows()[0].network).toBe('tiny')
  })

  it('the SAME instrument recorded twice is ONE row — a client retry cannot double-credit', async () => {
    await mark(OK)
    const again = await mark({ ...OK, priceMicro: 999_999 })
    expect(again.status).toBe(200)
    const r = rows()
    expect(r).toHaveLength(1)
    // First write wins: ON CONFLICT DO NOTHING, so the retry cannot rewrite the
    // price either. A row that could be re-priced by a later caller would let a
    // client dictate what the owner gets credited.
    expect(r[0].price_micro).toBe(50_000)
  })

  it('two DIFFERENT nonces from the same payer are two rows', async () => {
    await mark(OK)
    await mark({ ...OK, nonce: '0x' + '11'.repeat(32) })
    expect(rows()).toHaveLength(2)
  })

  it('the hash is OPTIONAL — a transport-failure unknown has none and must still be recorded', async () => {
    // settlePayment's catch branch reports `unknown` with NO hash: the
    // facilitator may have submitted and lost the response. That is the case
    // most in need of reconciliation, so refusing it would be exactly backwards.
    const res = await mark({ ...OK, txHash: undefined })
    expect(res.status).toBe(200)
    expect(rows()[0].tx_hash).toBeNull()
  })

  it('a MALFORMED hash stores NULL rather than itself', async () => {
    // A bogus hash is worse than none: the resolver would ask for a receipt that
    // can never exist and could read the miss as evidence of non-settlement.
    await mark({ ...OK, txHash: '0xnope' })
    expect(rows()[0].tx_hash).toBeNull()
  })

  it('an unidentifiable chain stores NULL, never a default', async () => {
    // 🔍 authorizationState and the AuthorizationUsed log are PER-CHAIN. A
    // confident answer from the wrong ledger is the worst possible input to a
    // resolver that ends in a credit, so the network must come from the
    // instrument or be absent. `namedNetwork`, never `normalizeNetwork`.
    await mark({ ...OK, network: 'eip155:999999' })
    expect(rows()[0].network).toBeNull()
    expect(code('payments.ts')).toMatch(/namedNetwork\(env, body\.network\)/)
  })

  it('base-sepolia is recorded as itself even on a tiny-chain deployment', async () => {
    await mark({ ...OK, network: 'eip155:84532' })
    expect(rows()[0].network).toBe('base-sepolia')
  })
})

describe.skipIf(!present)('an UNRESOLVABLE row is refused, not stored', () => {
  // ⚠️ THE DELIBERATE INVERSION of /pay/spend-sent. There, a mark with bad
  // identity is still stored, because the mark ITSELF is the safety fact and
  // refusing it would leave a bearer-instrument guard disarmed. Here a row has
  // exactly one purpose — to be resolved into a credit — so a row nobody can
  // resolve is not a safety net; it is a queue entry that can never be retired,
  // and a queue that cannot drain stops being an alarm (0027's lesson).
  it('no payer → 400, nothing stored', async () => {
    const res = await mark({ ...OK, payer: undefined })
    expect(res.status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('no nonce → 400, nothing stored', async () => {
    const res = await mark({ ...OK, nonce: undefined })
    expect(res.status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('a malformed payer or nonce is refused, never stored as garbage', async () => {
    expect((await mark({ ...OK, payer: 'not-an-address' })).status).toBe(400)
    expect((await mark({ ...OK, nonce: '0x123' })).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('no slug → 400: without it we cannot know WHO to credit', async () => {
    const res = await mark({ ...OK, slug: '' })
    expect(res.status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('a zero or negative price → 400: there is no unknown worth reconciling for nothing', async () => {
    expect((await mark({ ...OK, priceMicro: 0 })).status).toBe(400)
    expect((await mark({ ...OK, priceMicro: -5 })).status).toBe(400)
    expect((await mark({ ...OK, priceMicro: 'abc' })).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('the payer is lowercased — one instrument cannot become two rows by case', async () => {
    await mark({ ...OK, payer: PAYER.toUpperCase().replace('0X', '0x') })
    await mark(OK)
    expect(rows()).toHaveLength(1)
  })
})

describe.skipIf(!present)('the endpoint is INTERNAL, and a failed write is reported', () => {
  it('a wrong internal key gets 401 and writes nothing', async () => {
    const res = await mark(OK, ENV(), 'wrong-key-of-the-right-length-xx')
    expect(res.status).toBe(401)
    expect(rows()).toHaveLength(0)
  })

  it('a D1 failure answers 500 — the caller must learn its only record is the log', async () => {
    // The caller is about to answer 402 for a payment that may well have landed.
    // Swallowing this would leave it believing the row exists.
    const res = await mark(OK, ENV({ failOn: /INSERT INTO settle_unknown/ }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'record failed' })
  })
})

describe.skipIf(!present)('the open queue', () => {
  it('lists only unresolved rows, oldest first', async () => {
    await mark(OK)
    await mark({ ...OK, nonce: '0x' + '11'.repeat(32), slug: 'beta' })
    const open = () => db.prepare(pay.SETTLE_UNKNOWN_OPEN_SQL.replace('?1', '10')).all()
    expect(open()).toHaveLength(2)
    db.prepare("UPDATE settle_unknown SET resolved = 1, resolution = 'credited' WHERE slug = 'acme'").run()
    const rest = open()
    expect(rest).toHaveLength(1)
    expect(rest[0].slug).toBe('beta')
  })

  it('the index the per-minute sweep needs exists (resolved, created)', () => {
    const sql = migration('0028_settle_unknown.sql')
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_settle_unknown_open ON settle_unknown\(resolved, created\)/)
  })

  it('the terminal columns exist FROM THE START — 0027 had to be a second migration', () => {
    // The SETTLED outcome on this side writes ledger rows under a different ref
    // key, and the not-settled outcome writes nothing at all, so without a
    // terminal mark the queue could never drain. That was learned on the payer
    // side; it does not have to be learned twice.
    const sql = migration('0028_settle_unknown.sql')
    expect(sql).toMatch(/resolved\s+INTEGER/)
    expect(sql).toMatch(/resolution\s+TEXT/)
  })

  it('the instrument is the PRIMARY KEY, not the hash', () => {
    // A hash may be absent (transport failure) or may not be the only submission
    // of the same authorization. (payer, nonce) is unique by EIP-3009's own
    // single-use rule — the same reasoning as 0026.
    expect(migration('0028_settle_unknown.sql')).toMatch(/PRIMARY KEY \(payer, nonce\)/)
  })
})

describe('the identity parsed out of an untrusted X-PAYMENT header', () => {
  const payload = (auth: any) => ({ payload: { network: 'eip155:8469', authorization: auth } })

  it('pulls payer, nonce, value and the signed deadline', () => {
    const id = authorizationIdentity(payload({
      from: PAYER.toUpperCase().replace('0X', '0x'), nonce: NONCE,
      value: '50000', validAfter: '0', validBefore: '1800000000',
    }))
    expect(id).toEqual({ payer: PAYER, nonce: NONCE, valueMicro: 50_000, validBefore: 1_800_000_000 })
  })

  it('value is already micro-USDC — USDC has 6 decimals, so no conversion', () => {
    // The payload's `value` is the on-chain base-unit amount, which for USDC IS
    // micro. Dividing or multiplying here would credit 1e6× wrong.
    expect(authorizationIdentity(payload({ from: PAYER, nonce: NONCE, value: '1' }))!.valueMicro).toBe(1)
  })

  it('returns null when payer or nonce is missing or malformed — a partial identity is useless', () => {
    expect(authorizationIdentity(payload({ nonce: NONCE }))).toBeNull()
    expect(authorizationIdentity(payload({ from: PAYER }))).toBeNull()
    expect(authorizationIdentity(payload({ from: '0x1', nonce: NONCE }))).toBeNull()
    expect(authorizationIdentity(payload({ from: PAYER, nonce: '0xzz' }))).toBeNull()
    expect(authorizationIdentity(null)).toBeNull()
    expect(authorizationIdentity({})).toBeNull()
  })

  it('a missing or junk value/deadline is NULL, never NaN', () => {
    const id = authorizationIdentity(payload({ from: PAYER, nonce: NONCE, value: 'abc' }))
    expect(id).toMatchObject({ valueMicro: null, validBefore: null })
  })

  it('reads a flat authorization too (some clients omit the payload wrapper)', () => {
    expect(authorizationIdentity({ authorization: { from: PAYER, nonce: NONCE } }))
      .toMatchObject({ payer: PAYER, nonce: NONCE })
  })
})

describe('the receiver route records the unknown before it 402s', () => {
  const jsonRes = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const header = Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'exact', network: 'eip155:8453',
    payload: {
      network: 'eip155:8453',
      authorization: { from: PAYER, nonce: NONCE, value: '50000', validAfter: '0', validBefore: '1800000000' },
    },
  })).toString('base64')
  const paidReq = () =>
    new Request('https://tiny.technology/api/x402/chat/acme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
      body: JSON.stringify({ message: 'hi' }),
    })
  const params = Promise.resolve({ slug: 'acme' })

  // The header names mainnet, so these only reach the settle path on a mainnet
  // deployment (offeredNetworks is deployment-gated — the mint fix).
  let restore = () => {}
  beforeEach(() => { restore = asDeployment('base'); process.env.X402_PAY_TO = PAY_TO })
  afterEach(() => { restore(); vi.restoreAllMocks() })

  const prelude = (m: any) => m
    .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
    .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))      // /pay/pricing
    .mockResolvedValueOnce(jsonRes({ isValid: true }))           // /verify

  it('an UNKNOWN settle records the instrument, then answers 402 with the verdict', async () => {
    const m = vi.fn()
    prelude(m)
      // Submitted, unconfirmed: a hash exists and success is false.
      .mockResolvedValueOnce(jsonRes({ success: false, settlement: 'unknown', transaction: HASH, errorReason: 'receipt timeout' }))
      .mockResolvedValueOnce(jsonRes({ ok: true }))              // /pay/settle-unknown
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(402)
    const body: any = await res.json()
    expect(body.settlement).toBe('unknown')
    expect(body.tx_hash).toBe(HASH)

    const call = m.mock.calls.find((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))
    expect(call).toBeDefined()
    // Everything a later credit needs, in one body.
    expect(JSON.parse(call![1].body)).toMatchObject({
      payer: PAYER, nonce: NONCE, txHash: HASH, slug: 'acme', priceMicro: 50000,
      valueMicro: 50000, validBefore: 1800000000, network: 'eip155:8453', payTo: PAY_TO,
    })
    // The internal key rides along — this is an internal-only surface.
    expect(call![1].headers['X-Internal-Key']).toBeDefined()
  })

  it('a hashless unknown (settle unreachable) is STILL recorded', async () => {
    const m = vi.fn()
    prelude(m)
      .mockRejectedValueOnce(new Error('socket hang up'))         // /settle transport failure
      .mockResolvedValueOnce(jsonRes({ ok: true }))               // /pay/settle-unknown
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(402)
    expect((await res.json()).settlement).toBe('unknown')
    const call = m.mock.calls.find((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))
    expect(call).toBeDefined()
    const sent = JSON.parse(call![1].body)
    expect(sent).toMatchObject({ payer: PAYER, nonce: NONCE, slug: 'acme' })
    // No hash to send, and none invented.
    expect(sent.txHash).toBeUndefined()
  })

  it('a plain NOT_SETTLED rejection records NOTHING — there is no money to reconcile', async () => {
    const m = vi.fn()
    prelude(m)
      .mockResolvedValueOnce(jsonRes({ success: false, errorReason: 'bad signature' }))
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(402)
    expect((await res.json()).settlement).toBe('not_settled')
    expect(m.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))).toBe(false)
  })

  it('a VERIFY failure records nothing — nothing was ever submitted', async () => {
    const m = vi.fn()
    m.mockResolvedValueOnce(jsonRes({ name: 'acme' }))
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))
      .mockResolvedValueOnce(jsonRes({ isValid: false, invalidReason: 'expired' }))
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(402)
    expect(m.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))).toBe(false)
  })

  it('a SUCCESSFUL settle records nothing — it credits instead (Step 4)', async () => {
    const m = vi.fn()
    prelude(m)
      .mockResolvedValueOnce(jsonRes({ success: true, transaction: HASH, payer: PAYER }))
      .mockResolvedValueOnce(jsonRes({ ok: true }))              // /pay/credit
      .mockResolvedValueOnce(jsonRes({ ok: true }))              // /pay/invoke
      .mockResolvedValueOnce(new Response('data: {"type":"modelContentBlockDeltaEvent","textDelta":"answer"}\n', { status: 200 }))
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(200)
    expect(m.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))).toBe(false)
    expect(m.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/credit'))).toBe(true)
  })

  it('a FAILED record still answers 402 with the right verdict — and leaves the replay log', async () => {
    // Bookkeeping must never be able to change the money verdict, and a lost row
    // must degrade to the `x402-reconcile` line we had before, not to nothing.
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')) })
    const m = vi.fn()
    prelude(m)
      .mockResolvedValueOnce(jsonRes({ success: false, settlement: 'unknown', transaction: HASH }))
      .mockResolvedValue(jsonRes({ error: 'record failed' }, 500))  // every record attempt fails
    vi.stubGlobal('fetch', m)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(402)
    expect((await res.json()).settlement).toBe('unknown')
    const joined = errs.join('\n')
    expect(joined).toContain('x402-reconcile')
    // The full replay body, not just a hash — the gap this cycle closes.
    expect(joined).toContain('settle-unknown')
    expect(joined).toContain(NONCE)
  })

  it('the record is bounded to 2 attempts — the request is already 75s deep and answering 402', async () => {
    const m = vi.fn()
    prelude(m)
      .mockResolvedValueOnce(jsonRes({ success: false, settlement: 'unknown', transaction: HASH }))
      .mockResolvedValue(jsonRes({ error: 'record failed' }, 500))
    vi.stubGlobal('fetch', m)
    await POST(paidReq(), { params })
    expect(m.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/pay/settle-unknown'))).toHaveLength(2)
  })
})

describe.skipIf(!present)('wiring, and what this cycle deliberately does NOT do', () => {
  it('the route is registered on the worker', () => {
    const idx = readFileSync(join(WORKER_SRC, 'index.ts'), 'utf8')
    expect(idx).toContain("router.post('/pay/settle-unknown', PaySettleUnknownCall)")
    expect(idx).toContain('PaySettleUnknownCall')
  })

  it('the receiver route posts to it only for UNKNOWN', () => {
    expect(appCode).toMatch(/settlement === UNKNOWN && settled\.auth/)
    expect(appCode).toContain('/pay/settle-unknown')
  })

  it('recording NEVER writes to the ledger — a credit needs proof of VALUE, not of consumption', () => {
    // ⚠️ THE MINT GUARD FOR THIS CYCLE. authorizationState is set to true by
    // BOTH _transferWithAuthorization (money moved) and cancelAuthorization
    // (money did not), so a resolver built on that boolean would credit the
    // owner out of USDC a cancel never delivered. The events differ where the
    // bit cannot — AuthorizationUsed vs AuthorizationCanceled — so the resolver
    // is a log/receipt read and belongs to its own increment. Until then this
    // surface must be pure bookkeeping.
    const src = code('payments.ts')
    const fn = src.slice(src.indexOf('class PaySettleUnknownCall'))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    expect(body).not.toMatch(/INSERT INTO ledger/)
    expect(body).not.toMatch(/authorizationRedeemed/)
    // The ONE statement it runs, and where that statement writes.
    expect(body).toMatch(/SETTLE_UNKNOWN_SQL/)
    expect(src).toMatch(/SETTLE_UNKNOWN_SQL =\s*\n?\s*`INSERT INTO\s+settle_unknown/)
  })

  it('the contract really does set the same bit on cancel — the premise above is not folklore', () => {
    const sol = readFileSync(join(WORKER_SRC, '..', '..', 'chain', 'contracts', 'TinyUSDC.sol'), 'utf8')
    const cancel = sol.slice(sol.indexOf('function cancelAuthorization'))
    const cancelBody = cancel.slice(0, cancel.indexOf('\n    }'))
    expect(cancelBody).toMatch(/authorizationState\[authorizer\]\[nonce\] = true/)
    expect(cancelBody).toMatch(/AuthorizationCanceled/)
    // ...and no _transfer: the bit flips, the money does not move.
    expect(cancelBody).not.toMatch(/_transfer\(/)
    // The transfer path emits a DIFFERENT event, which is what a resolver reads.
    expect(sol).toMatch(/emit AuthorizationUsed\(from, nonce\)/)
  })

  it('the 0028 table is NOT the money ledger — balance stays SUM(ledger.delta_micro)', () => {
    // Same rule as 0022/0024/0025/0026/0027: annotations about money never live
    // where balance is computed.
    const sql = migration('0028_settle_unknown.sql')
    expect(sql).not.toMatch(/delta_micro/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS settle_unknown/)
  })
})
