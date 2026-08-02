/**
 * Capacity labels — "N of what?" for the two headers that print a limit.
 *
 * Backlog v10's lens is "a NUMBER the UI shows about data it did not fully
 * receive". c61 found the Memory Panel counting rows it never got. These two are
 * the same lens pointed at the other kind of number: not a count of missing
 * rows, but a DENOMINATOR — a claim about how much room is left.
 *
 * Two findings, and they fail in opposite directions:
 *
 *  1. `Control.tsx` printed `{myTools.length}/20`. **There is no cap of 20
 *     anywhere.** The worker's real one is `MAX_TOOLS = 10000`
 *     (worker/src/tools.ts:15), and its list query has no LIMIT,
 *     so the numerator was honest and the denominator was invented. A user with
 *     20 forged tools reads "20/20 — full" and stops forging, or forges a 21st
 *     and learns the UI was making it up. A fabricated limit is worse than no
 *     limit: it's a rule the product appears to enforce and doesn't.
 *
 *  2. `JobsPanel.tsx` printed `Scheduled jobs · {jobs.length}` with no cap at
 *     all — and there IS one: `MAX_JOBS_PER_USER = 10`
 *     (worker/src/scheduler.ts:23). The user only meets it as a
 *     429 at schedule time, from the agent, mid-conversation.
 *
 * THE TRAP THAT MADE (2) MORE THAN A ONE-LINER, and the reason this is a tested
 * module instead of a template edit: **the cap counts a DIFFERENT POPULATION
 * than the list shows.** The cap query is `WHERE user_id = ? AND enabled = 1`,
 * while the list is every row for the user — and a one-shot job sets
 * `enabled = 0` the moment it fires (scheduler.ts:117/172). So a user with 12
 * jobs listed, 9 of them spent one-shots, is at 3 of 10 and has plenty of room.
 * Rendering `{jobs.length}/10` would have shown "12/10" — over a limit they are
 * nowhere near, on a panel whose only other action is Delete. Pairing a count
 * with a cap is only truthful when both count the same rows, so
 * [activeJobCount] recomputes the cap's own population from the rows on screen.
 */

/** Worker cap on ACTIVE (enabled = 1) jobs per user — scheduler.ts:23. */
export const JOB_ACTIVE_CAP = 10

/**
 * Worker cap on forged tools per user — tools.ts:15.
 *
 * Exported to be ASSERTED against, not to be rendered: at 10000 it is not a
 * capacity a person can approach, so showing it would be noise dressed as
 * information. It lives here so the next person who wants a "N/M" badge finds
 * the real number instead of inventing one, and so a test fails if the worker's
 * value moves.
 */
export const TOOL_MAX = 10000

/** One job row, in the shape /api/jobs returns (extra fields ignored). */
export interface JobLike {
  /** D1 integer boolean; the list includes disabled rows, the cap does not. */
  enabled?: number | boolean | null
  fire_count?: number | null
}

/**
 * How many of these jobs count against the worker's cap.
 *
 * Anything not strictly enabled is excluded, including a missing or malformed
 * flag: /api/jobs is proxied raw (`Array.isArray` is the only validation), and
 * treating an unreadable flag as ACTIVE would inflate the number toward a limit
 * warning the user can't act on. Under-counting here shows more room than there
 * is, which the 429 corrects; over-counting tells someone to delete jobs they
 * don't need to.
 */
export function activeJobCount(jobs: JobLike[]): number {
  if (!Array.isArray(jobs)) return 0
  let n = 0
  for (const j of jobs) {
    // `=== 1` and `=== true`, NOT truthiness: `enabled: "0"` is a truthy string
    // and the D1 column is an integer, so a stringified row (a JSON round-trip
    // through the proxy, a client that quotes numbers) would count a disabled
    // job as active.
    if (j?.enabled === 1 || j?.enabled === true) n++
  }
  return n
}

/**
 * The Jobs panel header.
 *
 * Shows the total when nothing is near the cap — the plain count is what the
 * panel is about, and a permanent "3/10" invites the reading that the other 7
 * slots are a feature. The cap appears only once it's within reach (the last
 * two slots) or reached, because that is the only moment it changes a decision.
 * When it appears it is labelled with the population it counts ("active"), since
 * the list beside it may hold more rows than the number does.
 */
export function jobsHeader(jobs: JobLike[]): string {
  const total = Array.isArray(jobs) ? jobs.length : 0
  const active = activeJobCount(jobs)
  const base = `Scheduled jobs · ${total}`
  if (active >= JOB_ACTIVE_CAP) return `${base} · ${active}/${JOB_ACTIVE_CAP} active — limit reached`
  if (active >= JOB_ACTIVE_CAP - 2) return `${base} · ${active}/${JOB_ACTIVE_CAP} active`
  return base
}

/**
 * The sentence to show when the cap is reached, or null.
 *
 * Separate from the header because it names the WAY OUT, and the way out
 * depends on which population is full: with spent one-shots in the list,
 * deleting one of THOSE frees nothing — they already don't count. Saying
 * "delete a job" would send someone to the rows that look most disposable and
 * change nothing.
 */
export function jobsCapNote(jobs: JobLike[]): string | null {
  const active = activeJobCount(jobs)
  if (active < JOB_ACTIVE_CAP) return null
  const spent = (Array.isArray(jobs) ? jobs.length : 0) - active
  const tail =
    spent > 0
      ? ` Deleting a finished one won't free a slot — only the ${active} active jobs count.`
      : ''
  return `You're at the limit of ${JOB_ACTIVE_CAP} active jobs. Delete an active job to schedule another.${tail}`
}

/**
 * The forged-tools badge.
 *
 * A bare count, because the real cap (10000) is not a capacity anyone meets and
 * the old `/20` denominator was fiction. `null` for "not loaded yet" so the
 * caller can't accidentally render "0" during the fetch — a zero tool box and an
 * unfinished request look identical in a badge and mean opposite things.
 */
export function toolBoxBadge(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}

/**
 * Worker's global page size for run history — scheduler.ts:260,
 * `ORDER BY id DESC LIMIT 30`, across ALL of the user's jobs at once.
 */
export const RUNS_PAGE = 30

/**
 * Why an expanded job shows no runs — the third instance of this lens, and the
 * one with no number attached at all.
 *
 * The runs query is a SINGLE global page of 30 for the whole user, and the panel
 * then buckets it per job (5 max each). A job that has fired but whose runs fell
 * off the far end of that page renders "Last fired <date>" above an empty space:
 * the history is missing, and nothing on screen says whether that's because the
 * job has no history or because someone else's job filled the page. A busy
 * account is exactly where this bites — 30 rows divided among 10 jobs.
 *
 * Returns null when the absence is self-explanatory (never fired), or when the
 * page wasn't full and therefore genuinely holds everything there was.
 */
export function runsMissingNote(
  job: JobLike,
  shownRuns: number,
  totalRunsReceived: number,
): string | null {
  const fired = Number(job?.fire_count)
  if (!Number.isFinite(fired) || fired <= 0) return null
  if (shownRuns > 0) return null
  // A short page means we received every run there was, so an empty bucket is
  // the truth: this job's runs were pruned server-side (the scheduler keeps a
  // bounded history per job), not crowded out by other jobs.
  if (totalRunsReceived < RUNS_PAGE) return null
  return `Ran ${fired}×, but this job's runs aren't in the latest ${RUNS_PAGE} across your schedule.`
}
