// @vitest-environment node
import { describe, it, expect } from 'vitest'

/**
 * 🌐 x402 NETWORK-TABLE PARITY — the single guard against a drift that money
 * and permanence make expensive.
 *
 * The same (CAIP-2 network → USDC contract) facts are hand-maintained in THREE
 * places, each shaped for its own use:
 *   - NETWORKS         (app/api/x402/chat/[slug]) — the RECEIVER: the addresses
 *                       we verify + settle inbound payments against.
 *   - PAYER_NETWORKS   (lib/x402/payer.ts)        — the SIGNER: the token the
 *                       platform hot wallet authorizes moving (EIP-3009
 *                       verifyingContract = this asset). A wrong address here
 *                       signs a transfer of the wrong token.
 *   - X402_NETWORKS    (app/api/erc8004/registration/[slug]) — DISCOVERY, baked
 *                       PERMANENTLY on-chain when an agent mints its ERC-8004
 *                       identity. Wrong terms here can't be un-baked.
 *
 * All three carried a "MUST match the others" comment but nothing enforced it —
 * a USDC contract migration, or adding a network, that touched one map and
 * missed another would silently: (a) make the signer authorize a bad token,
 * (b) bake wrong payment terms into an immutable on-chain record, or (c) make
 * the receiver settle against a different asset than it advertised. This test
 * fails the moment any of the three diverges. Pure imports — no network, no
 * mocks, edge-safe.
 */
import { NETWORKS } from '../app/api/x402/chat/[slug]/route'
import { X402_NETWORKS } from '../app/api/erc8004/registration/[slug]/route'
import { PAYER_NETWORKS, canonicalNetwork } from '../lib/x402/payer'
import { canonicalNetwork as receiverCanonicalNetwork } from '../app/api/x402/chat/[slug]/route'

/** Project each table down to the canonical (caip2 → lowercased USDC) it asserts. */
const fromNetworks = () =>
  Object.fromEntries(Object.values(NETWORKS).map((n) => [n.caip2, n.usdc.toLowerCase()]))
const fromPayer = () =>
  Object.fromEntries(Object.entries(PAYER_NETWORKS).map(([caip2, n]) => [caip2, n.usdc.toLowerCase()]))
const fromRegistration = () =>
  Object.fromEntries(X402_NETWORKS.map((n) => [n.network, n.asset.toLowerCase()]))

describe('x402 network-table parity — three hand-synced maps must agree', () => {
  it('receiver NETWORKS and signer PAYER_NETWORKS map the same CAIP-2 → USDC', () => {
    expect(fromNetworks()).toEqual(fromPayer())
  })

  it('on-chain X402_NETWORKS matches the receiver — wrong terms here bake permanently', () => {
    expect(fromRegistration()).toEqual(fromNetworks())
  })

  it('all three cover exactly the same set of networks (no map adds/drops one)', () => {
    // The two Base chains are unconditional; the self-hosted tiny-chain entry
    // joins all three tables together when (and only when) the env configures
    // it (lib/x402/tiny-chain.ts) — tests/x402-tiny-network.test.ts covers the
    // configured case with stubbed env; here we assert against the live env so
    // the suite passes identically with or without a local tiny-chain.
    const tinyId = Number(process.env.TINY_CHAIN_ID || 0)
    const tinyConfigured = Number.isInteger(tinyId) && tinyId > 0
      && /^0x[0-9a-fA-F]{40}$/.test(String(process.env.TINY_CHAIN_USDC_ADDRESS || ''))
    const expected = ['eip155:8453', 'eip155:84532', ...(tinyConfigured ? [`eip155:${tinyId}`] : [])].sort()
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort()
    expect(keys(fromNetworks())).toEqual(expected)
    expect(keys(fromPayer())).toEqual(expected)
    expect(keys(fromRegistration())).toEqual(expected)
  })

  it("the payer's short name for each CAIP-2 is a key the receiver NETWORKS knows", () => {
    // The receiver keys by short name ('base'/'base-sepolia'); the payer records
    // that short name per CAIP-2. They must agree so canonicalNetwork folding
    // (short ⇄ CAIP-2) round-trips across the two halves of the flow.
    for (const [caip2, n] of Object.entries(PAYER_NETWORKS)) {
      expect(NETWORKS[n.short as keyof typeof NETWORKS]?.caip2).toBe(caip2)
    }
  })

  it('canonicalNetwork folds identically in the receiver and the payer copy', () => {
    // The fn is duplicated verbatim in both files (edge route can\'t import the
    // Node lib freely); this locks the two copies to the same folding rules.
    for (const s of ['base', 'BASE', 'eip155:8453', '8453', 'base-sepolia', 'base_sepolia', 'sepolia', 'eip155:84532', '84532', 'eip155:1', '', 'tiny', '31337', 'eip155:31337']) {
      expect(receiverCanonicalNetwork(s)).toBe(canonicalNetwork(s))
    }
  })
})
