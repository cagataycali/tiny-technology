// ⚖️ MAY THIS SEAT BE TAKEN FOR ABSENCE? — the decision the on-chain attendance
// record must NOT be allowed to make on its own.
//
// `TinyValidatorAttendance` records who proved they produced blocks. This file
// answers the separate question of when that record is strong enough to act on.
// The two are apart for the same reason c15 split `assessValidatorSet` from
// `assessSetLiveness`: one is a fact about a set, the other needs judgement about
// the world, and folding them together means either lying or refusing to answer.
//
// ┌ THE FAILURE THIS FILE EXISTS TO PREVENT ────────────────────────────────────┐
// │ Enforcing a liveness rule is the most dangerous thing this chain can do to   │
// │ itself, because every other rule here REFUSES in its failure mode and this   │
// │ one ACTS. rotate() below the floor reverts and the old set keeps validating; │
// │ a broken court fails open and convictions stop mattering. An eviction rule   │
// │ that misfires does the opposite: it removes working validators, and it does  │
// │ so precisely when evidence is scarce — during the network trouble that made  │
// │ them look silent. The rule is at its most confident exactly when it is most  │
// │ likely to be wrong.                                                          │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// 🔑 So THREE independent gates must all hold, and each one blocks a different
// way of being wrong. Any one of them alone is exploitable or catastrophic:
//
//   1. PARTICIPATION — the record must be in use by most of the set. Absence in a
//      network where nobody attests means "nobody attests", not "this validator is
//      dead". Enforcing at participation 0 convicts the entire honest set in one
//      epoch. This is not hypothetical: the devnet's participation was 1 of 6 the
//      day attendance shipped, and `TinyIssuance.creditBlock()` — the same shape of
//      opt-in record — has sat at ZERO calls for 8,000 blocks.
//   2. STREAK — one empty epoch is weak evidence. With epochBlocks=20 and 6 seats a
//      validator gets ~3 turns per epoch, so an unlucky tx-pool moment or a 30s
//      network blip can legitimately cost one. A streak demands a pattern.
//   3. MARGIN — removing a seat must leave the REMAINING set able to commit. This is
//      the one that turns a good rule into a dead chain: evicting the fifth of six
//      seats moves quorum from 4 to 4 while live validators drop, and a rule that
//      evicts its way below quorum has done more damage than the absent seat ever
//      could. c15's lesson, in the other direction: seats are not free, and neither
//      are evictions.
//
// ⚠️ AND THE RULE IS DELIBERATELY NOT SYMMETRIC WITH SLASHING. A convicted
// equivocator loses stake, because equivocation is objectively provable from two
// signatures. Absence is NOT provable — it is an absence of evidence, which is why
// this file exists at all, and why the sanction it authorises is losing a SEAT and
// never losing STAKE. Confusing "we cannot see you" with "you cheated" would let a
// network partition fine honest validators, and a fine for being unreachable is a
// fine for having a worse ISP than us.
//
// Plain `.mjs`, no imports, no RPC: the caller fetches the record and hands it in
// (same arrangement as validator-set-health.mjs, relayer-gas.mjs, settle-policy.mjs).

/**
 * Minimum fraction of seats that must have attested in the judged epoch, in
 * basis points, before ANY absence verdict may be acted on.
 *
 * 6667 = two-thirds, chosen to match QBFT's own quorum shape rather than picked
 * for feel: below two-thirds participation the attesting population is not even a
 * majority the chain would trust to commit a block, so it is not a population
 * whose silence should cost anyone a seat.
 */
export const MIN_PARTICIPATION_BPS = 6667

/**
 * Consecutive absent epochs required. 3 epochs at epochBlocks=20 and ~2.8s blocks
 * is ~2.8 minutes of sustained non-production — long enough that a blip does not
 * qualify, short enough that an abandoned seat does not sit through a whole day of
 * degraded tolerance.
 */
export const MIN_ABSENT_STREAK = 3

const BPS = 10_000

