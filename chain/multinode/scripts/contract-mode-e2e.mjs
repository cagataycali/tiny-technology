#!/usr/bin/env node
/**
 * P2 acceptance: the validator set is decided by a CONTRACT, and a stranger can
 * seat themselves in it.
 *
 * P1 proved four nodes agree. That's a network, but a closed one — the set came
 * from the genesis, so "who validates" was still our decision. This proves the
 * decision moved on-chain:
 *
 *   1. Besu is reading validators from TinyValidators (its answer == qbft_*'s),
 *   2. an address we did NOT put anywhere can stake and become seated,
 *   3. it is seated because of STAKE, not because an operator allowed it —
 *      demonstrated by an under-staked address in the same rotation being left
 *      out, and by rotate() being called BY the stranger,
 *   4. exiting returns the stake, so participation isn't a trap,
 *   5. the set never goes empty (Besu halts on an empty result — so we assert
 *      the contract REFUSES rather than complies).
 *
 * (2) is the load-bearing one, and note what it does NOT require: no genesis
 * edit, no restart, no key on our machine. That's the difference between a
 * permissioned chain with extra steps and an open one.
 *
 * Usage: node chain/multinode/scripts/contract-mode-e2e.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, getAddress, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'

const d = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
const valArt = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json'), 'utf8'))
const usdcArt = JSON.parse(readFileSync(join(MULTINODE, '../artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
const MIN_STAKE = BigInt(d.minStake)

/**
 * Two strangers that appear in NO genesis, NO deployment, and hold no seat.
 * "joiner" stakes enough; "shortfall" does not. Assigned in main() from the live
 * block height — see the note there for why they cannot be constants.
 */
let JOINER_KEY = process.env.TINY_JOINER_KEY
let SHORTFALL_KEY = process.env.TINY_SHORTFALL_KEY
const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

