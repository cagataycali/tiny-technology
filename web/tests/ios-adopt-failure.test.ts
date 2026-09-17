/**
 * Adopting a Nicla Voice — the four causes the server distinguishes and the
 * client used to flatten into one sentence.
 *
 * 🔴 Every failure printed:
 *
 *     "Couldn't claim the necklace on the server. Check your connection and try again."
 *
 * `/api/devices/adopt` answers a different status per cause DELIBERATELY, and
 * says so in its own comment: a 404 "must reach the client as 404, because the
 * caller's next move (enroll it fresh) differs from what it should do on an
 * outage (retry)". It even flags the outage `retryable: true`. iOS discarded the
 * lot with `try?`, so the reader whose session had expired and the reader whose
 * necklace had been revoked were both sent to look at their WiFi — and neither
 * retrying nor a better signal fixes either.
 *
 * ⚠️ The guard FOUR LINES ABOVE the one that printed it already carries the
 * lesson in a comment — "Say WHICH failure it was. 'Couldn't find it' sends the
 * user hunting for the necklace when the real problem is a radio switch" — for
 * the BLE branch only. That, not the wording, is the finding: the rule reached
 * the branch someone was looking at.
 *
 * ⚠️ Every pin here reads SOURCE with comments stripped, because Panels.swift
 * quotes the old sentence in its own prose to explain it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const ROUTE = join(ROOT, 'app/api/devices/adopt/route.ts')
const KT_PANELS = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Panels.kt')

/** Source with line and block comments removed, so prose can't satisfy a code pin. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '')
}

/** The body of a Swift/Kotlin declaration, by brace matching from its signature. */
function braced(src: string, anchor: string): string {
  const at = src.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${anchor}`)
}

const panels = () => code(readFileSync(PANELS, 'utf8'))
const route = () => code(readFileSync(ROUTE, 'utf8'))

describe('the premise: the route really does distinguish the causes', () => {
  // If this stops being true, the whole classification below is guesswork
  // wearing a switch statement — so it is asserted, not assumed.
  it('four distinguishable answers, one of them explicitly retryable', () => {
    const r = route()
    expect(r, 'the route stopped gating on a session').toMatch(/'login required' \}, 401/)
    expect(r, 'the 404 is no longer passed through').toMatch(/status === 404/)
    expect(r, 'the outage is no longer flagged retryable').toMatch(/retryable: true \}, 503/)
    // Never {ok:true} without a token — the case that makes `keyNotDelivered`
    // reachable at all, since a 2xx is then the only way to arrive there.
    expect(r, 'the route can report success without a token').toMatch(/!data\.device_token/)
  })

  it('adoption is still a ROTATION, which is why a lost key is not "try again"', () => {
    // The old token dies the moment the new one is minted. That makes a 2xx
    // whose token this phone failed to keep the one outcome where the necklace
    // ends up relayed by NOBODY.
    expect(route(), 'the route no longer rotates').toMatch(/device\/rotate-token/)
  })
})

describe('iOS reads the status instead of guessing', () => {
  it('the sentence that answered for everything is gone', () => {
    const src = panels()
    expect(src, 'the one-size-fits-all claim failure is back')
      .not.toMatch(/Couldn't claim the necklace on the server\. Check your connection/)
    // And the POST is caught, not swallowed. (`try?` legitimately remains in
    // adopt() for the scan sleep, so this pins the call, not the file.)
    const adopt = code(braced(readFileSync(PANELS, 'utf8'), 'private func adopt() async'))
    expect(adopt, 'the adopt POST throws its evidence away again')
      .not.toMatch(/try\?\s*await Api\.post/)
    expect(adopt).toMatch(/catch \{[\s\S]*?AdoptFailure\.classify\(error\)\.message/)
  })

  it('one case per next move, and the moves really are different', () => {
    const cls = braced(panels(), 'static func classify(')
    expect(cls).toMatch(/case 401: return \.signedOut/)
    expect(cls).toMatch(/case 404: return \.notInFleet/)
    // 0 is the house code for "nothing arrived"; 5xx covers the route's 503.
    expect(cls).toMatch(/case 0, \.some\(500\.\.\.599\): return \.uncertain/)
    expect(cls).toMatch(/if case \.badResponse = api \{ return \.keyNotDelivered \}/)
    expect(cls).toMatch(/default: return \.refused/)
  })

  it('a transport failure is classified before any status is looked for', () => {
    // URLError never produced a status, so the cast must not get first look —
    // it would print "Unexpected response" for a request that got no response.
    const cls = braced(panels(), 'static func classify(')
    const url = cls.indexOf('error is URLError')
    const cast = cls.indexOf('as? ApiError')
    expect(url, 'the URLError branch is gone').toBeGreaterThan(-1)
    expect(cast, 'the ApiError cast is gone').toBeGreaterThan(-1)
    expect(url, 'the ApiError cast now outranks the transport check').toBeLessThan(cast)
  })

  it('an expired session defers to the one status table, never restates it', () => {
    // HTTPErrorTests exists to keep that table from drifting; a second copy of
    // the sentence here would be outside it.
    const msg = braced(panels(), 'var message: String')
    expect(msg).toMatch(/case \.signedOut: return Api\.friendlyHTTPError\(401\)/)
    expect(msg, 'the 401 sentence was copied instead of delegated')
      .not.toMatch(/sign out and back in/)
  })

  it('no case sends the reader to their WiFi, and the wire phrases stay off screen', () => {
    const msg = braced(panels(), 'var message: String')
    expect(msg, 'a hard-coded connection claim is back').not.toMatch(/Check your connection/)
    // The worker's own vocabulary — fine on the wire, not on a panel.
    for (const wire of ['login required', 'device not found', 'adopt failed', 'registry unreachable']) {
      expect(msg, `the wire phrase "${wire}" reached the panel`).not.toContain(wire)
    }
  })

  it('the revoked necklace is told the move that actually works', () => {
    const msg = braced(panels(), 'var message: String')
    const notInFleet = msg.slice(msg.indexOf('case .notInFleet'), msg.indexOf('case .uncertain'))
    expect(notInFleet.length, 'the notInFleet arm vanished').toBeGreaterThan(20)
    expect(notInFleet, 'the reader is no longer told how to fix it').toMatch(/Set it up again/)
    expect(notInFleet, 'a stable 404 is still offered a retry').not.toMatch(/try again/i)
  })

  it('the case with no words before: the handover landed and the key did not', () => {
    const msg = braced(panels(), 'var message: String')
    const lost = msg.slice(msg.indexOf('case .keyNotDelivered'), msg.indexOf('case .refused'))
    expect(lost.length, 'the keyNotDelivered arm vanished').toBeGreaterThan(20)
    // It must say the move happened — the previous holder has already lost the
    // link — and must not blame the network, which demonstrably worked.
    expect(lost).toMatch(/moved to this phone/)
    expect(lost).toMatch(/Adopt again/)
    expect(lost, 'the one thing that provably worked is being blamed').not.toMatch(/connection/i)
  })

  it('a 2xx with no usable token is what reaches that case', () => {
    const adopt = code(braced(readFileSync(PANELS, 'utf8'), 'private func adopt() async'))
    // The guard survives (nicla-android-parity pins it too) and now reports the
    // specific outcome rather than the generic one.
    expect(adopt).toMatch(/!token\.isEmpty/)
    expect(adopt).toMatch(/AdoptFailure\.keyNotDelivered\.message/)
  })
})

describe('the other phone', () => {
  /**
   * ⚠️ FAILS-WHEN-FIXED — this records a real divergence, on purpose.
   *
   * Android's `VoiceAdopt.claimFailure` is pure and unit-tested (VoiceAdoptTest)
   * and it already distinguishes the 404 that iOS was missing. But it still
   * answers "Check your connection and try again" for BOTH a null reply (which
   * is where a 401 lands, since the helper returns no body for a non-2xx) and an
   * empty `device_token` — the case where the rotation has already landed and
   * the necklace is relayed by nobody.
   *
   * Port recipe, when Android's turn comes:
   *   1. `claimFailure` takes the status it already reads (`_status`) and maps
   *      401 → the session sentence, 5xx/null → "may or may not have moved",
   *      empty token on a 2xx → "moved to this phone but its key didn't arrive".
   *   2. Keep the 404 branch ABOVE the empty-token branch (nicla-android-parity
   *      pins that ordering — a 404 body carries no token and would otherwise
   *      read as a retryable outage forever).
   *   3. Add the cases to VoiceAdoptTest, then DELETE this block.
   */
  it('Android has not been ported yet, and this says so out loud', () => {
    const kt = code(readFileSync(KT_PANELS, 'utf8'))
    const claim = braced(kt, 'fun claimFailure(')
    // Android's strength: the 404 iOS lacked.
    expect(claim, 'Android lost the 404 branch').toMatch(/404/)
    // Android's gap. When this assertion fails, Android has been fixed — read
    // the recipe above, then delete this whole block.
    expect(
      claim,
      'Android now distinguishes more than the 404 — port is done, delete this marker',
    ).toMatch(/Check your connection and try again/)
  })
})
