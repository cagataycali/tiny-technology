// Backup E2E: boot a scratch anvil with a --state file → put real money on it
// (deploy TinyUSDC, mint) → snapshot with scripts/backup.mjs → DESTROY the state
// file the way a bad shutdown would → prove anvil won't boot on it → restore the
// snapshot → prove the balances came back.
//
// This is the one thing unit tests can't do: assert that the file we store is a
// file anvil will actually load. `anvil_dumpState` returns GZIPPED bytes and
// `--load-state` refuses gzip, so "we have backups" was one wrong `writeFileSync`
// away from being false.
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { deploy, tinyChain, DEPLOYER_KEY } from './deploy.mjs'
import { verifySnapshot, newestBlock, parseSnapshotName } from '../backup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ANVIL = `${homedir()}/.foundry/bin/anvil`
const WORK = join(homedir(), '.tiny-chain-backup-e2e')
const STATE = join(WORK, 'state')
const BACKUPS = join(WORK, 'backups')
const PORT = 8551
const RPC = `http://127.0.0.1:${PORT}`
const HOLDER = '0x976EA74026E726554dB657fA54763abd0C3a0aa9' // anvil #6

const ok = (cond, label) => {
  if (!cond) throw new Error(`BACKUP-E2E FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
}
const waitFor = async (probe, what, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try { if (await probe()) return } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`${what} did not come up`)
}
const up = () => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok)

// Scratch anvil ⟹ its published accounts ARE the right accounts (dev-keys.mjs).
process.env.TINY_CHAIN_ALLOW_DEV_KEYS = '1'

const startNode = (extra = []) => spawn(ANVIL, [
  '--port', String(PORT), '--chain-id', '31337', '--block-time', '1', ...extra,
], { stdio: ['ignore', 'ignore', 'pipe'] })

let node
const cleanup = () => { try { node?.kill() } catch {} ; try { rmSync(WORK, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)

try {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  node = startNode(['--state', STATE, '--state-interval', '1'])
  await waitFor(up, 'anvil')
  const { deployment, abi } = await deploy(RPC, { write: false })
  const pub = createPublicClient({ transport: http(RPC) })
  const chain = tinyChain(RPC, deployment.chainId)
  const treasury = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) })
  await pub.waitForTransactionReceipt({
    hash: await treasury.writeContract({ address: deployment.usdc, abi, functionName: 'mint', args: [HOLDER, parseUnits('42.5', 6)] }),
  })
  const before = await pub.readContract({ address: deployment.usdc, abi, functionName: 'balanceOf', args: [HOLDER] })
  ok(before === parseUnits('42.5', 6), 'a holder has $42.50 of TinyUSDC on the live node')

  const env = { ...process.env, TINY_CHAIN_RPC_URL: RPC, TINY_CHAIN_BACKUP_DIR: BACKUPS, TINY_CHAIN_BACKUP_KEEP: '3' }
  const runBackup = (args = []) => spawnSync(process.execPath, [join(ROOT, 'scripts/backup.mjs'), ...args], { env, encoding: 'utf8' })

  const first = runBackup()
  ok(first.status === 0, `scripts/backup.mjs succeeds (${(first.stdout || '').trim().split('\n')[0]})`)
  const snaps = readdirSync(BACKUPS).filter((n) => parseSnapshotName(n))
  ok(snaps.length === 1, 'exactly one snapshot on disk')
  const snapPath = join(BACKUPS, snaps[0])
  const info = verifySnapshot(readFileSync(snapPath))
  ok(info.bestBlock > 0 && info.accounts > 0, `the snapshot reads back (block ${info.bestBlock}, ${info.accounts} accounts)`)
  // 💾 The finding: dumpState is gzipped, --load-state is not. If the stored file
  // were the raw RPC result, this byte would be 0x1f and the restore below would
  // fail — which is the entire reason decodeDump() exists.
  ok(readFileSync(snapPath)[0] === 0x7b, 'and it is stored as PLAIN JSON, not the gzip anvil hands out')

  // Kill the node and destroy its state file exactly as a bad shutdown would.
  node.kill(); node = null
  await new Promise((r) => setTimeout(r, 500))
  copyFileSync(STATE, join(WORK, 'state.good'))
  writeFileSync(STATE, 'not json at all')

  // ⛔ A corrupt state file is a DEAD chain: anvil refuses to boot at all.
  const broken = startNode(['--state', STATE])
  let brokenErr = ''
  broken.stderr.on('data', (c) => { brokenErr += c })
  const brokenCode = await new Promise((r) => broken.on('exit', r))
  ok(brokenCode !== 0, 'anvil REFUSES to boot on a corrupt --state file (this is why backups matter)')
  ok(/failed to parse|invalid value/.test(brokenErr), 'and says the state file is the reason')

  // Restore = put the snapshot where the state file goes.
  copyFileSync(snapPath, STATE)
  node = startNode(['--state', STATE, '--state-interval', '1'])
  await waitFor(up, 'restored anvil')
  const pub2 = createPublicClient({ transport: http(RPC) })
  const after = await pub2.readContract({ address: deployment.usdc, abi, functionName: 'balanceOf', args: [HOLDER] })
  ok(after === before, `the money survived the restore ($${Number(after) / 1e6} of TinyUSDC back on chain)`)
  ok((await pub2.getBlockNumber()) >= BigInt(info.bestBlock), 'and the chain resumed at or after the snapshot height')

  // 💾 A backup that overwrites a good copy with a worse one is a delete. Feed the
  // runner a genesis node and it must refuse rather than rotate the real copy out.
  node.kill(); node = null
  await new Promise((r) => setTimeout(r, 300))
  node = startNode([]) // fresh chain, block ~0, no state
  await waitFor(up, 'genesis anvil')
  const regression = runBackup()
  ok(regression.status === 1, 'the runner REFUSES to snapshot a rewound chain over a better copy')
  ok(/does not go backwards|already hold/.test(regression.stderr || ''), 'and explains that the node lost state')
  ok(readdirSync(BACKUPS).filter((n) => parseSnapshotName(n)).length === 1, 'the good snapshot is still there, untouched')
  ok(newestBlock(readdirSync(BACKUPS)) === info.bestBlock, 'and it is still the high-water mark')

  const list = runBackup(['--list'])
  ok(list.status === 0 && list.stdout.includes(snaps[0]), '--list shows what we hold')
  const verified = runBackup(['--verify', snaps[0]])
  ok(verified.status === 0 && /block \d+/.test(verified.stdout), '--verify reads a stored snapshot back')
  writeFileSync(join(BACKUPS, 'tiny-chain-20200101T000000Z-blk1.json'), '{"block":{},"accounts"')
  const badVerify = runBackup(['--verify', 'tiny-chain-20200101T000000Z-blk1.json'])
  ok(badVerify.status === 1 && /not parseable|corrupt/.test(badVerify.stderr || ''), '--verify FAILS on a truncated snapshot')

  console.log('BACKUP E2E PASS')
} catch (err) {
  console.error(String(err?.message || err))
  process.exitCode = 1
} finally {
  cleanup()
}
