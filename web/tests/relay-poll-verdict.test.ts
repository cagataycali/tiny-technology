// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The relay poll's WIRING — who a silence is allowed to be about.
 *
 * The DECISION is tested for real in Swift (`TinyTests.swift`, `RelayPollTests`,
 * 10 tests through `RelayPoll.classify` / `.isTerminal` / `.verdict`). What Swift
 * cannot reach is either loop: both live inside `async` functions on a view or a
 * `@MainActor` class, and the defect was a `guard let … else { continue }` INSIDE
 * one of them — the exact place `readFrameAnswer`'s own doc says bugs hide.
 *
 * The defect: `GET /api/devices/relay?inReplyTo=…` answers three distinguishable
 * things — an empty mailbox, a refusal (`ApiError.http`: 401 when the session
 * lapsed mid-poll, 424 when the worker had a problem), and nothing at all — and
 * `try?` flattened all three to nil. Only the first is evidence about the device,
 * and both loops ended on a sentence blaming it: "No frame in 19s — is the camera
 * awake?" and "<laptop> didn't answer in 30s — is `tiny mesh` still running
 * there?" So a phone that had quietly signed itself out sent its owner to a
 * camera that was awake and a laptop whose daemon was running.
 *
 * ⚠️ Every scan strips comments. `RelayPoll`'s doc QUOTES both of those
 * sentences, and both loops' docs quote the idiom they replaced — a raw-file scan
 * therefore finds the defect in the prose explaining its removal. Third
 * increment running that this trap has bitten (inc 29, inc 31, here): scan CODE,
 * never prose, whenever the prose deliberately quotes the code.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
/** Whole-line `//` and `///` comments removed. */
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '')

/** A slice between two anchors, with both anchors proven present first. */
const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return strip(src.slice(a, b))
}

/** The camera's shared round-trip, which the devices list's panel also uses. */
const frameResult = () =>
  between(raw('ios/Tiny/Sources/TinyLive.swift'),
          'static func frameResult(', 'static func fetchFrame(', 'frameResult')

/** The Flipper panel's status check — the surface that reported the bug. */
const flipperCheck = () =>
  between(raw('ios/Tiny/Sources/Panels.swift'),
          'func check() async {', '\nstruct DeviceRow', 'FlipperDevicePanel.check')

const relayPoll = () =>
  between(raw('ios/Tiny/Sources/TinyLive.swift'), 'enum RelayPoll {', '\nfinal class SegmentAudio',
          'RelayPoll')

/**
 * The body of ONE `switch` arm: from its label to the next label, `default:`, or
 * the brace closing the switch — whichever comes first.
 *
 * ⚠️ Order-INDEPENDENT on purpose. This began as `slice(from .deviceSilent, to
 * .couldNotAsk)`, which quietly required the arms to be written in that order —
 * and Swift is indifferent to the order of two distinct cases. A probe that
 * merely SWAPPED them, changing nothing a compiler or a user could observe,
 * turned this suite red. A pin that punishes a neutral refactor teaches the next
 * reader to delete it, and it would have been deleted for the wrong reason.
 * (A continuation line — `+ "…"` — is not a label, so a multi-line arm survives
 * the scan.)
 */
const armOf = (body: string, label: string, what: string) => {
  const at = body.indexOf(label)
  expect(at, `${what}: the ${label} arm is gone — re-anchor`).toBeGreaterThan(-1)
  const rest = body.slice(at + label.length)
  const end = /\n\s*(?:case\s|default:|\})/.exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

describe('a timeout must be EARNED by reading the mailbox', () => {
  /**
   * The rule, on both loops at once. `.noReply` / "didn't answer" is a claim
   * about the hardware, so it may only be reached from the arm where we actually
   * saw an empty mailbox — never as the fall-through for our own failure to ask.
   */
  it('the device is blamed only from the arm that observed it', () => {
    for (const [what, body, blame] of [
      ['frameResult', frameResult(), '.noReply(seconds:'],
      ['flipper', flipperCheck(), "didn't answer in"],
    ] as const) {
      // ⚠️ Containment, not `claim > silent`: an index merely GREATER than the
      // `.deviceSilent` label is also satisfied by the blame moved INTO
      // `.couldNotAsk`, which is the original bug wearing the new switch. And
      // containment of the ARM (see `armOf`), not of the span between the two
      // labels, so the arms may be written in either order.
      expect(body, `${what}: the .couldNotAsk arm is gone`).toContain('case .couldNotAsk')
      const observed = armOf(body, 'case .deviceSilent:', what)
      expect(observed, `${what}: the timeout copy left the .deviceSilent arm`).toContain(blame)
      // …and exactly once in the whole loop, so a second unguarded copy can't
      // creep back into the refusal path beside it.
      expect(body.split(blame).length - 1, `${what}: ${blame} appears more than once`).toBe(1)
    }
  })

  it('both loops go through the shared decision, not their own guard', () => {
    for (const [what, body] of [['frameResult', frameResult()], ['flipper', flipperCheck()]] as const) {
      expect(body, what).toMatch(/switch await RelayPoll\.read\(inReplyTo: query, token: token\)/)
      expect(body, what).toMatch(/RelayPoll\.verdict\(refusal: refusal\)/)
    }
    // The two idioms that swallowed the answer. `try?` on this GET discarded the
    // thrown ApiError; `getBody` returns a body but no STATUS, so the Flipper
    // panel could not tell a settled 401 from a transient 424.
    expect(frameResult()).not.toMatch(/try\? await Api\.get/)
    expect(flipperCheck()).not.toMatch(/Api\.getBody/)
  })

  /**
   * The invariant no Swift test can see, because it is an assignment inside the
   * loop: a successful read CLEARS the last refusal. Without it an early network
   * blip would outrank what we could see at the end, and the panel would report
   * "couldn't ask" for a device that really did stay silent — the same bug facing
   * the other way.
   */
  it('a read clears the refusal, so the LAST attempt decides', () => {
    for (const [what, body] of [['frameResult', frameResult()], ['flipper', flipperCheck()]] as const) {
      expect(body, what).toMatch(/case \.empty:\s*\n\s*refusal = nil/)
      expect(body, what).toMatch(/case \.unreadable\(let why, let \w+\):\s*\n\s*refusal = why/)
    }
  })

  /**
   * A settled refusal ends the wait. 19s (camera) or 30s (Flipper) of spinner
   * cannot make a signed-out session sign back in — and `isTerminal` is what
   * keeps this from becoming the opposite bug, since a 424 or a 5xx must still
   * spend its retries (the host has a whole agent turn to run).
   */
  it('a settled refusal ends the wait early, a transient one does not', () => {
    expect(frameResult()).toMatch(
      /if RelayPoll\.isTerminal\(status: status\) \{ return \.failure\(\.relayRefused\(why\)\) \}/)
    expect(flipperCheck()).toMatch(
      /if RelayPoll\.isTerminal\(status: httpStatus\) \{ error = why; return \}/)
  })

  /**
   * `.relayRefused` already existed for this and was reachable from the SEND arm
   * only. Three sites now: the send, the early exit, and the exhausted budget.
   */
  it('the refusal case is reachable from both ends of the round trip', () => {
    expect(frameResult().split('.relayRefused(').length - 1).toBe(3)
  })
})

