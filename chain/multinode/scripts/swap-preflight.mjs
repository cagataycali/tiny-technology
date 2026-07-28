#!/usr/bin/env node
/**
 * 🔁 REGISTRY SWAP PREFLIGHT — run this before pointing chain 8470's genesis at a
 * different validator registry, and believe it when it refuses.
 *
 * ⚠️⚠️ WHY THIS EXISTS. The carried-debt item read: "swap TinyValidators for
 * TinyValidatorsSlashable (stake/candidate migration → timestamp-keyed transition
 * on all 4 nodes)". Probing the live devnet before implementing it found that
 * executing it as written would have HALTED THE CHAIN:
 *
 *     outgoing TinyValidators:          6 seats, 5 of them proposing right now
 *     incoming TinyValidatorsSlashable: 8 seats, 0 of them a running process
 *                                       (leftover joiners from its own E2E)
 *     after the transition: quorum 6, live 0 → no proposer, forever
 *
 * And the recovery does not exist: the only way to change a registry's seated set
 * is rotate(), which is a transaction, which needs the quorum that just vanished.
 * The chain would have to be relaunched — which for a chain whose whole claim is
 * that outsiders can sync it is not a recovery.
 *
 * 🔑 The reason no existing check caught it: the deploy script, the acceptance
 * suite and the design doc all ask whether the incoming registry's RULES work. The
 * danger is entirely in its STATE. Nothing about deploying, testing, or even
 * convicting on a registry tells you whether the addresses it seats are alive.
 *
 * So this asks the four questions whose answers are invisible from the inside:
 *   1. will the chain still commit blocks afterwards? (independent evidence: who
 *      has actually proposed, never the registry's own getValidators())
 *   2. is the transition key one besu reads as we intend, far enough ahead for
 *      every node to restart in lockstep? (c7's timestamp bug)
 *   3. is the incoming registry solvent for the stake it records?
 *   4. can anyone ever join or leave it afterwards?
 *
 * READ-ONLY. Makes no transaction, changes no file, and never touches the LIVE
 * 8469 (it refuses any RPC that is not chain 8470).
 *
 * Usage:
 *   node chain/multinode/scripts/swap-preflight.mjs
 *   node chain/multinode/scripts/swap-preflight.mjs --incoming 0xabc… [--transition <unix>]
 *
 * Exit 0 = the swap looks survivable. Exit 1 = REFUSE, with the reasons and the
 * remediation that actually works.
 */
import { createPublicClient, http, getAddress } from 'viem'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  assessRegistrySwap,
  MIN_TRANSITION_LEAD_S,
} from '../registry-swap-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

