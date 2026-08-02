// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📋 The devices footer taught a gesture the list wasn't offering.
 *
 * "Swipe a row to revoke its token." shipped as a constant sentence, while the
 * swipe itself is withheld on this phone — revoking our own token signs the app
 * out from under itself. So the footer was false in the two states a new user
 * reaches first: one iPhone and nothing else (the only row has no swipe), and a
 * necklace in range with nothing enrolled yet, where the "No devices yet" screen
 * is deliberately withheld so the pairing card can show and the list becomes the
 * card plus this footer — "0 of 20 devices. Swipe a row to revoke its token."
 *
 * `DevicesFooter` is the rule and the Swift suite tests it. What no Swift test
 * can see is that the VIEW asks it, with the count of rows the swipe is really
 * on, and that both the sentence and the gesture read the SAME predicate — the
 * defect was one place claiming what another place decides.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const WORKER = join(ROOT, 'worker/src/devices.ts')

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

/** Swift with its comments stripped: the fix is documented by quoting the bug. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

describe('the devices footer only claims what the list can do', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const view = code(body(panels, 'struct DevicesView: View {'))
  const rule = code(body(panels, 'enum DevicesFooter {'))
  const footer = code(body(panels, 'private var footer: some View {'))
  const cell = code(body(panels, 'private func cell(_ d: DeviceRow) -> some View {'))

  it('reads the file it means to read', () => {
    expect(view.length).toBeGreaterThan(3000)
    expect(rule.length).toBeGreaterThan(200)
  })

  it('the footer asks the rule instead of asserting the sentence itself', () => {
    // A pure function nothing calls is a green suite over an unchanged screen.
    expect(footer).toContain('DevicesFooter.count(total: devices.count, revocable: revocable)')
    expect(footer, 'the old constant sentence is back in the view')
      .not.toMatch(/Text\("[^"]*[Ss]wipe a row/)
    expect(footer, 'the count is being formatted in the view again')
      .not.toMatch(/of 20 devices/)
  })

  it('the sentence and the gesture read one predicate, so they cannot disagree', () => {
    // The whole defect: the footer advertised a swipe that `cell` withholds.
    expect(view).toMatch(
      /private var revocable: Int \{\s*devices\.filter \{ \$0\.revocable\(thisPhone: thisPhone\) \}\.count/)
    expect(cell, 'the swipe action stopped using the shared predicate')
      .toContain('if d.revocable(thisPhone: thisPhone)')
    expect(cell, 'a second copy of the rule is how the two drift apart')
      .not.toMatch(/swipeActions[\s\S]{0,120}d\.id != thisPhone/)
    expect(code(body(panels, 'struct DeviceRow: Identifiable {')))
      .toContain('func revocable(thisPhone: String?) -> Bool { id != thisPhone }')
  })

  it('at the cap it stops explaining how to add another', () => {
    expect(footer).toContain('if DevicesFooter.full(devices.count)')
    // The add instructions must be the ELSE — reachable only while there is room.
    const at = footer.indexOf('if DevicesFooter.full(devices.count)')
    const rest = footer.slice(at)
    const add = rest.indexOf('npx tiny-tech@latest mesh')
    const els = rest.indexOf('} else {')
    expect(els, 'no else branch — the full case replaced the offer instead of standing beside it')
      .toBeGreaterThan(-1)
    expect(add, 'the "how to add one" line is not behind the room-to-add branch')
      .toBeGreaterThan(els)
  })

  it('the command stays a literal, because Text only parses Markdown in one', () => {
    // ``npx tiny-tech@latest mesh`` renders as code in a literal and as
    // stray backticks in a runtime String, so this line cannot move into the enum.
    expect(footer).toMatch(/Text\("Add a Mac or Linux box with `npx tiny-tech@latest mesh`/)
    expect(rule, 'the enum grew a string the view can no longer render as Markdown')
      .not.toContain('npx tiny-tech')
  })

  it('the footer is on the last section, which is why the empty state reaches it', () => {
    // With a beacon in range and nothing enrolled, the pairing section IS the
    // list — the state where "swipe a row" had no rows to be true of.
    expect(code(body(panels, 'private var nearbySection: some View {')))
      .toMatch(/\} footer: \{\s*footer/)
  })

  it('the cap is the worker\'s number, traceably', () => {
    expect(rule).toContain('static let cap = 20')
    // Interpolated, so the sentences cannot drift from the constant.
    expect(rule).toMatch(/room for \\\(cap\)/)
    expect(rule).toMatch(/of \\\(cap\) devices/)
    expect(rule, 'a second literal 20 in the copy is the drift this prevents')
      .not.toMatch(/"[^"]*\b20\b[^"]*"/)
    // And it is really the worker's cap, not a matching guess.
    expect(readFileSync(WORKER, 'utf8')).toContain('const MAX_DEVICES_PER_USER = 20;')
  })
})