describe('the poll cannot be served a stale "not yet"', () => {
  /**
   * ⚠️ Nearly lost in this change. The Flipper poll used `Api.getBody`, which
   * sets `.reloadIgnoringLocalCacheData` and says why: "a polled read must never
   * be served from the cache". Moving it onto `Api.get` — which had no such
   * policy — would have silently dropped a stated invariant, and this GET is the
   * worst possible case for it: the URL is constant for the whole poll and the
   * body is `{ reply: null }` until the device answers. The route sends NO
   * `Cache-Control` (its `json()` helper sets only `Content-Type`), so nothing
   * downstream would have protected it.
   */
  it('the shared read asks for a fresh body every time', () => {
    expect(relayPoll()).toMatch(/cachePolicy: \.reloadIgnoringLocalCacheData/)
  })

  it('the shared verb carries the policy, rather than a hand-rolled request', () => {
    const api = strip(raw('ios/Tiny/Sources/Api.swift'))
    // Threaded through the ONE request core every verb rides — inc 31's lesson.
    expect(api).toMatch(/cachePolicy: URLRequest\.CachePolicy = \.useProtocolCachePolicy/)
    expect(api).toMatch(/req\.cachePolicy = cachePolicy/)
    // Defaulted, so no other verb's behaviour moved with it.
    expect(relayPoll()).not.toMatch(/URLSession\.shared/)
  })

  it('the route really is uncacheable-by-omission, which is why the client must say it', () => {
    // The measurement behind the assertion above: if the route grew a
    // `Cache-Control: no-store` the client policy would be belt-and-braces
    // rather than load-bearing, and this test should be the one to notice.
    const route = raw('app/api/devices/relay/route.ts')
    expect(route).toMatch(/headers: \{ 'Content-Type': 'application\/json' \}/)
    expect(route).not.toMatch(/Cache-Control/)
    // …and the body really is a poll-until-present shape.
    expect(route).toMatch(/reply: data\.reply \?\? null/)
  })
})

describe('the decision itself is tested where it can be RUN', () => {
  it('the Swift suite exists and drives RelayPoll, not a source scan', () => {
    const swift = raw('ios/Tests/TinyTests.swift')
    // ⚠️ `indexOf` checked BEFORE slicing: `slice(-1)` is the last character,
    // which is not '', so the obvious `.not.toBe('')` passes with the suite
    // deleted. Same weakness inc 31 found in a pin of its own.
    const at = swift.indexOf('@Suite struct RelayPollTests')
    expect(at, 'RelayPollTests is gone — the decision would be untested').toBeGreaterThan(-1)
    const suite = swift.slice(at)
    expect(suite).toMatch(/RelayPoll\.classify\(\.failure\(ApiError\.http\(401, "login required"\)\)\)/)
    // The headline and its mirror image — neither direction may be dropped.
    expect(suite).toMatch(/aLapsedSessionIsNotASleepingCamera/)
    expect(suite).toMatch(/anEmptyMailboxStillEarnsATimeout/)
    // And the guard against fixing the lie by never blaming the device.
    expect(suite).toMatch(/onlyASettledRefusalEndsTheWait/)
  })

  it('RelayPoll is top-level, so a plain test can reach it', () => {
    // The lesson TinyTests already records twice: a helper on a @MainActor view
    // or class is a helper nothing pins.
    const live = raw('ios/Tiny/Sources/TinyLive.swift')
    const at = live.indexOf('\nenum RelayPoll {')
    expect(at, 'RelayPoll is gone or nested — re-anchor').toBeGreaterThan(-1)
    // Not indented: nesting it inside TinyLive would put it behind the actor.
    expect(live.slice(at + 1, at + 6)).toBe('enum ')
  })
})