/** ceil(2n/3) — pinned from the shipped besu jar. Mirrors validator-set-health.mjs. */
function quorumOf(seats) {
  const n = Number.isFinite(seats) && seats > 0 ? Math.floor(seats) : 0
  return Math.ceil((2 * n) / 3)
}

const norm = (a) => String(a).toLowerCase()

/**
 * May `candidate` be unseated for absence?
 *
 * Returns a decision object rather than a boolean, because "no" has several
 * distinct reasons and an operator (or a future enforcing contract) has to be able
 * to tell "the evidence is too weak" from "the evidence is strong but evicting
 * would halt the chain". Collapsing them into false would hide the second, which
 * is the dangerous one.
 *
 * @param {object} input
 * @param {string} input.candidate            the seat being judged
 * @param {ReadonlyArray<string>} input.seats the current seated set (`getValidators()`)
 * @param {number} input.absentStreak         consecutive finished absent epochs
 * @param {boolean} [input.streakAtCap]       the record's lookback ran out (see MAX_LOOKBACK)
 * @param {number} input.participation        distinct attestors in the judged epoch
 * @param {ReadonlyArray<string>} [input.liveSeats]
 *   seats known to be producing blocks from an INDEPENDENT source (block miners),
 *   used for the margin check. Absent ⇒ margin cannot be evaluated and the answer
 *   is no. A rule that skips the margin check when data is missing is a rule that
 *   evicts hardest during an outage.
 * @param {{ minStreak?: number, minParticipationBps?: number }} [opts]
 * @returns {{ mayEvict: boolean, reason: string,
 *             gates: { participation: boolean, streak: boolean, margin: boolean },
 *             participationBps: number, quorumAfter: number, liveAfter: number }}
 */
