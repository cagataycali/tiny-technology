// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import {
  buildChainStatus,
  clampInt,
  MONEY_NOTE,
  SPAN_MAX,
  LIMIT_MAX,
  LIMIT_DEFAULT,
  SPAN_DEFAULT,
} from '@/lib/chain/status'
import type { TransferLog } from '@/lib/chain/explorer-core'

/**
 * ⛓️ GET /api/chain/status — the chain's live state for clients that can't SSR.
 *
 * The user's gap: "we dont see the chain details in the mobile apps". `/chain` is
 * a server-rendered page; iOS and Android had no equivalent and no JSON to build
 * one from. The failure this endpoint has to avoid is subtler than being wrong —
 * it's being CONFIDENT: rendering the live chain's blocks under the devnet's
 * heading, printing a 78-digit amount as a rounded Double, or showing "no
 * activity" for a node that never answered.
 */

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const ZERO = '0x0000000000000000000000000000000000000000'

const transfer = (over: Partial<TransferLog> = {}): TransferLog => ({
  from: addr(0xa1),
  to: addr(0xb2),
  micro: 1_500_000,
  txHash: tx(1),
  blockNumber: 4242,
  ...over,
})

const base = {
  info: { chainId: 8470, usdc: '0xABCDEF0123456789abcdef0123456789ABCDEF01' },
  identity: { state: 'match' as const, chainId: 8470 },
  latestBlock: 5000,
  transfers: [] as TransferLog[],
  span: 10_000,
}

describe('clampInt — a mobile client is the least trustworthy source of a range', () => {
  it('accepts a sane value', () => {
    expect(clampInt('500', SPAN_DEFAULT, 1, SPAN_MAX)).toBe(500)
    expect(clampInt(500, SPAN_DEFAULT, 1, SPAN_MAX)).toBe(500)
  })

  it('falls back on junk rather than producing NaN', () => {
    // NaN would flow into `latest - span` and then into a hex string of "NaN",
    // which the node rejects — the whole page would go empty for one bad param.
    for (const junk of ['', 'abc', null, undefined, {}, [], '1e999', NaN, Infinity]) {
      expect(clampInt(junk, 77, 1, SPAN_MAX)).toBe(77)
    }
  })

  it('clamps a negative to the floor — a negative span asks for blocks past the head', () => {
    // `lookbackFrom(latest, -5000)` floors at 0 today, but the honest fix is here:
    // a negative range returns nothing and looks EXACTLY like an idle chain.
    expect(clampInt('-5000', SPAN_DEFAULT, 1, SPAN_MAX)).toBe(1)
    expect(clampInt('0', SPAN_DEFAULT, 1, SPAN_MAX)).toBe(1)
  })

  it('caps the ceiling — an unbounded getLogs against a tunneled node is an outage', () => {
    expect(clampInt('99999999', SPAN_DEFAULT, 1, SPAN_MAX)).toBe(SPAN_MAX)
    expect(clampInt('1000', LIMIT_DEFAULT, 1, LIMIT_MAX)).toBe(LIMIT_MAX)
  })

  it('floors fractions instead of passing 1.5 into a hex conversion', () => {
    expect(clampInt('12.9', SPAN_DEFAULT, 1, SPAN_MAX)).toBe(12)
  })
})

describe('identity is three-state and never collapsed', () => {
  it('on match, reports the id once and offers no second number to render', () => {
    const s = buildChainStatus(base)
    expect(s.identity).toBe('match')
    expect(s.chainId).toBe(8470)
    expect(s.caip2).toBe('eip155:8470')
    // A `reportedChainId` on a match invites a client to print it as a separate
    // fact — two identical numbers labelled differently reads as a discrepancy.
    expect(s.reportedChainId).toBeNull()
  })

  it('on mismatch, names BOTH ids so the client can state the disagreement', () => {
    // The trap this exists for: TINY_CHAIN_RPC_URL defaults to 127.0.0.1:8545 =
    // the LIVE chain. Setting TINY_CHAIN_ID=8470 and forgetting the RPC shows
    // 8469's real blocks under an 8470 heading. Neither value is knowably right,
    // so the payload must carry both and assert nothing.
    const s = buildChainStatus({ ...base, identity: { state: 'mismatch', chainId: 8470, reported: 8469 } })
    expect(s.identity).toBe('mismatch')
    expect(s.chainId).toBe(8470)
    expect(s.reportedChainId).toBe(8469)
  })

  it('on unknown, does NOT look like a mismatch', () => {
    // "We couldn't ask" ≠ "they disagree". A node blip that renders as a chain
    // mismatch is a warning users learn to dismiss, and then it means nothing.
    const s = buildChainStatus({ ...base, identity: { state: 'unknown', chainId: 8470 }, latestBlock: null })
    expect(s.identity).toBe('unknown')
    expect(s.reportedChainId).toBeNull()
  })
})

