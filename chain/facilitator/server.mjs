// tiny-chain x402 facilitator — verify + settle EIP-3009 TransferWithAuthorization.
//
// Speaks the exact dialect our receiver already sends (app/api/x402/chat/[slug]/
// route.ts:182-199 settlePayment): POST /verify and POST /settle with
// {x402Version, paymentPayload, paymentRequirements}, answering
// {isValid, invalidReason?, payer?} and {success, transaction, network, payer,
// errorReason?}. Point X402_FACILITATOR_URL at this service and inbound x402
// settles on the chain we own instead of x402.org's public-chain facilitator.
//
// Env: TINY_CHAIN_RPC_URL (default http://127.0.0.1:8545),
//      TINY_CHAIN_USDC_ADDRESS (default: chain/deployment.json),
//      FACILITATOR_PORT (default 8546),
//      FACILITATOR_RELAYER_KEY (pays gas; needs ETH, never holds USDC). Falls
//      back to anvil account 9, which this process REFUSES to start with unless
//      TINY_CHAIN_ALLOW_DEV_KEYS=1 says it's a throwaway devnet (../dev-keys.mjs),
//      X402_PAY_TO (**required**) — the receiving address(es) this facilitator
//      will settle to, same value the x402 receiver advertises. Without it any
//      caller could relay their own transfers at our relayer's expense; see
//      ../settle-policy.mjs.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPublicClient, createWalletClient, http, defineChain, verifyTypedData, encodeFunctionData, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { isWellKnownKey, devKeysAllowed, devKeyRefusal } from '../dev-keys.mjs'
import { relayerCanTransact, relayerGasRefusal } from '../relayer-gas.mjs'
import { parsePayees, payeeAllowed, OFF_LIST_REASON, NO_PAYEES_REFUSAL } from '../settle-policy.mjs'
import { SETTLED, NOT_SETTLED, UNKNOWN } from '../settle-outcome.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RPC = process.env.TINY_CHAIN_RPC_URL || 'http://127.0.0.1:8545'
const PORT = Number(process.env.FACILITATOR_PORT || 8546)
const RELAYER_KEY = process.env.FACILITATOR_RELAYER_KEY
  || '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' // anvil #9

// ⛔ The relayer signs every settlement on this chain. A published dev key here
// is milder than the deployer's (it pays gas and holds no USDC by design) but
// anyone can drain its ETH and stop settlement — and, unlike the deployer, it
// IS fixable by setting the env and restarting, which is why the message says so.
// Refuse at STARTUP rather than at the first /settle: a facilitator that boots
// and then fails every payment is far worse to diagnose than one that won't boot.
if (isWellKnownKey(RELAYER_KEY) && !devKeysAllowed()) {
  console.error(devKeyRefusal('the facilitator relayer', RELAYER_KEY) +
    ' Set FACILITATOR_RELAYER_KEY and restart.')
  process.exit(1)
}

// 💸 …and WHOM it settles for. The relayer key above is what we spend; this is
// who we're willing to spend it on. Unset ⟺ "settle for anybody", which is what
// this service actually did until now — so it's a startup refusal, not a
// default. See ../settle-policy.mjs for the live proof and the reasoning.
const PAYEES = parsePayees(process.env.X402_PAY_TO)
if (PAYEES.length === 0) {
  console.error(NO_PAYEES_REFUSAL)
  process.exit(1)
}

function usdcAddress() {
  if (process.env.TINY_CHAIN_USDC_ADDRESS) return process.env.TINY_CHAIN_USDC_ADDRESS
  return JSON.parse(readFileSync(join(ROOT, 'deployment.json'), 'utf8')).usdc
}

