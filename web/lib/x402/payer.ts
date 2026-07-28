/**
 * 🤝 x402 PAYER — pure logic for paying another agent's x402 service.
 *
 * The signing half (EIP-3009 with the platform hot wallet) lives in the Node
 * route app/api/x402/pay/route.ts; everything HERE is deterministic and
 * key-free so it can be unit-tested exhaustively:
 *   - parse a 402 challenge (PaymentRequirements) into typed accepts[]
 *   - pick the accepts[] entry we can pay (network we support + within caps)
 *   - build the authorization object + EIP-712 typed data for signing
 *   - encode the X-PAYMENT header (base64 of the payment payload JSON)
 *
 * We EMIT and MATCH on CAIP-2 network strings (eip155:<chainId>) — the same
 * canonical form the receiver route uses (scheme_exact_evm.md). See
 * canonicalNetwork() in the receiver for the folding rules.
 */
import { usd } from '../utils'
import { tinyChainConfig, tinyExplorerTxUrl } from './tiny-chain'

/**
 * Networks the payer can sign for — mirrors the receiver's NETWORKS
 * (app/api/x402/chat/[slug]:37). `domainName` is the USDC EIP-712 domain `name`
 * for that chain, which becomes the TransferWithAuthorization domain we SIGN
 * (buildTypedData). It is per-network on purpose: Base mainnet USDC's on-chain
 * domain name is "USD Coin", Base Sepolia's is "USDC" — the SAME split the
 * receiver's NETWORKS.label carries and emits as accept.extra.name. A compliant
 * challenge supplies extra.name and we sign that; but when a service OMITS it,
 * the fallback must match the chain's real domain, not a single hardcoded value
 * — a domain-name mismatch makes the facilitator reject the signature.
 */
const TINY = tinyChainConfig()
export const PAYER_NETWORKS: Record<string, { short: string; chainId: number; usdc: string; domainName: string }> = {
  'eip155:8453': { short: 'base', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', domainName: 'USD Coin' },
  'eip155:84532': { short: 'base-sepolia', chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', domainName: 'USDC' },
  // Self-hosted tiny-chain (lib/x402/tiny-chain.ts) — present only when the
  // deployment configures it, so the table stays exactly the two Base chains
  // everywhere else. TinyUSDC's EIP-712 domain is USDC/2 by construction
  // (chain/contracts/TinyUSDC.sol).
  ...(TINY ? { [TINY.caip2]: { short: TINY.short, chainId: TINY.chainId, usdc: TINY.usdc, domainName: TINY.domainName } } : {}),
}

export type PayerNetwork = keyof typeof PAYER_NETWORKS

/** Fold any network string a challenge might use onto canonical CAIP-2. */
export function canonicalNetwork(n: string): string {
  const s = String(n || '').toLowerCase().trim()
  if (s === 'base' || s === 'eip155:8453' || s === '8453') return 'eip155:8453'
  if (s === 'base-sepolia' || s === 'base_sepolia' || s === 'sepolia' || s === 'eip155:84532' || s === '84532') return 'eip155:84532'
  if (TINY && (s === 'tiny' || s === TINY.caip2 || s === String(TINY.chainId))) return TINY.caip2
  return s
}

/**
 * Is `asset` the USDC contract we expect on `network`? The payer signs an
 * EIP-3009 TransferWithAuthorization whose `verifyingContract` is the accept's
 * asset — so the asset is the TOKEN the hot wallet actually authorizes moving.
 * We only front USDC; a challenge that names a supported network but a
 * DIFFERENT token contract (a buggy/compromised allowlisted host, or a service
 * offering USDC alongside another token) must never make us sign a transfer of
 * some other asset we happen to hold. Address compare is case-insensitive
 * (EIP-55 checksums vary), and empty/garbage asset strings fail closed.
 */
export function isExpectedUsdc(network: string, asset: string): boolean {
  const net = canonicalNetwork(network) as PayerNetwork
  const expected = PAYER_NETWORKS[net]?.usdc
  if (!expected) return false
  return String(asset || '').toLowerCase() === expected.toLowerCase()
}

/**
 * Pull the on-chain settlement tx hash out of the base64-JSON X-PAYMENT-RESPONSE
 * header an x402 service returns after settling (x402 SettleResponse
 * { success, transaction, network, payer }). Tolerates a missing/malformed
 * header and validates the shape — returns '' so no explorer link is emitted
 * for a bogus value, never throws.
 */
export function parseSettlementTx(header: string | null | undefined): string {
  if (!header) return ''
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const tx = decoded?.transaction || decoded?.txHash || ''
    return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : ''
  } catch { return '' }
}

/**
 * Fallback source for the settlement tx hash: tiny's OWN inbound receiver
 * (app/api/x402/chat/[slug]) returns the on-chain hash as `tx_hash` in its JSON
 * BODY and never sets the standard X-PAYMENT-RESPONSE header — so a same-platform
 * agent-to-agent payment (the default allowlist is tiny's own hosts only) would
 * otherwise drop the "View on BaseScan" proof link. Pull `tx_hash` out of the
 * already-parsed response body with the SAME 0x…64 validation as the header
 * path, so a bogus value yields no link. Only consulted for first-party hosts —
 * a third party must speak the x402 standard (the header), not a tiny-specific
 * body field, so this opens no new trust surface. Returns '' on any miss.
 */
export function settlementTxFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const tx = (body as { tx_hash?: unknown }).tx_hash
  return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : ''
}

