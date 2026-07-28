// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ⚠️ THE MISLABELLED-CHAIN TRAP.
 *
 * `TINY_CHAIN_RPC_URL` defaults to `http://127.0.0.1:8545`, and on the machine
 * hosting these chains that port is the LIVE chain (8469). A deployment that
 * sets `TINY_CHAIN_ID=8470` and forgets the RPC therefore renders 8469's blocks,
 * balances and transfers beneath an "eip155:8470" heading: every number real,
 * every label wrong, and nothing broken enough to notice. In the other direction
 * it misattributes production money to a devnet.
 *
 * `chainIdentity()` exists so the explorer can only claim a chain the node
 * confirms. These tests pin the three-state contract, and especially that
 * "couldn't ask" is NOT reported as "mismatch" — a down node is already reported
 * as down, and a warning that fires whenever the chain is offline gets ignored
 * exactly when it means something.
 */

const ENV_KEYS = ['TINY_CHAIN_ID', 'TINY_CHAIN_USDC_ADDRESS', 'TINY_CHAIN_RPC_URL'] as const
const saved: Record<string, string | undefined> = {}

const USDC = '0x5fbdb2315678afecb367f032d93f642f64180aa3'

/** Fake JSON-RPC: `chainIdHex` null ⇒ the call fails (node down / not allowed). */
function mockRpc(chainIdHex: string | null) {
  return vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body.method === 'eth_chainId') {
      if (chainIdHex === null) throw new Error('ECONNREFUSED')
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: chainIdHex }) } as any
    }
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) } as any
  })
}

async function identityWith(chainId: string, chainIdHex: string | null) {
  process.env.TINY_CHAIN_ID = chainId
  process.env.TINY_CHAIN_USDC_ADDRESS = USDC
  process.env.TINY_CHAIN_RPC_URL = 'http://127.0.0.1:8601'
  vi.stubGlobal('fetch', mockRpc(chainIdHex))
  vi.resetModules()
  const { chainIdentity } = await import('@/lib/chain/rpc')
  return chainIdentity()
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('chainIdentity — the explorer may only claim a chain the node confirms', () => {
  it('confirms a match', async () => {
    expect(await identityWith('8470', '0x2116')).toEqual({ state: 'match', chainId: 8470 })
  })

  it('reports BOTH ids on a mismatch — the exact 8470-label/8469-data trap', async () => {
    // 0x2115 = 8469, the live chain that answers on the DEFAULT rpc port.
    expect(await identityWith('8470', '0x2115')).toEqual({ state: 'mismatch', chainId: 8470, reported: 8469 })
  })

  it('catches the reverse too: claiming the live chain while reading the devnet', async () => {
    expect(await identityWith('8469', '0x2116')).toEqual({ state: 'mismatch', chainId: 8469, reported: 8470 })
  })

  it('does NOT call an unreachable node a mismatch', async () => {
    // The block row already says "node unreachable". A mismatch warning here
    // would fire on every outage and be tuned out when it finally means
    // something. `unknown` keeps the configured id and adds no claim.
    expect(await identityWith('8470', null)).toEqual({ state: 'unknown', chainId: 8470 })
  })

  it('returns null when no chain is configured at all', async () => {
    delete process.env.TINY_CHAIN_ID
    delete process.env.TINY_CHAIN_USDC_ADDRESS
    vi.stubGlobal('fetch', mockRpc('0x2116'))
    vi.resetModules()
    const { chainIdentity } = await import('@/lib/chain/rpc')
    // Not "mismatch": nothing was claimed, so nothing can disagree. The pages
    // render NotConfigured on this path.
    expect(await chainIdentity()).toBeNull()
  })

  it('never asks the node when unconfigured — no fetch at all', async () => {
    delete process.env.TINY_CHAIN_ID
    const spy = mockRpc('0x2116')
    vi.stubGlobal('fetch', spy)
    vi.resetModules()
    const { chainIdentity } = await import('@/lib/chain/rpc')
    await chainIdentity()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the guard is actually consulted, and is answerable', () => {
  const root = process.cwd()

  it('/chain renders the node-confirmed id, not the configured one', () => {
    // Anchored to the call site: a file-wide toContain('chainIdentity') passes
    // on the import line alone, and this repo has hit that trap repeatedly.
    const page = readFileSync(join(root, 'app/chain/page.tsx'), 'utf8')
    expect(page).toMatch(/chainIdentity\(\),/)
    expect(page).toMatch(/<ChainIdRow identity=\{identity\} \/>/)
    // And the raw configured id is no longer printed as the Chain row.
    expect(page).not.toMatch(/<Row k="Chain">eip155:\{info\.chainId\}/)
  })

  it('eth_chainId is in the public proxy allowlist — a guard that cannot ask is theatre', () => {
    // The explorer reads through chain/rpc-proxy.mjs in production. If
    // eth_chainId were off the allowlist, chainIdentity() would return
    // 'unknown' on every request and the mismatch could never be detected.
    const proxy = readFileSync(join(root, 'chain/rpc-proxy.mjs'), 'utf8')
    const allowBlock = proxy.slice(proxy.indexOf('export const ALLOWED'), proxy.indexOf('])', proxy.indexOf('export const ALLOWED')))
    expect(allowBlock).toContain("'eth_chainId'")
  })

  it('the mismatch UI names both ids and the env vars that fix it', () => {
    const ui = readFileSync(join(root, 'app/chain/ui.tsx'), 'utf8')
    const fn = ui.slice(ui.indexOf('export function ChainIdRow'), ui.indexOf('One decoded argument'))
    expect(fn).toMatch(/identity\.state === 'mismatch'/)
    expect(fn).toMatch(/\{identity\.chainId\}/)
    expect(fn).toMatch(/\{identity\.reported\}/)
    expect(fn).toContain('TINY_CHAIN_RPC_URL')
    expect(fn).toContain('TINY_CHAIN_ID')
  })

  it('a contract DEPLOYMENT is labelled as one, not as undecodable calldata', () => {
    // Every contract on 8470 was deployed by such a transaction, so these are
    // the first rows anyone auditing the chain's origin reads. Creation
    // bytecode has no selector; "not decoded" would claim a failed reading
    // where there was nothing to read.
    const page = readFileSync(join(root, 'app/chain/tx/[hash]/page.tsx'), 'utf8')
    expect(page).toMatch(/isCreation=\{isCreation\}/)
    // Derived from BOTH signals — a pending tx has no receipt to name a target.
    const derive = page.slice(page.indexOf('const created ='), page.lastIndexOf('return ('))
    expect(derive).toContain('receipt?.contractAddress')
    expect(derive).toContain('!tx.to')

    const ui = readFileSync(join(root, 'app/chain/ui.tsx'), 'utf8')
    // Slice from the JSX, not the whole function: the docblock above it also
    // says "not decoded", and an offset comparison that includes prose proves
    // nothing about which branch the renderer reaches first.
    const card = ui.slice(ui.indexOf('<Card title="Input'), ui.indexOf('The OUTPUT half'))
    // Creation is checked BEFORE the not-decoded branch, or it never shows.
    expect(card.indexOf('isCreation ?')).toBeGreaterThan(-1)
    expect(card.indexOf('isCreation ?')).toBeLessThan(card.indexOf('not decoded'))
    expect(card).toContain('deployed a contract')
    expect(card).toMatch(/creation bytecode/)
  })
})
