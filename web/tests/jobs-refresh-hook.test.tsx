// @vitest-environment jsdom
/**
 * The refetch half of v11 A4. job-cadence.test.ts proves the classification;
 * what only a DOM + fake timers can show is A4's original claim — a panel that
 * loads once and therefore never learns its job fired — and the property that
 * keeps the fix from becoming a background request loop: when every job is
 * terminal, the hook must arm NOTHING.
 *
 * ⚠️ Time is advanced in STEPS wherever the subject is a RATE. A single
 *    advanceTimersByTime(BIG) batches every setState into one React render, so a
 *    count taken after one big jump measures the batching, not the schedule
 *    (c66's rule). Each rate assertion also carries a LOWER bound, or a hook
 *    that armed nothing would pass it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useJobsRefresh, JOBS_POLL_MS } from '../lib/chat/use-jobs-refresh'
import type { OneShotJobLike } from '../lib/chat/job-cadence'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  // jsdom keeps `hidden` from the last test otherwise, and a leaked `true` makes
  // every later poll assertion pass for the wrong reason.
  setHidden(false)
})

const NOW_MS = 1_800_000_000_000
const NOW = NOW_MS / 1000
const HOUR = 3600

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

const oneShot = (over: Partial<OneShotJobLike> = {}): OneShotJobLike => ({
  schedule: null, run_at: NOW - HOUR, enabled: 1, fire_count: 0, ...over,
})

let calls = 0

function Panel({ jobs }: { jobs: OneShotJobLike[] }) {
  // Deliberately a NEW closure every render, like the panel's own load() — the
  // hook must not restart its interval because of that.
  useJobsRefresh(jobs, () => { calls++ })
  return <div>{jobs.length}</div>
}

function mount(jobs: OneShotJobLike[]) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  calls = 0
  return render(<Panel jobs={jobs} />)
}

const step = (ms: number, chunk = 1_000) => {
  act(() => {
    for (let t = 0; t < ms; t += chunk) vi.advanceTimersByTime(chunk)
  })
}

describe('useJobsRefresh', () => {
  it('polls a due job — THE regression: the panel used to never hear it fired', () => {
    mount([oneShot({ run_at: NOW + 120 })])
    expect(calls).toBe(0) // no immediate refetch; the mount-time load() covers that
    step(JOBS_POLL_MS)
    expect(calls).toBe(1)
    step(JOBS_POLL_MS * 3)
    expect(calls).toBe(4)
  })

  it('arms NOTHING when every job is terminal', () => {
    mount([
      oneShot({ fire_count: 1, enabled: 0 }),
      oneShot({ enabled: 0, fire_count: 0, run_at: NOW - 30 * HOUR }),
    ])
    step(JOBS_POLL_MS * 10)
    expect(calls).toBe(0)
    // Nothing scheduled at all — not merely "the callback declined to fire".
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll faster than the worker`s cron granularity', () => {
    mount([oneShot({ run_at: NOW + 600 })])
    step(JOBS_POLL_MS - 1_000)
    expect(calls).toBe(0)
    step(1_000)
    expect(calls).toBe(1)
  })

  it('a re-render with a NEW array of the same jobs does not restart the interval', () => {
    // The panel builds `jobs` from state and load() fresh each render; if either
    // were an effect dep the interval would re-arm forever and never fire.
    const jobs = [oneShot({ run_at: NOW + 600 })]
    const { rerender } = mount(jobs)
    step(JOBS_POLL_MS - 5_000)
    for (let i = 0; i < 5; i++) {
      act(() => { rerender(<Panel jobs={[...jobs.map((j) => ({ ...j }))]} />) })
    }
    step(5_000)
    expect(calls).toBe(1)
  })

  it('stops polling once the list becomes terminal', () => {
    const { rerender } = mount([oneShot({ run_at: NOW + 60 })])
    step(JOBS_POLL_MS)
    expect(calls).toBe(1)
    act(() => { rerender(<Panel jobs={[oneShot({ fire_count: 1, enabled: 0 })]} />) })
    step(JOBS_POLL_MS * 5)
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts polling when a terminal list gains a live job', () => {
    const { rerender } = mount([oneShot({ fire_count: 1, enabled: 0 })])
    step(JOBS_POLL_MS * 2)
    expect(calls).toBe(0)
    act(() => { rerender(<Panel jobs={[oneShot({ run_at: NOW + 600 })]} />) })
    step(JOBS_POLL_MS)
    expect(calls).toBe(1)
  })

  it('skips ticks while the tab is hidden', () => {
    mount([oneShot({ run_at: NOW + 600 })])
    setHidden(true)
    step(JOBS_POLL_MS * 5)
    expect(calls).toBe(0)
  })

  it('refetches IMMEDIATELY on becoming visible — the data is oldest right then', () => {
    mount([oneShot({ run_at: NOW + 600 })])
    setHidden(true)
    step(JOBS_POLL_MS * 3)
    expect(calls).toBe(0)
    setHidden(false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(calls).toBe(1)
  })

  it('a visibilitychange to HIDDEN does not fetch', () => {
    mount([oneShot({ run_at: NOW + 600 })])
    setHidden(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(calls).toBe(0)
  })

  it('unmount removes both the interval and the listener', () => {
    const { unmount } = mount([oneShot({ run_at: NOW + 600 })])
    act(() => { unmount() })
    expect(vi.getTimerCount()).toBe(0)
    step(JOBS_POLL_MS * 3)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(calls).toBe(0)
  })

  it('calls the LATEST closure, not the one captured when the interval armed', () => {
    // The panel's load() closes over setState; a stale closure would commit rows
    // into an unmounted-or-superseded state.
    let which = 'first'
    let seen = ''
    function Host({ tag }: { tag: string }) {
      useJobsRefresh([oneShot({ run_at: NOW + 600 })], () => { seen = tag })
      return null
    }
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const { rerender } = render(<Host tag={which} />)
    which = 'second'
    act(() => { rerender(<Host tag={which} />) })
    step(JOBS_POLL_MS)
    expect(seen).toBe('second')
  })
})
