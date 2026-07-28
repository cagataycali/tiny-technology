// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Plain .mjs shared with chain/ scripts (same arrangement as validator-set-health.mjs
// and chain/relayer-gas.mjs) — resolved through the @ alias, no shim needed.
import {
  mayEvictForAbsence,
  attendanceEnforceable,
  MIN_PARTICIPATION_BPS,
  MIN_ABSENT_STREAK,
} from '@/chain/multinode/attendance-policy.mjs'

/**
 * ⚖️ When may a seat be taken for absence?
 *
 * The liveness rule is the most dangerous rule on this chain, because every other
 * one REFUSES in its failure mode and this one ACTS. rotate() below the floor
 * reverts and the old set keeps validating; a broken court fails open. An eviction
 * rule that misfires REMOVES WORKING VALIDATORS, and it does so exactly when
 * evidence is scarce — during the trouble that made them look silent.
 *
 * So most of these tests are about REFUSING to evict. Each gate blocks a distinct
 * way of being wrong, and the load-bearing ones are the tests that make a single
 * gate the only thing standing between a plausible input and a wrongful eviction.
 */

// Real hex letters, not just digits and zeros. c15's lesson: an address built from
// `n.toString(16).padStart(40,'0')` contains no letters, so a test that depends on
// case handling passes against a build with the case handling REMOVED.
const A = '0xAAbbCC0000000000000000000000000000000001'
const B = '0xBBccDD0000000000000000000000000000000002'
const C = '0xCCddEE0000000000000000000000000000000003'
const D = '0xDDeeFF0000000000000000000000000000000004'
const E = '0xEEff110000000000000000000000000000000005'
const F = '0xFF11220000000000000000000000000000000006'
const GHOST = '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB' // c15's real one

const SIX = [A, B, C, D, E, GHOST]

/** A decision that passes every gate: 6 seats, 5 attesting, ghost absent 3 epochs. */
const goodCase = (over: Record<string, unknown> = {}) => ({
  candidate: GHOST,
  seats: SIX,
  absentStreak: 3,
  participation: 5,
  liveSeats: [A, B, C, D, E],
  ...over,
})

describe('mayEvictForAbsence — the happy path exists, so the refusals mean something', () => {
  it('evicts a genuinely abandoned seat when all three gates hold', () => {
    const r = mayEvictForAbsence(goodCase())
    expect(r.mayEvict).toBe(true)
    expect(r.gates).toEqual({ participation: true, streak: true, margin: true })
    // 5 live minus the evicted seat = 5 (the ghost was never live), quorum for 5 = 4.
    expect(r.liveAfter).toBe(5)
    expect(r.quorumAfter).toBe(4)
    expect(r.reason).toMatch(/margin 1/)
  })

  it('is case-insensitive about addresses on every input', () => {
    // The seat list, the candidate, and the live list all arrive from different
    // sources (a contract read, an operator, block miners) with different casing.
    const r = mayEvictForAbsence(goodCase({
      candidate: GHOST.toLowerCase(),
      seats: SIX.map((s) => s.toUpperCase().replace('0X', '0x')),
      liveSeats: [A.toLowerCase(), B, C.toUpperCase().replace('0X', '0x'), D, E],
    }))
    expect(r.mayEvict).toBe(true)
    // Prove the fixture is genuinely mixed-case, or this test tests nothing.
    expect(GHOST).not.toBe(GHOST.toLowerCase())
    expect(A.toUpperCase().replace('0X', '0x')).not.toBe(A)
  })
})

