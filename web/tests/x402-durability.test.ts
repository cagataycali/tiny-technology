// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 💸 x402 owner-credit durability (app/api/x402/chat/[slug]).
 *
 * A payer moves USDC on-chain BEFORE we credit the owner's ledger. If that
 * ledger write is fire-and-forget and the worker blips, the creator silently
 * loses earnings for money that really moved. `durableWrite` awaits the write
 * with bounded retry — safe because /pay/credit + /pay/invoke are idempotent
 * by the settlement txHash — and, on total failure, emits ONE structured
 * `x402-reconcile` line so the write is recoverable, never lost.
 *
 * These lock the retry/idempotency/observability contract.
 */
import { durableWrite, POST, GET, canonicalNetwork, matchRequirement, paymentRequirements, paymentResponseHeader, offeredNetworks } from '../app/api/x402/chat/[slug]/route'
// The payer-side reader — proves the header we EMIT is exactly what our own
// payer CONSUMES (closing the loop the first-party body-fallback hack opened).
import { parseSettlementTx } from '../lib/x402/payer'
// Every test below that names a deployment must PIN it — `paymentsNetwork()`
// reads PAYMENTS_NETWORK first and PAYMENTS_TESTNET only as a fallback, so
// clearing the boolean alone inherits the higher-precedence var from the shell.
import { asDeployment, TINY_CAIP2, TINY_USDC } from './_deployment'

const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

const postReq = (msg = 'hi') =>
  new Request('https://tiny.technology/api/x402/chat/acme', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg }),
  })
const params = Promise.resolve({ slug: 'acme' })

