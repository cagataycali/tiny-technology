/**
 * Typed client for the wallet API — the contract /wallet, WalletSheet, and
 * Chat's price badge previously shared BY DOCBLOCK CONVENTION only
 * ("Same API shapes … so the two never drift"). Now they import it.
 *
 * Types mirror the WIRE (snake_case) on purpose: the surfaces store raw
 * responses in state, so renaming fields here would cascade through every
 * consumer for zero user value. What this module owns instead:
 *  - the action union (a typo'd action is now a tsc error, not a silent 400),
 *  - one POST plumbing (callers keep their own retry/error strategies),
 *  - the parse rules everyone re-derived: 401/424/error classification and
 *    finite-guarded micro amounts (worker fields arrive unvalidated).
 */
import type { FaucetInfo } from './top-up'
import { QUICK_MS, deadlineFor } from '../deadlines'

export type LedgerEntry = {
  delta_micro: number
  kind: string
  ref?: string
  counterparty?: string
  created?: number
}

export interface DepositInfoResponse {
  ok?: boolean
  configured?: boolean
  deposit_address?: string
  default_network?: string
  linked_address?: string
  faucet?: FaucetInfo | null
}
export interface PricingResponse { price_micro?: number | string }
export interface LinkAddressResponse { ok?: boolean; address?: string; error?: string }
export interface ClaimResponse {
  ok?: boolean
  already_credited?: boolean
  credited_micro?: number | string
  testnet_trial?: boolean
  trial_cap_micro?: number | string
  /** Transient verification failure — the tx may confirm shortly; retry. */
  retry?: boolean
  error?: string
}
export interface FaucetClaimResponse {
  ok?: boolean
  credited_micro?: number | string
  trial_cap_micro?: number | string
  error?: string
  [k: string]: unknown
}

export type WalletActionBody =
  | { action: 'deposit_info' }
  | { action: 'pricing'; resource: string }
  | { action: 'link_address'; address: string }
  | { action: 'claim'; txHash: string; network: string }

/** One POST plumbing for every {action} call. Throws on network failure —
 * each caller keeps its own retry/degrade strategy (page retries twice,
 * the sheet checks mountedRef, the badge swallows). */
export function walletAction(body: { action: 'deposit_info' }): Promise<DepositInfoResponse>
export function walletAction(body: { action: 'pricing'; resource: string }): Promise<PricingResponse>
export function walletAction(body: { action: 'link_address'; address: string }): Promise<LinkAddressResponse>
export function walletAction(body: { action: 'claim'; txHash: string; network: string }): Promise<ClaimResponse>
export async function walletAction(body: WalletActionBody): Promise<unknown> {
  const r = await fetch('/api/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Deadline the call, or a hung worker leaves this pending forever — every
    // caller sits behind `if (busy) return` and clears the flag in a `.finally`,
    // so the button that could retry stays disabled until a reload. Budget comes
    // from lib/deadlines (35s here: the route gives the worker 20s for on-chain
    // verification on `claim`), never a blanket 10s that would abort a
    // verification still in progress.
    signal: AbortSignal.timeout(deadlineFor('/api/wallet')),
  })
  return r.json()
}

/** POST /api/wallet/faucet — the self-hosted chain's in-house top-up. */
export async function faucetClaim(): Promise<FaucetClaimResponse> {
  // 45s — the route declares maxDuration = 30 to mint credit on-chain.
  return fetch('/api/wallet/faucet', {
    method: 'POST',
    signal: AbortSignal.timeout(deadlineFor('/api/wallet/faucet')),
  }).then((r) => r.json())
}

/** Finite-guarded micro amount — worker numerics arrive as number|string|junk;
 * NaN falls through every comparison and renders "$NaN" (c4 lesson, now shared). */
export function microAmount(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export type WalletSnapshot =
  | { status: 'unauthorized' }
  | { status: 'unavailable' }
  | { status: 'ok'; balanceMicro: number; history: LedgerEntry[] }

/** The GET /api/wallet classification both surfaces re-derived:
 * 401 = signed out (page redirects, sheet shows copy — caller's call),
 * 424 or an error body = wallet service not configured/reachable,
 * anything else = a snapshot with guarded numerics. */
export function parseWalletSnapshot(httpStatus: number, data: any): WalletSnapshot {
  if (httpStatus === 401) return { status: 'unauthorized' }
  if (httpStatus === 424 || data?.error) return { status: 'unavailable' }
  return {
    status: 'ok',
    balanceMicro: microAmount(data?.balance_micro),
    history: Array.isArray(data?.history) ? data.history : [],
  }
}

export type WalletFetch = WalletSnapshot | { status: 'failed' }

/** GET the wallet snapshot; network/parse failure → 'failed' (the page keeps
 * an already-populated wallet on a reload blip; the sheet shows unavailable). */
export async function getWallet(): Promise<WalletFetch> {
  try {
    // A plain read — the house budget, which sits ABOVE the route's own 10s
    // proxy cap so that cap fires first and returns an explainable error.
    // Without any deadline a hung GET keeps the balance card on its skeleton
    // forever, and the sheet's post-claim re-read (`await getWallet()`) would
    // hold `busy` true past a claim that succeeded.
    const res = await fetch('/api/wallet', { cache: 'no-store', signal: AbortSignal.timeout(QUICK_MS) })
    return parseWalletSnapshot(res.status, await res.json().catch(() => ({})))
  } catch {
    return { status: 'failed' }
  }
}

/** Chat's price badge + the monetize card both read pricing this way. */
export function priceMicroOf(d: PricingResponse | null | undefined): number {
  return microAmount(d?.price_micro)
}
