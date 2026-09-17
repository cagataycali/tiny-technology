// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Universe told the phone how big it was, and the phone printed the page.
 *
 * Same finding class as `ios-capacity-parity` one cycle earlier — **a number the
 * UI shows about data it did not fully receive** — found by grepping the CLAIM
 * across every surface rather than the feature across its own file. It turned up
 * three iOS surfaces and two distinct defects, both of them already solved on web
 * in `lib/chat/universe-counts.ts`, and both with the honest number sitting in the
 * payload the phone had already parsed:
 *
 *  1. **`"\(users.count) builders"` was a PAGE LENGTH beside a real total.**
 *     `CommunityFeed.url` asks `?limit=50`; the worker answers `totalUsers`, a
 *     plain `SELECT COUNT(*) FROM users` (community.ts:114). `CommunityFeed.Feed`
 *     never carried the field, so `statsLine` put a page under the word "builders"
 *     immediately next to `totalPublicTinys`, which IS a `COUNT(*)`. Measured live
 *     while this was written: `totalUsers: 7`, **6 rows** — and the gap is not even
 *     the limit (the row query is `HAVING tiny_count > 0`, and `decode` drops
 *     `tinys.isEmpty` besides). The phone claimed 6 builders for a platform of 7.
 *
 *  2. **The "+N more" overflow was derived from the truncated array, so it could
 *     never fire.** The worker embeds at most `NAMES_PER_USER = 8` names per
 *     builder (community.ts:53) while `tinyCount` is that builder's real SQL
 *     total. `builderCard` asked `u.tinys.count > 8 ? u.tinys.count - 8 : 0` — and
 *     `u.tinys.count` is **at most 8**. Live: `cagataycali` has `tinyCount: 20`
 *     with 8 names, so the card drew a "20 tinys" badge over 8 chips and **12
 *     tinys had no chip, no count and no route anywhere on the phone.** The
 *     iPad sidebar had the same defect twice over: its badge printed
 *     `u.tinys.count` (the ≤8 slice) and its disclosure listed those 8 with no
 *     hint the rest existed.
 *
 * ⚠️ WHAT NO SWIFT TEST CAN SEE, and therefore why this file exists:
 *
 *  1. **That the VIEWS ask the rule at all.** A pure function nobody calls is a
 *     green suite over an unchanged screen — the `DevicesFooter`/`Capacity` lesson,
 *     verbatim, twice now.
 *  2. **That the old expressions are GONE from the view bodies.** A Swift test
 *     cannot assert the absence of `u.tinys.count > 8` from a view.
 *  3. **That the constants still match the WORKER**, which is a submodule and moves
 *     independently. A cap hardcoded in Swift and compared against nothing is
 *     exactly how the Toolbox's fabricated "20" survived.
 *  4. **That `totalUsers` is read as an OPTIONAL.** `?? 0` compiles, passes every
 *     arithmetic test that never supplies an absent value, and turns "this worker
 *     didn't tell us" into a census claiming an empty platform.
 *  5. **That all THREE surfaces got it** — the finding was three surfaces wide, and
 *     a per-site fix is how one of them stays wrong with a green suite.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const SPLIT = join(ROOT, 'ios/Tiny/Sources/Split.swift')
const TESTS = join(ROOT, 'ios/Tests/TinyTests.swift')
const COMMUNITY = join(ROOT, 'worker/src/community.ts')
const WEB_RULE = join(ROOT, 'lib/chat/universe-counts.ts')

/** Swift with its comments stripped: every fix here is documented by QUOTING the
 *  defect, so a raw scan finds `u.tinys.count > 8` in the prose explaining it. */
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
const splitRaw = readFileSync(SPLIT, 'utf8')
const split = code(splitRaw)

