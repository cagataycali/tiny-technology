// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 The picture is read first, and three of them named a cause the app never
 * checked.
 *
 * UniverseView, BuilderProfileView and ToolboxPanel drew
 * `Label("Couldn't load", systemImage: "wifi.slash")` for ANY failed load. Once
 * the captions started telling the truth (`1ffb5c19`, `3eca0cfe`) the mismatch
 * became plain: "Session expired — sign out and back in (HTTP 401)" under a
 * crossed-out wifi symbol, or "Server hiccup (HTTP 503)" under one. A reader who
 * trusts the glyph goes looking for signal; a reader who trusts the words signs
 * out. Only one of them can be right, and the app knew which all along.
 *
 * The honest glyph is either the screen's own SUBJECT crossed out — `bolt.slash`
 * on Activity, `iphone.slash` on My Devices, `waveform.slash` on recordings,
 * `person.2.slash` on the community list — which says no more than "this content
 * isn't here", or a cause-free retry glyph where no such symbol exists (there is
 * no `hammer.slash`; Apple's plist is the authority, and
 * `tests/ios-sf-symbols.test.ts` checks every name against it).
 *
 * A connection glyph is allowed in exactly one situation: the app MEASURED
 * reachability. `Views.swift`'s offline banner sits inside `if !net.online`, so
 * its `wifi.slash` is a fact. This suite is that rule, swept over every Swift
 * source, plus the wiring the three panels now share.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const API = join(ROOT, 'ios/Tiny/Sources/Api.swift')

/** Glyphs that assert a network. `slash` variants only — plain `wifi` is a
 *  settings row, not a claim about why something failed. */
const CONNECTION_GLYPHS = [
  'wifi.slash',
  'wifi.exclamationmark',
  'network.slash',
  'antenna.radiowaves.left.and.right.slash',
  'cellularbars.slash',
]

/** How the app can know it is offline. `net` is the injected NetworkMonitor. */
const MEASURED = /net\.online|isOnline|NWPath|reachab/i

/** Comments stripped — this file's own prose names every glyph it forbids, and
 *  so do the source comments explaining the rule. A rule documented in a
 *  comment must not be able to satisfy, or violate, an assertion. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

function swiftFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.swift')) out.push(p)
    }
  }
  for (const r of ['ios/Tiny/Sources', 'ios/Shared', 'ios/TinyWatch/Sources',
                   'ios/TinyWidgets', 'ios/TinyWatchWidgets']) walk(join(ROOT, r))
  return out
}

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

/** Every capture-group-1 match. `[...src.matchAll(re)]` is the obvious spelling
 *  and it typechecks only under `--downlevelIteration`; this tsconfig's target is
 *  below ES2015, so the spread adds a `TS2802` to the repo gate. An `exec` loop
 *  costs six lines and no noise. */
function caps(source: string, re: RegExp): string[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = g.exec(source)) !== null) out.push(m[1])
  return out
}

