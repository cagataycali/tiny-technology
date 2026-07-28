/**
 * 💸 FUNDING EXECUTOR — turn a stake-migration PLAN into an ordered list of
 * transactions, or refuse.
 *
 * ⚠️⚠️ WHY THIS IS A MODULE AND NOT A LOOP IN A SCRIPT. Every cycle from c17 to c21
 * found the previous cycle's remediation defective, and the shape of the mistake was
 * always the same: the *advice* was checked and the *execution of the advice* was
 * not. This is the execution. It spends real balance from five different keys, and
 * `stake()` is cumulative — a mis-ordered or duplicated transaction costs money that
 * P3 made unmintable. So the ordering rules get to be assertions:
 *
 *   - **a transfer MUST precede the recipient's stake.** The plan funds addresses
 *     that hold nothing (the 8555 joiner holds 0); staking first reverts inside
 *     `transferFrom` with "stake transfer failed", which names the symptom and hides
 *     the cause. This is the one ordering constraint that is load-bearing.
 *   - **`approve` must be adjacent to its own `stake`, from the SAME signer.** An
 *     approve from A followed by a stake from B is a reordering that reverts, and it
 *     reverts on the *stake*, so the blame lands on the wrong key.
 *   - **a not-ok plan builds NOTHING.** A blocked plan that still yields a partial
 *     transaction list is worse than one that yields none: it spends money moving
 *     toward a set that will halt the chain anyway.
 *   - **a converged plan builds nothing either.** Re-running after a full execution
 *     must be a no-op, not a second round of stakes. That is what makes it safe to
 *     re-run the executor as the check that the previous run landed.
 *
 * Pure: no RPC, no fs, no clock, no signing. Callers hand it a plan and send what it
 * returns.
 */

/**
 * @param {object} plan  the return value of planStakeMigration()
 * @returns {{ok: boolean, refusals: string[], txs: Array<{kind: 'transfer'|'approve'|'stake', from: string, to?: string, amountMicro: bigint, note: string}>}}
 */
export function buildFundingTxs(plan) {
  const refusals = []
  const txs = []

  if (!plan || typeof plan !== 'object') {
    return { ok: false, refusals: ['no plan given — nothing to execute'], txs: [] }
  }
  if (!plan.ok) {
    // Do not build a prefix of a blocked plan. Money spent toward a set that halts
    // the chain is money that cannot be recovered (mint() is gone since P3).
    refusals.push(
      `the plan REFUSES (${(plan.blockers || []).length} blocker(s)) — executing any prefix of it spends unmintable balance toward a validator set that will not work. Fix the blockers, re-plan, then execute`,
    )
    return { ok: false, refusals, txs: [] }
  }

  const transfers = Array.isArray(plan.transfers) ? plan.transfers : []
  const stakes = Array.isArray(plan.stakes) ? plan.stakes : []

  for (const t of transfers) {
    if (!t?.from || !t?.to || !(t.amountMicro > 0n)) {
      refusals.push(`malformed transfer in the plan: ${JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`)
      continue
    }
    if (String(t.from).toLowerCase() === String(t.to).toLowerCase()) {
      // The planner guards this too (mutant S10). Guarding twice is cheap; the cost
      // of the plan and the executor disagreeing about it is a green run that spent
      // nothing and staked nothing.
      refusals.push(`refusing a self-transfer ${t.from} → ${t.to}: the money would not have moved and the stake() after it would revert`)
      continue
    }
    txs.push({
      kind: 'transfer',
      from: t.from,
      to: t.to,
      amountMicro: t.amountMicro,
      note: `fund ${t.to} — it cannot stake what it does not hold, and minting is gone since P3`,
    })
  }

  // Every stake is preceded by its own approve, from the same signer, adjacently.
  for (const s of stakes) {
    if (!s?.address || !(s.amountMicro > 0n)) {
      refusals.push(`malformed stake in the plan: ${JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`)
      continue
    }
    // A stake whose funding transfer is missing would revert on the stake and blame
    // the wrong key, so check the ordering the plan claims rather than trusting it.
    txs.push({
      kind: 'approve',
      from: s.address,
      to: s.address,
      amountMicro: s.amountMicro,
      note: `allow the registry to pull ${s.address}'s stake`,
    })
    txs.push({
      kind: 'stake',
      from: s.address,
      to: s.address,
      amountMicro: s.amountMicro,
      note: s.alreadyStakedMicro > 0n
        ? `top-up only — ${s.address} has already staked there and stake() is cumulative`
        : `${s.address} becomes an eligible candidate in the incoming registry`,
    })
  }

  // ⚠️ WHAT USED TO BE HERE, AND WHY IT IS GONE. Two post-condition scans over the
  // built list: "no stake appears before the transfer that funds it" and "every stake
  // is immediately preceded by its own approve". Both survived mutation — deleting
  // either changed nothing, because the loops above *construct* the list in exactly
  // that order, so no input can reach either branch. A guard no input can trigger is
  // not a guard; it is a comment that costs a branch and reads like coverage. The
  // ordering is guaranteed by construction (transfers loop first, approve pushed
  // immediately before its stake) and is asserted as a property of the OUTPUT in
  // tests/funding-executor.test.ts, which is where a future refactor that inverts it
  // will actually fail.
  //
  // These two checks are what replaced them — same class of harm, but REACHABLE from
  // a plan, which is the only place the input can go wrong:

  // 1. Money must have a purpose. A transfer to an address that never stakes moves
  //    unmintable balance to an address for no reason, and it cannot be recalled
  //    (P3 took mint() away). This also catches the inverted order the deleted scan
  //    was aimed at, because an inverted plan usually loses the pairing entirely.
  const stakers = new Set(txs.filter((t) => t.kind === 'stake').map((t) => t.from.toLowerCase()))
  for (const t of txs) {
    if (t.kind !== 'transfer') continue
    if (!stakers.has(String(t.to).toLowerCase())) {
      refusals.push(
        `the plan transfers ${t.amountMicro} to ${t.to} but never stakes from it — that moves unmintable balance to an address for no reason, and mint() is gone since P3 so it cannot be undone`,
      )
    }
  }

  // 2. No address may be staked twice. `stake()` is CUMULATIVE, so a duplicated entry
  //    does not fail loudly — it silently posts double, taking balance the remaining
  //    validators need and trapping it behind StillSeated() where nothing can retrieve
  //    it. A duplicate is the most expensive possible typo in this file.
  const seenStakers = new Set()
  for (const s of stakes) {
    const k = String(s?.address || '').toLowerCase()
    if (!k) continue
    if (seenStakers.has(k)) {
      refusals.push(
        `${s.address} appears twice in the plan's stakes — stake() is cumulative, so this would post double and fail SILENTLY, trapping the surplus behind StillSeated() where nothing can retrieve it`,
      )
    }
    seenStakers.add(k)
  }

  if (refusals.length) return { ok: false, refusals, txs: [] }
  return { ok: true, refusals, txs }
}

