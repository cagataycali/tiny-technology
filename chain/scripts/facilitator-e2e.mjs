// Facilitator E2E: boot scratch anvil → deploy TinyUSDC → start the
// facilitator → drive it exactly like the receiver does (settlePayment,
// app/api/x402/chat/[slug]/route.ts:182-199) with a payload built exactly like
// the payer (payer.ts buildAuthorization/buildTypedData/encodePaymentHeader).
// Positive path + the negative paths that guard real money.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { deploy, tinyChain, DEPLOYER_KEY } from './deploy.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHAIN_PORT = 8548
const FAC_PORT = 8549
const RPC = `http://127.0.0.1:${CHAIN_PORT}`
const FAC = `http://127.0.0.1:${FAC_PORT}`

const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // anvil #1
const PAY_TO = '0x976EA74026E726554dB657fA54763abd0C3a0aa9' // anvil #6 — receiving address only

const ok = (cond, label) => {
  if (!cond) throw new Error(`FACILITATOR-E2E FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
}
const waitFor = async (probe, what, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    try { if (await probe()) return } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${what} did not come up`)
}

// Throwaway anvil → its published test accounts ARE the right accounts here, for
// the deployer AND for the relayer the facilitator subprocess inherits below.
// Without this, deploy() refuses anvil #0 and server.mjs exits on anvil #9
// (dev-keys.mjs — the guard that exists so production can't default into them).
process.env.TINY_CHAIN_ALLOW_DEV_KEYS = '1'

const anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ['--chain-id', '31337', '--port', String(CHAIN_PORT)], { stdio: 'ignore' })
let fac
const cleanup = () => { try { anvil.kill() } catch {}; try { fac?.kill() } catch {} }
process.on('exit', cleanup)

