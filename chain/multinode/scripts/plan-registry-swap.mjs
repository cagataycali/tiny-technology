#!/usr/bin/env node
/**
 * 🔁 PLAN THE GENESIS EDIT that performs the registry swap on chain 8470.
 *
 * ⚠️⚠️ WHY THIS EXISTS (c25). Two cycles ended by reporting "both gates green, ready
 * for the transition". `swap-preflight.mjs` answers whether the swap is SURVIVABLE —
 * and it does exit 0. Nothing answered whether anything could PERFORM it. The only
 * script in the tree that writes a qbft transition, `switch-to-contract-mode.sh`,
 * begins by bailing out if the genesis already has a contract-mode fork:
 *
 *     already has a contract-mode transition — nothing to do   → exit 0
 *
 * 8470's genesis has exactly that (it is how the chain reached contract mode). Run
 * on a copy of the real file, that script prints three lines of apparently useful
 * work and then changes nothing, successfully. And deleting the guard would be
 * worse, not better: the next line reads `d['validatorContract']`, the OUTGOING
 * registry — that script knows about one registry and a swap has two.
 *
 * 🔑 A GREEN GATE SAYS THE OPERATION IS SAFE, NEVER THAT ANYTHING CAN PERFORM IT.
 *
 * READ-ONLY, and deliberately so: it prints the exact fork object to append and the
 * exact command to apply it, but **writing the genesis is USER-GATED** and this
 * script will not do it. It makes no transaction, touches no file, and refuses any
 * RPC that is not chain 8470 (the LIVE chain is 8469).
 *
 * Usage:
 *   node chain/multinode/scripts/plan-registry-swap.mjs
 *   node chain/multinode/scripts/plan-registry-swap.mjs --incoming 0x… [--transition <unix>] [--json]
 *
 * Exit 0 = the append is legal and here it is. Exit 1 = REFUSE, with reasons.
 *
 * ⚠️ This checks the SHAPE of the edit (will besu start? does it name the right
 * registry?). It does NOT re-check liveness — run `swap-preflight.mjs` immediately
 * before applying, because whether the chain keeps committing blocks is a fact about
 * right now and its margin has been as thin as one node.
 */
import { createPublicClient, http, getAddress } from 'viem'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { planGenesisTransition } from '../genesis-transition-plan.mjs'
import { MIN_TRANSITION_LEAD_S } from '../registry-swap-policy.mjs'

const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  const genesisPath = join(HOME_DIR, 'network/genesis.json')
  for (const p of [deployPath, genesisPath]) {
    if (!existsSync(p)) {
      console.error(`no ${p} — nothing to plan against`)
      process.exit(1)
    }
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  const genesis = JSON.parse(readFileSync(genesisPath, 'utf8'))

  const incomingRaw = arg('incoming') || d.validatorContractSlashable
  if (!incomingRaw) {
    console.error('no incoming registry: pass --incoming 0x… or record validatorContractSlashable in the deployment file')
    process.exit(1)
  }
  const incoming = getAddress(incomingRaw)

  // ⚠️ The OUTGOING registry is read from the GENESIS, not from the deployment file's
  // `validatorContract`. Besu obeys the genesis; the deployment file is a note we
  // keep. Trusting the note is how the old writer would have named the wrong
  // contract — and if the two disagree, the planner blocks and says so.
  const forks = genesis?.config?.transitions?.qbft
  const latest = Array.isArray(forks)
    ? forks.reduce((a, f) => (f?.validatorcontractaddress && (!a || Number(f.block) > Number(a.block)) ? f : a), null)
    : null
  const outgoing = latest ? getAddress(latest.validatorcontractaddress) : undefined

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. The LIVE chain is 8469 — never point this at it.`)
    process.exit(1)
  }
  const head = await pub.getBlockNumber()
  const nowSec = Number((await pub.getBlock({ blockNumber: head })).timestamp)

  const transitionKey = arg('transition') ? Number(arg('transition')) : nowSec + MIN_TRANSITION_LEAD_S * 2
  const plan = planGenesisTransition({
    genesis,
    incoming,
    outgoing,
    transitionKey,
    nowSec,
    nowBlock: Number(head),
  })

  if (arg('json') !== undefined || process.argv.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2))
    process.exit(plan.ok ? 0 : 1)
  }

  console.log(`chain ${chainId}  head #${head}  now ${nowSec}`)
  console.log(`genesis ${genesisPath}`)
  console.log(`   existing qbft transition(s): ${plan.existing.length}`)
  for (const f of plan.existing) {
    const mark = outgoing && f.validatorcontractaddress?.toLowerCase() === outgoing.toLowerCase() ? ' ← in effect (highest key)' : ''
    console.log(`      key ${f.block}  ${f.validatorcontractaddress || '(header mode)'}${mark}`)
  }
  console.log(`\noutgoing (per the GENESIS, which is what besu obeys): ${outgoing || 'none — header mode'}`)
  if (outgoing && d.validatorContract && getAddress(d.validatorContract) !== outgoing) {
    console.log(`   ⚠️  the deployment file's validatorContract is ${getAddress(d.validatorContract)} — it disagrees with the genesis`)
  }
  console.log(`incoming (would become authoritative): ${incoming}`)
  console.log(`transition key: ${transitionKey}, read as a ${plan.timeBasedFork ? 'TIMESTAMP' : 'BLOCK NUMBER'} (derived from the genesis)`)

  console.log(`\n${plan.ok ? '✅' : '🛑'} ${plan.summary}`)
  for (const b of plan.blockers) console.log(`   🛑 ${b}`)
  for (const w of plan.warnings) console.log(`   ⚠️  ${w}`)

  if (!plan.ok) {
    console.log('\nDo NOT edit the genesis. Fix the blockers above and re-run.')
    process.exit(1)
  }

  console.log(`\nAppend this ONE object to config.transitions.qbft in the genesis of EVERY node:\n`)
  console.log(JSON.stringify(plan.fork, null, 2))
  console.log(`\n⚠️  Writing it is USER-GATED and this script will not do it. When authorized:`)
  console.log(`   1. node chain/multinode/scripts/swap-preflight.mjs --incoming ${incoming}`)
  console.log(`      — liveness is a fact about RIGHT NOW; re-run it immediately before writing.`)
  console.log(`   2. back up each genesis, append the object above, restart every node.`)
  console.log(`   3. a duplicate key makes besu REFUSE TO START, so re-running step 2 needs a fresh key.`)
  console.log(`   4. after the transition key passes, confirm qbft_getValidatorsByBlockNumber matches`)
  console.log(`      the incoming registry's getValidators().`)
}

main().catch((err) => {
  console.error('plan failed:', err?.shortMessage || err?.message || err)
  process.exit(1)
})
