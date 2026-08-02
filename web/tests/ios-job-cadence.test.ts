/**
 * The Jobs panel's schedule line, pinned across the three languages that have to
 * agree about it.
 *
 * 🔴 iOS rendered `ran Jul 20, 09:00 · fired 0×` — a row contradicting itself
 * about whether a reminder happened, with the false half the one a person acts
 * on. The cause was `let done = fired > 0 || !enabled`, reading a cleared
 * `enabled` flag as proof of a run when the scheduler ALSO clears it to abandon
 * a job it can no longer catch up with (`fire_count` untouched).
 *
 * The web fixed this and extracted `lib/chat/job-cadence.ts`; iOS kept the old
 * guess for the whole time in between. Nothing failed when the two disagreed,
 * because the only thing tying them together was a comment saying "same cadence
 * phrasing as the web's JobsPanel" — so these tests are the tie.
 *
 * ⚠️ Every pin here reads Swift/TS SOURCE with comments stripped: the files
 * quote the buggy expression in their own prose to explain it, so a naive
 * substring search finds `fired > 0 || !enabled` in exactly the file that no
 * longer does it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  JOB_CATCH_UP_SECONDS,
  oneShotState,
  oneShotPrefix,
} from '../lib/chat/job-cadence'

const ROOT = join(__dirname, '..')
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const SCHEDULER = join(ROOT, 'worker/src/scheduler.ts')
const WEB_MODULE = join(ROOT, 'lib/chat/job-cadence.ts')

/**
 * Source with comments removed. Line comments (`//`, both languages) and block
 * comments (`/* … *\/`, incl. `/** … *\/` doc blocks). Deliberately crude — it
 * only has to stop prose from satisfying a code pin, and every needle below is
 * code.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '')
}

/** The body of a Swift declaration, by brace matching from its signature. */
function braced(src: string, anchor: string): string {
  const at = src.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${anchor}`)
}

const panels = () => code(readFileSync(PANELS, 'utf8'))

describe('the rule that reads a run', () => {
  it('the guess that invented history is gone from iOS', () => {
    const src = panels()
    // The exact expression that shipped. It is quoted in two doc comments in
    // this same file, which is why `code()` runs first.
    expect(src, 'the cadence line is guessing from `enabled` again')
      .not.toMatch(/fired\s*>\s*0\s*\|\|\s*!\s*enabled/)
    expect(src).not.toMatch(/done\s*\?\s*"ran"\s*:\s*"once at"/)
  })

  it('fire_count is the only field iOS reads as a run', () => {
    const state = braced(panels(), 'static func oneShotState(')
    // The first branch, and the whole point: a recorded run outranks every flag.
    expect(state).toMatch(/if fired > 0 \{ return \.ran \}/)
    // `enabled` may only ever produce `.missed` — never `.ran`.
    expect(state).toMatch(/if !enabled \{ return \.missed \}/)
    expect(state.slice(state.indexOf('!enabled'))).not.toMatch(/return \.ran/)
  })

  it('iOS words the abandoned state as an outcome, not a flag', () => {
    const prefix = braced(panels(), 'static func prefix(')
    expect(prefix).toMatch(/case \.missed: return "didn't run"/)
    expect(prefix).toMatch(/case \.due: return "due"/)
    expect(prefix).toMatch(/case \.pending: return "once at"/)
    expect(prefix).toMatch(/case \.unknown: return nil/)
  })

  it('the same wording as the web, so the two surfaces cannot drift apart', () => {
    const prefix = braced(panels(), 'static func prefix(')
    // Read the web's answers rather than restating them: if someone rewords
    // `oneShotPrefix`, this fails until iOS is reworded too.
    for (const [state, word] of [
      ['ran', oneShotPrefix('ran')],
      ['missed', oneShotPrefix('missed')],
      ['due', oneShotPrefix('due')],
      ['pending', oneShotPrefix('pending')],
    ] as const) {
      expect(prefix, `iOS and the web disagree about \`${state}\``)
        .toContain(`case .${state}: return "${word}"`)
    }
  })
})

describe('the catch-up window: one number, three languages', () => {
  it('the worker, the web module and iOS all still say 24h', () => {
    // The worker is the authority — the `.missed` rule is only true while the
    // scheduler really does abandon a job past this window.
    const sched = code(readFileSync(SCHEDULER, 'utf8'))
    const m = sched.match(/CATCH_UP_SECONDS\s*=\s*([^;\n]+)/)
    expect(m, 'the worker no longer defines CATCH_UP_SECONDS').not.toBeNull()
    // eslint-disable-next-line no-eval
    const workerValue = eval(m![1]) as number
    expect(workerValue).toBe(24 * 60 * 60)

    expect(JOB_CATCH_UP_SECONDS, 'the web module drifted from the worker').toBe(workerValue)

    const ios = panels().match(/static let catchUpSeconds: Double = ([^\n]+)/)
    expect(ios, 'iOS no longer defines catchUpSeconds').not.toBeNull()
    // eslint-disable-next-line no-eval
    expect(eval(ios![1]), 'iOS drifted from the worker').toBe(workerValue)
  })

  it('iOS uses the scheduler\'s own comparison, strictly greater', () => {
    const state = braced(panels(), 'static func oneShotState(')
    // `>` not `>=`: exactly-at-the-window is still catchable, which is what
    // `now - due > CATCH_UP_SECONDS` says in scheduler.ts.
    expect(state).toMatch(/now - due > catchUpSeconds \? \.missed : \.due/)
    // And the web agrees at the boundary.
    const nowSec = 1_785_412_800
    expect(oneShotState({ run_at: nowSec - JOB_CATCH_UP_SECONDS, enabled: 1, fire_count: 0 }, nowSec))
      .toBe('due')
    expect(oneShotState({ run_at: nowSec - JOB_CATCH_UP_SECONDS - 1, enabled: 1, fire_count: 0 }, nowSec))
      .toBe('missed')
  })
})

