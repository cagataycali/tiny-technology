/**
 * QBFT header encoding — the one copy of the rule that cost a cycle to find.
 *
 * Extracted from slashing-e2e.mjs when a second suite needed it. It is exactly
 * the kind of knowledge that must not be duplicated: the seal-digest / anchor
 * split is invisible at round 0, so a drifted second copy would agree with the
 * first on every block a quiet devnet produces and disagree only during a real
 * round change — i.e. only when a conviction is actually at stake.
 */
import { keccak256, toRlp, fromRlp } from 'viem'
import { sign } from 'viem/accounts'

/** RLP wants minimal big-endian integers: strip leading zeros, 0 → empty. */
export const trim = (h) => {
  if (h === undefined || h === null) return '0x'
  let s = h.slice(2).replace(/^0+/, '')
  if (s.length % 2) s = '0' + s
  return s === '' ? '0x' : '0x' + s
}

/**
 * Re-encode a block header the way QBFT hashes it: RLP of the header with
 * extraData's SEAL LIST EMPTIED. Discovered empirically against besu 26.7.0 —
 * plain RLP of the header as returned by eth_getBlockByNumber does NOT reproduce
 * the block hash, because the commit seals are excluded from it. That exclusion is
 * exactly what makes the seals signable: they sign the hash they are attached to.
 *
 * ⚠️ ONE PREIMAGE, TWO DIGESTS, and this is where a real bug hid. `forAnchor`
 * additionally empties extraData's ROUND, because the canonical block hash does and
 * the seal digest does not:
 *
 *     seal digest = keccak(seallessHeader(b))                  — round KEPT
 *     block hash  = keccak(seallessHeader(b, {forAnchor:true})) — round EMPTIED
 *
 * At round 0 the two are byte-identical, so a suite that only ever sees round-0
 * blocks cannot tell them apart — which is exactly what happened: slashing-e2e
 * passed while asserting "the seal digest IS the block hash", until the validator
 * set grew to 5, real round changes appeared, and the SAME assertion started
 * failing against an unchanged contract. Measured over 59 blocks (15 at round ≠ 0):
 * each digest matches its own target 59/59, and neither matches the other's at
 * round ≠ 0.
 */
export function seallessHeader(b, { extraOverride, forAnchor = false } = {}) {
  const ex = fromRlp(b.extraData, 'hex')
  const inner = extraOverride ? fromRlp(extraOverride, 'hex') : [ex[0], ex[1], ex[2], ex[3], []]
  const extra = toRlp([inner[0], inner[1], inner[2], forAnchor ? '0x' : inner[3], inner[4]])
  const fields = [
    b.parentHash, b.sha3Uncles, b.miner, b.stateRoot, b.transactionsRoot, b.receiptsRoot, b.logsBloom,
    trim(b.difficulty), trim(b.number), trim(b.gasLimit), trim(b.gasUsed), trim(b.timestamp),
    extra, b.mixHash, b.nonce,
  ]
  if (b.baseFeePerGas !== undefined && b.baseFeePerGas !== null) fields.push(trim(b.baseFeePerGas))
  if (b.withdrawalsRoot) fields.push(b.withdrawalsRoot)
  return toRlp(fields)
}

/** The block hash of a header, per the anchor rule. */
export const anchorOf = (b, opts) => keccak256(seallessHeader(b, { ...opts, forAnchor: true }))

/** The seals a block carries, as 65-byte hex strings. */
export const sealsOf = (b) => fromRlp(b.extraData, 'hex')[4]

/** extraData's round field, as a bigint. */
export const roundOf = (b) => {
  const r = fromRlp(b.extraData, 'hex')[3]
  return r === '0x' || !r ? 0n : BigInt(r)
}

/** Sign a digest with a raw key, returning packed 65-byte (r,s,v). */
export async function sealWith(privateKey, hash) {
  const s = await sign({ hash, privateKey })
  return s.r + s.s.slice(2) + (s.v === 27n || s.v === 28n
    ? Number(s.v).toString(16).padStart(2, '0')
    : Number(s.yParity + 27n ?? 0).toString(16).padStart(2, '0'))
}

/**
 * Manufacture a genuine equivocation against a real canonical block.
 *
 * We can't ask a Besu node to double-sign, and we don't need to: equivocation is
 * "one key, two signatures, same height and round". The conflicting header keeps
 * the canonical block's height and round and changes only its vanity bytes, so the
 * pair is cryptographically indistinguishable from a validator that signed two
 * blocks at one height — which is the whole point. A court that convicts this
 * convicts the real thing.
 */
export async function forgeEquivocation(canonRaw, culpritKey) {
  const ex = fromRlp(canonRaw.extraData, 'hex')
  const canonHeader = seallessHeader(canonRaw)
  const conflictHeader = seallessHeader(canonRaw, {
    extraOverride: toRlp([keccak256('0xdeadbeef'), ex[1], ex[2], ex[3], []]),
  })
  return {
    canonHeader,
    conflictHeader,
    canonSeal: await sealWith(culpritKey, keccak256(canonHeader)),
    conflictSeal: await sealWith(culpritKey, keccak256(conflictHeader)),
  }
}
