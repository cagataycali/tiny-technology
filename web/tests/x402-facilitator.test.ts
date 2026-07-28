// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  facilitatorUrl, isPublicFacilitator, DEFAULT_PUBLIC_FACILITATOR,
} from '../lib/x402/facilitator'
import { asDeployment, TINY_FACILITATOR, TINY_CAIP2 } from './_deployment'

/**
 * 🏦 WHO SETTLES OUR CHAIN (report §1.2 item 2 — "You must run your own x402
 * facilitator").
 *
 * The receiver never moves money itself: it POSTs the payer's signed EIP-3009
 * authorization to a facilitator's /verify then /settle. Which facilitator was
 * one line — `X402_FACILITATOR_URL || 'https://x402.org/facilitator'` — and
 * that default can only settle base + base-sepolia.
 *
 * So the deployment this entire chain/ directory exists for (PAYMENTS_NETWORK=
 * tiny) shipped a payment door that advertised TinyUSDC on our own chain as
 * payable, accepted the payer's signature for it, and forwarded that signature
 * to a public service that has no RPC for our chain and no such token.
 *
 * The settle fails either way — no funds are lost. What the guard buys is the
 * ORDER: a transferWithAuthorization signature is a bearer instrument (anyone
 * who can reach our RPC may submit it), and the check that it can never be
 * settled is free and static. So refuse at the door, before anyone signs.
 *
 * This is the same guard the same three routes already apply to X402_PAY_TO;
 * the only reason the facilitator escaped it is that its unset state had a
 * default that LOOKED like a working value.
 */

let restore = () => {}
afterEach(() => {
  restore()
  restore = () => {}
  vi.unstubAllEnvs()
})

describe('facilitatorUrl — the Base deployments are unchanged', () => {
  it('unset on mainnet → the public facilitator, exactly as shipped', () => {
    restore = asDeployment('base')
    expect(facilitatorUrl()).toBe(DEFAULT_PUBLIC_FACILITATOR)
    expect(DEFAULT_PUBLIC_FACILITATOR).toBe('https://x402.org/facilitator')
  })

  it('unset on testnet → the public facilitator too', () => {
    restore = asDeployment('base-sepolia')
    expect(facilitatorUrl()).toBe(DEFAULT_PUBLIC_FACILITATOR)
  })

  it('an explicit facilitator wins on the Base chains (e.g. Coinbase CDP)', () => {
    // The go-live checklist's own upgrade path: "for mainnet-grade settlement,
    // switch to the Coinbase CDP facilitator". A public facilitator naming a
    // public chain is the supported configuration, not a misconfiguration.
    restore = asDeployment('base')
    vi.stubEnv('X402_FACILITATOR_URL', 'https://api.cdp.coinbase.com/platform/v2/x402')
    expect(facilitatorUrl()).toBe('https://api.cdp.coinbase.com/platform/v2/x402')
  })

  it('a self-hosted facilitator on a Base chain is allowed (a proxy is the operator\'s call)', () => {
    restore = asDeployment('base')
    vi.stubEnv('X402_FACILITATOR_URL', 'https://facilitator.example.com')
    expect(facilitatorUrl()).toBe('https://facilitator.example.com')
  })

  it('a trailing slash is stripped — callers append /verify and /settle', () => {
    restore = asDeployment('base')
    vi.stubEnv('X402_FACILITATOR_URL', 'https://f.example.com/x402///')
    expect(facilitatorUrl()).toBe('https://f.example.com/x402')
  })

  it('surrounding whitespace is tolerated — env files collect it', () => {
    restore = asDeployment('base')
    vi.stubEnv('X402_FACILITATOR_URL', '  https://f.example.com  ')
    expect(facilitatorUrl()).toBe('https://f.example.com')
  })
})

