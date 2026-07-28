import { kv } from "@vercel/kv";
import { Ratelimit } from "@upstash/ratelimit";
import { DEFAULT_REQUESTS_PER_DAY, freeTierRequestsPerDay } from "./free-tier";
import { REQUESTS_PER_POINT, MAX_REPUTATION_BONUS, reputationAllowance } from "./rate-limit-curve";
import { reputationFor } from "./reputation";
import { limitMessage } from "./limit-message";

/**
 * Per-IP daily rate limit — the guard formerly copy-pasted into
 * chat/tiny/worker/control/login/share. One implementation so the
 * fail-open rule, the key shape, and the 429 contract can't drift
 * between routes again.
 *
 * Returns a ready-to-return 429 Response when the caller is over the
 * limit, or null when the request may proceed. Proceeds without
 * counting when limiting is off (dev) or KV isn't configured, and
 * FAILS OPEN on KV errors — a rate-limiter hiccup must never take the
 * platform down.
 */
/**
 * 🏅 Reputation → allowance. The login wall the user complained about is this
 * 50/day/IP window: a signed-in builder the network has vouched for hits the
 * same ceiling as an anonymous scraper sharing their NAT.
 *
 * The curve itself lives in ./rate-limit-curve (numbers only, no KV client) so
 * the 429's copy can read it without importing a Redis client; re-exported here
 * because every call site and test already imports it from this module.
 */
export { REQUESTS_PER_POINT, MAX_REPUTATION_BONUS, reputationAllowance };

/**
 * 💸 WHO PAYS when this limit is abused — and therefore whether identity is
 * allowed to buy more of it.
 *
 * `platform` (default): the resource spent is ours — model tokens, our storage,
 * our compute. Signing in should key the window to YOU (so an office/CGNAT
 * neighbour can't spend your day's allowance) and standing should widen it,
 * because the platform is the party extending the credit and it can revoke it
 * from a named account.
 *
 * `others`: the limit exists to protect a THIRD PARTY from the caller — another
 * owner's notification stream, another owner's private-tiny key, someone else's
 * server on the far end of a fetch. Two separate reasons identity must buy
 * nothing here:
 *
 *   1. Reputation is standing WITH THE PLATFORM, not permission over a stranger.
 *      Being followed by three people is not consent from the person whose event
 *      ring you're filling. A widened allowance on this kind of limit converts
 *      popularity into reach over someone who never agreed to it.
 *   2. Accounts are free. A per-user KEY here would be strictly weaker than the
 *      IP key it replaced: one machine can mint accounts and hold N × the window
 *      instead of one shared bucket. That trade is acceptable when the only
 *      victim is our own bill (attributable to a named account, revocable); it
 *      is not acceptable when the victim is another user.
 *
 * So `others` ignores `userId` entirely — IP key, base allowance, no reputation
 * read. It's spelled out at the call site so the intent is visible there, and a
 * future `userId: session?.sub` added "for consistency" is inert rather than a
 * silent regression.
 */
export type LimitCost = 'platform' | 'others';

/**
 * The score for a signed-in user, from the worker's internal /reputation. Lives
 * in ./reputation (KV-free) so `/api/me` can report standing without bundling a
 * Redis client; re-exported because every existing import names this module.
 */
export { reputationFor };

