// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ✒️ Every speech request on Android asks for punctuation.
 *
 * `RecognizerIntent` returns UNPUNCTUATED text by default — the same default iOS
 * has in `SFSpeechRecognitionRequest.addsPunctuation`, and the same trap. On a
 * screen it is cosmetic. Every rail below is read by the AGENT (a chat message, a
 * tool result, or a transcript row in its context), where a run-on with no
 * sentence boundaries is something the model has to guess at.
 *
 * This is the Android half of `e8b6df23`, which found three unpunctuated rails on
 * iOS. Four of the five Android sites were missing it, and the miss had the same
 * shape on both phones:
 *
 *   - `WearablesListenerBridge.freeFormIntent()` is `meta_listen`'s recipe, shared
 *     with `GlassesLive.beginRecognition` so the tool's two rails (its own session,
 *     or a ride-along on an already-running HUD card) cannot disagree. On iOS they
 *     DID disagree: the tool's output format depended on whether the user happened
 *     to have a card open.
 *   - `VoiceMode.startSession()` — `ChatViewModel` builds it as
 *     `VoiceMode(app, speech) { text -> send(text) }`, so the utterance IS a
 *     message to the agent. `EXTRA_PARTIAL_RESULTS` does not excuse it: partials
 *     drive the meter, the final text is sent.
 *   - `PhoneRecorder` — `nicla_voice_record`'s answer. This phone cannot host an
 *     audio file (its recognizer owns the mic), so the transcript IS the recording
 *     and there is nothing to fall back on.
 *   - `LiveScribe` — the necklace's stream, filed as the rows
 *     `nicla_voice_transcripts` reads back long after the panel is closed.
 *
 * The roster is DERIVED by grepping for the intent construction, not listed, so a
 * new recognition path cannot join the app unregistered — a hand-kept list is
 * exactly what missed four sites here and three on iOS.
 */

const ROOT = process.cwd()
const SRC = 'android/app/src/main/java/technology/tiny/app'

/** Every `.kt` under the app's source root, recursively. */
function kotlinFiles(dir = SRC): string[] {
  const out: string[] = []
  let names: string[]
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    const rel = join(dir, n)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...kotlinFiles(rel))
    else if (n.endsWith('.kt')) out.push(rel)
  }
  return out.sort()
}

interface Site { file: string; line: number; region: string; scope: string }

/**
 * The intent construction and the extras chained onto it — bounded by
 * INDENTATION, so it grows with the code.
 *
 * ⚠️ This exists because the named pins below first used `slice(0, 1200)` and a
 * probe proved it: inserting a comment inside the chain (legal, correct work —
 * this rail already carries a four-line one) pushed `askForPunctuation()` past
 * the window and the pin went RED on code that was right. A byte count is a
 * guess about how long the code stays put; the extras chain, on the other hand,
 * is exactly the run of lines indented deeper than the line the request is built
 * on, and it ends at the `)` that closes it. Blank lines continue the chain
 * rather than ending it.
 */
function chainOf(src: string, at: number): string {
  const base = (/^\s*/.exec(src.slice(0, at).split('\n').pop() ?? '') as RegExpExecArray)[0].length
  const lines = src.slice(at).split('\n')
  const out = [lines[0]]
  for (const l of lines.slice(1)) {
    if (l.trim() !== '' && (/^\s*/.exec(l) as RegExpExecArray)[0].length <= base) break
    out.push(l)
  }
  return out.join('\n')
}

/**
 * From an offset to the end of the member function containing it — i.e. up to
 * the next declaration indented at most one level.
 *
 * The other half of the same lesson: "the next sibling anchor" is a boundary the
 * code defines, where a byte window is one the test invents.
 */
function untilNextMember(src: string, at: number): string {
  const rest = src.slice(at)
  const m = /\n\s{0,4}(?:(?:private|internal|public|protected|suspend|inline|override)\s+)*fun\s/.exec(rest)
  return m ? rest.slice(0, m.index) : rest
}

