// Proves the public RPC proxy refuses chain-rewriting methods while passing
// the read/submit set through. Scratch anvil on :8551, proxy on :8553.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

import { WELL_KNOWN_KEYS } from '../dev-keys.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ANVIL_PORT = 8551
const PROXY_PORT = 8553
const RPC = `http://127.0.0.1:${ANVIL_PORT}`
const PROXY = `http://127.0.0.1:${PROXY_PORT}`

const rpc = (url, method, params = [], id = 1) =>
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }).then((r) => r.json())

let pass = 0
const ok = (cond, label) => {
  if (!cond) { console.error(`  ✗ ${label}`); process.exitCode = 1; throw new Error(label) }
  console.log(`  ✓ ${label}`); pass++
}

const anvil = spawn(join(process.env.HOME, '.foundry/bin/anvil'), ['--port', String(ANVIL_PORT), '--chain-id', '8469'], { stdio: 'ignore' })
const proxy = spawn(process.execPath, [join(ROOT, 'rpc-proxy.mjs')], {
  env: { ...process.env, TINY_RPC_PROXY_PORT: String(PROXY_PORT), TINY_CHAIN_RPC_URL: RPC },
  stdio: 'ignore',
})
const cleanup = () => { anvil.kill(); proxy.kill() }
process.on('exit', cleanup)

try {
  await sleep(1500)

  const chainId = await rpc(PROXY, 'eth_chainId')
  ok(chainId.result === '0x2115', 'eth_chainId passes through (0x2115 = 8469)')

  const victim = '0x00000000000000000000000000000000000000AA'
  const setBal = await rpc(PROXY, 'anvil_setBalance', [victim, '0xffffffff'])
  ok(setBal.error?.code === -32601, 'anvil_setBalance refused (-32601)')
  const bal = await rpc(RPC, 'eth_getBalance', [victim, 'latest'])
  ok(bal.result === '0x0', 'and the balance genuinely never changed upstream')

  const mine = await rpc(PROXY, 'evm_mine')
  ok(mine.error?.code === -32601, 'evm_mine refused')

  const impersonate = await rpc(PROXY, 'anvil_impersonateAccount', [victim])
  ok(impersonate.error?.code === -32601, 'anvil_impersonateAccount refused')

  // anvil signs eth_sendTransaction with its unlocked world-known dev
  // accounts — allowing it makes "spend as account 0" public.
  const sendTx = await rpc(PROXY, 'eth_sendTransaction', [{ from: victim, to: victim }])
  ok(sendTx.error?.code === -32601, 'eth_sendTransaction refused (unlocked-account signer)')

  const batch = await fetch(PROXY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'anvil_mine', params: [] },
    ]),
  }).then((r) => r.json())
  const byId = Object.fromEntries(batch.map((x) => [x.id, x]))
  ok(typeof byId[1]?.result === 'string' && byId[2]?.error?.code === -32601,
    'batch: allowed item answered, refused item -32601, nothing dropped')

  const get = await fetch(PROXY).then((r) => r.json())
  ok(get.ok === true, 'GET health answers without touching the node')

  // eth_sendRawTransaction IS allowed (the caller must hold the key) — but ten
  // of the keys on this chain are published and anvil funds each with 10,000
  // ETH, so the signature proves nothing. Prove the signer gate against a REAL
  // node: a published-key tx must be refused AND must not land, while a
  // generated-key tx of the same shape goes through.
  const txShape = {
    to: '0x00000000000000000000000000000000000000AA', value: 1n, chainId: 8469,
    nonce: 0, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n,
    type: 'eip1559',
  }
  const headBefore = (await rpc(RPC, 'eth_blockNumber')).result
  const devRaw = await privateKeyToAccount(WELL_KNOWN_KEYS[0]).signTransaction(txShape)
  const devSend = await rpc(PROXY, 'eth_sendRawTransaction', [devRaw])
  ok(devSend.error?.code === -32003, 'a tx signed by anvil #0 is refused (-32003, not -32601)')
  ok(/anvil account #0/.test(devSend.error?.message || ''), 'and the refusal names the account')
  const nonceAfter = (await rpc(RPC, 'eth_getTransactionCount', [
    privateKeyToAccount(WELL_KNOWN_KEYS[0]).address, 'latest',
  ])).result
  ok(nonceAfter === '0x0', 'and it genuinely never reached the node (nonce still 0)')

  // The other half: the guard must not break real users. Fund a generated
  // account through the node directly, then have IT spend via the proxy.
  const realKey = generatePrivateKey()
  const real = privateKeyToAccount(realKey)
  await rpc(RPC, 'anvil_setBalance', [real.address, '0xde0b6b3a7640000']) // 1 ETH, upstream
  const realRaw = await real.signTransaction(txShape)
  const realSend = await rpc(PROXY, 'eth_sendRawTransaction', [realRaw])
  ok(/^0x[0-9a-f]{64}$/i.test(realSend.result || ''), 'a generated key\'s tx passes through and gets a hash')
  await sleep(300)
  const receipt = await rpc(RPC, 'eth_getTransactionReceipt', [realSend.result])
  ok(receipt.result?.status === '0x1', 'and it actually mined — the guard does not break real senders')
  ok(headBefore !== (await rpc(RPC, 'eth_blockNumber')).result, 'the chain advanced only for the real one')

  console.log(`PROXY E2E PASS — ${pass} asserts`)
} finally {
  cleanup()
}
