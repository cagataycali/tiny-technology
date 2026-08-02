// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📱 The row whose hardware is least in doubt was the one getting it wrong.
 *
 * `Session.enroll` posts `platform: "ios-arm64"` from the iPhone, the iPad and
 * the Mac Catalyst build alike. So on an iPad, the device list drew an iPhone
 * glyph, printed "iOS", and put a "this phone" pill under a header reading "This
 * phone" — four claims about the hardware the app was RUNNING ON, all made from
 * one lossy token.
 *
 * `LocalHardware` is the rule and the Swift suite tests it exhaustively. What no
 * Swift test can see is any of the things that make it sound:
 *
 *  1. that the VIEW asks — a correction nothing calls leaves the iPhone glyph on
 *     the iPad with a green suite either side of it;
 *  2. that the view passes the LIVE shape and not the `.phone` default, which is
 *     deliberately the identity case and would silently switch the fix off;
 *  3. that the correction stays cosmetic — `d.platform == "nicla-vision"` gates
 *     the necklace's camera panel and the server matches the token exactly, so
 *     the wire's word must survive;
 *  4. that the two platform tables still list `ipad` and `darwin` AHEAD of `ios`.
 *     Reorder them and the substituted token resolves to "iOS" again — the fix
 *     would evaporate with every test above still passing.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const SESSION = join(ROOT, 'ios/Tiny/Sources/Session.swift')

/** Source from a needle to its matching close brace. */
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

