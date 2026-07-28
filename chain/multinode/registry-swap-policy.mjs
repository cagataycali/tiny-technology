// 🔁 IS THIS REGISTRY SWAP SURVIVABLE? — the preflight for the one operation on
// chain 8470 that cannot be undone from inside the chain.
//
// Besu reads the validator set from whatever address the genesis names. Pointing
// it at a different registry is therefore one line of JSON, applied at a
// transition, and it reads like a configuration change. It is not. It is an
// INSTANTANEOUS REPLACEMENT OF THE VALIDATOR SET with whatever the incoming
// contract's `getValidators()` happens to return, at a moment nobody re-checks.
//
// ⚠️⚠️ THE FINDING THAT MADE THIS FILE (c17, probed against the live 8470 devnet
// before writing a line of it). The carried debt said: swap `TinyValidators` for
// `TinyValidatorsSlashable`, migrating stake and candidates first. Executing that
// as written, today, would have KILLED THE DEVNET:
//
//     outgoing registry: 6 seats, 5 of them proposing blocks right now
//     incoming registry: 8 seats, ZERO of them belonging to any running process
//                        (they are leftover joiners from the slashable E2E)
//     ⇒ after the transition: quorum 6, demonstrably live 0 → no proposer, ever
//
// And it is unrecoverable from inside: the only way to change a registry's set is
// `rotate()`, which is a transaction, which needs the quorum that no longer
// exists. Liveness recovery requires liveness. The chain would have to be
// relaunched from a rolled-back genesis — on a chain whose whole claim is that
// outsiders can join and sync it, that is not a recovery, it is a new chain.
//
// 🔑 THE LENS: A CONFIG CHANGE THAT SWITCHES WHICH CONTRACT ANSWERS A QUESTION IS A
// CHANGE TO THE ANSWER. The two registries are the same code with the same rules,
// which is exactly why the swap looked mechanical — the differences that matter are
// not in the code, they are in the STATE each one accumulated. Nothing about
// deploying, testing and even convicting on the incoming registry tells you
// anything about whether its seated set is a set of live validators, and the
// acceptance suites that pass hardest are the ones that never ask.
//
// 🔑 AND THE CHECK ALREADY EXISTED, POINTED AT THE WRONG SET. c15 wrote
// `assessSetLiveness` after the devnet halted with margin 0, and every caller
// since has aimed it at the AUTHORITATIVE set — the only set that cannot tell you
// anything about a swap. So this module deliberately does not reimplement it: it
// aims the existing predicate at the INCOMING registry, which is the whole
// insight. A new predicate here would have been a second opinion nobody
// reconciles; c53's mistake, one layer down.
//
// ⚠️⚠️ c18 CORRECTS c17's REMEDIATION — it was impossible, see
// `assessSwapReachability`. "Stake the live validators in and rotate()" cannot
// reach quorum on this registry, because rotate() seats EVERY eligible candidate
// rather than a top-N: adding a live validator adds a SEAT, quorum grows by 2 per 3
// seats, and 8 eligible ghosts therefore demand 14 live validators against the 5
// that exist. Every step of that advice succeeds and the chain halts anyway.
// 🔑 A REMEDIATION IS A CLAIM ABOUT THE FUTURE AND NEEDS A CHECK OF ITS OWN — the
// blocker was verified and mutation-tested; the fix printed beneath it never was.
//
// The four questions, each of which fails silently on its own:
//
//   1. WILL THE CHAIN STILL COMMIT BLOCKS? (`assessSetLiveness` on the incoming
//      seats, with independent evidence — who actually proposed — never the
//      registry's own opinion of itself.)
//   2. IS THE TRANSITION KEY A TIMESTAMP, AND IS IT FAR ENOUGH AHEAD? (c7's bug:
//      with a time-based hardfork in the genesis, a block number there means 1970
//      — silent for insiders, fatal for anyone syncing from genesis. And a
//      timestamp too close leaves no room to restart every node in lockstep, so
//      the stragglers fork.)
//   3. IS THE INCOMING REGISTRY SOLVENT? (A migration that writes `stakeOf`
//      without moving tokens looks perfect until the last validator tries to
//      withdraw and finds the money was never there.)
//   4. CAN ANYONE EVER JOIN IT AFTERWARDS? (A registry whose eligible pool is
//      below its own floor can never `rotate()` again: the set is frozen, entry
//      and exit are over, and the chain keeps producing blocks while quietly
//      ceasing to be permissionless — the one property this whole project is for.)
//
// Pure `.mjs`, no imports beyond the sibling predicate, no RPC: the caller fetches
// the state and hands it in (the arrangement of relayer-gas.mjs, settle-policy.mjs
// and validator-set-health.mjs). The preflight script that reads a real chain is
// `scripts/swap-preflight.mjs`.

