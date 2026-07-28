// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessRegistrySwap,
  assessTransitionKey,
  assessRegistrySolvency,
  assessRegistryOpenness,
  assessSwapReachability,
  assessCourtBinding,
  MIN_PLAUSIBLE_TIMESTAMP,
  MIN_TRANSITION_LEAD_S,
} from '@/chain/multinode/registry-swap-policy.mjs'

/**
 * 🔁 The registry-swap preflight.
 *
 * These tests exist because the carried-debt item "swap TinyValidators for
 * TinyValidatorsSlashable" was, when probed against the real 8470 devnet, an
 * instruction to halt the chain: the incoming registry seats 8 addresses and not
 * one of them belongs to a running process. Nothing in the deploy, the E2E, or the
 * design doc would have caught it — every one of them asks whether the incoming
 * registry's RULES work, and the swap's danger is entirely in its STATE.
 *
 * So the load-bearing tests here are the ones where the answer is REFUSE, and in
 * particular the ones where every other signal is green.
 */

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const seats = (n: number, from = 1) => Array.from({ length: n }, (_, i) => addr(i + from))

/** A swap that should pass, so each test can break exactly one thing. */
const NOW = 1_800_000_000
const healthy = () => ({
  incomingSeats: seats(4),
  outgoingSeats: seats(4),
  proposers: seats(4),
  window: 12,
  transitionKey: NOW + 1200,
  nowSec: NOW,
  solvency: { balanceMicro: BigInt('8000000000'), recordedStakeMicro: BigInt('8000000000'), forfeitedMicro: BigInt('0') },
  openness: { eligibleCount: 6, minValidators: 4 },
  courtHealthy: true,
})

describe('assessRegistrySwap — the halt this file exists to refuse', () => {
  it('passes a swap where the incoming set is the set that is actually producing blocks', () => {
    const r = assessRegistrySwap(healthy())
    expect(r.ok).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.liveness.live).toBe(4)
  })

  it('🔴 REFUSES the real c17 devnet state: incoming registry seats 8 addresses, none of them live', () => {
    // Verbatim from the probe, before this module existed.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(8, 100), // the slashable registry's leftover E2E joiners
      outgoingSeats: seats(6, 1), // today's authoritative seats
      proposers: seats(5, 1), // 5 of the 6 are proposing
      window: 24,
    })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toContain('CANNOT COMMIT BLOCKS AFTER THE SWAP')
    // The numbers that make it a halt, not a warning.
    expect(r.liveness.seats).toBe(8)
    expect(r.liveness.live).toBe(0)
    expect(r.liveness.quorum).toBe(6)
  })

  it('🔴 refuses even when the incoming set is ONE seat short of quorum', () => {
    // 6 seats, quorum 4, three live: the chain stops. Not a margin warning.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(6),
      proposers: seats(3),
      window: 18,
    })
    expect(r.ok).toBe(false)
    expect(r.liveness.live).toBe(3)
    expect(r.liveness.quorum).toBe(4)
  })

  it('🔴 refuses a swap at EXACTLY quorum — zero margin is one failure from a halt, and the swap is the moment to fix it', () => {
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(6),
      proposers: seats(4),
      window: 18,
    })
    expect(r.ok).toBe(false)
    expect(r.liveness.margin).toBe(0)
    expect(r.blockers.join(' ')).toContain('EXACTLY quorum')
  })

  it('counts only proposers that the INCOMING registry seats — a live validator it does not seat cannot vote in its quorum', () => {
    // Four busy proposers, but the incoming registry seats four OTHER addresses.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(4, 50),
      proposers: seats(4, 1),
      window: 12,
    })
    expect(r.ok).toBe(false)
    expect(r.liveness.live).toBe(0)
  })

  it('🔴 REFUSES rather than guesses when the evidence window is shorter than one round-robin', () => {
    // 6 seats sampled over 3 blocks: at most 3 proposers can appear, so "3 are
    // silent" is an artefact of the sample. For an irreversible operation,
    // "cannot tell" must read as refuse — not as the cautious pass.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(6),
      proposers: seats(3),
      window: 3,
    })
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(true)
    expect(r.blockers.join(' ')).toContain('coin flip')
  })

  it('is case-insensitive about who is live — checksummed seats vs lowercase proposers is the normal wire shape', () => {
    const mixed = ['0xAaBbCcDdEeFf00112233445566778899AaBbCcDd', '0xDeAdBeEf00000000000000000000000000001111', addr(3), addr(4)]
    // Prove the fixture genuinely has letters in both cases (c15's lesson: a case
    // test whose fixture is digits-only tests nothing).
    expect(mixed[0]).toMatch(/[A-F]/)
    expect(mixed[0].toLowerCase()).not.toBe(mixed[0])
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: mixed,
      outgoingSeats: mixed,
      proposers: mixed.map((m) => m.toLowerCase()),
      window: 12,
    })
    expect(r.ok).toBe(true)
    expect(r.liveness.live).toBe(4)
  })

  it('the REMEDIATION is case-insensitive too — otherwise it tells you to stake validators that are already seated', () => {
    // Found by a surviving mutant: `assessSetLiveness` lowercases internally, so
    // the liveness numbers stay right while the advice goes wrong. Checksummed
    // seats + lowercase proposers is the ordinary wire shape (getValidators()
    // returns checksummed, block.miner arrives lowercase), so this is the DEFAULT
    // case, not an edge one.
    const mixed = ['0xAaBbCcDdEeFf00112233445566778899AaBbCcDd', '0xDeAdBeEf00000000000000000000000000001111', addr(3), addr(4), addr(5), addr(6)]
    expect(mixed[0]).toMatch(/[A-F]/)
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: mixed,
      outgoingSeats: mixed,
      proposers: mixed.slice(0, 3).map((m) => m.toLowerCase()), // 3 live of 6 seats: a halt
      window: 18,
    })
    expect(r.ok).toBe(false)
    // Every live proposer IS seated, so the shortfall is not a migration gap.
    expect(r.remediation.join(' ')).toContain('not a migration gap')
    expect(r.remediation.join(' ')).not.toContain('stake the')
  })
})

