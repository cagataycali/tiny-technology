/**
 * What a `DELETE /api/learnings` request is allowed to erase.
 *
 * The rule already existed — [planUnlearn] enforces it for the agent tool — and
 * the HTTP boundary that every UI crosses did not use it. What the route had
 * instead LOOKED like the rule:
 *
 *   body: JSON.stringify({ userId, ...(id !== undefined && id !== '' ? { id } : {}) })
 *
 * That test does not refuse a blank id, it OMITS it, and omission is the wire
 * form of "erase everything": the worker's `else` branch purges every fact and
 * every fact edge the user owns (`PURGE_ALL_FACTS_SQL`,
 * `PURGE_ALL_FACT_EDGES_SQL`), runs an unqualified
 * `DELETE FROM learnings WHERE user_id = ?`, and hands every one of their
 * vectors to `MEMORY.deleteByIds` (`worker/src/learnings.ts`). So:
 *
 *   { id: '42' } → { userId, id: '42' }   close one, recoverable as history
 *   { id: ''   } → { userId }             ⚠️ ERASE EVERYTHING, not recoverable
 *   (no body)    → { userId }             ⚠️ ERASE EVERYTHING
 *
 * Both danger rows are reachable from a swipe on a SINGLE row. iOS decodes an
 * id straight off the wire (`Panels.swift` `decodeLearnings` keeps `""` — only
 * a MISSING id gets the safe `UUID()` fallback) and builds the body with
 * `try? JSONSerialization.data(...)`, so a body that fails to encode is sent as
 * no body at all, which this route then read as clear-all. The failure mode of
 * "we could not say which memory to delete" was "delete all of them".
 *
 * ⚠️ The reason this survived review: `tests/unlearn-scope.test.ts` PINNED the
 * old line as proof the route was already safe ("the HTTP route already guarded
 * the empty id — the tool was the outlier"). A passing test certified the defect
 * as the fix, because `id !== ''` reads as a guard and behaves as an escalation.
 * When a test asserts that some OTHER file is safe, it has to assert the safe
 * BEHAVIOUR, not the presence of a line that looks reassuring.
 *
 * ── Where this differs from [planUnlearn], and why ──
 * A bare `{}` body still means clear-all here. `planUnlearn` refuses it, and
 * that is right for a model, which can be told to try again with `scope:'all'`.
 * But `{}` is the DOCUMENTED wire form of clear-all for a published client we
 * cannot redeploy tonight: tiny-tech's `tiny_unlearn` advertises "omit to close
 * ALL memories" and sends `id ? { id } : {}`. Refusing `{}` would break a
 * shipped capability; refusing a blank id breaks nothing. So the boundary
 * refuses every INFERRED clear-all and keeps the one REQUESTED form.
 *
 * ⚠️ Remaining inference, with a named owner: because tiny-tech collapses a
 * falsy id into `{}`, an MCP agent holding an empty id still reaches clear-all
 * through the documented door. Closing that means teaching tiny-tech to send
 * `scope: 'all'` (its own repo, `npm publish` user-gated) and only then dropping
 * the `{}` allowance below. Until it ships, this is a seam, not a fix.
 *
 * Pure — takes the raw body text, returns a plan — so every rule here is a node
 * test.
 */
import { planUnlearn, type UnlearnPlan, type UnlearnRefusal } from './unlearn-scope'

/**
 * Resolve a raw `DELETE /api/learnings` body into a plan.
 *
 * Takes TEXT, not parsed JSON, because "the body could not be parsed" is one of
 * the cases that used to mean annihilation — the route reached it through
 * `req.json().catch(() => ({}))`, which turns any unreadable body into the
 * clear-all shape. A parse failure is now a refusal, so the ambiguity resolves
 * toward the outcome that can be undone.
 */
export function planLearningsDelete(rawBody: string): UnlearnPlan {
  const refuse = (reason: UnlearnRefusal): UnlearnPlan => ({
    kind: 'refuse',
    reason,
    error: deleteRefusalForHumans(reason),
  })

  // No body at all — iOS's `try?` encode failure arrives exactly like this.
  if (rawBody.trim() === '') return refuse('unreadable-body')

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return refuse('unreadable-body')
  }
  // `null`, an array or a bare scalar are all valid JSON and none of them can
  // name a memory. Reject the SHAPE rather than indexing into it and finding
  // `undefined`, which is the reading that meant clear-all.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('unreadable-body')
  }

  const args = parsed as Record<string, unknown>
  // The one deliberate omission: neither field present. Anything that SUPPLIED
  // an id or a scope is judged by the shared rule, so a blank id is refused
  // instead of falling through to the same wire shape as this line.
  if (!('id' in args) && !('scope' in args)) return { kind: 'all' }
  return planUnlearn(args)
}

/**
 * The refusal as a PERSON reads it.
 *
 * `MemoryPanel` toasts the route's `error` verbatim (`toast.error(d.error || …)`)
 * so these are UI copy, not agent copy — [planUnlearn]'s own strings tell a
 * model to retry with a real id, which is nonsense on a phone. Every line says
 * what did NOT happen, because a refusal that reads like a result is the failure
 * this whole module exists to prevent.
 *
 * A `Record` and not a `switch`: adding a cause to [UnlearnRefusal] then fails
 * to compile until it has words, which is the cheapest possible live gate.
 */
export function deleteRefusalForHumans(reason: UnlearnRefusal): string {
  const copy: Record<UnlearnRefusal, string> = {
    // Deliberately does NOT say "try again" — the same blank id will fail the
    // same way. Reloading is what can actually help, so ask for that instead.
    'blank-id':
      "Couldn't tell which memory that was, so nothing was deleted. Reload your memories and try again.",
    'unreadable-body':
      "Couldn't read that request, so nothing was deleted. Reload your memories and try again.",
    unscoped:
      "Erasing every memory has to be asked for explicitly, so nothing was deleted.",
    contradictory:
      "Got both one memory and 'erase everything' in the same request, so nothing was deleted.",
  }
  return copy[reason]
}
