#!/usr/bin/env node
/**
 * 💀 → 🫀 RESTORE THE LIVENESS MARGIN on 8470.
 *
 * This is `assessSetLiveness`'s advice made executable, written the same cycle the
 * devnet HALTED at block 11857 for the reason that predicate now detects:
 *
 *   5 seats, quorum 4 (ceil(2n/3)), and only 4 seats backed by a live process.
 *   Margin 0. node1's JVM died an hour later and consensus stopped.
 *
 * ⚠️ THE FIX IS NOT rotate(). That was this cycle's wrong first instinct, and the
 * live chain disproved it: seats are awarded by STAKE, and the abandoned seat was
 * held by a P2 joiner that had staked 2.5B — MORE than any founder's 2.0B. So
 * rotate() succeeds and re-seats the ghost. Worse, its key was ephemeral and is
 * gone, so nobody can ever `exit()` it. That seat is permanent.
 *
 * 🔑 So the only real remedy is to ADD live validators, not remove dead ones. That
 * works because seats are not scarce here (cap 21, five candidates eligible), and
 * it is the honest version of the advice: a set's fault tolerance comes from how
 * many of its members are actually there.
 *
 * What this does, and why each step is the way it is:
 *
 *  1. Uses the ALREADY-SYNCED node from `join-tiny-chain.sh` (port 8555) instead of
 *     starting a fifth besu. That node re-executed the whole chain from the
 *     published genesis, so it is a genuine independent validator — and reusing it
 *     means the fix needs no new process to babysit.
 *  2. Refuses to touch a set whose margin is already positive. Staking another
 *     validator "just in case" raises the quorum too (5 → 6 seats moves quorum
 *     4 → 4, but 6 → 7 moves it 4 → 5), so more seats is NOT monotonically safer.
 *     Only add when the margin is short.
 *  3. Asserts the margin actually IMPROVED afterward, by re-reading the seats and
 *     watching for the new validator to propose. "The tx mined" is not the claim;
 *     "the set can now survive a failure" is.
 *
 * Usage:  node chain/multinode/scripts/restore-liveness-margin.mjs [--dry-run]
 */
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { assessSetLiveness, qbftQuorum } from '../validator-set-health.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const JOIN_HOME = process.env.TINY_JOIN_HOME || join(homedir(), '.tiny-chain/joiner')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const DRY = process.argv.includes('--dry-run')

// anvil #0 — the devnet deployer, the only key here that still holds stake tokens
// to grant (P3 took mint() away from every key, so this is a TRANSFER of existing
// supply). On a real network the new validator brings its own stake; this is a
// devnet convenience, labelled as one. Same default + env override as its siblings.
const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const REGISTRY_ABI = parseAbi([
  'function stake(uint256 amount)',
  'function rotate()',
  'function stakeOf(address) view returns (uint256)',
  'function minStake() view returns (uint256)',
  'function maxValidators() view returns (uint256)',
  'function getValidators() view returns (address[])',
  'function isActive(address) view returns (bool)',
  'function rotatable() view returns (bool)',
  'function eligibleCount() view returns (uint256)',
])
const ERC20_ABI = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
])

let failures = 0
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

/** Proposers over a window long enough to cover a full round-robin. */
async function recentProposers(url, seats) {
  const head = Number(BigInt(await rpcCall(url, 'eth_blockNumber')))
  const window = Math.max(seats * 2, 8)
  const seen = new Set()
  for (let i = 0; i < window && head - i > 0; i++) {
    const b = await rpcCall(url, 'eth_getBlockByNumber', [`0x${(head - i).toString(16)}`, false])
    if (b?.miner) seen.add(b.miner.toLowerCase())
  }
  return { proposers: [...seen], window, head }
}