describe('reachability is derived from an answer we actually got', () => {
  it('a null height means unreachable even when identity says match', () => {
    // `chainIdentity` can return 'unknown' while config alone is consistent; the
    // block height is the only field here that required the node to respond.
    const s = buildChainStatus({ ...base, latestBlock: null })
    expect(s.reachable).toBe(false)
    expect(s.latestBlock).toBeNull()
  })

  it('block 0 is reachable — a fresh chain is not a down chain', () => {
    // The `!latestBlock` version of this check calls genesis "unreachable",
    // which is precisely the state a brand-new node is in.
    const s = buildChainStatus({ ...base, latestBlock: 0 })
    expect(s.reachable).toBe(true)
    expect(s.latestBlock).toBe(0)
  })
})

describe('money is pre-formatted, and the clamp is visible', () => {
  it('formats micro-USDC on the server so three clients cannot disagree', () => {
    const s = buildChainStatus({ ...base, transfers: [transfer({ micro: 1_500_000 })] })
    expect(s.transfers[0].amount).toBe('$1.50')
    expect(s.transfers[0].amountMicro).toBe(1_500_000)
    expect(s.transfers[0].clamped).toBe(false)
  })

  it('flags a clamped uint256 instead of quietly printing a rounded Double', () => {
    // hexToNumber clamps at MAX_SAFE_INTEGER, so equality IS the clamp signal.
    // JSON.parse on a phone turns anything past 2^53 into a lossy Double — a
    // client that trusts the number alone prints a wrong amount confidently, on
    // exactly the transfer somebody is auditing.
    const s = buildChainStatus({ ...base, transfers: [transfer({ micro: Number.MAX_SAFE_INTEGER })] })
    expect(s.transfers[0].clamped).toBe(true)
    expect(s.transfers[0].amount).toContain('clamped')
  })

  it('renders a missing amount as "—", not as zero', () => {
    // A malformed log is not a free transfer.
    const s = buildChainStatus({ ...base, transfers: [transfer({ micro: null })] })
    expect(s.transfers[0].amount).toBe('—')
    expect(s.transfers[0].amountMicro).toBeNull()
  })

  it('carries the money note verbatim from the web explorer', () => {
    // This is a promise about money. Three clients phrasing it three ways is how
    // one of them ends up implying withdrawability.
    const page = readFileSync(joinPath(process.cwd(), 'app/chain/page.tsx'), 'utf8')
    expect(page).toContain('Balances here are trial credit')
    expect(MONEY_NOTE).toContain('not withdrawable as real USDC')
    expect(buildChainStatus(base).moneyNote).toBe(MONEY_NOTE)
    // Even unconfigured: the sentence is about what the credit IS, not about
    // whether this deployment has a chain.
    expect(buildChainStatus({ ...base, info: null }).moneyNote).toBe(MONEY_NOTE)
  })
})

