// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🕒 A reading on the devices sheet has to say when it was taken.
 *
 * Two panels on that sheet fetch something over the relay and then keep showing
 * it. The camera stamped its frame `as of 8:35:12 AM`. The Flipper panel printed
 * the host agent's answer — firmware, a battery percentage, which machine the
 * cable is in — with nothing at all to say how old it was, so a reading taken
 * while the Flipper was plugged in read identically twenty minutes after someone
 * pulled the cable out. Three present-tense facts, no moment attached to any of
 * them.
 *
 * And the panel destroyed that reading in order to replace it: `check()` opened
 * with `status = nil`, so a panel that HAD an answer showed none for the whole
 * 30-second poll, and if the poll failed the answer was gone for good — leaving
 * the button reading "Check status" as though the user had never checked. The
 * camera panel one row up states the opposite rule in a comment ("a stale frame
 * is worth more than a blank rectangle, so keep whatever is already on screen and
 * report the reason beneath"), on the same sheet, for the same event.
 *
 * `ReadingAge` is the rule and the Swift suite tests its properties. What no
 * Swift test can see is the WIRING: that both panels read the one function, that
 * an age can never be drawn without the reading it dates, and that the reading
 * now survives the attempt to update it.
 */

const ROOT = process.cwd()
const PANELS = join(ROOT, 'ios/Tiny/Sources/Panels.swift')
const KT_PANELS = join(
  ROOT,
  'android/app/src/main/java/technology/tiny/app/ui/Panels.kt',
)

/** The `{ … }` block starting at or after `at`, brace-matched. */
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
 * The block introduced by `signature`.
 *
 * The anchor index is ASSERTED before slicing. `indexOf` answers -1 for a
 * signature that moved, `slice(-1)` hands back one character, and every
 * `.not.toMatch()` below would then pass forever on it — which is exactly how
 * two pins in this repo stopped pinning anything when `refresh()` grew a
 * parameter.
 */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — renamed? the pins would be vacuous`)
    .toBeGreaterThan(-1)
  return braced(source, at)
}

/** Swift with its comments stripped: every fix here is documented by quoting it. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

const count = (src: string, needle: RegExp) => src.match(needle)?.length ?? 0

describe('a reading on the devices sheet says how old it is', () => {
  const panels = readFileSync(PANELS, 'utf8')
  const all = code(panels)
  const rule = code(body(panels, 'enum ReadingAge {'))
  const camera = code(body(panels, 'struct RelayCameraPanel: View {'))
  const flipper = code(body(panels, 'struct FlipperDevicePanel: View {'))
  const check = code(body(panels, 'func check() async {'))

  it('reads the file it means to read', () => {
    expect(rule).toContain('static func asOf(')
    expect(camera.length).toBeGreaterThan(2000)
    expect(flipper.length).toBeGreaterThan(1000)
    expect(check).toContain('flipper_status')
  })

  it('ONE function decides a reading\'s age, and both panels ask it', () => {
    // The camera formatted the time inline, which left the sheet's second
    // reading free to date itself differently — or, as it did, not at all.
    expect(camera).toMatch(/ReadingAge\.asOf\(stamp\)/)
    expect(flipper).toMatch(/ReadingAge\.asOf\(stamp\)/)
    // And neither reading panel formats a time by hand any more. Scoped to those
    // two rather than the file: this panels file also dates a credential
    // ("forged 4 Aug 2026") and a scheduled job ("once at 4 Aug, 09:00"), and
    // neither is a reading kept on screen — one is a fact that never changes and
    // the other is the future.
    expect(camera, 'the camera formats its own time again').not.toMatch(/\.formatted\(date: /)
    expect(flipper, 'the Flipper formats its own time').not.toMatch(/\.formatted\(date: /)
    // "as of" exists in exactly one place: the rule. A second one is a second
    // format, which is the drift this replaced.
    expect(count(all, /"as of /g), 'a second "as of" is a second format').toBe(1)
    expect(rule).toContain('"as of "')
    // The wake list is deliberately untouched — those are timestamped events,
    // one line per wake, not a reading being held on screen.
    expect(code(body(panels, 'struct VoiceDevicePanel: View {')))
      .toMatch(/w\.at\.formatted\(date: /)
  })

  it('seconds and the day-when-it-matters live in the rule, not in a view', () => {
    // Both properties are the reason the extraction was necessary rather than
    // tidy: duplicating them at a second site is how they drift.
    expect(rule).toMatch(/time: \.standard/)
    expect(rule).toMatch(/isDate\(when, inSameDayAs: now\)/)
    expect(rule).toMatch(/date: today \? \.omitted : \.abbreviated/)
    // A relative age would rot in place — nothing re-renders these panels.
    expect(rule, 'an elapsed time needs a timer this sheet does not have')
      .not.toMatch(/ago|timeIntervalSince/)
  })

  it('an age is never drawn without the reading it dates', () => {
    // The age sits INSIDE `if let s = status`, so there is no state in which the
    // sheet shows a timestamp for nothing.
    const at = flipper.indexOf('if let s = status {')
    expect(at, 'the Flipper status branch is gone or renamed').toBeGreaterThan(-1)
    const shown = braced(flipper, at)
    expect(shown).toContain('Text(s)')
    expect(shown).toMatch(/ReadingAge\.asOf\(stamp\)/)
    // Same for the camera: `if let asOf` guards it, and the frame's own branch
    // is the only thing above it.
    expect(camera).toMatch(/if let asOf = ReadingAge\.asOf\(stamp\) \{/)
  })

  it('the reading survives the attempt to replace it', () => {
    // The defect, stated as the line that used to be here. Blanking `status` on
    // entry emptied a good panel for 30s and lost the answer entirely on a
    // failed poll.
    expect(check, 'the good reading is blanked before the poll again')
      .not.toMatch(/status = nil/)
    // The stale ERROR does go, though: it belongs to the previous attempt.
    expect(check).toMatch(/error = nil/)
  })

  it('the reading and its age come from the same moment', () => {
    // Adjacent assignments. A `stamp` set anywhere else — at the top of
    // `check()`, say — would date the request instead of the answer, and on a
    // 30s poll those are not the same fact.
    const at = check.indexOf('status = RelayReply.text(payload)')
    expect(at, 'the success assignment moved').toBeGreaterThan(-1)
    expect(check.slice(at, at + 120)).toMatch(/stamp = Date\(\)/)
    // Exactly one write each, so a failure path cannot advance the age of a
    // reading it did not replace.
    expect(count(check, /stamp = /g)).toBe(1)
    expect(count(check, /status = /g)).toBe(1)
  })

  it('the button stops claiming the user never checked', () => {
    // Downstream of the fix, and the visible half of it: the label reads
    // `status == nil`, so blanking `status` on every attempt made a panel that
    // had answered once offer "Check status" again after any later failure.
    expect(flipper).toMatch(/status == nil \? "Check status" : "Refresh"/)
  })

})

/**
 * The same rule on the Pixel. Ported once the phone was on the cable; the
 * `⚠️ FAILS WHEN FIXED` marker this replaces named the recipe and is now gone.
 *
 * Only HALF of that marker had an analogue to port. It named two divergences:
 * Android's hard-coded `SimpleDateFormat("HH:mm:ss", Locale.US)` — real, and fixed
 * — and its Flipper panel having no stamp, which is not a gap because **Android has
 * no Flipper panel at all**. Panels.kt:490 says so in prose; a grep for `Flipper`
 * in the Kotlin tree finds that comment, and a `"flipper" to "Flipper Zero"`
 * display-name entry. Pinned below so the absence stays a fact rather than an
 * assumption a later cycle has to re-derive.
 *
 * Kotlin's `ReadingAgeTest` owns the rule's properties, including the two the
 * replaced format got wrong. This owns the wiring.
 */
describe('a reading on the Android sheet says how old it is', () => {
  const ktRaw = readFileSync(KT_PANELS, 'utf8')
  // Kotlin's line comments are `//` too, so the same stripper reads both languages.
  const ktAll = code(ktRaw)
  const ktRule = code(body(ktRaw, 'internal object ReadingAge {'))
  const ktCamera = code(body(ktRaw, 'internal fun RelayCameraPanel('))

  it('reads the file it means to read', () => {
    expect(ktRule).toContain('fun asOf(')
    expect(ktCamera.length).toBeGreaterThan(2000)
  })

  it('ONE function decides a reading\'s age, and the panel asks it', () => {
    expect(ktCamera).toMatch(/ReadingAge\.asOf\(stamp\)/)
    // And it no longer formats a clock by hand. Scoped to this panel rather than the
    // file, for the same reason the Swift half is: Panels.kt also stamps a wake
    // event and a scheduled job, and neither is a reading being held on screen.
    expect(ktCamera, 'the camera formats its own time again')
      .not.toMatch(/SimpleDateFormat|DateFormat\.get/)
    // "as of" exists in exactly one place: the rule. A second one is a second
    // format, which is the drift this replaced.
    expect(count(ktAll, /"as of /g), 'a second "as of" is a second format').toBe(1)
    expect(ktRule).toContain('"as of "')
  })

  it('the clock is the phone\'s, and the day comes from a calendar', () => {
    // The defect, named: `Locale.US` decided the convention for a phone that had
    // already stated its own. `getDefault()` asks instead.
    expect(ktRule).toMatch(/Locale\.getDefault\(\)/)
    expect(ktRule, 'a US locale decides the clock again').not.toMatch(/Locale\.US/)
    // ⚠️ An INSTANCE format, not a pattern: a hand-written "h:mm:ss a" is the same
    // defect reversed — forcing a 12-hour clock on a phone set to 24 — because a
    // pattern decides the convention itself and only a locale's format asks.
    expect(ktRule, 'a hand-written pattern decides the clock convention')
      .not.toMatch(/SimpleDateFormat\(/)
    expect(ktRule).toMatch(/getTimeInstance\(\s*java\.text\.DateFormat\.MEDIUM/)
    // MEDIUM is the instance format that carries seconds — SHORT does not, and a 2s
    // poll cannot be seen going stale on a clock that only counts minutes.
    expect(ktRule, 'a SHORT format drops the seconds a 2s poll needs')
      .not.toMatch(/DateFormat\.SHORT/)
    // The day-when-it-matters, from the calendar rather than a 24h subtraction:
    // 23:00 and 01:00 are two hours apart and two different days.
    expect(ktRule).toMatch(/DAY_OF_YEAR/)
    expect(ktRule).toMatch(/Calendar\.YEAR/)
    expect(ktRule, 'a relative age needs a ticker this sheet has not got')
      .not.toMatch(/ago/)
  })

  it('an age is never drawn without the reading it dates', () => {
    // `asOf` answers null for a null stamp and the caller `?.let`s on it, so there
    // is no state in which the sheet shows a timestamp for nothing.
    expect(ktRule).toMatch(/if \(millis == null\) return null/)
    expect(ktCamera).toMatch(/ReadingAge\.asOf\(stamp\)\?\.let/)
  })

  it('the half of this rule with no Android analogue is ABSENT, not forgotten', () => {
    // The Flipper reading is the defect the iOS half of this suite exists for, and
    // Android has no Flipper panel to fix. Asserted rather than assumed: if one is
    // ever added, this fails and says what it needs.
    expect(ktRaw, 'Android grew a Flipper panel — it needs the stamp too, then')
      .not.toMatch(/fun FlipperDevicePanel/)
  })
})
