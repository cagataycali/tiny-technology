// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Plain .mjs shared with chain/ scripts (same arrangement as chain/relayer-gas.mjs
// and its test) — resolved through the @ alias, no shim needed.
import {
  assessValidatorSet,
  assessSetLiveness,
  qbftQuorum,
  validatorSetSummary,
} from '@/chain/multinode/validator-set-health.mjs'

/**
 * 🪑 The validator-set health predicate.
 *
 * This module replaced a one-line assertion in the P1 acceptance suite:
 *
 *     validators.length === NODES
 *
 * which passed for six cycles and then failed on a perfectly healthy chain — a
 * stranger had staked, rotate() had seated them, and 4 nodes reported 5
 * validators. The test was asserting "nobody joined" on a chain whose entire
 * premise is that anyone can. These tests exist to make sure the replacement
 * cannot regress to that shape: growth must PASS, and the things besu genuinely
 * cannot survive must FAIL.
 */

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const set = (n: number) => Array.from({ length: n }, (_, i) => addr(i + 1))

describe('assessValidatorSet — growth is success, not drift', () => {
  it('accepts a set LARGER than the node count — the bug this module exists for', () => {
    // 4 nodes, 5 seats: exactly the state that failed the old assertion.
    const r = assessValidatorSet(set(5), { min: 4, max: 21 })
    expect(r.ok).toBe(true)
    expect(r.count).toBe(5)
    expect(r.reason).toBeNull()
  })

  it('accepts the set at exactly the floor and exactly the cap', () => {
    // Inclusive bounds, deliberately: MIN_VALIDATORS seats is the floor the
    // contract itself refuses to go below, and MAX_VALIDATORS is a seat count
    // the contract will actually seat. An exclusive check here would fail the
    // chain in its own legal configuration.
    expect(assessValidatorSet(set(4), { min: 4, max: 21 }).ok).toBe(true)
    expect(assessValidatorSet(set(21), { min: 4, max: 21 }).ok).toBe(true)
  })

  it('says growth is the point, so an operator does not read it as drift', () => {
    const msg = validatorSetSummary(5, 4, { min: 4, max: 21 })
    expect(msg).toMatch(/5 validator/)
    expect(msg).toMatch(/outside stake is seated/)
    // And no such claim when the set simply matches what we run.
    expect(validatorSetSummary(4, 4, { min: 4, max: 21 })).not.toMatch(/outside stake/)
  })
})