describe('🔴 gate 1 — participation: an unused record is not evidence of absence', () => {
  it('REFUSES at the participation the devnet actually had when attendance shipped', () => {
    // 1 of 6. This is not a hypothetical: it is what the acceptance suite measured,
    // and TinyIssuance.creditBlock() — the same shape of opt-in record — had sat at
    // zero calls for 8,000 blocks. A rule switched on here evicts five honest seats.
    const r = mayEvictForAbsence(goodCase({ participation: 1 }))
    expect(r.mayEvict).toBe(false)
    expect(r.gates.participation).toBe(false)
    expect(r.reason).toMatch(/NOBODY ATTESTS/)
    expect(r.participationBps).toBe(1666)
  })

  it('REFUSES at zero participation — the state every deployment starts in', () => {
    const r = mayEvictForAbsence(goodCase({ participation: 0 }))
    expect(r.mayEvict).toBe(false)
    expect(r.gates.participation).toBe(false)
  })

  it('the threshold is two-thirds, matching QBFT quorum rather than a feel', () => {
    expect(MIN_PARTICIPATION_BPS).toBe(6667)
    // 4 of 6 = 6666bps, one basis point short: refused.
    expect(mayEvictForAbsence(goodCase({ participation: 4, liveSeats: [A, B, C, D] })).mayEvict).toBe(false)
    expect(mayEvictForAbsence(goodCase({ participation: 4 })).gates.participation).toBe(false)
    // 5 of 6 = 8333bps: allowed.
    expect(mayEvictForAbsence(goodCase({ participation: 5 })).gates.participation).toBe(true)
  })

  it('participation is counted against SEATS, not against the attestor list', () => {
    // Same absolute participation, different seat count ⇒ different verdict. If the
    // denominator were anything else this would not move.
    const nine = [...SIX, F, '0x1122330000000000000000000000000000000007', '0x2233440000000000000000000000000000000008']
    const r = mayEvictForAbsence(goodCase({ seats: nine, participation: 5 }))
    expect(r.gates.participation).toBe(false) // 5/9 = 5555bps
    expect(r.participationBps).toBe(5555)
  })

  it('garbage participation is not silently generous', () => {
    for (const participation of [NaN, undefined, null, 'five', -3] as unknown[]) {
      const r = mayEvictForAbsence(goodCase({ participation }))
      expect(r.mayEvict).toBe(false)
      expect(r.gates.participation).toBe(false)
    }
  })
})

describe('gate 2 — streak: one quiet epoch is a blip', () => {
  it('REFUSES a single absent epoch', () => {
    const r = mayEvictForAbsence(goodCase({ absentStreak: 1 }))
    expect(r.mayEvict).toBe(false)
    expect(r.gates.streak).toBe(false)
    expect(r.gates.participation).toBe(true) // gate 1 passed: this is gate 2's refusal
    expect(r.reason).toMatch(/blip/)
  })

  it('the boundary is exact', () => {
    expect(MIN_ABSENT_STREAK).toBe(3)
    expect(mayEvictForAbsence(goodCase({ absentStreak: 2 })).mayEvict).toBe(false)
    expect(mayEvictForAbsence(goodCase({ absentStreak: 3 })).mayEvict).toBe(true)
  })

  it('a streak at the record`s lookback CAP counts — more evidence, not less', () => {
    // MAX_LOOKBACK caps the reported streak. Treating a capped value as a shortfall
    // would make the longest-absent validators the hardest to evict.
    const r = mayEvictForAbsence(goodCase({ absentStreak: 64, streakAtCap: true }))
    expect(r.mayEvict).toBe(true)
  })

  it('a caller-supplied threshold is honoured in both directions', () => {
    expect(mayEvictForAbsence(goodCase({ absentStreak: 2 }), { minStreak: 2 }).mayEvict).toBe(true)
    expect(mayEvictForAbsence(goodCase({ absentStreak: 3 }), { minStreak: 10 }).mayEvict).toBe(false)
  })
})

