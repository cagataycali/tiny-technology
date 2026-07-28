// 🔬 THE MEASUREMENT BEHIND THE RECEIVER-SIDE RESOLVER.
//
// The payer-side resolver (worker `reconcileSentSpends`) asks the chain ONE
// question — `authorizationState(payer, nonce) → bool` — and refunds when the
// answer is false past the signed deadline. On the payer's side that boolean is
// enough, because its ambiguity errs safe: `true` merely means "don't refund".
//
// The receiver's resolver runs the mirror image: `true` would mean "credit the
// tiny's owner (plus the platform fee) for money that arrived". If the bit can be
// set WITHOUT money arriving, that credit is a MINT — balance invented out of a
// boolean. TinyUSDC.sol says it can:
//
//   _transferWithAuthorization → authorizationState[from][nonce] = true; _transfer(...)
//   cancelAuthorization        → authorizationState[authorizer][nonce] = true;  (no _transfer)
//
// Prose is not a measurement. This script proves it on a real chain: it signs TWO
// same-shaped EIP-3009 authorizations from the same payer, TRANSFERS one and
// CANCELS the other, and then asserts
//
//   • both nonces read back `authorizationState == true`   ← the bit cannot tell them apart
//   • only the transferred one emits AuthorizationUsed      ← the log can
//   • only the cancelled one emits AuthorizationCanceled
//   • only the transferred one moved USDC (balances + a Transfer log)
//
// and it pins the exact wire facts the worker's log reader hardcodes: both
// topic0 hashes, that `authorizer` is topics[1] and `nonce` is topics[2] (the
// contract declares both `indexed`, so neither is in `data`), and that an
// indexed-topic filter for one instrument does not match the other.
//
// Run: npm run e2e:authproof   (scratch anvil on :8550, nothing persistent)
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createPublicClient, createWalletClient, http, parseUnits, keccak256, toBytes, pad } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { deploy, tinyChain, DEPLOYER_KEY } from './deploy.mjs'

const CHAIN_PORT = 8550
const RPC = `http://127.0.0.1:${CHAIN_PORT}`

const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // anvil #1
const PAY_TO = '0x976EA74026E726554dB657fA54763abd0C3a0aa9' // anvil #6 — receiving address only

// The two constants the worker's resolver hardcodes. Computed here from the
// signatures rather than pasted, so a drifted event name fails HERE and not
// silently in production (a topic0 nobody matches reads as "no proof of value",
// which for the receiver means a creator never gets paid).
const USED_TOPIC = keccak256(toBytes('AuthorizationUsed(address,bytes32)'))
const CANCELED_TOPIC = keccak256(toBytes('AuthorizationCanceled(address,bytes32)'))
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'))

const ok = (cond, label) => {
  if (!cond) throw new Error(`AUTHPROOF-E2E FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
}
const waitFor = async (probe, what, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    try { if (await probe()) return } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${what} did not come up`)
}

