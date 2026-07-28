/**
 * Did this one-shot job RUN? — the question `JobsPanel`'s cadence line answered
 * by guessing, in the one direction that invents history.
 *
 * v11's lens is "a value the UI computed from the clock and then never
 * recomputed", and A4 was filed as the mild version of that: the panel loads
 * once (`JobsPanel.tsx` `load()` in a mount-only effect) so a job watched
 * through its own fire time keeps saying "once at 09:00" after 09:00. True, and
 * fixed by refetching. But reading the worker to confirm it turned up a defect
 * that no amount of refetching would fix, because it is wrong on the FIRST
 * paint:
 *
 *     const done = job.fire_count > 0 || !job.enabled
 *     return `${done ? 'ran' : 'once at'} ${when(job.run_at)}`
 *
 * 🔑 `!enabled` is NOT evidence that a job ran. The scheduler clears `enabled`
 * from two places, and only one of them is a run:
 *
 *   • after a successful fire — `UPDATE jobs SET enabled = 0` (scheduler.ts:172),
 *     preceded by CLAIM_SQL, which increments `fire_count`.
 *   • when it gives UP on one — the 'skip-stale' branch (scheduler.ts:117)
 *     `UPDATE jobs SET last_fired_at = ?, enabled = 0`, reached when a job was
 *     due more than CATCH_UP_SECONDS (24h) ago. `fire_count` is untouched. The
 *     job never ran and now never will: it is disabled precisely so the tick
 *     stops re-evaluating it.
 *
 * So the row for an abandoned one-shot read `ran Jul 20, 09:00 · fired 0×` —
 * self-contradictory on its own line, and the wrong half is the one a person
 * acts on. Somebody who asked for a reminder is told it happened. Worse, the
 * expanded card says `Last fired <date>` from `last_fired_at`, which that same
 * UPDATE set to the moment of ABANDONMENT — so the panel names a time the job
 * definitely did not run at.
 *
 * That state is easy to reach without any outage: `runAt` is only validated as
 * finite (scheduler.ts:203–206), so an agent that computes a unix timestamp
 * from a misparsed date lands a one-shot whose fire time is already in the past.
 * It is created enabled, the next tick marks it stale, and the panel then claims
 * it ran.
 *
 * 🔑 The general rule: `fire_count` is the ONLY field that records a run. Every
 * other field here (`enabled`, `last_fired_at`) is scheduler bookkeeping, and
 * both are written by paths that mean "never mind" as well as by paths that mean
 * "done". A flag that two code paths clear for opposite reasons cannot be read
 * as either one.
 *
 * Pure and `nowSec`-injectable, in the house pattern (quote-expiry.ts,
 * faucet-countdown.ts): the panel formats the time, this decides what the time
 * MEANS.
 */

/** Mirror of the scheduler's CATCH_UP_SECONDS (scheduler.ts:75). */
export const JOB_CATCH_UP_SECONDS = 24 * 60 * 60

/** A job row as /api/jobs returns it; extra fields ignored. */
export interface OneShotJobLike {
  schedule?: string | null
  run_at?: number | null
  /** D1 integer boolean. */
  enabled?: number | boolean | null
  fire_count?: number | null
}

/**
 * What a one-shot job's fire time means right now.
 *
 *  'ran'      — it fired. The only state `fire_count` can attest to.
 *  'missed'   — it will never fire: the scheduler either already dropped it
 *               (disabled with no runs) or is past the point where it can
 *               (still enabled, but due beyond the catch-up window, so the very
 *               next tick takes the skip-stale branch). Deliberately ONE state:
 *               "already abandoned" and "certain to be abandoned" differ in
 *               bookkeeping, not in anything the user can do or expect.
 *  'due'      — its time has passed, it is still enabled, and it is inside the
 *               catch-up window, so it is genuinely about to run. The cron ticks
 *               every minute; this is a job in flight, not a broken one.
 *  'pending'  — its time is still ahead.
 *  'unknown'  — no usable `run_at`. Same guard as `when()`/`relativeAgo`: the
 *               payload is proxied raw, and Number(null) is 0 — a finite value
 *               that would date the job to 1970 and read as long-missed.
 */
export type OneShotState = 'ran' | 'missed' | 'due' | 'pending' | 'unknown'

