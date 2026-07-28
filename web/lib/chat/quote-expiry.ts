/**
 * When does an x402 payment quote stop being spendable — and when should the
 * card that renders it FIND OUT?
 *
 * A quote carries a 5-minute TTL (`expires_at`, QUOTE_TTL_SEC in
 * app/api/x402/pay/route.ts). PayReceipt read that boundary once, in its render
 * body, against `Date.now()`. Correct for the first paint and never again:
 * React re-renders a chat card when its props or state change, and a quote
 * sitting in a transcript has neither. So the case the comment there claimed to
 * catch — "the persisted/slow-stream case", a card that MOUNTS already expired —
 * was the only case it caught. The common one, a card on screen while the five
 * minutes elapse, kept offering a live "✓ Approve $0.01" button that dead-ends
 * on tap (approve() re-checks, refuses, and flips the card to "Payment not
 * sent" — a red failure for a payment that was never attempted).
 *
 * So the rules here are pure and clock-injected, and `use-quote-expiry.ts`
 * arms a timer from `expiryTimeoutMs` so the card notices its own expiry
 * without anyone touching it.
 *
 * Two hazards this file exists to contain:
 *
 * ⚠️ A `setTimeout` delay above 2^31−1 ms overflows and fires IMMEDIATELY. A
 *    malformed `expires_at` (milliseconds sent where seconds belong — the exact
 *    unit confusion this repo already guards in relative-time.ts) yields a
 *    delay ~50,000 years out, i.e. a timer that fires now, on a quote with four
 *    minutes left. Hence the tick cap: never schedule more than
 *    EXPIRY_TICK_MAX_MS ahead, re-arm, and recompute from a fresh clock each
 *    time. That also covers a laptop asleep through the TTL and a wall-clock
 *    jump — both land on "recompute", not on a stale decision.
 *
 * ⚠️ Not-expired must be the answer when we can't PROVE expiry. A missing,
 *    NaN, or non-positive `expires_at` means we have no deadline, not a lapsed
 *    one — and the server enforces `exp` regardless (410 + `expired: true`,
 *    which the card already recovers from). Guessing "expired" here would
 *    replace a working Approve button with a re-quote nobody asked for.
 *
 * Comparison is strictly `<`, matching the server's `nowSec > q.exp` and both
 * mobile clients (WalletCore.isQuoteExpired, PayQuote.swift `expired`): AT the
 * expiry second a quote is still good everywhere, so it must be here too.
 */

/**
 * Longest a single tick may wait. Small enough that a 2^31-overflowing delay
 * can never be scheduled, large enough that a 5-minute TTL costs ~10 timers.
 */
export const EXPIRY_TICK_MAX_MS = 30_000

/**
 * Milliseconds until this quote lapses — negative once it has, `null` when the
 * quote carries no usable deadline at all (absent / NaN / ≤ 0).
 *
 * `null` and `0` are deliberately different answers: `0` is "it just expired",
 * `null` is "there is nothing to wait for", and a caller that conflated them
 * would arm a timer against a quote with no expiry.
 */
export function msUntilExpiry(expiresAt: unknown, nowMs: number): number | null {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return null
  return expiresAt * 1000 - nowMs
}

/** Has this quote lapsed? False whenever we cannot prove that it has. */
export function isQuoteExpired(expiresAt: unknown, nowMs: number): boolean {
  const left = msUntilExpiry(expiresAt, nowMs)
  return left !== null && left < 0
}

/**
 * How long to wait before looking at the clock again, or `null` when there is
 * no point (already expired, or no deadline to reach).
 *
 * Capped at EXPIRY_TICK_MAX_MS — see this file's docblock — and floored at 1ms
 * so a sub-millisecond remainder still makes forward progress instead of
 * re-arming a zero-delay timer forever.
 */
export function expiryTimeoutMs(expiresAt: unknown, nowMs: number): number | null {
  const left = msUntilExpiry(expiresAt, nowMs)
  if (left === null || left < 0) return null
  return Math.max(1, Math.min(EXPIRY_TICK_MAX_MS, Math.ceil(left)))
}
