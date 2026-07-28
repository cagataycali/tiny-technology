#!/usr/bin/env node
/**
 * Deploy the 8470 stake token + TinyValidators, and print the genesis
 * transition that hands validator selection over to the contract.
 *
 * Order matters and is not arbitrary: the contract must EXIST before the chain
 * is told to obey it. So the chain runs in header mode (P1), we deploy here,
 * and only then does a transition at a future block switch Besu to contract
 * mode. Naming a not-yet-deployed address in the genesis would mean Besu asks
 * an empty account for validators, gets nothing, and halts at block 1.
 *
 * The initial set is the four current validators — the same addresses, so the
 * switch changes WHO DECIDES the set without changing the set itself. Nothing
 * about consensus should wobble on the transition block; the only difference is
 * that afterwards, a stranger can join.
 *
 * ⚠️ MUST run BEFORE deploy-issuance.mjs. This script mints the founders' stake
 * with the deployer key, and P3 hands TinyUSDC's ownership to TinyIssuance —
 * after which every mint() here reverts "TinyUSDC: not owner". That ordering is
 * not a limitation to work around: once issuance is a rule, the bootstrap grant
 * has to have happened already or be earned like everyone else's.
 *
 * Usage: node chain/multinode/scripts/deploy-validators.mjs [--nodes 4]
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

const NODES = Number(process.argv.includes('--nodes') ? process.argv[process.argv.indexOf('--nodes') + 1] : 4)
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

// The stake token is the SAME TinyUSDC source the live chain uses, read from
// chain/artifacts on purpose: a second copy of the .sol could drift, and then
// "TinyUSDC" would mean two different tokens depending on which chain you asked.
const USDC_ARTIFACT = join(CHAIN, 'artifacts/TinyUSDC.sol/TinyUSDC.json')
const VALIDATORS_ARTIFACT = join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json')

// Devnet-only deployer (anvil account 0). On 8470 this key owns the token's mint
// authority, which is exactly why P7 (real cutover) must NOT reuse it — see the
// refusal in chain/scripts/deploy.mjs. Fine here: this chain is disposable.
const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// Stake sizing for the devnet. MIN_STAKE's real value is an open economic
// question (design §7) — we mint the stake asset, so if faucet credit could be
// staked, Sybil resistance would be theatre.
const MIN_STAKE = parseUnits('1000', 6)
const GRANT = parseUnits('5000', 6)
const MAX_VALIDATORS = 21n

/**
 * The floor. 4 is the smallest QBFT set with any fault tolerance at all:
 * f = ⌊(n-1)/3⌋, so 4 → f=1 and 3 → f=0. Below it, one bad node stops the chain.
 * rotate() refuses to seat fewer than this.
 */
const MIN_VALIDATORS = 4n
const EPOCH_BLOCKS = 20n // short so a devnet rotation is observable in ~40s

// zeroBaseFee + --min-gas-price=0: every tx pays literally nothing, which is
// what lets a validator key stake while holding no native coin at all.
const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

const nodeIds = Array.from({ length: NODES }, (_, i) => i + 1)

function nodeKey(n) {
  const raw = readFileSync(join(HOME_DIR, `node${n}/data/key`), 'utf8').trim()
  return raw.startsWith('0x') ? raw : `0x${raw}`
}

