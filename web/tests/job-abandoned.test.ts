// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { KIND_ICONS, EMITTED_KINDS, iconFor } from '../lib/chat/event-icons'

warnIfWorkerAbsent('job-abandoned')

/**
 * ⛔ The one job outcome that said nothing.
 *
 * Every other end-state of a scheduled job speaks: a success emits `job_result`
 * and pushes ✅, a failure emits `job_error` and pushes ❌. The 'skip-stale'
 * branch — a one-shot due more than CATCH_UP_SECONDS ago — just wrote
 * `enabled = 0` and moved on. So the ONLY outcome that means *this will never
 * happen*, the only one the user has to act on, was the only silent one.
 *
 * It does not need an outage. `JobsCreateCall` validates `runAt` as finite and
 * nothing more, so an agent that computes a timestamp from a misparsed date
 * creates a one-shot already in the past; `/jobs` answers `{ok:true}`, the next
 * tick abandons it, and nothing anywhere says so. (The DISPLAY half of this was
 * fixed separately in lib/chat/job-cadence.ts — but that only helps a user who
 * goes and looks at the panel.)
 *
 * What these tests pin, in order of how badly each would hurt:
 *   1. the sentence names the DUE time, not the moment of abandonment — the
 *      write that disables the job overwrites `last_fired_at`, so afterwards the
 *      row cannot say which run was lost;
 *   2. recurring jobs are NOT announced (they fire again; a push per missed slot
 *      after an outage would be a flood);
 *   3. the notification is strictly DOWNSTREAM of the disabling write — a
 *      notification rail having a bad day must not leave the job enabled and
 *      rescanned forever;
 *   4. `job_missed` gets its OWN glyph on every surface. `job` is a real prefix
 *      of it, so the prefix matchers would have drawn it as ⏰ — the glyph of a
 *      job that RAN. Same shape as c29's checkmark, one kind later.
 */

let jobAbandonedText: any
let JOB_ABANDONED_KIND: string
let CATCH_UP_SECONDS: number
let src = ''

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('scheduler.ts') /* @vite-ignore */)
  jobAbandonedText = mod.jobAbandonedText
  JOB_ABANDONED_KIND = mod.JOB_ABANDONED_KIND
  CATCH_UP_SECONDS = mod.CATCH_UP_SECONDS
  src = readFileSync(workerFile('scheduler.ts'), 'utf8')
})

const DUE = 1_753_000_000 // a fixed unix time; the message must not read the clock

describe.runIf(present)('jobAbandonedText', () => {
  it('names the time the run was DUE, not the moment it was given up on', () => {
    const t = jobAbandonedText({ name: 'water the plants', once: 1 }, DUE)
    const dueIso = new Date(DUE * 1000).toISOString().replace('T', ' ').slice(0, 16)
    expect(t.body).toContain(dueIso)
    // The abandonment happens ~now; the message must not quote that instead.
    const nowIso = new Date().toISOString().slice(0, 10)
    if (!dueIso.startsWith(nowIso)) expect(t.body).not.toContain(nowIso)
  })

  it('says the job is OFF and that restarting it is the user\'s move', () => {
    const t = jobAbandonedText({ name: 'x', once: 1 }, DUE)
    // A notice about something that will never happen is only useful if it says
    // what to do about it.
    expect(t.body.toLowerCase()).toMatch(/switched off|disabled|turned off/)
    expect(t.body.toLowerCase()).toMatch(/schedule it again|re-?schedule/)
  })

  it('never claims the job ran', () => {
    const t = jobAbandonedText({ name: 'nightly digest', once: 1 }, DUE)
    // The web panel's own bug (job-cadence.ts) was rendering this state as
    // "ran" — the notification must not repeat it in prose.
    const all = `${t.title} ${t.body} ${t.detail}`.toLowerCase()
    expect(all).not.toMatch(/completed|finished|succeeded/)
    // Every occurrence of "ran" must be negated — "never ran" is the point, a
    // bare "ran" would be the panel's old lie in prose form.
    const ran = /\bran\b/g
    let m: RegExpExecArray | null
    while ((m = ran.exec(all)) !== null) {
      expect(all.slice(Math.max(0, m.index - 6), m.index)).toContain('never')
    }
    expect(t.title).toContain('never ran')
  })

  it('quotes the real overdue threshold, not a hardcoded number', () => {
    const t = jobAbandonedText({ name: 'x', once: 1 }, DUE)
    expect(t.body).toContain(`${Math.floor(CATCH_UP_SECONDS / 3600)}h`)
  })

  it('stays silent for a RECURRING job — it will come round again', () => {
    // The flood guard. An outage marks every recurring job stale on the next
    // tick; each one still fires on its normal cadence, so nothing was lost.
    expect(jabRecurring()).toBeNull()
    function jabRecurring() { return jobAbandonedText({ name: 'every 5m', once: 0 }, DUE) }
    expect(jobAbandonedText({ name: 'every 5m', once: null }, DUE)).toBeNull()
    expect(jobAbandonedText({ name: 'every 5m' }, DUE)).toBeNull()
  })

  it('survives a nameless job and a missing due time', () => {
    // The row comes from D1; a null name must not render "undefined never ran".
    const t = jobAbandonedText({ once: 1 }, 0)
    expect(t.title).not.toContain('undefined')
    expect(t.title).not.toContain('null')
    expect(t.body).toBeTruthy()
  })

  it('clamps a hostile job name', () => {
    const t = jobAbandonedText({ name: 'z'.repeat(500), once: 1 }, DUE)
    expect(t.title.length).toBeLessThan(120)
  })
})

