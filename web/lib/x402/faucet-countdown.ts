/**
 * The faucet's "Next top-up in 2h 5m" — turned back into something that moves.
 *
 * `deposit_info.faucet.next_drip_in_seconds` is a SERVER DELTA: the worker
 * computes seconds-to-UTC-midnight at request time (`nextDripInSeconds`,
 * worker/src/deposits.ts:247) and hands it over as a plain
 * number. A delta is only true at the instant it was measured, and neither
 * consumer refetches — `app/wallet/page.tsx:189-191` and
 * `components/chat/WalletSheet.tsx:112-115` both load once, with no interval and
 * no visibilitychange. So the number on screen is frozen at page load.
 *
 * That is worse than a stale label, because the Claim button is DISABLED off the
 * same field. Leave a wallet tab open across UTC midnight and the drip becomes
 * claimable while the UI keeps saying "Claimed today — next top-up in 2h 5m",
 * with no way to press anything. The only cure is a reload the user has no
 * reason to think they need.
 *
 * The fix is to stop carrying a delta. Convert it ONCE into an absolute deadline
 * (`dripDeadlineMs`) at the moment it arrives, then derive everything from the
 * clock. A deadline stays true while a delta rots.
 *
 * ⚠️ THE DIRECTION OF THE RISK IS THE OPPOSITE OF A PAYMENT QUOTE, and that is
 *    what makes re-enabling the button safe here. A quote that looks live when
 *    it has lapsed offers an action the server will refuse (410). This offers an
 *    action the server will ACCEPT: the faucet's idempotency key is
 *    `faucet:d<epochDay>` (deposits.ts:244), so once the UTC day rolls over the
 *    old key no longer collides and the claim genuinely succeeds. And if this
 *    code is somehow wrong about the boundary, the server answers 429
 *    `already_claimed` — which both consumers already surface verbatim and
 *    follow with a `loadDepositInfo()`. Being wrong costs one refused tap;
 *    staying frozen costs the whole feature until a reload.
 */

/** Seconds we still count down at. Below this, the label rounds to "1m". */
export const DRIP_TICK_MS = 30_000

/**
 * A server delta → an absolute epoch-ms deadline, pinned to the clock NOW.
 *
 * Returns null for anything that isn't a usable future delta, and null means
 * "no known deadline" everywhere downstream — deliberately NOT "zero seconds
 * left". A missing field must not read as "the wait is over".
 */
export function dripDeadlineMs(seconds: unknown, nowMs: number): number | null {
  const n = Number(seconds)
  // `> 0` and not `>= 0`: a zero delta carries no information about when the
  // boundary is, and 0 is also what `Number(null)`/`Number(false)` coerce to.
  if (!Number.isFinite(n) || n <= 0) return null
  if (!Number.isFinite(nowMs)) return null
  return nowMs + n * 1000
}

/**
 * Seconds left until a pinned deadline, floored at 0.
 *
 * null in → null out: an unknown deadline stays unknown rather than collapsing
 * into "elapsed", because those two lead to opposite UI (keep waiting vs the
 * drip is claimable again).
 */
export function dripRemainingSeconds(deadlineMs: number | null, nowMs: number): number | null {
  if (deadlineMs == null || !Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return null
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}

/**
 * How long until this countdown next needs recomputing, or null when it never
 * does again.
 *
 * Ticks at DRIP_TICK_MS while there is more than that left, then lands exactly
 * on the deadline — so the label is at most one tick stale and the flip to
 * "claimable" happens on time rather than up to 30s late.
 *
 * ⚠️ There is deliberately NO 2^31−1 clamp here, unlike lib/chat/quote-expiry.ts
 *    where a bogus `expires_at` in milliseconds could produce a ~50,000-year
 *    delay that setTimeout wraps into firing IMMEDIATELY. The `min` with
 *    DRIP_TICK_MS already bounds every return to 30s, so a clamp above it could
 *    never fire — it would be a guard that reads as protection and executes
 *    never. A mutant deleting it survived the whole suite, which is how it was
 *    caught. The invariant that MATTERS is the one asserted instead: no return
 *    value ever exceeds DRIP_TICK_MS, whatever the server sent.
 */
export function dripTimeoutMs(deadlineMs: number | null, nowMs: number): number | null {
  const left = dripRemainingSeconds(deadlineMs, nowMs)
  if (left == null || left <= 0) return null
  const ms = (deadlineMs as number) - nowMs
  return Math.min(Math.max(0, ms), DRIP_TICK_MS)
}
