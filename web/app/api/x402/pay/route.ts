/**
 * 🤝 /api/x402/pay — first-party x402 PAYER (Node runtime).
 *
 * Lets a signed-in user's agent pay ANOTHER x402 service (agent-to-agent
 * commerce). The platform hot wallet fronts the USDC on-chain via an EIP-3009
 * transferWithAuthorization; the user's tiny-wallet ledger is debited to
 * reimburse it. This is the OUTBOUND mirror of /api/x402/chat (inbound).
 *
 * Custody decision: the PLATFORM hot wallet signs (same PAYOUT_PRIVATE_KEY as
 * withdrawals — one funded key, no per-user keys to manage). The user never
 * holds a key; their balance is the spend authority. So the invariant is:
 * DEBIT THE LEDGER BEFORE SIGNING. If we signed first and the ledger debit
 * failed, the platform would front USDC it can't recover.
 *
 * Flow:
 *   1. Session auth. Fetch the target's 402 challenge (GET or a probe POST).
 *   2. selectAccept() within the per-request + platform spend caps.
 *   3. /pay/spend — atomic guarded ledger debit (reserves funds). 402 if short.
 *   4. Sign EIP-3009 with the hot wallet → X-PAYMENT header.
 *   5. Retry the target with X-PAYMENT. On our-side failure BEFORE the retry
 *      (signing throws), /pay/spend-reverse (no USDC moved). Once the signed
 *      header leaves us we do NOT auto-reverse (the payee may have settled) —
 *      mirror of the withdraw "txHash gates the refund" rule.
 *
 * Security:
 *   - maxSpend is clamped server-side; the caller can only LOWER it.
 *   - Only same-origin tiny.technology x402 URLs OR an allowlisted host set can
 *     be paid, to stop the agent being tricked into paying an attacker's URL
 *     with the user's balance. (SSRF / fund-redirect guard.)
 *   - PAYOUT_PRIVATE_KEY must not be a PUBLISHED dev key (payerKeyRefusal). It
 *     both fronts the USDC and — via quoteSecret()'s fallback — keys the
 *     confirm-every-payment HMAC, so an anvil key here makes approvals forgeable,
 *     not merely the float stealable.
 */
import { getSession } from '@/lib/auth'
import { createHmac, timingSafeEqual } from 'node:crypto'
// We sign the EIP-3009 authorization OFF-CHAIN (privateKeyToAccount +
// account.signTypedData, with the chainId baked into the typed data from the
// selected accept) — there's no wallet client and no on-chain send here, so
// viem's createWalletClient/http + the base/baseSepolia chain objects were
// imported but never used. Dropped them (dead imports).
import { privateKeyToAccount } from 'viem/accounts'
import { isWellKnownKey, devKeysAllowed, devKeyRefusal } from '@/chain/dev-keys.mjs'
import { NOT_SETTLED, safeToRefund, settleOutcome, settlementHash } from '@/chain/settle-outcome.mjs'
import {
  parseChallenge, selectAccept, buildAuthorization, buildTypedData,
  encodePaymentHeader, encodeQuote, decodeQuote, isExpectedUsdc, PAYER_NETWORKS,
  parseSettlementTx, settlementTxFromBody, explorerTxUrl, effectiveSpendCap,
  type PayerNetwork, type QuoteFields,
} from '@/lib/x402/payer'
import { usd } from '@/lib/utils'
import { asNetwork, quoteSummary } from '@/lib/x402/top-up'
import { tinyChainConfig, paymentsNetwork } from '@/lib/x402/tiny-chain'

export const runtime = 'nodejs'
// The execute (PUT) path runs SEQUENTIAL internal timeouts that must all fit
// under this budget WITH headroom, or the platform hard-kills the function
// before the graceful path can run: re-probe (30s) → sign → paid fetch (90s) →
// reconcile-log + 202 return. At the old 120s, 30+90 alone consumed the entire
// budget, so the /pay/spend reserve + signing pushed the money-critical 90s
// paid-fetch timeout PAST the kill line — the reconcile marker (the only trail
// an out-of-band sweep has to a committed-but-unsettled reservation) never got
// logged and the 202 pending receipt never returned. 180 leaves ~45s of
// headroom above the 30+90 internal ceiling for the spend reserve, signing,
// JSON parsing, and the reverse call. (Siblings: chat + inbound x402/chat use
// 300; withdraw uses 60 against a 45s receipt wait.)
export const maxDuration = 180

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
// Hard ceiling for a single first-party payment regardless of what the caller
// asks — the worker enforces its own SPEND_MAX_MICRO too (defense in depth).
const PLATFORM_MAX_SPEND_MICRO = 25_000_000 // $25 / payment
// 🧪→💵 The ONE network this deployment's hot wallet + ledger settle on —
// PAYMENTS_TESTNET=1 → base-sepolia, else base. The SAME single-network
// selector the INBOUND receiver uses (offeredNetworks(), commit bd48d8a0) and
// deposits.ts uses for the balance economy. We sign off-chain (account
// .signTypedData with the chainId baked from the accept), so the ONLY thing
// steering which chain we authorize on is selectAccept's pick — pass this so a
// dual-network service can't make us sign a mainnet transfer the testnet wallet
// can't back (or vice-versa) after the ledger already reserved the funds.
const offeredPayerNetwork = (): PayerNetwork => {
  const net = paymentsNetwork()
  if (net === 'tiny') return tinyChainConfig()!.caip2
  return net === 'base-sepolia' ? 'eip155:84532' : 'eip155:8453'
}
// A signed quote is short-lived: long enough for the user to read + tap,
// short enough that a stale price/challenge can't be executed much later.
const QUOTE_TTL_SEC = 300 // 5 min