describe('🔴 gate 3 — margin: a rule that evicts below quorum kills the chain', () => {
  it('REFUSES when the remaining live set would be exactly quorum', () => {
    // 6 seats, 4 live (excluding the ghost). Evicting leaves 5 seats, quorum 4, and
    // 4 live — one more failure halts the chain. This is c15's halt, caused by the
    // rule meant to prevent it.
    const r = mayEvictForAbsence(goodCase({ participation: 5, liveSeats: [A, B, C, D] }))
    expect(r.mayEvict).toBe(false)
    expect(r.gates.margin).toBe(false)
    expect(r.liveAfter).toBe(4)
    expect(r.quorumAfter).toBe(4)
    expect(r.reason).toMatch(/one more failure halts the chain/)
  })

  it('REFUSES when the remaining live set is BELOW quorum', () => {
    const r = mayEvictForAbsence(goodCase({ participation: 5, liveSeats: [A, B, C] }))
    expect(r.mayEvict).toBe(false)
    expect(r.gates.margin).toBe(false)
    expect(r.reason).toMatch(/COULD NOT COMMIT BLOCKS/)
  })

  it('🔴 REFUSES when NO independent liveness evidence is supplied', () => {
    // The dangerous default. A rule that treats missing evidence as "fine" evicts
    // hardest during an outage — the exact moment the record is least trustworthy.
    const { liveSeats, ...withoutEvidence } = goodCase()
    const r = mayEvictForAbsence(withoutEvidence)
    expect(r.mayEvict).toBe(false)
    expect(r.gates.margin).toBe(false)
    expect(r.reason).toMatch(/margin check cannot run/)
  })

  it('the liveness evidence must be INDEPENDENT of the attendance record', () => {
    // Documented by behaviour: liveSeats is a separate argument, so a caller passing
    // the attestor list would be passing the same evidence twice. The test that
    // matters is that an EMPTY live list can never authorise an eviction, which is
    // what a total outage looks like through the attendance record alone.
    const r = mayEvictForAbsence(goodCase({ liveSeats: [] }))
    expect(r.mayEvict).toBe(false)
    expect(r.liveAfter).toBe(0)
  })

  it('ignores live addresses that are not seated', () => {
    // A proposer that has been rotated out is real evidence about the chain and says
    // nothing about THIS set's quorum — same rule as assessSetLiveness.
    const r = mayEvictForAbsence(goodCase({ liveSeats: [A, B, C, D, F, '0x9999990000000000000000000000000000000099'] }))
    expect(r.liveAfter).toBe(4) // A,B,C,D — F and the stranger are not seated
    expect(r.mayEvict).toBe(false)
  })

  it('quorum after eviction is ceil(2n/3) of the SHRUNKEN set', () => {
    // 7 seats -> 6 after eviction, quorum 4. Off-by-one neighbours would give 5,
    // and each wrong version understates how many validators must survive.
    const seven = [A, B, C, D, E, F, GHOST]
    const r = mayEvictForAbsence(goodCase({
      seats: seven, participation: 6, liveSeats: [A, B, C, D, E],
    }))
    expect(r.quorumAfter).toBe(4)
    expect(r.liveAfter).toBe(5)
    expect(r.mayEvict).toBe(true)
  })
})

describe('🔴 the contradiction case: a live validator with an empty record', () => {
  it('REFUSES to evict a seat that IS proposing blocks', () => {
    // This is the takeover vector in its final form. A validator that produces blocks
    // but does not run an attest loop is a WORKING validator with no record. If the
    // rule evicted it, running the attest loop would become mandatory to keep a seat,
    // and whoever automated it first could clear the set.
    const r = mayEvictForAbsence(goodCase({
      liveSeats: [A, B, C, D, E, GHOST], // the candidate is live!
    }))
    expect(r.mayEvict).toBe(false)
    expect(r.reason).toMatch(/PROPOSING BLOCKS/)
    expect(r.reason).toMatch(/not an absent one/)
  })

  it('and the contradiction outranks a passing margin', () => {
    // Margin would be fine here (5 live remain), so only the contradiction check
    // stands between this input and a wrongful eviction.
    const r = mayEvictForAbsence(goodCase({
      seats: [A, B, C, D, E, F, GHOST],
      participation: 6,
      liveSeats: [A, B, C, D, E, F, GHOST],
    }))
    expect(r.mayEvict).toBe(false)
    expect(r.liveAfter).toBe(6)
    expect(r.quorumAfter).toBe(4)
  })
})

describe('mayEvictForAbsence — malformed input claims nothing', () => {
  it('an unseated candidate is a category error, not a verdict about conduct', () => {
    const r = mayEvictForAbsence(goodCase({ candidate: F }))
    expect(r.mayEvict).toBe(false)
    expect(r.reason).toMatch(/not seated/)
  })

  it('no seats, no candidate, and junk objects all refuse', () => {
    expect(mayEvictForAbsence(goodCase({ seats: [] })).mayEvict).toBe(false)
    expect(mayEvictForAbsence(goodCase({ candidate: null })).mayEvict).toBe(false)
    expect(mayEvictForAbsence({} as never).mayEvict).toBe(false)
    expect(mayEvictForAbsence(null as never).mayEvict).toBe(false)
  })

  it('a duplicated seat is counted once, so it cannot inflate the denominator', () => {
    // Besu sorts but does not dedupe. A doubled address counted twice would lower the
    // participation ratio and make eviction harder to justify — wrong in the safe
    // direction here, but wrong, and the same dedupe protects quorumAfter.
    const r = mayEvictForAbsence(goodCase({ seats: [...SIX, A, A.toLowerCase()] }))
    expect(r.participationBps).toBe(8333) // 5/6, not 5/8
    expect(r.mayEvict).toBe(true)
  })
})