/**
 * BaseScan URL for a settlement tx, host chosen by the CAIP-2 network WE signed
 * for (never a service-supplied value) — eip155:84532 → sepolia.basescan.org,
 * eip155:8453 → basescan.org. Returns '' for an unknown network or absent hash
 * so a wrong-chain link is never produced. Mirrors the withdraw route + the
 * inbound x402/chat receipt.
 */
export function explorerTxUrl(caip2: string, txHash: string): string {
  if (!txHash) return ''
  if (caip2 === 'eip155:84532') return `https://sepolia.basescan.org/tx/${txHash}`
  if (caip2 === 'eip155:8453') return `https://basescan.org/tx/${txHash}`
  if (TINY && caip2 === TINY.caip2) return tinyExplorerTxUrl(txHash)
  return ''
}

/**
 * The price (in micro-USDC) a PUBLIC DISCOVERY surface may advertise for a tiny.
 *
 * `/pay/pricing` is the public, unauthenticated pricing endpoint — it returns a
 * price REGARDLESS of whether the tiny is private. But every x402 payment door
 * 403s a private tiny: the inbound receiver (POST + GET discovery,
 * app/api/x402/chat/[slug]) and the ERC-8004 registration file all reject it.
 * So any crawlable surface that advertises a private tiny's price + payability
 * (JSON-LD offers, the OG share card, structured discovery) lures a paying
 * agent into a guaranteed 403 — the advertise-vs-charge mismatch this whole arc
 * closes everywhere else. The single rule, in one place: a private tiny
 * advertises NO price (0). A public tiny advertises its real, floored,
 * non-negative micro price (a NaN/absent/blip read → 0 = free, never negative).
 *
 * Returns micro-USDC (integer domain); callers divide by 1e6 for dollars. Use
 * `> 0` on the result to gate any "payable via x402" copy — that's true only for
 * a public, genuinely-priced tiny.
 */
export function advertisablePriceMicro(priceMicro: unknown, isPrivate: boolean): number {
  if (isPrivate) return 0
  return Math.max(0, Number(priceMicro) || 0)
}

export interface Accept {
  scheme: string
  network: string          // canonicalized to CAIP-2 by parseChallenge
  maxAmountRequired: string // micro-USDC, string per spec
  payTo: string
  asset: string
  resource?: string
  description?: string
  maxTimeoutSeconds?: number
  extra?: { name?: string; version?: string }
}

export interface Challenge {
  x402Version: number
  accepts: Accept[]
  error?: string
}

