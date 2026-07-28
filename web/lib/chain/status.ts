/**
 * ⛓️ THE CHAIN STATUS PAYLOAD — what a NON-BROWSER client is told about the chain.
 *
 * WHY THIS EXISTS. `/chain` is a server-rendered page: it reads RPC on the server
 * and ships HTML. iOS and Android have no equivalent and cannot get one from that
 * page — a native client would have to either scrape HTML or talk JSON-RPC
 * directly, and the second is worse than it sounds. Our own public proxy allows
 * `eth_getLogs`, so a mobile client doing its own decoding would be a fourth
 * implementation of transfer decoding, uint256 clamping and chain-identity
 * checking, drifting from web/Android/iOS on its own schedule. This module makes
 * the SERVER the single decoder and hands mobile a flat, already-safe payload.
 *
 * The shaping rules, all learned the expensive way on the web explorer:
 *
 *  • IDENTITY IS THREE-STATE, and 'unknown' must never render as a mismatch.
 *    `TINY_CHAIN_RPC_URL` defaults to 127.0.0.1:8545, which on the host machine is
 *    the LIVE chain — so a deployment that sets the id and forgets the RPC shows
 *    real numbers under a wrong heading. A client has to be able to say "these two
 *    disagree" without inventing which one is right. Separately, "we couldn't ask"
 *    is NOT disagreement: a down node is already reported by a null block height,
 *    and a warning on every blip gets tuned out until it means nothing.
 *
 *  • MONEY IS PRE-FORMATTED, and the clamp is visible. A uint256 is 78 decimal
 *    digits; JSON.parse turns that into a Double on the client and a Double
 *    silently loses integers past 2^53. So the server sends BOTH the clamped
 *    number and a display string, and marks `clamped` when the true value was
 *    wider than we can express. A client that only reads the string can never
 *    print a wrong amount confidently.
 *
 *  • NO REQUEST-SHAPED INPUT REACHES RPC. The caller passes a span and a limit;
 *    both are clamped here, because "give me 10 million blocks of logs" against a
 *    node behind a tunnel is a self-inflicted outage and a mobile client is the
 *    least trustworthy source of a range.
 *
 * Pure: takes the already-fetched pieces, returns the payload. The route fetches.
 */
import type { ChainIdentity } from './rpc'
import { shortHex, usdMicro, transferKind, type TransferLog } from './explorer-core'

/** Hard bounds on what a client may ask us to scan. */
export const SPAN_MAX = 10_000
export const SPAN_DEFAULT = 10_000
export const LIMIT_MAX = 50
export const LIMIT_DEFAULT = 20

/**
 * Clamp a client-supplied number into [min, max], falling back on junk.
 *
 * Junk INCLUDES negatives and NaN, not just non-numbers: `fromBlock` is computed
 * as `latest - span`, so a negative span would ask the node for a range ahead of
 * the head — which returns nothing and looks exactly like an idle chain.
 */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  // ⚠️ An empty string is ABSENT, not zero. `Number('')` is 0, which is finite,
  // so the obvious version of this function turns `?span=` — what a client sends
  // for an unset param — into the minimum window rather than the default one.
  // The symptom is a 1-block explorer that looks like a chain with no activity.
  if (typeof raw === 'string' && raw.trim() === '') return fallback
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

export type StatusTransfer = {
  hash: string
  /** Short forms too: a phone has ~34 characters of monospace, not 66. */
  hashShort: string
  from: string
  fromShort: string
  to: string
  toShort: string
  blockNumber: number | null
  /** Clamped to MAX_SAFE_INTEGER — see `clamped`. */
  amountMicro: number | null
  /** Already formatted ("$1.50", "—", or the clamp) — the safe thing to render. */
  amount: string
  /** True when the real on-chain value exceeded what a JSON number can carry. */
  clamped: boolean
  /**
   * mint | burn | transfer. On a chain whose supply is ours, "where did this
   * money come from" is the question the explorer exists to answer, and a mint
   * rendered as a transfer from 0x0000…0000 makes the reader do that decoding.
   */
  kind: 'mint' | 'burn' | 'transfer'
}

export type ChainStatus = {
  configured: boolean
  chainId: number | null
  caip2: string | null
  usdc: string | null
  /** 'match' | 'mismatch' | 'unknown' | null(unconfigured) — never collapsed. */
  identity: ChainIdentity['state'] | null
  /** Present ONLY on mismatch, so a client can name both numbers. */
  reportedChainId: number | null
  /** null = the node did not answer. Not 0 — block 0 is a real height. */
  latestBlock: number | null
  reachable: boolean
  /** The one-line honesty about what this money is. */
  moneyNote: string
  transfers: StatusTransfer[]
  /** Window actually scanned, after clamping — so a client can say "recent". */
  span: number
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

const shape = (t: TransferLog): StatusTransfer => ({
  hash: t.txHash,
  hashShort: shortHex(t.txHash),
  from: t.from,
  fromShort: shortHex(t.from),
  to: t.to,
  toShort: shortHex(t.to),
  blockNumber: t.blockNumber,
  amountMicro: t.micro,
  amount: usdMicro(t.micro),
  // `hexToNumber` clamps at MAX_SAFE_INTEGER, so equality IS the clamp signal.
  // Flagging it matters: a clamped transfer is the shape a hostile mint takes,
  // and that is precisely the moment somebody is reading the explorer.
  clamped: t.micro === MAX_SAFE,
  kind: transferKind(t),
})

export type StatusInputs = {
  info: { chainId: number; usdc: string } | null
  identity: ChainIdentity | null
  latestBlock: number | null
  transfers: TransferLog[]
  span: number
}

export function buildChainStatus(input: StatusInputs): ChainStatus {
  const { info } = input
  if (!info) {
    // A deployment with no chain configured is a legitimate state, not an error:
    // Base deployments have no tiny-chain at all. The client renders "not
    // configured" rather than "unreachable", which are different sentences.
    return {
      configured: false,
      chainId: null,
      caip2: null,
      usdc: null,
      identity: null,
      reportedChainId: null,
      latestBlock: null,
      reachable: false,
      moneyNote: MONEY_NOTE,
      transfers: [],
      span: input.span,
    }
  }
  const id = input.identity
  return {
    configured: true,
    chainId: info.chainId,
    caip2: `eip155:${info.chainId}`,
    usdc: info.usdc.toLowerCase(),
    identity: id?.state ?? null,
    // Only on mismatch. Sending the node's id on 'match' would invite a client to
    // render it as a second, redundant fact; sending it on 'unknown' would be
    // sending null under a name that implies we asked and got an answer.
    reportedChainId: id?.state === 'mismatch' ? id.reported : null,
    latestBlock: input.latestBlock,
    // Reachability is derived from the block read, NOT from `identity`: identity
    // can be 'match' from a cached config while the node is down, and a height is
    // the only thing here that required the node to actually answer.
    reachable: input.latestBlock !== null,
    moneyNote: MONEY_NOTE,
    transfers: input.transfers.map(shape),
    span: input.span,
  }
}

/**
 * The sentence the web explorer shows, verbatim, because it is a promise about
 * money and three clients must not each phrase it their own way.
 */
export const MONEY_NOTE =
  'Balances here are trial credit — spendable across tiny, not withdrawable as real USDC.'