async function main() {
  console.log('\n🫀 restore the 8470 liveness margin\n')

  const depFile = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(depFile)) {
    console.error(`no deployment file at ${depFile} — run deploy-validators.mjs first\n`)
    process.exit(1)
  }
  const dep = JSON.parse(readFileSync(depFile, 'utf8'))
  const registry = dep.validatorContract
  const usdc = dep.usdc

  const chainId = Number(BigInt(await rpcCall(RPC, 'eth_chainId')))
  // Same guard every script in this directory carries: production settles on 8469
  // and this script STAKES and ROTATES. Refusing on the wrong chain id is the
  // difference between a devnet tool and an accident.
  if (chainId !== 8470) {
    console.error(`refusing to run: chain id is ${chainId}, expected 8470 (the live chain is 8469)\n`)
    process.exit(1)
  }
  console.log(`chain 8470, registry ${registry}`)

  const chain = defineChain({
    id: 8470, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const pub = createPublicClient({ transport: http(RPC) })
  const read = (fn, args = []) => pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: fn, args })

  // ── 1. diagnose, using the SAME predicate the acceptance suite uses ──────────
  console.log('\ndiagnosis')
  const seats = await read('getValidators')
  const { proposers, window } = await recentProposers(RPC, seats.length)
  const before = assessSetLiveness(seats, proposers, { window })
  console.log(`  seats ${before.seats}, live ${before.live}, quorum ${before.quorum}, margin ${before.margin}`)
  if (before.silent.length) console.log(`  silent seat(s): ${before.silent.join(', ')}`)

  if (before.ok) {
    console.log(`\n✅ margin is already ${before.margin} — nothing to do.`)
    // Deliberately NOT "stake another validator anyway". More seats raises the
    // quorum too, so padding a healthy set can REDUCE tolerance (6→7 seats moves
    // quorum 4→5). Only act when the margin is actually short.
    console.log('   (adding seats to a healthy set can lower tolerance — quorum grows with seats)\n')
    process.exit(0)
  }

  // ── 2. find a live, synced, unseated node to promote ────────────────────────
  console.log('\ncandidate to promote')
  const joinerKeyFile = join(JOIN_HOME, 'data/key')
  if (!existsSync(joinerKeyFile)) {
    console.error(`\nno synced spare node: ${joinerKeyFile} does not exist.`)
    console.error('  start one first:  bash chain/multinode/scripts/join-tiny-chain.sh --background --rpc-port 8555 --p2p-port 30500\n')
    process.exit(1)
  }
  const raw = readFileSync(joinerKeyFile, 'utf8').trim()
  const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`)
  console.log(`  ${account.address} (from ${joinerKeyFile})`)

  // It must be SYNCED, not merely alive. A validator that holds a different chain
  // would be seated and then fail to agree — worse than an empty seat, because it
  // counts toward quorum while voting on another history.
  const joinerRpc = process.env.TINY_JOINER_RPC || 'http://127.0.0.1:8555'
  let synced = false
  try {
    const jHead = Number(BigInt(await rpcCall(joinerRpc, 'eth_blockNumber')))
    const oHead = Number(BigInt(await rpcCall(RPC, 'eth_blockNumber')))
    const common = Math.min(jHead, oHead) - 1
    const [a, b] = await Promise.all([
      rpcCall(joinerRpc, 'eth_getBlockByNumber', [`0x${common.toString(16)}`, false]),
      rpcCall(RPC, 'eth_getBlockByNumber', [`0x${common.toString(16)}`, false]),
    ])
    synced = Boolean(a?.hash) && a.hash === b?.hash
    ok(synced, `spare node agrees on block ${common} (it re-executed our history)`,
      synced ? '' : `hashes differ: ${a?.hash} vs ${b?.hash}`)
  } catch (e) {
    ok(false, 'spare node answers RPC and agrees on a common block', e.message)
  }
  if (!synced) {
    console.log('\n❌ refusing to seat a node that does not hold our chain\n')
    process.exit(1)
  }
  ok(!(await read('isActive', [account.address])), 'spare node is not already seated')

  if (DRY) {
    console.log('\n--dry-run: would grant stake, stake, and rotate. Nothing sent.\n')
    process.exit(0)
  }

  // ── 3. stake it, by exactly the same rule as any stranger ───────────────────
  console.log('\nstaking (same rule as any joiner: hold minStake, call stake(), rotate())')
  const minStake = await read('minStake')
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const FREE = { gas: 3_000_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
  const dWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const jWallet = createWalletClient({ account, chain, transport: http(RPC) })

  // The new validator needs BOTH stake tokens and a non-zero native balance:
  // zero-price gas does NOT mean a zero-balance sender can transact (an account
  // absent from state has its txs pooled, gossiped, and then never included —
  // silently). 1 wei is enough; this is the devnet's documented onboarding drip.
  const nativeBal = await pub.getBalance({ address: account.address })
  if (nativeBal === 0n) {
    const h = await dWallet.sendTransaction({ to: account.address, value: 10n ** 15n, ...FREE })
    await pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })
    console.log('  funded the new validator with gas money (0-price gas ≠ 0-balance senders)')
  }
  const stakeBal = await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })
  if (stakeBal < minStake) {
    const h = await dWallet.writeContract({
      address: usdc, abi: ERC20_ABI, functionName: 'transfer',
      args: [account.address, minStake * 2n], ...FREE,
    })
    await pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })
    console.log(`  transferred ${(minStake * 2n) / 1000000n} stake units (transfer, not mint — P3 took mint() away from every key)`)
  }
  for (const [fn, address, abi, args] of [
    ['approve', usdc, ERC20_ABI, [registry, minStake * 2n]],
    ['stake', registry, REGISTRY_ABI, [minStake * 2n]],
  ]) {
    const h = await jWallet.writeContract({ address, abi, functionName: fn, args, ...FREE })
    await pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })
    console.log(`  ${fn}() mined`)
  }
  ok((await read('stakeOf', [account.address])) >= minStake, 'new validator holds at least minStake')

  // ── 4. rotate, then prove the margin actually improved ──────────────────────
  console.log('\nrotating')
  for (let i = 0; i < 30 && !(await read('rotatable')); i++) {
    if (i === 0) console.log('  … waiting for the next epoch boundary')
    await sleep(4_000)
  }
  const h = await jWallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'rotate', args: [], ...FREE })
  await pub.waitForTransactionReceipt({ hash: h, timeout: 90_000 })
  ok(await read('isActive', [account.address]), 'the new validator holds a seat')

  // The claim is NOT "rotate mined" — it is that the set can now survive a
  // failure. That needs the new seat to actually PROPOSE, which takes a round.
  console.log('\nnew seat actually proposes (a seat that never proposes is the bug we are fixing)')
  const after = await read('getValidators')
  let sawIt = false
  for (let i = 0; i < 40 && !sawIt; i++) {
    const { proposers: p } = await recentProposers(RPC, after.length)
    sawIt = p.includes(account.address.toLowerCase())
    if (!sawIt) await sleep(3_000)
  }
  ok(sawIt, `${account.address} proposed a block`)

  const { proposers: finalProposers, window: finalWindow } = await recentProposers(RPC, after.length)
  const post = assessSetLiveness(after, finalProposers, { window: finalWindow })
  console.log(`\n  seats ${post.seats}, live ${post.live}, quorum ${post.quorum}, margin ${post.margin}`)
  ok(post.margin > before.margin, `margin improved ${before.margin} → ${post.margin}`, post.reason || '')
  ok(post.ok, 'the set can now survive a validator failure', post.reason || '')
  console.log(`  (quorum for ${post.seats} seats is ${qbftQuorum(post.seats)})`)

  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ liveness margin restored'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