describe('facilitatorUrl — a self-hosted chain has no possible default', () => {
  it('UNSET on a self-hosted chain → null, so the door fails closed', () => {
    // The finding. There is no facilitator that both (a) we haven't configured
    // and (b) can settle a chain we own, so "unset" cannot be quietly resolved
    // into a working value the way it is on Base.
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', '')
    expect(facilitatorUrl()).toBeNull()
  })

  it('our own facilitator on our own chain → that URL (the correct configuration)', () => {
    // chain/facilitator/server.mjs, default port 8546. The fixture pins it,
    // because a self-hosted deployment WITHOUT it is misconfigured by definition.
    restore = asDeployment('tiny')
    expect(facilitatorUrl()).toBe(TINY_FACILITATOR)
  })

  it('x402.org NAMED on a self-hosted chain → null (the likely misconfiguration)', () => {
    // Not a hypothetical: docs/payments-go-live-checklist.md told operators to
    // leave the var unset, i.e. to use exactly this facilitator. Copying that
    // instruction onto a tiny-chain deployment must not produce a payable door.
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', DEFAULT_PUBLIC_FACILITATOR)
    expect(facilitatorUrl()).toBeNull()
  })

  it('Coinbase CDP on a self-hosted chain → null (same impossibility, different vendor)', () => {
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', 'https://api.cdp.coinbase.com/platform/v2/x402')
    expect(facilitatorUrl()).toBeNull()
  })

  it('the hostname decides, not the path or the scheme', () => {
    restore = asDeployment('tiny')
    for (const u of [
      'https://x402.org',
      'http://x402.org/facilitator',
      'https://www.x402.org/facilitator/',
      'https://X402.ORG/facilitator',
    ]) {
      vi.stubEnv('X402_FACILITATOR_URL', u)
      expect(facilitatorUrl()).toBeNull()
    }
  })

  it('a lookalike hostname is NOT treated as the public facilitator', () => {
    // Precision matters in both directions: an operator who really does run
    // `x402.org.mycorp.internal` for their own chain must not be blocked by a
    // substring match, and a `notx402.org` must not be waved through as public.
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', 'https://x402.org.mycorp.internal/facilitator')
    expect(facilitatorUrl()).toBe('https://x402.org.mycorp.internal/facilitator')
  })
})

describe('facilitatorUrl — a malformed value fails closed, never becomes a fetch base', () => {
  it('junk / relative / wrong-scheme values → null on every deployment', () => {
    for (const dep of ['base', 'base-sepolia', 'tiny'] as const) {
      restore = asDeployment(dep)
      for (const junk of ['not a url', '/facilitator', 'facilitator.example.com', 'ftp://f.example.com', 'javascript:alert(1)', 'https://']) {
        vi.stubEnv('X402_FACILITATOR_URL', junk)
        expect(facilitatorUrl()).toBeNull()
      }
      restore()
      restore = () => {}
    }
  })

  it('a typo does NOT silently fall back to the public facilitator', () => {
    // The dangerous alternative implementation: treat unparseable as unset. On
    // a self-hosted chain that would resurrect the exact bug — a typo'd
    // facilitator URL would resolve to x402.org and start collecting
    // signatures for a chain it cannot settle.
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', 'htp://127.0.0.1:8546')
    expect(facilitatorUrl()).toBeNull()
  })

  it('a bad value on a BASE deployment also fails closed, rather than reverting to the default', () => {
    // Same reasoning, less severe: the operator asked for a specific
    // facilitator, and quietly substituting a different one is not a fallback
    // anybody wants from a money path.
    restore = asDeployment('base')
    vi.stubEnv('X402_FACILITATOR_URL', 'not a url')
    expect(facilitatorUrl()).toBeNull()
  })

  it('is read per CALL — routes must see an env change without a redeploy of the module', () => {
    restore = asDeployment('tiny')
    vi.stubEnv('X402_FACILITATOR_URL', '')
    expect(facilitatorUrl()).toBeNull()
    vi.stubEnv('X402_FACILITATOR_URL', TINY_FACILITATOR)
    expect(facilitatorUrl()).toBe(TINY_FACILITATOR)
  })
})

describe('isPublicFacilitator', () => {
  it('knows the public-chain-only facilitators', () => {
    expect(isPublicFacilitator('https://x402.org/facilitator')).toBe(true)
    expect(isPublicFacilitator('https://api.cdp.coinbase.com/platform/v2/x402')).toBe(true)
  })

  it('a private/self-hosted facilitator is not public', () => {
    expect(isPublicFacilitator(TINY_FACILITATOR)).toBe(false)
    expect(isPublicFacilitator('https://facilitator.example.com')).toBe(false)
  })

  it('junk is not public (the caller decides what to do with unparseable)', () => {
    expect(isPublicFacilitator('not a url')).toBe(false)
    expect(isPublicFacilitator('')).toBe(false)
  })
})

/**
 * 🚪 THE THREE DOORS. A tiny is payable only if all of: it has a price, the
 * platform has a receiving address, AND some facilitator can settle the chain
 * we advertise. The receiver POST, its GET discovery doc, and the ERC-8004
 * registration must agree — the last one bakes its answer PERMANENTLY on-chain.
 */
