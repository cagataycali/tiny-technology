// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 A frozen frame is not a live view — on either surface.
 *
 * The robot panel polls a snapshot every 2s and, when a tick fails, deliberately
 * keeps the last good frame on screen: flashing an empty box over a working
 * camera is worse than showing a frame two seconds old. But the badge over that
 * frame said `live` from the first successful decode and was never withdrawn.
 *
 * On iOS it could not be withdrawn: `cameraFailed` is only ever assigned while
 * `frame == nil`, so after one success the panel had no way left to report a
 * failure at all. On web it was explicit — `onError` mapped the camera state back
 * onto itself precisely so the frame would survive, and the badge read that state
 * as proof the view was current. A chamber camera that died at 3am showed a still
 * picture of a finished print, labelled live, for as long as the page stayed open.
 *
 * Three claims per surface said it independently: the word, its accent tint, and
 * the alt/accessibility label. All three now read ONE boolean, published on the
 * poll's own schedule — because a stopped camera produces no renders, so anything
 * derived at render time would freeze along with the picture.
 *
 * The Swift suite (`FrameLivenessTests`) owns the rule's properties. This suite
 * owns what no unit test can see: that the views ask it, that both surfaces use
 * the same window, and that nothing formats its own answer on the side.
 */

const ROOT = process.cwd()
const SWIFT = join(ROOT, 'ios/Tiny/Sources/EndpointPanel.swift')
const PAGE = join(ROOT, 'app/devices/page.tsx')
const KT = join(
  ROOT,
  'android/app/src/main/java/technology/tiny/app/ui/EndpointPanel.kt',
)

/** Comments stripped: a rule explained in prose must not satisfy an assertion. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')

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

/**
 * The block introduced by `signature`, with the anchor ASSERTED first.
 *
 * `indexOf` answers -1 for a signature that moved and `slice(-1)` hands back one
 * character, on which every `.not.toMatch()` passes forever. Two suites in this
 * repo went vacuous exactly that way when `refresh()` grew a parameter.
 */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed? every pin below would be vacuous`)
    .toBeGreaterThan(-1)
  return braced(source, at)
}

/**
 * A FUNCTION's body — `body()` is wrong for one whose parameters are destructured.
 *
 * `braced()` takes the first `{` after the anchor, and for
 * `function EndpointPanel({ device, accent }: …)` that is the parameter pattern:
 * every web pin below then ran against the six characters of `{ device, accent }`
 * and half of them passed for the wrong reason. Anchor on the signature's own
 * `) {` instead.
 */
function fnBody(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`)
    .toBeGreaterThan(-1)
  const open = source.indexOf(') {', at)
  expect(open, `${signature} has no body — re-anchor`).toBeGreaterThan(at)
  return braced(source, open)
}

const count = (src: string, needle: RegExp) => src.match(needle)?.length ?? 0

