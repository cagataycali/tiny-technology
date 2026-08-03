// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Remote ears: the tap that could end in nothing at all.
 *
 * The DECISION is tested in Swift (`TinyTests.swift`, `ListenResultTests`, 8
 * tests through `TinyLive.readClipAnswer` and `ListenResult.note`). These pins
 * cover what Swift cannot reach: the `async` poll loop, the assignment that
 * delivers the outcome, and — the part no unit test can see — whether the
 * surface the outcome lands on is RENDERED anywhere the user is looking.
 *
 * The defect: `remoteListen` POSTed a `record` invoke, then polled with
 * `guard let … else { continue }` and regexed a `.wav` URL out of
 * `obj["result"]`. Four separate dead ends returned with nothing said — send
 * refused, poll refused, budget spent, and an answer carrying no URL — while the
 * panel went on reading "tiny necklace · remote". The user taps the ear, watches
 * a spinner for 36 seconds, and is told nothing: indistinguishable from not
 * having tapped.
 *
 * `readFrameAnswer` two screens below states the rule and names both bugs, having
 * fixed them for the camera. The server's `nicla_listen` — the SAME `record`
 * invoke on the SAME wire — has always made the necklace's own words the error
 * when it finds no URL. So the rule was written down twice and the microphone
 * followed neither.
 *
 * ⚠️ Comments stripped before every scan: the Swift docs quote `try?`,
 * "Couldn't reach the relay" and the old idiom, so a raw-file scan finds the
 * defect in the prose explaining its removal.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '')

const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return strip(src.slice(a, b))
}

/**
 * One `switch` arm, bounded at the NEXT sibling — whichever it is.
 *
 * ⚠️ Twin of `relay-poll-verdict.test.ts`'s `armOf`, and here for the same reason
 * it was written there: this suite originally sliced
 * `indexOf('case .deviceSilent') … indexOf('case .couldNotAsk', silent)`, which
 * quietly requires those two arms to appear IN THAT ORDER. Swift is indifferent
 * to the order of two distinct cases, so merely swapping them — a refactor that
 * changes no behaviour at all — reddened the pin. **A slice bounded at the NEXT
 * SIBLING is only safe when the siblings are ORDERED by something the language
 * cares about; between switch arms, order is free, so bind at ANY sibling.**
 * (A `+ "…"` continuation line is not a label, so a multi-line arm survives.)
 */
const armOf = (body: string, label: string, what: string) => {
  const at = body.indexOf(label)
  expect(at, `${what}: the ${label} arm is gone — re-anchor`).toBeGreaterThan(-1)
  const rest = body.slice(at + label.length)
  const end = /\n\s*(?:case\s|default:|\})/.exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

const live = () => raw('ios/Tiny/Sources/TinyLive.swift')
const remoteListen = () =>
  between(live(), 'func remoteListen() {', 'private static let clipPollTries', 'remoteListen')
const clipResult = () =>
  between(live(), 'static func clipResult(', '\n    /// Why a frame didn\'t arrive', 'clipResult')
const frameResult = () =>
  between(live(), 'static func frameResult(', 'static func fetchFrame(', 'frameResult')

