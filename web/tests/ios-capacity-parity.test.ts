// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The two numbers the phone printed about a limit, and both were wrong.
 *
 * The Toolbox header read `"\(tools.count)/20 forged tools"`. **There is no cap of
 * 20.** The worker's is `MAX_TOOLS = 10000` and its list query has no LIMIT, so
 * the numerator was honest and the denominator was invented — a rule the product
 * appeared to enforce and didn't. The Jobs panel had the opposite defect: a bare
 * `Section("Scheduled jobs")` with no cap, while `MAX_JOBS_PER_USER = 10` is real
 * and is met as a 429 from the agent, mid-conversation, after the user has already
 * said what they wanted.
 *
 * Web fixed both in `lib/chat/capacity.ts` (cycle A2/A3 of its own backlog); the
 * phone never received it. `Capacity` in Panels.swift is the port, and
 * `CapacityTests` runs its arithmetic on the JVM— sorry, on the simulator.
 *
 * ⚠️ WHAT NO SWIFT TEST CAN SEE, and therefore why this file exists:
 *
 *  1. **That the VIEWS ask the rule at all.** A pure function nobody calls is a
 *     green suite over an unchanged screen. This was the `DevicesFooter` lesson
 *     one cycle earlier and it applies verbatim.
 *  2. **That the fiction is gone from the screen** — a Swift test cannot assert
 *     the ABSENCE of a string literal in a view body.
 *  3. **That the constants still match the WORKER**, which is a different repo
 *     (a submodule) and moves independently. A cap hardcoded in Swift and read
 *     from nowhere is exactly how "20" survived.
 *  4. **That the jobs header is asked with the nil-when-unloaded value**, not the
 *     raw array. `jobs` is `[]` before the fetch, after a failed fetch, and for an
 *     account with none — and only the third is a count of zero.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const TESTS = join(ROOT, 'ios/Tests/TinyTests.swift')
const SCHEDULER = join(ROOT, 'worker/src/scheduler.ts')
const TOOLS = join(ROOT, 'worker/src/tools.ts')