import { assessSetLiveness, qbftQuorum } from './validator-set-health.mjs'

/**
 * The earliest value we will believe is a unix timestamp rather than a block
 * number. 2020-09-13. Chain 8470's heads are in the tens of thousands and no
 * plausible block number reaches ten digits, so this separates the two
 * interpretations with a decade of margin in both directions.
 */
export const MIN_PLAUSIBLE_TIMESTAMP = 1_600_000_000

/**
 * How much warning every node needs before the transition, by default.
 *
 * ⚠️ This is a lockstep requirement, not a convenience. A node still reading the
 * OLD registry after its peers have switched computes a different validator set,
 * rejects their blocks and forks — so the window has to cover editing and
 * restarting every node, including the ones an operator does not control. 10
 * minutes is ~300 blocks at 2s; `switch-to-contract-mode.sh` used ~200 and that
 * was for four nodes on one machine.
 */
export const MIN_TRANSITION_LEAD_S = 600

/**
 * Is the transition key one Besu will read the way we mean it, at a time we can
 * actually be ready for?
 *
 * @param {unknown} key  the value written to `transitions.qbft[].block`
 * @param {{ nowSec: number, minLeadS?: number, timeBasedFork?: boolean,
 *          nowBlock?: number, blockPeriodS?: number }} opts
 *   timeBasedFork — whether a `*Time` hardfork precedes it in the genesis
 *   (`shanghaiTime` for us). When it does, Besu reads this field as a TIMESTAMP
 *   regardless of intent. Defaults true, because that is 8470's configuration and
 *   the safe default for a check is the one that refuses a block number.
 *   nowBlock/blockPeriodS — only for the block-number reading, where the lead has
 *   to be measured in BLOCKS and then converted. Comparing a block number against
 *   a wall clock is how a "600s lead" check reads a perfectly good key as 1.8
 *   billion seconds in the past.
 * @returns {{ ok: boolean, reason: string | null, leadS: number | null }}
 */
export function assessTransitionKey(key, opts) {
  const nowSec = Math.floor(Number(opts?.nowSec) || 0)
  const minLeadS = opts?.minLeadS ?? MIN_TRANSITION_LEAD_S
  const timeBasedFork = opts?.timeBasedFork ?? true

  const n = Number(key)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, leadS: null, reason: `transition key ${JSON.stringify(key)} is not a positive integer` }
  }
  // The c7 bug, refused by shape. A ten-digit-looking number is the only form
  // besu will interpret as the moment we mean; a block number here is read as a
  // 1970 timestamp, i.e. "contract mode from block 1", which is invisible to every
  // node that already holds those blocks and fatal to every future joiner.
  if (timeBasedFork && n < MIN_PLAUSIBLE_TIMESTAMP) {
    return {
      ok: false, leadS: null,
      reason: `transition key ${n} looks like a BLOCK NUMBER, but a time-based hardfork (e.g. shanghaiTime) precedes it, so besu reads this field as a unix TIMESTAMP — ${n} means 1970, i.e. the new registry applies from block 1. Nodes holding those blocks never notice; anyone syncing from genesis is refused at block 1 and stalls forever`,
    }
  }
  // A key besu reads as a BLOCK NUMBER must be judged against the head, not the
  // clock. The units are the trap: `key - nowSec` on a block number is ~1.8
  // billion seconds "in the past", so the wrong reading here produces a confident
  // refusal of a correct key — and, on a genesis that later gains `shanghaiTime`,
  // a confident acceptance of a fatal one.
  if (!timeBasedFork) {
    const nowBlock = Math.floor(Number(opts?.nowBlock))
    const periodS = Math.floor(Number(opts?.blockPeriodS)) || 2
    if (!Number.isFinite(nowBlock) || nowBlock <= 0) {
      return {
        ok: false, leadS: null,
        reason: `transition key ${n} is a BLOCK NUMBER (no time-based hardfork precedes it) but no nowBlock was supplied, so the lead cannot be measured — an irreversible swap must not be scheduled against an unknown head`,
      }
    }
    const leadBlocks = n - nowBlock
    const leadS = leadBlocks * periodS
    if (leadBlocks <= 0) {
      return { ok: false, leadS, reason: `transition block ${n} is ${-leadBlocks} block(s) BEHIND the head (${nowBlock}) — nodes adopt the new registry the moment they restart, so nodes restarted at different times disagree about the validator set and fork` }
    }
    if (leadS < minLeadS) {
      return { ok: false, leadS, reason: `only ${leadBlocks} block(s) (~${leadS}s at ${periodS}s/block) until the transition; ${minLeadS}s is the minimum — every node must carry the same transition BEFORE it fires, and a node still reading the old registry rejects its peers' blocks and forks` }
    }
    return { ok: true, leadS, reason: null }
  }
  const leadS = n - nowSec
  if (leadS <= 0) {
    return {
      ok: false, leadS,
      reason: `transition timestamp ${n} is ${-leadS}s in the PAST — every node adopts the new registry the instant it restarts, so nodes restarted at different times disagree about the validator set and fork`,
    }
  }
  if (leadS < minLeadS) {
    return {
      ok: false, leadS,
      reason: `only ${leadS}s until the transition; ${minLeadS}s is the minimum — every node must carry the same transition BEFORE it fires, and a node still reading the old registry rejects its peers' blocks and forks`,
    }
  }
  return { ok: true, leadS, reason: null }
}

