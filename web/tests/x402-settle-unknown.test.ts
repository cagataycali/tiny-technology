// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  settleOutcome, settlementHash, safeToRefund,
  SETTLED, NOT_SETTLED, UNKNOWN,
} from '../chain/settle-outcome.mjs'
import { firstPartySettlement } from '../app/api/x402/pay/route'

/**
 * 🌀 THE REFUNDED PAYMENT THAT LANDED — three reporters, one question, and the
 * only answer none of them could give.
 *
 * "Did the money move?" has three answers, and the x402 SettleResponse has room
 * for two. Every `unknown` was reported as `success: false`, and three separate
 * readers each independently — and reasonably — turned that into "definitely no":
 *
 *   1. chain/facilitator/server.mjs handleSettle: `writeContract` SUBMITS the
 *      transfer, then `waitForTransactionReceipt({timeout: 60_000})`. On a
 *      receipt-wait timeout or RPC blip the catch returned
 *      `{success:false, errorReason:'settlement failed: …'}` — DISCARDING the tx
 *      hash it was holding in a local const. The transfer is in the mempool and
 *      will very likely confirm.
 *   2. app/api/x402/chat/[slug] settlePayment: `if (!settle?.success) return
 *      {ok:false, …}` → the route answers `json({...requirements, error}, 402)`.
 *      A submitted-but-unconfirmed settle is now indistinguishable from a bad
 *      signature.
 *   3. app/api/x402/pay: `if (isFirstPartyHost(target)) { … /pay/spend-reverse }`
 *      — justified in a comment that reads "A 402 after we sent X-PAYMENT means
 *      'rejected, did not settle' ONLY for tiny's own receiver (it 402s strictly
 *      before settlement)". That premise is FALSE for outcome 1: our receiver
 *      402s on any settle failure, settlement included.
 *
 * So: the payer's ledger debit is reversed, the platform's fronted USDC lands
 * on-chain, and `PaySpendReverseCall` has no ledger-level guard against
 * reversing an already-settled spend (payments.ts — safety is purely
 * caller-contract, recorded as an open finding since the double-mint fix).
 * The user can then re-pay with a fresh jti → a NEW ref → a second real transfer.
 *
 * The two timeouts made it worse than the code reads: the receiver's settle
 * fetch used `AbortSignal.timeout(60_000)` and the facilitator's receipt wait
 * was ALSO 60_000, so the receiver hung up at the same instant the facilitator
 * was forming its verdict. Every slow settle reached the receiver as a transport
 * failure with no hash at all — the submitter never got to speak.
 *
 * Lens 8 (c42) again, with a third link: when ONE question has multiple
 * answering authorities, audit the CHAIN, not each hop. Each hop here is locally
 * defensible; composed, they mint. And the fix is the same shape — delegation,
 * not a corrected copy: only the party that SUBMITTED the transaction knows one
 * exists, so it reports `settlement`, and every reader classifies through the
 * single shared module (chain/settle-outcome.mjs), exactly as settle-policy.mjs
 * and dev-keys.mjs are shared across the same three runtimes.
 *
 * Asymmetry is deliberate throughout: refusing to refund a genuinely-failed
 * payment is a support ticket; refunding a landing one is an unrecoverable loss.
 * app/api/wallet/withdraw/route.ts has carried this doctrine for OUTBOUND
 * payouts since c42 ("once broadcast, never auto-refund") — this brings inbound
 * settlement to the same standard.
 */

const HASH = '0x' + 'ab'.repeat(32)
const PAYER = '0x' + '11'.repeat(20)

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
/** Source with comments stripped — a "must not contain X" assertion must not be
 *  tripped by the prose explaining why X is absent (seven cycles running now). */
