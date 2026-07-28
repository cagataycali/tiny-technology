/**
 * What the Universe surfaces may claim about the builders and tinys they show.
 *
 * Backlog v10 A4 (lens = "a NUMBER the UI shows about data it did not fully
 * receive"). A4 was filed as one item — `{users.length} builders` from
 * `?limit=100`, paired on the same line with `totalPublicTinys`, which IS a
 * real total. Probing the live worker turned up something the item hadn't
 * suspected, and it is the bigger half:
 *
 *  1. **`/community` DOES return a builder total, and nothing rendered it.**
 *     `GET /community?limit=1` answers `{users:[…1 row…], totalUsers: 5, …}` —
 *     verified live, and `Chat.tsx:238` already knows this ("the deployed
 *     worker returns a true COUNT(*) totalUsers … independent of ?limit"). But
 *     `normalizeCommunity` never carried the field, so every surface that draws
 *     the universe printed the PAGE LENGTH under the word "builders" next to a
 *     genuine `totalPublicTinys` total. This is c61's Memory-Panel defect
 *     exactly — one line fed by two queries, one a page and one a COUNT(*) —
 *     on a PUBLIC page, and with the honest number already in the payload.
 *
 *  2. **`tinyCount` and `tinys[]` are different populations, and the card put
 *     them side by side.** The worker caps each user's embedded `tinys` array
 *     at 8 while `tinyCount` is that builder's real total: `cagataycali`
 *     returns `tinyCount: 20` with 8 names (verified against `/profile?login=`,
 *     which returns all 20 — the community 8 are its first 8). So the grid
 *     rendered a "20 tinys" badge above 8 chips, and `UniverseDirectory`'s
 *     "+N more" arithmetic — `u.tinys.length > 8 && +{u.tinys.length - 8}` —
 *     can NEVER fire, because `tinys.length` is at most 8. **The overflow
 *     affordance for the truncation was computed from the truncated array**, so
 *     the 12 hidden tinys had no link and no mention anywhere.
 *
 * The same subtraction is the constellation footer's: `nodes.length -
 * users.length` counts the stars it drew (≤ 8 per builder), under a label that
 * reads like a census of the universe. It is honest about the PICTURE and the
 * picture is a sample; c62's rule applies — the count was right, and what it
 * was silent about was the finding.
 *
 * So the rule this module encodes, and it is the v10 lens turned around: **when
 * a payload carries both a page and a total, render the total and say what the
 * page is** — and when it carries neither, derive the overflow from the number
 * that counts the whole population, never from the array that was cut.
 *
 * Pure — no fetch, no React — so every rule here is a node test.
 */

/**
 * The worker's per-user cap on the embedded `tinys` array in a `/community`
 * response — verified live: `cagataycali` has `tinyCount: 20` and 8 entries,
 * and `/profile?login=cagataycali` returns all 20 with the community 8 as its
 * leading slice. There is no query parameter that widens it (`tinyLimit`,
 * `tinys`, `perUser` all leave it at 8).
 *
 * Exported to be COMPARED against, not rendered: it is the reason a card's chip
 * row can be short while its badge is right, and the reason overflow must be
 * derived from `tinyCount`.
 */
export const COMMUNITY_TINYS_PER_USER = 8

/**
 * The `limit` our surfaces send to `/community`. The worker clamps above this
 * anyway (`?limit=500` returns the same rows as `?limit=100`), so this is the
 * page size we ask for, not a cap we invented.
 */
export const COMMUNITY_PAGE = 100

export type UniverseCountsInput = {
  /** Builders actually received (the page). */
  shown: number
  /**
   * The worker's `totalUsers` — a real COUNT(*), independent of `?limit`.
   * `undefined` when an older payload omits it (then the page is all we know).
   */
  totalUsers?: number
  /** The worker's `totalPublicTinys` — a real total, every mode. */
  totalPublicTinys: number
  /** The worker's `totalMessages`, or 0/absent. */
  totalMessages?: number
  /** The page size the fetch asked for; a full page is evidence of more. */
  limit?: number
}