/** Swift with its comments stripped: every fix here is documented by QUOTING the
 *  defect, so a raw scan finds `/20 forged tools` in the prose explaining it. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\*+.*$/gm, '')

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

function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

const panelsRaw = readFileSync(PANELS, 'utf8')
const panels = code(panelsRaw)

describe('iOS capacity labels — the denominator, and the population it counts', () => {
  it('reads the files it means to read', () => {
    // A slicer that returns "" passes every assertion below forever.
    expect(panels.length).toBeGreaterThan(50_000)
    expect(body(panels, 'enum Capacity {').length).toBeGreaterThan(500)
    expect(body(panels, 'struct JobsView: View {').length).toBeGreaterThan(3000)
    expect(body(panels, 'struct ToolboxView: View {').length).toBeGreaterThan(2000)
  })

  it('the caps are the WORKER\'s numbers, read from the worker', () => {
    // ⚠️ The whole reason "20" survived: a number typed into a Swift view and
    // compared against nothing. Both sides are read here, so a worker-side change
    // reddens this suite instead of silently making the phone lie.
    const scheduler = readFileSync(SCHEDULER, 'utf8')
    const tools = readFileSync(TOOLS, 'utf8')
    const jobCap = scheduler.match(/MAX_JOBS_PER_USER\s*=\s*(\d+)/)?.[1]
    const toolCap = tools.match(/MAX_TOOLS\s*=\s*(\d+)/)?.[1]
    expect(jobCap, 'MAX_JOBS_PER_USER is gone from the scheduler — re-anchor').toBeTruthy()
    expect(toolCap, 'MAX_TOOLS is gone from the worker tools — re-anchor').toBeTruthy()

    const cap = body(panels, 'enum Capacity {')
    expect(cap, `the worker caps active jobs at ${jobCap}; iOS Capacity disagrees`)
      .toMatch(new RegExp(`jobActiveCap\\s*=\\s*${jobCap}\\b`))
    // 10_000 in Swift, 10000 in TS — compare digits, not spelling.
    expect(
      cap.replace(/(\d)_(\d)/g, '$1$2'),
      `the worker caps forged tools at ${toolCap}; iOS Capacity disagrees`,
    ).toMatch(new RegExp(`toolMax\\s*=\\s*${toolCap}\\b`))
  })

  it('the cap query counts ONLY enabled rows — which is why the count is recomputed', () => {
    // The premise the whole jobs half rests on. If the worker ever counted every
    // row, `activeJobCount` would be wrong in the other direction and this suite
    // should say so rather than keep asserting a stale reason.
    const scheduler = readFileSync(SCHEDULER, 'utf8')
    expect(
      scheduler,
      'the cap no longer counts enabled-only — Capacity.activeJobCount is now the wrong population',
    ).toMatch(/COUNT\(\*\)[^"]*FROM jobs WHERE user_id = \? AND enabled = 1/)
    // …and the LIST is unbounded and unfiltered, so it really can hold more rows
    // than the cap counts. (That difference IS the 12/10 defect.)
    expect(scheduler).toMatch(/FROM jobs WHERE user_id = \? ORDER BY created DESC/)
  })

  it('the Toolbox header asks the rule instead of printing its own arithmetic', () => {
    const view = body(panels, 'struct ToolboxView: View {')
    expect(view, 'the header does not go through Capacity — the rule is decorative')
      .toContain('Capacity.toolBoxBadge(tools.count)')
    // ⚠️ THE FICTION, asserted absent. No Swift test can do this.
    expect(view, 'the invented /20 cap is back in the Toolbox header')
      .not.toMatch(/\/20 forged tools/)
    expect(view, 'a denominator is being formatted in the view again')
      .not.toMatch(/tools\.count\)\/\d/)
  })

  it('the Jobs header and cap note both go through the rule', () => {
    const view = body(panels, 'struct JobsView: View {')
    expect(view, 'the jobs section header still hardcodes its title, so no cap can appear')
      .not.toMatch(/Section\("Scheduled jobs"\)/)
    expect(view).toContain('Capacity.jobsHeader(')
    expect(view, 'the cap note is computed nowhere — the way out is never named')
      .toContain('Capacity.jobsCapNote(')
  })

  it('the header is asked with the not-loaded-aware value, never the raw array', () => {
    // ⚠️ `jobs` is [] in three situations and only one of them is a count of zero.
    // The header renders OUTSIDE the state switch (deliberately — device-local
    // agent alerts must survive a server outage), so passing the array straight in
    // prints "· 0" above "Couldn't load your scheduled jobs". This is the bug web
    // still ships, and the reason the entry points take an optional.
    const view = body(panels, 'struct JobsView: View {')
    for (const call of ['Capacity.jobsHeader(', 'Capacity.jobsCapNote(']) {
      const arg = view.slice(view.indexOf(call) + call.length).match(/^[^)]*/)?.[0].trim()
      expect(arg, `${call} is asked with \`${arg}\` — [] means "not loaded" here too`)
        .toBe('loadedJobs')
    }
    // …and that value must actually be nil outside .loaded, or the name lies.
    const loaded = body(panels, 'private var loadedJobs: [JobRow]?')
    expect(loaded).toMatch(/case \.loaded/)
    expect(loaded, 'loadedJobs never returns nil — an unloaded panel would print 0')
      .toMatch(/return nil/)
  })

  it('the create form names the ACTIVE population, not a total', () => {
    // Same population confusion, pointed the other way: "up to 10 scheduled jobs"
    // reads as a cap on the LIST, so someone looking at 12 rows (9 of them spent)
    // believes they are two over a limit they are nowhere near.
    const view = body(panels, 'struct JobCreateView: View {')
    expect(view, 'the create footer states a cap on the wrong population')
      .not.toMatch(/Up to \d+ scheduled jobs/)
    expect(view).toMatch(/Capacity\.jobActiveCap\) active scheduled jobs/)
  })

  it('the arithmetic is RUN, not merely read off source text', () => {
    // ⚠️ A test file is a parity surface too. Everything above is a source scan,
    // which cannot tell whether jobsHeader(3 active + 9 spent) says 12 or 12/10 —
    // only CapacityTests can, and if its @Test attributes are dropped the whole
    // suite still passes with fewer tests and nothing anywhere goes red.
    const src = readFileSync(TESTS, 'utf8')
    const suite = body(src, '@Suite struct CapacityTests {')
    expect(suite.length, 'CapacityTests is gone or gutted — re-anchor').toBeGreaterThan(1500)
    // A count is not a gate (the day a test is added, a floor goes slack). What
    // kills a silenced test is this: a `func` in the suite with no @Test above it
    // still compiles, still reads like a test, and never runs.
    const lines = suite.split('\n')
    const orphans = lines
      .map((l, i) => ({ l, prev: lines[i - 1] ?? '' }))
      // The fixture helpers are deliberately un-annotated — they are named
      // `private func`, which is exactly what a silenced @Test is not.
      .filter(({ l }) => /^\s+func\s+\w+\(\)/.test(l))
      .filter(({ prev }) => !prev.includes('@Test'))
      .map(({ l }) => l.trim())
    expect(orphans, `these look like tests but carry no @Test, so they never run: ` +
      `${orphans.join(' | ')}`).toEqual([])
    // The three properties no source scan can reach: the mixed-population count,
    // the not-loaded case, and the absent denominator.
    expect(suite, 'nothing runs the mixed active/spent count — the 12/10 defect')
      .toMatch(/active\(3\) \+ spent\(9\)/)
    expect(suite, 'nothing runs the not-loaded case').toMatch(/jobsHeader\(nil\)/)
    expect(suite, 'nothing runs the tool badge').toMatch(/toolBoxBadge\(/)
  })
})
