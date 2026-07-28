// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  canonicalNetwork, parseChallenge, selectAccept, buildAuthorization,
  buildTypedData, encodePaymentHeader, isExpectedUsdc, PAYER_NETWORKS,
  encodeQuote, decodeQuote, parseSettlementTx, settlementTxFromBody,
  explorerTxUrl, effectiveSpendCap, advertisablePriceMicro, type QuoteFields,
} from '../lib/x402/payer'

// Real USDC contracts — selectAccept now binds the accept to the expected USDC
// per network (we front USDC only), so tests must use the true addresses.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/**
 * 🤝 First-party x402 PAYER — pure logic. These lock the money-selecting and
 * signing-payload construction so a challenge can never be mis-paid: wrong
 * network, over-cap spend, or a malformed authorization.
 */

const challengeBody = (opts: { nets?: string[]; amount?: string } = {}) => ({
  x402Version: 1,
  accepts: (opts.nets || ['eip155:8453', 'eip155:84532']).map((network) => ({
    scheme: 'exact',
    network,
    maxAmountRequired: opts.amount ?? '10000', // $0.01
    resource: 'https://tiny.technology/api/x402/chat/acme',
    payTo: '0x1111111111111111111111111111111111111111',
    asset: network.includes('84532')
      ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    maxTimeoutSeconds: 120,
    extra: { name: 'USD Coin', version: '2' },
  })),
})

describe('canonicalNetwork', () => {
  it('folds every alias onto CAIP-2', () => {
    for (const s of ['base', 'BASE', 'eip155:8453', '8453']) expect(canonicalNetwork(s)).toBe('eip155:8453')
    for (const s of ['base-sepolia', 'sepolia', 'eip155:84532', '84532']) expect(canonicalNetwork(s)).toBe('eip155:84532')
  })
})

describe('parseChallenge', () => {
  it('parses a valid challenge and canonicalizes networks', () => {
    const c = parseChallenge(challengeBody({ nets: ['base', 'base-sepolia'] }))!
    expect(c).not.toBeNull()
    expect(c.accepts.map(a => a.network)).toEqual(['eip155:8453', 'eip155:84532'])
  })
  it('rejects empty / malformed bodies', () => {
    expect(parseChallenge(null)).toBeNull()
    expect(parseChallenge({})).toBeNull()
    expect(parseChallenge({ accepts: [] })).toBeNull()
    // No usable (exact + payTo + asset) entries → null.
    expect(parseChallenge({ accepts: [{ scheme: 'upto' }] })).toBeNull()
  })
})