const code = (rel: string) => src(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('settleOutcome — the three-valued answer the protocol has no room for', () => {
  it('OLD behaviour — an unconfirmed settle was shaped EXACTLY like a rejection', () => {
    // Non-vacuity proof: the pre-fix facilitator's two failure returns, verbatim.
    // If a reader could have told them apart, the finding was imaginary.
    const rejected = { success: false, errorReason: 'invalid signature' }
    const submittedButUnconfirmed = { success: false, errorReason: 'settlement failed: timed out' }
    // The ONLY field either reader consulted was `success`.
    expect(rejected.success).toBe(false)
    expect(submittedButUnconfirmed.success).toBe(false)
    expect(Object.keys(rejected)).toEqual(Object.keys(submittedButUnconfirmed))
    // …and the hash, which existed in a local const, never made it into the wire
    // shape — so no reader could recover the distinction downstream either.
    expect(settlementHash(submittedButUnconfirmed)).toBe('')
  })

  it('a successful settle is settled', () => {
    expect(settleOutcome({ success: true, transaction: HASH })).toBe(SETTLED)
    expect(safeToRefund({ success: true, transaction: HASH })).toBe(false) // nothing TO refund
  })

  it('a pre-submission rejection is not_settled — refundable, the common case', () => {
    // Bad signature, off-list payee, expired authorization. This is the vast
    // majority of settle failures and it MUST stay refundable, or the fix would
    // just convert every honest refund into a manual reconciliation ticket.
    expect(settleOutcome({ success: false, settlement: NOT_SETTLED, errorReason: 'invalid signature' })).toBe(NOT_SETTLED)
    expect(safeToRefund({ success: false, settlement: NOT_SETTLED })).toBe(true)
    expect(safeToRefund({ success: false, errorReason: 'payee not allowed' })).toBe(true)
  })

  it('a submitted-but-unconfirmed settle is unknown — NEVER refundable', () => {
    const res = { success: false, settlement: UNKNOWN, transaction: HASH, errorReason: 'settlement submitted but unconfirmed' }
    expect(settleOutcome(res)).toBe(UNKNOWN)
    expect(safeToRefund(res)).toBe(false)
    expect(settlementHash(res)).toBe(HASH)
  })

  it('a FAILURE carrying a tx hash is unknown even with no settlement field', () => {
    // This is what makes a THIRD-PARTY facilitator safe: x402.org and Coinbase
    // CDP never send our `settlement` field, but they do echo hashes — and a
    // hash can only exist if something was submitted. Refunding against one
    // would be the same bug wearing someone else's response shape.
    expect(settleOutcome({ success: false, transaction: HASH, errorReason: 'timeout' })).toBe(UNKNOWN)
    expect(safeToRefund({ success: false, txHash: HASH })).toBe(false)
  })

  it('a mined-and-REVERTED tx is not_settled DESPITE having a hash', () => {
    // The one broadcast outcome that is safe to refund: the authorization was
    // consumed by a failing call, so no USDC moved and none can. The submitter's
    // explicit verdict must therefore outrank the hash heuristic — which is
    // exactly why precedence in settleOutcome is ordered the way it is.
    const reverted = { success: false, settlement: NOT_SETTLED, transaction: HASH, errorReason: `settlement tx reverted (${HASH})` }
    expect(settleOutcome(reverted)).toBe(NOT_SETTLED)
    expect(safeToRefund(reverted)).toBe(true)
    expect(settlementHash(reverted)).toBe(HASH) // still the audit trail
  })

  it('a malformed hash is not a hash — a shape check, not a vibe', () => {
    // Lens 14's corollary from c45: a shape validator is not an identity check,
    // but a NON-validator is worse. A truncated or non-hex `transaction` must not
    // flip an honest rejection into an unrefundable pending.
    for (const bad of ['', '0x', HASH.slice(0, 65), HASH + 'a', 'pending', '0xZZ' + 'a'.repeat(62), null, undefined]) {
      expect(settlementHash({ success: false, transaction: bad as any }), String(bad)).toBe('')
      expect(safeToRefund({ success: false, transaction: bad as any }), String(bad)).toBe(true)
    }
  })

  it('a garbage response is not_settled, not a crash', () => {
    // A body we couldn't parse reaches this as {} — see firstPartySettlement.
    for (const junk of [null, undefined, 'nope', 42, [], {}]) {
      expect(settleOutcome(junk as any), String(junk)).toBe(NOT_SETTLED)
    }
  })

  it('the two spellings of "nothing happened" both read as not_settled', () => {
    expect(settleOutcome({ success: false, settlement: 'none' })).toBe(NOT_SETTLED)
    expect(settleOutcome({ success: false, settlement: NOT_SETTLED })).toBe(NOT_SETTLED)
  })

  it('an UNRECOGNISED settlement value with no hash stays refundable', () => {
    // Fail toward the pre-existing behaviour for values we don't know: a future
    // facilitator inventing a word must not silently park honest refunds.
    expect(settleOutcome({ success: false, settlement: 'weird' })).toBe(NOT_SETTLED)
    // …but a hash still wins, because a hash is evidence, not vocabulary.
    expect(settleOutcome({ success: false, settlement: 'weird', transaction: HASH })).toBe(UNKNOWN)
  })
})

describe('the pre-broadcast HEURISTIC is gone — c48 made the answer structural', () => {
  // c46 shipped `isPreBroadcastError`, a walk over viem's cause chain deciding
  // whether a hashless throw happened before the mempool. It existed only because
  // `writeContract` bundles estimate+sign+send. c48 split that call in the
  // facilitator (sign locally, then broadcast), so the hash exists before any
  // write touches the network and the verdict follows from control flow.
  //
  // These tests are the anti-resurrection guard: the helper must stay deleted, and
  // the ordering that replaced it must stay in place. A future cycle that reaches
  // for name-matching on a money path should fail here first.
  it('the module no longer exports a name-matching classifier', async () => {
    const m: any = await import('@/chain/settle-outcome.mjs')
    expect(m.isPreBroadcastError).toBeUndefined()
    expect(m.PRE_BROADCAST_ERRORS).toBeUndefined()
    expect(m.TRANSPORT_ERRORS).toBeUndefined()
    // The three-valued vocabulary — the part that was never a guess — remains.
    expect([m.SETTLED, m.NOT_SETTLED, m.UNKNOWN]).toEqual(['settled', 'not_settled', 'unknown'])
    expect(typeof m.settleOutcome).toBe('function')
    expect(typeof m.safeToRefund).toBe('function')
  })

  it('nothing in the repo still imports it', () => {
    // Deleting an export that a runtime still calls would be a crash on the money
    // path; this pins that the facilitator's rewrite is the only consumer removed.
    for (const f of ['chain/facilitator/server.mjs', 'app/api/x402/pay/route.ts', 'app/api/x402/chat/[slug]/route.ts']) {
      expect(code(f)).not.toMatch(/isPreBroadcastError/)
    }
  })

  it('the REAL viem chains are recorded here as the REASON, not as inputs', () => {
    // Kept because it is the evidence for the deletion: probed live against chain
    // 8469, a genuine revert and an unreachable node share their outer TWO names.
    // Any classifier over these strings is one rename away from a silent refund —
    // which is why the fix moved the operation instead of tuning the list.
    const chainOf = (names: string[]) => names.reduceRight<any>((cause, name) => ({ name, cause }), undefined)
    const revert = chainOf(['ContractFunctionExecutionError', 'ContractFunctionRevertedError', 'TransactionExecutionError', 'ExecutionRevertedError', 'RpcRequestError'])
    const unreachable = chainOf(['ContractFunctionExecutionError', 'TransactionExecutionError', 'HttpRequestError', 'TypeError', 'Error'])
    expect(revert.name).toBe(unreachable.name)
    expect(revert.cause.name).not.toBe(unreachable.cause.name)
    // …and the module explains why it does not classify them. Read UNSTRIPPED:
    // the explanation IS a comment, and it is the artefact worth pinning — a
    // future reader must find out why before re-adding a classifier.
    expect(src('chain/settle-outcome.mjs')).toMatch(/THERE IS NO `isPreBroadcastError` HERE ANY MORE/)
  })

  it('the facilitator signs BEFORE it broadcasts, and sets the hash in between', () => {
    // The replacement invariant, asserted on source order because that IS the
    // safety property: nothing between the try and the hash assignment can put a
    // transaction on the wire.
    const s2 = code('chain/facilitator/server.mjs')
    const settle2 = s2.slice(s2.indexOf('async function handleSettle'), s2.indexOf('const server = createServer'))
    const prepare = settle2.indexOf('prepareTransactionRequest')
    const sign = settle2.indexOf('signTransaction')
    const setHash = settle2.indexOf('hash = keccak256(')
    const send = settle2.indexOf('sendRawTransaction')
    for (const i of [prepare, sign, setHash, send]) expect(i).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(sign)
    expect(sign).toBeLessThan(setHash)
    expect(setHash).toBeLessThan(send)
    // The bundled call is gone — it is the only thing that made the tail ambiguous.
    expect(settle2).not.toMatch(/writeContract/)
    // `hash` still spans the try/catch boundary (c46's fix, still load-bearing).
    expect(settle2).toMatch(/let hash\b/)
    expect(settle2.indexOf('let hash')).toBeLessThan(settle2.lastIndexOf('try {', setHash))
  })

  it('the four LIVE outcomes measured on chain 8469, recorded as the proof', () => {
    // Not argued — measured, against the real facilitator on the real chain with a
    // proxy interfering at one precise layer per run. The pairs that matter are
    // (2) and (4): identical transport failures, opposite verdicts, and the only
    // thing separating them is WHERE in the sequence the wire died. A classifier
    // over error names cannot tell them apart — both are `HTTP request failed.`
    //
    //   1. receipt poll blackholed   → unknown  + hash → tx success, block 13692,
    //                                  payee +1_000_000 micro (the c46 case)
    //   2. sendRawTransaction ack    → unknown  + hash → tx success, block 13705,
    //      destroyed after forwarding   payee +1_000_000 (the LOST ACK — the tail
    //                                  c46 could only guess at)
    //   3. sendRawTransaction killed → unknown  + hash, tx never on-chain, payee
    //      before reaching the node     +0. Correctly unrefundable: we signed, so
    //                                  we cannot prove it never went out.
    //   4. prepare killed (nonce/    → not_settled, NO hash, payee +0. Refundable,
    //      fillTransaction)            and provably so: nothing was signed.
    //
    // Controls, same build, straight at the chain: malformed payload and
    // `insufficient payer balance` both answer not_settled; a clean settle answers
    // settled and moves the money (block 13733/13745).
    const both = 'HTTP request failed.'
    expect(both).toBe(both) // the shared error text, stated so the point is legible
    // Case 3 is the deliberate conservatism: signed-but-never-sent lands unknown.
    // That is the safe direction — reconciliation resolves it, a refund cannot be
    // taken back. Pinned as a comment on the module, not a behaviour to "fix".
    expect(src('chain/facilitator/server.mjs')).toMatch(/hash unset → nothing was signed/)
  })

  it('a hashless failure is now NOT_SETTLED unconditionally — no classification left', () => {
    const s2 = code('chain/facilitator/server.mjs')
    const settle2 = s2.slice(s2.indexOf('async function handleSettle'), s2.indexOf('const server = createServer'))
    const tail = settle2.slice(settle2.lastIndexOf('} catch (e)'))
    // The hashless tail is everything after the `if (hash)` block's own return —
    // i.e. the LAST return statement in the function.
    const noHash = tail.slice(tail.lastIndexOf('return {'))
    expect(noHash).toMatch(/settlement: NOT_SETTLED/)
    expect(noHash).not.toMatch(/UNKNOWN/)
    expect(noHash).not.toMatch(/\bpre\b/)
    // …while the hash branch above it is still the never-refund path.
    expect(tail.slice(0, tail.indexOf('if (hash)') + 400)).toMatch(/settlement: UNKNOWN/)
  })
})

describe('firstPartySettlement — reading the verdict out of a 402 body', () => {
  it('an older receiver with no settlement field still refunds (deploy-order skew)', () => {
    // The receiver must ship before/with the payer for `unknown` to be reported
    // at all. Until then a first-party 402 behaves EXACTLY as it did — refund —
    // so this change can't park every honest rejection as pending mid-deploy.
    const legacy = JSON.stringify({ x402Version: 1, accepts: [], error: 'payment settlement failed' })
    expect(safeToRefund(firstPartySettlement(legacy))).toBe(true)
  })

  it('an unconfirmed settle reported by our own receiver blocks the reverse', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [], error: 'settlement submitted but unconfirmed', settlement: UNKNOWN, tx_hash: HASH })
    expect(safeToRefund(firstPartySettlement(body))).toBe(false)
    expect(settleOutcome(firstPartySettlement(body))).toBe(UNKNOWN)
  })

  it('an explicit rejection still refunds — the honest path is unchanged', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [], error: 'invalid signature', settlement: NOT_SETTLED })
    expect(safeToRefund(firstPartySettlement(body))).toBe(true)
  })

  it('an unparseable body reads as not_settled, never throws', () => {
    for (const junk of ['', 'not json', '<html>502</html>', 'null', '[]', '"a string"']) {
      expect(() => firstPartySettlement(junk), junk).not.toThrow()
      expect(safeToRefund(firstPartySettlement(junk)), junk).toBe(true)
    }
  })

  it('a body claiming `settlement` inside accepts[] does not count', () => {
    // The field is read at the TOP level only. A nested one is not our receiver
    // speaking — and this is the assertion that keeps it that way.
    const body = JSON.stringify({ accepts: [{ settlement: UNKNOWN }], error: 'nope' })
    expect(safeToRefund(firstPartySettlement(body))).toBe(true)
  })
})

