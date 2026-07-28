// tiny-chain backup policy — the pure half of `scripts/backup.mjs`.
//
// 💾 WHY THIS EXISTS. `~/.tiny-chain/state` is the ONLY copy of every balance on
// this chain: every faucet drip's backing reserve, every settled x402 payment,
// every deposit the worker credited against a Transfer log. It is gitignored (it's
// a ledger, not a secret, so it was deliberately left out of the tiny-secrets
// push), it lives on one Mac mini, and until now nothing copied it anywhere.
//
// Two things make that worse than "we'd lose some test data", both verified
// against anvil 1.7.1 on 2026-07-25:
//
//  1. **A corrupt state file is a DEAD CHAIN, not a degraded one.** anvil refuses
//     to boot on a `--state` file it can't parse:
//         error: invalid value '…/state' for '--state <PATH>':
//         failed to parse json file: expected ident at line 1 column 2
//     and `technology.tiny.chain.plist` sets `KeepAlive: true`, so launchd would
//     restart-loop it forever. There is no "start empty and carry on" mode.
//
//  2. **`anvil_dumpState` returns GZIPPED hex, and `--load-state` REFUSES a
//     gzipped file** (`failed to read from "…snap.json.gz"`). So the obvious
//     backup — save what dumpState hands you — produces a file that cannot be
//     restored, and you find that out on the worst day. `decodeDump()` exists to
//     make the stored form the one anvil can actually load. Round-trip proven:
//     dump → gunzip → file → fresh `anvil --load-state` → balances and block
//     height identical.
//
// The judgement worth reusing is in `regressionRefusal()`: **a backup that
// overwrites a good copy with a worse one is a delete.** If the state file is ever
// lost, anvil comes back at block 0 with 17 pristine accounts — and a rotation
// that faithfully snapshots whatever the node currently says would replicate that
// empty chain over every good copy, on schedule, until they're all gone. The
// backup must be the one process in the system that refuses to follow the node
// downward.
//
// Dependency-free on purpose (same reason as dev-keys.mjs): this has to run from
// launchd, from a cron, and from a recovery shell where `npm i` is not a step.
import { gunzipSync } from 'node:zlib'

/** Keys every anvil state dump has. Absence means we saved something else. */
export const REQUIRED_KEYS = ['block', 'accounts', 'best_block_number', 'blocks']

const GZIP_MAGIC = [0x1f, 0x8b]

/**
 * `anvil_dumpState`'s result → the bytes anvil's `--load-state` will accept.
 *
 * Accepts a 0x-hex string (what the RPC returns) or a Buffer, and gunzips when
 * the payload is actually gzipped — a future anvil that stops compressing must
 * not break this, and neither must one that starts.
 */
export function decodeDump(result) {
  let buf
  if (Buffer.isBuffer(result)) buf = result
  else if (typeof result === 'string') {
    const hex = result.startsWith('0x') || result.startsWith('0X') ? result.slice(2) : result
    if (hex === '' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error('anvil_dumpState did not return hex bytes')
    }
    buf = Buffer.from(hex, 'hex')
  } else throw new Error('anvil_dumpState returned no result')

  if (buf.length === 0) throw new Error('anvil_dumpState returned an empty dump')
  const gzipped = buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]
  return gzipped ? gunzipSync(buf) : buf
}

