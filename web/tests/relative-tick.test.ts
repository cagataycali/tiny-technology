/**
 * v11 A3 — when does a "5m ago" stop being true?
 *
 * The interesting property is not "it ticks". It is that the wake-ups land on
 * relativeAgo's OWN bucket boundaries: one moment too early and the render
 * changes nothing, one too late and the page showed a stale age in between. So
 * most of this file asserts the schedule against relativeAgo itself rather than
 * against numbers I picked — a test that hardcodes 60_000 would keep passing if
 * the formatter's buckets changed underneath it.
 */
import { describe, it, expect } from 'vitest'
import {
  nextRelativeChangeMs,
  nextRelativeTickMs,
  relativeTickKey,
  parseRelativeTickKey,
  RELATIVE_TICK_MAX_MS,
} from '../lib/relative-tick'
import { relativeAgo } from '../lib/relative-time'

const NOW = 1_800_000_000_000 // ms, and a whole second
const secAgo = (n: number) => NOW / 1000 - n

describe('nextRelativeChangeMs', () => {
  it('waits for the exact second the label changes — no earlier, no later', () => {
    // THE load-bearing assertion, and it never names a number: whatever the
    // formatter's buckets are, the scheduled instant must be the first one whose
    // output differs, and the millisecond before it must still match.
    for (const age of [0, 1, 30, 59, 60, 61, 119, 3599, 3600, 3601, 86_399, 86_400, 100_000, 400_000]) {
      const ts = secAgo(age)
      const ms = nextRelativeChangeMs(ts, NOW)
      expect(ms, `age ${age}`).not.toBeNull()
      const before = relativeAgo(ts, '', NOW + (ms as number) - 1)
      const at = relativeAgo(ts, '', NOW + (ms as number))
      expect(relativeAgo(ts, '', NOW), `age ${age} start`).toBe(before)
      expect(at, `age ${age} boundary`).not.toBe(before)
    }
  })

  it('crosses "just now" → "1m ago" at the minute, not 30s into it', () => {
    // The concrete case the fixed-interval version got wrong in the visible
    // direction: a 30s poll can show "just now" for a row that is 1m10s old.
    expect(nextRelativeChangeMs(secAgo(10), NOW)).toBe(50_000)
    expect(relativeAgo(secAgo(10), '', NOW)).toBe('just now')
    expect(relativeAgo(secAgo(10), '', NOW + 50_000)).toBe('1m ago')
  })

  it('scales the wait with the bucket — an old row has nothing to say for hours', () => {
    // 90 minutes old → the next change is at 2h, i.e. half an hour away. This is
    // the whole reason the schedule is computed rather than fixed.
    expect(nextRelativeChangeMs(secAgo(90 * 60), NOW)).toBe(30 * 60 * 1000)
    // 30 hours old → next change at 48h: 18 hours away.
    expect(nextRelativeChangeMs(secAgo(30 * 3600), NOW)).toBe(18 * 3600 * 1000)
  })

  it('never returns 0 or a negative delay — including on a FRACTIONAL timestamp', () => {
    // A 0ms chain pins a core; a negative one fires immediately and then again
    // immediately. Reachable only with a fractional stamp: `d` is measured
    // against a floored clock but keeps the fraction, so bucketing it can land
    // the boundary a few hundred ms in the past. This exact pair does (-790ms
    // before the floor), and integer-only ages never would — so the mutation
    // that drops the floor survives a test suite that only uses whole seconds.
    expect(nextRelativeChangeMs(863_078_576.016, 863_080_736_806)).toBe(1)
    for (const age of [0, 59.999, 60, 3600, 86_400, -5, -100_000]) {
      const ms = nextRelativeChangeMs(secAgo(age), NOW)
      if (ms !== null) expect(ms, `age ${age}`).toBeGreaterThan(0)
    }
    // Swept: no fractional stamp anywhere in a day's range can produce ≤ 0.
    for (let i = 0; i < 2000; i++) {
      const frac = (i * 0.37) % 1
      for (const age of [0.5, 59.5, 3599.5, 86_399.5]) {
        const ms = nextRelativeChangeMs(secAgo(age) + frac, NOW + i)
        if (ms !== null) expect(ms, `age ${age} frac ${frac}`).toBeGreaterThan(0)
      }
    }
  })

  it('returns null for anything relativeAgo would not format', () => {
    // A row rendering the fallback has no label to keep true, so it must not arm
    // a timer. Number(null) and Number('') are 0 — finite, and would otherwise
    // schedule against 1970.
    for (const bad of [undefined, null, NaN, 0, -1, '', 'soon', {}, []]) {
      expect(nextRelativeChangeMs(bad, NOW), String(bad)).toBeNull()
      expect(relativeAgo(bad as never, '', NOW), String(bad)).toBe('')
    }
  })

  it('accepts a numeric string, because a worker payload is validated nowhere', () => {
    expect(nextRelativeChangeMs(String(secAgo(10)), NOW)).toBe(50_000)
  })
})