let failures = 0
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`) }
}

const chain = defineChain({
  id: d.chainId, name: 'tiny-multinode',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ transport: http(RPC) })
const walletFor = (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })
const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readValidators = () =>
  pub.readContract({ address: d.validatorContract, abi: valArt.abi, functionName: 'getValidators' })
const rpcValidators = async () => {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'qbft_getValidatorsByBlockNumber', params: ['latest'] }),
  })
  return (await res.json()).result || []
}

/**
 * Wait past the next epoch boundary, then rotate FROM the given wallet.
 *
 * Waits on the EPOCH only, not on rotatable(): rotatable() is also false when
 * too few candidates are eligible, and one test deliberately creates exactly
 * that state to prove rotate() refuses it. Polling rotatable() there would spin
 * for three minutes and then report a timeout instead of the revert we want.
 */
async function rotateAs(wallet, label) {
  const epochBlocks = BigInt(d.epochBlocks)
  const startEpoch = await pub.readContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'lastRotatedEpoch',
  })
  for (let i = 0; i < 90; i++) {
    if ((await pub.getBlockNumber()) / epochBlocks > startEpoch) break
    await sleep(2_000)
  }
  const hash = await wallet.writeContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'rotate', args: [], ...FREE,
  })
  await wait(hash)
  console.log(`  … rotate() called by ${label}`)
}

async function main() {
  console.log('\n🔗 multi-node tiny chain — P2 acceptance (contract-mode validators)\n')

  /**
   * FRESH stranger keys per run, and this is a bug fix rather than tidiness.
   *
   * They used to be fixed constants, and `stake()` ACCUMULATES: after several
   * cycles against this long-lived devnet the "under-staked" stranger had banked
   * 2.5× minStake and was legitimately seated, so `the under-staked stranger is
   * NOT seated` failed while the contract was behaving exactly as specified. A
   * suite whose fixtures accrue state on a persistent chain eventually reports
   * that chain's history as a regression in itself — and the failure points at
   * the contract, which is the most expensive place to be sent looking.
   */
  const seed = await pub.getBlockNumber()
  JOINER_KEY = JOINER_KEY || keccak256(`0x6a${seed.toString(16).padStart(16, '0')}`)
  SHORTFALL_KEY = SHORTFALL_KEY || keccak256(`0x5f${seed.toString(16).padStart(16, '0')}`)

  const deployer = walletFor(DEPLOYER_KEY)
  const joiner = walletFor(JOINER_KEY)
  const shortfall = walletFor(SHORTFALL_KEY)
  const joinerAddr = getAddress(privateKeyToAccount(JOINER_KEY).address)
  const shortfallAddr = getAddress(privateKeyToAccount(SHORTFALL_KEY).address)

  console.log('who decides the validator set')
  const head = await pub.getBlockNumber()
  ok(Number(head) >= d.transitionBlock,
    `chain is past the transition block (${d.transitionBlock}); head ${head}`,
    Number(head) < d.transitionBlock ? `wait ${d.transitionBlock - Number(head)} more blocks` : '')
  if (Number(head) < d.transitionBlock) {
    console.log('\n  not yet in contract mode — rerun after the transition block\n')
    process.exit(1)
  }

  const fromContract = (await readValidators()).map((a) => getAddress(a)).sort()
  const fromNode = (await rpcValidators()).map((a) => getAddress(a)).sort()
  ok(fromNode.length > 0 && JSON.stringify(fromContract) === JSON.stringify(fromNode),
    'Besu\'s validator set IS the contract\'s getValidators() — consensus now obeys the contract',
    `contract ${JSON.stringify(fromContract)}\n      node     ${JSON.stringify(fromNode)}`)

  console.log('\na stranger joins — no operator action, no restart')
  ok(!fromContract.includes(joinerAddr), `joiner ${joinerAddr} starts OUTSIDE the set`)

  // Bootstrapping a stranger needs two things they can't create themselves: gas
  // money (see the alloc trap in qbft-config.json) and stake. On a devnet we
  // hand both over; on a real chain they'd be earned or bought. Everything AFTER
  // this point is done by the stranger's own key.
  //
  // ⚠️ TRANSFERS, not mints. This test used to mint the stake, and P3 broke it on
  // purpose: TinyIssuance now owns TinyUSDC, so the deployer key's mint() reverts
  // with "TinyUSDC: not owner". Keeping the mint would have meant either handing
  // the printer back or letting the P2 suite rot. Moving existing tokens is also
  // the more honest test — on a chain where issuance is a rule, nobody funding a
  // newcomer gets to skip that rule either.
  const funderBal = await pub.readContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [deployer.account.address],
  })
  const needed = MIN_STAKE * 2n + MIN_STAKE / 2n
  if (funderBal < needed) {
    console.log(`\n  💥 funder ${deployer.account.address} holds ${funderBal}, needs ${needed}.`)
    console.log('     Since P3, nobody can mint their way out of this — earn it (issuance-e2e.mjs)')
    console.log('     or re-run deploy-validators.mjs on a fresh chain.\n')
    process.exit(1)
  }
  for (const [addr, amount] of [[joinerAddr, MIN_STAKE * 2n], [shortfallAddr, MIN_STAKE / 2n]]) {
    await wait(await deployer.sendTransaction({ to: addr, value: parseUnits('1', 18), gas: 30_000n, ...FREE }))
    await wait(await deployer.writeContract({
      address: d.usdc, abi: usdcArt.abi, functionName: 'transfer', args: [addr, amount], ...FREE,
    }))
  }
  console.log('  … both strangers funded (gas + tokens)')

  // From here on: the joiner acts entirely on its own.
  await wait(await joiner.writeContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'approve',
    args: [d.validatorContract, MIN_STAKE * 2n], ...FREE,
  }))
  await wait(await joiner.writeContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'stake', args: [MIN_STAKE * 2n], ...FREE,
  }))
  await wait(await shortfall.writeContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'approve',
    args: [d.validatorContract, MIN_STAKE / 2n], ...FREE,
  }))
  await wait(await shortfall.writeContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'stake', args: [MIN_STAKE / 2n], ...FREE,
  }))

  const stakedBeforeSeat = (await readValidators()).map((a) => getAddress(a))
  ok(!stakedBeforeSeat.includes(joinerAddr),
    'staking alone does NOT seat them — seats change only at an epoch boundary')

  // Called BY the joiner: if this required our key, the chain would not be open.
  await rotateAs(joiner, 'the joiner itself (not the operator)')

  const seated = (await readValidators()).map((a) => getAddress(a))
  ok(seated.includes(joinerAddr), 'joiner is now a SEATED validator, by staking alone', `set: ${seated}`)
  ok(!seated.includes(shortfallAddr),
    'the under-staked stranger is NOT seated — stake is the rule, not favour',
    `set: ${seated}`)

  console.log('\nBesu agrees — the new validator really is one')
  let nodeSees = []
  for (let i = 0; i < 30; i++) {
    nodeSees = (await rpcValidators()).map((a) => getAddress(a))
    if (nodeSees.includes(joinerAddr)) break
    await sleep(2_000)
  }
  ok(nodeSees.includes(joinerAddr),
    'qbft_getValidatorsByBlockNumber includes the joiner — the CONSENSUS set grew',
    `node: ${JSON.stringify(nodeSees)}`)

  console.log('\nleaving works too — participation is not a trap')
  await wait(await joiner.writeContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'requestExit', args: [], ...FREE,
  }))
  await rotateAs(joiner, 'the joiner (exiting)')
  const afterExit = (await readValidators()).map((a) => getAddress(a))
  ok(!afterExit.includes(joinerAddr), 'joiner is unseated after requesting exit', `set: ${afterExit}`)

  const balBefore = await pub.readContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [joinerAddr],
  })
  await wait(await joiner.writeContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'unstake', args: [MIN_STAKE * 2n], ...FREE,
  }))
  const balAfter = await pub.readContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [joinerAddr],
  })
  ok(balAfter - balBefore === MIN_STAKE * 2n, 'stake returned in full on unstake',
    `+${balAfter - balBefore}, expected +${MIN_STAKE * 2n}`)

  console.log('\nthe founders are not evicted by a stranger\'s rotation')
  // The bug this catches, found by this very test on its first run: founders
  // were seated by the constructor but never enrolled as candidates, so the
  // first permissionless rotate() saw one eligible address and evicted all four
  // — turning a 4-node set (f=1) into a 1-node set (f=0). Any stranger could
  // trigger it for the price of one stake.
  const survivors = (await readValidators()).map((a) => getAddress(a))
  ok(survivors.length >= d.minValidators,
    `set still has ≥ the ${d.minValidators}-validator floor after outside rotations (${survivors.length})`,
    `set: ${JSON.stringify(survivors)}`)

  console.log('\nthe set can never fall below the floor (too few HALTS besu)')
  // Every founder asks to leave at once. The contract must REFUSE the rotation
  // rather than obey it: obeying would leave a set too small to tolerate any
  // fault, and an empty one would stop the chain outright.
  const nodeKeys = []
  for (let n = 1; n <= 4; n++) {
    const raw = readFileSync(join(HOME_DIR, `node${n}/data/key`), 'utf8').trim()
    nodeKeys.push(raw.startsWith('0x') ? raw : `0x${raw}`)
  }
  for (const k of nodeKeys) {
    const w = walletFor(k)
    await wait(await w.writeContract({
      address: d.validatorContract, abi: valArt.abi, functionName: 'requestExit', args: [], ...FREE,
    }))
  }
  let refused = false
  try {
    await rotateAs(joiner, 'anyone, with every founder exiting')
  } catch (e) {
    refused = /EmptySetRefused|BelowValidatorFloor|revert/i.test(e.shortMessage || e.message)
  }
  const stillSeated = (await readValidators()).map((a) => getAddress(a))
  ok(refused && stillSeated.length >= d.minValidators,
    'rotate() REFUSED to drop below the floor — previous set kept, chain stays alive',
    `refused=${refused} set=${JSON.stringify(stillSeated)}`)

  // Clear the founders' exit flags again. Without this the test leaves the chain
  // one eligible validator short of the floor forever: every later rotate()
  // reverts, so the NEXT run of this file fails at the join step and reads as a
  // broken chain when the chain is fine and the test was the thing that broke it.
  // A test that permanently degrades the system it inspects can only be run once.
  for (const k of nodeKeys) {
    await wait(await walletFor(k).writeContract({
      address: d.validatorContract, abi: valArt.abi, functionName: 'cancelExit', args: [], ...FREE,
    }))
  }
  const restored = await pub.readContract({
    address: d.validatorContract, abi: valArt.abi, functionName: 'eligibleCount',
  })
  ok(Number(restored) >= d.minValidators,
    'founders\' exit requests cancelled — chain left rotatable for the next run',
    `eligible: ${restored}`)

  // The chain must still be producing after all that.
  const h1 = await pub.getBlockNumber()
  await sleep(6_000)
  const h2 = await pub.getBlockNumber()
  ok(h2 > h1, `chain still producing blocks after the churn (${h1} → ${h2})`)

  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ P2 verified: anyone can validate — the contract decides, not us'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
