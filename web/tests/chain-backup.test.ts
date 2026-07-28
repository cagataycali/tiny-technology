// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  decodeDump, verifySnapshot, snapshotName, parseSnapshotName, utcStamp,
  newestBlock, regressionRefusal, planRotation, REQUIRED_KEYS,
  DUMP_UNAVAILABLE_HINT,
} from '@/chain/backup.mjs'

/**
 * 💾 THE CHAIN HAD NO BACKUP (loop item c-o).
 *
 * `~/.tiny-chain/state` is the only copy of every balance on tiny-chain: each
 * faucet drip's backing reserve, each settled x402 payment, each deposit the
 * worker credited against a Transfer log. It's gitignored (a ledger, not a
 * secret — deliberately excluded from the c34 tiny-secrets push), it lives on one
 * Mac mini, and nothing copied it anywhere. Flagged at c30 and again at c35 as
 * "needs a user call on where a copy may live"; the copying itself never needed
 * one, and the two findings below are why it shouldn't have waited.
 *
 * Verified against anvil 1.7.1 on 2026-07-25:
 *
 *  1. **A corrupt state file is a DEAD chain, not a degraded one.** anvil refuses
 *     to boot on an unparseable `--state`:
 *       error: invalid value '…/corrupt.json' for '--state <PATH>':
 *       failed to parse json file: expected ident at line 1 column 2
 *     …and `technology.tiny.chain.plist` has `KeepAlive: true`, so launchd would
 *     restart-loop forever. There is no start-empty-and-carry-on mode.
 *
 *  2. **`anvil_dumpState` returns GZIPPED hex and `--load-state` REFUSES a
 *     gzipped file** (`failed to read from "…snap.json.gz"`). The obvious backup
 *     — store what dumpState hands you — yields a file that cannot be restored,
 *     and you learn that on the worst day. Proven round-trip: dump → gunzip →
 *     file → fresh `anvil --load-state` → identical balance (0x1234567890) and
 *     block height (0x20).
 *
 * The judgement worth reusing: **a backup that overwrites a good copy with a
 * worse one is a delete.** If the state file is lost, anvil returns at block 0
 * with 17 pristine accounts — and a faithful rotation would replicate that empty
 * chain over every good copy, on schedule, until they're gone. So the backup is
 * the one process here that refuses to follow the node downward
 * (`regressionRefusal`), and rotation can never delete the highest-block copy.
 */

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

// The shape anvil 1.7.1 actually emits (top-level keys taken from a live dump of
// the running chain: block, accounts, best_block_number, blocks, transactions,
// historical_states).
const dumpJson = (bestBlock = 4549, accounts = 17) => ({
  block: { number: '0x1194', beneficiary: '0x' + '0'.repeat(40) },
  accounts: Object.fromEntries(
    Array.from({ length: accounts }, (_, i) => [
      '0x' + String(i).padStart(40, '0'),
      { nonce: 0, balance: '0x0', code: '0x', storage: {} },
    ]),
  ),
  best_block_number: bestBlock,
  blocks: Array.from({ length: 3 }, () => ({})),
  transactions: [],
  historical_states: null,
})
const dumpBytes = (o = dumpJson()) => Buffer.from(JSON.stringify(o), 'utf8')
const asRpcResult = (bytes: Buffer) => '0x' + gzipSync(bytes).toString('hex')