describe('the payment doors fail closed when nothing can settle our chain', () => {
  const jsonRes = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const params = Promise.resolve({ slug: 'acme' })
  /** /get then /pay/pricing, the pair every one of these routes resolves first. */
  const stubWorker = (priceMicro: number) => vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(jsonRes({ name: 'acme' }))
    .mockResolvedValueOnce(jsonRes({ price_micro: priceMicro })))

  afterEach(() => vi.unstubAllGlobals())

  /** A self-hosted deployment with NO facilitator configured. */
  const brokenSelfHosted = () => {
    const r = asDeployment('tiny')
    process.env.X402_FACILITATOR_URL = ''
    process.env.X402_PAY_TO = '0x000000000000000000000000000000000000dEaD'
    return r
  }

  it('POST: a paid tiny 424s instead of emitting a 402 nobody can settle', async () => {
    restore = brokenSelfHosted()
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')
    stubWorker(50_000)
    const res = await receiver.POST(new Request('https://tiny.technology/api/x402/chat/acme', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    }), { params })
    // NOT 402: a 402 is an invitation to sign, and the signature is a bearer
    // instrument we already know we can never redeem.
    expect(res.status).toBe(424)
    expect((await res.json()).error).toContain('not configured')
    vi.resetModules()
  })

  it('GET: discovery 424s and is never cached (no crawler learns a false price)', async () => {
    restore = brokenSelfHosted()
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')
    stubWorker(50_000)
    const res = await receiver.GET(new Request('https://tiny.technology/api/x402/chat/acme'), { params })
    expect(res.status).toBe(424)
    const body: any = await res.json()
    expect(body.price_micro_usdc).toBeUndefined()
    expect(body.free).toBeUndefined()
    // The moment a facilitator is configured the true doc must serve.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    vi.resetModules()
  })

  it('ERC-8004: the registration 424s — no agent mints "payable" terms we cannot honor', async () => {
    // The most permanent surface: `register_agent` bakes this doc's payment
    // terms on-chain, where they can't be edited afterwards.
    restore = brokenSelfHosted()
    vi.resetModules()
    const reg = await import('../app/api/erc8004/registration/[slug]/route')
    stubWorker(50_000)
    const res = await reg.GET(new Request('https://tiny.technology/api/erc8004/registration/acme'), { params })
    expect(res.status).toBe(424)
    const body: any = await res.json()
    expect(body.x402Support).toBeUndefined()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    vi.resetModules()
  })

  it('a FREE tiny still serves on all three doors — the guard is paid-only', async () => {
    // A facilitator is only needed to take money. The free courtesy API, its
    // discovery doc and its registration must not be collateral damage.
    restore = brokenSelfHosted()
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')
    stubWorker(0)
    const disc = await receiver.GET(new Request('https://tiny.technology/api/x402/chat/acme'), { params })
    expect(disc.status).toBe(200)
    expect((await disc.json()).free).toBe(true)

    const reg = await import('../app/api/erc8004/registration/[slug]/route')
    stubWorker(0)
    const regRes = await reg.GET(new Request('https://tiny.technology/api/erc8004/registration/acme'), { params })
    expect(regRes.status).toBe(200)
    const regBody: any = await regRes.json()
    expect(regBody.x402Support).toBe(false)
    vi.resetModules()
  })

  it('WITH our own facilitator, the same paid tiny is payable on our chain', async () => {
    // The positive control: the guard must gate on the misconfiguration, not on
    // "self-hosted chain" — otherwise it would have broken the deployment mode
    // the whole chain/ directory exists to support.
    restore = asDeployment('tiny')
    process.env.X402_PAY_TO = '0x000000000000000000000000000000000000dEaD'
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')
    stubWorker(50_000)
    const res = await receiver.GET(new Request('https://tiny.technology/api/x402/chat/acme'), { params })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.free).toBe(false)
    expect(Object.keys(body.networks)).toEqual(['tiny'])
    expect(body.networks.tiny.caip2).toBe(TINY_CAIP2)
    vi.resetModules()
  })

  it('a MAINNET deployment with no facilitator env is payable as before (no regression)', async () => {
    // The deployment tiny.technology actually runs today: X402_FACILITATOR_URL
    // unset, and that is the correct, working configuration.
    restore = asDeployment('base')
    process.env.X402_PAY_TO = '0x000000000000000000000000000000000000dEaD'
    vi.resetModules()
    const receiver = await import('../app/api/x402/chat/[slug]/route')
    stubWorker(50_000)
    const res = await receiver.GET(new Request('https://tiny.technology/api/x402/chat/acme'), { params })
    expect(res.status).toBe(200)
    expect((await res.json()).free).toBe(false)
    vi.resetModules()
  })
})
