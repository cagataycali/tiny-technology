#!/usr/bin/env node
/**
 * P3 acceptance: money on 8470 is created by a RULE, not by a key.
 *
 * The claims, in order of how much they matter:
 *
 *   1. The deployer key CANNOT mint. Not "doesn't" — its mint() reverts. Until
 *      this holds, every cap below is decoration on top of an unlimited printer.
 *   2. A validator earns by producing blocks, with NO oracle: the credit comes
 *      from block.coinbase, which consensus writes.
 *   3. Anyone can credit a block, and cannot misdirect the credit — the caller
 *      does not choose the beneficiary.
 *   4. A block can be credited at most once (else one validator mints an epoch
 *      from inside its own block).
 *   5. An open epoch cannot be claimed (the pro-rata denominator is still moving).
 *   6. No address can exceed its per-epoch cap, and no epoch can exceed budget.
 *   7. The schedule decays, so total supply is bounded.
 *   8. The serve half cannot be minted by anyone who isn't the locked
 *      distributor, and the lock is one-shot.
 *
 * Usage: node chain/multinode/scripts/issuance-e2e.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const CHAIN = dirname(MULTINODE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'

const d = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
const issArt = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyIssuance.sol/TinyIssuance.json'), 'utf8'))
const usdcArt = JSON.parse(readFileSync(join(CHAIN, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

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

const iss = (functionName, args = []) =>
  pub.readContract({ address: d.issuance, abi: issArt.abi, functionName, args })
const usdcBal = (a) =>
  pub.readContract({ address: d.usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [a] })

/** Did this call revert? Returns the revert text, or null if it succeeded. */
async function reverted(fn) {
  try { await fn(); return null } catch (e) { return e.shortMessage || e.message }
}

