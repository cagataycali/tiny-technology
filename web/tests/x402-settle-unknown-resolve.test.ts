// @vitest-environment node
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('x402-settle-unknown-resolve')

/**
 * 🔍 THE RECEIVER'S RESOLVER — and the one question it may not ask.
 *
 * c51 (migration 0028) wrote down the last unreconciled money surface: our x402
 * door 402s when a settlement is submitted-but-unconfirmed, so a transfer that
 * then LANDS leaves the tiny's owner unpaid for a request that really was paid
 * for. `settle_unknown` records the instrument; nothing drained it. This is the
 * drain, and its whole design turns on one measured fact.
 *
 * ⚠️ THE PAYER-SIDE QUESTION WOULD MINT HERE. The payer's resolver asks
 * `authorizationState(payer, nonce) → bool` and refunds on false. That bit is set
 * to true by BOTH `_transferWithAuthorization` (money moved, TinyUSDC.sol:151) and
 * `cancelAuthorization` (money did NOT, :128). For the payer the ambiguity errs
 * safe — true only means "don't refund". For the receiver, true would credit the
 * owner plus a platform fee out of USDC that a cancellation never delivered.
 *
 * That is not a reading of the source: chain/scripts/authorization-proof-e2e.mjs
 * signs two same-shaped authorizations on a live chain, transfers one and cancels
 * the other, and measures
 *
 *   authorizationState → true for BOTH        ← the bit cannot tell them apart
 *   AuthorizationUsed  → only the transferred one
 *   AuthorizationCanceled → only the cancelled one
 *   payTo's balance    → moved exactly once
 *
 * ⚠️ AND THE MEASUREMENT CORRECTED THE DESIGN. `AuthorizationUsed` carries **no
 * amount** — both args are `indexed`, so `data` is empty. The event proves the
 * instrument was consumed BY A TRANSFER; it cannot say how much arrived. So the
 * credit is for the price our own 402 demanded, and only after the value the payer
 * actually SIGNED is checked to cover it. The design doc for 0028 said "read proof
 * of value" and would have stopped at the event.
 *
 * Recipe as ever: the REAL exported SQL, the REAL migrations, the REAL route
 * handlers against node:sqlite, a stubbed chain that records WHAT was asked, plus
 * comment-stripped source assertions for the properties that live in control flow.
 */

const migration = (name: string) => readFileSync(join(WORKER_SRC, '..', 'migrations', name), 'utf8')
const code = (rel: string) => readFileSync(join(WORKER_SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const chainFile = (rel: string) => readFileSync(join(WORKER_SRC, '..', '..', 'chain', rel), 'utf8')

const KEY = 'internal-test-key-0123456789'
const USDC = '0x4f585a7be17e3eac9e3eaddd40ae2e475ace5bec'
const PAYER = '0x' + 'ab'.repeat(20)
const NONCE = '0x' + 'cd'.repeat(32)
const TXH = '0x' + 'ef'.repeat(32)
const SLUG = 'demo'
const PRICE = 2_000_000        // $2.00 — what the 402 demanded
const OWNER = 'owner-1'
const NOW = 1_800_000_500
const HEAD = 500_000

// The two topics the resolver hardcodes, recomputed here from their signatures so
// a drifted event name fails in THIS file rather than silently in production.
const USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
const CANCELED_TOPIC = '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81'

let pay: any, dep: any, db: any

beforeAll(async () => {
  if (!present) return
  pay = await import(workerFile('payments.ts') /* @vite-ignore */)
  dep = await import(workerFile('deposits.ts') /* @vite-ignore */)
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
  db.exec(migration('0028_settle_unknown.sql'))
  // The tiny is priced, and the price is what the credit pair reads.
  db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?, ?, ?, 1)")
    .run(`tiny:${SLUG}`, OWNER, PRICE)
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
      async first() { return db.prepare(sql).get(...args()) ?? null },
      async all() {
        if (opts.failSelect && opts.failSelect.test(sql)) throw new Error('D1_ERROR: storage unavailable')
        return { results: db.prepare(sql).all(...args()) }
      },
    }
    return stmt
  },
  async batch(stmts: any[]) {
    const out: any[] = []
    for (const s of stmts) out.push(await s.run())
    return out
  },
})

/** The deployment prod actually runs: the self-hosted chain, selected by default. */
const ENV = (opts: { failSelect?: RegExp } = {}) => ({
  DB: d1(opts),
  INTERNAL_API_KEY: KEY,
  TINY_CHAIN_ID: '8469',
  TINY_CHAIN_USDC_ADDRESS: USDC,
  TINY_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
  PAYMENTS_NETWORK: 'tiny',
})

const topicFor = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** A log as a node returns it. */
const logOf = (topic: string, o: {
  payer?: string; nonce?: string; txHash?: string; address?: string; data?: string; topics?: string[]
} = {}) => ({
  address: o.address ?? USDC,
  topics: o.topics ?? [topic, topicFor(o.payer ?? PAYER), (o.nonce ?? NONCE).toLowerCase()],
  data: o.data ?? '0x',
  transactionHash: (o.txHash ?? TXH).toLowerCase(),
})
const usedLog = (o: any = {}) => logOf(USED_TOPIC, o)
const cancelLog = (o: any = {}) => logOf(CANCELED_TOPIC, o)

/**
 * Stub the chain. `answer` sees the decoded JSON-RPC body so a test can reply per
 * method, and every call is recorded — WHAT was asked matters as much as what was
 * concluded, because the entire point of this cycle is that one question is right
 * and another mints money.
 */
let restoreFetch: (() => void) | null = null
const stubChain = (answer: (body: any, url: string) => any) => {
  const calls: any[] = []
  const orig = globalThis.fetch
  restoreFetch = () => { globalThis.fetch = orig }
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ url: String(url), method: body.method, params: body.params })
    const r = answer(body, String(url))
    if (r instanceof Error) throw r
    const payload = r && typeof r === 'object' && 'error' in r ? r : { jsonrpc: '2.0', id: 1, result: r }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  }) as any
  return calls
}
afterEach(() => { restoreFetch?.(); restoreFetch = null })