function decl(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

function structBody(source: string, name: string): string {
  const at = source.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** Swift with its comments stripped: the fix is documented by quoting the bug. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('this device draws the hardware it is actually running on', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const rule = decl(panels, 'enum LocalHardware {')
  const row = structBody(panels, 'DeviceRowView')
  const sheet = structBody(panels, 'DevicesView')

  it('reads the files it means to read', () => {
    expect(rule.length).toBeGreaterThan(800)
    expect(row.length).toBeGreaterThan(1500)
    expect(sheet.length).toBeGreaterThan(4000)
  })

  it('the sheet corrects the fleet it is about to draw', () => {
    // A rule nothing calls is dead code, and this one has to be called on the
    // path that BUILDS the sections — not at decode, which a poll, an SSE nudge
    // and a pull-to-refresh each bypass in their own way.
    const groups = code(decl(sheet, 'private var groups: [DeviceGroup] {'))
    expect(groups).toMatch(/LocalHardware\.corrected\(devices, thisDeviceId: thisPhone/)
    expect(groups).toMatch(/DeviceOrder\.grouped\(/)
  })

  it('the live shape reaches every one of the four claims', () => {
    // `.phone` is the default on all three DeviceOrder entry points BECAUSE it
    // changes nothing — which is exactly what makes a forgotten argument
    // invisible. Each of these is a place the default would silently win.
    const groups = code(decl(sheet, 'private var groups: [DeviceGroup] {'))
    expect(groups).toMatch(/let shape = LocalHardware\.current/)
    // Both calls, each pinned to its own argument list. A bare /shape: shape/
    // needle passed with the argument DROPPED from `grouped` — the other call in
    // the same expression was matching it, and an iPad's sections went back to
    // being named "This phone" with this suite green. Mutation-tested (M12).
    expect(groups, 'the correction would run for the default shape')
      .toMatch(/corrected\(devices, thisDeviceId: thisPhone,\s*shape: shape\)/)
    expect(groups, 'the sections would be named for a phone on an iPad')
      .toMatch(/myDeviceId: thisPhone, shape: shape\)/)
    const body = code(row)
    expect(body, 'the row lost its shape and would draw the default')
      .toMatch(/private var shape: LocalHardware\.Shape \{ LocalHardware\.current \}/)
    expect(body).toMatch(/deviceGlyph\(platform: d\.shownPlatform, kind: d\.kind\)/)
    expect(body, 'the glyph went back to the wire word')
      .not.toMatch(/deviceGlyph\(platform: d\.platform/)
    expect(body).toMatch(/Text\(LocalHardware\.selfPill\(shape\)\)/)
    expect(body, 'the pill is a hardcoded noun again').not.toMatch(/Text\("this phone"\)/)
    expect(body).toMatch(/rowLine\(d, isThisPhone: isThisPhone, shape: shape\)/)
  })

  it('the word on the second line comes from the corrected platform', () => {
    // `descriptor` is what `rowLine` and `presenceLine` both print. Left on
    // `platform` it would say "iOS" beside an iPad glyph — a row disagreeing
    // with itself, which is worse than a row that is uniformly wrong.
    const d = code(decl(panels, 'var descriptor: String {'))
    expect(d).toMatch(/deviceLabel\(platform: shownPlatform, kind: kind\)/)
    expect(d, 'the descriptor is back on the wire word').not.toMatch(/platform: platform,/)
  })

  it('the wire word survives, because behaviour still runs on it', () => {
    // The correction is for DRAWING only. Two live consumers prove why: the
    // necklace panels switch on the exact token, and the server does too
    // (`platform === 'ios-arm64'` picks the recorder for the Voice necklace).
    expect(code(panels)).toMatch(/if d\.platform == "nicla-vision"/)
    expect(code(panels)).toMatch(/if d\.platform == "nicla-voice"/)
    expect(code(panels), 'a behaviour gate started reading the cosmetic word')
      .not.toMatch(/shownPlatform == "nicla/)
    // `platform` stays immutable and `localPlatform` is the addition.
    expect(panels).toMatch(/ {4}let platform: String\n/)
    expect(panels).toMatch(/var shownPlatform: String \{ localPlatform \?\? platform \}/)
    // Exactly one writer, inside the rule itself.
    const writes = code(panels).match(/\.localPlatform = /g) ?? []
    expect(writes.length, 'something outside LocalHardware is setting the shown word')
      .toBe(1)
    expect(code(rule)).toMatch(/fixed\.localPlatform = shown/)
  })

  it('the enroll token is NOT touched — that is the whole premise', () => {
    // Changing what goes on the wire would split the fleet across two spellings
    // and need a server deploy; this app cannot do it unilaterally. If this ever
    // changes, this test is the note that the correction may be redundant.
    const session = readFileSync(SESSION, 'utf8')
    expect(session).toMatch(/"platform": "ios-arm64"/)
  })

  it('the pure rule stays pure, and the impure edge stays one expression', () => {
    // `current` is the only place that may read the device, so every other
    // function is testable on any simulator. Catalyst is checked at COMPILE
    // time and first: "Scaled to Match iPad" reports the `.pad` idiom from a Mac.
    const current = decl(rule, '@MainActor static var current: Shape {')
    expect(current).toMatch(/#if targetEnvironment\(macCatalyst\)/)
    expect(current).toMatch(/UIDevice\.current\.userInterfaceIdiom == \.pad/)
    for (const fn of ['static func platform(wire: String, shape: Shape)',
                      'static func corrected(', 'static func selfNoun(']) {
      expect(decl(rule, fn), `${fn} reads the device instead of its argument`)
        .not.toMatch(/UIDevice|ProcessInfo|targetEnvironment/)
    }
  })

  it('one noun behind the header and the pill', () => {
    // The defect this change is about, one line lower: "This iPad" over a pill
    // reading "this phone". Derived strings, so they cannot drift apart.
    expect(code(rule)).toMatch(/selfTitle\(_ shape: Shape\) -> String \{ "This \\\(selfNoun\(shape\)\)" \}/)
    expect(code(rule)).toMatch(/selfPill\(_ shape: Shape\) -> String \{ "this \\\(selfNoun\(shape\)\)" \}/)
    expect(code(decl(panels, 'static func groupTitles(')))
      .toMatch(/LocalHardware\.selfTitle\(shape\)/)
  })

  it('⚠️ the substituted tokens still resolve — table ORDER is load-bearing', () => {
    // The correction adds no needle: it spells the platform so that needles the
    // app has always had, and never once matched, finally fire. Both tables put
    // `ipad` and `darwin` ahead of `ios`; move `ios` up and an iPad silently
    // reads "iOS" again with every other test here still green.
    for (const table of ['DEVICE_PLATFORM_GLYPH', 'DEVICE_PLATFORM_NAME']) {
      // Bracket-matched, not brace-matched: these are array literals, and a
      // `{`-matcher silently returns the next unrelated block.
      // `= [`, because the first `[` after the name is the TYPE annotation's.
      const start = panels.indexOf('= [', panels.indexOf(`private let ${table}`)) + 2
      expect(start, `${table} not found — renamed?`).toBeGreaterThan(-1)
      let depth = 1
      let i = start + 1
      while (i < panels.length && depth > 0) {
        if (panels[i] === '[') depth++
        else if (panels[i] === ']') depth--
        i++
      }
      const body = panels.slice(start, i)
      expect(body).toContain('nicla')
      const at = (needle: string) => {
        const i = body.indexOf(`("${needle}"`)
        expect(i, `${table} lost its ${needle} needle`).toBeGreaterThan(-1)
        return i
      }
      expect(at('ipad'), `${table} now matches ios before ipad`).toBeLessThan(at('ios'))
      expect(at('darwin'), `${table} now matches ios before darwin`).toBeLessThan(at('ios'))
    }
    // And the tokens the rule actually substitutes are the ones those needles read.
    const platform = code(decl(rule, 'static func platform(wire: String, shape: Shape)'))
    expect(platform).toMatch(/case \.pad: return "ipad-arm64"/)
    expect(platform).toMatch(/case \.mac: return "darwin-arm64"/)
    expect(platform, 'the iPhone case stopped being a no-op').toMatch(/case \.phone: return nil/)
  })

  it('⚠️ web and Android still say "iOS" for the same iPad — flagged, not fixed', () => {
    // Not an oversight and not fixable there: only the device itself knows what
    // it is, and the wire is what is lossy. A tablet's row on another surface
    // will keep reading "iOS" until enroll sends a truer token — which needs a
    // server change. Kept as a failing-when-fixed marker so the asymmetry is
    // written down somewhere other than a commit message.
    const kt = readFileSync(
      join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Panels.kt'), 'utf8')
    expect(kt).toMatch(/"ipad"/)
    expect(kt, 'Android grew a local-hardware rule — port the note or drop this test')
      .not.toMatch(/LocalHardware|localPlatform|shownPlatform/)
  })
})