/** A block with its anchor ASSERTED — an unfound anchor makes `slice` return one
 *  character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('iOS failure glyphs: no cause the app never checked', () => {
  it('every connection glyph sits in a branch that MEASURED reachability', () => {
    // The window is the 14 lines above the glyph: far enough to hold the `if`
    // and the Label it guards even with a wrapped multi-line initialiser, close
    // enough that an unrelated `net.online` elsewhere in the view can't launder
    // an unchecked claim. Widen it only with a reason.
    const offenders: string[] = []
    let allowed = 0
    for (const file of swiftFiles()) {
      const lines = code(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (!/systemName:|systemImage:/.test(line)) return
        if (!CONNECTION_GLYPHS.some(g => line.includes(`"${g}"`))) return
        const window = lines.slice(Math.max(0, i - 14), i + 1).join('\n')
        if (MEASURED.test(window)) allowed++
        else offenders.push(`${file.replace(ROOT + '/', '')}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(offenders, 'a failure glyph blames the network without checking it')
      .toEqual([])
    // ⚠️ Reachability of the rule itself: if this hits 0 the sweep is passing
    // because it found NOTHING, and a regex that matches nothing passes forever.
    // Views.swift's offline banner is the honest case that keeps it honest.
    expect(allowed, 'no measured-reachability glyph left — is the sweep still finding anything?')
      .toBeGreaterThan(0)
  })

  it('the three panels show a subject or a retry, never a cause', () => {
    const src = code(readFileSync(PANELS, 'utf8'))
    // Each failure state, by the caption that identifies it.
    const glyphFor = (caption: string) => {
      const at = src.indexOf(caption)
      expect(at, `${caption} not found — re-anchor`).toBeGreaterThan(-1)
      const m = src.slice(at, at + 200).match(/systemImage:\s*"([^"]+)"/)
      return m?.[1]
    }
    expect(glyphFor('"Couldn\'t load", systemImage')).toBe('person.2.slash')
    expect(glyphFor('"Couldn\'t load @\\(login)"')).toBe('exclamationmark.arrow.circlepath')
    expect(glyphFor('"Couldn\'t load your tools"')).toBe('exclamationmark.arrow.circlepath')
  })

  it("the profile's failure glyph differs from its not-found glyph", () => {
    // Two states, opposite meanings, four lines apart: "we couldn't reach the
    // server" and "this handle is not a builder". Sharing `person.slash` would
    // make a transient outage look like a verdict about a person.
    const src = code(readFileSync(PANELS, 'utf8'))
    const fail = src.slice(src.indexOf('"Couldn\'t load @\\(login)"'))
      .match(/systemImage:\s*"([^"]+)"/)?.[1]
    const notFound = src.slice(src.indexOf('"No builder @\\(login)"'))
      .match(/systemImage:\s*"([^"]+)"/)?.[1]
    expect(notFound, 'the not-found state moved — re-anchor').toBe('person.slash')
    expect(fail).not.toBe(notFound)
  })

  it('no failure state states a fixed sentence instead of the reason', () => {
    // "Usually momentary." was the builder profile's whole description: a claim
    // about the future, made without reading the failure, in the one place the
    // reason belongs.
    const src = code(readFileSync(PANELS, 'utf8'))
    expect(src, 'a fixed prognosis is back in place of the reason')
      .not.toContain('Usually momentary')
  })
})

describe('iOS content loads: the chat table stays in the chat', () => {
  it('the three loaders ask `contentMessage`, not the chat table', () => {
    const src = code(readFileSync(PANELS, 'utf8'))
    for (const anchor of ['private func load() async {']) {
      expect(src.split(anchor).length - 1,
             'the panels no longer have three loads — re-anchor').toBeGreaterThanOrEqual(3)
    }
    // Every failed-state assignment in the file, and what it is handed.
    const assigns = caps(code(readFileSync(PANELS, 'utf8')), /state = \.failed\(([^\n]*)\)/g)
    expect(assigns.length, 'no failed-state assignments found — re-anchor').toBeGreaterThan(3)
    for (const a of assigns) {
      // Raw system text (`error.localizedDescription`) and hand-rolled wire
      // strings (`"HTTP \(code)"`, `"Bad response"`, `"bad login"`) are what
      // this increment removed; each is a sentence the reader can't use.
      expect(a, `a failed state hands over raw system text: ${a}`)
        .not.toMatch(/^error\.localizedDescription/)
      expect(a, `a failed state speaks HTTP at the reader: ${a}`)
        .not.toMatch(/"HTTP \\\(/)
    }
  })

  it('`contentMessage` defers to the table only where the table means transport', () => {
    const fn = body(code(readFileSync(API, 'utf8')), 'static func contentMessage(_ error: Error)')
    // The three conditions, each load-bearing: a status, no words from the
    // server, and a status the table does not own.
    expect(fn).toMatch(/statusOwnsTheMessage\(status\)/)
    expect(fn).toMatch(/status != 424/)
    expect(fn).toMatch(/trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/)
    expect(fn, 'the fallback must not fall back to the chat table')
      .toMatch(/return "Couldn't load it — try again \(HTTP \\\(status\)\)"/)
    // And the non-HTTP paths still go through the one type dispatch.
    expect(fn).toMatch(/return message\(error\)/)
  })

  it('the status door and the error door are the SAME rule', () => {
    // Two panels fetch plugin.tiny.technology directly and hold an Int, not a
    // thrown ApiError. A second implementation for them is a second thing to
    // drift; the overload must construct the error and call the one rule.
    const fn = body(code(readFileSync(API, 'utf8')), 'static func contentMessage(status: Int')
    expect(fn).toMatch(/contentMessage\(ApiError\.http\(status, serverMsg\)\)/)
    expect(fn, 'the overload grew its own table').not.toMatch(/switch|friendlyHTTPError/)
  })

  it("⚠️ FAILS WHEN FIXED: the worker's answer set is what the panels assume", () => {
    // The 400→not-found routing is only right while /profile answers 400 for a
    // handle it refuses to look up. If that becomes a retryable failure, the
    // panel would silently call it "not a builder" — so this pin fails the day
    // the worker's contract moves.
    const profile = join(ROOT, 'worker/src/profile.ts')
    if (!existsSync(profile)) return // submodule not checked out
    const src = readFileSync(profile, 'utf8')
    expect(src, '🎉 /profile no longer 400s an invalid login — recheck Panels.swift:611')
      .toMatch(/json\(\{\s*error:\s*"invalid login"\s*\}\s*,\s*400\)/)
    expect(src, '🎉 /profile no longer 404s an unknown login')
      .toMatch(/json\(\{\s*error:\s*"not found"\s*\}\s*,\s*404\)/)
    // And the community list's only non-2xx, which is why 500 must keep the
    // table's "Server hiccup" wording rather than the cause-free line.
    const community = readFileSync(join(ROOT, 'worker/src/community.ts'), 'utf8')
    expect(community, '🎉 /community gained a status — check contentMessage covers it')
      .toMatch(/status:\s*500/)
  })
})
