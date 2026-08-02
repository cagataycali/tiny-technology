// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📸 THE WEB CAN NOW ASK YOUR IPHONE FOR ITS SCREEN — AND THE PROMPT MUST NOT
 *    COST YOU YOUR NOTIFICATIONS TO ANSWER.
 *
 * `use_device` + `screenshot` used to refuse on iOS: the per-capture consent
 * prompt lived in ChatView, and a relay turn has no chat view on screen. The executor now
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
const platform = readFileSync(join(ROOT, 'lib/chat/tools/platform.ts'), 'utf8')
const mainActivity = readFileSync(join(ROOT, AND, 'MainActivity.kt'), 'utf8')
const tinyAppKt = readFileSync(join(ROOT, AND, 'TinyApp.kt'), 'utf8')
const chatVm = readFileSync(join(ROOT, AND, 'chat/ChatViewModel.kt'), 'utf8')
const voiceCall = readFileSync(join(ROOT, 'ios/Tiny/Sources/VoiceCall.swift'), 'utf8')

/**
 * Read a duration literal out of source. Shared by the two deadline blocks: the
 * numbers only mean anything relative to each other, so both must read the same
 * declarations rather than restating them.
 */
const win = (src: string, re: RegExp, scale = 1) => {
  const m = src.match(re)
  const n = Number(m?.[1]?.replace(/_/g, ''))
  expect(m, `unreadable: ${re}`).toBeTruthy()
  expect(n).toBeGreaterThan(0)
  return n * scale
}

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
    // turn hangs for the full timeout on a capture that is never coming — but
    // TAGGED, because that waiter used to read the empty url as a decline. The
    // first version of this pin asserted the bare `emitScreenshot(id, "")`, i.e.
    // it required precisely the signal-by-absence that told the lie.
    expect(and, 'expired never releases the voice waiter — the call hangs')
      .toMatch(/emitScreenshot\(toolUseId, "", TinyApp\.ShotOutcome\.EXPIRED\)/)
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

  /**
   * ⚠️ THE DIRECTION OF THE GRACE IS THE WHOLE POINT, AND THE FIRST VERSION OF
   *    THIS TEST HAD IT BACKWARDS (asserted `>= 90`, shipped a 100s window).
   *
   * The poll is `for (i<45) { await sleep(2000); check }` — it sleeps FIRST, so
   * checks land at t≈2,4,…,90 and the result has to already be IN the mailbox at
   * t=90. A tap is not a result: ReplayKit's first frame, the JPEG encode, the
   * /api/media upload and the mailbox POST all happen after it.
   *
   * So the window must be BELOW the poll budget by at least the delivery cost. A
   * window above it re-creates the exact bug the deadline exists to kill —
   * pixels captured and stored permanently for a poll that has already gone —
   * just bounded to the overhang instead of unbounded.
   */
  it('the consent window closes BEFORE the server stops listening', () => {
    const poll = win(screenshot, /serverPollBudget: TimeInterval = (\d+)/)
    const grace = win(screenshot, /deliveryGrace: TimeInterval = (\d+)/)
    const ios = poll - grace

    // The recorded poll budget must match the server that actually polls, so a
    // change to platform.ts can't leave the phones calibrated to a stale number.
    // The budget is NAMED (SHOT_POLL_*) precisely because three things read it —
    // the loop, the terminal message, and both phones' windows — but the loop must
    // still be the thing that CONSUMES those constants, or the name drifts from
    // the behaviour it claims to describe.
    //
    // ⚠️ platform.ts holds SEVEN of these loops with different budgets. The
    // declarations are just above makeScreenshotTool, so slice from them (an
    // unscoped regex reads the first loop in the file, 15×3s).
    const shotLoops = Number(platform.match(/const SHOT_POLL_LOOPS = (\d+)/)?.[1])
    const shotSleep = Number(platform.match(/const SHOT_POLL_SLEEP_MS = (\d+)/)?.[1])
    expect(shotLoops, 'SHOT_POLL_LOOPS unreadable').toBeGreaterThan(0)
    expect(shotSleep, 'SHOT_POLL_SLEEP_MS unreadable').toBeGreaterThan(0)
    const shotTool = platform.slice(
      platform.indexOf('export const makeScreenshotTool'),
      platform.indexOf('export const', platform.indexOf('export const makeScreenshotTool') + 10),
    )
    expect(shotTool, 'did not slice makeScreenshotTool').toContain("name: 'screenshot'")
    expect(shotTool, 'the screenshot poll no longer uses the budget it declares')
      .toMatch(/for \(let i = 0; i < SHOT_POLL_LOOPS; i\+\+\)[\s\S]{0,120}setTimeout\(r, SHOT_POLL_SLEEP_MS\)/)
    expect(poll, "the phones' idea of the server budget drifted from the server")
      .toBe((shotLoops * shotSleep) / 1000)
    // …and the derived seconds constant must actually be that product, since the
    // user-facing message quotes it as the time they waited.
    expect(platform, 'SHOT_POLL_BUDGET_S is not derived from the loop')
      .toMatch(/SHOT_POLL_BUDGET_S = \(SHOT_POLL_LOOPS \* SHOT_POLL_SLEEP_MS\) \/ 1000/)

    // …and the tap deadline must leave real room for capture+upload+POST.
    expect(ios, 'the consent window outlives the poll — a late tap still captures')
      .toBeLessThan(poll)
    expect(grace, 'the delivery grace is too thin for two 30s-bounded network legs')
      .toBeGreaterThanOrEqual(15)
    // Still has to be long enough to be usable: a human must be able to notice
    // the prompt and tap it.
    expect(ios).toBeGreaterThanOrEqual(45)
  })

  it('both phones compute the same window, from the same two numbers', () => {
    const ios = win(screenshot, /serverPollBudget: TimeInterval = (\d+)/) -
      win(screenshot, /deliveryGrace: TimeInterval = (\d+)/)
    const and = win(androidConsent, /SERVER_POLL_BUDGET_MS = ([\d_]+)L/) -
      win(androidConsent, /DELIVERY_GRACE_MS = ([\d_]+)L/)
    expect(and, 'the two phones disagree on how long consent lasts').toBe(ios * 1000)
    // Derived, not restated: a hardcoded literal on either side would drift
    // silently the next time the poll budget moves.
    expect(screenshot, 'iOS hardcodes the window instead of deriving it')
      .toMatch(/consentWindow: TimeInterval = serverPollBudget - deliveryGrace/)
    expect(androidConsent, 'Android hardcodes the window instead of deriving it')
      .toMatch(/CONSENT_WINDOW_MS = SERVER_POLL_BUDGET_MS - DELIVERY_GRACE_MS/)
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
 * 🚪 A REQUEST ALSO DIES FOR REASONS THAT AREN'T THE CLOCK (iOS).
 *
 * The deadline covers a prompt nobody noticed. It does NOT cover the requester
 * leaving: the user hangs up the call, switches tiny (which hangs up), or hits ⏹
 * on the turn. The alert survives all three — it is bound to
 * `chat.pendingScreenshot`, which is owned by ChatModel and knows nothing about
 * either the WebSocket or the stream task.
 *
 * So an Allow tapped afterwards ran ReplayKit, uploaded the frame to R2
 * *permanently* (nothing deletes R2 media), and answered a listener that was
 * already gone — the expiry bug reached through a different door, and reachable
 * in ONE second rather than needing seventy.
 *
 * Two things make the fix honest rather than merely quiet:
 *   - "nobody is asking any more" is its own outcome. Resuming the waiter with
 *     `false` would have been one line, and would have recorded a decline the
 *     user never made — the Android voice-bridge bug in a different file.
 *   - the hook is on `VoiceCall.stop()`, not on its callers. There are four (End,
 *     hangup-on-error, tiny switch, onDisappear) and a missed one is silent.
 */
describe('a consent ask dies with the thing that asked (iOS)', () => {
  const askFn = (() => {
    const at = views.indexOf('private func askScreenshotConsent')
    return views.slice(at, views.indexOf('\n    /// The ChatView', at))
  })()
  const answerFn = (() => {
    const at = views.indexOf('private func answerScreenshotConsent')
    return views.slice(at, views.indexOf('\n    }', at))
  })()

  it('reads the functions it means to read', () => {
    expect(askFn).toContain('withCheckedContinuation')
    expect(answerFn, 'answerScreenshotConsent missing — is resume still centralized?')
      .toContain('resume(returning:')
  })

  it('"called off" is a distinct outcome, not a decline', () => {
    expect(screenshot, 'ConsentOutcome cannot express an abandoned ask')
      .toMatch(/enum ConsentOutcome \{[^}]*abandoned/)
    // The waiter must map it to .abandoned — resuming with a "no" is the whole
    // bug this describe block exists about.
    expect(askFn).toMatch(/case \.abandon:\s*return \.abandoned/)
    expect(askFn, 'the stale-ask cleanup still reports a decline nobody made')
      .not.toMatch(/resume\(returning: false\)/)
    // …and the CALLER of that mapping has to hand it `.abandon`. Everything above
    // is satisfied by an abandon() that resumes with `.deny` — which is the exact
    // one-line version of this bug ("resuming the waiter with false would have
    // been one line and would have recorded a refusal the user never made"), and
    // a mutation battery walked straight through the pins as written.
    const abandon = views.slice(views.indexOf('func abandonScreenshotConsent()'))
    expect(views.indexOf('func abandonScreenshotConsent()'),
      'abandonScreenshotConsent is gone — re-anchor this pin').toBeGreaterThan(-1)
    const abandonBody = abandon.slice(0, abandon.indexOf('\n    }'))
    expect(abandonBody, 'calling off an ask records a decline the user never made')
      .toMatch(/answerScreenshotConsent\(\.abandon\)/)
    expect(abandonBody).not.toMatch(/\.deny|\.expire|\.allow/)
    // The tap handler is the only thing allowed to turn a false into a decline.
    const resolve = views.slice(views.indexOf('func resolveScreenshotConsent('))
    expect(resolve.slice(0, resolve.indexOf('\n    }')))
      .toMatch(/allow \? \.allow : \.deny/)
  })

  it('a cancelled turn takes its prompt with it', () => {
    // withCheckedContinuation alone ignores cancellation: stopping a turn left
    // the alert up and still armed.
    expect(askFn, 'stopping a turn leaves the consent alert live')
      .toMatch(/withTaskCancellationHandler/)
    expect(askFn).toMatch(/onCancel:[\s\S]*abandonScreenshotConsent\(\)/)
  })

  it('hanging up dismisses the prompt, and the hook is on stop() not its callers', () => {
    expect(voiceCall, 'VoiceCall never tells anyone the call ended')
      .toMatch(/var onEnded: \(\(\) -> Void\)\?/)
    const stop = voiceCall.slice(voiceCall.indexOf('func stop()'))
    expect(stop.slice(0, stop.indexOf('\n    }')), 'stop() does not fire onEnded — a prompt outlives the call')
      .toMatch(/onEnded\?\(\)/)
    // …and ChatView must actually wire it to the abandon path.
    expect(views, 'onEnded is declared but never wired')
      .toMatch(/call\.onEnded = \{[^}]*abandonScreenshotConsent\(\)/)
    // The four call sites are covered BY stop(); if someone re-implements
    // teardown beside it, this catches the divergence.
    const stops = views.match(/call\.stop\(\)/g) ?? []
    expect(stops.length, 'no call.stop() sites found — did teardown move?').toBeGreaterThan(0)
  })

  it('one resume path, and it claims the continuation before dismissing', () => {
    // The alert's isPresented `set` calls resolveScreenshotConsent(false) on ANY
    // dismissal, programmatic included. So clearing pendingScreenshot re-enters
    // this. Claim first (nil the property) or the second call either resumes a
    // continuation twice — a runtime trap — or overwrites .abandon with a
    // decline, depending on when SwiftUI runs.
    const claim = answerFn.indexOf('screenshotConsent = nil')
    const dismiss = answerFn.indexOf('pendingScreenshot = nil')
    const resume = answerFn.indexOf('cont.resume(returning:')
    expect(claim).toBeGreaterThan(-1)
    expect(answerFn, 'no guard — a second dismissal resumes a dead continuation')
      .toMatch(/guard let cont = screenshotConsent else \{ return \}/)
    expect(claim, 'the continuation is dismissed before being claimed — re-entrant')
      .toBeLessThan(dismiss)
    expect(resume, 'resumed before claiming — SwiftUI can re-enter mid-flight')
      .toBeGreaterThan(claim)
    // Exactly one resume site in the whole model: resolve/abandon both route here.
    const resumes = views.match(/screenshotConsent\?\.resume|cont\.resume\(returning:/g) ?? []
    expect(resumes, 'more than one place resumes the consent continuation').toHaveLength(1)
  })

  it('neither call site reports an abandoned ask as a user decision', () => {
    // ⚠️ Slice with an EXPLICIT index check. `indexOf` returns -1 when the arm is
    // gone and `slice(-1)` hands back the last character — truthy, and matching
    // nothing, so deleting the arm outright passed the first version of this
    // test. Swift wouldn't compile a non-exhaustive switch, but a vacuous
    // assertion is worth nothing regardless of what saves it.
    const arm = (hay: string, from: string, to: string) => {
      const a = hay.indexOf(from)
      expect(a, `no ${from} arm — the outcome is unhandled`).toBeGreaterThan(-1)
      const b = hay.indexOf(to, a)
      expect(b, `could not bound the ${from} arm`).toBeGreaterThan(a)
      return hay.slice(a, b)
    }

    const voice = views.slice(views.indexOf('func voiceScreenshot'))
    const vbody = voice.slice(0, voice.indexOf('\n    }'))
    expect(vbody, 'did not slice voiceScreenshot').toContain('askScreenshotConsent')
    expect(arm(vbody, 'case .abandoned', 'case .allowed'), 'voice calls an abandoned ask a decline')
      .not.toMatch(/"denied": true/)

    // The chat/stream path must NOT post a decline either. It posts nothing at
    // all — the task is already cancelled — so pin the absence.
    const stream = views.slice(views.indexOf('case .screenshot(let id, let reason)'))
    const sbody = stream.slice(0, stream.indexOf('case .metaTakePhoto'))
    expect(sbody, 'did not slice the stream loop arm').toContain('askScreenshotConsent')
    expect(arm(sbody, 'case .abandoned', 'activeTool = nil'), 'a stopped turn is recorded as the user declining')
      .not.toMatch(/postDenied/)
  })
})

/**
 * ⏳ A DEADLINE THAT ONLY FIRES WHEN THE USER TAPS IS NOT A DEADLINE.
 *
 * The window (70s, derived) shipped read from exactly one place on each phone:
 * inside the Allow handler / the activity-result handler. So it only ever ran if
 * a finger arrived — and the case it exists FOR is the phone in a pocket, where
 * one never does.
 *
 * What an ignored prompt actually did:
 *   - iOS chat/voice: the continuation never resumed. The caller never returned,
 *     `activeTool` stayed on "screenshot", and NOTHING reached the mailbox.
 *   - iOS relay: the alert sat armed forever; nothing posted.
 *   - Android: nothing posted; a voice call sat on an unrelated 120s literal.
 * In every case the server polled its full 90s and then told the user, in one
 * sentence, that they may have ignored the prompt OR capture may be unavailable
 * OR the app may be backgrounded. It knew none of the three. The phone knew.
 *
 * That is invariant 3 (post on EVERY path) broken by the most ordinary outcome
 * there is, and invariant 6 (only a decline may be reported as a decline) losing
 * its teeth — because `expired` was unreachable without a tap.
 *
 * These pins require a timer that FIRES, on all three surfaces, and that a real
 * answer cancels it — an uncancelled deadline dismisses the NEXT capture's prompt.
 */
describe('the consent window closes itself, with no tap', () => {
  // Same explicit-index slicer the abandon block uses: `indexOf` = -1 makes
  // `slice(-1)` return one truthy character that matches nothing, so a vacuous
  // pin passes forever. (Cost two cycles in this loop already.)
  const arm = (hay: string, from: string, to: string) => {
    const a = hay.indexOf(from)
    expect(a, `no ${from} — the deadline never fires`).toBeGreaterThan(-1)
    const b = hay.indexOf(to, a)
    expect(b, `could not bound ${from}`).toBeGreaterThan(a)
    return hay.slice(a, b)
  }

  const askFn = (() => {
    const at = views.indexOf('private func askScreenshotConsent')
    expect(at, 'askScreenshotConsent renamed?').toBeGreaterThan(-1)
    return views.slice(at, views.indexOf('\n    /// The ChatView', at))
  })()
  const remoteFn = (() => {
    const at = screenshot.indexOf('func askRemoteConsent')
    expect(at, 'askRemoteConsent renamed?').toBeGreaterThan(-1)
    return screenshot.slice(at, screenshot.indexOf('\n    /// What a consent prompt', at))
  })()
  const answerFn = (() => {
    const at = views.indexOf('private func answerScreenshotConsent')
    expect(at, 'answerScreenshotConsent renamed?').toBeGreaterThan(-1)
    return views.slice(at, views.indexOf('\n    }', at))
  })()

  it('reads the three functions it means to read', () => {
    expect(askFn, 'did not slice askScreenshotConsent').toContain('withCheckedContinuation')
    expect(remoteFn, 'did not slice askRemoteConsent').toContain('UIAlertController')
    expect(answerFn, 'did not slice answerScreenshotConsent').toContain('resume(returning:')
  })

  it('iOS chat/voice resolves an unanswered prompt on its own', () => {
    // A sleep is not enough on its own — it has to RESOLVE the waiter, or the
    // turn still hangs while a Task quietly finishes.
    expect(askFn, 'nothing closes the window — an ignored prompt hangs the turn')
      .toMatch(/Task\.sleep\(for: \.seconds\(Screenshot\.consentWindow\)\)/)
    // Derived from the shared window, never a literal: a second number here would
    // drift from the one the tap is judged against.
    expect(askFn, 'the timer uses its own duration instead of the shared window')
      .not.toMatch(/Task\.sleep\(for: \.seconds\((?!Screenshot\.consentWindow)/)
    // …and what it resolves with must be `expired`, not a decline and not
    // `abandoned` (the user was there; nobody left, and nobody refused).
    expect(askFn, 'the deadline never resolves the waiter').toMatch(/answerScreenshotConsent\(\.expire\)/)
    expect(arm(askFn, 'case .expire:', 'case .allow:'), 'a timed-out prompt is not reported as expired')
      .toMatch(/return \.expired/)
    expect(askFn, 'the deadline reports a decline the user never made')
      .not.toMatch(/answerScreenshotConsent\(\.deny\)/)
  })

  it('an answered prompt cancels the deadline, or it kills the NEXT one', () => {
    // The timer outlives its own prompt otherwise: capture A is answered at 5s,
    // capture B is asked at 10s, and A's deadline fires at 70s onto B's alert.
    expect(answerFn, 'the deadline is never cancelled — it fires into the next capture')
      .toMatch(/screenshotDeadline\?\.cancel\(\)/)
    // Cancellation belongs on the ONE resume path, so allow/deny/abandon/expire
    // all get it. A cancel at an individual call site would miss the others.
    const cancels = views.match(/screenshotDeadline\?\.cancel\(\)/g) ?? []
    expect(cancels, 'the deadline is cancelled in more than one place — one path or none')
      .toHaveLength(1)
  })

  it('iOS relay posts the reason instead of stranding the poll', () => {
    // Anchored on the sleep, not on `Task {` — there are three of those in this
    // function (both tap handlers open one) and the first is the Allow closure, so
    // a `Task {`-anchored slice swallows the deny action and reads its postDenied.
    expect(remoteFn, 'the relay prompt has no self-closing deadline')
      .toMatch(/Task\.sleep\(for: \.seconds\(Self\.consentWindow\)\)/)
    const deadline = arm(remoteFn, 'Task.sleep(for: .seconds(Self.consentWindow))', '\n        }')
    expect(deadline, 'the expired relay prompt tells the phone but not the server')
      .toMatch(/postExpired\(toolUseId:/)
    expect(deadline, 'an expired prompt stays on screen, still armed')
      .toMatch(/alert\.dismiss\(animated:/)
    // It must NOT fire after a tap already resolved the ask — the last write to
    // the mailbox is what the poll reads, so this would overwrite a real answer.
    expect(deadline, 'the deadline fires even after the user answered')
      .toMatch(/guard alert\.presentingViewController != nil else \{ return \}/)
    expect(deadline, 'never report an untouched prompt as a decline')
      .not.toMatch(/postDenied/)
  })

  it('a late Allow tells the server too, not just the user', () => {
    // This arm showed explainExpired on the phone and posted nothing, so the
    // server still burned its remaining budget and then guessed.
    const allow = arm(remoteFn, '"Allow once"', `"Don't allow"`)
    const guardAt = allow.indexOf('isConsentStillLive')
    expect(guardAt, 'the late-tap guard is gone').toBeGreaterThan(-1)
    const stale = allow.slice(guardAt, allow.indexOf('return', guardAt))
    expect(stale, 'a late Allow strands the poll — invariant 3').toMatch(/postExpired\(toolUseId:/)
  })

  it('Android arms a deadline at launch, and a real answer cancels it', () => {
    const create = arm(androidConsent, 'override fun onCreate', 'private fun armDeadline')
    expect(create, 'the consent dialog opens with nothing to close it')
      .toMatch(/armDeadline\(toolUseId\)/)
    const armFn = arm(androidConsent, 'private fun armDeadline', '/** True once')
    expect(armFn, 'the deadline uses its own duration instead of the shared window')
      .toMatch(/delay\(CONSENT_WINDOW_MS\)/)
    expect(armFn, 'an ignored system dialog still posts nothing').toMatch(/postExpired\(app, toolUseId\)/)
    expect(armFn, 'never report an untouched dialog as a decline').not.toMatch(/postDenied/)
    // Not lifecycleScope: this activity is transparent and can be destroyed while
    // the system dialog is up — precisely when the report is most needed.
    expect(armFn, 'a lifecycle-scoped timer dies exactly when it is needed')
      .not.toMatch(/lifecycleScope/)
    // The result handler must cancel it BEFORE any post, or "expired" lands on
    // top of a grant that is capturing.
    const handler = arm(androidConsent, 'registerForActivityResult', 'override fun onCreate')
    const cancelAt = handler.indexOf('deadline?.cancel()')
    expect(cancelAt, 'a real answer does not cancel the deadline').toBeGreaterThan(-1)
    expect(cancelAt, 'the deadline is cancelled after the outcome is posted — it can overwrite it')
      .toBeLessThan(handler.indexOf('ScreenshotService.start'))
  })

  it("Android's voice waiter derives its timeout from the window it races", () => {
    // A bare 120_000 sat here, unrelated to the 70s window and the 20s delivery
    // cost it was waiting behind. Safe by accident of direction; an edit to either
    // number would not have noticed the other.
    const bridge = arm(mainActivity, 'if (name == "screenshot")', 'runCatching { liveCall.sendToolResult')
    expect(bridge, 'did not slice the voice bridge').toContain('ScreenshotConsentActivity.launch')
    expect(bridge, 'the voice waiter still hardcodes a timeout unrelated to the window')
      .not.toMatch(/withTimeoutOrNull\(\d[\d_]*\)/)
    expect(bridge, 'the waiter no longer derives its budget from the consent window')
      .toMatch(/CONSENT_WINDOW_MS \+[\s\S]{0,120}DELIVERY_GRACE_MS/)
  })

  it('the local deadline still lands inside the server budget, on both phones', () => {
    // The whole point of closing the window ourselves is to be heard: the report
    // has to arrive while the poll is still checking. iOS resolves at
    // consentWindow (=poll-grace) and posts immediately; Android the same. If the
    // window ever crept up to the poll budget, the self-close would deliver into
    // a mailbox nobody reads — back to the 90s guess.
    const poll = win(screenshot, /serverPollBudget: TimeInterval = (\d+)/)
    const window = poll - win(screenshot, /deliveryGrace: TimeInterval = (\d+)/)
    expect(window, 'the self-closing report arrives after the poll gave up').toBeLessThan(poll)
    // And the voice waiter must outlast the deadline that answers it, or it gives
    // up with "capture timed out" over a phone that had the real reason ready. Read
    // the terms the waiter ACTUALLY sums — restating the arithmetic here would pass
    // whatever the source said (window - grace + grace is just the poll budget).
    const bridge = mainActivity.slice(mainActivity.indexOf('if (name == "screenshot")'))
    const terms = arm(bridge, 'withTimeoutOrNull(', 'app.screenshots.first')
    expect(terms, 'unreadable voice waiter budget').toContain('CONSENT_WINDOW_MS')
    // Both constants are DERIVED in Kotlin, so resolve them from the two literals
    // rather than looking for a number that isn't written down.
    const pollMs = win(androidConsent, /SERVER_POLL_BUDGET_MS = ([\d_]+)L/)
    const graceMs = win(androidConsent, /DELIVERY_GRACE_MS = ([\d_]+)L/)
    const value: Record<string, number> = {
      CONSENT_WINDOW_MS: pollMs - graceMs,
      DELIVERY_GRACE_MS: graceMs,
      SERVER_POLL_BUDGET_MS: pollMs,
    }
    const budget = Object.keys(value)
      .filter(k => terms.includes(k))
      .reduce((sum, k) => sum + value[k], 0)
    expect(budget, 'the waiter names no known duration constant').toBeGreaterThan(0)
    expect(budget, 'the voice waiter gives up before the deadline can answer it')
      .toBeGreaterThan(window * 1000)
  })
})

/**
 * 🗣️ THE SERVER'S LAST WORD MUST NOT BLAME THE USER FOR SILENCE.
 *
 * `makeScreenshotTool`'s timeout message offered the model three causes: the user
 * may not have responded to the prompt, capture may be unavailable, or the app
 * went to background. Every one of those is now self-reported by the phones, each
 * as its own tagged payload, in time to be read:
 *
 *   unanswered   → `expired`, posted when the consent window closes ITSELF, a
 *                  deliveryGrace BEFORE this poll ends (P2.5 + P2.7)
 *   unavailable  → {ok:false, error:…} from ReplayKit / Fail.unavailable
 *   backgrounded → a named failure posted before a prompt is even attempted
 *
 * So silence at the end of the poll now means something the message did NOT
 * name — the device never got the event, or its own best-effort POST failed, or
 * it vanished mid-capture. Leading with user inaction (the one cause positively
 * excluded) told the model to tell the user they ignored a prompt they may never
 * have seen. That is invariant 6's confabulation moved up a layer: the whole arc
 * exists to stop the machine inventing a human decision.
 *
 * These pins hold the exclusion in place. They deliberately do NOT pin the exact
 * prose — only that the message stops asserting the excluded cause, still says
 * how long it waited, and tells the model what NOT to say.
 */
describe('the server does not guess when the phones have stopped being silent', () => {
  const shotTool = (() => {
    const at = platform.indexOf('export const makeScreenshotTool')
    expect(at, 'makeScreenshotTool renamed?').toBeGreaterThan(-1)
    return platform.slice(at, platform.indexOf('export const', at + 10))
  })()
  const terminal = (() => {
    // The message after the loop — everything from the loop's closing brace on.
    const at = shotTool.lastIndexOf('return {')
    expect(at, 'no terminal return in makeScreenshotTool').toBeGreaterThan(-1)
    return shotTool.slice(at)
  })()

  it('reads the tool and its terminal message', () => {
    expect(shotTool, 'did not slice makeScreenshotTool').toContain("name: 'screenshot'")
    expect(terminal, 'did not slice the terminal message').toContain('ok: false')
  })

  it('silence is no longer reported as the user ignoring the prompt', () => {
    // The exact phrasing is free to change; asserting the CLAIM is gone is not.
    expect(terminal, 'the timeout message still blames the user for not responding')
      .not.toMatch(/may not have responded/i)
    // And it must actively stop the model reaching for that story anyway — the
    // model will otherwise supply the same guess from the tool description.
    expect(terminal, 'the message does not tell the model what NOT to conclude')
      .toMatch(/[Dd]o NOT tell the user they ignored/)
  })

  it('the three self-reported causes are named as EXCLUDED, not as candidates', () => {
    // They may still appear — as the reasons this is *not* one of them, which is
    // the useful information. What must not survive is offering them as guesses.
    //
    // ⚠️ An alternation here was VACUOUS: /rules out|report themselves|no reason
    // either/ still matched after the entire exclusion clause was deleted, because
    // "and no reason either" survives in the opening sentence. The mutant lived.
    // So require the two halves that only the clause itself can supply — that the
    // ordinary causes are ruled OUT, and WHY (they report themselves).
    expect(terminal, 'the message no longer says the ordinary causes are ruled out')
      .toMatch(/rules? out/i)
    expect(terminal, 'the message never explains WHY they are ruled out')
      .toMatch(/report themselves/i)
    expect(terminal, 'still floats "capture may be unavailable" as a live possibility')
      .not.toMatch(/capture may be unavailable/i)
    expect(terminal, 'still floats "the app went to background" as a live possibility')
      .not.toMatch(/app went to background/i)
  })

  it('the wait it quotes is the budget it actually waited, not a literal', () => {
    // The message used to hardcode "90s" beside a loop that could change under
    // it. It now interpolates the derived constant.
    expect(terminal, 'the message hardcodes a duration that can drift from the loop')
      .not.toMatch(/within 90s|\b90 seconds\b/)
    expect(terminal, 'the message no longer quotes the real budget')
      .toMatch(/\$\{SHOT_POLL_BUDGET_S\}/)
  })

  it('a decline is still first-class, and a tagged failure still passes through', () => {
    // The honest-silence rewrite must not have swallowed the outcomes the phones
    // DO report — that would be the same information loss in the other direction.
    expect(shotTool, 'a declined capture is no longer surfaced as denied')
      .toMatch(/p\?\.denied\) return \{ ok: false, denied: true/)
    expect(shotTool, "the device's own error text is no longer passed through")
      .toMatch(/String\(p\?\.error \|\|/)
  })
})

/**
 * 🔇 THE REASON HAS TO TRAVEL WITH THE SIGNAL (Android's voice bridge).
 *
 * The screenshot round-trip answers TWO listeners: the server's mailbox poll
 * (`/api/chat/tool-result`, which gets a full JSON payload) and, during a voice
 * call, an in-process `SharedFlow` waiter — because the live WS turn is not
 * reading the mailbox at all.
 *
 * That flow carried one field, `url`, so every non-success arrived as `""` and
 * the bridge had to GUESS which one it was. It guessed `{denied:true}`. So a
 * grant that landed after its request expired, an encode that failed, and an
 * upload that 500'd were all reported to the model as "the user declined this
 * capture" — a refusal the user never made, spoken back to them in the call.
 * The mailbox payloads distinguished these correctly the whole time; only the
 * voice leg lied, which is why the consent tests passed while shipping it.
 *
 * The fix is structural, not a third branch: an explicit outcome on the event.
 * These pins exist so the collapse can't come back as a "simplification" —
 * `url.isEmpty()` reads like a perfectly reasonable check.
 */
describe('a screenshot outcome says WHY, not just "no url"', () => {
  const voiceBridge = (() => {
    const at = mainActivity.indexOf('if (name == "screenshot")')
    return mainActivity.slice(at, mainActivity.indexOf('runCatching { liveCall.sendToolResult', at))
  })()

  it('reads the bridge it means to read', () => {
    expect(voiceBridge.length).toBeGreaterThan(300)
    expect(voiceBridge).toContain('ScreenshotConsentActivity.launch')
    expect(voiceBridge).toContain('app.screenshots.first')
  })

  it('the event carries an outcome, not just a url', () => {
    const at = tinyAppKt.indexOf('data class ScreenshotResult')
    expect(at, 'ScreenshotResult renamed?').toBeGreaterThan(-1)
    const cls = tinyAppKt.slice(at, tinyAppKt.indexOf(')', tinyAppKt.indexOf('outcome', at)))
    expect(cls, 'the flow event has no outcome field — WHY is unrecoverable')
      .toMatch(/val outcome: ShotOutcome/)
    // All four reasons must be nameable, or a caller is forced to overload one.
    const en = tinyAppKt.match(/enum class ShotOutcome \{([^}]+)\}/)?.[1] ?? ''
    for (const c of ['OK', 'DENIED', 'EXPIRED', 'FAILED']) {
      expect(en, `ShotOutcome cannot express ${c}`).toContain(c)
    }
  })

  it('the voice bridge branches on the outcome, never on an empty url', () => {
    expect(voiceBridge, 'the bridge is back to inferring the reason from a missing url')
      .not.toMatch(/url\.isEmpty\(\)/)
    expect(voiceBridge, 'the bridge no longer switches on the outcome')
      .toMatch(/when \(res\?\.outcome\)/)
  })

  it('only a real decline is reported as a decline', () => {
    // The whole defect in one assertion: exactly ONE arm may say denied, and it
    // must be the DENIED arm.
    const arms = voiceBridge.split(/\n\s*(?=null ->|TinyApp\.ShotOutcome\.)/).slice(1)
    const denying = arms.filter((a) => /put\("denied", true\)/.test(a))
    expect(denying, 'more than one outcome reports a user decline').toHaveLength(1)
    expect(denying[0], 'a decline is reported for something the user did not decline')
      .toMatch(/^TinyApp\.ShotOutcome\.DENIED\b/)
  })

  it('every outcome is answered, and expiry/failure say what happened', () => {
    for (const c of ['DENIED', 'EXPIRED', 'FAILED', 'OK']) {
      expect(voiceBridge, `the voice bridge drops ${c} on the floor`)
        .toContain(`TinyApp.ShotOutcome.${c} ->`)
    }
    // A missing event is still distinct from all four: the waiter timed out.
    expect(voiceBridge).toMatch(/null ->[\s\S]*?capture timed out/)
    const expired = voiceBridge.slice(voiceBridge.indexOf('ShotOutcome.EXPIRED ->'))
    expect(expired.slice(0, expired.indexOf('ShotOutcome.FAILED')))
      .toMatch(/expired/)
  })

  it('no emit falls back to guessing — every site tags its reason', () => {
    // The default parameter infers OK/FAILED from the url, which is right for
    // the success call only. Any OTHER untagged emit is a silent re-collapse.
    const emits = androidShot.match(/emitScreenshot\([^)]*\)/g) ?? []
    expect(emits.length, 'no emit sites found — did Screenshot.kt move?')
      .toBeGreaterThanOrEqual(6)
    const untagged = emits.filter((e) => !e.includes('ShotOutcome.'))
    // Exactly one: the success path, which passes a real url.
    expect(untagged, `untagged emits: ${untagged.join(' | ')}`).toHaveLength(1)
    expect(untagged[0]).toMatch(/emitScreenshot\(toolUseId, url\)/)
    // And each failure kind is represented at least once.
    for (const c of ['DENIED', 'EXPIRED', 'FAILED']) {
      expect(emits.join('\n'), `nothing ever emits ${c}`).toContain(`ShotOutcome.${c}`)
    }
    // …and the BRIDGE has to honour the tag it was handed. Every assertion above
    // is about the call sites, so dropping the `outcome ?:` pass-through — one
    // token, in a file none of them read — reverts all six of them to the url
    // guess with the wiring still on screen. A Kotlin default parameter severs a
    // wire that way: the argument is accepted, ignored, and nothing warns.
    const emitAt = tinyAppKt.indexOf('fun emitScreenshot(')
    expect(emitAt, 'emitScreenshot is gone — re-anchor this pin').toBeGreaterThan(-1)
    const emitFn = tinyAppKt.slice(emitAt, tinyAppKt.indexOf('\n    override fun onCreate', emitAt))
    expect(emitFn, 'the emit signature no longer accepts a reason')
      .toMatch(/outcome: ShotOutcome\? = null/)
    expect(emitFn, 'the caller\'s outcome is dropped — every emit is back to guessing from the url')
      .toMatch(/outcome \?: if \(url\.isEmpty\(\)\)/)
  })

  it('the in-chat card still ignores the outcome and checks the url', () => {
    // The OTHER consumer must NOT grow a switch: it attaches an image, so the
    // only question it can answer is "are there pixels". Pinned because the
    // temptation after this change is to make it symmetric.
    const at = chatVm.indexOf('private fun attachScreenshot')
    expect(at, 'attachScreenshot renamed?').toBeGreaterThan(-1)
    const fn = chatVm.slice(at, chatVm.indexOf('\n    }', at))
    expect(fn, 'the image card started reasoning about consent outcomes')
      .not.toMatch(/ShotOutcome/)
    expect(fn, 'the image card no longer guards on having pixels').toMatch(/isEmpty\(\)/)
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