/** best_block_number arrives as a number on 1.7.1, but hex/decimal strings are cheap to accept. */
function asBlockNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  if (typeof v === 'string') {
    const s = v.trim()
    const n = /^0x/i.test(s) ? Number.parseInt(s, 16) : Number.parseInt(s, 10)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

/**
 * A snapshot is not a backup until it has been read back. Parses the decoded
 * bytes and reports what's in them, or throws with what's wrong.
 *
 * Truncation is the failure mode this catches in practice — a half-written 8MB
 * file parses as "Unterminated string in JSON at position …", verified. Size
 * alone would have called that file fine.
 */
export function verifySnapshot(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '')
  if (text.trim() === '') throw new Error('snapshot is empty')
  let json
  try { json = JSON.parse(text) } catch (e) {
    throw new Error(`snapshot is not parseable JSON (truncated or corrupt): ${String(e.message).slice(0, 90)}`)
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('snapshot is not a JSON object')
  const missing = REQUIRED_KEYS.filter((k) => !(k in json))
  if (missing.length) throw new Error(`snapshot is missing ${missing.join(', ')} — this is not an anvil state dump`)

  const bestBlock = asBlockNumber(json.best_block_number)
  if (!Number.isFinite(bestBlock) || bestBlock < 0) throw new Error('snapshot has no usable best_block_number')
  const accounts = Object.keys(json.accounts || {}).length
  const blocks = Array.isArray(json.blocks) ? json.blocks.length : 0
  return { bestBlock, accounts, blocks, bytes: Buffer.byteLength(text) }
}

/** Chronological-sorting name: stamp first so lexicographic order IS time order. */
export function snapshotName(bestBlock, stamp) {
  const b = asBlockNumber(bestBlock)
  if (!Number.isFinite(b) || b < 0) throw new Error('snapshotName needs a block number')
  if (!/^\d{8}T\d{6}Z$/.test(String(stamp || ''))) throw new Error('snapshotName needs a YYYYMMDDTHHMMSSZ stamp')
  return `tiny-chain-${stamp}-blk${b}.json`
}

export function parseSnapshotName(name) {
  const m = /^tiny-chain-(\d{8}T\d{6}Z)-blk(\d+)\.json$/.exec(String(name || ''))
  return m ? { stamp: m[1], block: Number(m[2]) } : null
}

/** Highest block among our own snapshot files; -1 when there are none. */
export function newestBlock(names) {
  let best = -1
  for (const n of names || []) {
    const p = parseSnapshotName(n)
    if (p && p.block > best) best = p.block
  }
  return best
}

/**
 * 💾 THE ONE RULE: never replace a good copy with a worse one.
 *
 * Returns a refusal string when this snapshot must NOT be stored, or null to
 * proceed. A chain only ever moves forward, so a candidate below what we already
 * hold means the node lost state — exactly when the existing backups are the only
 * thing left, and exactly when a dutiful rotation would eat them.
 *
 * Equal is allowed: an idle chain with `--block-time` still mines, but a manual
 * run seconds apart can legitimately land on the same block, and refusing that
 * would make "back it up right now, before I touch anything" fail.
 */
export function regressionRefusal(candidateBlock, newestStoredBlock) {
  const c = asBlockNumber(candidateBlock)
  const n = asBlockNumber(newestStoredBlock)
  if (!Number.isFinite(c)) return 'refusing to store a snapshot with no block number'
  if (!Number.isFinite(n) || n < 0) return null // nothing stored yet — anything is an improvement
  if (c < n) {
    return `refusing to store block ${c}: we already hold block ${n}. A chain does not go ` +
      'backwards, so the node has lost state — these backups are now the only copy and ' +
      'rotating them would destroy it. Restore instead (see chain/README.md), and move the ' +
      'existing backups aside first if you really mean to start over.'
  }
  return null
}

/**
 * Which files to keep and which to delete, newest-first.
 *
 * The highest-block snapshot is ALWAYS kept regardless of `keep`, because
 * rotation exists to bound disk, not to be able to delete the last good copy.
 * Anything that isn't one of our snapshots is left alone — this function's
 * delete list must never be able to name a file we didn't write.
 */
export function planRotation(names, keep) {
  const mine = (names || []).map((n) => ({ name: n, p: parseSnapshotName(n) })).filter((x) => x.p)
  const others = (names || []).filter((n) => !parseSnapshotName(n))
  mine.sort((a, b) => (a.p.stamp < b.p.stamp ? 1 : a.p.stamp > b.p.stamp ? -1 : b.p.block - a.p.block))
  const n = Number.isFinite(Number(keep)) && Number(keep) >= 1 ? Math.floor(Number(keep)) : 1
  const highest = newestBlock(names)
  const keptNames = []
  const deleted = []
  for (let i = 0; i < mine.length; i++) {
    const isHighest = mine[i].p.block === highest && !keptNames.some((k) => parseSnapshotName(k).block === highest)
    if (i < n || isHighest) keptNames.push(mine[i].name)
    else deleted.push(mine[i].name)
  }
  return { keep: keptNames, delete: deleted, ignored: others }
}

/** UTC stamp in the name format, from an explicit Date (callers own the clock). */
export function utcStamp(date) {
  const iso = new Date(date).toISOString()
  return iso.slice(0, 19).replace(/[-:]/g, '') + 'Z'
}

/**
 * `anvil_dumpState` is deliberately NOT on `rpc-proxy.mjs`'s public allowlist: it
 * hands out the whole state, and the proxy is what the tunnel publishes. So a
 * backup talks to the node's loopback port directly, and this message says so
 * instead of leaving an operator staring at -32601.
 */
export const DUMP_UNAVAILABLE_HINT =
  'anvil_dumpState was refused. Point TINY_CHAIN_RPC_URL at the node itself ' +
  '(default http://127.0.0.1:8545), not at the public proxy — dumpState is off ' +
  'the proxy\'s allowlist on purpose.'