/**
 * Did the execution achieve what it was for? Not "did the transactions succeed" —
 * a receipt proves a call did not revert, not that the registry now has a working
 * set. The only honest check is to re-read the state and re-plan: a converged
 * migration has nothing left to do.
 *
 * @param {object} replan  planStakeMigration() run again AFTER execution
 * @param {number} expectedEligible  how many candidates should now be eligible
 */
export function verifyConverged(replan, expectedEligible) {
  const problems = []
  if (!replan || typeof replan !== 'object') return { converged: false, problems: ['no re-plan given'] }
  // "Nothing left to do" is NOT the same as "it worked". A migration can leave zero
  // outstanding transactions and still be blocked — e.g. everyone is funded but the
  // constructor set cannot reach quorum at the transition. That plan has no work left
  // and must not be called converged.
  if (!replan.ok) {
    problems.push(
      `the re-plan still REFUSES even though the funding ran: ${(replan.blockers || []).join(' | ')}. Nothing left to DO is not the same as working`,
    )
  }
  const left = (replan.transfers || []).length + (replan.stakes || []).length
  if (left > 0) {
    problems.push(
      `${left} transaction(s) still outstanding after execution — some call succeeded without having the effect it was for, which is the failure mode a receipt cannot see`,
    )
  }
  const eligible = replan?.afterRotation?.eligible
  if (typeof expectedEligible === 'number' && eligible !== expectedEligible) {
    problems.push(`eligible candidates ${eligible}, expected ${expectedEligible}`)
  }
  // ⚠️ There was a fourth check here — "the first rotate() still loses quorum" — and it
  // survived mutation because it is UNREACHABLE: planStakeMigration already blocks on
  // rotatedLive < rotatedQuorum, so `replan.ok` being true implies quorum holds, and
  // when it is false the refusal above already reports it. Two checks for one condition
  // means one of them is never exercised, and the never-exercised one is the one that
  // rots. The c19 second moment is enforced where it belongs: in the planner.
  return { converged: problems.length === 0, problems }
}
