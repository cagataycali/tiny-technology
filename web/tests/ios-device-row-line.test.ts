// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔁 A row must not echo the header two lines above it.
 *
 * The devices sheet states presence three times per row: the section header, the
 * dot, and the word. In two of the four sections the word was a VERBATIM copy of
 * its own header — "Online" over `online · Mac`, and worst, "Reachable when
 * called" over `reachable when called · p1s.ada.tiny.tech…`, where 24 characters
 * of echo truncated the address that row exists to show. "Offline" is different:
 * the row answers with `seen 3 days ago`, and "3 minutes ago" vs "in March" is
 * the entire question being asked.
 *
 * `DeviceOrder.rowLine` decides it by COMPARING the row's presence word to its
 * own section title, so renaming a header keeps the rule true. Which means the
 * rule is only sound while three things hold, and no Swift test can see any of
 * them: that the view calls it at all, that the header on screen is drawn from
 * the same `groupTitles` the comparison reads, and that VoiceOver still speaks
 * the word in full — the omission is justified by a header being VISIBLE above
 * the row, and a row read aloud has no header above it.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')

/** Source of `struct <name>: View { … }`, brace-matched. */
function structBody(source: string, name: string): string {
  const at = source.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** Source of a func/enum, from a needle to its matching close brace. */
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

function funcBody(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/**
 * Swift with its comments removed, for the NEGATIVE needles: this fix is
 * documented at its own site and quotes the exact line it replaced, so a raw
 * scan would flag the explanation as the bug.
 */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('the row line says what its section header does not', () => {
  const panels = readFileSync(PANELS, 'utf8')

  it('reads the files it means to read', () => {
    // A brace-matcher that silently returned "" would make the rest pass forever.
    expect(structBody(panels, 'DeviceRowView').length).toBeGreaterThan(400)
    expect(funcBody(panels, 'static func rowLine(').length).toBeGreaterThan(200)
    expect(panels).toContain('enum DeviceOrder {')
  })

  it('the row renders rowLine — a rule nothing calls is dead code', () => {
    const row = code(structBody(panels, 'DeviceRowView'))
    expect(row, 'the row went back to echoing its header')
      .not.toMatch(/Text\(d\.presenceLine\)/)
    // `shape` travels with it: section 0's header is named after this device
    // ("This iPad" — LocalHardware), so a row comparing itself against the
    // default `.phone` title would answer for a screen nobody is looking at.
    expect(row).toMatch(
      /Text\(DeviceOrder\.rowLine\(d, isThisPhone: isThisPhone, shape: shape\)\)/)
  })

  it('the string it compares against is the string on screen', () => {
    // The whole rule is "is my word my header?", so a header drawn from anywhere
    // other than `groupTitles` would compare the row against a title nobody sees.
    // Three links, each pinned: the comparison reads groupTitles, the group
    // carries that exact title, and the List renders that title.
    // `groupTitles` became a function OF THE SHAPE for exactly this reason: with
    // section 0 named after the local hardware, a `static let` would have left
    // the comparison reading "This phone" while the header said "This iPad".
    expect(code(funcBody(panels, 'static func rowLine('))).toMatch(/groupTitles\(shape\)\[rank\(/)
    expect(code(funcBody(panels, 'static func grouped(')))
      .toMatch(/groupTitles\(shape\)\.enumerated\(\)/)
    expect(code(panels)).toMatch(/DeviceGroup\(id: title, title: title, rows: bucket\)/)
    expect(code(panels), 'the section header stopped rendering the group title')
      .toMatch(/\} header: \{\s*Text\(g\.title\)/)
  })

  it('the rule is a comparison, not a hard-coded list of ranks', () => {
    // `rank == 1 || rank == 2` passes every test above and rots the moment a
    // header is reworded or a fifth section appears: the row would go on hiding a
    // word that no longer matches anything, or echo one that now does.
    const body = code(funcBody(panels, 'static func rowLine('))
    expect(body, 'rowLine is matching rank literals again').not.toMatch(/rank\([^)]*\)\s*==\s*\d/)
    expect(body).toMatch(/caseInsensitiveCompare\(word\) == \.orderedSame/)
  })

  it('one definition of which section a row is in', () => {
    // rowLine asks the row's own question ("am I this phone?") because a row view
    // has no device id. A second switch on presence under the other spelling is a
    // row printing the line for a section it is not in.
    const byId = code(funcBody(panels, 'static func rank(_ d: DeviceRow, myDeviceId:'))
    expect(byId, 'the id spelling grew its own copy of the buckets')
      .not.toMatch(/case \.online:/)
    expect(byId).toMatch(/rank\(d, isThisPhone: d\.id == myDeviceId\)/)
  })

  it('VoiceOver still hears the word in full — it has no header above it', () => {
    // This is the assertion the omission RESTS on. A screen reader walks rows; the
    // section title is not part of the row's combined label, so a row that only
    // said "studio-mac, Mac" would have lost presence entirely for the one user
    // who cannot glance up at the header.
    //
    // The label moved into `DeviceOrder.spokenLabel` — beside `rowLine`, because
    // the two are renderings of one set of facts and the rules for what each may
    // omit only read straight against each other. So the pin follows it: the
    // clause is the same clause, in the function that now owns it.
    const spoken = code(funcBody(panels, 'static func spokenLabel('))
    expect(spoken).toContain('d.presence.label(lastSeen: d.lastSeen)')
    expect(spoken, 'the spoken row adopted the visible row\'s omission')
      .not.toMatch(/rowLine/)
    // And the view asks for it, or none of the above is on screen.
    const row = structBody(panels, 'DeviceRowView')
    expect(row).toContain(
      '.accessibilityLabel(DeviceOrder.spokenLabel(d, isThisPhone: isThisPhone, shape: shape))')
  })

  it('the dot still carries presence for anyone scrolled past the header', () => {
    // List headers scroll away. The dot is the row's own copy of the fact, and it
    // is the copy that costs nothing: three shapes, so it survives colour
    // blindness and a monochrome screenshot.
    const row = code(structBody(panels, 'DeviceRowView'))
    expect(row).toMatch(/private var presenceDot: some View/)
    expect(row, 'the dot left the line it shares with the words')
      .toMatch(/presenceDot\s*\n[\s\S]{0,600}?Text\(DeviceOrder\.rowLine/)
  })

  it('web keeps its word, because a flat list has no header to echo', () => {
    // Not a parity gap — the opposite. /devices renders one flat <ul>, so its row
    // is the ONLY place presence is written there. Copying this omission across
    // would delete the fact instead of de-duplicating it. If web ever grows
    // sections, this test fails and that decision gets made on purpose.
    const web = readFileSync(join(ROOT, 'app/devices/page.tsx'), 'utf8')
    expect(web, 'the web device list is no longer flat — revisit rowLine parity')
      .toMatch(/<ul className="space-y-2">\s*\{devices\.map\(\(d\) => \(/)
    expect(web).toContain('const presenceOf = (d: Device)')
  })
})
