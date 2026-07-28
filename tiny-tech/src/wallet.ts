/**
 * 💧 WALLET COPY + TOP-UP ROUTING for the daemon — the fourth and last client of
 * the self-hosted chain's money surface (web `lib/x402/top-up.ts`, iOS
 * `TopUp.swift`, Android `WalletCore.kt`).
 *
 * The other three clients render BUTTONS, so their bug was a link that couldn't
 * deliver. This client renders nothing: its user is a language model reading tool
 * descriptions and tool results, and it acts on what those SAY. So the same bug
 * takes a worse form here — `tiny_wallet` advertised "claim (credit an on-chain
 * deposit by tx hash)" as the only way in, on a deployment where nobody sells the
 * token, and a helpful agent will duly walk the user through buying USDC that
 * this deployment cannot credit. A wrong button is a dead end; a wrong sentence
 * from an agent is worse, because the user asked and was answered.
 *
 * Two things here are NOT copy:
 *
 *  1. `WALLET_NETWORKS` includes `tiny`. The MCP schema listed only
 *     base/base-sepolia, so on a self-hosted deployment — where `deposit_info`
 *     reports `default_network: "tiny"` — the SDK rejected the very network the
 *     server told the agent to use. An unreachable branch is a bug the schema
 *     enforces.
 *  2. `faucetOutcome` keeps the worker's two refusals apart (429 already-claimed
 *     vs 400 ceiling-reached), because "wait until midnight UTC" and "get
 *     followed to raise your ceiling" are opposite instructions and an agent that
 *     merges them will loop a capped user back to the same call every day.
 *
 * PURE — no fetch, no fs, no env — so all of it is asserted (test/wallet.test.mjs)
 * instead of discovered in front of a user holding the wrong token.
 */

/** Networks the payments stack settles on — mirrors the worker's `PayNetwork`. */
export type PayNetwork = 'base' | 'base-sepolia' | 'tiny'

/**
 * Every network a deposit claim may name. `tiny` belongs here even though only a
 * self-hosted deployment serves it: the schema is the agent's whole world, and
 * omitting a network the server advertises makes the documented flow impossible.
 */
export const WALLET_NETWORKS: PayNetwork[] = ['base', 'base-sepolia', 'tiny']

/**
 * Coerce an unknown network string, defaulting to the SAFEST reading (real
 * Base): guessing "trial" for an unknown name would have an agent describe real,
 * withdrawable money as play credit.
 */
export const asNetwork = (raw: unknown): PayNetwork => {
  const n = String(raw ?? '').toLowerCase().trim()
  return n === 'tiny' || n === 'base-sepolia' ? n : 'base'
}

/** Balance on this network is spendable inside tiny but not withdrawable. */
export const isTrialNetwork = (n: PayNetwork): boolean => n !== 'base'

/** What the money on a network IS, in one phrase an agent can quote. */
export const fundsPhrase = (n: PayNetwork): string =>
  n === 'tiny' ? "trial credit on this deployment's own chain (not withdrawable as real USDC)"
    : n === 'base-sepolia' ? 'testnet trial credit on Base Sepolia (not withdrawable as real USDC)'
      : 'real USDC on Base'

/** Micro-USDC → "$1.2" — trailing zeros trimmed, junk → "$0". */
export const usdShort = (micro: unknown): string => {
  const n = Number(micro)
  const v = Number.isFinite(n) ? n / 1_000_000 : 0
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return `$${s}`
}

/** `deposit_info.faucet` (worker `PayDepositInfoCall`). */
export type FaucetInfo = {
  available?: boolean
  network?: string
  drip_micro?: number
  cap_micro?: number
  granted_micro?: number
  remaining_micro?: number
  claimed_today?: boolean
  next_drip_in_seconds?: number
  reputation?: number
  micro_per_point?: number
  max_micro?: number
}

export type DepositInfoLike = {
  default_network?: string
  linked_address?: string | null
  deposit_address?: string | null
  configured?: boolean
  faucet?: FaucetInfo | null
}

/**
 * Which top-up route this deployment offers. Exactly one, always:
 *
 *  - `faucet`  — we own the chain, so we issue the credit; no external rail can
 *                deliver a token only this deployment mints.
 *  - `testnet` — Sepolia: the public faucet is the one true source, and a fiat
 *                on-ramp hands over MAINNET USDC the claim scanner can't see.
 *  - `fiat`    — real Base: buying/bridging works and a faucet would be nonsense.
 */
export type TopUpRoute = 'faucet' | 'testnet' | 'fiat'

/**
 * Pick the route from what the SERVER said.
 *
 * Keyed on `faucet.available`, not on `default_network === 'tiny'`, because the
 * two legitimately disagree: the faucet needs a mintable token AND a deployer
 * key, so a half-configured tiny-chain deployment reports `tiny` with no faucet,
 * and an agent that trusted the name would keep calling a 424.
 */