describe('the live badge stops calling a frozen frame live', () => {
  const swiftRaw = readFileSync(SWIFT, 'utf8')
  const swift = code(swiftRaw)
  const pageRaw = readFileSync(PAGE, 'utf8')
  const page = code(pageRaw)
  const rule = code(body(swiftRaw, 'enum FrameLiveness {'))
  const panel = code(body(swiftRaw, 'struct EndpointPanel: View {'))
  const webPanel = code(fnBody(pageRaw, 'function EndpointPanel('))

  it('reads the files it means to read', () => {
    expect(rule).toContain('static func isLive(')
    expect(panel.length).toBeGreaterThan(2000)
    expect(webPanel.length).toBeGreaterThan(2000)
  })

  // ── the shared window ─────────────────────────────────────────────────────

  it('both surfaces go stale after the SAME three ticks', () => {
    // Two independently-chosen windows would mean the same dead camera reads
    // live on one device and stale on the other, which is the drift this pins.
    expect(rule).toMatch(/staleAfter: TimeInterval = 6\b/)
    expect(page).toMatch(/STALE_AFTER_MS = 6_000/)
    // And the window is three ticks of the poll each side actually runs — the
    // relationship, not just the number, since a poll-interval change has to
    // move the window with it.
    expect(panel, 'the iOS camera poll is no longer 2s — re-derive the window')
      .toMatch(/Task\.sleep\(for: \.seconds\(2\)\)/)
    expect(webPanel, 'the web camera poll is no longer 2s — re-derive the window')
      .toMatch(/setInterval\(tick, 2_000\)/)
  })

  // ── iOS wiring ────────────────────────────────────────────────────────────

  it('iOS: all three claims read ONE boolean', () => {
    // The word.
    expect(panel).toMatch(/FrameLiveness\.badge\(live: frameLive\)/)
    // No literal left behind: `Text("live")` was the badge, and a second source
    // for the same word is how one of the three drifts back.
    expect(panel, 'the badge hard-codes its word again').not.toMatch(/Text\("live"\)/)
    // The tint. `running` alone lit the accent, so a stale frame from a job that
    // is still printing glowed exactly like a live one.
    expect(count(panel, /frameLive && running/g),
      'both the dot and the label must gate their accent on liveness').toBe(2)
    expect(panel, 'an accent still keys off `running` alone')
      .not.toMatch(/\(running \? accent/)
    // The label.
    expect(panel).toMatch(/FrameLiveness\.spoken\(deviceName: deviceName, live: frameLive\)/)
    expect(panel, 'VoiceOver claims a live view unconditionally again')
      .not.toMatch(/accessibilityLabel\("Live camera view/)
  })

  it('iOS: liveness is published by the poll, not derived at render', () => {
    // Nothing else re-renders this panel. Computing the badge in `body` would
    // freeze it at whatever the last frame's arrival happened to make true.
    // Comment-stripped: this loop is DOCUMENTED by quoting its own code, so a
    // raw slice would let the prose satisfy the pin instead of the source.
    const loop = code(body(swiftRaw, 'private func cameraLoop() async {'))
    expect(loop).toMatch(/frameLive = FrameLiveness\.isLive\(frameAt: frameAt\)/)
    // OUTSIDE the scenePhase gate: the ticks skipped while backgrounded still
    // have to age the frame, or a phone out of a pocket finds a five-minute-old
    // picture still badged live.
    //
    // ⚠️ Brace-matched, not compared by index. "After `fetchingFrame = false`" is
    // ALSO true of the last line INSIDE the gate — a mutant that moved the
    // republish in there survived this pin while its comment claimed otherwise.
    const gateAt = loop.indexOf('if scenePhase == .active')
    expect(gateAt, 'the scenePhase gate moved — re-anchor').toBeGreaterThan(-1)
    expect(braced(loop, gateAt),
      'the republish sits INSIDE the gate: a backgrounded tick never ages the frame')
      .not.toContain('frameLive = FrameLiveness.isLive')
    const republish = loop.indexOf('frameLive = FrameLiveness.isLive')
    const sleep = loop.indexOf('Task.sleep')
    expect(republish, 'liveness is never republished').toBeGreaterThan(-1)
    expect(sleep, 'the republish must happen before the tick sleeps')
      .toBeGreaterThan(republish)
  })

  it('iOS: the frame and its stamp come from the same moment', () => {
    // A `frameAt` set anywhere else — at the top of the tick, say — would date
    // the REQUEST, and on a poll that can time out those are not the same fact.
    // Comment-stripped: this loop is DOCUMENTED by quoting its own code, so a
    // raw slice would let the prose satisfy the pin instead of the source.
    const loop = code(body(swiftRaw, 'private func cameraLoop() async {'))
    const at = loop.indexOf('frame = img')
    expect(at, 'the success assignment moved').toBeGreaterThan(-1)
    expect(loop.slice(at, at + 80)).toMatch(/frameAt = Date\(\)/)
    expect(count(loop, /frameAt = /g), 'exactly one write, on success only').toBe(1)
  })

  it('iOS: the age is drawn only with a frame under it, in the sheet voice', () => {
    // Same rule as the sheet's other two readings, and the same one function —
    // a second "as of" format is a second voice.
    expect(panel).toMatch(/if !frameLive, let asOf = ReadingAge\.asOf\(frameAt\) \{/)
    expect(panel, 'this panel formats its own clock instead of asking ReadingAge')
      .not.toMatch(/\.formatted\(date: /)
  })

  // ── web wiring ────────────────────────────────────────────────────────────

  it('web: the camera state stops being NAMED live', () => {
    // `camState === "live"` meant "a frame decoded once" — the conflation that
    // caused this. Renaming it is the fix at the root: `onError` still preserves
    // the state (so the frame survives) without that reading as liveness.
    expect(webPanel).toMatch(/"idle" \| "loaded" \| "failed"/)
    expect(webPanel, 'the camera state is called "live" again').not.toMatch(/setCamState\("live"\)/)
    expect(webPanel, 'a preserved frame still counts as a live view')
      .not.toMatch(/camState === "live"/)
    expect(webPanel).toMatch(/s === "loaded" \? "loaded" : "failed"/)
  })

  it('web: all three claims read ONE boolean', () => {
    expect(webPanel).toMatch(/\{frameLive \? "live" : "last frame"\}/)
    expect(count(webPanel, /frameLive && running/g),
      'both the dot and the text must gate their accent on liveness').toBe(2)
    expect(webPanel, 'an accent still keys off `running` alone')
      .not.toMatch(/[:{] running \? accent/)
    // alt text is the badge's claim for anyone who cannot see the picture.
    expect(webPanel).toMatch(/frameLive\s*\?\s*`Live camera view from/)
    expect(webPanel).toMatch(/:\s*`Last camera frame from/)
  })

  it('web: liveness is aged by the tick, and stamped by the load', () => {
    // The tick, not onError: a request that hangs past the deadline fires
    // NEITHER handler, and that is the failure most likely to strand the badge.
    const camEffect = webPanel.slice(webPanel.indexOf('if (!hasCamera) return'))
    expect(camEffect).toMatch(/setFrameLive\(Date\.now\(\) - frameAtRef\.current < STALE_AFTER_MS\)/)
    // onLoad owns the stamp — the only moment a frame is known to exist.
    expect(webPanel).toMatch(/frameAtRef\.current = t/)
    expect(webPanel).toMatch(/setFrameAt\(t\)/)
    // The ref exists so the tick can read the stamp without re-subscribing the
    // effect to it, which would tear down and restart the interval every frame.
    expect(webPanel).toMatch(/useRef\(0\)/)
  })

  it('web: the age needs a stamp AND a stale frame', () => {
    expect(webPanel).toMatch(/hasCamera && !frameLive && frameAt > 0/)
    expect(webPanel).toMatch(/asOfClock\(frameAt\)/)
  })

  it('web: the stamp is an instant with seconds, and names the day when it must', () => {
    // iOS parity (ReadingAge): "4m ago" would need a timer of its own to stay
    // true, and a tab left open overnight comes back holding last night's frame.
    const fmt = page.slice(page.indexOf('const asOfClock'), page.indexOf('const presenceOf'))
    expect(fmt.length, 'asOfClock moved — re-anchor').toBeGreaterThan(50)
    expect(fmt).toMatch(/toLocaleTimeString\(\)/)
    expect(fmt).toMatch(/toDateString\(\) === new Date\(nowMs\)\.toDateString\(\)/)
    expect(fmt).toMatch(/as of /)
    expect(fmt, 'an elapsed age needs a ticker this line does not have')
      .not.toMatch(/relativeAgo|ago`/)
  })

  // ── the third surface ─────────────────────────────────────────────────────
})

/**
 * The same three claims, on the Pixel. Ported once the phone was on the cable —
 * the `⚠️ FAILS WHEN FIXED` marker this replaces named the recipe and is now gone.
 *
 * Kotlin's own rule is unit-tested (`FrameLivenessTest`, and `ReadingAgeTest` for
 * the stamp). What no JVM test can see is the same thing no Swift test can: that
 * the Compose panel ASKS the rule, in all three places, and that the answer is
 * republished by the poll rather than computed while drawing.
 */
describe('the same live badge holds on the other phone', () => {
  const ktRaw = readFileSync(KT, 'utf8')
  const kt = code(ktRaw)
  const swiftRaw = readFileSync(SWIFT, 'utf8')
  const ktRule = code(body(ktRaw, 'internal object FrameLiveness {'))
  const ktPanel = code(body(ktRaw, 'fun EndpointPanel('))
  // The camera poll, not the telemetry one — both are `LaunchedEffect`s in the
  // same function and only one of them owns the frame.
  const ktLoop = code(body(ktRaw, 'LaunchedEffect(deviceId, hasCamera) {'))

  it('reads the files it means to read', () => {
    expect(ktRule).toContain('fun isLive(')
    expect(ktPanel.length).toBeGreaterThan(2000)
    expect(ktLoop.length).toBeGreaterThan(400)
    expect(ktLoop, 'anchored on the telemetry poll instead').toContain('fetchEndpointFrame')
  })

  it('all THREE surfaces go stale after the same three ticks', () => {
    // The window is the one number that must not be chosen twice: two of them mean
    // the same dead camera reads live on the phone in your hand and stale on the
    // tablet beside it. Both other surfaces are asserted above; this ties the third
    // to them, in the same units each language counts in.
    expect(ktRule).toMatch(/const val staleAfter = 6_000L/)
    expect(code(swiftRaw)).toMatch(/staleAfter: TimeInterval = 6\b/)
    expect(ktLoop, 'the Android camera poll is no longer 2s — re-derive the window')
      .toMatch(/delay\(2_000\)/)
  })

  it('Android: all three claims read ONE boolean', () => {
    // The word.
    expect(ktPanel).toMatch(/FrameLiveness\.badge\(frameLive\)/)
    expect(ktPanel, 'the badge hard-codes its word again').not.toMatch(/^\s*"live",\s*$/m)
    // The tint, both halves of it: the dot and the label. `running` alone lit the
    // accent, so a stale frame from a job that is still printing glowed exactly
    // like a live one.
    expect(count(ktPanel, /frameLive && running/g),
      'both the dot and the label must gate their accent on liveness').toBe(2)
    expect(ktPanel, 'an accent still keys off `running` alone')
      .not.toMatch(/if \(running\) accent/)
    // The label. TalkBack's claim is the one with no frozen picture beside it to
    // contradict it.
    expect(ktPanel).toMatch(/contentDescription = FrameLiveness\.spoken\(deviceName, frameLive\)/)
    expect(ktPanel, 'TalkBack claims a live view unconditionally again')
      .not.toMatch(/contentDescription = "Live camera view/)
  })

  it('Android: liveness is published by the poll, not computed while drawing', () => {
    // Compose recomposes on state change, and a stopped camera changes no state —
    // so `FrameLiveness.isLive(frameAt)` read inside the `Box` would freeze at
    // whatever the last frame made true, exactly like iOS's `body`.
    expect(ktLoop).toMatch(/frameLive = FrameLiveness\.isLive\(frameAt\)/)
    // ⚠️ The anchor is asserted before slicing: `indexOf` answers -1 for a layout
    // that moved and `slice(-1)` is one character, on which the negative below
    // passes forever.
    const drawAt = ktPanel.indexOf('Column(Modifier')
    expect(drawAt, 'the panel\'s layout root moved — re-anchor').toBeGreaterThan(-1)
    expect(ktPanel.slice(drawAt),
      'the badge recomputes liveness while drawing — it will freeze with the frames')
      .not.toMatch(/FrameLiveness\.isLive\(/)
    // ⚠️ Brace-matched, not compared by index. "After the fetch" is ALSO true of the
    // last line INSIDE the `resumed` gate, and a mutant that moved the republish in
    // there survived the equivalent iOS pin.
    const gateAt = ktLoop.indexOf('if (resumed)')
    expect(gateAt, 'the resumed gate moved — re-anchor').toBeGreaterThan(-1)
    expect(braced(ktLoop, gateAt),
      'the republish sits INSIDE the gate: a backgrounded tick never ages the frame')
      .not.toContain('frameLive = FrameLiveness.isLive')
    const republish = ktLoop.indexOf('frameLive = FrameLiveness.isLive')
    const sleep = ktLoop.indexOf('delay(2_000)')
    expect(republish, 'liveness is never republished').toBeGreaterThan(-1)
    expect(sleep, 'the republish must happen before the tick sleeps')
      .toBeGreaterThan(republish)
  })

  it('Android: the frame and its stamp come from the same moment', () => {
    const at = ktLoop.indexOf('frame = img')
    expect(at, 'the success assignment moved').toBeGreaterThan(-1)
    expect(ktLoop.slice(at, at + 120)).toMatch(/frameAt = System\.currentTimeMillis\(\)/)
    // Exactly one write, on success only: a failure path that advanced the stamp
    // would date a frame it did not deliver, which is the badge's bug one layer down.
    expect(count(ktLoop, /frameAt = /g), 'exactly one write, on success only').toBe(1)
  })

  it('Android: the age is drawn only with a stale frame under it, in the sheet voice', () => {
    // `ReadingAge` is the sheet's one voice for "when was this taken" — the necklace
    // camera asks the same function, and a second format here would be a second
    // clock. Which is precisely what this panel's Kotlin twin used to be.
    expect(ktPanel).toMatch(/if \(!frameLive\) \{\s*ReadingAge\.asOf\(frameAt\)/)
    expect(ktPanel, 'this panel formats its own clock instead of asking ReadingAge')
      .not.toMatch(/SimpleDateFormat|DateFormat\.get/)
  })
})