const ABI = JSON.parse(readFileSync(join(ROOT, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8')).abi
const USDC = usdcAddress()
const pub = createPublicClient({ transport: http(RPC) })
const CHAIN_ID = await pub.getChainId()
const CAIP2 = `eip155:${CHAIN_ID}`
const chain = defineChain({
  id: CHAIN_ID, name: 'tiny-chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const relayer = createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain, transport: http(RPC) })

// ⛽ …and can that relayer's transactions actually be MINED on this chain?
//
// The third startup refusal, and the only one that needs the network to answer.
// Both tiny chains price gas at zero, which makes "the relayer needs no ETH" a
// very reasonable thing to believe — and it is false: a zero-balance sender's
// transaction is ACCEPTED into besu's pool and then never mined, so every
// settlement would be signed, broadcast, and reported `unknown`. Measured on
// 8470; see ../relayer-gas.mjs for the trials and why an affordability check
// (`balance >= gas * fee`) cannot detect it on a zero-fee chain.
//
// Checked at startup for the dev-keys reason: this failure mode produces a
// service that boots healthy and poisons every payment it touches. It is also
// exactly the state chain 8470 is in for prod's relayer today, so this guard is
// what stops the 8469→8470 cutover from silently becoming that.
if (!relayerCanTransact(await pub.getBalance({ address: relayer.account.address }))) {
  console.error(relayerGasRefusal(relayer.account.address, CHAIN_ID))
  process.exit(1)
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
const canonical = (n) => {
  const s = String(n || '').toLowerCase().trim()
  return /^\d+$/.test(s) ? `eip155:${s}` : s
}

/**
 * Shared validation for verify AND settle (settle re-verifies — a stale verify
 * is not a settle ticket). Returns {auth, signature, requirement} or throws a
 * string reason. Fail-closed on every mismatch.
 */
async function validate(body) {
  const payload = body?.paymentPayload
  const requirement = body?.paymentRequirements
  const auth = payload?.payload?.authorization
  const signature = payload?.payload?.signature
  if (!payload || !requirement || !auth || !signature) throw 'malformed payment payload'
  if (payload.scheme !== 'exact' || requirement.scheme !== 'exact') throw 'unsupported scheme (exact only)'
  if (canonical(payload.network) !== CAIP2 || canonical(requirement.network) !== CAIP2) throw `unsupported network (this facilitator settles ${CAIP2} only)`
  if (!eq(requirement.asset, USDC)) throw 'unsupported asset (not the tiny-chain USDC)'
  // WHOSE payment is this? `paymentRequirements` is caller-supplied, so payTo is
  // a claim, not a fact: every check below (signature, nonce, balance) can pass
  // for a perfectly valid authorization that simply isn't ours to relay. Checked
  // BEFORE the signature work because it's static and free — and in `validate`,
  // shared by /verify and /settle, so /verify can never bless what /settle
  // refuses (a facilitator whose two answers disagree is worse than either).
  if (!payeeAllowed(requirement.payTo, PAYEES)) throw OFF_LIST_REASON
  if (!eq(auth.to, requirement.payTo)) throw 'authorization.to does not match requirement.payTo'

  let value, required
  try { value = BigInt(auth.value); required = BigInt(requirement.maxAmountRequired) } catch { throw 'non-integer value/maxAmountRequired' }
  if (value < required) throw 'authorized value below required amount'

  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (nowSec <= BigInt(auth.validAfter)) throw 'authorization not yet valid'
  // 6s buffer: the settle tx must still be inside the window when it mines.
  if (nowSec + 6n >= BigInt(auth.validBefore)) throw 'authorization expired (or expires before settlement)'

  const okSig = await verifyTypedData({
    address: auth.from,
    domain: {
      name: requirement.extra?.name || 'USDC',
      version: requirement.extra?.version || '2',
      chainId: CHAIN_ID,
      verifyingContract: requirement.asset,
    },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from, to: auth.to, value,
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  }).catch(() => false)
  if (!okSig) throw 'signature does not recover to authorization.from'

  const [used, balance] = await Promise.all([
    pub.readContract({ address: USDC, abi: ABI, functionName: 'authorizationState', args: [auth.from, auth.nonce] }),
    pub.readContract({ address: USDC, abi: ABI, functionName: 'balanceOf', args: [auth.from] }),
  ])
  if (used) throw 'authorization nonce already used'
  if (balance < value) throw 'insufficient payer balance'

  return { auth, signature, requirement }
}

async function handleVerify(body) {
  try {
    const { auth } = await validate(body)
    return { isValid: true, payer: auth.from }
  } catch (reason) {
    return { isValid: false, invalidReason: String(reason) }
  }
}

async function handleSettle(body) {
  let checked
  try {
    checked = await validate(body)
  } catch (reason) {
    // Pre-submission refusal: nothing was broadcast, nothing can land. This is
    // the ONE settle failure that is genuinely safe for a caller to refund, and
    // it says so explicitly rather than leaving readers to infer it.
    return { success: false, settlement: NOT_SETTLED, errorReason: String(reason) }
  }
  const { auth, signature, requirement } = checked
  // ⚠️ The hash lives OUTSIDE the try. Once writeContract resolves, a transfer
  // is in the mempool and may confirm at any time — so every failure past that
  // point must report `unknown` and carry the hash, never a flat failure. We are
  // the only party that knows a tx was submitted; if we drop that fact, the
  // receiver 402s and the payer route reverses the payer's debit while the USDC
  // lands on-chain (chain/settle-outcome.mjs documents the full three-reader
  // chain; app/api/wallet/withdraw/route.ts carries the mirror doctrine for
  // outbound payouts).
  let hash
  try {
    // 🖊️ SIGN LOCALLY FIRST, broadcast as a SEPARATE step — the same structural
    // move app/api/wallet/withdraw/route.ts makes for outbound payouts, and for
    // the same reason. `writeContract` bundles estimate + sign + send, so if the
    // node ACCEPTS the transaction but the HTTP ack is lost, it throws with `hash`
    // still unset — indistinguishable from a request that never arrived. That is
    // the one tail c46 could only guess at (`isPreBroadcastError`, a heuristic
    // over viem's error taxonomy).
    //
    // Splitting the call removes the guess instead of improving it. The hash is
    // keccak256 of the signed serialized transaction — fixed the instant we sign,
    // BEFORE any write hits the network — so the invariant becomes structural:
    //
    //   hash unset → nothing was signed, so nothing can have been broadcast.
    //   hash set   → it may be in flight, forever. Never `not_settled`.
    //
    // `prepareTransactionRequest` does read-only RPC (nonce, gas estimate, fees).
    // A revert surfaces THERE, before signing, with `hash` still unset — which is
    // exactly the common refundable case (expired authorization, reused nonce,
    // payer can't cover it), now proven by control flow rather than by matching
    // error names.
    //
    // Packed-bytes overload — submits the payer's signature verbatim.
    const data = encodeFunctionData({
      abi: ABI, functionName: 'transferWithAuthorization',
      args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, signature],
    })
    const request = await relayer.prepareTransactionRequest({ to: USDC, data })
    const serializedTransaction = await relayer.signTransaction(request)
    // Past this line every failure is "may have been broadcast".
    hash = keccak256(serializedTransaction)
    await relayer.sendRawTransaction({ serializedTransaction })
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') {
      // Mined and REVERTED — the authorization was consumed by a failing call,
      // so no USDC moved and none can. Refundable, and the hash still rides
      // along as the audit trail.
      return { success: false, settlement: NOT_SETTLED, transaction: hash, errorReason: `settlement tx reverted (${hash})` }
    }
    return { success: true, settlement: SETTLED, transaction: hash, network: requirement.network, payer: auth.from }
  } catch (e) {
    const why = String(e?.shortMessage || e?.message || e).slice(0, 160)
    if (hash) {
      console.error('[facilitator] settle-unknown', JSON.stringify({ hash, payer: auth.from, to: auth.to, value: String(auth.value), why }))
      return {
        success: false, settlement: UNKNOWN, transaction: hash, network: requirement.network, payer: auth.from,
        errorReason: `settlement submitted but unconfirmed (${hash}): ${why}`,
      }
    }
    // No hash ⟹ we never signed ⟹ nothing was broadcast. This is now a
    // STRUCTURAL fact, not a guess: only `prepareTransactionRequest` (read-only:
    // nonce, gas estimate, fees) and the local `signTransaction` run before `hash`
    // is assigned, so nothing above this can have put a transaction on the wire.
    //
    // c46 had to infer this from viem's error taxonomy (`isPreBroadcastError`),
    // which was never safe: viem's generic envelopes wrap a real revert AND an
    // unreachable node, so one misread name turned a lost ack into a refund. The
    // heuristic is deleted rather than tuned — an unreachable node now fails
    // inside `prepareTransactionRequest`, before signing, and is refundable
    // because it provably sent nothing, not because we recognised its error.
    return {
      success: false,
      settlement: NOT_SETTLED,
      errorReason: `settlement rejected before broadcast: ${why}`,
    }
  }
}

const server = createServer(async (req, res) => {
  const respond = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'GET' && req.url === '/healthz') return respond(200, { ok: true, network: CAIP2, usdc: USDC })
  if (req.method === 'GET' && req.url === '/supported') return respond(200, { kinds: [{ x402Version: 1, scheme: 'exact', network: CAIP2 }] })
  if (req.method !== 'POST' || (req.url !== '/verify' && req.url !== '/settle')) return respond(404, { error: 'not found' })

  let body
  try {
    const chunks = []
    for await (const c of req) {
      chunks.push(c)
      if (chunks.reduce((n, b) => n + b.length, 0) > 64_000) throw new Error('body too large')
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return respond(400, req.url === '/verify' ? { isValid: false, invalidReason: 'invalid JSON body' } : { success: false, errorReason: 'invalid JSON body' })
  }
  const result = req.url === '/verify' ? await handleVerify(body) : await handleSettle(body)
  respond(200, result)
})

server.listen(PORT, () => {
  console.log(`tiny-chain x402 facilitator on :${PORT} — network ${CAIP2}, usdc ${USDC}, rpc ${RPC}`)
})