/** The usable-timestamp guard shared with relative-time.ts (seconds > 0). */
function usableSec(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Strictly enabled — matches capacity.ts's activeJobCount, and for the same
 * reason: `enabled: "0"` is a truthy string off a JSON round-trip. */
function isEnabled(job: OneShotJobLike): boolean {
  return job?.enabled === 1 || job?.enabled === true
}

/**
 * Did the scheduler record a run? — the only question anything here asks of
 * `fire_count`.
 *
 * ⚠️ Deliberately NOT `Number.isFinite(n) && n > 0 ? n : 0` behind a `> 0` at
 *    each call site. That was the first version, and a mutation test found the
 *    finite-check could never change an outcome: every unusable value coerces to
 *    NaN or a non-positive number, and both `NaN > 0` and `-1 > 0` are already
 *    false. A guard that cannot fail makes every mutation verdict on it
 *    meaningless, so it is gone rather than pinned by a test that proves nothing
 *    (same call as use-relative-tick's deleted length check).
 */
function hasRun(job: OneShotJobLike): boolean {
  return Number(job?.fire_count) > 0
}

/**
 * Classify a one-shot job. `nowSec` is unix SECONDS, matching the payload.
 *
 * Order matters, and the first branch is the whole point: a recorded run
 * outranks every flag, including a still-enabled row (the scheduler's
 * post-fire disable is a separate statement inside a swallowing try/catch at
 * scheduler.ts:171–174, so `enabled = 1, fire_count = 1` is a state that can
 * exist, and it means the job RAN).
 */
export function oneShotState(
  job: OneShotJobLike,
  nowSec: number = Math.floor(Date.now() / 1000),
): OneShotState {
  if (hasRun(job)) return 'ran'
  const runAt = usableSec(job?.run_at)
  if (runAt === null) return 'unknown'
  // Never ran, and nothing left to run it: the scheduler disables a job it has
  // abandoned so the tick stops looking at it.
  if (!isEnabled(job)) return 'missed'
  if (runAt > nowSec) return 'pending'
  // Due. Whether it still gets to run is exactly the scheduler's catch-up test.
  return nowSec - runAt > JOB_CATCH_UP_SECONDS ? 'missed' : 'due'
}

/**
 * The word before the formatted time, or null when there is nothing to say
 * about a time we cannot read.
 *
 * Kept separate from the state so the panel keeps its own `toLocaleString`
 * formatting (and its "?" fallback) instead of this module growing a second
 * date vocabulary.
 */
export function oneShotPrefix(state: OneShotState): string | null {
  switch (state) {
    case 'ran':
      return 'ran'
    // Names the outcome, not the flag. "didn't run" is the only phrasing that is
    // true for both halves of 'missed' and cannot be mistaken for a schedule.
    case 'missed':
      return "didn't run"
    // Not "once at": the time has passed, so a future-tense label reads as a
    // job that is still coming and makes an in-flight run look overdue-forever.
    case 'due':
      return 'due'
    case 'pending':
      return 'once at'
    default:
      return null
  }
}

/**
 * Why a job that never fired is showing a `last_fired_at`.
 *
 * The expanded card renders "Last fired {when(last_fired_at)}" whenever the
 * field is set — but skip-stale sets it to the moment the scheduler gave up
 * (scheduler.ts:117), so on a missed job that line names a time nothing
 * happened. Returns the honest replacement, or null when "Last fired" is true.
 */
export function lastFiredNote(
  job: OneShotJobLike,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  if (hasRun(job)) return null
  const state = oneShotState(job, nowSec)
  if (state !== 'missed') return null
  return `Never ran — its scheduled time passed more than ${JOB_CATCH_UP_SECONDS / 3600}h before the scheduler reached it, so it was dropped.`
}

/**
 * Is this row's label going to change on its own? — the refetch half of A4.
 *
 * True for the states whose truth is a function of the clock and the worker:
 * a 'pending' job becomes 'due' then 'ran' with no interaction at all, and the
 * panel is an overlay someone leaves open. 'ran'/'missed' are terminal, so a
 * panel showing only those needs no poll, and a recurring job's label ('every
 * 5 min') never changes either.
 *
 * Returned as a predicate over the whole list so the polling decision is
 * testable without a DOM, and so an idle panel of finished jobs stops asking.
 */
export function jobsNeedRefresh(
  jobs: ReadonlyArray<OneShotJobLike>,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Array.isArray(jobs)) return false
  return jobs.some((j) => {
    // A recurring job's cadence string is schedule-derived and constant; its
    // fire_count and last run DO move, which is exactly what the run history
    // beneath it shows, so an enabled recurring job counts as live too.
    if (typeof j?.schedule === 'string' && j.schedule) return isEnabled(j)
    const state = oneShotState(j, nowSec)
    return state === 'pending' || state === 'due'
  })
}
