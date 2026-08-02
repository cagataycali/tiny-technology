// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JOB_CATCH_UP_SECONDS, oneShotState, oneShotPrefix } from '../lib/chat/job-cadence'

/**
 * ⏰ The Jobs sheet's schedule line, pinned across the FOUR languages that have to
 * agree about it.
 *
 * 🔴 Android rendered `ran Jan 1, 09:00 · fired 0×` — one row contradicting
 * itself about whether a reminder happened, with the false half the one a person
 * acts on. The cause, `Jobs.kt`'s `fireCount > 0 || !enabled`, read a cleared
 * `enabled` flag as proof of a run; the scheduler ALSO clears it to abandon a
 * one-shot it can no longer catch up with, leaving `fire_count` untouched.
 *
 * The web fixed this and extracted `lib/chat/job-cadence.ts`. iOS ported it as
 * `JobCadence` (`34f43165`). Android kept the original guess the whole time, and
 * **its own unit test asserted the wrong answer** — `JobsFormatTest` demanded
 * `"ran"` for a disabled zero-fire job, with a comment calling it "spent". A test
 * that pins a defect is worse than no test: it makes the fix look like the
 * regression. That assertion is now inverted, with the old expectation named.
 *
 * ⚠️ Every source pin here strips comments first. All four files quote the buggy
 * expression in their own prose to explain it, so a naive substring search finds
 * `fireCount > 0 || !enabled` in exactly the file that no longer does it.
 *
 * `JobCadenceTest` (Kotlin, 20) owns the rule's behaviour — the boundary, the
 * ordering, the words. This suite owns what a JVM test cannot see: that the sheet
 * WIRES the rule to the string it renders, that the tone reaches a colour, and
 * that the four implementations still say the same thing.
 */

const ROOT = process.cwd()
const JOBS = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Jobs.kt')
const PANELS_SWIFT = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const SCHEDULER = join(ROOT, 'worker/src/scheduler.ts')
const WEB_MODULE = join(ROOT, 'lib/chat/job-cadence.ts')
const KT_TEST = join(ROOT, 'android/app/src/test/java/technology/tiny/app/ui/JobsFormatTest.kt')

/** Source with line and block comments removed — prose must not satisfy a code pin. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '')

/** The `{ … }` block opening at or after `at`, brace-matched. */
function braced(source: string, at: number): string {
  const open = source.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open, i)
}

