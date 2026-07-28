#!/usr/bin/env node
/**
 * Deploy TinyValidatorAttendance — the on-chain record of which seated
 * validators are actually producing blocks — on chain 8470.
 *
 * Safe to run repeatedly and safe to run late, for the same reasons
 * deploy-slashing.mjs is: this contract holds no funds, has no privileged caller,
 * has no one-shot lock, and nothing depends on it for liveness. Redeploying
 * loses the attendance history and nothing else.
 *
 * ⚠️ Deploying this does NOT make absence cost anything. It records evidence; no
 * seat is lost, no reward withheld, no stake touched. Enforcement is a later
 * increment and it needs the registry to consult this contract — which is a
 * registry swap, exactly as P4's court needed one. Recording that limit is part
 * of shipping this, not a caveat to tidy away later.
 *
 * ⚠️ AND UNTIL VALIDATORS RUN AN ATTEST LOOP, A SILENT RECORD MEANS "NOBODY
 * ATTESTS HERE", NOT "THIS VALIDATOR IS DEAD". The script prints the
 * participation count for exactly that reason: an enforcement rule switched on
 * against a participation of 0 would convict the entire honest set at once.
 *
 * Usage: node chain/multinode/scripts/deploy-attendance.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

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
  if (!d.validatorContract) {
    console.error('no validatorContract in the deployment file — run deploy-validators.mjs first')
    process.exit(1)
  }

  const artPath = join(MULTINODE, 'artifacts/TinyValidatorAttendance.sol/TinyValidatorAttendance.json')
  if (!existsSync(artPath)) {
    console.error(`missing artifact ${artPath}\n  run: (cd ${MULTINODE} && forge build)`)
    process.exit(1)
  }
  const art = JSON.parse(readFileSync(artPath, 'utf8'))

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
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })

  /**
   * The epoch length comes from the REGISTRY, never from a constant here.
   *
   * The contract's constructor re-checks it against the same registry, so this
   * is belt-and-braces — but the reason both exist is that the failure is
   * silent: a contract whose epochs are not the epochs seats change on answers
   * every question confidently about the wrong window.
   */
  const registryAbi = [{
    name: 'epochBlocks', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  }]
  const epochBlocks = await pub.readContract({
    address: d.validatorContract, abi: registryAbi, functionName: 'epochBlocks',
  })

  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`deployer    ${deployer.address}`)
  console.log(`registry    ${d.validatorContract}`)
  console.log(`epochBlocks ${epochBlocks} (read from the registry)`)

  const hash = await wallet.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [epochBlocks, d.validatorContract], ...FREE,
  })
  const attendance = (await pub.waitForTransactionReceipt({ hash })).contractAddress
  console.log(`TinyValidatorAttendance ${attendance}`)

  // Read it back on a REAL block. In particular `currentProposer()` — the fact
  // this whole contract rests on is that block.coinbase IS the QBFT proposer,
  // and a deploy that can't demonstrate it on the chain it just landed on has no
  // business being recorded as working.
  const head = await pub.getBlockNumber()
  const [eb, startEpoch, proposer, total] = await Promise.all([
    pub.readContract({ address: attendance, abi: art.abi, functionName: 'epochBlocks' }),
    pub.readContract({ address: attendance, abi: art.abi, functionName: 'startEpoch' }),
    pub.readContract({ address: attendance, abi: art.abi, functionName: 'currentProposer' }),
    pub.readContract({ address: attendance, abi: art.abi, functionName: 'totalAttestations' }),
  ])
  const block = await pub.getBlock({ blockNumber: head })
  if (eb !== epochBlocks || getAddress(proposer) !== getAddress(block.miner) || total !== 0n) {
    console.error(`refusing to record: reads back wrong (epochBlocks=${eb} proposer=${proposer} vs miner=${block.miner} total=${total})`)
    process.exit(1)
  }
  console.log(`reads back: epochBlocks ✓  startEpoch ${startEpoch}  currentProposer == block ${head} miner ✓`)

  writeFileSync(deployPath, JSON.stringify({
    ...d,
    attendance,
    attendanceStartEpoch: Number(startEpoch),
    attendanceEnforced: false,
  }, null, 2) + '\n')
  console.log(`\nwrote ${deployPath}`)
  console.log('\n⚠️  Attendance is RECORDED, not enforced: no seat is lost, no reward withheld,')
  console.log('    no stake touched. Enforcement needs a registry that reads this contract —')
  console.log('    a registry swap, exactly like P4\'s court. Do not describe seats as')
  console.log('    liveness-gated yet (attendanceEnforced: false).')
  console.log('\n⚠️  And absence only MEANS absence once validators attest. Until then a silent')
  console.log('    record says "nobody attests here". Check participation() before believing')
  console.log('    any verdict, and never enforce against a participation of 0.')
  console.log(`\nnext: node ${join(HERE, 'attendance-e2e.mjs')}`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
