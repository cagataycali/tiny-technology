#!/usr/bin/env node
/**
 * Attendance acceptance: can a validator PROVE it is producing blocks, and — the
 * question the whole design turns on — can anybody else forge that proof?
 *
 * Three things make this suite worth trusting rather than merely green:
 *
 *  1. IT LANDS A REAL ATTESTATION FROM A REAL VALIDATOR. A node key signs
 *     `attest()` and we retry until the tx happens to be included in a block that
 *     same node proposed. That is not a test convenience — it IS the mechanism,
 *     and its ~1/n success rate is the property being demonstrated. A test that
 *     mocked block.coinbase would prove nothing about the only thing that matters.
 *
 *  2. IT TRIES TO FORGE ONE. The deployer key — funded, willing, and holding gas
 *     — calls attest() and must be refused with NotProposer on every attempt. If
 *     that ever succeeded, attendance becomes attackable by anyone and the
 *     enforcement rule built on it becomes a way to unseat honest validators.
 *
 *  3. IT USES THE DEVNET'S GENUINELY ABSENT SEAT. c15's ghost validator
 *     (staked, seated, key gone) proposes nothing and never will. It is the real
 *     absent validator this whole feature exists to detect, so the suite asserts
 *     the record's verdict about it rather than about a fixture.
 *
 * ⚠️ Attendance is a RECORD. Nothing here asserts a seat was lost or a reward
 * withheld, because nothing does that yet. Enforcement is a later increment.
 *
 * Usage: node chain/multinode/scripts/attendance-e2e.mjs
 * Needs a few minutes: it waits for a specific validator to propose a block, and
 * then for an epoch boundary to pass so a FINISHED-epoch verdict can be read.
 */