describe('decodeDump — the stored form must be the one anvil can LOAD', () => {
  it('gunzips the hex string anvil_dumpState returns', () => {
    // The whole point: dumpState's output is gzipped, and --load-state rejects a
    // gzipped file outright. Storing the bytes verbatim is an unrestorable backup.
    const bytes = dumpBytes()
    expect(decodeDump(asRpcResult(bytes)).toString('utf8')).toBe(bytes.toString('utf8'))
  })

  it('passes through an already-plain dump (a future anvil may stop compressing)', () => {
    const bytes = dumpBytes()
    expect(decodeDump('0x' + bytes.toString('hex')).toString('utf8')).toBe(bytes.toString('utf8'))
  })

  it('accepts a Buffer as well as 0x-hex', () => {
    const bytes = dumpBytes()
    expect(decodeDump(gzipSync(bytes)).toString('utf8')).toBe(bytes.toString('utf8'))
    expect(decodeDump(bytes).toString('utf8')).toBe(bytes.toString('utf8'))
  })

  it('accepts hex without the 0x prefix', () => {
    const bytes = dumpBytes()
    expect(decodeDump(gzipSync(bytes).toString('hex')).toString('utf8')).toBe(bytes.toString('utf8'))
  })

  it('throws on a missing / empty / non-hex result rather than writing junk', () => {
    // A backup that cheerfully writes an error string is worse than no backup:
    // it looks like a copy and satisfies every "do we have backups" check.
    for (const bad of [undefined, null, 42, {}, '', '0x', '0xzz', '0xabc']) {
      expect(() => decodeDump(bad as never), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('verifySnapshot — a snapshot is not a backup until it has been read back', () => {
  it('reports the block, account and block counts of a good dump', () => {
    const info = verifySnapshot(dumpBytes(dumpJson(4549, 17)))
    expect(info.bestBlock).toBe(4549)
    expect(info.accounts).toBe(17)
    expect(info.blocks).toBe(3)
    expect(info.bytes).toBeGreaterThan(0)
  })

  it('catches TRUNCATION, which is the realistic corruption', () => {
    // A half-written 8MB file was verified to fail exactly here
    // ("Unterminated string in JSON at position 7362360"). A size check would
    // have called that file fine — it's 90% of the right size.
    const full = dumpBytes()
    expect(() => verifySnapshot(full.subarray(0, Math.floor(full.length * 0.9))))
      .toThrow(/not parseable JSON/)
  })

  it('rejects an empty or whitespace snapshot', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('   \n')]) {
      expect(() => verifySnapshot(b)).toThrow(/empty/)
    }
  })

  it('rejects JSON that is not an anvil state dump', () => {
    // e.g. a JSON-RPC error object, which is what a wrong port hands back — and
    // which parses perfectly.
    expect(() => verifySnapshot(Buffer.from(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601 } }))))
      .toThrow(/missing|not an anvil state dump/)
    for (const notObj of ['[]', '"hello"', '3', 'null']) {
      expect(() => verifySnapshot(Buffer.from(notObj)), notObj).toThrow()
    }
  })

  it('requires each key the restore path depends on', () => {
    for (const k of REQUIRED_KEYS) {
      const o: Record<string, unknown> = dumpJson()
      delete o[k]
      expect(() => verifySnapshot(Buffer.from(JSON.stringify(o))), k).toThrow(new RegExp(k))
    }
  })

  it('accepts best_block_number as a number OR a hex/decimal string', () => {
    // 1.7.1 emits a number; not worth a broken backup if that ever changes.
    expect(verifySnapshot(Buffer.from(JSON.stringify({ ...dumpJson(), best_block_number: 12 }))).bestBlock).toBe(12)
    expect(verifySnapshot(Buffer.from(JSON.stringify({ ...dumpJson(), best_block_number: '0x1194' }))).bestBlock).toBe(4500)
    expect(verifySnapshot(Buffer.from(JSON.stringify({ ...dumpJson(), best_block_number: '77' }))).bestBlock).toBe(77)
  })

  it('rejects an unusable best_block_number instead of guessing', () => {
    for (const v of [null, 'later', {}, -5, '']) {
      const o = { ...dumpJson(), best_block_number: v }
      expect(() => verifySnapshot(Buffer.from(JSON.stringify(o))), JSON.stringify(v)).toThrow()
    }
  })

  it('accepts a genesis snapshot (block 0 is a legitimate state)', () => {
    // Only regressionRefusal gets to have an opinion about a low block number;
    // verification is about whether the FILE is sound.
    expect(verifySnapshot(dumpBytes(dumpJson(0, 17))).bestBlock).toBe(0)
  })
})

describe('regressionRefusal — a backup must not follow the node downward', () => {
  it('allows the first snapshot when nothing is stored', () => {
    expect(regressionRefusal(4549, -1)).toBeNull()
  })

  it('allows a forward-moving snapshot', () => {
    expect(regressionRefusal(4600, 4549)).toBeNull()
  })

  it('allows an EQUAL block (two runs seconds apart on an idle chain)', () => {
    // Refusing this would break "back it up right now, before I touch anything",
    // which is the single most valuable moment to run a backup.
    expect(regressionRefusal(4549, 4549)).toBeNull()
  })

  it('REFUSES a snapshot below what we already hold — the empty-chain case', () => {
    // Lose ~/.tiny-chain/state and anvil returns at block 0 with pristine
    // accounts. A dutiful rotation would then overwrite every good copy with that
    // empty chain, on schedule. This refusal is the only thing standing there.
    const r = regressionRefusal(0, 4549)
    expect(r).toBeTruthy()
    expect(r).toMatch(/does not go backwards|already hold/)
    expect(r).toMatch(/4549/)
    expect(r).toMatch(/[Rr]estore/) // tells the operator what to do instead
  })

  it('refuses a candidate with no block number at all', () => {
    for (const v of [undefined, null, 'nope', {}]) {
      expect(regressionRefusal(v as never, 10), JSON.stringify(v)).toBeTruthy()
    }
  })

  it('treats a junk stored-block as "nothing stored" and proceeds', () => {
    // An unreadable backup dir must not block taking a fresh copy — that would
    // turn one broken filename into no backups at all.
    for (const v of [undefined, null, NaN, -1, 'nope']) {
      expect(regressionRefusal(500, v as never), JSON.stringify(v)).toBeNull()
    }
  })
})

