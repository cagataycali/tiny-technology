/**
 * 📦 STAKE MIGRATION PLANNER — can the incoming registry actually be FUNDED to a
 * working validator set, and with whose money?
 *
 * ⚠️⚠️ WHY THIS EXISTS. c18 replaced an impossible remediation ("stake the live
 * validators into the ghost-laden registry and rotate()") with a three-step one:
 * deploy a fresh registry → stake the live validators into it → re-run the
 * preflight. Probing the chain before executing THAT found step 2 is not free
 * either, and for reasons no amount of reading the contract reveals — they are
 * facts about the current balances:
 *
 *   - **The stake already posted is TRAPPED.** `unstake()` reverts `StillSeated()`
 *     for anyone `isActive`, and every live validator is seated in the outgoing
 *     registry. So the ~10,500 units sitting in the old contract are NOT a funding
 *     source for the new one, however much the deployment file makes it look like
 *     migrating stake is a matter of moving a number.
 *   - **No more can be minted.** P3 handed TinyUSDC's ownership to TinyIssuance,
 *     irreversibly, so `mint()` reverts for every key we hold. The total stakeable
 *     supply is now exactly what is already in circulation.
 *   - **Two of the five live validators hold ZERO free balance** (the 8555 joiner
 *     and one founder), so `stake()` would revert inside `transferFrom` with
 *     "stake transfer failed" — a message that names the symptom and hides all of
 *     the above.
 *
 * 🔑 THE LESSON, THIRD CYCLE RUNNING: a remediation is a claim about the future.
 * c17's was impossible; c18's was possible but under-specified, and the gap was
 * invisible from the contract source because it lived in the balances. So this
 * plans the funding explicitly, from state, and refuses when the money isn't there.
 *
 * 🔑 AND IT CHECKS TWO DIFFERENT MOMENTS, because they have different seat sets:
 *   1. **At the transition** Besu reads the incoming registry's CONSTRUCTOR set —
 *      which `deploy-validators-slashable.mjs` seeds from the outgoing registry's
 *      *seated* set, ghosts included, regardless of stake. Quorum here is over
 *      addresses that may hold nothing.
 *   2. **At the first rotate()** the set becomes the ELIGIBLE candidates, which is
 *      a different population: funded keys only. A plan can survive moment 1 and
 *      halt the chain at moment 2, days later, with nobody connecting the two.
 * Checking only one of them is how a swap passes review and fails in production.
 *
 * Pure: no RPC, no fs, no clock. Callers read the chain and pass numbers in.
 */
import { qbftQuorum } from './validator-set-health.mjs'

/** Micro-units (1e6) throughout, matching TinyUSDC's decimals. */
const big = (v) => {
  try {
    const n = BigInt(v ?? 0)
    return n < 0n ? 0n : n
  } catch {
    return 0n
  }
}

/**
 * @param {object} input
 * @param {Array<{address: string, live?: boolean, hasKey?: boolean, freeMicro?: bigint|string|number, alreadyStakedMicro?: bigint|string|number, nativeWei?: bigint|string|number|null, seatedOutgoing?: boolean, stakedOutgoingMicro?: bigint|string|number}>} input.validators
 *   Every address the incoming registry will seat at birth, plus any live proposer
 *   we intend to fund. `hasKey` = we hold the private key, i.e. it can sign a
 *   `stake()` at all. `live` = it has demonstrably proposed a block recently.
 *   `alreadyStakedMicro` = its `stakeOf` in the INCOMING registry, which is 0 for a
 *   fresh deploy and nonzero once part of this plan has run — pass it or a re-run
 *   will plan the same money twice.
 * @param {bigint|string|number} input.minStakeMicro  the incoming registry's minStake
 * @param {number} [input.minValidators]  its floor (rotate() reverts below this)
 * @param {number} [input.maxValidators]  its seat cap
 * @param {Array<{address: string, freeMicro: bigint|string|number}>} [input.donors]
 *   extra funded addresses that can `transfer` stake to a validator that has none.
 *   The token has a plain `transfer`, so funding is possible without minting.
 */