/** Parse a raw 402 body into a typed Challenge (network canonicalized). */
export function parseChallenge(body: any): Challenge | null {
  if (!body || !Array.isArray(body.accepts) || body.accepts.length === 0) return null
  const accepts: Accept[] = body.accepts
    .filter((a: any) => a && a.scheme === 'exact' && a.payTo && a.asset)
    .map((a: any) => ({
      scheme: String(a.scheme),
      network: canonicalNetwork(a.network),
      maxAmountRequired: String(a.maxAmountRequired ?? '0'),
      payTo: String(a.payTo),
      asset: String(a.asset),
      resource: a.resource ? String(a.resource) : undefined,
      description: a.description ? String(a.description) : undefined,
      maxTimeoutSeconds: Number.isFinite(Number(a.maxTimeoutSeconds)) ? Number(a.maxTimeoutSeconds) : undefined,
      extra: a.extra && typeof a.extra === 'object'
        ? { name: a.extra.name ? String(a.extra.name) : undefined, version: a.extra.version ? String(a.extra.version) : undefined }
        : undefined,
    }))
  if (!accepts.length) return null
  return { x402Version: Number(body.x402Version) || 1, accepts }
}

/**
 * Choose the accepts[] entry to pay: a network we can sign for, whose price is
 * within `maxSpendMicro`. Prefers mainnet over testnet (real settlement) when
 * both are offered and affordable. Returns { accept } or a typed reason so the
 * caller can surface a precise error to the agent.
 *
 * `offeredNet` — when set, restricts selection to the ONE network THIS
 * deployment can actually settle on. The platform hot wallet + the whole
 * balance economy live on a single chain per deployment (PAYMENTS_TESTNET=1 →
 * base-sepolia, else base — the same invariant the INBOUND receiver enforces
 * via offeredNetworks(), commit bd48d8a0). Without this bound, a third-party
 * service offering BOTH networks makes the mainnet-preference below pick base
 * even on a testnet deployment — so we'd sign a MAINNET EIP-3009 authorization
 * the testnet-funded hot wallet can't back, AFTER /pay/spend already reserved
 * the user's balance: the settle fails, the reservation may hang, and the user
 * sees a doomed payment. Restricting here is the OUTBOUND mirror of the receiver
 * fix. Omitted (undefined) → the original both-networks, mainnet-first behavior
 * (keeps the pure unit tests + any caller that doesn't yet gate unchanged).
 */