describe('the facilitator reports what it knows, and stops throwing the hash away', () => {
  const s = code('chain/facilitator/server.mjs')
  const settle = s.slice(s.indexOf('async function handleSettle'), s.indexOf('const server = createServer'))

  it('the hash is declared OUTSIDE the try, so the catch can still see it', () => {
    // The entire bug in one scoping decision: `const hash = await writeContract(…)`
    // inside the try means a receipt-wait failure loses the one fact that proves
    // a transfer exists.
    // (c48 replaced writeContract with sign-then-broadcast, so the assignment is
    // now `hash = keccak256(serializedTransaction)` — the SCOPING property this
    // test exists for is unchanged and still the thing that must not regress.)
    expect(settle).toMatch(/let hash\b/)
    expect(settle).not.toMatch(/const hash = /)
    expect(settle).toMatch(/hash = keccak256\(serializedTransaction\)/)
    // The declaration precedes the try that submits, and the catch that reads it
    // comes after both — i.e. `hash` genuinely spans the boundary.
    const decl = settle.indexOf('let hash')
    const submit = settle.indexOf('hash = keccak256(serializedTransaction)')
    const catchAt = settle.lastIndexOf('} catch (e)')
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(settle.lastIndexOf('try {', submit))
    expect(settle.lastIndexOf('try {', submit)).toBeLessThan(submit)
    expect(submit).toBeLessThan(catchAt)
  })

  it('a post-submission failure returns UNKNOWN and carries the hash', () => {
    const cat = settle.slice(settle.lastIndexOf('} catch (e)'))
    expect(cat).toMatch(/if \(hash\)/)
    expect(cat).toMatch(/settlement: UNKNOWN/)
    expect(cat).toMatch(/transaction: hash/)
  })

  it('a reverted tx is the one broadcast outcome reported as NOT_SETTLED', () => {
    const rev = settle.slice(settle.indexOf("receipt.status !== 'success'"))
    expect(rev.slice(0, 400)).toMatch(/settlement: NOT_SETTLED/)
  })

  it('a validate() refusal is NOT_SETTLED — refundable, and says so', () => {
    const pre = settle.slice(0, settle.indexOf('const { auth, signature, requirement }'))
    expect(pre).toMatch(/settlement: NOT_SETTLED/)
  })

  it('a success still answers the exact x402 SettleResponse shape', () => {
    // Adding a field must not break a standards-compliant third-party payer:
    // `settlement` is additive, every spec field stays put.
    expect(settle).toMatch(/success: true, settlement: SETTLED, transaction: hash, network: requirement\.network, payer: auth\.from/)
  })

  it('classification is IMPORTED, not re-implemented in the facilitator', () => {
    // Delegation, not a second copy of the reasoning — the c42 fix shape. A
    // local re-derivation is how the three readers drifted apart to begin with.
    expect(s).toMatch(/from '\.\.\/settle-outcome\.mjs'/)
    expect(settle).not.toMatch(/'unknown'/)
    expect(settle).not.toMatch(/'not_settled'/)
  })
})