describe('the remediation must be the one that actually works', () => {
  it('names the live validators to stake, and says to rotate BEFORE the transition — when that can actually reach quorum', () => {
    // ⚠️ c18 CHANGED THIS FIXTURE, and the change IS the finding. It used to be
    // the real c17 devnet state (8 ghosts, 5 live) asserting `stake the 5 live
    // validator(s)` — advice that CANNOT WORK, because rotate() seats every
    // eligible candidate, so 5 live against 8 eligible ghosts is 13 seats needing
    // 9 signatures. The test passed because it checked that the sentence was
    // printed, never that following it would help.
    //
    // So the stake-and-rotate branch is now tested where it is genuinely the fix:
    // ONE ghost, and enough live validators to carry the resulting quorum.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: [addr(100), ...seats(2, 1)], // 1 ghost + 2 of the live set
      proposers: seats(5, 1), // 5 live, 3 of them unseated
      window: 24,
      incomingEligibleGhosts: 1,
    })
    const advice = r.remediation.join(' ')
    expect(r.reach.reachable).toBe(true)
    expect(advice).toContain('stake the 3 live validator(s)')
    expect(advice).toContain('BEFORE writing the transition')
    // The trap c15 paid for: telling an operator to rotate AFTER the swap is
    // advice that cannot be executed, because rotate() is a transaction.
    expect(advice).toContain('needs a quorum that will not exist')
    // And the advice it must NOT give here: this registry is rescuable.
    expect(advice).not.toContain('deploy a FRESH registry')
  })

  it('🔴 REFUSES TO GIVE c17\'s OWN ADVICE on c17\'s OWN devnet state — it was arithmetically impossible', () => {
    // The exact probed state: 8 leftover E2E joiners eligible and seated, 5 live
    // validators. c17 shipped "stake the 5 live validators and rotate()" as the
    // remediation for precisely this, and every step of it succeeds while the
    // chain halts anyway — rotate() ADDS the newcomers as seats instead of
    // replacing the ghosts, so quorum goes 6 → 9 and 5 signers still cannot commit.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(8, 100),
      outgoingSeats: seats(6, 1),
      proposers: seats(5, 1),
      window: 24,
      incomingEligibleGhosts: 8,
      incomingLabel: '0x4ea0Be853219be8C9cE27200Bdeee36881612FF2',
    })
    const advice = r.remediation.join(' ')
    expect(r.ok).toBe(false)
    expect(r.reach.reachable).toBe(false)
    // THE ASSERTION THIS CYCLE EXISTS FOR: the impossible instruction is gone,
    // not merely accompanied by a caveat. An operator reading a list does the
    // first thing on it.
    expect(advice).not.toMatch(/stake the \d+ live validator\(s\)/)
    expect(advice).toContain('NOT AVAILABLE')
    // And it says what to do instead, naming the dead instance so the next cycle
    // cannot re-aim at it by reading the deployment file.
    expect(advice).toContain('deploy a FRESH registry')
    expect(advice).toContain('0x4ea0Be853219be8C9cE27200Bdeee36881612FF2')
  })

  it('finishes the fresh-deploy advice: a new registry seats with ZERO stake, so it must be staked before it can rotate', () => {
    // 🔑 THE SAME LESSON, ONE LEVEL DOWN. The replacement remediation is itself a
    // claim about the future, so it gets the same check the one it replaced never
    // got — and it was two-thirds of an answer. TinyValidatorsSlashable's
    // constructor writes isActive/isCandidate/candidates for its initial set but
    // never writes stakeOf (verified: 0 occurrences in the constructor), and
    // _eligible requires stakeOf >= minStake. So a freshly deployed registry is
    // born with eligibleCount 0, under its own minValidators floor, where every
    // rotate() reverts BelowValidatorFloor — the seated set frozen forever. An
    // operator who follows the advice as written deploys, re-runs, and is refused
    // again by assessRegistryOpenness.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(8, 100),
      proposers: seats(5, 1),
      window: 24,
      incomingEligibleGhosts: 8,
    })
    const advice = r.remediation.join(' ')
    expect(advice).toContain('zero stake')
    expect(advice).toContain('eligibleCount 0')
    // Named so the next cycle can grep for the revert it would otherwise hit.
    expect(advice).toContain('BelowValidatorFloor')
    // And the order matters: deploy, THEN stake, THEN re-run the preflight. The
    // re-run is the step that makes this advice falsifiable at all.
    const deployAt = advice.indexOf('deploy a FRESH registry')
    const stakeAt = advice.indexOf('stake the live validators INTO')
    const rerunAt = advice.indexOf('re-run this preflight against the fresh registry')
    expect(deployAt).toBeGreaterThan(-1)
    expect(stakeAt).toBeGreaterThan(deployAt)
    expect(rerunAt).toBeGreaterThan(stakeAt)
  })

  it('c19: sends the operator to the stake PLANNER, because "stake them" is not free either', () => {
    // Probing step 2 of the advice above found the money may not exist: the stake
    // already posted is trapped behind StillSeated(), mint() went to TinyIssuance
    // irreversibly in P3, and a live validator with a zero balance makes stake()
    // revert inside transferFrom — a message that names the symptom and hides all
    // three causes. An operator who has to discover that mid-migration has been
    // handed advice that reads complete and is not.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(8, 100),
      proposers: seats(5, 1),
      window: 24,
      incomingEligibleGhosts: 8,
    })
    const advice = r.remediation.join(' ')
    expect(advice).toContain('stake-migration-plan.mjs')
    // and the planner must be invoked BEFORE the staking it plans
    expect(advice.indexOf('stake-migration-plan.mjs')).toBeGreaterThan(advice.indexOf('deploy a FRESH registry'))
    expect(advice.indexOf('stake-migration-plan.mjs')).toBeLessThan(
      advice.indexOf('re-run this preflight against the fresh registry'),
    )
  })

  it('does not blame the migration when no live proposer is missing — then the chain simply lacks validators', () => {
    // Incoming seats a superset of the live proposers, but only 2 of 9 are live.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: seats(9),
      proposers: seats(2),
      window: 27,
    })
    expect(r.ok).toBe(false)
    expect(r.remediation.join(' ')).toContain('not a migration gap')
  })

  it('offers no remediation when nothing is wrong', () => {
    expect(assessRegistrySwap(healthy()).remediation).toEqual([])
  })

  // ⚠️ THE FOUR TESTS BELOW EXIST BECAUSE MUTANTS SURVIVED. `assessSwapReachability`
  // was thoroughly covered standalone while every ARGUMENT assessRegistrySwap
  // passes into it was unasserted — so the function was right and could still be
  // called with the wrong numbers. When a mutant survives, ask which CONSUMER of
  // the value nothing asserts (c17's MUT9 lesson, one layer out).

  it('passes the LIVE PROPOSER COUNT into the reachability check, not the incoming seat count', () => {
    // A mutant using `incoming.length` for liveCount survived every other test:
    // with 8 seats and 8 ghosts it computes 8 ≥ ceil(2·16/3)=11 → still false, so
    // the verdict looked right for the wrong reason. Distinguish with a case where
    // the two disagree in the ANSWER: 6 live proposers vs 3 ghosts is reachable,
    // but a 3-seat incoming registry read as liveCount=3 is not.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: [addr(100), addr(101), addr(102)],
      proposers: seats(6, 1),
      window: 18,
      incomingEligibleGhosts: 3,
    })
    expect(r.reach.reachable).toBe(true)
    expect(r.remediation.join(' ')).toContain('stake the 6 live validator(s)')
  })

  it('honours incomingEligibleGhosts over the seated-ghost fallback', () => {
    // The fallback (count seated ghosts) is a FLOOR, so it is safe — and therefore
    // silent when the caller's real number is larger. A mutant inverting the
    // Number.isFinite test survived, because on the c17 fixture the seated and
    // eligible ghost counts are both 8. Make them disagree in the verdict.
    const base = { ...healthy(), incomingSeats: [addr(100)], proposers: seats(3, 1), window: 12 }
    // Seated ghosts = 1 → 3 live carries it. Eligible ghosts = 8 → it cannot.
    expect(assessRegistrySwap({ ...base }).reach.reachable).toBe(true)
    expect(assessRegistrySwap({ ...base, incomingEligibleGhosts: 8 }).reach.reachable).toBe(false)
  })

  it('honours the incoming registry\'s OWN maxValidators, not the 21 default', () => {
    // A mutant hardcoding 21 survived because 8470's cap IS 21. A registry deployed
    // with a smaller cap changes the arithmetic: 4 live + 3 ghosts is 7 seats
    // needing 5 (unreachable), but capped at 4 seats it needs only 3 (reachable).
    const base = { ...healthy(), incomingSeats: [addr(100)], proposers: seats(4, 1), window: 12, incomingEligibleGhosts: 3 }
    expect(assessRegistrySwap({ ...base, openness: { eligibleCount: 6, minValidators: 4, maxValidators: 21 } }).reach.reachable).toBe(false)
    expect(assessRegistrySwap({ ...base, openness: { eligibleCount: 6, minValidators: 4, maxValidators: 4 } }).reach.reachable).toBe(true)
  })

  it('surfaces the stake caveat in the REMEDIATION, not only in the returned object', () => {
    // Deleting the `remediation.push(reach.caveat)` line survived: r.reach.caveat
    // was still populated, and the only consumer that a human ever reads is the
    // printed advice list. A condition that exists only in a field nobody prints is
    // the same failure as one printed only on refusals.
    const r = assessRegistrySwap({
      ...healthy(),
      incomingSeats: [addr(100), ...seats(3, 1)],
      proposers: seats(4, 1),
      window: 12,
      incomingEligibleGhosts: 1,
      openness: { eligibleCount: 6, minValidators: 4, maxValidators: 4 },
    })
    expect(r.reach.reachable).toBe(true)
    expect(r.reach.caveat).toBeTruthy()
    expect(r.remediation.join(' ')).toContain('STAKE')
  })
})

