// 🪑 IS THIS VALIDATOR SET HEALTHY? — one predicate, so the acceptance suites and
// any future monitor give the same answer about the same set.
//
// This exists because the P1 acceptance test asserted the WRONG rule, and did so
// in the one direction that hurts:
//
//     validators.length === NODES     // 4 nodes ⇒ expect exactly 4 validators
//
// That passed for six cycles and then failed — not because the chain broke, but
// because the chain finally did the thing it was built for. In P5 a stranger
// staked and rotate() seated them, so Besu reported 5 validators on a 4-node
// devnet, and the suite called a success a failure.
//
// 🔑 The lesson worth keeping: an equality assertion on a set that is DESIGNED to
// grow is a test of "nobody joined". On a permissionless chain, the healthy state
// is a RANGE, and the only test that can survive open participation is one that
// checks the invariants Besu actually depends on. Getting this wrong is not
// cosmetic — a red suite on a healthy chain trains an operator to ignore it, and
// the next failure is the real one.
//
// WHAT BESU ACTUALLY REQUIRES of getValidators() (verified by decompiling the
// shipped besu 26.7.0 jars — see the multinode design doc):
//
//   • NEVER EMPTY. An empty return is fatal: "Unexpected empty result from
//     validator smart contract call" and the chain HALTS with no proposer. This is
//     the failure that has no recovery path from inside the contract, which is why
//     MIN_VALIDATORS exists and why it is checked first here.
//   • AT LEAST the BFT floor. QBFT tolerates f faults with 3f+1 seats, so a
//     4-seat floor is what makes f=1 meaningful. Below it the chain still runs but
//     stops being fault-tolerant — the interesting failure, because nothing
//     announces it.
//   • AT MOST the seat cap. QBFT is O(n²) in messages; MAX_VALIDATORS is a
//     liveness bound, not a preference.
//   • NO DUPLICATES. Besu sorts the returned array itself
//     (TransactionValidatorProvider → Stream.sorted()) but does not dedupe, so a
//     doubled address would be counted twice toward every quorum — a set of 4 with
//     one duplicate is really 3 distinct signers pretending to be a BFT majority.
//
// Deliberately NOT checked here: whether the set equals the node count. Those are
// different things on purpose — a full node earns no seat (P5), and a seated
// validator need not be one of ours. Conflating them is the bug this file replaces.
//
// Plain `.mjs`, no imports, no RPC: the caller fetches the set and hands it in, so
// the predicate is testable without a chain (same arrangement as
// chain/relayer-gas.mjs, dev-keys.mjs and settle-policy.mjs).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The QBFT quorum: how many of `seats` must sign for a block to commit.
 *
 * `ceil(2n/3)`, taken from the SHIPPED besu 26.7.0 jar rather than from the
 * literature — `BftHelpers.calculateRequiredValidatorQuorum(int)` decompiles to
 * `Util.fastDivCeiling(2 * n, 3)`. Worth pinning in code because the off-by-one
 * neighbours are all plausible (`floor(2n/3)+1` differs at n=3, `2f+1` differs
 * whenever n≠3f+1) and each wrong version understates the number of validators a
 * chain needs alive — i.e. errs toward calling a stalled chain healthy.
 *
 * @param {number} seats
 * @returns {number}
 */
export function qbftQuorum(seats) {
  return Math.ceil((2 * seats) / 3)
}

/**
 * Assess a validator set against the rules Besu enforces.
 *
 * @param {unknown} validators   whatever `qbft_getValidatorsByBlockNumber` returned
 * @param {{ min?: number, max?: number }} [bounds]
 *   min — the floor below which the set is no longer BFT-meaningful (MIN_VALIDATORS)
 *   max — the seat cap (MAX_VALIDATORS)
 * @returns {{ ok: boolean, count: number, reason: string | null }}
 *   `reason` is null when healthy, and otherwise says which rule broke and why it
 *   matters — a count alone doesn't tell an operator whether to act.
 */
