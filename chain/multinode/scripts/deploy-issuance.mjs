#!/usr/bin/env node
/**
 * Deploy TinyIssuance on 8470 and hand it the token's mint authority.
 *
 * The load-bearing step is the LAST one: transferOwnership on TinyUSDC. Before
 * it, the schedule is decoration — the deployer key can still mint whatever it
 * likes, so no cap in the contract means anything. After it, the deployer key
 * cannot mint at all, and that is checkable by anyone: `usdc.owner()`.
 *
 * ⚠️ IRREVERSIBLE on this chain. Once ownership moves, nothing can move it back
 * (TinyIssuance has no owner and never calls transferOwnership). If the faucet
 * on 8470 ever needs to mint again it must do so through an issuance path, which
 * is the intended consequence, not an oversight. Refuses to run against any
 * chain but 8470 for exactly this reason — on the live 8469 this script would
 * permanently sever the faucet from its mint.
 *
 * Usage: node chain/multinode/scripts/deploy-issuance.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const CHAIN = dirname(MULTINODE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/**
 * Schedule parameters for the devnet.
 *
 * EPOCH_BLOCKS matches TinyValidators' epoch so "an epoch" means one thing on
 * this chain: two different epoch lengths would make reward periods and seating
 * periods drift in and out of phase, and every explanation of the economy would
 * need a caveat about which epoch was meant.
 *
 * Budget/halving are devnet-shaped (small budget, fast halving) so the decay is
 * observable in a test rather than in a year. The real values are an open
 * economic question — design §7 — and belong to the user, not to this script.
 */
const EPOCH_BLOCKS = 20n
const INITIAL_EPOCH_BUDGET = parseUnits('100', 6) // 100 USDC per epoch at genesis
const HALVING_EPOCHS = 50n
const VALIDATOR_SHARE_BPS = 6000n // 60% validate-to-earn / 40% serve-to-earn
/**
 * 5000 = one address may take at most half of an epoch's validator budget.
 * Rewards are pro-rata over CREDITED blocks and crediting is opt-in, so a lone
 * diligent validator would otherwise sweep 100% of an epoch its peers ignored.
 */
const MAX_RECIPIENT_BPS = 5000n

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

async function main() {
  const valDeployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(valDeployPath)) {
    console.error(`no ${valDeployPath} — run deploy-validators.mjs first`)
    process.exit(1)
  }
  const vd = JSON.parse(readFileSync(valDeployPath, 'utf8'))

  const issArtPath = join(MULTINODE, 'artifacts/TinyIssuance.sol/TinyIssuance.json')
  const usdcArtPath = join(CHAIN, 'artifacts/TinyUSDC.sol/TinyUSDC.json')
  for (const p of [issArtPath, usdcArtPath]) {
    if (!existsSync(p)) {
      console.error(`missing artifact ${p}\n  run: (cd ${p === usdcArtPath ? CHAIN : MULTINODE} && forge build)`)
      process.exit(1)
    }
  }
  const issArt = JSON.parse(readFileSync(issArtPath, 'utf8'))
  const usdcArt = JSON.parse(readFileSync(usdcArtPath, 'utf8'))

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}.`)
    console.error('The LIVE chain is 8469 — moving its token ownership would permanently break the faucet.')
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

  console.log(`chain ${chainId} @ ${RPC}\ndeployer ${deployer.address}\nTinyUSDC ${vd.usdc}`)

  // The deployer must currently own the token, or there is nothing to hand over
  // and the "sole minter" claim would be false in a way no later test catches.
  const currentOwner = await pub.readContract({
    address: vd.usdc, abi: usdcArt.abi, functionName: 'owner',
  })
  if (getAddress(currentOwner) !== getAddress(deployer.address)) {
    console.error(`refusing: TinyUSDC owner is ${currentOwner}, not the deployer.`)
    console.error('Ownership has already moved — re-deploying issuance would leave a minter that cannot mint.')
    process.exit(1)
  }

  // 1. the schedule
  const issHash = await wallet.deployContract({
    abi: issArt.abi, bytecode: issArt.bytecode.object,
    args: [vd.usdc, EPOCH_BLOCKS, INITIAL_EPOCH_BUDGET, HALVING_EPOCHS, VALIDATOR_SHARE_BPS, MAX_RECIPIENT_BPS],
    ...FREE,
  })
  const issuance = (await wait(issHash)).contractAddress
  console.log(`TinyIssuance   ${issuance}`)

  // 2. hand over mint authority — the irreversible step
  await wait(await wallet.writeContract({
    address: vd.usdc, abi: usdcArt.abi, functionName: 'transferOwnership', args: [issuance], ...FREE,
  }))
  const newOwner = await pub.readContract({ address: vd.usdc, abi: usdcArt.abi, functionName: 'owner' })
  if (getAddress(newOwner) !== getAddress(issuance)) {
    console.error(`ownership transfer did not take: owner is ${newOwner}`)
    process.exit(1)
  }
  console.log('TinyUSDC ownership -> TinyIssuance ✓  (the deployer key can no longer mint)')

  const startBlock = await pub.readContract({ address: issuance, abi: issArt.abi, functionName: 'startBlock' })
  const out = {
    ...vd,
    issuance,
    issuanceStartBlock: Number(startBlock),
    issuanceEpochBlocks: Number(EPOCH_BLOCKS),
    initialEpochBudget: INITIAL_EPOCH_BUDGET.toString(),
    halvingEpochs: Number(HALVING_EPOCHS),
    validatorShareBps: Number(VALIDATOR_SHARE_BPS),
    maxRecipientBps: Number(MAX_RECIPIENT_BPS),
  }
  writeFileSync(valDeployPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`\nwrote ${valDeployPath}`)
  console.log(`\nnext: node ${join(HERE, 'issuance-e2e.mjs')}`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
