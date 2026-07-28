#!/usr/bin/env node
/**
 * P1 acceptance for the multi-node tiny chain (8470).
 *
 * The claim being tested is NOT "besu starts" — a single node starts fine and
 * proves nothing. It's the claim anvil could never satisfy:
 *
 *   1. four INDEPENDENT processes are peered (each sees the other three),
 *   2. blocks are being PRODUCED by consensus, not by one process's timer,
 *   3. all four AGREE on the same block hash at the same height,
 *   4. more than one validator actually proposes (round-robin is live, so the
 *      network survives losing any single node),
 *   5. the chain id is 8470 — i.e. this is NOT the live 8469 talking.
 *
 * (3) is the load-bearing assertion. Four nodes each producing their own fork
 * would still show "blocks increasing" on every RPC port; agreement on hash is
 * what makes it one chain.
 *
 * Usage: node chain/multinode/scripts/devnet-e2e.mjs [nodeCount]
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assessValidatorSet, assessSetLiveness, validatorSetSummary } from '../validator-set-health.mjs'

const NODES = Number(process.argv[2] || 4)
const rpcUrl = (n) => `http://127.0.0.1:${8600 + n}`
const nodeIds = Array.from({ length: NODES }, (_, i) => i + 1)

// The seat bounds come from the DEPLOYMENT, not from constants here: they are
// contract parameters, and a hardcoded copy would silently disagree with the chain
// after any redeploy. Absent file ⇒ fall back to the predicate's own defaults.
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
let deployment = {}
try {
  deployment = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
} catch {
  /* pre-P2 devnet: header-mode, no validator contract deployed yet */
}

