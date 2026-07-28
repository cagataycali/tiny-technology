'use client'

/**
 * The clock half of job-cadence.ts: keep the Jobs panel's rows true while it
 * sits open.
 *
 * A4's original observation. Unlike the other three v11 items, the value that
 * rots here is not one the UI computed from the clock — it is a value the SERVER
 * computed, which changes when the cron tick fires. So the fix is not a
 * formatter riding a timer, it is a REFETCH, and the whole design question is
 * when to stop asking.
 *
 * ⚠️ The rule this hook exists to enforce: a panel whose jobs have all finished
 *    must hold no timer. `jobsNeedRefresh` answers that from the rows
 *    themselves, so a schedule of spent one-shots polls zero times, while a job
 *    due in two minutes is picked up within one interval. The other polling
 *    surfaces in this app (ActivityHUD, MessagesHUD, /devices) poll
 *    unconditionally because their subject is always live; a job list has a
 *    terminal state, and honouring it is the difference between a background
 *    fetch loop and one that ends.
 *
 * Also mirrors the house `visibilitychange` pattern (app/devices/page.tsx:177,
 * :364): skip ticks while hidden, and refetch immediately on return, because
 * the moment someone comes back to a tab is exactly when the data is oldest.
 */
import { useEffect, useRef } from 'react'
import { jobsNeedRefresh, type OneShotJobLike } from './job-cadence'

/** Poll interval — the worker's cron granularity is one minute, so anything
 * faster only adds requests without adding freshness. */
export const JOBS_POLL_MS = 60_000

/**
 * Re-run `reload` on a timer for as long as any job's label can still change.
 *
 * @param jobs    the rows currently on screen (the poll's own subject)
 * @param reload  the panel's load(); called with no arguments
 */
export function useJobsRefresh(
  jobs: ReadonlyArray<OneShotJobLike>,
  reload: () => void,
): void {
  // The caller's load() is redefined every render (it closes over setState), and
  // it must NOT be an effect dependency or the interval restarts on every
  // render and never reaches its own delay. A ref keeps the effect keyed on the
  // DATA while always calling the freshest closure.
  const reloadRef = useRef(reload)
  useEffect(() => { reloadRef.current = reload }, [reload])

  // Same reason as relative-tick's string key: `jobs` is a new array on every
  // render, so the effect is keyed on the boolean it actually cares about. That
  // also means arming/disarming happens exactly when liveness flips, not on
  // every repaint of the list.
  const live = jobsNeedRefresh(jobs)

  useEffect(() => {
    if (!live) return
    const tick = () => {
      // Don't poll a tab nobody is looking at — the visibilitychange handler
      // below catches them up on return, in one request instead of the dozens a
      // hidden hour would have made.
      if (typeof document !== 'undefined' && document.hidden) return
      reloadRef.current()
    }
    const t = setInterval(tick, JOBS_POLL_MS)
    const onVisible = () => { if (!document.hidden) reloadRef.current() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [live])
}
