import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planStakeMigration } from '../chain/multinode/stake-migration-plan.mjs'

const MIN = BigInt('1000000000') // 1000 units, the live 8470 minStake

/** A funded, live, key-held validator — the shape that needs no help. */
const good = (i: number, free = MIN) => ({
  address: `0x${String(i).padStart(40, 'a')}`,
  live: true,
  hasKey: true,
  freeMicro: free,
})

describe('planStakeMigration — the funding that c18 assumed was free', () => {
  it('plans nothing when every validator already holds minStake', () => {
    const p = planStakeMigration({
      validators: [good(1), good(2), good(3), good(4)],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(true)
    expect(p.transfers).toEqual([])
    expect(p.stakes).toHaveLength(4)
    expect(p.steps.join(' ')).toContain('approve')
  })

  it('moves SURPLUS between validators when one is short — minting is gone', () => {
    // 3 rich founders, 1 broke joiner: the real 8470 shape.
    const p = planStakeMigration({
      validators: [
        good(1, MIN * BigInt(3)),
        good(2, MIN * BigInt(3)),
        good(3, MIN * BigInt(3)),
        good(4, BigInt(0)),
      ],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(true)
    expect(p.transfers).toHaveLength(1)
    expect(p.transfers[0].to).toBe(good(4).address)
    expect(p.transfers[0].amountMicro).toBe(MIN)
    // and it says WHY a transfer rather than a mint
    expect(p.steps.join(' ')).toContain('minting is no longer available')
  })

  it('🔴 REFUSES when the free balance genuinely is not there, and says there is no more to find', () => {
    const p = planStakeMigration({
      validators: [good(1, MIN), good(2, BigInt(0)), good(3, BigInt(0)), good(4, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    expect(p.unfunded).toHaveLength(3)
    const b = p.blockers.join(' ')
    expect(b).toContain('cannot reach minStake')
    // The three closed doors, named — so nobody re-derives them as a revert.
    expect(b).toContain('TinyIssuance')
    expect(b).toContain('StillSeated')
  })

  it('never counts a donor into poverty: surplus is balance ABOVE its own requirement', () => {
    // Two validators, one holding exactly 1.5× minStake. Handing 0.5 to the other
    // leaves neither eligible if surplus were computed as the whole balance.
    const p = planStakeMigration({
      validators: [good(1, MIN + MIN / BigInt(2)), good(2, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    // it moved at most the surplus, so validator 1 stays fundable
    const moved = p.transfers.reduce((a: bigint, t: any) => a + t.amountMicro, BigInt(0))
    expect(moved).toBeLessThanOrEqual(MIN / BigInt(2))
    expect(p.unfunded.map((u: any) => u.address)).toEqual([good(2).address])
  })
})

describe('the two moments have DIFFERENT seat sets — checking one is how this fails in production', () => {
  it('blocks at the TRANSITION when the constructor set cannot sign, whatever the stake says', () => {
    // 6 seats inherited, only 2 live. Every live one is richly funded, so a
    // stake-only check would pass this happily.
    const p = planStakeMigration({
      validators: [
        good(1, MIN * BigInt(5)),
        good(2, MIN * BigInt(5)),
        { address: '0xdead1', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xdead2', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xdead3', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xdead4', live: false, hasKey: true, freeMicro: MIN },
      ],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    expect(p.atTransition).toEqual({ seats: 6, quorum: 4, live: 2 })
    const b = p.blockers.join(' ')
    expect(b).toContain('AT THE TRANSITION')
    // The distinction that makes this blocker worth having.
    expect(b).toContain('CONSTRUCTOR')
  })

  it('🔴 blocks the plan that SURVIVES the transition and halts at the first rotate()', () => {
    // The nastiest shape: the born set is 3 live of 3 (fine, quorum 2), but only
    // 2 of them can be funded, so rotate() reseats 2 with quorum 2 while one of
    // them is dead → halt at an epoch boundary, hours later.
    const p = planStakeMigration({
      validators: [
        good(1, MIN),
        good(2, MIN),
        { address: '0xlive3', live: true, hasKey: true, freeMicro: BigInt(0) },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    // The transition itself is survivable — that is the trap.
    expect(p.atTransition.live).toBeGreaterThanOrEqual(p.atTransition.quorum)
    expect(p.ok).toBe(false)
    expect(p.blockers.join(' ')).toContain('cannot reach minStake')
  })

  it('names the epoch-boundary failure explicitly when rotation loses quorum', () => {
    // Funded: 3, of which live: 1. Born set is live enough to pass moment 1.
    const p = planStakeMigration({
      validators: [
        good(1, MIN * BigInt(4)),
        { address: '0xz1', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xz2', live: false, hasKey: true, freeMicro: MIN },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.atTransition).toEqual({ seats: 3, quorum: 2, live: 1 })
    expect(p.afterRotation).toEqual({ seats: 3, quorum: 2, live: 1, eligible: 3 })
    expect(p.blockers.join(' ')).toContain('halt at the next epoch boundary')
  })

  it('respects the seat CAP when computing the rotated quorum', () => {
    // 30 funded candidates, cap 5 → rotate() seats 5, quorum 4, not 20.
    const p = planStakeMigration({
      validators: Array.from({ length: 30 }, (_, i) => good(i + 10, MIN)),
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 5,
    })
    expect(p.afterRotation.seats).toBe(5)
    expect(p.afterRotation.quorum).toBe(4)
  })

  it('blocks below the registry floor rather than reporting a comfortable quorum', () => {
    const p = planStakeMigration({
      validators: [good(1), good(2)],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    expect(p.blockers.join(' ')).toContain('BelowValidatorFloor')
  })
})

describe('the state facts that are invisible from the contract source', () => {
  it('warns that stake in the outgoing registry is TRAPPED, not migratable', () => {
    const p = planStakeMigration({
      validators: [
        { ...good(1), seatedOutgoing: true, stakedOutgoingMicro: MIN * BigInt(2) },
        { ...good(2), seatedOutgoing: true, stakedOutgoingMicro: MIN * BigInt(2) },
        good(3),
        good(4),
      ],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(true) // funded independently, so the plan works…
    expect(p.trappedMicro).toBe(MIN * BigInt(4)) // …but the trapped stake is still reported
    const w = p.warnings.join(' ')
    expect(w).toContain('TRAPPED')
    expect(w).toContain('StillSeated')
    // The part an operator would otherwise discover months later.
    expect(w).toContain('nobody will think to look')
  })

  it('does not count stake as trapped for a validator that is not seated in the outgoing set', () => {
    const p = planStakeMigration({
      validators: [{ ...good(1), seatedOutgoing: false, stakedOutgoingMicro: MIN * BigInt(9) }, good(2)],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.trappedMicro).toBe(BigInt(0))
    expect(p.warnings.join(' ')).not.toContain('TRAPPED')
  })

  it('🔴 never sends stake to an address we hold no key for — it would be burned', () => {
    const p = planStakeMigration({
      validators: [
        good(1, MIN * BigInt(9)),
        { address: '0xghost', live: false, hasKey: false, freeMicro: BigInt(0) },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.transfers.some((t: any) => t.to === '0xghost')).toBe(false)
    expect(p.stakes.some((s: any) => s.address === '0xghost')).toBe(false)
    expect(p.keyless).toEqual(['0xghost'])
    const w = p.warnings.join(' ')
    expect(w).toContain('sending them stake would burn it')
    expect(w).toContain('raise quorum')
  })

  it('accepts an external donor so a migration is not blocked by WHO holds the balance', () => {
    const p = planStakeMigration({
      validators: [good(1, BigInt(0)), good(2, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
      donors: [{ address: '0xtreasury', freeMicro: MIN * BigInt(2) }],
    })
    expect(p.ok).toBe(true)
    expect(p.transfers.every((t: any) => t.from === '0xtreasury')).toBe(true)
    expect(p.transfers).toHaveLength(2)
  })

  it('reports the plan STEPS in an executable order: transfer, then approve+stake, then re-verify', () => {
    const p = planStakeMigration({
      validators: [good(1, MIN * BigInt(3)), good(2, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    const t = p.steps.findIndex((s: string) => s.startsWith('transfer'))
    const s = p.steps.findIndex((s: string) => s.includes('approve'))
    const v = p.steps.findIndex((s: string) => s.includes('swap-preflight.mjs'))
    expect(t).toBeGreaterThan(-1)
    expect(s).toBeGreaterThan(t)
    expect(v).toBeGreaterThan(s)
    // 🔑 the plan asserts its own falsifiability — three cycles of this lesson
    expect(p.steps[v]).toContain('a claim about the future')
  })

  it('offers no steps at all when it refuses — a blocked plan must not read as executable', () => {
    const p = planStakeMigration({
      validators: [good(1, BigInt(0)), good(2, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 4,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    expect(p.steps).toEqual([])
  })

  it('survives junk input without inventing a fundable plan', () => {
    for (const bad of [undefined, {}, { validators: null }, { validators: [{}] }]) {
      const p = planStakeMigration(bad as any)
      expect(p.ok).toBe(false)
      expect(p.steps).toEqual([])
    }
  })

  it('treats a negative or unparseable balance as zero rather than as credit', () => {
    const p = planStakeMigration({
      validators: [
        { address: '0xa', live: true, hasKey: true, freeMicro: BigInt(-5) as any },
        { address: '0xb', live: true, hasKey: true, freeMicro: 'not-a-number' as any },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    expect(p.unfunded).toHaveLength(2)
    expect(p.unfunded[0].shortfallMicro).toBe(MIN)
  })

  it('🔴 counts liveness over the FUNDED set at rotation, not over everyone seated at birth', () => {
    // MUTANT S5 SURVIVED HERE: `rotatedLive` computed over all validators instead
    // of the funded ones. Every earlier fixture funded everybody, so the two
    // populations were identical and the mutant was invisible. This one makes them
    // DISAGREE: the only other live validator is the one that cannot be funded, so
    // counting it would claim a quorum that will not exist at the epoch boundary.
    const p = planStakeMigration({
      validators: [
        good(1, MIN), // live + funded
        { address: '0xs1', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xs2', live: false, hasKey: true, freeMicro: MIN },
        { address: '0xbroke', live: true, hasKey: true, freeMicro: BigInt(0) }, // live, NOT fundable
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.afterRotation.eligible).toBe(3)
    expect(p.afterRotation.live).toBe(1) // NOT 2 — the broke one never gets seated
    const b = p.blockers.join(' ')
    expect(b).toContain('halt at the next epoch boundary')
    expect(b).toContain('cannot reach minStake')
  })

  it('🔴 never counts a self-transfer as funding — the money would not have moved', () => {
    // MUTANT S10 SURVIVED HERE: dropping the `dn.address === v.address` guard. It
    // is unreachable via validator surplus (being short means surplus is 0), but a
    // DONOR may name an address that is also a validator, and its surplus is its
    // whole balance. Without the guard the planner "funds" 0xa from 0xa, reports a
    // green plan, and the stake() reverts on execution.
    const p = planStakeMigration({
      validators: [{ address: '0xa', live: true, hasKey: true, freeMicro: BigInt(0) }],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
      donors: [{ address: '0xa', freeMicro: MIN }],
    })
    expect(p.transfers.some((t: any) => t.from === t.to)).toBe(false)
    expect(p.ok).toBe(false)
    expect(p.unfunded.map((u: any) => u.address)).toEqual(['0xa'])
  })

  it('🔴 does not re-charge stake already posted in the incoming registry', () => {
    // The plan is N transactions signed by N keys, so a half-executed plan is the
    // NORMAL case. stake() is cumulative: asking again for the full minStake spends
    // balance that nothing needed to spend.
    const p = planStakeMigration({
      validators: [
        { ...good(1, BigInt(0)), alreadyStakedMicro: MIN },
        { ...good(2, BigInt(0)), alreadyStakedMicro: MIN },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.ok).toBe(true)
    expect(p.transfers).toEqual([]) // nothing to move: the money is already staked
    expect(p.stakes).toEqual([]) // and nothing left to stake
    expect(p.alreadyEligible).toEqual([good(1).address, good(2).address])
    expect(p.afterRotation.eligible).toBe(2)
    expect(p.steps.join(' ')).toContain('must converge, not charge twice')
  })

  it('🔴 plans only the TOP-UP for a partially staked validator, not the whole minStake', () => {
    const p = planStakeMigration({
      validators: [{ ...good(1, MIN / BigInt(2)), alreadyStakedMicro: MIN / BigInt(2) }],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.ok).toBe(true)
    expect(p.transfers).toEqual([]) // half is already staked, half is in hand
    expect(p.stakes).toHaveLength(1)
    expect(p.stakes[0].amountMicro).toBe(MIN / BigInt(2))
    expect(p.steps.join(' ')).toContain('stake() is cumulative')
  })

  it('🔴 re-running a half-executed plan CONVERGES instead of refusing', () => {
    // The whole point. Two validators, one donor's worth of money between them.
    // Run 1 moves 1000 to B and stakes both; if the re-run ignored the posted
    // stake it would demand 2000 that no longer exists and REFUSE — reading as
    // "the migration was never fundable" when in fact it half-succeeded.
    const before = planStakeMigration({
      validators: [good(1, MIN * BigInt(2)), good(2, BigInt(0))],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(before.ok).toBe(true)
    expect(before.transfers).toHaveLength(1)
    // …executed: A staked its 1000 and sent 1000 on to B, which staked it too.
    const after = planStakeMigration({
      validators: [
        { ...good(1, BigInt(0)), alreadyStakedMicro: MIN },
        { ...good(2, BigInt(0)), alreadyStakedMicro: MIN },
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(after.ok).toBe(true)
    expect(after.unfunded).toEqual([])
  })

  it('🔴 does not treat posted stake as a donatable surplus — unstake() reverts StillSeated', () => {
    // A already staked its whole balance; B has nothing. Counting the posted stake
    // as surplus would plan a transfer of money that cannot leave the registry, so
    // the plan would read GREEN and the transfer would revert on execution.
    const p = planStakeMigration({
      validators: [
        { ...good(1, BigInt(0)), alreadyStakedMicro: MIN * BigInt(3) },
        good(2, BigInt(0)),
      ],
      minStakeMicro: MIN,
      minValidators: 1,
      maxValidators: 21,
    })
    expect(p.transfers).toEqual([])
    expect(p.ok).toBe(false)
    expect(p.unfunded.map((u: any) => u.address)).toEqual([good(2).address])
  })

  it('reuses qbftQuorum rather than re-deriving ceil(BigInt(2)/3)', () => {
    // Same guard the swap policy carries: two copies of this formula is how one
    // of them drifts. 3 seats → 2, 4 → 3, 6 → 4.
    for (const [seats, quorum] of [[3, 2], [4, 3], [6, 4], [21, 14]] as const) {
      const p = planStakeMigration({
        validators: Array.from({ length: seats }, (_, i) => good(i + 1, MIN)),
        minStakeMicro: MIN,
        minValidators: 1,
        maxValidators: 100,
      })
      expect(p.afterRotation.quorum).toBe(quorum)
    }
  })
})

// ⚠️ MUTANTS S18/S19 SURVIVED THE UNIT TESTS ENTIRELY, and could not have failed
// them: they hardcode `live: true` / `hasKey: true` in the SCRIPT that reads the
// chain. The planner stays correct and is simply told a lie — a silent OFF switch
// on both of the checks this cycle exists for. A pure module can only be as honest
// as its caller, so the caller gets asserted at the source level (the c18 pattern).
describe('the planner SCRIPT must derive liveness and key-holding from reality', () => {
  // ⚠️ c22: the chain reading moved into lib/read-migration-state.mjs so the REPORT and
  // the EXECUTOR go through one reader — two copies of this logic would be two plans
  // that merely agree today, and this file is where both c21 facts live. These
  // assertions follow the logic; `report` is the thin printer that remains.
  const src = readFileSync(join(__dirname, '../chain/multinode/scripts/lib/read-migration-state.mjs'), 'utf8')
  const report = readFileSync(join(__dirname, '../chain/multinode/scripts/stake-migration-plan.mjs'), 'utf8')

  it('🔴 the report goes through the SHARED reader, not its own chain access', () => {
    expect(report).toContain("from './lib/read-migration-state.mjs'")
    expect(report).not.toContain('createPublicClient')
  })

  it('reads `live` from the observed proposers, never a constant', () => {
    expect(src).toContain('live: proposers.has(address.toLowerCase())')
    expect(src).not.toMatch(/live:\s*(true|false)\s*,/)
  })

  it('reads `hasKey` from the on-disk key scan, never a constant', () => {
    expect(src).toContain('hasKey: keys.has(address)')
    expect(src).not.toMatch(/hasKey:\s*(true|false)\s*,/)
  })

  it('scans OUTSIDE the multinode home for keys — the 8555 joiner lives elsewhere', () => {
    // A scan rooted only at HOME_DIR reports the live joiner as keyless, which
    // reads exactly like "a ghost we can never fund" and would refuse a migration
    // that is actually fundable.
    expect(src).toContain(".tiny-chain/joiner")
    expect(src).toMatch(/const roots = \[/)
  })

  it('🔴 reads the birth set as a FACT when the incoming registry exists, and PREDICTS only when it does not', () => {
    // c21: this used to always predict from the outgoing seated set. After c20's
    // deploy that prediction was wrong in a way that could not be seen from the
    // output — it warned about a keyless ghost the real registry does not seat and
    // computed quorum over 6 addresses when the chain would inherit 5. Predicting
    // when the answer is readable is guessing, and it erred toward refusing, which
    // is exactly the direction nobody investigates.
    expect(src).toMatch(/if \(incomingRaw\) \{\s*\n\s*bornSeats = \(await rd\(getAddress\(incomingRaw\), 'getValidators'\)\)/)
    // and the fallback is still the outgoing set, because that is what
    // deploy-validators-slashable would seed from — ghosts included.
    expect(src).toContain("bornSeats = (await rd(outgoing, 'getValidators'))")
    // the report must say WHICH it is: a fact and a prediction warrant different
    // levels of trust, and a number with no provenance gets the higher one.
    expect(report).toContain('from ${st.bornFrom}')
    expect(src).toContain('this is a fact, not a prediction')
    expect(src).toContain('predicted')
  })

  it('🔴 reads stake already posted in the INCOMING registry so a re-run converges', () => {
    // Without this the plan double-charges a half-executed migration and then
    // refuses for lack of funds — the failure looks like "never fundable".
    expect(src).toMatch(/incomingRaw \? rd\(getAddress\(incomingRaw\), 'stakeOf', \[address\]\) : Promise\.resolve\(0n\)/)
    expect(src).toContain('alreadyStakedMicro')
  })

  it('🔴 decides `seatedOutgoing` per address rather than assuming the whole birth set is', () => {
    // The birth set can now contain an address the outgoing registry never seated
    // (a live newcomer). Claiming its stake is trapped would report money as lost
    // that was never there.
    expect(src).toMatch(/const outgoingSeated = new Set\(/)
    expect(src).toContain('seatedOutgoing: outgoingSeated.has(address.toLowerCase())')
    expect(src).not.toMatch(/seatedOutgoing:\s*(true|false)/)
  })

  it('reads minStake/floor/cap from the INCOMING registry when one exists', () => {
    // The incoming registry's own parameters are what its rotate() enforces, and
    // they need not match the outgoing one's.
    expect(src).toContain('const paramSource = incomingRaw ? getAddress(incomingRaw) : outgoing')
  })

  it('refuses any chain that is not 8470', () => {
    expect(src).toContain('EXPECTED_CHAIN_ID = 8470')
    expect(src).toContain('The LIVE chain is 8469')
    expect(src).toMatch(/if \(chainId !== EXPECTED_CHAIN_ID\)/)
  })

  it('🔴 reads the NATIVE balance too — zero-priced gas is not a zero-balance sender', () => {
    // A tx from a 0-balance account is accepted, then never mined and never rejected.
    // It is the only failure in this whole arc with no error message anywhere.
    expect(src).toMatch(/pub\.getBalance\(\{ address \}\)/)
    expect(src).toContain('nativeWei')
  })

  it('makes no transaction — planning and reading are not executing', () => {
    for (const banned of ['writeContract', 'sendTransaction', 'createWalletClient', 'writeFileSync']) {
      expect(src).not.toContain(banned)
      expect(report).not.toContain(banned)
    }
  })
})