/**
 * Does the incoming registry actually hold the money it says people have posted?
 *
 * A stake migration is two halves — a token transfer and a bookkeeping entry —
 * and nothing on-chain couples them. A registry credited with stake it never
 * received passes every eligibility, rotation and seating test, because none of
 * those touch the token: the fraud surfaces only when someone unstakes, and then
 * it surfaces as the LAST withdrawers' transactions reverting, for what looks like
 * their own fault.
 *
 * ⚠️ Forfeited stake counts as an obligation. `forfeit()` zeroes a convict's
 * balance and tallies it in `forfeitedTotal` without moving any token — the header
 * of TinyValidatorsSlashable is explicit that forfeited stake stays LOCKED in the
 * contract forever rather than being burned or paid to anyone. So the tokens
 * backing it must still be there; treating forfeited as spendable headroom would
 * make a solvent-looking registry that has quietly promised the same dollar twice.
 *
 * @param {{ balanceMicro: bigint|number|string, recordedStakeMicro: bigint|number|string, forfeitedMicro?: bigint|number|string }} s
 * @returns {{ ok: boolean, reason: string | null, deficitMicro: bigint }}
 */
export function assessRegistrySolvency(s) {
  const big = (v) => {
    try {
      const b = typeof v === 'bigint' ? v : BigInt(String(v ?? 0).split('.')[0])
      return b < 0n ? 0n : b
    } catch {
      return 0n
    }
  }
  const balance = big(s?.balanceMicro)
  const recorded = big(s?.recordedStakeMicro)
  const forfeited = big(s?.forfeitedMicro)
  const owed = recorded + forfeited
  const deficitMicro = owed > balance ? owed - balance : 0n
  if (deficitMicro > 0n) {
    return {
      ok: false, deficitMicro,
      reason: `the registry owes ${owed} micro (${recorded} staked + ${forfeited} forfeited-and-locked) but holds only ${balance} — a ${deficitMicro} micro shortfall. Every seating and rotation check still passes; the failure lands on whoever unstakes LAST, as their own transaction reverting`,
    }
  }
  return { ok: true, deficitMicro: 0n, reason: null }
}

