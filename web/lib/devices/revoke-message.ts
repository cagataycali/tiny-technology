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
 */

/** The outcome clause, before any reason. Byte-identical in Panels.swift (pinned). */
export const REVOKE_FAILED_LEAD = "Not revoked — its token still works.";

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
  return `${REVOKE_FAILED_LEAD} ${revokeStatusLine(status, server)}`;
}