describe('x402 network matching — the challenge offers ONLY the deployment network', () => {
  // 🧪→💵 MINT GUARD: the challenge must offer exactly the one chain this
  // deployment treats as real balance. Offering both let a mainnet deployment
  // accept faucet USDC on base-sepolia and mint it into real withdrawable
  // earnings (the withdrawal guard only excludes on-chain testnet DEPOSITS,
  // never x402 invoke_credit EARNINGS). The selector is read at call time, so
  // each test pins the deployment it is about and restores it after — clearing
  // PAYMENTS_TESTNET alone left PAYMENTS_NETWORK inherited from the shell, which
  // turned every one of these guards red on a self-hosted deployment.
  let restore = () => {}
  afterEach(() => restore())

  it('a MAINNET deployment offers ONLY base — the free sepolia mint door is closed', () => {
    restore = asDeployment('base')
    expect(offeredNetworks()).toEqual(['base'])
    const reqs = paymentRequirements('acme', 1000, '0xPayTo')
    expect(reqs.x402Version).toBe(1)
    expect(reqs.accepts.map((a: any) => a.network)).toEqual(['eip155:8453'])
    for (const a of reqs.accepts as any[]) {
      for (const k of ['scheme', 'network', 'maxAmountRequired', 'resource', 'payTo', 'asset', 'maxTimeoutSeconds']) {
        expect(a[k]).toBeDefined()
      }
      expect(a.scheme).toBe('exact')
    }
  })

  it('a TESTNET deployment offers ONLY base-sepolia', () => {
    restore = asDeployment('base-sepolia')
    expect(offeredNetworks()).toEqual(['base-sepolia'])
    const reqs = paymentRequirements('acme', 1000, '0xPayTo')
    expect(reqs.accepts.map((a: any) => a.network)).toEqual(['eip155:84532'])
    // The testnet entry carries the (testnet) marker in its description.
    expect(reqs.accepts[0].description).toContain('(testnet)')
    expect(reqs.accepts[0].asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  })

  it('on MAINNET, a base-sepolia payload matches NOTHING → settle fails closed (the mint fix)', () => {
    restore = asDeployment('base')
    const reqs = paymentRequirements('acme', 1000, '0xPayTo')
    // A faucet-funded sepolia payment can no longer find a requirement to settle
    // against on a mainnet deployment — matchRequirement returns null, and
    // settlePayment rejects 'unsupported network' before any settle happens.
    expect(matchRequirement({ payload: { network: 'base-sepolia' } }, reqs)).toBeNull()
    expect(matchRequirement({ network: 'eip155:84532' }, reqs)).toBeNull()
    // The real mainnet door still matches.
    expect(matchRequirement({ network: 'eip155:8453' }, reqs)?.network).toBe('eip155:8453')
  })

  it('on TESTNET, a mainnet payload matches NOTHING (symmetric — no cross-chain settle)', () => {
    restore = asDeployment('base-sepolia')
    const reqs = paymentRequirements('acme', 1000, '0xPayTo')
    expect(matchRequirement({ network: 'eip155:8453' }, reqs)).toBeNull()
    expect(matchRequirement({ payload: { network: 'base-sepolia' } }, reqs)?.network).toBe('eip155:84532')
  })

  /**
   * The third deployment, which is the one the report asks for — and the reason
   * this whole describe block was inheriting its environment. On a chain we own
   * the mint guard matters MORE, not less: TinyUSDC is a token we can issue at
   * will, so a receiver that also honored a Base payload would let real mainnet
   * USDC settle against a ledger whose balances we mint — and, in the other
   * direction, let free minted credit buy a mainnet-priced service.
   *
   * Note this asserts against a FRESHLY-imported receiver: `NETWORKS` and the
   * `TINY` config are module-load constants, so the already-imported copy at the
   * top of this file has no tiny row no matter what env says now.
   */
  it('a SELF-HOSTED deployment offers ONLY the tiny door — both Base doors closed', async () => {
    restore = asDeployment('tiny')
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')

    expect(receiver.offeredNetworks()).toEqual(['tiny'])
    const reqs = receiver.paymentRequirements('acme', 1000, '0xPayTo')
    expect(reqs.accepts.map((a: any) => a.network)).toEqual([TINY_CAIP2])
    expect(reqs.accepts[0].asset).toBe(TINY_USDC)
    // extra.name is the EIP-712 domain the payer signs — TinyUSDC.sol is USDC/2.
    expect(reqs.accepts[0].extra).toEqual({ name: 'USDC', version: '2' })
    // Symmetric fail-closed, in BOTH directions: real USDC must not settle
    // against minted balance, and minted credit must not buy a mainnet service.
    expect(receiver.matchRequirement({ network: 'eip155:8453' }, reqs)).toBeNull()
    expect(receiver.matchRequirement({ payload: { network: 'base-sepolia' } }, reqs)).toBeNull()
    expect(receiver.matchRequirement({ network: 'tiny' }, reqs)?.network).toBe(TINY_CAIP2)
    vi.resetModules()
  })

  it('canonicalNetwork folds short names, bare chain ids, and CAIP-2 onto one form', () => {
    for (const s of ['base', 'eip155:8453', '8453', 'BASE']) expect(canonicalNetwork(s)).toBe('eip155:8453')
    for (const s of ['base-sepolia', 'base_sepolia', 'sepolia', 'eip155:84532', '84532']) expect(canonicalNetwork(s)).toBe('eip155:84532')
  })

  it('a payload naming an unsupported network returns null (settle must reject, not fall back)', () => {
    restore = asDeployment('base')
    const reqs = paymentRequirements('acme', 1000, '0xPayTo')
    expect(matchRequirement({ network: 'eip155:1' }, reqs)).toBeNull()
    expect(matchRequirement({ network: '' }, reqs)).toBeNull()
  })
})

describe('paymentResponseHeader — the STANDARD x402 settlement receipt header', () => {
  it('encodes a base64-JSON SettleResponse a third-party payer can decode', () => {
    const h = paymentResponseHeader('0xabc', 'eip155:84532', '0xpayer')
    const receipt = JSON.parse(Buffer.from(h['X-PAYMENT-RESPONSE'], 'base64').toString('utf8'))
    expect(receipt).toEqual({ success: true, transaction: '0xabc', network: 'eip155:84532', payer: '0xpayer' })
  })

  it('round-trips through the payer-side parseSettlementTx (the header IS what our own payer reads)', () => {
    // The whole point: emitting this header lets payer.ts stop leaning on its
    // first-party body-fallback hack. A 0x…64 hash survives the round-trip.
    const tx = '0x' + 'a'.repeat(64)
    const h = paymentResponseHeader(tx, 'eip155:8453', '0xpayer')
    expect(parseSettlementTx(h['X-PAYMENT-RESPONSE'])).toBe(tx)
  })

  it('emits NO header when there is no settlement tx (free tiny / hashless settle) — never a bogus receipt', () => {
    expect(paymentResponseHeader('', 'eip155:8453', '0xpayer')).toEqual({})
    expect(paymentResponseHeader('', '', '')).toEqual({})
  })

  it('tolerates missing network/payer without throwing (still a valid receipt)', () => {
    const h = paymentResponseHeader('0xabc', '', '')
    const receipt = JSON.parse(Buffer.from(h['X-PAYMENT-RESPONSE'], 'base64').toString('utf8'))
    expect(receipt).toEqual({ success: true, transaction: '0xabc', network: '', payer: '' })
  })
})

describe('x402 POST — fail CLOSED on upstream lookup blips (never serve a paid tiny for free)', () => {
  it('a pricing-lookup non-2xx returns 502 (retry), NOT a free run', async () => {
    // /get resolves a real tiny; /pay/pricing returns a worker HTTP error.
    // Collapsing that to price 0 would skip the 402 dance and run the paid
    // model for free — the owner earns nothing. Must 502 instead.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ error: 'db down' }, 503))   // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(postReq(), { params })
    expect(res.status).toBe(502)
    // Crucially: we never reached the model — no third fetch to /api/chat.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a /get non-2xx returns 502, distinguishing an outage from a missing tiny', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))      // /get down
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))          // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(postReq(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.error).not.toContain('not found') // NOT a 404 masquerade
  })

  it('a genuinely-free tiny (pricing 200, price 0) still runs — no false 502', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))          // /pay/pricing (real free)
      .mockResolvedValueOnce(new Response('data: {"type":"modelContentBlockDeltaEvent","textDelta":"hello"}\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(postReq(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.response).toBe('hello')
    expect(body.paid_micro).toBe(0)
  })
})