describe('a listen tap always ends in a sentence', () => {
  /**
   * The delivery, not the decision. `ListenResult.note` is proven non-empty in
   * Swift; what Swift cannot see is whether anything ASSIGNS it.
   */
  it('every non-clip outcome is written to a note the panel reads', () => {
    const body = remoteListen()
    expect(body).toMatch(/switch await Self\.clipResult\(deviceId: id, token: token\)/)
    expect(body).toMatch(/case \.clip\(let url\):/)
    // The catch-all arm — so a case ADDED to ListenResult still gets shown
    // rather than silently joining the old silent paths.
    expect(body).toMatch(/case let outcome:\s*\n\s*speechNote = outcome\.note/)
    // The hand-rolled poll is gone from the panel entirely.
    expect(body).not.toMatch(/Api\.get|inReplyTo|JSONSerialization/)
  })

  /**
   * A note from the previous tap outranks nothing, so it must be cleared when a
   * new tap starts — otherwise "mic busy" from a minute ago reads as this tap's
   * answer, which is the same lie in a different direction.
   */
  it('a stale note is cleared before the new request', () => {
    const body = remoteListen()
    const cleared = body.indexOf('speechNote = nil')
    const asked = body.indexOf('clipResult(')
    expect(cleared, 'the stale-note clear is gone').toBeGreaterThan(-1)
    expect(cleared, 'the note is cleared AFTER the ask — a race with the answer').toBeLessThan(asked)
  })

  /**
   * ⚠️ The pin that made this increment pick `speechNote` over `lastError`:
   * `lastError` renders only inside `if let frame = live.frame { … } else { … }`'s
   * ELSE branch, so in remote mode with a working stream — exactly when the ear
   * is tapped — it is invisible. A sentence nothing renders is still silence.
   */
  it('the note is rendered OVER the frame, not only in place of it', () => {
    const view = live()
    const overlay = between(view, '.overlay(alignment: .bottom) {', '\n            HStack(spacing: 12)',
                            'subtitle overlay')
    expect(overlay).toMatch(/live\.speechNote/)
    // And the placeholder-only channel is still the placeholder-only channel:
    // if lastError ever becomes the listen channel, this pin should be revisited.
    const placeholder = between(view, 'if let frame = live.frame {', '.frame(width: 236',
                                'frame placeholder')
    expect(placeholder).toMatch(/live\.lastError \?\? live\.stateText/)
    expect(remoteListen(), 'lastError would be invisible here').not.toMatch(/lastError/)
  })

  /**
   * ⚠️ The property the whole increment exists for, pinned where this tree can
   * RUN it. `ListenResultTests.everyOutcomeExceptTheClipHasSomethingToSay`
   * executes it — in Swift, which nothing here compiles — so publicly it was
   * assumed. A mutant returning `nil` for `.noAnswer` (a tap that ends in
   * silence again, the exact defect) passed all ten ported pins.
   *
   * So: read `note`'s switch and require every arm except `.clip` to yield a
   * string. The scan asserts it FOUND the arms, because a slicer that returns
   * nothing passes forever.
   */
  it('only the clip has nothing to say', () => {
    const body = between(live(), 'var note: String? {', '\n    }\n\n    /// Read one reply payload',
                         'ListenResult.note')
    // `Array.from`, not a spread: this tsconfig targets below ES2015, so
    // `[...matchAll()]` is two `error TS2802` on a gate that runs clean.
    const arms = Array.from(body.matchAll(/case (\.[A-Za-z]+)[^\n:]*:\s*return ([^\n]+)/g))
    expect(arms.length, 'note\'s arms are gone — re-anchor').toBeGreaterThanOrEqual(4)
    for (const [, label, returned] of arms) {
      if (label === '.clip') {
        expect(returned.trim(), 'a clip speaks for itself').toBe('nil')
      } else {
        expect(returned.trim(), `${label} returns nil — that outcome is silent`).not.toBe('nil')
      }
    }
    // And every case the enum declares is answered by that switch, so a new
    // outcome cannot join the silent ones by omission.
    const cases = Array.from(
      between(live(), 'enum ListenResult: Equatable {', 'var note: String? {', 'ListenResult')
        .matchAll(/case ([a-zA-Z]+)/g),
      m => `.${m[1]}`)
    expect(cases.length, 'the enum\'s cases are gone — re-anchor').toBeGreaterThanOrEqual(4)
    expect(arms.map(a => a[1]).sort()).toEqual(cases.sort())
  })
})