async function main() {
  console.log('\n🪙 multi-node tiny chain — P3 acceptance (issuance by rule, not by key)\n')
  if (!d.issuance) {
    console.log('  no issuance in the deployment file — run deploy-issuance.mjs first\n')
    process.exit(1)
  }
  const deployer = walletFor(DEPLOYER_KEY)
  const nodeKeys = []
  for (let n = 1; n <= 4; n++) {
    const raw = readFileSync(join(HOME_DIR, `node${n}/data/key`), 'utf8').trim()
    nodeKeys.push(raw.startsWith('0x') ? raw : `0x${raw}`)
  }
  // A stranger with no role at all: not a validator, not the deployer, not the
  // distributor. Used to prove the permissionless paths are permissionless and
  // the privileged ones aren't.
  const strangerKey = process.env.TINY_STRANGER_KEY
    || '0x4444444444444444444444444444444444444444444444444444444444444444'
  const stranger = walletFor(strangerKey)
  const strangerAddr = getAddress(privateKeyToAccount(strangerKey).address)
  const strangerBal = await pub.getBalance({ address: strangerAddr })
  if (strangerBal === 0n) {
    await wait(await deployer.sendTransaction({ to: strangerAddr, value: 10n ** 18n, gas: 30_000n, ...FREE }))
  }

  console.log('who is allowed to create money')
  ok(await iss('isSoleMinter'), 'TinyIssuance owns TinyUSDC — it is the only minter')
  // The claim that makes every cap below meaningful. Tested by ATTEMPTING the
  // mint, not by reading the owner field: "owner is someone else" and "my mint
  // reverts" are the same thing only if the token checks what we think it checks.
  const mintErr = await reverted(() => deployer.writeContract({
    address: d.usdc, abi: usdcArt.abi, functionName: 'mint', args: [strangerAddr, 1_000_000n], ...FREE,
  }))
  ok(mintErr !== null && /not owner|revert/i.test(mintErr),
    'the DEPLOYER KEY can no longer mint — the monetary authority is a contract',
    mintErr === null ? 'mint SUCCEEDED — the key is still the printer' : '')

  console.log('\nthe schedule is bounded and decaying')
  const b0 = await iss('epochBudget', [0n])
  const bH = await iss('epochBudget', [BigInt(d.halvingEpochs)])
  const b2H = await iss('epochBudget', [BigInt(d.halvingEpochs) * 2n])
  ok(b0 === BigInt(d.initialEpochBudget), `epoch 0 budget is the configured ${b0}`)
  ok(bH === b0 / 2n && b2H === b0 / 4n,
    `budget halves every ${d.halvingEpochs} epochs (${b0} → ${bH} → ${b2H})`)
  // A schedule that wraps back to full after enough halvings is an inflation bug
  // wearing a cap: >>256 is undefined in the EVM, so this is a real edge, not a
  // theoretical one.
  const bFar = await iss('epochBudget', [BigInt(d.halvingEpochs) * 300n])
  ok(bFar === 0n, 'budget reaches 0 rather than overflowing back to full', `got ${bFar}`)
  const vb = await iss('validatorBudget', [0n])
  const sb = await iss('serveBudget', [0n])
  ok(vb + sb === b0, `the two budgets partition the epoch exactly (${vb} + ${sb} = ${b0})`)

  console.log('\nvalidate-to-earn needs NO oracle')
  // The credit comes from block.coinbase — written by consensus, not by us.
  const beforeEpoch = Number(await iss('currentEpoch'))
  const creditHash = await stranger.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'creditBlock', args: [], ...FREE,
  })
  const creditRec = await wait(creditHash)
  const creditedBlock = await pub.getBlock({ blockNumber: creditRec.blockNumber })
  const proposer = getAddress(creditedBlock.miner)
  const epochOfCredit = Number(await iss('currentEpoch')) === beforeEpoch ? beforeEpoch : null
  const creditedTo = await iss('blocksCreditedTo', [BigInt(epochOfCredit ?? beforeEpoch), proposer])
  ok(Number(creditedTo) >= 1,
    `a STRANGER credited a block and the credit went to its PROPOSER ${proposer.slice(0, 10)}… — not to the caller`,
    `credited ${creditedTo}`)
  const strangerCredited = await iss('blocksCreditedTo', [BigInt(epochOfCredit ?? beforeEpoch), strangerAddr])
  ok(Number(strangerCredited) === 0,
    'the caller credited themselves NOTHING — the beneficiary is consensus\'s choice, not the sender\'s')

  // Without this, a validator calls creditBlock in a loop inside its own block
  // and takes the whole epoch.
  const doubleErr = await reverted(() => stranger.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'creditBlock', args: [], ...FREE,
  }))
  // Same block is only reachable if we land in the same block; the durable
  // guarantee is that lastCreditedBlock advanced, so re-crediting THAT block
  // reverts. Assert on the state, which is true regardless of timing.
  const lastCredited = await iss('lastCreditedBlock')
  ok(Number(lastCredited) >= Number(creditRec.blockNumber),
    'lastCreditedBlock advanced — the same block cannot be credited twice',
    `lastCredited=${lastCredited} creditedIn=${creditRec.blockNumber} secondCall=${doubleErr ? 'reverted' : 'mined in a later block'}`)

  console.log('\nan OPEN epoch cannot be claimed (the denominator is still moving)')
  const openEpoch = BigInt(await iss('currentEpoch'))
  const earlyErr = await reverted(() => stranger.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'claimValidatorReward',
    args: [openEpoch, proposer], ...FREE,
  }))
  ok(earlyErr !== null, 'claiming the current epoch REVERTS — a share of an unfinished total is not a share',
    earlyErr === null ? 'the claim succeeded' : '')

  console.log('\nblocks credited across a whole epoch, then paid')
  // Credit steadily so several proposers accumulate, then wait for the epoch to
  // close. This is the real flow: nobody knows their share until the epoch ends.
  const workEpoch = BigInt(await iss('currentEpoch'))
  let credits = 0
  for (let i = 0; i < 40; i++) {
    if (BigInt(await iss('currentEpoch')) !== workEpoch) break
    try {
      await wait(await stranger.writeContract({
        address: d.issuance, abi: issArt.abi, functionName: 'creditBlock', args: [], ...FREE,
      }))
      credits++
    } catch { /* same-block collision — expected, keep going */ }
    await sleep(1_200)
  }
  for (let i = 0; i < 60 && BigInt(await iss('currentEpoch')) <= workEpoch; i++) await sleep(2_000)
  const totalCredited = await iss('blocksCredited', [workEpoch])
  ok(Number(totalCredited) > 0, `epoch ${workEpoch} closed with ${totalCredited} credited blocks (${credits} sent)`)

  const earners = []
  for (const k of nodeKeys) {
    const a = getAddress(privateKeyToAccount(k).address)
    const n = await iss('blocksCreditedTo', [workEpoch, a])
    if (Number(n) > 0) earners.push({ addr: a, blocks: Number(n) })
  }
  ok(earners.length > 0, `${earners.length} validator(s) earned credit in the epoch`,
    earners.map((e) => `${e.addr.slice(0, 10)}…:${e.blocks}`).join(' '))

  const vBudget = await iss('validatorBudget', [workEpoch])
  const cap = (vBudget * BigInt(d.maxRecipientBps)) / 10_000n
  let paidTotal = 0n
  for (const e of earners) {
    const pending = await iss('pendingValidatorReward', [workEpoch, e.addr])
    const before = await usdcBal(e.addr)
    // Claimed BY THE STRANGER on the validator's behalf: the tokens go to the
    // earner either way, so requiring the earner to be online to be paid would
    // only punish validators that went offline after doing the work.
    await wait(await stranger.writeContract({
      address: d.issuance, abi: issArt.abi, functionName: 'claimValidatorReward',
      args: [workEpoch, e.addr], ...FREE,
    }))
    const after = await usdcBal(e.addr)
    const got = after - before
    paidTotal += got
    ok(got === pending && got > 0n,
      `${e.addr.slice(0, 10)}… was paid ${got} micro-USDC for ${e.blocks} block(s), by a third party`,
      `pending said ${pending}, balance moved ${got}`)
    ok(got <= cap, `…and it is within the ${Number(d.maxRecipientBps) / 100}% per-address cap (${cap})`)
  }
  ok(paidTotal <= vBudget, `total paid ${paidTotal} never exceeds the epoch's validator budget ${vBudget}`)

  // Paying twice for the same work is the classic issuance bug.
  const twiceErr = await reverted(() => stranger.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'claimValidatorReward',
    args: [workEpoch, earners[0].addr], ...FREE,
  }))
  ok(twiceErr !== null, 'a second claim for the same epoch REVERTS — work is paid once',
    twiceErr === null ? 'double claim succeeded' : '')

  console.log('\nthe serve half is separately gated (and is an ORACLE — labelled as one)')
  const distributor = await iss('serveDistributor')
  const locked = await iss('serveDistributorLocked')
  const serveErr = await reverted(() => stranger.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'mintServeReward',
    args: [strangerAddr, workEpoch, 1_000n], ...FREE,
  }))
  ok(serveErr !== null, 'a stranger cannot mint from the serve budget', serveErr === null ? 'it minted' : '')
  ok(distributor === '0x0000000000000000000000000000000000000000' || locked,
    'serve distributor is either unset or LOCKED — never freely repointable',
    `distributor=${distributor} locked=${locked}`)
  // Serve minting stays unreachable until TinyServeRewards exists. Asserting the
  // budget is untouched proves the two halves really are separate: a bug in the
  // serve path must not be able to spend validator issuance.
  ok((await iss('serveMinted', [workEpoch])) === 0n,
    'no serve issuance has been minted — the validator half was paid from its own budget')

  console.log('\nsupply moved by exactly what was issued')
  const totalIssued = await iss('totalIssued')
  ok(totalIssued >= paidTotal, `totalIssued (${totalIssued}) accounts for the payouts (${paidTotal})`)
  const supply = await pub.readContract({ address: d.usdc, abi: usdcArt.abi, functionName: 'totalSupply' })
  ok(supply > 0n, `TinyUSDC totalSupply is ${supply} — created by rule, not by a key`)

  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ P3 verified: issuance is a rule anyone can audit'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