/**
 * After the swap, can anybody still get in or out?
 *
 * `rotate()` is the only path by which a registry's set ever changes, and it
 * refuses when the eligible pool is below `minValidators` (the floor that exists
 * because a rotation which seats too few hands the chain to a group with no fault
 * tolerance). A registry that arrives already below its own floor therefore has a
 * PERMANENT set: blocks keep coming, every health check stays green, and entry and
 * exit are silently over. That is the one failure mode that does not look like a
 * failure — the chain works perfectly and has stopped being the thing it is for.
 *
 * @param {{ eligibleCount: number, minValidators: number, candidateCount?: number }} r
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function assessRegistryOpenness(r) {
  const eligible = Math.floor(Number(r?.eligibleCount) || 0)
  const floor = Math.floor(Number(r?.minValidators) || 0)
  if (floor <= 0) {
    return { ok: false, reason: `incoming registry reports minValidators ${JSON.stringify(r?.minValidators)} — a floor of zero would let rotate() seat an empty set, which halts besu` }
  }
  if (eligible < floor) {
    return {
      ok: false,
      reason: `only ${eligible} eligible candidate(s) against a floor of ${floor}: every rotate() reverts BelowValidatorFloor, so the seated set is FROZEN FOREVER once this registry is authoritative — nobody can join, nobody can leave, and the chain keeps producing blocks the whole time it is no longer permissionless`,
    }
  }
  return { ok: true, reason: null }
}

/**
 * Does the incoming registry's COURT still describe the incoming registry?
 *
 * ⚠️⚠️ THE c24 FINDING, probed on the live 8470 before this was written. Both the
 * outgoing and incoming registries name the SAME court (`TinySlashing`
 * 0x2b0d36fa…), and `courtHealthy()` returns **true** on both — which is what made
 * this invisible. But `TinySlashing.validators` is `immutable`, set at construction
 * to the OUTGOING registry, and a swap cannot move it:
 *
 *     swap target 0xb2ff9d5e….court()      → 0x2b0d36fa…   ✅ the real court
 *     0x2b0d36fa….validators()             → 0x0165878a…   ⚠️ the OUTGOING registry
 *
 * 🔑 THE ASYMMETRY IS THE WHOLE POINT, because it is why nothing catches this:
 *
 *   - **Exclusion keeps working.** `_convicted()` calls `isEquivocator(v)`, which
 *     reads `convictions[v].provenAtBlock` — a mapping keyed by ADDRESS, with no
 *     registry term in it. So `rotate()` on the incoming registry still refuses to
 *     seat a convict, and `forfeit()` still burns the incoming registry's own
 *     `stakeOf`. Consensus enforcement survives the swap intact.
 *   - **The VERDICT does not.** `submitEquivocation` records
 *     `stakeAtConviction: validators.stakeOf(accused)` and
 *     `seatedAtConviction: validators.isActive(accused)` through that immutable
 *     pointer. After the swap those two fields describe a contract nobody consults
 *     any more. Measured on the real chain, for a validator seated in both:
 *     the incoming registry holds 1000 units and the court would record 2000; for
 *     `0x5CbDd86a…`, which holds NOTHING in the incoming registry and loses its
 *     seat at the transition, the court would record 2500 units and `seated: true`.
 *
 * So a post-swap conviction produces a verdict that is wrong in the direction that
 * flatters the accused, and `stakeAtConviction` is precisely the field that says how
 * much SHOULD have been burned — the number `slashing-e2e` asserts as "the missing
 * enforcement, on the record", and the one `lib/chain/calldata.ts` decodes for the
 * explorer. Whoever later builds burning on top of it inherits a stale number.
 *
 * 🔑 THE LENS, and it generalizes past this contract: **`courtHealthy()` ASKS
 * WHETHER THE COURT ANSWERS, NOT WHETHER IT IS ANSWERING ABOUT US.** A liveness
 * probe on a collaborator is not an identity check on it, and the existing warning
 * fires only when the court goes silent — the loud failure. This is the quiet one:
 * the court answers every time, promptly, about the wrong registry. Two contracts
 * pointing at each other is a CYCLE that has to be closed at BOTH ends, and only
 * one end of it was ever checked.
 *
 * A warning, not a blocker: losing verdict accuracy is strictly better than halting
 * the chain, and it is fixable after the swap by deploying a fresh court and a
 * registry that names it. Refusing here would trade a real halt for a bookkeeping
 * defect, which is the trade c17 got wrong in the other direction.
 *
 * @param {{ court?: string, courtValidators?: string, incoming?: string, outgoing?: string }} r
 *   courtValidators — what `court.validators()` returns, i.e. the registry the court
 *   will describe in every verdict it records from now on. `undefined` means the
 *   caller could not read it, which must NOT read as agreement.
 * @returns {{ ok: boolean, unknown: boolean, reason: string | null }}
 */
export function assessCourtBinding(r) {
  const norm = (a) => (typeof a === 'string' ? a.trim().toLowerCase() : '')
  const court = norm(r?.court)
  const bound = norm(r?.courtValidators)
  const incoming = norm(r?.incoming)
  const outgoing = norm(r?.outgoing)

  // No court at all is the plain-TinyValidators case: there is no binding to check
  // and no enforcement to lose. Silence here, or every swap of a non-slashable
  // registry inherits a warning about a contract it does not have.
  if (!court || /^0x0{40}$/.test(court)) return { ok: true, unknown: false, reason: null }
  if (!incoming) {
    return { ok: true, unknown: true, reason: 'cannot check the court binding: no incoming registry address given' }
  }
  // Unreadable is NOT agreement. A caller that never asked, and a court whose
  // `validators()` reverted, both land here — and reading either as "fine" would
  // turn the check off exactly when the contract is unexpected.
  if (!bound) {
    return {
      ok: true,
      unknown: true,
      reason: `could not read validators() on the court ${r?.court} — so it is UNKNOWN whether its verdicts will describe the incoming registry. courtHealthy() only proves the court answers, not that it answers about us`,
    }
  }
  if (bound === incoming) return { ok: true, unknown: false, reason: null }

  const which = bound === outgoing
    ? 'the OUTGOING registry — the one this swap is retiring'
    : 'a THIRD registry that is neither the incoming nor the outgoing one'
  return {
    ok: false,
    unknown: false,
    reason: `the incoming registry's court ${r?.court} has validators() = ${r?.courtValidators}, which is ${which}. TinySlashing.validators is immutable, so the swap cannot move it. Exclusion still works (isEquivocator() is keyed by address, so rotate() keeps refusing convicts and forfeit() burns the incoming registry's own stakeOf), but every verdict recorded after the swap will read stakeAtConviction and seatedAtConviction off the retired contract — the field that says how much SHOULD have been burned, describing balances nothing consults any more. courtHealthy() cannot see this: it asks whether the court answers, not whether it answers about us`,
  }
}

