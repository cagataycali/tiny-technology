// @vitest-environment node
/**
 * v11 A4 — the Jobs panel's one-shot cadence line.
 *
 * The item was filed as a staleness finding ("a job due in two minutes still
 * says 'once at' after it has fired"). Reading the worker to re-verify it turned
 * up a stronger defect in the same line, wrong on the FIRST paint: the panel
 * read `!enabled` as "it ran", and the scheduler clears that flag from two
 * places, only one of which is a run.
 *
 * So the load-bearing tests here are the ones that pin the DISTINCTION between
 * the scheduler's two disable paths — and each is asserted against the worker's
 * own source, so a change to either statement breaks this suite instead of
 * silently restoring the false claim.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  oneShotState,
  oneShotPrefix,
  lastFiredNote,
  jobsNeedRefresh,
  JOB_CATCH_UP_SECONDS,
  type OneShotJobLike,
} from '../lib/chat/job-cadence'
import { workerFile, workerPresent, warnIfWorkerAbsent } from './_worker'

const NOW = 1_800_000_000 // unix SECONDS, matching the payload
const HOUR = 3600

/** A one-shot as /api/jobs returns it: schedule null, run_at set, once = 1. */
const oneShot = (over: Partial<OneShotJobLike> = {}): OneShotJobLike => ({
  schedule: null,
  run_at: NOW - HOUR,
  enabled: 1,
  fire_count: 0,
  ...over,
})

describe('oneShotState — a run is recorded by fire_count and by nothing else', () => {
  it('a fired one-shot: fire_count 1, enabled cleared', () => {
    // The normal terminal state: scheduler.ts increments fire_count via
    // CLAIM_SQL and then clears enabled.
    expect(oneShotState(oneShot({ fire_count: 1, enabled: 0 }), NOW)).toBe('ran')
  })

  it('🔴 THE BUG: disabled with fire_count 0 is a job that NEVER ran', () => {
    // The skip-stale path (scheduler.ts:117) sets enabled = 0 and leaves
    // fire_count alone. The old line read `!enabled` as done and rendered
    // "ran <date> · fired 0×" — a contradiction on its own line, and the wrong
    // half is the one someone acts on.
    const abandoned = oneShot({ enabled: 0, fire_count: 0, run_at: NOW - 30 * HOUR })
    expect(oneShotState(abandoned, NOW)).toBe('missed')
    expect(oneShotPrefix(oneShotState(abandoned, NOW))).toBe("didn't run")
    expect(oneShotPrefix(oneShotState(abandoned, NOW))).not.toBe('ran')
  })

  it('fire_count OUTRANKS a still-enabled flag', () => {
    // scheduler.ts:171-174 increments then disables in a SEPARATE statement,
    // inside the per-job try/catch that swallows D1 errors — so
    // {enabled: 1, fire_count: 1} is reachable and means it ran.
    expect(oneShotState(oneShot({ enabled: 1, fire_count: 3 }), NOW)).toBe('ran')
  })

  it('a future one-shot is pending', () => {
    expect(oneShotState(oneShot({ run_at: NOW + HOUR }), NOW)).toBe('pending')
    expect(oneShotPrefix('pending')).toBe('once at')
  })

  it('past its time, still enabled, inside the catch-up window: DUE, not missed', () => {
    // The cron ticks every minute, so this job is in flight. Labelling it
    // "didn't run" would be the mirror-image of the original bug.
    expect(oneShotState(oneShot({ run_at: NOW - 60 }), NOW)).toBe('due')
    expect(oneShotPrefix('due')).toBe('due')
  })

  it('"due" is not "once at" — a future-tense label on a past time reads as never-arriving', () => {
    expect(oneShotPrefix('due')).not.toBe(oneShotPrefix('pending'))
  })

  it('past the catch-up window while still enabled: missed, because the next tick drops it', () => {
    // jobFireDecision returns 'skip-stale' here, so this job's fate is already
    // decided even though its flag has not been written yet.
    expect(oneShotState(oneShot({ run_at: NOW - JOB_CATCH_UP_SECONDS - 1 }), NOW)).toBe('missed')
  })

  it('the catch-up boundary is EXCLUSIVE, matching the scheduler`s > comparison', () => {
    // `now - due > CATCH_UP_SECONDS` — exactly 24h old still fires.
    expect(oneShotState(oneShot({ run_at: NOW - JOB_CATCH_UP_SECONDS }), NOW)).toBe('due')
    expect(oneShotState(oneShot({ run_at: NOW - JOB_CATCH_UP_SECONDS - 1 }), NOW)).toBe('missed')
  })

  it('run_at exactly now is due, not pending', () => {
    expect(oneShotState(oneShot({ run_at: NOW }), NOW)).toBe('due')
  })
})

