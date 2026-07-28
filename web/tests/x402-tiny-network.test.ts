// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 🔗 Self-hosted tiny-chain as a payments network (lib/x402/tiny-chain.ts).
 *
 * The three x402 network tables are frozen at module load from env, so every
 * test here stubs env FIRST, resets the module registry, and dynamically
 * imports fresh copies. The unstubbed default case (tables = exactly the two
 * Base chains) is locked by tests/x402-network-parity.test.ts — this file
 * covers the CONFIGURED deployment and the fail-closed misconfigurations.
 */

const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3' // deterministic anvil deploy addr

const freshImports = async () => {
  vi.resetModules()
  const tiny = await import('../lib/x402/tiny-chain')
  const payer = await import('../lib/x402/payer')
  const receiver = await import('../app/api/x402/chat/[slug]/route')
  const registration = await import('../app/api/erc8004/registration/[slug]/route')
  return { tiny, payer, receiver, registration }
}

beforeEach(() => {
  vi.stubEnv('TINY_CHAIN_ID', '31337')
  vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', USDC)
  vi.stubEnv('PAYMENTS_NETWORK', 'tiny')
  // Pin the LEGACY selector too: the fail-closed tests assert the broken-config
  // fallback is 'base', but that fallback reads PAYMENTS_TESTNET — inherited
  // from the shell, a stray '1' makes it 'base-sepolia' and five guards go red
  // for env, not code (same trap tests/_deployment.ts documents).
  vi.stubEnv('PAYMENTS_TESTNET', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('tiny-chain config (fail-closed)', () => {
  it('parses a valid config into CAIP-2 + defaults', async () => {
    const { tiny } = await freshImports()
    expect(tiny.tinyChainConfig()).toEqual({
      caip2: 'eip155:31337', chainId: 31337, usdc: USDC,
      rpc: 'http://127.0.0.1:8545', short: 'tiny', domainName: 'USDC',
    })
  })

  it.each([
    ['missing id', () => vi.stubEnv('TINY_CHAIN_ID', '')],
    ['non-integer id', () => vi.stubEnv('TINY_CHAIN_ID', '31337.5')],
    ['negative id', () => vi.stubEnv('TINY_CHAIN_ID', '-1')],
    ['junk usdc', () => vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', 'not-an-address')],
    ['short usdc', () => vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', '0x1234')],
  ])('%s → null config AND paymentsNetwork refuses tiny', async (_label, breakEnv) => {
    breakEnv()
    const { tiny } = await freshImports()
    expect(tiny.tinyChainConfig()).toBeNull()
    // PAYMENTS_NETWORK=tiny with a broken config must not advertise a chain
    // nothing can settle on — falls back to the legacy selector (base).
    expect(tiny.paymentsNetwork()).toBe('base')
  })

  it('paymentsNetwork: PAYMENTS_NETWORK wins; legacy PAYMENTS_TESTNET honored when unset', async () => {
    const { tiny } = await freshImports()
    expect(tiny.paymentsNetwork()).toBe('tiny')

    vi.stubEnv('PAYMENTS_NETWORK', 'base-sepolia')
    expect(tiny.paymentsNetwork()).toBe('base-sepolia')

    vi.stubEnv('PAYMENTS_NETWORK', '')
    vi.stubEnv('PAYMENTS_TESTNET', '1')
    expect(tiny.paymentsNetwork()).toBe('base-sepolia')
    vi.stubEnv('PAYMENTS_TESTNET', '')
    expect(tiny.paymentsNetwork()).toBe('base')
  })
})

describe('tiny-chain joins all three parity tables together', () => {
  it('receiver + payer + registration all gain the same eip155:31337 → USDC row', async () => {
    const { payer, receiver, registration } = await freshImports()
    expect(receiver.NETWORKS.tiny).toEqual({ caip2: 'eip155:31337', usdc: USDC, label: 'USDC' })
    expect(payer.PAYER_NETWORKS['eip155:31337']).toEqual({ short: 'tiny', chainId: 31337, usdc: USDC, domainName: 'USDC' })
    expect(registration.X402_NETWORKS.find((n) => n.network === 'eip155:31337')?.asset).toBe(USDC)
    // Same parity projection the parity test uses — with tiny included.
    const fromNetworks = Object.fromEntries(Object.values(receiver.NETWORKS).map((n) => [n.caip2, n.usdc.toLowerCase()]))
    const fromPayer = Object.fromEntries(Object.entries(payer.PAYER_NETWORKS).map(([caip2, n]) => [caip2, n.usdc.toLowerCase()]))
    const fromRegistration = Object.fromEntries(registration.X402_NETWORKS.map((n) => [n.network, n.asset.toLowerCase()]))
    expect(fromNetworks).toEqual(fromPayer)
    expect(fromRegistration).toEqual(fromNetworks)
  })

  it('both canonicalNetwork copies fold tiny/chain-id/caip2 onto eip155:31337 identically', async () => {
    const { payer, receiver } = await freshImports()
    for (const s of ['tiny', 'TINY', '31337', 'eip155:31337']) {
      expect(payer.canonicalNetwork(s)).toBe('eip155:31337')
      expect(receiver.canonicalNetwork(s)).toBe(payer.canonicalNetwork(s))
    }
    // Base folding is untouched by the tiny entry.
    expect(payer.canonicalNetwork('base')).toBe('eip155:8453')
    expect(receiver.canonicalNetwork('sepolia')).toBe('eip155:84532')
  })

  it('the 402 challenge offers EXACTLY the tiny door on a tiny deployment (mint guard)', async () => {
    const { receiver } = await freshImports()
    expect(receiver.offeredNetworks()).toEqual(['tiny'])
    const req = receiver.paymentRequirements('demo', 1500, '0x976EA74026E726554dB657fA54763abd0C3a0aa9')
    expect(req.accepts).toHaveLength(1)
    expect(req.accepts[0]).toMatchObject({
      scheme: 'exact', network: 'eip155:31337', asset: USDC,
      maxAmountRequired: '1500',
      // extra.name/version is the EIP-712 domain the payer signs — must be the
      // USDC/2 TinyUSDC.sol was deployed with, or the facilitator rejects.
      extra: { name: 'USDC', version: '2' },
    })
    // A payment signed for a chain we don't offer must not match (fail closed).
    expect(receiver.matchRequirement({ network: 'eip155:8453' }, req)).toBeNull()
    expect(receiver.matchRequirement({ network: 'tiny' }, req)).toMatchObject({ network: 'eip155:31337' })
  })

  it('explorer links: tiny has none by default, TINY_CHAIN_EXPLORER_URL enables them', async () => {
    const { payer } = await freshImports()
    const tx = '0x' + 'ab'.repeat(32)
    // "by default" has to be WRITTEN, not assumed. Every other var this file
    // depends on is stubbed; this one was read straight from the shell, so a
    // developer running the suite against their own configured devnet (the exact
    // deployment this file is about) saw the first assertion fail and the
    // "unconfigured" case never get tested at all. Same precedence trap as
    // tests/_deployment.ts, one env var further down.
    vi.stubEnv('TINY_CHAIN_EXPLORER_URL', '')
    expect(payer.explorerTxUrl('eip155:31337', tx)).toBe('')
    vi.stubEnv('TINY_CHAIN_EXPLORER_URL', 'http://explorer.tiny.internal/')
    expect(payer.explorerTxUrl('eip155:31337', tx)).toBe(`http://explorer.tiny.internal/tx/${tx}`)
    // Base explorers unaffected.
    expect(payer.explorerTxUrl('eip155:8453', tx)).toBe(`https://basescan.org/tx/${tx}`)
  })

  it('isExpectedUsdc accepts only the configured TinyUSDC on the tiny network', async () => {
    const { payer } = await freshImports()
    expect(payer.isExpectedUsdc('tiny', USDC)).toBe(true)
    expect(payer.isExpectedUsdc('eip155:31337', USDC.toLowerCase())).toBe(true)
    expect(payer.isExpectedUsdc('eip155:31337', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false)
  })
})