describe('assessValidatorSet — the failures besu cannot survive', () => {
  it('rejects an EMPTY set with the halt besu actually reports', () => {
    // The one case with no in-contract recovery: no proposer, chain stops. It
    // gets its own message rather than being folded into "below the floor",
    // because the operator response is different and urgent.
    const r = assessValidatorSet([], { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/EMPTY/)
    expect(r.reason).toMatch(/halts/)
    expect(r.reason).toMatch(/no proposer/)
  })

  it('rejects a set below the BFT floor and explains what is lost', () => {
    const r = assessValidatorSet(set(3), { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    // The interesting failure: blocks keep coming, so nothing announces it.
    expect(r.reason).toMatch(/no longer BFT fault-tolerant/)
    expect(r.reason).toMatch(/3f\+1/)
  })

  it('rejects a set over the seat cap and names the reason as liveness', () => {
    const r = assessValidatorSet(set(22), { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/O\(n²\)|O\(n\^2\)/)
  })

  it('rejects DUPLICATES, counting distinct signers not array entries', () => {
    // Besu sorts the returned array but does not dedupe, so a doubled address is
    // counted twice toward every quorum: 4 entries with one duplicate is really
    // 3 signers claiming a BFT majority they don't have.
    const dupes = [addr(1), addr(2), addr(3), addr(1)]
    const r = assessValidatorSet(dupes, { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    expect(r.count).toBe(3) // distinct, not 4
    expect(r.reason).toMatch(/duplicate/)
    expect(r.reason).toMatch(/does not dedupe/)
  })

  it('treats the same address in two checksum forms as ONE signer', () => {
    // Mixed-case is how a real ABI decoder and a real RPC differ. Comparing raw
    // strings would call this a healthy set of 4 while only 3 keys can sign.
    //
    // ⚠️ The address must contain HEX LETTERS or this test asserts nothing: my
    // first fixture used the zero-padded addr(1), whose only non-zero digit is
    // `1`, so upper/lower-casing it produced an identical string and the "two
    // forms" were one form. A case-insensitivity test needs a case to differ in.
    const real = '0x13bd8be870424bbb97ad87ee0556b987c96e9607' // a live 8470 validator
    const mixed = [real, real.toUpperCase().replace('0X', '0x'), addr(2), addr(3)]
    expect(mixed[0]).not.toBe(mixed[1]) // the fixture really does hold two forms
    const r = assessValidatorSet(mixed, { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    expect(r.count).toBe(3)
    expect(r.reason).toMatch(/duplicate/)
  })

  it('rejects non-arrays and non-addresses rather than counting them', () => {
    // A failed RPC returns null, and `null?.length` reads as absent rather than
    // as a broken set. Each of these must be refused, not silently sized.
    for (const bad of [null, undefined, 'four', 42, {}]) {
      const r = assessValidatorSet(bad as unknown, { min: 4, max: 21 })
      expect(r.ok, `${JSON.stringify(bad)} should be refused`).toBe(false)
      expect(r.reason).toMatch(/did not return an array/)
    }
    const r = assessValidatorSet([addr(1), 'not-an-address', addr(2), addr(3)], { min: 4, max: 21 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not addresses/)
  })

  it('defaults to the 4–21 range when bounds are omitted', () => {
    // The acceptance script reads bounds from the deployment file; when that file
    // is absent (a pre-P2 header-mode devnet) the defaults must still be the
    // chain's real parameters, not something laxer.
    expect(assessValidatorSet(set(3)).ok).toBe(false)
    expect(assessValidatorSet(set(4)).ok).toBe(true)
    expect(assessValidatorSet(set(21)).ok).toBe(true)
    expect(assessValidatorSet(set(22)).ok).toBe(false)
  })
})

describe('the acceptance script uses the predicate, and the bounds are the CHAIN’s', () => {
  const root = process.cwd()

  it('devnet-e2e no longer asserts seat-count equals node-count', () => {
    const src = readFileSync(join(root, 'chain/multinode/scripts/devnet-e2e.mjs'), 'utf8')
    // Anchored to the call, not the file: a file-wide match would pass on the
    // explanatory comment that quotes the old assertion on purpose.
    expect(src).toMatch(/const health = assessValidatorSet\(validators, bounds\)/)
    expect(src).toMatch(/ok\(\s*health\.ok,/)
    // The old rule must be gone from the executable code. It still appears in a
    // comment (deliberately, as the record of why), so strip comment lines first.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/validators\.length === NODES/)
  })

  it('reads the seat bounds from the deployment file, not from a local copy', () => {
    // MIN/MAX_VALIDATORS are contract parameters. A hardcoded duplicate here
    // would keep passing after a redeploy changed them — the test would then be
    // measuring a number nobody enforces.
    const src = readFileSync(join(root, 'chain/multinode/scripts/devnet-e2e.mjs'), 'utf8')
    expect(src).toMatch(/deployment\.minValidators/)
    expect(src).toMatch(/deployment\.maxValidators/)
  })

  it('the defaults match what the live 8470 deployment actually uses', () => {
    // If this fails, the fallback used on a fresh devnet disagrees with the
    // chain we run — which is how a "passing" suite ends up checking nothing.
    let d: any
    try {
      d = JSON.parse(
        readFileSync(join(process.env.HOME || '', '.tiny-chain/multinode/validators-deployment.json'), 'utf8'),
      )
    } catch {
      return // no local devnet on this machine (e.g. CI) — the unit rules above still hold
    }
    expect(assessValidatorSet(set(d.minValidators)).ok).toBe(true)
    expect(assessValidatorSet(set(d.minValidators - 1)).ok).toBe(false)
    expect(assessValidatorSet(set(d.maxValidators)).ok).toBe(true)
  })
})

describe('qbftQuorum — the number taken from the besu jar, not the literature', () => {
  it('is ceil(2n/3), matching BftHelpers.calculateRequiredValidatorQuorum', () => {
    // Decompiled from the SHIPPED besu 26.7.0:
    //   calculateRequiredValidatorQuorum(int n) -> Util.fastDivCeiling(2 * n, 3)
    // Pinned as a table because every plausible neighbour formula agrees on the
    // 3f+1 sizes and diverges elsewhere — and each wrong one UNDERSTATES how many
    // validators must be alive, i.e. errs toward calling a stalled chain healthy.
    const table: Array<[number, number]> = [
      [1, 1], [2, 2], [3, 2], [4, 3], [5, 4], [6, 4], [7, 5],
      [10, 7], [13, 9], [21, 14],
    ]
    for (const [seats, quorum] of table) {
      expect(qbftQuorum(seats), `${seats} seats`).toBe(quorum)
    }
  })

  it('differs from floor(2n/3)+1 exactly where that formula is wrong', () => {
    // The most common misremembering. It agrees on most sizes, so a test that
    // only sampled n=4 would not notice the substitution.
    const n = 3
    expect(qbftQuorum(n)).toBe(2)
    expect(Math.floor((2 * n) / 3) + 1).toBe(3)
  })

  it('tolerates f=1 at 4 seats and STILL f=1 at 5 — the trap that halted 8470', () => {
    // 🔑 Growing 4 → 5 seats buys NO extra fault tolerance while raising the
    // signing bar from 3 to 4. So a fifth seat backed by no process is strictly
    // worse than no fifth seat: same f, one more signature required.
    expect(4 - qbftQuorum(4)).toBe(1)
    expect(5 - qbftQuorum(5)).toBe(1)
    expect(qbftQuorum(5)).toBeGreaterThan(qbftQuorum(4))
  })
})

describe('assessSetLiveness — the check whose absence halted the devnet', () => {
  const root = process.cwd()

  it('FLAGS the exact state that halted 8470: 5 seats, 4 live, margin 0', () => {
    // The real incident. assessValidatorSet called this healthy (it is a legal
    // set) and the chain died an hour later when one of the four went away.
    const seats = set(5)
    const proposers = seats.slice(0, 4)
    const r = assessSetLiveness(seats, proposers, { window: 10 })
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(false)
    expect(r.seats).toBe(5)
    expect(r.live).toBe(4)
    expect(r.quorum).toBe(4)
    expect(r.margin).toBe(0)
    expect(r.silent).toEqual([addr(5).toLowerCase()])
    // The message must name the recovery and its deadline — this state is
    // unrecoverable on-chain once it tips, because rotate() needs a quorum.
    expect(r.reason).toMatch(/EXACTLY quorum/)
    // ⚠️ And it must NOT advise rotate() as the fix. The first draft of this
    // module did, and simulateContract against the live 8470 disproved it: the
    // abandoned seat held 2.5B stake against the founders' 2.0B, so rotate()
    // succeeds and re-seats the ghost. Seats follow stake, and a joiner who
    // out-staked everyone to get in keeps the seat when its process dies.
    expect(r.reason).toMatch(/Do NOT assume rotate\(\) evicts/)
    expect(r.reason).toMatch(/making another validator LIVE/)
  })

  it('and assessValidatorSet calls that very same set HEALTHY — both are right', () => {
    // Not a contradiction: one judges the set's shape, the other whether the set
    // can act. This assertion is here so nobody "fixes" the overlap by deleting
    // one of them.
    const seats = set(5)
    expect(assessValidatorSet(seats, { min: 4, max: 21 }).ok).toBe(true)
    expect(assessSetLiveness(seats, seats.slice(0, 4), { window: 10 }).ok).toBe(false)
  })

  it('accepts a set with a real margin', () => {
    const seats = set(4)
    const r = assessSetLiveness(seats, seats, { window: 8 })
    expect(r.ok).toBe(true)
    expect(r.quorum).toBe(3)
    expect(r.margin).toBe(1)
    expect(r.silent).toEqual([])
    expect(r.reason).toBeNull()
  })

  it('says CANNOT COMMIT, not merely thin, once live drops below quorum', () => {
    const seats = set(5)
    const r = assessSetLiveness(seats, seats.slice(0, 3), { window: 10 })
    expect(r.ok).toBe(false)
    expect(r.live).toBe(3)
    expect(r.margin).toBe(-1)
    expect(r.reason).toMatch(/CANNOT make blocks/)
    // The whole point: the on-chain fix is gone at this moment.
    expect(r.reason).toMatch(/needs the quorum that is missing/)
    expect(r.reason).toMatch(/OFF-CHAIN/)
    expect(r.silent).toHaveLength(2)
  })

  it('refuses to answer when the evidence window is shorter than one round-robin', () => {
    // A 3-block sample of a 5-seat chain shows at most 3 proposers, so "2 seats
    // are silent" is an artefact of the sample, not a fact about the chain.
    // Guessing either way is worse than declining: a false stall trains an
    // operator to ignore this check, and a false pass is the bug it exists for.
    const seats = set(5)
    const r = assessSetLiveness(seats, seats.slice(0, 3), { window: 3 })
    expect(r.unknown).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too short/)
    expect(r.reason).toMatch(/at least 5/)
  })

  it('answers normally when the window exactly covers the seats', () => {
    // Boundary: window === seats is sufficient, since one full round-robin gives
    // every seat its turn. An off-by-one here would make the suite decline to
    // answer on the commonest sampling choice.
    const seats = set(4)
    expect(assessSetLiveness(seats, seats, { window: 4 }).unknown).toBe(false)
    expect(assessSetLiveness(seats, seats, { window: 3 }).unknown).toBe(true)
  })

  it('works with no window given at all — evidence quality is then the caller\'s claim', () => {
    const seats = set(4)
    const r = assessSetLiveness(seats, seats)
    expect(r.unknown).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('ignores proposers that are no longer seated', () => {
    // Real during a rotation: a validator that produced a block and was then
    // un-seated is evidence about the chain but not about THIS set's quorum.
    // Counting it would inflate the margin using a signer who can no longer sign.
    const seats = set(4)
    const stranger = addr(99)
    const r = assessSetLiveness(seats, [...seats.slice(0, 2), stranger], { window: 8 })
    expect(r.live).toBe(2)
    expect(r.ok).toBe(false)
    expect(r.silent).toHaveLength(2)
  })

  it('is case-insensitive on both sides — a checksum is not a different validator', () => {
    // getValidators() returns lowercase; eth_getBlockByNumber().miner comes back
    // EIP-55 checksummed. Comparing raw strings would report every seat as silent
    // and declare a perfectly live chain dead.
    //
    // ⚠️ Uses hex LETTERS deliberately. The `addr()` helper builds addresses out
    // of zeros and digits, so `.toUpperCase()` on those is a no-op — the first
    // version of this test passed against a build with the lowercasing REMOVED.
    // A case test whose fixture has no letters in it tests nothing.
    const seats = ['0xaabbccddeeff00112233445566778899aabbccdd', '0xdeadbeef00000000000000000000000000000abc',
                   '0xfacefeed11111111111111111111111111111111', '0xcafebabe22222222222222222222222222222222']
    const shouting = seats.map((s) => '0x' + s.slice(2).toUpperCase())
    expect(shouting[0]).not.toBe(seats[0]) // the fixture is genuinely mixed-case
    const r = assessSetLiveness(seats, shouting, { window: 8 })
    expect(r.ok).toBe(true)
    expect(r.live).toBe(4)
    expect(r.silent).toEqual([])
    // …and the other direction: checksummed SEATS, lowercase proposers.
    const r2 = assessSetLiveness(shouting, seats, { window: 8 })
    expect(r2.ok).toBe(true)
    expect(r2.live).toBe(4)
  })

  it('deduplicates seats before computing quorum', () => {
    // assessValidatorSet REJECTS duplicates; this one must not silently compute a
    // higher quorum from them, or the two modules would disagree about how many
    // signers exist while both looking correct.
    const seats = [...set(4), addr(1)]
    const r = assessSetLiveness(seats, set(4), { window: 10 })
    expect(r.seats).toBe(4)
    expect(r.quorum).toBe(3)
    expect(r.ok).toBe(true)
  })

  it('handles an empty set and non-arrays without throwing', () => {
    // A monitor that crashes on a malformed RPC reply reports nothing at all,
    // which is the same as not having the check.
    expect(assessSetLiveness([], [], { window: 4 }).ok).toBe(false)
    expect(assessSetLiveness([], []).reason).toMatch(/no seats/)
    expect(assessSetLiveness(null as never, null as never).ok).toBe(false)
    expect(assessSetLiveness(undefined as never, ['0x1'] as never).seats).toBe(0)
  })

  it('is wired into the P1 suite, at the call site', () => {
    // A file-wide match would pass on the import line alone. Anchor to the call.
    const src = readFileSync(join(root, 'chain/multinode/scripts/devnet-e2e.mjs'), 'utf8')
    expect(src).toMatch(/const liveness = assessSetLiveness\(validators, \[\.\.\.proposers\], \{ window \}\)/)
    expect(src).toMatch(/ok\(\s*liveness\.ok,/)
  })

  it('the P1 suite sizes its sample off the SEAT COUNT, not the node count', () => {
    // The old `NODES * 2` window is only coincidentally long enough: seats grow
    // when strangers join, and at 9+ seats a 8-block sample would make the new
    // check decline to answer on every run.
    const src = readFileSync(join(root, 'chain/multinode/scripts/devnet-e2e.mjs'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toMatch(/seatCount \* 2/)
    expect(code).not.toMatch(/length: Math\.min\(NODES \* 2, common\)/)
  })
})
