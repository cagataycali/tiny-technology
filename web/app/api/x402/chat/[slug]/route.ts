/**
 * 🌐 /api/x402/chat/<slug> — x402 inbound (payments PR3, design doc §3b).
 *
 * The "real network" door: ANY agent on the internet can pay a priced tiny
 * per request with USDC on Base — no tiny.technology account needed.
 *
 * Protocol (x402, https://x402.org):
 *   1. POST { message } without payment → 402 + PaymentRequirements JSON
 *      (accepts[]: exact scheme, USDC on Base, payTo = platform address)
 *   2. Caller signs an EIP-3009 transferWithAuthorization payload and
 *      retries with the X-PAYMENT header (base64 JSON)
 *   3. We verify + SETTLE via the facilitator BEFORE running the model
 *      (settle-before-serve — §6.3; verify alone is not payment)
 *   4. Owner is credited in the ledger (price minus the flat $0.001 fee)
 *      keyed by the settlement tx hash — idempotent, auditable
 *
 * Free tinys work here too (courtesy JSON API — no 402 dance).
 *
 * Env: X402_PAY_TO (platform receiving address), X402_FACILITATOR_URL
 * (default https://x402.org/facilitator on the Base chains; REQUIRED on a
 * self-hosted chain — see lib/x402/facilitator.ts), PAYMENTS_TESTNET=1 → Base
 * Sepolia.
 */
import { isDeliveredOutput } from '@/lib/chat/events'
import { tinyChainConfig, tinyExplorerTxUrl, paymentsNetwork } from '@/lib/x402/tiny-chain'
import { facilitatorUrl } from '@/lib/x402/facilitator'
import { asNetwork, x402DescSuffix } from '@/lib/x402/top-up'
import { settleOutcome, settlementHash, UNKNOWN, NOT_SETTLED } from '@/chain/settle-outcome.mjs'

export const runtime = 'edge'
export const maxDuration = 300

