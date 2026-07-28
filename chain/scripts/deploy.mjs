// Deploy TinyUSDC to a running tiny-chain node and mint the treasury.
// Writes chain/deployment.json — the file the app/facilitator env reads from.
import { createWalletClient, createPublicClient, http, defineChain, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isWellKnownKey, devKeysAllowed, devKeyRefusal } from '../dev-keys.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// anvil default account 0 — the monetary authority on a chain we own.
export const DEPLOYER_KEY = process.env.TINY_CHAIN_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/**
 * ⛔ The most consequential guard in this directory. TinyUSDC's `mint` is
 * owner-only and the owner is fixed AT DEPLOY TIME, so deploying with a
 * published dev key hands the token's monetary authority to a keypair the whole
 * internet has — permanently. There is no revoke: the only remedy is deploying a
 * new token and migrating every balance. Unlike the faucet or the facilitator,
 * this cannot be corrected by fixing an env var later, which is why it refuses
 * rather than warns. TINY_CHAIN_ALLOW_DEV_KEYS=1 for a throwaway devnet.
 *
 * @param {string} [key]
 * @param {Record<string, string | undefined>} [env]
 */
export function assertDeployerKeySafe(key = DEPLOYER_KEY, env = process.env) {
  if (!isWellKnownKey(key) || devKeysAllowed(env)) return
  throw new Error(
    devKeyRefusal('the TinyUSDC deployer (its permanent mint authority)', key) +
    ' A deployed token\'s owner CANNOT be changed — this would have to be redeployed.'
  )
}

export function tinyChain(rpc, chainId) {
  return defineChain({
    id: chainId,
    name: 'tiny-chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  })
}

/**
 * Deploy + mint the treasury. Returns the deployment; writes deployment.json
 * unless `write:false`.
 *
 * ⚠️ `write` exists because deployment.json is the file the facilitator reads its
 * USDC address from at startup, it is gitignored (so git cannot restore it), and
 * the e2e scripts call deploy() against a SCRATCH anvil. Left writing, a routine
 * `npm run e2e` silently replaces a live deployment's record with a throwaway
 * address — recoverable only by asking the running chain what it was. The e2es
 * don't need the file at all: they use the returned object.
 */
export async function deploy(rpc = process.env.TINY_CHAIN_RPC_URL || 'http://127.0.0.1:8545', { write = true } = {}) {
  // BEFORE any RPC: a refusal must cost nothing and leave no half-deployed token.
  assertDeployerKeySafe()
  const artifact = JSON.parse(readFileSync(join(ROOT, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const chain = tinyChain(rpc, chainId)
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })

  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  const usdc = receipt.contractAddress

  // Treasury: 1,000,000 USDC (6 decimals) to the deployer — faucet source.
  const mintHash = await wallet.writeContract({
    address: usdc, abi: artifact.abi, functionName: 'mint',
    args: [deployer.address, parseUnits('1000000', 6)],
  })
  await pub.waitForTransactionReceipt({ hash: mintHash })

  const deployment = {
    network: `eip155:${chainId}`,
    chainId,
    rpc,
    usdc,
    deployer: deployer.address,
    eip712Domain: { name: 'USDC', version: '2' },
    deployTx: hash,
  }
  if (write) writeFileSync(join(ROOT, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n')
  return { deployment, abi: artifact.abi }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { deployment } = await deploy()
  console.log(JSON.stringify(deployment, null, 2))
}