describe('selectAccept — pick a network we can pay, within cap', () => {
  it('prefers mainnet when both offered and affordable', () => {
    const c = parseChallenge(challengeBody())!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r && r.network).toBe('eip155:8453')
  })
  it('falls to the affordable network when mainnet is over cap', () => {
    // mainnet $1.00, sepolia $0.001 — cap $0.01 rules out mainnet.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1000000', payTo: '0xabc', asset: USDC_BASE },
        { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '1000', payTo: '0xabc', asset: USDC_SEPOLIA },
      ],
    })!
    const r = selectAccept(c, 10_000)
    expect('accept' in r && r.network).toBe('eip155:84532')
  })
  it('errors when every offer exceeds the cap, reporting the cheapest', () => {
    const c = parseChallenge(challengeBody({ amount: '50000000' }))! // $50
    const r = selectAccept(c, 1_000_000) // $1 cap
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.needMicro).toBe(50000000) // raw micro — the machine field
      // …but the PROSE names DOLLARS, not raw micro-USDC integers (this string
      // reaches the user via the pay_x402 tool). "$50.00", "$1.00" — never
      // "50000000 micro-USDC, over the 1000000 cap".
      expect(r.error).toBe('cheapest offer is $50.00, over your $1.00 cap')
      expect(r.error).not.toMatch(/micro-USDC|\b\d{4,}\b/) // no bare micro integers
    }
  })
  it('errors when no supported network is offered', () => {
    const c = parseChallenge({
      x402Version: 1,
      accepts: [{ scheme: 'exact', network: 'eip155:1', maxAmountRequired: '10', payTo: '0xabc', asset: '0xUSDC' }],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('error' in r && r.error).toMatch(/unsupported/)
  })

  // A price MUST be a canonical integer micro-USDC string. decodeQuote rejects
  // anything else at EXECUTE time (/^\d+$/), so if selectAccept mints a quote
  // for a fractional / scientific / hex / padded amount, the user's Approve tap
  // dead-ends as "invalid or tampered payment quote" — for a quote nothing
  // tampered with. selectAccept must refuse these up front with a clear reason.
  for (const bad of ['1.5', '1e4', '0x2710', '  5000 ', '', 'abc', '-100']) {
    it(`rejects a non-integer micro price ${JSON.stringify(bad)} instead of minting a doomed quote`, () => {
      const c = parseChallenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: bad, payTo: '0xabc', asset: USDC_BASE }],
      })!
      const r = selectAccept(c, 1_000_000)
      expect('accept' in r).toBe(false)
      if ('error' in r) expect(r.error).toMatch(/non-integer|unsupported/)
    })
  }

  it('a malformed price is reported as un-payable, NOT as a cap problem (no misleading top-up hint)', () => {
    const c = parseChallenge({
      x402Version: 1,
      accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1.5', payTo: '0xabc', asset: USDC_BASE }],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/non-integer/)
      expect(r.needMicro).toBeUndefined() // not a "top up to afford it" situation
    }
  })

  it('rejects a $0 / amount-absent accept instead of minting an "Approve $0.00" quote', () => {
    // "0" passes /^\d+$/ and 0 <= cap, so without the amt > 0 floor selectAccept
    // would return it as affordable → a bogus $0.00 approval card whose tap 400s
    // at the worker (not insufficient_balance) → a FALSE x402pay-reconcile line.
    for (const zero of ['0', '00']) {
      const c = parseChallenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: zero, payTo: '0xabc', asset: USDC_BASE }],
      })!
      const r = selectAccept(c, 1_000_000)
      expect('error' in r).toBe(true)
    }
    // an amount-absent accept (parseChallenge defaults maxAmountRequired to "0")
    const cAbsent = parseChallenge({
      x402Version: 1,
      accepts: [{ scheme: 'exact', network: 'eip155:8453', payTo: '0xabc', asset: USDC_BASE }],
    })!
    expect('error' in selectAccept(cAbsent, 1_000_000)).toBe(true)
  })

  it('picks a positive-integer network when a $0 offer sits alongside a good one', () => {
    // mainnet quotes $0 (unpayable), sepolia quotes a clean positive integer.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '0', payTo: '0xabc', asset: USDC_BASE },
        { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '1000', payTo: '0xabc', asset: USDC_SEPOLIA },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r && r.network).toBe('eip155:84532')
    if ('accept' in r) expect(r.accept.maxAmountRequired).toBe('1000')
  })

  it('picks the CHEAPEST affordable offer within the preferred network, not array-order-first', () => {
    // one resource, three base-mainnet USDC prices out of order — must quote the
    // cheapest ($0.002), never the array-first ($0.005).
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000', payTo: '0xabc', asset: USDC_BASE },
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '2000', payTo: '0xabc', asset: USDC_BASE },
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '3000', payTo: '0xabc', asset: USDC_BASE },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r).toBe(true)
    if ('accept' in r) expect(r.accept.maxAmountRequired).toBe('2000')
  })

  it('cheapest-pick never crosses the mainnet-first tier (a cheaper testnet offer does not win)', () => {
    // testnet is cheaper in raw micro, but real-USDC mainnet is the preferred
    // tier — the mainnet offer must win even though its number is larger.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '10', payTo: '0xabc', asset: USDC_SEPOLIA },
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '5000', payTo: '0xabc', asset: USDC_BASE },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r && r.network).toBe('eip155:8453')
    if ('accept' in r) expect(r.accept.maxAmountRequired).toBe('5000')
  })

  it('picks the integer-priced network when a malformed offer sits alongside a good one', () => {
    // mainnet quotes garbage, sepolia quotes a clean integer — take sepolia.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1.5', payTo: '0xabc', asset: USDC_BASE },
        { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '1000', payTo: '0xabc', asset: USDC_SEPOLIA },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r && r.network).toBe('eip155:84532')
    if ('accept' in r) expect(r.accept.maxAmountRequired).toBe('1000')
  })

  // ── Deployment network gating (offeredNet) — the OUTBOUND mirror of the
  //    receiver's offeredNetworks() bound (bd48d8a0). We sign off-chain, so the
  //    ONLY thing choosing which chain we authorize on is this pick; a testnet
  //    deployment must never sign a mainnet transfer its wallet can't back.
  describe('offeredNet — restrict to the ONE network this deployment settles', () => {
    it('a TESTNET deployment picks base-sepolia even when mainnet is offered + affordable', () => {
      // Without the bound, mainnet-first would pick base — a mainnet auth the
      // testnet-funded hot wallet can't back, signed AFTER the ledger reserved.
      const c = parseChallenge(challengeBody())! // both nets, $0.01 each
      const r = selectAccept(c, 1_000_000, 'eip155:84532')
      expect('accept' in r && r.network).toBe('eip155:84532')
    })
    it('a MAINNET deployment picks base and ignores an offered base-sepolia', () => {
      const c = parseChallenge(challengeBody())!
      const r = selectAccept(c, 1_000_000, 'eip155:8453')
      expect('accept' in r && r.network).toBe('eip155:8453')
    })
    it('errors with a deployment-vs-service reason when the service does not offer our settled network', () => {
      // Service offers ONLY mainnet; a testnet deployment can't settle it. This
      // is a mismatch the user can't fix by topping up — the reason must say so,
      // not blame the wallet balance, and carry no needMicro top-up hint.
      const c = parseChallenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0xabc', asset: USDC_BASE }],
      })!
      const r = selectAccept(c, 1_000_000, 'eip155:84532')
      expect('error' in r).toBe(true)
      if ('error' in r) {
        expect(r.error).toMatch(/doesn't accept payment on base-sepolia/)
        expect(r.needMicro).toBeUndefined()
      }
    })
    it('still reports plain "unsupported networks" when the service offers NO network we support', () => {
      // offeredNet set, but the service names only eip155:1 — keep the original
      // unsupported-networks message (not the deployment-mismatch one), since we
      // couldn't pay this service on ANY deployment.
      const c = parseChallenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'eip155:1', maxAmountRequired: '10', payTo: '0xabc', asset: '0xUSDC' }],
      })!
      const r = selectAccept(c, 1_000_000, 'eip155:8453')
      expect('error' in r && r.error).toMatch(/unsupported/)
    })
    it('omitting offeredNet preserves the original both-networks, mainnet-first behavior', () => {
      const c = parseChallenge(challengeBody())!
      const r = selectAccept(c, 1_000_000)
      expect('accept' in r && r.network).toBe('eip155:8453')
    })
  })

  it('INVARIANT: any amount selectAccept picks is one decodeQuote will accept at execute time', () => {
    // The two functions must agree on what a valid micro-USDC amount is, or a
    // freshly-minted quote is un-executable from birth.
    for (const amt of ['1.5', '1e4', '0x2710', '10000', '0', '  5000 ']) {
      const c = parseChallenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: amt, payTo: '0xabc', asset: USDC_BASE }],
      })!
      const r = selectAccept(c, 1_000_000)
      if ('accept' in r) {
        // decodeQuote's amountMicro guard is /^\d+$/ — selectAccept must only
        // ever hand back amounts that pass it.
        expect(/^\d+$/.test(r.accept.maxAmountRequired)).toBe(true)
      }
    }
  })
})

