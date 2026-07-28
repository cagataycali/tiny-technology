// 🚰 One-shot proof that the FAUCET's reserve mint actually works on the chain
// we own: boot a scratch anvil, deploy TinyUSDC, then mint through the EXACT
// calldata path /api/wallet/faucet uses — its own minimal `mint(address,uint256)`
// ABI fragment + encodeFunctionData + sendTransaction, not deploy.mjs's
// writeContract against the full artifact ABI.
//
// Why that distinction is the point of this script: the route cannot import the
// forge artifact (it isn't in the Next build), so it carries a hand-written ABI
// fragment. A fragment that disagrees with the deployed contract by one type
// produces a selector that reverts — and the route treats a mint failure as
// merely "unbacked", best-effort, so the drip would keep succeeding and the
// reserve would silently never exist. That's a failure no unit test sees and no
// user reports. So the fragment is proven against a real deployment here.
//
// Also asserted: mint is OWNER-ONLY (a non-deployer key reverts). The monetary
// authority is the deployer key alone; if that ever stopped being true, the
// faucet's ceiling would bound nothing.
//
// Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { deploy, tinyChain } from './deploy.mjs'

const PORT = Number(process.env.TINY_CHAIN_PORT || 8549) // scratch port, distinct from e2e/facilitator
const RPC = `http://127.0.0.1:${PORT}`

// VERBATIM from app/api/wallet/faucet/route.ts — if the route's fragment drifts
// from the contract, this script is what fails instead of production silently
// dripping unbacked credit.
const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
]

const DEPLOYER_KEY = process.env.TINY_CHAIN_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil #0
const OUTSIDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // anvil #1
const DEPOSIT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // stands in for env.DEPOSIT_ADDRESS
const DRIP_MICRO = 1_000_000n // FAUCET_DRIP_MICRO — $1.00 at 6 decimals

const BALANCE_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}]

// The anvil below is a throwaway, so its published test accounts are the right
// accounts here — opt in, or deploy.mjs's guard refuses anvil #0 (dev-keys.mjs).
process.env.TINY_CHAIN_ALLOW_DEV_KEYS = '1'

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ['--chain-id', '31337', '--port', String(PORT)], { stdio: 'ignore' })
const cleanup = () => { try { anvil.kill() } catch {} }
process.on('exit', cleanup)

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`) }

try {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      })
      if (r.ok) break
    } catch {}
    if (i >= 50) throw new Error('anvil did not come up on ' + RPC)
    await new Promise((res) => setTimeout(res, 100))
  }
  console.log(`anvil up on ${RPC}`)

  const { deployment } = await deploy(RPC, { write: false })
  const usdc = deployment.usdc
  console.log(`TinyUSDC at ${usdc} (chain ${deployment.chainId})`)

  const chain = tinyChain(RPC, deployment.chainId)
  const pub = createPublicClient({ chain, transport: http(RPC) })
  const before = await pub.readContract({ address: usdc, abi: BALANCE_ABI, functionName: 'balanceOf', args: [DEPOSIT_ADDRESS] })

  // 1. The route's exact mint path.
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const data = encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [DEPOSIT_ADDRESS, DRIP_MICRO] })
  const hash = await wallet.sendTransaction({ to: usdc, data })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 20_000 })
  assert(receipt.status === 'success', `route-shaped mint reverted (${hash}) — the ABI fragment disagrees with the contract`)

  const after = await pub.readContract({ address: usdc, abi: BALANCE_ABI, functionName: 'balanceOf', args: [DEPOSIT_ADDRESS] })
  assert(after - before === DRIP_MICRO, `reserve credited ${after - before}, expected ${DRIP_MICRO}`)
  console.log(`reserve mint OK — deposit address +$${Number(DRIP_MICRO) / 1e6} (${hash})`)

  // 2. Mint is the DEPLOYER's alone. If any key could mint, the ledger ceiling
  //    the faucet enforces would bound a supply anyone could inflate.
  const outsider = createWalletClient({ account: privateKeyToAccount(OUTSIDER_KEY), chain, transport: http(RPC) })
  let refused = false
  try {
    const badHash = await outsider.sendTransaction({ to: usdc, data })
    const badReceipt = await pub.waitForTransactionReceipt({ hash: badHash, timeout: 20_000 })
    refused = badReceipt.status !== 'success'
  } catch {
    refused = true // reverted at estimation — also a refusal
  }
  assert(refused, 'a NON-deployer key minted TinyUSDC — mint() is not owner-only')
  console.log('owner-only mint OK — an outsider key cannot issue reserve')

  console.log('FAUCET E2E PASS')
} catch (err) {
  console.error(String(err?.message || err))
  process.exitCode = 1
} finally {
  cleanup()
}
