import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickInitialValidators } from '../chain/multinode/initial-seat-policy.mjs'

const A = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`
/** The real 8470 shape: 6 seated, 5 of them live, one dead+keyless. */
const eight470 = () => ({
  seatedOutgoing: [A(1), A(2), A(3), A(4), A(5), A(6)],
  proposers: [A(2), A(3), A(4), A(5), A(6)],
  window: 18,
  minValidators: 4,
  maxValidators: 21,
})

describe('pickInitialValidators — the seed is a DECISION, not a read', () => {
  it('seats the live validators and leaves the silent one out', () => {
    const r = pickInitialValidators(eight470())
    expect(r.ok).toBe(true)
    expect(r.initial).toEqual([A(2), A(3), A(4), A(5), A(6)])
    expect(r.dropped).toEqual([A(1)])
  })

  it('preserves the outgoing order so an unchanged chain redeploys identically', () => {
    const a = pickInitialValidators(eight470())
    const b = pickInitialValidators({ ...eight470(), proposers: [A(6), A(2), A(5), A(3), A(4)] })
    expect(b.initial).toEqual(a.initial)
  })

  it('🔴 puts the existing seats FIRST and newcomers after, whatever order they were observed in', () => {
    // MUTANT I10 SURVIVED HERE: `[...liveUnseated, ...keep]`. The determinism test
    // above only permutes `proposers` among addresses that are all already seated,
    // so both orderings produce the same array — the two branches never disagreed.
    // Order is not cosmetic: Besu sorts the set it receives, but the CONSTRUCTOR
    // order is what a redeploy must reproduce byte-for-byte to be verifiable, and
    // it is what every `getValidators()` comparison in the deploy script indexes.
    const r = pickInitialValidators({
      ...eight470(),
      proposers: [A(9), A(2), A(3), A(4), A(5), A(6)], // newcomer observed FIRST
    })
    expect(r.ok).toBe(true)
    expect(r.initial).toEqual([A(2), A(3), A(4), A(5), A(6), A(9).toLowerCase()])
    expect(r.initial[0]).toBe(A(2)) // an incumbent, not the newcomer
  })

  it('seats a live proposer the outgoing registry does NOT seat — it already carries consensus', () => {
    const r = pickInitialValidators({ ...eight470(), proposers: [A(2), A(3), A(4), A(5), A(6), A(9)] })
    expect(r.ok).toBe(true)
    expect(r.initial).toContain(A(9))
    expect(r.liveUnseated).toEqual([A(9).toLowerCase()])
    expect(r.warnings.join(' ')).toContain('leaving them out would drop real signers')
  })

  it('names what a dropped seat forfeits, in units', () => {
    const r = pickInitialValidators({ ...eight470(), trappedMicro: { [A(1)]: BigInt('2500000000') } })
    const w = r.warnings.join(' ')
    expect(w).toContain('2500 unit(s)')
    expect(w).toContain('StillSeated')
    expect(w).toContain('nothing points at that contract')
  })

  it('is case-insensitive about addresses — a checksum mismatch must not drop a live seat', () => {
    const r = pickInitialValidators({
      ...eight470(),
      proposers: [A(2), A(3), A(4), A(5), A(6)].map((a) => a.toUpperCase()),
    })
    expect(r.initial).toHaveLength(5)
    expect(r.dropped).toEqual([A(1)])
  })
})

describe('the refusals — dropping a seat is close to irreversible, so guess nothing', () => {
  it('🔴 REFUSES on an evidence window too short to call anyone silent', () => {
    // 6 seated needs 18 blocks. 6 blocks would "prove" 5 of them silent.
    const r = pickInitialValidators({ ...eight470(), window: 6 })
    expect(r.ok).toBe(false)
    expect(r.initial).toEqual([])
    expect(r.requiredWindow).toBe(18)
    const b = r.blockers.join(' ')
    expect(b).toContain('too short')
    // The asymmetry is the reason this is a blocker and not a warning.
    expect(b).toContain('there is no mint to re-stake with')
    expect(b).toContain('SHORTER window makes more addresses look droppable')
  })

  it('derives the required window from the SET, not from the answer', () => {
    // A 30-seat outgoing registry needs 90 blocks; 18 was plenty for 6.
    const big = pickInitialValidators({
      seatedOutgoing: Array.from({ length: 30 }, (_, i) => A(i + 10)),
      proposers: Array.from({ length: 30 }, (_, i) => A(i + 10)),
      window: 18,
      minValidators: 4,
      maxValidators: 40,
    })
    expect(big.requiredWindow).toBe(90)
    expect(big.ok).toBe(false)
  })

  it('🔴 REFUSES below the incoming floor rather than letting the constructor revert BadConfig', () => {
    const r = pickInitialValidators({ ...eight470(), proposers: [A(2), A(3)] })
    expect(r.ok).toBe(false)
    expect(r.initial).toEqual([])
    const b = r.blockers.join(' ')
    expect(b).toContain('BadConfig')
    // Why a refusal here is better than the revert: attribution.
    expect(b).toContain('reads like a deploy bug')
    expect(b).toContain('cannot conjure signers')
  })

  it('🔴 REFUSES above the cap, and says a subset is a choice about who keeps producing', () => {
    const many = Array.from({ length: 8 }, (_, i) => A(i + 10))
    const r = pickInitialValidators({
      seatedOutgoing: many,
      proposers: many,
      window: 24,
      minValidators: 4,
      maxValidators: 5,
    })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toContain('cap of 5')
    expect(r.blockers.join(' ')).toContain('a subset is a choice')
  })

  it('offers no `initial` when it refuses — a blocked seed must not look deployable', () => {
    for (const bad of [undefined, {}, { seatedOutgoing: [] }, { seatedOutgoing: [A(1)], window: 3 }]) {
      const r = pickInitialValidators(bad as any)
      expect(r.ok).toBe(false)
      expect(r.initial).toEqual([])
    }
  })
})

describe('keyless validators: live means seated, but flag the rotation that follows', () => {
  it('🔴 never drops a LIVE validator for being keyless — it still signs blocks', () => {
    // The 8555 joiner shape: live, no key on this machine.
    const r = pickInitialValidators({ ...eight470(), keyholders: [A(2), A(3), A(4), A(5)] })
    expect(r.ok).toBe(true)
    expect(r.initial).toContain(A(6)) // live, keyless — still seated
    const w = r.warnings.join(' ')
    expect(w).toContain('it carries the transition')
    // and it points at the moment where being keyless DOES cost the seat
    expect(w).toContain('stake-migration-plan.mjs')
  })

  it('notes when a dropped address was keyless anyway — the seat was never recoverable', () => {
    const r = pickInitialValidators({ ...eight470(), keyholders: [A(2), A(3), A(4), A(5), A(6)] })
    expect(r.warnings.join(' ')).toContain('could never have staked into the new registry anyway')
  })

  it('says nothing about keys when the caller supplied none, rather than assuming keyless', () => {
    // An empty keyholder list means "not checked", not "we hold nothing" — treating
    // it as the latter would warn that every validator is unfundable.
    const r = pickInitialValidators(eight470())
    expect(r.warnings.join(' ')).not.toContain('we hold no key')
  })
})

// The pure module can only be as honest as its caller (the c19 lesson): a deploy
// script that ignores `initial` and passes the seated set anyway would leave every
// test above green while shipping the bug this module exists to prevent.
describe('the deploy SCRIPT must seed from this policy, not from getValidators()', () => {
  const src = readFileSync(join(__dirname, '../chain/multinode/scripts/deploy-validators-slashable.mjs'), 'utf8')

  it('imports the policy', () => {
    expect(src).toContain('pickInitialValidators')
    expect(src).toContain('initial-seat-policy.mjs')
  })

  it('passes the POLICY output as the constructor argument, not the raw seated set', () => {
    expect(src).toMatch(/args:\s*\[[^\]]*seed\.initial\]/)
  })

  it('refuses to deploy when the policy refuses', () => {
    expect(src).toMatch(/if \(!seed\.ok\)/)
    expect(src).toContain('process.exit(1)')
  })

  it('observes proposers over a window rather than trusting the registry about liveness', () => {
    expect(src).toContain('getBlock')
    expect(src).toContain('miner')
  })

  it('still preserves the pointer to the previous slashable registry', () => {
    // c19 flagged this: overwriting validatorContractSlashable erases the only
    // record of the instance the swap tests name — swap-preflight refuses to swap
    // to that ghost-laden address BY ADDRESS, so losing it lets a future cycle
    // re-aim at a registry already ruled out, having lost the reason why.
    //
    // ⚠️ MUTANT I15 SURVIVED a bare `toContain('previousValidatorContractSlashable')`
    // because the string also appears in the comment ABOVE the assignment. A needle
    // that a comment can satisfy proves nothing about the code. Assert the write.
    expect(src).toMatch(/d\.previousValidatorContractSlashable = \[/)
    // and that it appends rather than replacing, so a third deploy keeps both
    expect(src).toMatch(/Array\.isArray\(d\.previousValidatorContractSlashable\)/)
    // guarded on actually having changed — a redeploy of the same address must not
    // pile up duplicates
    expect(src).toMatch(/toLowerCase\(\) !== registry\.toLowerCase\(\)/)
  })
})