describe('transfers arrive ready to render on a 34-column screen', () => {
  it('ships short forms alongside the full hex', () => {
    const s = buildChainStatus({ ...base, transfers: [transfer()] })
    const t = s.transfers[0]
    expect(t.hash).toBe(tx(1))
    expect(t.hashShort).toMatch(/^0x0{6}…0{3}1$/)
    expect(t.fromShort.length).toBeLessThan(t.from.length)
    expect(t.toShort.length).toBeLessThan(t.to.length)
    // The full value must survive: it's what a tap-through to the explorer needs.
    expect(t.from).toBe(addr(0xa1))
  })

  it('names mints and burns instead of making the client decode 0x0000…0000', () => {
    // On a chain whose supply is ours, "where did this money come from" is the
    // question the explorer exists to answer.
    const s = buildChainStatus({
      ...base,
      transfers: [
        transfer({ from: ZERO, txHash: tx(2) }),
        transfer({ to: ZERO, txHash: tx(3) }),
        transfer({ txHash: tx(4) }),
      ],
    })
    expect(s.transfers.map((t) => t.kind)).toEqual(['mint', 'burn', 'transfer'])
  })

  it('reports the span actually scanned, so "recent" has a definition', () => {
    const s = buildChainStatus({ ...base, span: 500 })
    expect(s.span).toBe(500)
  })
})

describe('a deployment with no chain is a state, not an error', () => {
  it('says unconfigured — which is a different sentence from unreachable', () => {
    // Base deployments have no tiny-chain at all. Rendering "cannot reach the
    // node" there sends the operator debugging a node that was never meant to
    // exist.
    const s = buildChainStatus({ ...base, info: null })
    expect(s.configured).toBe(false)
    expect(s.chainId).toBeNull()
    expect(s.caip2).toBeNull()
    expect(s.usdc).toBeNull()
    expect(s.identity).toBeNull()
    expect(s.reachable).toBe(false)
    expect(s.transfers).toEqual([])
  })

  it('never leaks transfers or a height into an unconfigured payload', () => {
    // Belt and braces: if a caller passes stale reads alongside info:null, the
    // payload must not present them as this chain's activity.
    const s = buildChainStatus({ ...base, info: null, latestBlock: 999, transfers: [transfer()] })
    expect(s.latestBlock).toBeNull()
    expect(s.transfers).toEqual([])
  })
})

describe('the USDC address is normalised', () => {
  it('lowercases, because clients compare it against lowercased log topics', () => {
    // Log topics decode lowercase. A mixed-case contract address here makes
    // `t.to === status.usdc` false on every client that tries it.
    const s = buildChainStatus(base)
    expect(s.usdc).toBe(base.info.usdc.toLowerCase())
  })
})

