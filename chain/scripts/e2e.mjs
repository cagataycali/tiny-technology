// One-shot CI-able proof: boot a scratch anvil, deploy TinyUSDC, run the
// EIP-3009 smoke, tear down. Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

import { deploy } from './deploy.mjs'
import { smoke } from './smoke.mjs'

// The anvil this script boots IS a throwaway, so its published test accounts are
// the right accounts here — opt in, or deploy.mjs's guard refuses anvil #0.
// Safe to set after the import: the guard reads process.env when deploy() runs.
process.env.TINY_CHAIN_ALLOW_DEV_KEYS = '1'

const PORT = Number(process.env.TINY_CHAIN_PORT || 8547) // scratch port — avoid colliding with a long-running devnet on 8545
const RPC = `http://127.0.0.1:${PORT}`

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ['--chain-id', '31337', '--port', String(PORT)], { stdio: 'ignore' })
const cleanup = () => { try { anvil.kill() } catch {} }
process.on('exit', cleanup)

try {
  // Wait for the RPC to come up (max ~5s).
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
      if (r.ok) break
    } catch {}
    if (i >= 50) throw new Error('anvil did not come up on ' + RPC)
    await new Promise(res => setTimeout(res, 100))
  }
  console.log(`anvil up on ${RPC}`)
  const { deployment, abi } = await deploy(RPC, { write: false })
  console.log(`TinyUSDC deployed at ${deployment.usdc} (chain ${deployment.chainId})`)
  const tx = await smoke(RPC, deployment.usdc, abi)
  console.log(`E2E PASS — EIP-3009 settlement ${tx}`)
} catch (err) {
  console.error(String(err?.message || err))
  process.exitCode = 1
} finally {
  cleanup()
}