export type UniverseCounts = {
  /** e.g. "5 builders" or "100 of 340 builders" — never a bare page length. */
  builders: string
  /** e.g. "25 public tinys" — a true total, so it never needs qualifying. */
  tinys: string
  /** True when builders exist that are not on this page. */
  truncated: boolean
  /** Longer explanation for `title`, only when the page isn't the whole set. */
  title?: string
}

const int = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback
}

/**
 * The builders/tinys line for a Universe header.
 *
 * Two independent proofs that builders are missing, for the same reason
 * `memoryHeader` needs two: the count comparison is exact but needs
 * `totalUsers` to exist, and a full page is the only evidence available when it
 * doesn't. Neither is sufficient alone — an older worker payload has no total,
 * and a total that happens to equal the page size proves nothing by itself.
 */
export function universeCounts(input: UniverseCountsInput): UniverseCounts {
  const shown = int(input.shown)
  const publicTinys = int(input.totalPublicTinys)
  const limit = Number.isFinite(input.limit) ? int(input.limit) : undefined
  // A total BELOW the page length is a broken payload, not a truncation: trust
  // the rows in hand over a number that contradicts them, or the header would
  // read "12 of 3 builders".
  const rawTotal = Number.isFinite(input.totalUsers as number) ? int(input.totalUsers) : undefined
  const total = rawTotal !== undefined && rawTotal >= shown ? rawTotal : undefined

  const missing = total !== undefined && total > shown
  // Only meaningful when we have no total to compare against — with a total,
  // `missing` is exact, and a full page that IS the whole set must not be
  // reported as truncated.
  const fullPage = total === undefined && limit !== undefined && shown >= limit
  const truncated = missing || fullPage

  const tinys = `${publicTinys} public tin${publicTinys === 1 ? 'y' : 'ys'}`

  if (missing) {
    return {
      builders: `${shown} of ${total} builders`,
      tinys,
      truncated: true,
      title: `Showing ${shown} of ${total} builders — the newest page. ${publicTinys} public tinys across all of them.`,
    }
  }
  const builders = `${shown} builder${shown === 1 ? '' : 's'}`
  if (fullPage) {
    return {
      builders,
      tinys,
      truncated: true,
      title: `Showing the first ${shown} builders — there may be more. ${publicTinys} public tinys across all of them.`,
    }
  }
  return { builders, tinys, truncated: false }
}

/**
 * How many of a builder's tinys are NOT in the chips on screen.
 *
 * `tinyCount` is the builder's real total; `tinys[]` is the worker's ≤8 slice,
 * further sliced by the caller's own display cap (8 in the grid, 6 in the
 * drawer). The old `tinys.length - 8` could never be positive, so a builder
 * with 20 tinys showed 8 chips and no way to reach the rest.
 *
 * Returns 0 when nothing is hidden, or when `tinyCount` is smaller than what's
 * on screen (a stale/incoherent count must not produce a negative "+-3 more").
 */
export function hiddenTinyCount(tinyCount: unknown, chipsShown: number): number {
  const total = int(tinyCount)
  const shown = int(chipsShown)
  return Math.max(0, total - shown)
}

/**
 * The footer under a constellation, which draws at most
 * [COMMUNITY_TINYS_PER_USER] stars per builder.
 *
 * The star count is honest about the picture, so it stays — what it was silent
 * about is that the picture is a sample. Qualify it only when it actually is
 * one: `starsShown < totalPublicTinys` is provable omission, and when they
 * match, the drawing IS the universe and a hedge would be its own false claim.
 */
export function constellationFooter(input: {
  builders: number
  starsShown: number
  totalPublicTinys: number
}): { label: string; title?: string } {
  const builders = int(input.builders)
  const stars = int(input.starsShown)
  const publicTinys = int(input.totalPublicTinys)
  const b = `${builders} builder${builders === 1 ? '' : 's'}`

  if (publicTinys > stars) {
    return {
      label: `${b} · ${stars} of ${publicTinys} tinys`,
      title: `Each builder shows up to ${COMMUNITY_TINYS_PER_USER} tinys, so ${publicTinys - stars} aren't drawn — open a builder to see all of theirs.`,
    }
  }
  return { label: `${b} · ${stars} tin${stars === 1 ? 'y' : 'ys'}` }
}
