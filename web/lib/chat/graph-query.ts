/**
 * What a `memory_graph` call is actually asking for.
 *
 * Backlog v9 A3, and the item's own open question is what reframed it. A3 asked
 * "does the worker MATCH a truncated node, or return an empty result the agent
 * reads as 'no such memory'?" The worker answers it: `NEIGHBOR_EDGES_SQL` is
 * `WHERE owner = ?1 AND valid_to IS NULL AND (src = ?2 OR dst = ?2)` — an
 * EXACT match. `SOCIAL_NEIGHBORS_SQL` is the same (`e.src = ?1 OR e.dst = ?1`).
 * So a malformed argument cannot match anything, and the response is a
 * perfectly healthy `200 {ok:true, nodes:[], edges:[]}`.
 *
 * That is the defect, and it is bigger than a slice: **every malformed argument
 * to this tool comes back as an empty graph, and an empty graph is a CLAIM.**
 * The agent doesn't say "my query was wrong", it says "that memory isn't linked
 * to anything" or "@mert doesn't interact with anyone" — a false statement about
 * the user's own history, delivered confidently, with a 200 behind it. Unlike
 * v9 A1 (a DM) nothing is destroyed; unlike a 4xx nothing is even suspicious.
 *
 * Four ways to reach that empty result, all live before this module:
 *
 *   1. `rels` was `z.array(z.string())` with no validation, while the worker
 *      filters `relFilter.includes(e.rel)` against a FIXED vocabulary
 *      (`FACT_RELS = supersedes|part_of|authored|relates_to|about`). So
 *      `rels:['part-of']` — one hyphen — excludes every edge and reports an
 *      unlinked memory. The sibling field `learn.edges.rel` is a `z.enum`;
 *      this one was free-form (the same lone-outlier smell as c59's `z.string()`
 *      id, and again the outlier is on the query nobody double-checks).
 *   2. `input.rels.join(',').slice(0, 200)` cut the filter mid-word, which
 *      silently DROPS a relation — the agent asked for two rel types and got an
 *      answer about one.
 *   3. `String(input.node).slice(0, 120)` — A3's original line. Exact match
 *      means a truncated id is a guaranteed false empty.
 *   4. `if (input.node) qs.set('node', …)` on the social branch: a falsy node
 *      DROPPED the parameter, and dropping it is a documented MODE — "omit for
 *      trust ranking only". So `{mode:'social', node:''}` silently became the
 *      global leaderboard, whose response shape (`{edges:[], trust:{…}}`) is
 *      indistinguishable from "this person interacts with nobody". Fourth
 *      sighting of c59's rule that **a falsy value selecting a MODE is worse
 *      than one selecting a value** — and the first where the mode it lands on
 *      isn't destructive, just wrong about somebody.
 *
 * The rule, which is v9's lens turned around: a silent clamp is judged by
 * whether the caller can discover it, and here the caller CANNOT — an empty
 * result is exactly what a correct query on a sparse graph returns. So this
 * surface refuses instead of clamping, and every refusal names the vocabulary
 * or the id shape so the agent's next call can be right.
 *
 * Pure — no fetch, no session — so every rule here is a node test.
 */

/** The worker's `FACT_RELS`, which is what `rels` is filtered against. */
export const GRAPH_RELS = ['supersedes', 'part_of', 'authored', 'relates_to', 'about'] as const
export type GraphRel = (typeof GRAPH_RELS)[number]

/**
 * The worker bounds `node` at 120 chars itself (`GraphNeighborsCall`,
 * `SocialGraphCall`). We refuse rather than pre-trim to that number: real ids
 * are `mig12:<n>`, a legacy integer, `user:<id>` or `tiny:<slug>` — all far
 * shorter — so anything longer is a mistake, and truncating a mistake into an
 * exact-match lookup manufactures a confident "no such memory".
 */
export const NODE_MAX = 120

export type GraphPlan =
  | { kind: 'neighbors'; node: string; hops: 1 | 2; rels?: GraphRel[] }
  | { kind: 'social'; node?: string }
  | { kind: 'feed' }
  | { kind: 'refuse'; error: string }