export function selectAccept(
  challenge: Challenge, maxSpendMicro: number, offeredNet?: PayerNetwork
): { accept: Accept; network: PayerNetwork } | { error: string; needMicro?: number } {
  const onSupportedNet = challenge.accepts
    .map((a) => ({ a, net: a.network as PayerNetwork }))
    .filter(({ net }) => net in PAYER_NETWORKS)
    // Bind to the deployment's settleable network when the caller passed one.
    .filter(({ net }) => !offeredNet || net === offeredNet)
  if (!onSupportedNet.length) {
    // Distinguish "we settle a network the service doesn't offer" from "the
    // service named only networks we don't support at all" — the former is a
    // deployment-vs-service mismatch the user can't fix by topping up, and the
    // precise reason helps the agent explain it rather than blame the wallet.
    if (offeredNet && challenge.accepts.some(a => (a.network as PayerNetwork) in PAYER_NETWORKS)) {
      return { error: `this service doesn't accept payment on ${PAYER_NETWORKS[offeredNet].short}, the only network this deployment can settle` }
    }
    return { error: `service only accepts unsupported networks: ${challenge.accepts.map(a => a.network).join(', ')}` }
  }
  // The asset is the TOKEN we authorize moving (it becomes the EIP-712
  // verifyingContract we sign). We front USDC only — an accept on a supported
  // network but a non-USDC contract must never be selected, or the hot wallet
  // would sign a transfer of some other asset it holds up to the spend cap.
  // Filter here so a USDC-alongside-other-token offer still pays via the USDC
  // entry, and a USDC-only-wrong-address offer fails with a precise reason.
  const supported = onSupportedNet.filter(({ a, net }) => isExpectedUsdc(net, a.asset))
  if (!supported.length) {
    return { error: `service does not offer USDC on a supported network (assets: ${onSupportedNet.map(({ a }) => a.asset).join(', ')}); cannot pay` }
  }
  // Mainnet first, then testnet — deterministic, real money preferred.
  supported.sort((x, y) => (x.net === 'eip155:8453' ? -1 : 1) - (y.net === 'eip155:8453' ? -1 : 1))
  // The price MUST be a canonical integer micro-USDC string — the exact contract
  // decodeQuote enforces at execute time (/^\d+$/). If we selected a fractional
  // ("1.5"), scientific ("1e4"), hex ("0x2710"), or padded ("  5000 ") amount
  // here, we'd mint a signed quote that decodeQuote later rejects as "tampered"
  // — a dead-end at the user's Approve tap for a quote nothing tampered with.
  // Reject a malformed price up front, with a precise reason, so it never mints.
  // A canonical micro price is a POSITIVE integer string. "0" passes /^\d+$/ and
  // 0 <= cap, so without the amt > 0 floor a $0 (or amount-absent, which
  // parseChallenge defaults to "0") accept would mint a valid quote → the card
  // renders a nonsensical "Approve $0.00", and on tap the worker rejects
  // amount_micro:0 with a 400 that is NOT insufficient_balance → the route trips
  // its x402pay-reconcile earnings-loss marker for a payment that never reserved
  // and never could move USDC. Reject non-positive up front, same as a malformed
  // price, so it never mints.
  const isCanonicalMicro = (s: string) => /^\d+$/.test(s) && Number(s) > 0
  const affordableAll = supported.filter(({ a }) => {
    const raw = a.maxAmountRequired
    if (!isCanonicalMicro(raw)) return false
    const amt = Number(raw)
    return Number.isFinite(amt) && amt <= maxSpendMicro
  })
  // `supported` is sorted mainnet-first (real USDC preferred over trial testnet —
  // the two tiers are NOT price-comparable), so the first affordable entry's
  // network is the tier we want. Within that tier pick the CHEAPEST offer: a
  // service listing several USDC prices for one resource must never make us
  // quote (and the user approve) more than necessary. `.find` took array-order
  // first, which need not be the cheapest.
  const affordable = affordableAll
    .filter(({ net }) => net === affordableAll[0]?.net)
    .sort((x, y) => Number(x.a.maxAmountRequired) - Number(y.a.maxAmountRequired))[0]
  if (!affordable) {
    // Distinguish "priced in a form we can't sign" from "genuinely too expensive"
    // — otherwise a "1.5" offer reads as a cap problem the user can't fix by
    // topping up. Only positive-integer-priced offers count toward the cheapest.
    const canonical = supported.filter(({ a }) => isCanonicalMicro(a.maxAmountRequired))
    if (!canonical.length) {
      return { error: `service quoted a non-integer micro-USDC price (${supported.map(({ a }) => a.maxAmountRequired).join(', ')}); cannot pay` }
    }
    const cheapest = Math.min(...canonical.map(({ a }) => Number(a.maxAmountRequired)))
    // Human-legible dollars in the PROSE (this string is surfaced to the user via
    // the pay_x402 tool → "x402 quote failed: …"), not raw micro-USDC integers —
    // the same Rule-B usd() treatment C101/C102 gave the chat + pay-route money
    // copy. needMicro stays a raw integer: it's the machine field the route echoes
    // as need_micro for a client to reason about, not display text.
    return { error: `cheapest offer is ${usd(cheapest)}, over your ${usd(maxSpendMicro)} cap`, needMicro: cheapest }
  }
  return { accept: affordable.a, network: affordable.net }
}

/**
 * Build the EIP-3009 authorization object. `nonce` is a 32-byte hex; caller
 * supplies it (crypto.randomUUID-derived or random bytes) so this stays pure.
 * validAfter/validBefore bound the signature's validity window.
 */
export function buildAuthorization(params: {
  from: string; to: string; valueMicro: string; nonce: string
  nowSec: number; validForSec: number
}) {
  const { from, to, valueMicro, nonce, nowSec, validForSec } = params
  return {
    from,
    to,
    value: String(valueMicro),
    // validAfter a touch in the past to tolerate clock skew between us and the
    // verifier; validBefore bounds how long the signed authorization is live.
    validAfter: String(Math.max(0, nowSec - 60)),
    validBefore: String(nowSec + Math.max(60, validForSec)),
    nonce,
  }
}

