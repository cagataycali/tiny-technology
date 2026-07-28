import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chooseE2ERegistry, projectGhostInflation } from '../chain/multinode/e2e-registry-target.mjs'

const AUTH = '0x0165878A594ca255338adfa4d48449f69242Eb8F'
const TARGET = '0xb2ff9d5e60d68a52cea3cd041b32f1390a880365'
const OLD = '0x4ea0be853219be8c9ce27200bdeee36881612ff2'
const SCRATCH = '0x1111111111111111111111111111111111111111'

const deployment = {
  validatorContract: AUTH,
  validatorContractSlashable: TARGET,
  previousValidatorContractSlashable: [OLD],
}

describe('chooseE2ERegistry — a destructive suite owns its fixture', () => {
  it('defaults to a scratch fixture, naming no address at all', () => {
    const c = chooseE2ERegistry({ deployment })
    expect(c.ok).toBe(true)
    expect(c.mode).toBe('scratch')
    // The absence of an address is the point: nothing pre-existing can be reshaped.
    expect(c.address).toBeNull()
  })

  it('🔴 refuses the DESIGNATED SWAP TARGET even though Besu does not read it', () => {
    // The old guard's premise — "not authoritative ⇒ safe to reshape" — was true when
    // written and false the moment a funded swap target existed. This is the whole
    // finding, so it is asserted on the reason, not just the boolean.
    const c = chooseE2ERegistry({ deployment, requested: TARGET })
    expect(c.ok).toBe(false)
    expect(c.address).toBeNull()
    const r = c.refusals.join(' ')
    expect(r).toContain('DESIGNATED SWAP TARGET')
    expect(r).toContain('StillSeated')
    expect(r).toContain('eligible forever')
  })

  it('🔴 still refuses the authoritative registry — the original guard survives', () => {
    const c = chooseE2ERegistry({ deployment, requested: AUTH })
    expect(c.ok).toBe(false)
    expect(c.refusals.join(' ')).toContain('AUTHORITATIVE')
  })

  it('🔴 refuses regardless of address casing', () => {
    // Checksummed in the deployment file, lowercase on a command line. A case-sensitive
    // compare would refuse in tests and permit in practice — the worst direction.
    for (const form of [TARGET.toUpperCase().replace('0X', '0x'), TARGET.toLowerCase()]) {
      expect(chooseE2ERegistry({ deployment, requested: form }).ok).toBe(false)
    }
    expect(chooseE2ERegistry({ deployment, requested: AUTH.toLowerCase() }).ok).toBe(false)
  })

  it('permits a SUPERSEDED registry, and warns that its state is leftovers', () => {
    // Reshaping it is genuinely harmless — nothing points at it — so this must be
    // allowed, or probing the historical instance becomes impossible.
    const c = chooseE2ERegistry({ deployment, requested: OLD })
    expect(c.ok).toBe(true)
    expect(c.mode).toBe('explicit')
    expect(c.address).toBe(OLD.toLowerCase())
    expect(c.warnings.join(' ')).toContain('SUPERSEDED')
    expect(c.warnings.join(' ')).toContain('deltas')
  })

  it('permits an unknown address but says it is assuming it is scratch', () => {
    const c = chooseE2ERegistry({ deployment, requested: SCRATCH })
    expect(c.ok).toBe(true)
    expect(c.warnings.join(' ')).toContain('not named in the deployment record')
  })

  it('🔴 refuses a missing deployment rather than treating everything as scratch', () => {
    // With no record, no address can be recognised as off-limits — so "nothing is
    // forbidden" is exactly the wrong default.
    for (const bad of [undefined, null, 'x', 5]) {
      const c = chooseE2ERegistry({ deployment: bad as any, requested: TARGET })
      expect(c.ok).toBe(false)
    }
  })

  it('🔴 does not crash when previousValidatorContractSlashable is absent or junk', () => {
    for (const prev of [undefined, null, 'nope', {}]) {
      const c = chooseE2ERegistry({
        deployment: { ...deployment, previousValidatorContractSlashable: prev } as any,
        requested: OLD,
      })
      // With no recorded history the old address is simply unknown — permitted, warned.
      expect(c.ok).toBe(true)
      expect(c.warnings.join(' ')).toContain('not named')
    }
  })

  it('includes the projected quorum damage in the refusal when given one', () => {
    // A refusal an operator can dismiss is a refusal that gets bypassed. Numbers are
    // harder to argue with than adjectives.
    const projection = projectGhostInflation({ eligibleNow: 5, added: 4, maxValidators: 21, liveCount: 5 })
    const c = chooseE2ERegistry({ deployment, requested: TARGET, projection })
    const r = c.refusals.join(' ')
    expect(r).toContain('quorum 4 → 6')
    expect(r).toContain('HALT THE CHAIN')
  })
})