export type GraphArgs = { mode?: unknown; node?: unknown; hops?: unknown; rels?: unknown }

const refuse = (error: string): GraphPlan => ({ kind: 'refuse', error })

/** A number is a legitimate memory id here (legacy rows are integers). */
function rawNode(node: unknown): string | null {
  if (typeof node === 'number') return Number.isFinite(node) ? String(node) : null
  return typeof node === 'string' ? node.trim() : null
}

/**
 * Social nodes live in the shared `_social` graph under ids the platform
 * writes itself: `userNodeId = user:<id>` and `tinyNodeId = tiny:<slug>`
 * lowercased. Lowercasing a `tiny:` slug is therefore information-preserving
 * (the writer already did it); everything else is refused, because a bare
 * `mert` or `@mert` matches no row and comes back as "interacts with nobody".
 */
function normalizeSocialNode(node: string): { ok: true; node: string } | { ok: false; error: string } {
  const m = /^(user|tiny):(.+)$/i.exec(node)
  if (!m) {
    return {
      ok: false,
      error:
        `refused: '${node}' is not a social node id, so it would match nothing and come back as ` +
        'an empty graph (which reads as "they interact with nobody"). Social nodes are ' +
        "'tiny:<slug>' for a tiny or 'user:<id>' for a person — note it's the numeric user ID, " +
        'not their @login. Omit node entirely for the global trust ranking.',
    }
  }
  const prefix = m[1].toLowerCase()
  const rest = m[2].trim()
  // ⚠️ This branch is UNREACHABLE as written, and is kept as defence-in-depth
  // rather than given a test that only appears to cover it. `rawNode` already
  // trimmed the whole string, so an all-whitespace body leaves the string
  // ending in ':' — which `.+` cannot match, so `tiny:   ` fails the regex and
  // is refused by the !m branch above with the better message. Verified
  // exhaustively over every single-code-point body in 0..0x11000: zero reach
  // it. It exists because relaxing the regex (a `\s` class, a `*`) would make
  // it live, and an empty id reaching an exact-match lookup is exactly the
  // false-empty this module exists to prevent.
  if (!rest) {
    return {
      ok: false,
      error: `refused: '${node}' has no id after the '${prefix}:' prefix — nothing was queried.`,
    }
  }
  return { ok: true, node: prefix === 'tiny' ? `tiny:${rest.toLowerCase()}` : `user:${rest}` }
}

/** 1 or 2 — the worker clamps identically. A clamped depth IS visible in the
 *  returned subgraph, so this one is a legitimate clamp, not a silent loss. */
function planHops(hops: unknown): 1 | 2 {
  const n = Math.round(Number(hops))
  return Number.isFinite(n) && n >= 2 ? 2 : 1
}

function planRels(rels: unknown): { ok: true; rels?: GraphRel[] } | { ok: false; error: string } {
  if (rels === undefined || rels === null) return { ok: true }
  if (!Array.isArray(rels)) {
    return { ok: false, error: `refused: rels must be an array of relation names (${GRAPH_RELS.join(', ')}).` }
  }
  const wanted = rels.map((r) => (typeof r === 'string' ? r.trim() : String(r)))
  if (!wanted.length) return { ok: true } // an empty filter means "no filter", same as omitting it
  const unknown = wanted.filter((r) => !(GRAPH_RELS as readonly string[]).includes(r))
  if (unknown.length) {
    return {
      ok: false,
      error:
        `refused: ${unknown.map((r) => `'${r}'`).join(', ')} ${unknown.length > 1 ? 'are not' : 'is not'} ` +
        `a graph relation, and an unknown filter excludes EVERY edge — you would get an empty ` +
        `graph that looks like an unlinked memory. Valid relations: ${GRAPH_RELS.join(', ')}. ` +
        'Omit rels to see all links.',
    }
  }
  // Dedupe, preserving the caller's order (the worker's filter is a set test).
  return { ok: true, rels: Array.from(new Set(wanted)) as GraphRel[] }
}

