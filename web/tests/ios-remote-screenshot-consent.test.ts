// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📸 THE WEB CAN NOW ASK YOUR IPHONE FOR ITS SCREEN — AND THE PROMPT MUST NOT
 *    COST YOU YOUR NOTIFICATIONS TO ANSWER.
 *
 * `use_device` + `screenshot` used to refuse on iOS: the per-capture consent
 * prompt lived in ChatView, and a relay turn has no chat view on screen
 * (docs/remote-screenshot-consent-design-2026-08-02.md). The executor now
 * presents its own UIAlertController — but the way it does that carries one
 * non-obvious invariant that nothing else in the codebase can express:
 *
 *   **The relay path must DISPATCH the prompt, never AWAIT the answer.**
 *
 * `runDeviceEvent` runs inside the relay poll loop's current iteration, and that
 * loop is what claims `{type:"notify"}` envelopes — which ARE iOS's entire push
 * transport (Session.swift, "the relay poll IS the push rail on iOS"). Awaiting
 * a human there — the obvious implementation, and what the chat path correctly
 * does — would mean an unanswered consent alert silently stops every push to
 * that phone for as long as it sits there. The symptom would appear nowhere near
 * the screenshot code: DMs and job results would just stop arriving.
 *
 * Nothing about `await askScreenshotConsent(...)` looks wrong, so the shape gets
 * pinned here. The Swift suite can't reach it (UIKit presentation on the key
 * window needs a host app), so these read the source — the same tactic
 * tests/ios-capability-words.test.ts uses for call sites no Swift test can see.
 */

const ROOT = process.cwd()
const SESSION = join(ROOT, 'ios/Tiny/Sources/Session.swift')
const SCREENSHOT = join(ROOT, 'ios/Tiny/Sources/Screenshot.swift')
const DEVICE_TOOLS = join(ROOT, 'ios/Tiny/Sources/DeviceTools.swift')
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const AND = 'android/app/src/main/java/technology/tiny/app/'

const session = readFileSync(SESSION, 'utf8')
const screenshot = readFileSync(SCREENSHOT, 'utf8')
const deviceTools = readFileSync(DEVICE_TOOLS, 'utf8')
const panels = readFileSync(PANELS, 'utf8')
const androidFleet = readFileSync(join(ROOT, AND, 'fleet/FleetManager.kt'), 'utf8')
const androidPanels = readFileSync(join(ROOT, AND, 'ui/Panels.kt'), 'utf8')
const views = readFileSync(join(ROOT, 'ios/Tiny/Sources/Views.swift'), 'utf8')
const androidConsent = readFileSync(join(ROOT, AND, 'tools/ScreenshotConsentActivity.kt'), 'utf8')
const androidShot = readFileSync(join(ROOT, AND, 'tools/Screenshot.kt'), 'utf8')

/** The `case .screenshot(...)` arm of runDeviceEvent, up to the next `case .`. */
function relayScreenshotBranch(): string {
  const at = session.indexOf('case .screenshot(')
  expect(at, 'the relay .screenshot branch is gone — renamed?').toBeGreaterThan(-1)
  const next = session.indexOf('\n        case .', at + 10)
  return session.slice(at, next === -1 ? at + 4000 : next)
}