describe('projectGhostInflation — quantify the harm, do not assert it', () => {
  it('🔴 reports the real 8470 case: 4 ephemeral stakers turn a margin of 1 into a halt', () => {
    const p = projectGhostInflation({ eligibleNow: 5, added: 4, maxValidators: 21, liveCount: 5 })
    expect(p.seatsBefore).toBe(5)
    expect(p.seatsAfter).toBe(9)
    expect(p.quorumBefore).toBe(4)
    expect(p.quorumAfter).toBe(6)
    expect(p.marginBefore).toBe(1)
    expect(p.marginAfter).toBe(-1)
    expect(p.halts).toBe(true)
    expect(p.breaksSurvivableSwap).toBe(true)
  })

  it('🔴 distinguishes "already broken" from "broken BY this" ', () => {
    // If the swap could not survive beforehand either, the suite is not what broke it,
    // and blaming it would send an operator to fix the wrong thing.
    const p = projectGhostInflation({ eligibleNow: 8, added: 4, maxValidators: 21, liveCount: 3 })
    expect(p.halts).toBe(true)
    expect(p.breaksSurvivableSwap).toBe(false)
  })

  it('adding nothing changes nothing', () => {
    const p = projectGhostInflation({ eligibleNow: 5, added: 0, maxValidators: 21, liveCount: 5 })
    expect(p.quorumAfter).toBe(p.quorumBefore)
    expect(p.breaksSurvivableSwap).toBe(false)
    expect(p.halts).toBe(false)
  })

  it('🔴 respects the seat cap — quorum cannot be inflated past it', () => {
    // maxValidators bounds the seated set, so ghosts beyond the cap raise the candidate
    // queue without raising quorum. Ignoring the cap would overstate the harm, and an
    // overstated refusal is one that gets overridden.
    const p = projectGhostInflation({ eligibleNow: 21, added: 50, maxValidators: 21, liveCount: 21 })
    expect(p.seatsAfter).toBe(21)
    expect(p.quorumAfter).toBe(p.quorumBefore)
    expect(p.breaksSurvivableSwap).toBe(false)
  })

  it('survives junk input without inventing a halt', () => {
    const p = projectGhostInflation({} as any)
    expect(p.seatsBefore).toBe(0)
    expect(p.halts).toBe(false)
  })
})

