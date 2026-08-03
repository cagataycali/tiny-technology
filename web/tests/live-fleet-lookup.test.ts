// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The live view's FIRST call, and the sentence it told everyone.
 *
 * `connect` needs a device id, so it asked the fleet. The ask was
 * `guard let … = try? await Api.get("/api/devices") … else { return nil }`, and
 * `connect` turned that one nil into one sentence: **"No nicla-vision device in
 * your fleet — is it enrolled?"**
 *
 * Three unrelated things arrived as that sentence, and it is true of one:
 *   - the request was REFUSED (401 from a session that lapsed since the last
 *     screen, 424 from the worker). The necklace IS enrolled; the phone signed
 *     itself out. The user is sent to re-check their hardware when the fix is one
 *     tap on Log in.
 *   - the body could not be read — a 200 whose `devices` is not a list.
 *   - there really is no `nicla-vision` row. Correct here, and only here.
 *
 * `connect` draws exactly this distinction two lines earlier for a MISSING token
 * ("Log in first — the live view goes through your tiny"), so the view has always
 * cared; it just could not see a token that went stale rather than absent. And
 * `Api.getData`'s doc names the defect class in the same words — "that is how an
 * expired session became 'No calls yet'".
 *
 * The DECISION is tested in Swift (`FleetLookupTests`, 6 tests through
 * `TinyLive.readFleet`). These pins cover what Swift cannot reach: `lookUpVision`
 * and `connect` are `async` on a `@MainActor` view, so the wiring — which arm
 * says what, and whether a second swallowing door to the fleet exists — is only
 * visible in the source.
 *
 * ⚠️ Comments stripped before every scan. The new doc comment quotes the old
 * `try? await Api.get("/api/devices")` idiom AND the old sentence verbatim, so a
 * raw-file scan finds the defect in the prose explaining its removal.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return strip(src.slice(a, b))
}

const live = () => raw('ios/Tiny/Sources/TinyLive.swift')
const code = () => strip(live())
const connect = () =>
  between(live(), 'private func connect(token: String?) async {',
          '/// Pick the necklace to talk to', 'connect')
const readFleet = () =>
  between(live(), 'nonisolated static func readFleet(',
          '/// ⚠️ `contentMessage`, not `message`', 'readFleet')
const lookUpVision = () =>
  between(live(), 'static func lookUpVision(token: String?) async',
          '/// Split out from the fetch', 'lookUpVision')

/** The two send arms that must NOT change to `contentMessage`. */
const sendArm = (fn: string) =>
  between(live(), `static func ${fn}(deviceId:`, 'guard let msgId', `${fn} send arm`)

