/**
 * 🔍 tiny-chain explorer — the PURE half.
 *
 * Everything the /chain pages decide that isn't a fetch lives here so it can
 * be asserted: hash/address validation (these become URL segments — a bad
 * validator is an open redirect into RPC queries), ERC-20 Transfer log
 * decoding, and the uint256→dollars clamp. The pages are thin RPC callers.
 *
 * Money display uses the same trap-guard family as Wallet.swift:207 /
 * ChatStreamDecoder.safeMicro: a uint256 is 78 decimal digits and Number()
 * happily makes it Infinity — an explorer that crashes (or prints "$Infinity")
 * on one hostile mint would be unusable exactly when someone is auditing that
 * mint. Values above Number.MAX_SAFE_INTEGER clamp and SAY so.
 */

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 event topic. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export const isTxHash = (s: unknown): s is string =>
  typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)

export const isAddress = (s: unknown): s is string =>
  typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)

/** Where a search-box string should go. null = neither shape, stay put. */
export const lookupTarget = (q: unknown): 'tx' | 'address' | null => {
  const s = String(q ?? '').trim()
  if (isTxHash(s)) return 'tx'
  if (isAddress(s)) return 'address'
  return null
}

/** 0xabcd…1234 — recognizable without a wall of hex. */
export const shortHex = (s: string, head = 6, tail = 4): string =>
  s.length > head + tail + 2 ? `${s.slice(0, head + 2)}…${s.slice(-tail)}` : s

/** A 32-byte indexed-address topic → the 20-byte address (lowercased). */
export const addressFromTopic = (topic: unknown): string => {
  const t = String(topic ?? '')
  if (!/^0x[0-9a-fA-F]{64}$/.test(t)) return ''
  return `0x${t.slice(-40).toLowerCase()}`
}

/**
 * Hex quantity → JS number, clamped. `null` for junk (absent ≠ zero — a log
 * with no data field is malformed, not a free transfer); MAX_SAFE_INTEGER for
 * anything wider (the clamp is visible: usdMicro formats it as the clamp).
 */
export const hexToNumber = (hex: unknown): number | null => {
  const h = String(hex ?? '')
  if (!/^0x[0-9a-fA-F]+$/.test(h)) return null
  const big = BigInt(h)
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(big)
}

/** Micro-USDC → dollars for display; the clamped ceiling reads as such. */
export const usdMicro = (micro: number | null): string => {
  if (micro === null || !Number.isFinite(micro)) return '—'
  if (micro >= Number.MAX_SAFE_INTEGER) return '> $9e9 (clamped)'
  const usd = micro / 1e6
  return usd >= 0.01 || usd === 0
    ? `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${usd.toFixed(6).replace(/0+$/, '')}`
}

export type TransferLog = {
  from: string
  to: string
  micro: number | null
  txHash: string
  blockNumber: number | null
}

/**
 * Decode one eth_getLogs entry as an ERC-20 Transfer. null when it isn't one
 * (wrong topic, missing indexed fields) — a decoder that guesses renders a
 * transfer that never happened, on the page whose job is on-chain truth.
 */
export const decodeTransferLog = (log: any): TransferLog | null => {
  if (!log || log.topics?.[0] !== TRANSFER_TOPIC) return null
  const from = addressFromTopic(log.topics?.[1])
  const to = addressFromTopic(log.topics?.[2])
  if (!from || !to) return null
  return {
    from,
    to,
    micro: hexToNumber(log.data),
    txHash: isTxHash(log.transactionHash) ? log.transactionHash : '',
    blockNumber: hexToNumber(log.blockNumber),
  }
}

/**
 * getLogs fromBlock for "recent activity": the last `span` blocks, floored at
 * genesis. The node prunes history (anvil --prune-history), so an unbounded
 * range is both slow and partially unanswerable — recent is the honest scope.
 */
export const lookbackFrom = (latest: number, span: number): number =>
  Math.max(0, Math.floor(latest) - Math.max(0, Math.floor(span)))

/** Mints come from the zero address — worth naming on a chain whose supply is ours. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const transferKind = (t: { from: string; to: string }): 'mint' | 'burn' | 'transfer' =>
  t.from === ZERO_ADDRESS ? 'mint' : t.to === ZERO_ADDRESS ? 'burn' : 'transfer'
