/**
 * 📝 WHAT EXACTLY GOES INTO THE GENESIS TO PERFORM THE REGISTRY SWAP?
 *
 * ⚠️⚠️ THE c25 FINDING, and the reason this file exists. `swap-preflight.mjs` says
 * whether the swap is SURVIVABLE. Both its gates are green. So the recorded next
 * step is "write the transition" — and the only script in the tree that writes one,
 * `switch-to-contract-mode.sh`, **CANNOT DO IT AND EXITS 0 SAYING SO**:
 *
 *     if any(t.get('validatorcontractaddress') for t in existing):
 *         print('already has a contract-mode transition — nothing to do')
 *         sys.exit(0)
 *
 * 8470 already has exactly such a transition — it is how the chain got into
 * contract mode at all. Run against the real genesis (on a copy), the writer prints
 * three lines of apparently successful work, then "nothing to do", and **exits 0
 * having changed nothing.** A gated operation whose executor is a silent no-op is
 * worse than one with no executor: nobody goes looking for a step that reported
 * success.
 *
 * 🔑 AND THE GUARD IS NOT MERELY STALE — INVERTING IT WOULD BE WRONG TOO. The line
 * below it reads `contract = d['validatorContract']`, which is the **OUTGOING**
 * registry. That script was written to move the chain from header mode to contract
 * mode, where "the registry" is unambiguous. A SWAP has two registries, and every
 * line of that script assumes one. So this is not a guard to delete; the swap needs
 * its own plan.
 *
 * 🔑 THE LENS (c24's, one level out): **A GREEN GATE SAYS THE OPERATION IS SAFE,
 * NEVER THAT ANYTHING CAN PERFORM IT.** Two cycles have ended by reporting "both
 * gates green, ready for the transition" — a claim about survivability read as a
 * claim about executability. Nothing had checked the executor, because the gate is
 * the thing that looks like the risk.
 *
 * ── THE FIVE CONSTRAINTS, read off the shipped besu 26.7.0 bytecode ──────────────
 * (`javap -c` on besu-config-26.7.0.jar and besu-consensus-common)
 *
 *  1. **Forks are a LIST and besu SORTS them itself** — `TreeSet` over
 *     `Comparator.comparing(block)` plus `Stream.sorted(...)` in
 *     `ForksScheduleFactory`. So the swap is an APPEND, and JSON array order is
 *     irrelevant. (A plan that tried to keep them ordered by hand would be
 *     maintaining an invariant besu does not read.)
 *  2. **"Duplicate transitions cannot be created for the same block"** — a
 *     `Preconditions.checkArgument`, so a collision is not a warning that the later
 *     entry wins: **besu refuses to start.** Every node, at once, on a chain whose
 *     recovery needs quorum. This is the sharpest constraint here and the one a
 *     hand-written edit is most likely to hit, because the natural key ("now + a
 *     lead") is computed from the clock and a re-run lands nearby.
 *  3. **"Transition cannot be created for genesis block"** — the key must be > 0.
 *  4. **"QBFT transition has config with contract mode but no contract address"** —
 *     `validatorselectionmode: 'contract'` requires the address; both keys or
 *     neither. (c7's cycle-costing bug was the mirror of this: the ADDRESS without
 *     the MODE is parsed and then silently ignored.)
 *  5. **The key is a TIMESTAMP whenever a `*Time` hardfork precedes it** (we have
 *     `shanghaiTime`), because besu adopts the milestone type of the nearest
 *     preceding hardfork. A block number there means 1970 — contract mode from
 *     block 1 — which every existing node ignores and every NEWCOMER dies on. That
 *     is design-doc §5.1, and `assessTransitionKey` in registry-swap-policy.mjs
 *     already owns the rule; this module does not restate it, it requires it.
 *
 * Pure: no fs, no RPC, no clock. The caller reads the genesis and passes it in.
 */
import { assessTransitionKey, MIN_TRANSITION_LEAD_S } from './registry-swap-policy.mjs'

const norm = (a) => (typeof a === 'string' ? a.trim().toLowerCase() : '')

/** The forks besu will actually read, or null when the shape is not what we assume. */
function qbftForks(genesis) {
  const t = genesis?.config?.transitions?.qbft
  return Array.isArray(t) ? t : null
}

/**
 * Plan the genesis edit that repoints Besu at a new validator registry.
 *
 * @param {object} input
 * @param {object} input.genesis    the parsed genesis.json (NOT mutated)
 * @param {string} input.incoming   the registry that should become authoritative
 * @param {string} input.outgoing   the registry that is authoritative today
 * @param {number} input.transitionKey  the key to write (timestamp — see constraint 5)
 * @param {number} input.nowSec     head block timestamp, for the lead check
 * @returns {{ok: boolean, blockers: string[], warnings: string[],
 *            fork: object|null, appendTo: string, existing: object[],
 *            summary: string}}
 *   `fork` is the exact object to append to `config.transitions.qbft`, or null when
 *   the plan refuses. It is never a partial edit: a genesis half-written is a chain
 *   that will not start.
 */