describe('snapshot names sort chronologically', () => {
  it('round-trips stamp + block', () => {
    const n = snapshotName(4549, '20260725T154100Z')
    expect(n).toBe('tiny-chain-20260725T154100Z-blk4549.json')
    expect(parseSnapshotName(n)).toEqual({ stamp: '20260725T154100Z', block: 4549 })
  })

  it('lexicographic order IS time order (stamp before block in the name)', () => {
    const a = snapshotName(9, '20260725T010000Z')
    const b = snapshotName(1000, '20260725T020000Z')
    expect([b, a].sort()).toEqual([a, b])
  })

  it('utcStamp emits the name format from an explicit Date', () => {
    // Callers own the clock: this repo's tests run under a tsconfig where
    // Date.now() in a workflow script is unavailable, and a pure function that
    // reads the wall clock is untestable anyway.
    expect(utcStamp(new Date('2026-07-25T15:41:00.123Z'))).toBe('20260725T154100Z')
  })

  it('refuses to name a snapshot it cannot describe', () => {
    expect(() => snapshotName(NaN, '20260725T154100Z')).toThrow()
    expect(() => snapshotName(10, 'today')).toThrow()
    expect(() => snapshotName(10, '')).toThrow()
  })

  it('parseSnapshotName ignores anything we did not write', () => {
    for (const n of ['state', 'tiny-chain.json', 'tiny-chain-x-blk1.json', '', undefined, null]) {
      expect(parseSnapshotName(n as never), String(n)).toBeNull()
    }
  })

  it('newestBlock is the high-water mark, -1 when empty', () => {
    expect(newestBlock([])).toBe(-1)
    expect(newestBlock(['state', 'notes.txt'])).toBe(-1)
    expect(newestBlock([snapshotName(5, '20260725T010000Z'), snapshotName(90, '20260724T010000Z')])).toBe(90)
  })
})

describe('planRotation — bounds disk, can never delete the last good copy', () => {
  const n = (block: number, hour: string) => snapshotName(block, `20260725T${hour}0000Z`)

  it('keeps the newest `keep` and deletes the rest', () => {
    const files = [n(10, '01'), n(20, '02'), n(30, '03'), n(40, '04')]
    const plan = planRotation(files, 2)
    expect(plan.keep).toEqual([n(40, '04'), n(30, '03')])
    expect(plan.delete).toEqual([n(20, '02'), n(10, '01')])
  })

  it('ALWAYS keeps the highest-block snapshot, even outside `keep`', () => {
    // The case that matters: a regression got through (or an older anvil wrote a
    // rewound state before the refusal existed), so the best copy is not the
    // newest by time. Rotation exists to bound disk, not to lose the ledger.
    const files = [n(9000, '01'), n(10, '02'), n(20, '03')]
    const plan = planRotation(files, 1)
    expect(plan.keep).toContain(n(9000, '01'))
    expect(plan.delete).not.toContain(n(9000, '01'))
  })

  it('never names a file we did not write', () => {
    const plan = planRotation(['state', 'keys.env', 'logs', n(10, '01'), n(20, '02')], 1)
    expect(plan.delete).toEqual([n(10, '01')])
    expect(plan.ignored).toEqual(['state', 'keys.env', 'logs'])
  })

  it('deletes nothing when there is nothing to spare', () => {
    expect(planRotation([], 5).delete).toEqual([])
    expect(planRotation([n(10, '01')], 5).delete).toEqual([])
    expect(planRotation([n(10, '01')], 1).delete).toEqual([])
  })

  it('a junk `keep` degrades to 1, never to 0', () => {
    // keep=0 would mean "delete everything"; the safe reading of a bad config is
    // the conservative one. (The highest-block rule keeps one alive regardless,
    // but two independent guards is the right number here.)
    for (const k of [0, -3, NaN, undefined, null, 'lots']) {
      const plan = planRotation([n(10, '01'), n(20, '02')], k as never)
      expect(plan.keep.length, String(k)).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('the operator-facing wiring', () => {
  it('warns that dumpState is not on the public proxy allowlist', () => {
    // Someone will point this at chain.example.com and get -32601. The proxy
    // allowlist is c34's work and dumpState must stay off it: it hands out the
    // entire state, including every account's storage.
    expect(DUMP_UNAVAILABLE_HINT).toMatch(/anvil_dumpState/)
    expect(DUMP_UNAVAILABLE_HINT).toMatch(/proxy/)
    expect(src('chain/rpc-proxy.mjs')).not.toContain('anvil_dumpState')
  })

  it('the runner writes via a temp file and renames (no half-file under a real name)', () => {
    const runner = src('chain/scripts/backup.mjs')
    expect(runner).toMatch(/partial/)
    expect(runner).toMatch(/renameSync/)
    // and it re-reads from DISK before the rename — verifying the in-memory
    // buffer proves nothing about what landed.
    expect(runner).toMatch(/verifySnapshot\(readFileSync\(tmp\)\)/)
  })

  it('the runner refuses a regression before it writes anything', () => {
    const runner = src('chain/scripts/backup.mjs')
    const refusalAt = runner.indexOf('regressionRefusal(')
    const writeAt = runner.indexOf('writeFileSync(tmp')
    expect(refusalAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(refusalAt)
  })

  it('is reachable as an npm script and documented', () => {
    expect(JSON.parse(src('chain/package.json')).scripts.backup).toMatch(/backup\.mjs/)
    expect(src('chain/README.md')).toMatch(/backup/i)
    expect(src('chain/README.md')).toMatch(/load-state/)
  })
})