describe('isExpectedUsdc — the payer fronts USDC only, never another token', () => {
  it('accepts the canonical USDC per network (case-insensitively)', () => {
    expect(isExpectedUsdc('eip155:8453', USDC_BASE)).toBe(true)
    expect(isExpectedUsdc('eip155:8453', USDC_BASE.toUpperCase())).toBe(true)
    expect(isExpectedUsdc('eip155:84532', USDC_SEPOLIA)).toBe(true)
    // Network aliases fold to the same canonical form.
    expect(isExpectedUsdc('base', USDC_BASE)).toBe(true)
    expect(isExpectedUsdc('base-sepolia', USDC_SEPOLIA)).toBe(true)
  })
  it('rejects a different token, the wrong-network USDC, and empty/garbage', () => {
    expect(isExpectedUsdc('eip155:8453', '0xdeadbeef00000000000000000000000000000000')).toBe(false)
    expect(isExpectedUsdc('eip155:8453', USDC_SEPOLIA)).toBe(false) // sepolia USDC on mainnet
    expect(isExpectedUsdc('eip155:1', USDC_BASE)).toBe(false)       // unsupported network
    expect(isExpectedUsdc('eip155:8453', '')).toBe(false)
  })
})

describe('selectAccept — asset binding: never sign a transfer of a non-USDC token', () => {
  it('REFUSES an accept on a supported network but a NON-USDC asset', () => {
    // A buggy/compromised allowlisted host offers a supported network + payable
    // price, but names some other token contract. The hot wallet would sign a
    // TransferWithAuthorization for THAT token (verifyingContract = asset) —
    // draining an asset we hold. Must fail closed with a precise reason.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0xabc', asset: '0xEvIlToken000000000000000000000000000000' }],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r).toBe(false)
    if ('error' in r) expect(r.error).toMatch(/USDC/)
  })

  it('takes the USDC entry when a non-USDC offer sits alongside it on the same network', () => {
    // Offer USDC and some other token, both affordable on mainnet — we must pick
    // the USDC one, not whatever sorts first.
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0xabc', asset: '0xNotUsdc00000000000000000000000000000000' },
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0xabc', asset: USDC_BASE },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r).toBe(true)
    if ('accept' in r) expect(r.accept.asset.toLowerCase()).toBe(USDC_BASE.toLowerCase())
  })

  it('falls to the USDC-on-testnet entry when mainnet offers only a non-USDC token', () => {
    const c = parseChallenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0xabc', asset: '0xNotUsdc00000000000000000000000000000000' },
        { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '10000', payTo: '0xabc', asset: USDC_SEPOLIA },
      ],
    })!
    const r = selectAccept(c, 1_000_000)
    expect('accept' in r && r.network).toBe('eip155:84532')
  })
})