describe('x402 POST — a PAID caller is refunded when the agent delivers nothing', () => {
  // Build a valid X-PAYMENT header targeting mainnet so matchRequirement + the
  // facilitator settle succeed, exercising the full paid path through the drain.
  const PAY_TO = '0x1234567890123456789012345678901234567890'
  const paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: { network: 'eip155:8453', authorization: { from: '0xpayer' } },
  })).toString('base64')
  const paidReq = () =>
    new Request('https://tiny.technology/api/x402/chat/acme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': paymentHeader },
      body: JSON.stringify({ message: 'hi' }),
    })

  // The header above names eip155:8453, so these tests only reach the settle
  // path on a MAINNET deployment. Left ambient, a configured self-hosted chain
  // made all three fail at the 402 door — the refund logic they exist to cover
  // was never executed, and the failure read like a refund bug.
  let restoreDeployment = () => {}
  beforeEach(() => { restoreDeployment = asDeployment('base') })
  afterEach(() => restoreDeployment())

  // The paid fetch order: /get, /pay/pricing, facilitator /verify, /settle,
  // /pay/credit, /pay/invoke, /api/chat, then (on empty) /pay/refund.
  const paidPrelude = (fetchMock: any) =>
    fetchMock
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))               // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))         // /pay/pricing (paid)
      .mockResolvedValueOnce(jsonRes({ isValid: true }))              // facilitator /verify
      .mockResolvedValueOnce(jsonRes({ success: true, transaction: '0xtx', payer: '0xpayer' })) // /settle
      .mockResolvedValueOnce(jsonRes({ ok: true }))                   // /pay/credit
      .mockResolvedValueOnce(jsonRes({ ok: true }))                   // /pay/invoke

  it('a 200 stream that carries an error event and NO deltas → reverse + 502 refunded', async () => {
    process.env.X402_PAY_TO = PAY_TO
    const fetchMock = vi.fn()
    paidPrelude(fetchMock)
      // 200 stream that errored mid-flight — chatRes.ok is true, but no
      // textDelta/reasoning/tool ever landed. Old code returned "(empty
      // response)" 200 and kept the money.
      .mockResolvedValueOnce(new Response('data: {"type":"error","error":"model exploded"}\n', { status: 200 }))
      .mockResolvedValueOnce(jsonRes({ ok: true }))                   // /pay/refund
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.refunded).toBe(true)
    expect(body.paid).toBe(false)
    // The refund actually fired against the settlement txHash.
    const refundCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).endsWith('/pay/refund'))
    expect(refundCall).toBeDefined()
    expect(JSON.parse(refundCall![1].body)).toMatchObject({ ref: '0xtx' })
  })

  it('a 200 stream WITH real text is delivered + paid — no refund fires', async () => {
    process.env.X402_PAY_TO = PAY_TO
    const fetchMock = vi.fn()
    paidPrelude(fetchMock)
      .mockResolvedValueOnce(new Response('data: {"type":"modelContentBlockDeltaEvent","textDelta":"answer"}\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.response).toBe('answer')
    expect(body.paid_micro).toBe(50000)
    // The receipt carries the settlement tx hash + a network-correct BaseScan
    // link (the caller's on-chain proof) — mainnet payment → basescan.org, not
    // the sepolia host. The tx hash is the '0xtx' the settle mock returned.
    expect(body.tx_hash).toBe('0xtx')
    expect(body.explorer).toBe('https://basescan.org/tx/0xtx')
    // The SAME settlement proof rides the STANDARD x402 X-PAYMENT-RESPONSE
    // header (base64 SettleResponse), so a third-party payer that reads only the
    // spec header — not tiny's body-specific tx_hash — still gets on-chain proof.
    const hdr = res.headers.get('X-PAYMENT-RESPONSE')
    expect(hdr).toBeTruthy()
    const receipt = JSON.parse(Buffer.from(hdr as string, 'base64').toString('utf8'))
    expect(receipt).toMatchObject({ success: true, transaction: '0xtx', network: 'eip155:8453', payer: '0xpayer' })
    // No /pay/refund among the calls — a delivered answer keeps the earnings.
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/refund'))).toBe(false)
  })

  it('a tool-only turn (afterToolCallEvent, no final text) counts as delivered — NOT refunded', async () => {
    // Guard against over-refunding: a completed tool call is real work even if
    // the final text is empty, so it must not be clawed back.
    process.env.X402_PAY_TO = PAY_TO
    const fetchMock = vi.fn()
    paidPrelude(fetchMock)
      .mockResolvedValueOnce(new Response('data: {"type":"afterToolCallEvent","toolResult":{}}\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(paidReq(), { params })
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).endsWith('/pay/refund'))).toBe(false)
  })
})

