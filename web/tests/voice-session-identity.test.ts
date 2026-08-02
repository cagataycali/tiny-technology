// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 A callback that cannot say which session it came from.
 *
 * `VoiceMode` (Android) rolls a fresh `SpeechRecognizer` on every final result and
 * every error, because Android's ends sessions by itself. It set ONE shared
 * `RecognitionListener` object on every recognizer it built — and `destroy()` is
 * asynchronous, so a callback from the session just torn down lands on the same
 * listener that now serves its replacement. Nothing in a `RecognitionListener`
 * callback identifies its recognizer.
 *
 * A late `onResults` therefore appended words `pending` already held (the roll in
 * `onError` absorbs `_partial` first), sending a message that said a sentence
 * twice; and it called `startSession()` on a recognizer that had only just opened,
 * destroying it mid-utterance.
 *
 * iOS hit this in `NiclaRecorder` and fixed it with `TakeBox`'s generation counter
 * (`6a5eb026`). `VoiceModeTest` (Kotlin) owns the pure accumulation rule. This
 * suite owns the wiring, which is the part a JVM test cannot see: that the
 * listener is built PER SESSION, that every callback is gated on being live, and
 * that the two places which can act after a wait re-read the generation rather
 * than trusting `active`.
 */

const ROOT = process.cwd()
const SRC = join(ROOT, 'android/app/src/main/java/technology/tiny/app/chat/VoiceMode.kt')

/** Kotlin comments stripped: a rule explained in prose must not satisfy a pin. */
const kt = () =>
  readFileSync(SRC, 'utf8')
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

