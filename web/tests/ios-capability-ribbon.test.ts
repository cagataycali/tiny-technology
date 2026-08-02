// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎗️ The capability ribbon was the largest thing in every device row.
 *
 * A laptop enrolls twelve capabilities — `npx tiny-tech mesh` sends one per
 * resolved device tool — and the row drew all twelve as grey pills, wrapping to
 * five lines under a one-line name. The row exists to answer two questions
 * ("which device is this", "can I reach it") and the answer to neither was the
 * biggest element in it.
 *
 * `CapabilityRibbon` is the rule and the Swift suite tests it exhaustively. What
 * no Swift test can see is whether the VIEW asks — a cap nothing calls leaves the
 * pill-wall on screen with a green suite either side of it — and, worse, whether
 * the row's SPOKEN label got shortened along with the visible one. The cap is a
 * width problem; a spoken row has no width, so VoiceOver must still hear all
 * twelve. That asymmetry is invisible from inside Swift and is what this pins.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')

/** Source of `struct <name>: View { … }`, brace-matched. */
function structBody(source: string, name: string): string {
  const at = source.search(new RegExp(`struct\\s+${name}\\s*:\\s*View\\s*\\{`))
  expect(at, `struct ${name} not found — renamed?`).toBeGreaterThan(-1)
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

/** Swift with its comments removed — the fix is documented by quoting the bug. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('the device row caps its capability ribbon', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const row = structBody(panels, 'DeviceRowView')

  it('reads the file it means to read', () => {
    expect(row.length).toBeGreaterThan(1500)
    expect(panels).toContain('enum CapabilityRibbon')
    expect(panels).toContain('static func split(_ caps: [String], expanded: Bool)')
  })

  it('the chips the row draws are the ones the RULE returned', () => {
    // The defect shape: `ForEach(d.capabilities)` — the rule computed, the view
    // ignoring it. Both halves asserted, because adding the call without
    // changing the ForEach leaves the wall exactly where it was.
    const body = code(row)
    expect(body).toMatch(/CapabilityRibbon\.split\(d\.capabilities, expanded: showAllCapabilities\)/)
    expect(body).toMatch(/ForEach\(ribbon\.shown, id: \\\.self\)/)
    expect(body, 'the ribbon is drawing the whole list again')
      .not.toMatch(/ForEach\(d\.capabilities, id: \\\.self\)/)
  })

  it('a capped row says so, from the same rule that capped it', () => {
    // A ribbon silently cut to four is worse than a long one: nothing on screen
    // would say the device can do anything else.
    const body = code(row)
    expect(body).toMatch(/CapabilityRibbon\.toggleLabel\(d\.capabilities,/)
    expect(body).toMatch(/showAllCapabilities\.toggle\(\)/)
    // Recomputed from the full list, never from the truncated slice — counting
    // `ribbon.shown` would make the control claim a number it can't see.
    expect(body, 'the control is counting the visible chips')
      .not.toMatch(/toggleLabel\(ribbon\.shown/)
  })

  it('the toggle is real state on the row, so it survives a poll', () => {
    expect(row).toMatch(/@State private var showAllCapabilities = false/)
  })

  it('the spoken row still enumerates EVERY capability', () => {
    // The asymmetry the cap must not break. `.accessibilityElement(children:
    // .combine)` makes this string the only one VoiceOver reads, so shortening
    // it here deletes the facts rather than deferring them.
    //
    // Assembled in `DeviceOrder.spokenLabel` since the spoken row also had to
    // start naming the hardware; the rule is unchanged and so is this pin, it
    // just reads the function that owns the string instead of the call site.
    const at = panels.indexOf('static func spokenLabel(')
    expect(at, 'spokenLabel not found — renamed?').toBeGreaterThan(-1)
    const label = panels.slice(at, panels.indexOf('\n    }', at))
    expect(label).toContain('d.capabilities.map(capabilityLabel).joined(separator: ", ")')
    expect(label, 'VoiceOver got the truncated ribbon instead of the fleet')
      .not.toMatch(/ribbon\.shown|CapabilityRibbon\./)
    // …and the view asks for it, rather than assembling a shorter one inline.
    expect(row.slice(row.indexOf('.accessibilityLabel(')))
      .toContain('.accessibilityLabel(DeviceOrder.spokenLabel(')
  })

  it('the cap is one number, not a literal sprinkled through the view', () => {
    const ribbon = panels.slice(panels.indexOf('enum CapabilityRibbon'))
    const body = code(ribbon.slice(0, ribbon.indexOf('\n}\n') + 3))
    expect(body).toMatch(/static let cap = \d+/)
    // `> cap + 1`, not `> cap`: "+1 more" is a chip that hides a chip, so the cap
    // may only fire where it buys back at least two.
    expect(body).toMatch(/caps\.count > cap \+ 1/)
    expect(body).toMatch(/Array\(caps\.prefix\(cap\)\)/)
    expect(body, 'a hardcoded count is back in the rule').not.toMatch(/prefix\(4\)|count > 5/)
  })

  it('the rule is pure, so Swift can test it without a device', () => {
    const ribbon = panels.slice(panels.indexOf('enum CapabilityRibbon'))
    const body = ribbon.slice(0, ribbon.indexOf('\n}\n') + 3)
    expect(body).not.toMatch(/@State|@Environment|DeviceRow|\.shared/)
  })

  it('the toggle chip does not disguise itself as a capability', () => {
    // Every other chip in the strip is secondary grey and says something; this
    // one DOES something. A twelfth identical pill that happens to be tappable
    // is a control nobody finds.
    const body = code(row)
    const chip = body.slice(body.indexOf('CapabilityRibbon.toggleLabel'))
    expect(chip).toMatch(/foregroundStyle\(accent\)/)
    expect(chip).toMatch(/\.contentShape\(Capsule\(\)\)/)
    // Still ribbon-shaped, though: same 7/3 padding as CapabilityChip.
    expect(chip).toMatch(/\.padding\(\.horizontal, 7\)\.padding\(\.vertical, 3\)/)
    expect(panels.slice(panels.indexOf('struct CapabilityChip')))
      .toMatch(/\.padding\(\.horizontal, 7\)/)
  })

  // The ⚠️ marker that used to sit here — "Android still draws the whole wall",
  // written to FAIL when the Kotlin row got the same cap — has been collected:
  // Android now caps at four through its own `CapabilityRibbon`. The pins that
  // replace it are in tests/nicla-android-parity.test.ts ("neither strip
  // outweighs the name it sits under"), which holds both phones to the same cap
  // and the same `> cap + 1` rule, and records the ONE place they legitimately
  // diverge: iOS's `.combine` merge makes the spoken row free, while Compose
  // gives every capability its own semantics node, so Android has to speak the
  // hidden labels itself.
})