/** Resolve a `memory_graph` call into something that can actually match. */
export function planGraphQuery(args: GraphArgs): GraphPlan {
  const mode = args.mode === undefined || args.mode === null ? 'neighbors' : args.mode
  if (mode !== 'neighbors' && mode !== 'social' && mode !== 'feed') {
    return refuse(`refused: mode must be 'neighbors', 'social' or 'feed' (default 'neighbors').`)
  }
  if (mode === 'feed') return { kind: 'feed' }

  const node = rawNode(args.node)
  const supplied = args.node !== undefined && args.node !== null

  if (supplied && node !== null && node.length > NODE_MAX) {
    return refuse(
      `refused: that node id is ${node.length} characters (max ${NODE_MAX}) — nothing was queried. ` +
        'A truncated id matches nothing, and the empty result would look like "no such memory". ' +
        'Pass an id exactly as it appears in your context or a recall result.',
    )
  }
  if (supplied && !node) {
    // The falsy-argument case. On the social branch this used to fall through to
    // a DIFFERENT MODE (global trust ranking); on neighbors it reached the
    // worker as `node=` and 400'd. Both are refused here, by name.
    return refuse(
      mode === 'social'
        ? "refused: the node was empty, and an empty node used to mean \"global trust ranking\" — " +
          'so you would have gotten a leaderboard instead of an answer about anyone. Pass ' +
          "'tiny:<slug>' or 'user:<id>', or omit node deliberately for the ranking."
        : 'refused: the node id was empty — nothing was queried. Pass a memory id from your ' +
          'context or a recall result.',
    )
  }

  if (mode === 'social') {
    if (!supplied || node === null) return { kind: 'social' } // trust ranking only, by design
    const normalized = normalizeSocialNode(node)
    return normalized.ok ? { kind: 'social', node: normalized.node } : refuse(normalized.error)
  }

  if (!supplied || node === null) {
    return refuse("refused: neighbors mode needs a memory id (from your context or a recall result).")
  }
  const rels = planRels(args.rels)
  if (!rels.ok) return refuse(rels.error)
  return { kind: 'neighbors', node, hops: planHops(args.hops), ...(rels.rels ? { rels: rels.rels } : {}) }
}

/** Query string for a plan that is going ahead (`userId` added by the caller). */
export function graphQueryParams(plan: GraphPlan): Record<string, string> {
  if (plan.kind === 'neighbors') {
    return {
      node: plan.node,
      ...(plan.hops === 2 ? { hops: '2' } : {}),
      ...(plan.rels?.length ? { rels: plan.rels.join(',') } : {}),
    }
  }
  if (plan.kind === 'social') return plan.node ? { node: plan.node } : {}
  return {}
}

/**
 * What to tell the agent about a result that came back EMPTY.
 *
 * The refusals above remove the ways an empty result can be a lie about the
 * query; this removes the last way it can be a lie about the GRAPH. A filtered
 * neighbors call and a node-less social call both legitimately return nothing,
 * and in both cases "nothing" means something narrower than the agent will
 * assume unless told.
 */
export function graphEmptyNote(plan: GraphPlan, edgeCount: number): string | undefined {
  if (edgeCount > 0) {
    return plan.kind === 'social' && !plan.node
      ? 'This is the GLOBAL trust ranking — no node was given, so it is not about any particular person.'
      : undefined
  }
  if (plan.kind === 'neighbors') {
    return plan.rels?.length
      ? `No ${plan.rels.join('/')} links — the filter was applied, so this memory may still have links of other kinds. Retry without rels before telling the user it stands alone.`
      : 'No links on this memory — it stands alone in the graph (this is a real answer, not a failed lookup).'
  }
  if (plan.kind === 'social') {
    return plan.node
      ? `No public interactions recorded for ${plan.node} yet. Private things (DMs) never appear here, so this is "nothing public", not "nothing".`
      : 'No node was given, so there are no edges by construction — the trust ranking below is global.'
  }
  return undefined
}