const REGISTRY_ABI = [
  { name: 'getValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { name: 'candidateCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'candidateAt', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'stakeOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'eligibleCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minStake', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'exiting', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'forfeitedTotal', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'courtHealthy', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'court', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
/**
 * The other end of the registry↔court cycle. `TinySlashing.validators` is immutable,
 * so this is the question a swap cannot change and nothing was asking: does the court
 * the incoming registry trusts still describe the incoming registry? (c24)
 */
const COURT_ABI = [
  { name: 'validators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

/** Sum `stakeOf` over the candidate queue — the registry's own record of what it owes. */
async function recordedStake(pub, address) {
  const n = Number(await pub.readContract({ address, abi: REGISTRY_ABI, functionName: 'candidateCount' }))
  let total = 0n
  for (let i = 0; i < n; i++) {
    const c = await pub.readContract({ address, abi: REGISTRY_ABI, functionName: 'candidateAt', args: [BigInt(i)] })
    total += await pub.readContract({ address, abi: REGISTRY_ABI, functionName: 'stakeOf', args: [c] })
  }
  return { total, candidates: n }
}

/** Optional views: a registry without a court has no courtHealthy(), and that is not an error. */
async function tryRead(pub, address, functionName, abi = REGISTRY_ABI) {
  try {
    return await pub.readContract({ address, abi, functionName })
  } catch {
    return undefined
  }
}

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — nothing to preflight`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))

  const outgoing = getAddress(d.validatorContract)
  const incomingRaw = arg('incoming') || d.validatorContractSlashable
  if (!incomingRaw) {
    console.error('no incoming registry: pass --incoming 0x… or record validatorContractSlashable in the deployment file')
    process.exit(1)
  }
  const incoming = getAddress(incomingRaw)
  if (incoming.toLowerCase() === outgoing.toLowerCase()) {
    console.error(`incoming and outgoing are the same address (${incoming}) — nothing to swap`)
    process.exit(1)
  }

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  // The LIVE chain is 8469. Refuse loudly rather than read (or advise on) it.
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. The LIVE chain is 8469 — never point this at it.`)
    process.exit(1)
  }

  const head = await pub.getBlockNumber()
  const headBlock = await pub.getBlock({ blockNumber: head })
  const nowSec = Number(headBlock.timestamp)

  const incomingSeats = await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'getValidators' })
  const outgoingSeats = await pub.readContract({ address: outgoing, abi: REGISTRY_ABI, functionName: 'getValidators' })

  // The evidence window must cover at least one full round-robin of the LARGER
  // set, or a healthy validator that hasn't had its turn reads as silent (c15).
  // ×3 because at epochBlocks=20 a rotation's worth of turns is what makes an
  // absence meaningful rather than a scheduling artefact.
  const window = Math.max(incomingSeats.length, outgoingSeats.length, 1) * 3
  const proposers = new Set()
  for (let i = 0; i < window; i++) {
    const b = await pub.getBlock({ blockNumber: head - BigInt(i) })
    proposers.add(b.miner.toLowerCase())
  }

  const usdc = getAddress(d.usdc)
  const [inBal, outBal] = await Promise.all([
    pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [incoming] }),
    pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [outgoing] }),
  ])
  const inStake = await recordedStake(pub, incoming)
  const forfeited = (await tryRead(pub, incoming, 'forfeitedTotal')) ?? 0n
  const courtHealthy = await tryRead(pub, incoming, 'courtHealthy')
  // Both ends of the cycle. Reading only `court()` would prove the registry names a
  // court; reading `validators()` back off it is what proves the court names US.
  const court = await tryRead(pub, incoming, 'court')
  const courtValidators = court ? await tryRead(pub, court, 'validators', COURT_ABI) : undefined

  const eligibleCount = Number(await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'eligibleCount' }))
  const minValidators = Number(await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'minValidators' }))
  const maxValidators = Number(await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'maxValidators' }))

  // c18: how many ELIGIBLE candidates are not producing blocks — the number that
  // decides whether staking-and-rotating could ever reach quorum, because the next
  // rotate() seats every one of them. Counting SEATS instead would undercount: the
  // ghosts that matter are the ones a future rotation would seat, not only the ones
  // seated today. There is no per-address eligible() view, so this reconstructs
  // `_eligible` from its parts — minus the court check, which can only ever make a
  // candidate INELIGIBLE, so omitting it keeps the estimate conservative (it
  // over-counts ghosts, i.e. errs toward refusing).
  const eligibleGhosts = await (async () => {
    const minStake = await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'minStake' })
    let n = 0
    for (let i = 0; i < inStake.candidates; i++) {
      const c = await pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'candidateAt', args: [BigInt(i)] })
      const [st, ex] = await Promise.all([
        pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'stakeOf', args: [c] }),
        pub.readContract({ address: incoming, abi: REGISTRY_ABI, functionName: 'exiting', args: [c] }),
      ])
      if (!ex && st >= minStake && !proposers.has(c.toLowerCase())) n++
    }
    return n
  })()

  // Default the proposed transition to the earliest key that could pass, so the
  // report is about the SET rather than about a number the operator hasn't chosen
  // yet. `--transition` checks a specific one.
  const transitionKey = arg('transition') ? Number(arg('transition')) : nowSec + MIN_TRANSITION_LEAD_S
  const genesisPath = join(HOME_DIR, 'network/genesis.json')
  // Whether besu will read the key as a timestamp is a property of the GENESIS, not
  // an assumption: any `*Time` hardfork makes the floor milestone time-based (c7).
  let timeBasedFork = true
  if (existsSync(genesisPath)) {
    const cfg = JSON.parse(readFileSync(genesisPath, 'utf8')).config || {}
    timeBasedFork = Object.keys(cfg).some((k) => /Time$/.test(k))
  }

  const verdict = assessRegistrySwap({
    incomingSeats,
    outgoingSeats,
    proposers: [...proposers],
    window,
    transitionKey,
    nowSec,
    timeBasedFork,
    solvency: {
      balanceMicro: inBal,
      recordedStakeMicro: inStake.total,
      forfeitedMicro: forfeited,
      outgoingBalanceMicro: outBal,
    },
    openness: { eligibleCount, minValidators, maxValidators, candidateCount: inStake.candidates },
    courtHealthy,
    court,
    courtValidators,
    incomingEligibleGhosts: eligibleGhosts,
    incomingLabel: incoming,
    outgoingLabel: outgoing,
  })

  const live = (s) => (proposers.has(s.toLowerCase()) ? '🟢 proposing' : '⚫️ silent')
  console.log(`chain ${chainId}  head #${head}  evidence window ${window} block(s), ${proposers.size} distinct proposer(s)`)
  console.log(`\noutgoing (authoritative today) ${outgoing} — ${outgoingSeats.length} seat(s)`)
  for (const s of outgoingSeats) console.log(`   ${getAddress(s)}  ${live(s)}`)
  console.log(`\nincoming (would become authoritative) ${incoming} — ${incomingSeats.length} seat(s)`)
  for (const s of incomingSeats) console.log(`   ${getAddress(s)}  ${live(s)}`)
  console.log(`\nincoming registry: eligible ${eligibleCount} / floor ${minValidators} / cap ${maxValidators}, candidates ${inStake.candidates}`)
  console.log(`   of the eligible, ${eligibleGhosts} are NOT producing blocks — rotate() would seat all of them`)
  console.log(`   holds ${Number(inBal) / 1e6} USDC; records ${Number(inStake.total) / 1e6} staked + ${Number(forfeited) / 1e6} forfeited-and-locked`)
  console.log(`   court answers: ${courtHealthy === undefined ? 'n/a (no courtHealthy view)' : courtHealthy}`)
  if (court) {
    const bound = courtValidators
      ? `${getAddress(courtValidators)}${courtValidators.toLowerCase() === incoming.toLowerCase() ? ' (the incoming registry ✅)' : courtValidators.toLowerCase() === outgoing.toLowerCase() ? ' ⚠️ THE OUTGOING ONE' : ' ⚠️ a THIRD registry'}`
      : 'unreadable ⚠️'
    console.log(`   court ${getAddress(court)} describes: ${bound}`)
  }
  console.log(`transition key checked: ${transitionKey}${arg('transition') ? '' : ` (default: now + ${MIN_TRANSITION_LEAD_S}s)`}, read as a ${timeBasedFork ? 'TIMESTAMP' : 'BLOCK NUMBER'}`)

  console.log(`\n${verdict.ok ? '✅' : '🛑'} ${verdict.summary}`)
  for (const b of verdict.blockers) console.log(`   🛑 ${b}`)
  for (const w of verdict.warnings) console.log(`   ⚠️  ${w}`)
  for (const r of verdict.remediation) console.log(`   → ${r}`)

  if (!verdict.ok) {
    console.log('\nDo NOT edit the genesis. Fix the blockers above and re-run.')
    process.exit(1)
  }
  console.log('\nSwap looks survivable. Re-run immediately before writing the transition — liveness is a fact about right now.')
}

main().catch((err) => {
  console.error('preflight failed:', err?.shortMessage || err?.message || err)
  process.exit(1)
})