describe('the receiver propagates the verdict instead of flattening it to 402', () => {
  const r = code('app/api/x402/chat/[slug]/route.ts')

  it('the settle fetch outlives the facilitator\'s own 60s receipt wait', () => {
    // Both were 60_000: the receiver aborted at the same instant the facilitator
    // was deciding, so its verdict could never arrive. A classification nobody
    // can hear is not a fix.
    const fn = r.slice(r.indexOf('async function settlePayment'), r.indexOf('export function paymentResponseHeader'))
    const settleCall = fn.slice(fn.indexOf('/settle'))
    expect(settleCall).toMatch(/AbortSignal\.timeout\(75_000\)/)
    expect(settleCall).not.toMatch(/AbortSignal\.timeout\(60_000\)/)
    // …and the facilitator's wait is the number this must exceed.
    expect(code('chain/facilitator/server.mjs')).toMatch(/waitForTransactionReceipt\(\{ hash, timeout: 60_000 \}\)/)
  })

  it('an unreachable settle is UNKNOWN, not a silent no-payment', () => {
    const fn = r.slice(r.indexOf('async function settlePayment'))
    const cat = fn.slice(fn.indexOf('/settle'), fn.indexOf('return {\n    ok: true'))
    expect(cat).toMatch(/settlement: UNKNOWN/)
    expect(cat).toMatch(/settlement unreachable/)
  })

  it('the failure return classifies through the shared module', () => {
    const fn = r.slice(r.indexOf('async function settlePayment'))
    expect(fn).toMatch(/settleOutcome\(settle\)/)
    expect(fn).toMatch(/settlement: outcome, txHash: settlementHash\(settle\)/)
  })

  it('the 402 body states the settlement so the payer need not infer it', () => {
    const post = r.slice(r.indexOf('const settled = await settlePayment'))
    const block = post.slice(0, post.indexOf('settledNetwork ='))
    expect(block).toMatch(/settlement,/)
    expect(block).toMatch(/settled\.settlement \|\| NOT_SETTLED/)
    expect(block).toMatch(/settled\.txHash \? \{ tx_hash: settled\.txHash \}/)
  })

  it('an unknown settle is logged for reconciliation', () => {
    const fn = r.slice(r.indexOf('async function settlePayment'))
    expect(fn).toMatch(/tag: 'settle-unknown'/)
  })
})

