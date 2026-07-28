/**
 * Which memories an `unlearn` call is allowed to close.
 *
 * Backlog v9 A4 (same lens as A1/A3: a rule applied to someone else's input on
 * the way to an irreversible action). `unlearn`'s contract is
 * "id → close one, NO id → clear ALL", implemented as
 * `...(input.id ? { id: input.id } : {})`. Every falsy id therefore FALLS
 * THROUGH to clear-all:
 *
 *   { id: '42' } → { userId, id: '42' }   close one
 *   { id: ''   } → { userId }             ⚠️ CLEAR EVERYTHING
 *   {          } → { userId }             clear everything (intended)
 *
 * The empty string is the dangerous one, because it is exactly what a model
 * emits when it means "this memory" but has no id in hand — a schema-valid
 * `z.string()` that reads as intent and executes as annihilation. Verified by
 * probe against the tool's own zod schema.
 *
 * Why this outranks the sibling truncations: clear-all is the ONE destructive
 * memory operation that is not bitemporal. The tool's own description says a
 * single close "survives as history" while clear-all "also purges the semantic
 * index" — so a mistaken single close is recoverable and a mistaken clear-all
 * is not. And the asymmetry with the human path is stark: `MemoryPanel`'s
 * `forget()` puts a `danger` confirm in front of closing ONE RECOVERABLE
 * memory, while an agent could wipe all of them with a falsy string and no
 * confirmation of any kind — on the VOICE bridge too, where nobody is looking
 * at a screen (`app/api/voice/tool/route.ts` mounts `unlearn`).
 *
 * The rule: clear-all must be REQUESTED, never inferred. An explicit
 * `scope: 'all'` is the only way to reach it; a missing id is no longer
 * sufficient and a falsy id is refused outright. That keeps "close one" as the
 * default reading of an ambiguous call, which is the recoverable direction —
 * **when a destructive call is ambiguous, resolve it toward the outcome that
 * can be undone.**
 *
 * Pure — no fetch, no session — so every rule here is a node test.
 */

/** What the worker should be asked to do. */
export type UnlearnPlan =
  | { kind: 'one'; id: string }
  | { kind: 'all' }
  | { kind: 'refuse'; error: string }

/**
 * Resolve `unlearn`'s arguments into a plan.
 *
 * `scope` is the explicit opt-in for clear-all. `id` closes one. Anything
 * ambiguous is refused with copy the agent can act on, rather than being
 * resolved toward the destructive reading.
 */
export function planUnlearn(args: { id?: unknown; scope?: unknown }): UnlearnPlan {
  const wantsAll = args.scope === 'all'
  // Accept a number: ids render as `#42` in MemoryPanel and every SIBLING
  // memory-id field in this file is `z.union([z.string(), z.number()])`, so a
  // model that passes 42 is following the house convention, not misusing it.
  const rawId = typeof args.id === 'number' ? String(args.id) : args.id
  const hasId = typeof rawId === 'string' && rawId.trim() !== ''

  if (hasId && wantsAll) {
    // Contradictory: refuse rather than guessing which half was meant. Guessing
    // `all` destroys everything; guessing `one` ignores an explicit request.
    return {
      kind: 'refuse',
      error:
        "refused: got both an id and scope:'all' — nothing was closed. " +
        'Pass an id to close ONE memory, or scope:\'all\' alone to clear everything.',
    }
  }
  if (hasId) return { kind: 'one', id: (rawId as string).trim() }
  if (wantsAll) return { kind: 'all' }

  // The headline defect: a falsy id used to mean clear-all. An id that was
  // SUPPLIED but empty is a mistake, and the mistake's blast radius was every
  // memory the user ever stored.
  if (args.id !== undefined) {
    return {
      kind: 'refuse',
      error:
        'refused: the id was empty, and an empty id used to mean "clear ALL memories" — nothing was closed. ' +
        'Pass a real id from your context or a recall result, or scope:\'all\' if the user asked to erase everything.',
    }
  }
  // No id and no scope at all: this used to clear everything. Make the caller
  // say so, because clear-all also purges the semantic index and is the one
  // memory operation that cannot be undone.
  return {
    kind: 'refuse',
    error:
      'refused: unlearn needs either an id (close one memory, kept as history) or ' +
      "scope:'all' (erase EVERY memory and the semantic index — not recoverable). " +
      'Nothing was closed. Confirm with the user before clearing everything.',
  }
}

/** The worker request body for a plan that is going ahead. */
export function unlearnBody(userId: string, plan: UnlearnPlan): Record<string, string> {
  if (plan.kind === 'one') return { userId, id: plan.id }
  return { userId }
}

/** What the agent is told after a successful call, so it can't overstate it. */
export function unlearnNote(plan: UnlearnPlan): string {
  return plan.kind === 'all'
    ? 'Cleared ALL server-side memories and purged the semantic index — this is not recoverable.'
    : 'Closed — it leaves recall and listings but survives as history.'
}
