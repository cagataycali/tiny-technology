/**
 * Which tiny is the config editor actually editing?
 *
 * Backlog v12 (lens = "a value scoped to one SUBJECT still on screen after the
 * subject changed"). The two items the survey named — Chat's `name`-keyed
 * effects and the memory/jobs panels — both came back clean when verified:
 * Next keys each dynamic-segment subtree, so a slug change remounts Chat
 * (`layout-router.js`: the segment `child` is keyed on its state key), and
 * `MemoryGraph` already validates its `selected` id against the node set it
 * just received. `Control.tsx` is where the lens actually lands, and it is the
 * worst place for it, because in that component **the subject is an editable
 * text field** rather than a route.
 *
 * `Control` is one form over N tinys. Blurring the name input refetches that
 * tiny's whole config and replaces every field (`handleBlurFormItem` →
 * `applyTinyData`), and a second fetch loads its price. Neither had a
 * latest-wins guard — the only `reqRef`-less subject-keyed loads left in the
 * app (`MemoryPanel` alone carries three of those tokens). So:
 *
 *   type "b", blur → GET b starts
 *   type "a", blur → GET a starts, resolves first, form shows a
 *   GET b resolves → form is silently repainted with **b's** system prompt,
 *                    memory, worker, theme and MCP config, while the name
 *                    field still says "a"
 *
 * That alone is a cosmetic staleness. What makes it a defect is the harm
 * question this lens ends with — **does anything SEND, PAY or DELETE with it?**
 * Three controls do, and they split cleanly in two:
 *
 *   • `/api/delete` sends the name and NOTHING ELSE. Its confirm dialog quotes
 *     the same value and demands it be typed back, and `purgeTinyKeys` uses
 *     that value too. A mismatched form cannot misdirect it — so it is
 *     deliberately NOT gated here. (Recorded so a later cycle doesn't "fix" it.)
 *   • `/api/control` (save) and `/api/wallet` `set_price` send the name PLUS
 *     state that was loaded for a different name. Save writes the prompt,
 *     knowledge, worker, skills, chips, theme and MCP servers on screen; the
 *     price call writes `priceForm`. Those are the ones that can commit tiny
 *     B's content — or B's price — to tiny A, report "Tiny AI saved! 🎉", and
 *     leave no trace: the stale load has already repainted the form, so what
 *     the user sees afterwards is exactly what they think they saved.
 *
 * The save path has one more property worth naming, because it is what makes
 * this worth a guard rather than a comment: `/api/control` sends the whole
 * document, and the worker "preserves undefined, overwrites ''". So a stale
 * form does not merge — it REPLACES, field by field, including clearing ones
 * the target tiny had set.
 *
 * THE RULE, which is the reusable half: **a mutation carrying only the subject
 * is safe to fire whenever; a mutation carrying the subject plus state loaded
 * FOR a subject must refuse unless the two subjects agree.**
 *
 * Note on the staleness guard: it keys on the NAME, not on a monotonic request
 * counter, and that is stronger here rather than weaker. The response is a pure
 * function of the name, so a slow reply for the name the field currently holds
 * is still the right answer — typing b → a → b must apply the first b's data,
 * which a counter would throw away and refetch.
 */

/**
 * The comparison key. The save path posts `nameForm.toLowerCase()` and
 * `ownsThisTiny` matches `me.tinys` on the same lowercased value, so a
 * case-only difference is the SAME subject and must not read as a mismatch —
 * otherwise typing your own tiny as "MyTiny" would block your own save.
 *
 * Deliberately not `slugify`: this decides whether two values address the same
 * record, and the worker canonicalizes strictly on its side. A stricter rule
 * here would call "cool.ai" and "cool-ai" the same subject and let a load for
 * one apply to the other.
 */
export function canonicalSubject(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase()
}

/**
 * May a response that was requested for `responseFor` be applied, given that
 * `latestRequested` is the newest name we asked about?
 *
 * `latestRequested` null/'' means nothing is in flight — an unsolicited apply,
 * which must not paint over the form.
 */
export function isCurrentSubject(
  responseFor: string | null | undefined,
  latestRequested: string | null | undefined,
): boolean {
  const want = canonicalSubject(latestRequested)
  if (!want) return false
  return canonicalSubject(responseFor) === want
}

export type SubjectMutation = 'save' | 'price' | 'delete'

export type SubjectGate =
  | { ok: true; reason: 'match' | 'subject-only' | 'nothing-loaded' }
  | { ok: false; reason: 'mismatch' | 'unattributed'; message: string }

/**
 * Should this mutation fire?
 *
 * @param action  which control was pressed
 * @param loaded  the name whose values are currently IN the fields this action
 *                sends (`loadedNameRef` for save, `priceLoadedFor` for price) —
 *                written only when a load actually APPLIED
 * @param form    the name the field holds right now; what the request addresses
 *
 * ⚠️ THE CASE THAT DECIDES THE SHAPE: an empty `loaded` is not the same defect
 * for both actions, so it cannot be one branch.
 *
 *   • SAVE must allow it. Nothing was ever loaded, so the form holds only what
 *     the user typed — that is the CREATE flow, and it is also every first
 *     click, because pressing the button blurs the name input and that blur
 *     starts the load. Refusing here would make "Create AI" fail once, always.
 *   • PRICE must refuse it. `loadPrice` clears `priceLoadedFor` but leaves
 *     `priceForm` alone, so after a failed or in-flight price read the field
 *     still shows the PREVIOUS tiny's price — and an untouched empty field
 *     posts `price_micro: 0`, silently making a paid tiny free. An unattributed
 *     value is not a blank one.
 *
 * A mismatch refuses for both, in flight or not: the load that is coming will
 * replace the form anyway, so the second click is the correct one. That costs
 * an extra click when someone retypes the name — and buys the guarantee that no
 * click ever writes one tiny's content to another.
 */
export function gateSubjectMutation(
  action: SubjectMutation,
  { loaded, form }: { loaded: string | null | undefined; form: string | null | undefined },
): SubjectGate {
  // Carries no loaded state → nothing to misdirect. See the docblock.
  if (action === 'delete') return { ok: true, reason: 'subject-only' }

  const target = canonicalSubject(form)
  const have = canonicalSubject(loaded)
  if (have && have === target) return { ok: true, reason: 'match' }

  if (!have) {
    if (action === 'save') return { ok: true, reason: 'nothing-loaded' }
    return {
      ok: false,
      reason: 'unattributed',
      message: `${target || 'This tiny'}'s current price hasn't loaded — reopen it before setting a price.`,
    }
  }
  return {
    ok: false,
    reason: 'mismatch',
    // Name BOTH tinys: the whole failure is that the user cannot see which one
    // the form belongs to, so "try again" alone would be useless advice.
    message: action === 'price'
      ? `The price shown is ${have}'s, not ${target || 'this tiny'}'s — wait for ${target || 'it'} to load before setting a price.`
      : `The form still holds ${have}'s settings, but the name says ${target || 'nothing'} — wait for ${target || 'it'} to load before saving.`,
  }
}
