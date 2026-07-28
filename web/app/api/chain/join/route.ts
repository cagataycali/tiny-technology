/**
 * 🚪 GET /api/chain/join — how to run a node on the multi-node tiny chain.
 *
 * This is the endpoint that makes "anyone can participate" literally true. Until
 * it existed, the one file the p2p handshake requires — the genesis — lived only
 * in `chain/multinode/genesis-8470.json` inside a PRIVATE repo, so the P5 suite's
 * "the published artifacts are sufficient" was a claim about our own clone. A
 * stranger had nothing to boot from.
 *
 *   GET /api/chain/join                  → the full join document (JSON)
 *   GET /api/chain/join?format=genesis   → the raw genesis file, curl-able
 *
 * The genesis is a STATIC IMPORT, not a filesystem read: this route is edge, and
 * `node:fs` is aliased to an empty module there (next.config.js). Importing it
 * also means the bytes served are the same bytes the founders' nodes boot from —
 * a copy kept in sync by hand would eventually not be, and the failure mode is a
 * joiner who cannot peer for reasons that look like a network problem.
 *
 * All the judgement lives in lib/chain/join.ts (pure, unit-tested). This file is
 * only wiring: env in, cache headers out.
 */
import genesis from '@/chain/multinode/genesis-8470.json'
import { buildJoinDoc } from '@/lib/chain/join'
import { tinyChainConfig, paymentsNetwork } from '@/lib/x402/tiny-chain'

export const runtime = 'edge'

// Public and cacheable: the genesis of a running chain is immutable, and the rest
// of the document changes only on a deploy. 5 minutes matches the other public
// docs (share, erc8004 registration) — long enough to absorb a link going around,
// short enough that publishing a real bootnode takes effect the same day.
const CACHE = 'public, max-age=300'

export async function GET(req: Request) {
  const url = new URL(req.url)

  if (url.searchParams.get('format') === 'genesis') {
    // Served as application/json with a filename hint so `curl -O` and a browser
    // both do something sensible. No transformation whatsoever — a genesis that
    // has been through a JSON round-trip is still byte-fragile in the ways that
    // matter (key order does not affect the genesis block hash, but there is no
    // reason to take the risk on the one file that must match exactly).
    return new Response(JSON.stringify(genesis, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `inline; filename="tiny-${genesis.config.chainId}-genesis.json"`,
        'Cache-Control': CACHE,
      },
    })
  }

  const tiny = tinyChainConfig()
  let doc
  try {
    doc = buildJoinDoc({
      genesis,
      // Env, not the repo's bootnodes-8470.txt: that file is loopback-only by
      // design (see its own header) and this route cannot read files on edge
      // anyway. Absent env ⇒ an empty list plus a note saying how to get a peer
      // enode — never a fabricated address, which is the one answer that would
      // make a joiner debug their own network for a peer that never existed.
      bootnodes: process.env.TINY_CHAIN_PUBLIC_BOOTNODES || null,
      configuredChainId: tiny?.chainId ?? null,
      configuredUsdc: tiny?.usdc ?? null,
      deploymentNetwork: paymentsNetwork(),
      origin: url.origin,
    })
  } catch (e: any) {
    // Only reachable if the committed genesis loses its chain id. Fail closed:
    // wrong boot instructions cost the reader a full sync before they find out.
    return new Response(JSON.stringify({ error: String(e?.message || e) }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }

  return new Response(JSON.stringify(doc, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE },
  })
}
