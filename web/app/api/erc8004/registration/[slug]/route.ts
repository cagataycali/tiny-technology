/**
 * 🪪 /api/erc8004/registration/<slug> — ERC-8004 registration file (PR4).
 *
 * Serves the spec-compliant registration JSON for any public tiny
 * (https://eips.ethereum.org/EIPS/eip-8004#registration-v1). Owners point
 * `register_agent` at this URL (or upload it to IPFS) to mint their tiny's
 * on-chain identity — e.g. with strands-erc8004:
 *
 *   erc8004(action="register_agent",
 *           agent_uri="https://tiny.technology/api/erc8004/registration/<slug>",
 *           chain="base", wallet_name="my-wallet")
 *
 * The file is LIVE (reflects current price/x402 support) — HTTPS URI
 * strategy from the spec. Private tinys 403 (their prompt/knowledge is
 * masked everywhere else; the registration file must not leak metadata).
 */
import removeMd from 'remove-markdown'
import { tinyChainConfig, paymentsNetwork } from '@/lib/x402/tiny-chain'
import { facilitatorUrl } from '@/lib/x402/facilitator'

export const runtime = 'edge'

const WORKER = 'https://plugin.tiny.technology'

// The exact networks/assets the x402 challenge accepts — MUST match
// app/api/x402/chat/[slug] NETWORKS so the registration is self-describing:
// an agent reading only this file learns which chains + USDC asset to pay,
// without a second round-trip to probe the endpoint for a 402.
// Exported so tests/x402-network-parity.test.ts can assert this on-chain-baked
// table stays byte-identical to the x402/chat receiver's NETWORKS + the payer's
// PAYER_NETWORKS — the "MUST match" invariant above, with teeth. A silent drift
// here bakes wrong payment terms into PERMANENT on-chain registrations.
const TINY = tinyChainConfig()
export const X402_NETWORKS: readonly { network: string; asset: string }[] = [
  { network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },   // Base — USDC
  { network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, // Base Sepolia — USDC (testnet)
  // Self-hosted tiny-chain — present only when configured (lib/x402/tiny-chain.ts)
  ...(TINY ? [{ network: TINY.caip2, asset: TINY.usdc }] : []),
]

// 🧪→💵 Which of the parity-table networks THIS deployment actually settles on.
// X402_NETWORKS above is the full 2-chain address table the parity test locks
// (tests/x402-network-parity.test.ts asserts the CONSTANT stays byte-identical
// across receiver/signer/registration — it must keep both entries). But the
// registration file we SERVE must advertise only the network the receiver will
// honor: post-commit bd48d8a0 the x402 challenge (paymentRequirements →
// offeredNetworks) offers EXACTLY the deployment's own chain — base-sepolia on
// PAYMENTS_TESTNET, else base. Baking BOTH into accepts[] hands a minting agent
// a chain the receiver's matchRequirement() returns null for → settlePayment
// fails closed ('unsupported network') on every payment signed against the
// non-offered door. Mirror offeredNetworks() by CAIP-2 so the on-chain doc and
// the receiver never disagree about which chain is payable.
const offeredAccepts = () => {
  const net = paymentsNetwork()
  const caip2 = net === 'tiny' ? tinyChainConfig()!.caip2
    : net === 'base-sepolia' ? 'eip155:84532' : 'eip155:8453'
  return X402_NETWORKS.filter((n) => n.network === caip2)
}

const json = (body: any, status = 200, cacheable = false) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Only cache a complete, successful registration file. A 404 (tiny not
      // yet created) or 403 (private) cached publicly for 5min means the
      // on-chain registration URL keeps 404ing after the tiny goes live —
      // minting fails until TTL expires. Same rule as share/route.ts. And a
      // 200 whose pricing lookup failed must not be cached either (see below).
      'Cache-Control': status === 200 && cacheable ? 'public, max-age=300' : 'no-store',
    },
  })

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params
  const slug = String(rawSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)
  if (!slug) return json({ error: 'invalid tiny name' }, 400)

  // Deadline both upstream reads: a minting agent fetches this URL, so a hung
  // worker must fail fast into the 502 below (a retryable "lookup failed")
  // rather than holding the edge invocation open until the platform wall-clock
  // kills it. 10s matches the SSR /get convention; AbortError → .catch → null,
  // which the null-vs-{} branches below already treat as "upstream down".
  const [tiny, pricing] = await Promise.all([
    // null (not {}) on transport failure / non-2xx so we can tell "the worker
    // is down" apart from "this tiny genuinely doesn't exist". Collapsing both
    // to {} made a worker outage answer 404 for a tiny that may well exist —
    // and the on-chain registration URL 404s look permanent to a minting agent.
    fetch(`${WORKER}/get?name=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
    // null (not {price_micro:0}) on failure so we can tell "genuinely free"
    // apart from "pricing lookup failed" — a failed lookup must NOT be cached
    // as x402Support:false for a paid tiny (agents would attempt unpaid calls).
    // The r.ok gate is load-bearing: .catch only fires on transport/parse
    // failure, so a worker HTTP-error status carrying a JSON body (503
    // {"error":...}) would otherwise resolve non-null → pricingOk true →
    // a paid tiny cached as free for 5min. Treat any non-2xx as a failed lookup.
    fetch(`${WORKER}/pay/pricing?resource=${encodeURIComponent(`tiny:${slug}`)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  // A null tiny means the /get lookup itself failed (worker down / non-2xx /
  // transport) — that's an upstream error, not a missing tiny. Answering 404
  // here would make an outage indistinguishable from "never created" and (for
  // a real tiny) break its published registration URL for the outage window.
  if (tiny === null) {
    return json({ error: 'registration lookup failed' }, 502)
  }
  if (!tiny?.name || tiny.response === 'tiny.technology is not exists') {
    return json({ error: `tiny '${slug}' not found` }, 404)
  }
  if (tiny.private) return json({ error: `tiny '${slug}' is private` }, 403)

  // Fail CLOSED on a pricing-lookup blip, exactly like the x402/chat POST + GET
  // paths. Serving a 200 with x402Support:false here is failing OPEN to the
  // DIRECT caller — no-store only protects downstream caches, not the agent
  // reading this response right now. And this registration URL is precisely
  // what `register_agent` points at to mint an ERC-8004 identity ON-CHAIN: an
  // agent minting during a pricing outage would bake x402Support:false into a
  // PERMANENT on-chain record for what may be a paid tiny. A retryable 502 is
  // the only safe answer — the minting agent retries and gets the true price.
  if (pricing === null) return json({ error: 'pricing lookup failed, retry' }, 502)

  const priceMicro = Number(pricing?.price_micro || 0)
  // Trust the VALUE, not just its presence — same guard the x402/chat POST + GET
  // paths apply (route.ts "!Number.isInteger || < 0 → 502"). A fractional price
  // bakes priceMicroUsdc:1.5 + a full accepts[] into this cacheable, on-chain-
  // minted doc that no canonical-micro (/^\d+$/) payer can honor; a NaN/negative
  // reads free (NaN>0 and -5>0 are both false) so a PAID tiny gets immortalized
  // as x402Support:false — the exact "paid tiny cached as free" failure this
  // route's comments claim to prevent. Fail CLOSED with the pricing-blip 502 so
  // the registration and the receiver never disagree about whether a tiny is
  // payable, and no minting agent bakes a broken price on-chain.
  if (!Number.isInteger(priceMicro) || priceMicro < 0) return json({ error: 'pricing lookup failed, retry' }, 502)
  // Same receiving address the x402 challenge emits (X402_PAY_TO). When it's a
  // paid tiny we advertise the full payment shape so the registration stands
  // alone as discovery; a free tiny needs no payment metadata.
  const payTo = process.env.X402_PAY_TO || ''

  // Fail CLOSED when a PAID tiny has no receiving address configured. The relay
  // hard-fails this exact condition (x402/chat POST → 424 "x402 payments not
  // configured on this deployment"), so advertising the tiny here as fully
  // payable (x402Support:true, scheme, accepts[]) — just without payTo — would
  // hand a minting agent a service the relay 424s on every payment. Worse, this
  // 200 is cacheable AND is precisely what `register_agent` bakes PERMANENTLY
  // on-chain: an agent minting during a payTo-less window would immortalize an
  // "I'm payable" claim that can never be honored. Mirror the relay's 424 (not
  // the pricing-blip 502 — an unset env won't resolve on retry) so the two
  // endpoints agree and no broken registration gets minted.
  if (priceMicro > 0 && !payTo) {
    return json({ error: 'x402 payments not configured on this deployment' }, 424)
  }

  // Same fail-closed for a deployment whose chain NO configured facilitator can
  // settle (lib/x402/facilitator.ts — unset on a self-hosted chain, or pointed
  // at a public-chain-only facilitator). The relay 424s every payment in that
  // state, and this doc is the one that gets baked PERMANENTLY on-chain: an
  // agent minting during such a window would immortalize "pay me TinyUSDC on
  // eip155:<our chain>" for a door that cannot settle it, with no way to edit
  // the claim afterwards. Mirror the relay's 424 for the same reason the payTo
  // guard above does — the three surfaces must agree on whether a tiny is
  // payable.
  if (priceMicro > 0 && !facilitatorUrl()) {
    return json({ error: 'x402 payments not configured on this deployment' }, 424)
  }

  return json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: tiny.name,
    // Strip markdown BEFORE the 500-char clamp — this description is baked
    // PERMANENTLY on-chain and rendered by consuming agent registries as plain
    // text, so raw `**bold**` / `# heading` / `[label](url)` syntax would show
    // literally in a registry UI (and inflate the char budget with markup the
    // reader never sees). The OG share card already strips the same field
    // (og/[slug] removeMd) — the more permanent, more machine-consumed surface
    // must be at least as clean. Clamp the STRIPPED text so the 500 cap counts
    // visible characters, not syntax. Falls back to a branded line when empty.
    description: removeMd(String(tiny.systemPrompt || '')).trim().slice(0, 500) || `${tiny.name} — an AI at tiny.technology`,
    image: `https://tiny.technology/og/${tiny.name}`,
    services: [
      { name: 'web', endpoint: `https://tiny.technology/${tiny.name}` },
      {
        name: 'x402-chat',
        endpoint: `https://tiny.technology/api/x402/chat/${tiny.name}`,
        ...(priceMicro > 0
          ? {
              priceMicroUsdc: priceMicro,
              // The payment facts an agent needs to pay without probing: scheme,
              // receiving address, and every accepted (network, USDC asset) —
              // filtered to the network THIS deployment settles (offeredAccepts),
              // so a minting agent never signs a chain the receiver fails closed on.
              scheme: 'exact',
              ...(payTo ? { payTo } : {}),
              accepts: offeredAccepts().map((n) => ({ network: n.network, asset: n.asset })),
            }
          : {}),
      },
    ],
    x402Support: priceMicro > 0,
    active: tiny.active !== false,
    supportedTrust: ['reputation'],
    // Safe to cache: we only reach here with a genuine pricing result (a failed
    // lookup already 502'd above), so x402Support reflects the real price.
  }, 200, true)
}