describe('buildAuthorization', () => {
  it('sets a skew-tolerant validAfter and a bounded validBefore', () => {
    const a = buildAuthorization({ from: '0xF', to: '0xT', valueMicro: '10000', nonce: '0xNN', nowSec: 1_000_000, validForSec: 120 })
    expect(a.from).toBe('0xF')
    expect(a.value).toBe('10000')
    expect(Number(a.validAfter)).toBe(1_000_000 - 60) // 60s back-dated for skew
    expect(Number(a.validBefore)).toBe(1_000_000 + 120)
    expect(a.nonce).toBe('0xNN')
  })
  it('floors a too-short validity window to 60s', () => {
    const a = buildAuthorization({ from: '0xF', to: '0xT', valueMicro: '1', nonce: '0x0', nowSec: 100, validForSec: 5 })
    expect(Number(a.validBefore)).toBe(100 + 60)
  })
})

describe('buildTypedData — EIP-3009 TransferWithAuthorization', () => {
  it('produces the canonical type list, domain, and bigint message', () => {
    const c = parseChallenge(challengeBody())!
    const accept = c.accepts[0] // mainnet
    const auth = buildAuthorization({ from: '0xAbC', to: accept.payTo, valueMicro: accept.maxAmountRequired, nonce: '0x' + '00'.repeat(32), nowSec: 1000, validForSec: 120 })
    const td = buildTypedData(accept, auth)
    expect(td.primaryType).toBe('TransferWithAuthorization')
    expect(td.types.TransferWithAuthorization.map(f => f.name)).toEqual(['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'])
    expect(td.domain.chainId).toBe(PAYER_NETWORKS['eip155:8453'].chainId)
    expect(td.domain.verifyingContract).toBe(accept.asset)
    expect(td.domain.name).toBe('USD Coin')
    // Amounts are bigints (uint256), not strings.
    expect(typeof td.message.value).toBe('bigint')
    expect(td.message.value).toBe(BigInt(accept.maxAmountRequired))
  })

  it('honors a challenge-supplied extra.name over the fallback', () => {
    const c = parseChallenge(challengeBody())!
    const accept = { ...c.accepts[0], extra: { name: 'Bridged USDC', version: '2' } }
    const auth = buildAuthorization({ from: '0xAbC', to: accept.payTo, valueMicro: accept.maxAmountRequired, nonce: '0x' + '00'.repeat(32), nowSec: 1000, validForSec: 120 })
    expect(buildTypedData(accept, auth).domain.name).toBe('Bridged USDC')
  })

  // A non-compliant service can OMIT extra.name. The fallback must then match
  // the chain's REAL USDC EIP-712 domain name, not a single hardcoded value:
  // Base mainnet USDC's domain is "USD Coin", Base Sepolia's is "USDC" (the same
  // per-network split the receiver's NETWORKS table emits). Signing the wrong
  // domain name yields a DOMAIN_SEPARATOR the facilitator rejects — a silent
  // payment failure the payer↔receiver drift would otherwise cause on testnet.
  it('falls back to the network-correct USDC domain name when extra is absent', () => {
    // Base Sepolia, no extra → "USDC" (NOT the mainnet "USD Coin").
    const accept: any = { scheme: 'exact', network: 'eip155:84532', maxAmountRequired: '1000', payTo: '0xabc', asset: USDC_SEPOLIA }
    const auth = buildAuthorization({ from: '0xAbC', to: accept.payTo, valueMicro: accept.maxAmountRequired, nonce: '0x' + '00'.repeat(32), nowSec: 1000, validForSec: 120 })
    expect(buildTypedData(accept, auth).domain.name).toBe('USDC')

    // Base mainnet, no extra → "USD Coin".
    const mainAccept: any = { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1000', payTo: '0xabc', asset: USDC_BASE }
    const mainAuth = buildAuthorization({ from: '0xAbC', to: mainAccept.payTo, valueMicro: mainAccept.maxAmountRequired, nonce: '0x' + '00'.repeat(32), nowSec: 1000, validForSec: 120 })
    expect(buildTypedData(mainAccept, mainAuth).domain.name).toBe('USD Coin')
  })
})

describe('buildSpendRef — a repeat payment must NOT collide (platform double-front guard)', () => {
  // The reservation ref keys /pay/spend idempotency. If two DISTINCT legitimate
  // payments share a ref, the 2nd hits already_spent → no ledger debit → but a
  // fresh nonce is signed and the facilitator settles USDC AGAIN → platform loss.
  it('two calls with the same params but no idempotency_key get DIFFERENT refs', async () => {
    const { buildSpendRef } = await import('../app/api/x402/pay/route')
    let n = 0
    const args = { sub: 'u1', network: 'eip155:8453', payTo: '0xPay', amountMicro: '10000', randomToken: () => `tok${++n}` }
    const a = buildSpendRef(args)
    const b = buildSpendRef(args)
    expect(a).not.toBe(b) // distinct payments → distinct reservations
  })

  it('an explicit idempotency_key makes the ref STABLE (opt-in retry-safety)', async () => {
    const { buildSpendRef } = await import('../app/api/x402/pay/route')
    const args = { sub: 'u1', network: 'eip155:8453', payTo: '0xPay', amountMicro: '10000', idempotencyKey: 'order-42', randomToken: () => 'never-used' }
    expect(buildSpendRef(args)).toBe(buildSpendRef(args))
    expect(buildSpendRef(args)).toContain('order-42')
  })

  it('quote jti as the key: replaying ONE quote → same ref (settles once); two quotes → distinct refs', async () => {
    const { buildSpendRef } = await import('../app/api/x402/pay/route')
    const base = { sub: 'u1', network: 'eip155:8453', payTo: '0xPay', amountMicro: '10000', randomToken: () => 'unused' }
    // Same quote replayed (same jti) → identical ref → worker dedups → one on-chain settlement.
    const replay1 = buildSpendRef({ ...base, idempotencyKey: 'jti-A' })
    const replay2 = buildSpendRef({ ...base, idempotencyKey: 'jti-A' })
    expect(replay1).toBe(replay2)
    // Two DISTINCT quotes for identical payee/price (different jti) → two refs → two payments (correct).
    const quoteB = buildSpendRef({ ...base, idempotencyKey: 'jti-B' })
    expect(quoteB).not.toBe(replay1)
  })

  it('sanitizes and bounds the idempotency_key (no ref injection / unbounded key)', async () => {
    const { buildSpendRef } = await import('../app/api/x402/pay/route')
    const ref = buildSpendRef({ sub: 'u1', network: 'eip155:8453', payTo: '0xPay', amountMicro: '10000', idempotencyKey: 'a:b/c ' + 'x'.repeat(200), randomToken: () => 'r' })
    const token = ref.split(':').pop()!
    expect(token).not.toMatch(/[^a-zA-Z0-9_-]/) // colon/slash/space stripped
    expect(token.length).toBeLessThanOrEqual(64)
  })
})

describe('isPayableUrl — SSRF guard: only pay vetted https hosts', () => {
  // The payer signs an EIP-3009 authorization and POSTs it (with the X-PAYMENT
  // header) to this URL. A hostile/hallucinated tool arg must not reach an
  // arbitrary host. NOTE: this vets the PRE-redirect host only; the route pairs
  // it with redirect:'error' on every fetch so an allowlisted 3xx can't hop off.
  it('allows the first-party x402 hosts', async () => {
    const { isPayableUrl } = await import('../app/api/x402/pay/route')
    expect(isPayableUrl('https://tiny.technology/api/x402/chat/foo')).not.toBeNull()
    expect(isPayableUrl('https://plugin.tiny.technology/pay')).not.toBeNull()
  })

  it('rejects a non-allowlisted host', async () => {
    const { isPayableUrl } = await import('../app/api/x402/pay/route')
    expect(isPayableUrl('https://evil.com/x402')).toBeNull()
  })

  it('rejects non-https (no http, no file/gopher/etc.)', async () => {
    const { isPayableUrl } = await import('../app/api/x402/pay/route')
    expect(isPayableUrl('http://tiny.technology/x402')).toBeNull()
    expect(isPayableUrl('file:///etc/passwd')).toBeNull()
  })

  it('fails closed on a userinfo-smuggled host (tiny.technology@evil.com → evil.com)', async () => {
    const { isPayableUrl } = await import('../app/api/x402/pay/route')
    // WHATWG URL parses the hostname as evil.com — the allowlist must see that.
    expect(isPayableUrl('https://tiny.technology@evil.com/x402')).toBeNull()
  })

  it('rejects a malformed URL rather than throwing', async () => {
    const { isPayableUrl } = await import('../app/api/x402/pay/route')
    expect(isPayableUrl('not a url')).toBeNull()
    expect(isPayableUrl('')).toBeNull()
  })
})

describe('encodePaymentHeader', () => {
  it('base64-encodes a payload carrying the CAIP-2 network + signature', () => {
    const c = parseChallenge(challengeBody())!
    const accept = c.accepts[0]
    const auth = buildAuthorization({ from: '0xF', to: accept.payTo, valueMicro: '10000', nonce: '0x1', nowSec: 1, validForSec: 60 })
    const header = encodePaymentHeader(accept, auth, '0xSIG', 1, (s) => Buffer.from(s, 'utf8').toString('base64'))
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded.x402Version).toBe(1)
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe('eip155:8453') // CAIP-2, matches receiver
    expect(decoded.payload.signature).toBe('0xSIG')
    expect(decoded.payload.authorization.value).toBe('10000')
  })
})