// Throwaway anvil → its published accounts ARE the right accounts (deploy()
// refuses a well-known deployer key otherwise; dev-keys.mjs).
process.env.TINY_CHAIN_ALLOW_DEV_KEYS = '1'

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ['--chain-id', '31337', '--port', String(CHAIN_PORT)], { stdio: 'ignore' })
process.on('exit', () => { try { anvil.kill() } catch {} })

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
}
const CANCEL_TYPES = {
  CancelAuthorization: [
    { name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' },
  ],
}

try {
  await waitFor(async () => (await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
  })).ok, 'anvil')

  const { deployment, abi } = await deploy(RPC, { write: false })
  const pub = createPublicClient({ transport: http(RPC) })
  const chain = tinyChain(RPC, deployment.chainId)
  const payer = privateKeyToAccount(PAYER_KEY)
  const usdc = deployment.usdc
  const domain = { name: 'USDC', version: '2', chainId: deployment.chainId, verifyingContract: usdc }

  // Fund the payer $5 from the treasury.
  const treasury = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) })
  await pub.waitForTransactionReceipt({
    hash: await treasury.writeContract({ address: usdc, abi, functionName: 'transfer', args: [payer.address, parseUnits('5', 6)] }),
  })

  // A RELAYER submits both calls — EIP-3009's whole point, and the shape the
  // facilitator uses: neither the transfer nor the cancel is sent by the payer.
  const relayer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) })

  const value = parseUnits('1.5', 6)
  const nowSec = Math.floor(Date.now() / 1000)
  const mk = () => `0x${randomBytes(32).toString('hex')}`
  const nonceUsed = mk()
  const nonceCancelled = mk()

  // TWO authorizations identical in every field but the nonce, so nothing except
  // which CALL was made can explain a difference in what the chain reports.
  const authFor = (nonce) => ({
    from: payer.address, to: PAY_TO, value,
    validAfter: BigInt(nowSec - 60), validBefore: BigInt(nowSec + 3600), nonce,
  })
  const signTransfer = (nonce) => payer.signTypedData({
    types: TRANSFER_TYPES, domain, primaryType: 'TransferWithAuthorization', message: authFor(nonce),
  })

  const startBlock = await pub.getBlockNumber()
  const payToBefore = await pub.readContract({ address: usdc, abi, functionName: 'balanceOf', args: [PAY_TO] })

  // ── 1. SETTLE one. This is what a confirmed x402 settlement looks like.
  const usedRcpt = await pub.waitForTransactionReceipt({
    hash: await relayer.writeContract({
      address: usdc, abi, functionName: 'transferWithAuthorization',
      args: [payer.address, PAY_TO, value, BigInt(nowSec - 60), BigInt(nowSec + 3600), nonceUsed,
        await signTransfer(nonceUsed)],
    }),
  })
  ok(usedRcpt.status === 'success', 'transferWithAuthorization confirmed')

  // ── 2. CANCEL the other. Signed by the same payer, same nonce shape, relayed
  // the same way — and it moves nothing.
  const cancelSig = await payer.signTypedData({
    types: CANCEL_TYPES, domain, primaryType: 'CancelAuthorization',
    message: { authorizer: payer.address, nonce: nonceCancelled },
  })
  const r = `0x${cancelSig.slice(2, 66)}`
  const s = `0x${cancelSig.slice(66, 130)}`
  const v = parseInt(cancelSig.slice(130, 132), 16)
  const cancelRcpt = await pub.waitForTransactionReceipt({
    hash: await relayer.writeContract({
      address: usdc, abi, functionName: 'cancelAuthorization',
      args: [payer.address, nonceCancelled, v, r, s],
    }),
  })
  ok(cancelRcpt.status === 'success', 'cancelAuthorization confirmed')

  // ── 3. ⚠️ THE FINDING. One bit, two meanings.
  const stateUsed = await pub.readContract({ address: usdc, abi, functionName: 'authorizationState', args: [payer.address, nonceUsed] })
  const stateCancelled = await pub.readContract({ address: usdc, abi, functionName: 'authorizationState', args: [payer.address, nonceCancelled] })
  ok(stateUsed === true && stateCancelled === true,
    'authorizationState is TRUE for BOTH — the settled nonce and the cancelled one')
  ok(stateUsed === stateCancelled,
    '⚠️ so the payer-side question CANNOT tell "you were paid" from "it was voided"')

  // And the money says they are not the same event at all.
  const payToAfter = await pub.readContract({ address: usdc, abi, functionName: 'balanceOf', args: [PAY_TO] })
  ok(payToAfter - payToBefore === value,
    'exactly ONE of the two moved USDC to payTo (crediting both would mint the other)')

  // ── 4. The logs, which do tell them apart. Queried the way the worker will:
  // an indexed-topic filter, not a client-side scan of everything.
  const logsFor = (topic, nonce) => pub.request({
    method: 'eth_getLogs',
    params: [{
      address: usdc, fromBlock: `0x${startBlock.toString(16)}`, toBlock: 'latest',
      topics: [topic, pad(payer.address.toLowerCase(), { size: 32 }), nonce],
    }],
  })

  const usedLogs = await logsFor(USED_TOPIC, nonceUsed)
  const usedLogsForCancelled = await logsFor(USED_TOPIC, nonceCancelled)
  ok(usedLogs.length === 1, 'AuthorizationUsed(payer, settledNonce) → exactly one log')
  ok(usedLogsForCancelled.length === 0,
    '✅ AuthorizationUsed(payer, cancelledNonce) → NO log: this is the proof of value')

  const cancelLogs = await logsFor(CANCELED_TOPIC, nonceCancelled)
  const cancelLogsForUsed = await logsFor(CANCELED_TOPIC, nonceUsed)
  ok(cancelLogs.length === 1 && cancelLogsForUsed.length === 0,
    'AuthorizationCanceled is the mirror — one log, and only for the cancelled nonce')
  ok(USED_TOPIC !== CANCELED_TOPIC, 'the two topic0s differ (a shared topic0 would collapse the distinction)')

  // The OR form: `topics[0]` as an ARRAY asks both questions in ONE eth_getLogs.
  // The resolver depends on this (one RPC per row per tick, not two), and a node
  // that ignored the alternation would answer with the WRONG event's logs.
  const either = async (nonce) => pub.request({
    method: 'eth_getLogs',
    params: [{
      address: usdc, fromBlock: `0x${startBlock.toString(16)}`, toBlock: 'latest',
      topics: [[USED_TOPIC, CANCELED_TOPIC], pad(payer.address.toLowerCase(), { size: 32 }), nonce],
    }],
  })
  const eitherUsed = await either(nonceUsed)
  const eitherCancelled = await either(nonceCancelled)
  ok(eitherUsed.length === 1 && eitherUsed[0].topics[0].toLowerCase() === USED_TOPIC.toLowerCase(),
    'a topic0 ALTERNATION [used, canceled] returns the settled instrument as AuthorizationUsed')
  ok(eitherCancelled.length === 1 && eitherCancelled[0].topics[0].toLowerCase() === CANCELED_TOPIC.toLowerCase(),
    'and the same one query returns the voided instrument as AuthorizationCanceled')
  ok((await either(mk())).length === 0,
    'an instrument the chain never saw returns NOTHING — absence is a third answer, not a default')

  // ── 5. The wire layout the resolver hardcodes.
  const log = usedLogs[0]
  ok(log.topics[0].toLowerCase() === USED_TOPIC.toLowerCase(),
    `topic0 == keccak("AuthorizationUsed(address,bytes32)") == ${USED_TOPIC}`)
  ok(log.topics[1].toLowerCase() === pad(payer.address.toLowerCase(), { size: 32 }),
    'topics[1] is the AUTHORIZER, left-padded to 32 bytes')
  ok(log.topics[2].toLowerCase() === nonceUsed.toLowerCase(), 'topics[2] is the NONCE, verbatim')
  ok(log.topics.length === 3, 'three topics — both args are `indexed`, so neither hides in `data`')
  ok(!log.data || log.data === '0x', 'and `data` is empty: there is NO amount in this event')
  ok(log.address.toLowerCase() === usdc.toLowerCase(), 'the log comes from the token contract')
  ok(log.transactionHash.toLowerCase() === usedRcpt.transactionHash.toLowerCase(),
    'the log carries the settling tx hash — the ref a reconciled credit must be keyed by')

  // ── 6. ⚠️ AND WHY THE EVENT ALONE IS NOT THE WHOLE ANSWER. AuthorizationUsed
  // has no amount, so it proves the instrument was consumed by a TRANSFER, not
  // how much arrived. The Transfer log in the SAME tx is where the value is —
  // which is why the resolver pairs them (findUsdcTransfer, deposits.ts).
  const transferLogs = usedRcpt.logs.filter((l) =>
    l.address.toLowerCase() === usdc.toLowerCase() && l.topics[0].toLowerCase() === TRANSFER_TOPIC.toLowerCase())
  ok(transferLogs.length === 1, 'the settling tx also emits exactly one USDC Transfer')
  ok(BigInt(transferLogs[0].data) === value, 'and ITS data carries the amount that actually moved')
  ok(transferLogs[0].topics[1].toLowerCase() === pad(payer.address.toLowerCase(), { size: 32 })
    && transferLogs[0].topics[2].toLowerCase() === pad(PAY_TO.toLowerCase(), { size: 32 }),
    'from = payer, to = payTo — checkable against the row we stored')
  ok(cancelRcpt.logs.filter((l) => l.topics[0].toLowerCase() === TRANSFER_TOPIC.toLowerCase()).length === 0,
    'the cancel tx emits NO Transfer at all')

  // ── 7. A settled instrument cannot then be cancelled, and vice versa — the
  // two verdicts are mutually exclusive forever, so a resolver may treat the
  // first one it sees as terminal.
  let reCancelFailed = false
  try {
    await relayer.writeContract({
      address: usdc, abi, functionName: 'cancelAuthorization',
      args: [payer.address, nonceUsed, v, r, s],
    })
  } catch { reCancelFailed = true }
  ok(reCancelFailed, 'a SETTLED nonce can never be cancelled afterwards ("auth used")')
  let reSettleFailed = false
  try {
    await relayer.writeContract({
      address: usdc, abi, functionName: 'transferWithAuthorization',
      args: [payer.address, PAY_TO, value, BigInt(nowSec - 60), BigInt(nowSec + 3600), nonceCancelled,
        await signTransfer(nonceCancelled)],
    })
  } catch { reSettleFailed = true }
  ok(reSettleFailed, 'and a CANCELLED nonce can never settle afterwards — each verdict is final')

  console.log('\nAUTHPROOF-E2E PASS — the bit is ambiguous, the log is not.')
  process.exit(0)
} catch (err) {
  console.error(`\n${err?.message || err}`)
  process.exit(1)
}
