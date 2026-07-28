/**
 * GET /api/chain/status — the /chain explorer's facts, as JSON, for native clients.
 *
 * Wiring only. Every decision (identity three-state, money pre-formatting, the
 * uint256 clamp flag, clamping the client's span/limit) lives in
 * `lib/chain/status.ts` where it is unit-tested; this file fetches and serialises.
 *
 * PUBLIC AND UNAUTHENTICATED, deliberately: everything here is already public —
 * it is a blockchain, and `chain/rpc-proxy.mjs` exposes these same reads to the
 * open internet. Requiring a token would suggest the data is private, which is
 * the opposite of the claim the chain makes. What it must NOT do is let a caller
 * turn one request into an expensive node query, hence the clamps.
 */
import { chainInfo, chainIdentity, latestBlockNumber, recentTransfers } from '@/lib/chain/rpc'
import {
  buildChainStatus,
  clampInt,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  SPAN_DEFAULT,
  SPAN_MAX,
} from '@/lib/chain/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const span = clampInt(url.searchParams.get('span'), SPAN_DEFAULT, 1, SPAN_MAX)
  const limit = clampInt(url.searchParams.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)

  const info = chainInfo()
  // No chain configured → skip the awaits. This branch is REDUNDANT and known to
  // be: `rpc()` won't fetch without config, and `buildChainStatus` nulls every
  // field when `info` is null, so deleting these three lines changes no response
  // and no network traffic — a mutation test proved it unkillable. The guarantee
  // lives in the pure layer; this is just not doing pointless work. Don't read it
  // as the safety check, and don't move the safety check here.
  if (!info) {
    return json(buildChainStatus({ info: null, identity: null, latestBlock: null, transfers: [], span }))
  }

  // Concurrent: the three reads are independent, and a phone on a slow link is
  // already paying our latency once.
  const [identity, latestBlock, transfers] = await Promise.all([
    chainIdentity(),
    latestBlockNumber(),
    recentTransfers({ span, limit }),
  ])

  return json(buildChainStatus({ info, identity, latestBlock, transfers, span }))
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      // Short and public. A block height is stale the moment it's sent; 10s keeps
      // a pull-to-refresh honest while absorbing a screen that polls.
      'cache-control': 'public, max-age=10',
    },
  })
