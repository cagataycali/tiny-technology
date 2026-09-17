/**
 * 🔴 What to say when a revoke did NOT happen.
 *
 * Revoke is the destructive action on /devices, and it was the one that told the
 * user the least. The page showed the server's raw `error` string — which, for a
 * transport failure, is `String(e?.message)` from the edge, so
 * "The operation was aborted due to timeout" landed on a person's screen — and
 * its client-side catch said "Revoke failed — try again."
 *
 * Neither said the thing that matters. **A revoke that fails leaves the device's
 * token working.** Someone revoking a laptop they have just lost needs that fact;
 * "try again" implies the opposite, that nothing has been decided yet.
 *
 * iOS parity: `RevokeFailure` in ios/Tiny/Sources/Panels.swift, same lead clause,
 * and `statusLine` below mirrors that app's `Api.httpMessage` /
 * `Api.friendlyHTTPError` for the statuses THIS route can answer. The same words
 * on both surfaces, because the device being revoked is often the other one.
 *
 * ⚠️ …and then that sentence was said about answers that never came. See
 * `revokeDecided`: "its token still works" is a CLAIM, and for three of the five
 * statuses this route produces there was nothing behind it.
 */

/**
 * Is this status a DECISION about the revoke — proof that it did not happen?
 *
 * Only a 4xx is. Every 4xx on this path refuses BEFORE anything is written:
 * `DELETE /api/devices` answers 401 with no session and 400 with no deviceId,
 * both before it calls the worker; the worker's own `DeviceRevokeCall` answers
 * 401 and 400 before `DEVICE_REVOKE_SQL`; and the route's 424 arm now fires only
 * for a worker 4xx (`app/api/devices/route.ts`). So for those, the token really
 * is still live and the owner of a lost laptop needs to hear it.
 *
 * Nothing else is a decision, and the old rule said "its token still works" for
 * all of them anyway:
 *
 *  · **0** — the fetch threw. An aborted deadline or a dropped connection means
 *    the DELETE may have been received and executed; the ANSWER is what was lost.
 *  · **5xx** — the request broke mid-decision. The route's transient arm never
 *    reached the worker, but a worker 5xx can land after the UPDATE has run.
 *  · **a 2xx that is not a success** — an intermediary or a mid-redeploy HTML
 *    page answering 200 with something that isn't this route's body. It says
 *    nothing whatsoever about the row.
 *
 * For those the honest lead is the one below, and the reason it can offer an
 * action is that `DEVICE_REVOKE_SQL` is an idempotent `UPDATE … SET revoked = 1`
 * with no `revoked = 0` guard (pinned in tests/revoke-message.test.ts) and
 * `DEVICE_LIST_SQL` filters `revoked = 0` — so the list IS the answer, and asking
 * twice costs nothing.
 *
 * Same rule, same words as the server-side send path: a 4xx is a decision, a 5xx
 * or a dead connection is the absence of one (`lib/chat/relay-send.ts`).
 */
export function revokeDecided(status: number): boolean {
  return status >= 400 && status <= 499;
}

/** The outcome clause for a decision. Byte-identical in Panels.swift (pinned). */
export const REVOKE_FAILED_LEAD = "Not revoked — its token still works.";

/**
 * The outcome clause when there was no decision — also byte-identical on the
 * other two surfaces.
 *
 * It states the same FACT the other lead does (what is true of the device's
 * token) rather than describing the request, so the two read as one voice. It
 * mirrors the other's shape deliberately: someone who has seen "its token still
 * works" should not have to parse a different sentence to notice this one is
 * hedged.
 */
export const REVOKE_UNCONFIRMED_LEAD =
  "Not confirmed — its token may or may not still work, and revoking again is safe.";

/**
 * Status → a reason a person can act on.
 *
 * Mirrors `Api.friendlyHTTPError` for exactly the codes `DELETE /api/devices`
 * produces — 0 (no response), 400, 401, 424, and 5xx — and NOT the rest of that
 * table, because a line this route cannot return is a line nobody can check.
 *
 * The 401/0/5xx branches are the app's `statusOwnsTheMessage` set: cases where
 * the client knows something the server cannot phrase. Everything else yields to
 * the server, which is describing THIS request, with the code kept so a support
 * conversation still has it.
 */
export function revokeStatusLine(status: number, serverMessage?: string | null): string {
  if (status === 0) return "No response — check your connection";
  if (status === 401) return "Session expired — sign out and back in (HTTP 401)";
  if (status >= 500 && status <= 599) {
    return `Server hiccup (HTTP ${status}) — usually passes, try again`;
  }
  const msg = (serverMessage ?? "").trim();
  return msg ? `${msg} (HTTP ${status})` : `HTTP ${status}`;
}

/**
 * The line for the page, or `null` when the token really is dead.
 *
 * ⚠️ Success requires the route's own `ok` flag AND a 2xx. A 200 whose body says
 * otherwise is not a revoke, and this is the wrong place to assume the two always
 * agree — the route's own comment says a false success "would hide a still-live
 * device token from the user".
 *
 * Pass `status: 0` for a fetch that threw (an aborted deadline, a dropped
 * connection): there is no response, so there is no body to prefer.
 *
 * ⚠️ The LEAD is chosen by the status, not fixed — see `revokeDecided`. Both
 * surfaces used to open every failure with "its token still works", including the
 * ones where nothing had answered, which is the opposite error from the one this
 * module was written to fix and points the reader the same wrong way: it says the
 * question is settled when it isn't.
 */
// A fetch that threw has no response, so status 0 can never be a success — the
// overload says so, and callers of the catch path don't need a `!` or a fallback
// string. (An `?? ""` there would clear the error banner on the one failure the
// page cannot see coming.)
export function revokeMessage(status: 0, body: unknown): string
export function revokeMessage(status: number, body: unknown): string | null
export function revokeMessage(status: number, body: unknown): string | null {
  const b = (body ?? null) as { ok?: unknown; error?: unknown } | null;
  if (status >= 200 && status <= 299 && b?.ok === true) return null;
  const server = typeof b?.error === "string" ? b.error : null;
  const lead = revokeDecided(status) ? REVOKE_FAILED_LEAD : REVOKE_UNCONFIRMED_LEAD;
  return `${lead} ${revokeStatusLine(status, server)}`;
}