export function mayEvictForAbsence(input, opts = {}) {
  const minStreak = opts.minStreak ?? MIN_ABSENT_STREAK
  const minBps = opts.minParticipationBps ?? MIN_PARTICIPATION_BPS

  const seats = Array.isArray(input?.seats) ? [...new Set(input.seats.map(norm))] : []
  const candidate = input?.candidate ? norm(input.candidate) : null
  const streak = Number(input?.absentStreak)
  const participation = Number(input?.participation)
  const gates = { participation: false, streak: false, margin: false }

  const deny = (reason) => ({
    mayEvict: false, reason, gates,
    participationBps: seats.length > 0 && Number.isFinite(participation)
      ? Math.floor((Math.max(0, participation) * BPS) / seats.length) : 0,
    quorumAfter: quorumOf(Math.max(0, seats.length - 1)),
    liveAfter: 0,
  })

  if (!candidate) return deny('no candidate given')
  if (seats.length === 0) return deny('no seated set given — nothing to judge against')
  // Judging an address that is not seated is a category error, not a "no": there is
  // no seat to take, and answering "not evictable" would read as a verdict about
  // its conduct.
  if (!seats.includes(candidate)) return deny(`${candidate} is not seated — nothing to evict`)

  // ── gate 1: is the record in use at all? ──────────────────────────────────
  const participationBps = Number.isFinite(participation)
    ? Math.floor((Math.max(0, participation) * BPS) / seats.length)
    : 0
  gates.participation = participationBps >= minBps
  if (!gates.participation) {
    return {
      ...deny(
        `participation is ${participation}/${seats.length} seats (${(participationBps / 100).toFixed(1)}%, `
        + `need ${(minBps / 100).toFixed(1)}%) — an absent record here means NOBODY ATTESTS, not that this `
        + 'validator is dead. Enforcing would convict the honest set.',
      ),
      participationBps,
    }
  }

  // ── gate 2: is one epoch of silence a pattern? ────────────────────────────
  // `streakAtCap` is accepted and NOT treated as a shortfall: a capped streak is
  // longer than the record can express, which is more evidence, not less.
  gates.streak = Number.isFinite(streak) && streak >= minStreak
  if (!gates.streak) {
    return {
      ...deny(
        `absent for ${Number.isFinite(streak) ? streak : 0} consecutive epoch(s), need ${minStreak} — `
        + 'one quiet epoch is a blip, not an abandonment',
      ),
      participationBps,
    }
  }

  // ── gate 3: would evicting leave a set that can still commit? ─────────────
  // Evidence about who is live must come from OUTSIDE the attendance record.
  // Reading liveness off the same record the eviction is based on would make the
  // check circular: in an outage where nobody attests, everyone looks dead and the
  // margin check would authorise evicting the whole set.
  if (!Array.isArray(input?.liveSeats)) {
    return {
      ...deny(
        'no independent liveness evidence supplied — the margin check cannot run, and a rule '
        + 'that skips it evicts hardest during exactly the outage that made the seat look absent',
      ),
      participationBps,
    }
  }
  const seatSet = new Set(seats)
  const live = new Set(input.liveSeats.map(norm).filter((a) => seatSet.has(a)))
  // The candidate's own liveness does not count toward the remaining set: it is
  // the one being removed. (And if it IS live, that is a contradiction the caller
  // should resolve — flagged below rather than silently ignored.)
  const liveAfter = [...live].filter((a) => a !== candidate).length
  const quorumAfter = quorumOf(seats.length - 1)
  gates.margin = liveAfter > quorumAfter

  if (live.has(candidate)) {
    return {
      mayEvict: false,
      reason: `${candidate} is PROPOSING BLOCKS according to independent evidence while its attendance `
        + 'record is empty — that is a validator not running an attest loop, not an absent one. Evicting '
        + 'it would remove a working validator.',
      gates: { ...gates, margin: gates.margin },
      participationBps, quorumAfter, liveAfter,
    }
  }

  if (!gates.margin) {
    return {
      mayEvict: false,
      reason: `evicting would leave ${liveAfter} live seat(s) against a quorum of ${quorumAfter} — `
        + (liveAfter < quorumAfter
          ? 'the chain COULD NOT COMMIT BLOCKS. '
          : 'exactly quorum, so one more failure halts the chain. ')
        + 'A liveness rule that evicts its way below quorum has done more damage than the absent seat. '
        + 'Restore margin first (start a node, or seat another honest candidate).',
      gates, participationBps, quorumAfter, liveAfter,
    }
  }

  return {
    mayEvict: true,
    reason: `absent ${streak} consecutive epoch(s) with ${participation}/${seats.length} seats attesting; `
      + `evicting leaves ${liveAfter} live against quorum ${quorumAfter} (margin ${liveAfter - quorumAfter})`,
    gates, participationBps, quorumAfter, liveAfter,
  }
}

/**
 * Is the attendance record trustworthy enough to enforce ON AT ALL, network-wide?
 *
 * Separate from the per-validator decision because it is the question an operator
 * asks before switching enforcement on, and answering it per-validator would mean
 * discovering the answer one wrongful eviction at a time.
 *
 * @param {number} participation  distinct attestors in the judged epoch
 * @param {number} seats          seated count
 * @param {{ minParticipationBps?: number }} [opts]
 * @returns {{ ready: boolean, bps: number, reason: string }}
 */
export function attendanceEnforceable(participation, seats, opts = {}) {
  const minBps = opts.minParticipationBps ?? MIN_PARTICIPATION_BPS
  const s = Number.isFinite(seats) && seats > 0 ? Math.floor(seats) : 0
  const p = Number.isFinite(participation) && participation > 0 ? Math.floor(participation) : 0
  if (s === 0) return { ready: false, bps: 0, reason: 'no seats — nothing to enforce against' }
  const bps = Math.floor((p * BPS) / s)
  if (bps < minBps) {
    return {
      ready: false, bps,
      reason: `${p}/${s} seats attesting (${(bps / 100).toFixed(1)}%) — below the ${(minBps / 100).toFixed(1)}% `
        + 'floor. Enforcing now would evict validators for not running an attest loop. Roll the loop out '
        + 'to the set FIRST; the record is honest, the interpretation is what would be wrong.',
    }
  }
  return {
    ready: true, bps,
    reason: `${p}/${s} seats attesting (${(bps / 100).toFixed(1)}%) — the record reflects the set`,
  }
}
