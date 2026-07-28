/**
 * 🎯 WHICH REGISTRY MAY A DESTRUCTIVE ACCEPTANCE SUITE OPERATE ON?
 *
 * ⚠️⚠️ WHY THIS EXISTS. `slashable-registry-e2e.mjs` stakes throwaway keys, convicts
 * one of them, and calls a REAL `rotate()`. That is the right way to test enforcement
 * — reading `isConvicted()` and calling it enforcement is what it was written to avoid
 * — but it means the suite RESHAPES the validator set of whatever registry it is aimed
 * at. It carried one guard for that: refuse if the registry under test is the one Besu
 * reads. The premise was "not authoritative ⇒ safe to reshape", and it was true when
 * written.
 *
 * c22 made it false. There is now a third category: a registry Besu does **not** read
 * yet, which is the DESIGNATED SWAP TARGET — funded, converged, and `swap-preflight`
 * green. Aiming the suite at that is worse than aiming it at the authoritative
 * registry, because the damage is silent and arrives later:
 *
 *   - the suite's candidates are ephemeral keys (`keccak256(seed)`, derived in-process
 *     and never written anywhere). After the run **nobody holds them**;
 *   - their stake cannot be removed by anyone: `unstake()` reverts `StillSeated()`
 *     while seated, `requestExit()` needs their signature, and `forfeit()` needs a
 *     conviction they will never earn. They are eligible **forever**;
 *   - `rotate()` seats by stake, so every future rotation re-seats them. Seats go up,
 *     quorum goes up, the number of live processes does not — and the swap that was
 *     survivable becomes a halt at the transition;
 *   - and none of it shows up as a failure. The suite passes. It is *supposed* to
 *     stake and rotate.
 *
 * 🔑 THIS ALREADY HAPPENED, and the evidence sat unread for two cycles. The registry
 * c21 abandoned for being "ghost-laden" (8 seats, 15 candidates, 6000 forfeited) was
 * ghost-laden BECAUSE THIS SUITE RAN AGAINST IT. c20/c21 diagnosed the state and
 * deployed a fresh registry; neither asked where the ghosts came from. A remediation
 * that does not identify the source ships a clean instance to the same factory.
 *
 * So: a destructive suite OWNS ITS FIXTURE. The default is a scratch registry the
 * suite deploys itself, and any registry the deployment file currently designates is
 * refused by name.
 *
 * Pure: no RPC, no fs, no clock.
 */
import { qbftQuorum } from './validator-set-health.mjs'

const norm = (a) => String(a || '').trim().toLowerCase()

/**
 * What staking N ephemeral candidates into a registry and rotating would do to the
 * quorum the chain has to satisfy afterwards.
 *
 * Quantified rather than asserted, because "it would add ghosts" invites a judgement
 * call and "quorum becomes 6 against 5 live processes" does not. `added` counts only
 * candidates that end up ELIGIBLE — a convicted one takes no seat, so counting it
 * would overstate the harm and make the refusal easy to dismiss as alarmist.
 *
 * @param {object} p
 * @param {number} p.eligibleNow    eligible candidates before the suite runs
 * @param {number} p.added          ephemeral candidates that would become eligible
 * @param {number} p.maxValidators  the registry's seat cap
 * @param {number} p.liveCount      processes actually producing blocks
 */
export function projectGhostInflation(p) {
  const eligibleNow = Math.max(0, Math.floor(Number(p?.eligibleNow) || 0))
  const added = Math.max(0, Math.floor(Number(p?.added) || 0))
  const cap = Math.max(1, Math.floor(Number(p?.maxValidators) || 21))
  const liveCount = Math.max(0, Math.floor(Number(p?.liveCount) || 0))

  const seatsBefore = Math.min(eligibleNow, cap)
  const seatsAfter = Math.min(eligibleNow + added, cap)
  const quorumBefore = qbftQuorum(seatsBefore)
  const quorumAfter = qbftQuorum(seatsAfter)
  return {
    seatsBefore,
    seatsAfter,
    quorumBefore,
    quorumAfter,
    liveCount,
    // The margin is what the swap actually depends on, and it is the number that
    // moves. Reporting only the seat count hides that a +4 seat change can be the
    // difference between a working swap and an unrecoverable one.
    marginBefore: liveCount - quorumBefore,
    marginAfter: liveCount - quorumAfter,
    halts: liveCount < quorumAfter,
    // True when the swap was survivable before and is not afterwards. This is the
    // specific harm — not "ghosts are untidy" but "a green gate turns red, and the
    // thing that turned it red reported success".
    breaksSurvivableSwap: liveCount >= quorumBefore && liveCount < quorumAfter,
  }
}