describe('nextRelativeTickMs', () => {
  it('waits for the SOONEST row, not the first or the newest', () => {
    // Deliberately unordered: whichever row crosses first decides.
    const stamps = [secAgo(90 * 60), secAgo(10), secAgo(30 * 3600)]
    expect(nextRelativeTickMs(stamps, NOW)).toBe(50_000)
    expect(nextRelativeTickMs([...stamps].reverse(), NOW)).toBe(50_000)
  })

  it('clamps a long wait, so a slept-through tab recovers within a minute', () => {
    // A reachable clamp doing real work — not the unreachable kind sitting above
    // a tighter bound. Without it, an old ledger arms an 18-hour timeout and any
    // suspend or wall-clock change goes uncorrected until it fires.
    expect(nextRelativeChangeMs(secAgo(30 * 3600), NOW)).toBe(18 * 3600 * 1000)
    expect(nextRelativeTickMs([secAgo(30 * 3600)], NOW)).toBe(RELATIVE_TICK_MAX_MS)
    expect(RELATIVE_TICK_MAX_MS).toBeLessThan(18 * 3600 * 1000)
  })

  it('does not clamp UP — a boundary 3s away is waited for, not a minute', () => {
    expect(nextRelativeTickMs([secAgo(57)], NOW)).toBe(3_000)
  })

  it('has nothing to schedule for an empty or unusable list', () => {
    // Both are the "arm no timer" case: an empty ledger, and a ledger whose rows
    // all render the fallback.
    expect(nextRelativeTickMs([], NOW)).toBeNull()
    expect(nextRelativeTickMs([0, NaN, -1] as number[], NOW)).toBeNull()
  })

  it('honours a caller-supplied ceiling, and never returns 0 from one', () => {
    expect(nextRelativeTickMs([secAgo(10)], NOW, 5_000)).toBe(5_000)
    expect(nextRelativeTickMs([secAgo(10)], NOW, 0)).toBe(1)
    expect(nextRelativeTickMs([secAgo(10)], NOW, -9)).toBe(1)
  })
})

describe('relativeTickKey', () => {
  it('is stable across the new array React builds on every render', () => {
    // THE reason this is a string. `history.map(e => e.created)` is a fresh array
    // each render, so an array dep would re-arm the effect on every render — and
    // an effect that re-arms constantly never reaches its own timeout.
    const a = [secAgo(10), secAgo(90 * 60)]
    expect(relativeTickKey(a)).toBe(relativeTickKey([...a]))
  })

  it('is order-insensitive and deduped', () => {
    const t = secAgo(10)
    expect(relativeTickKey([t, secAgo(60)])).toBe(relativeTickKey([secAgo(60), t]))
    // A hundred rows in the same minute cross one boundary together.
    expect(relativeTickKey([t, t, t])).toBe(String(t))
  })

  it('drops unusable stamps entirely, so a bad row cannot arm a timer', () => {
    expect(relativeTickKey([undefined, null, 0, NaN, ''])).toBe('')
    expect(relativeTickKey([])).toBe('')
  })

  it('CHANGES when a genuinely new timestamp arrives', () => {
    // The other half of stability: a refetch that adds a row must re-arm, or the
    // new row's first boundary is missed.
    const before = relativeTickKey([secAgo(90 * 60)])
    const after = relativeTickKey([secAgo(90 * 60), secAgo(1)])
    expect(after).not.toBe(before)
  })

  it('round-trips through parseRelativeTickKey', () => {
    // The effect parses the stamps back out of the dep it fired on, so the
    // closure can never disagree with what triggered it.
    const stamps = [secAgo(10), secAgo(3600)]
    const key = relativeTickKey(stamps)
    expect(parseRelativeTickKey(key).sort()).toEqual([...stamps].sort())
    expect(parseRelativeTickKey('')).toEqual([])
    // And a parsed key schedules identically to the raw stamps.
    expect(nextRelativeTickMs(parseRelativeTickKey(key), NOW))
      .toBe(nextRelativeTickMs(stamps, NOW))
  })
})
