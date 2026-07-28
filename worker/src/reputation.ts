/**
 * 🏅 Reputation — earned standing, deliberately NOT money.
 *
 * The user's ask (docs/e2e-gaps-report-2026-07-25.md §2): "we can just give
 * people reputation when they follow each other", so the login walls can
 * loosen for people the network has vouched for instead of treating every
 * builder like an anonymous IP.
 *
 * Two invariants make the score worth anything:
 *
 *  1. **Not in the ledger.** Balance is `SUM(delta_micro)` over ALL kinds at
 *     five money-critical sites (payments.ts balanceOf + both invoke overdraft
 *     guards, withdrawals.ts debit + withdrawable figure). A `reputation` row
 *     there would inflate spendable balance — and the withdrawal exclusion
 *     filters on `kind='deposit'`, so it wouldn't even catch it: points would
 *     become withdrawable real USDC. Points live in their own table.
 *
 *  2. **Every point costs someone ELSE a gesture.** A score you can grant
 *     yourself is a score you can mint (the same trap `tiny` deposits fell
 *     into in cycle 6). So following people earns you nothing on its own —
 *     being followed does, and completing a MUTUAL follow pays both sides.
 *     Otherwise one account could follow 500 builders and buy itself past the
 *     rate limit.
 *
 * Idempotency is the DB's job, not a read-then-write: UNIQUE(user_id, kind,
 * ref) + `ON CONFLICT DO NOTHING`, so follow → unfollow → re-follow farming is
 * a no-op even though a re-follow legitimately opens a fresh graph edge.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

/** Points per event kind. Tuning these is safe; they're read nowhere else. */
export const REP_POINTS = {
  /** Someone followed you — an outside gesture, so it scores. */
  follow_received: 10,
  /** You two follow each other — mutual vouching, paid to BOTH sides. */
  mutual_follow: 5,
} as const;

export type RepKind = keyof typeof REP_POINTS;

/**
 * The grant. One statement, conflict-guarded — exported so tests can run the
 * real SQL against real sqlite.
 *
 * NOTE: D1 binds ?1/?2… positionally from .bind(); node:sqlite treats them as
 * NAMED parameters, so tests bind `{1: …, 2: …}`.
 */
export const GRANT_SQL =
  "INSERT INTO reputation (user_id, points, kind, ref) VALUES (?1, ?2, ?3, ?4) " +
  "ON CONFLICT DO NOTHING";

/** Score = the sum of every grant. Cheap via idx_reputation_user. */
export const SCORE_SQL =
  "SELECT COALESCE(SUM(points), 0) AS v FROM reputation WHERE user_id = ?";

/** Stable, symmetric key for a mutual pair: both sides share one ref. */
export const mutualRef = (a: string, b: string): string =>
  `mutual:${[String(a), String(b)].sort().join(":")}`;

/** The follow grant's key — one grant per (follower → target) pair, forever. */
export const followRef = (followerId: string, targetId: string): string =>
  `follow:${followerId}:${targetId}`;

/**
 * Grant points. Returns true only when a row actually landed (i.e. this is the
 * first time for that ref) so callers can report a fresh award honestly.
 * Never throws: reputation must not break the gesture that earned it.
 */
export async function grantReputation(
  env: any,
  opts: { userId: string; kind: RepKind; ref: string; points?: number }
): Promise<boolean> {
  const points = opts.points ?? REP_POINTS[opts.kind];
  if (!opts.userId || !Number.isFinite(points) || points === 0) return false;
  try {
    const res = await env.DB.prepare(GRANT_SQL)
      .bind(String(opts.userId), Math.trunc(points), opts.kind, opts.ref)
      .run();
    return Number(res?.meta?.changes || 0) > 0;
  } catch (err) {
    console.log(err, "reputation grant");
    return false;
  }
}

/** A user's current score. 0 on any failure — never blocks a read path. */
export async function reputationScore(env: any, userId: string): Promise<number> {
  try {
    const row = await env.DB.prepare(SCORE_SQL).bind(String(userId)).first();
    return Math.max(0, Number(row?.v || 0));
  } catch (err) {
    console.log(err, "reputation score");
    return 0;
  }
}

/** Per-kind breakdown, so a client can explain WHERE the standing came from. */
export const BREAKDOWN_SQL =
  "SELECT kind, SUM(points) AS points, COUNT(*) AS n FROM reputation WHERE user_id = ? GROUP BY kind ORDER BY points DESC";

/**
 * GET /reputation?userId= (internal) — the score as a number the app can act on.
 *
 * Exists so the web app's login walls can consult standing without scraping the
 * public /profile payload (which is keyed by github login, cached differently,
 * and carries tinys + tool source it doesn't need). Internal-key only: the score
 * gates rate limits, so a public read would let anyone enumerate who has slack.
 */
export class ReputationGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Community"],
    summary: "Internal: a user's reputation score (+ per-kind breakdown).",
    parameters: {
      userId: Query(Str, { required: true, description: "User id whose standing to read." }),
    },
    responses: { "200": { description: "Score", schema: { response: "Reputation" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const score = await reputationScore(env, userId);
    let breakdown: { kind: string; points: number; n: number }[] = [];
    try {
      const { results } = await env.DB.prepare(BREAKDOWN_SQL).bind(String(userId)).all();
      breakdown = (results || []).map((r: any) => ({
        kind: String(r.kind), points: Number(r.points || 0), n: Number(r.n || 0),
      }));
    } catch (err) { console.log(err, "reputation breakdown"); }
    return new Response(JSON.stringify({ score, breakdown }), {
      status: 200,
      // Never cache: this feeds a live allowance decision.
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