describe('the 1970 guard', () => {
  it('iOS refuses a non-positive timestamp instead of dating a job to 1970', () => {
    const guard = braced(panels(), 'static func usableSec(')
    expect(guard).toMatch(/v\.isFinite, v > 0/)
    // Both places that turn a payload number into a Date go through it.
    const src = panels()
    expect(src, 'the cadence line formats run_at without the guard')
      .toMatch(/let at = JobCadence\.usableSec\(runAt\)/)
    expect(src, 'last_fired_at is formatted without the guard')
      .toMatch(/JobCadence\.usableSec\(\(j\["last_fired_at"\] as\? NSNumber\)\?\.doubleValue\)/)
  })
})

describe('last_fired_at, the field the scheduler overwrites when it gives up', () => {
  it('iOS never prints "last" for a job that never fired', () => {
    const word = braced(panels(), 'static func lastFiredWord(')
    expect(word).toMatch(/if fired > 0 \{ return "last" \}/)
    expect(word).toMatch(/if state == \.missed \{ return "switched off" \}/)
    expect(word).toMatch(/return nil/)
    // "last" must be unreachable without a fire behind it.
    expect(word.slice(word.indexOf('if state =='))).not.toContain('"last"')
  })

  it('the row renders that word, not any last_fired_at it happens to have', () => {
    const src = panels()
    expect(src, 'the row prints a bare "last <when>" again')
      .not.toMatch(/Text\("· last \\\(/)
    expect(src).toMatch(/if let lf = j\.lastFiredLabel/)
    // The model no longer even carries a raw Date for the view to be tempted by.
    expect(braced(src, 'struct JobRow: Identifiable')).not.toMatch(/lastFired: Date\?/)
  })

  it('the worker really does write that field when abandoning a job', () => {
    // The premise. If this stops being true, "switched off" is the wrong word
    // and this whole module needs re-reading — so it is asserted, not assumed.
    const sched = code(readFileSync(SCHEDULER, 'utf8'))
    expect(sched, 'the skip-stale branch no longer sets last_fired_at + enabled = 0')
      .toMatch(/UPDATE jobs SET last_fired_at = \?, enabled = 0 WHERE id = \?/)
    // …and does NOT touch fire_count while doing it, which is what makes
    // fire_count trustworthy as the only record of a run.
    const stale = sched.slice(sched.indexOf('skip-stale'))
    const upd = stale.match(/UPDATE jobs SET last_fired_at = \?, enabled = 0[^"]*/)
    expect(upd?.[0]).not.toContain('fire_count')
  })
})

describe('daily@HH:MM speaks the reader\'s clock', () => {
  it('iOS no longer labels a UTC time and leaves the reader to convert', () => {
    const src = panels()
    expect(src, 'the raw UTC label is back')
      .not.toMatch(/"daily at \\\(s\.dropFirst\(6\)\) UTC"/)
    expect(src).toMatch(/JobCadence\.dailyLocal\(s, now:/)
    const daily = braced(src, 'static func dailyLocal(')
    // Parsed as UTC, formatted in the output zone — that is the conversion.
    expect(daily).toMatch(/TimeZone\(identifier: "UTC"\)!/)
    expect(daily).toMatch(/fmt\.timeZone = output/)
  })

  it('an unrecognised schedule is passed through rather than reworded', () => {
    const cad = braced(panels(), 'static func cadence(')
    // `dailyLocal` returning nil has to fall through to the raw string, not to
    // a "?" — the DSL is the only thing the app knows about that job.
    expect(cad).toMatch(/if let local = JobCadence\.dailyLocal\([\s\S]*?\n\s*\}\n\s*return s/)
  })
})

describe('the colour stops asserting success', () => {
  it('the cadence line is no longer unconditionally green', () => {
    const src = panels()
    expect(src, 'the cadence line is hard-coded green again')
      .not.toMatch(/Text\(j\.cadence\)[\s\S]{0,80}?foregroundStyle\(\.green\)/)
    expect(src).toMatch(/foregroundStyle\(JobsView\.tint\(j\.tone\)\)/)
  })

  it('only live states get green, and a missed job is warned about', () => {
    const tint = braced(panels(), 'static func tint(')
    expect(tint).toMatch(/case \.live: return \.green/)
    expect(tint).toMatch(/case \.warn: return \.orange/)
    expect(tint).toMatch(/case \.done, \.muted: return \.secondary/)
    const tone = braced(panels(), 'static func tone(')
    // A paused recurring job is muted; an enabled one stays green (the common
    // case, and the reason tone can't just be derived from the one-shot state).
    expect(tone).toMatch(/return enabled \? \.live : \.muted/)
    expect(tone).toMatch(/case \.missed: return \.warn/)
  })
})