// ── Quote HMAC (confirm-every-payment) ───────────────────────────────────────
// The quote secret keys the payment-intent token the agent hands back to the
// UI. Falls back to the payout key material so a deployment that already signs
// withdrawals can mint quotes without a new secret; prefer an explicit
// X402_QUOTE_SECRET. Never the raw private key on the wire — it's HMAC input.
const quoteSecret = () => process.env.X402_QUOTE_SECRET || process.env.PAYOUT_PRIVATE_KEY || ''
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')
const quoteHmac = (payloadB64: string) => createHmac('sha256', quoteSecret()).update(payloadB64).digest('hex')
const quoteVerify = (payloadB64: string, sigHex: string) => {
  const expected = quoteHmac(payloadB64)
  if (expected.length !== sigHex.length) return false
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(sigHex)) } catch { return false }
}

/** Stable hash of the message body — binds a quote to the intent it was made
 *  for, without carrying the (possibly long) raw text in the token. */
const hashMessage = (msg: string) => createHmac('sha256', 'x402-quote-msg').update(msg).digest('hex').slice(0, 32)

/**
 * 🔑 Is PAYOUT_PRIVATE_KEY usable as the payer? Returns null when yes, or the
 * (log-only) reason when no — ONE gate both verbs must pass, so the next entry
 * point added here can't be the one that forgets a check.
 *
 * The dev-key half is the same refusal `wallet/withdraw` and the faucet's
 * `mintReserve` already make, arriving late because that sweep found the two
 * routes that send a transaction and this one signs OFF-chain (no
 * createWalletClient, so it didn't match the grep). Two distinct harms here,
 * and the second is worse than the first:
 *
 *   1. The hot wallet fronts the USDC. Its key being published means anyone can
 *      drain the float — while the user's ledger is still debited to reimburse a
 *      payment that will bounce for insufficient funds.
 *   2. `quoteSecret()` falls back to PAYOUT_PRIVATE_KEY, so a PUBLISHED key
 *      makes the confirm-every-payment HMAC key public too. Every field the
 *      quote binds — payee, amount, network, message intent, payer, expiry — is
 *      then forgeable, which collapses the whole invariant this route is built
 *      on: that money moves only on the user's explicit tap. An agent carrying a
 *      prompt injection could mint its own approved quote for any allowlisted
 *      payee and execute it. A wallet nobody can steal from still has this hole.
 *
 * @param env injectable so a test can ask about a different deployment (and so
 *   the opt-in grant chain/'s scratch-anvil scripts set process-wide can't leak
 *   into one) — same reason `devKeysAllowed` takes one.
 */
export function payerKeyRefusal(pk: string, env: Record<string, string | undefined> = process.env): string | null {
  // Dev-key check BEFORE the format check, deliberately. The realistic way one
  // of these arrives is pasted into a dashboard env field with a stray newline,
  // which fails the hex regex — so a format-first order refuses correctly but
  // reports "no key configured" for the one case an operator most needs named.
  // (isWellKnownKey trims and lowercases; the regex can't.)
  if (isWellKnownKey(pk) && !devKeysAllowed(env)) {
    return devKeyRefusal('the x402 payer hot wallet (which also keys the payment-quote HMAC)', pk)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(pk || ''))) return 'no PAYOUT_PRIVATE_KEY configured'
  return null
}

/**
 * …and what the CALLER is told: nothing about which. "Unconfigured" and
 * "configured with a key anyone can sign with" are the same fact to a client —
 * this deployment cannot pay — and naming the anvil account over HTTP would
 * hand an attacker the confirmation that the quote HMAC is forgeable here.
 */