/**
 * Is the remediation we are about to advise ARITHMETICALLY POSSIBLE?
 *
 * ⚠️⚠️ THE c18 FINDING, and the reason this function exists: the advice c17 shipped
 * — "stake the live validators into the incoming registry, then rotate() it" —
 * CANNOT WORK ON THE REGISTRY IT WAS AIMED AT. Probed against the real 8470:
 * 5 live proposers, 8 eligible ghosts, and the advice is unreachable by a factor
 * of three.
 *
 * The reason is that `rotate()` seats EVERY eligible candidate up to
 * `maxValidators` — it is not a top-N by stake, stake only breaks the ordering
 * when the cap forces a choice. So staking a live validator does not take a seat
 * from a ghost; it ADDS a seat, and quorum is `ceil(2n/3)`, which grows by 2 for
 * every 3 seats added. Chasing quorum by adding validators is chasing a target
 * that runs at two thirds your speed:
 *
 *     seats = min(live + ghosts, maxValidators),  commit ⟺ live ≥ ceil(2·seats/3)
 *     under the cap this reduces to:  live ≥ 2 × ghosts
 *
 * 8 ghosts therefore demand 16 live validators. We have 5, and no amount of
 * staking, stake-weighting or rotating changes that — 13 eligible is already more
 * than the 7 seats 5 live validators can carry.
 *
 * 🔑 THE LESSON, which generalizes past this contract: **A REMEDIATION IS A CLAIM
 * ABOUT THE FUTURE, AND IT NEEDS A CHECK OF ITS OWN.** The blocker c17 shipped was
 * correct, verified, and mutation-tested; the fix printed underneath it had never
 * been evaluated against the arithmetic of the very mechanism it invoked. A
 * refusal that hands the operator an impossible instruction is worse than one that
 * hands them none, because they will spend the cycle executing it — and every step
 * of it succeeds. Staking works. `rotate()` works. The chain halts anyway.
 *
 * And the escape hatches are closed, which is why this returns a verdict rather
 * than a suggestion:
 *   • Ghosts cannot be evicted. `requestExit()` and `unstake()` are `msg.sender`
 *     only, and these ghosts are leftover joiners from the slashable registry's own
 *     acceptance suite — nobody holds their keys. There is no admin path, by design.
 *   • They cannot be convicted either: equivocation evidence needs two signatures
 *     from the same address, and an address that never proposed a block has none.
 *   • Outbidding them past `maxValidators` does not help. Seats displaced by
 *     higher-staked candidates are only worth having if the newcomers are LIVE, and
 *     if we had that many live validators we would not be here.
 *
 * So the only executable path is to stop trying to rescue the instance: deploy a
 * FRESH registry seeded with the live set (`deploy-validators-slashable.mjs`
 * already reads the seated set off the chain rather than off the deployment file)
 * and stake into that. This function's job is to say so before an operator spends a
 * day on the alternative.
 *
 * @param {{ liveCount: number, ghostCount: number, maxValidators: number }} r
 *   liveCount — validators demonstrably producing blocks, i.e. the most that could
 *   ever be made eligible. The OPTIMISTIC bound on purpose: if the best case
 *   cannot commit, the refusal is certain rather than merely likely.
 *   ghostCount — eligible candidates in the incoming registry that are NOT live.
 *   Every one of them takes a seat at the next rotation and signs nothing.
 * @returns {{ reachable: boolean, minSeats: number, quorum: number,
 *             liveNeeded: number | null, capContested: boolean,
 *             caveat: string | null, reason: string | null }}
 *   caveat — set on a REACHABLE verdict when the seat cap forces rotate() to choose
 *   by stake. Arithmetic-reachable is not seat-reachable, and a condition reported
 *   only alongside a refusal is one nobody acts on.
 */