describe('the live view names the reason it could not find the necklace', () => {
  /**
   * The regression this whole increment exists to stop is not a dropped arm —
   * Swift's exhaustiveness catches that — it is two arms MERGED back into one
   * sentence. So the pin requires the colon immediately after `.noVision`:
   * `case .noVision, .couldNotAsk:` does not match it.
   */
  it('only a fleet with no necklace is told the necklace is not enrolled', () => {
    const src = code()
    const ARM = /case \.noVision:\s*\n\s*fail\("No nicla-vision device in your fleet[^"]*"\); return/
    expect(src, 'the enrollment sentence left its own arm — re-anchor, or it was merged').toMatch(ARM)
    // Region-split, not a count: a SECOND site is the defect, and a count would
    // also have to be nudged by any innocent edit that moved this one.
    expect(src.replace(ARM, ''), 'that sentence is reachable from a second place again')
      .not.toMatch(/No nicla-vision device in your fleet/)
  })

  it('a refusal is quoted, not reworded', () => {
    // `fail(why)`, verbatim. Anything else here is the app explaining a cause it
    // was handed the words for.
    expect(connect(), 'the refusal is being re-phrased instead of shown')
      .toMatch(/case \.couldNotAsk\(let why\):\s*\n\s*fail\(why\); return/)
  })

  it('there is exactly one door to the fleet, and it throws', () => {
    const src = code()
    const GET = /return readFleet\(try await Api\.get\("\/api\/devices", token: token\)\)/
    expect(src, 'the fleet fetch moved or stopped delegating to readFleet').toMatch(GET)
    // ⚠️ The exact defect shape, stated on its own so the failure reads plainly.
    expect(src, '`try?` is back on the fleet — a refusal is a nil again')
      .not.toMatch(/try\?\s+await\s+Api\.get\("\/api\/devices"/)
    // And no second fetch site of any spelling: a private helper that asks again
    // is how the swallowed answer got here in the first place.
    expect(src.replace(GET, ''), 'a second fleet lookup appeared — route it through lookUpVision')
      .not.toMatch(/Api\.get\("\/api\/devices"/)
  })

  it('connect asks through the verdict and reads all three answers', () => {
    const body = connect()
    expect(body, 'connect stopped asking lookUpVision').toContain('switch await Self.lookUpVision(token: token)')
    for (const arm of ['case .found(let device):', 'case .noVision:', 'case .couldNotAsk(let why):']) {
      expect(body, `connect no longer handles ${arm}`).toContain(arm)
    }
    // The view must not go back to deciding this itself — that is what made one
    // nil mean three things.
    expect(body, 'connect reads the fleet body directly again').not.toMatch(/\["devices"\]/)
  })

  it('the fleet is a list the user asked to SEE, so it gets contentMessage', () => {
    const body = lookUpVision()
    // ⚠️ `contentMessage`, anchored on the full spelling so `message(` cannot
    // satisfy it as a substring — the mistake `load-failure-caption` documents.
    expect(body, 'the fleet refusal lost the content rule')
      .toContain('LoadFailure.contentMessage(error)')
    expect(body, 'the fleet fell back to the chat table — which words a bare 404 as "That tiny doesn\'t exist"')
      .not.toMatch(/LoadFailure\.message\(/)
    expect(body, 'the throw is being swallowed here instead').not.toMatch(/try\?/)
  })

  it('the relay send arms keep the plain rule, because an invoke is something the user SENT', () => {
    // The distinction is the point: the same file uses both helpers, and each for
    // its own reason. If a future sweep "unifies" them, this is the arm that says
    // no.
    for (const fn of ['clipResult', 'frameResult']) {
      expect(sendArm(fn), `${fn}'s send arm switched to the content rule`)
        .toContain('LoadFailure.message(error)')
    }
  })

  it('the decision stays where a test can call it', () => {
    const src = code()
    // Dropping `nonisolated` is a WARNING here, not an error, so the Swift suite
    // would keep compiling while every call hopped the actor — and the 6 tests
    // that prove the three answers apart would be testing a different function.
    expect(src, 'readFleet left the nonisolated island — FleetLookupTests can no longer call it')
      .toMatch(/nonisolated static func readFleet\(/)
    const pure = readFleet()
    expect(pure, 'readFleet does I/O now — the pure half is what makes it testable')
      .not.toMatch(/await|Api\./)
    // The blank the Swift suite caught: `"error": ""` taken at face value renders
    // as an empty line, which is the silence this path was fixed to stop.
    expect(pure, 'a blank server error is trusted again — that renders as nothing at all')
      .toMatch(/trimmingCharacters/)
  })

  /**
   * ⚠️ Added at PORT TIME, not carried over: the pins above prove the three arms are
   * READ, and `FleetLookupTests` proves the three are RETURNED — but nothing in this
   * tree compiles Swift, so the second half arrived here as an assumption.
   *
   * A mutant found the hole. Turning `readFleet`'s
   * `guard let found = pickVision(from: list) else { return .noVision }` into
   * `else { return .couldNotAsk("no necklace") }` makes `.noVision` UNREACHABLE — the
   * one case for which "is it enrolled?" is the true answer can no longer be told, and
   * every empty fleet is reported as a refusal instead. Every pin above stayed green,
   * because `connect`'s switch still *has* the arm; it is simply never taken.
   *
   * So the property is pinned where it lives: at the two returns inside the pure half.
   */
  it('an empty fleet can still REACH the enrollment sentence', () => {
    const pure = readFleet()
    expect(pure, 'the noVision return left readFleet — connect\'s arm is now dead code, ' +
                 'and an empty fleet is reported as a refusal')
      .toMatch(/else \{ return \.noVision \}/)
    // And the unreadable-body guard must NOT be the one that returns it: those are the
    // two answers this increment exists to keep apart, and swapping them inside the
    // pure half is invisible to every arm-reading pin above.
    const guardBody = pure.slice(pure.indexOf('guard let list'), pure.indexOf('guard let found'))
    expect(guardBody.length, 'readFleet\'s two guards moved — re-anchor').toBeGreaterThan(40)
    expect(guardBody, 'an unreadable body now claims there is no necklace')
      .not.toMatch(/\.noVision/)
    expect(guardBody, 'the unreadable body stopped being reported as a refusal')
      .toMatch(/couldNotAsk/)
  })
})
