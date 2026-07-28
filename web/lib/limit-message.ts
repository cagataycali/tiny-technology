import { pluralize } from './utils'
import { REQUESTS_PER_POINT, MAX_REPUTATION_BONUS } from './rate-limit-curve'

/**
 * 🏅 WHAT THE WALL SAYS — the user-visible half of reputation→allowance.
 *
 * c8 built the curve (each reputation point buys REQUESTS_PER_POINT more
 * requests a day) and, so that "get followed, get more room" would be
 * "discoverable instead of folklore", put the score on the 429 as
 * `X-Reputation-Score`. Thirty cycles later, **no client reads that header** —
 * and none can cheaply: web shows the response body, iOS's `ApiError.http(Int)`
 * carries only a status code, Android's `friendlyHttpError(code)` is a
 * status→string table. So all three said some flavour of "daily limit reached,
 * try again tomorrow": the wall existed, the lever that moves it did not.
 *
 * The fix is copy, not plumbing: compose the 429's *message* from the numbers
 * the limiter already has, in the field every client already renders. Web reads
 * the body (`Chat.tsx:1310`), and both native chat streams prefer a JSON
 * `error` field over their static table (`Api.swift:341`,
 * `TinyApi.kt:289`) — which is why `/api/chat` now answers `json: true`.
 *
 * Three rules the branches encode:
 *
 * 1. **Never advertise a lever that does nothing.** `cost: 'others'` limits
 *    (the private-tiny key check, another owner's notification ring, our egress
 *    at a stranger's server) ignore identity and reputation on purpose — see
 *    LimitCost — so their 429s say exactly what the route wrote, with no
 *    reputation talk, mirroring the header's own silence there.
 * 2. **At the cap, stop asking for standing.** Once the bonus is
 *    MAX_REPUTATION_BONUS, "earn more reputation" is false; the message says so
 *    instead of dangling it.
 * 3. **The route's own sentence is the part that must survive.** Web wraps the
 *    body in `new Error(String(msg).slice(0, 300))`, so anything longer is
 *    truncated mid-word by the client. A suffix that wouldn't fit is DROPPED
 *    rather than allowed to push the actual refusal out of view.
 */

/**
 * Web truncates the server's message at 300 chars (`Chat.tsx:1316`). This is
 * that budget, exported so the test pins the number rather than a vibe.
 */
export const CLIENT_MESSAGE_BUDGET = 300

/**
 * Which lever the caller could actually pull. `reputation` = a limit we pay for
 * (cost: 'platform'), where signing in keys the window to you and standing
 * widens it. `none` = a limit that shields a third party, where neither does.
 */
export type LimitLever = 'reputation' | 'none'

export interface LimitMessageInput {
  /** The route's own sentence ("Share limit reached for today."). Never dropped. */
  message: string
  /** Allowance before reputation — the free tier, or the route's own number. */
  base: number
  /** What the window was actually built with (base + earned bonus). */
  allowance: number
  /** Reputation points read for this caller; 0 for anon or an unreadable worker. */
  score: number
  /** Was the window keyed to a signed-in user (cost 'platform' + a session)? */
  identified: boolean
  /** Whether reputation/identity buy anything on this limit at all. */
  lever: LimitLever
}

const int = (n: unknown, fallback = 0): number => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.floor(v) : fallback
}

/** Append only if the whole thing still fits in what the client will show. */
function fit(message: string, suffix: string): string {
  const full = `${message} ${suffix}`
  return full.length <= CLIENT_MESSAGE_BUDGET ? full : message
}

/**
 * The 429's human sentence. Pure — no KV, no request, no env — so every branch
 * is testable, and the numbers come from the same place the limiter enforced.
 */
export function limitMessage({
  message, base, allowance, score, identified, lever,
}: LimitMessageInput): string {
  const sentence = String(message || '').trim()
  if (lever !== 'reputation') return sentence

  if (!identified) {
    // Anonymous on a limit WE pay for: the window is IP-keyed, so they're
    // sharing it with everyone behind their egress (the office/CGNAT complaint
    // that started this track). Signing in is a real, immediate fix — a
    // per-user key is a fresh window — and it's the entrance to the curve.
    return fit(sentence, 'Signing in gives you your own daily allowance instead of one shared with ' +
      'every visitor on your network — and reputation earns more on top of it.')
  }

  const bonus = Math.max(0, int(allowance) - int(base))
  const room = `That's ${pluralize(int(allowance), 'request')} a day`

  if (bonus <= 0) {
    return fit(sentence, `${room}. Reputation earns more room — each point adds ` +
      `${REQUESTS_PER_POINT} a day, up to ${MAX_REPUTATION_BONUS} extra — and being followed is what pays.`)
  }
  if (bonus >= MAX_REPUTATION_BONUS) {
    // Rule 2: the lever is spent. Saying "earn more" here would be a lie the
    // user could spend weeks acting on.
    return fit(sentence, `${room}: ${int(base)} free plus the full ${MAX_REPUTATION_BONUS} ` +
      `that reputation can earn, so more standing won't widen this one.`)
  }
  return fit(sentence, `${room}: ${int(base)} free plus ${bonus} earned from ` +
    `${pluralize(int(score), 'point')} of reputation. Each further point adds ${REQUESTS_PER_POINT} a day, ` +
    `up to ${MAX_REPUTATION_BONUS} extra.`)
}