describe('quote token — confirm-every-payment: the agent quotes, only the user executes', () => {
  // Test harness mirrors the route's real HMAC (node crypto), so these lock the
  // exact tamper-resistance the server relies on.
  const SECRET = 'test-secret-key'
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')
  const hmac = (p: string) => createHmac('sha256', SECRET).update(p).digest('hex')
  // constant-time-ish string compare (the route uses crypto.timingSafeEqual)
  const timingEq = (a: string, b: string) => {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
  }
  const verify = (p: string, sig: string) => timingEq(hmac(p), sig)

  const fields = (over: Partial<QuoteFields> = {}): QuoteFields => ({
    jti: 'quote-nonce-abc', sub: 'user-1', url: 'https://tiny.technology/api/x402/chat/acme',
    payTo: '0x1111111111111111111111111111111111111111', network: 'eip155:8453',
    amountMicro: '10000', msgHash: 'abc123', maxSpendMicro: 25_000_000, exp: 1_000_000, ...over,
  })

  it('round-trips a valid quote back to its exact bound fields', () => {
    const token = encodeQuote(fields(), b64, hmac)
    const got = decodeQuote(token, unb64, verify)
    expect(got).toEqual(fields())
  })

  it('REJECTS a tampered amount (the core attack — agent bumps the price)', () => {
    const token = encodeQuote(fields({ amountMicro: '10000' }), b64, hmac)
    // Attacker rewrites the payload to $25 but keeps the old signature.
    const [, sig] = token.split('.')
    const forgedPayload = b64(JSON.stringify(fields({ amountMicro: '25000000' })))
    const forged = `${forgedPayload}.${sig}`
    expect(decodeQuote(forged, unb64, verify)).toBeNull()
  })

  it('REJECTS a tampered payee (fund-redirect attempt)', () => {
    const token = encodeQuote(fields(), b64, hmac)
    const [, sig] = token.split('.')
    const forged = `${b64(JSON.stringify(fields({ payTo: '0xAttacker' })))}.${sig}`
    expect(decodeQuote(forged, unb64, verify)).toBeNull()
  })

  it('REJECTS a quote signed with the wrong secret (forged wholesale)', () => {
    const wrongHmac = (p: string) => createHmac('sha256', 'attacker-secret').update(p).digest('hex')
    const token = encodeQuote(fields(), b64, wrongHmac)
    expect(decodeQuote(token, unb64, verify)).toBeNull()
  })

  it('REJECTS malformed tokens (no dot, empty half, garbage)', () => {
    for (const t of ['', 'nodot', '.onlysig', 'onlypayload.', 'a.b.c']) {
      expect(decodeQuote(t, unb64, verify)).toBeNull()
    }
  })

  it('REJECTS a structurally-valid HMAC over a payload missing bound fields', () => {
    // Correctly signed, but the payload isn't a full QuoteFields → shape guard
    // must still reject (defense in depth against a partial-object quote).
    const payloadB64 = b64(JSON.stringify({ sub: 'u', amountMicro: '10000' }))
    const token = `${payloadB64}.${hmac(payloadB64)}`
    expect(decodeQuote(token, unb64, verify)).toBeNull()
  })

  it('REJECTS a bad amountMicro shape and an unsupported network in the payload', () => {
    const bad1 = b64(JSON.stringify(fields({ amountMicro: '1e6' as any })))
    expect(decodeQuote(`${bad1}.${hmac(bad1)}`, unb64, verify)).toBeNull()
    const bad2 = b64(JSON.stringify(fields({ network: 'eip155:1' as any })))
    expect(decodeQuote(`${bad2}.${hmac(bad2)}`, unb64, verify)).toBeNull()
  })

  it('REJECTS a quote with a missing/empty jti (single-use anchor must be present)', () => {
    // Without jti the execute path would fall back to a random ref per PUT and
    // a replayed quote would double-settle — the shape guard must refuse it.
    const noJti = b64(JSON.stringify(fields({ jti: '' })))
    expect(decodeQuote(`${noJti}.${hmac(noJti)}`, unb64, verify)).toBeNull()
    const { jti, ...without } = fields()
    const missing = b64(JSON.stringify(without))
    expect(decodeQuote(`${missing}.${hmac(missing)}`, unb64, verify)).toBeNull()
  })

  it('round-trips the jti so execute can use it as the idempotency ref', () => {
    const token = encodeQuote(fields({ jti: 'unique-xyz' }), b64, hmac)
    expect(decodeQuote(token, unb64, verify)?.jti).toBe('unique-xyz')
  })

  // ── kind:'transfer' — the P2P send quote class (make_payment) ──────────────
  it("round-trips a transfer quote (kind:'transfer', payTo = login, no url)", () => {
    const t = fields({ kind: 'transfer', url: '', payTo: 'alice' })
    const token = encodeQuote(t, b64, hmac)
    expect(decodeQuote(token, unb64, verify)).toEqual(t)
  })

  it('REJECTS an unknown kind (a tampered quote class must not decode as spendable)', () => {
    const bad = b64(JSON.stringify(fields({ kind: 'withdraw' as any })))
    expect(decodeQuote(`${bad}.${hmac(bad)}`, unb64, verify)).toBeNull()
  })

  it('REJECTS a kind-stripped transfer quote (empty url makes it fail the x402 shape)', () => {
    // The core cross-class attack: strip kind so a transfer quote (url:'')
    // routes into the x402 execute path. The HMAC already blocks tampering;
    // this locks the SHAPE guard as defense in depth — an x402-class quote
    // with no url must never decode.
    const stripped = fields({ url: '', payTo: 'alice' })
    delete (stripped as any).kind
    const payload = b64(JSON.stringify(stripped))
    expect(decodeQuote(`${payload}.${hmac(payload)}`, unb64, verify)).toBeNull()
  })

  it('REJECTS a transfer quote with an empty payee login', () => {
    const noPayee = b64(JSON.stringify(fields({ kind: 'transfer', url: '', payTo: '' })))
    expect(decodeQuote(`${noPayee}.${hmac(noPayee)}`, unb64, verify)).toBeNull()
  })
})

