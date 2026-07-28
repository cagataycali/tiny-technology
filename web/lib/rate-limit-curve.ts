/**
 * 🏅 REPUTATION → ALLOWANCE, the curve alone.
 *
 * Split out of lib/rate-limit.ts (which imports @vercel/kv and
 * @upstash/ratelimit at module load) so the two things that only need the
 * NUMBERS — the 429's copy in lib/limit-message.ts, and any UI that wants to
 * explain the curve — can read them without pulling a KV client into the
 * bundle, and without a cycle: rate-limit re-exports these, so every existing
 * `from './rate-limit'` import still resolves.
 *
 * The curve: every reputation point buys REQUESTS_PER_POINT extra requests a
 * day, capped at MAX_REPUTATION_BONUS. Capped deliberately — reputation is
 * earned from other people's gestures (the worker's reputation.ts: being
 * followed pays, following pays nothing), but a popular account still shouldn't
 * be able to grow an unbounded allowance and become the platform's cheapest DoS
 * vector.
 *
 * A 10-point builder (one follower) gets 100/day; the cap is reached at 45
 * points, roughly three mutual follows.
 */
export const REQUESTS_PER_POINT = 5
export const MAX_REPUTATION_BONUS = 200

/** Pure, so the curve is testable without KV or a network. */
export function reputationAllowance(base: number, score: number): number {
  const points = Number(score)
  if (!Number.isFinite(points) || points <= 0) return base
  return base + Math.min(MAX_REPUTATION_BONUS, Math.floor(points) * REQUESTS_PER_POINT)
}
