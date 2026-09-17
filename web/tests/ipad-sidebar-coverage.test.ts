// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📱 "we have a lot of features but we need to iterate on the ipad"
 *
 * The iPad's whole layout is `Split.swift`: a NavigationSplitView whose sidebar
 * is meant to make every surface resident instead of buried under the phone's ⋯
 * menu. `Router.Panel` decides what the sidebar can reach — and it had drifted
 * to HALF the app:
 *
 *   enum Panel: String { case memory, jobs, toolbox, devices, messages,
 *                             nearby, map, settings }        // 8
 *
 * while ChatView carried 16 sheets. `activity`, `graph`, `sessions`,
 * `callRecordings`, `transcripts`, `universe`, `wallet` and `relayLog` all
 * existed as finished screens, all reachable on the PHONE from the overflow
 * menu, and none had a sidebar row. So on the one canvas with room for a
 * persistent list of surfaces, half of them were only reachable through the
 * gesture that list exists to replace.
 *
 * ⚠️ WHY IT DRIFTED, which is the part worth pinning: the roster lived in TWO
 * places — the enum, and eight literal `sidebarRow("brain", "Memory", .memory…)`
 * calls in the body. Adding a screen meant editing three files (enum, sidebar
 * body, ChatView's switch) and NOTHING failed if you edited two. Same shape as
 * the SHOT_LIST crib that named 15 of 16 Android routes, and as
 * `hand-kept-rosters-cant-guard-themselves`.
 *
 * The fix makes the enum the single authority: it carries title/icon/section/
 * chord, and the sidebar renders `allCases`. These pins hold that shape — a row
 * per case, no hand-written list, and a consumer switch with no `default:` so
 * the BUILD breaks on a half-wired case rather than shipping a dead row.
 */

const ROOT = process.cwd()
const SPLIT = 'ios/Tiny/Sources/Split.swift'
const VIEWS = 'ios/Tiny/Sources/Views.swift'

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Comments stripped: the prose here quotes the enum it replaced, and a
 *  whole-file scan would otherwise pass on the documentation of the bug. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

const split = code(read(SPLIT))
const views = code(read(VIEWS))

/**
 * The braces-matched body starting at the first `{` after `at`.
 *
 * ⚠️ Not a fixed char window. My first draft sliced `at + 1400` to read the
 * `title`/`icon`/`section` tables, which overran into `iconActive` — a table that
 * legitimately HAS a `default:` — so the pin failed on correct code. A
 * `.not.toMatch` is only as trustworthy as the region it reads.
 */
const braceBody = (src: string, at: number) => {
  const open = src.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(open, i)
}

/** The `Panel` cases, read out of the enum's `case` lines. */
function panelCases(): string[] {
  const at = split.indexOf('enum Panel:')
  expect(at, 'Router.Panel not found — every pin below is blind').toBeGreaterThan(-1)
  // Bounded to the enum's own declaration lines: `case` appears in the switch
  // bodies further down (title/icon/section), and those repeat every name.
  const decl = split.slice(at, split.indexOf('var id:', at))
  const out: string[] = []
  for (const m of decl.matchAll(/^\s*case\s+([a-zA-Z, ]+)$/gm)) {
    for (const n of m[1].split(',')) out.push(n.trim())
  }
  return out.filter(Boolean)
}

/** ChatView's `show…` sheet flags — the app's real inventory of surfaces. */
function sheetFlags(): string[] {
  return [...views.matchAll(/@State private var (show[A-Z][A-Za-z]*)\s*=\s*false/g)]
    .map((m) => m[1])
}

describe('the iPad sidebar reaches the whole app', () => {
  it('the roster is DERIVED from the enum, not a hand-written list of rows', () => {
    // The literal-rows shape is the defect itself: 8 calls naming 8 of 16
    // surfaces, with nothing to notice the other 8.
    expect(split, 'the sidebar no longer renders Panel.allCases — a hand-kept list of ' +
      'rows is what let the roster drift to half the app')
      .toMatch(/ForEach\(Router\.Panel\.allCases|Router\.Panel\.allCases\.filter/)
    expect(split, 'Panel is not CaseIterable, so the sidebar cannot derive its rows')
      .toMatch(/enum Panel: String, CaseIterable/)
    // And no reappearance of the literal form, scoped to the view body.
    const body = split.slice(split.indexOf('struct SidebarView'))
    expect(body, 'a hardcoded sidebarRow(icon, title, panel) is back — put the row in the enum')
      .not.toMatch(/sidebarRow\(\s*"/)
  })

  it('⚠️ every surface with a chat sheet has a sidebar row', () => {
    const cases = panelCases()
    expect(cases.length, 'no Panel cases parsed — this suite is blind').toBeGreaterThanOrEqual(14)

    // The sheets that are SURFACES, not transient pickers/importers. Excluded
    // deliberately, each for a stated reason rather than to make the test pass:
    //   camera/photos/files  — system importers, launched from the composer
    //   voicePicker          — owner-only, per-tiny, belongs beside the tiny
    //   glassesLive/tinyLive — floating overlays, not a sheet destination
    //   relayLog             — IS in the enum; listed here only as a name map
    const notASurface = new Set([
      'showCamera', 'showPhotos', 'showFiles', 'showVoicePicker',
      'showGlassesLive', 'showTinyLive',
    ])
    const flags = sheetFlags().filter((f) => !notASurface.has(f))
    expect(flags.length, 'no sheet flags parsed from ChatView — blind').toBeGreaterThanOrEqual(14)

    // `showCallRecordings` → `callRecordings`
    const want = flags.map((f) => f.slice(4)).map((n) => n[0].toLowerCase() + n.slice(1))
    const missing = want.filter((n) => !cases.includes(n)).sort()
    expect(
      missing,
      `ChatView has sheet(s) ${missing.join(', ')} that Router.Panel cannot reach, so the ` +
        `iPad sidebar has no row for them and they are reachable only from the ⋯ overflow ` +
        `menu — the phone gesture the sidebar exists to replace. Add the case (title, icon, ` +
        `section, chord) and ChatView's switch will fail to compile until it opens something.`,
    ).toEqual([])
  })

  it('⚠️ the consumer switch is exhaustive — no default: to swallow a new case', () => {
    // This is the load-bearing safety: with no `default:`, a case added to the
    // enum breaks the BUILD until it is wired to a sheet. With one, it would
    // ship a sidebar row that silently does nothing.
    const at = views.indexOf('router.$openPanel')
    expect(at, 'the openPanel consumer moved — re-anchor this pin').toBeGreaterThan(-1)
    const block = views.slice(at, views.indexOf('\n            .', at + 200))
    expect(block, 'the openPanel switch has a default: arm — a new Panel case would ' +
      'compile into a dead sidebar row instead of failing the build')
      .not.toMatch(/default\s*:/)

    // Every case reached, and each one opening something.
    for (const c of panelCases()) {
      expect(block, `Router.Panel.${c} is not handled where the sidebar's picks are consumed`)
        .toMatch(new RegExp(`case \\.${c}:\\s*show[A-Z]`))
    }
  })

  it('every row is titled, iconed and sectioned by the enum itself', () => {
    // A case with no title would render an empty row; the compiler catches it
    // only because these switches are exhaustive too. Pinned so nobody
    // "simplifies" them with a default that returns "".
    for (const table of ['var title: String', 'var icon: String', 'var section: Section']) {
      const at = split.indexOf(table)
      expect(at, `${table} is gone from Panel — rows lose their words`).toBeGreaterThan(-1)
      const body = braceBody(split, at)
      // Read something: a 20-char body means the anchor moved and the pin below
      // passes on nothing.
      expect(body.length, `${table}'s body did not parse — this pin reads nothing`)
        .toBeGreaterThan(200)
      expect(body, `${table} has a default: arm, so a new case renders a blank/duplicate row`)
        .not.toMatch(/default\s*:/)
      // Every case named, or a case falls through the switch the compiler is
      // supposed to be guarding. ⚠️ `\.name` without the `case` prefix: `section`
      // GROUPS its arms (`case .memory, .jobs, .toolbox, .graph:`), so anchoring
      // on `case \.jobs` reported a missing entry that was right there — the same
      // partial-regex mistake `store-shot-list-nav` documents for the three forms
      // of an Android openPanel dispatch.
      for (const c of panelCases()) {
        expect(body, `${table} has no entry for .${c}`).toMatch(new RegExp(`\\.${c}\\b`))
      }
    }
  })

  it('⚠️ the shipped ⌘-chords did not move', () => {
    // ⌘1–⌘8 were shipped and are muscle memory. Eight new rows arrived; if any
    // renumbering had happened, an iPad user's learned chord would now open a
    // DIFFERENT screen — worse than a chord that never existed.
    const frozen: Array<[string, string]> = [
      ['memory', '1'], ['jobs', '2'], ['devices', '3'], ['messages', '4'],
      ['nearby', '5'], ['settings', '6'], ['toolbox', '7'], ['map', '8'],
    ]
    const at = split.indexOf('var chord: Character?')
    expect(at, 'the chord table is gone').toBeGreaterThan(-1)
    const body = split.slice(at, at + 800)
    for (const [name, key] of frozen) {
      expect(body, `⌘${key} no longer opens ${name} — a moved chord opens the wrong screen ` +
        `for a hand that already learned it`)
        .toMatch(new RegExp(`case \\.${name}: return "${key}"`))
    }
  })

  it('⚠️ the sidebar shows the unread counts the ⋯ menu already showed', () => {
    // The other half of what a persistent sidebar is for. The overflow menu has
    // carried "Messages (3)" / "Activity (12)" since it was written; the sidebar
    // carried neither, so an iPad user looking straight at the word "Messages"
    // could not tell it had anything in it.
    expect(split, 'the sidebar draws no unread badge').toMatch(/private func badge\(/)
    expect(split, 'the Messages row has no unread count').toMatch(/case \.messages: return session\.unreadDms/)
    expect(split, 'the Activity row has no unread count').toMatch(/case \.activity: return session\.unreadEvents/)
    // The SAME counters the menu reads — not a second tally that can disagree.
    expect(views, 'the ⋯ menu stopped reading unreadDms — re-check which counter is authoritative')
      .toContain('session.unreadDms')
    // Drawn, not merely computed: the count has to reach the row.
    const row = split.slice(split.indexOf('private func sidebarRow'))
    expect(row.slice(0, 1200), 'the badge is computed and never rendered')
      .toMatch(/Text\("\\\(min\(count, 99\)\)"\)/)
  })

  /**
   * 🔑 The pins above all passed while the sidebar was INVISIBLE.
   *
   * Every row, section, badge and chord was correct and unreachable: `columnVisibility`
   * was `.automatic`, which hides the column at portrait width. Verified on an iPad Pro
   * 13" simulator — the app launched with the accessibility tree reading
   * `button "Show Sidebar"` and not one row on screen. A source-scanning suite cannot
   * see that, so the two facts it CAN see get pinned here.
   */
  it('⚠️ the sidebar is VISIBLE on launch, not behind a Show Sidebar tap', () => {
    const at = split.indexOf('NavigationSplitViewVisibility')
    expect(at, 'SplitRoot no longer sets column visibility — re-anchor this pin').toBeGreaterThan(-1)
    const decl = split.slice(at, split.indexOf('\n', at))
    expect(decl, 'columnVisibility is back to .automatic, which HIDES the sidebar in ' +
      'portrait — every row this suite checks would be behind an undiscovered tap')
      .not.toMatch(/=\s*\.automatic/)
    expect(decl, 'the initial visibility must ask for the sidebar').toMatch(/=\s*\.all\b/)
  })

  it('the open/closed choice is remembered across launches', () => {
    // A user who collapses the sidebar had it reopened on every cold launch. The codec
    // itself is tested in Swift (SidebarVisibilityTests, incl. the .automatic/.detailOnly
    // aliasing); this only pins that SplitRoot is actually WIRED to it — a codec nobody
    // calls is the same as no persistence.
    expect(split, 'the sidebar visibility is not persisted').toMatch(/@AppStorage\(SidebarVisibility\.key\)/)
    expect(split, 'the stored visibility is never restored on appear')
      .toMatch(/\.onAppear\s*\{\s*visibility = SidebarVisibility\.decode\(stored\)/)
    expect(split, 'a change to the sidebar is never written back')
      .toMatch(/\.onChange\(of: visibility\)/)
    // ⚠️ And the nil is respected. `stored = SidebarVisibility.encode(now)!` would
    // compile if the type changed and would persist "no opinion" as a real choice —
    // which for this type means the sidebar-hidden state. See the Swift suite.
    const onChange = split.slice(split.indexOf('.onChange(of: visibility)'))
    expect(onChange.slice(0, 400), 'encode()\'s nil (meaning ".automatic", i.e. no ' +
      'preference) is being force-unwrapped or stored, which persists the COLLAPSED state')
      .toMatch(/if let encoded = SidebarVisibility\.encode\(now\)\s*\{\s*stored = encoded/)
  })

  it('⚠️ sidebar destinations open page-sized, not as a phone-shaped card', () => {
    // Verified on the 13" sim: Transcripts opened as an ~840pt form sheet holding ONE
    // row, on a 1376pt canvas, over a dimmed sidebar. The same fixed box was given to a
    // 981-line Wallet and a 34-line Relay log, because a form sheet ignores its content.
    // The `.presentationDetents` already present don't help — detents are compact-width
    // only, so iPad regular width ignores them while the code reads as if sized.
    expect(split, 'the panelSheet() helper is gone').toMatch(/func panelSheet\(\)/)
    expect(split, 'panelSheet() no longer requests page sizing').toMatch(/presentationSizing\(\.page\)/)

    // Every SURFACE sheet uses it. Derived from the enum, so a new panel is covered:
    // these are exactly the rows the sidebar renders, and each has a chat sheet.
    const cases = panelCases()
    expect(cases.length, 'no Panel cases parsed — blind').toBeGreaterThanOrEqual(14)
    const sheetBlock = views.slice(views.indexOf('.sheet(isPresented: $showSessions)'))
    const region = sheetBlock.slice(0, sheetBlock.indexOf('\n        }'))
    expect(region.length, 'the sheet region did not parse — this pin reads nothing').toBeGreaterThan(800)

    const flagFor = (c: string) => 'show' + c[0].toUpperCase() + c.slice(1)
    const unsized: string[] = []
    for (const c of cases) {
      const flag = flagFor(c)
      const i = region.indexOf(`$${flag})`)
      if (i === -1) continue // .map has no sheet here; the enum→sheet pin above owns that
      // The closure for this sheet, brace-matched from the `{` after the `)`.
      const body = braceBody(region, region.indexOf(')', i))
      if (!/\.panelSheet\(\)/.test(body)) unsized.push(flag)
    }
    expect(
      unsized,
      `sheet(s) ${unsized.join(', ')} are sidebar destinations that still open as a ` +
        `phone-sized form card on iPad. Add .panelSheet() — it is a no-op at compact ` +
        `width, so the iPhone is unaffected.`,
    ).toEqual([])
  })

  /**
   * 🔑 EVERY PIN IN THIS FILE IS ON THE FAR SIDE OF THE LOGIN GATE.
   *
   * `RootView` is `token != nil → AdaptiveRoot`, `!onboarded → OnboardingView`,
   * else `LoginView`. So the sidebar, the panels and their sizing — this whole
   * suite — describe screens a signed-out iPad never reaches. The two screens it
   * DOES reach were the two that never got an iPad pass:
   *
   *   • `LoginView` — a 984pt sign-in button stretched edge to edge on a 1032pt
   *     canvas, under a 96pt logo, tagline centred in a field of black.
   *   • `OnboardingView` — the same full-bleed "Continue" across all 5 pages,
   *     which is what a FRESH INSTALL opens on.
   *
   * ⚠️ Neither was visible while iterating: a simulator that already holds a
   * session renders neither, and every screenshot of the sidebar work was taken
   * signed in. The gap wasn't in the code, it was in which screens got looked at.
   *
   * Both now use the readable measure already proven in this app — `frame(maxWidth:
   * 760)` then `.infinity`, the transcript/composer's "P2.4", web's max-w-4xl. A
   * no-op on every iPhone (widest is 440pt), so no size-class branch is needed.
   *
   * These pins came from a surviving mutant: M5 deleted the tour's cap and all 13
   * copy tests stayed green, because they read words and this is layout.
   */
  it('⚠️ the pre-login screens use the readable measure, not the full canvas', () => {
    const LOGIN = 'ios/Tiny/Sources/Views.swift'
    const TOUR = 'ios/Tiny/Sources/Onboarding.swift'
    for (const [file, anchor, what] of [
      [LOGIN, 'struct LoginView: View {', 'the login screen'],
      [TOUR, 'struct OnboardingView: View {', 'the onboarding tour'],
    ] as Array<[string, string, string]>) {
      const src = code(read(file))
      const at = src.indexOf(anchor)
      expect(at, `${what} moved — re-anchor this pin`).toBeGreaterThan(-1)
      const body = braceBody(src, at)
      expect(body.length, `${what}'s body did not parse — this pin reads nothing`)
        .toBeGreaterThan(600)
      // The cap AND the re-expansion. `maxWidth: 760` alone leaves the column
      // pinned to the leading edge instead of centred — a different wrong layout,
      // and one a screenshot makes obvious while a source scan for "760" does not.
      expect(body, `${what} lost its 760pt readable measure — on a 1032pt iPad canvas ` +
        `its button stretches nearly edge to edge. This is the first screen a ` +
        `signed-out iPad sees, and no other pin in this file can reach it.`)
        .toMatch(/\.frame\(maxWidth: 760\)/)
      expect(body, `${what} caps at 760 but never re-expands, so the column sits ` +
        `against the leading edge instead of centred`)
        .toMatch(/\.frame\(maxWidth: 760\)\s*\.frame\(maxWidth: \.infinity\)/)
    }
  })

  it('the transient pickers are deliberately NOT page-sized', () => {
    // The opposite mistake, and the reason panelSheet() is applied per-sheet rather than
    // to the whole chain: a page-sized card for one row of voices, or for the system
    // share sheet, is as wrong as a stamp-sized Wallet. Their detents are real on phone.
    //
    // ⚠️ Brace-matched, not a 400-char window — and I made that mistake HERE too, one
    // test after documenting it for `braceBody` above. The window ran off the end of the
    // share sheet's closure into `.sheet($showNearby) { NearbyView().panelSheet() }` and
    // failed correct code by reading a neighbour's body. 🔑 Knowing the lesson is not the
    // same as applying it; anchor to the construct, never to a character count.
    for (const [anchor, name] of [
      ['.sheet(item: $shareURL)', 'the system share sheet'],
      ['.sheet(isPresented: $showVoicePicker)', 'the voice picker'],
    ] as Array<[string, string]>) {
      const at = views.indexOf(anchor)
      expect(at, `${name} moved — re-anchor this pin`).toBeGreaterThan(-1)
      const body = braceBody(views, at)
      expect(body.length, `${name}'s closure did not parse — this pin reads nothing`)
        .toBeGreaterThan(40)
      expect(body, `${name} was made page-sized; a page-sized card for a few rows of ` +
        `choices is the same mistake as a stamp-sized Wallet, in the other direction`)
        .not.toMatch(/\.panelSheet\(\)/)
      expect(body, `${name} lost the detents that are its real behaviour on phone`)
        .toMatch(/presentationDetents/)
    }
  })
})