describe('attendanceEnforceable — the switch-on question, asked once', () => {
  it('NOT ready at the devnet`s real participation', () => {
    const r = attendanceEnforceable(1, 6)
    expect(r.ready).toBe(false)
    expect(r.bps).toBe(1666)
    expect(r.reason).toMatch(/not running an attest loop/)
  })

  it('ready once two-thirds of the set attests', () => {
    expect(attendanceEnforceable(4, 6).ready).toBe(false) // 6666
    expect(attendanceEnforceable(5, 6).ready).toBe(true) // 8333
    expect(attendanceEnforceable(6, 6).bps).toBe(10000)
  })

  it('refuses on no seats rather than dividing by zero', () => {
    const r = attendanceEnforceable(0, 0)
    expect(r.ready).toBe(false)
    expect(r.bps).toBe(0)
    expect(r.reason).toMatch(/no seats/)
  })

  it('garbage in, refusal out', () => {
    for (const [p, s] of [[NaN, 6], [1, NaN], [-1, 6], ['a', 'b']] as unknown[][]) {
      expect(attendanceEnforceable(p as number, s as number).ready).toBe(false)
    }
  })

  it('says the record is HONEST and the interpretation is what would be wrong', () => {
    // The phrasing matters: an operator who reads "the record is broken" fixes the
    // wrong thing, and might switch enforcement on after "fixing" it.
    expect(attendanceEnforceable(1, 6).reason).toMatch(/the record is honest/)
  })
})

describe('the contract is the spec — these break if the Solidity changes', () => {
  const sol = readFileSync(
    join(__dirname, '..', 'chain/multinode/contracts/TinyValidatorAttendance.sol'), 'utf8')

  it('attest() is gated on msg.sender == block.coinbase, and nothing weaker', () => {
    // THE security property. Anchored at the statement, not at a docblock mentioning
    // it: a file-wide match would pass on the header's own explanation.
    const code = sol.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('if (msg.sender != proposer) revert NotProposer(msg.sender, proposer)')
    expect(code).toContain('address proposer = block.coinbase;')
    // And there must be no second, weaker way in. A permissionless recorder
    // alongside this one would recreate TinyIssuance.creditBlock()'s defect where
    // nobody looks.
    const externals = code.match(/function \w+\([^)]*\) external(?! view)/g) || []
    expect(externals).toEqual(['function attest() external'])
  })

  it('the verdict enum orders EpochOpen and NoRecord before Absent', () => {
    // The test's numeric constants (and the E2E suite's) depend on this order, and a
    // reorder would silently turn "not yet" into "absent" — the c67 defect shape.
    const m = sol.match(/enum Attendance \{([^}]+)\}/)
    expect(m).toBeTruthy()
    // Strip comments BEFORE splitting: the members carry trailing `//` comments
    // that contain commas of their own, and splitting first turns prose into
    // phantom enum members (my first version reported six).
    const members = m![1]
      .replace(/\/\/[^\n]*/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    expect(members).toEqual(['EpochOpen', 'NoRecord', 'Present', 'Absent'])
  })

  it('the contract enforces nothing: no registry call, no stake, no seat change', () => {
    const code = sol.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // The registry appears exactly once, in the constructor's epoch check, and is
    // never stored — so nothing here can ever affect rotation.
    expect(code).not.toMatch(/rotate\s*\(/)
    expect(code).not.toMatch(/isActive/)
    expect(code).not.toMatch(/stakeOf/)
    expect(code).not.toMatch(/transfer(From)?\s*\(/)
    expect((code.match(/IEpochSource/g) || []).length).toBe(2) // interface decl + the one call
  })

  it('MAX_LOOKBACK bounds the streak scan, so a contract may call it', () => {
    expect(sol).toContain('uint256 public constant MAX_LOOKBACK = 64')
    const code = sol.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('while (streak < MAX_LOOKBACK)')
  })
})
