/**
 * Shared /api/me probe — one network call, every consumer.
 *
 * c12 console QA: an anonymous tiny-page visit fired seven authenticated
 * endpoints (messages, events, wallet, prefs×3, me×2) that all 401 —
 * seven wasted round-trips per anon page view. Every mount-time
 * authenticated fetch now awaits this probe and skips while signed out;
 * /api/me itself collapses to a single shared request.
 *
 * The cache invalidates on the `tiny:auth` window event (passkey login is
 * client-side — it lands with no reload, same signal the private-mode
 * unlock uses) and can be forced fresh (AuthButton's post-action refresh).
 *
 * It also invalidates when an authenticated fetch reports a 401 —
 * `reportAuthFailure` (v6 E2). Without that, an expired cookie left the page
 * half signed-in: the HUD that saw the 401 flipped its own state while every
 * other consumer kept reading a cache that still said authenticated.
 */
import { isAuthFailure, confirmsExpiry, shouldConfirmExpiry } from "./session-expiry";
import { authEvent } from "./auth-events";
import { deadlineFor } from "../deadlines";

export type Me = {
  authenticated?: boolean;
  user?: unknown;
  /**
   * The probe never reached a verdict — timeout, offline, unparseable body. NOT
   * the same as signed-out, even though `authenticated` reads false for both:
   * gates want identical behaviour ("don't fetch the extras"), but
   * `confirmsExpiry` must never announce a sign-out on it.
   */
  unreachable?: boolean;
  [k: string]: unknown;
};

let cached: Promise<Me> | null = null;

/**
 * ⚠️ The deadline here is load-bearing in a way no individual surface's is,
 * because this promise is CACHED and shared.
 *
 * Every mount-time authenticated fetch in the app awaits it (`isAuthed()` gates
 * in Chat's price badge, MapView, both HUDs, theme sync ×2, ModelSettings via
 * useAuthValue). An un-deadlined probe that never settles doesn't fail those
 * gates — it leaves them all pending forever, and because the promise is memoised
 * in `cached`, every later caller awaits the SAME dead promise. One hung request
 * silently disables the authenticated half of the page, with no error state
 * anywhere, because nobody's `.catch` ever runs. The v7 lens ("a request that
 * never answers") has no worse instance in this codebase: a per-surface hang
 * costs one surface, this one costs all of them at once and is unrecoverable
 * without a reload.
 *
 * The route's own budget is 10s (`lib/auth.ts` internalInit's cap on the
 * /user/get read; `reputationFor` runs in parallel with its own 2s), so
 * `deadlineFor` yields QUICK_MS = 15s — above it, per the c50/c51 rule.
 */
function probe(): Promise<Me> {
  const result: Promise<Me> = fetch("/api/me", { signal: AbortSignal.timeout(deadlineFor("/api/me")) })
    .then((r) => r.json() as Promise<Me>)
    // Never REJECT — every caller is a `.then`-only gate with no catch, so a
    // rejection here is an unhandled one AND a gate that never resolves. A
    // failure degrades to signed-out (don't fetch the optional extras), exactly
    // as it always did — but it carries `unreachable` so `confirmsExpiry` can
    // tell "we couldn't ask" apart from "the answer was no". Without that flag,
    // adding this deadline would turn a slow network into a false sign-out.
    .catch((): Me => ({ authenticated: false, unreachable: true }))
    .then((me) => {
      // ⚠️ Don't MEMOISE a non-answer. The cache exists to spend one round-trip
      // per page (c12), and that bargain assumes the cached value is an answer.
      // Both HUDs call `isAuthed()` on every poll, so caching one timeout would
      // make a single blip permanent: every later poll awaits the same failed
      // promise and the authenticated half of the page stays dark until a
      // reload — the exact unrecoverable state this cycle is fixing, just moved
      // one layer up. Dropping the cache lets the next poll retry.
      //
      // Identity-checked so a fresh probe that has already replaced this one
      // (AuthButton's post-action refresh, a `tiny:auth` clear) isn't discarded
      // by a slow loser resolving afterwards.
      if (me.unreachable && cached === result) cached = null;
      return me;
    });
  return result;
}

export function whoami(opts?: { fresh?: boolean }): Promise<Me> {
  if (opts?.fresh || !cached) cached = probe();
  return cached;
}

/** true only for a signed-in session — the gate for authenticated mounts. */
export function isAuthed(): Promise<boolean> {
  return whoami().then((me) => !!me?.user || me?.authenticated === true);
}

// Expiry confirmation state (v6 E2). Module-scope like the cache itself:
// both HUDs poll, so one expiry yields several 401s within milliseconds and
// they must collapse into a single authoritative probe.
let expiryProbeInFlight = false;
let expirySettled = false;

/**
 * Tell the shared probe that an authenticated fetch came back 401.
 *
 * Confirms before announcing: a 401 is evidence, not proof (these routes proxy
 * a worker), so this forces ONE fresh /api/me and only announces a sign-out if
 * that authoritative answer agrees. An UNREACHABLE confirmation answers nothing
 * (`confirmsExpiry` refuses it), and `expirySettled` stays false — so the next
 * 401 gets a real confirmation attempt instead of the question being closed by
 * a network blip. Announcing reuses c47's
 * `authEvent('signed-out')`, so every consumer converges through the single
 * path it already handles — including this module's own listener, which clears
 * the cache.
 *
 * Safe to call from any 401 branch, as often as it fires; extra calls collapse.
 */
export function reportAuthFailure(status: number | undefined): void {
  if (!shouldConfirmExpiry(status, { inFlight: expiryProbeInFlight, settled: expirySettled })) {
    return;
  }
  expiryProbeInFlight = true;
  // Bypass the stale cache — that cache is precisely what's suspect.
  cached = null;
  whoami({ fresh: true })
    .then((me) => {
      if (!confirmsExpiry(me)) return; // false alarm: session is fine, cache is now fresh
      expirySettled = true;
      if (typeof window !== "undefined") {
        window.dispatchEvent(authEvent("signed-out"));
      }
    })
    .catch(() => { })
    .finally(() => { expiryProbeInFlight = false; });
}

/** True once a 401 has been confirmed as a dead session (tests + callers). */
export function isSessionExpired(): boolean {
  return expirySettled;
}

if (typeof window !== "undefined") {
  window.addEventListener("tiny:auth", (e) => {
    cached = null;
    // A sign-IN clears the expiry latch: whatever died, the user has a live
    // session again, so the next 401 deserves a fresh confirmation probe.
    // (A bare event reads as signed-in — auth-events' historical-meaning rule.)
    const detail = (e as CustomEvent<{ change?: string }>).detail;
    if (detail?.change !== "signed-out") expirySettled = false;
  });
}

// Re-exported so 401 branches can ask the question without a second import.
export { isAuthFailure };