/**
 * 🧢 effectiveSpendCap — the agent's original spend cap must survive a re-quote.
 * The tightest of {platform ceiling, per-request cap, prior-quote cap} wins, and
 * every input is only ever a FLOOR (Math.min), so no path can widen spending.
 */
describe('effectiveSpendCap — carry the cap through a re-quote, never widen it', () => {
  const PLATFORM = 25_000_000 // $25

  it('defaults to the platform ceiling when nothing tighter is supplied', () => {
    expect(effectiveSpendCap(PLATFORM)).toBe(PLATFORM)
    expect(effectiveSpendCap(PLATFORM, undefined, undefined)).toBe(PLATFORM)
  })

  it('honors a per-request cap that is below the ceiling', () => {
    expect(effectiveSpendCap(PLATFORM, 2_000_000)).toBe(2_000_000)
  })

  it('carries the PRIOR-quote cap when no per-request cap is given (the re-quote case)', () => {
    // The client re-POSTs with only url+message+prior_quote; the model isn't in
    // the loop to re-supply max_spend_micro, so the prior quote's cap must hold.
    expect(effectiveSpendCap(PLATFORM, undefined, 2_000_000)).toBe(2_000_000)
  })

  it('takes the TIGHTER of the per-request and prior caps — never the looser', () => {
    expect(effectiveSpendCap(PLATFORM, 5_000_000, 2_000_000)).toBe(2_000_000)
    expect(effectiveSpendCap(PLATFORM, 2_000_000, 5_000_000)).toBe(2_000_000)
  })

  it('a prior cap can only LOWER, never RAISE, spending (a replayed/forged token cannot widen it)', () => {
    // Even a prior cap ABOVE the platform ceiling is clamped by it — the min
    // guarantees the ceiling is the hard maximum regardless of the token.
    expect(effectiveSpendCap(PLATFORM, undefined, 100_000_000)).toBe(PLATFORM)
    // And a prior cap can't undo a tighter per-request cap.
    expect(effectiveSpendCap(PLATFORM, 1_000_000, 100_000_000)).toBe(1_000_000)
  })

  it('ignores non-positive / non-finite caps (leaves that floor at the ceiling)', () => {
    expect(effectiveSpendCap(PLATFORM, 0, 0)).toBe(PLATFORM)
    expect(effectiveSpendCap(PLATFORM, -5, NaN)).toBe(PLATFORM)
    expect(effectiveSpendCap(PLATFORM, Infinity)).toBe(PLATFORM)
  })

  it('floors a fractional cap to an integer micro amount', () => {
    expect(effectiveSpendCap(PLATFORM, 1_500_000.9)).toBe(1_500_000)
  })
})

