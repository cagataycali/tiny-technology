// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📷 The camera panel raised an alarm about a request nobody made.
 *
 * `RelayCameraPanel.body` ends `.task { if unreachable == nil { refresh() } }` —
 * an ONLINE necklace gets a frame fetched the moment the devices sheet opens, on
 * purpose. When that automatic fetch failed, the panel reported it with the chrome
 * this app reserves for a user's own action going wrong: an orange warning
 * triangle, and a button labelled **Retry** — naming the repetition of something
 * the user had never done. Two necklaces on one account meant two alarms, each
 * one louder than the device's own name beside it, before the sheet had even
 * finished appearing. Meanwhile the panel's idle copy still said "tap to peek",
 * advertising a gesture it had already performed on the user's behalf.
 *
 * The panel already states the rule one branch up, for a board asleep in a
 * drawer: "Deliberately NOT the failure card: nothing failed." The automatic
 * fetch was the single path that escaped it.
 *
 * `PeekShape` is the rule and each phone's own suite tests its words (Swift
 * `PeekShapeTests`, JVM `PeekShapeTest`). What NEITHER can see is the WIRING: that
 * exactly one caller is unasked, that the alarm chrome lives only in the alarm
 * branch, and that the view asks the rule rather than re-deriving it — the defect
 * was one place claiming what another place decides. So the first describe pins
 * iOS's wiring, the second pins Android's; the rule's words are pinned in each
 * phone's native suite, where the shapes can actually be constructed.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const KT_PANELS = join(
  ROOT,
  'android/app/src/main/java/technology/tiny/app/ui/Panels.kt',
)

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

function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed?`).toBeGreaterThan(-1)
  return braced(source, at)
}

/**
 * Swift or Kotlin with its comments stripped: the fix is documented by quoting
 * the bug, so a whole-file scan would flag the explanation instead of the defect.
 * Both languages spell a line comment `//`, so one function serves both.
 */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

const count = (src: string, needle: RegExp) => src.match(needle)?.length ?? 0

