// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

/**
 * 🪪 ERC-8004 registration file (app/api/erc8004/registration/[slug]).
 *
 * A minting/consuming agent reads THIS file to learn how to pay a priced tiny.
 * It must therefore carry the same payment facts the x402 challenge emits —
 * scheme, payTo, and every accepted (network CAIP-2, USDC asset) — so the
 * registration stands alone as discovery, no second probe round-trip needed.
 * These lock that consistency + the fail-closed pricing discipline.
 */
import { GET } from '../app/api/erc8004/registration/[slug]/route'
// Deployment pinning — the registration doc advertises the network the
// deployment settles on, and `paymentsNetwork()` reads PAYMENTS_NETWORK before
// PAYMENTS_TESTNET, so tests must pin BOTH (tests/_deployment.ts) or inherit
// the shell's deployment and go red on any self-hosted checkout.
import { asDeployment } from './_deployment'

const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const params = Promise.resolve({ slug: 'acme' })
const req = () => new Request('https://tiny.technology/api/erc8004/registration/acme')

const PAY_TO = '0x1234567890123456789012345678901234567890'

let restoreDeployment = () => {}
beforeEach(() => { process.env.X402_PAY_TO = PAY_TO; restoreDeployment = asDeployment('base') })
afterEach(() => { vi.restoreAllMocks(); restoreDeployment() })