export async function enforceIpDailyLimit(
  req: Request,
  {
    requests,
    // The legacy prefix predates the platform; kept because live KV
    // windows are keyed under it (changing it would reset every counter)
    keyPrefix = "novel_ratelimit_",
    message = "You have reached your request limit for the day.",
    json = false,
    userId = null,
    cost = 'platform',
  }: {
    /**
     * Per-route override. OMIT it to inherit the deployment's free-tier
     * allowance (see below) — a route that names its own number, like share's
     * 20/day, is stating a product decision, not the free tier, so the env knob
     * deliberately leaves it alone.
     */
    requests?: number; keyPrefix?: string; message?: string; json?: boolean;
    /** Signed-in user id → their OWN window, sized by reputation (see below). */
    userId?: string | null;
    /** Who the limit protects — see LimitCost. `others` ignores userId. */
    cost?: LimitCost;
  } = {},
): Promise<Response | null> {
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.KV_REST_API_URL ||
    !process.env.KV_REST_API_TOKEN
  ) {
    return null;
  }

  // ⚡ The base allowance, before reputation. An explicit `requests` is a route's
  // own product decision (share 20/day, visit 300/day, faucet 20/day) and is
  // honoured verbatim. When it's omitted, the route is asking for "the free
  // tier" — which the DEPLOYMENT owns, because on a self-hosted instance the
  // model key, the KV window and the bill are all the operator's.
  //
  // The knob applies to `platform` limits ONLY. Three of the five inheriting
  // sites are `cost: 'others'` — /api/tiny and /api/login are the private-tiny
  // key check, /api/worker aims our egress at a stranger's server — and there
  // the window IS the brute-force/abuse budget against a third party. An
  // operator raising their users' chat allowance must not also multiply how many
  // guesses an attacker gets at another owner's key; that's the same reasoning
  // that makes `others` ignore reputation, one layer up (see LimitCost).
  const base = requests ?? (cost === 'platform' ? freeTierRequestsPerDay() : DEFAULT_REQUESTS_PER_DAY);

  // x-forwarded-for is a comma-separated hop chain (client, proxy1, …); on
  // Vercel the leftmost entry is the real client. Key on that single hop, not
  // the raw header — the full string lets a caller rotate downstream hops to
  // mint fresh buckets, and a missing header stringifies to the literal
  // "null", collapsing every header-less caller into one shared window.
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  // 🏅 A signed-in builder gets their OWN window, widened by the standing the
  // network gave them. Two problems this fixes at once:
  //   1. IP keying punishes identity — everyone behind one NAT (office, campus,
  //      carrier CGNAT) shared a single 50/day bucket even while logged in.
  //   2. A vouched-for builder had no way to earn more room.
  // The bucket key must change with the allowance: Upstash's sliding window
  // stores counts per key, so serving two different limits on ONE key makes the
  // decision depend on whichever request arrived first. Per-user keys keep each
  // allowance in its own window. Anonymous callers are unchanged: base limit,
  // IP-keyed.
  // …but only where the resource being spent is OURS. A limit that shields a
  // third party (cost: 'others') stays IP-keyed at the base allowance no matter
  // who is signed in: reputation is standing with the platform, not permission
  // over a stranger, and free accounts would make a per-user key weaker than the
  // IP key it replaced. See LimitCost.
  const identified = cost === 'platform' ? userId : null;
  const score = await reputationFor(identified);
  const allowance = identified ? reputationAllowance(base, score) : base;
  const key = identified ? `${keyPrefix}u_${identified}` : `${keyPrefix}${ip}`;

  const ratelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(allowance, "1 d"),
  });

  let success = true, limit = allowance, reset = 0, remaining = allowance;
  try {
    ({ success, limit, reset, remaining } = await ratelimit.limit(key));
  } catch (e) {
    console.warn("ratelimit unavailable, failing open:", e);
  }
  if (success) return null;

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": limit.toString(),
    "X-RateLimit-Remaining": remaining.toString(),
    "X-RateLimit-Reset": reset.toString(),
  };
  // Tell an out-of-room builder what their standing is worth, so "get followed,
  // get more room" is discoverable instead of folklore. The header is the
  // machine-readable twin of the sentence below — kept because it's exact, but
  // it can no longer be the ONLY place we say it: no client reads it, and two of
  // the three can't cheaply (iOS ApiError.http carries a status and nothing
  // else; Android's friendlyHttpError is a status→string table). See
  // lib/limit-message.ts.
  if (identified) headers["X-Reputation-Score"] = String(score);
  const body = limitMessage({
    message, base, allowance, score,
    identified: Boolean(identified),
    lever: cost === 'platform' ? 'reputation' : 'none',
  });
  return json
    ? new Response(JSON.stringify({ error: body }), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json" },
      })
    : new Response(body, { status: 429, headers });
}