/**
 * 🔗 Settlement receipt — the on-chain proof surfaced on the "Payment sent"
 * card. The tx hash rides back in the X-PAYMENT-RESPONSE header; the explorer
 * host must follow the network WE signed for, never a service-supplied claim.
 */
describe('parseSettlementTx — decode the X-PAYMENT-RESPONSE settlement header', () => {
  const TX = '0x' + 'a'.repeat(64)
  const b64json = (o: any) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

  it('extracts the tx hash from a well-formed x402 SettleResponse', () => {
    expect(parseSettlementTx(b64json({ success: true, transaction: TX, network: 'base' }))).toBe(TX)
  })

  it('accepts the txHash alias too', () => {
    expect(parseSettlementTx(b64json({ txHash: TX }))).toBe(TX)
  })

  it('returns "" for a null/absent header (service omitted it) — no link, no throw', () => {
    expect(parseSettlementTx(null)).toBe('')
    expect(parseSettlementTx(undefined)).toBe('')
    expect(parseSettlementTx('')).toBe('')
  })

  it('returns "" for a malformed header (not base64 / not JSON) rather than throwing', () => {
    expect(parseSettlementTx('!!!not base64!!!')).toBe('')
    expect(parseSettlementTx(Buffer.from('not json', 'utf8').toString('base64'))).toBe('')
  })

  it('returns "" for a settle response whose transaction is not a 0x…64 hash', () => {
    expect(parseSettlementTx(b64json({ transaction: 'nope' }))).toBe('')
    expect(parseSettlementTx(b64json({ transaction: '0x123' }))).toBe('') // too short
    expect(parseSettlementTx(b64json({ transaction: 12345 }))).toBe('')   // non-string
    expect(parseSettlementTx(b64json({ success: true }))).toBe('')        // no tx field
  })
})

