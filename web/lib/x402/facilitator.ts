import { paymentsNetwork } from './tiny-chain'

/**
 * 🏦 WHICH FACILITATOR SETTLES THIS DEPLOYMENT'S CHAIN.
 *
 * The x402 receiver doesn't move money itself — it POSTs the payer's signed
 * EIP-3009 authorization to a facilitator's /verify then /settle. Which
 * facilitator was, until now, one line: `X402_FACILITATOR_URL ||
 * 'https://x402.org/facilitator'`. That default is correct for exactly the two
 * chains it knows (base, base-sepolia) and is *incapable* of settling any
 * other — and report §1.2 item 2 ("You must run your own x402 facilitator")
 * is the whole reason chain/facilitator/server.mjs exists.
 *
 * So a deployment configured for its own chain (PAYMENTS_NETWORK=tiny) had a
 * 402 door that:
 *   1. advertised TinyUSDC on eip155:<our id> as payable (offeredNetworks),
 *   2. took the payer's signed authorization, and
 *   3. sent it to x402.org, which has never heard of that chain.
 *
 * Nobody loses funds — the settle just fails — but the payer has already
 * signed, and what they signed is a BEARER INSTRUMENT: a valid
 * transferWithAuthorization anyone who can reach our RPC may submit. Handing
 * that to an unrelated third party to be told "unknown network" is the wrong
 * order of operations. The check is free and static: we know our chain and we
 * know the facilitator can't settle it, so refuse at the door, BEFORE anyone
 * signs anything.
 *
 * This mirrors the guard the same routes already apply to X402_PAY_TO — a paid
 * tiny with no receiving address 424s in POST, in GET discovery, and in the
 * ERC-8004 registration, so a crawler (or a minting agent baking terms
 * PERMANENTLY on-chain) never caches a payable claim we can't honor. A missing
 * facilitator is the identical failure with the identical remedy; the only
 * reason it wasn't covered is that its unset state had a default that *looked*
 * like a working value.
 *
 * Resolution, per call (never frozen at module load — routes read the network
 * selector per request, and so must this):
 *   - unset on base / base-sepolia → the public x402.org facilitator, exactly
 *     as before. This is the behaviour tiny.technology ships with today and
 *     nothing about it changes.
 *   - unset on a self-hosted chain → null (fail closed). There is no default
 *     that could work; the operator must point this at their own
 *     chain/facilitator/server.mjs.
 *   - a public facilitator explicitly named on a self-hosted chain → null.
 *     Same impossibility, just spelled out instead of inherited — and this is
 *     the likely misconfiguration, because the go-live checklist used to say
 *     "leave it unset".
 *   - unparseable → null, rather than a fetch base that throws only after the
 *     payer has signed.
 */

/** The public facilitator, and the historical default for the Base chains. */
export const DEFAULT_PUBLIC_FACILITATOR = 'https://x402.org/facilitator'

/**
 * Facilitators that settle PUBLIC chains only. Naming one of these on a
 * self-hosted chain is a misconfiguration we can detect statically: they have
 * no RPC for our chain and no TinyUSDC to call, so every settle would fail
 * after the payer signed. (Hostname match — the path differs per provider.)
 */
const PUBLIC_FACILITATOR_HOSTS = [
  'x402.org',
  'www.x402.org',
  'api.cdp.coinbase.com',
  'api.developer.coinbase.com',
]

/** Is this URL a known public-chain-only facilitator? */
export function isPublicFacilitator(url: string): boolean {
  try {
    return PUBLIC_FACILITATOR_HOSTS.includes(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The facilitator this deployment settles through, or null when no facilitator
 * can settle the chain it offers. A null means the payment door must fail
 * closed (424) in every place that advertises or demands payment — the callers
 * are the receiver POST, its GET discovery doc, and the ERC-8004 registration.
 *
 * Returned without a trailing slash, since callers append `/verify` + `/settle`.
 */
export function facilitatorUrl(): string | null {
  const raw = String(process.env.X402_FACILITATOR_URL || '').trim().replace(/\/+$/, '')
  const selfHosted = paymentsNetwork() === 'tiny'

  // Unset: the Base chains keep their working default; a self-hosted chain has
  // no possible default, so it must be configured rather than guessed.
  if (!raw) return selfHosted ? null : DEFAULT_PUBLIC_FACILITATOR

  // Must be an absolute http(s) origin — this becomes a fetch base. A relative
  // path or a typo'd scheme would otherwise surface as "facilitator
  // unreachable" only after we'd already collected a signed authorization.
  let host = ''
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    host = u.hostname
  } catch {
    return null
  }
  if (!host) return null

  // A public facilitator cannot settle a chain we host ourselves.
  if (selfHosted && isPublicFacilitator(raw)) return null

  return raw
}