export function assessValidatorSet(validators, bounds = {}) {
  const min = bounds.min ?? 4
  const max = bounds.max ?? 21

  if (!Array.isArray(validators)) {
    return { ok: false, count: 0, reason: `getValidators() did not return an array (got ${typeof validators}) — besu cannot read a set from this` }
  }
  // Emptiness first and separately from the floor: it is the one case that HALTS
  // the chain rather than merely weakening it, so it deserves its own sentence.
  if (validators.length === 0) {
    return { ok: false, count: 0, reason: 'the validator set is EMPTY — besu halts with "Unexpected empty result from validator smart contract call" and there is no proposer' }
  }

  const malformed = validators.filter((v) => typeof v !== 'string' || !ADDRESS.test(v))
  if (malformed.length) {
    return { ok: false, count: validators.length, reason: `${malformed.length} entr(y/ies) are not addresses: ${JSON.stringify(malformed.slice(0, 3))}` }
  }

  // Case-insensitive: the same validator in two checksum forms is still one
  // signer, and comparing raw strings would call that a healthy set of two.
  const lower = validators.map((v) => v.toLowerCase())
  const distinct = new Set(lower)
  if (distinct.size !== lower.length) {
    const dupes = lower.filter((v, i) => lower.indexOf(v) !== i)
    // `count` is DISTINCT signers, not array entries: the array length is the
    // number besu would use for quorum arithmetic, and reporting it here would
    // repeat the very overcount this branch exists to catch.
    return { ok: false, count: distinct.size, reason: `duplicate validator(s) ${JSON.stringify([...new Set(dupes)])} — besu sorts the set but does not dedupe, so a doubled address counts twice toward every quorum: ${validators.length} entries, only ${distinct.size} real signers` }
  }

  if (distinct.size < min) {
    return { ok: false, count: distinct.size, reason: `${distinct.size} validator(s) is below the ${min}-seat floor — the chain still produces blocks but is no longer BFT fault-tolerant (3f+1 needs ${min} for f=1)` }
  }
  if (distinct.size > max) {
    return { ok: false, count: distinct.size, reason: `${distinct.size} validators exceeds the ${max}-seat cap — QBFT is O(n²) in messages, so the cap is a liveness bound` }
  }
  return { ok: true, count: distinct.size, reason: null }
}

/**
 * 💀 CAN THIS SET STILL COMMIT A BLOCK? — the question assessValidatorSet does not ask.
 *
 * Written after the 8470 devnet HALTED at block 11857 and assessValidatorSet
 * called the set healthy the whole way down. Both statements were true:
 *
 *   • 5 seats, floor 4, cap 21, no duplicates ⇒ a perfectly legal set.
 *   • quorum for 5 seats is 4, and only 4 of those seats belonged to a live
 *     process — so the network's fault tolerance was f=0, and the next crash
 *     (node1's JVM, an hour later) stopped the chain.
 *
 * 🔑 The seat that caused it was a SUCCESS of the design: in the P2 joiner test a
 * stranger staked, rotate() seated them, and then their process went away. Nobody
 * un-seats you for going quiet — that is exactly the permissionlessness being
 * built. But a seat is a share of every quorum, so an ABANDONED seat is not
 * neutral: it raises the bar for consensus while contributing nothing to it. On a
 * chain anyone may join, "how many seats" and "how many validators are actually
 * there" drift apart by default, and only the second one keeps the chain alive.
 *
 * ⚠️ And the recovery has a cruel shape, in TWO layers.
 *
 *   1. Below quorum, the on-chain fix is unreachable: removing a seat means
 *      calling rotate(), which is a transaction, which needs a quorum to mine.
 *      Liveness recovery requires liveness. The only ways out are off-chain —
 *      restart the missing node, or hold the abandoned key.
 *   2. ⚠️⚠️ Even ABOVE quorum, rotate() may not help, and this predicate must not
 *      promise that it will. Seats are awarded by STAKE, and an abandoned seat is
 *      usually abandoned by a joiner who staked generously to get it: on the real
 *      8470 the dead seat held 2.5B — MORE than any founder's 2.0B — so rotate()
 *      succeeds and re-seats it. Verified by simulateContract against the live
 *      devnet, after this file's first draft told an operator to rotate.
 *
 * 🔑 Which means the honest remediation is NOT "call rotate()". It is: get another
 * validator alive (restart a node, or seat one more honest candidate) so the set's
 * quorum has a live majority again. Un-seating the ghost needs something the
 * registry does not currently have — a liveness rule (only stake and voluntary exit
 * are enforced today). That gap is real and is named in the design doc rather than
 * papered over by advice that does not work.
 *
 * So this is a WARNING predicate: the margin must be watched while it is still
 * positive, because at zero there is nothing left to call.
 *
 * Deliberately separate from assessValidatorSet: that one judges a set from the
 * set alone (a pure function of `getValidators()`), while this needs evidence
 * about the outside world — who has actually proposed lately. Folding them
 * together would mean either lying about liveness or refusing to answer without
 * block data.
 *
 * @param {ReadonlyArray<string>} validators  the seated set (`getValidators()`)
 * @param {ReadonlyArray<string>} activeProposers
 *   addresses seen proposing in a recent window. MUST cover at least a full
 *   round-robin (>= validators.length blocks) or a healthy validator that simply
 *   hasn't had its turn reads as absent — see the `window` argument.
 * @param {{ window?: number }} [opts]
 *   window — how many blocks the evidence covers. When it is smaller than the
 *   seat count the answer is `unknown` rather than a guess, because a short
 *   window CANNOT distinguish "silent" from "not its turn yet".
 * @returns {{ ok: boolean, unknown: boolean, seats: number, live: number,
 *             quorum: number, margin: number, silent: string[], reason: string | null }}
 */
