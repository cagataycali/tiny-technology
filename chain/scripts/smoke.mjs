// EIP-3009 smoke test against a deployed TinyUSDC.
//
// Proves the ONE property the whole x402 stack depends on: a typed-data
// signature produced with the EXACT structure lib/x402/payer.ts:296-330
// (buildTypedData) signs — TransferWithAuthorization, domain {name:'USDC',
// version:'2', chainId, verifyingContract} — moves tokens on the tiny chain
// when submitted by a THIRD party (the facilitator role: payer pays no gas),
// and that replaying the same authorization reverts.
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tinyChain, DEPLOYER_KEY } from './deploy.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// anvil default accounts 1 (payer) and 2 (relayer/facilitator).
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const RELAYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const ok = (cond, label) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
}

export async function smoke(rpc, usdc, abi) {
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const chain = tinyChain(rpc, chainId)
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const payer = privateKeyToAccount(PAYER_KEY)
  const relayer = privateKeyToAccount(RELAYER_KEY)
  const treasury = createWalletClient({ account: deployer, chain, transport: http(rpc) })
  const facilitator = createWalletClient({ account: relayer, chain, transport: http(rpc) })

  // Fund the payer from the treasury: $5.00.
  const fund = await treasury.writeContract({
    address: usdc, abi, functionName: 'transfer', args: [payer.address, parseUnits('5', 6)],
  })
  await pub.waitForTransactionReceipt({ hash: fund })
  ok((await pub.readContract({ address: usdc, abi, functionName: 'balanceOf', args: [payer.address] })) === parseUnits('5', 6), 'payer funded $5.00')

  // Mirror of buildAuthorization (payer.ts:270-289) + buildTypedData
  // (payer.ts:296-330) with spec-default domain fallbacks — field for field.
  const nowSec = Math.floor(Date.now() / 1000)
  const authorization = {
    from: payer.address,
    to: relayer.address, // stand-in payTo
    value: String(1_500_000), // $1.50 in micro-USDC
    validAfter: String(Math.max(0, nowSec - 60)),
    validBefore: String(nowSec + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const typedData = {
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    domain: { name: 'USDC', version: '2', chainId, verifyingContract: usdc },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  }
  const signature = await payer.signTypedData(typedData)

  // The facilitator (NOT the payer) submits the packed-bytes overload —
  // exactly what a verbatim-forwarding x402 facilitator does.
  const args = [
    authorization.from, authorization.to, BigInt(authorization.value),
    BigInt(authorization.validAfter), BigInt(authorization.validBefore),
    authorization.nonce, signature,
  ]
  const submit = await facilitator.writeContract({ address: usdc, abi, functionName: 'transferWithAuthorization', args })
  const receipt = await pub.waitForTransactionReceipt({ hash: submit })
  ok(receipt.status === 'success', 'transferWithAuthorization settled by third party (gasless for payer)')
  ok((await pub.readContract({ address: usdc, abi, functionName: 'balanceOf', args: [relayer.address] })) === parseUnits('1.5', 6), 'payee received $1.50')
  ok((await pub.readContract({ address: usdc, abi, functionName: 'balanceOf', args: [payer.address] })) === parseUnits('3.5', 6), 'payer balance $3.50')
  ok((await pub.readContract({ address: usdc, abi, functionName: 'authorizationState', args: [payer.address, authorization.nonce] })) === true, 'authorization nonce consumed')

  // Replay must revert.
  let replayed = false
  try {
    await facilitator.writeContract({ address: usdc, abi, functionName: 'transferWithAuthorization', args })
    replayed = true
  } catch { /* expected */ }
  ok(!replayed, 'replay of the same authorization reverts')

  return receipt.transactionHash
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deployment = JSON.parse(readFileSync(join(ROOT, 'deployment.json'), 'utf8'))
  const artifact = JSON.parse(readFileSync(join(ROOT, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))
  const tx = await smoke(deployment.rpc, deployment.usdc, artifact.abi)
  console.log(`smoke passed — settlement tx ${tx}`)
}
