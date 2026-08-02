// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎙️ "out of range" and a green "listening", on the same line.
 *
 * `VoiceStatus` is a last-known reading: NiclaVoiceGateway clears `status` in
 * `forget()` only — never on disconnect, deliberately, because a wake delivered
 * over a link that dropped a second later still has to reach the row. So the
 * panel's badge kept saying "listening", in the present tense and in green, about
 * a necklace this phone could no longer hear. The detail line beside it
 * (`3 wake words · 12 heard · up 11h`) had the gate and went away as it should,
 * which is the tell: one struct, two readings of the same object, and only the
 * present-tense one was ungated.
 *
 * `VoiceFmt.live` is the gate, and the Swift suite tests it. What no Swift test
 * can see is whether the VIEW asks — a gate nothing calls is dead code, and the
 * badge would go on outliving its link with a green suite either side of it.
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

describe('the voice panel stops speaking for a board it cannot hear', () => {
  const panels = readFileSync(PANELS, 'utf8')

  it('reads the file it means to read', () => {
    expect(structBody(panels, 'VoiceDevicePanel').length).toBeGreaterThan(1500)
    expect(panels).toContain('static func live(_ s: VoiceStatus?, connected: Bool) -> VoiceStatus?')
  })

  it('EVERY status read in the panel goes through the gate', () => {
    // Counted rather than spot-checked: the bug was one ungated read among two,
    // so "a call to live() exists somewhere" is exactly the assertion that would
    // have passed on the broken panel.
    const panel = code(structBody(panels, 'VoiceDevicePanel'))
    const reads = panel.match(/gw\.status/g)?.length ?? 0
    const gated = panel.match(/VoiceFmt\.live\(gw\.status, connected: gw\.connected\)/g)?.length ?? 0
    expect(reads, 'the panel stopped reading status at all — did the badge go?').toBeGreaterThan(1)
    expect(gated, 'an ungated status read is back in the panel').toBe(reads)
    // The exact line that shipped, pinned so a revert names itself.
    expect(panel, 'the badge is reading last-known status again')
      .not.toMatch(/if let s = gw\.status \{/)
  })

  it('the badge still tells deaf apart from listening', () => {
    // The fix must not swallow the badge whenever it is inconvenient: a loaded
    // board with a dead mic looks identical from outside, and this is the only
    // surface that shows it. Only the LINK gates it.
    const panel = structBody(panels, 'VoiceDevicePanel')
    expect(panel).toContain('Label(s.listening ? "listening" : "not listening",')
    expect(panel).toMatch(/foregroundStyle\(s\.listening \? \.green : \.orange\)/)
  })

  it('history is not gated — a wake that happened, happened', () => {
    // Timestamped events stay true after the link drops, and gating them would
    // erase the wake list every time the necklace left the room. Only the
    // present-tense reading is withheld.
    const panel = code(structBody(panels, 'VoiceDevicePanel'))
    expect(panel).toMatch(/if !gw\.wakes\.isEmpty \{/)
    expect(panel, 'the wake history got gated on the live link')
      .not.toMatch(/VoiceFmt\.live\(gw\.wakes/)
  })

  it('the panel still says why it has nothing to report', () => {
    // The withheld badge is only honest next to a line that explains the
    // silence — the same rule the camera panel's asleep state follows.
    expect(structBody(panels, 'VoiceDevicePanel'))
      .toContain('Text(gw.connected ? "relayed by this phone" : "out of range")')
  })

  it('the gate is a pure function, so Swift can test it without a radio', () => {
    const fn = panels.slice(panels.indexOf('static func live(_ s: VoiceStatus?'))
    const body = code(fn.slice(0, fn.indexOf('\n    }') + 6))
    expect(body).toMatch(/connected \? s : nil/)
    expect(body, 'the gate reached for the singleton and stopped being testable')
      .not.toMatch(/NiclaVoiceGateway|\.shared/)
  })
})