describe('x402 GET discovery — fail CLOSED so a paid tiny is never advertised as free', () => {
  const getReq = () => new Request('https://tiny.technology/api/x402/chat/acme')
  const PAY_TO = '0x1234567890123456789012345678901234567890'
  // A paid discovery doc requires a configured payTo (mirrors POST's 424 guard),
  // so set it for the paid-tiny cases; the free/private/404/502 cases don't need it.
  // The deployment is pinned to base for the same reason as the block above: the
  // network table is what the doc advertises, and it must not be the shell's.
  let restore = () => {}
  beforeEach(() => { process.env.X402_PAY_TO = PAY_TO; restore = asDeployment('base') })
  afterEach(() => { delete process.env.X402_PAY_TO; restore() })
  // GET now resolves tiny + price in parallel (Promise.all order: /get, then
  // /pay/pricing), mirroring POST — so it honors the same existence/privacy
  // gating. Mock BOTH fetches in that order.

  it('a pricing-lookup non-2xx returns 502 (retry), NOT free:true', async () => {
    // A worker HTTP error carrying a JSON error body must not be mistaken for
    // "price 0" — a Bazaar crawler caching free:true would hammer the paid
    // endpoint with unpaid calls. Mirror of the POST fail-closed rule.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ error: 'db down' }, 503))   // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.free).toBeUndefined()
    expect(body.error).toContain('retry')
  })

  it('a genuine free tiny (pricing 200, price 0) still advertises free:true', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))          // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.free).toBe(true)
    expect(body.price_micro_usdc).toBe(0)
  })

  it('a paid tiny (pricing 200, price > 0) advertises the price and free:false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))      // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.free).toBe(false)
    expect(body.price_micro_usdc).toBe(50000)
  })

  it('the discovery doc advertises ONLY the deployment network (advertise = demand)', async () => {
    // On a mainnet deployment the doc must NOT list base-sepolia as a settlement
    // network — POST would 'unsupported network' any sepolia payment, so
    // advertising it tells a crawler to pay a door that's closed. "Mainnet" here
    // is the block's asDeployment('base') pin — `delete PAYMENTS_TESTNET` alone
    // let an inherited PAYMENTS_NETWORK turn this into a tiny-deployment doc,
    // which is how a guard against over-advertising ended up asserting nothing.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))      // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    const body: any = await res.json()
    expect(Object.keys(body.networks)).toEqual(['base'])
    expect(body.networks['base-sepolia']).toBeUndefined()
  })

  it('on a SELF-HOSTED deployment the doc advertises the tiny chain — and NEITHER Base', async () => {
    // The same advertise=demand rule, on the deployment the self-hosted chain
    // exists for. Getting this wrong is worse here than on sepolia: a crawler
    // told "base" would sign a real-USDC payment against a receiver that only
    // settles a token we mint, so the payment leaves its wallet and matches
    // nothing. The doc must name our chain id and our deployed TinyUSDC.
    const restore = asDeployment('tiny')
    vi.resetModules()
    try {
      const receiver = await import('../app/api/x402/chat/[slug]/route')
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
        .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))      // /pay/pricing
      vi.stubGlobal('fetch', fetchMock)

      const res = await receiver.GET(getReq(), { params })
      const body: any = await res.json()
      expect(Object.keys(body.networks)).toEqual(['tiny'])
      expect(body.networks.tiny).toEqual({ caip2: TINY_CAIP2, asset: TINY_USDC })
      expect(body.networks.base).toBeUndefined()
      expect(body.networks['base-sepolia']).toBeUndefined()
    } finally {
      vi.resetModules()
      restore()
    }
  })

  it('a PAID tiny with X402_PAY_TO unset returns 424 (never advertises a payable service every POST 424s)', async () => {
    // Advertise-vs-demand parity: POST 424s "x402 payments not configured" for a
    // paid tiny with no payTo (route :246), and the ERC-8004 registration doc
    // mirrors it. Discovery must too, or a crawler caches a payable 200 the
    // platform can't honor. Mirror the 424 — an unset env won't resolve on retry.
    delete process.env.X402_PAY_TO
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))      // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(424)
    const body: any = await res.json()
    expect(body.error).toContain('not configured')
    expect(body.free).toBeUndefined()
    expect(body.price_micro_usdc).toBeUndefined()
    // Never cache a misconfig — the moment X402_PAY_TO is set, the true doc serves.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a FREE tiny with X402_PAY_TO unset still advertises free:true (the 424 guard is paid-only)', async () => {
    delete process.env.X402_PAY_TO
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))          // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.free).toBe(true)
  })

  it('a non-integer price_micro (fractional/NaN) fails CLOSED to 502, never a malformed doc', async () => {
    // A worker anomaly (fractional/NaN/negative) must not become an unpayable
    // price_micro_usdc:1.5 or a NaN→null that reads free:false. Fail closed like
    // a pricing blip — the amount, not just its presence, must be trustworthy.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))            // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 1.5 }))        // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.error).toContain('retry')
    expect(body.price_micro_usdc).toBeUndefined()
  })

  it('a PRIVATE tiny is NOT discoverable (403) — parity with the POST 403, no info leak', async () => {
    // POST 403s a private tiny; discovery must not leak its existence/price/
    // how-to-pay, or it undoes the privacy the POST path enforces.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', private: true })) // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 50000 }))          // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(403)
    const body: any = await res.json()
    expect(body.free).toBeUndefined()
    expect(body.price_micro_usdc).toBeUndefined()
    expect(body.networks).toBeUndefined()
  })

  it('a MISSING tiny is 404, not a phantom free:true service', async () => {
    // Advertising free:true for a tiny that doesn't exist gets it cached by a
    // crawler that then POSTs it forever to a 404.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ response: 'tiny.technology is not exists' })) // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))                             // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(404)
    const body: any = await res.json()
    expect(body.free).toBeUndefined()
  })

  it('a /get outage returns 502 (retry), distinguishing an outage from a missing tiny', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))      // /get down
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))          // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(getReq(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.error).not.toContain('not found') // NOT a 404 masquerade
  })
})

