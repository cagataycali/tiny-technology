#!/usr/bin/env node
// tiny-chain backup — take a restorable snapshot of the live chain's state.
//
//   node scripts/backup.mjs                 # snapshot + rotate
//   node scripts/backup.mjs --list          # what we hold
//   node scripts/backup.mjs --verify <file> # read one back
//
// Env: TINY_CHAIN_RPC_URL (default http://127.0.0.1:8545 — the NODE, not the
//      public proxy: anvil_dumpState is off the proxy allowlist on purpose),
//      TINY_CHAIN_BACKUP_DIR (default ~/.tiny-chain/backups),
//      TINY_CHAIN_BACKUP_KEEP (default 24 — the newest snapshot is kept
//      regardless, rotation bounds disk and must never delete the last copy).
//
// The policy — and the reasoning for every rule — lives in ../backup.mjs, which
// is pure and unit-tested (tests/chain-backup.test.ts). This file is only I/O:
// talk to the node, write the file, read it back, rotate.
//
// ⚠️ Restore is NOT automatic, deliberately. See chain/README.md: booting a node
// on an older state silently rewinds every balance, so it is a decision a human
// makes with the block numbers in front of them.
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decodeDump, verifySnapshot, snapshotName, utcStamp, newestBlock,
  regressionRefusal, planRotation, DUMP_UNAVAILABLE_HINT,
} from '../backup.mjs'

const RPC = process.env.TINY_CHAIN_RPC_URL || 'http://127.0.0.1:8545'
const DIR = process.env.TINY_CHAIN_BACKUP_DIR || join(homedir(), '.tiny-chain', 'backups')
const KEEP = Number(process.env.TINY_CHAIN_BACKUP_KEEP || 24)

const die = (msg) => { console.error(msg); process.exit(1) }
const names = () => { try { return readdirSync(DIR) } catch { return [] } }

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120_000), // an 8MB gzipped dump is not instant
  })
  const json = await res.json()
  if (json.error) {
    const extra = method === 'anvil_dumpState' ? `\n${DUMP_UNAVAILABLE_HINT}` : ''
    throw new Error(`${method} failed: ${json.error.message || JSON.stringify(json.error)}${extra}`)
  }
  return json.result
}

if (process.argv.includes('--list')) {
  const files = names().filter((n) => /^tiny-chain-.*\.json$/.test(n)).sort().reverse()
  if (!files.length) die(`no snapshots in ${DIR} — run \`npm run backup\` (nothing is backing up this chain yet)`)
  for (const f of files) {
    const size = (statSync(join(DIR, f)).size / 1e6).toFixed(1)
    console.log(`${f}  ${size} MB`)
  }
  console.log(`\n${files.length} snapshot(s) in ${DIR}, newest block ${newestBlock(files)}`)
  process.exit(0)
}

const verifyIdx = process.argv.indexOf('--verify')
if (verifyIdx !== -1) {
  const target = process.argv[verifyIdx + 1] || die('--verify needs a file path')
  const path = target.includes('/') ? target : join(DIR, target)
  try {
    const info = verifySnapshot(readFileSync(path))
    console.log(`✓ ${path}\n  block ${info.bestBlock}, ${info.accounts} accounts, ${info.blocks} blocks, ${(info.bytes / 1e6).toFixed(1)} MB`)
  } catch (e) { die(`✗ ${path}\n  ${e.message}`) }
  process.exit(0)
}

try {
  const chainId = await rpc('eth_chainId')
  const bytes = decodeDump(await rpc('anvil_dumpState'))
  // Read it back BEFORE it counts as a backup: an unverified snapshot is a
  // rumour, and it's the file we'd bet every balance on.
  const info = verifySnapshot(bytes)

  const stored = names()
  const refusal = regressionRefusal(info.bestBlock, newestBlock(stored))
  if (refusal) die(`💾 ${refusal}`)

  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const name = snapshotName(info.bestBlock, utcStamp(new Date()))
  // Write to a temp name and rename: a reader (or a rotation) must never see a
  // half-written file under a real snapshot name. rename(2) is atomic in-dir.
  const tmp = join(DIR, `.${name}.partial`)
  writeFileSync(tmp, bytes, { mode: 0o600 })
  verifySnapshot(readFileSync(tmp)) // and again, from disk — what we wrote is what's there
  renameSync(tmp, join(DIR, name))
  console.log(`💾 ${name} — chain ${parseInt(chainId, 16)}, block ${info.bestBlock}, ${info.accounts} accounts, ${(info.bytes / 1e6).toFixed(1)} MB`)

  const plan = planRotation(names(), KEEP)
  for (const f of plan.delete) unlinkSync(join(DIR, f))
  if (plan.delete.length) console.log(`   rotated out ${plan.delete.length} (keeping ${plan.keep.length}, newest always kept)`)
  console.log(`   ${DIR}`)
} catch (e) {
  die(`backup failed: ${e.message}`)
}