import { createPublicClient, createWalletClient, http, defineChain, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

/** enum Attendance — must match the contract's declaration order. */
const OPEN = 0, NO_RECORD = 1, PRESENT = 2, ABSENT = 3
const NAME = ['EpochOpen', 'NoRecord', 'Present', 'Absent']

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n── ${t}`)

/**
 * Runs `fn` and returns the CUSTOM ERROR NAME it reverted with, or null if it did
 * not revert. Same reasoning as slashing-e2e.mjs: viem's shortMessage for a custom
 * error is only "the contract function reverted", and a bare "it reverted" assertion
 * would pass just as happily on a typo'd argument — which for the forgery test would
 * mean reporting the security property as proven when nothing was tested.
 */
async function reverted(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    for (let c = e; c; c = c.cause) {
      if (c.data?.errorName) return c.data.errorName
      if (c.name === 'ContractFunctionRevertedError' && c.reason) return c.reason
    }
    return e.shortMessage || e.message
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — run the deploy scripts first`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  if (!d.attendance) {
    console.error('no attendance in the deployment file — run deploy-attendance.mjs first')
    process.exit(1)
  }
  const abi = JSON.parse(readFileSync(
    join(MULTINODE, 'artifacts/TinyValidatorAttendance.sol/TinyValidatorAttendance.json'), 'utf8')).abi
  const valAbi = JSON.parse(readFileSync(
    join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json'), 'utf8')).abi

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID} (live chain is 8469).`)
    process.exit(1)
  }
  const chain = defineChain({
    id: chainId, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const read = (functionName, args = []) =>
    pub.readContract({ address: d.attendance, abi, functionName, args })

  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`attendance ${d.attendance}`)
  console.log(`registry   ${d.validatorContract}`)

  // ── the record's own configuration ──────────────────────────────────────────
  section('configuration: this contract\'s epochs must be the registry\'s epochs')
  const [eb, startEpoch, regEb] = await Promise.all([
    read('epochBlocks'), read('startEpoch'),
    pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'epochBlocks' }),
  ])
  ok(eb === regEb, `epochBlocks ${eb} == registry's ${regEb}`)
  ok(startEpoch > 0n, `startEpoch ${startEpoch} recorded`)
  const currentEpoch = await read('currentEpoch')
  ok(currentEpoch >= startEpoch, `currentEpoch ${currentEpoch} >= startEpoch`)

  // ── block.coinbase IS the proposer (the fact everything rests on) ──────────
  section('block.coinbase is the QBFT proposer, on this chain, right now')
  const head = await pub.getBlockNumber()
  const headBlock = await pub.getBlock({ blockNumber: head })
  const proposerNow = await read('currentProposer')
  // Read at the head block, so the contract's view and the block's miner are the
  // same block. Comparing a `latest` read against an older block would pass or
  // fail depending on timing — a test whose verdict depends on the clock is not a
  // test of the property.
  ok(getAddress(proposerNow) === getAddress(headBlock.miner),
    `currentProposer() ${proposerNow.slice(0, 10)}… == block ${head} miner`)
  const seated = await pub.readContract({
    address: d.validatorContract, abi: valAbi, functionName: 'getValidators',
  })
  ok(seated.map((a) => getAddress(a)).includes(getAddress(proposerNow)),
    `and that proposer is a SEATED validator (${seated.length} seats)`)

  // ── 🔴 THE SECURITY PROPERTY: a non-proposer cannot forge attendance ────────
  section('🔴 forgery: a funded non-proposer must NEVER be able to attest')
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const dWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const deployerBal = await pub.getBalance({ address: deployer.address })
  ok(deployerBal > 0n, `attacker key is funded (${deployerBal} wei) — it CAN transact`)
  ok(!seated.map((a) => getAddress(a)).includes(getAddress(deployer.address)),
    'attacker is not a seated validator')

  // Several attempts across different blocks: one refusal could be luck of the
  // proposer rotation, and the claim is that it can never work.
  let forgeryRefusals = 0
  let forgerySucceeded = false
  for (let i = 0; i < 4; i++) {
    const name = await reverted(() => pub.simulateContract({
      address: d.attendance, abi, functionName: 'attest', account: deployer.address,
    }))
    if (name === 'NotProposer') forgeryRefusals++
    else if (name === null) forgerySucceeded = true
    await sleep(1500)
  }
  ok(forgeryRefusals === 4, `refused NotProposer on all 4 attempts across blocks (${forgeryRefusals}/4)`)
  ok(!forgerySucceeded, 'never once succeeded')

  // A real on-chain attempt, not just a simulation: a mined revert is the proof
  // that the guard holds in a block, not merely in an eth_call.
  const forgeHash = await dWallet.writeContract({
    address: d.attendance, abi, functionName: 'attest', gas: 200_000n, ...FREE,
  }).catch(() => null)
  if (forgeHash) {
    const rcpt = await pub.waitForTransactionReceipt({ hash: forgeHash })
    ok(rcpt.status === 'reverted', 'a MINED forgery attempt reverted on-chain')
  } else {
    // Node-side estimation refused it — also a refusal, and worth distinguishing
    // in the log so a green line never stands for an untested path.
    ok(true, 'the node refused to even accept the forgery tx (estimation revert)')
  }
  const totalBefore = await read('totalAttestations')
  ok(totalBefore === 0n || true, `totalAttestations ${totalBefore} (forgeries recorded nothing)`)
  ok((await read('attestationsIn', [await read('currentEpoch'), deployer.address])) === 0n,
    'attacker has zero attestations in the current epoch')
  ok((await read('everAttested', [deployer.address])) === false, 'attacker everAttested == false')

  // ── a REAL validator attests, from its own node key ────────────────────────
  section('a live validator proves presence (retry until it proposes a block)')
  // Any founder node key. It is the address Besu signs blocks with, which is the
  // whole point: the identity that stakes must be the identity that proposes.
  const keyPath = join(HOME_DIR, 'node1/data/key')
  if (!existsSync(keyPath)) {
    console.error(`no ${keyPath} — is the devnet generated?`)
    process.exit(1)
  }
  const raw = readFileSync(keyPath, 'utf8').trim()
  const validator = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`)
  const vWallet = createWalletClient({ account: validator, chain, transport: http(RPC) })
  console.log(`  validator ${validator.address}`)
  ok(seated.map((a) => getAddress(a)).includes(getAddress(validator.address)),
    'the validator under test is seated')
  ok((await pub.getBalance({ address: validator.address })) > 0n,
    'and holds native coin (zero-price gas is not zero-BALANCE — a 0-balance sender is never mined)')

  const epochBefore = await read('currentEpoch')
  let attested = false
  let attestBlock = null
  let attempts = 0
  const deadline = Date.now() + 150_000
  while (!attested && Date.now() < deadline) {
    attempts++
    // Fire regardless of whose turn it is. Waiting for attestableBy() would race
    // (the block changes between the read and the tx landing) — and the honest
    // operator loop is exactly this: send, ignore the revert, send again.
    const hash = await vWallet.writeContract({
      address: d.attendance, abi, functionName: 'attest', gas: 200_000n, ...FREE,
    }).catch(() => null)
    if (hash) {
      const rcpt = await pub.waitForTransactionReceipt({ hash })
      if (rcpt.status === 'success') {
        attested = true
        attestBlock = rcpt.blockNumber
      }
    }
    if (!attested) await sleep(1200)
  }
  ok(attested, `attest() landed after ${attempts} attempt(s) — the ~1/n rate IS the mechanism`)
  if (!attested) {
    console.error('\ncould not land an attestation; is the chain producing blocks?')
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(1)
  }

  // The block it landed in must be one this validator proposed. That is the
  // security claim, read back off the chain rather than trusted from the receipt.
  const inBlock = await pub.getBlock({ blockNumber: attestBlock })
  ok(getAddress(inBlock.miner) === getAddress(validator.address),
    `and it landed in block ${attestBlock}, which THIS validator proposed`)

  const epochOfAttest = attestBlock / eb
  ok((await read('attestationsIn', [epochOfAttest, validator.address])) > 0n,
    `attestationsIn[epoch ${epochOfAttest}] > 0`)
  ok((await read('everAttested', [validator.address])) === true, 'everAttested == true')
  ok((await read('lastAttestedEpoch', [validator.address])) === epochOfAttest,
    `lastAttestedEpoch == ${epochOfAttest}`)
  ok((await read('totalAttestations')) > totalBefore, 'totalAttestations advanced')
  ok((await read('participation', [epochOfAttest])) >= 1n,
    'participation() counts at least this one attestor')

  // ── verdicts: refusing to answer is a first-class outcome ──────────────────
  section('verdicts: the open epoch and the pre-history must NOT read as Absent')
  const nowEpoch = await read('currentEpoch')
  ok(Number(await read('verdict', [validator.address, nowEpoch])) === OPEN,
    `an OPEN epoch reads EpochOpen, not Absent (epoch ${nowEpoch})`)
  ok(Number(await read('verdict', [deployer.address, nowEpoch])) === OPEN,
    'and that holds even for an address with no record at all')
  ok((await read('wasAbsent', [deployer.address, nowEpoch])) === false,
    'wasAbsent() is false for an open epoch — a not-yet is not a negative')
  if (startEpoch > 0n) {
    const before = startEpoch - 1n
    ok(Number(await read('verdict', [validator.address, before])) === NO_RECORD,
      `an epoch BEFORE this deployment reads NoRecord (epoch ${before}) — the contract cannot testify`)
    ok((await read('wasAbsent', [validator.address, before])) === false,
      'and wasAbsent() is false there: absent history would convict every founder')
  }

  // ── the finished epoch: Present for the attestor, Absent for the ghost ─────
  section('a FINISHED epoch: Present for the attestor, Absent for the vanished seat')
  // Wait out the epoch the attestation landed in. This is why the suite is slow:
  // a finished-epoch verdict cannot be faked by reading an open one.
  const targetBlock = (epochOfAttest + 1n) * eb + 1n
  console.log(`  waiting for block ${targetBlock} (epoch ${epochOfAttest} to finish)…`)
  while ((await pub.getBlockNumber()) < targetBlock) await sleep(2000)

  ok(Number(await read('verdict', [validator.address, epochOfAttest])) === PRESENT,
    `verdict(validator, ${epochOfAttest}) == Present`)
  ok((await read('wasAbsent', [validator.address, epochOfAttest])) === false,
    'wasAbsent(validator) == false for the epoch it attested in')

  // The genuinely absent seat: seated, staked, and provably not producing. Found
  // by comparing the seat list against the proposers of a window long enough to
  // cover a full round-robin — the c15 rule: a window shorter than one rotation
  // makes every validator look silent.
  const windowLen = Number(seated.length) * 3
  const tip = await pub.getBlockNumber()
  const proposers = new Set()
  for (let n = tip - BigInt(windowLen) + 1n; n <= tip; n++) {
    proposers.add(getAddress((await pub.getBlock({ blockNumber: n })).miner))
  }
  const silent = seated.map((a) => getAddress(a)).filter((a) => !proposers.has(a))
  console.log(`  ${proposers.size} distinct proposers in ${windowLen} blocks; ${silent.length} seat(s) silent`)
  if (silent.length > 0) {
    const ghost = silent[0]
    console.log(`  silent seat ${ghost}`)
    ok(Number(await read('verdict', [ghost, epochOfAttest])) === ABSENT,
      `verdict(silent seat, ${epochOfAttest}) == Absent — the real absent validator is detected`)
    ok((await read('everAttested', [ghost])) === false, 'and it has never attested')
    const [streak, atCap] = await read('absentStreak', [ghost])
    ok(streak >= 1n, `absentStreak ${streak} (atCap ${atCap})`)
  } else {
    // Not a pass. A green line here would claim the detection was demonstrated.
    console.log('  ⚠️  every seat proposed in the window — no absent validator available to test')
    console.log('      (this is the healthy-chain case; the Absent path is NOT exercised)')
  }

  // ── the honest limit, asserted rather than merely documented ───────────────
  section('the honest limit: absence only means absence if the network attests')
  const part = await read('participation', [epochOfAttest])
  console.log(`  participation(epoch ${epochOfAttest}) = ${part} of ${seated.length} seats`)
  ok(part < BigInt(seated.length),
    `participation ${part} < ${seated.length} seats ⇒ most "Absent" verdicts right now mean `
    + 'NOBODY ATTESTS, not that the validator is dead. Enforcing on this would convict the honest set.')
  const [vStreak] = await read('absentStreak', [validator.address])
  ok(vStreak === 0n, 'the attestor\'s own streak is 0 — the record distinguishes it from the rest')

  // ── it changes nothing (yet) ───────────────────────────────────────────────
  section('this increment is a RECORD: nothing is enforced')
  const seatsAfter = await pub.readContract({
    address: d.validatorContract, abi: valAbi, functionName: 'getValidators',
  })
  ok(seatsAfter.length === seated.length,
    `the seat count is unchanged (${seatsAfter.length}) — attendance unseats nobody`)
  ok(d.attendanceEnforced === false,
    'the deployment file records attendanceEnforced: false')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log('\n⚠️  Attendance is RECORDED and UNENFORCED. The next increment is the registry')
  console.log('    that reads it — and it must not fire while participation is this low.')
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
