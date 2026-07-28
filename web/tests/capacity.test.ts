/**
 * lib/chat/capacity — the denominator, and the population it counts.
 *
 * Backlog v10 item A3 said `Control.tsx:375` renders `{myTools.length}/20` and
 * to "verify 20 is the worker's real cap". It isn't: the worker's cap is
 * `MAX_TOOLS = 10000` and its list query has no LIMIT. So the numerator was
 * right and the denominator was invented.
 *
 * Item A2 said `JobsPanel` header shows a bare `{jobs.length}`. The list is
 * genuinely uncapped (verified: `SELECT … FROM jobs WHERE user_id = ? ORDER BY
 * created DESC`, no LIMIT), so that count is honest — but there IS a cap of 10
 * the panel never mentioned, and it counts `enabled = 1` ONLY, while the list
 * includes the one-shots that flipped to `enabled = 0` when they fired. That
 * mismatch is what these tests mostly pin: pairing a count with a cap is only
 * truthful when both count the same rows.
 */
import { describe, it, expect } from 'vitest'
import {
  JOB_ACTIVE_CAP,
  TOOL_MAX,
  RUNS_PAGE,
  activeJobCount,
  jobsHeader,
  jobsCapNote,
  toolBoxBadge,
  runsMissingNote,
} from '../lib/chat/capacity'

/** An active recurring job. */
const active = (n = 1) => Array.from({ length: n }, () => ({ enabled: 1, fire_count: 3 }))
/** A spent one-shot: fired, then `enabled = 0` (scheduler.ts:117/172). */
const spent = (n = 1) => Array.from({ length: n }, () => ({ enabled: 0, fire_count: 1 }))

describe('the caps are the worker’s real numbers', () => {
  it('mirrors MAX_JOBS_PER_USER and MAX_TOOLS, not invented values', () => {
    // If either moves worker-side, this test is the tripwire. 20 was never
    // either of them — that is the whole finding.
    expect(JOB_ACTIVE_CAP).toBe(10)
    expect(TOOL_MAX).toBe(10000)
    expect(TOOL_MAX).not.toBe(20)
    expect(RUNS_PAGE).toBe(30)
  })
})

describe('activeJobCount — the cap’s population, not the list’s', () => {
  it('counts only enabled rows', () => {
    expect(activeJobCount([...active(3), ...spent(9)])).toBe(3)
  })

  it('accepts the boolean form too — the proxy passes rows raw', () => {
    expect(activeJobCount([{ enabled: true }, { enabled: false }])).toBe(1)
  })

  it('does NOT count a truthy non-1 flag — "0" is a truthy string', () => {
    // The D1 column is an integer; a JSON round-trip that quotes it must not
    // turn a disabled job into an active one and push someone over the limit.
    expect(activeJobCount([{ enabled: '0' as any }, { enabled: '1' as any }])).toBe(0)
  })

  it('treats a missing or null flag as inactive, showing MORE room not less', () => {
    // Over-counting tells a user to delete jobs they don't need to; the 429
    // corrects under-counting. Only one of those wastes their time.
    expect(activeJobCount([{}, { enabled: null }, { enabled: undefined }])).toBe(0)
  })

  it('survives a non-array and holey input', () => {
    expect(activeJobCount(null as any)).toBe(0)
    expect(activeJobCount([null as any, undefined as any, { enabled: 1 }])).toBe(1)
  })
})

describe('jobsHeader', () => {
  it('is a plain count when nowhere near the cap', () => {
    // A permanent "3/10" reads as though the other 7 slots are a feature.
    expect(jobsHeader(active(3))).toBe('Scheduled jobs · 3')
  })

  it('NEVER shows total/cap — the number in the list is not the number capped', () => {
    // THE FINDING. 3 active + 9 spent one-shots would render "12/10": over a
    // limit the user is nowhere near, on a panel whose only action is Delete.
    const jobs = [...active(3), ...spent(9)]
    const h = jobsHeader(jobs)
    expect(h).toBe('Scheduled jobs · 12')
    expect(h).not.toContain('12/10')
    expect(h).not.toContain('/10')
  })

  it('reveals the cap in the last two slots, labelled with its population', () => {
    expect(jobsHeader(active(8))).toBe('Scheduled jobs · 8 · 8/10 active')
    expect(jobsHeader(active(9))).toBe('Scheduled jobs · 9 · 9/10 active')
  })

  it('says the limit is reached at the cap', () => {
    expect(jobsHeader(active(10))).toBe('Scheduled jobs · 10 · 10/10 active — limit reached')
  })

  it('still keeps the two numbers apart at the cap', () => {
    // 10 active + 5 spent: the total is 15, the cap-relevant number is 10.
    const h = jobsHeader([...active(10), ...spent(5)])
    expect(h).toContain('· 15')
    expect(h).toContain('10/10 active')
  })

  it('an over-cap account (a worker-side change, or a stale row) still reads sanely', () => {
    expect(jobsHeader(active(12))).toContain('12/10 active — limit reached')
  })

  it('handles the empty and malformed cases', () => {
    expect(jobsHeader([])).toBe('Scheduled jobs · 0')
    expect(jobsHeader(null as any)).toBe('Scheduled jobs · 0')
  })
})