describe('the camera panel is only as loud as the user asked it to be', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const panel = code(body(panels, 'struct RelayCameraPanel: View {'))
  const rule = code(body(panels, 'enum PeekShape: Equatable {'))
  const placeholder = code(
    body(panels, '@ViewBuilder private var placeholder: some View {'),
  )
  const refresh = code(body(panels, 'private func refresh(asked: Bool) {'))

  it('reads the file it means to read', () => {
    // A brace-matcher that silently returned "" would make every pin below pass
    // forever — and two pins in the suites this change touched had already gone
    // vacuous exactly that way, by anchoring on a signature that moved.
    expect(panel.length).toBeGreaterThan(2000)
    expect(rule).toContain('case quiet(String)')
    expect(placeholder).toContain('exclamationmark.triangle.fill')
    expect(refresh).toContain('busy = true')
  })

  it('exactly ONE caller is unasked, and it is the appearance fetch', () => {
    // The pin that makes the whole fix true. A second `asked: false` anywhere is
    // a user gesture whose failure would go quiet — the opposite mistake, and
    // the one that would hide a broken camera from someone actively looking.
    expect(count(panel, /asked: false/g), 'a second unasked peek appeared').toBe(1)
    expect(panel).toMatch(/\.task \{ if unreachable == nil \{ refresh\(asked: false\) \} \}/)
  })

  it('every gesture that reaches the camera says so', () => {
    // Three: the Retry button, the placeholder rectangle, the frame itself. All
    // three are the user asking, so all three keep the alarm on a failure.
    expect(count(panel, /refresh\(asked: true\)/g)).toBe(3)
    expect(placeholder).toMatch(/Button\("Retry"\) \{ refresh\(asked: true\) \}/)
    expect(placeholder).toMatch(/\.onTapGesture \{ refresh\(asked: true\) \}/)
    // The frame's own tap lives in `body`, outside the placeholder.
    const frame = panel.slice(panel.indexOf('Image(uiImage: f)'))
    expect(frame).toMatch(/\.onTapGesture \{ refresh\(asked: true\) \}/)
    // And no call site is left spelling the old signature.
    expect(panel, 'a caller still peeks without saying who asked')
      .not.toMatch(/refresh\(\)/)
  })

  it('refresh records provenance beside the call, and still always calls', () => {
    expect(refresh).toContain('self.asked = asked')
    // The gate stays at the appearance-triggered call, never inside the function
    // both share — guarding here would make a tap on a stale frame a no-op.
    expect(refresh, 'a tap became a silent no-op').not.toMatch(/unreachable|RelayReach/)
    // Provenance is recorded before the async work, so the shape can't be read
    // from a previous peek while this one is in flight.
    expect(refresh.indexOf('self.asked = asked')).toBeLessThan(refresh.indexOf('Task {'))
  })

  it('ONE rule decides the shape; the view does not re-derive it', () => {
    expect(panel).toMatch(
      /private var peek: PeekShape \{\s*PeekShape\.of\(error: error, busy: busy, asked: asked\)/,
    )
    // The old spelling, and the shape of the bug: the placeholder testing the
    // raw state itself. Two readers of two conditions is how the chrome drifted
    // away from who asked in the first place.
    expect(placeholder, 'the placeholder is deciding for itself again')
      .not.toMatch(/if let error, !busy/)
    // Nothing outside `peek` and `refresh` may branch on provenance directly:
    // the declaration and the two writes are it. (The `@State` initialiser is
    // deliberately not matched — it is the declaration, not a second reader.)
    const elsewhere = panel.replace(refresh, '').replace(/PeekShape\.of\([^)]*\)/, '')
    expect(elsewhere, 'a second reader of `asked` appeared')
      .not.toMatch(/if asked|asked \?|!asked|asked ==/)
  })

  it('the alarm chrome is inside the alarm branch and nowhere else', () => {
    // The whole complaint in one boundary. Everything that shouts — the triangle,
    // the orange, the Retry — belongs to `.alarm`; the else arm is the same grey
    // one-line shape the asleep-board branch already wears.
    const at = placeholder.indexOf('if case .alarm(let why) = peek {')
    expect(at, 'the alarm branch is gone or no longer reads the rule').toBeGreaterThan(-1)
    const elseAt = placeholder.indexOf('\n        } else {', at)
    expect(elseAt, 'the placeholder lost its else arm').toBeGreaterThan(at)
    const alarm = placeholder.slice(at, elseAt)
    const quiet = placeholder.slice(elseAt)

    expect(alarm).toContain('exclamationmark.triangle.fill')
    expect(alarm).toMatch(/foregroundStyle\(\.orange\)/)
    expect(alarm).toMatch(/Button\("Retry"\)/)

    expect(quiet, 'an unasked failure wears the alarm again')
      .not.toMatch(/exclamationmark|\.orange|Retry/)
    expect(quiet).toMatch(/foregroundStyle\(\.secondary\)/)
  })

  it('quiet is not silent: the reason still renders, and still wraps', () => {
    // A swallowed reason is the bug the panel's `error` state was added to fix —
    // dropping the alarm must not drop the words with it. And the reason is the
    // one string this panel exists to show, so it grows downward instead of
    // being clipped at an accessibility text size.
    expect(placeholder).toContain('Text(peek.quietReason ?? "tap to peek")')
    const at = placeholder.indexOf('Text(peek.quietReason ?? "tap to peek")')
    expect(placeholder.slice(at, at + 200)).toContain(
      '.fixedSize(horizontal: false, vertical: true)',
    )
    expect(placeholder, 'a truncated reason is the swallowed failure again')
      .not.toMatch(/\.lineLimit\(/)
  })

  it('the grey line speaks its reason out loud, not a label that replaces it', () => {
    // `.combine` merges the children and then the explicit label REPLACES them,
    // so a hard-coded "Peek at the camera" is a reason a VoiceOver user never
    // hears — the same defect DeviceOrder.spokenLabel fixed for device rows, one
    // panel deeper. Both strings come from the rule, which is tested in Swift.
    expect(placeholder).toMatch(/\.accessibilityElement\(children: \.combine\)/)
    expect(placeholder).toMatch(/\.accessibilityLabel\(peek\.spoken\)/)
    expect(placeholder).toMatch(/\.accessibilityHint\(peek\.spokenHint \?\? ""\)/)
    expect(placeholder, 'the label is hard-coded again and eats the reason')
      .not.toMatch(/accessibilityLabel\(busy \?/)
  })

  it('the working state still outranks a stale reason on screen', () => {
    // Pinned as ORDER, not presence: a `.working` case that were checked after
    // `.quiet` would leave the last failure's words under a live spinner. The
    // rule decides it, and this is the view honouring the decision.
    const working = placeholder.indexOf('if case .working = peek {')
    const reason = placeholder.indexOf('Text(peek.quietReason')
    expect(working, 'the spinner branch stopped reading the rule').toBeGreaterThan(-1)
    expect(reason).toBeGreaterThan(working)
    expect(rule).toMatch(/if busy \{ return \.working \}/)
  })

})

/**
 * The same rule, one phone later. Android carried the identical defect — its
 * `LaunchedEffect` took the same automatic first fetch and its `else if (why !=
 * null && !busy)` arm painted TinyWarn + a retry for whatever came back — and it
 * was pinned here as a fails-when-fixed marker while the Pixel was off the cable.
 * The marker is gone; these are what replace it.
 *
 * The Kotlin rule's own words are tested in `PeekShapeTest` (8 tests, JVM). What
 * no JVM test can see is the same thing no Swift test can: the WIRING.
 */
describe('the same peek provenance holds on the other phone', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const kt = readFileSync(KT_PANELS, 'utf8')
  const ktPanel = code(braced(kt, kt.indexOf('internal fun RelayCameraPanel')))
  const ktRule = code(braced(kt, kt.indexOf('internal sealed interface PeekShape')))

  it('reads the files it means to read', () => {
    // A brace-matcher that silently returned "" would make every pin below pass
    // forever — which is exactly how two pins in these suites went vacuous.
    expect(kt.indexOf('internal sealed interface PeekShape')).toBeGreaterThan(-1)
    expect(ktPanel.length).toBeGreaterThan(2000)
    expect(ktRule).toContain('data class Quiet(val why: String)')
  })

  it('both phones spell the same four shapes', () => {
    // Scraped from each declaration rather than listed, so a fifth shape on
    // either phone — or a renamed one — fails here instead of drifting.
    const rule = code(body(panels, 'enum PeekShape: Equatable {'))
    const ios = new Set(
      Array.from(rule.matchAll(/^\s{4}case (\w+)/gm)).map((m) => m[1].toLowerCase()),
    )
    expect(ios).toEqual(new Set(['working', 'idle', 'quiet', 'alarm']))
    const android = new Set(
      Array.from(ktRule.matchAll(/^\s{4}(?:object|data class) (\w+) ?[:(]/gm)).map((m) =>
        m[1].toLowerCase(),
      ),
    )
    expect(android).toEqual(ios)
  })

  it('the precedence is identical: busy wins, an empty reason is idle', () => {
    // Order, and then CONTENT — an `of` that read the three inputs in this order
    // and returned the wrong shape would satisfy an ordering-only pin.
    expect(ktRule).toMatch(/if \(busy\) return Working/)
    expect(ktRule).toMatch(/if \(error\.isNullOrEmpty\(\)\) return Idle/)
    expect(ktRule).toMatch(/return if \(asked\) Alarm\(error\) else Quiet\(error\)/)
    const busyAt = ktRule.indexOf('if (busy)')
    const emptyAt = ktRule.indexOf('if (error.isNullOrEmpty())')
    expect(busyAt).toBeGreaterThan(-1)
    expect(emptyAt).toBeGreaterThan(busyAt)
    expect(ktRule.indexOf('if (asked)')).toBeGreaterThan(emptyAt)
  })

  it('exactly ONE caller is unasked, and it is the appearance fetch', () => {
    // The pin that makes the whole fix true on this phone too. A second
    // `asked = false` is a user gesture whose failure would go quiet — the
    // opposite mistake, and the one that hides a broken camera from someone
    // actively looking at it.
    expect(count(ktPanel, /asked = false/g), 'a second unasked peek appeared').toBe(1)
    expect(ktPanel).toMatch(
      /LaunchedEffect\(deviceId, unreachable == null\) \{ if \(unreachable == null\) refresh\(asked = false\) \}/,
    )
  })

  it('every gesture that reaches the camera says so', () => {
    // Three, the same three as iOS: the retry control, the placeholder row, the
    // frame itself.
    expect(count(ktPanel, /refresh\(asked = true\)/g)).toBe(3)
    expect(ktPanel).toMatch(/TextButton\(\s*onClick = \{ refresh\(asked = true\) \}/)
    // The frame's own tap: inside the `bmp != null` arm, above the placeholder.
    const frameAt = ktPanel.indexOf('bmp.asImageBitmap()')
    expect(frameAt, 'the frame arm moved').toBeGreaterThan(-1)
    expect(ktPanel.slice(0, frameAt)).toMatch(/onClickLabel = "fetch a new frame",\s*\n\s*role = [^\n]*Role\.Button,\s*\n\s*\) \{ refresh\(asked = true\) \}/)
    // And no call site is left spelling the old signature.
    expect(ktPanel, 'a caller still peeks without saying who asked')
      .not.toMatch(/refresh\(\)/)
  })

  it('refresh records provenance beside the call, and still always calls', () => {
    const at = ktPanel.indexOf('fun refresh(asked: Boolean) {')
    expect(at, 'refresh lost its parameter').toBeGreaterThan(-1)
    const fn = braced(ktPanel, at)
    expect(fn).toContain('askedFor = asked')
    // The gate stays at the appearance-triggered call, never inside the function
    // both share — guarding here would make a tap on a stale frame a no-op.
    expect(fn, 'a tap became a silent no-op').not.toMatch(/unreachable|RelayReach/)
    // Recorded before the async work, so the shape can't be read off the previous
    // peek while this one is in flight.
    expect(fn.indexOf('askedFor = asked')).toBeLessThan(fn.indexOf('scope.launch {'))
    expect(fn.indexOf('askedFor = asked')).toBeLessThan(fn.indexOf('busy = true'))
  })

  it('ONE rule decides the shape; the composable does not re-derive it', () => {
    expect(ktPanel).toMatch(
      /val peek = PeekShape\.of\(error = error, busy = busy, asked = askedFor\)/,
    )
    // The old spelling, and the shape of the bug: the placeholder testing the raw
    // state itself. Two readers of two conditions is how the chrome drifted away
    // from who asked in the first place.
    expect(ktPanel, 'the placeholder is deciding for itself again')
      .not.toMatch(/why != null && !busy/)
    // Nothing outside the one `of` call may branch on provenance directly: the
    // declaration, the one write, and the one read are it.
    const elsewhere = ktPanel
      .replace(braced(ktPanel, ktPanel.indexOf('fun refresh(asked: Boolean) {')), '')
      .replace(/PeekShape\.of\([^)]*\)/, '')
    expect(elsewhere, 'a second reader of provenance appeared')
      .not.toMatch(/if \(asked|askedFor\)|!askedFor|askedFor ==/)
  })

  it('the alarm chrome is inside the alarm branch and nowhere else', () => {
    // The whole complaint in one boundary. Everything that shouts — the ⚠, the
    // TinyWarn, the retry — belongs to `Alarm`; the else arm is the same grey
    // one-line shape the asleep-board branch already wears.
    const at = ktPanel.indexOf('} else if (peek is PeekShape.Alarm) {')
    expect(at, 'the alarm branch is gone or no longer reads the rule').toBeGreaterThan(-1)
    const elseAt = ktPanel.indexOf('\n            } else {', at)
    expect(elseAt, 'the placeholder lost its else arm').toBeGreaterThan(at)
    const alarm = ktPanel.slice(at, elseAt)
    // Brace-matched, NOT sliced to the end of the panel: the footer below this
    // `if` legitimately paints a failed refresh in TinyWarn over a kept frame, so
    // an unbounded slice would fail on the one line that is supposed to be there.
    const quiet = braced(ktPanel, elseAt)
    expect(quiet.length, 'the else arm brace-matched to nothing').toBeGreaterThan(500)

    expect(alarm).toContain('"⚠ "')
    expect(alarm).toMatch(/color = TinyWarn/)
    expect(alarm).toMatch(/"↻ retry"/)
    // The card binds the reason off the SHAPE, so an alarm cannot render a
    // reason the rule decided belonged to a quiet line.
    expect(alarm).toMatch(/peek\.why/)

    expect(quiet, 'an unasked failure wears the alarm again')
      .not.toMatch(/⚠|TinyWarn|↻ retry/)
    expect(quiet).toMatch(/color = TinyGray/)
  })

  it('quiet is not silent: the reason still renders, and still wraps', () => {
    // A swallowed reason is the bug the panel's `error` state was added to fix —
    // dropping the alarm must not drop the words with it. And Compose wraps by
    // default, so what has to hold is that this render site caps nothing.
    expect(ktPanel).toContain('peek.quietReason ?: "📷 tap to peek"')
    const at = ktPanel.indexOf('peek.quietReason ?: "📷 tap to peek"')
    const around = ktPanel.slice(at, at + 300)
    expect(around, 'a truncated reason is the swallowed failure again')
      .not.toMatch(/maxLines|TextOverflow/)
    // Weighted, or a long reason pushes itself out of a Row that has a spinner
    // slot beside it.
    expect(around).toMatch(/Modifier\.weight\(1f\)/)
  })

  it('the grey line speaks its reason out loud, not a label that replaces it', () => {
    // Compose merges descendants and then the contentDescription REPLACES them,
    // exactly as iOS `.combine` + accessibilityLabel does — so a hard-coded
    // string here is a reason a TalkBack user never hears.
    expect(ktPanel).toMatch(
      /\.semantics\(mergeDescendants = true\) \{ contentDescription = peek\.spoken \}/,
    )
    // The affordance rides onClickLabel — Android's slot for "double-tap to …" —
    // and comes from the rule, which nulls it for the shapes whose own words
    // already say it.
    expect(ktPanel).toMatch(/onClickLabel = peek\.spokenHint/)
    expect(ktPanel, 'the label is hard-coded again and eats the reason')
      .not.toMatch(/contentDescription = "peek at the camera"/)
  })

  it('the working state still outranks a stale reason on screen', () => {
    // Pinned as ORDER **and** as content: a `Working` case checked after `Quiet`
    // would leave the last failure's words under a live spinner, and a branch
    // that read the rule but rendered the reason anyway would pass on order
    // alone.
    const working = ktPanel.indexOf('if (peek is PeekShape.Working) {')
    const reason = ktPanel.indexOf('peek.quietReason')
    expect(working, 'the spinner branch stopped reading the rule').toBeGreaterThan(-1)
    expect(reason).toBeGreaterThan(working)
    expect(ktPanel.slice(working, reason)).toContain('asking the camera…')
    expect(ktRule).toMatch(/if \(busy\) return Working/)
  })

  it('the asleep board still outranks BOTH, on both phones', () => {
    // A reason measured while the board was awake must not outlive the link — so
    // `unreachable` is read ahead of the shape, and it is not a failure: no ⚠, no
    // retry. This is the branch the automatic fetch escaped, and the reason
    // PeekShape exists at all.
    const unreachableAt = ktPanel.indexOf('if (unreachable != null) {')
    const alarmAt = ktPanel.indexOf('} else if (peek is PeekShape.Alarm) {')
    expect(unreachableAt).toBeGreaterThan(-1)
    expect(alarmAt).toBeGreaterThan(unreachableAt)
    expect(ktPanel.slice(unreachableAt, alarmAt)).toMatch(/Icons\.Outlined\.Bedtime/)
    expect(panels).toMatch(/} else if let unreachable \{/)
  })
})
