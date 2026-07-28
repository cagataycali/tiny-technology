#!/usr/bin/env node
/**
 * P6 acceptance: the x402 money layer works on chain 8470 — the REAL one, with
 * four QBFT nodes and no anvil anywhere.
 *
 * Every other x402 test in this repo (chain/scripts/facilitator-e2e.mjs) boots a
 * scratch anvil. Anvil auto-mines, funds ten accounts, and never disagrees with
 * itself, so it cannot show what a real consensus chain does differently. This
 * runs the SAME facilitator binary against the SAME multi-node devnet the
 * joiner suite uses, and the difference it found is the reason the file exists.
 *
 * ⛽ THE FINDING (c8). Both tiny chains price gas at zero: genesis `zeroBaseFee`,
 * besu `--min-gas-price=0`, and viem's fee estimation returns maxFeePerGas 0. So
 * "the relayer needs no ETH" is a reasonable belief. Measured here, gasPrice 0 on
 * both trials, senders differing only in balance:
 *
 *   balance 0 wei → eth_sendRawTransaction ACCEPTS it, returns a hash, and the
 *                   transaction is never mined and never rejected.
 *   balance 1 wei → mined in the next block.
 *
 * The gate is a strictly positive balance, NOT affordability — so the check a
 * reviewer naturally writes, `balance >= gas * maxFeePerGas`, is `0 >= 0` and
 * passes for the one account that cannot transact.
 *
 * Why that is money rather than downtime: the facilitator signs, assigns `hash`,
 * broadcasts, then waits for a receipt, and past the signing line every failure
 * must report `unknown` (chain/settle-outcome.mjs) because a broadcast tx may
 * land at any time. `unknown` is the one outcome that must never be
 * auto-refunded. So a 0-balance relayer makes EVERY settlement an unrefundable
 * unknown: payer debited, receiver 402'd, reconciler chasing a transfer that can
 * never happen — a service that boots healthy and poisons every payment.
 *
 * And 8470 is in exactly that state for production's relayer today: it holds
 * ~1000 ETH on 8469 and 0 on 8470. Cutover without this guard IS the 0-wei row.
 *
 * ⚠️ Does NOT touch the live 8469: every RPC here goes to 8601-8604, and the
 * relayer/payer keys are generated per run.
 *
 * Usage: node chain/multinode/scripts/x402-8470-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createPublicClient, createWalletClient, http, defineChain, parseUnits } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const CHAIN = dirname(MULTINODE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const FAC_PORT = Number(process.env.TINY_MULTINODE_FAC_PORT || 8559)
const FAC = `http://127.0.0.1:${FAC_PORT}`

const d = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
const usdcArt = JSON.parse(readFileSync(join(CHAIN, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))
const ABI = usdcArt.abi

// Zero-price gas — the same fees the payer and every multinode script use.
const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
// The 8470 genesis funds anvil #0-#3 only. #0 is the deployer; it no longer owns
// TinyUSDC (TinyIssuance does, P3) but it still holds a USDC balance to send.
const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

let failures = 0
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chain = defineChain({
  id: d.chainId, name: 'tiny-multinode',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ transport: http(RPC) })
const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
const walletFor = (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })

const spawnFacilitator = (env) => spawn(process.execPath, [join(CHAIN, 'facilitator/server.mjs')], {
  env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
})
/** Run a facilitator to completion, capturing output — for the refusal cases. */
const facilitatorExit = (env) => new Promise((resolve) => {
  const p = spawnFacilitator(env)
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.stderr.on('data', (c) => { out += c })
  p.on('exit', (code) => resolve({ code, out }))
})

