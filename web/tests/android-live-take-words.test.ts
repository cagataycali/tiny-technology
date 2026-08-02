// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎙️ The take that showed a meter and no words.
 *
 * `PhoneRecorder` drew a ten-bar level meter on both of this phone's Record
 * buttons — the Voice device panel and the Transcripts sheet — and never showed a
 * single word, because the recognizer's partials went into a LOCAL `var` inside
 * `listen()` and died there when the take ended. **A meter proves the mic hears
 * SOMETHING; only words prove it hears YOU**, which is what a person actually
 * wants to know before trusting a screen with two minutes of speech: a muted mic
 * and a phone face-down in a pocket both move a bar.
 *
 * iOS carried the identical gap and admitted it in its own comment ("partial
 * recognition text is not shown anywhere else in this view"). It was fixed at
 * `e99e3c53`, which this ports. The OTHER half of that commit — a second pass over
 * the recorded file with an uncapped engine, keeping whichever transcript is
 * longer — **cannot be ported at all**: `SpeechRecognizer` captures inside
 * Google's recognition-service process, so this app never sees the samples and
 * there is no file to re-read. That is stated here so a future cycle does not go
 * looking for the missing half.
 *
 * `LiveTakeTest` (Kotlin) owns the two pure rules — when there is anything worth
 * drawing, and what the caption says. This suite owns what a JVM test cannot see:
 * that the words ESCAPE the recognizer, on which tick, that they are cleared at
 * both ends of a take, that both surfaces render them, and that a long take tails
 * rather than pushing Stop off the screen.
 */

const ROOT = process.cwd()
const REC = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
const LIVE = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/LiveTakeWords.kt')
const PANELS = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const SHEET = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/TranscriptsSheet.kt')

/** Comments stripped: a rule explained in prose must not satisfy a pin. */
const stripped = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
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

/** A block, with its anchor ASSERTED — an unfound anchor makes every `.not` pin vacuous. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('a live take shows the words it is hearing', () => {
  it('the words leave the recognizer at all', () => {
    // 🔴 THE GAP in one pin: `partial` was a local var inside `listen()`. A screen
    // cannot collect a local variable, which is why the meter was all there was.
    const rec = stripped(REC)
    expect(rec, 'the take\'s words are unreachable from any screen again')
      .toMatch(/val partial: StateFlow<String> = _partial/)
    expect(rec, 'the backing flow is gone').toMatch(/private val _partial = MutableStateFlow\(""\)/)
  })

  it('they are published on the loop tick, not from the recognition callback', () => {
    // ⚠️ WHICH tick, and it is a deliberate choice iOS made for the same reason:
    // `onPartialResults` fires as fast as the recognition service produces
    // hypotheses — many per second, each one a recomposition of every screen
    // collecting the flow, for text no eye can follow at that rate. The take loop
    // already ticks at 200ms for `stopEarly`, so it costs nothing.
    const rec = stripped(REC)
    const loop = body(rec, 'while (android.os.SystemClock.elapsedRealtime() < until)')
    expect(loop, 'the words are no longer republished on the take loop tick')
      .toMatch(/_partial\.value = snapshot\(\)/)
    // ⚠️ `snapshot()`, NOT `partial`: `listen()` ROLLS a fresh SpeechRecognizer every
    // time Android ends a session on its own, and after a roll the local `partial`
    // holds only the newest utterance — so publishing it would make the card appear
    // to forget the sentence the user just watched it type. (iOS publishes
    // box.fullText over `transcript` for exactly this.)
    expect(loop, 'the loop publishes the live session only — a rolled take forgets itself')
      .not.toMatch(/_partial\.value = partial/)
    // And NOT from the callback, whose rate is the reason above.
    const cb = body(rec, 'override fun onPartialResults(results: Bundle?)')
    expect(cb, 'the words are published per hypothesis — far more updates than a view can use')
      .not.toMatch(/_partial/)
  })

  it('a new take never opens showing the last one\'s words', () => {
    // ⚠️ Cleared where the mic is CLAIMED, beside `stopRequested` and for the same
    // reason: this text is rendered as "what the mic is hearing RIGHT NOW", so a
    // leftover sentence is the previous take's words presented as live ones.
    const rec = stripped(REC)
    const claim = body(rec, 'suspend fun record(app: TinyApp, seconds: Int, label: String)')
    const at = claim.indexOf('_isRecording.value = true')
    expect(at, 're-anchor: the claim point moved').toBeGreaterThan(-1)
    expect(claim.slice(at, at + 400), 'the words are not cleared where the mic is claimed')
      .toMatch(/_partial\.value = ""/)
    // ⚠️ And in the `finally`, which is what makes a FAILED take leave nothing
    // behind that looks like a recording in progress with no button to stop it.
    const fin = claim.slice(claim.indexOf('} finally {'))
    expect(fin, 'a failed take leaves its words on screen')
      .toMatch(/_partial\.value = ""/)
    expect(fin, 're-anchor: the finally no longer resets the meter beside it')
      .toMatch(/_level\.value = 0f/)
  })

  it('both Record buttons show them — there are two, and neither may be the odd one out', () => {
    // ⚠️ The failure this tree keeps paying for: a surface added to N screens where
    // the N+1th forgets it and nothing goes red. Both buttons already drew the same
    // ten bars twice, so the words live in ONE composable and both call it.
    for (const [name, path] of [['the Voice device panel', PANELS], ['the Transcripts sheet', SHEET]] as const) {
      const src = stripped(path)
      expect(src, `${name} no longer collects the take's words`)
        .toMatch(/val heard by PhoneRecorder\.partial\.collectAsState\(\)/)
      expect(src, `${name} collects the words and draws nothing`)
        .toMatch(/if \(recording\) LiveTakeWords\(heard\)/)
    }
  })

  it('a long take tails instead of pushing Stop off the screen', () => {
    // A 120s memo is ~1,700 characters. Unbounded, it grows the sheet until the
    // Stop button is gone — and the NEWEST words are the ones that answer "is it
    // hearing me right now", so the scroll follows the bottom.
    const live = stripped(LIVE)
    expect(live, 'the live words are unbounded — a long take buries the Stop button')
      .toMatch(/heightIn\(max = 140\.dp\)\.verticalScroll\(scroll\)/)
    expect(live, 'the words no longer tail — a long take shows only its opening')
      .toMatch(/LaunchedEffect\(heard\) \{ scroll\.animateScrollTo\(scroll\.maxValue\) \}/)
  })

  it('the caption is always drawn, and the words only when there are some', () => {
    // ⚠️ The asymmetry: an empty bordered text block reads as a rendering bug, while
    // the caption is the ONLY place the app can tell "you just tapped Record" apart
    // from "this microphone is not hearing you" — so it must not hide with the words.
    const live = stripped(LIVE)
    const fn = body(live, 'internal fun LiveTakeWords(heard: String)')
    const guard = fn.indexOf('if (LiveTake.hasWords(heard))')
    expect(guard, 'the words are drawn even when there are none').toBeGreaterThan(-1)
    const wordsArm = braced(fn, guard)
    expect(wordsArm, 're-anchor: the guarded arm no longer holds the words')
      .toMatch(/Text\(\s*heard,/)
    expect(wordsArm, 'the caption moved inside the has-words arm — silence now says nothing')
      .not.toMatch(/LiveTake\.caption/)
    expect(fn, 'the caption is gone').toMatch(/LiveTake\.caption\(heard\)/)
    // ⚠️ EXACTLY ONE guard, and this is the pin that survived a mutant without it:
    // asserting the caption is not inside the braced arm says nothing about a SECOND
    // `if (hasWords(heard))` written in front of it, which hides the caption just as
    // completely while leaving the block structure above untouched. The words are the
    // only thing in here that may be conditional.
    expect((fn.match(/hasWords\(/g) ?? []).length,
      'the caption is now conditional too — a silent take says nothing at all').toBe(1)
  })

  it('⚠️ FAILS WHEN FIXED: Android still has no audio file to re-read', () => {
    // The half of `e99e3c53` that is NOT here, pinned so nobody hunts for it: iOS
    // runs a SECOND pass over the take's recorded file with an uncapped engine and
    // keeps whichever transcript is longer, because its live path stitches N
    // recognition tasks and drops audio at every seam. Android's live path rolls
    // sessions the same way and has the same seams — but `SpeechRecognizer` captures
    // inside Google's recognition-service process, so this app never receives the
    // samples. There is nothing to re-read.
    //
    // If a capture path ever lands here (an AudioRecord tap feeding recognition AND
    // a file), this fails and the second pass becomes portable — the ONE remaining
    // gap between the two recorders.
    // Stripped, deliberately: the header already NAMES MediaRecorder to explain why
    // there is none ("the mic is exclusive — a MediaRecorder opened alongside it
    // would either fail…"), and a prose mention is the opposite of a capture path.
    const rec = stripped(REC)
    expect(rec, '🎉 the recorder writes audio now — port iOS betterTranscript (longer wins)')
      .not.toMatch(/AudioRecord|MediaRecorder/)
    // ⚠️ And the stripper must really be stripping — a slicer that returns "" passes
    // every `.not` pin in this test forever.
    expect(rec, 'the stripped source is empty — every pin here is vacuous')
      .toMatch(/object PhoneRecorder \{/)
    // The reply contract that constraint produces, and its own test's subject: no
    // audioUrl key, because a fabricated one renders a player over nothing.
    expect(rec, 'an audioUrl appeared — audio exists, so re-read the file')
      .not.toMatch(/put\("audioUrl"/)
  })
})