/**
 * The enclosing member function of an offset — from its `fun` line onward.
 *
 * ⚠️ NOT the nearest preceding `fun`. Walking back one step lands inside a
 * `RecognitionListener`'s `override fun onEvent` or a local `fun finish` (DmMedia
 * has both between its recognizer and its intent), which is a tighter window than
 * the one the intent sits in — the pin using it went red on code that was
 * correct. So: walk back to the first declaration indented at most one level,
 * i.e. a member of the object or class, and take the whole body from there.
 */
function enclosingFun(src: string, at: number): number {
  const head = src.slice(0, at).split('\n')
  for (let i = head.length - 1; i >= 0; i--) {
    const m = /^(\s{0,4})(?:(?:private|internal|public|protected|suspend|inline|override)\s+)*fun\s/.exec(head[i])
    if (m) return head.slice(0, i).join('\n').length
  }
  return 0 // a top-level `val` or initialiser: read from the top of the file
}

/**
 * Every `Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)`, with the text from it
 * up to the NEXT construction in the same file (or EOF).
 *
 * Bounded by the next site rather than by a byte window on purpose: a fixed window
 * is a guess about how long the code stays put, and four assertions in
 * `ios-live-transcribe.test.ts` once broke at once because a comment grew past
 * one. Extras are chained onto a request immediately, so "up to the next request"
 * is the honest boundary.
 */
function recognitionSites(): Site[] {
  const sites: Site[] = []
  for (const file of kotlinFiles()) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const needle = 'Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)'
    const found: number[] = []
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) found.push(i)
    found.forEach((at, i) => {
      const end = i + 1 < found.length ? found[i + 1] : src.length
      sites.push({
        file, region: src.slice(at, end),
        // The whole member function the request is built in, for properties a
        // rail can satisfy BEFORE the intent exists (see `enclosingFun`).
        scope: src.slice(enclosingFun(src, at), end),
        line: src.slice(0, at).split('\n').length,
      })
    })
  }
  return sites
}

const SITES = recognitionSites()