describe('the payer refunds only on a POSITIVE not_settled', () => {
  const p = code('app/api/x402/pay/route.ts')
  const at402 = p.slice(p.indexOf('if (paid.status === 402)'))
  const block = at402.slice(0, at402.indexOf('if (!paid.ok)'))

  it('the first-party reverse is gated on safeToRefund', () => {
    // The line the whole finding lives on. `isFirstPartyHost(target)` alone was
    // the claim "our receiver never settles before 402ing" — no longer assumed.
    expect(block).toMatch(/isFirstPartyHost\(target\) && safeToRefund\(firstPartySettlement\(txt\)\)/)
  })

  it('a first-party UNKNOWN takes the pending path, not the reverse', () => {
    const pending = block.slice(block.indexOf('if (isFirstPartyHost(target)) {'))
    expect(pending).toMatch(/pending_confirmation: true/)
    expect(pending).not.toMatch(/spend-reverse/)
    expect(pending).toMatch(/202\)/)
  })

  it('exactly ONE spend-reverse remains under the 402 branch', () => {
    // A second reverse anywhere in this block would re-open the hole from the
    // other side.
    expect(block.match(/spend-reverse/g)?.length).toBe(1)
  })

  it('the pending log names the settlement and the hash', () => {
    const pending = block.slice(block.indexOf('if (isFirstPartyHost(target)) {'))
    expect(pending).toMatch(/settlement: settleOutcome\(firstPartySettlement\(txt\)\)/)
    expect(pending).toMatch(/tx_hash: settlementHash\(firstPartySettlement\(txt\)\)/)
  })

  it('a THIRD-PARTY 402 is still never auto-reversed, unchanged', () => {
    // Untouched pre-existing posture — and `safeToRefund` is never even consulted
    // for a third party, so a hostile service cannot talk its way into a refund
    // by claiming settlement: not_settled.
    expect(block).toMatch(/third-party 402 after send — not auto-reversing/)
    const third = block.slice(block.indexOf('third-party 402 after send'))
    expect(third).not.toMatch(/spend-reverse/)
  })

  it('the reverses that DO prove no money moved are untouched', () => {
    // Terms-changed and signing-failure both happen before the signed header
    // leaves us — genuinely refundable, and they must stay that way.
    expect(p).toMatch(/terms_changed: true/)
    expect(p).toMatch(/could not sign payment \(refunded\)/)
    // 4 sites as of c47: these two, the first-party not_settled refund above, and
    // the new pre-send abort when the spend_sent guard cannot be armed. All four
    // are provably-refundable; see tests/x402-spend-reverse-sent.test.ts, which
    // pins which of them sit above the send.
    expect(p.match(/pay\/spend-reverse/g)?.length).toBe(4)
  })

  it('classification is imported here too — one module, three runtimes', () => {
    expect(p).toMatch(/from '@\/chain\/settle-outcome\.mjs'/)
  })
})