export function assessSwapReachability(r) {
  const live = Math.max(0, Math.floor(Number(r?.liveCount) || 0))
  const ghosts = Math.max(0, Math.floor(Number(r?.ghostCount) || 0))
  const maxV = Math.max(1, Math.floor(Number(r?.maxValidators) || 1))

  // The smallest seated set any rotation can produce. Not `live` — every eligible
  // ghost is seated too, and they cannot be made ineligible from outside.
  const minSeats = Math.min(live + ghosts, maxV)
  const quorum = qbftQuorum(minSeats)

  // How many live validators would be enough — SEARCHED, not solved.
  //
  // ⚠️ The closed form `live ≥ 2 × ghosts` is only the sub-cap rule, and quoting it
  // at the cap OVERSTATES the requirement: with 8 ghosts and maxValidators 21 the
  // real answer is 14, not 16, because seats stop growing at 21 while quorum stops
  // at 14. An operator told "you need 16" when 14 suffices has been handed a
  // different wrong number than c17 handed them, so this searches for the smallest
  // count that actually satisfies the inequality.
  //
  // ⚠️ But the cap's discount is CONDITIONAL and the caller must be told so: once
  // live + ghosts exceeds maxValidators, rotate() has to choose, and it chooses by
  // STAKE. Being one of 26 eligible for 21 seats is not a seat. So the discount is
  // only real if the live validators outstake every ghost — see `capContested`.
  let liveNeeded = null
  for (let L = live; L <= maxV + 2 * ghosts + 1; L++) {
    if (L >= qbftQuorum(Math.min(L + ghosts, maxV))) { liveNeeded = L; break }
  }
  const capContested = liveNeeded !== null && liveNeeded + ghosts > maxV

  if (live === 0) {
    return {
      reachable: false, minSeats, quorum, liveNeeded, capContested, caveat: null,
      reason: 'no validator is demonstrably producing blocks, so there is nothing to stake INTO the incoming registry — the shortfall is not a migration gap and no rotation fixes it',
    }
  }
  if (live >= quorum) {
    // ⚠️ Reachable by ARITHMETIC is not the same as reachable in fact, and this is
    // the one place the two come apart: once live + ghosts exceeds the seat cap,
    // rotate() must choose, and it chooses by STAKE. The numbers can work while the
    // live validators lose the seats to richer ghosts. So the caveat rides along
    // with a green verdict rather than being reported only on refusals — a
    // condition attached to advice is worthless if it is printed only when the
    // advice is already withdrawn.
    const caveat = live + ghosts > maxV
      ? `${live} live + ${ghosts} ghost(s) exceeds the ${maxV}-seat cap, so rotate() picks by STAKE — stake the live validators ABOVE every ghost or they will be eligible without being seated`
      : null
    return { reachable: true, minSeats, quorum, liveNeeded, capContested, caveat, reason: null }
  }

  const needMore = liveNeeded === null
    ? `no number of live validators satisfies it while ${ghosts} ghost(s) stay eligible`
    : `you would need ${liveNeeded} live validator(s)${capContested ? `, and even then only if they OUTSTAKE every ghost — at ${liveNeeded}+${ghosts} eligible for ${maxV} seats rotate() picks by stake, so being eligible is not being seated` : ' (under the seat cap the rule is live ≥ 2 × ghosts)'}`
  return {
    reachable: false, minSeats, quorum, liveNeeded, capContested, caveat: null,
    reason: `staking and rotating CANNOT reach quorum on this registry: rotate() seats EVERY eligible candidate (up to maxValidators ${maxV}) rather than a top-N, so the ${ghosts} eligible ghost(s) keep their seats and the best case is ${minSeats} seats needing ${quorum} signatures from ${live} live validator(s). Adding validators ADDS seats and quorum grows by 2 per 3 seats, so ${needMore}. The ghosts cannot be removed either: requestExit()/unstake() are msg.sender-only and nobody holds their keys, and they cannot be convicted because equivocation evidence needs two signatures from an address that has never signed a block`,
  }
}

/**
 * The whole verdict. Refuses unless every question above is answered and green.
 *
 * ⚠️ `unknown` is NOT ok. The evidence window can be too short to tell a silent
 * validator from one waiting its turn (c15's rule), and for an irreversible
 * operation "we could not tell" must read as a refusal. Elsewhere in this codebase
 * declining to answer is the cautious branch; here the cautious branch is to
 * decline to ACT.
 *
 * @param {{
 *   incomingSeats: ReadonlyArray<string>,
 *   outgoingSeats?: ReadonlyArray<string>,
 *   proposers: ReadonlyArray<string>,
 *   window: number,
 *   transitionKey: unknown,
 *   nowSec: number,
 *   solvency: object,
 *   openness: object,
 *   bounds?: { min?: number, max?: number },
 *   minLeadS?: number,
 *   timeBasedFork?: boolean,
 *   courtHealthy?: boolean,
 *   court?: string,
 *   courtValidators?: string,
 *   incomingEligibleGhosts?: number,
 *   incomingLabel?: string,
 *   outgoingLabel?: string,
 * }} input
 *   incomingEligibleGhosts — ELIGIBLE candidates of the incoming registry that are
 *   not demonstrably live. This, not the seat count, is what decides whether the
 *   stake-and-rotate remediation can ever reach quorum, because the next rotate()
 *   seats all of them. Omitting it falls back to the seated ghosts (a floor).
 * @returns {{ ok: boolean, unknown: boolean, blockers: string[], warnings: string[],
 *            liveness: { ok: boolean, unknown: boolean, seats: number, live: number,
 *                        quorum: number, margin: number, silent: string[], reason: string | null },
 *            reach: { reachable: boolean, minSeats: number, quorum: number,
 *                     liveNeeded: number | null, capContested: boolean,
 *                     caveat: string | null, reason: string | null },
 *            remediation: string[],
 *            courtBinding: { ok: boolean, unknown: boolean, reason: string | null },
 *            summary: string }}
 */
