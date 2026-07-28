/**
 * 🏅 Reading a user's standing — the worker's internal `/reputation`.
 *
 * Split out of lib/rate-limit.ts (which imports @vercel/kv and
 * @upstash/ratelimit at module load) so a route that only wants to TELL a
 * builder their score doesn't pull a Redis client into its edge bundle. Same
 * reasoning as lib/rate-limit-curve.ts, and re-exported from lib/rate-limit so
 * every existing import still resolves.
 *
 * ⚠️ Server-only: it sends `INTERNAL_API_KEY`. Never import this from a client
 * component — the pure display half is lib/standing.ts.
 */

/**
 * The score for a signed-in user. Returns 0 for anon, on any failure, or on a
 * slow worker — standing can only ever RAISE a limit, so failing to read it
 * just means the base allowance.
 */
export async function reputationFor(userId: string | null | undefined): Promise<number> {
  if (!userId) return 0
  try {
    const res = await fetch(
      `${process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'}/reputation?userId=${encodeURIComponent(userId)}`,
      {
        headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        // Short: this sits in front of every un-keyed chat request. A slow
        // worker must cost the user a bonus, not their latency.
        signal: AbortSignal.timeout(2_000),
      },
    )
    if (!res.ok) return 0
    const data: any = await res.json()
    return Math.max(0, Number(data?.score) || 0)
  } catch {
    return 0
  }
}