async function main() {
  console.log('\n🔗 multi-node tiny chain — P6 acceptance (x402 on 8470)\n')

  const chainId = await pub.getChainId()
  ok(chainId === 8470, `talking to chain ${chainId} (NOT the live 8469)`)
  if (chainId !== 8470) { console.error('\n💥 wrong chain — refusing to continue\n'); process.exit(1) }

  // Generated per run: a relayer that starts with nothing is the whole point of
  // trial 1, and a fresh payer keeps nonces and balances independent of prior runs.
  const relayerKey = generatePrivateKey()
  const relayer = privateKeyToAccount(relayerKey)
  const payerKey = generatePrivateKey()
  const payer = privateKeyToAccount(payerKey)
  const payTo = privateKeyToAccount(generatePrivateKey()).address

  const facEnv = {
    TINY_CHAIN_RPC_URL: RPC,
    TINY_CHAIN_USDC_ADDRESS: d.usdc,
    FACILITATOR_PORT: String(FAC_PORT),
    FACILITATOR_RELAYER_KEY: relayerKey,
    X402_PAY_TO: payTo,
  }

  console.log('⛽ zero-price gas is not no-gas-required\n')

  ok((await pub.getBalance({ address: relayer.address })) === 0n,
    `a freshly generated relayer holds 0 ETH on 8470 (${relayer.address})`)

  // 💸 THE GUARD. Before it, this facilitator booted and reported healthy.
  const refusal = await facilitatorExit(facEnv)
  ok(refusal.code === 1, 'the facilitator REFUSES TO START with a 0-balance relayer')
  ok(/[Zz]ero-price gas is NOT the same as no gas required/.test(refusal.out),
    'and says zero-price gas ≠ no gas required, so the operator does not read it as a bug in the check')
  ok(refusal.out.includes(relayer.address) && /8470/.test(refusal.out),
    'and names the address AND the chain — the same key is funded on 8469')

  // Now MEASURE the claim that guard is based on, rather than asserting the guard
  // and trusting the reasoning behind it. Two identical transactions, gasPrice 0,
  // differing only in the sender's balance.
  const deployer = walletFor(DEPLOYER_KEY)
  const burn = '0x00000000000000000000000000000000000000AA'
  const zeroBalanceSender = walletFor(generatePrivateKey())

  let strandedHash
  try {
    strandedHash = await zeroBalanceSender.sendTransaction({ to: burn, value: 0n, gas: 21_000n, ...FREE })
    ok(true, `a 0-balance sender's tx is ACCEPTED by the node (${strandedHash.slice(0, 12)}…) — no error at all`)
  } catch (e) {
    ok(false, 'a 0-balance sender\'s tx is accepted by the node', `it was rejected instead: ${e.shortMessage || e.message}`)
  }
  if (strandedHash) {
    await sleep(12_000) // ~6 blocks at 2s
    const tx = await pub.getTransaction({ hash: strandedHash }).catch(() => null)
    ok(tx && tx.blockNumber === null,
      'and 6 blocks later it is STILL PENDING — accepted, unmined, unrejected, and no log line names it',
      tx ? `blockNumber: ${tx.blockNumber}` : 'the node has forgotten the tx entirely')
  }

  // The control that pins the rule to BALANCE > 0 rather than affordability:
  // fund with exactly ONE WEI. If the gate were "can it pay for its gas", 21000
  // gas at any positive price costs far more than 1 wei and this would strand
  // too. It mines — which is why relayer-gas.mjs checks `> 0` and not arithmetic
  // over fees, and why the guard must not be a threshold that would refuse to
  // start a facilitator the chain would actually serve.
  const oneWeiKey = generatePrivateKey()
  const oneWeiSender = privateKeyToAccount(oneWeiKey)
  await wait(await deployer.sendTransaction({ to: oneWeiSender.address, value: 1n, gas: 21_000n, ...FREE }))
  ok((await pub.getBalance({ address: oneWeiSender.address })) === 1n,
    `a control sender is funded with exactly 1 wei (${oneWeiSender.address})`)
  try {
    const h = await walletFor(oneWeiKey).sendTransaction({ to: burn, value: 0n, gas: 21_000n, ...FREE })
    const r = await wait(h)
    ok(r.status === 'success',
      `and 1 wei is ENOUGH — mined in block ${r.blockNumber}, so the gate is balance > 0, not affordability`)
  } catch (e) {
    ok(false, 'and 1 wei is enough to be mined',
      `it stranded too, so the rule is not simply balance > 0: ${e.shortMessage || e.message}`)
  }

  // And the stranded tx from the trial above is still stranded — the difference
  // between the two is nothing but the sender's balance.
  if (strandedHash) {
    const still = await pub.getTransaction({ hash: strandedHash }).catch(() => null)
    ok(still && still.blockNumber === null,
      'while the 0-balance tx from the same chain, same fees, is STILL unmined')
  }

  console.log('\n💸 a real x402 settlement, mined by a validator\n')

  // Fund the relayer (1 ETH — generous, but this is the state a real operator
  // maintains) and the payer with USDC from the deployer's balance.
  await wait(await deployer.sendTransaction({ to: relayer.address, value: 10n ** 18n, gas: 21_000n, ...FREE }))
  ok((await pub.getBalance({ address: relayer.address })) > 0n, 'the relayer is funded — the guard should now pass')

  const price = parseUnits('1.25', 6)
  await wait(await deployer.writeContract({
    address: d.usdc, abi: ABI, functionName: 'transfer', args: [payer.address, parseUnits('5', 6)], ...FREE,
  }))
  ok((await pub.readContract({ address: d.usdc, abi: ABI, functionName: 'balanceOf', args: [payer.address] })) === parseUnits('5', 6),
    'the payer holds $5.00 of 8470 TinyUSDC')

  const fac = spawnFacilitator(facEnv)
  const cleanup = () => { try { fac.kill() } catch {} }
  process.on('exit', cleanup)
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${FAC}/healthz`)).ok } catch {}
    if (!up) await sleep(100)
  }
  ok(up, `the facilitator BOOTS against 8470 once the relayer can transact (${FAC})`)
  if (!up) { console.error('\n💥 facilitator never came up\n'); cleanup(); process.exit(1) }

  const health = await fetch(`${FAC}/healthz`).then((r) => r.json())
  ok(health.network === 'eip155:8470',
    `/healthz advertises eip155:8470 — derived from the chain, not configured (${health.network})`)
  const supported = await fetch(`${FAC}/supported`).then((r) => r.json())
  ok(supported?.kinds?.[0]?.network === 'eip155:8470', '/supported advertises eip155:8470')

  // Shaped exactly like paymentRequirements() (app/api/x402/chat/[slug]) and
  // signed exactly like the payer (lib/x402/payer.ts buildTypedData).
  const requirement = {
    scheme: 'exact', network: 'eip155:8470', maxAmountRequired: String(price),
    resource: 'https://tiny.technology/api/x402/chat/demo', mimeType: 'application/json',
    payTo, maxTimeoutSeconds: 120, asset: d.usdc,
    extra: { name: d.eip712Domain.name, version: d.eip712Domain.version },
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const authorization = {
    from: payer.address, to: payTo, value: String(price),
    validAfter: String(nowSec - 60), validBefore: String(nowSec + 600),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await payer.signTypedData({
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    domain: { name: d.eip712Domain.name, version: d.eip712Domain.version, chainId: d.chainId, verifyingContract: d.usdc },
    primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization, value: price,
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
    },
  })
  const body = JSON.stringify({
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: 'eip155:8470', payload: { signature, authorization } },
    paymentRequirements: requirement,
  })
  const post = (path, b = body) => fetch(`${FAC}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: b,
  }).then((r) => r.json())

  const verify = await post('/verify')
  ok(verify.isValid === true && verify.payer === payer.address,
    'the EIP-3009 signature verifies against 8470 as verifyingContract',
    JSON.stringify(verify))

  // 🔒 The chain-id half of P6: an authorization signed for 8469 must NOT settle
  // here. This is the guard that makes two chains on one machine safe — a payer
  // still configured for the old chain gets refused, not silently settled.
  const wrongChainSig = await payer.signTypedData({
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    domain: { name: d.eip712Domain.name, version: d.eip712Domain.version, chainId: 8469, verifyingContract: d.usdc },
    primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization, value: price,
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
    },
  })
  const wrongChainBody = JSON.parse(body)
  wrongChainBody.paymentPayload.payload.signature = wrongChainSig
  const wrongChain = await post('/verify', JSON.stringify(wrongChainBody))
  ok(wrongChain.isValid === false,
    'a signature bound to chainId 8469 does NOT verify on 8470 — the domain separator differs')

  const declaredWrong = JSON.parse(body)
  declaredWrong.paymentPayload.network = 'eip155:8469'
  const declared = await post('/verify', JSON.stringify(declaredWrong))
  ok(declared.isValid === false && /unsupported network/.test(declared.invalidReason || ''),
    'and a payload DECLARING eip155:8469 is refused by network, before any signature work',
    JSON.stringify(declared))

  const settle = await post('/settle')
  ok(settle.success === true && /^0x[0-9a-f]{64}$/i.test(settle.transaction || ''),
    'a real settlement lands on 8470', JSON.stringify(settle))
  ok(settle.network === 'eip155:8470' && settle.payer === payer.address,
    'and reports eip155:8470 + the payer (SettleResponse shape)')

  if (settle.transaction) {
    const receipt = await pub.getTransactionReceipt({ hash: settle.transaction }).catch(() => null)
    ok(receipt?.status === 'success', 'the settlement tx is mined and successful')
    if (receipt) {
      // 🏛️ The property anvil cannot demonstrate: the block carrying our payment
      // was proposed by a validator seated BY THE STAKE CONTRACT, and every other
      // node had to agree to it. The money moved through consensus, not through a
      // single process that also owned the mempool.
      const block = await pub.getBlock({ blockNumber: receipt.blockNumber })
      const validators = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'qbft_getValidatorsByBlockNumber', params: [`0x${receipt.blockNumber.toString(16)}`] }),
      }).then((r) => r.json()).then((j) => (j.result || []).map((v) => v.toLowerCase()))
      ok(validators.includes(block.miner.toLowerCase()),
        `the settling block ${receipt.blockNumber} was proposed by a seated validator (${block.miner})`,
        `validators: ${validators.join(', ')}`)
      ok(validators.length >= 4, `and ${validators.length} validators had to agree to it — this is consensus money, not an anvil auto-mine`)

      // Read the result back from a DIFFERENT node. On anvil there is no such
      // thing; here it is the difference between "a process told us" and "the
      // network agrees".
      const otherRpc = process.env.TINY_MULTINODE_RPC_2 || 'http://127.0.0.1:8602'
      const other = createPublicClient({ transport: http(otherRpc) })
      const balOther = await other.readContract({ address: d.usdc, abi: ABI, functionName: 'balanceOf', args: [payTo] }).catch(() => null)
      ok(balOther === price,
        `a SECOND node (${otherRpc}) independently reports the payee received $1.25`,
        `got ${balOther}`)
    }
  }

  const balance = await pub.readContract({ address: d.usdc, abi: ABI, functionName: 'balanceOf', args: [payTo] })
  ok(balance === price, `the payee holds $1.25 on 8470 (${balance})`)

  const replay = await post('/settle')
  ok(replay.success === false && /nonce already used/.test(replay.errorReason || ''),
    'and the same authorization cannot be replayed (EIP-3009 nonce consumed on 8470)')

  cleanup()
  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ P6 verified: x402 settles on 8470 through consensus, and a 0-gas relayer can no longer poison it'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