export function assessSetLiveness(validators, activeProposers, opts = {}) {
  const seats = Array.isArray(validators) ? validators.map((v) => String(v).toLowerCase()) : []
  const seatSet = new Set(seats)
  const quorum = qbftQuorum(seatSet.size)
  const seen = new Set(
    (Array.isArray(activeProposers) ? activeProposers : [])
      .map((p) => String(p).toLowerCase())
      // A proposer that is no longer seated is real evidence about the chain but
      // says nothing about THIS set's quorum, so it must not be counted toward it.
      .filter((p) => seatSet.has(p)),
  )
  const silent = [...seatSet].filter((s) => !seen.has(s))
  const live = seen.size
  const margin = live - quorum

  // A window shorter than one full round-robin cannot tell silence from waiting.
  // Refusing to answer beats both alternatives: claiming a stall on a healthy
  // chain trains an operator to ignore this, and claiming health on a stalled one
  // is the failure it exists to catch.
  const window = opts.window
  if (seatSet.size > 0 && typeof window === 'number' && window < seatSet.size) {
    return {
      ok: false, unknown: true, seats: seatSet.size, live, quorum, margin, silent,
      reason: `evidence covers ${window} block(s) for ${seatSet.size} seats — too short to tell a silent validator from one waiting its turn; sample at least ${seatSet.size}`,
    }
  }
  if (seatSet.size === 0) {
    return {
      ok: false, unknown: false, seats: 0, live: 0, quorum, margin, silent: [],
      reason: 'no seats — besu halts with no proposer (see assessValidatorSet)',
    }
  }
  if (live < quorum) {
    return {
      ok: false, unknown: false, seats: seatSet.size, live, quorum, margin, silent,
      reason: `only ${live} of ${seatSet.size} seats have proposed recently but ${quorum} must sign to commit — the chain CANNOT make blocks. rotate() is NOT the fix: it is a transaction, so it needs the quorum that is missing. Recover OFF-CHAIN by restarting the silent node(s) (${silent.slice(0, 3).join(', ')}${silent.length > 3 ? `, +${silent.length - 3}` : ''})`,
    }
  }
  if (margin === 0) {
    return {
      ok: false, unknown: false, seats: seatSet.size, live, quorum, margin, silent,
      reason: `${live} live of ${seatSet.size} seats is EXACTLY quorum (${quorum}) — ONE more failure halts the chain, and ${silent.length} abandoned seat(s) consumed the margin (${silent.slice(0, 3).join(', ')}${silent.length > 3 ? `, +${silent.length - 3}` : ''}). Fix by making another validator LIVE (restart a node, or seat one more honest candidate). Do NOT assume rotate() evicts the silent seat: seats go to the highest stake, and an abandoned seat is typically held by a joiner who out-staked the founders to get it`,
    }
  }
  return {
    ok: true, unknown: false, seats: seatSet.size, live, quorum, margin, silent,
    reason: null,
  }
}

/**
 * The healthy-set message, phrased so growth reads as SUCCESS rather than drift.
 *
 * An operator seeing "5 validators (floor 4)" on a 4-node devnet should
 * understand that someone joined, which is the product working. The old
 * assertion's failure text ("QBFT reports 4 validators") said the opposite.
 *
 * @param {number} count
 * @param {number} nodeCount  how many nodes WE run — reported, never asserted on
 * @param {{ min?: number, max?: number }} [bounds]
 */
export function validatorSetSummary(count, nodeCount, bounds = {}) {
  const min = bounds.min ?? 4
  const max = bounds.max ?? 21
  const grown = count > nodeCount
  return `${count} validator(s) seated, within the ${min}–${max} seat range` +
    (grown ? ` — ${count - nodeCount} more than the ${nodeCount} node(s) we run, i.e. outside stake is seated (this is the point)` : '')
}