/** A block, with its anchor ASSERTED — an unfound anchor makes every `.not` pin vacuous. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('the guess that invented history', () => {
  it('is gone from Android', () => {
    // 🔴 THE DEFECT in one pin. `!enabled` in a sentence about whether a job ran.
    const kt = code(JOBS)
    expect(kt, 'the cadence line reads the enabled flag as a run again')
      .not.toMatch(/fireCount\s*>\s*0\s*\|\|\s*!enabled/)
    expect(kt, 'nothing derives a done/ran boolean from the flag')
      .not.toMatch(/!enabled\s*\)\s*"ran"/)
  })

  it('and its own test no longer demands the wrong answer', () => {
    // ⚠️ The trap that made this cycle different from every other port: the
    // defect was PINNED. Porting the fix without touching the test turns a
    // correct implementation into a red suite, and the obvious reading of that
    // red ("my port is wrong") is the expensive one.
    const t = code(KT_TEST)
    expect(t, 'the old assertion is back — a disabled zero-fire job called "ran"')
      .not.toMatch(/assertEquals\("ran [^"]*", cadence\(null, 1_704_099_600L, 0, false/)
    expect(t, 'the inverted assertion is missing — nothing pins the fixed phrasing here')
      .toMatch(/assertEquals\("didn't run [^"]*", cadence\(null, 1_704_099_600L, 0, false/)
  })

  it('fire_count is the only field Android reads as a run', () => {
    // The rule's first branch, and the reason the whole object exists.
    const rule = body(code(JOBS), 'fun oneShotState(')
    expect(rule, 'a recorded fire is no longer what decides "ran"')
      .toMatch(/if \(fired > 0\) return OneShot\.RAN/)
    // ⚠️ Ordered FIRST. `enabled` is checked below it on purpose: the post-fire
    // disable is a separate statement, so `enabled = 1, fire_count = 1` exists
    // and means the job ran. Reversed, a fired-but-still-enabled job reads as
    // pending forever.
    expect(rule.indexOf('fired > 0'), 'the flag is consulted before the run record')
      .toBeLessThan(rule.indexOf('!enabled'))
  })
})

describe('the catch-up window: one number, four languages', () => {
  it('the worker, the web module, iOS and Android all still say 24h', () => {
    // Nothing but this test makes them agree. Each is written in its own
    // language's idiom, so the pin is the VALUE, computed the same way.
    expect(JOB_CATCH_UP_SECONDS, 'the web module changed its window').toBe(24 * 60 * 60)
    expect(code(SCHEDULER), 'the worker changed the window the rule mirrors')
      .toMatch(/CATCH_UP_SECONDS\s*=\s*24\s*\*\s*60\s*\*\s*60/)
    expect(code(PANELS_SWIFT), 'iOS drifted from the worker')
      .toMatch(/catchUpSeconds:\s*Double\s*=\s*24\s*\*\s*60\s*\*\s*60/)
    expect(code(JOBS), 'Android drifted from the worker')
      .toMatch(/CATCH_UP_SECONDS\s*=\s*24\s*\*\s*60\s*\*\s*60L/)
  })

  it('Android uses the scheduler\'s own comparison, strictly greater', () => {
    // ⚠️ `>=` declares a job dead one tick before the worker would have run it.
    // The worker's test is `now - due > CATCH_UP_SECONDS`; this is the same.
    const rule = body(code(JOBS), 'fun oneShotState(')
    expect(rule, 'the boundary comparison moved — a due job now reads as missed')
      .toMatch(/nowSec - due > CATCH_UP_SECONDS/)
    expect(code(SCHEDULER), 're-anchor: the worker no longer compares this way')
      .toMatch(/now - due > CATCH_UP_SECONDS/)
  })

  it('and the four agree on what the boundary MEANS, not just on the number', () => {
    // Executed, not grepped: the web module is the reference implementation, so
    // its answers are the contract the Kotlin unit tests assert independently.
    const now = 1_704_099_600
    expect(oneShotState({ run_at: now - JOB_CATCH_UP_SECONDS, enabled: 1, fire_count: 0 }, now))
      .toBe('due')
    expect(oneShotState({ run_at: now - JOB_CATCH_UP_SECONDS - 1, enabled: 1, fire_count: 0 }, now))
      .toBe('missed')
    // The defect itself, in the reference implementation.
    expect(oneShotState({ run_at: now - 3600, enabled: 0, fire_count: 0 }, now)).toBe('missed')
  })
})

describe('the words', () => {
  it('Android words the abandoned state as an outcome, not as a flag', () => {
    const prefix = body(code(JOBS), 'fun prefix(state: OneShot)')
    expect(prefix, 'the missed state lost its wording')
      .toMatch(/OneShot\.MISSED\s*->\s*"didn't run"/)
    // Not "once at" for a time that has passed.
    expect(prefix, 'a due job is labelled with a future tense again')
      .toMatch(/OneShot\.DUE\s*->\s*"due"/)
  })

  it('the same wording as the web, so the surfaces cannot drift apart', () => {
    // The reference implementation's strings, asserted against Android's source
    // rather than re-typed — a reworded web module fails here.
    const prefix = body(code(JOBS), 'fun prefix(state: OneShot)')
    for (const state of ['missed', 'due', 'pending', 'ran'] as const) {
      const word = oneShotPrefix(state)
      expect(word, `the web module has no word for ${state}`).toBeTruthy()
      expect(prefix, `Android's word for ${state} is not the web's "${word}"`)
        .toContain(`"${word}"`)
    }
  })

  it('the cadence line RENDERS the rule\'s answer', () => {
    // ⚠️ A rule nothing calls is a rule that changed nothing. The whole object
    // could be correct and the sheet keep its old string.
    const cadence = body(code(JOBS), 'internal fun cadence(')
    expect(cadence, 'the sheet stopped asking the rule what the time means')
      .toMatch(/JobCadence\.oneShotState\(runAt, fireCount, enabled, nowMs \/ 1000\)/)
    expect(cadence, 'the rule is consulted and its word discarded')
      .toMatch(/JobCadence\.prefix\(state\)/)
    // ⚠️ SECONDS. `cadence` takes millis for the daily@ conversion; un-divided,
    // `nowSec` is ~1000× too large and every one-shot reads as stale-past-catch-up.
    expect(cadence, 'the rule is handed milliseconds — every job reads as missed')
      .toMatch(/nowMs \/ 1000/)
  })
})

describe('last_fired_at, the field the scheduler overwrites when it gives up', () => {
  it('the worker really does write that field when abandoning a job', () => {
    // The premise of the whole fix, read from the worker rather than assumed —
    // if skip-stale ever stops touching `last_fired_at`, "switched off" becomes
    // the wrong word and this pin is where that surfaces.
    const s = code(SCHEDULER)
    expect(s, 'skip-stale no longer sets last_fired_at — re-check the wording')
      .toMatch(/UPDATE jobs SET last_fired_at = \?, enabled = 0 WHERE id = \?/)
    // …and does NOT touch fire_count on that path, which is why fire_count is
    // trustworthy as the only record of a run.
    const stale = s.slice(s.indexOf("=== 'skip-stale'"))
    expect(stale.slice(0, 600), 'skip-stale now increments fire_count — the rule\'s premise is gone')
      .not.toMatch(/fire_count = fire_count \+ 1/)
  })

  it('Android never prints "last" for a job that never fired', () => {
    const word = body(code(JOBS), 'fun lastFiredWord(')
    expect(word, '"last" no longer requires a fire behind it')
      .toMatch(/fired > 0 -> "last"/)
    expect(word, 'the abandoned stamp lost its honest name')
      .toMatch(/state == OneShot\.MISSED -> "switched off"/)
    expect(word, 'a never-fired job with nothing true to say now says something')
      .toMatch(/else -> null/)
  })

  it('the row renders that word, not any last_fired_at it happens to have', () => {
    // 🔴 The second half of the contradiction: `last Jan 1, 09:00` beside
    // `fired 0×`, naming the moment of ABANDONMENT as a run.
    const sheet = code(JOBS)
    expect(sheet, 'the row prints "last <when>" unconditionally again')
      .not.toMatch(/"last \$\{whenStamp/)
    expect(sheet, 'the row stopped asking what the stamp is evidence of')
      .toMatch(/JobCadence\.lastFiredWord\(j\.fireCount, state\)/)
    // Through the same `> 0` guard as the cadence line, so `last_fired_at: 0`
    // cannot render as a 1970 stamp under either word.
    expect(sheet, 'the stamp bypasses the usable-timestamp guard')
      .toMatch(/JobCadence\.usableSec\(j\.lastFired\)/)
  })
})

describe('the tone Android never had', () => {
  it('the cadence carries a tone, and the rest of the line stays gray', () => {
    // ⚠️ NOT iOS's bug mirrored. iOS's line was unconditionally GREEN, so
    // "didn't run" was painted as success; Android's was one flat gray join, so
    // "didn't run" was indistinguishable from "every 5 min" and the row's only
    // warning was a word. Different defect, same fix: the tone must reach a colour.
    const sheet = code(JOBS)
    expect(sheet, 'nothing maps a tone to a colour')
      .toMatch(/internal fun jobToneColor\(tone: JobCadence\.Tone\): Color/)
    const tint = body(sheet, 'internal fun jobToneColor(')
    expect(tint, 'a missed job is no longer warned about in colour')
      .toMatch(/Tone\.WARN -> TinyWarn/)
    expect(tint, 'the live tone lost the accent')
      .toMatch(/Tone\.LIVE -> TinyAccent/)
    // DONE and MUTED share TinyGray deliberately — a finished job and a job with
    // nothing to say are equally past, and a third colour would make every
    // completed one-shot compete with the live rows above it.
    expect(tint, 'a finished job now competes with the live rows for attention')
      .toMatch(/Tone\.DONE, JobCadence\.Tone\.MUTED -> TinyGray/)
  })

  it('the sheet actually tints the cadence with it', () => {
    // The rule reaching a colour is not the same as the colour reaching the row.
    const sheet = code(JOBS)
    expect(sheet, 'the cadence is rendered without its tone — the warning is invisible')
      .toMatch(/color = jobToneColor\(JobCadence\.tone\(j\.schedule, state, j\.enabled\)\)/)
    // And the detail half is still gray: "as tiny · fired 0×" is not a warning
    // about anything, so recolouring the whole join would cry wolf.
    expect(sheet, 'the whole detail line is tinted — every row now shouts')
      .toMatch(/"fired \$\{j\.fireCount\}×"/)
  })

  it('a recurring job is judged by its switch, not by a one-shot state', () => {
    // `every 5 min` has no run_at, so its OneShot is always UNKNOWN — reading the
    // state here would mute every live recurring row in the list.
    const tone = body(code(JOBS), 'fun tone(schedule: String?')
    expect(tone, 'a recurring row is toned by a state it can never have')
      .toMatch(/if \(!schedule\.isNullOrEmpty\(\)\) return if \(enabled\) Tone\.LIVE else Tone\.MUTED/)
    // ⚠️ `isNullOrEmpty`, not `!= null`: the payload carries "" for a one-shot,
    // and "" taking the recurring branch would tone every one-shot by its
    // enabled flag — the exact flag this cycle stopped reading as a run.
    expect(tone, 'an empty schedule takes the recurring branch — one-shots toned by the flag')
      .not.toMatch(/schedule != null\) return/)
  })
})

describe('the 1970 guard', () => {
  it('Android refuses a non-positive timestamp instead of dating a job to 1970', () => {
    // The worker validates `runAt` only as finite, and a proxied payload can carry
    // 0 — a valid instant 54 years in the past, which classifies as long-MISSED
    // and reads as an abandoned reminder the user never created.
    // ⚠️ Pinned as a DECLARATION LINE, not via `body()`. `usableSec` is an
    // expression body, so brace-matching from the signature finds the `takeIf`
    // LAMBDA's `{` and returns `{ it > 0 }` — the guard's own name falls outside
    // the slice, and the pin fails on correct code. (c57's "a signature is not a
    // body", in its other direction: there is no block to match at all.)
    expect(code(JOBS), 'the usable-timestamp guard is gone')
      .toMatch(/fun usableSec\(v: Long\?\): Long\? = v\?\.takeIf \{ it > 0 \}/)
    const rule = body(code(JOBS), 'fun oneShotState(')
    expect(rule, 'the rule no longer routes run_at through the guard')
      .toMatch(/usableSec\(runAt\) \?: return OneShot\.UNKNOWN/)
  })
})