describe('erc8004 registration — payment discovery is self-describing for a paid tiny', () => {
  it('a paid tiny (mainnet deployment) advertises scheme + payTo + ONLY the base accept', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', systemPrompt: 'hi' })) // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))                 // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const x402 = body.services.find((s: any) => s.name === 'x402-chat')

    expect(body.x402Support).toBe(true)
    expect(x402.priceMicroUsdc).toBe(1000)
    expect(x402.scheme).toBe('exact')
    expect(x402.payTo).toBe(PAY_TO)
    // ONLY the network THIS (default = mainnet) deployment settles. The served
    // doc must mirror the x402 challenge, which post-bd48d8a0 offers exactly one
    // network via offeredNetworks() — advertising base-sepolia here too would
    // bake on-chain a door the receiver's matchRequirement() returns null for,
    // 424ing every payment signed against it. (X402_NETWORKS still carries BOTH
    // — the parity test locks the full table; this is the runtime OFFER filter.)
    expect(x402.accepts.map((a: any) => a.network)).toEqual(['eip155:8453'])
    expect(x402.accepts[0].asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  it('a paid tiny on a TESTNET deployment advertises ONLY the base-sepolia accept', async () => {
    // A sepolia deployment settles base-sepolia only; the served registration
    // must match so a minting agent signs the chain that settles. (asDeployment
    // pins both selector vars — beforeEach pinned base, override it here.)
    restoreDeployment()
    restoreDeployment = asDeployment('base-sepolia')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', systemPrompt: 'hi' })) // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))                 // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const x402 = body.services.find((s: any) => s.name === 'x402-chat')

    expect(x402.accepts.map((a: any) => a.network)).toEqual(['eip155:84532'])
    expect(x402.accepts[0].asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  })

  it('a free tiny carries NO payment metadata (no accepts / payTo / price)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))    // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))  // /pay/pricing (free)
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    const body: any = await res.json()
    const x402 = body.services.find((s: any) => s.name === 'x402-chat')

    expect(body.x402Support).toBe(false)
    expect(x402.priceMicroUsdc).toBeUndefined()
    expect(x402.accepts).toBeUndefined()
    expect(x402.payTo).toBeUndefined()
  })

  it('fails CLOSED (424) for a PAID tiny when X402_PAY_TO is unset — never advertises a service the relay 424s', async () => {
    // A paid tiny with no receiving address configured is exactly what the relay
    // (x402/chat POST) rejects with 424 "x402 payments not configured". Serving a
    // payable registration here (x402Support:true, scheme, accepts[]) minus payTo
    // would hand a minting agent a service every payment 424s — and this 200 is
    // cacheable + is what register_agent bakes PERMANENTLY on-chain. Must mirror
    // the relay's 424 so the two endpoints agree and no broken doc gets minted.
    delete process.env.X402_PAY_TO
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(424)
    const body: any = await res.json()
    expect(body.error).toContain('not configured')
    expect(body.x402Support).toBeUndefined()  // no payable registration leaked
    expect(body.services).toBeUndefined()     // no registration doc at all
    // Never cache a misconfig — the moment X402_PAY_TO is set, the real doc must
    // be servable without waiting out a TTL (same rule as the 403/502 branches).
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('fails CLOSED on a pricing-lookup blip — 502 retry, never a false "free" to the minting agent', async () => {
    // /get ok, /pay/pricing HTTP-errors → pricing null. Serving 200 +
    // x402Support:false here would fail OPEN to the DIRECT caller (no-store only
    // guards downstream caches). This URL is what register_agent points at to
    // mint an ERC-8004 identity ON-CHAIN, so a false "free" during an outage
    // could be baked permanently. Must 502 (retryable), mirroring x402/chat.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))
      .mockResolvedValueOnce(jsonRes({ error: 'db down' }, 503))
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.error).toContain('retry')
    expect(body.x402Support).toBeUndefined() // no registration doc leaked
    expect(res.headers.get('Cache-Control')).toBe('no-store') // never cache the error
  })

  it('a genuine free tiny (pricing 200, price 0) still succeeds and is cacheable', async () => {
    // Guard against over-correction: a REAL price-0 lookup is not a blip.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme' }))
      .mockResolvedValueOnce(jsonRes({ price_micro: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.x402Support).toBe(false)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  it('a PRIVATE tiny 403s and leaks NO persona — the registration file must not unmask it', async () => {
    // Load-bearing privacy invariant (route header: "the registration file must
    // not leak metadata"). A private tiny's systemPrompt is what a PUBLIC tiny's
    // `description` is built from, so if a refactor ever drops the `tiny.private`
    // guard, that masked prompt would ship in the served doc. This pins the guard:
    // 403, never-cached, and — crucially — the secret prompt appears nowhere in
    // the response body. (Same mask the x402/chat POST + GET routes enforce.)
    const secret = 'SECRET-SYSTEM-PROMPT-do-not-leak'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', private: true, systemPrompt: secret })) // /get
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))                                  // /pay/pricing
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    expect(res.status).toBe(403)
    const rawBody = JSON.stringify(await res.json())
    expect(rawBody).toContain('is private')
    expect(rawBody).not.toContain(secret)     // no persona/system-prompt leak
    expect(rawBody).not.toContain('services') // no registration doc at all
    // A 403 must never be cached — else a tiny that later goes public keeps
    // 403ing at its on-chain registration URL until the TTL expires.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('strips markdown from the on-chain description — no raw **/#/[](	) syntax baked permanently', async () => {
    // description is minted PERMANENTLY on-chain and rendered as PLAIN TEXT by
    // consuming agent registries, so markdown syntax must not survive into it
    // (the OG share card already strips the same systemPrompt field via removeMd
    // — the more permanent surface must be at least as clean). Also pins that
    // the 500-char clamp counts VISIBLE characters: markup is removed BEFORE the
    // slice, so a heavily-marked prompt isn't truncated by its own syntax budget.
    const md = '# Legal Helper\n\n**Expert** contract review — see [our terms](https://x.example) for _details_.'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', systemPrompt: md }))
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    const body: any = await res.json()
    // The visible words survive; the markup characters do not.
    expect(body.description).toContain('Legal Helper')
    expect(body.description).toContain('Expert')
    expect(body.description).toContain('our terms')
    expect(body.description).not.toContain('**')
    expect(body.description).not.toContain('# ')
    expect(body.description).not.toContain('](')   // no raw link syntax
    expect(body.description).not.toContain('https://x.example') // link URL dropped, not shown literally
  })

  it('advertises supportedTrust exactly as minted on-chain — pins the permanent claim', async () => {
    // supportedTrust is baked PERMANENTLY on-chain when an agent mints its
    // identity from this file, so a silent change to the claim (adding/removing a
    // trust model that isn't actually wired) is durable and un-baked. This locks
    // the emitted value: change it deliberately, and update this test in the same
    // commit. (Standing note: 'reputation' has no reputation logic behind it yet —
    // a known deferred product decision, tracked separately, not a test bug.)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ name: 'acme', systemPrompt: 'hi' }))
      .mockResolvedValueOnce(jsonRes({ price_micro: 1000 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(req(), { params })
    const body: any = await res.json()
    expect(body.supportedTrust).toEqual(['reputation'])
  })
})
