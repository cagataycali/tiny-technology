// The external agent, as a script: pay any x402 endpoint with TinyUSDC.
//
//   X402_PAYER_KEY=0x… node scripts/pay-e2e.mjs <endpoint-url> "<message>"
//
// Does the full spec dance a third-party payer does — no tiny.technology
// account, no session, nothing but a funded key on the chain the endpoint
// names: POST → 402 PaymentRequirements → sign EIP-3009
// transferWithAuthorization for accepts[0] → retry with X-PAYMENT →
// print the paid response + the X-PAYMENT-RESPONSE settlement receipt.
//
// This is also the E2E for the whole self-hosted x402 stack: receiver
// (Vercel edge) → facilitator (x402.example.com) → chain (chain.example.com),
// with the payer as the one genuinely outside party.
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'

const [url, message = 'ping'] = process.argv.slice(2)
if (!url || !process.env.X402_PAYER_KEY) {
  console.error('usage: X402_PAYER_KEY=0x… node scripts/pay-e2e.mjs <x402-endpoint-url> "<message>"')
  process.exit(2)
}
const payer = privateKeyToAccount(process.env.X402_PAYER_KEY)

const post = (headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message }),
  })

// 1. Knock without payment — a priced endpoint answers 402 + requirements.
const challenge = await post()
if (challenge.status !== 402) {
  console.log(`no payment required (HTTP ${challenge.status}):`)
  console.log(JSON.stringify(await challenge.json(), null, 2))
  process.exit(0)
}
const requirements = await challenge.json()
const req = requirements?.accepts?.[0]
if (!req) { console.error('402 carried no accepts[]'); process.exit(1) }
console.log(`402 → ${req.description}`)
console.log(`    ${Number(req.maxAmountRequired) / 1e6} ${req.extra?.name || 'USDC'} on ${req.network} → ${req.payTo}`)

// 2. Sign the exact-scheme EIP-3009 authorization for accepts[0].
const chainId = Number(String(req.network).split(':')[1])
const nowSec = Math.floor(Date.now() / 1000)
const authorization = {
  from: payer.address, to: req.payTo, value: String(req.maxAmountRequired),
  validAfter: String(nowSec - 60), validBefore: String(nowSec + (req.maxTimeoutSeconds || 120)),
  nonce: `0x${randomBytes(32).toString('hex')}`,
}
const signature = await payer.signTypedData({
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
  domain: { name: req.extra?.name || 'USDC', version: req.extra?.version || '2', chainId, verifyingContract: req.asset },
  primaryType: 'TransferWithAuthorization',
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
})
const paymentPayload = { x402Version: 1, scheme: 'exact', network: req.network, payload: { signature, authorization } }

// 3. Retry with X-PAYMENT.
const paid = await post({ 'X-PAYMENT': Buffer.from(JSON.stringify(paymentPayload)).toString('base64') })
const body = await paid.json().catch(() => ({}))
console.log(`\nHTTP ${paid.status}`)
const receiptHeader = paid.headers.get('X-PAYMENT-RESPONSE')
if (receiptHeader) {
  console.log('X-PAYMENT-RESPONSE:', JSON.stringify(JSON.parse(Buffer.from(receiptHeader, 'base64').toString())))
}
console.log(JSON.stringify(body, null, 2))
process.exit(paid.status === 200 ? 0 : 1)