describe('iOS universe counts — the page, the census, and the tinys with no route', () => {
  it('reads the files it means to read', () => {
    // A slicer that returns "" passes every assertion below forever.
    expect(panels.length).toBeGreaterThan(50_000)
    expect(split.length).toBeGreaterThan(10_000)
    expect(body(panels, 'enum UniverseCounts {').length).toBeGreaterThan(800)
    expect(body(panels, 'struct UniverseView: View {').length).toBeGreaterThan(3000)
    expect(body(split, 'struct SidebarView: View {').length).toBeGreaterThan(2000)
  })

  it("the per-user name cap is the WORKER's number, read from the worker", () => {
    // ⚠️ The whole reason the Toolbox's "20" survived a year: a number typed into
    // a Swift view and compared against nothing. Both sides are read here, so a
    // worker-side change reddens this suite instead of silently making the phone
    // hide tinys (too low) or promise a "+N more" that isn't there (too high).
    const worker = readFileSync(COMMUNITY, 'utf8')
    const cap = worker.match(/NAMES_PER_USER\s*=\s*(\d+)/)?.[1]
    expect(cap, 'NAMES_PER_USER is gone from the worker — re-anchor').toBeTruthy()
    expect(
      body(panels, 'enum UniverseCounts {'),
      `the worker embeds ${cap} names per builder; iOS UniverseCounts disagrees`,
    ).toMatch(new RegExp(`namesPerUser\\s*=\\s*${cap}\\b`))

    // …and the page limit must be the one the fetch actually sends, or
    // `isTruncated`'s full-page evidence is measured against a fiction.
    const url = panelsRaw.match(/community\?limit=(\d+)/)?.[1]
    expect(url, 'the community url no longer carries a limit — re-anchor').toBeTruthy()
    expect(
      body(panels, 'enum UniverseCounts {'),
      `CommunityFeed asks for limit=${url}; pageLimit says otherwise`,
    ).toMatch(new RegExp(`pageLimit\\s*=\\s*${url}\\b`))
  })

  it('the worker really does send a census, and really does cap the names', () => {
    // The premise both halves rest on. If the worker ever stopped answering
    // totalUsers, or stopped capping tinys[], this suite should say so rather
    // than keep asserting a stale reason for a rule.
    const worker = readFileSync(COMMUNITY, 'utf8')
    expect(worker, 'totalUsers is no longer a COUNT(*) — the "N of M" premise is stale')
      .toMatch(/SELECT COUNT\(\*\) AS n FROM users/)
    expect(worker, 'totalUsers is no longer emitted — statsLine has no census to read')
      .toMatch(/totalUsers,/)
    expect(worker, 'tinyCount is no longer the SQL total — overflow has no population')
      .toMatch(/tinyCount: Number\(row\.tiny_count\)/)
    expect(worker, 'the embedded names are no longer capped — then tinys.count WOULD be usable')
      .toMatch(/u\.tinys\.length < NAMES_PER_USER/)
  })

  it('the feed CARRIES totalUsers, and carries it as an optional', () => {
    // ⚠️ Point 4. The field was in every response the phone ever parsed and
    // nothing read it — that absence IS the first defect. And `?? 0` here would
    // be a different lie: "the worker didn't say" rendered as "nobody is here".
    const feed = body(panels, 'struct Feed {')
    expect(feed, 'Feed does not carry the census — statsLine can only print the page')
      .toMatch(/let totalUsers: Int\?/)
    expect(feed, 'totalUsers is non-optional, so an absent census reads as a real 0')
      .not.toMatch(/let totalUsers: Int\b(?!\?)/)

    const decode = body(panels, 'static func decode(')
    expect(decode, 'decode never reads totalUsers off the wire').toContain('obj["totalUsers"]')
    expect(decode, 'decode coerces an absent census to 0 — the exact reading the optional prevents')
      .not.toMatch(/totalUsers"\]\s*as\?\s*NSNumber\)\?\.intValue\s*\?\?\s*0/)
  })

  it('the stats line asks the rule instead of formatting its own count', () => {
    const view = body(panels, 'struct UniverseView: View {')
    expect(view, 'the builders half does not go through UniverseCounts — the rule is decorative')
      .toContain('UniverseCounts.builders(shown: users.count, totalUsers: totalUsers)')
    expect(view).toContain('UniverseCounts.publicTinys(totalPublicTinys)')

    // ⚠️ Point 2: THE DEFECT, asserted absent. No Swift test can do this.
    expect(view, 'the bare page length is back in the stats line')
      .not.toMatch(/\\\(users\.count\) builder/)
    expect(view, 'a count is being pluralised in the view again')
      .not.toMatch(/users\.count == 1 \?/)
  })

  it('the qualified count comes with the sentence that explains it', () => {
    // Web hides this in a `title` tooltip. A phone has no hover, so without the
    // caption "6 of 7 builders" is a number with no reading — and it must appear
    // ONLY when the page really isn't the whole set (a permanent hedge is its own
    // false claim).
    const view = body(panels, 'struct UniverseView: View {')
    expect(view, 'nothing computes the explanatory note').toContain('UniverseCounts.note(')
    expect(view, 'the note is computed but never rendered').toMatch(/if let statsNote/)
  })

  it('the builder card derives its overflow from the whole population', () => {
    const view = body(panels, 'struct UniverseView: View {')
    expect(view, 'the overflow does not go through the rule')
      .toContain('UniverseCounts.hiddenTinys(')
    expect(view, 'the overflow is computed from tinyCount, so it must be passed one')
      .toMatch(/tinyCount: u\.tinyCount/)

    // ⚠️ THE DEFECT, asserted absent: `u.tinys.count` is at most 8, so any
    // comparison of it against 8 is dead code that hides every hidden tiny.
    expect(view, 'the unreachable overflow is back — u.tinys.count can never exceed 8')
      .not.toMatch(/u\.tinys\.count > 8/)
    expect(view, 'the overflow is subtracting from the truncated array again')
      .not.toMatch(/u\.tinys\.count - 8/)
  })

  it('the iPad sidebar badge counts the builder, not the slice it received', () => {
    // ⚠️ Point 5. The finding was three surfaces wide; this is the one a
    // Panels.swift-only fix leaves wrong, with everything above still green.
    const view = body(split, 'struct SidebarView: View {')
    expect(view, 'the sidebar badge prints the ≤8 embedded slice as if it were the total')
      .not.toMatch(/Text\("\\\(u\.tinys\.count\)"\)/)
    expect(view, 'the sidebar badge no longer shows the builder’s real total')
      .toMatch(/Text\("\\\(u\.tinyCount\)"\)/)
  })

  it('the sidebar names a route to the tinys it did not receive', () => {
    // The disclosure lists the ≤8 names it has. Without this it is silent about
    // the other 12 — the same "no route" defect as the card's dead overflow, on
    // the surface that is always on screen.
    const view = body(split, 'struct SidebarView: View {')
    expect(view, 'the sidebar computes no hidden count')
      .toContain('UniverseCounts.hiddenTinys(')
    expect(view, 'the hidden count is computed but leads nowhere')
      .toMatch(/more in the Universe/)
    expect(view, 'the "more" row shows unconditionally, promising more when there is none')
      .toMatch(/if hidden > 0/)
  })

  it('web and iOS encode the SAME rule, so neither can drift alone', () => {
    // The port's anchor. Web grew this module for these two findings; if its
    // rules move, the phone's copy is stale and this is where that shows up.
    const web = readFileSync(WEB_RULE, 'utf8')
    const cap = web.match(/COMMUNITY_TINYS_PER_USER\s*=\s*(\d+)/)?.[1]
    expect(cap, 'the web cap constant is gone — re-anchor').toBeTruthy()
    expect(
      body(panels, 'enum UniverseCounts {'),
      `web caps per-user names at ${cap}; iOS disagrees`,
    ).toMatch(new RegExp(`namesPerUser\\s*=\\s*${cap}\\b`))
    // Both derive overflow from the total, and both refuse a negative.
    expect(web).toMatch(/Math\.max\(0, total - shown\)/)
    expect(body(panels, 'static func hiddenTinys(')).toMatch(/max\(0,/)
    // Both render "N of M" rather than a bare page.
    expect(web).toMatch(/\$\{shown\} of \$\{total\} builders/)
    expect(body(panels, 'static func builders(')).toMatch(/\\\(shown\) of \\\(total\) builders/)
  })

  it('the arithmetic is RUN, not merely read off source text', () => {
    // ⚠️ A test file is a parity surface too. Everything above is a source scan,
    // which cannot tell whether builders(shown: 6, totalUsers: 7) says "6 of 7"
    // or "7 of 6" — only UniverseCountsTests can. And if its @Test attributes are
    // dropped, that suite still passes with fewer tests and nothing goes red.
    const src = readFileSync(TESTS, 'utf8')
    const suite = body(src, '@Suite struct UniverseCountsTests {')
    expect(suite.length, 'UniverseCountsTests is gone or gutted — re-anchor').toBeGreaterThan(2000)

    // A @Test COUNT is not a gate (it goes slack the day a test is added). What
    // kills a silenced test is this: a `func` in the suite with no @Test above it
    // still compiles, still reads like a test, and never runs. This exact scan
    // caught a mutant that left the Swift suite green with 8 tests instead of 9.
    const lines = suite.split('\n')
    const orphans = lines
      .map((l, i) => ({ l, prev: lines[i - 1] ?? '' }))
      .filter(({ l }) => /^\s+func\s+\w+\(\)/.test(l))
      .filter(({ prev }) => !prev.includes('@Test'))
      .map(({ l }) => l.trim())
    expect(orphans, `these look like tests but carry no @Test, so they never run: ` +
      `${orphans.join(' | ')}`).toEqual([])

    // The four properties no source scan can reach: the live page-vs-census pair,
    // the absent census, the incoherent total, and the overflow that could never
    // fire.
    expect(suite, 'nothing runs the page-beside-a-total case — the first defect')
      .toMatch(/builders\(shown: 6, totalUsers: 7\)/)
    expect(suite, 'nothing runs the absent-census case').toMatch(/totalUsers: nil/)
    expect(suite, 'nothing runs the contradicting-total case')
      .toMatch(/builders\(shown: 12, totalUsers: 3\)/)
    expect(suite, 'nothing runs the 20-real/8-embedded case — the second defect')
      .toMatch(/hiddenTinys\(tinyCount: 20, chipsShown: 8\)/)
    // …and that decode really keeps an absent census absent, which is the one
    // property a `?? 0` would pass every other test while breaking.
    expect(suite, 'nothing runs decode against a payload with no totalUsers')
      .toMatch(/removeValue\(forKey: "totalUsers"\)/)
  })
})