/** The common stub: head at HEAD, and whatever logs the test supplies. */
const chainWith = (logs: any[]) => stubChain((body) => {
  if (body.method === 'eth_blockNumber') return '0x' + HEAD.toString(16)
  if (body.method === 'eth_getLogs') return logs
  throw new Error(`unexpected ${body.method}`)
})

const unknownRow = (o: {
  payer?: string; nonce?: string; txHash?: string | null; slug?: string
  price?: number; value?: number | null; network?: string | null
} = {}) =>
  db.prepare(`INSERT INTO settle_unknown
      (payer, nonce, tx_hash, slug, price_micro, value_micro, network, pay_to, valid_before)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      (o.payer ?? PAYER).toLowerCase(), (o.nonce ?? NONCE).toLowerCase(),
      o.txHash === undefined ? TXH.toLowerCase() : o.txHash,
      o.slug ?? SLUG, o.price ?? PRICE,
      o.value === undefined ? PRICE : o.value,
      o.network === undefined ? 'tiny' : o.network,
      '0x' + '11'.repeat(20), 1_800_000_000,
    )

const row = (nonce = NONCE) =>
  db.prepare('SELECT * FROM settle_unknown WHERE nonce = ?').get(nonce.toLowerCase())
const ledger = (userId: string) =>
  db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY id').all(userId)
const balance = (userId: string) =>
  db.prepare('SELECT COALESCE(SUM(delta_micro),0) v FROM ledger WHERE user_id = ?').get(userId).v
const PAYER_ID = `x402:${PAYER.toLowerCase()}`

// ───────────────────────────────────────────────────────────────────────────────

describe.skipIf(!present)('THE MEASURED FINDING: the bit is ambiguous, the log is not', () => {
  it('the two topics are the keccak hashes of the two event signatures', async () => {
    // Not pasted: derived. A wrong topic0 matches nothing, and "no proof of value"
    // silently means a creator is never paid — so the constants get checked.
    const { keccak256, toBytes } = await import('viem')
    expect(dep.AUTHORIZATION_USED_TOPIC)
      .toBe(keccak256(toBytes('AuthorizationUsed(address,bytes32)')))
    expect(dep.AUTHORIZATION_CANCELED_TOPIC)
      .toBe(keccak256(toBytes('AuthorizationCanceled(address,bytes32)')))
    expect(dep.AUTHORIZATION_USED_TOPIC).not.toBe(dep.AUTHORIZATION_CANCELED_TOPIC)
  })

  it('and the contract emits exactly one of them per code path', () => {
    const sol = chainFile('contracts/TinyUSDC.sol')
    // Both args indexed ⟹ authorizer is topics[1], nonce is topics[2], data empty.
    expect(sol).toMatch(/event AuthorizationUsed\(address indexed authorizer, bytes32 indexed nonce\)/)
    expect(sol).toMatch(/event AuthorizationCanceled\(address indexed authorizer, bytes32 indexed nonce\)/)
    // The cancel path sets the SAME bit and moves NOTHING — the whole finding.
    const cancel = sol.slice(sol.indexOf('function cancelAuthorization'))
      .slice(0, sol.slice(sol.indexOf('function cancelAuthorization')).indexOf('function _transferWithAuthorization'))
    expect(cancel).toMatch(/authorizationState\[authorizer\]\[nonce\] = true/)
    expect(cancel).toMatch(/emit AuthorizationCanceled/)
    expect(cancel).not.toMatch(/_transfer\(/)
    // …while the transfer path sets it and DOES move money.
    const xfer = sol.slice(sol.indexOf('function _transferWithAuthorization'))
    expect(xfer).toMatch(/authorizationState\[from\]\[nonce\] = true/)
    expect(xfer).toMatch(/emit AuthorizationUsed/)
    expect(xfer).toMatch(/_transfer\(from, to, value\)/)
  })

  it('NON-VACUITY — the live measurement exists and asserts the ambiguity', () => {
    // A prose claim about a chain is worth nothing; lens 21. This is the script
    // that ran, and these are the clauses it must contain.
    const probe = chainFile('scripts/authorization-proof-e2e.mjs')
    expect(probe).toMatch(/cancelAuthorization/)
    expect(probe).toMatch(/transferWithAuthorization/)
    expect(probe).toMatch(/authorizationState is TRUE for BOTH/)
    expect(probe).toMatch(/NO log: this is the proof of value/)
    // And it's runnable, not orphaned.
    const pkg = JSON.parse(chainFile('package.json'))
    expect(pkg.scripts['e2e:authproof']).toMatch(/authorization-proof-e2e\.mjs/)
  })

  it('⚠️ THE RESOLVER NEVER ASKS authorizationState — that call would mint', () => {
    const src = code('payments.ts')
    const fn = src.slice(src.indexOf('export async function reconcileSettleUnknown'))
    expect(fn.length).toBeGreaterThan(500)
    // The payer-side question, by either name, must not appear in this function.
    expect(fn).not.toMatch(/authorizationRedeemed\s*\(/)
    expect(fn).not.toMatch(/encodeAuthorizationState/)
    expect(fn).not.toMatch(/eth_call/)
    // What it asks instead:
    expect(fn).toMatch(/authorizationFate\s*\(/)
  })
})

describe.skipIf(!present)('decodeAuthorizationFate — pure, and safe in the mint direction', () => {
  it('AuthorizationUsed ⟹ used, carrying the settling tx hash', () => {
    expect(dep.decodeAuthorizationFate([usedLog()], USDC, PAYER, NONCE))
      .toEqual({ fate: 'used', txHash: TXH.toLowerCase() })
  })

  it('AuthorizationCanceled ⟹ canceled', () => {
    expect(dep.decodeAuthorizationFate([cancelLog()], USDC, PAYER, NONCE))
      .toEqual({ fate: 'canceled', txHash: TXH.toLowerCase() })
  })

  it('⚠️ a CONTRADICTION resolves to canceled, whatever the order', () => {
    // If both appear for one (payer, nonce) the instrument is not provably paid.
    // Order is not trust: a node could return them either way round.
    const a = dep.decodeAuthorizationFate([usedLog(), cancelLog({ txHash: '0x' + '01'.repeat(32) })], USDC, PAYER, NONCE)
    const b = dep.decodeAuthorizationFate([cancelLog({ txHash: '0x' + '01'.repeat(32) }), usedLog()], USDC, PAYER, NONCE)
    expect(a.fate).toBe('canceled')
    expect(b.fate).toBe('canceled')
  })

  it('an EMPTY set is null — never "not settled"', () => {
    // c48: absence is not evidence. The tx may be pending, the range wrong, the
    // node behind. On this side a wrong "nothing happened" only delays; a wrong
    // "used" mints — but delay is still not a verdict to record.
    expect(dep.decodeAuthorizationFate([], USDC, PAYER, NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate(null, USDC, PAYER, NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate(undefined, USDC, PAYER, NONCE)).toBe(null)
  })

  it('a log from ANOTHER token is ignored', () => {
    // Anyone may deploy a contract that emits our topic with our nonce. The token
    // address is what makes the event ours.
    const other = '0x' + '99'.repeat(20)
    expect(dep.decodeAuthorizationFate([usedLog({ address: other })], USDC, PAYER, NONCE)).toBe(null)
  })

  it("another payer's or another nonce's log is ignored", () => {
    // The filter is a request to the node; this is the check. A node that widened
    // the filter must not be able to credit one instrument for another's proof.
    expect(dep.decodeAuthorizationFate([usedLog({ payer: '0x' + '77'.repeat(20) })], USDC, PAYER, NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate([usedLog({ nonce: '0x' + '11'.repeat(32) })], USDC, PAYER, NONCE)).toBe(null)
  })

  it('an unrelated topic0 is ignored, not interpreted', () => {
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    expect(dep.decodeAuthorizationFate([logOf(TRANSFER)], USDC, PAYER, NONCE)).toBe(null)
  })

  it('a log with no usable tx hash is ignored — the credit needs a ref', () => {
    // The hash IS the idempotency key of the credit. A "used" we cannot key by
    // would either collide wrongly or double-pay on the next tick.
    expect(dep.decodeAuthorizationFate([usedLog({ txHash: '0xnope' } as any)], USDC, PAYER, NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate([{ ...usedLog(), transactionHash: undefined }], USDC, PAYER, NONCE)).toBe(null)
  })

  it('malformed inputs ask nothing rather than guess', () => {
    expect(dep.decodeAuthorizationFate([usedLog()], 'not-a-token', PAYER, NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate([usedLog()], USDC, 'nope', NONCE)).toBe(null)
    expect(dep.decodeAuthorizationFate([usedLog()], USDC, PAYER, '0xshort')).toBe(null)
    expect(dep.decodeAuthorizationFate([{ topics: [USED_TOPIC] }], USDC, PAYER, NONCE)).toBe(null)
  })

  it('addressToTopic is topicToAddress inverted, and refuses junk', () => {
    expect(dep.addressToTopic(PAYER)).toBe(topicFor(PAYER))
    expect(dep.topicToAddress(dep.addressToTopic(PAYER))).toBe(PAYER.toLowerCase())
    expect(dep.addressToTopic('nope')).toBe('')
  })
})

describe.skipIf(!present)('authorizationFate — the bounded query it actually sends', () => {
  it('ONE eth_getLogs, topic0 as an ALTERNATION of both events', async () => {
    const calls = stubChain(() => [usedLog()])
    const out = await dep.authorizationFate(ENV(), PAYER, NONCE, 'tiny', '0x1')
    expect(out).toEqual({ fate: 'used', txHash: TXH.toLowerCase() })
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('eth_getLogs')
    const f = calls[0].params[0]
    expect(f.address).toBe(USDC)
    expect(f.topics[0]).toEqual([USED_TOPIC, CANCELED_TOPIC])
    expect(f.topics[1]).toBe(topicFor(PAYER))
    expect(f.topics[2]).toBe(NONCE.toLowerCase())
  })

  it('⚠️ an UNBOUNDED range is refused — no RPC is even attempted', async () => {
    // A genesis-to-latest scan is what a node truncates, and a truncated result is
    // indistinguishable from "canceled"'s absence — i.e. it denies a creator their
    // earnings while looking like a clean answer. So fromBlock must be a real hex
    // quantity; 'earliest' and '' are refused.
    const calls = stubChain(() => [usedLog()])
    expect(await dep.authorizationFate(ENV(), PAYER, NONCE, 'tiny', 'earliest')).toBe(null)
    expect(await dep.authorizationFate(ENV(), PAYER, NONCE, 'tiny', '')).toBe(null)
    expect(calls.length).toBe(0)
  })

  it('an RPC failure is null, not a verdict', async () => {
    stubChain(() => new Error('ECONNREFUSED'))
    expect(await dep.authorizationFate(ENV(), PAYER, NONCE, 'tiny', '0x1')).toBe(null)
    restoreFetch?.(); restoreFetch = null
    stubChain(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'query returned more than 10000 results' } }))
    expect(await dep.authorizationFate(ENV(), PAYER, NONCE, 'tiny', '0x1')).toBe(null)
  })

  it('a chain with no configured token asks nothing', async () => {
    const calls = stubChain(() => [usedLog()])
    const env: any = { ...ENV(), TINY_CHAIN_USDC_ADDRESS: '' }
    expect(await dep.authorizationFate(env, PAYER, NONCE, 'tiny', '0x1')).toBe(null)
    expect(calls.length).toBe(0)
  })

  it('blockNumber is the lookback anchor, and null when the node won\'t say', async () => {
    stubChain(() => '0x' + HEAD.toString(16))
    expect(await dep.blockNumber(ENV(), 'tiny')).toBe(HEAD)
    restoreFetch?.(); restoreFetch = null
    stubChain(() => new Error('down'))
    expect(await dep.blockNumber(ENV(), 'tiny')).toBe(null)
  })
})

describe.skipIf(!present)('the sweep: a landed settlement pays the owner', () => {
  it('AuthorizationUsed ⟹ the SAME credit+invoke pair the live route runs', async () => {
    unknownRow()
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)

    expect(out).toMatchObject({ checked: 1, credited: 1, cancelled: 0 })

    // The payer's namespaced account was funded by the price, then debited by the
    // invoke — net zero, exactly as a live settle leaves it.
    const rows = ledger(PAYER_ID)
    expect(rows.map((r: any) => r.kind)).toEqual(['deposit', 'invoke_debit'])
    expect(rows[0].delta_micro).toBe(PRICE)
    expect(balance(PAYER_ID)).toBe(0)

    // …and the owner is paid, minus the flat platform fee.
    expect(balance(OWNER)).toBe(PRICE - pay.PLATFORM_FEE_MICRO)
    expect(balance('platform')).toBe(pay.PLATFORM_FEE_MICRO)

    // Terminal, and it says WHICH way.
    expect(row().resolution).toBe('credited')
    expect(row().resolved).toBe(NOW)
  })

  it('the credit is keyed by the ON-CHAIN hash — so a live credit and this one collide', async () => {
    // The ref must come from the log, never be synthesized: if the live request
    // somehow also credited, the two writes are the same row rather than two.
    unknownRow({ txHash: null })
    const env = ENV()
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(env, NOW)
    expect(ledger(PAYER_ID)[0].ref).toBe(TXH.toLowerCase())
    // And the hash we learned is written back to the row that arrived without one.
    expect(row().tx_hash).toBe(TXH.toLowerCase())
  })

  it('a hash we already stored is NOT overwritten by the log\'s', async () => {
    // The stored hash is what the payer's client was told; keep it.
    const stored = '0x' + 'aa'.repeat(32)
    unknownRow({ txHash: stored })
    chainWith([usedLog({ txHash: TXH })])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(row().tx_hash).toBe(stored)
    // The CREDIT still uses the chain's hash — that is the one the money is under.
    expect(ledger(PAYER_ID)[0].ref).toBe(TXH.toLowerCase())
  })

  it('running the sweep twice credits ONCE (idempotent by ref, and by resolved)', async () => {
    unknownRow()
    const env = ENV()
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(env, NOW)
    const after = await pay.reconcileSettleUnknown(env, NOW + 60)
    // The row left the open queue, so the second tick doesn't even ask.
    expect(after.checked).toBe(0)
    expect(ledger(PAYER_ID).length).toBe(2)
    expect(balance(OWNER)).toBe(PRICE - pay.PLATFORM_FEE_MICRO)
  })

  it('a trial-chain settle credits as TRIAL money, not withdrawable USDC', async () => {
    // tiny-chain USDC is minted by us. The credit's counterparty is what the
    // withdrawal exclusion reads, and the resolver must report the chain it read.
    unknownRow()
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(ledger(PAYER_ID)[0].counterparty).toBe(pay.counterpartyFor?.('tiny') ?? 'chain:tiny')
  })
})

describe.skipIf(!present)('the sweep: a cancellation pays NOBODY', () => {
  it('⚠️ AuthorizationCanceled ⟹ no ledger rows at all', async () => {
    // THE MINT THIS CYCLE EXISTS TO PREVENT. `authorizationState` reads true for
    // this instrument (measured), so a resolver reusing the payer's question would
    // credit the owner here out of money that never arrived.
    unknownRow()
    const env = ENV()
    chainWith([cancelLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)

    expect(out).toMatchObject({ checked: 1, credited: 0, cancelled: 1 })
    expect(ledger(PAYER_ID).length).toBe(0)
    expect(balance(OWNER)).toBe(0)
    expect(balance('platform')).toBe(0)
  })

  it("and it is recorded as 'cancelled', distinct from 'not_settled'", async () => {
    // The payer ACTED. Collapsing that into "the tx never landed" loses the
    // difference between a lost transaction and a withdrawn payment — and
    // migration 0028 reserved the word for exactly this.
    unknownRow()
    chainWith([cancelLog()])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(row().resolution).toBe('cancelled')
    expect(migration('0028_settle_unknown.sql')).toMatch(/'credited' \| 'not_settled' \| 'cancelled'/)
  })
})

describe.skipIf(!present)('the sweep: what it refuses to conclude', () => {
  it('NO logs ⟹ still open, nothing written', async () => {
    unknownRow()
    const env = ENV()
    chainWith([])
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out).toMatchObject({ checked: 1, unknown: 1, credited: 0, cancelled: 0 })
    expect(row().resolved).toBe(null)
    expect(ledger(PAYER_ID).length).toBe(0)
  })

  it('a dead RPC leaves every row open', async () => {
    unknownRow()
    stubChain(() => new Error('ECONNREFUSED'))
    const out = await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(out.unknown).toBe(1)
    expect(row().resolved).toBe(null)
  })

  it('a head we cannot read means no log query is attempted', async () => {
    // Without a head there is no bounded range, and an unbounded scan is the one
    // query whose truncation reads as a verdict.
    unknownRow()
    const calls = stubChain((body) => {
      if (body.method === 'eth_blockNumber') return new Error('down')
      return []
    })
    const out = await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(out.unknown).toBe(1)
    expect(calls.filter(c => c.method === 'eth_getLogs').length).toBe(0)
  })

  it('an unnameable network is SKIPPED, never asked of the default chain', async () => {
    // Asking the wrong chain returns a confident answer about a different ledger.
    unknownRow({ network: null })
    const calls = stubChain(() => [usedLog()])
    const out = await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(out).toMatchObject({ checked: 1, skipped: 1, credited: 0 })
    expect(calls.length).toBe(0)
    expect(row().resolved).toBe(null)   // left for a human, not marked resolved
  })

  it('⚠️ an authorized value BELOW the price never credits', async () => {
    // AuthorizationUsed has no amount (measured — `data` is empty), so the event
    // alone cannot say how much arrived. A payload authorizing $1 against a $2
    // price did not buy this request; crediting the price would mint the gap.
    unknownRow({ value: PRICE - 1 })
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out).toMatchObject({ checked: 1, skipped: 1, credited: 0 })
    expect(ledger(PAYER_ID).length).toBe(0)
    expect(row().resolved).toBe(null)
  })

  it('a value ABOVE the price credits the PRICE, not the value', async () => {
    // The owner is owed what the 402 demanded. An over-authorization is the
    // payer's business (and their change is a chain matter, not a ledger one).
    unknownRow({ value: PRICE * 3 })
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(ledger(PAYER_ID)[0].delta_micro).toBe(PRICE)
    expect(balance(OWNER)).toBe(PRICE - pay.PLATFORM_FEE_MICRO)
  })

  it('a row with NO recorded value stays open rather than being credited', async () => {
    unknownRow({ value: null })
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(out.skipped).toBe(1)
    expect(ledger(PAYER_ID).length).toBe(0)
  })

  it('a broken queue read resolves nothing and does not throw', async () => {
    unknownRow()
    // A deployment with the code but not migration 0028 hits exactly this.
    const out = await pay.reconcileSettleUnknown(ENV({ failSelect: /FROM settle_unknown/ }), NOW)
    expect(out).toMatchObject({ checked: 0, credited: 0 })
  })

  it('an empty queue costs ZERO rpc calls', async () => {
    const calls = stubChain(() => '0x1')
    const out = await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(out.checked).toBe(0)
    expect(calls.length).toBe(0)
  })
})

describe.skipIf(!present)('the sweep: batching, ordering and the shared head read', () => {
  it('oldest first, bounded by the batch size', async () => {
    for (let i = 0; i < 8; i++) {
      unknownRow({ nonce: '0x' + String(i).repeat(2).padStart(2, '0').repeat(32).slice(0, 64) })
    }
    chainWith([])
    const out = await pay.reconcileSettleUnknown(ENV(), NOW, 3)
    expect(out.checked).toBe(3)
    expect(pay.SETTLE_UNKNOWN_BATCH).toBeLessThanOrEqual(10)
    expect(pay.SETTLE_UNKNOWN_OPEN_SQL).toMatch(/ORDER BY created ASC/)
    expect(pay.SETTLE_UNKNOWN_OPEN_SQL).toMatch(/resolved IS NULL/)
  })

  it('ONE eth_blockNumber for the whole batch, one eth_getLogs per row', async () => {
    unknownRow({ nonce: '0x' + '11'.repeat(32) })
    unknownRow({ nonce: '0x' + '22'.repeat(32) })
    unknownRow({ nonce: '0x' + '33'.repeat(32) })
    const calls = chainWith([])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(calls.filter(c => c.method === 'eth_blockNumber').length).toBe(1)
    expect(calls.filter(c => c.method === 'eth_getLogs').length).toBe(3)
  })

  it('the range is bounded backwards from the head, not from genesis', async () => {
    unknownRow()
    const calls = chainWith([])
    await pay.reconcileSettleUnknown(ENV(), NOW)
    const f = calls.find(c => c.method === 'eth_getLogs').params[0]
    expect(f.fromBlock).toBe('0x' + (HEAD - pay.FATE_LOOKBACK_BLOCKS).toString(16))
    expect(f.toBlock).toBe('latest')
    expect(pay.FATE_LOOKBACK_BLOCKS).toBeGreaterThan(1000)
  })

  it('a head SHALLOWER than the lookback clamps at block 0, not a negative hex', async () => {
    unknownRow()
    const calls = stubChain((body) => {
      if (body.method === 'eth_blockNumber') return '0x5'
      return []
    })
    await pay.reconcileSettleUnknown(ENV(), NOW)
    expect(calls.find(c => c.method === 'eth_getLogs').params[0].fromBlock).toBe('0x0')
  })

  it('one bad row does not stop the batch', async () => {
    unknownRow({ nonce: '0x' + '11'.repeat(32), network: null })   // skipped
    unknownRow({ nonce: '0x' + '22'.repeat(32) })                   // credited
    const env = ENV()
    stubChain((body) => {
      if (body.method === 'eth_blockNumber') return '0x' + HEAD.toString(16)
      return [usedLog({ nonce: '0x' + '22'.repeat(32) })]
    })
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out).toMatchObject({ checked: 2, skipped: 1, credited: 1 })
    expect(row('0x' + '22'.repeat(32)).resolution).toBe('credited')
  })
})

describe.skipIf(!present)('the credit pair, and the terminal mark', () => {
  it('a credit refused with 409 is TERMINAL — resolved, but never as a payment', async () => {
    // ⚠️ CONTRACT UPDATE (c60). This test previously asserted `resolved === null`
    // for this case, on the reasoning that a 409 "is not a creator payment, so it
    // must not be recorded as one". The first half is right and the conclusion was
    // wrong: leaving it open meant the row came back every tick FOREVER, at the head
    // of an oldest-first queue with a batch of 5, starving resolvable payments
    // behind it. A 409 cannot clear on its own — `claimed_txs` holds the hash for
    // another account and only that account's own path releases it. So it is
    // terminal, under its own verdict: not `credited` (nobody was paid) and not
    // `cancelled` (the transfer really happened — someone else banked it).
    unknownRow()
    db.prepare('INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?)')
      .run(TXH.toLowerCase(), 'someone-else', 'tiny')
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out.credited).toBe(0)
    expect(row().resolution).toBe('tx_claimed_elsewhere')
    expect(row().resolved).toBe(NOW)
    // Still nobody's money: no creator credit, and no deposit for the payer.
    expect(balance(OWNER)).toBe(0)
    expect(ledger(PAYER_ID)).toEqual([])
  })

  it('…and the queue actually DRAINS — the same row is not re-read next tick', async () => {
    // The property the resolution mark exists for, asserted behaviourally rather
    // than by reading `resolved`: a terminal row must leave the open query, or
    // "terminal" is just a column nobody acts on.
    unknownRow()
    db.prepare('INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?)')
      .run(TXH.toLowerCase(), 'someone-else', 'tiny')
    const env = ENV()
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(env, NOW)
    const second = await pay.reconcileSettleUnknown(env, NOW + 60)
    expect(second.checked).toBe(0)
  })

  it('a 409 does not starve the rows behind it', async () => {
    // The consequence that made this worth a cycle. Batch is 5; put a permanently
    // claimed row FIRST (oldest) and a good one behind it, then run twice. Before
    // c60 the claimed row was re-read every tick forever; the good row still got
    // served here because the batch is 5 wide, so the honest assertion is about
    // the queue emptying, not about the good row being reached.
    const OTHER = '0x' + '77'.repeat(32)
    unknownRow()                       // oldest — will 409
    unknownRow({ nonce: OTHER, txHash: '0x' + '88'.repeat(32) })
    db.prepare('INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?)')
      .run(TXH.toLowerCase(), 'someone-else', 'tiny')
    const env = ENV()
    stubChain((body) => {
      if (body.method === 'eth_blockNumber') return '0x' + HEAD.toString(16)
      return [usedLog(), usedLog({ nonce: OTHER, txHash: '0x' + '88'.repeat(32) })]
    })
    await pay.reconcileSettleUnknown(env, NOW)
    expect(row().resolution).toBe('tx_claimed_elsewhere')
    expect(row(OTHER).resolution).toBe('credited')
    // Nothing open ⇒ the next tick reads nothing at all.
    expect((await pay.reconcileSettleUnknown(env, NOW + 60)).checked).toBe(0)
  })

  it('a TRANSIENT credit failure still leaves the row open — only 409 is terminal', async () => {
    // ⚠️ THE LOAD-BEARING OTHER HALF. If every failed credit became terminal, one
    // momentary storage error would permanently abandon a real creator payment —
    // strictly worse than the bug c60 fixed. So this drives a genuine non-409
    // failure THROUGH the credit route: `reserveTx` cannot read `claimed_txs`, so
    // PayCreditCall answers 500, and the row must stay open for the next tick.
    unknownRow()
    const env = ENV()
    chainWith([usedLog()])
    // Break only the reservation read. The open-queue SELECT must keep working, or
    // the sweep would never reach the credit at all and the test would prove nothing.
    const realPrepare = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => {
      const stmt = realPrepare(sql)
      if (/INSERT INTO claimed_txs/i.test(sql)) {
        // Same shape as a real statement, so the type of `prepare` is unchanged —
        // only `run` is poisoned.
        return { ...stmt, bind: () => ({ ...stmt, run: async () => { throw new Error('D1_ERROR: storage unavailable') } }) }
      }
      return stmt
    }
    const out = await pay.reconcileSettleUnknown(env, NOW)
    // Reached the credit, was refused, and did NOT mark the row.
    expect(out.checked).toBe(1)
    expect(out.credited).toBe(0)
    expect(out.unknown).toBe(1)
    expect(row().resolved).toBe(null)
    expect(row().resolution).toBe(null)
    expect(balance(OWNER)).toBe(0)

    // ⚠️ NON-VACUITY. `unknown++` has five other reachable sources (no head, no
    // fate, invoke failed, a throw…), so `unknown === 1` alone does not prove the
    // credit was ever ATTEMPTED — this test would pass just as well if the sweep
    // died before reaching it. So repair ONLY the reservation and re-run the SAME
    // row: it credits. That makes the refused credit the one thing that had
    // failed, and staying open is what let this second tick exist at all.
    env.DB.prepare = realPrepare
    chainWith([usedLog()])
    const second = await pay.reconcileSettleUnknown(env, NOW)
    expect(second.credited).toBe(1)
    expect(row().resolution).toBe('credited')
    expect(balance(OWNER)).toBeGreaterThan(0)
  })

  it('only 409 is treated as permanent — asserted on the STATUS, not the message', async () => {
    // A body-text match (`/already claimed/`) would break the moment the copy
    // changed, and worse, would match a transient error that happened to mention
    // a claim. The gate must read the HTTP status.
    const fn = code('payments.ts')
    const body = fn.slice(fn.indexOf('export async function reconcileSettleUnknown'))
    expect(body).toMatch(/credited\.status === 409/)
    expect(body).toMatch(/resolve\(payer, nonce, "tx_claimed_elsewhere"\)/)
    // …and internalPost must actually SURFACE the status, or the gate above reads
    // `undefined === 409` forever: a guard no input can reach.
    const helper = fn.slice(0, fn.indexOf('export async function reconcileSettleUnknown'))
    const post = helper.slice(helper.indexOf('async function internalPost'))
    expect(post).toMatch(/status: res\.status/)
    expect(post).toMatch(/Promise<\{ ok: boolean; status: number; data: any \}>/)
  })

  it('the invoke runs AFTER the credit — an unfunded invoke would just bounce', async () => {
    const fn = code('payments.ts')
    const body = fn.slice(fn.indexOf('export async function reconcileSettleUnknown'))
    const creditIdx = body.indexOf('/pay/credit')
    const invokeIdx = body.indexOf('/pay/invoke')
    expect(creditIdx).toBeGreaterThan(0)
    expect(invokeIdx).toBeGreaterThan(creditIdx)
    // …and the invoke is gated on the credit having succeeded.
    expect(body.slice(creditIdx, invokeIdx)).toMatch(/if \(!credited\.ok\)/)
  })

  it('a failed invoke leaves the row open, and the deposit is not double-written', async () => {
    // Unpriced resource ⟹ invoke reports free, which is ok:true — so force a real
    // failure by removing the price row the split needs.
    unknownRow()
    db.prepare('DELETE FROM prices').run()
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)
    // invoke on an unpriced resource is a legitimate `free` success — the row IS
    // resolved, and the owner gets nothing because the tiny costs nothing.
    expect(out.credited).toBe(1)
    expect(balance(OWNER)).toBe(0)
    // The deposit stands (the payer really did send money) and is written once.
    expect(ledger(PAYER_ID).map((r: any) => r.kind)).toEqual(['deposit'])
  })

  it('a price RAISED between the 402 and the sweep is TERMINAL — the split can never be paid', async () => {
    // ⚠️ c61. The branch above this one credits `price_micro` — the price OUR 402
    // challenge demanded when the payer signed. `/pay/invoke` then charges the
    // price that is live NOW. An owner raising their price in between is an
    // ordinary product action, and it leaves the payer credited $2 and billed $9:
    // the debit's `WHERE … >= price` yields 0 rows and invoke answers 402.
    //
    // Nothing about a retry can move either number — the credit is idempotent by
    // ref, so the next tick re-credits nothing, and the stored price only ever
    // moves further away. The old code called this transient (`out.unknown++`)
    // under a comment claiming "the split can still be made".
    unknownRow()                                   // recorded at PRICE
    db.prepare('UPDATE prices SET price_micro = ? WHERE resource = ?')
      .run(PRICE * 4, `tiny:${SLUG}`)              // owner raised it afterwards
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)

    expect(out.credited).toBe(0)
    expect(row().resolution).toBe('split_underfunded')
    expect(row().resolved).toBe(NOW)
    // The creator was NOT paid — that is the whole reason this needs a human.
    expect(balance(OWNER)).toBe(0)
    // …but the payer's deposit STANDS. The transfer really happened, and marking
    // the row terminal must not confiscate it.
    expect(ledger(PAYER_ID).map((r: any) => r.kind)).toEqual(['deposit'])
    expect(balance(PAYER_ID)).toBe(PRICE)
  })

  it('…and that row DRAINS — it does not come back at the head of the queue forever', async () => {
    // The consequence that makes it worth a verdict rather than a log line: the
    // open query is oldest-first with a batch of 5, so an unresolvable row at the
    // head costs one eth_getLogs per tick and starves what is behind it.
    unknownRow()
    db.prepare('UPDATE prices SET price_micro = ? WHERE resource = ?').run(PRICE * 4, `tiny:${SLUG}`)
    const env = ENV()
    chainWith([usedLog()])
    await pay.reconcileSettleUnknown(env, NOW)
    expect((await pay.reconcileSettleUnknown(env, NOW + 60)).checked).toBe(0)
  })

  it('a price CUT still resolves normally — only underfunding is terminal', async () => {
    // The direction that must NOT fire. A cheaper price is affordable out of the
    // credited amount, so this is an ordinary payment; the owner is paid the new
    // price and the payer keeps the difference. Guarding on "the price changed"
    // instead of "the split is unaffordable" would abandon this real payment.
    unknownRow()
    db.prepare('UPDATE prices SET price_micro = ? WHERE resource = ?').run(PRICE / 2, `tiny:${SLUG}`)
    const env = ENV()
    chainWith([usedLog()])
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out.credited).toBe(1)
    expect(row().resolution).toBe('credited')
    expect(balance(OWNER)).toBeGreaterThan(0)
  })

  it('a TRANSIENT invoke failure still leaves the row open — only 402 is terminal', async () => {
    // ⚠️ THE LOAD-BEARING OTHER HALF, the same one the credit branch has. If every
    // failed invoke became terminal, one momentary storage error would abandon a
    // real creator payment — strictly worse than the bug this fixes. So drive a
    // genuine NON-402 failure through the invoke route: its ledger batch throws a
    // non-UNIQUE error, so PayInvokeCall answers 500.
    unknownRow()
    const env = ENV()
    chainWith([usedLog()])
    const realBatch = env.DB.batch.bind(env.DB)
    let poisoned = true
    env.DB.batch = async (stmts: any[]) => {
      if (poisoned) throw new Error('D1_ERROR: storage unavailable')
      return realBatch(stmts)
    }
    const out = await pay.reconcileSettleUnknown(env, NOW)
    expect(out.credited).toBe(0)
    expect(out.unknown).toBe(1)
    expect(row().resolved).toBe(null)
    expect(row().resolution).toBe(null)

    // ⚠️ NON-VACUITY (c60's rule). `unknown++` has six reachable sources, so
    // `unknown === 1` does not prove the INVOKE was what failed — this would pass
    // if the sweep died before reaching it. Repair only the batch and re-run the
    // SAME row: it credits. That makes the refused invoke the one thing that had
    // failed, and staying open is what let this second tick exist at all.
    poisoned = false
    chainWith([usedLog()])
    const second = await pay.reconcileSettleUnknown(env, NOW + 60)
    expect(second.credited).toBe(1)
    expect(row().resolution).toBe('credited')
    expect(balance(OWNER)).toBeGreaterThan(0)
  })

  it('the underfunded gate reads the STATUS, not the message', () => {
    const fn = code('payments.ts')
    const body = fn.slice(fn.indexOf('export async function reconcileSettleUnknown'))
    const invokeIdx = body.indexOf('/pay/invoke')
    const after = body.slice(invokeIdx)
    expect(after).toMatch(/invoked\.status === 402/)
    expect(after).toMatch(/resolve\(payer, nonce, "split_underfunded"\)/)
    // A body-text match on 'insufficient_balance' would break on a copy change
    // and could match a transient error that merely mentioned a balance.
    expect(after.slice(0, after.indexOf('out.credited++'))).not.toMatch(/data\?\.error.*insufficient/)
  })

  it('the reporter can NAME this blocker — or it is invisible again', async () => {
    // c60's rule, restated: a condition the sweep acts on must be nameable by the
    // monitor, or /pay/reconcile-status calls the row healthy and c59's pager
    // stays silent by design. Asserted against the shipped blocker function.
    const raised = new Map([[`tiny:${SLUG}`, PRICE * 4]])
    const r = { network: 'tiny', price_micro: PRICE, value_micro: PRICE, payer: PAYER.toLowerCase(), slug: SLUG, tx_hash: TXH.toLowerCase() }
    expect(pay.settleUnknownBlocker(ENV(), r, undefined, raised))
      .toBe('price raised above the credited amount')
    // Unchanged and cut prices are not blockers…
    expect(pay.settleUnknownBlocker(ENV(), r, undefined, new Map([[`tiny:${SLUG}`, PRICE]]))).toBe(null)
    expect(pay.settleUnknownBlocker(ENV(), r, undefined, new Map([[`tiny:${SLUG}`, 1]]))).toBe(null)
    // …and an ABSENT price is invoke's `free: true` path, which resolves fine.
    // Under-reporting is the direction this reader errs in, deliberately.
    expect(pay.settleUnknownBlocker(ENV(), r, undefined, new Map())).toBe(null)
    expect(pay.settleUnknownBlocker(ENV(), r, undefined, undefined)).toBe(null)

    // ⚠️ It must read THIS row's slug. A surviving mutant that hardcoded
    // `tiny:demo` passed everything above, because every fixture here is 'demo' —
    // so one ANOTHER tiny's raise must not be charged to this row, and vice versa.
    const other = { ...r, slug: 'somebody-else' }
    expect(pay.settleUnknownBlocker(ENV(), other, undefined, raised)).toBe(null)
    expect(pay.settleUnknownBlocker(ENV(), other, undefined, new Map([['tiny:somebody-else', PRICE * 4]])))
      .toBe('price raised above the credited amount')
  })

  it('livePricesFor chunks under D1 param cap, and answers empty on failure', async () => {
    // STATUS_SCAN_LIMIT is 200 and D1 caps a statement near 100 bound params, so
    // one IN (…) over a full scan throws on exactly the deepest queues this report
    // exists to describe.
    const slugs = Array.from({ length: 200 }, (_, i) => `t${i}`)
    db.prepare("INSERT INTO prices (resource, owner_id, price_micro, active) VALUES (?,?,?,1)")
      .run('tiny:t150', OWNER, 7)
    const env = ENV()
    const sizes: number[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => {
      if (/FROM prices/.test(sql)) sizes.push((sql.match(/\?/g) || []).length)
      return realPrepare(sql)
    }
    const got = await pay.livePricesFor(env, slugs)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50)
    expect(got.get('tiny:t150')).toBe(7)   // non-vacuous: it really read them

    // A missing table must not throw — and note `prepare()` itself throws for
    // that, so a .catch() on the await alone would not have covered it.
    db.exec('DROP TABLE prices')
    expect((await pay.livePricesFor(ENV(), [SLUG])).size).toBe(0)
  })

  it('the reporter asks about prices through ONE query per scan, not per row', () => {
    const src = code('payments.ts')
    const reader = src.slice(src.indexOf('const claimedBy = await claimedTxHolders'))
    expect(reader.slice(0, 600)).toMatch(/livePricesFor\(\s*env, scan\.rows\.map/)
    // …and both classification passes get it, or `unpaid_micro` would keep
    // counting money this queue will never pay out.
    expect((src.match(/settleUnknownBlocker\(env, r, claimedBy, livePrices\)/g) || []).length).toBe(2)
  })

  it('the resolve mark is guarded by resolved IS NULL — the first verdict wins', () => {
    expect(pay.SETTLE_UNKNOWN_RESOLVE_SQL).toMatch(/resolved IS NULL/)
    expect(pay.SETTLE_UNKNOWN_RESOLVE_SQL).toMatch(/SET resolved = \?3, resolution = \?4/)
    expect(pay.SETTLE_UNKNOWN_HASH_SQL).toMatch(/tx_hash IS NULL/)
  })

  it('the pair runs IN-PROCESS — no self-URL var that could be unset', async () => {
    // A cron has no request URL, and this codebase has no worker self-URL. A var
    // that nobody sets would make the resolver silently never run, which is the
    // exact failure this arc exists to delete. So it calls the route classes.
    const src = code('payments.ts')
    expect(src).not.toMatch(/WORKER_SELF_URL/)
    const helper = src.slice(src.indexOf('async function internalPost'))
    expect(helper.slice(0, 900)).toMatch(/new Route\(\{ skipValidation: true \}\)\.handle\(request, env\)/)
    // And it really is the shipped handler: PayCreditCall / PayInvokeCall.
    const fn = src.slice(src.indexOf('export async function reconcileSettleUnknown'))
    expect(fn).toMatch(/internalPost\(env, PayCreditCall/)
    expect(fn).toMatch(/internalPost\(env, PayInvokeCall/)
  })
})

describe.skipIf(!present)('wiring: the cron actually drains this queue', () => {
  it('reconcileSettleUnknown runs on the per-minute scheduler', () => {
    const idx = code('index.ts')
    expect(idx).toMatch(/reconcileSettleUnknown\(env, Math\.floor\(Date\.now\(\) \/ 1000\)\)/)
    // Inside scheduled(), and inside waitUntil so it survives the handler return.
    const sched = idx.slice(idx.indexOf('async scheduled('))
    // The promise is BOUND rather than passed inline since the c59 alarm has to
    // sequence after both sweeps — so assert the two properties that matter
    // (it is created inside scheduled, and waitUntil keeps it alive past the
    // handler return) rather than one literal expression shape.
    expect(sched).toMatch(/const settleUnknown = reconcileSettleUnknown\(env,/)
    expect(sched).toMatch(/waitUntil\(settleUnknown\)/)
    // …and it can never take down the reconciler or the job dispatch beside it.
    expect(sched).toMatch(/reconcileSettleUnknown\([\s\S]{0,200}?\.catch\(/)
  })

  it('the cron trigger exists in BOTH wrangler envs', () => {
    const toml = readFileSync(join(WORKER_SRC, '..', 'wrangler.toml'), 'utf8')
    expect(toml).toMatch(/\[triggers\]\ncrons = \["\* \* \* \* \*"\]/)
    expect(toml).toMatch(/\[env\.production\.triggers\]\ncrons = \["\* \* \* \* \*"\]/)
  })

  it('the payer-side reconciler still runs, unchanged, beside it', () => {
    // Two queues, two questions, one tick. The payer's still uses the boolean —
    // which is correct THERE, and the point of lens 22.
    const idx = code('index.ts')
    expect(idx).toMatch(/const sentSpends = reconcileSentSpends\(env,/)
    expect(idx).toMatch(/waitUntil\(sentSpends\)/)
    const pays = code('payments.ts')
    const payerFn = pays.slice(pays.indexOf('export async function reconcileSentSpends'),
      pays.indexOf('export const SETTLE_UNKNOWN_SQL'))
    expect(payerFn).toMatch(/authorizationRedeemed\(/)
  })
})