describe('a rolled voice session owns its own callbacks', () => {
  it('the listener is built per session, not shared across every recognizer', () => {
    const src = kt()
    // ⚠️ THE DEFECT, in one line. `private val listener = object : RecognitionListener`
    // is a single instance handed to every recognizer this class creates.
    expect(src, 'the listener is a shared instance again — callbacks lose their session')
      .not.toMatch(/private val listener\s*=\s*object\s*:\s*RecognitionListener/)
    expect(src, 'the listener is no longer built per session')
      .toMatch(/private fun listenerFor\(gen: Int\)\s*=\s*object\s*:\s*RecognitionListener/)
    // And it is USED: a factory nothing calls is dead code holding a green pin.
    expect(body(src, 'private fun startSession()'),
      'startSession stopped binding a listener to its own generation')
      .toMatch(/setRecognitionListener\(listenerFor\(gen\)\)/)
  })

  it('a new session takes the generation before it builds anything', () => {
    // The bump must precede `destroy()`: destroying first means the teardown's
    // callbacks are still stamped live and act on the session being replaced.
    const fn = body(kt(), 'private fun startSession()')
    const bump = fn.indexOf('generation += 1')
    const destroy = fn.indexOf('recognizer?.destroy()')
    expect(bump, 'startSession no longer claims a generation').toBeGreaterThan(-1)
    expect(destroy, 'startSession no longer tears the old recognizer down').toBeGreaterThan(-1)
    expect(bump, 'the old session is destroyed while still counted live').toBeLessThan(destroy)
    // The generation is captured ONCE, so the listener closes over a constant. Reading
    // `generation` inside the callbacks instead would make every check trivially true.
    expect(fn, 'the session no longer captures its own generation')
      .toMatch(/val gen = generation/)
  })

  it('every callback that can act is gated on still being the live session', () => {
    const src = kt()
    const factory = body(src, 'private fun listenerFor(gen: Int)')
    expect(factory, 'the liveness test is gone')
      .toMatch(/private val live: Boolean get\(\) = gen == generation/)
    // Each of the four callbacks that mutates state or the mic. `onRmsChanged` is
    // checked separately below because its early return must NOT write.
    for (const cb of ['onPartialResults', 'onResults', 'onError']) {
      expect(body(factory, `override fun ${cb}(`), `${cb} acts on a dead session again`)
        .toMatch(/if \(!live\) return/)
    }
  })

  it('a dying session cannot flip the UI to DENIED or stop a working mic', () => {
    // ⚠️ ORDER. Android reports a destroyed recognizer's teardown as an error like
    // any other, so if the permission arm ran first, a roll could show the
    // microphone-denied banner and stop() a session that was recording fine.
    const onError = body(kt(), 'override fun onError(')
    const live = onError.indexOf('if (!live) return')
    const denied = onError.indexOf('ERROR_INSUFFICIENT_PERMISSIONS')
    expect(live, 'onError lost its liveness gate').toBeGreaterThan(-1)
    expect(denied, 're-anchor: the permission arm moved').toBeGreaterThan(-1)
    expect(live, "a dead session's error can reach the DENIED arm").toBeLessThan(denied)
  })

  it('the debounced roll re-reads the generation AFTER its wait', () => {
    // ⚠️ The subtle one. The roll waits 500ms, and `active` can be true again by then
    // — a stop() then start() — so checking only `active` would destroy a recognizer
    // that had just opened. The check has to happen after the delay; capturing a
    // boolean before it is no check at all.
    const onError = body(kt(), 'override fun onError(')
    const at = onError.indexOf('scope.launch')
    expect(at, 're-anchor: the debounced roll moved').toBeGreaterThan(-1)
    const roll = braced(onError, at)
    expect(roll, 'the debounced roll no longer waits').toMatch(/delay\(500\)/)
    expect(roll, 'the debounced roll trusts `active` alone and can kill a live session')
      .toMatch(/if \(live && active && !inCall\(\)\) startSession\(\)/)
    // The liveness check must come after the delay, not before it.
    expect(roll.indexOf('delay(500)'), 'liveness is read before the wait — it proves nothing')
      .toBeLessThan(roll.indexOf('live'))
  })

  it('stop() takes the generation so nothing in flight can re-arm the mic', () => {
    // `onResults` calls startSession() straight through with no `active` re-check
    // beyond its own, and a destroy-triggered error is exactly what arrives here —
    // so closing voice mode has to invalidate the callbacks, not just clear state.
    const fn = body(kt(), 'fun stop()')
    expect(fn, 'stop() no longer invalidates in-flight callbacks')
      .toMatch(/generation \+= 1/)
    const bump = fn.indexOf('generation += 1')
    expect(bump, 'stop() bumps the generation after tearing down — callbacks race it')
      .toBeLessThan(fn.indexOf('recognizer?.destroy()'))
  })

  it('a dead session never writes to the level meter, not even zero', () => {
    // ⚠️ Zeroing on a stale callback would blank the LIVE session's bar mid-utterance
    // — the same class of bug in miniature. A dead session must return without
    // touching `_level`; only the live one may drive it, and only it may zero it.
    const cb = body(kt(), 'override fun onRmsChanged(')
    expect(cb, 'onRmsChanged lost its liveness gate').toMatch(/if \(!live\) return/)
    const deadReturn = cb.indexOf('if (!live) return')
    const anyWrite = cb.indexOf('_level.value')
    expect(anyWrite, 're-anchor: the meter write moved').toBeGreaterThan(-1)
    expect(deadReturn, 'a stale callback writes the meter before yielding')
      .toBeLessThan(anyWrite)
    // And the dead-session return is bare — `{ _level.value = 0f; return }` here is
    // exactly the blanking this pin exists to prevent.
    expect(cb, 'a dead session zeroes the live meter')
      .not.toMatch(/if \(!live\) \{[^}]*_level/)
  })

  it('both accumulation sites go through the deduping rule', () => {
    const src = kt()
    // The bare `joinToString(" ")` is the doubling. Both `heard()` and `onResults`
    // built `pending`/`_partial` that way; both must ask the shared rule now.
    expect(src, 'a caller joins transcripts by hand again — that is the doubling')
      .not.toMatch(/listOf\(pending, text\)\.filter \{ it\.isNotBlank\(\) \}\.joinToString\(" "\)/)
    expect(body(src, 'private fun heard('), 'heard() stopped deduping')
      .toMatch(/appendHeard\(pending, text\)/)
    expect(body(src, 'override fun onResults('), 'onResults stopped deduping')
      .toMatch(/pending = appendHeard\(pending, text\)/)
    // The rule itself is pure and in the companion, so `VoiceModeTest` can reach it
    // on the local JVM. An `android.*` reference in there would break that.
    const companion = body(src, 'companion object {')
    expect(companion, 'appendHeard left the companion — the JVM suite cannot see it')
      .toMatch(/fun appendHeard\(pending: String, heard: String\): String/)
    expect(companion, 'the pure rule reaches into android.* and stops being testable')
      .not.toMatch(/android\./)
  })

  it('the absorb before a roll stays a plain assignment, and is trimmed', () => {
    // ⚠️ NOT `appendHeard` here, deliberately: `_partial` is always `pending` plus the
    // live text, so it already CONTAINS `pending` — re-joining them would be the
    // doubling this line exists to prevent. Trimmed because `_partial` feeds the
    // auto-send verbatim.
    const onError = body(kt(), 'override fun onError(')
    expect(onError, 'the absorb re-joins text that already contains pending')
      .toMatch(/pending = _partial\.value\.trim\(\)/)
    expect(onError, 'the absorb went through the join and now doubles')
      .not.toMatch(/pending = appendHeard/)
  })

  it('⚠️ FAILS WHEN FIXED: the premise is that one session is not the whole take', () => {
    // Everything here rests on VoiceMode ROLLING sessions. If Android ever stops
    // ending them on its own — or this class stops re-arming — the generation is
    // dead weight and this fails rather than sitting here unexplained.
    const src = kt()
    expect(src, '🎉 sessions are no longer rolled — the generation may be unnecessary')
      .toMatch(/startSession\(\)/)
    const rolls = (src.match(/startSession\(\)/g) ?? []).length
    // Declared, so adding a roll site that skips the generation is a failure here
    // rather than a silent hole: start(), onResults', the debounced one, and the
    // declaration itself.
    expect(rolls, 'a roll site was added or removed — check it claims a generation')
      .toBe(4)
    // And iOS's fix, which this ports: if TakeBox loses its generation, the two
    // phones have diverged on a bug they both had.
    const ios = readFileSync(join(ROOT, 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')
    expect(ios, "🎉 iOS dropped TakeBox's generation — recheck why Android keeps one")
      .toMatch(/private var generation = 0/)
  })
})