export function planGenesisTransition(input) {
  const blockers = []
  const warnings = []

  const genesis = input?.genesis && typeof input.genesis === 'object' ? input.genesis : null
  if (!genesis) {
    return {
      ok: false,
      blockers: ['no genesis given — nothing can be planned against an unread file'],
      warnings, fork: null, appendTo: 'config.transitions.qbft', existing: [],
      summary: 'REFUSE: no genesis',
    }
  }

  const forks = qbftForks(genesis)
  if (forks === null) {
    // Absent is fine for a header-mode chain, but 8470 is in contract mode, so the
    // absence of the list here means the file is not the one we think it is.
    blockers.push('config.transitions.qbft is missing or not an array — this genesis is not the contract-mode one this plan assumes; refusing rather than creating a structure besu may read differently')
  }
  const existing = forks || []

  const incoming = norm(input?.incoming)
  const outgoing = norm(input?.outgoing)
  if (!incoming) blockers.push('no incoming registry address given — constraint 4: contract mode without an address makes besu throw "QBFT transition has config with contract mode but no contract address"')
  if (incoming && incoming === outgoing) {
    blockers.push(`incoming and outgoing are the same address (${input.incoming}) — there is nothing to swap, and writing the fork would burn a transition key for no change`)
  }

  // ── constraint 5, delegated. The rule lives in ONE place; restating it here
  // would be a second opinion that can drift from the first.
  //
  // ⚠️ `timeBasedFork` is DERIVED, never assumed. 8470 has `shanghaiTime` today, so
  // hardcoding `true` would be right — and would stay "right" for the wrong reason
  // if that key were ever removed, which is the failure mode c7 cost a cycle on.
  // We are holding the file that answers the question; predicting it instead of
  // reading it is the mistake this loop keeps re-learning.
  const cfgKeys = Object.keys(genesis?.config || {})
  const timeBasedFork = cfgKeys.some((k) => /Time$/.test(k))
  const key = assessTransitionKey(input?.transitionKey, {
    nowSec: input?.nowSec,
    timeBasedFork,
    nowBlock: input?.nowBlock,
    blockPeriodS: Number(genesis?.config?.qbft?.blockperiodseconds) || undefined,
    minLeadS: input?.minLeadS ?? MIN_TRANSITION_LEAD_S,
  })
  if (!key.ok) blockers.push(key.reason)

  // ── constraint 2: THE ONE THAT STOPS EVERY NODE FROM STARTING.
  const wanted = Number(input?.transitionKey)
  const clash = existing.filter((t) => Number(t?.block) === wanted)
  if (clash.length) {
    blockers.push(`a transition already exists at key ${wanted} (${JSON.stringify(clash[0])}) — besu's ForksScheduleFactory asserts "Duplicate transitions cannot be created for the same block", so this is not a later-entry-wins situation: EVERY NODE WOULD REFUSE TO START, on a chain whose only recovery path needs a quorum of running nodes. Pick a different key`)
  }

  // ── constraint 3 needs no code here: assessTransitionKey already refuses any key
  // that is not a positive integer, and duplicating it would report the same defect
  // twice in different words.

  // Is the chain already where we are trying to send it? Checked against the fork
  // with the LARGEST key, because that is the one that ends up in effect — besu
  // sorts, so "the last array element" is not the same question (constraint 1).
  const contractForks = existing.filter((t) => norm(t?.validatorcontractaddress))
  const latest = contractForks.reduce(
    (a, t) => (a === null || Number(t?.block) > Number(a?.block) ? t : a),
    null,
  )
  if (latest && incoming && norm(latest.validatorcontractaddress) === incoming) {
    blockers.push(`the highest-keyed existing transition (key ${latest.block}) already names ${input.incoming} — the swap has already been written. Appending it again would burn a key and change nothing`)
  }
  if (latest && outgoing && norm(latest.validatorcontractaddress) !== outgoing) {
    // The genesis is the only thing besu actually obeys. If it disagrees with what
    // the caller believes is authoritative, every number in the preflight was
    // measured against the wrong contract.
    blockers.push(`the highest-keyed existing transition names ${latest.validatorcontractaddress}, but the caller says the outgoing registry is ${input.outgoing}. The GENESIS is what besu obeys, so one of the two is wrong and the preflight's liveness numbers were measured against the other one`)
  }
  if (!latest && existing.length) {
    warnings.push(`${existing.length} existing qbft transition(s), none of them contract-mode — this chain is in header mode, so the swap is really a first switch to contract mode and switch-to-contract-mode.sh is the right tool, not this plan`)
  }

  if (blockers.length) {
    return {
      ok: false, blockers, warnings, fork: null, timeBasedFork,
      appendTo: 'config.transitions.qbft', existing,
      summary: `REFUSE: ${blockers.length} blocker(s) — do not edit the genesis`,
    }
  }

  // Constraint 4: both keys, always, in the same object.
  const fork = {
    block: wanted,
    validatorselectionmode: 'contract',
    validatorcontractaddress: incoming,
  }
  return {
    ok: true, blockers, warnings, fork, timeBasedFork,
    appendTo: 'config.transitions.qbft', existing,
    summary: `append one fork at key ${wanted} (${key.leadS}s ahead, read as a ${timeBasedFork ? 'TIMESTAMP' : 'BLOCK NUMBER'}) repointing validators from ${input.outgoing} to ${input.incoming}; ${existing.length} existing transition(s) are left untouched and besu sorts by key itself`,
  }
}