const WORKER = 'https://plugin.tiny.technology'
// 🌐 DUAL-NETWORK: the 402 challenge offers BOTH Base mainnet and Base
// Sepolia — the caller picks by signing for one of the accepts[]. Real
// USDC = real credit; testnet = works end-to-end for free trials.
// Exported so tests/x402-network-parity.test.ts can assert this money-path table
// (the addresses we verify+settle against) stays byte-identical to the payer's
// PAYER_NETWORKS (what the hot wallet signs for) and the ERC-8004 registration's
// X402_NETWORKS (what gets baked on-chain). Three hand-maintained copies of the
// same USDC contracts — the parity test is the single guard against drift.
const TINY = tinyChainConfig()
export const NETWORKS: Record<string, { caip2: string; usdc: string; label: string }> = {
  base: { caip2: 'eip155:8453', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USD Coin' },
  'base-sepolia': { caip2: 'eip155:84532', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'USDC' },
  // Self-hosted tiny-chain — entry exists only when the deployment configures
  // it (lib/x402/tiny-chain.ts), keeping the table byte-identical to the other
  // two copies everywhere else. label doubles as the EIP-712 domain name the
  // challenge emits (extra.name) — TinyUSDC.sol is deployed as USDC/2.
  ...(TINY ? { tiny: { caip2: TINY.caip2, usdc: TINY.usdc, label: TINY.domainName } } : {}),
}

const json = (body: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const ikey = () => ({ 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' })

/** BaseScan URL for a settlement tx, host chosen by the CAIP-2 network the
 *  settlement landed on — mirrors the withdraw route's network-gated explorer
 *  (base-sepolia → sepolia.basescan.org, base → basescan.org). Returns '' when
 *  the network is unknown or the hash is absent, so no wrong-chain link is ever
 *  emitted. */
function explorerTxUrl(caip2: string, txHash: string): string {
  if (!txHash) return ''
  if (caip2 === 'eip155:84532') return `https://sepolia.basescan.org/tx/${txHash}`
  if (caip2 === 'eip155:8453') return `https://basescan.org/tx/${txHash}`
  if (TINY && caip2 === TINY.caip2) return tinyExplorerTxUrl(txHash)
  return ''
}

/**
 * 🧪→💵 MINT GUARD: which network(s) THIS deployment actually settles on. A
 * deployment offers EXACTLY ONE — the chain whose USDC it treats as real
 * balance: PAYMENTS_TESTNET=1 → base-sepolia only (a trial economy);
 * otherwise → base only (real USDC). This is the SAME selector deposits.ts
 * (:51, :273) uses everywhere else; the x402 challenge was the one place that
 * ignored it and offered BOTH.
 *
 * Offering both on a MAINNET deployment was a money mint: a payer signs the
 * free base-sepolia door with faucet USDC, the facilitator settles it, and the
 * owner's invoke_credit lands as REAL withdrawable balance — the withdrawal
 * guard (withdrawals.ts) only excludes on-chain testnet *deposits*, never x402
 * *earnings*, so free testnet coin mints real, cashable money. Restricting the
 * accepts[] to the deployment's own network makes matchRequirement return null
 * for the other chain, so settlePayment fails closed ('unsupported network')
 * before any faucet-funded settle can happen.
 */
export function offeredNetworks(): (keyof typeof NETWORKS)[] {
  // paymentsNetwork() honors PAYMENTS_NETWORK (incl. 'tiny' when configured)
  // and falls back to the legacy PAYMENTS_TESTNET boolean — one selector for
  // receiver, payer, registration, and (via the worker) deposits.
  return [paymentsNetwork()]
}

/** Build the x402 PaymentRequirements — one accepts[] entry per OFFERED network. */
export function paymentRequirements(slug: string, priceMicro: number, payTo: string) {
  return {
    x402Version: 1,
    accepts: offeredNetworks().map((net) => ({
      scheme: 'exact',
      network: NETWORKS[net].caip2,
      maxAmountRequired: String(priceMicro),
      resource: `https://tiny.technology/api/x402/chat/${slug}`,
      description: `One message to ${slug} — an AI at tiny.technology/${slug}${x402DescSuffix(asNetwork(net))}`,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 120,
      asset: NETWORKS[net].usdc,
      extra: { name: NETWORKS[net].label, version: '2' },
    })),
    error: 'Payment required: retry with the X-PAYMENT header',
  }
}

/**
 * Canonical CAIP-2 for any network string a client might echo. We EMIT CAIP-2
 * (spec-correct — scheme_exact_evm.md uses `eip155:<chainId>`), but tolerate a
 * client that signs against the short name (`base` / `base-sepolia`) or a bare
 * chain id. Without this, a short-name echo never equals our CAIP-2
 * `a.network`, so matchRequirement fell through to accepts[0] = mainnet — a
 * testnet payment silently verified/settled against MAINNET requirements
 * (wrong asset/amount domain) and got reported as the wrong chain.
 */
export function canonicalNetwork(n: string): string {
  const s = String(n || '').toLowerCase().trim()
  if (s === 'base' || s === 'eip155:8453' || s === '8453') return 'eip155:8453'
  if (s === 'base-sepolia' || s === 'base_sepolia' || s === 'sepolia' || s === 'eip155:84532' || s === '84532') return 'eip155:84532'
  if (TINY && (s === 'tiny' || s === TINY.caip2 || s === String(TINY.chainId))) return TINY.caip2
  return s
}

/**
 * Which accepts[] entry does a payment payload target? Match by network,
 * comparing on the CANONICAL form so `base-sepolia` and `eip155:84532` are the
 * same door. Returns null when the payload names a network we don't offer —
 * the caller MUST reject rather than settle against a mismatched requirement.
 */
export function matchRequirement(payload: any, requirements: any): any {
  const net = canonicalNetwork(payload?.payload?.network || payload?.network || '')
  return requirements.accepts.find((a: any) => canonicalNetwork(a.network) === net) || null
}

/**
 * Durable internal-write with bounded retry. Both /pay/credit and /pay/invoke
 * are idempotent by ref (the settlement txHash), so retrying is always safe —
 * a duplicate lands as already_credited/already_settled, never a double-charge.
 *
 * WHY THIS EXISTS: the payer has ALREADY moved USDC on-chain by the time we get
 * here (settle-before-serve). If our ledger write is fire-and-forget and the
 * worker blips, the owner is never credited for money that really moved — a
 * silent creator-earnings loss. We await + retry, and if every attempt fails we
 * emit ONE structured `x402-reconcile` log line carrying everything needed to
 * replay the write by hand or by a sweep. The answer is still served (the caller
 * paid); only our bookkeeping lagged, and it's now recoverable, not lost.
 */
export async function durableWrite(url: string, body: any, tag: string, attempts = 4): Promise<boolean> {
  let lastErr = ''
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: ikey(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      // 2xx OR the idempotent-conflict shapes = the write is durably recorded.
      if (r.ok) return true
      const j = await r.json().catch(() => ({} as any))
      if (j?.ok || j?.already_credited || j?.already_settled) return true
      lastErr = j?.error || `HTTP ${r.status}`
    } catch (e: any) {
      lastErr = String(e?.message || e).slice(0, 120)
    }
    // Linear backoff; edge CPU budget is tight, so keep it short and few.
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 250 * (i + 1)))
  }
  // Every attempt failed. Money moved on-chain but the ledger write didn't
  // land — emit a single greppable line with the full replay payload. This is
  // the reconciliation record; `x402-reconcile` is the alerting/sweep hook.
  console.error('x402-reconcile', JSON.stringify({ tag, url, body, lastErr }))
  return false
}

/**
 * 🔍 The instrument the caller actually signed, as the reconciler needs it.
 *
 * An EIP-3009 authorization is identified by (from, nonce) — NOT by a tx hash.
 * That matters on the receiver side for the same reason it did on the payer side
 * (migration 0026): a hash may not exist yet, may never exist for a broadcast we
 * lost the ack to, and c48 showed one can exist for a transaction that never
 * reached a node. (from, nonce) is knowable the moment we decode the header, and
 * is unique by the contract's own single-use rule.
 *
 * `value` is the on-chain amount in USDC's 6-decimal base units, i.e. already
 * micro-USDC — the same unit as `priceMicro`, so no conversion. It is kept
 * separate from the price because they can differ: the payload authorizes an
 * amount, the challenge demanded one, and a reconciled credit must be able to
 * see both rather than assume they match.
 *
 * Returns null unless payer AND nonce are both well-formed: a partial identity
 * cannot be resolved, and the worker rejects it anyway (0028).
 *
 * Exported for tests — this is the shape the whole receiver-side reconciliation
 * depends on, and it is parsed out of an untrusted client-supplied header.
 */
export function authorizationIdentity(payload: any): { payer: string; nonce: string; valueMicro: number | null; validBefore: number | null } | null {
  const auth = payload?.payload?.authorization || payload?.authorization
  const payer = String(auth?.from || '').toLowerCase()
  const nonce = String(auth?.nonce || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(payer) || !/^0x[0-9a-f]{64}$/.test(nonce)) return null
  // Both arrive as decimal strings in the x402 payload (JSON has no uint256), so
  // Number() is the parse, and a non-finite result stores NULL rather than NaN.
  const v = Number(auth?.value)
  const vb = Number(auth?.validBefore)
  return {
    payer,
    nonce,
    valueMicro: Number.isFinite(v) && v > 0 ? Math.floor(v) : null,
    validBefore: Number.isFinite(vb) && vb > 0 ? Math.floor(vb) : null,
  }
}

/** Verify + settle an X-PAYMENT header via the facilitator. Settle-before-serve.
 *
 * The facilitator is resolved per call (lib/x402/facilitator.ts) and is null
 * when NO facilitator can settle the chain this deployment offers — the door
 * already 424s in that case, so reaching here with null would mean the gate
 * regressed. Fail closed rather than fetch `null/verify`. */
async function settlePayment(paymentHeader: string, requirements: any): Promise<{ ok: boolean; txHash?: string; payer?: string; network?: string; error?: string; settlement?: string; auth?: ReturnType<typeof authorizationIdentity>; payTo?: string }> {
  const FACILITATOR = facilitatorUrl()
  if (!FACILITATOR) return { ok: false, error: 'x402 payments not configured on this deployment' }
  let payload: any
  try {
    payload = JSON.parse(atob(paymentHeader))
  } catch {
    return { ok: false, error: 'X-PAYMENT header is not base64 JSON' }
  }

  // The payload MUST target a network we actually offer. A null match means
  // the client signed for a chain that isn't in accepts[] — settling that
  // against a fallback requirement would charge the wrong asset/amount domain,
  // so fail closed here rather than let the facilitator guess.
  const matched = matchRequirement(payload, requirements)
  if (!matched) return { ok: false, error: 'payment targets an unsupported network' }

  const body = JSON.stringify({
    x402Version: 1,
    paymentPayload: payload,
    paymentRequirements: matched,
  })

  // Verify first (cheap rejection), then settle (the actual transfer).
  const verify = await fetch(`${FACILITATOR}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(30_000),
  }).then(r => r.json()).catch((e: any) => ({ isValid: false, invalidReason: `facilitator unreachable: ${String(e?.message || e).slice(0, 80)}` }))
  if (!verify?.isValid) return { ok: false, error: verify?.invalidReason || 'payment verification failed' }

  // ⏱️ 75s, deliberately LONGER than the facilitator's own 60s receipt wait. When
  // this timeout was also 60s we aborted the request at the same instant the
  // facilitator was deciding, so its `unknown` verdict — the whole point of the
  // classification below — could never reach us: every slow settle arrived here
  // as a transport failure with no hash. The submitter must always get to speak.
  const settle = await fetch(`${FACILITATOR}/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(75_000),
  }).then(r => r.json()).catch((e: any) => ({
    // A settle we couldn't even read the answer to is NOT proof of no payment:
    // the facilitator may have submitted the transfer and lost the response.
    // `settlement: unknown` is what keeps the payer route from auto-refunding.
    success: false, settlement: UNKNOWN, errorReason: `settlement unreachable: ${String(e?.message || e).slice(0, 80)}`,
  }))
  if (!settle?.success) {
    // Report WHICH kind of failure, so the payer side can tell "rejected, no
    // money moved" (refundable) from "submitted, unconfirmed" (never refund).
    // Collapsing both into one 402 is what let an unconfirmed-but-landing
    // settlement refund the payer while our USDC was on-chain.
    const outcome = settleOutcome(settle)
    if (outcome === UNKNOWN) {
      console.error('x402-reconcile', JSON.stringify({
        tag: 'settle-unknown', settlement: outcome, hash: settlementHash(settle),
        note: 'settle unconfirmed — payer must NOT be refunded on this response',
      }))
    }
    return {
      ok: false, settlement: outcome, txHash: settlementHash(settle),
      error: settle?.errorReason || 'payment settlement failed',
      // Carried out only for the `unknown` branch's benefit: the caller records
      // the instrument so the owner can still be credited if it confirms. Parsed
      // here because this is where the decoded payload and the matched
      // requirement both exist — the caller has neither.
      auth: authorizationIdentity(payload), payTo: String(matched?.payTo || ''),
      // The chain we matched, so the reconciler asks the RIGHT one.
      // `authorizationState` and the AuthorizationUsed log are per-chain: a
      // confident answer from the wrong ledger is the worst possible input to a
      // resolver that ends in a credit.
      network: String(matched?.network || ''),
    }
  }

  return {
    ok: true,
    txHash: settle.transaction || settle.txHash,
    payer: settle.payer || payload?.payload?.authorization?.from,
    network: matched?.network || '',
  }
}

