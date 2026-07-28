/**
 * Mid-session expiry (v6 E2) — the transition c47 didn't cover.
 *
 * c47 fixed the case where the USER ends the session. A session can also just
 * die: the cookie expires, or it's revoked from another device. Nothing
 * announces that. The two HUDs have a `401 → setLoggedIn(false)` backstop, but
 * it only flips their OWN state — `whoami`'s module-scope cache keeps resolving
 * `authenticated: true`, so every other consumer (`isAuthed()` gates in Chat,
 * MapView, theme, ModelSettings) stays convinced there's a session until a
 * reload. You get a page that is half signed-in: the inbox says "sign in" while
 * the wallet badge and the theme sync still act like an owner.
 *
 * The design rule here is CONFIRM, DON'T TRUST. A 401 is evidence, not proof:
 * these endpoints proxy a worker, and a proxy hiccup or a route that answers
 * 401 for its own reasons must not be able to sign a working user out of their
 * own UI. So a 401 invalidates the cache and forces exactly one fresh /api/me —
 * the authoritative answer — and only if THAT says signed-out does anything
 * announce it, via c47's existing `authEvent('signed-out')` so all consumers
 * converge through the one path they already handle.
 *
 * The rules are pure here; `whoami.ts` owns the cache and does the plumbing.
 */

/**
 * Is this status evidence the SESSION died?
 *
 * 401 only. A 403 means "authenticated but not allowed" (someone else's tiny,
 * a revoked scope) — treating it as expiry would sign a perfectly good session
 * out for visiting the wrong page. 5xx and 429 are the server's problem, not
 * the session's.
 */
export function isAuthFailure(status: number | undefined): boolean {
  return status === 401
}

/**
 * Did the authoritative re-probe agree the session is gone?
 *
 * Deliberately the same predicate `isAuthed` applies, inverted — with ONE
 * exception that is the whole point of "confirm, don't trust":
 *
 * ⚠️ `probe()` degrades an UNREACHABLE server to `{authenticated: false}`,
 * because for gating optional extras "we couldn't ask" and "signed out" want the
 * same behaviour (don't fetch). For CONFIRMATION they are opposites: a probe
 * that never reached the server is not evidence about the session at all, and
 * announcing a sign-out from it re-creates precisely the bug this module
 * prevents — a working session torn down by a network blip, except now the blip
 * is the confirmation's own. So the probe marks that case (`unreachable`) and
 * this refuses to confirm on it.
 *
 * This was latent until v7 put a deadline on the probe: before that, an
 * unanswered /api/me hung forever, so `.then` never ran and nothing announced.
 * The hang was hiding it. Fixing the hang exposed it.
 */
export function confirmsExpiry(
  me: { authenticated?: boolean; user?: unknown; unreachable?: boolean } | null | undefined,
): boolean {
  if (!me) return true
  if (me.unreachable) return false
  return !me.user && me.authenticated !== true
}

export type ReprobeState = {
  /** A confirmation round-trip is already out — a second would learn nothing. */
  inFlight: boolean
  /** Have we already confirmed this session is gone? */
  settled: boolean
}

/**
 * Should this 401 trigger a confirmation probe?
 *
 * Collapses the stampede: both HUDs poll, so an expiry produces two 401s
 * within milliseconds, and every subsequent poll produces more. One probe
 * answers all of them, and once expiry is confirmed there is nothing left to
 * confirm — the signed-out consumers stop fetching, so no further 401 arrives
 * anyway, and `settled` makes that a rule rather than a coincidence.
 */
export function shouldConfirmExpiry(status: number | undefined, state: ReprobeState): boolean {
  if (!isAuthFailure(status)) return false
  if (state.inFlight || state.settled) return false
  return true
}
