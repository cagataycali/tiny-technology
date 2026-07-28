// Public-facing JSON-RPC proxy for tiny-chain — an ALLOWLIST, not a blocklist.
//
// anvil's RPC surface includes anvil_setBalance, anvil_impersonateAccount,
// evm_mine, hardhat_* etc. — any one of them is full write access to the
// chain, so the raw node must never be what a Cloudflare tunnel exposes.
// This proxy forwards only the read/submit methods a wallet or our own
// worker/app needs; everything else answers -32601 without ever reaching
// the node. eth_sendTransaction is deliberately ABSENT: anvil signs it with
// its unlocked (world-known) dev accounts, which would make "send as
// account 0" a public primitive.
//
// eth_sendRawTransaction IS allowed, because a raw transaction arrives already
// signed — the caller must hold the key. On any other chain that ends the
// argument; on ours ten of those keys are published in anvil's banner, each
// funded with 10,000 ETH, so the signature proves nothing. Hence raw-tx-guard.mjs:
// the allowlist decides which METHODS are public, and the guard decides which
// SIGNERS are. Both refusals are answered here and never reach the node.
//
// Env: TINY_RPC_PROXY_PORT (default 8552),
//      TINY_CHAIN_RPC_URL upstream (default http://127.0.0.1:8545),
//      TINY_CHAIN_ALLOW_DEV_KEYS=1 to accept published-key transactions (devnet).
import { createServer } from 'node:http'

import { screenRawTxBatch } from './raw-tx-guard.mjs'

const PORT = Number(process.env.TINY_RPC_PROXY_PORT || 8552)
const UPSTREAM = process.env.TINY_CHAIN_RPC_URL || 'http://127.0.0.1:8545'
const MAX_BODY = 1_000_000 // 1MB — a signed tx is a few KB; getLogs queries are smaller

export const ALLOWED = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_feeHistory',
  'eth_maxPriorityFeePerGas', 'eth_syncing',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt',
  'eth_call', 'eth_estimateGas',
  'eth_sendRawTransaction',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockReceipts',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs',
  'net_version', 'web3_clientVersion',
])

const refuse = (id) => ({
  jsonrpc: '2.0', id: id ?? null,
  error: { code: -32601, message: 'method not available on the public endpoint' },
})

// One request in a batch being refused must not take down the allowed ones —
// but a refused item is answered locally and NEVER forwarded.
export function partition(body) {
  const items = Array.isArray(body) ? body : [body]
  const forward = []
  const refused = []
  for (const item of items) {
    if (item && typeof item.method === 'string' && ALLOWED.has(item.method)) forward.push(item)
    else refused.push(refuse(item?.id))
  }
  return { forward, refused, batch: Array.isArray(body) }
}

const server = createServer(async (req, res) => {
  const answer = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method !== 'POST') return answer(200, { ok: true, service: 'tiny-chain rpc' })

  let raw = ''
  let over = false
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY) { over = true; break }
  }
  if (over) return answer(413, refuse(null))

  let body
  try { body = JSON.parse(raw) } catch { return answer(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }

  const { forward: allowed, refused, batch } = partition(body)

  // Second gate: the method is public, but the SIGNER may not be. Screened
  // transactions are answered exactly like an off-allowlist method — locally,
  // never forwarded — so a published key cannot spend the node's gas.
  const { forward, refused: badSigner } = await screenRawTxBatch(allowed)
  refused.push(...badSigner)

  let upstreamAnswers = []
  if (forward.length) {
    try {
      const r = await fetch(UPSTREAM, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch ? forward : forward[0]),
      })
      const parsed = await r.json()
      upstreamAnswers = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      upstreamAnswers = forward.map((f) => ({ jsonrpc: '2.0', id: f.id ?? null, error: { code: -32000, message: 'upstream unavailable' } }))
    }
  }

  const all = [...upstreamAnswers, ...refused]
  answer(200, batch ? all : all[0])
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`tiny-chain rpc proxy on :${PORT} → ${UPSTREAM} (${ALLOWED.size} methods allowed)`)
  })
}

export default server
