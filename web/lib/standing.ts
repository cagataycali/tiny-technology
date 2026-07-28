import { pluralize } from './utils'
import { REQUESTS_PER_POINT, MAX_REPUTATION_BONUS, reputationAllowance } from './rate-limit-curve'

/**
 * 🏅 STANDING, BEFORE THE WALL — what a builder's reputation is worth, stated
 * while they still have room left.
 *
 * c8 built the curve, c31 made the base configurable, c37 made the 429 SAY what
 * standing is worth. All three only speak at the moment the request is refused.
 * Before that, the one place the platform quotes an allowance —
 * ModelSettings' "free but limited to 50 requests a day" — renders
 * `freeTierRequestsPhrase()`, which knows the deployment's base and nothing
 * about the caller. So a builder with 40 points, whose window is actually 250,
 * was told 50: **a correct number under a label that names something else** (the
 * c30 explorer bug), on the one screen whose job is explaining the free tier.
 *
 * That's why this module exists rather than a second copy of the arithmetic in a
 * component: the number shown before the wall and the number enforced at the
 * wall must be the same number. `standingFor` calls the same
 * `reputationAllowance` the limiter builds its window with, and
 * tests/standing.test.ts pins them equal across a table of scores — the drift
 * this file is designed to make impossible.
 *
 * Pure: no KV client, no request, no env read. The base is passed in (it's the
 * deployment's, resolved by lib/free-tier) and the score comes from the worker.
 */

export interface Standing {
  /** Reputation points the network granted this user; 0 for anon or unknown. */
  score: number
  /** The allowance before reputation — the deployment's free tier. */
  base: number
  /** What the limiter will actually build the window with. */
  allowance: number
  /** Extra requests standing has earned (allowance − base, never negative). */
  bonus: number
  /** Is this a signed-in caller whose window is keyed to them? */
  identified: boolean
  /** Has the bonus reached MAX_REPUTATION_BONUS — i.e. is the lever spent? */
  atCap: boolean
  /**
   * The curve itself, carried on the wire for the clients that cannot import it.
   *
   * Web reads `reputationAllowance` directly, so these two fields are redundant
   * here — they exist because iOS and Android can't, and a hardcoded `5`/`200`
   * in Swift or Kotlin is a fork of the limiter that agrees with it only until
   * the curve moves, and then lies from an installed build nobody is about to
   * update. Same shape the faucet already ships (`micro_per_point`/`max_micro`,
   * read by `TopUp.swift` and `WalletCore.kt` rather than re-declared).
   */
  perPoint: number
  /** Ceiling on the earned bonus — what "the full 200" means in the copy. */
  maxBonus: number
}

const int = (n: unknown): number => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

/**
 * The caller's standing. Anonymous callers get the base and nothing else — the
 * window is IP-keyed and shared, so there is no personal allowance to report.
 */
export function standingFor(base: number, score: number, identified: boolean): Standing {
  const b = Math.max(1, int(base) || 1)
  const s = identified ? int(score) : 0
  const allowance = identified ? reputationAllowance(b, s) : b
  const bonus = Math.max(0, allowance - b)
  return {
    score: s, base: b, allowance, bonus,
    identified: Boolean(identified),
    atCap: bonus >= MAX_REPUTATION_BONUS,
    perPoint: REQUESTS_PER_POINT,
    maxBonus: MAX_REPUTATION_BONUS,
  }
}

/**
 * Trust nothing from the wire. `/api/me` gained `standing` at c38, so any client
 * that outlives a rollback — or an older deployment behind the same OTA — gets
 * `undefined` here and must fall back to the deployment-wide phrase rather than
 * render `NaN requests a day`. Returns null when there's no usable payload; the
 * house idiom (normalizeProfile, normalizeCommunity).
 */
export function normalizeStanding(raw: any): Standing | null {
  if (!raw || typeof raw !== 'object') return null
  const base = int(raw.base)
  if (base < 1) return null
  // Recompute from base+score rather than trusting the server's arithmetic: it's
  // the same pure function the limiter uses, so a stale or hand-edited
  // `allowance` can't make the pre-wall number disagree with the enforced one.
  return standingFor(base, int(raw.score), raw.identified !== false)
}

/**
 * The allowance as a phrase — the drop-in replacement for
 * `freeTierRequestsPhrase()` on any screen that knows WHO is asking.
 * Through `pluralize`, so a deployment with a free tier of 1 never reads
 * "1 requests a day".
 */
export function allowancePhrase(s: Standing): string {
  return `${pluralize(s.allowance, 'request')} a day`
}

/**
 * One sentence of explanation, or '' when there is nothing true to add.
 *
 * Empty for the two cases where any extra clause would be noise or a lie: an
 * anonymous caller (they have no standing to report — the sign-in prompt is the
 * 429's job, c37) and a signed-in builder with no points yet, where the honest
 * message is the invitation below, not a breakdown of `50 = 50 + 0`.
 */
export function standingDetail(s: Standing): string {
  if (!s.identified || s.bonus <= 0) return ''
  if (s.atCap) {
    return `${s.base} free plus the full ${MAX_REPUTATION_BONUS} that reputation can earn.`
  }
  return `${s.base} free plus ${s.bonus} earned from ${pluralize(s.score, 'point')} of reputation.`
}

/**
 * What earning more would get them, or '' when nothing would.
 *
 * At the cap this must be empty: "each point adds 5 more" is false there, and
 * dangling a spent lever is worse than silence — the same rule the 429 follows
 * (lib/limit-message.ts). Names *being followed* because that is the gesture
 * that pays; following pays nothing (worker reputation.ts).
 */
export function standingNextStep(s: Standing): string {
  if (!s.identified || s.atCap) return ''
  const room = MAX_REPUTATION_BONUS - s.bonus
  return `Each reputation point adds ${REQUESTS_PER_POINT} more a day (${room} still to earn) — being followed is what pays.`
}