// A pure module is only as honest as its caller (the c19 lesson). Here the caller is a
// suite that STAKES AND ROTATES, so the assertions are about what it must not aim at.
describe('the E2E SCRIPT must go through the policy and own its fixture', () => {
  const src = readFileSync(join(__dirname, '../chain/multinode/scripts/slashable-registry-e2e.mjs'), 'utf8')

  it('🔴 picks its target by CALLING the policy, and exits on a refusal', () => {
    // Assert the CALL SHAPE, not that the identifier appears somewhere: stubbing this
    // line — `const target = {ok: true, address: d.validatorContractSlashable}` — leaves
    // every other guard in this file green (the import still mentions the function, and
    // every call site still says `underTest`) while pointing `underTest` straight at the
    // registry the chain is about to depend on. It is the one edit here that re-creates
    // the exact bug this cycle fixed, and it survived until this assertion existed.
    expect(src).toMatch(/const target = chooseE2ERegistry\(\{[^}]*deployment: d[^}]*\}\)/)
    expect(src).toMatch(/if \(!target\.ok\)/)
    expect(src).toMatch(/process\.exit\(1\)/)
    // and `underTest` may only ever come from the vetted decision or a fresh deploy
    expect(src).toMatch(/underTest = getAddress\(target\.address\)/)
    expect(src).toMatch(/underTest = \(await wait\(h\)\)\.contractAddress/)
  })

  it('🔴 every state-changing call goes to `underTest`, never to the swap target', () => {
    // THE regression this cycle exists to prevent. `underTest` may be a scratch fixture
    // or an explicit superseded instance; `d.validatorContractSlashable` may be READ
    // (section 8 does, to prove it was left alone) but never written.
    //
    // Checked by walking each mutating call site rather than banning the identifier: a
    // blanket ban would forbid the very read that proves no ghost was added, so the
    // assertion has to distinguish reading from writing — which is the same distinction
    // the bug turned on.
    const MUTATORS = ['stake', 'rotate', 'unstake', 'requestExit', 'forfeit']
    // `underTest` is the vetted handle; `registry` is enroll()'s PARAMETER and `floorReg`
    // is a registry the suite deploys inside a fixture block — both are safe by
    // construction, but only if nothing hands them the swap target, which the next
    // assertion covers. Anything else appearing here is a new, unreviewed target.
    const ALLOWED = ['underTest', 'registry', 'floorReg']
    // `.forEach` over `.match(…g)`, not a spread of `.matchAll` — tsconfig targets es5
    // here, where iterating an iterator needs downlevelIteration.
    const sites = src.match(/address: [A-Za-z.\w]+, abi: reg, functionName: '\w+'/g) || []
    const parse = (s: string) => {
      const m = /address: ([A-Za-z.\w]+), abi: reg, functionName: '(\w+)'/.exec(s)
      return { addr: m ? m[1] : '', fn: m ? m[2] : '' }
    }
    const mutating = sites.map(parse).filter((s) => MUTATORS.indexOf(s.fn) > -1)
    expect(mutating.length).toBeGreaterThanOrEqual(7)
    mutating.forEach(({ addr, fn }) => {
      expect(ALLOWED, `${fn}() acts on ${addr}, which is not a vetted fixture handle`).toContain(addr)
    })
    // and nothing is ever ENROLLED into the swap target — that is the call that would
    // post the unremovable stake.
    const enrolls = src.match(/enroll\([^,]+,/g) || []
    expect(enrolls.length).toBeGreaterThan(0)
    enrolls.forEach((e) => {
      expect(ALLOWED).toContain(e.replace(/^enroll\(/, '').replace(/,$/, '').trim())
    })
    // and the swap target appears ONLY in read-only positions
    const targetSites = src.match(/address: d\.validatorContractSlashable, abi: reg, functionName: '\w+'/g) || []
    expect(targetSites.length).toBeGreaterThan(0)
    targetSites.forEach((s) => expect(MUTATORS).not.toContain(parse(s).fn))
  })

  it('🔴 deploys its own fixture seeded from OBSERVED proposers, not from a registry', () => {
    // Seeding from getValidators() would inherit whatever ghosts already exist — the
    // c20 lesson, and here it would also make section 8's liveness claim untestable.
    expect(src).toContain('liveSeed')
    expect(src).toMatch(/b\.miner/)
    expect(src).toMatch(/args: \[d\.usdc, d\.slashing, minStake, maxV, minV, epochBlocks, liveSeed\]/)
  })

  it('🔴 asserts afterwards that the swap target is UNCHANGED, by candidate count', () => {
    // Seats only move at a rotation, so a seat-count check stays green through a leak.
    // The candidate queue changes the instant a stake lands.
    expect(src).toContain('swapTargetCandidatesAtStart')
    expect(src).toMatch(/targetCandidates === swapTargetCandidatesAtStart/)
    expect(src).toContain("functionName: 'candidateCount'")
    expect(src).toContain('DESIGNATED SWAP TARGET')
  })

  it('🔴 reads config from the AUTHORITATIVE registry, not from its own fixture', () => {
    // Reading minStake off the fixture would make "config matches the live registry"
    // compare a contract to itself — a green assertion that tests nothing.
    expect(src).toMatch(/\['minStake', 'maxValidators', 'minValidators', 'epochBlocks'\]\.map\(\(f\) =>\s*\n\s*pub\.readContract\(\{ address: d\.validatorContract/)
  })

  it('keeps the original authoritative-registry guard', () => {
    expect(src).toMatch(/getAddress\(underTest\) === getAddress\(d\.validatorContract\)/)
    expect(src).toContain('IS the authoritative one')
  })
})