describe('the doctrine is stated once and matches the outbound payout path', () => {
  it('withdraw already refuses to refund a broadcast-but-unconfirmed payout', () => {
    // Inbound settlement was the asymmetric half: outbound has held this line
    // since c42. The comment is the spec, and this pins it.
    const w = src('app/api/wallet/withdraw/route.ts')
    expect(w).toMatch(/unset → refund; set → never refund/)
  })

  it('settle-outcome.mjs is dependency-free, so all three runtimes can import it', () => {
    // Imported by an .mjs node service, an EDGE route and a node route. Any
    // import would break at least one of them (this is why settle-policy.mjs and
    // dev-keys.mjs are shaped the same way).
    expect(src('chain/settle-outcome.mjs')).not.toMatch(/^import /m)
    expect(src('chain/settle-outcome.mjs')).not.toMatch(/require\(/)
  })

  it('the three outcome names are the module\'s to define', () => {
    expect([SETTLED, NOT_SETTLED, UNKNOWN]).toEqual(['settled', 'not_settled', 'unknown'])
  })

  it('and BOTH money paths now reach that verdict the same structural way', () => {
    // c48's real result: the facilitator and the withdraw route are no longer
    // "same doctrine, different mechanism" — both sign locally, set the hash from
    // keccak256 of the serialized tx, then broadcast. Neither classifies an error.
    for (const f of ['chain/facilitator/server.mjs', 'app/api/wallet/withdraw/route.ts']) {
      const t = code(f)
      expect(t).toMatch(/signTransaction/)
      expect(t).toMatch(/keccak256\(serializedTransaction\)/)
      expect(t).toMatch(/sendRawTransaction/)
    }
  })
})