/**
 * Decide the registry a destructive suite may operate on.
 *
 * @param {object} input
 * @param {object} input.deployment  the parsed validators-deployment.json
 * @param {string} [input.requested] an explicit --registry override
 * @param {object} [input.projection] the output of projectGhostInflation, for the message
 * @returns {{ok: boolean, mode: 'scratch'|'explicit', address: string|null, refusals: string[], warnings: string[]}}
 */
export function chooseE2ERegistry(input) {
  const refusals = []
  const warnings = []
  const d = input?.deployment && typeof input.deployment === 'object' ? input.deployment : null
  if (!d) {
    return { ok: false, mode: 'scratch', address: null, refusals: ['no deployment record given — cannot tell which registries are off-limits'], warnings }
  }

  const authoritative = norm(d.validatorContract)
  const designated = norm(d.validatorContractSlashable)
  const superseded = new Set((Array.isArray(d.previousValidatorContractSlashable) ? d.previousValidatorContractSlashable : []).map(norm))

  const requested = norm(input?.requested)

  // No override: the suite deploys its own. This is the posture, not the fallback —
  // a fixture the suite created is the only one whose state it can reason about, and
  // it is also the only one whose ghosts nobody inherits.
  if (!requested) {
    return { ok: true, mode: 'scratch', address: null, refusals, warnings }
  }

  if (requested === authoritative) {
    refusals.push(
      `${input.requested} is the AUTHORITATIVE registry — Besu reads it every block. This suite stakes, convicts and rotates; against that address it would reshape the running chain's validator set to check an assertion`,
    )
  } else if (requested === designated) {
    // ⚠️ THE c23 REFUSAL. Not authoritative, and that is exactly what makes it
    // dangerous: the old guard checked authority, and authority is not the property
    // that matters. What matters is whether anyone is going to DEPEND on this
    // registry's state later.
    const pr = input?.projection
    const numbers = pr
      ? ` Concretely: ${pr.seatsBefore} seats → ${pr.seatsAfter}, so quorum ${pr.quorumBefore} → ${pr.quorumAfter} against ${pr.liveCount} live process(es)${pr.breaksSurvivableSwap ? ' — a swap that is survivable today would HALT THE CHAIN at the transition' : ''}.`
      : ''
    refusals.push(
      `${input.requested} is the DESIGNATED SWAP TARGET (validatorContractSlashable) — funded and preflight-green. This suite stakes ephemeral keys that nobody holds after the run and then rotates, and their stake can never be removed: unstake() reverts StillSeated(), requestExit() needs their signature, forfeit() needs a conviction they will not earn. They stay eligible forever and every rotation re-seats them.${numbers} The registry the previous cycles abandoned for being ghost-laden was made that way by exactly this run`,
    )
  } else if (superseded.has(requested)) {
    warnings.push(
      `${input.requested} is a SUPERSEDED registry — nothing depends on its state, so reshaping it is harmless. Note the results are read against leftovers from earlier runs, so assert deltas, never absolutes`,
    )
  } else {
    warnings.push(
      `${input.requested} is not named in the deployment record — assuming it is a scratch registry. If anything is going to depend on its state, this suite must not be aimed at it`,
    )
  }

  if (refusals.length) return { ok: false, mode: 'explicit', address: null, refusals, warnings }
  return { ok: true, mode: 'explicit', address: input.requested, refusals, warnings }
}
