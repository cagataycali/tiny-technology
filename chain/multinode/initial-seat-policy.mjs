/**
 * 🪑 INITIAL SEAT POLICY — which addresses should a FRESH registry seat at birth?
 *
 * ⚠️⚠️ WHY THIS EXISTS. `deploy-validators-slashable.mjs` seeds its constructor
 * from the outgoing registry's `getValidators()` — the SEATED set — and its own
 * docblock explains why: a registry seeded from the deployment file's founders
 * would describe a set that no longer exists. That reasoning is right and the
 * implementation still inherits every ghost, because *seated* is not *live*. c19
 * measured it: the outgoing set holds `0x5CbDd86a…`, which is silent, keyless, and
 * holds 2500 units of stake nobody can ever move. A fresh registry seeded that way
 * is born with the exact problem the fresh deploy was supposed to escape, and c18's
 * remediation claimed otherwise in so many words ("born seating exactly the
 * validators that are producing blocks").
 *
 * 🔑 SO THE SEED IS A DECISION, NOT A READ. And it is close to irreversible: a
 * validator left out of the constructor can only get back in by staking, and after
 * P3 there is no mint — so a wrongly-dropped seat may be unrecoverable. That makes
 * the failure asymmetric, and this module refuses rather than guesses:
 *
 *   - **an inadequate evidence window is a REFUSAL, not a shrug.** Below one full
 *     round-robin ×3, a healthy validator that simply has not had its turn reads as
 *     silent (c15) — and here "reads as silent" means "loses its seat forever". A
 *     shorter window makes MORE addresses look droppable, so the dangerous
 *     direction is the one that looks tidier.
 *   - **dropping below the registry's own floor is a REFUSAL**: the constructor
 *     reverts BadConfig, and a caller who does not know that reads the revert as a
 *     deploy bug rather than as this decision.
 *   - **a live proposer is never dropped for being keyless.** It still signs blocks,
 *     so it still carries the transition; it merely cannot be funded, which is the
 *     next moment's problem (see stake-migration-plan.mjs) and is reported as such.
 *
 * Pure: no RPC, no fs, no clock.
 */

/** Normalise to a lowercase key for set comparison; addresses arrive checksummed. */
const key = (a) => String(a || '').toLowerCase()

/**
 * @param {object} input
 * @param {string[]} input.seatedOutgoing  the outgoing registry's getValidators()
 * @param {string[]} input.proposers       addresses observed proposing in `window`
 * @param {number} input.window            how many blocks of evidence were sampled
 * @param {number} input.minValidators     the incoming registry's floor
 * @param {number} input.maxValidators     the incoming registry's cap
 * @param {string[]} [input.keyholders]    addresses whose private key we hold
 * @param {Record<string, bigint|string|number>} [input.trappedMicro]  stake each
 *   dropped address leaves behind, purely so the report can name what is forfeited.
 */
export function pickInitialValidators(input) {
  const seated = (Array.isArray(input?.seatedOutgoing) ? input.seatedOutgoing : []).map(String)
  const live = new Set((Array.isArray(input?.proposers) ? input.proposers : []).map(key))
  const keys = new Set((Array.isArray(input?.keyholders) ? input.keyholders : []).map(key))
  const minV = Math.max(1, Math.floor(Number(input?.minValidators) || 1))
  const maxV = Math.max(1, Math.floor(Number(input?.maxValidators) || 21))
  const window = Math.max(0, Math.floor(Number(input?.window) || 0))

  const blockers = []
  const warnings = []

  // One full round-robin of the OUTGOING set is the minimum meaningful sample, ×3
  // so that an absence is a pattern rather than a scheduling artefact. Deriving the
  // requirement from the set we are judging (not from the answer) is what keeps a
  // small window from silently justifying itself.
  const requiredWindow = Math.max(seated.length, 1) * 3
  const windowOk = window >= requiredWindow

  const keep = seated.filter((a) => live.has(key(a)))
  const dropped = seated.filter((a) => !live.has(key(a)))
  // A live proposer the outgoing registry does NOT seat is a real thing (it was
  // seated by a rotation the file predates, or it is mid-join). Seat it: it is
  // already carrying consensus.
  const liveUnseated = [...live].filter((a) => !seated.some((s) => key(s) === a))
  const chosen = [...keep, ...liveUnseated]

  if (!windowOk) {
    blockers.push(
      `evidence window of ${window} block(s) is too short to call anyone silent — one full round-robin of the ${seated.length}-seat outgoing set ×3 is ${requiredWindow}. A validator that has simply not had its turn would be dropped from the constructor, and after P3 there is no mint to re-stake with, so that seat may be unrecoverable. A SHORTER window makes more addresses look droppable, which is why this refuses instead of proceeding`,
    )
  }
  if (chosen.length < minV) {
    blockers.push(
      `only ${chosen.length} of the ${seated.length} seated address(es) are demonstrably live, under the incoming registry's floor of ${minV} — the constructor would revert BadConfig, which reads like a deploy bug rather than like this decision. Start more validators before deploying; a different seed cannot conjure signers`,
    )
  }
  if (chosen.length > maxV) {
    blockers.push(
      `${chosen.length} live validator(s) exceeds the incoming registry's cap of ${maxV} — the constructor reverts BadConfig. Raise maxValidators or seat a subset, and note that a subset is a choice about who keeps producing blocks`,
    )
  }

  for (const a of dropped) {
    const trapped = input?.trappedMicro?.[a] ?? input?.trappedMicro?.[key(a)] ?? 0
    let amount = 0n
    try {
      amount = BigInt(trapped)
    } catch {
      amount = 0n
    }
    warnings.push(
      `${a} is seated today but has not proposed in ${window} block(s) — it is NOT being seated in the fresh registry${amount > 0n ? `, and the ${Number(amount) / 1e6} unit(s) it staked in the outgoing registry stay there: unstake() reverts StillSeated() while it is seated, and after the swap nothing points at that contract` : ''}${keys.size && !keys.has(key(a)) ? '. We hold no key for it, so it could never have staked into the new registry anyway' : ''}`,
    )
  }
  for (const a of chosen) {
    if (keys.size && !keys.has(key(a))) {
      warnings.push(
        `${a} is live and IS being seated (it signs blocks, so it carries the transition) but we hold no key for it — it can never stake, so the first rotate() will drop it. Check that the set still has quorum after that: see stake-migration-plan.mjs`,
      )
    }
  }
  if (liveUnseated.length) {
    warnings.push(
      `${liveUnseated.length} live proposer(s) are NOT seated by the outgoing registry and are being seated here (${liveUnseated.join(', ')}) — they are already carrying consensus, so leaving them out would drop real signers`,
    )
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    // Deterministic order: the outgoing set's order first (so a redeploy of an
    // unchanged chain produces an identical constructor argument), then newcomers.
    initial: blockers.length === 0 ? chosen : [],
    dropped,
    liveUnseated,
    requiredWindow,
    windowOk,
  }
}
