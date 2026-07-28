#!/usr/bin/env node
/**
 * Deploy TinyServeRewards and wire it into TinyIssuance's serve half.
 *
 * ⚠️ THE WIRING STEP FIRES EXACTLY ONCE. TinyIssuance.setServeDistributor is
 * one-shot-then-locked: after this script runs, the serve budget can only ever
 * be minted by the address recorded here. Point it at a broken contract and the
 * serve half of issuance is unmintable forever — there is no fix, by design (an
 * upgradeable minter is not a fixed supply schedule). So this script verifies
 * the deployed contract answers its own view functions BEFORE it locks, and
 * refuses if the lock has already been spent.
 *
 * Usage: node chain/multinode/scripts/deploy-serve-rewards.mjs
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
 * The attestor. ONE member on the devnet, m-of-n in shape from day one.
 *
 * In production this is the worker/facilitator signer: chain/facilitator/server.mjs
 * already sees exactly the fields an attestation needs — payer, payTo, value, and
 * whether the settle tx actually mined — so the attested numbers are things a real
 * service can produce rather than a shape invented for the contract.
 *
 * ⚠️ It is a TRUSTED THIRD PARTY. It is trusted that requests happened and that
 * payer ≠ payee (self-dealing is farmable and the contract cannot see it). Use a
 * dedicated key: this key's signature mints money, so it should not be the same
 * key that pays gas or holds funds.
 */
const ATTESTOR_KEY = process.env.TINY_ATTESTOR_KEY
  || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // anvil #1, devnet only
const THRESHOLD = 1n
/** One server may take at most 50% of an epoch's serve budget. */
const MAX_SERVER_BPS = 5000n

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — run deploy-validators.mjs then deploy-issuance.mjs first`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  if (!d.issuance) {
    console.error('no issuance in the deployment file — run deploy-issuance.mjs first')
    process.exit(1)
  }

  const artPath = join(MULTINODE, 'artifacts/TinyServeRewards.sol/TinyServeRewards.json')
  const issPath = join(MULTINODE, 'artifacts/TinyIssuance.sol/TinyIssuance.json')
  for (const p of [artPath, issPath]) {
    if (!existsSync(p)) {
      console.error(`missing artifact ${p}\n  run: (cd ${MULTINODE} && forge build)`)
      process.exit(1)
    }
  }
  const art = JSON.parse(readFileSync(artPath, 'utf8'))
  const issArt = JSON.parse(readFileSync(issPath, 'utf8'))

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
  const wait = (hash) => pub.waitForTransactionReceipt({ hash })

  // Refuse before deploying if the one-shot is already spent: otherwise we'd
  // leave an orphan contract on-chain that can never mint, and a deployment file
  // pointing at it, which reads exactly like a working install.
  const lockedAlready = await pub.readContract({
    address: d.issuance, abi: issArt.abi, functionName: 'serveDistributorLocked',
  })
  if (lockedAlready) {
    const current = await pub.readContract({
      address: d.issuance, abi: issArt.abi, functionName: 'serveDistributor',
    })
    console.error(`refusing: TinyIssuance's serve distributor is already locked to ${current}.`)
    console.error('That lock is permanent by design. To change it you need a new TinyIssuance,')
    console.error('which means a new token owner — i.e. a fresh chain.')
    process.exit(1)
  }

  const attestor = privateKeyToAccount(ATTESTOR_KEY)
  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`deployer  ${deployer.address}`)
  console.log(`issuance  ${d.issuance}`)
  console.log(`attestor  ${attestor.address}  (threshold ${THRESHOLD} of 1 — TRUSTED ORACLE)`)

  const hash = await wallet.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [d.issuance, [attestor.address], THRESHOLD, MAX_SERVER_BPS], ...FREE,
  })
  const rewards = (await wait(hash)).contractAddress
  console.log(`TinyServeRewards ${rewards}`)

  // Sanity-read the deployed contract BEFORE the irreversible lock. A contract
  // that can't answer its own views is one we must not hand the budget to.
  const [count, thr, domain] = await Promise.all([
    pub.readContract({ address: rewards, abi: art.abi, functionName: 'attestorCount' }),
    pub.readContract({ address: rewards, abi: art.abi, functionName: 'threshold' }),
    pub.readContract({ address: rewards, abi: art.abi, functionName: 'DOMAIN_SEPARATOR' }),
  ])
  const seated = await pub.readContract({ address: rewards, abi: art.abi, functionName: 'attestorList' })
  if (Number(count) !== 1 || Number(thr) !== Number(THRESHOLD) ||
      getAddress(seated[0]) !== getAddress(attestor.address) || !domain || domain === `0x${'0'.repeat(64)}`) {
    console.error('refusing to lock: the deployed contract does not read back as expected')
    console.error({ count, thr, seated, domain })
    process.exit(1)
  }
  console.log('deployed contract reads back correctly (attestor set, threshold, EIP-712 domain) ✓')

  // The irreversible step.
  await wait(await wallet.writeContract({
    address: d.issuance, abi: issArt.abi, functionName: 'setServeDistributor', args: [rewards], ...FREE,
  }))
  const [dist, locked] = await Promise.all([
    pub.readContract({ address: d.issuance, abi: issArt.abi, functionName: 'serveDistributor' }),
    pub.readContract({ address: d.issuance, abi: issArt.abi, functionName: 'serveDistributorLocked' }),
  ])
  if (getAddress(dist) !== getAddress(rewards) || !locked) {
    console.error(`lock did not take: distributor=${dist} locked=${locked}`)
    process.exit(1)
  }
  console.log(`serve distributor -> ${rewards} and LOCKED ✓  (permanent)`)

  writeFileSync(deployPath, JSON.stringify({
    ...d,
    serveRewards: rewards,
    attestors: [attestor.address],
    attestorThreshold: Number(THRESHOLD),
    maxServerBps: Number(MAX_SERVER_BPS),
  }, null, 2) + '\n')
  console.log(`\nwrote ${deployPath}`)
  console.log(`\nnext: node ${join(HERE, 'serve-rewards-e2e.mjs')}`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