describe('assessTransitionKey — c7\'s timestamp bug, refused by shape', () => {
  it('rejects a block number when a time-based hardfork precedes the transition', () => {
    const r = assessTransitionKey(14500, { nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('BLOCK NUMBER')
    expect(r.reason).toContain('1970')
    // The failure this shape produces, named: insiders never notice.
    expect(r.reason).toContain('syncing from genesis')
  })

  it('accepts the same block number when NO time-based hardfork precedes it — judged against the HEAD, not the clock', () => {
    // Not a hypothetical: a genesis without shanghaiTime reads the field as a
    // block number, and refusing it there would be a false alarm. The units are
    // the trap this test caught on its first run — comparing a block number to
    // `nowSec` makes a correct key look 1.8 billion seconds late.
    const r = assessTransitionKey(14500, { nowSec: NOW, timeBasedFork: false, nowBlock: 14000, blockPeriodS: 2 })
    expect(r.ok).toBe(true)
    expect(r.leadS).toBe(1000)
  })

  it('rejects a block-number key behind the head', () => {
    const r = assessTransitionKey(13000, { nowSec: NOW, timeBasedFork: false, nowBlock: 14000 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('1000 block(s) BEHIND the head')
  })

  it('rejects a block-number key too few blocks ahead, converting blocks to seconds', () => {
    // 100 blocks at 2s = 200s, under the 600s floor.
    const r = assessTransitionKey(14100, { nowSec: NOW, timeBasedFork: false, nowBlock: 14000, blockPeriodS: 2 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('~200s at 2s/block')
  })

  it('refuses a block-number key when the head is unknown rather than assuming one', () => {
    const r = assessTransitionKey(14500, { nowSec: NOW, timeBasedFork: false })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('no nowBlock was supplied')
  })

  it('DEFAULTS to treating the key as a timestamp — the safe default is the one that refuses a block number', () => {
    expect(assessTransitionKey(14500, { nowSec: NOW }).ok).toBe(false)
  })

  it('rejects a timestamp in the past — nodes restarting at different times would disagree', () => {
    const r = assessTransitionKey(NOW - 60, { nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('PAST')
    expect(r.leadS).toBe(-60)
  })

  it('rejects a timestamp too close to give every node time to restart in lockstep', () => {
    const r = assessTransitionKey(NOW + 120, { nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('120s until the transition')
    expect(r.reason).toContain('forks')
  })

  it('accepts a timestamp at exactly the minimum lead', () => {
    const r = assessTransitionKey(NOW + MIN_TRANSITION_LEAD_S, { nowSec: NOW })
    expect(r.ok).toBe(true)
    expect(r.leadS).toBe(MIN_TRANSITION_LEAD_S)
  })

  it('honours an explicit longer lead requirement', () => {
    expect(assessTransitionKey(NOW + 700, { nowSec: NOW, minLeadS: 3600 }).ok).toBe(false)
    expect(assessTransitionKey(NOW + 3600, { nowSec: NOW, minLeadS: 3600 }).ok).toBe(true)
  })

  it('rejects garbage rather than coercing it into a plausible key', () => {
    for (const bad of [null, undefined, 'soon', {}, [], -1, 0, 1.5, NaN]) {
      expect(assessTransitionKey(bad as any, { nowSec: NOW }).ok).toBe(false)
    }
  })

  it('the timestamp threshold is a decade clear of any plausible 8470 block number', () => {
    // Heads are ~14k. If this constant ever drifted down toward block-number
    // range the whole check would silently stop working.
    expect(MIN_PLAUSIBLE_TIMESTAMP).toBeGreaterThan(1_000_000_000)
  })
})

describe('assessRegistrySolvency — the half of a migration nothing on-chain couples', () => {
  it('passes when the token balance covers every recorded stake', () => {
    const r = assessRegistrySolvency({ balanceMicro: BigInt('5000'), recordedStakeMicro: BigInt('5000') })
    expect(r.ok).toBe(true)
    expect(r.deficitMicro).toBe(BigInt('0'))
  })

  it('🔴 refuses a registry credited with stake it never received — the failure that only appears at the LAST withdrawal', () => {
    const r = assessRegistrySolvency({ balanceMicro: BigInt('1000'), recordedStakeMicro: BigInt('8000') })
    expect(r.ok).toBe(false)
    expect(r.deficitMicro).toBe(BigInt('7000'))
    expect(r.reason).toContain('unstakes LAST')
  })

  it('🔴 counts FORFEITED stake as an obligation — it is locked in the contract forever, not spendable headroom', () => {
    // Exactly the shape of the real slashable registry: 8000 staked + 6000
    // forfeited against a 14000 balance is solvent; ignoring the forfeited half
    // would call a 6000 shortfall healthy.
    const solvent = assessRegistrySolvency({ balanceMicro: BigInt('14000'), recordedStakeMicro: BigInt('8000'), forfeitedMicro: BigInt('6000') })
    expect(solvent.ok).toBe(true)
    const broke = assessRegistrySolvency({ balanceMicro: BigInt('8000'), recordedStakeMicro: BigInt('8000'), forfeitedMicro: BigInt('6000') })
    expect(broke.ok).toBe(false)
    expect(broke.deficitMicro).toBe(BigInt('6000'))
    expect(broke.reason).toContain('forfeited-and-locked')
  })

  it('accepts a surplus — a registry holding more than it owes is odd, not unsafe', () => {
    expect(assessRegistrySolvency({ balanceMicro: BigInt('9000'), recordedStakeMicro: BigInt('5000') }).ok).toBe(true)
  })

  it('handles the string/decimal forms an RPC or JSON file actually hands over', () => {
    expect(assessRegistrySolvency({ balanceMicro: '8000', recordedStakeMicro: '8000' }).ok).toBe(true)
    expect(assessRegistrySolvency({ balanceMicro: '1000', recordedStakeMicro: '8000' }).ok).toBe(false)
    // No precision loss at values beyond Number.MAX_SAFE_INTEGER: micro-USDC
    // reaches that at ~9e12, well inside a real supply.
    const huge = assessRegistrySolvency({
      balanceMicro: '90071992547409910',
      recordedStakeMicro: '90071992547409920',
    })
    expect(huge.ok).toBe(false)
    expect(huge.deficitMicro).toBe(BigInt('10'))
  })

  it('treats missing/garbage figures as zero rather than throwing — a preflight must always produce a verdict', () => {
    expect(assessRegistrySolvency({} as any).ok).toBe(true)
    expect(assessRegistrySolvency({ balanceMicro: 'x', recordedStakeMicro: 'y' } as any).ok).toBe(true)
    expect(assessRegistrySolvency({ balanceMicro: BigInt('0'), recordedStakeMicro: 'nonsense' } as any).ok).toBe(true)
  })
})

describe('assessSwapReachability — c18: is the advice we are about to print even possible?', () => {
  it('🔴 refuses c17\'s case: 5 live vs 8 eligible ghosts, needing 9 of 13 seats', () => {
    const r = assessSwapReachability({ liveCount: 5, ghostCount: 8, maxValidators: 21 })
    expect(r.reachable).toBe(false)
    expect(r.minSeats).toBe(13)
    expect(r.quorum).toBe(9)
  })

  it('🔑 THE WHOLE ARITHMETIC: adding a live validator adds a SEAT, so quorum runs at 2/3 your speed', () => {
    // This is why "just stake more validators in" is not a fix. Every added live
    // validator is +1 seat and +2/3 quorum, so the gap closes at 1/3 per addition
    // — from 4 behind, that is 12 validators, not 4.
    for (const live of [1, 5, 8, 12]) {
      expect(assessSwapReachability({ liveCount: live, ghostCount: 8, maxValidators: 21 }).reachable).toBe(false)
    }
    // And the first count that works is 14 — set by the CAP, not by the algebra.
    expect(assessSwapReachability({ liveCount: 14, ghostCount: 8, maxValidators: 21 }).reachable).toBe(true)
  })

  it('quotes the CAP-CORRECTED requirement, not the closed form — 14, not 2×8=16', () => {
    // The sub-cap rule is live ≥ 2 × ghosts, and quoting it at the cap overstates
    // the requirement: seats stop growing at maxValidators while quorum stops at
    // ceil(2·max/3). Handing an operator 16 when 14 suffices is a different wrong
    // number than c17 handed them, not a fix.
    const r = assessSwapReachability({ liveCount: 5, ghostCount: 8, maxValidators: 21 })
    expect(r.liveNeeded).toBe(14)
    expect(r.reason).toContain('14 live validator(s)')
    expect(r.reason).not.toContain('16 live')
  })

  it('warns that the cap\'s discount is CONDITIONAL — at the cap, rotate() picks by stake', () => {
    // 14 + 8 = 22 eligible for 21 seats, so one of them misses out and rotate()
    // decides by stake. Being eligible is not being seated, and advice that skips
    // that is advice that fails on the last step.
    const r = assessSwapReachability({ liveCount: 5, ghostCount: 8, maxValidators: 21 })
    expect(r.capContested).toBe(true)
    expect(r.reason).toContain('OUTSTAKE')
    // Under the cap there is no contest, so the caveat must NOT appear — an
    // unconditional warning is one an operator learns to skip.
    const under = assessSwapReachability({ liveCount: 1, ghostCount: 2, maxValidators: 21 })
    expect(under.capContested).toBe(false)
    expect(under.reason).not.toContain('OUTSTAKE')
  })

  it('the sub-cap rule holds exactly: live ≥ 2 × ghosts', () => {
    for (const ghosts of [1, 2, 3, 4]) {
      expect(assessSwapReachability({ liveCount: 2 * ghosts, ghostCount: ghosts, maxValidators: 21 }).reachable).toBe(true)
      expect(assessSwapReachability({ liveCount: 2 * ghosts - 1, ghostCount: ghosts, maxValidators: 21 }).reachable).toBe(false)
    }
  })

  it('is reachable with no ghosts at all — a registry seating only live validators needs no rescue', () => {
    const r = assessSwapReachability({ liveCount: 4, ghostCount: 0, maxValidators: 21 })
    expect(r.reachable).toBe(true)
    expect(r.reason).toBe(null)
  })

  it('refuses when nothing is live, and says so as a node problem rather than a registry one', () => {
    const r = assessSwapReachability({ liveCount: 0, ghostCount: 4, maxValidators: 21 })
    expect(r.reachable).toBe(false)
    expect(r.reason).toContain('nothing to stake')
    // Must NOT blame rotate()/the ghosts: with zero live validators the chain has
    // no signers at all and every registry is equally dead.
    expect(r.reason).not.toContain('OUTSTAKE')
  })

  it('counts ELIGIBLE ghosts, not seated ones — the ones a future rotate() would seat', () => {
    // A candidate with stake but no seat today takes a seat at the next rotation,
    // so judging on seats alone can call a doomed swap reachable. Note 5-live/3-ghost
    // is ALSO unreachable (8 seats need 6, and 5 < 6) — the sub-cap rule is
    // live ≥ 2 × ghosts, so the honest contrast is at the boundary: 6 live carries
    // 3 ghosts, and the same 6 cannot carry 8.
    expect(assessSwapReachability({ liveCount: 6, ghostCount: 3, maxValidators: 21 }).reachable).toBe(true)
    expect(assessSwapReachability({ liveCount: 6, ghostCount: 8, maxValidators: 21 }).reachable).toBe(false)
  })

  it('handles junk input by refusing rather than throwing — it gates an irreversible op', () => {
    for (const bad of [undefined, null, {}, { liveCount: 'x', ghostCount: 'y', maxValidators: 'z' }]) {
      // @ts-expect-error deliberately malformed
      const r = assessSwapReachability(bad)
      expect(r.reachable).toBe(false)
    }
  })

  it('🔑 A GREEN VERDICT AT THE CAP STILL CARRIES THE STAKE CAVEAT — arithmetic-reachable is not seat-reachable', () => {
    // maxValidators 1 makes quorum 1, so 1 live validator satisfies the ARITHMETIC
    // and this returns reachable. But the single seat goes to whichever eligible
    // candidate has the most stake, so the advice fails on its last step unless the
    // live one outstakes the ghost. The caveat therefore has to ride along with the
    // GREEN answer — a condition printed only on refusals is a condition nobody
    // reads, which is the same failure c17 made one level up.
    const r = assessSwapReachability({ liveCount: 1, ghostCount: 1, maxValidators: 1 })
    expect(r.reachable).toBe(true)
    expect(r.minSeats).toBe(1)
    expect(r.reason).toBe(null)
    expect(r.caveat ?? '').toContain('STAKE')
  })

  it('no caveat when the cap is not contested — an unconditional warning is one that gets skipped', () => {
    const r = assessSwapReachability({ liveCount: 6, ghostCount: 3, maxValidators: 21 })
    expect(r.reachable).toBe(true)
    expect(r.caveat).toBe(null)
  })
})

describe('assessRegistryOpenness — the failure that does not look like one', () => {
  it('passes when the eligible pool clears the floor', () => {
    expect(assessRegistryOpenness({ eligibleCount: 6, minValidators: 4 }).ok).toBe(true)
  })

  it('passes at exactly the floor — rotate() requires >= , not >', () => {
    expect(assessRegistryOpenness({ eligibleCount: 4, minValidators: 4 }).ok).toBe(true)
  })

  it('🔴 refuses a registry arriving below its own floor: every rotate() reverts, so the set is frozen forever', () => {
    const r = assessRegistryOpenness({ eligibleCount: 3, minValidators: 4 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('FROZEN FOREVER')
    // The reason this is the worst of the four: nothing else notices.
    expect(r.reason).toContain('no longer permissionless')
  })

  it('refuses a zero floor rather than reading it as "no constraint"', () => {
    const r = assessRegistryOpenness({ eligibleCount: 9, minValidators: 0 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('halts besu')
  })

  it('a frozen registry is a BLOCKER in the full verdict even when the chain would keep producing blocks', () => {
    const r = assessRegistrySwap({ ...healthy(), openness: { eligibleCount: 2, minValidators: 4 } })
    expect(r.ok).toBe(false)
    // Liveness is fine — that is exactly why this needs its own question.
    expect(r.liveness.ok).toBe(true)
    expect(r.blockers.join(' ')).toContain('FROZEN FOREVER')
  })
})

describe('warnings are real and are NOT refusals', () => {
  it('warns that a broken court means convictions stop biting, without blocking the swap', () => {
    const r = assessRegistrySwap({ ...healthy(), courtHealthy: false })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('FAILS OPEN')
  })

  it('warns about addresses that silently lose their seats at the transition', () => {
    const r = assessRegistrySwap({
      ...healthy(),
      outgoingSeats: seats(6),
      incomingSeats: seats(4),
      proposers: seats(4),
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('2 address(es) seated today are NOT seated')
  })

  it('warns about stake stranded in the outgoing registry — reachable, but nothing points there any more', () => {
    const r = assessRegistrySwap({
      ...healthy(),
      solvency: { ...healthy().solvency, outgoingBalanceMicro: BigInt('20500000000') },
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('20500000000 micro of stake')
  })

  it('a clean swap warns about nothing', () => {
    expect(assessRegistrySwap(healthy()).warnings).toEqual([])
  })
})

describe('a swap can fail several ways at once, and must report all of them', () => {
  it('collects every blocker instead of stopping at the first', () => {
    const r = assessRegistrySwap({
      incomingSeats: seats(8, 100),
      outgoingSeats: seats(6),
      proposers: seats(5),
      window: 24,
      transitionKey: 14500, // a block number
      nowSec: NOW,
      solvency: { balanceMicro: BigInt('0'), recordedStakeMicro: BigInt('8000') },
      openness: { eligibleCount: 1, minValidators: 4 },
      courtHealthy: false,
    })
    expect(r.ok).toBe(false)
    expect(r.blockers.length).toBe(4)
    expect(r.summary).toContain('REFUSE: 4 blocker(s)')
    // An operator fixing one blocker must not be told the swap is now safe.
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('the summary carries the numbers an operator would otherwise have to dig for', () => {
    const r = assessRegistrySwap(healthy())
    expect(r.summary).toContain('4 incoming seats')
    expect(r.summary).toContain('4 demonstrably live')
    expect(r.summary).toContain('quorum 3')
    expect(r.summary).toContain('transition in 1200s')
  })
})

describe('the module reuses the existing liveness predicate rather than re-deciding it', () => {
  const src = readFileSync(join(process.cwd(), 'chain/multinode/registry-swap-policy.mjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports assessSetLiveness from validator-set-health.mjs', () => {
    expect(code).toMatch(/import\s*\{[^}]*assessSetLiveness[^}]*\}\s*from\s*'\.\/validator-set-health\.mjs'/)
  })

  it('does not reimplement the quorum formula — a second opinion nobody reconciles is c53\'s bug one layer down', () => {
    // The formula itself must appear nowhere in this file's code.
    expect(code).not.toMatch(/Math\.ceil\s*\(\s*\(?\s*2\s*\*/)
    expect(code).not.toMatch(/\/\s*3\s*\)/)
  })

  it('makes no network call of its own — the caller supplies the state (relayer-gas.mjs arrangement)', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/createPublicClient|http\s*\(/)
    expect(code).not.toMatch(/eth_[a-zA-Z]/)
  })

  it('reads liveness from PROPOSERS, never from the registry\'s own view of itself', () => {
    // The whole insight: `getValidators()` is the incoming registry's opinion; who
    // proposed is independent evidence. A check built on the former is circular.
    expect(code).toMatch(/proposers/)
    expect(code).not.toMatch(/isActive|validatorCount\(/)
  })

  it('c18: the reachability check reuses qbftQuorum too, rather than open-coding the seat math', () => {
    // Same rule as above, applied to the new function: the impossible-advice check
    // is entirely about quorum growth, so an independent formula here would be the
    // exact bug it exists to catch.
    expect(code).toMatch(/import\s*\{[^}]*qbftQuorum[^}]*\}\s*from\s*'\.\/validator-set-health\.mjs'/)
    const fn = code.slice(code.indexOf('export function assessSwapReachability'))
    expect(fn).toMatch(/qbftQuorum\s*\(/)
  })
})

describe('c18: the preflight SCRIPT actually supplies the eligible-ghost count', () => {
  // ⚠️ The policy falls back to counting SEATED ghosts when the caller omits
  // `incomingEligibleGhosts`. That fallback is a floor, so it is safe — and it is
  // therefore INVISIBLE if the script forgets to pass the real number. On the c17
  // devnet the seated and eligible ghost counts happen to be equal (8 and 8), so
  // even a live run would not reveal the omission. Assert the wiring at source.
  const src = readFileSync(join(process.cwd(), 'chain/multinode/scripts/swap-preflight.mjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('passes incomingEligibleGhosts into assessRegistrySwap', () => {
    expect(code).toMatch(/incomingEligibleGhosts:\s*eligibleGhosts/)
  })

  it('derives it from the CANDIDATE queue, not from the seated set', () => {
    // Ghosts that matter are the ones a future rotate() would seat, which means
    // every eligible candidate — the seated set is a subset and would undercount.
    expect(code).toMatch(/candidateAt/)
    expect(code).toMatch(/eligibleGhosts/)
    const block = code.slice(code.indexOf('const eligibleGhosts'), code.indexOf('const transitionKey'))
    expect(block).toMatch(/exiting/)
    expect(block).toMatch(/minStake/)
    expect(block).toMatch(/proposers\.has/)
  })

  it('passes maxValidators through, since the seat cap changes the answer', () => {
    // Without it the policy defaults to 21; correct for 8470 today and wrong the
    // moment a registry is deployed with a different cap.
    expect(code).toMatch(/functionName:\s*'maxValidators'/)
    expect(code).toMatch(/openness:\s*\{[^}]*maxValidators/)
  })

  it('still refuses any RPC that is not the 8470 devnet — the live chain is 8469', () => {
    expect(code).toMatch(/EXPECTED_CHAIN_ID\s*=\s*8470/)
    expect(code).toMatch(/chainId\s*!==\s*EXPECTED_CHAIN_ID/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// c24: `courtHealthy()` asks whether the court ANSWERS, not whether it is
// answering ABOUT US. Measured on the real 8470 before these were written:
//
//     incoming 0xb2ff9d5e….court()  → 0x2b0d36fa…   ✅ the real court
//     0x2b0d36fa….validators()      → 0x0165878a…   ⚠️ the OUTGOING registry
//     both registries' courtHealthy()               → true
//
// Two contracts pointing at each other is a CYCLE, and only one end was checked.
const COURT = '0x2b0d36FACD61b71cc05Ab8F3d2355Ec3631c0Dd5'
// ⚠️ These fixtures carry LETTERS in mixed case on purpose. `addr(0x11)` renders as
// digits only, so `toUpperCase()` is a no-op on it and the case-insensitivity test
// below passes against a case-SENSITIVE comparison — exactly the trap this file's own
// c15 note warns about, and a mutant survived on it before these were changed. They
// are the real 8470 addresses, which is also the mixed case the chain returns.
const IN = '0xb2ff9d5E60d68a52ceA3cd041b32F1390a880365'
const OUT = '0x0165878A594ca255338adfa4d48449f69242Eb8F'
const THIRD = '0x4Ea0Be853219be8C9CE27200bDEeE36881612FF2'
describe('assessCourtBinding — the court answers promptly, about the wrong registry', () => {
  it('the fixtures are genuinely mixed-case, or the casing test below proves nothing', () => {
    for (const a of [IN, OUT, THIRD, COURT]) {
      expect(a).toMatch(/[A-F]/)
      expect(a.toLowerCase()).not.toBe(a)
    }
  })

  it('accepts a court that describes the incoming registry', () => {
    const r = assessCourtBinding({ court: COURT, courtValidators: IN, incoming: IN, outgoing: OUT })
    expect(r.ok).toBe(true)
    expect(r.unknown).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('🔴 flags a court still bound to the OUTGOING registry — the real 8470 case', () => {
    // The finding. Nothing else in the preflight can see it: the court is healthy,
    // both registries name it, and exclusion genuinely keeps working.
    const r = assessCourtBinding({ court: COURT, courtValidators: OUT, incoming: IN, outgoing: OUT })
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(false)
    expect(r.reason).toContain('OUTGOING')
    expect(r.reason).toContain('immutable')
    // and it must say WHAT survives, or the reader over-corrects into halting the chain
    expect(r.reason).toContain('stakeAtConviction')
    expect(r.reason).toContain('Exclusion still works')
    expect(r.reason).toContain('courtHealthy() cannot see this')
  })

  it('🔴 distinguishes a THIRD registry from the outgoing one', () => {
    // Bound to neither is a different mistake (a mis-wired deploy, not a stale
    // pointer) and sending an operator to look at the outgoing contract would waste
    // the one reading they do.
    const r = assessCourtBinding({ court: COURT, courtValidators: THIRD, incoming: IN, outgoing: OUT })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('THIRD registry')
    expect(r.reason).not.toContain('OUTGOING registry —')
  })

  it('🔴 compares case-insensitively — checksummed on chain, lowercase in a file', () => {
    // A case-sensitive compare would warn on every healthy swap, and a warning that
    // always fires is one nobody reads by the time it is true. This is the ordinary
    // wire shape, not an edge case: getValidators()/court() return checksummed, and
    // the deployment file records lowercase.
    for (const [a, b] of [
      [IN.toLowerCase(), IN],
      [IN, IN.toLowerCase()],
      [IN.toUpperCase().replace('0X', '0x'), IN],
    ]) {
      expect(a).not.toBe(b) // the two spellings really do differ as strings
      const r = assessCourtBinding({ court: COURT, courtValidators: a, incoming: b, outgoing: OUT })
      expect(r.ok).toBe(true)
      expect(r.reason).toBeNull()
    }
    // …and the outgoing-vs-third diagnosis must be case-insensitive too, or the real
    // finding gets reported as a mis-wired deploy.
    const stale = assessCourtBinding({
      court: COURT, courtValidators: OUT.toLowerCase(), incoming: IN, outgoing: OUT,
    })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toContain('OUTGOING')
  })

  it('says nothing at all when there is no court — the plain-registry case', () => {
    // TinyValidators has no court(). Warning here would attach a permanent caveat
    // about a contract the registry does not have.
    for (const c of [undefined, null, '', '0x0000000000000000000000000000000000000000']) {
      const r = assessCourtBinding({ court: c as any, courtValidators: OUT, incoming: IN, outgoing: OUT })
      expect(r.ok).toBe(true)
      expect(r.reason).toBeNull()
    }
  })

  it('🔴 treats an UNREADABLE validators() as unknown, never as agreement', () => {
    // A caller that never asked and a court whose validators() reverted both land
    // here. Reading either as "fine" turns the check off exactly when the contract
    // is not what we assume — the c21 lesson about unchecked meaning unknown.
    for (const bad of [undefined, null, '']) {
      const r = assessCourtBinding({ court: COURT, courtValidators: bad as any, incoming: IN, outgoing: OUT })
      expect(r.ok).toBe(true)
      expect(r.unknown).toBe(true)
      expect(r.reason).toContain('UNKNOWN')
      expect(r.reason).toContain('only proves the court answers')
    }
  })

  it('reports unknown rather than agreement when the incoming address is missing', () => {
    const r = assessCourtBinding({ court: COURT, courtValidators: OUT })
    expect(r.unknown).toBe(true)
    expect(r.reason).toContain('no incoming registry address')
  })

  it('survives junk without inventing a binding', () => {
    for (const bad of [undefined, null, {}, 5, 'x']) {
      expect(() => assessCourtBinding(bad as any)).not.toThrow()
    }
    expect(assessCourtBinding({} as any).ok).toBe(true)
  })
})

describe('c24: the aggregate verdict WARNS on a stale court but does not refuse', () => {
  it('🔴 surfaces the stale binding as a warning while the swap stays survivable', () => {
    // Losing verdict accuracy is strictly better than halting the chain, and it is
    // fixable after the swap. Refusing here trades a real halt for a bookkeeping
    // defect — c17's mistake in the other direction.
    const r = assessRegistrySwap({
      ...healthy(), court: COURT, courtValidators: OUT, incomingLabel: IN, outgoingLabel: OUT,
    })
    expect(r.ok).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.warnings.join(' ')).toContain('immutable')
    expect(r.courtBinding.ok).toBe(false)
  })

  it('🔴 stays silent when the court describes the incoming registry', () => {
    // The load-bearing half: a check that fires on a healthy swap gets ignored.
    const r = assessRegistrySwap({
      ...healthy(), court: COURT, courtValidators: IN, incomingLabel: IN, outgoingLabel: OUT,
    })
    expect(r.ok).toBe(true)
    expect(r.courtBinding.ok).toBe(true)
    expect(r.warnings.join(' ')).not.toContain('immutable')
  })

  it('🔴 is INDEPENDENT of courtHealthy — the two failures are different and can co-occur', () => {
    // The whole point of a separate check: courtHealthy() is satisfied either way,
    // so a court that answers about the wrong registry passes the existing one.
    const both = assessRegistrySwap({
      ...healthy(), courtHealthy: false, court: COURT, courtValidators: OUT, incomingLabel: IN, outgoingLabel: OUT,
    })
    expect(both.warnings.filter((w: string) => w.includes('court')).length).toBeGreaterThanOrEqual(2)
    const stale = assessRegistrySwap({
      ...healthy(), courtHealthy: true, court: COURT, courtValidators: OUT, incomingLabel: IN, outgoingLabel: OUT,
    })
    expect(stale.warnings.join(' ')).toContain('immutable')
  })

  it('says nothing when the caller supplies no court at all — the pre-c24 call shape', () => {
    // Every existing caller omits these fields. They must not start warning.
    const r = assessRegistrySwap(healthy())
    expect(r.ok).toBe(true)
    expect(r.courtBinding.ok).toBe(true)
    expect(r.warnings.join(' ')).not.toContain('immutable')
  })
})

describe('c24: the preflight SCRIPT reads BOTH ends of the registry↔court cycle', () => {
  const src = readFileSync(join(process.cwd(), 'chain/multinode/scripts/swap-preflight.mjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('🔴 reads court() on the registry AND validators() back off the court', () => {
    // Reading only court() proves the registry names a court — which was never in
    // doubt. The back-read is the entire check, and it is the half a plausible
    // implementation omits.
    expect(code).toMatch(/const court = await tryRead\(pub, incoming, 'court'\)/)
    expect(code).toMatch(/const courtValidators = court \? await tryRead\(pub, court, 'validators', COURT_ABI\) : undefined/)
  })

  it('🔴 passes both, plus the OUTGOING label, into the policy', () => {
    // Without outgoingLabel the policy cannot tell "stale pointer" from "mis-wired
    // deploy", and its fallback — "a THIRD registry" — is the wrong diagnosis for
    // the case that actually exists on 8470.
    expect(code).toMatch(/court,/)
    expect(code).toMatch(/courtValidators,/)
    expect(code).toMatch(/outgoingLabel:\s*outgoing/)
  })

  it('🔴 reads validators() through a COURT abi, not the registry abi', () => {
    // REGISTRY_ABI has no validators(), so reusing it would make tryRead swallow an
    // AbiFunctionNotFoundError and return undefined — the check would read
    // "unknown" forever while looking wired up.
    expect(code).toMatch(/const COURT_ABI = \[/)
    const abiBlock = code.slice(code.indexOf('const COURT_ABI'), code.indexOf('function arg'))
    expect(abiBlock).toMatch(/name: 'validators'/)
    expect(code).toMatch(/async function tryRead\(pub, address, functionName, abi = REGISTRY_ABI\)/)
    expect(code).toMatch(/pub\.readContract\(\{ address, abi, functionName \}\)/)
  })

  it('prints what the court describes, so a reader sees it without parsing a warning', () => {
    expect(code).toMatch(/court .*describes/)
  })
})