describe('oneShotState — unusable input never becomes a claim', () => {
  it('a missing or zero run_at is unknown, not 1970', () => {
    // Number(null) is 0: finite, and ~55 years "missed". The panel falls back to
    // its own "?" rather than dating a job to the Unix epoch.
    for (const run_at of [null, undefined, 0, NaN, -5] as unknown[]) {
      expect(oneShotState(oneShot({ run_at: run_at as number }), NOW)).toBe('unknown')
    }
    expect(oneShotPrefix('unknown')).toBeNull()
  })

  it('a non-numeric run_at is unknown', () => {
    expect(oneShotState({ run_at: 'soon' as unknown as number, enabled: 1 }, NOW)).toBe('unknown')
  })

  it('fire_count still wins over an unusable run_at — it ran, we just cannot say when', () => {
    expect(oneShotState({ run_at: null, fire_count: 1 }, NOW)).toBe('ran')
  })

  it('enabled: "0" (a stringified D1 row) counts as DISABLED, not truthy', () => {
    // Same trap capacity.ts documents: a JSON round-trip that quotes numbers
    // would otherwise make a dropped job read as still scheduled.
    //
    // ⚠️ run_at is RECENT on purpose. The first version of this test used a
    //    30h-old run_at and passed against `Boolean(job.enabled)` too — because
    //    that fixture reaches 'missed' by the OTHER path (past the catch-up
    //    window), so the assertion proved nothing about the flag it names. A
    //    fixture must make the two readings DISAGREE: inside the window, a
    //    disabled job is 'missed' and a truthy-read one is 'due'.
    const quoted = { schedule: null, run_at: NOW - 60, enabled: '0' as unknown as number, fire_count: 0 }
    expect(oneShotState(quoted, NOW)).toBe('missed')
    expect(oneShotState({ ...quoted, enabled: 1 }, NOW)).toBe('due')
  })

  it('only 1 and true are enabled — every other flag shape is a dropped job', () => {
    // Inside the catch-up window, so 'missed' can only come from the flag.
    for (const enabled of [0, '0', 'false', null, undefined, 2, '1'] as unknown[]) {
      const j = { schedule: null, run_at: NOW - 60, enabled: enabled as number, fire_count: 0 }
      expect(oneShotState(j, NOW)).toBe('missed')
    }
    expect(oneShotState({ schedule: null, run_at: NOW - 60, enabled: true, fire_count: 0 }, NOW)).toBe('due')
  })

  it('a garbage fire_count is treated as no runs', () => {
    for (const fire_count of [null, undefined, NaN, -1, 'two'] as unknown[]) {
      const j = oneShot({ fire_count: fire_count as number, run_at: NOW + HOUR })
      expect(oneShotState(j, NOW)).toBe('pending')
    }
  })

  it('an empty object does not crash and claims nothing', () => {
    expect(oneShotState({}, NOW)).toBe('unknown')
  })
})

describe('lastFiredNote — "Last fired" must not name the moment of abandonment', () => {
  it('a missed job gets the honest sentence instead', () => {
    // skip-stale writes last_fired_at = now (scheduler.ts:117), so the expanded
    // card said "Last fired <the moment we gave up>".
    const note = lastFiredNote(oneShot({ enabled: 0, fire_count: 0, run_at: NOW - 30 * HOUR }), NOW)
    expect(note).toMatch(/Never ran/)
    expect(note).toMatch(/24h/)
  })

  it('null for a job that really did fire — the normal line stands', () => {
    expect(lastFiredNote(oneShot({ fire_count: 2, enabled: 0 }), NOW)).toBeNull()
  })

  it('null for pending and due jobs — nothing to explain yet', () => {
    expect(lastFiredNote(oneShot({ run_at: NOW + HOUR }), NOW)).toBeNull()
    expect(lastFiredNote(oneShot({ run_at: NOW - 60 }), NOW)).toBeNull()
  })

  it('null for a recurring job — it has no run_at to be missed', () => {
    expect(lastFiredNote({ schedule: '*/5m', run_at: null, enabled: 1, fire_count: 0 }, NOW)).toBeNull()
  })
})

