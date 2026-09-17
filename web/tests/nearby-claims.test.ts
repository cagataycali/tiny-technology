// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 Four surfaces answer "what's nearby", and three of them decided it alone.
 *
 * `BleEmptyState` was extracted (inc "the pairing card") for one reason: a list
 * with no rows in it must not claim the room is empty when the truth is that
 * nothing looked. Only the devices panel ever adopted it. The other three kept
 * their own chains, each missing the same two arms — a phone with no radio, and
 * a scan that never ran:
 *
 *   • `NearbyView` (Views.swift) — `scanning` FIRST, so an unavailable radio read
 *     as "Scanning…" for the window, then "No devices found yet." The exact
 *     ternary the enum's own doc comment describes as the bug.
 *   • `adopt()` (Panels.swift) — "Couldn't see the necklace nearby. Bring it
 *     closer" sends someone walking toward a phone that never switched its radio
 *     on.
 *   • `scanSummary()` (Bluetooth.swift) — the worst of the three, because its
 *     text is appended to the agent's prompt: "No BLE devices discovered nearby."
 *     leaves the phone as a sentence the model states as fact about the user's
 *     room.
 *
 * `BleEmptyState.situation` is the one classification now. `message` is the
 * caption, `obstacle` is the phone-side reason — and **nil from `obstacle` is the
 * only licence to claim an empty room**, which is why both callers are written
 * `obstacle(…) ?? "<their own sentence>"`: the check sits in front of the claim.
 *
 * `BleEmptyStateTests` and `BleObstacleTests` (Swift) own the words and the
 * verdicts. These pins own what only the source can show — that no surface has
 * gone back to deciding for itself.
 */

const ROOT = process.cwd()
const IOS = join(ROOT, 'ios/Tiny/Sources')
const SRC = (f: string) => join(IOS, f)

/** Comments stripped: the new docs quote every removed chain verbatim. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

/** Every Swift source in the app target — the count asserted, because a glob
 *  that finds nothing turns every `.not.toContain` below into a green no-op. */
const EVERY_SWIFT = readdirSync(IOS).filter(f => f.endsWith('.swift'))

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

