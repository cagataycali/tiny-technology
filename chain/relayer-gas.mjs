// ⛽ CAN THE RELAYER'S TRANSACTION BE MINED AT ALL? — one predicate, so the
// facilitator and the pre-cutover readiness check give the same answer.
//
// This exists because of a measured failure on chain 8470 (P6). Both tiny chains
// run ZERO-PRICE gas: genesis `zeroBaseFee`, besu `--min-gas-price=0`, and
// viem's own fee estimation returns maxFeePerGas 0. The natural reading is that
// gas simply doesn't matter, so a relayer needs no ETH. That reading is wrong,
// and wrong in the most expensive direction available to this service.
//
// MEASURED on the live 4-node 8470 devnet (chain/multinode), gasPrice 0 on every
// trial, sender differing only in balance:
//
//   balance 0 wei  → eth_sendRawTransaction ACCEPTS it and returns a hash.
//                    The transaction then sits in the pool FOREVER. Never mined,
//                    never rejected, no log line naming it.
//   balance 1 wei  → mined in the next block (~4s).
//
// So the gate is a STRICTLY POSITIVE BALANCE, not affordability. That distinction
// is the whole point of this module:
//
//   ⚠️ The check a reviewer naturally writes — `balance >= gas * maxFeePerGas` —
//      is TRUE for a 0-balance account on a 0-fee chain. It passes precisely
//      where the transaction cannot be mined. Arithmetic on fees cannot see this
//      failure; only `balance > 0` can.
//
// Why it costs money rather than merely failing: server.mjs signs, assigns
// `hash`, broadcasts, then waits for a receipt. Past the signing line every
// failure MUST report `unknown` (settle-outcome.mjs) because a broadcast tx may
// land at any time — and `unknown` is the one outcome that must never be
// auto-refunded. A 0-balance relayer therefore turns every single settlement
// into an unrefundable unknown: the payer is debited, the receiver is 402'd, and
// a reconciler has to chase a transfer that will never happen. The service is
// 100% broken while reporting the state reserved for "we cannot tell".
//
// Hence a STARTUP refusal, matching dev-keys.mjs's reasoning exactly: a
// facilitator that boots and then poisons every payment is far worse to diagnose
// than one that won't boot. It is also the shape this bug would have taken on
// cutover — prod's relayer holds ~1000 ETH on 8469 and 0 on 8470, so moving the
// facilitator to the new chain is exactly the "0 wei" row above.
//
// Plain `.mjs`, no imports, no RPC: `chain/`'s scripts are ESM run by bare node
// while this repo's suite is TypeScript, and both consume this file directly
// (same arrangement as dev-keys.mjs / settle-policy.mjs / settle-outcome.mjs).
// The caller does the eth_getBalance and hands the number in, so the predicate
// stays testable without a chain.

/**
 * Can a transaction signed by an account with this balance be mined?
 *
 * Deliberately NOT parameterized by gas or fee: on a zero-fee chain those make
 * the answer yes for an account that cannot transact. `> 0` is the real rule as
 * measured, and a rule that matches the measurement beats one that matches the
 * fee model.
 *
 * @param {bigint | number | string | null | undefined} balanceWei
 * @returns {boolean} false for zero, negative, absent, or unparseable balances.
 */
export function relayerCanTransact(balanceWei) {
  if (balanceWei === null || balanceWei === undefined || balanceWei === '') return false
  let wei
  try { wei = BigInt(balanceWei) } catch { return false }
  return wei > 0n
}

/**
 * The refusal message. Names the address, the chain, and — most importantly —
 * that zero-price gas is not the same as no gas needed, because an operator who
 * believes gas is free will read a gas complaint as a bug in this check and
 * override it.
 *
 * @param {string} address
 * @param {number | string} chainId
 */
export function relayerGasRefusal(address, chainId) {
  return `refusing to start: the facilitator relayer ${address} holds 0 ETH on chain ${chainId}.\n` +
    `  Zero-price gas is NOT the same as no gas required: a sender with a zero balance has its\n` +
    `  transactions ACCEPTED into the pool and never mined — so every settlement would be signed,\n` +
    `  broadcast, and then reported as 'unknown' (the one outcome that must never be refunded).\n` +
    `  Fund ${address} with any positive amount (1 wei is provably enough) and restart.`
}