let failures = 0
const ok = (cond, msg, detail = '') => {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function rpc(n, method, params = []) {
  const res = await fetch(rpcUrl(n), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method} on node${n}: ${json.error.message}`)
  return json.result
}

const hexToNum = (h) => Number(BigInt(h))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(label, fn, tries = 60, gap = 2_000) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true
    } catch {
      /* node still starting */
    }
    if (i === 0) console.log(`  … waiting for ${label}`)
    await sleep(gap)
  }
  return false
}

/**
 * Send a zero-value tx from a genesis-funded account and see if it lands.
 *
 * Uses a genesis-funded sender deliberately: an unfunded one CANNOT be included
 * (proven on this devnet — see qbft-config.json's alloc comment), so probing
 * with a fresh key would report a broken chain on a healthy one.
 */
async function sendProbeTx() {
  let viem, accounts
  try {
    viem = await import('viem')
    accounts = await import('viem/accounts')
  } catch {
    return { ok: false, detail: 'viem not installed — run npm i at the repo root' }
  }
  // anvil #3, funded in the genesis alloc. Not #0: that's the deployer, and
  // sharing its nonce with a concurrent deploy script would wedge both.
  const key = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
  const chainId = hexToNum(await rpc(1, 'eth_chainId'))
  const chain = viem.defineChain({
    id: chainId, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl(1)] } },
  })
  const account = accounts.privateKeyToAccount(key)
  const pub = viem.createPublicClient({ transport: viem.http(rpcUrl(1)) })
  const balance = await pub.getBalance({ address: account.address })
  if (balance === 0n) {
    return { ok: false, detail: `probe sender ${account.address} has no balance — genesis alloc is empty, so NO tx can ever be included` }
  }
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(rpcUrl(1)) })
  try {
    const hash = await wallet.sendTransaction({
      to: '0x0000000000000000000000000000000000000001',
      value: 0n, gas: 30_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 40_000 })
    return { ok: true, detail: `mined in block ${receipt.blockNumber}` }
  } catch (e) {
    return { ok: false, detail: `tx never mined: ${(e.shortMessage || e.message).split('\n')[0]}` }
  }
}

async function main() {
  console.log(`\n🔗 multi-node tiny chain — P1 acceptance (${NODES} nodes)\n`)

  console.log('all nodes answering RPC')
  const up = await waitFor('nodes to accept RPC', async () => {
    const ids = await Promise.all(nodeIds.map((n) => rpc(n, 'eth_chainId')))
    return ids.every((id) => id)
  })
  ok(up, `${NODES} nodes answering JSON-RPC`)
  if (!up) {
    console.log('\n  nodes never came up — check ~/.tiny-chain/multinode/logs/\n')
    process.exit(1)
  }

  console.log('\nchain identity')
  const chainIds = await Promise.all(nodeIds.map((n) => rpc(n, 'eth_chainId')))
  ok(
    chainIds.every((id) => hexToNum(id) === 8470),
    'every node reports chain 8470 (NOT the live 8469)',
    `got ${chainIds.map(hexToNum).join(', ')}`,
  )

  console.log('\npeering — this is what anvil cannot do')
  const peered = await waitFor('peers to find each other', async () => {
    const counts = await Promise.all(nodeIds.map((n) => rpc(n, 'net_peerCount')))
    return counts.every((c) => hexToNum(c) >= NODES - 1)
  })
  const peerCounts = await Promise.all(nodeIds.map((n) => rpc(n, 'net_peerCount')))
  ok(
    peered,
    `each node peers with the other ${NODES - 1}`,
    `peer counts: ${peerCounts.map(hexToNum).join(', ')}`,
  )

  console.log('\nblock production by consensus')
  const start = hexToNum(await rpc(1, 'eth_blockNumber'))
  const producing = await waitFor('blocks to advance', async () => {
    return hexToNum(await rpc(1, 'eth_blockNumber')) > start + 2
  }, 30)
  const now = hexToNum(await rpc(1, 'eth_blockNumber'))
  ok(producing, `chain advanced (${start} → ${now})`)

  console.log('\nagreement — four nodes, ONE chain')
  // Compare at a height every node has, not at each node's own head: heads differ
  // by a block during normal operation, and comparing different heights would fail
  // a healthy network (or, worse, pass a forked one by accident).
  const heads = await Promise.all(nodeIds.map((n) => rpc(n, 'eth_blockNumber')))
  const common = Math.min(...heads.map(hexToNum)) - 1
  const blocks = await Promise.all(
    nodeIds.map((n) => rpc(n, 'eth_getBlockByNumber', [`0x${common.toString(16)}`, false])),
  )
  const hashes = blocks.map((b) => b?.hash)
  ok(
    hashes.every((h) => h && h === hashes[0]),
    `all ${NODES} nodes agree on the hash of block ${common}`,
    `hashes: ${hashes.map((h) => (h ? h.slice(0, 14) : 'null')).join(', ')}`,
  )

  console.log('\nvalidator set + rotation')
  const validators = await rpc(1, 'qbft_getValidatorsByBlockNumber', ['latest'])
  // ⚠️ NOT `validators.length === NODES`. That is what this test used to assert,
  // and it failed the first time the chain did what it exists to do: in P5 a
  // stranger staked, rotate() seated them, and a 4-node devnet correctly reported
  // 5 validators — so the suite called an open chain broken. On a permissionless
  // chain the healthy state is a RANGE, and the seat count is deliberately
  // decoupled from how many nodes WE run (a full node earns no seat; a seated
  // validator need not be ours). Assert the rules besu actually enforces instead.
  const bounds = { min: deployment.minValidators ?? 4, max: deployment.maxValidators ?? 21 }
  const health = assessValidatorSet(validators, bounds)
  ok(
    health.ok,
    health.ok ? validatorSetSummary(health.count, NODES, bounds) : `validator set is unhealthy`,
    health.reason ? `${health.reason}\n      got ${JSON.stringify(validators)}` : '',
  )
  // Round-robin means distinct proposers across consecutive blocks. If one node
  // produced everything, losing it would halt the chain — the opposite of the
  // resilience a multi-node network is for.
  // ⚠️ The window is sized off the SEAT COUNT, not off NODES. It used to be
  // `NODES * 2`, which is only coincidentally enough: seats grow when strangers
  // join (that is the product), and a window shorter than one round-robin cannot
  // tell a silent validator from one that has not had its turn. Two full rotations
  // gives every seat a chance to appear even if a round was skipped.
  const seatCount = Array.isArray(validators) ? validators.length : NODES
  const window = Math.min(Math.max(seatCount * 2, NODES * 2), common)
  const recent = await Promise.all(
    Array.from({ length: window }, (_, i) =>
      rpc(1, 'eth_getBlockByNumber', [`0x${(common - i).toString(16)}`, false]),
    ),
  )
  const proposers = new Set(recent.map((b) => b?.miner?.toLowerCase()).filter(Boolean))
  ok(
    proposers.size > 1,
    `blocks are proposed by ${proposers.size} different validators (round-robin live)`,
    `proposers: ${[...proposers].join(', ')}`,
  )

  // 💀 The check whose ABSENCE let this devnet halt. Every assertion above passed
  // for the hour before block 11857 stopped the chain: 5 seats within a 4–21 range,
  // all four live nodes agreeing, blocks advancing, txs mining. What none of them
  // asked was whether the SEATS could still reach quorum — one seat belonged to a
  // joiner from the P2 test whose process had gone away, and quorum for 5 seats is
  // 4, so the margin was already zero. node1's JVM died and there was no consensus
  // left. Reported as a failed check rather than a warning line precisely because
  // the state is unrecoverable on-chain once it tips: rotate() needs a quorum to
  // mine, so the fix disappears at the moment it is needed.
  console.log('\nliveness margin — can the SEATED set still commit?')
  const liveness = assessSetLiveness(validators, [...proposers], { window })
  ok(
    liveness.ok,
    `${liveness.live} of ${liveness.seats} seats proposing, quorum ${liveness.quorum} — margin ${liveness.margin} failure(s) to spare`,
    liveness.reason || '',
  )

  console.log('\ngas is free but METERED')
  const gasPrice = await rpc(1, 'eth_gasPrice')
  // Deliberately NOT labelled "no native coin needed": zero-price gas does not
  // imply zero-balance senders. A sender absent from state gets its txs pooled,
  // gossiped, and then never included — silently. See the alloc comment in
  // qbft-config.json; funding the same sender 1 wei fixes the same zero-fee tx.
  ok(hexToNum(gasPrice) === 0, 'gas price is 0 — a tx costs nothing to send')
  const latest = await rpc(1, 'eth_getBlockByNumber', ['latest', false])
  ok(
    hexToNum(latest.gasLimit) > 0,
    'block gas limit is non-zero — free ≠ unmetered (design §0.1)',
    `gasLimit ${latest.gasLimit}`,
  )

  // The claim above is worth nothing unless a tx actually lands. This check is
  // what would have caught the empty-alloc trap in seconds: a chain can look
  // flawless on every other metric here while being unable to include a single
  // transaction, because the pool accepts and gossips them and then silently
  // never selects them.
  //
  // It SENDS one rather than scanning recent blocks for any tx: scanning tells
  // you when the chain was last used, not whether it works now — an idle devnet
  // would fail a passing network, and a long-dead one would pass on history.
  console.log('\ntxs actually get INCLUDED (not just accepted)')
  const sent = await sendProbeTx()
  ok(sent.ok, 'a freshly sent tx is mined', sent.detail)

  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ P1 verified: a real multi-node chain'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.message}\n`)
  process.exit(1)
})
