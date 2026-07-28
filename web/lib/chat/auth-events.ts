/**
 * The `tiny:auth` signal, and what a sign-OUT has to undo (v6 E1).
 *
 * Sign-in on this app is client-side — a passkey or the private-mode unlock
 * sets the session cookie with no reload — so nothing else on the page learns
 * the session changed unless it's told. `AuthButton` therefore dispatches
 * `tiny:auth` on login, and six consumers listen or re-probe: the shared
 * `whoami` cache, ActivityHUD, MessagesHUD, MapView, ModelSettings, and Chat's
 * private-tiny unlock.
 *
 * Sign-OUT dispatched nothing. The cookie went away and AuthButton's own local
 * state flipped, but:
 *   - `whoami`'s module cache kept resolving `authenticated: true`, so every
 *     `isAuthed()`-gated mount stayed convinced there was a session — the
 *     signed-out user's HUDs kept polling authenticated endpoints, which now
 *     401, and the badges read as errors instead of "signed out";
 *   - worst, on a PRIVATE tiny, Chat's `isAuthorized` stayed true, so the
 *     revealed systemPrompt and systemKnowledge — the whole point of the lock —
 *     remained on screen for someone who had just signed out. Only a manual
 *     reload re-locked it.
 *
 * The event is the same one login uses (every consumer already handles it), so
 * the fix is to emit it in both directions and give the one consumer that
 * needs to LOCK rather than just re-probe a way to tell the two apart.
 */

/** The single event name, so a typo can't half-wire a consumer. */
export const AUTH_EVENT = 'tiny:auth'

/**
 * Which direction the session moved. `signed-in` is the historical meaning of
 * a bare `tiny:auth` (login-only), so a listener that ignores the detail —
 * every pre-existing one — keeps behaving exactly as it did.
 */
export type AuthChange = 'signed-in' | 'signed-out'

/**
 * Deliberately structural and optional-only: the real call sites hand this a
 * DOM `Event` (a listener's parameter type) which has no `detail` at all, so a
 * required-property shape would reject exactly the bare-event case that must
 * read as `signed-in`.
 */
export type AuthEventLike = { readonly detail?: unknown; readonly type?: string }

/**
 * Read the direction off an event. Anything unrecognised — a bare `Event` from
 * an older dispatch site, a hand-fired event, a detail of the wrong shape —
 * reads as `signed-in`, matching what a bare `tiny:auth` has always meant.
 */
export function authChangeOf(e: AuthEventLike | null | undefined): AuthChange {
  const d = e?.detail
  if (d && typeof d === 'object' && (d as { change?: unknown }).change === 'signed-out') {
    return 'signed-out'
  }
  return 'signed-in'
}

/**
 * Does this event mean a private tiny must re-lock?
 *
 * Kept as its own predicate because the asymmetry is the entire bug: a
 * signed-IN event asks "can I unlock now?" (and the unlock path deliberately
 * no-ops when already authorized, so a stray event can't reset it), while a
 * signed-OUT event must revoke a vouch this tab already granted.
 */
export function shouldRelock(e: AuthEventLike | null | undefined): boolean {
  return authChangeOf(e) === 'signed-out'
}

/**
 * Build the event. A `CustomEvent` so the direction rides along; consumers
 * that only care THAT auth changed keep ignoring `detail`.
 */
export function authEvent(change: AuthChange): CustomEvent<{ change: AuthChange }> {
  return new CustomEvent(AUTH_EVENT, { detail: { change } })
}