async function main() {
  for (const p of [USDC_ARTIFACT, VALIDATORS_ARTIFACT]) {
    if (!existsSync(p)) {
      console.error(`missing artifact ${p}\n  run: (cd ${p === USDC_ARTIFACT ? CHAIN : MULTINODE} && forge build)`)
      process.exit(1)
    }
  }
  const usdcArt = JSON.parse(readFileSync(USDC_ARTIFACT, 'utf8'))
  const valArt = JSON.parse(readFileSync(VALIDATORS_ARTIFACT, 'utf8'))

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  // Refuse loudly rather than deploy onto the live 8469 by a mistyped port.
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. The LIVE chain is 8469 — never deploy this there.`)
    process.exit(1)
  }
  const chain = defineChain({
    id: chainId,
    name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const wait = (hash) => pub.waitForTransactionReceipt({ hash })

  console.log(`chain ${chainId} @ ${RPC}\ndeployer ${deployer.address}`)

  // 1. stake token
  const usdcHash = await wallet.deployContract({ abi: usdcArt.abi, bytecode: usdcArt.bytecode.object, ...FREE })
  const usdc = (await wait(usdcHash)).contractAddress
  console.log(`TinyUSDC       ${usdc}`)

  // 2. seed the validator keys so they can post stake. On a devnet we hand it
  //    out; on a real chain a joiner buys or earns it.
  const validators = nodeIds.map((n) => getAddress(privateKeyToAccount(nodeKey(n)).address))
  await wait(await wallet.writeContract({
    address: usdc, abi: usdcArt.abi, functionName: 'mint',
    args: [deployer.address, parseUnits('1000000', 6)], ...FREE,
  }))
  for (const v of validators) {
    await wait(await wallet.writeContract({
      address: usdc, abi: usdcArt.abi, functionName: 'mint', args: [v, GRANT], ...FREE,
    }))
  }
  console.log(`minted ${GRANT / 1000000n} stake units to each of ${validators.length} validator keys`)

  // 3. validator registry, pre-seated with the CURRENT set
  const valHash = await wallet.deployContract({
    abi: valArt.abi, bytecode: valArt.bytecode.object,
    args: [usdc, MIN_STAKE, MAX_VALIDATORS, MIN_VALIDATORS, EPOCH_BLOCKS, validators], ...FREE,
  })
  const registry = (await wait(valHash)).contractAddress
  console.log(`TinyValidators ${registry}`)

  // 3b. Founders post stake, by the same rule as any joiner.
  //
  // Not a formality: the constructor seats them and enrols them as candidates,
  // but a candidate holding no stake is INELIGIBLE. Skip this and the very first
  // rotation finds fewer eligible validators than the floor and reverts — the
  // chain would keep running on the founding set forever and no stranger could
  // ever join, which is the failure that looks most like success.
  //
  // Each node key needs gas money too: zero-price gas still requires the sender
  // to exist in state (see the alloc comment in qbft-config.json).
  for (const n of nodeIds) {
    const nodeWallet = createWalletClient({ account: privateKeyToAccount(nodeKey(n)), chain, transport: http(RPC) })
    await wait(await wallet.sendTransaction({
      to: validators[n - 1], value: parseUnits('1', 18), gas: 30_000n, ...FREE,
    }))
    await wait(await nodeWallet.writeContract({
      address: usdc, abi: usdcArt.abi, functionName: 'approve', args: [registry, MIN_STAKE * 2n], ...FREE,
    }))
    await wait(await nodeWallet.writeContract({
      address: registry, abi: valArt.abi, functionName: 'stake', args: [MIN_STAKE * 2n], ...FREE,
    }))
  }
  console.log(`all ${nodeIds.length} founding validators have posted stake — eligible under the same rule as strangers`)

  // 4. prove the hook answers BEFORE we ask Besu to depend on it. If this read
  //    is wrong, the transition would halt the chain — and a halted chain is
  //    much harder to debug than a failed script.
  const seated = await pub.readContract({ address: registry, abi: valArt.abi, functionName: 'getValidators' })
  const same = seated.length === validators.length
    && seated.every((a, i) => getAddress(a) === validators[i])
  if (!same) {
    console.error(`getValidators() mismatch\n  contract: ${seated}\n  nodes:    ${validators}`)
    process.exit(1)
  }
  console.log(`getValidators() returns the ${seated.length} live validators ✓`)

  // 5. the transition block: far enough ahead that every node can be restarted
  //    with the new config before it arrives. If a node is still in header mode
  //    when the others switch, it forks.
  const head = await pub.getBlockNumber()
  const transitionBlock = Number(head) + 200

  const out = {
    chainId,
    rpc: RPC,
    usdc,
    validatorContract: registry,
    deployer: deployer.address,
    initialValidators: validators,
    minStake: MIN_STAKE.toString(),
    maxValidators: Number(MAX_VALIDATORS),
    minValidators: Number(MIN_VALIDATORS),
    epochBlocks: Number(EPOCH_BLOCKS),
    transitionBlock,
    eip712Domain: { name: 'USDC', version: '2' },
  }
  const path = join(HOME_DIR, 'validators-deployment.json')
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  console.log(`\nwrote ${path}`)
  console.log(`\nnext: bash chain/multinode/scripts/switch-to-contract-mode.sh   (transition at block ${transitionBlock}, head is ${head})`)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
