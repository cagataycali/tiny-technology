import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFundingTxs, verifyConverged } from '../chain/multinode/funding-executor.mjs'
import { planStakeMigration } from '../chain/multinode/stake-migration-plan.mjs'

const MIN = BigInt('1000000000') // 1000 units, the live 8470 minStake
const A = (i: number) => `0x${String(i).padStart(40, 'a')}`
const good = (i: number, free = MIN) => ({
  address: A(i), live: true, hasKey: true, freeMicro: free, nativeWei: BigInt('1000000000000000000'),
})

/** The real shape this cycle executes: 4 funded founders + a broke live joiner. */
const eight470 = () =>
  planStakeMigration({
    validators: [
      good(1, MIN * BigInt(3)),
      good(2, MIN * BigInt(3)),
      good(3, MIN * BigInt(3)),
      good(4, MIN * BigInt(3)),
      good(5, BigInt(0)),
    ],
    minStakeMicro: MIN,
    minValidators: 4,
    maxValidators: 21,
  })

describe('buildFundingTxs — the order is load-bearing, so it gets to refuse', () => {
  it('turns the real 8470 plan into transfer-then-approve+stake', () => {
    const b = buildFundingTxs(eight470())
    expect(b.ok).toBe(true)
    // 1 transfer + 5×(approve, stake)
    expect(b.txs).toHaveLength(11)
    expect(b.txs[0].kind).toBe('transfer')
    expect(b.txs[0].to).toBe(A(5))
    expect(b.txs.filter((t: any) => t.kind === 'stake')).toHaveLength(5)
  })

  it('🔴 refuses a self-transfer — the money would not move but the plan thinks it did', () => {
    const selfFund = buildFundingTxs({ ok: true, transfers: [{ from: A(9), to: A(9), amountMicro: MIN }], stakes: [] })
    expect(selfFund.ok).toBe(false)
    expect(selfFund.txs).toEqual([])
    expect(selfFund.refusals.join(' ')).toContain('self-transfer')
    expect(selfFund.refusals.join(' ')).toContain('would revert')
  })

  it('🔴 puts every funding transfer BEFORE the stake it funds', () => {
    // The one ordering constraint that costs real money to get wrong: staking first
    // reverts inside transferFrom as "stake transfer failed", which names the symptom
    // and hides the cause. Asserted as a property over the built list, so a future
    // refactor that emits stakes first fails here rather than on-chain.
    const b = buildFundingTxs(eight470())
    expect(b.ok).toBe(true)
    b.txs.forEach((t: any, i: number) => {
      if (t.kind !== 'transfer') return
      const stakeAt = b.txs.findIndex((o: any) => o.kind === 'stake' && o.from.toLowerCase() === t.to.toLowerCase())
      expect(stakeAt).toBeGreaterThan(i)
    })
    // and the recipient that held nothing is the one being funded
    expect(b.txs[0].to).toBe(A(5))
  })

  it('🔴 every stake is immediately preceded by its OWN matching approve', () => {
    // A cross-signer approve makes the STAKE revert, so the blame lands on the wrong
    // key and the real cause is two steps away.
    const b = buildFundingTxs(eight470())
    for (let i = 0; i < b.txs.length; i++) {
      if (b.txs[i].kind !== 'stake') continue
      expect(b.txs[i - 1].kind).toBe('approve')
      expect(b.txs[i - 1].from).toBe(b.txs[i].from)
      expect(b.txs[i - 1].amountMicro).toBe(b.txs[i].amountMicro)
    }
  })

  it('🔴 builds NOTHING from a refused plan — a prefix spends unmintable balance', () => {
    const bad = planStakeMigration({
      validators: [good(1, BigInt(0)), good(2, BigInt(0)), good(3, BigInt(0)), good(4, BigInt(0))],
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(bad.ok).toBe(false)
    const b = buildFundingTxs(bad)
    expect(b.ok).toBe(false)
    expect(b.txs).toEqual([])
    expect(b.refusals.join(' ')).toContain('unmintable')
    expect(b.refusals.join(' ')).toContain('will not work')
  })

  it('🔴 builds nothing from a CONVERGED plan — a re-run must not stake twice', () => {
    const done = planStakeMigration({
      validators: [1, 2, 3, 4].map((i) => ({ ...good(i, BigInt(0)), alreadyStakedMicro: MIN })),
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(done.ok).toBe(true)
    const b = buildFundingTxs(done)
    expect(b.ok).toBe(true)
    expect(b.txs).toEqual([]) // re-running the executor is the check, not a second charge
  })

  it('plans only the TOP-UP amount and says why, for a partially staked validator', () => {
    const p = planStakeMigration({
      validators: [{ ...good(1, MIN / BigInt(2)), alreadyStakedMicro: MIN / BigInt(2) }],
      minStakeMicro: MIN, minValidators: 1, maxValidators: 21,
    })
    const b = buildFundingTxs(p)
    expect(b.txs.map((t: any) => t.amountMicro)).toEqual([MIN / BigInt(2), MIN / BigInt(2)])
    expect(b.txs[1].note).toContain('cumulative')
  })

  it('survives junk without producing a sendable list', () => {
    for (const bad of [undefined, null, {}, { ok: true }, { ok: true, transfers: 'no', stakes: null }]) {
      const b = buildFundingTxs(bad as any)
      expect(b.txs).toEqual([])
    }
  })

  it('refuses a zero-amount or malformed entry rather than sending a no-op', () => {
    const b = buildFundingTxs({ ok: true, transfers: [{ from: A(1), to: A(2), amountMicro: BigInt(0) }], stakes: [] })
    expect(b.ok).toBe(false)
    expect(b.refusals.join(' ')).toContain('malformed transfer')
  })

  it('🔴 refuses a malformed STAKE entry, not just a malformed transfer', () => {
    // A zero-amount stake would be an approve+stake pair that spends gas and changes
    // nothing, leaving the validator ineligible while the run reports success.
    for (const bad of [{ address: A(1), amountMicro: BigInt(0) }, { amountMicro: MIN }, { address: '', amountMicro: MIN }]) {
      const b = buildFundingTxs({ ok: true, transfers: [], stakes: [bad] })
      expect(b.ok).toBe(false)
      expect(b.txs).toEqual([])
      expect(b.refusals.join(' ')).toContain('malformed stake')
    }
  })

  it('🔴 refuses a transfer to an address that never stakes — unmintable money with no purpose', () => {
    // This is where the money leaks: the transfer succeeds, the balance is gone, and
    // nothing about the run looks wrong. P3 removed mint(), so it cannot be replaced.
    const b = buildFundingTxs({
      ok: true,
      transfers: [{ from: A(1), to: A(7), amountMicro: MIN }],
      stakes: [{ address: A(1), amountMicro: MIN, alreadyStakedMicro: BigInt(0) }],
    })
    expect(b.ok).toBe(false)
    expect(b.txs).toEqual([])
    const r = b.refusals.join(' ')
    expect(r).toContain('never stakes from it')
    expect(r).toContain('mint() is gone since P3')
  })

  it('🔴 refuses a two-hop transfer chain whose middle address never stakes', () => {
    // The subtle version of the leak: B is not a dead end — it FORWARDS the money on.
    // So "did anyone send from this address?" says yes and the plan looks purposeful,
    // while B itself never stakes and the balance parked there on the way through is
    // unrecoverable. Only "did anyone STAKE from this address?" catches it.
    const b = buildFundingTxs({
      ok: true,
      transfers: [
        { from: A(1), to: A(2), amountMicro: MIN },
        { from: A(2), to: A(3), amountMicro: MIN },
      ],
      stakes: [
        { address: A(1), amountMicro: MIN, alreadyStakedMicro: BigInt(0) },
        { address: A(3), amountMicro: MIN, alreadyStakedMicro: BigInt(0) },
      ],
    })
    expect(b.ok).toBe(false)
    expect(b.txs).toEqual([])
    expect(b.refusals.join(' ')).toContain(`never stakes from it`)
    expect(b.refusals.join(' ')).toContain(A(2))
  })

  it('🔴 refuses a duplicated staker — stake() is cumulative, so double posting is SILENT', () => {
    // The most expensive typo available in this file: no revert, double the stake
    // posted, and the surplus is trapped behind StillSeated() forever.
    const b = buildFundingTxs({
      ok: true,
      transfers: [],
      stakes: [
        { address: A(1), amountMicro: MIN, alreadyStakedMicro: BigInt(0) },
        { address: A(1).toUpperCase(), amountMicro: MIN, alreadyStakedMicro: BigInt(0) },
      ],
    })
    expect(b.ok).toBe(false)
    expect(b.txs).toEqual([])
    const r = b.refusals.join(' ')
    expect(r).toContain('appears twice')
    expect(r).toContain('fail SILENTLY')
    expect(r).toContain('StillSeated')
  })
})

describe('verifyConverged — a receipt is not an effect', () => {
  it('accepts a plan with nothing left to do', () => {
    const done = planStakeMigration({
      validators: [1, 2, 3, 4].map((i) => ({ ...good(i, BigInt(0)), alreadyStakedMicro: MIN })),
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(verifyConverged(done, 4).converged).toBe(true)
  })

  it('🔴 rejects when transactions remain — the call succeeded without its effect', () => {
    const v = verifyConverged(eight470(), 5)
    expect(v.converged).toBe(false)
    expect(v.problems.join(' ')).toContain('still outstanding')
    expect(v.problems.join(' ')).toContain('a receipt cannot see')
  })

  it('🔴 rejects a plan with NOTHING LEFT TO DO that still refuses', () => {
    // The distinction "nothing outstanding" ≠ "it worked". Everyone is staked, so
    // there is no work left — and the chain would still halt at the epoch boundary,
    // because only one of the three funded seats is live. A convergence check that
    // only counted remaining transactions would call this a success.
    const replan = planStakeMigration({
      validators: [
        { ...good(1, BigInt(0)), alreadyStakedMicro: MIN },
        { ...good(2, BigInt(0)), alreadyStakedMicro: MIN, live: false },
        { ...good(3, BigInt(0)), alreadyStakedMicro: MIN, live: false },
      ],
      minStakeMicro: MIN, minValidators: 1, maxValidators: 21,
    })
    expect(replan.ok).toBe(false)
    expect(replan.transfers).toEqual([]) // …yet nothing is outstanding
    expect(replan.stakes).toEqual([])
    const v = verifyConverged(replan, 3)
    expect(v.converged).toBe(false)
    const p = v.problems.join(' ')
    expect(p).toContain('still REFUSES')
    expect(p).toContain('Nothing left to DO is not the same as working')
    // and the underlying reason is still reported, from the planner where it lives
    expect(p).toContain('halt at the next epoch boundary')
  })

  it('rejects a mismatch in the eligible count', () => {
    const done = planStakeMigration({
      validators: [1, 2, 3, 4].map((i) => ({ ...good(i, BigInt(0)), alreadyStakedMicro: MIN })),
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    const v = verifyConverged(done, 5)
    expect(v.converged).toBe(false)
    expect(v.problems.join(' ')).toContain('expected 5')
  })

  it('rejects a missing re-plan rather than reading absence as success', () => {
    expect(verifyConverged(undefined as any, 4).converged).toBe(false)
  })
})

describe('the ZERO-GAS-BALANCE blocker — the only failure with no error message', () => {
  it('🔴 blocks a signer with zero native balance even though gas is priced at zero', () => {
    const p = planStakeMigration({
      validators: [
        good(1, MIN * BigInt(3)),
        { ...good(2, MIN), nativeWei: BigInt(0) },
        good(3), good(4),
      ],
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(p.ok).toBe(false)
    const b = p.blockers.join(' ')
    expect(b).toContain('ZERO native balance')
    // The reason it is a blocker and not a warning: nobody ever sees it happen.
    expect(b).toContain('NEVER mined and NEVER rejected')
    expect(b).toContain('an operator never sees')
  })

  it('does not block a gasless KEYLESS address — it signs nothing', () => {
    const p = planStakeMigration({
      validators: [
        good(1), good(2), good(3), good(4),
        { address: A(9), live: true, hasKey: false, freeMicro: BigInt(0), nativeWei: BigInt(0) },
      ],
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(p.blockers.join(' ')).not.toContain('ZERO native balance')
    expect(p.ok).toBe(true)
  })

  it('🔴 does not block a gasless KEY-HOLDER that is already staked and so signs nothing', () => {
    // The populations "holds a key" and "must send a transaction" are not the same,
    // and this fixture is where they disagree: A(5) holds a key, holds no gas, and is
    // already at minStake — it has no step in the plan, so its empty gas tank cannot
    // stop anything. Blocking here would refuse a fully executable migration on the
    // strength of an address that does nothing.
    const p = planStakeMigration({
      validators: [
        good(1), good(2), good(3), good(4),
        { address: A(5), live: true, hasKey: true, freeMicro: BigInt(0), nativeWei: BigInt(0), alreadyStakedMicro: MIN },
      ],
      minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
    })
    expect(p.ok).toBe(true)
    expect(p.blockers.join(' ')).not.toContain('ZERO native balance')
    expect(p.alreadyEligible).toEqual([A(5)])
    expect(p.afterRotation.eligible).toBe(5)
  })

  it('🔴 treats an UNCHECKED native balance as unknown, not as zero', () => {
    // A caller that never read getBalance passes undefined; one that read it and got
    // nothing back passes null. BOTH mean "not checked", and reading either as zero
    // would block every migration — a check that fires when it was never run is a
    // check somebody deletes. `undefined` and `null` are tested separately because the
    // normaliser maps them to the same value and one guard can be dropped alone.
    for (const unknown of [undefined, null]) {
      const p = planStakeMigration({
        validators: [good(1), good(2), good(3), good(4)].map((v) => ({ ...v, nativeWei: unknown })),
        minStakeMicro: MIN, minValidators: 4, maxValidators: 21,
      })
      expect(p.ok).toBe(true)
      expect(p.blockers.join(' ')).not.toContain('native balance')
    }
  })
})

// A pure module is only as honest as its caller (the c19 lesson). Here the caller
// SENDS MONEY, so the assertions are about what it must never do.
describe('the executor SCRIPT must go through the policy, and be re-runnable', () => {
  const src = readFileSync(join(__dirname, '../chain/multinode/scripts/fund-migration.mjs'), 'utf8')
  const reader = readFileSync(join(__dirname, '../chain/multinode/scripts/lib/read-migration-state.mjs'), 'utf8')

  it('builds its transaction list from buildFundingTxs, never from its own loop', () => {
    expect(src).toContain('buildFundingTxs')
    expect(src).toMatch(/if \(!built\.ok\)/)
    expect(src).toContain('Nothing was sent')
  })

  it('🔴 shares ONE chain reader with the plan report, so the two cannot drift', () => {
    // If the executor read the chain itself, the plan a human reviewed and the plan
    // the machine executes would be two computations that merely agree today — and
    // the reader is where both hard-won c21 facts live.
    expect(src).toContain("from './lib/read-migration-state.mjs'")
    const report = readFileSync(join(__dirname, '../chain/multinode/scripts/stake-migration-plan.mjs'), 'utf8')
    expect(report).toContain("from './lib/read-migration-state.mjs'")
    expect(src).not.toContain('createPublicClient')
    expect(report).not.toContain('createPublicClient')
  })

  it('🔴 refuses before sending when the plan refuses', () => {
    expect(src).toMatch(/if \(!plan\.ok\)/)
    expect(src).toMatch(/process\.exit\(1\)/)
  })

  it('🔴 verifies by RE-PLANNING against re-read state, not by trusting receipts', () => {
    expect(src).toMatch(/const after = await readMigrationState/)
    expect(src).toContain('a receipt is not an effect')
    // The verdict must come FROM the policy and be computed over the RE-PLAN. Stubbing
    // it — `const v = {converged: true}` — is the one edit here that turns a failed
    // migration into a green run that then invites the swap, so assert the call shape,
    // not just that the identifier appears somewhere.
    expect(src).toMatch(/const v = verifyConverged\(replan, [^)]+\)/)
    expect(src).toMatch(/if \(!v\.converged\)/)
    expect(src).toContain('did NOT converge')
    expect(src).toContain('Do not proceed to the swap')
  })

  it('🔴 checks every receipt status — a reverted call must stop the run', () => {
    expect(src).toMatch(/rc\.status !== 'success'/)
    expect(src).toContain('re-run')
  })

  it('supports --dry-run and sends nothing in that mode', () => {
    expect(src).toMatch(/const DRY = process\.argv\.includes\('--dry-run'\)/)
    expect(src).toMatch(/if \(DRY\) \{[\s\S]{0,300}process\.exit\(0\)/)
  })

  it('🔴 never writes a file or edits the genesis — the swap is a separate, gated step', () => {
    // Funding and cutting over are different decisions with different reversibility.
    // A funder that also rewrote the deployment file would make the swap a side effect
    // of a step that is allowed to run unattended.
    for (const banned of ['writeFileSync', 'switch-to-contract-mode', 'validatorContract =']) {
      expect(src).not.toContain(banned)
    }
    expect(src).toContain('USER-GATED')
    expect(src).toContain('swap-preflight.mjs')
  })

  it('🔴 the reader refuses any chain that is not 8470, and reads native balance', () => {
    expect(reader).toContain('EXPECTED_CHAIN_ID = 8470')
    expect(reader).toContain('The LIVE chain is 8469')
    expect(reader).toMatch(/pub\.getBalance\(\{ address \}\)/)
    // and it stays read-only: signing belongs to the executor
    for (const banned of ['writeContract', 'sendTransaction', 'writeFileSync']) {
      expect(reader).not.toContain(banned)
    }
  })
})
