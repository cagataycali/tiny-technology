// 🎲 Did the money move? — the THREE-valued answer, in one place.
//
// A settlement has three outcomes, not two:
//
//   settled     the transfer is mined and successful. Serve the request.
//   not_settled nothing left the payer's balance and nothing can: the payload
//               was invalid, or the tx mined and REVERTED. Safe to refund.
//   unknown     we submitted a transaction and could not confirm it (receipt
//               timeout, RPC blip, lost ack). It may confirm at any moment.
//               NEVER refund — that double-pays a landing transfer.
//
// The x402 SettleResponse shape only has room for two (`{success: boolean}`),
// so every unknown was being reported as `success: false` — and three separate
// readers each turned that into "definitely did not settle":
//
//   chain/facilitator/server.mjs   a receipt-wait timeout returned
//                                  {success:false} and DISCARDED the tx hash it
//                                  already held.
//   app/api/x402/chat/[slug]       any !success became a 402.
//   app/api/x402/pay              a FIRST-PARTY 402 was treated as proof no
//                                  USDC moved → auto-reversed the ledger debit.
//
// So one unconfirmed-but-landing settlement refunded the payer while the
// platform's USDC was on-chain. Three guards, each individually reasonable,
// composing into a mint — the c42 pair shape with one more link in the chain.
//
// The fix is delegation, not a third copy of the reasoning: the only authority
// that KNOWS whether a transaction was submitted is the one that submitted it,
// so it reports `settlement`, and every reader classifies through this module.
// app/api/wallet/withdraw/route.ts already carries this doctrine for outbound
// payouts ("once broadcast, never auto-refund"); this brings inbound settlement
// to the same standard.
//
// Pure + dependency-free on purpose: imported by the facilitator (.mjs, node)
// AND by the edge receiver / node payer routes (.ts) — same verdict on all
// three sides, like chain/settle-policy.mjs and chain/dev-keys.mjs.

/** The transfer is mined and successful. */
export const SETTLED = 'settled'
/** Nothing moved and nothing can. The one outcome that is safe to refund. */
export const NOT_SETTLED = 'not_settled'
/** Submitted, unconfirmed. May land. Reconcile — never auto-refund. */
export const UNKNOWN = 'unknown'

/**
 * Classify a facilitator SettleResponse.
 *
 * Precedence is load-bearing, and the order is from most authoritative to most
 * defensive:
 *
 *   1. `success: true` → settled. The facilitator saw a successful receipt.
 *   2. an explicit `settlement` field → that. The submitter's own verdict wins,
 *      which is how a mined-and-REVERTED tx reports not_settled even though it
 *      has a hash (it is the one broadcast outcome that is safe to refund).
 *   3. a `transaction` on a FAILURE → unknown. A hash exists only if something
 *      was submitted, so a failure that still names one cannot be proof of
 *      no-settlement. This is what makes a THIRD-PARTY facilitator (x402.org,
 *      Coinbase CDP) safe too: they never send our `settlement` field, but they
 *      do echo hashes, and we must not refund against one.
 *   4. otherwise → not_settled. A bare `{success:false}` with no hash is a
 *      pre-submission rejection (bad signature, off-list payee, expired auth),
 *      which is the overwhelmingly common case and must stay refundable.
 */
export function settleOutcome(res) {
  if (!res || typeof res !== 'object') return NOT_SETTLED
  if (res.success === true) return SETTLED
  const stated = String(res.settlement || '')
  if (stated === UNKNOWN) return UNKNOWN
  if (stated === NOT_SETTLED || stated === 'none') return NOT_SETTLED
  if (settlementHash(res)) return UNKNOWN
  return NOT_SETTLED
}

/** The submitted tx hash a response carries, or '' — `transaction` is the x402
 *  spec field; `txHash` is accepted because our own receiver reads both. */
export function settlementHash(res) {
  const h = String(res?.transaction || res?.txHash || '')
  return /^0x[0-9a-fA-F]{64}$/.test(h) ? h : ''
}

// ⛔ THERE IS NO `isPreBroadcastError` HERE ANY MORE, AND THAT IS THE POINT.
//
// c46 shipped one: a walk over viem's `cause` chain deciding whether a throw with
// no tx hash happened before the transaction could reach the mempool. It existed
// because `writeContract` bundles estimate → sign → send, so a single throw meant
// either "the gas estimate reverted, nothing was sent" (refundable, and the common
// case) or "the node took it and the ack was lost" (never refundable).
//
// A guess is the wrong instrument for that question, and it proved so twice:
//
//   1. An early draft listed viem's GENERIC envelope `ContractFunctionExecution-
//      Error`. Probed live, a real revert and an unreachable node share their
//      outer TWO names — so a dead RPC classified as refundable, reintroducing
//      the very bug the module exists to close.
//   2. Even after the transport veto, correctness depended on a third party's
//      error taxonomy staying put across versions. Nothing in our tests would
//      notice viem renaming a class; the failure mode is a silent refund.
//
// c48 deleted the guess instead of tuning it. `chain/facilitator/server.mjs` now
// signs locally FIRST and broadcasts as a separate step, exactly as
// app/api/wallet/withdraw/route.ts has since c42, so the hash — keccak256 of the
// signed serialized tx — exists before any write touches the network. The answer
// is then CONTROL FLOW, not classification:
//
//   hash unset → only read-only RPC and a local signature ran. Nothing was
//                broadcast. `not_settled`.
//   hash set   → it may confirm at any time, forever. `unknown`.
//
// Same three outcomes, one fewer thing to be wrong about. If you find yourself
// reaching for a name-matching helper on a money path, that is the signal to move
// the operation instead: make the safe answer follow from the ORDER of the steps.

/**
 * May a caller reverse the payer's debit on this response?
 *
 * The single question the money path actually asks. `unknown` answers NO — the
 * asymmetry is deliberate: refusing to refund a genuinely-failed payment is a
 * support ticket, refunding a landing one is an unrecoverable platform loss.
 */
export function safeToRefund(res) {
  return settleOutcome(res) === NOT_SETTLED
}
