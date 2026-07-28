import { pluralize } from './utils'

/**
 * ⚡ THE FREE-TIER DAILY ALLOWANCE — one number, one phrase, one env knob.
 *
 * Report §2.2 ("Web login barriers — what the walls actually are") found that the
 * whole free tier is a single number: 50 requests/day, and it lived as a DEFAULT
 * PARAMETER of `enforceIpDailyLimit`. Nothing read an env var, so a self-hosted
 * deployment — the deployment this whole track exists for, where the model key,
 * the KV instance and the bill all belong to the operator — could not raise or
 * lower its own wall without editing our source.
 *
 * Two things make this more than "read an env var":
 *
 * 1. **The knob widens only the limits WE pay for.** Five call sites omit
 *    `requests` and so inherit this default, but three of them are `cost:
 *    'others'` — the private-tiny key check (`/api/tiny`, `/api/login`) and the
 *    outbound OpenAPI fetch (`/api/worker`). On those the window IS the
 *    brute-force budget against another owner's key, and "give my users more
 *    room" must never silently mean "give every guesser 10× the attempts at a
 *    stranger's tiny". `enforceIpDailyLimit` therefore applies the knob to
 *    `platform` limits only; `others` keeps DEFAULT_REQUESTS_PER_DAY. See
 *    LimitCost in lib/rate-limit.ts for why identity buys nothing there either.
 *
 * 2. **The number is COPY as much as configuration.** Three UI strings quote it
 *    ("Free tier — 50 requests a day", the onboarding toast, ModelSettings'
 *    BYOK pitch). An env-tunable limit with hardcoded copy is exactly the c30
 *    explorer bug again — a correct value under a label that names something
 *    else — except here the label is the part the user reads before they hit the
 *    wall. So the phrase is derived from the same resolver, and it goes through
 *    `pluralize` so an operator who sets 1 doesn't get "1 requests".
 *
 * Why NEXT_PUBLIC_: the browser has to render the number, and it is not a
 * secret — every 429 already discloses it in `X-RateLimit-Limit`, and the
 * onboarding card's entire job is to tell a first-time visitor what the free
 * tier gives them. A server-only var would leave the copy stale on exactly the
 * deployments that changed it.
 *
 * Fail-closed: anything unparseable, zero, negative or absurd falls back to 50
 * rather than to "no limit". A typo in an env file must not remove the wall (or,
 * with 0, wall off every free-tier request on a sliding window that can never
 * succeed) — the safe direction for a misconfiguration is the behaviour this
 * codebase shipped with.
 */

/** The wall as shipped. Also the floor a broken env value falls back to. */
export const DEFAULT_REQUESTS_PER_DAY = 50

/**
 * Practical ceiling. Above this the limiter is indistinguishable from "off",
 * while the value still has to be a sane integer for Upstash's window and short
 * enough to read in a caption.
 */
export const MAX_REQUESTS_PER_DAY = 1_000_000

/** The env name, exported so tests and docs can't spell it differently. */
export const FREE_TIER_ENV = 'NEXT_PUBLIC_FREE_TIER_REQUESTS_PER_DAY'

/**
 * The deployment's free-tier daily allowance. Pure apart from the env read, so
 * the fail-closed rules are testable without KV, a request, or a browser.
 *
 * ⚠️ The env read MUST be the literal `process.env.NEXT_PUBLIC_…` member
 * expression, not `process.env[FREE_TIER_ENV]`. Next inlines NEXT_PUBLIC_ vars
 * into the client bundle by textually substituting literal member accesses; a
 * computed key survives the build as a lookup on an object that doesn't exist in
 * the browser, so the three UI sites would have read `undefined` and quietly
 * printed 50 forever on a deployment that configured something else — passing
 * every server-side test while being wrong in exactly the place a user reads.
 */
export function freeTierRequestsPerDay(): number {
  const raw = process.env.NEXT_PUBLIC_FREE_TIER_REQUESTS_PER_DAY
  if (raw == null || String(raw).trim() === '') return DEFAULT_REQUESTS_PER_DAY
  const n = Number(String(raw).trim())
  // NaN / Infinity / 0 / negative → the shipped default. Infinity is a
  // misconfiguration, not a request for an unlimited tier: it would make
  // slidingWindow's argument non-integral and the copy read "Infinity requests".
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REQUESTS_PER_DAY
  return Math.min(MAX_REQUESTS_PER_DAY, Math.floor(n))
}

/**
 * The one phrase every UI site renders — "50 requests a day". Built with
 * `pluralize` so the count grammar is right at 1 (see lib/utils.ts:283), and
 * carrying no leading/trailing punctuation so each site keeps its own sentence.
 */
export function freeTierRequestsPhrase(): string {
  return `${pluralize(freeTierRequestsPerDay(), 'request')} a day`
}