describe('jobsCapNote — the way out depends on which rows are full', () => {
  it('is absent below the cap', () => {
    expect(jobsCapNote(active(9))).toBeNull()
    expect(jobsCapNote([...active(2), ...spent(30)])).toBeNull()
  })

  it('names the limit and the action at the cap', () => {
    const note = jobsCapNote(active(10))!
    expect(note).toContain('limit of 10 active jobs')
    expect(note).toContain('Delete an active job')
  })

  it('warns that deleting a finished job frees nothing, when finished jobs exist', () => {
    // Without this, the rows that LOOK most disposable are exactly the ones
    // that don't count — a user deletes three and is still blocked.
    const note = jobsCapNote([...active(10), ...spent(4)])!
    expect(note).toContain("won't free a slot")
    expect(note).toContain('only the 10 active jobs count')
  })

  it('omits that sentence when every job is active — nothing to mistake', () => {
    expect(jobsCapNote(active(10))).not.toContain("won't free a slot")
  })
})

describe('toolBoxBadge — no fabricated denominator', () => {
  it('is a bare count, never N/20', () => {
    expect(toolBoxBadge(7)).toBe('7 tools')
    expect(toolBoxBadge(7)).not.toContain('/')
    expect(toolBoxBadge(20)).toBe('20 tools')
    // The old badge said "20/20 — full" here. Nothing is full at 20.
    expect(toolBoxBadge(20)).not.toContain('20/20')
  })

  it('singularizes', () => {
    expect(toolBoxBadge(1)).toBe('1 tool')
  })

  it('renders zero as zero — an empty tool box is a real state', () => {
    expect(toolBoxBadge(0)).toBe('0 tools')
  })

  it('is null while not loaded, so a pending fetch never reads as empty', () => {
    expect(toolBoxBadge(null)).toBeNull()
    expect(toolBoxBadge(undefined)).toBeNull()
  })

  it('refuses a non-number and a negative rather than printing NaN', () => {
    expect(toolBoxBadge(Number.NaN)).toBeNull()
    expect(toolBoxBadge('12' as any)).toBeNull()
    expect(toolBoxBadge(-1)).toBeNull()
  })
})

describe('runsMissingNote — the absence with no number on it', () => {
  it('explains an empty history when the runs page was FULL', () => {
    // 30 rows is one global page across every job the user has; a job whose runs
    // fell off the end shows "Last fired <date>" above nothing.
    const note = runsMissingNote({ fire_count: 12, enabled: 1 }, 0, RUNS_PAGE)!
    expect(note).toContain('Ran 12×')
    expect(note).toContain('latest 30')
  })

  it('is silent when the page was short — then we really did receive everything', () => {
    // A short page means the per-job server-side pruning is the reason, not
    // crowding, and claiming otherwise would be a guess.
    expect(runsMissingNote({ fire_count: 12 }, 0, 12)).toBeNull()
  })

  it('is silent when runs ARE shown', () => {
    expect(runsMissingNote({ fire_count: 12 }, 3, RUNS_PAGE)).toBeNull()
  })

  it('is silent for a job that has never fired — nothing needs explaining', () => {
    expect(runsMissingNote({ fire_count: 0 }, 0, RUNS_PAGE)).toBeNull()
    expect(runsMissingNote({}, 0, RUNS_PAGE)).toBeNull()
  })

  it('is silent on a malformed fire_count rather than printing "Ran NaN×"', () => {
    expect(runsMissingNote({ fire_count: 'lots' as any }, 0, RUNS_PAGE)).toBeNull()
    expect(runsMissingNote({ fire_count: null }, 0, RUNS_PAGE)).toBeNull()
  })

  it('fires at exactly a full page, not only beyond it', () => {
    // Off-by-one guard: LIMIT 30 returning 30 IS the truncated case.
    expect(runsMissingNote({ fire_count: 1 }, 0, 30)).not.toBeNull()
    expect(runsMissingNote({ fire_count: 1 }, 0, 29)).toBeNull()
  })
})