describe('durableWrite — x402 ledger write durability', () => {
  it('a 2xx ok write returns true after ONE attempt (no retry, no reconcile log)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await durableWrite('https://w/pay/credit', { userId: 'x402:0xabc', amount_micro: 1000, ref: '0xtx' }, 'credit')

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('treats the idempotent-conflict shapes as durable success (already_credited / already_settled)', async () => {
    // A retry of an already-recorded txHash comes back 200 with an
    // already_* flag — that IS the write landing, not a failure.
    for (const shape of [{ already_credited: true }, { already_settled: true }]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonRes(shape))
      vi.stubGlobal('fetch', fetchMock)
      const ok = await durableWrite('https://w/pay/invoke', { ref: '0xtx' }, 'invoke', 1)
      expect(ok).toBe(true)
    }
  })

  it('retries a transient failure then succeeds — returns true, no reconcile log', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonRes({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await durableWrite('https://w/pay/credit', { ref: '0xtx' }, 'credit', 3)

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('exhausting all attempts emits a single x402-reconcile record with the full replay payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ error: 'db down' }, 500))
    vi.stubGlobal('fetch', fetchMock)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const body = { userId: 'x402:0xabc', amount_micro: 1000, ref: '0xdeadbeef' }
    const ok = await durableWrite('https://w/pay/credit', body, 'credit', 1)

    expect(ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    const [tag, payloadStr] = errSpy.mock.calls[0]
    expect(tag).toBe('x402-reconcile')
    const payload = JSON.parse(payloadStr as string)
    // The record must carry everything a human/sweep needs to replay the write.
    expect(payload).toMatchObject({ tag: 'credit', url: 'https://w/pay/credit', body })
    // Prefers the worker's own error message over the bare HTTP status.
    expect(payload.lastErr).toBe('db down')
  })

  it('a thrown fetch (network error) is caught and reconciled, never propagated', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await durableWrite('https://w/pay/invoke', { ref: '0xtx' }, 'invoke', 1)

    expect(ok).toBe(false)
    const payload = JSON.parse(errSpy.mock.calls[0][1] as string)
    expect(payload.lastErr).toContain('ECONNRESET')
  })
})
