#!/usr/bin/env node
/**
 * Deploy TinyValidatorsSlashable — the registry that ENFORCES a conviction — on
 * chain 8470.
 *
 * ⚠️ THIS DOES NOT SWAP THE LIVE REGISTRY, AND ON PURPOSE. Besu reads the address
 * named in genesis, so making this registry authoritative is a genesis transition
 * applied to every node (switch-to-contract-mode.sh's job) — and the new registry
 * starts with an EMPTY seated set, which Besu treats as fatal. So the swap is its
 * own increment, with its own migration of stake and candidates, and the honest
 * order is: deploy → prove the enforcement works against the real chain → then
 * cut over. Shipping this deploy while calling the chain "slashable" would be the
 * same overclaim TinySlashing was careful not to make.
 *
 * What it IS good for today: the enforcement logic runs against real chain state,
 * a real court, and real convictions, so the acceptance suite measures a contract
 * on a chain rather than a fixture on a fork.
 *
 * Safe to re-run. Holds no funds until someone stakes into it, has no admin, and
 * nothing points at it until the transition.
 *
 * Usage: node chain/multinode/scripts/deploy-validators-slashable.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pickInitialValidators } from '../initial-seat-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — run deploy-validators.mjs first`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  if (!d.slashing) {
    console.error('no slashing in the deployment file — run deploy-slashing.mjs first.')
    console.error('A "slashable" registry with no court is a name that lies; the constructor refuses address(0).')
    process.exit(1)
  }

  const artPath = join(MULTINODE, 'artifacts/TinyValidatorsSlashable.sol/TinyValidatorsSlashable.json')
  if (!existsSync(artPath)) {
    console.error(`missing artifact ${artPath}\n  run: (cd ${MULTINODE} && forge build)`)
    process.exit(1)
  }
  const art = JSON.parse(readFileSync(artPath, 'utf8'))

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  // Refuse loudly rather than deploy onto the live 8469 by a mistyped port.
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. The LIVE chain is 8469 — never deploy this there.`)
    process.exit(1)
  }
  const chain = defineChain({
    id: chainId, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const wait = (hash) => pub.waitForTransactionReceipt({ hash })

  console.log(`chain ${chainId} @ ${RPC}\ndeployer ${deployer.address}`)
  console.log(`court (TinySlashing) ${d.slashing}`)

  /**
   * Seat it with the CURRENT live set, read from the chain — not from the
   * deployment file's `initialValidators`.
   *
   * The file records the four founders. The live set has since grown (a stranger
   * staked and rotate() seated them), which is the entire point of the chain, so
   * a registry seeded from the file would be born describing a validator set that
   * no longer exists. The one thing Besu cannot survive is disagreeing with the
   * registry about who is allowed to sign.
   *
   * ⚠️ c20: "the live set" used to mean `getValidators()` — the SEATED set — and
   * seated is not live. c19 measured the difference: the outgoing set holds a
   * validator that is silent, keyless, and holds stake nobody can move, so a fresh
   * registry seeded that way was born with the exact problem the fresh deploy
   * exists to escape. Liveness is now OBSERVED from who proposes blocks, and the
   * seed is a policy decision that can REFUSE (initial-seat-policy.mjs) — because
   * a wrongly-dropped seat cannot re-enter after P3 took away mint().
   */
  const valAbi = JSON.parse(
    readFileSync(join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json'), 'utf8')
  ).abi
  const seatedOutgoing = (await pub.readContract({
    address: d.validatorContract, abi: valAbi, functionName: 'getValidators',
  })).map((a) => getAddress(a))

  // Independent evidence of liveness: one full round-robin of the outgoing set ×3,
  // because a validator that has not had its turn reads as silent (c15) and here
  // that costs it a seat.
  const head = await pub.getBlockNumber()
  const window = Math.max(seatedOutgoing.length, 1) * 3
  const proposers = new Set()
  for (let i = 0; i < window; i++) {
    const b = await pub.getBlock({ blockNumber: head - BigInt(i) })
    proposers.add(b.miner.toLowerCase())
  }

  const minStake = await pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'minStake' })
  const maxValidators = await pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'maxValidators' })
  const minValidators = await pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'minValidators' })
  const epochBlocks = await pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'epochBlocks' })

  // Which of those seats belong in the constructor. This can refuse — an evidence
  // window too short to call anyone silent, or a live set under the floor.
  const trappedMicro = {}
  for (const a of seatedOutgoing) {
    trappedMicro[a] = await pub.readContract({ address: d.validatorContract, abi: valAbi, functionName: 'stakeOf', args: [a] })
  }
  const seed = pickInitialValidators({
    seatedOutgoing,
    proposers: [...proposers],
    window,
    minValidators: Number(minValidators),
    maxValidators: Number(maxValidators),
    trappedMicro,
  })
  console.log(`\nseeding the constructor from OBSERVED liveness (${window}-block window):`)
  for (const a of seatedOutgoing) {
    console.log(`   ${a}  ${proposers.has(a.toLowerCase()) ? '🟢 proposing → seated' : '⚫️ silent    → NOT seated'}`)
  }
  for (const w of seed.warnings) console.log(`   ⚠️  ${w}`)
  if (!seed.ok) {
    for (const b of seed.blockers) console.error(`   🛑 ${b}`)
    console.error('\nRefusing to deploy: the constructor set is a near-irreversible decision (no mint after P3).')
    process.exit(1)
  }
  const live = seed.initial.map((a) => getAddress(a))
  console.log(`constructor set: ${live.length} of ${seatedOutgoing.length} seated address(es)`)

  const hash = await wallet.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [d.usdc, d.slashing, minStake, maxValidators, minValidators, epochBlocks, seed.initial], ...FREE,
  })
  const registry = (await wait(hash)).contractAddress
  console.log(`TinyValidatorsSlashable ${registry}`)

  // Read back the three things a broken deploy would get wrong, BEFORE recording
  // it. `getValidators()` is what Besu will call every block once this is
  // authoritative; an empty or mismatched answer there halts a chain.
  const seated = (await pub.readContract({ address: registry, abi: art.abi, functionName: 'getValidators' }))
    .map((a) => getAddress(a))
  const sameSet = seated.length === live.length && seated.every((a, i) => a === live[i])
  if (!sameSet) {
    console.error(`getValidators() mismatch\n  new: ${seated}\n  intended: ${live}`)
    process.exit(1)
  }
  const court = getAddress(await pub.readContract({ address: registry, abi: art.abi, functionName: 'court' }))
  if (court !== getAddress(d.slashing)) {
    console.error(`court mismatch: ${court} != ${d.slashing}`)
    process.exit(1)
  }
  // The fail-open design means a court that never answers is INVISIBLE: nothing
  // breaks, convictions simply stop mattering. Assert it answers at deploy time,
  // which is the only moment anyone is looking.
  const healthy = await pub.readContract({ address: registry, abi: art.abi, functionName: 'courtHealthy' })
  if (!healthy) {
    console.error(`courtHealthy() is false — ${d.slashing} does not answer isEquivocator().`)
    console.error('Enforcement would fail OPEN (by design) and nothing would look wrong. Refusing to record this.')
    process.exit(1)
  }
  console.log(`getValidators() returns the ${seated.length} live validators ✓`)
  console.log('courtHealthy() ✓ — the docket answers')

  // ⚠️ c20: keep the address this key USED to hold. swap-preflight refuses to swap
  // to a ghost-laden instance BY ADDRESS, and the tests name it — overwriting the
  // only record of it means a future cycle can re-aim at a registry that was
  // already ruled out, having lost the reason why.
  if (d.validatorContractSlashable && d.validatorContractSlashable.toLowerCase() !== registry.toLowerCase()) {
    d.previousValidatorContractSlashable = [
      ...(Array.isArray(d.previousValidatorContractSlashable) ? d.previousValidatorContractSlashable : []),
      d.validatorContractSlashable,
    ]
  }
  d.validatorContractSlashable = registry
  // NOT `validatorContract`. That key is what every other script and the genesis
  // transition read; overwriting it here would silently repoint tooling at a
  // registry Besu has never heard of.
  d.slashableEnforced = false
  writeFileSync(deployPath, JSON.stringify(d, null, 2) + '\n')
  console.log(`\nwrote ${deployPath} (validatorContractSlashable, slashableEnforced: false)`)

  console.log(`
⚠️  Deployed, NOT authoritative. Besu still reads ${d.validatorContract}.
    Convictions cost reputation only until a genesis transition points every node
    here — and that swap must migrate stake and candidates first, because this
    registry's candidate pool is currently just the ${seated.length} seated keys with no
    stake recorded, so its own rotate() would revert BelowValidatorFloor.

next, in this order — each step is checkable and the last two can REFUSE:
  1. node chain/multinode/scripts/stake-migration-plan.mjs --incoming ${registry}
     (can the ${live.length} seated key(s) actually be funded to minStake? stake in the
      outgoing registry is trapped behind StillSeated() and mint() is gone to
      TinyIssuance, so this is a question about balances, not about code)
  2. run that plan's steps, then:
     node chain/multinode/scripts/swap-preflight.mjs --incoming ${registry}
     must exit 0 BEFORE the genesis is touched
  3. node chain/multinode/scripts/slashable-registry-e2e.mjs (enforcement acceptance)`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
