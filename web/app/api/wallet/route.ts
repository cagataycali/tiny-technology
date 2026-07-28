/**
 * /api/wallet — session-gated payments proxy (payments PR1).
 *
 *   GET  → { ok, balance_micro, history }        (your ledger)
 *   POST { action: 'set_price', resource, price_micro } → set/clear a price
 *   POST { action: 'pricing', resource }         → public price lookup
 *
 * All ledger mutation happens in the worker on the internal-key channel;
 * the session is the payer/owner authority (AGENTS.md §13 — encode every
 * client value into worker URLs).
 */
import { getSession } from '@/lib/auth'
import slugify from 'slugify'

export const runtime = 'edge'

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'

// 💸 Canonicalize a `tiny:` pricing resource to the SAME strict slug the price
// was WRITTEN under. A tiny's price is set under `tiny:${slugify(name,{strict:
// true})}` — by the chat set_price tool (chat/route.ts:1339) and create_tiny
// stores names AS strict slugs (:402) — and the CHARGE reads that same strict
// form (chat/route.ts:215/277). But the clients POST this route's set_price +
// pricing actions with a bare-lowercased name: web sends the already-canonical
// tiny.name (fine), but iOS loadPrice ("tiny:\(name.lowercased())") and Android
// fetchPrice ("tiny:${name.trim().lowercase()}") + Android's bare `/price`
// (writes "tiny:$currentTiny") send a user-typed Config.tinyName that may be
// non-canonical ("Cool Bot" → "cool bot", never the "cool-bot" the price lives
// under). Left verbatim, the badge lookup MISSES the price row (no badge shown)
// yet the server still charges on send — a surprise-charge display-vs-charge
// gap — and a bare-`/price` write lands under a key the charge never reads (the
// owner prices it but earns nothing). Canonicalizing here, in the one route all
// three clients share for BOTH read and write, closes it centrally. slugify is
// idempotent on a canonical slug (node-verified) so the web/canonical path is a
// strict no-op. tool: resources have their own canonicalization + a login
// prefix, so only tiny: is touched. Completes the Cycle-88/89 pricing-key arc.
function canonicalPricingResource(resource: string): string {
  if (!resource.startsWith('tiny:')) return resource
  const slug = slugify(resource.slice('tiny:'.length), { lower: true, strict: true })
  return slug ? `tiny:${slug}` : resource
}

// Upper bound on a set price, in micro-USDC ($100). The chat agent tool already
// enforces this (app/api/chat/route.ts set_price: z.number().min(0).max(100))
// and all 3 clients cap their UI at $100 — but this raw proxy route only
// checked `>= 0`, so a direct authenticated POST could set an arbitrary price,
// bypassing the guardrail every other surface honors. Android's own client
// comment (ChatViewModel.kt) even documents the server contract as
// "price_micro:0..100_000_000 ($100 cap)" — a contract this route didn't
// enforce. Make the server authoritative so no surface can exceed the cap.
const MAX_PRICE_MICRO = 100_000_000 // $100

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const internalHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  // Bound the worker read (10s, matching every sibling proxy —
  // erc8004/registration, x402/chat, tools/install): a hung worker would
  // otherwise pin this edge invocation to the CF wall-clock (the wallet page
  // spins forever) instead of failing fast into the 424 the .catch already
  // routes to. AbortError → .catch → { error } → 424, the handled path.
  const data = await fetch(
    `${WORKER_URL}/pay/balance?userId=${encodeURIComponent(session.sub)}`,
    { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
  ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))

  if (data.error) return json({ ok: false, error: data.error }, 424)
  return json({ ok: true, balance_micro: data.balance_micro, history: data.history || [] })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const body = await req.json().catch(() => ({} as any))
  const action = String(body.action || '')

  if (action === 'set_price') {
    const resource = canonicalPricingResource(String(body.resource || ''))
    const priceMicro = Math.floor(Number(body.price_micro))
    if (!resource || !Number.isFinite(priceMicro) || priceMicro < 0) {
      return json({ ok: false, error: 'resource and price_micro >= 0 required' }, 400)
    }
    if (priceMicro > MAX_PRICE_MICRO) {
      return json({ ok: false, error: 'price_micro exceeds the $100 maximum' }, 400)
    }
    // Bound the worker write (10s) like the read paths above: without it a hung
    // worker pins this edge invocation to the CF wall-clock and the owner's
    // "set price" button spins forever instead of failing fast into the handled
    // error below. AbortError → .catch → { error } → surfaced. Safe under retry:
    // set_price is idempotent (re-setting the same price is a no-op).
    const data = await fetch(`${WORKER_URL}/pay/price`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ ownerId: session.sub, resource, price_micro: priceMicro }),
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
    if (data.error) return json({ ok: false, error: data.error }, 400)
    return json({ ok: true, resource: data.resource, price_micro: data.price_micro })
  }

  if (action === 'deposit_info') {
    const data = await fetch(
      `${WORKER_URL}/pay/deposit-info?userId=${encodeURIComponent(session.sub)}`,
      { headers: internalHeaders(), cache: 'no-store', signal: AbortSignal.timeout(10_000) }
    ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
    if (data.error) return json({ ok: false, error: data.error }, 424)
    return json(data)
  }

  if (action === 'link_address') {
    const address = String(body.address || '')
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json({ ok: false, error: 'valid 0x address required' }, 400)
    // Bound (10s) like the reads: a hung worker must not leave the "link address"
    // button spinning. Idempotent — re-linking the same address is a no-op.
    const data = await fetch(`${WORKER_URL}/pay/link-address`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ userId: session.sub, address }),
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
    if (data.error) return json({ ok: false, error: data.error }, 400)
    return json(data)
  }

  if (action === 'claim') {
    const txHash = String(body.txHash || '')
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return json({ ok: false, error: 'valid tx hash required' }, 400)
    const res = await fetch(`${WORKER_URL}/pay/claim`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        userId: session.sub, txHash,
        // 'base' | 'base-sepolia' — testnet claims credit capped trial balance
        ...(body.network ? { network: String(body.network) } : {}),
      }),
      // 20s (vs the 10s reads): the worker does on-chain tx verification here, so
      // it needs more headroom — but still fail-fast rather than hang the "claim"
      // button on the CF wall-clock. AbortError → .catch → null → the 424 below.
      // Safe under retry: claim is idempotent by txHash (worker → already_credited).
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null)
    if (!res) return json({ ok: false, error: 'wallet service unreachable' }, 424)
    const data = await res.json().catch(() => ({}))
    // Pass through worker status semantics (425 = wait for confirmations)
    return json(data, res.ok ? 200 : res.status)
  }

  if (action === 'pricing') {
    const resource = canonicalPricingResource(String(body.resource || ''))
    const data = await fetch(
      `${WORKER_URL}/pay/pricing?resource=${encodeURIComponent(resource)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(10_000) }
    ).then(r => r.json()).catch(e => ({ error: String(e?.message || e) }))
    if (data.error) return json({ ok: false, error: data.error }, 400)
    return json({ ok: true, ...data })
  }

  return json({ ok: false, error: 'unknown action' }, 400)
}
