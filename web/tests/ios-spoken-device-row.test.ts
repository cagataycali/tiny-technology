// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔊 The devices list told a listener the least about the device.
 *
 * `.accessibilityElement(children: .combine)` merges the row into one element,
 * and an explicit `.accessibilityLabel` on a merged element REPLACES everything
 * inside it. So the glyph (hidden), the "this iPad" pill, the capability chips
 * and the whole second line contribute nothing, and the label was:
 *
 *     "<name>, online, can camera, mic"
 *
 * A phone, a Mac, a necklace and a robot, spoken in one shape, told apart only by
 * a name their owner chose — while the screen beside them said "iPad", "Flipper
 * Zero", "Nicla Vision", "p1s.ada.tiny.tech". The endpoint robot fared worst: its
 * descriptor IS its address, which `DeviceRow.descriptor` documents as "the fact
 * the owner actually can't get anywhere else on this screen", and the row never
 * said it out loud.
 *
 * `DeviceOrder.spokenLabel` is the rule and the Swift suite tests it. What no
 * Swift test can see is that the merge is still what makes this string the row's
 * ONLY voice — and that the view asks for it with the LIVE hardware shape rather
 * than the `.phone` default, which is the identity case and would silently take
 * the iPad's announcement back to "this phone".
 *
 * Android needs no equivalent: Compose does not merge this row, so TalkBack
 * already reads its subtitle and every chip as their own nodes. That asymmetry —
 * and the fact that it makes iOS's visual cap free and Android's costly — is
 * pinned in tests/nicla-android-parity.test.ts, so it is not restated here.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')

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

function structBody(source: string, name: string): string {
  const at = source.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** A `static func`'s body, brace-matched from its declaration. */
function funcBody(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/** Swift with its comments stripped: the fix is documented by quoting the bug. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('the device row says out loud what it shows on screen', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const row = structBody(panels, 'DeviceRowView')
  const spoken = code(funcBody(panels, 'static func spokenLabel('))

  it('reads the file it means to read', () => {
    expect(row.length).toBeGreaterThan(1500)
    expect(spoken.length).toBeGreaterThan(300)
  })

  it('the row asks for the spoken label, with the live shape', () => {
    // A pure function nothing calls is a green suite over an unchanged screen.
    // And `shape` defaults to `.phone` BECAUSE that changes nothing, which is
    // exactly what makes a forgotten argument invisible: an iPad would go back
    // to announcing itself as "this phone" with every Swift test still passing.
    expect(code(row)).toContain(
      '.accessibilityLabel(DeviceOrder.spokenLabel(d, isThisPhone: isThisPhone, shape: shape))')
    expect(code(row), 'the row lost its shape and would speak the default')
      .toMatch(/private var shape: LocalHardware\.Shape \{ LocalHardware\.current \}/)
  })

  it('one assembly, not two — the row does not build a spoken string of its own', () => {
    // The bug was an inline label in the view; leaving a second assembly behind
    // is how the two drift, and the view's copy is the one that wins.
    const body = code(row)
    expect(body, 'the view is assembling presence into a label again')
      .not.toMatch(/accessibilityLabel\([\s\S]{0,200}d\.presence\.label/)
    expect(body, 'the view is enumerating capabilities into a label again')
      .not.toMatch(/accessibilityLabel\([\s\S]{0,200}d\.capabilities/)
  })

  it('the label is the row\'s only voice, which is why it must carry everything', () => {
    // Each of these is a fact the merge swallows. If the merge or the hiding ever
    // goes away, `spokenLabel` is restating things VoiceOver would read anyway
    // and this test is the note to reconsider it.
    const body = code(row)
    expect(body).toContain('.accessibilityElement(children: .combine)')
    // The glyph is decoration for the eye — "ipad" spoken as a symbol name is
    // noise, and it is the one part of the row that already has a word.
    expect(body).toMatch(/Image\(systemName: deviceGlyph\([\s\S]{0,600}?accessibilityHidden\(true\)/)
    // Same for the dot: three shapes for an eye, nothing for an ear, and the word
    // it stands for is in the label already.
    expect(code(structBody(panels, 'DeviceRowView'))
      .slice(row.indexOf('private var presenceDot')))
      .toMatch(/accessibilityHidden\(true\)/)
    // …and the pill, the second line and the chips are plain child views: no
    // element of their own to be read separately.
    expect(body).toContain('Text(LocalHardware.selfPill(shape))')
    expect(body).toContain('Text(DeviceOrder.rowLine(d, isThisPhone: isThisPhone, shape: shape))')
  })

  it('every fact the two visible lines carry is in the spoken string', () => {
    // Name, hardware-or-address, presence, capabilities — the union of the name
    // row and the presence row. Read as source rather than as strings so a fact
    // being DROPPED fails here even when the Swift examples still pass.
    expect(spoken).toContain('d.name')
    expect(spoken).toContain('d.descriptor')
    expect(spoken).toContain('d.presence.label(lastSeen: d.lastSeen)')
    expect(spoken).toContain('d.capabilities.map(capabilityLabel).joined(separator: ", ")')
    expect(spoken).toContain('LocalHardware.selfPill(shape)')
  })

  it('it states presence in full, where the visible line may omit it', () => {
    // `rowLine` drops the presence word when the section header above already
    // says it. A row read aloud has no header above it, so the spoken row must
    // not inherit that omission — the omission's own doc comment says so.
    expect(spoken, 'the spoken row adopted the visible row\'s omission')
      .not.toMatch(/rowLine|groupTitles/)
    const visible = code(funcBody(panels, 'static func rowLine('))
    expect(visible).toMatch(/caseInsensitiveCompare\(word\) == \.orderedSame/)
  })

  it('it does not say the same noun twice, and the test is not the reason why', () => {
    // "this iPad, iPad, online" is what parity with the screen would give: the
    // pill and the descriptor are one word on a tablet and on a Mac. An eye skips
    // that repeat and an ear cannot. Dropped by CONTAINMENT rather than by a
    // shape switch, so "this phone, iOS" — where the second word is a fact the
    // first doesn't carry — survives.
    expect(spoken).toMatch(/localizedCaseInsensitiveContains\(d\.descriptor\)/)
    expect(spoken, 'the dedupe became a per-shape rule and a phone lost "iOS"')
      .not.toMatch(/case \.pad|shape == \./)
  })

  it('an empty part does not open the row with a comma', () => {
    // A blank server name (`dev["name"] as? String` keeps "") and a device whose
    // kind has no word leave holes in the middle of the join.
    expect(spoken).toMatch(/\.filter \{ !\$0\.isEmpty \}/)
    expect(spoken).toMatch(/\.joined\(separator: ", "\)/)
  })
})