/** A block, with its anchor ASSERTED — an unfound anchor makes `slice` return a
 *  character, on which every `.not.toMatch()` passes forever. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('a nearby list only claims an empty room when it looked', () => {
  it('the radio-state strings live in one place', () => {
    expect(EVERY_SWIFT.length, 'the source scan found almost nothing — these pins are vacuous')
      .toBeGreaterThan(40)
    // ⚠️ THE DEFECT, as a regex. `state == "unauthorized"` is a surface deciding
    // for itself, and every copy of it was missing an arm. The enum's `switch`
    // spells the same strings as `case "unauthorized":`, so this catches the
    // COMPARISON form only — the one a caller writes.
    for (const f of EVERY_SWIFT) {
      expect(code(readFileSync(SRC(f), 'utf8')), `${f} decides the radio state itself again`)
        .not.toMatch(/state == "(unauthorized|poweredOff|unsupported)"/)
    }
    // And the classification is a single switch, not one per wording. Two `case
    // "unauthorized":` would mean `message` and `obstacle` can drift on which
    // situation an input IS, which is the whole thing being single-sourced.
    const ble = code(readFileSync(SRC('Bluetooth.swift'), 'utf8'))
    expect(ble.match(/case "unauthorized"/g)?.length,
      'the radio-state switch was duplicated — the two registers can now disagree').toBe(1)
    expect(body(ble, 'static func situation('), 'situation stopped ranking the radio first')
      .toMatch(/switch state \{[\s\S]*case "unauthorized": return \.noPermission/)
    // Both registers read the SAME verdict. If either inlined its own branching,
    // the caption could say "looking" while the agent said "nothing is there".
    expect(ble.match(/situation\(scanning: scanning, state: state, completedScan: completedScan\)/g)?.length,
      'message and obstacle no longer both delegate to situation').toBe(2)
  })

  it('no surface still tells the reader a scan happened that did not', () => {
    // The old sentences, gone from every source. "No devices found yet." was
    // NearbyView's; it is the flat claim the enum's doc names as the bug.
    for (const f of EVERY_SWIFT) {
      const src = code(readFileSync(SRC(f), 'utf8'))
      expect(src, `${f} still claims an empty room outright`)
        .not.toContain('No devices found yet.')
      // ⚠️ Not the sentence itself — `scanSummary` still ends in "No BLE devices
      // discovered nearby." and must. What may not come back is the CHAIN that
      // reached it without asking whether anything looked.
      expect(src, `${f} words the permission case its own way again`)
        .not.toContain('Bluetooth permission denied on the phone.')
    }
  })

  it('every surface that can claim an empty room asks first', () => {
    // The `??` shape is the pin: `obstacle` on the left of the fallback means the
    // check is in front of the claim and cannot be skipped by omission.
    const CALLERS = [
      { file: 'Bluetooth.swift', fn: 'func scanSummary(', own: 'No BLE devices discovered nearby.' },
      { file: 'Panels.swift', fn: 'private func adopt() async {', own: "Couldn't see the necklace nearby." },
    ]
    for (const { file, fn, own } of CALLERS) {
      const region = body(code(readFileSync(SRC(file), 'utf8')), fn)
      expect(region, `${file}: ${fn} stopped asking for the obstacle`)
        .toMatch(/BleEmptyState\.obstacle\(scanning: [\w.]*scanning, state: [\w.]*state,/)
      expect(region, `${file}: the obstacle is no longer what gates the claim`)
        .toMatch(/completedScan: [\w.]*completedScan\)\s*\n\s*\?\?/)
      // Its own sentence for the one case it owns — a caller that lost this is
      // not fixed, it is silent.
      expect(region, `${file} lost its found-nothing sentence`).toContain(own)
    }
    // The caption surfaces, which have no sentence of their own to write.
    for (const { file, fn } of [
      { file: 'Views.swift', fn: 'struct NearbyView: View {' },
      { file: 'Panels.swift', fn: 'private var nearbySection: some View {' },
    ]) {
      expect(body(code(readFileSync(SRC(file), 'utf8')), fn), `${file}: ${fn} stopped asking the rule`)
        .toMatch(/BleEmptyState\.message\(scanning: ble\.scanning, state: ble\.state,\s*\n\s*completedScan: ble\.completedScan\)/)
    }
  })

  it('every caller of the rule is a declared one', () => {
    // An enumeration, not a count: a new surface asking the shared rule is the
    // desired outcome, so it gets a line and a reason here. Per FILE, because a
    // caller gained in one place while another lost one sums to the same total.
    const DECLARED: Record<string, string[]> = {
      'Bluetooth.swift': ['scanSummary — the text appended to the agent’s prompt'],
      'Panels.swift': [
        'nearbySection — the pairing card’s caption under an empty list',
        'adopt — why the necklace could not be seen',
      ],
      'Views.swift': ['NearbyView — the iPad sidebar’s nearby list'],
    }
    const found: Record<string, number> = {}
    for (const f of EVERY_SWIFT) {
      const src = code(readFileSync(SRC(f), 'utf8'))
      const n = (src.match(/BleEmptyState\.(message|obstacle)\(/g) ?? []).length
      if (n) found[f] = n
    }
    expect(found, 'a surface joined or left the shared rule — give it a line and a reason')
      .toEqual(Object.fromEntries(Object.entries(DECLARED).map(([f, r]) => [f, r.length])))
  })

  it('the scanner still tracks whether a scan ever ran', () => {
    // Everything above rests on `completedScan` meaning what it says. It is set
    // in exactly one place — a scan that WAS running and is now stopped — and
    // cleared when a new one is asked for.
    const ble = code(readFileSync(SRC('Bluetooth.swift'), 'utf8'))
    expect(body(ble, 'func stopScan() {'), 'a stopped scan no longer counts as having looked')
      .toMatch(/if scanning \{ completedScan = true \}/)
    expect(body(ble, 'func startScan('), 'a new scan inherits the last one’s verdict')
      .toMatch(/completedScan = false/)
    // Published, or the caption cannot see it change.
    expect(ble, 'completedScan stopped being observable')
      .toMatch(/@Published private\(set\) var completedScan = false/)
  })

  it('⚠️ FAILS WHEN FIXED: Android answers the same question with less to go on', () => {
    // One agent reads whichever phone answered, so the sentence a completed scan
    // produces is shared BYTE FOR BYTE and pinned on both sides. The rest is not:
    // Android's `summaryText` takes no `completedScan` at all, so it still reports
    // an empty room for a scan that never ran — the defect this increment closed
    // on iOS. Android belongs to another loop, so this REPORTS rather than fixes;
    // when that loop lands the third argument, this test says so.
    const kt = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/Bluetooth.kt')
    if (!existsSync(kt)) return // Android tree not checked out
    const src = readFileSync(kt, 'utf8')
    expect(code(readFileSync(SRC('Bluetooth.swift'), 'utf8')),
      'iOS renamed the found-nothing line — the two clients now answer the agent differently')
      .toContain('No BLE devices discovered nearby.')
    expect(src, 'Android renamed it too — recheck the pair together')
      .toContain('No BLE devices discovered nearby.')
    expect(/fun summaryText\([^)]*completedScan/.test(src),
      '🎉 Android’s summaryText learned whether a scan ran — port the situation split and drop this')
      .toBe(false)
  })
})