export const topUpRoute = (info: DepositInfoLike | null | undefined): TopUpRoute => {
  if (info?.faucet?.available) return 'faucet'
  return asNetwork(info?.default_network) === 'base-sepolia' ? 'testnet' : 'fiat'
}

/**
 * The sentence the AGENT reads after `deposit_info` — this client's equivalent of
 * the other three's top-up card, and the reason this module exists.
 *
 * It states the one way in and, on the faucet route, forbids the wrong one
 * explicitly. A prohibition is needed rather than mere omission: a model that
 * knows how USDC normally works will fill the gap with Coinbase from its own
 * priors, which is exactly the trap (real money spent for a token this
 * deployment cannot accept).
 */
export const topUpAdvice = (info: DepositInfoLike | null | undefined): string => {
  const route = topUpRoute(info)
  const net = asNetwork(info?.default_network)

  if (route === 'faucet') {
    const f = info!.faucet!
    const drip = usdShort(f.drip_micro)
    const left = usdShort(Math.max(0, Number(f.remaining_micro) || 0))
    return `TOP UP with tiny_wallet action 'faucet' — free, one claim per UTC day (${drip}), ${left} left on this user's lifetime ceiling. That is the ONLY source of credit here: this deployment runs its own chain, so NEVER tell the user to buy, bridge, exchange or faucet USDC anywhere else — no exchange sells this chain's token, and anything they acquire elsewhere cannot be credited. Balance is ${fundsPhrase(net)}. The ceiling grows with reputation, which is earned by being followed.`
  }

  if (route === 'testnet') {
    return `TOP UP: get free testnet USDC from https://faucet.circle.com, send it to ${info?.deposit_address || 'the deposit address from deposit_info'}, then credit it with tiny_wallet action 'claim' (txHash + network 'base-sepolia'). Do NOT tell the user to buy real USDC — mainnet USDC cannot be claimed on this deployment. Balance is ${fundsPhrase('base-sepolia')}.`
  }

  return `TOP UP: buy or bridge USDC on Base, send it to ${info?.deposit_address || 'the deposit address from deposit_info'}, then credit it with tiny_wallet action 'claim' (txHash + network 'base'). Balance is ${fundsPhrase('base')}, and earnings withdraw self-serve from the web wallet.`
}

/**
 * The outcome of `POST /api/wallet/faucet`, as one sentence plus a machine kind.
 *
 * The kinds mirror the worker's deliberately-distinct statuses. Ceiling is
 * checked BEFORE already-claimed for the same reason every other client does it:
 * someone fully capped who also claimed today is CAPPED, and "come back
 * tomorrow" would be a lie, because tomorrow's drip is refused too.
 */
export type FaucetOutcome = {
  ok: boolean
  kind: 'credited' | 'already_claimed' | 'ceiling_reached' | 'unavailable' | 'failed'
  message: string
}

/** Human "2h 5m" until the next drip; '' when it isn't in the future. */
export const untilNextDrip = (seconds: unknown): string => {
  const n = Math.floor(Number(seconds))
  if (!Number.isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  // A sub-minute wait rounds UP — "in 0m" reads as a bug, and the drip is imminent.
  return `${Math.max(1, m)}m`
}

export const faucetOutcome = (body: any, status?: number): FaucetOutcome => {
  if (!body || typeof body !== 'object') {
    return { ok: false, kind: 'failed', message: "couldn't reach the faucet" }
  }

  if (body.ok) {
    const credited = usdShort(body.credited_micro)
    const backed = body.reserve_backed
      ? ' Backed 1:1 by minted TinyUSDC on-chain.'
      : ' (The on-chain reserve mint did not land — the credit is real and spendable regardless.)'
    return {
      ok: true,
      kind: 'credited',
      message: `Credited ${credited} trial credit — spendable on any tiny, NOT withdrawable as real USDC.${backed}`,
    }
  }

  const err = String(body.error || '').trim()

  // The worker's own sentences carry the figures the user needs, so they pass
  // through verbatim; four clients re-wording a money refusal is four chances to
  // contradict the server.
  if (body.ceiling_reached) {
    return { ok: false, kind: 'ceiling_reached', message: `${err || 'lifetime trial ceiling reached'} — waiting will not help; being followed raises the ceiling.` }
  }
  if (body.already_claimed || status === 429) {
    const wait = untilNextDrip(body.next_drip_in_seconds)
    return { ok: false, kind: 'already_claimed', message: `${err || "already claimed today's credit"} — next drip ${wait ? `in ${wait}` : 'after midnight UTC'}. The lifetime ceiling is NOT the problem here.` }
  }
  if (status === 424) {
    return { ok: false, kind: 'unavailable', message: `${err || 'no in-house faucet on this deployment'} — check deposit_info for how this deployment funds a wallet; do not invent an on-ramp.` }
  }
  return { ok: false, kind: 'failed', message: err || 'faucet failed' }
}