describe('Android speech requests — punctuation on every rail the agent reads', () => {
  it('finds the recognition sites at all (a zero-length roster proves nothing)', () => {
    // Without this the suite passes vacuously the day the constructor moves or is
    // wrapped — green, and pinning nothing. FOUR is the tracked floor: VoiceMode,
    // LiveScribe, PhoneRecorder, WearablesListener. (DmMedia's voice-note rail is a
    // fifth, but it belongs to a concurrent session and may not be on disk here —
    // so it is not part of the floor.)
    expect(SITES.length).toBeGreaterThanOrEqual(4)
    expect(new Set(SITES.map(s => s.file)).size).toBeGreaterThanOrEqual(4)
  })

  it.each(SITES.map(s => [`${s.file}:${s.line}`, s] as const))(
    '%s asks for punctuation', (_where, site) => {
      // The PROPERTY, not one spelling: the shared helper is the house style, but a
      // site that sets EXTRA_ENABLE_FORMATTING inline is just as correct (DmMedia
      // does, and it is another session's file). Either satisfies this.
      expect(
        site.region,
        `${site.file}:${site.line} builds a recognition request without asking for ` +
        `punctuation — call askForPunctuation() (or set EXTRA_ENABLE_FORMATTING). ` +
        `This text is read by the agent, and unpunctuated it is one run-on.`,
      ).toMatch(/askForPunctuation\(\)|EXTRA_ENABLE_FORMATTING/)
    })

  it.each(SITES.map(s => [`${s.file}:${s.line}`, s] as const))(
    '%s keeps recognition on the phone', (_where, site) => {
      // The privacy property that travels with these requests, and iOS pins the
      // same one per site (`requiresOnDeviceRecognition`): an open mic in someone's
      // home must not become a stream of household audio to a server. Spelled two
      // ways here — the intent extra, or `createOnDeviceSpeechRecognizer` where the
      // rail can demand it outright — so only the property is pinned.
      //
      // ⚠️ Reads `scope`, not `region`, and that is the whole point: a rail that
      // demands the on-device recognizer does it when it BUILDS the recognizer,
      // which is before the intent (LiveScribe.open, DmMedia's transcriber). Aimed
      // at the post-intent region this pin went red on two correct files.
      expect(
        site.scope,
        `${site.file}:${site.line} neither sets EXTRA_PREFER_OFFLINE nor builds an ` +
        `on-device recognizer — this mic's audio would leave the phone`,
      //
      // ⚠️ `isOnDeviceRecognitionAvailable` is NOT accepted, though both rails call
      // it: asking whether on-device recognition exists is not using it, and a rail
      // that kept the query but downgraded the recognizer it builds would satisfy a
      // pin that took it. Only the two spellings that decide where the audio goes.
      // ⚠️ And the VALUE, not just the key: `EXTRA_PREFER_OFFLINE, false` is the
      // extra being set to the wrong thing, which reads as compliance to a pin that
      // greps for the name. c65's B2 was the same mistake one level up (a pin that
      // read the value but not the key), found by a mutant that survived.
      ).toMatch(/EXTRA_PREFER_OFFLINE,\s*true|createOnDeviceSpeechRecognizer/)
    })

  it('the shared helper sets the FORMATTING extra, and asks for QUALITY', () => {
    const src = readFileSync(join(ROOT, `${SRC}/fleet/SpeechFormat.kt`), 'utf8')
    // ⚠️ Both halves, because either alone is satisfied by a wrong call: the KEY
    // could be any extra (a helper that sets EXTRA_LANGUAGE_MODEL to "quality"
    // compiles, punctuates nothing, and every per-site pin above still passes
    // because they only see `askForPunctuation()`), and the VALUE could be the
    // latency profile. A mutant that swapped the key survived a pin that read only
    // the value.
    expect(src).toMatch(
      /putExtra\(\s*RecognizerIntent\.EXTRA_ENABLE_FORMATTING,\s*RecognizerIntent\.FORMATTING_OPTIMIZE_QUALITY,?\s*\)/,
    )
    // LATENCY is for live captioning. Every caller here is already waiting on a
    // network round-trip, so the formatting pass is not what anyone waits for.
    expect(src).not.toMatch(/FORMATTING_OPTIMIZE_LATENCY,/)
    // ⚠️ The absent SDK_INT check is deliberate and must stay explained, or the
    // next reader "fixes" it: API 33 constant, minSdk 29, but it is an inlined
    // String and extras are a bag older recognizers ignore. Unwrap KDoc `* `
    // wrapping before matching — a phrase that spans a line wrap is the false red
    // someone deletes instead of investigating.
    const flat = src.replace(/\n\s*\*\s?/g, ' ')
    expect(flat).toMatch(/API 33/)
    expect(flat).toMatch(/minSdk` is 29|minSdk is 29/)
    expect(flat).toMatch(/compile-time-inlined `String` constant/)
    expect(flat).toMatch(/NO `SDK_INT` GUARD/)
  })
})

describe('the rails that made this a bug, not a typo', () => {
  const listener = readFileSync(join(ROOT, `${SRC}/fleet/WearablesListener.kt`), 'utf8')
  const live = readFileSync(join(ROOT, `${SRC}/fleet/WearablesLive.kt`), 'utf8')
  const voice = readFileSync(join(ROOT, `${SRC}/chat/VoiceMode.kt`), 'utf8')
  const vm = readFileSync(join(ROOT, `${SRC}/chat/ChatViewModel.kt`), 'utf8')
  const recorder = readFileSync(join(ROOT, `${SRC}/fleet/PhoneRecorder.kt`), 'utf8')

  it('meta_listen still has two rails, and they SHARE one request', () => {
    // iOS's split was two rails each building their own request. Here the HUD
    // rail calls the same two functions the tool's own rail does, so a punctuation
    // setting cannot apply to one and not the other. If this stops being true the
    // derived roster still holds — which is the point of deriving it.
    expect(live).toMatch(/WearablesListenerBridge\.newRecognizer\(app\)/)
    expect(live).toMatch(/WearablesListenerBridge\.freeFormIntent\(\)/)
    expect(listener).toMatch(/internal fun freeFormIntent\(\): Intent/)
    // ...and the tool's own rail uses it too, so "shared" is not aspirational.
    // Bounded at the end of the member that builds the recognizer, not at a byte
    // count: `freeFormIntent()` has to be the intent THIS rail runs, and the
    // definition of it further down the file must not satisfy the pin. A probe
    // killed the 200-byte version of this by growing a comment above the call.
    const own = untilNextMember(listener, listener.indexOf('val (recognizer, onDevice) = newRecognizer(app)'))
    expect(own).toMatch(/val intent = freeFormIntent\(\)/)
    // ⚠️ And WHY it is shared has to stay written down, or a later reader inlines
    // the recipe back into each rail and re-earns iOS's bug. Unwrap KDoc `* `
    // wrapping first — the c60 trap.
    const flat = listener.replace(/\n\s*\*\s?/g, ' ')
    expect(flat).toMatch(/SINGLE-SOURCING IS WHAT MAKES `meta_listen` ONE TOOL/)
    expect(flat).toMatch(/same shape|SAME SHAPE/)
  })

  it('a dictated utterance is a message to the agent, not a preview', () => {
    // This is why EXTRA_PARTIAL_RESULTS does not excuse skipping punctuation.
    expect(voice).toMatch(/RecognizerIntent\.EXTRA_PARTIAL_RESULTS, true/)
    expect(vm).toMatch(/VoiceMode\(app, tinyApp\.speech\) \{ text -> send\(text\) \}/)
  })

  it('the record rail has no audio file to fall back on', () => {
    // c64's finding, one layer down: nicla_voice_record answers with text ONLY on
    // this phone, so the transcript is the artefact — not a caption on one.
    expect(recorder).not.toMatch(/o\.put\("audioUrl"/)
    // ⚠️ Named, not only derived. The roster's per-site pins are what stop a NEW
    // rail escaping; these two rails need naming as well, because each is the sole
    // guard of a property for its file — weaken the derived pin and nothing else
    // notices. Two independent readers, so a mutant has to defeat both.
    //
    // Read through the extras CHAIN (see `chainOf`), which is tighter than the
    // roster's window — the request must ask for these itself, not somewhere later
    // in the take loop — and which cannot be pushed out of by a comment.
    const chain = chainOf(recorder, recorder.indexOf('Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)'))
    expect(chain).toMatch(/askForPunctuation\(\)/)
    expect(chain).toMatch(/EXTRA_PREFER_OFFLINE, true/)
  })

  it('the transcripts rail is punctuated and stays on the phone, by name', () => {
    // LiveScribe is the longest-lived text this app produces: its rows are what
    // `nicla_voice_transcripts` hands the agent days later, and the mic feeding it
    // is a necklace open in someone's home. Both properties, named — for the same
    // reason as above, and because the derived roster reads them through two
    // different windows (the intent, and the enclosing function).
    const scribe = readFileSync(join(ROOT, `${SRC}/fleet/LiveScribe.kt`), 'utf8')
    const at = scribe.indexOf('Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)')
    expect(at).toBeGreaterThan(0)
    expect(scribe.slice(at)).toMatch(/askForPunctuation\(\)/)
    // Built BEFORE the intent, which is why the roster's on-device pin reads the
    // enclosing function rather than the request.
    expect(scribe.slice(0, at)).toMatch(/createOnDeviceSpeechRecognizer/)
  })
})
