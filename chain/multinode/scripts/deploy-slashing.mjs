#!/usr/bin/env node
/**
 * Deploy TinySlashing — the equivocation court — on chain 8470.
 *
 * Safe to run repeatedly and safe to run late: this contract holds no funds, has
 * no privileged caller, and nothing else points at it. That is a consequence of
 * what it is (a court that records verdicts, not an executioner that burns
 * stake), and it is why this deploy needs none of the one-shot-lock ceremony that
 * deploy-serve-rewards.mjs does.
 *
 * ⚠️ It also means deploying this does NOT make stake slashable yet. Enforcement
 * requires a registry that consults isEquivocator(), and TinyValidators is
 * deployed with no hook and no admin — see the contract header. Recording that
 * limit is part of shipping this, not a caveat to be tidied away later.
 *
 * Usage: node chain/multinode/scripts/deploy-slashing.mjs
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

/**
 * Evidence window, in blocks. 256 is the EVM's own `blockhash` reach and the
 * anchor is what keeps a foreign chain's seal from convicting an honest key here,
 * so the window cannot be widened without weakening the rule — see the contract's
 * "honest limit" note. At 2s blocks this is ~8.5 minutes.
 *
 * ⚠️ Re-deploying is expected after any change to the digest rules: convictions
 * live in this contract's storage, so a fresh deploy starts with an empty docket.
 * That was acceptable for the round≠0 fix (nothing had been convicted but test
 * culprits) and would NOT be after a real conviction — migrate the docket then.
 */
const MAX_EVIDENCE_AGE = 256n

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

  const artPath = join(MULTINODE, 'artifacts/TinySlashing.sol/TinySlashing.json')
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

  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`deployer   ${deployer.address}`)
  console.log(`validators ${d.validatorContract}`)

  const hash = await wallet.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [d.validatorContract, MAX_EVIDENCE_AGE], ...FREE,
  })
  const slashing = (await pub.waitForTransactionReceipt({ hash })).contractAddress
  console.log(`TinySlashing ${slashing}`)

  // Read the deployment back. A header parser is the kind of code that can be
  // deployed broken and stay silent until the day someone needs it, so prove it
  // answers on a REAL block right here rather than trusting the compile.
  const head = await pub.getBlockNumber()
  const [registry, age] = await Promise.all([
    pub.readContract({ address: slashing, abi: art.abi, functionName: 'validators' }),
    pub.readContract({ address: slashing, abi: art.abi, functionName: 'maxEvidenceAge' }),
  ])
  if (getAddress(registry) !== getAddress(d.validatorContract) || age !== MAX_EVIDENCE_AGE) {
    console.error(`refusing to record: reads back wrong (registry=${registry} age=${age})`)
    process.exit(1)
  }
  console.log(`reads back: registry ✓  maxEvidenceAge ${age} blocks ✓  (head ${head})`)

  writeFileSync(deployPath, JSON.stringify({
    ...d,
    slashing,
    maxEvidenceAge: Number(MAX_EVIDENCE_AGE),
  }, null, 2) + '\n')
  console.log(`\nwrote ${deployPath}`)
  console.log('\n⚠️  Convictions are RECORDED, not enforced: TinyValidators has no hook to')
  console.log('    burn stake and no admin to add one. Enforcement = a registry that reads')
  console.log('    isEquivocator(), i.e. a registry swap. Do not describe stake as slashable yet.')
  console.log(`\nnext: node ${join(HERE, 'slashing-e2e.mjs')}`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