/**
 * The EIP-712 typed-data payload for USDC's TransferWithAuthorization
 * (EIP-3009). `name`/`version` come from the accept.extra (USDC domain), with
 * spec-correct defaults. This is exactly what the wallet signs.
 */
export function buildTypedData(accept: Accept, authorization: ReturnType<typeof buildAuthorization>) {
  const net = accept.network as PayerNetwork
  const chainId = PAYER_NETWORKS[net]?.chainId
  return {
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    domain: {
      // Prefer the challenge-supplied domain name; else fall back to the REAL
      // per-chain USDC domain name (Base "USD Coin" / Base Sepolia "USDC"),
      // never a single hardcoded value — signing the wrong domain name yields a
      // signature the facilitator rejects. Mirrors the receiver's NETWORKS table.
      name: accept.extra?.name || PAYER_NETWORKS[net]?.domainName || 'USD Coin',
      version: accept.extra?.version || '2',
      chainId,
      verifyingContract: accept.asset as `0x${string}`,
    },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  }
}

/**
 * Assemble the x402 payment payload and base64-encode it into the X-PAYMENT
 * header value. `b64` is injected (btoa in edge, Buffer in node) to keep this
 * runtime-agnostic and pure.
 */
export function encodePaymentHeader(
  accept: Accept,
  authorization: ReturnType<typeof buildAuthorization>,
  signature: string,
  x402Version: number,
  b64: (s: string) => string
): string {
  const payload = {
    x402Version: x402Version || 1,
    scheme: accept.scheme,
    network: accept.network, // CAIP-2 — matches what we selected
    payload: { signature, authorization },
  }
  return b64(JSON.stringify(payload))
}

/**
 * ✋ Confirm-every-payment: the QUOTE.
 *
 * A pay_x402 tool call must NOT move money — an autonomous agent could then
 * drain a wallet unattended. Instead the tool returns a signed QUOTE (payee,
 * amount, network, a hash of the message, the payer's session, an expiry).
 * Money moves only when a SEPARATE /api/x402/pay/execute call presents this
 * quote back — and only the user's explicit tap makes that call. The agent's
 * tool code cannot forge or replay a quote: the HMAC binds every field, so any
 * tampering (bump the amount, swap the payee) invalidates it.
 *
 * The quote is `<payloadB64>.<sigHex>` — payload is a compact JSON of the
 * bound fields; sig is HMAC-SHA256 over the payload bytes. Signing/verifying
 * the HMAC is injected (keeps this pure + runtime-agnostic + testable).
 *
 * SINGLE-USE: each quote carries a unique `jti`. The execute route feeds that
 * jti as the /pay/spend idempotency ref, so replaying ONE quote collides on
 * already_spent and settles once — while two DISTINCT quotes for the same
 * payee/price carry different jti and remain two separate payments.
 */
export interface QuoteFields {
  jti: string            // unique per-quote id — makes ONE approval settle ONCE
  sub: string            // payer session subject — a quote is spendable by ONE user
  url: string            // the exact target URL that was probed ('' for a transfer)
  payTo: string          // receiving address from the challenge; the recipient LOGIN for a transfer
  network: PayerNetwork  // CAIP-2 network we selected
  amountMicro: string    // price we will pay (micro-USDC)
  msgHash: string        // hash of the message body — binds intent, not the raw text
  maxSpendMicro: number  // the cap in force when quoted
  exp: number            // unix seconds; execute rejects an expired quote
  /**
   * Absent = the original x402 URL payment (every quote minted before this
   * field existed decodes unchanged). 'transfer' = an internal P2P ledger move
   * (make_payment tool): payTo is the recipient's login, url is unused, and
   * execute settles via the worker's atomic /pay/transfer instead of the
   * on-chain spend→sign→settle flow. Inside the HMAC like every other field —
   * a tampered kind can't reroute an approved x402 payment into a transfer
   * (or vice versa).
   */
  kind?: 'transfer'
}