describe('iOS remote screenshot consent', () => {
  it('reads the branch it means to read', () => {
    // A slicer that silently returned "" would make every assertion below pass
    // forever — the failure mode this whole file exists to prevent.
    expect(relayScreenshotBranch().length).toBeGreaterThan(400)
    expect(relayScreenshotBranch()).toContain('Screenshot.shared.askRemoteConsent')
  })

  it('does NOT await the human on the relay loop', () => {
    const branch = relayScreenshotBranch()
    // The chat path's ask suspends until the tap. On the relay path that would
    // park the envelope loop — so neither the awaiting helper nor any await of
    // the consent call may appear here.
    expect(branch, 'the relay path is awaiting consent — this stalls the push rail')
      .not.toMatch(/await\s+\w*askScreenshotConsent/)
    expect(branch, 'askRemoteConsent is being awaited for an answer')
      .not.toMatch(/await\s+Screenshot\.shared\.askRemoteConsent/)
  })

  it('the executor hands back only whether it PRESENTED, not what was chosen', () => {
    // The signature is the enforcement: a Bool named for the tap ("allowed")
    // would invite the caller to await it. `askRemoteConsent` returns
    // synchronously and its Bool means "a prompt is on screen".
    const at = screenshot.indexOf('func askRemoteConsent')
    expect(at, 'askRemoteConsent not found — renamed?').toBeGreaterThan(-1)
    const sig = screenshot.slice(at, screenshot.indexOf('{', at))
    expect(sig, 'askRemoteConsent became async — the caller can now await a human')
      .not.toContain('async')
    expect(sig).toMatch(/->\s*Bool/)
  })

  it('both consent answers post to the mailbox from inside the alert', () => {
    // The server callback polls tool-result for 90s. Since the relay turn has
    // already returned by the time the user taps, the ALERT ACTIONS are the only
    // thing left that can answer it — allow must capture, deny must post denied.
    const at = screenshot.indexOf('func askRemoteConsent')
    const body = screenshot.slice(at, screenshot.indexOf('\n    }', at))
    expect(body).toMatch(/self\.run\(toolUseId:/)
    expect(body).toMatch(/self\.postDenied\(toolUseId:/)
  })

  it('every path the relay turn itself takes posts an outcome', () => {
    const branch = relayScreenshotBranch()
    // Two non-prompt exits — backgrounded, and active-but-no-window. Each must
    // post, or the server strands for its full 90s with nothing to say (G7).
    const posts = branch.match(/postToolFailure\(/g) ?? []
    expect(posts.length, 'a non-prompt exit posts nothing — the server will strand 90s')
      .toBeGreaterThanOrEqual(2)
    // And the prompt path must NOT post: the alert owns that outcome, and a
    // second post would race the real answer into the same mailbox slot.
    const promptPath = branch.slice(branch.indexOf('askRemoteConsent'))
    expect(promptPath.slice(promptPath.indexOf('return DeviceActionAudit.consentLine')))
      .not.toContain('postToolFailure')
  })

  it('the audit claims the prompt was SHOWN, never that a capture happened', () => {
    const at = deviceTools.indexOf('static func consentLine')
    expect(at, 'consentLine not found — renamed?').toBeGreaterThan(-1)
    const line = deviceTools.slice(at, deviceTools.indexOf('\n    }', at))
    const text = line.match(/"([^"]+)"/)?.[1] ?? ''
    expect(text).toMatch(/consent prompt shown/)
    // "captured"/"ran"/"took" here would be the exact confabulation the audit
    // exists to catch — at this instant nobody has tapped anything yet.
    expect(text, 'the audit is claiming a capture that has not happened')
      .not.toMatch(/\b(captured|ran on|took|screenshotted)\b/)
    // The relay branch must use THAT line for the prompt path, not the old
    // droppedLine (which says the tool cannot run remotely — no longer true).
    const branch = relayScreenshotBranch()
    expect(branch).toContain('DeviceActionAudit.consentLine("screenshot")')
  })

  it('backgrounded still refuses, and names the precondition not the capability', () => {
    const branch = relayScreenshotBranch()
    // iOS can't present an alert for a background app, and ReplayKit records the
    // FOREGROUND app's UI — so there is nothing to capture even with consent.
    expect(branch).toContain('UIApplication.shared.applicationState == .active')
    const at = deviceTools.indexOf('static func backgroundedLine')
    expect(at, 'backgroundedLine not found — renamed?').toBeGreaterThan(-1)
    const text = deviceTools.slice(at, deviceTools.indexOf('\n    }', at)).match(/"([^"]+)"/)?.[1] ?? ''
    expect(text).toMatch(/backgrounded/)
    // The stale wording promised a feature that now exists; saying it again
    // would talk the model out of a capability the phone really has.
    expect(text, 'the refusal still says remote screenshot is unbuilt')
      .not.toMatch(/not available remotely|yet/)
  })

  it('the prompt names its remote origin', () => {
    // A prompt identical to the local one would be a trust bug: the user did not
    // ask for this on this device, and consent needs to know who is asking.
    const at = screenshot.indexOf('func askRemoteConsent')
    const body = screenshot.slice(at, screenshot.indexOf('\n    }', at))
    expect(body).toMatch(/Asked from another device/)
  })
})

/**
 * ⏱️ CONSENT EXPIRES WITH THE REQUEST THAT ASKED FOR IT.
 *
 * The prompt outlives the request unless something stops it. The server callback
 * polls 90s and the turn ends; the alert (iOS) and the system MediaProjection
 * dialog (Android) both survive a locked screen indefinitely. And for a REMOTE
 * ask, not noticing the prompt is the normal case — the phone is in a pocket.
 *
 * So a tap an hour later used to capture whatever was on screen at THAT moment,
 * upload it permanently (nothing ever deletes R2 media — there is no
 * MEDIA.delete anywhere in the worker; only the mailbox ROW is swept, at 15
 * min), and deliver it to nobody. The user's "yes" answered a question about a
 * screen that no longer existed, for a request that no longer existed.
 *
 * Both halves are load-bearing and neither is visible in a diff:
 *   - the window is stamped when the ask ARRIVES, not when it's answered
 *     (stamping at tap time measures nothing and always passes);
 *   - an expired grant is NOT reported as `{denied:true}` — the user allowed it,
 *     and a decline they never made is exactly the confabulation the device
 *     audit exists to stop.
 */
describe('a consent tap expires with the request', () => {
  const remoteFn = (() => {
    const at = screenshot.indexOf('func askRemoteConsent')
    return screenshot.slice(at, screenshot.indexOf('\n    /// How long', at))
  })()

  it('reads the function it means to read', () => {
    expect(remoteFn.length).toBeGreaterThan(400)
    expect(remoteFn).toContain('UIAlertController')
  })

  it('iOS stamps the clock at ASK time, OUTSIDE the Allow handler', () => {
    // The stamp must live in the function body, not in the tap closure. Inside,
    // it measures the gap between tap and capture (~0s) and the guard becomes
    // vacuous while reading exactly like a working deadline.
    //
    // "before `present(`" is NOT the check: the closure is *written* above the
    // present call, so a stamp moved into it still comes first textually. Only
    // "before the first addAction" separates the two.
    const stamp = remoteFn.indexOf('let asked = Date()')
    const firstAction = remoteFn.indexOf('alert.addAction(')
    expect(stamp, 'no ask-time stamp in askRemoteConsent').toBeGreaterThan(-1)
    expect(firstAction).toBeGreaterThan(-1)
    expect(stamp, 'the stamp is inside a tap handler — the deadline measures nothing')
      .toBeLessThan(firstAction)
    // And exactly one stamp: a second one inside the closure would shadow it.
    expect(remoteFn.match(/let asked = Date\(\)/g) ?? []).toHaveLength(1)
    // The Allow path must consult it.
    const allow = remoteFn.slice(remoteFn.indexOf('"Allow once"'))
    expect(allow).toMatch(/isConsentStillLive\(asked\)/)
  })

  it('iOS captures nothing once expired', () => {
    const allow = remoteFn.slice(remoteFn.indexOf('"Allow once"'), remoteFn.indexOf(`"Don't allow"`))
    // The guard must RETURN before run(); a warning that still captured would
    // be the same privacy bug with better manners.
    const guardAt = allow.indexOf('isConsentStillLive')
    const runAt = allow.indexOf('self.run(toolUseId:')
    expect(guardAt).toBeGreaterThan(-1)
    expect(runAt).toBeGreaterThan(guardAt)
    expect(allow.slice(guardAt, runAt)).toMatch(/return/)
  })

  it('declining needs no deadline — "no" is valid forever', () => {
    const deny = remoteFn.slice(remoteFn.indexOf(`"Don't allow"`))
    expect(deny).toMatch(/postDenied\(toolUseId:/)
    expect(deny, 'the decline path grew a deadline it does not need')
      .not.toMatch(/isConsentStillLive/)
  })

  it('an expired grant is never reported as a decline, on either phone', () => {
    // iOS
    const at = screenshot.indexOf('func postExpired')
    expect(at, 'iOS postExpired missing').toBeGreaterThan(-1)
    const ios = screenshot.slice(at, screenshot.indexOf('\n    }', at))
    expect(ios, 'iOS reports an expired grant as a user decline').not.toMatch(/"denied"/)
    expect(ios).toMatch(/"ok": false/)
    expect(ios).toMatch(/expired/)
    // Android
    const aat = androidShot.indexOf('suspend fun postExpired')
    expect(aat, 'Android postExpired missing').toBeGreaterThan(-1)
    const and = androidShot.slice(aat, androidShot.indexOf('\n    }', aat))
    expect(and, 'Android reports an expired grant as a user decline').not.toMatch(/put\("denied"/)
    expect(and).toMatch(/put\("ok", false\)/)
    // …and it must still release the in-process voice waiter, or a call's tool
    // turn hangs for the full timeout on a capture that is never coming.
    expect(and, 'expired never releases the voice waiter — the call hangs')
      .toMatch(/emitScreenshot\(toolUseId, ""\)/)
  })

  it('Android stamps at launch() and refuses a late grant', () => {
    const launch = androidConsent.slice(androidConsent.indexOf('fun launch('))
    expect(launch, 'the ask time is never recorded on the intent')
      .toMatch(/putExtra\(EXTRA_ASKED_AT, System\.currentTimeMillis\(\)\)/)
    // The result handler must gate the capture on it.
    const handler = androidConsent.slice(
      androidConsent.indexOf('registerForActivityResult'),
      androidConsent.indexOf('override fun onCreate'),
    )
    expect(handler).toMatch(/!isExpired\(\)/)
    expect(handler, 'a late grant still starts the capture service')
      .toMatch(/postExpired/)
    // A missing stamp must read as LIVE, not as expired: an older caller (mixed
    // -version install) would otherwise have every capture silently refused.
    const fn = androidConsent.slice(androidConsent.indexOf('private fun isExpired'))
    expect(fn.slice(0, fn.indexOf('\n    }'))).toMatch(/asked <= 0L\) return false/)
  })

  it('both phones use the same window, and it covers the 90s poll', () => {
    const ios = Number(screenshot.match(/consentWindow: TimeInterval = (\d+)/)?.[1])
    const and = Number(androidConsent.match(/CONSENT_WINDOW_MS = ([\d_]+)L/)?.[1]?.replace(/_/g, ''))
    expect(ios, 'iOS consent window unreadable').toBeGreaterThan(0)
    expect(and, 'Android consent window unreadable').toBeGreaterThan(0)
    expect(and, 'the two phones disagree on how long consent lasts').toBe(ios * 1000)
    // Must outlast the server's poll (2s × 45) or a tap at 85s is thrown away
    // while the model is still waiting for it.
    expect(ios).toBeGreaterThanOrEqual(90)
    // …and must not be so long that it stops being a deadline at all.
    expect(ios).toBeLessThanOrEqual(180)
  })

  it('the CHAT path shares the deadline instead of reasoning about it twice', () => {
    // The user is watching here, but they can still lock the phone mid-turn —
    // and SwiftUI re-presents the alert on return, after the poll is over.
    const at = views.indexOf('private func askScreenshotConsent')
    expect(at, 'askScreenshotConsent renamed?').toBeGreaterThan(-1)
    const fn = views.slice(at, views.indexOf('\n    /// The ChatView', at))
    expect(fn, 'the chat path still returns a bare Bool — no room for "expired"')
      .toMatch(/->\s*Screenshot\.ConsentOutcome/)
    expect(fn).toMatch(/Screenshot\.isConsentStillLive\(asked\)/)
    // Same vacuity trap as the relay path: the stamp has to be taken before the
    // suspension, or it measures the time from tap to check instead of from ask
    // to tap — always live, guard always true.
    const stamp = fn.indexOf('let asked = Date()')
    expect(stamp, 'no ask-time stamp on the chat path').toBeGreaterThan(-1)
    expect(stamp, 'the stamp is taken after the await — the deadline measures nothing')
      .toBeLessThan(fn.indexOf('await withCheckedContinuation'))
    // Both call sites must handle the third case, or Swift's switch wouldn't
    // compile — but the voice one returns a dictionary, so pin its honesty.
    const voice = views.slice(views.indexOf('func voiceScreenshot'))
    const body = voice.slice(0, voice.indexOf('\n    }'))
    expect(body).toMatch(/case \.expired/)
    expect(body.slice(body.indexOf('case .expired')), 'voice reports expiry as a decline')
      .not.toMatch(/"denied": true/)
  })
})

/**
 * 🏷️ THE ROSTER GAP THIS CHANGE WALKED INTO.
 *
 * Advertising a capability is three edits, not one: `Session.capabilities` is
 * the wire, and the devices sheet renders each token through `capabilityLabel`
 * + `capabilityIcon`. Miss either and the chip degrades — the label falls back
 * to the underscore-stripped TOKEN (the exact bug ios-capability-words.test.ts
 * was written about) and the icon to nil. Both fallbacks are silent, and both
 * look deliberate from outside the file.
 *
 * No test tied the three together, so `screenshot` could have shipped as a bare
 * word on the sheet with a green suite. This pins the whole roster, so the next
 * capability someone adds fails here instead.
 */
describe('every advertised iOS capability is renderable', () => {
  const caps = (() => {
    const m = session.match(/nonisolated static let capabilities = \[([^\]]+)\]/)
    expect(m, 'Session.capabilities not found — renamed?').toBeTruthy()
    return Array.from(m![1].matchAll(/"([^"]+)"/g)).map((x) => x[1])
  })()

  it('parsed the roster', () => {
    expect(caps.length).toBeGreaterThan(5)
    expect(caps).toContain('screenshot')
  })

  it('has a human LABEL for each', () => {
    const table = panels.slice(panels.indexOf('let CAPABILITY_LABELS'))
    const body = table.slice(table.indexOf('['), table.indexOf(']\n') + 1)
    const labelled = new Set(Array.from(body.matchAll(/"([^"]+)":\s*"[^"]+"/g)).map((m) => m[1]))
    expect(caps.filter((c) => !labelled.has(c))).toEqual([])
  })

  it('has an ICON for each', () => {
    const at = panels.indexOf('func capabilityIcon(')
    expect(at, 'capabilityIcon not found — renamed?').toBeGreaterThan(-1)
    const fn = panels.slice(at, panels.indexOf('\n}', at))
    const iconed = new Set(Array.from(fn.matchAll(/case "([^"]+)":/g)).map((m) => m[1]))
    expect(caps.filter((c) => !iconed.has(c))).toEqual([])
  })
})

/**
 * 🤖 THE SAME ROSTER GAP, ALREADY SHIPPED ON ANDROID.
 *
 * Writing the iOS pin above turned this up: Android has advertised `screenshot`
 * on the wire since the capability widening, but neither of its render maps knew
 * the token — so a Pixel in anyone's devices sheet has been showing a bare
 * "screenshot" chip with no icon this whole time. The cross-platform suite
 * couldn't catch it, because it compares the two phones' MAPS to each other
 * (both were equally missing it) and never to what either phone CLAIMS.
 *
 * That's the general lesson worth pinning: parity between two surfaces doesn't
 * imply either one is complete. Android's wire roster gets checked against
 * Android's own maps here, the same way iOS's is above.
 */
describe('every advertised Android capability is renderable', () => {
  const caps = (() => {
    const at = androidFleet.indexOf('private val capabilities = listOf(')
    expect(at, 'FleetManager.capabilities not found — renamed?').toBeGreaterThan(-1)
    const list = androidFleet.slice(at, androidFleet.indexOf(')', at))
    return Array.from(list.matchAll(/"([^"]+)"/g)).map((m) => m[1])
  })()

  it('parsed the roster', () => {
    expect(caps.length).toBeGreaterThan(5)
    expect(caps).toContain('screenshot')
  })

  it('has a human LABEL for each', () => {
    const table = androidPanels.slice(androidPanels.indexOf('val CAPABILITY_LABELS'))
    const body = table.slice(0, table.indexOf('\n)'))
    const labelled = new Set(Array.from(body.matchAll(/"([^"]+)" to "[^"]+"/g)).map((m) => m[1]))
    expect(caps.filter((c) => !labelled.has(c))).toEqual([])
  })

  it('has an ICON for each', () => {
    const at = androidPanels.indexOf('fun capabilityIcon(')
    expect(at, 'capabilityIcon not found — renamed?').toBeGreaterThan(-1)
    const fn = androidPanels.slice(at, androidPanels.indexOf('\n}', at))
    const iconed = new Set(Array.from(fn.matchAll(/"([^"]+)" ->/g)).map((m) => m[1]))
    expect(caps.filter((c) => !iconed.has(c))).toEqual([])
  })
})
