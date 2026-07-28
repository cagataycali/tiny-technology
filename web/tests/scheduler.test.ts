// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('scheduler')

type NextDue = (schedule: string | null, runAt: number | null, after: number) => number | null
type ValidSchedule = (schedule: string) => boolean
type Job = { schedule: string | null; run_at: number | null; last_fired_at: number | null; created: number }
type FireDecision = (job: Job, now: number) => 'fire' | 'skip' | 'skip-stale'
let nextDue: NextDue = () => null
let validSchedule: ValidSchedule = () => false
let jobFireDecision: FireDecision = () => 'skip'
let CATCH_UP_SECONDS = 86400
beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('scheduler.ts') /* @vite-ignore */)
  nextDue = mod.nextDue
  validSchedule = mod.validSchedule
  jobFireDecision = mod.jobFireDecision
  CATCH_UP_SECONDS = mod.CATCH_UP_SECONDS
})

describe.skipIf(!present)('validSchedule', () => {
  it.each(['*/5m', '*/1m', '*/12h', 'daily@09:00', 'daily@23:59'])('accepts %s', (s) => {
    expect(validSchedule(s)).toBe(true)
  })

  it.each(['5m', '*/m', '*/5s', 'daily@9:00', 'daily@24:0', 'every 5m', '', 'cron */5'])('rejects %s', (s) => {
    expect(validSchedule(s)).toBe(false)
  })

  // Range-check the clock: two-digit-but-out-of-range hours/minutes used to
  // pass the /^daily@\d{2}:\d{2}$/ shape and silently roll over in Date.UTC
  // (daily@25:00 → fires at 01:00), firing at an unintended time.
  it.each(['daily@25:00', 'daily@24:00', 'daily@09:60', 'daily@99:99', 'daily@12:75'])(
    'rejects out-of-range %s', (s) => {
    expect(validSchedule(s)).toBe(false)
  })

  it.each(['daily@00:00', 'daily@23:59', 'daily@12:30'])('accepts in-range %s', (s) => {
    expect(validSchedule(s)).toBe(true)
  })

  // "*/0m" used to pass \d+ but nextDue() returns null for a 0 step → an
  // enabled job that never fires yet holds one of the 10 quota slots forever.
  it.each(['*/0m', '*/0h', '*/00m'])('rejects zero-step %s (would create a stuck job)', (s) => {
    expect(validSchedule(s)).toBe(false)
  })
})

describe.skipIf(!present)('nextDue', () => {
  it('every-N aligns to the step boundary strictly after `after`', () => {
    // 300s step: after=1000 → next boundary is 1200
    expect(nextDue('*/5m', null, 1000)).toBe(1200)
    // exactly on a boundary → next one, not the same instant (no double-fire)
    expect(nextDue('*/5m', null, 1200)).toBe(1500)
  })

  it('hourly steps', () => {
    expect(nextDue('*/2h', null, 7200)).toBe(14400)
  })

  it('daily@ fires today if still ahead, else tomorrow', () => {
    // 2026-01-01 00:00:00 UTC = 1767225600
    const midnight = 1767225600
    expect(nextDue('daily@09:00', null, midnight)).toBe(midnight + 9 * 3600)
    // after 09:00 → tomorrow 09:00
    expect(nextDue('daily@09:00', null, midnight + 10 * 3600)).toBe(midnight + 86400 + 9 * 3600)
    // exactly at 09:00 → tomorrow (strictly after)
    expect(nextDue('daily@09:00', null, midnight + 9 * 3600)).toBe(midnight + 86400 + 9 * 3600)
  })

  it('one-shot: run_at when future, run_at when past (catch-up handled by caller)', () => {
    expect(nextDue(null, 5000, 1000)).toBe(5000)
    expect(nextDue(null, 500, 1000)).toBe(500)
    expect(nextDue(null, null, 1000)).toBeNull()
  })

  it('zero-step schedules return null (rejected upstream by validSchedule)', () => {
    expect(nextDue('*/0m', null, 1000)).toBeNull()
  })

  it('garbage schedules return null', () => {
    expect(nextDue('nonsense', null, 1000)).toBeNull()
    expect(nextDue('*/0m', null, 1000)).toBeNull()
  })
})

describe.skipIf(!present)('jobFireDecision', () => {
  const NOW = 1_000_000

  it('fires a recurring job whose boundary just passed', () => {
    // */5m job last fired at NOW-600 → next boundary at ~NOW-300, due, within window
    const job = { schedule: '*/5m', run_at: null, last_fired_at: NOW - 600, created: 0 }
    expect(jobFireDecision(job, NOW)).toBe('fire')
  })

  it('skips a job not yet due', () => {
    // last fired 60s ago on a 5m schedule → next boundary is future
    const job = { schedule: '*/5m', run_at: null, last_fired_at: NOW - 60, created: 0 }
    expect(jobFireDecision(job, NOW)).toBe('skip')
  })

  it('skip-stale when due longer ago than the catch-up window', () => {
    // last fired ~2 days ago → due time is well past NOW - CATCH_UP_SECONDS
    const job = { schedule: '*/5m', run_at: null, last_fired_at: NOW - 2 * CATCH_UP_SECONDS, created: 0 }
    expect(jobFireDecision(job, NOW)).toBe('skip-stale')
  })

  it('one-shot: fires once when run_at has passed (within window)', () => {
    const job = { schedule: null, run_at: NOW - 60, last_fired_at: null, created: 0 }
    expect(jobFireDecision(job, NOW)).toBe('fire')
    // future one-shot → skip
    expect(jobFireDecision({ schedule: null, run_at: NOW + 60, last_fired_at: null, created: 0 }, NOW)).toBe('skip')
  })

  it('garbage schedule → skip (never fires, never errors)', () => {
    expect(jobFireDecision({ schedule: 'nonsense', run_at: null, last_fired_at: null, created: 0 }, NOW)).toBe('skip')
  })

  it('recurring job with NULL last_fired_at fires (falls back to created)', () => {
    // A never-fired recurring row (last_fired_at NULL) must fire, using
    // `created` as the baseline. NOTE: the CAS in runDueJobs must then use
    // `last_fired_at IS ?` (null-safe) — `= ?` compares against NULL and would
    // skip this row forever despite this 'fire' decision.
    const job = { schedule: '*/5m', run_at: null, last_fired_at: null, created: NOW - 600 }
    expect(jobFireDecision(job, NOW)).toBe('fire')
  })
})