/**
 * The skip-stale branch with COMMENTS REMOVED.
 *
 * Every ordering assertion below has to run on code, not prose. The branch is
 * documented with a paragraph explaining *why* nextDue() must be read before the
 * UPDATE — and that paragraph contains the literal `nextDue(`. A first draft of
 * these tests searched the raw source, so it happily found the explanation and
 * passed after I mutated the actual call away. A test that a comment can satisfy
 * asserts nothing about the program.
 */
function staleBranchCode(): string {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  const start = stripped.indexOf("if (decision === 'skip-stale')")
  expect(start).toBeGreaterThan(-1)
  const branch = stripped.slice(start)
  return branch.slice(0, branch.indexOf('continue;'))
}

describe.runIf(present)('the tick wires it up safely', () => {
  it('reads the due time BEFORE the write that overwrites last_fired_at', () => {
    // The ordering IS the correctness: nextDue() takes last_fired_at as its
    // input, and the skip-stale UPDATE replaces it with `now`.
    const body = staleBranchCode()
    const dueRead = body.indexOf('nextDue(')
    const write = body.indexOf('UPDATE jobs SET last_fired_at')
    expect(dueRead).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(-1)
    expect(dueRead).toBeLessThan(write)
  })

  it('notifies strictly AFTER the disabling write', () => {
    // Rail isolation, the c28 rule: the bookkeeping is what stops the tick
    // rescanning this row forever, so it must not be behind a notification.
    const body = staleBranchCode()
    const write = body.indexOf('UPDATE jobs SET last_fired_at = ?, enabled = 0')
    const notify = body.indexOf('jobAbandonedText(')
    expect(write).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(-1)
    expect(write).toBeLessThan(notify)
    // …and both pushes are downstream of it too, not just the text builder.
    expect(body.indexOf('sendPushToUser')).toBeGreaterThan(write)
    expect(body.indexOf('emitEvent(')).toBeGreaterThan(write)
  })

  it('emits the kind and pushes, both keyed to the job', () => {
    const body = staleBranchCode()
    expect(body).toContain('JOB_ABANDONED_KIND')
    expect(body).toContain('sendPushToUser')
  })
})

describe('every surface styles job_missed distinctly', () => {
  const surfaces: Array<[string, string]> = [
    ['ios/Tiny/Sources/Activity.swift', 'job_missed'],
    ['android/app/src/main/java/technology/tiny/app/ui/Activity.kt', 'job_missed'],
    ['lib/chat/prompt.ts', 'job_missed'],
    ['tiny-tech/src/tray.ts', 'job_missed'],
    ['tiny-tech/menubar/Sources/TinyMenuKit/TrayProtocol.swift', 'job_missed'],
    ['tiny-tech/menubar/Sources/TinyMenuKit/MenuModel.swift', 'job_missed'],
  ]

  it.each(surfaces)('%s knows the kind', (file, needle) => {
    expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).toContain(needle)
  })

  it('is on the web roster and has its own glyph', () => {
    expect(EMITTED_KINDS).toContain('job_missed')
    expect(KIND_ICONS.job_missed).toBeTruthy()
  })

  it('does NOT inherit the glyph of a job that ran', () => {
    // `job` is a prefix of `job_missed`, and the matcher used to iterate in
    // literal declaration order — so the more specific key only wins because
    // iconFor sorts by specificity. This is the assertion that pins that.
    expect(iconFor('job_missed')).not.toBe(iconFor('job_result'))
    expect(iconFor('job_missed')).toBe(KIND_ICONS.job_missed)
    // And the ordinary kinds still collapse as before.
    expect(iconFor('job_result')).toBe(iconFor('job_error'))
    expect(iconFor('nonsense')).toBe('⚡')
  })

  it('the worker kind and the roster entry are the same string', () => {
    if (!present) return
    expect(EMITTED_KINDS).toContain(JOB_ABANDONED_KIND)
  })
})