export function planStakeMigration(input) {
  const minStake = big(input?.minStakeMicro)
  const maxV = Math.max(1, Math.floor(Number(input?.maxValidators) || 21))
  const minV = Math.max(1, Math.floor(Number(input?.minValidators) || 1))

  const vals = (Array.isArray(input?.validators) ? input.validators : []).map((v) => ({
    address: String(v?.address || ''),
    live: !!v?.live,
    hasKey: !!v?.hasKey,
    free: big(v?.freeMicro),
    // stake ALREADY posted in the INCOMING registry — 0 for a fresh deploy, nonzero
    // once part of this plan has been executed.
    staked: big(v?.alreadyStakedMicro),
    // native balance. `undefined` means the caller did not check, which must NOT read
    // as zero — that would block every migration planned by a caller that predates
    // this field.
    nativeWei: v?.nativeWei === undefined || v?.nativeWei === null ? null : big(v.nativeWei),
    seatedOutgoing: !!v?.seatedOutgoing,
    trapped: big(v?.stakedOutgoingMicro),
  }))

  const blockers = []
  const warnings = []
  const steps = []

  // ── moment 1: the seats Besu inherits AT THE TRANSITION ────────────────────
  // These come from the constructor argument, NOT from stake. An address with
  // zero balance and no key still occupies a seat and still raises quorum.
  const bornSeats = vals.length
  const bornQuorum = qbftQuorum(bornSeats)
  const bornLive = vals.filter((v) => v.live).length

  // ── the funding problem ────────────────────────────────────────────────────
  // A validator we hold no key for can never sign `stake()`, so it can never
  // become eligible however much we send it. Sending anyway would burn stake into
  // an address nobody controls, so those are excluded from funding outright.
  const keyless = vals.filter((v) => !v.hasKey)
  const fundable = vals.filter((v) => v.hasKey)

  // `stakeOf` in the INCOMING registry starts at 0 for everyone — the constructor
  // seats without writing it (verified: 0 occurrences of `stakeOf[v]` there). So a
  // validator needs the full minStake unless it has ALREADY staked there.
  //
  // ⚠️ c21: RESUMABILITY IS A REQUIREMENT, not a nicety. The plan is N transactions
  // signed by N different keys, so a partial execution is the normal case, not the
  // exception — a key runs out of gas, a node is down, the operator stops halfway.
  // `stake()` is CUMULATIVE, so a plan that ignores stake already posted asks for
  // the full amount again, spends balance that did not need spending, and then
  // refuses because the money ran out. Re-running the plan must converge, not
  // double-charge.
  // What this validator must still put INTO the incoming registry.
  const toStakeOf = (v) => (minStake > v.staked ? minStake - v.staked : 0n)
  // What it is short of being able to do that from its own balance.
  const shortOf = (v) => {
    const owed = toStakeOf(v)
    return owed > v.free ? owed - v.free : 0n
  }
  const need = new Map(fundable.map((v) => [v.address, shortOf(v)]))

  // Surplus is free balance ABOVE the amount this holder must still stake itself.
  // ⚠️ NOT above its shortfall: once it can cover its own stake the shortfall is
  // zero, and reading that as "the whole balance is spare" would give away the very
  // money the stake() call is going to spend — a green plan whose last transaction
  // reverts. A donor that funds a peer into eligibility while dropping itself out
  // has moved the problem, not solved it, and the total eligible count is what
  // quorum is measured against. Stake already POSTED is never surplus either: it
  // cannot be moved out (unstake() reverts StillSeated once seated), so only the
  // free part can ever be given away.
  const surplusOf = (v) => {
    const reserve = toStakeOf(v)
    return v.free > reserve ? v.free - reserve : 0n
  }
  const extraDonors = (Array.isArray(input?.donors) ? input.donors : []).map((dn) => ({
    address: String(dn?.address || ''),
    surplus: big(dn?.freeMicro),
  }))
  const pool = [
    ...fundable.map((v) => ({ address: v.address, surplus: surplusOf(v) })),
    ...extraDonors,
  ].filter((dn) => dn.surplus > 0n)

  const transfers = []
  const stakes = []
  const funded = []
  const unfunded = []

  const alreadyEligible = []

  for (const v of fundable) {
    // Already at minStake in the INCOMING registry: this step is DONE. Emitting a
    // stake() here would be worse than redundant — it would spend balance that the
    // still-unfunded validators need, so a re-run of a half-executed plan could
    // refuse where the first run succeeded.
    const toStake = toStakeOf(v)
    if (toStake === 0n) {
      funded.push(v)
      alreadyEligible.push(v.address)
      continue
    }
    let shortfall = need.get(v.address) ?? 0n
    // Already holds enough: no transfer, just a stake() call.
    for (const dn of pool) {
      if (shortfall === 0n) break
      if (dn.address === v.address || dn.surplus === 0n) continue
      const take = dn.surplus < shortfall ? dn.surplus : shortfall
      transfers.push({ from: dn.address, to: v.address, amountMicro: take })
      dn.surplus -= take
      shortfall -= take
    }
    if (shortfall === 0n) {
      funded.push(v)
      // Top-up, not the full minStake: stake() is cumulative.
      stakes.push({ address: v.address, amountMicro: toStake, alreadyStakedMicro: v.staked })
    } else {
      unfunded.push({ address: v.address, shortfallMicro: shortfall, live: v.live })
    }
  }

  // ── moment 2: the seats the FIRST rotate() produces ────────────────────────
  // Now the population is the eligible candidates — funded keys only. Different
  // set, different quorum, and it takes effect long after anyone is watching.
  const rotatedSeats = Math.min(funded.length, maxV)
  const rotatedQuorum = qbftQuorum(rotatedSeats)
  const rotatedLive = funded.filter((v) => v.live).length

  const totalFree = vals.reduce((a, v) => a + v.free, 0n)
    + extraDonors.reduce((a, dn) => a + dn.surplus, 0n)
  const trappedMicro = vals.reduce((a, v) => a + (v.seatedOutgoing ? v.trapped : 0n), 0n)

  if (trappedMicro > 0n) {
    warnings.push(
      `${Number(trappedMicro) / 1e6} units of stake are TRAPPED in the outgoing registry: unstake() reverts StillSeated() for every seated validator, and they are all seated. That stake cannot fund this migration — and after the swap nothing points at that contract, so nobody will think to look for it`,
    )
  }
  if (keyless.length) {
    warnings.push(
      `${keyless.length} address(es) the incoming registry seats cannot ever stake — we hold no key for them (${keyless.map((v) => v.address).join(', ')}). They occupy seats and raise quorum while contributing nothing, and sending them stake would burn it`,
    )
  }

  if (bornLive < bornQuorum) {
    blockers.push(
      `AT THE TRANSITION the incoming registry seats ${bornSeats} address(es) needing ${bornQuorum} signatures, but only ${bornLive} are producing blocks — the chain stops at the transition, before any stake matters. Seats at that moment come from the CONSTRUCTOR argument, not from stake`,
    )
  }
  if (rotatedSeats < minV) {
    blockers.push(
      `AT THE FIRST rotate() only ${rotatedSeats} candidate(s) would be eligible, under the registry's own floor of ${minV} — every rotation reverts BelowValidatorFloor and the seated set is frozen forever`,
    )
  } else if (rotatedLive < rotatedQuorum) {
    blockers.push(
      `AT THE FIRST rotate() the seated set becomes ${rotatedSeats} funded candidate(s) needing ${rotatedQuorum} signatures, of which ${rotatedLive} are live — the chain would run after the transition and halt at the next epoch boundary, which is the worst version of this failure because nothing connects the two events`,
    )
  }
  // ⚠️ THE FAILURE WITH NO ERROR MESSAGE. Gas is priced at zero on 8470, which reads
  // like "senders need no balance" — but a transaction from a zero-balance account is
  // ACCEPTED into the pool and then never mined and never rejected. There is no
  // revert, no receipt, and no log line: the plan simply stops happening. Every other
  // blocker here is something an operator eventually sees; this one they never do,
  // which is why it is checked before a single transaction is signed rather than
  // discovered by watching a step hang.
  // `null` means the caller never looked, which must not read as zero — that would
  // block every migration planned by a caller predating this field, and a check that
  // fires when it was never run is a check somebody deletes.
  //
  // ⚠️ There is no `hasKey` term here, and no `!== null` term either. Both looked like
  // sensible guards and both survived mutation: `needsToSign` already contains only
  // addresses that sign something (so a keyless address can never reach here), and
  // `null === 0n` is already false (so the null case is already excluded). Two filters
  // for one condition means one of them is never exercised, and the never-exercised one
  // is the one that rots into a lie.
  const gasless = vals.filter((v) => v.nativeWei === 0n)
  // Only addresses that must actually SEND something. A gasless address that signs
  // nothing — a keyless ghost, or a validator already at minStake — is irrelevant, and
  // blocking on it would refuse a migration that is perfectly executable.
  const needsToSign = new Set([
    ...transfers.map((t) => String(t.from).toLowerCase()),
    ...stakes.map((s) => String(s.address).toLowerCase()),
  ])
  const gaslessSigners = gasless.filter((v) => needsToSign.has(v.address.toLowerCase()))
  if (gaslessSigners.length) {
    blockers.push(
      `${gaslessSigners.length} signer(s) hold ZERO native balance (${gaslessSigners.map((v) => v.address).join(', ')}) — gas is priced at zero here, which is not the same as needing none: their transactions would be accepted into the pool and then NEVER mined and NEVER rejected. No revert, no receipt, no log. The plan would simply stop happening, which is the only failure here that an operator never sees`,
    )
  }

  if (unfunded.length) {
    const liveUnfunded = unfunded.filter((u) => u.live).length
    blockers.push(
      `${unfunded.length} validator(s) cannot reach minStake ${Number(minStake) / 1e6}${liveUnfunded ? ` (${liveUnfunded} of them LIVE)` : ''}: short by ${unfunded.map((u) => `${u.address} ${Number(u.shortfallMicro) / 1e6}`).join(', ')}. There is no more stake to find — mint() belongs to TinyIssuance since P3 and reverts for every key we hold, and the outgoing registry's stake is trapped behind StillSeated(). The only sources are the free balances already counted here`,
    )
  }

  if (!blockers.length) {
    if (transfers.length) {
      steps.push(
        ...transfers.map(
          (t) => `transfer ${Number(t.amountMicro) / 1e6} stake units from ${t.from} to ${t.to} (plain ERC-20 transfer — minting is no longer available)`,
        ),
      )
    }
    steps.push(
      ...stakes.map(
        (s) => `from ${s.address}: approve(${Number(s.amountMicro) / 1e6}) then stake(${Number(s.amountMicro) / 1e6}) on the INCOMING registry${s.alreadyStakedMicro > 0n ? ` (top-up — it has already staked ${Number(s.alreadyStakedMicro) / 1e6} there, and stake() is cumulative)` : ''}`,
      ),
    )
    if (alreadyEligible.length) {
      steps.push(
        `${alreadyEligible.length} validator(s) are ALREADY at minStake in the incoming registry and need no step (${alreadyEligible.join(', ')}) — re-running this plan after a partial execution must converge, not charge twice`,
      )
    }
    steps.push(
      'then re-run swap-preflight.mjs --incoming <new> and require exit 0 — this plan is a claim about the future too',
    )
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    steps,
    transfers,
    stakes,
    alreadyEligible,
    unfunded,
    keyless: keyless.map((v) => v.address),
    trappedMicro,
    totalFreeMicro: totalFree,
    atTransition: { seats: bornSeats, quorum: bornQuorum, live: bornLive },
    afterRotation: { seats: rotatedSeats, quorum: rotatedQuorum, live: rotatedLive, eligible: funded.length },
  }
}