try {
  await waitFor(async () => (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok, 'anvil')
  const { deployment, abi } = await deploy(RPC, { write: false })
  const pub = createPublicClient({ transport: http(RPC) })
  const chain = tinyChain(RPC, deployment.chainId)
  const payer = privateKeyToAccount(PAYER_KEY)

  // Fund the payer with $5 from the treasury.
  const treasury = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) })
  await pub.waitForTransactionReceipt({
    hash: await treasury.writeContract({ address: deployment.usdc, abi, functionName: 'transfer', args: [payer.address, parseUnits('5', 6)] }),
  })

  // X402_PAY_TO is the payee allowlist (settle-policy.mjs) and the facilitator
  // refuses to start without it — proven below, before the happy path.
  const facEnv = {
    ...process.env, TINY_CHAIN_RPC_URL: RPC, TINY_CHAIN_USDC_ADDRESS: deployment.usdc,
    FACILITATOR_PORT: String(FAC_PORT), X402_PAY_TO: PAY_TO,
  }

  // 💸 Unset payTo ⟹ no boot. The pre-guard behaviour was "settle for anybody",
  // so this must be a startup refusal and not a default that reads as configured.
  const noPayee = spawn(process.execPath, [join(ROOT, 'facilitator/server.mjs')], {
    env: { ...facEnv, X402_PAY_TO: '' }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let noPayeeErr = ''
  noPayee.stderr.on('data', (c) => { noPayeeErr += c })
  const noPayeeCode = await new Promise((r) => noPayee.on('exit', r))
  ok(noPayeeCode === 1, 'the facilitator REFUSES TO START with X402_PAY_TO unset')
  ok(/X402_PAY_TO/.test(noPayeeErr) && /restart/.test(noPayeeErr),
    'and says which env to set and that a restart cures it')
  // A typo must shrink the allowlist to nothing, not widen it to everything.
  const junkPayee = spawn(process.execPath, [join(ROOT, 'facilitator/server.mjs')], {
    env: { ...facEnv, X402_PAY_TO: 'not-an-address' }, stdio: 'ignore',
  })
  ok((await new Promise((r) => junkPayee.on('exit', r))) === 1,
    'and an all-junk value is treated as unset, never as a wildcard')

  fac = spawn(process.execPath, [join(ROOT, 'facilitator/server.mjs')], {
    env: facEnv, stdio: 'ignore',
  })
  await waitFor(async () => (await fetch(`${FAC}/healthz`)).ok, 'facilitator')
  console.log(`facilitator up on ${FAC}`)

  // ONE accepts[] entry, shaped like paymentRequirements() (receiver route:81-98).
  const requirement = {
    scheme: 'exact',
    network: deployment.network,
    maxAmountRequired: String(1_500_000), // $1.50
    resource: 'https://tiny.technology/api/x402/chat/demo',
    mimeType: 'application/json',
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    asset: deployment.usdc,
    extra: { name: 'USDC', version: '2' },
  }

  // Payload built exactly like the payer (buildAuthorization payer.ts:270 +
  // buildTypedData :296 + encodePaymentHeader :337).
  const nowSec = Math.floor(Date.now() / 1000)
  const authorization = {
    from: payer.address, to: PAY_TO, value: requirement.maxAmountRequired,
    validAfter: String(nowSec - 60), validBefore: String(nowSec + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await payer.signTypedData({
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    domain: { name: 'USDC', version: '2', chainId: deployment.chainId, verifyingContract: deployment.usdc },
    primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  })
  const paymentPayload = { x402Version: 1, scheme: 'exact', network: deployment.network, payload: { signature, authorization } }
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirement })
  const post = (path, b = body) => fetch(`${FAC}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b }).then((r) => r.json())

  const supported = await fetch(`${FAC}/supported`).then((r) => r.json())
  ok(supported?.kinds?.[0]?.network === deployment.network, `/supported advertises ${deployment.network}`)

  const verify = await post('/verify')
  ok(verify.isValid === true && verify.payer === payer.address, '/verify accepts a payer-shaped payload')

  // Tamper: bump the authorized value → signature must no longer verify.
  const tampered = JSON.parse(body)
  tampered.paymentPayload.payload.authorization.value = String(2_000_000)
  ok((await post('/verify', JSON.stringify(tampered))).isValid === false, '/verify rejects a tampered value')

  // Wrong payee: authorization.to ≠ requirement.payTo → fail closed.
  const wrongPayee = JSON.parse(body)
  wrongPayee.paymentRequirements.payTo = payer.address
  ok((await post('/verify', JSON.stringify(wrongPayee))).isValid === false, '/verify rejects payTo mismatch')

  // 💸 THE LIVE FINDING (c-n): a fully valid, self-consistent authorization whose
  // payee simply isn't ours. Before the guard this settled — on the real chain,
  // from a 0-ETH stranger, burning our relayer's gas. Both halves of the
  // authorization are moved so `auth.to == requirement.payTo` still holds: the
  // ONLY thing wrong with it is that we don't receive at that address.
  const stranger = privateKeyToAccount(generatePrivateKey())
  const strangerPayee = '0x000000000000000000000000000000000000dEaD'
  const strangerAuth = {
    from: stranger.address, to: strangerPayee, value: '0',
    validAfter: String(nowSec - 60), validBefore: String(nowSec + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const strangerSig = await stranger.signTypedData({
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    domain: { name: 'USDC', version: '2', chainId: deployment.chainId, verifyingContract: deployment.usdc },
    primaryType: 'TransferWithAuthorization',
    message: { ...strangerAuth, value: 0n, validAfter: BigInt(strangerAuth.validAfter), validBefore: BigInt(strangerAuth.validBefore) },
  })
  const strangerBody = JSON.stringify({
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: deployment.network, payload: { signature: strangerSig, authorization: strangerAuth } },
    paymentRequirements: { ...requirement, maxAmountRequired: '0', payTo: strangerPayee, resource: 'https://not-ours.example/x' },
  })
  const relayerAddr = privateKeyToAccount(process.env.FACILITATOR_RELAYER_KEY
    || '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6').address
  const relayerNonceBefore = await pub.getTransactionCount({ address: relayerAddr })
  const strangerVerify = await post('/verify', strangerBody)
  ok(strangerVerify.isValid === false && /payTo is not an address/.test(strangerVerify.invalidReason || ''),
    '/verify refuses a VALID authorization to a payee we don\'t receive at')
  const strangerSettle = await post('/settle', strangerBody)
  ok(strangerSettle.success === false, '/settle refuses it too (verify and settle agree)')
  ok(await pub.getTransactionCount({ address: relayerAddr }) === relayerNonceBefore,
    'and our relayer signed NOTHING — no gas spent on a stranger\'s transfer')
  ok(!/0x[0-9a-fA-F]{40}/.test(strangerSettle.errorReason || ''),
    'and the refusal names no address — a prober learns nothing about our payTo')

  const settle = await post('/settle')
  ok(settle.success === true && /^0x[0-9a-f]{64}$/i.test(settle.transaction || ''), '/settle moves the money and returns the tx')
  ok(settle.network === deployment.network && settle.payer === payer.address, '/settle reports network + payer (SettleResponse shape)')
  ok((await pub.readContract({ address: deployment.usdc, abi, functionName: 'balanceOf', args: [PAY_TO] })) === parseUnits('1.5', 6), 'payee received $1.50 on-chain')

  const replay = await post('/settle')
  ok(replay.success === false && /nonce already used/.test(replay.errorReason || ''), '/settle replay of the same authorization is refused')

  console.log(`FACILITATOR E2E PASS — settlement ${settle.transaction}`)
} catch (err) {
  console.error(String(err?.message || err))
  process.exitCode = 1
} finally {
  cleanup()
}