describe('the clip round trip decides like the camera round trip', () => {
  it('the poll arm is RelayPoll, inherited rather than re-derived', () => {
    const body = clipResult()
    expect(body).toMatch(/switch await RelayPoll\.read\(inReplyTo: query, token: token\)/)
    expect(body).toMatch(/case \.empty:\s*\n\s*refusal = nil/)
    expect(body).toMatch(/if RelayPoll\.isTerminal\(status: status\) \{ return \.couldNotAsk\(why\) \}/)
    expect(body).toMatch(/RelayPoll\.verdict\(refusal: refusal\)/)
  })

  /** The inc-32 rule, on a third surface: blame the device only from `.deviceSilent`. */
  it('the necklace is blamed only from the arm that observed it', () => {
    const body = clipResult()
    // Containment of the ARM, not of the span between two NAMED arms — see armOf.
    expect(armOf(body, 'case .deviceSilent:', 'clipResult'),
           '.noAnswer left the .deviceSilent arm').toContain('.noAnswer(seconds:')
    expect(armOf(body, 'case .couldNotAsk(let why):', 'clipResult'),
           'the refusal arm blames the necklace — the original bug in the new switch')
      .not.toContain('.noAnswer(')
    expect(body.split('.noAnswer(seconds:').length - 1, 'more than one .noAnswer site').toBe(1)
  })

  /**
   * The SEND arm had its own copy of the same bug: `try?` discarded the route's
   * words, so a 401 on send became "Couldn't reach the relay" — a network shrug
   * over an answer that named its own cause. Fixed in BOTH round trips, because
   * two adjacent functions disagreeing about a 401 reads as intentional.
   */
  it('a refused send says what the route said, in both round trips', () => {
    for (const [what, body, wrap] of [
      ['clipResult', clipResult(), '.couldNotAsk(LoadFailure.message(error))'],
      ['frameResult', frameResult(), '.failure(.relayRefused(LoadFailure.message(error)))'],
    ] as const) {
      expect(body, what).toContain(wrap)
      expect(body, `${what}: try? still swallows the send`).not.toMatch(/try\? await Api\.post/)
    }
  })

  /** The budget the timeout quotes must be the budget it spent. */
  it('the poll budget is computed from the loop that spent it', () => {
    const body = clipResult()
    expect(body).toMatch(/for _ in 0 \.\.< clipPollTries/)
    expect(body).toMatch(/Task\.sleep\(for: \.seconds\(clipPollEvery\)\)/)
    expect(body).toMatch(/\.noAnswer\(seconds: Int\(Double\(clipPollTries\) \* clipPollEvery\)\)/)
  })
})

describe('iOS and the agent tool read the same wire the same way', () => {
  /**
   * `nicla_listen` and this panel send the identical `record` invoke and parse
   * the identical reply. The agreement was stated only in prose, on both sides —
   * so a change to either regex would leave one surface finding clips the other
   * calls prose, with nothing failing.
   */
  it('the WAV pattern is one pattern, not two that happen to match', () => {
    const swift = strip(live()).match(/#"(https:[^"]*\\\.wav)"#/)
    const server = strip(raw('lib/chat/tools/nicla.ts')).match(/\/(https:[^\n]*?\\\.wav)\/\.exec\(/)
    expect(swift, 'the Swift WAV regex is gone — re-anchor').not.toBeNull()
    expect(server, 'the server WAV regex is gone — re-anchor').not.toBeNull()
    // JS escapes the delimiter (`\/\/`); Swift's raw string does not.
    expect(swift![1]).toBe(server![1].replace(/\\\//g, '/'))
  })

  it('both surfaces treat a missing URL as the device having spoken', () => {
    // The server's half of the rule, which iOS now matches: `r.result` — the
    // necklace's own words — becomes the message, with a fallback only if it
    // said nothing at all.
    expect(strip(raw('lib/chat/tools/nicla.ts')))
      .toMatch(/if \(!url\) return \{ ok: false, error: r\.result \|\| 'The necklace answered without an audio URL\.' \}/)
    // iOS's half: no URL → the words, via the shared unwrapper.
    expect(strip(live())).toMatch(/else \{ return \.said\(text\) \}/)
    expect(strip(live())).toMatch(/let text = RelayReply\.text\(payload\)/)
  })
})

describe('the decision is tested where it can be RUN', () => {
  it('ListenResultTests exists and drives the real functions', () => {
    const swift = raw('ios/Tests/TinyTests.swift')
    const at = swift.indexOf('@Suite struct ListenResultTests')
    expect(at, 'ListenResultTests is gone — the decision would be untested').toBeGreaterThan(-1)
    const suite = swift.slice(at)
    expect(suite).toMatch(/TinyLive\.readClipAnswer/)
    // The headline: an answer with no clip is still an answer.
    expect(suite).toMatch(/anAnswerWithoutAClipIsStillAnAnswer/)
    // And the guard on the guard: a tap may not end in silence.
    expect(suite).toMatch(/everyOutcomeExceptTheClipHasSomethingToSay/)
  })
})