describe('jobsNeedRefresh — a finished schedule must hold no timer', () => {
  it('false for a list of terminal jobs', () => {
    expect(jobsNeedRefresh([
      oneShot({ fire_count: 1, enabled: 0 }),
      oneShot({ enabled: 0, fire_count: 0, run_at: NOW - 30 * HOUR }),
    ], NOW)).toBe(false)
  })

  it('true when ANY job is still pending or due', () => {
    expect(jobsNeedRefresh([
      oneShot({ fire_count: 1, enabled: 0 }),
      oneShot({ run_at: NOW + 120 }),
    ], NOW)).toBe(true)
    expect(jobsNeedRefresh([oneShot({ run_at: NOW - 60 })], NOW)).toBe(true)
  })

  it('true for an enabled recurring job — its fire count and runs keep moving', () => {
    expect(jobsNeedRefresh([{ schedule: 'daily@09:00', run_at: null, enabled: 1, fire_count: 4 }], NOW)).toBe(true)
  })

  it('false for a DISABLED recurring job — nothing will fire it', () => {
    expect(jobsNeedRefresh([{ schedule: '*/5m', run_at: null, enabled: 0, fire_count: 9 }], NOW)).toBe(false)
  })

  it('false for an empty list and for malformed input', () => {
    expect(jobsNeedRefresh([], NOW)).toBe(false)
    expect(jobsNeedRefresh(null as unknown as OneShotJobLike[], NOW)).toBe(false)
  })

  it('an unknown-run_at job does not keep the poll alive forever', () => {
    // It can never transition, so polling for it would be an endless request
    // loop over a row that will never change.
    expect(jobsNeedRefresh([oneShot({ run_at: null })], NOW)).toBe(false)
  })

  it('flips to false as the last live job crosses into missed', () => {
    const jobs = [oneShot({ run_at: NOW - JOB_CATCH_UP_SECONDS })]
    expect(jobsNeedRefresh(jobs, NOW)).toBe(true)
    expect(jobsNeedRefresh(jobs, NOW + 1)).toBe(false)
  })
})

describe('the worker source is the spec — these break if the scheduler changes', () => {
  it('skip-stale really does clear enabled WITHOUT touching fire_count', () => {
    if (!workerPresent) return warnIfWorkerAbsent('job-cadence')
    const src = readFileSync(workerFile('scheduler.ts'), 'utf8')
    // The exact statement the 'missed' state exists for.
    const stale = "UPDATE jobs SET last_fired_at = ?, enabled = 0 WHERE id = ?"
    expect(src).toContain(stale)
    // …and it must NOT increment fire_count, or 'missed' would be unreachable
    // and the old `!enabled` reading would have been right after all.
    expect(stale).not.toContain('fire_count')
  })

  it('fire_count is incremented ONLY by the claim statement', () => {
    if (!workerPresent) return warnIfWorkerAbsent('job-cadence')
    const src = readFileSync(workerFile('scheduler.ts'), 'utf8')
    const writes = src.match(/fire_count\s*=\s*fire_count\s*\+\s*1/g) || []
    expect(writes.length).toBe(1)
    expect(src).toContain('fire_count = fire_count + 1 WHERE id = ? AND last_fired_at IS ?')
  })

  it('the catch-up window mirrored here matches the worker constant', () => {
    if (!workerPresent) return warnIfWorkerAbsent('job-cadence')
    const src = readFileSync(workerFile('scheduler.ts'), 'utf8')
    const m = src.match(/CATCH_UP_SECONDS\s*=\s*([^\n;]+)/)
    expect(m).toBeTruthy()
    // Multiplied literals ("24 * 60 * 60"), evaluated by hand rather than by
    // eval() so this stays a plain read of the source.
    const factors = m![1].trim().split('*').map((p) => Number(p.trim()))
    expect(factors.every((n) => Number.isFinite(n))).toBe(true)
    expect(factors.reduce((a, b) => a * b, 1)).toBe(JOB_CATCH_UP_SECONDS)
  })

  it("the panel no longer reads !enabled as a run", () => {
    const panel = readFileSync(join(__dirname, '..', 'components/chat/JobsPanel.tsx'), 'utf8')
    // Anchored to the CALL, not to the import line or the docblock: a file-wide
    // toContain would pass on a comment mentioning the function.
    expect(panel).toContain('oneShotPrefix(oneShotState(job))')
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('job.fire_count > 0 || !job.enabled')
  })

  it('the panel polls while jobs are live, and background-loads when it does', () => {
    const panel = readFileSync(join(__dirname, '..', 'components/chat/JobsPanel.tsx'), 'utf8')
    expect(panel).toContain('useJobsRefresh(jobs, () => load({ background: true }))')
    // The refresh BUTTON must stay a foreground load, or a person's click would
    // stop showing them the spinner and the error they need.
    expect(panel).toContain('onClick={() => load()}')
  })

  it('a background load touches NONE of the user-facing feedback', () => {
    // MUT17 survived the first suite: nothing asserted that the poll leaves the
    // spinner alone, and a poll that sets `loading` disables the refresh button
    // for the length of every request, once a minute, on a panel the user is
    // reading. Each of these four is a separate way for a silent refetch to
    // announce itself — spinner, error banner, error toast, and the 401 that
    // closes the whole overlay.
    const panel = readFileSync(join(__dirname, '..', 'components/chat/JobsPanel.tsx'), 'utf8')
    expect(panel).toContain('if (!background) setLoading(true)')
    expect(panel).toContain('if (loadReqRef.current === req && !background) setLoading(false)')
    expect(panel).toContain('if (loadReqRef.current !== req || background) return')
    // The 401 branch: a lapsed session must not yank the overlay out from under
    // a reader mid-poll.
    expect(panel).toMatch(/if \(d\.error\) \{\s*\n\s*if \(background\) return;/)
  })
})