const PAYER_UNCONFIGURED = 'x402 payments not configured on this deployment'

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ikey = () => ({ 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' })

/**
 * Only pay hosts we trust. tiny.technology's own x402 endpoints are always
 * allowed; extend via X402_PAY_ALLOWLIST (comma-separated hostnames). Prevents
 * an injected prompt from directing the user's balance to an attacker URL.
 * NOTE: this vets the pre-redirect host only — every fetch of this URL MUST use
 * redirect:'error' so an allowlisted host can't 3xx the request (and any signed
 * X-PAYMENT header) onto an unvetted origin.
 */
export function isPayableUrl(raw: string): URL | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  const allow = new Set(
    ['tiny.technology', 'plugin.tiny.technology']
      .concat(String(process.env.X402_PAY_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  )
  return allow.has(host) ? u : null
}

/**
 * Is this one of tiny's OWN x402 receivers? Only our receiver contractually
 * 402s *before* settlement, so only for these hosts is "the target answered
 * 402 after we sent X-PAYMENT" proof that no USDC moved (→ safe to reverse the
 * reservation). A third-party allowlisted host could settle on-chain AND
 * answer 402, so we must NOT auto-reverse for those (mirror of the "once the
 * signed header leaves, never auto-reverse" invariant).
 */
function isFirstPartyHost(u: URL): boolean {
  const host = u.hostname.toLowerCase()
  return host === 'tiny.technology' || host === 'plugin.tiny.technology'
}

/**
 * Read the settlement verdict out of a FIRST-PARTY 402 body.
 *
 * Only ever called for a first-party host, and that scoping is the safety
 * argument: we trust this field because we wrote the code that emits it
 * (app/api/x402/chat/[slug] — it forwards the facilitator's own verdict). A
 * third-party 402 is never auto-reversed at all, so a hostile service cannot
 * reach `safeToRefund` by claiming `settlement: not_settled`.
 *
 * A body we can't parse — or one from an older receiver with no `settlement`
 * field — yields `{}`, which classifies as not_settled: the pre-existing
 * behaviour for first-party 402s, preserved so a deploy-order skew (payer new,
 * receiver old) keeps refunding genuinely-rejected payments instead of parking
 * them all as pending. The receiver is the half that must ship first for the
 * unknown case to be reported at all.
 */
export function firstPartySettlement(bodyText: string): any {
  try {
    const parsed = JSON.parse(bodyText)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 💸 P2P transfer target — the make_payment tool posts `to: "@login"`; the
 * clients' re-quote paths post the SAME target back through their existing
 * url plumbing as the `transfer:@login` sentinel (so no client grew a second
 * re-quote body shape). Returns the bare validated login, or null when this
 * request isn't a transfer. GitHub login rules — alphanumeric + hyphens,
 * ≤39 chars — the same gate the worker's /profile applies.
 */
export function parseTransferTarget(body: any): string | null {
  const raw = typeof body?.to === 'string' && body.to
    ? String(body.to)
    : typeof body?.url === 'string' && body.url.startsWith('transfer:')
      ? body.url.slice('transfer:'.length)
      : ''
  const login = raw.trim().replace(/^@/, '')
  return /^[a-zA-Z0-9-]{1,39}$/.test(login) ? login : null
}

/** A 32-byte random hex nonce for the EIP-3009 authorization. */
function randomNonce(): `0x${string}` {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return ('0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

/**
 * The reservation ref for /pay/spend — MUST be unique per payment attempt, NOT
 * deterministic on the payment parameters. Two legitimate consults to the same
 * payee for the same price are two DISTINCT payments: each signs a fresh
 * EIP-3009 nonce, so the facilitator settles USDC on-chain BOTH times. A
 * deterministic ref would make /pay/spend return already_spent on the 2nd call
 * → the ledger debits once while the platform fronts USDC twice (guaranteed
 * platform loss).
 *
 * Retry-safety for a SINGLE logical payment is opt-in: a caller that may
 * re-issue the same request (e.g. after a dropped response) passes a stable
 * `idempotencyKey`; a replay then reuses the reservation instead of paying
 * again. Absent one, `randomToken()` makes every call a new payment.
 */
export function buildSpendRef(args: {
  sub: string; network: string; payTo: string; amountMicro: string
  idempotencyKey?: string; randomToken: () => string
}): string {
  const idem = String(args.idempotencyKey || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  const token = idem || args.randomToken()
  return `x402pay:${args.sub}:${args.network}:${args.payTo}:${args.amountMicro}:${token}`
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  // Refuse at QUOTE time, not just at execute: a quote is a promise the UI
  // renders as an approval card, and minting one this deployment can never
  // honor spends the user's attention on a payment that 424s after the tap.
  const pk = process.env.PAYOUT_PRIVATE_KEY || ''
  const refusal = payerKeyRefusal(pk)
  if (refusal) {
    console.error(`[x402/pay] ${refusal}`)
    return json({ ok: false, error: PAYER_UNCONFIGURED }, 424)
  }

  const body = await req.json().catch(() => ({} as any))
  const message = String(body.message || body.prompt || '').slice(0, 8000)
  // Carry the agent's ORIGINAL cap through a re-quote. When a quote expires (or
  // its terms change) the client re-POSTs to mint a fresh one via "Get fresh
  // quote" — but the model isn't in that loop, so it can't re-supply
  // max_spend_micro. If the caller hands back the prior (expired) quote token, we
  // decode it (HMAC-verified, so the cap can't be forged) and — only when it
  // belongs to THIS session — reuse its bound maxSpendMicro. effectiveSpendCap
  // takes the MIN of platform ceiling + per-request + prior cap, so this can only
  // ever TIGHTEN spending, never widen it (a replayed/forged token can't raise
  // the ceiling). Without this, a re-quote silently reverts to the $25 platform
  // max and could show the user an approval over the agent's authorized cap.
  const prior = body.prior_quote ? decodeQuote(String(body.prior_quote), unb64, quoteVerify) : null
  const priorCap = prior && prior.sub === session.sub ? prior.maxSpendMicro : undefined
  // Per-request cap: the caller can only tighten the platform ceiling.
  const maxSpendMicro = effectiveSpendCap(PLATFORM_MAX_SPEND_MICRO, Number(body.max_spend_micro), priorCap)

  // 💸 P2P transfer mint (make_payment tool + client re-quotes of a transfer
  // quote) — no URL, no 402 probe, no on-chain leg; still confirm-every-payment.
  const transferLogin = parseTransferTarget(body)
  if (transferLogin) {
    return mintTransferQuote({ session, login: transferLogin, body, prior, maxSpendMicro, message })
  }

  const target = isPayableUrl(String(body.url || ''))
  if (!target) return json({ ok: false, error: 'url must be an https x402 endpoint on an allowlisted host' }, 400)

  // 1. Probe for the 402 challenge. x402 servers answer the unpaid POST with
  //    402 + PaymentRequirements; a 200 means it's free (just relay it).
  //    redirect:'error' — isPayableUrl only vetted the PRE-redirect host, so a
  //    'follow' would let an allowlisted host 3xx us onto an arbitrary origin
  //    (SSRF from server egress). A real x402 endpoint answers 402/200 inline
  //    and never redirects, so a redirect here is a hard failure → 502.
  const probe = await fetch(target.toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }), signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  }).catch(() => null)
  if (!probe) return json({ ok: false, error: 'target unreachable' }, 502)

  if (probe.status !== 402) {
    // Free (or a non-payment error) — pass the body straight back.
    const txt = await probe.text()
    return json({ ok: probe.ok, paid_micro: 0, status: probe.status, response: safeJson(txt) }, probe.ok ? 200 : 502)
  }

  const challengeBody = await probe.json().catch(() => null)
  const challenge = parseChallenge(challengeBody)
  if (!challenge) return json({ ok: false, error: 'target returned a 402 we could not parse' }, 502)

  const picked = selectAccept(challenge, maxSpendMicro, offeredPayerNetwork())
  if ('error' in picked) {
    return json({ ok: false, error: picked.error, need_micro: picked.needMicro, max_spend_micro: maxSpendMicro }, 402)
  }
  const { accept, network } = picked
  const amountMicro = String(accept.maxAmountRequired)

  // ✋ CONFIRM-EVERY-PAYMENT. We do NOT spend here. An autonomous agent calls
  // this route, so moving money now would let it drain a wallet unattended.
  // Instead we return a signed QUOTE describing exactly what would be paid.
  // Money moves only when /api/x402/pay/execute is called back WITH this quote
  // — and only the user's explicit tap makes that call. The HMAC binds every
  // field (payee, amount, network, message intent, payer, expiry), so the
  // agent can neither forge a quote nor tamper one it was handed.
  if (!quoteSecret()) {
    return json({ ok: false, error: 'x402 payment quoting not configured on this deployment' }, 424)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const quoteFields: QuoteFields = {
    // Unique per quote → single-use at execute (see executePayment). Inside the
    // HMAC, so it's tamper-proof and an agent can't strip it to force a replay.
    jti: randomNonce().slice(2, 34),
    sub: session.sub, url: target.toString(), payTo: accept.payTo,
    network: network as PayerNetwork, amountMicro, msgHash: hashMessage(message),
    maxSpendMicro, exp: nowSec + QUOTE_TTL_SEC,
  }
  const quote = encodeQuote(quoteFields, b64, quoteHmac)
  return json({
    ok: true,
    // Not paid yet — this is a confirmation request, not a receipt.
    requires_confirmation: true,
    quote,
    price_micro: Number(amountMicro),
    network: PAYER_NETWORKS[network as PayerNetwork].short,
    payee: accept.payTo,
    expires_at: quoteFields.exp,
    description: accept.description || `Payment to ${accept.payTo}`,
    // A human-legible summary the agent can echo verbatim; the real approval is
    // the user tapping the receipt card the client renders from these fields.
    // quoteSummary names the KIND of money (trial credit vs real USDC) — the
    // agent echoes this sentence verbatim, so it's the one place the user is
    // told what approving actually spends before they tap.
    summary: quoteSummary(Number(amountMicro), asNetwork(PAYER_NETWORKS[network as PayerNetwork].short)),
  })
}

/**
 * 💸 Mint a P2P transfer quote (moves NO money — the confirm card's Approve
 * tap executes it via PUT). Mirrors the x402 mint's invariants with the
 * on-chain machinery removed: the HMAC binds recipient login, amount, payer,
 * message intent, and expiry; the amount rides amount_micro on the first mint
 * (the agent supplies it) and is recovered from the prior quote's HMAC-bound
 * amountMicro on a client re-quote (the card knows no amounts, only tokens).
 */
async function mintTransferQuote(args: {
  session: { sub: string; login?: string }
  login: string
  body: any
  prior: QuoteFields | null
  maxSpendMicro: number
  message: string
}): Promise<Response> {
  const { session, login, body, prior, maxSpendMicro, message } = args
  if (!quoteSecret()) {
    return json({ ok: false, error: 'payment quoting not configured on this deployment' }, 424)
  }

  const explicit = Math.floor(Number(body.amount_micro))
  const fromPrior = prior && prior.kind === 'transfer' && prior.sub === session.sub
    ? Number(prior.amountMicro) : NaN
  const amount = Number.isFinite(explicit) && explicit > 0 ? explicit : fromPrior
  if (!Number.isInteger(amount) || amount <= 0) {
    return json({ ok: false, error: 'amount_micro (positive integer micro-USDC) is required to send money' }, 400)
  }
  if (amount > maxSpendMicro) {
    return json({
      ok: false, error: `that send is over the ${usd(maxSpendMicro)} per-payment cap`,
      need_micro: amount, max_spend_micro: maxSpendMicro,
    }, 402)
  }
  if (session.login && session.login.toLowerCase() === login.toLowerCase()) {
    return json({ ok: false, error: "you can't send money to yourself" }, 400)
  }

  // Resolve the recipient NOW so the card names a real account — approving a
  // send to a typo should be impossible, not a 404 after the tap. /profile is
  // the worker's public by-login read (it exposes no raw ids; the worker
  // re-resolves the login at settle time).
  const prof: any = await fetch(`${WORKER_URL}/profile?login=${encodeURIComponent(login)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  if (!prof?.login) {
    return json({ ok: false, error: `no tiny account named @${login} — check the spelling` }, 404)
  }
  const canonical = String(prof.login)

  const network = offeredPayerNetwork()
  const short = PAYER_NETWORKS[network].short
  const nowSec = Math.floor(Date.now() / 1000)
  const quoteFields: QuoteFields = {
    jti: randomNonce().slice(2, 34),
    sub: session.sub, url: '', payTo: canonical,
    network, amountMicro: String(amount), msgHash: hashMessage(message),
    maxSpendMicro, exp: nowSec + QUOTE_TTL_SEC, kind: 'transfer',
  }
  const quote = encodeQuote(quoteFields, b64, quoteHmac)
  return json({
    ok: true,
    requires_confirmation: true,
    quote,
    price_micro: amount,
    network: short,
    payee: `@${canonical}`,
    expires_at: quoteFields.exp,
    transfer: true,
    // The canonical target — the make_payment tool copies this (as the
    // transfer: sentinel url) onto its result so every client's existing
    // re-quote plumbing round-trips it untouched.
    to: `@${canonical}`,
    description: `Send ${usd(amount)} to @${canonical}${prof.name && prof.name !== canonical ? ` (${prof.name})` : ''}`,
    summary: quoteSummary(amount, asNetwork(short)),
  })
}

/**
 * ✅ /api/x402/pay/execute — the ONLY money-moving path. Requires a valid,
 * unexpired, session-matched quote (minted by POST above) plus the same
 * message it was quoted for. Runs the spend→sign→settle flow the POST used to
 * run inline. The client calls this on the user's explicit tap.
 */
export async function PUT(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  // Re-checked here and not inherited from the quote: this is the verb that
  // signs, and a key can be replaced (or a TINY_CHAIN_ALLOW_DEV_KEYS=1 devnet
  // grant dropped) between the mint and the tap.
  const pk = process.env.PAYOUT_PRIVATE_KEY || ''
  const refusal = payerKeyRefusal(pk)
  if (refusal) {
    console.error(`[x402/pay execute] ${refusal}`)
    return json({ ok: false, error: PAYER_UNCONFIGURED }, 424)
  }

  // Symmetric to POST's mint guard (see `if (!quoteSecret())` above): refuse to
  // VERIFY a quote when no quote secret is configured. An empty HMAC key is a
  // publicly-computable key, so verifying against it would honor a forged quote.
  // Harmless under today's config (quoteSecret() falls back to PAYOUT_PRIVATE_KEY,
  // and the pk gate above already required that to be a valid 64-hex key, so this
  // never fires) — but it fail-closes the latent hole should that fallback ever
  // be dropped in favor of requiring an explicit, distinct X402_QUOTE_SECRET.
  //
  // ⚠️ Emptiness is the only thing this can check, and a PUBLISHED key is not
  // empty — it's an HMAC key an attacker already has, which reads as configured
  // to every check here. That case is caught above by payerKeyRefusal, and it is
  // the reason the dev-key guard belongs on this route at all rather than only
  // on the two that move a transaction.
  if (!quoteSecret()) {
    return json({ ok: false, error: 'x402 payment quoting not configured on this deployment' }, 424)
  }

  const body = await req.json().catch(() => ({} as any))
  const q = decodeQuote(String(body.quote || ''), unb64, quoteVerify)
  if (!q) return json({ ok: false, error: 'invalid or tampered payment quote' }, 400)

  // Bind the quote to THIS user, THIS message, and a live clock.
  if (q.sub !== session.sub) return json({ ok: false, error: 'this quote belongs to another session' }, 403)
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec > q.exp) return json({ ok: false, error: 'this quote expired — request a fresh one', expired: true }, 410)
  const message = String(body.message || body.prompt || '').slice(0, 8000)
  if (hashMessage(message) !== q.msgHash) {
    return json({ ok: false, error: 'the message does not match what was quoted' }, 409)
  }

  // 💸 Transfer quotes settle on the internal ledger — one atomic worker call,
  // no URL, no signing, no on-chain leg. (kind is HMAC-bound: a tampered quote
  // can't reroute an approved x402 payment through this cheaper path.)
  if (q.kind === 'transfer') return executeTransfer(session, q)

  // Re-validate the URL against the CURRENT allowlist (env may have tightened
  // since the quote was minted) — never trust the quote's URL blindly.
  const target = isPayableUrl(q.url)
  if (!target) return json({ ok: false, error: 'quoted url is no longer payable' }, 400)

  return executePayment({ session, pk, target, message, q })
}

/**
 * 💸 The transfer settle — the worker's /pay/transfer is ONE atomic D1 batch
 * (guarded debit + gated credit + taint), idempotent by the quote's jti. That
 * atomicity is why this path needs none of executePayment's spend-sent /
 * reverse machinery: there is no signed bearer instrument in flight, so every
 * outcome is either "settled once" or "nothing moved" — and a retry of the
 * same approval collides on the ref and reports already_settled.
 */
async function executeTransfer(session: { sub: string }, q: QuoteFields): Promise<Response> {
  const amount = Number(q.amountMicro)
  const short = PAYER_NETWORKS[q.network].short
  const r: any = await fetch(`${WORKER_URL}/pay/transfer`, {
    method: 'POST', headers: ikey(),
    body: JSON.stringify({ payerId: session.sub, toLogin: q.payTo, amount_micro: amount, ref: `p2p:${q.jti}` }),
    signal: AbortSignal.timeout(30_000),
  }).then(res => res.json()).catch(() => null)

  if (!r) {
    // Ambiguous (ack lost): the batch may or may not have committed. Unlike the
    // x402 path this is SAFE to retry — the jti-keyed ref makes a second attempt
    // either settle the once-only transfer or report already_settled.
    return json({ ok: false, error: 'could not confirm the transfer — retry this approval; it settles at most once' }, 502)
  }
  if (r.already_settled === true) {
    // Double-tap / re-approve after a dropped response: the money DID move,
    // exactly once. already_paid is the clients' "treat as paid" signal.
    return json({
      ok: false, already_paid: true,
      error: 'this transfer already settled — not sending it twice',
      price_micro: amount, payee: `@${r.to || q.payTo}`, network: short, transfer: true,
    }, 409)
  }
  if (r.ok === true) {
    return json({
      ok: true, paid_micro: amount, transfer: true,
      network: short, payee: `@${r.to || q.payTo}`,
      balance_micro: Number(r.balance_micro ?? 0),
    })
  }
  if (r.error === 'insufficient_balance') {
    return json({
      ok: false, payment_required: true,
      error: `This send is ${usd(amount)} and the wallet has ${usd(Number(r.balance_micro ?? 0))}. Top up at /wallet.`,
      price_micro: amount, balance_micro: Number(r.balance_micro ?? 0),
    }, 402)
  }
  if (r.error === 'unknown_recipient') {
    return json({ ok: false, error: `@${q.payTo} no longer resolves to a tiny account — nothing was sent` }, 404)
  }
  return json({ ok: false, error: String(r.error || 'the transfer could not be completed') }, 502)
}

/**
 * The spend→sign→settle core, shared by the execute path. Money moves here and
 * only here. Preserves every hardening from the original inline flow: debit
 * BEFORE signing, reverse ONLY when no USDC moved, never auto-reverse once the
 * signed header has left us.
 */
async function executePayment(args: {
  session: { sub: string }; pk: string; target: URL; message: string; q: QuoteFields
}): Promise<Response> {
  const { session, pk, target, message, q } = args
  const { payTo, network, amountMicro } = q

  // Reservation ref keyed on the quote's unique jti → executing the SAME quote
  // twice (double-tap, remount re-approve, or a hostile agent replaying the
  // token within its TTL) collides on already_spent and settles ONCE. Two
  // DISTINCT quotes for the same payee/price carry different jti → two refs →
  // two payments (correct — they are two separate approvals). The random token
  // is a belt-and-suspenders fallback that never runs while jti is present.
  const ref = buildSpendRef({
    sub: session.sub, network, payTo, amountMicro,
    idempotencyKey: q.jti,
    randomToken: () => randomNonce().slice(2, 34), // 16 bytes of entropy
  })

  // Reserve the balance BEFORE signing (see header invariant). Bound the fetch
  // (30s) like every other network call in this route: without it a hung worker
  // stalls to the platform kill with NO reconcile marker — yet this is the ONE
  // call whose null (ambiguous ack-lost) result already has a graceful branch
  // built below (the reconcile-log + honest "no money moved" 402). An unbounded
  // hang would deny it the chance to run. A commit whose ack times out is caught
  // by that same branch (retrying the quote reuses jti → already_spent → 409).
  const spend = await fetch(`${WORKER_URL}/pay/spend`, {
    method: 'POST', headers: ikey(),
    // `network` (CAIP-2, as selected by selectAccept — the chain we are about to
    // sign a REAL USDC transfer on) decides whether trial credits may fund this:
    // the worker excludes them on a real network, since there the platform hot
    // wallet fronts real money and minted/faucet credits would have it eat the
    // difference. The worker normalizes unknown values to its deployment default,
    // never to "trial", so this can only ever tighten the guard.
    body: JSON.stringify({ userId: session.sub, amount_micro: Number(amountMicro), ref, payee: payTo, network }),
    signal: AbortSignal.timeout(30_000),
  }).then(r => r.json()).catch(() => null)
  if (!spend || spend.ok !== true) {
    // A definitive `insufficient_balance` means the worker's guarded debit wrote
    // NO row (the balance WHERE yielded 0 rows) — nothing was reserved, nothing
    // to reconcile. But a null/transport-lost (or otherwise non-ok) reply is
    // AMBIGUOUS: the atomic debit may have COMMITTED while the HTTP ack was lost
    // (a drop after commit, an unparseable body). Then the balance is held yet
    // no USDC will ever move — and a retry of this same quote reuses the jti →
    // same ref → /pay/spend answers already_spent → we 409 below without
    // settling or reversing, so the hold is permanent via this route. Emit a
    // reconcile marker for THAT case only (mirrors the post-send reconcile logs
    // at the timeout/402 branches) so an out-of-band sweep can find and reverse
    // a committed-but-unsettled reservation. Never log the expected
    // insufficient-balance path — that would pollute the earnings-loss signal
    // (same discipline as arming the undelivered-refund ref only on a real move).
    const insufficient = spend?.error === 'insufficient_balance'
    if (!insufficient) {
      console.error('x402pay-reconcile', JSON.stringify({ ref, userId: session.sub, payee: payTo, amountMicro, reason: 'spend-reserve ack lost — a reservation may be held with no payment' }))
    }
    // `payment_required` is the clients' "Add funds" trigger (web PayReceipt +
    // iOS PayQuote both key their top-up button off it). Set it ONLY on the
    // definitive insufficient-balance decline, where topping up + retrying the
    // still-valid quote genuinely settles. The ambiguous transport-lost case
    // shares this 402 but is NOT a funds problem: a retry of this same quote
    // reuses the jti → same ref → already_spent → 409 (never a second payment),
    // and any committed-but-unsettled hold is swept via the reconcile marker
    // above. Flagging it payment_required would show a funded user a spurious
    // "Add funds" on a mere worker blip — so let it fall through to the plain
    // "Payment not sent" card (no misleading affordance), the honest posture.
    return json({
      ok: false, ...(insufficient ? { payment_required: true } : {}),
      error: insufficient
        ? `This service charges ${usd(Number(amountMicro))} and the wallet has ${usd(Number(spend?.balance_micro ?? 0))}. Top up at /wallet.`
        : 'could not reserve funds for this payment — no money moved; if a hold is showing it will be reconciled',
      price_micro: Number(amountMicro), balance_micro: Number(spend?.balance_micro ?? 0),
    }, 402)
  }
  if (spend.already_spent === true) {
    return json({
      ok: false, already_paid: true,
      error: 'this payment was already settled — not sending a second on-chain payment',
      ref, price_micro: Number(amountMicro),
    }, 409)
  }

  // We must re-fetch the challenge to sign against the CURRENT accept (asset,
  // domain, timeout) — the quote binds the price/network/payee we approved, but
  // the EIP-712 domain must come from a live challenge, not a stale one.
  const probe = await fetch(target.toString(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }), signal: AbortSignal.timeout(30_000),
    redirect: 'error', // see quote-probe note: never follow a 3xx off the vetted host
  }).catch(() => null)
  const challenge = probe && probe.status === 402 ? parseChallenge(await probe.json().catch(() => null)) : null
  // Re-find the accept we quoted in the FRESH challenge, binding the asset too:
  // selectAccept already guaranteed USDC at quote time, but the live challenge
  // is re-fetched here and could differ (a service that swapped its token
  // between quote and execute). Signing is about to authorize a transfer of
  // accept.asset, so require it to still be the expected USDC — never sign a
  // non-USDC transfer. A mismatch means the terms changed → reverse + re-quote.
  // Compare payTo case-INSENSITIVELY: an Ethereum address is case-insensitive on
  // chain (EIP-55 checksum casing is only a cosmetic typo-detection overlay), so
  // a service that echoes the same receiving address with different casing
  // between the quote and this execute-time re-probe must NOT read as a terms
  // change. Mirrors isExpectedUsdc's own lowercased asset compare. Signing below
  // uses accept.payTo from the fresh challenge — the same on-chain recipient.
  const accept = challenge?.accepts.find(a =>
    a.network === network && a.payTo.toLowerCase() === payTo.toLowerCase() && String(a.maxAmountRequired) === amountMicro
    && isExpectedUsdc(a.network, a.asset))
  if (!accept) {
    // The service's terms changed (or it's no longer charging what we quoted) —
    // no USDC moved, so reverse the reservation and ask for a fresh quote.
    await fetch(`${WORKER_URL}/pay/spend-reverse`, {
      method: 'POST', headers: ikey(), body: JSON.stringify({ userId: session.sub, ref }),
    }).catch(() => {})
    return json({ ok: false, error: 'the service’s price or terms changed — request a fresh quote', terms_changed: true }, 409)
  }

  // Sign the EIP-3009 authorization with the hot wallet.
  //
  // 🔍 The instrument's IDENTITY escapes this block with the header, because it is
  // what makes the guard below RESOLVABLE rather than permanent. `randomNonce()`
  // used to be an inline argument, so the nonce we signed was discarded the instant
  // the header was encoded — nothing anywhere could name the authorization again.
  // That is exactly the field a reconciler needs: `authorizationState(from, nonce)`
  // is the chain's own redemption bit, and `validBefore` (signed INTO the payload,
  // so it is the contract's deadline and not a timeout we invented) is what lets
  // "not redeemed" become the verdict `not_settled` instead of "not yet".
  let xPaymentHeader: string
  let identity: { payer: string; nonce: string; validBefore: number }
  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    const nonce = randomNonce()
    const authorization = buildAuthorization({
      from: account.address, to: accept.payTo, valueMicro: amountMicro,
      nonce, nowSec: Math.floor(Date.now() / 1000), validForSec: accept.maxTimeoutSeconds || 120,
    })
    const typed = buildTypedData(accept, authorization)
    const signature = await account.signTypedData(typed as any)
    xPaymentHeader = encodePaymentHeader(accept, authorization, signature, challenge!.x402Version, (s) => Buffer.from(s, 'utf8').toString('base64'))
    // Read back from `authorization`, not from the inputs: buildAuthorization owns
    // the window (it back-dates validAfter for clock skew and floors validForSec),
    // so the deadline the reconciler must honour is the one that was SIGNED, never
    // a second computation of it here. Two derivations of the same deadline is the
    // split-authority shape this whole arc keeps closing.
    identity = { payer: account.address, nonce, validBefore: Number(authorization.validBefore) }
  } catch (e: any) {
    await fetch(`${WORKER_URL}/pay/spend-reverse`, {
      method: 'POST', headers: ikey(), body: JSON.stringify({ userId: session.sub, ref }),
    }).catch(() => { /* reservation row remains — visible for repair */ })
    return json({ ok: false, error: `could not sign payment (refunded): ${String(e?.message || e).slice(0, 120)}` }, 502)
  }

  // 🖊️→💸 ARM THE GUARD BEFORE HANDING OUT THE SIGNATURE.
  //
  // Everything above this line is provably pre-send, and both reverse sites above
  // are therefore safe. Everything below is irreversible: an EIP-3009
  // authorization is a BEARER instrument, so once the header leaves us anyone
  // holding it can settle it, at any time. The worker's /pay/spend-reverse had no
  // way to tell those two worlds apart — "no USDC moved" was purely our word — so
  // we now record the crossing (migration 0025 spend_sent) and the reverse refuses
  // any ref that carries the mark.
  //
  // Marked BEFORE the send, not after: a mark written afterwards is not a gate at
  // all, because the send can succeed while the mark is lost, and a later reverse
  // would then read an unmarked ref and refund a payment in flight. Marking first
  // can only ever over-protect.
  //
  // A mark that FAILS aborts the payment and reverses — which is sound precisely
  // because we are still on the pre-send side of the line, so the reversal is
  // provably correct. We refuse to hand out an instrument whose guard we could not
  // arm. (The worker being unreachable here is not a new dependency: /pay/spend
  // above already had to reach it to create this reservation.)
  const marked = await fetch(`${WORKER_URL}/pay/spend-sent`, {
    method: 'POST', headers: ikey(),
    // …and WHICH instrument, so the freeze this mark creates is pending rather than
    // permanent. The worker validates each identity field independently and stores
    // NULL for anything malformed — it never rejects the mark over them, because
    // the safety fact must land even if the resolvability hint cannot.
    body: JSON.stringify({ userId: session.sub, ref, payee: payTo, ...identity }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!marked?.ok) {
    await fetch(`${WORKER_URL}/pay/spend-reverse`, {
      method: 'POST', headers: ikey(), body: JSON.stringify({ userId: session.sub, ref }),
    }).catch(() => { /* reservation row remains — visible for repair */ })
    console.error('x402pay-reconcile', JSON.stringify({
      ref, userId: session.sub, payee: payTo, amountMicro,
      reason: 'could not mark the reservation as sent — payment NOT sent, reservation reversed',
    }))
    return json({ ok: false, error: 'could not arm the payment safety guard — nothing was sent (refunded); please retry' }, 503)
  }

  // Retry the target WITH payment. Past this point the signed authorization has
  // left us; the payee may settle it, so we do NOT auto-reverse on a timeout
  // (mirror of withdraw's "once broadcast, never auto-refund").
  // redirect:'error' matters MOST here — this carries the signed X-PAYMENT
  // authorization. fetch does NOT strip a custom header on a cross-origin
  // redirect, so 'follow' would leak the signed auth + the user's message to a
  // redirect target. A redirect fails → the null-body reconcile path below
  // (pending, no auto-reverse — the auth already left us, correct posture).
  const paid = await fetch(target.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': xPaymentHeader },
    body: JSON.stringify({ message }), signal: AbortSignal.timeout(90_000),
    redirect: 'error',
  }).catch(() => null)

  if (!paid) {
    console.error('x402pay-reconcile', JSON.stringify({ ref, userId: session.sub, payee: payTo, amountMicro, reason: 'no response after payment sent' }))
    return json({
      ok: false, pending_confirmation: true,
      error: 'payment was sent but the service did not respond — do not retry; it will be reconciled', ref,
    }, 202)
  }

  const txt = await paid.text()
  if (paid.status === 402) {
    // A 402 after we sent X-PAYMENT means "rejected, did not settle" ONLY for
    // tiny's own receiver (it 402s strictly before settlement). We can safely
    // reverse there. A third-party allowlisted host, however, could have
    // settled the EIP-3009 authorization on-chain and STILL answered 402 — so
    // for those we must NOT auto-reverse (that would refund the user while the
    // platform's USDC is gone). Treat it as pending + reconcile, like a timeout.
    //
    // ⚠️ "it 402s strictly before settlement" is not unconditionally true, and
    // that assumption was the bug. Our receiver 402s on ANY settle failure, and
    // a settle can fail as "submitted, unconfirmed" — a receipt-wait timeout or
    // RPC blip on a transfer that is already in the mempool. Reversing there
    // refunds the user while the platform's fronted USDC lands on-chain. So the
    // 402 body now STATES the verdict (chain/settle-outcome.mjs) and we refund
    // only on a positive not_settled. An older receiver that omits the field
    // reads as not_settled — first-party behaviour is unchanged for every
    // genuinely-rejected payment, which is essentially all of them.
    if (isFirstPartyHost(target) && safeToRefund(firstPartySettlement(txt))) {
      // This reverse is POST-send, so it must carry the one fact that makes that
      // safe past the worker's spend_sent guard: the payee positively reported the
      // authorization dead. We pass the classifier's own verdict rather than a
      // bare "trust me" flag, so the assertion is the same word the receiver
      // computed — and a caller that cannot say it gets refused by default.
      await fetch(`${WORKER_URL}/pay/spend-reverse`, {
        method: 'POST', headers: ikey(),
        body: JSON.stringify({ userId: session.sub, ref, settlement: NOT_SETTLED }),
      }).catch(() => { /* visible for repair */ })
      return json({ ok: false, error: 'payment rejected by the service (refunded)', detail: safeJson(txt) }, 402)
    }
    if (isFirstPartyHost(target)) {
      // First-party 402 that did NOT positively claim not_settled — i.e. our own
      // receiver told us the settle was submitted but unconfirmed. Same posture
      // as a third-party 402: pending, reconcile, never auto-refund.
      console.error('x402pay-reconcile', JSON.stringify({
        ref, userId: session.sub, payee: payTo, amountMicro, status: 402,
        settlement: settleOutcome(firstPartySettlement(txt)), tx_hash: settlementHash(firstPartySettlement(txt)),
        reason: 'first-party 402 reported an UNCONFIRMED settle — not auto-reversing',
      }))
      return json({
        ok: false, pending_confirmation: true,
        error: 'payment was submitted but the service could not confirm it — not auto-refunding; it will be reconciled', ref,
      }, 202)
    }
    console.error('x402pay-reconcile', JSON.stringify({ ref, userId: session.sub, payee: payTo, amountMicro, status: 402, reason: 'third-party 402 after send — not auto-reversing' }))
    return json({
      ok: false, pending_confirmation: true,
      error: 'the service returned 402 after payment was sent — not auto-refunding; it will be reconciled', ref,
    }, 202)
  }
  if (!paid.ok) {
    console.error('x402pay-reconcile', JSON.stringify({ ref, userId: session.sub, payee: payTo, amountMicro, status: paid.status }))
    return json({ ok: false, pending_confirmation: true, error: `service errored after payment (status ${paid.status}) — reconciling`, ref }, 202)
  }

  // The settlement receipt rides back in the standard x402 `X-PAYMENT-RESPONSE`
  // header (base64 JSON { success, transaction, network, payer }). `transaction`
  // is the on-chain tx hash — the user's proof the USDC actually moved. Without
  // this the "Payment sent" receipt could only say "Paid $X to 0x…" with no way
  // to verify it landed, while the withdraw + inbound-x402 receipts both link to
  // BaseScan. Decode best-effort — a service that omits the header (or sends a
  // malformed one) simply yields no link, never an error.
  const responseBody = safeJson(txt)
  // Prefer the standard x402 X-PAYMENT-RESPONSE header. Tiny's OWN receiver
  // (app/api/x402/chat/[slug]) doesn't set that header — it returns the hash as
  // `tx_hash` in the body — and it's the ONLY host on the default allowlist, so
  // without this fallback the BaseScan link silently drops for the common
  // same-platform agent-to-agent payment. Body fallback is first-party-only:
  // a third party must speak the header (settlementTxFromBody isn't consulted
  // for them), so no new trust surface. The explorer host still follows the
  // network WE signed for, never a body-supplied claim.
  const settleTx = parseSettlementTx(paid.headers.get('X-PAYMENT-RESPONSE'))
    || (isFirstPartyHost(target) ? settlementTxFromBody(responseBody) : '')
  const explorer = explorerTxUrl(network, settleTx)

  return json({
    ok: true,
    paid_micro: Number(amountMicro),
    network: PAYER_NETWORKS[network].short,
    payee: payTo,
    response: responseBody,
    // On-chain proof, when the service returned a settlement header. Omitted
    // (not null) when absent so the client cleanly shows no link. The explorer
    // host is chosen by the network WE signed for (never the header's claim) —
    // mirrors the withdraw + inbound receipts, never a wrong-chain link.
    ...(settleTx ? { tx_hash: settleTx } : {}),
    ...(explorer ? { explorer } : {}),
  })
}

/** Best-effort JSON parse — an x402 service returns JSON, but tolerate text. */
function safeJson(txt: string): any {
  try { return JSON.parse(txt) } catch { return txt.slice(0, 4000) }
}
