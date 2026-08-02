// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📷 A sleeping board is not a broken camera.
 *
 * `RelayCameraPanel` fetched a frame on `.task` — every appearance, presence
 * unread. Open My devices with a necklace asleep in a drawer and the sheet spent
 * a POST plus sixteen polls, nineteen seconds, on a device that by the worker's
 * own definition wasn't listening: `PULL_KINDS` in worker/src/
 * devices.ts is documented as the kinds that "hold a `tind_` token, heartbeat,
 * poll the relay" — one loop, both jobs — so a device outside the 60s presence
 * window is not reading the relay either. Then it painted the silence in orange
 * as "No frame in 19s — is the camera awake?", directly beneath a row that
 * already said "seen 3 days ago". The camera was awake. The board was gone.
 *
 * `FlipperDevicePanel`, one row down on the same sheet and over the same relay,
 * had already worked this out and written down why the wording matters as much
 * as the call: "Saying 'Flipper offline' sends the user to unplug a working
 * cable." So the rule is now one function both panels ask.
 *
 * The Swift suite tests `RelayReach` itself. What no Swift test can see is
 * whether the VIEW obeys it — a rule nothing calls is dead code, and the sheet
 * would go on spending round-trips with a green suite either side of it.
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

/**
 * Swift with its comments removed, for the NEGATIVE needles: every fix here is
 * documented at its own site, quoting the exact line it replaced, so a raw scan
 * would flag the fix's own explanation as the bug.
 */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '')

describe('a relay panel reads presence before it spends a round-trip', () => {
  const panels = readFileSync(PANELS, 'utf8')

  it('reads the files it means to read', () => {
    // A brace-matcher that silently returned "" would make the rest pass forever.
    expect(structBody(panels, 'RelayCameraPanel').length).toBeGreaterThan(2000)
    expect(structBody(panels, 'FlipperDevicePanel').length).toBeGreaterThan(1000)
    expect(panels).toContain('enum RelayReach {')
  })

  it('the camera panel is TOLD the presence — it cannot guess', () => {
    // A panel that can't see presence can't gate on it, so this is the pin that
    // has to hold before any of the others mean anything.
    const cam = code(structBody(panels, 'RelayCameraPanel'))
    expect(cam, 'RelayCameraPanel stopped taking presence').toMatch(/let presence: DevicePresence/)
    expect(cam, 'and the name it needs for its one sentence').toMatch(/let deviceName: String/)
  })

  it('the AUTOMATIC fetch is gated, and a user tap still is not', () => {
    const cam = code(structBody(panels, 'RelayCameraPanel'))
    // Any argument list, so an ungated auto-fetch can't hide behind a new
    // parameter: `.task { refresh(asked: false) }` is the same bug as
    // `.task { refresh() }` was.
    expect(cam, 'the sheet is auto-fetching again, presence unread')
      .not.toMatch(/\.task \{ refresh\(/)
    expect(cam).toMatch(/\.task \{ if unreachable == nil \{ refresh\(asked: false\) \} \}/)
    // Deliberately NOT inside refresh(): a tap is the user overriding our guess
    // about their own hardware, and this app answers that with Retry, never with
    // a silent no-op. Guarding the function instead of the auto-call would make
    // the frame's tap-to-refresh do nothing on a stale frame.
    //
    // The anchor drops the argument list, and then CHECKS ITSELF. It read
    // `indexOf('private func refresh()')` until the function grew an `asked:`
    // parameter for provenance — at which point indexOf returned -1,
    // `slice(-1)` handed the assertion the body's last character, and
    // `.not.toMatch` passed on it forever. A pin anchored on a signature stops
    // pinning the moment the signature moves, silently and in the direction of
    // green, so the anchor's own existence is now an assertion.
    const at = cam.indexOf('private func refresh(')
    expect(at, 'refresh() is gone or renamed — the pin below would be vacuous')
      .toBeGreaterThan(-1)
    const refresh = cam.slice(at)
    expect(refresh.slice(0, refresh.indexOf('\n    }')), 'the tap became a silent no-op')
      .not.toMatch(/unreachable|RelayReach/)
  })

  it('the sheet hands the row\'s own presence to the panel', () => {
    // The gate is only as good as the value: `presence: .online` hard-coded at
    // the call site would satisfy every test above and change nothing.
    expect(code(panels)).toMatch(
      /RelayCameraPanel\(deviceId: d\.id, deviceName: d\.name,\s*presence: d\.presence, token: token\)/)
  })

  it('both relay panels ask ONE question, so one sheet holds one answer', () => {
    const flip = code(structBody(panels, 'FlipperDevicePanel'))
    expect(flip, 'the Flipper panel went back to its own private copy of the rule')
      .not.toMatch(/hostPresence != \.online/)
    expect(flip).toMatch(/RelayReach\.canReach\(hostPresence\)/)
  })

  it('a robot is NEVER gated on relay reach — it polls nothing', () => {
    // An endpoint device's presence is `.unknown` BY CONSTRUCTION: the worker
    // sends `online: null` because tiny dials OUT to its HTTPS API instead of
    // waiting for a heartbeat. Gate EndpointPanel on relay reach and every
    // healthy printer and rover on the sheet goes dark — a plausible "fix" that
    // this test exists to stop.
    const endpoint = readFileSync(join(ROOT, 'ios/Tiny/Sources/EndpointPanel.swift'), 'utf8')
    expect(endpoint, 'read the wrong file').toContain('struct EndpointPanel: View {')
    expect(code(endpoint), 'a robot got gated on a relay it never polls')
      .not.toMatch(/RelayReach/)
  })

  it('nothing failed, so the asleep state does not wear the failure chrome', () => {
    const cam = code(structBody(panels, 'RelayCameraPanel'))
    expect(cam, 'the asleep line lost the sibling glyph').toMatch(/systemImage: "moon\.zzz"/)
    // Exactly one orange triangle in this panel, and it belongs to the state
    // where something really did fail. Two would mean the asleep branch grew a
    // warning again — the panel's own comment: "A failure should not occupy the
    // footprint of a success."
    expect(cam.match(/exclamationmark\.triangle\.fill/g)?.length ?? 0).toBe(1)
  })

  it('one sheet, one voice: both refusals open the same way', () => {
    // The Flipper's line and the camera's are different sentences on purpose —
    // a Flipper is a capability of another machine, a necklace is itself — but
    // they are the same MOVE, so they share an opening.
    expect(panels).toContain("isn't online — wake that machine to reach the Flipper.")
    expect(panels).toContain("isn't online — its camera answers once it's back.")
    // And the camera's refusal must not inherit the timeout's wording, which is
    // what sent the user to check a camera that was working.
    const note = panels.slice(panels.indexOf('static func cameraNote('))
    expect(note.slice(0, note.indexOf('\n    }')), 'the refusal blames the camera again')
      .not.toMatch(/camera awake|failed/i)
  })
})