/**
 * Build the standard x402 `X-PAYMENT-RESPONSE` header — base64-JSON of the
 * SettleResponse { success, transaction, network, payer } — so ANY x402 client
 * gets the on-chain settlement proof in the SPEC location, not just tiny's own
 * payer. We already echo tx_hash in the body, but a standards-compliant
 * third-party payer reads ONLY this header (our own payer.ts:60 parseSettlementTx
 * reads it too, and documents a first-party body-fallback hack — :77 — that
 * exists precisely because this header was missing; emitting it lets that
 * fallback stop being load-bearing). Returns {} when there's no settlement tx so
 * no bogus header is emitted (free tinys / a hashless settle) — mirrors how the
 * body omits tx_hash in the same cases. `network` is the CAIP-2 chain we settled
 * on (matched.network), consistent with the body's `network` field.
 */
export function paymentResponseHeader(txHash: string, network: string, payer: string): Record<string, string> {
  if (!txHash) return {}
  const receipt = { success: true, transaction: txHash, network: network || '', payer: payer || '' }
  return { 'X-PAYMENT-RESPONSE': btoa(JSON.stringify(receipt)) }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params
  const slug = String(rawSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)
  if (!slug) return json({ error: 'invalid tiny name' }, 400)

  const body = await req.json().catch(() => ({} as any))
  const message = String(body.message || body.prompt || '').slice(0, 8000)
  if (!message.trim()) return json({ error: 'message required' }, 400)

  // Resolve tiny + price in parallel. Both resolve to null (not {}) on
  // transport failure / non-2xx so an upstream blip is distinguishable from a
  // genuine answer — same discipline as erc8004/registration. The r.ok gate is
  // load-bearing on BOTH: a worker HTTP-error carrying a JSON error body would
  // otherwise resolve non-null and be mistaken for a real result.
  const [tiny, pricing] = await Promise.all([
    fetch(`${WORKER}/get?name=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${WORKER}/pay/pricing?resource=${encodeURIComponent(`tiny:${slug}`)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  // A null tiny is an upstream failure, not a missing tiny — 404 here would
  // make an outage indistinguishable from "never created".
  if (tiny === null) return json({ error: 'lookup failed, retry' }, 502)
  if (!tiny?.name || tiny.response === 'tiny.technology is not exists') {
    return json({ error: `tiny '${slug}' not found` }, 404)
  }
  if (tiny.private) return json({ error: `tiny '${slug}' is private` }, 403)

  // Fail CLOSED on a pricing-lookup blip. Collapsing null → price 0 would skip
  // the 402 dance entirely and run a PAID tiny for free — the owner earns
  // nothing for real work. A retryable 502 is the only safe answer: better to
  // ask the caller to retry than to give a paid agent away. (This also 502s a
  // genuinely-free tiny during a worker outage — the correct trade: the free
  // courtesy API is not worth silently leaking paid inference.)
  if (pricing === null) return json({ error: 'pricing lookup failed, retry' }, 502)

  const priceMicro = Number(pricing?.price_micro || 0)
  // A price MUST be a non-negative INTEGER micro-USDC. A worker anomaly (NaN /
  // fractional / negative) would otherwise slip through the priceMicro>0 gate as
  // a "1.5" that paymentRequirements stringifies into maxAmountRequired:"1.5" —
  // unpayable by any standard x402 client AND rejected by our own payer.ts
  // (isCanonicalMicro=/^\d+$/), or as a NaN that reads free (NaN>0 is false) so a
  // paid tiny runs for nothing. Fail CLOSED like a pricing blip — the amount, not
  // just its presence, has to be trustworthy before we quote or charge.
  if (!Number.isInteger(priceMicro) || priceMicro < 0) return json({ error: 'pricing lookup failed, retry' }, 502)
  const payTo = process.env.X402_PAY_TO || ''

  // Network the settlement actually landed on (mainnet vs testnet) — echoed
  // in the receipt so an x402/Bazaar caller can reconcile which chain moved.
  let settledNetwork = ''
  // The on-chain settlement tx hash — echoed on the receipt so a machine caller
  // can VERIFY the payment landed (look it up on BaseScan / reconcile against
  // its own books). `network` alone can't locate a settlement on-chain; the tx
  // hash is the reconciliation key the receipt comment already promises. Distinct
  // from settledRef below: this is surfaced whenever settle returns a hash (the
  // caller's proof), settledRef gates OUR compensating refund. Stays '' for free
  // tinys (no settle) and if the facilitator settles without returning a hash.
  let settledTx = ''
  // The on-chain payer address the facilitator reported — carried into the
  // standard X-PAYMENT-RESPONSE header so a machine caller's receipt names who
  // paid, matching the x402 SettleResponse shape. Stays '' for free tinys.
  let settledPayer = ''
  // Ref (settlement txHash) of an invoke that actually landed this request —
  // set ONLY after the invoke durably records, so a downstream agent failure
  // can reverse the owner credit + platform fee (settle-before-serve refund,
  // mirror of the chat route). Stays '' for free tinys and for settlements
  // whose ledger write never landed (nothing to reverse).
  let settledRef = ''

  // Paid tiny + payments configured → x402 dance
  if (priceMicro > 0) {
    if (!payTo) return json({ error: 'x402 payments not configured on this deployment' }, 424)
    // ...and no facilitator that can settle the chain we're about to advertise.
    // Without this the 402 below quotes TinyUSDC on our own chain, the payer
    // signs a transferWithAuthorization for it, and we hand that signature to
    // x402.org — which has no RPC for our chain and never heard of the token.
    // The settle fails either way; the difference is whether we collected a
    // signed bearer instrument first and shipped it to an unrelated third party
    // to learn so. Same 424 as the missing payTo: an unset env won't resolve on
    // retry, so this is "not configured", not a blip.
    if (!facilitatorUrl()) return json({ error: 'x402 payments not configured on this deployment' }, 424)

    const requirements = paymentRequirements(slug, priceMicro, payTo)
    const paymentHeader = req.headers.get('X-PAYMENT') || ''

    if (!paymentHeader) {
      // Step 1: the 402 challenge
      return json(requirements, 402)
    }

    // Step 2/3: verify + settle BEFORE the model runs
    const settled = await settlePayment(paymentHeader, requirements)
    if (!settled.ok) {
      // The 402 body states the settlement verdict. Our own payer route reads
      // it: a first-party 402 used to be treated as blanket proof that no USDC
      // moved ("it 402s strictly before settlement"), which stopped being true
      // the moment a settle could be submitted-but-unconfirmed. `settlement`
      // makes the claim explicit instead of inferred from the status code, and
      // the hash (when we have one) is the reconciliation key.
      const settlement = settled.settlement || NOT_SETTLED
      // 🔍 THE OWNER'S SIDE OF THE UNKNOWN. `unknown` means the settlement was
      // submitted and we could not confirm it — so it very probably lands, the
      // payer's USDC arrives at payTo, and this 402 returns having credited
      // NOBODY: Step 4 below is never reached. That is a silent creator-earnings
      // loss, the same failure `durableWrite` exists to prevent twenty lines
      // down, and until now its only trace was a console line carrying a hash
      // and nothing else — unreplayable even by hand.
      //
      // So the instrument gets written down (migration 0028) with everything a
      // later credit needs: who signed, which nonce, which chain, which tiny, the
      // price, and the submitted hash when one exists. Recording only — proving
      // the money MOVED needs the AuthorizationUsed log rather than
      // `authorizationState` (that bit is also set by cancelAuthorization, so
      // crediting on it would mint), which is its own increment.
      //
      // `durableWrite` because this is the same class of write as the credit it
      // stands in for — idempotent (0028's ON CONFLICT on the instrument), and on
      // total failure it emits the SAME `x402-reconcile` line with the full body,
      // so a lost row degrades to exactly the replayable log we had before rather
      // than to nothing. Two attempts, not the default four: we are already 75s
      // into a request whose only remaining job is to answer 402, and the log
      // fallback means a third try buys little.
      //
      // Never fatal: the verdict below is unchanged either way. A bookkeeping
      // write must not be able to turn an honest `unknown` into a 500.
      if (settlement === UNKNOWN && settled.auth) {
        await durableWrite(`${WORKER}/pay/settle-unknown`, {
          payer: settled.auth.payer, nonce: settled.auth.nonce,
          txHash: settled.txHash || undefined, slug, priceMicro,
          valueMicro: settled.auth.valueMicro || undefined,
          validBefore: settled.auth.validBefore || undefined,
          network: settled.network || undefined, payTo: settled.payTo || undefined,
        }, 'settle-unknown', 2).catch(() => {})
      }
      return json({
        ...requirements, error: settled.error, settlement,
        ...(settled.txHash ? { tx_hash: settled.txHash } : {}),
      }, 402)
    }
    settledNetwork = settled.network || ''
    settledTx = settled.txHash || ''
    settledPayer = settled.payer || ''

    // Step 4: credit the owner in the ledger, keyed by settlement tx.
    // payerId = external x402 payer (namespaced, no tiny account) — their
    // debit row keeps SUM(ledger)=deposits invariant intact.
    //
    // DURABLE, not fire-and-forget: the payer already moved USDC on-chain, so
    // a dropped ledger write here would silently cost the owner their earnings.
    // We await both writes with bounded retry (idempotent by txHash) and, on
    // total failure, log a structured `x402-reconcile` record to replay later.
    // The `credit → invoke` order matters: invoke debits the payer's balance,
    // so it must be funded first. A ref is REQUIRED — an on-chain settle that
    // somehow lacks a txHash must not collapse two distinct payments onto one
    // synthetic ref (that would make the second look already_settled and skip
    // the owner's credit), so we fail closed and reconcile instead.
    const ref = settled.txHash || ''
    const payerId = `x402:${settled.payer || 'unknown'}`
    if (!ref) {
      console.error('x402-reconcile', JSON.stringify({
        tag: 'missing-txhash', slug, payer: settled.payer, priceMicro,
        note: 'settle succeeded without a tx hash; ledger write skipped to avoid ref collision',
      }))
    } else {
      // `network` is not decoration: the worker derives the ledger COUNTERPARTY
      // from it, and the counterparty is what the trial exclusion reads. Without
      // it every settle credited as counterparty='platform' — real, withdrawable
      // money — including a settle in TinyUSDC we mint ourselves, whose payer
      // therefore looked un-tainted and whose owner's invoke_credit came out as
      // mainnet USDC. We already resolved the chain (matched.network, echoed in
      // the receipt and X-PAYMENT-RESPONSE); this reports it to the one place
      // that decides whether the money is real. See creditCounterparty().
      const credited = await durableWrite(`${WORKER}/pay/credit`, {
        userId: payerId, amount_micro: priceMicro, kind: 'deposit', ref,
        network: settledNetwork,
      }, 'credit')
      // Only debit+split if the funding credit is durably recorded — invoking
      // against an unfunded balance would just bounce insufficient_balance.
      if (credited) {
        const invoked = await durableWrite(`${WORKER}/pay/invoke`, {
          payerId, resource: `tiny:${slug}`, ref,
        }, 'invoke')
        // Arm the compensating refund only if the invoke split actually
        // recorded — the owner's earnings must be reversible if the agent
        // then fails to deliver an answer for this paid request.
        if (invoked) settledRef = ref
      }
    }
  }

  // Run the tiny (headless, non-streaming — x402 callers are machines)
  const chatRes = await fetch('https://tiny.technology/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tiny-name': slug,
      'x-tiny-session': `x402-${Date.now()}`,
      // Internal marker so the chat route's own paywall doesn't double-charge
      // an already-settled x402 call — validated against the internal key
      // server-side (the header alone is spoofable)
      'x-tiny-x402-settled': priceMicro > 0 ? '1' : '',
      'x-internal-key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: message }] }),
    signal: AbortSignal.timeout(240_000),
  }).catch(() => null)

  if (!chatRes || !chatRes.ok) {
    // The caller paid on-chain but the agent never ran → reverse the owner
    // credit + platform fee (idempotent by ref; leaves the on-chain deposit
    // credit as a reconcilable liability to the payer). Without this the owner
    // keeps earnings for an undelivered answer — the x402 mirror of the chat
    // route's settle-before-serve refund. durableWrite retries + reconcile-logs.
    if (settledRef) {
      await durableWrite(`${WORKER}/pay/refund`, { ref: settledRef }, 'refund')
    }
    return json({ error: 'agent execution failed', paid: false, refunded: Boolean(settledRef) }, 502)
  }

  // Drain the SSE stream into a single text answer
  const raw = await chatRes.text()
  let text = ''
  // Did the agent deliver anything of value (readable text/reasoning or a
  // completed tool call)? Same rule the chat route uses to gate its own
  // settle-before-serve refund (isDeliveredOutput) — a 200 stream can still
  // carry an `error` event and zero deltas (model failed after headers), and
  // that is NOT a delivered answer. Kept as the single source of truth so a
  // new delta type is classified identically on both paths.
  let delivered = false
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const evt = JSON.parse(line.slice(6))
      // The chat SSE vocabulary (lib/chat/events.ts) emits text as
      // { type: 'modelContentBlockDeltaEvent', textDelta } — there is no
      // 'text'/'text' event, so the old filter matched nothing and every
      // paid x402 call returned "(empty response)" after being charged.
      if (evt.type === 'modelContentBlockDeltaEvent' && typeof evt.textDelta === 'string') {
        text += evt.textDelta
      }
      if (isDeliveredOutput(evt)) delivered = true
    } catch { }
  }

  // Charged on-chain but the agent delivered NOTHING (200 stream that errored
  // mid-flight or produced an empty completion) → reverse the owner credit +
  // platform fee, exactly like the !chatRes.ok branch above. Without this the
  // payer loses USDC for an "(empty response)": the chat route's own
  // chargedRef refund is deliberately suppressed for x402 calls (they carry
  // x-tiny-x402-settled:1), so the relay is the ONLY place this can be undone.
  // A completed tool call with no final text still counts as delivered (real
  // work happened), so this can't be gamed by tool-only turns.
  if (settledRef && !delivered) {
    await durableWrite(`${WORKER}/pay/refund`, { ref: settledRef }, 'refund')
    return json({
      tiny: slug,
      error: 'agent returned an empty response — the charge was refunded',
      response: '',
      paid: false,
      refunded: true,
      ...(settledNetwork ? { network: settledNetwork } : {}),
      // The original settlement tx + link, so a caller can confirm both the
      // charge AND its on-chain refund reconcile against the same transfer.
      ...(settledTx ? { tx_hash: settledTx } : {}),
      ...(explorerTxUrl(settledNetwork, settledTx) ? { explorer: explorerTxUrl(settledNetwork, settledTx) } : {}),
    }, 502)
  }

  return json({
    tiny: slug,
    response: text || '(empty response)',
    paid_micro: priceMicro,
    // The chain the settlement actually landed on (mainnet vs testnet) — a
    // paid caller needs it to reconcile; empty for free tinys (no settle).
    ...(settledNetwork ? { network: settledNetwork } : {}),
    // The settlement tx hash + a network-correct BaseScan link — the caller's
    // on-chain proof of payment. `network` names the chain; only the hash can
    // locate the transfer. Empty for free tinys / a hashless settle.
    ...(settledTx ? { tx_hash: settledTx } : {}),
    ...(explorerTxUrl(settledNetwork, settledTx) ? { explorer: explorerTxUrl(settledNetwork, settledTx) } : {}),
    // Also surface the settlement in the STANDARD x402 header, so a third-party
    // payer that reads only X-PAYMENT-RESPONSE (per spec) gets the same proof.
  }, 200, paymentResponseHeader(settledTx, settledNetwork, settledPayer))
}

/** GET — service discovery: price + how to pay (Bazaar-crawlable). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // Discovery is Bazaar-crawlable, so every answer carries an explicit
  // Cache-Control. Without it a CDN/crawler may heuristically cache a transient
  // 404/502 (or a stale 200) on a header-less response — the exact failure the
  // status codes below fail CLOSED against, reopened for the cache window. Same
  // discipline as app/api/erc8004/registration/[slug]/route.ts: no-store on any
  // non-200, and cache the complete 200 only briefly. A crawler that cached a
  // free:true doc for a not-yet-created tiny would otherwise keep POSTing it and
  // getting 404 long after the tiny goes live.
  const nostore = { 'Cache-Control': 'no-store' }
  const { slug: rawSlug } = await params
  const slug = String(rawSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)
  if (!slug) return json({ error: 'invalid tiny name' }, 400, nostore)

  // Resolve tiny + price in parallel, mirroring POST — discovery MUST honor the
  // same existence + privacy gating POST enforces. Both resolve to null (not {})
  // on transport failure / non-2xx so a worker blip is distinguishable from a
  // genuine answer; the r.ok gate is load-bearing on both.
  const [tiny, pricing] = await Promise.all([
    fetch(`${WORKER}/get?name=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${WORKER}/pay/pricing?resource=${encodeURIComponent(`tiny:${slug}`)}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  // A null tiny is an upstream failure, not a missing tiny — 404 here would make
  // an outage indistinguishable from "never created".
  if (tiny === null) return json({ error: 'lookup failed, retry' }, 502, nostore)
  if (!tiny?.name || tiny.response === 'tiny.technology is not exists') {
    // Don't advertise a service that doesn't exist — a crawler caching a
    // free:true doc for a missing tiny then POSTs it and gets 404 forever.
    return json({ error: `tiny '${slug}' not found` }, 404, nostore)
  }
  // A private tiny is walled off from x402 by POST (403). Discovery must not leak
  // its existence, price, or how-to-pay — otherwise the discovery endpoint
  // undoes the privacy the POST path enforces.
  if (tiny.private) return json({ error: `tiny '${slug}' is private` }, 403, nostore)

  // Fail CLOSED on a pricing-lookup blip, exactly like POST above. The r.ok gate
  // is load-bearing: without it a worker HTTP-error carrying a JSON body (503
  // {"error":…}) resolves non-null → price 0 → this discovery doc advertises a
  // PAID tiny as `free`. A Bazaar crawler that caches "free" then hammers the
  // endpoint with unpaid calls (all 402), and the owner's service reads as free
  // in the marketplace. A retryable 502 is the only safe answer.
  if (pricing === null) return json({ error: 'pricing lookup failed, retry' }, 502, nostore)
  const priceMicro = Number(pricing?.price_micro || 0)
  // Same integer-micro guard as POST: a NaN/fractional/negative price must not be
  // advertised (a "1.5" price_micro_usdc no standard client can pay, or a NaN
  // that JSON.stringifies to null while free:false stays false). Fail CLOSED to a
  // retryable 502, never a malformed cacheable doc.
  if (!Number.isInteger(priceMicro) || priceMicro < 0) return json({ error: 'pricing lookup failed, retry' }, 502, nostore)
  // Fail CLOSED when a PAID tiny has no receiving address configured — the exact
  // guard POST enforces (424 "x402 payments not configured", :246) and the
  // ERC-8004 registration doc mirrors. Without it, an X402_PAY_TO-less deployment
  // advertises a cacheable 200 {free:false, price>0} for a service every POST
  // 424s — the advertise-vs-demand drift the two sibling routes were hardened
  // against. Mirror their 424 (not the pricing-blip 502 — an unset env won't
  // resolve on retry) so a crawler never caches a payable claim we can't honor.
  if (priceMicro > 0 && !process.env.X402_PAY_TO) {
    return json({ error: 'x402 payments not configured on this deployment' }, 424, nostore)
  }
  // Same for a deployment with no facilitator able to settle the chain it
  // offers (lib/x402/facilitator.ts): POST 424s such a request, so advertising
  // a cacheable payable doc here would be the identical advertise-vs-demand
  // drift the payTo guard above exists to prevent — a Bazaar crawler caching
  // "payable on eip155:<our chain>" for a door that never settles.
  if (priceMicro > 0 && !facilitatorUrl()) {
    return json({ error: 'x402 payments not configured on this deployment' }, 424, nostore)
  }
  // Only THIS path — a complete, existence+privacy+pricing+payTo-verified doc — is
  // cacheable, and only briefly so a price change or newly-private tiny
  // propagates within 5min. Every other return above is no-store.
  return json({
    service: `tiny.technology/${slug}`,
    type: 'x402-chat',
    method: 'POST',
    body: { message: 'string' },
    price_micro_usdc: priceMicro,
    // Advertise ONLY the network this deployment actually settles on — same
    // set POST's paymentRequirements offers. Advertising base-sepolia on a
    // mainnet deployment (or vice-versa) would tell a crawler to pay a door
    // POST now rejects ('unsupported network'), the advertise-vs-demand drift
    // this route is otherwise careful to avoid.
    networks: Object.fromEntries(
      offeredNetworks().map(n => [n, { caip2: NETWORKS[n].caip2, asset: NETWORKS[n].usdc }])
    ),
    free: priceMicro === 0,
  }, 200, { 'Cache-Control': 'public, max-age=300' })
}