/** Encode a quote as `<payloadB64>.<hmacHex>`. `b64`/`hmac` are injected. */
export function encodeQuote(
  fields: QuoteFields,
  b64: (s: string) => string,
  hmac: (payloadB64: string) => string
): string {
  const payloadB64 = b64(JSON.stringify(fields))
  return `${payloadB64}.${hmac(payloadB64)}`
}

/**
 * Verify + decode a quote token. Returns the bound fields ONLY when the HMAC
 * matches (via the injected constant-time `verify`) and the token is well
 * formed. Expiry is the caller's to check against the current clock (kept out
 * so this stays pure). Returns null on any tampering/parse failure.
 */
export function decodeQuote(
  token: string,
  unb64: (s: string) => string,
  verify: (payloadB64: string, sigHex: string) => boolean
): QuoteFields | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const sigHex = token.slice(dot + 1)
  if (!verify(payloadB64, sigHex)) return null
  let parsed: any
  try { parsed = JSON.parse(unb64(payloadB64)) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const f = parsed as QuoteFields
  // Shape guard: every bound field must be present and the right type, else the
  // downstream spend could run on a partially-attacker-controlled quote.
  if (typeof f.jti !== 'string' || !f.jti) return null
  if (typeof f.sub !== 'string' || !f.sub) return null
  // kind is either absent (x402 URL payment) or the literal 'transfer' — any
  // other value is a tampered/unknown quote class and must not decode into a
  // spendable object.
  if (f.kind !== undefined && f.kind !== 'transfer') return null
  // A transfer quote has no probed URL (payTo carries the recipient login);
  // an x402 quote must still bind the exact target it was minted for.
  if (f.kind !== 'transfer' && (typeof f.url !== 'string' || !f.url)) return null
  if (typeof f.payTo !== 'string' || !f.payTo) return null
  if (!(f.network in PAYER_NETWORKS)) return null
  if (typeof f.amountMicro !== 'string' || !/^\d+$/.test(f.amountMicro)) return null
  if (typeof f.msgHash !== 'string' || !f.msgHash) return null
  if (typeof f.maxSpendMicro !== 'number' || !Number.isFinite(f.maxSpendMicro)) return null
  if (typeof f.exp !== 'number' || !Number.isFinite(f.exp)) return null
  return f
}

/**
 * The spend cap in force for a (re-)quote, always the tightest of three:
 *   - the platform hard ceiling (never exceeded),
 *   - the per-request `max_spend_micro` the caller passed (can only LOWER it),
 *   - the cap bound in a PRIOR quote being re-minted (so the agent's original
 *     ceiling survives a "Get fresh quote" — see below).
 *
 * WHY THE PRIOR-QUOTE CAP MATTERS: an agent told "consult X, don't spend over
 * $2" passes max_spend_micro:2_000_000 on the FIRST quote. If that quote expires
 * (5-min TTL) and the user taps "Get fresh quote", the client re-POSTs to mint a
 * new one — but the model is not in that loop, so it can't re-supply the cap.
 * Without carrying it forward the re-quote silently reverts to the $25 platform
 * ceiling: were the service to have raised its price above $2 meanwhile, the user
 * would be shown an approval OVER the cap the agent was authorized to. Threading
 * the expired quote's own tamper-proof maxSpendMicro back in keeps the agent's
 * intent enforced across the re-quote. Monotonic by construction — every input is
 * only ever a floor via Math.min, so a prior cap can tighten but never RAISE the
 * ceiling (a replayed/forged prior quote can't widen spending; decodeQuote's HMAC
 * already gates authenticity, and this takes the min regardless).
 *
 * `perRequestMicro`/`priorCapMicro` are honored only when finite and > 0; a
 * missing/zero/NaN input leaves that floor at the platform ceiling.
 */
export function effectiveSpendCap(
  platformMaxMicro: number,
  perRequestMicro?: number,
  priorCapMicro?: number,
): number {
  const floors = [platformMaxMicro]
  for (const c of [perRequestMicro, priorCapMicro]) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) floors.push(Math.floor(c))
  }
  return Math.min(...floors)
}
