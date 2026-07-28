/**
 * Server-side JSON-RPC reads for the /chain explorer pages.
 *
 * Plain fetch, no client library: every method used here is in the public
 * proxy's allowlist (chain/rpc-proxy.mjs), so the pages work identically
 * against the local node and the tunneled endpoint. Every call carries a
 * timeout and fails to null — an explorer that 500s when the chain is down
 * can't tell the user the chain is down.
 */
import { tinyChainConfig } from '@/lib/x402/tiny-chain'
import { TRANSFER_TOPIC, decodeTransferLog, hexToNumber, lookbackFrom, type TransferLog } from './explorer-core'

export type ChainInfo = { chainId: number; usdc: string; rpc: string }

/** null on deployments without a chain — the pages render "not configured". */
export function chainInfo(): ChainInfo | null {
  const t = tinyChainConfig()
  return t ? { chainId: t.chainId, usdc: t.usdc.toLowerCase(), rpc: t.rpc } : null
}

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const info = chainInfo()
  if (!info) return null
  try {
    const r = await fetch(info.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    const body = await r.json()
    return body?.error ? null : body?.result ?? null
  } catch {
    return null
  }
}

export const latestBlockNumber = async (): Promise<number | null> =>
  hexToNumber(await rpc('eth_blockNumber'))

/**
 * ⚠️ IS THE NODE WE'RE READING THE CHAIN WE CLAIM TO BE?
 *
 * `TINY_CHAIN_RPC_URL` **defaults to `http://127.0.0.1:8545`**, which on the
 * machine that hosts these chains is the LIVE one (8469). So a deployment that
 * sets `TINY_CHAIN_ID=8470` and forgets the RPC renders 8469's blocks, balances
 * and transfers under an "eip155:8470" heading — every number real, every label
 * wrong, and nothing broken enough to notice. The same mistake in reverse
 * misattributes production money to the devnet.
 *
 * Returns the node's own answer, so a caller can say "this is chain X" only
 * when the node agrees. `null` means we couldn't ask (node down, method not in
 * the proxy allowlist) — which is NOT the same as a mismatch and must not
 * render as one: an unreachable node is already reported as unreachable.
 */
export const reportedChainId = async (): Promise<number | null> =>
  hexToNumber(await rpc('eth_chainId'))

export type ChainIdentity =
  | { state: 'match'; chainId: number }
  | { state: 'unknown'; chainId: number }
  | { state: 'mismatch'; chainId: number; reported: number }

/**
 * Compare the configured chain id against the node's `eth_chainId`.
 *
 * Fails LOUD on disagreement rather than fixing it silently: whichever value we
 * picked to trust, the deployment is misconfigured and the operator is the only
 * one who can say which half was intended. Rendering the node's id would hide a
 * wrong `PAYMENTS_NETWORK`; rendering ours would keep lying about the data.
 */
export async function chainIdentity(): Promise<ChainIdentity | null> {
  const info = chainInfo()
  if (!info) return null
  const reported = await reportedChainId()
  if (reported === null) return { state: 'unknown', chainId: info.chainId }
  if (reported !== info.chainId) return { state: 'mismatch', chainId: info.chainId, reported }
  return { state: 'match', chainId: info.chainId }
}

export const getTransaction = (hash: string) => rpc('eth_getTransactionByHash', [hash])
export const getReceipt = (hash: string) => rpc('eth_getTransactionReceipt', [hash])
export const getBlock = (numberHex: string) => rpc('eth_getBlockByNumber', [numberHex, false])

/** TinyUSDC balanceOf(addr) via eth_call — selector 0x70a08231 + padded address. */
export async function usdcBalanceMicro(address: string): Promise<number | null> {
  const info = chainInfo()
  if (!info) return null
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`
  return hexToNumber(await rpc('eth_call', [{ to: info.usdc, data }, 'latest']))
}

export const ethBalanceWei = async (address: string): Promise<number | null> =>
  hexToNumber(await rpc('eth_getBalance', [address, 'latest']))

const toTopicAddress = (address: string): string =>
  `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

/**
 * Recent TinyUSDC transfers, newest first — optionally only those touching
 * `address` (as sender OR recipient: two filtered queries, merged + deduped
 * by tx+index, because a topic filter is positional and OR across positions
 * isn't expressible in one eth_getLogs).
 */
export async function recentTransfers(opts: { span: number; address?: string; limit: number }): Promise<TransferLog[]> {
  const info = chainInfo()
  if (!info) return []
  const latest = await latestBlockNumber()
  if (latest === null) return []
  const fromBlock = `0x${lookbackFrom(latest, opts.span).toString(16)}`
  const base = { address: info.usdc, fromBlock, toBlock: 'latest' }
  const queries = opts.address
    ? [
        { ...base, topics: [TRANSFER_TOPIC, toTopicAddress(opts.address)] },
        { ...base, topics: [TRANSFER_TOPIC, null, toTopicAddress(opts.address)] },
      ]
    : [{ ...base, topics: [TRANSFER_TOPIC] }]
  const results = await Promise.all(queries.map((q) => rpc('eth_getLogs', [q])))
  const seen = new Set<string>()
  const out: TransferLog[] = []
  for (const logs of results) {
    if (!Array.isArray(logs)) continue
    for (const log of logs) {
      const key = `${log?.transactionHash}:${log?.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      const t = decodeTransferLog(log)
      if (t) out.push(t)
    }
  }
  out.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))
  return out.slice(0, opts.limit)
}