export function assessRegistrySwap(input) {
  const blockers = []
  const warnings = []
  const remediation = []

  const incoming = Array.isArray(input?.incomingSeats) ? input.incomingSeats : []
  const outgoing = Array.isArray(input?.outgoingSeats) ? input.outgoingSeats : []

  // 1. THE HALT QUESTION — the existing predicate, aimed at the incoming set.
  const liveness = assessSetLiveness(incoming, input?.proposers ?? [], { window: input?.window })
  if (!liveness.ok) {
    blockers.push(
      liveness.unknown
        ? `cannot judge the incoming set's liveness: ${liveness.reason}. An irreversible swap on unreadable evidence is a coin flip`
        : `THE INCOMING SET CANNOT COMMIT BLOCKS AFTER THE SWAP — ${liveness.reason}`,
    )
  }

  // The remediation is the part that has to be true, not just alarming. Seats are
  // awarded by STAKE and rotate() is permissionless, so the fix is to make the
  // live validators eligible in the INCOMING registry and rotate it BEFORE the
  // transition — while the outgoing registry is still the one keeping the chain
  // alive. Doing it in the other order is the halt.
  const seatSet = new Set(incoming.map((s) => String(s).toLowerCase()))
  const seenProposers = new Set((input?.proposers ?? []).map((p) => String(p).toLowerCase()))
  const liveButUnseated = [...seenProposers].filter((p) => !seatSet.has(p))

  // ⚠️⚠️ c18: BEFORE advising the stake-and-rotate fix, check that it can work.
  // c17's advice was unreachable on the very registry it was aimed at (5 live vs 8
  // eligible ghosts), and every step of executing it succeeds while the chain halts
  // anyway. `ghostCount` counts ELIGIBLE non-live candidates, because eligibility is
  // what rotate() seats on — a candidate with no stake takes no seat and costs
  // nothing. When the caller cannot supply it we fall back to the seated ghosts,
  // which is the floor of the real number, so the check stays conservative.
  const ghostCount = Number.isFinite(Number(input?.incomingEligibleGhosts))
    ? Math.floor(Number(input.incomingEligibleGhosts))
    : incoming.filter((s) => !seenProposers.has(String(s).toLowerCase())).length
  const reach = assessSwapReachability({
    liveCount: seenProposers.size,
    ghostCount,
    maxValidators: input?.openness?.maxValidators ?? input?.bounds?.max ?? 21,
  })

  if (!liveness.ok && !liveness.unknown) {
    // ⚠️ ORDER MATTERS, and getting it wrong was c18's own first mistake: the
    // reachability check must not speak until we know the shortfall is a MIGRATION
    // GAP at all. When every live proposer is already seated by the incoming
    // registry, no registry manoeuvre of any kind helps — not staking, not
    // rotating, and not a fresh deploy either, because a new instance seeded from
    // the live set would seat the same too-few validators. That case needs NODES,
    // and telling an operator to redeploy would send them to build a second
    // identical dead end. Distinguish first, then advise.
    if (!liveButUnseated.length) {
      remediation.push('no live proposer is missing from the incoming set, so the shortfall is not a migration gap — get more validators running before swapping; a different registry cannot conjure signers')
    } else if (!reach.reachable) {
      // The impossible advice is REPLACED, not annotated. An operator reading a
      // list does the first thing on it.
      remediation.push(`the stake-and-rotate fix is NOT AVAILABLE here — ${reach.reason}`)
      remediation.push(
        `deploy a FRESH registry seeded with the live set instead: deploy-validators-slashable.mjs reads the seated set off the chain (not off the deployment file), so a new instance is born seating exactly the validators that are producing blocks. The ghost-laden instance ${input?.incomingLabel ? `(${input.incomingLabel}) ` : ''}cannot be rescued and must not be swapped to`,
      )
      // ⚠️ AND THE SAME LESSON ONE LEVEL DOWN — this advice is also a claim about
      // the future, so it gets the same scrutiny. The constructor seats its initial
      // validators as candidates with ZERO stake (it never writes stakeOf), so a
      // fresh registry is born with eligibleCount 0, below its own floor: the
      // openness blocker fires and no rotate() can ever succeed. That is caught on
      // the next run rather than in production, but an operator who has to discover
      // it by re-running has been handed a two-thirds answer.
      remediation.push(
        'then stake the live validators INTO the fresh registry before re-running: the constructor seats them as candidates with zero stake (it never writes stakeOf), so a new instance starts with eligibleCount 0 — below its own floor, where every rotate() reverts BelowValidatorFloor. With no ghosts in it, staking is finally the fix that works',
      )
      // ⚠️ c19: and "stake them" is not free either — the stake already posted is
      // trapped behind StillSeated(), mint() belongs to TinyIssuance since P3, and
      // some live validators hold zero balance, so stake() reverts inside
      // transferFrom with a message that hides all three. Point at the planner
      // rather than let that be discovered as a revert mid-migration.
      remediation.push(
        'plan that staking with `node chain/multinode/scripts/stake-migration-plan.mjs --incoming <new>` FIRST — it checks whether the money exists at all (stake in the outgoing registry is trapped behind StillSeated(), mint() is gone to TinyIssuance) and checks the two moments that have different seat sets: the transition (constructor set) and the first rotate() (eligible candidates)',
      )
      remediation.push('re-run this preflight against the fresh registry with --incoming before touching the genesis')
    } else {
      remediation.push(
        `stake the ${liveButUnseated.length} live validator(s) that the incoming registry does NOT seat (${liveButUnseated.slice(0, 4).join(', ')}${liveButUnseated.length > 4 ? `, +${liveButUnseated.length - 4}` : ''}) into the incoming registry, then call its rotate() and re-run this preflight — all of it BEFORE writing the transition, while the outgoing registry is still authoritative`,
      )
      // The condition under which that advice still fails on its last step.
      if (reach.caveat) remediation.push(`⚠️ ${reach.caveat}`)
    }
    remediation.push('do NOT write the transition until this check passes: after it fires, rotate() needs a quorum that will not exist')
  }

  // 2. THE TRANSITION KEY.
  const key = assessTransitionKey(input?.transitionKey, {
    nowSec: input?.nowSec,
    minLeadS: input?.minLeadS,
    timeBasedFork: input?.timeBasedFork,
  })
  if (!key.ok) blockers.push(key.reason)

  // 3. SOLVENCY.
  const solvency = assessRegistrySolvency(input?.solvency ?? {})
  if (!solvency.ok) blockers.push(solvency.reason)

  // 4. STILL PERMISSIONLESS AFTERWARDS.
  const openness = assessRegistryOpenness(input?.openness ?? {})
  if (!openness.ok) blockers.push(openness.reason)

  // Warnings — real, and none of them a reason to refuse. A swap that loses
  // enforcement is worse than one that keeps it and better than a halt.
  if (input?.courtHealthy === false) {
    warnings.push('the incoming registry\'s court does not answer: _convicted() FAILS OPEN by design, so the chain would be seated by a registry whose convictions do not bite — visible only via courtHealthy()')
  }
  // …and the quiet twin of that check: the court answers fine, about the wrong
  // registry. courtHealthy() is satisfied either way, which is why this is separate.
  const courtBinding = assessCourtBinding({
    court: input?.court,
    courtValidators: input?.courtValidators,
    incoming: input?.incomingLabel,
    outgoing: input?.outgoingLabel,
  })
  if (courtBinding.reason) warnings.push(courtBinding.reason)
  const outSet = new Set(outgoing.map((s) => String(s).toLowerCase()))
  const dropped = [...outSet].filter((s) => !seatSet.has(s))
  if (dropped.length) {
    warnings.push(`${dropped.length} address(es) seated today are NOT seated by the incoming registry (${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? `, +${dropped.length - 4}` : ''}) — they lose their seats at the transition with no rotation and no notice`)
  }
  // Stake does not travel with authority: it is tokens held by a contract address,
  // and the incoming registry is a different address. An outgoing registry left
  // holding balances is not a bug, but it IS money whose owners can only reach it
  // through a contract nothing points at any more.
  const strandedMicro = (() => {
    try { return BigInt(String(input?.solvency?.outgoingBalanceMicro ?? 0).split('.')[0]) } catch { return 0n }
  })()
  if (strandedMicro > 0n) {
    warnings.push(`the outgoing registry still holds ${strandedMicro} micro of stake; unstake() there keeps working, but nothing points at that contract after the swap, so nobody will think to look`)
  }

  const ok = blockers.length === 0
  const summary = ok
    ? `swap looks survivable: ${liveness.seats} incoming seats, ${liveness.live} demonstrably live, quorum ${liveness.quorum} (margin ${liveness.margin}), transition in ${key.leadS}s`
    : `REFUSE: ${blockers.length} blocker(s). Incoming ${liveness.seats} seats, ${liveness.live} demonstrably live, quorum ${qbftQuorum(liveness.seats)}`
  return { ok, unknown: !!liveness.unknown, blockers, warnings, liveness, reach, remediation, courtBinding, summary }
}