describe('settlementTxFromBody — first-party body fallback when the header is absent', () => {
  // Tiny's own receiver returns the settlement hash as `tx_hash` in the JSON
  // body (not the X-PAYMENT-RESPONSE header). This closes the "no BaseScan link
  // on same-platform payments" gap — with the SAME 0x…64 validation as the
  // header path so a bogus body value never produces a link.
  const TX = '0x' + 'c'.repeat(64)

  it('extracts a well-formed tx_hash from tiny\'s receiver body', () => {
    expect(settlementTxFromBody({ tiny: 'acme', paid_micro: 10000, tx_hash: TX })).toBe(TX)
  })

  it('returns "" for a body with no tx_hash (free tiny / hashless settle)', () => {
    expect(settlementTxFromBody({ tiny: 'acme', paid_micro: 10000 })).toBe('')
  })

  it('returns "" for a malformed tx_hash rather than emitting a bad link', () => {
    expect(settlementTxFromBody({ tx_hash: 'nope' })).toBe('')
    expect(settlementTxFromBody({ tx_hash: '0x123' })).toBe('')     // too short
    expect(settlementTxFromBody({ tx_hash: 12345 })).toBe('')       // non-string
  })

  it('returns "" for a non-object body (a service that answered plain text)', () => {
    expect(settlementTxFromBody(null)).toBe('')
    expect(settlementTxFromBody(undefined)).toBe('')
    expect(settlementTxFromBody('0x' + 'c'.repeat(64))).toBe('') // a raw string is not a body
    expect(settlementTxFromBody(42)).toBe('')
  })
})

describe('explorerTxUrl — network-correct BaseScan link, host chosen by the network WE signed for', () => {
  const TX = '0x' + 'b'.repeat(64)

  it('mainnet (eip155:8453) → basescan.org', () => {
    expect(explorerTxUrl('eip155:8453', TX)).toBe(`https://basescan.org/tx/${TX}`)
  })

  it('testnet (eip155:84532) → sepolia.basescan.org — never the mainnet host', () => {
    expect(explorerTxUrl('eip155:84532', TX)).toBe(`https://sepolia.basescan.org/tx/${TX}`)
  })

  it('returns "" for an unknown network so a wrong-chain link is never produced', () => {
    expect(explorerTxUrl('eip155:1', TX)).toBe('')
    expect(explorerTxUrl('', TX)).toBe('')
  })

  it('returns "" when there is no tx hash', () => {
    expect(explorerTxUrl('eip155:8453', '')).toBe('')
  })
})

/**
 * 🔒 advertisablePriceMicro — the discovery-surface price gate. A PRIVATE tiny
 * must advertise NO price on any crawlable surface (JSON-LD offers, OG card),
 * because every x402 door 403s it — advertising a payable price lures a paying
 * agent into a guaranteed 403 (advertise-vs-charge mismatch). Public tinys
 * advertise their real, floored, non-negative price.
 */
describe('advertisablePriceMicro — private tiny advertises no price', () => {
  it('a PRIVATE priced tiny advertises 0 (never its real price)', () => {
    expect(advertisablePriceMicro(50000, true)).toBe(0)
    expect(advertisablePriceMicro(1, true)).toBe(0)
  })

  it('a PUBLIC priced tiny advertises its real micro price', () => {
    expect(advertisablePriceMicro(50000, false)).toBe(50000)
    expect(advertisablePriceMicro('50000', false)).toBe(50000) // worker may send a string
  })

  it('a PUBLIC free tiny advertises 0', () => {
    expect(advertisablePriceMicro(0, false)).toBe(0)
  })

  it('a NaN / absent / blip price read floors to 0 (free), never negative or NaN', () => {
    expect(advertisablePriceMicro(undefined, false)).toBe(0)
    expect(advertisablePriceMicro(null, false)).toBe(0)
    expect(advertisablePriceMicro('not-a-number', false)).toBe(0)
    expect(advertisablePriceMicro(-5, false)).toBe(0) // never advertise a negative price
  })

  it('privacy wins even over a valid positive price (the whole point of the gate)', () => {
    // The failure this guards: /pay/pricing (public, unauthenticated) returns
    // 50000 for a private tiny; without the gate the discovery doc would carry it.
    expect(advertisablePriceMicro(50000, true)).toBe(0)
    // And the "payable via x402" copy keys off `> 0`, so it's suppressed too.
    expect(advertisablePriceMicro(50000, true) > 0).toBe(false)
  })
})