describe('the route wires the pure layer without re-deciding anything', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const load = () => import('@/app/api/chain/status/route')

  it('returns the unconfigured payload with NO network call when no chain is set', async () => {
    vi.stubEnv('TINY_CHAIN_ID', '')
    vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', '')
    vi.stubEnv('TINY_CHAIN_RPC_URL', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { GET } = await load()
    const res = await GET(new Request('https://x.test/api/chain/status'))
    const body = await res.json()
    expect(body.configured).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    // ⚠️ That last assertion passes for TWO reasons — the route's own `!info`
    // short-circuit, and `rpc()` refusing to fetch without config. Which means it
    // does NOT prove the route has the guard. See the next test for that.
  })

  it('does not lean on rpc()"s internal guard to stay quiet about an unconfigured chain', async () => {
    // Removing the route's `!info` branch is invisible today, because `rpc()`
    // returns null before fetching. So this test removes THAT guard instead: an
    // rpc layer that answers even without config — which is exactly what adding a
    // fallback URL to `rpc()` would create later. If the route has no branch of
    // its own, a Base deployment starts reporting some other node's blocks as its
    // own, with `configured: false` sitting right next to real-looking data.
    vi.doMock('@/lib/chain/rpc', () => ({
      chainInfo: () => null,
      chainIdentity: async () => ({ state: 'match', chainId: 8470 }),
      latestBlockNumber: async () => 12345,
      recentTransfers: async () => [transfer()],
    }))
    const { GET } = await import('@/app/api/chain/status/route')
    const body = await (await GET(new Request('https://x.test/api/chain/status'))).json()
    expect(body.configured).toBe(false)
    expect(body.latestBlock).toBeNull()
    expect(body.transfers).toEqual([])
    vi.doUnmock('@/lib/chain/rpc')
  })

  it('serves live values from the node and clamps the caller"s span', async () => {
    vi.stubEnv('TINY_CHAIN_ID', '8470')
    vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', addr(0xdd))
    vi.stubEnv('TINY_CHAIN_RPC_URL', 'http://node.invalid:8600')
    const seen: any[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
      const body = JSON.parse(String(init.body))
      seen.push(body)
      const result =
        body.method === 'eth_chainId'
          ? '0x2116' // 8470
          : body.method === 'eth_blockNumber'
            ? '0x1388' // 5000
            : body.method === 'eth_getLogs'
              ? [
                  {
                    topics: [
                      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                      `0x${'0'.repeat(24)}${addr(0xa1).slice(2)}`,
                      `0x${'0'.repeat(24)}${addr(0xb2).slice(2)}`,
                    ],
                    data: '0x16e360', // 1_500_000
                    transactionHash: tx(7),
                    logIndex: '0x0',
                    blockNumber: '0x1387',
                  },
                ]
              : null
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        headers: { 'content-type': 'application/json' },
      })
    })

    const { GET } = await load()
    const res = await GET(new Request('https://x.test/api/chain/status?span=999999&limit=0'))
    const body = await res.json()

    expect(body.configured).toBe(true)
    expect(body.chainId).toBe(8470)
    expect(body.identity).toBe('match')
    expect(body.latestBlock).toBe(5000)
    expect(body.reachable).toBe(true)
    expect(body.transfers).toHaveLength(1)
    expect(body.transfers[0].amount).toBe('$1.50')
    expect(body.transfers[0].kind).toBe('transfer')

    // The clamp is observable in the payload AND in what we asked the node for:
    // span capped to SPAN_MAX, so fromBlock is latest-SPAN_MAX, not latest-999999.
    expect(body.span).toBe(SPAN_MAX)
    const logsCall = seen.find((b) => b.method === 'eth_getLogs')
    expect(parseInt(logsCall.params[0].fromBlock, 16)).toBe(5000 - SPAN_MAX < 0 ? 0 : 5000 - SPAN_MAX)
  })

  it('reports a node that answers nothing as unreachable, not as an empty chain', async () => {
    vi.stubEnv('TINY_CHAIN_ID', '8470')
    vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', addr(0xdd))
    vi.stubEnv('TINY_CHAIN_RPC_URL', 'http://node.invalid:8600')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const { GET } = await load()
    const body = await (await GET(new Request('https://x.test/api/chain/status'))).json()
    // Configured but silent: the client must say "can't reach the chain", never
    // "the chain has no activity" — the second is a claim we cannot support.
    expect(body.configured).toBe(true)
    expect(body.reachable).toBe(false)
    expect(body.latestBlock).toBeNull()
    expect(body.identity).toBe('unknown')
    expect(body.transfers).toEqual([])
  })

  it('surfaces a chain-id mismatch rather than serving mislabelled blocks', async () => {
    vi.stubEnv('TINY_CHAIN_ID', '8470')
    vi.stubEnv('TINY_CHAIN_USDC_ADDRESS', addr(0xdd))
    vi.stubEnv('TINY_CHAIN_RPC_URL', 'http://127.0.0.1:8545')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
      const body = JSON.parse(String(init.body))
      const result = body.method === 'eth_chainId' ? '0x2111' /* 8465... */ : body.method === 'eth_blockNumber' ? '0x64' : []
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    })
    const { GET } = await load()
    const body = await (await GET(new Request('https://x.test/api/chain/status'))).json()
    expect(body.identity).toBe('mismatch')
    expect(body.chainId).toBe(8470)
    expect(body.reportedChainId).toBe(0x2111)
  })

  it('is public and cached briefly — never no-store, never private', async () => {
    vi.stubEnv('TINY_CHAIN_ID', '')
    const { GET } = await load()
    const res = await GET(new Request('https://x.test/api/chain/status'))
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toMatch(/public/)
  })

  it('does not require a token — this is chain data, and gating it would imply privacy', () => {
    const src = readFileSync(joinPath(process.cwd(), 'app/api/chain/status/route.ts'), 'utf8')
    // Anchored to executable shapes, not to prose: the docblock discusses tokens
    // deliberately, and a file-wide match would pass on the explanation.
    expect(src).not.toMatch(/requireAuth|authorize\(|getSession\(|headers\.get\(['"]authorization/i)
  })
})
