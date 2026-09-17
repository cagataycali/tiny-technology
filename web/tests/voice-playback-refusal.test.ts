// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import {
  playbackRefusal, refusalFromStatusAnswer, tooLongToStitch, UNKNOWN_REFUSAL,
  SEGMENT_BYTES, STITCH_BYTE_CAP,
} from '../lib/voice/playback'
import { deadlineFor } from '../lib/deadlines'

/**
 * 🔇 A refusal handed to a media player, which has no way to say it.
 *
 * `/voice/recording/:id` is not a file — it is a route that STITCHES a call's
 * PCM segments into one WAV on first listen, and it declines five ways:
 *
 *   424 media store not provisioned    409 call still in progress
 *   404 no replay journaled…           404 no audio journaled
 *   413 call too long to stitch
 *
 * Each is a JSON body with a stated reason. All three clients hand that URL
 * directly to a media player — web `<audio src>`, iOS `AVPlayer(url:)`, Android
 * `MediaPlayer.setDataSource(url)` — and a media player given a 413 with a JSON
 * body has exactly one thing to say, which is nothing:
 *
 *   - web `<audio controls>` greys out its own play button, silently;
 *   - iOS set `currentItem.status = .failed` and NOTHING read it, so `playingId`
 *     stayed set — a pause glyph over a transport frozen at 0:00, forever;
 *   - Android registered `setOnPreparedListener` + `setOnCompletionListener` and
 *     NO `setOnErrorListener`, and `prepareAsync` reports asynchronously, so the
 *     enclosing `runCatching` could not see it either. Nothing throws.
 *
 * ⚠️ WHAT MAKES THIS THIS LOOP'S OWN CLASS: the exact same three files already
 * learned it on their LOAD path, and each carries a ⚠️ comment about it —
 * "reaching past the house client is what threw the status away, and a screen
 * with no status can only guess at a cause". The list is fetched through
 * `Api.getData` / `app.api.getJson` / a deadlined `fetch` for precisely this
 * reason. The PLAY path in those same files then handed a URL to a player with
 * no error channel at all. A surface stating a conclusion it has no basis for —
 * here the conclusion is "playing", asserted by a pause glyph.
 *
 * ⚠️ AND THE ROW ALREADY HELD THE NUMBER THAT PREDICTS ONE REFUSAL.
 * `segment_count` is decoded by all three clients and used ONLY as `> 0`. At
 * ~1.44MB per segment against a 40MB stitch cap, a call past 30 segments CANNOT
 * stitch — knowable before the tap, from a field already on the row. That is
 * the same shape as c45's finding (the duration was already there), inverted:
 * a number present and read as a boolean.
 */

const ROOT = process.cwd()
const WEB = join(ROOT, 'app/calls/page.tsx')
const IOS = join(ROOT, 'ios/Tiny/Sources/VoiceCall.swift')
const AND = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/CallRecordingsSheet.kt')
const STATUS_ROUTE = join(ROOT, 'app/api/voice/recording-status/[id]/route.ts')

const read = (p: string) => readFileSync(p, 'utf8')

/** Comments stripped: a rule explained in prose must not satisfy an assertion. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

const webSrc = read(WEB)
const iosSrc = read(IOS)
const andSrc = read(AND)

describe('the refusal rule', () => {
  it('⚠️ always says something — silence is the defect itself', () => {
    // This is the difference from `callOutcome`, which returns null for a clean
    // call. This function is called only when a play FAILED, so every input must
    // produce a sentence. A null here would be the dead play button again.
    for (const input of [null, undefined, '', '   ', 'who knows']) {
      const r = playbackRefusal(input as any, null)
      expect(r.text, `playbackRefusal(${JSON.stringify(input)}) said nothing`).toBeTruthy()
      expect(r.text.length).toBeGreaterThan(4)
    }
  })

  it('an unrecognised refusal names no cause but still reports the failure', () => {
    const r = playbackRefusal('the flux capacitor desynced', 500)
    expect(r.known, 'an unrecognised refusal was reported as understood').toBe(false)
    expect(r.text).toBe(UNKNOWN_REFUSAL)
    // It must not echo what it did not understand — that is the raw diagnostic.
    expect(r.text).not.toMatch(/flux/)
  })

  it('each refusal the route can give gets its own sentence', () => {
    expect(playbackRefusal('call still in progress').text).toMatch(/still going/)
    expect(playbackRefusal('call too long to stitch').text).toMatch(/too long/)
    expect(playbackRefusal('no replay journaled for this session').text).toMatch(/wasn't recorded/)
    expect(playbackRefusal('no audio journaled').text).toMatch(/audio wasn't saved/)
    expect(playbackRefusal('media store not provisioned').text).toMatch(/unavailable right now/)
    // All five are distinct — a table that collapses two answers into one
    // sentence is a table with a missing row.
    const texts = [
      'call still in progress', 'call too long to stitch',
      'no replay journaled for this session', 'no audio journaled',
      'media store not provisioned',
    ].map((r) => playbackRefusal(r).text)
    expect(new Set(texts).size, 'two refusals share a sentence — one of them is unsayable').toBe(5)
    // ⚠️ And none of the five is the generic line: each of these has a cause the
    // person can act on (or a plainly stated one they can't), so falling back to
    // "couldn't play this recording" for any of them would be a covered refusal
    // rendered as an unknown one.
    for (const t of texts) {
      expect(t, 'a refusal with a known cause renders as the generic line').not.toBe(UNKNOWN_REFUSAL)
    }
  })

  it('⚠️ the 400 shares the generic sentence but is still marked KNOWN', () => {
    // `session id required` needs a client bug to reach (all three build the URL
    // from a row id) and there is nothing useful to tell the person about it, so
    // it deliberately reuses the generic line. It must still report `known: true`:
    // "we understand this and have nothing better to say" is a different fact
    // from "we do not recognise this", and only the second is a rot signal.
    const r = playbackRefusal('session id required')
    expect(r.text).toBe(UNKNOWN_REFUSAL)
    expect(r.known, 'a refusal the map covers is reported as unrecognised').toBe(true)
  })

  it('⚠️ a bare 409 is translated, because it is the one refusal that self-heals', () => {
    // A media player often yields a status and no body at all. 409 is worth
    // translating blind: the call is still live, so "reload in a moment" is
    // actionable — and the list filter admits only ended/error rows, so seeing
    // this means the row is stale.
    const r = playbackRefusal(null, 409)
    expect(r.known).toBe(true)
    expect(r.text).toMatch(/still going/)
    expect(r.text, 'the bare-409 sentence drifted from the with-body one')
      .toBe(playbackRefusal('call still in progress').text)
  })

  it('a bare status we cannot read is not dressed up as a diagnosis', () => {
    for (const s of [0, 404, 413, 424, 500]) {
      const r = playbackRefusal(null, s)
      expect(r.known, `status ${s} alone was reported as an understood cause`).toBe(false)
      expect(r.text).toBe(UNKNOWN_REFUSAL)
    }
  })
})

describe("⚠️ the status route's answer is READ, not merely requested", () => {
  // ⚠️ THIS DESCRIBE EXISTS BECAUSE A MUTANT SURVIVED. `playFailed` asked the
  // route WHY and then translated `(null, null)` — discarding the reason it had
  // just fetched — and every pin passed, because the only thing they could check
  // was that the fetch and the translation both appear in the file. The rule was
  // inline in a component closure, so nothing could call it. It has a name now.

  it('a refusal the route read is the sentence on the row', () => {
    const r = refusalFromStatusAnswer({ ok: false, status: 413, error: 'call too long to stitch' })
    expect(r.text, 'the route reported a cause and the row ignored it').toMatch(/too long/)
    expect(r.known).toBe(true)
  })

  it('⚠️ each of the route\'s refusals survives the whole round trip', () => {
    // The end-to-end claim in one loop: what the worker says, through the proxy's
    // envelope, to what a person reads. Anything that drops the body on the way
    // collapses every one of these to the same generic line.
    const seen = new Set<string>()
    for (const error of [
      'call still in progress', 'call too long to stitch',
      'no replay journaled for this session', 'no audio journaled',
      'media store not provisioned',
    ]) {
      const r = refusalFromStatusAnswer({ ok: false, status: 400, error })
      expect(r.known, `"${error}" was lost between the route and the row`).toBe(true)
      expect(r.text, `"${error}" reached the row as the generic line`).not.toBe(UNKNOWN_REFUSAL)
      seen.add(r.text)
    }
    expect(seen.size, 'the round trip collapsed distinct refusals into one sentence').toBe(5)
  })

  it('a recording that serves audio now is not given an invented cause', () => {
    // `ok: true` after an onError means the failure was transient. Reporting a
    // reason here would be this cycle's own defect in reverse: a surface stating
    // a conclusion it has no basis for.
    const r = refusalFromStatusAnswer({ ok: true, status: 206, error: null })
    expect(r.text).toBe(UNKNOWN_REFUSAL)
    expect(r.known, 'a transient failure was reported as a diagnosed cause').toBe(false)
  })

  it('an answer that never arrived still says something', () => {
    for (const a of [null, undefined, {}, { ok: false, status: 0, error: null }]) {
      const r = refusalFromStatusAnswer(a as any)
      expect(r.text, `${JSON.stringify(a)} produced no sentence`).toBe(UNKNOWN_REFUSAL)
      expect(r.known).toBe(false)
    }
  })

  it('the page hands the route\'s answer to the shared rule', () => {
    // The call site, now that the rule itself is behaviourally pinned above.
    const c = code(webSrc)
    expect(c, 'web no longer translates the route answer')
      .toMatch(/refusalFromStatusAnswer\(answer\)/)
    expect(c, 'web discards the answer it fetched').toMatch(/answer = await r\.json\(\)/)
  })
})

describe('⚠️ the size refusal is arithmetic, knowable before the tap', () => {
  it('the threshold follows from the two worker constants, not from a literal', () => {
    // The claim: `(n - 2) * SEGMENT_BYTES > STITCH_BYTE_CAP`. Two segments are
    // exempt because `segment_count` sums both directions and only the FINAL
    // segment per direction may be short of SEGMENT_BYTES.
    const firstRefused = Math.floor(STITCH_BYTE_CAP / SEGMENT_BYTES) + 3
    expect(tooLongToStitch(firstRefused), `${firstRefused} segments must be refused`).toBe(true)
    expect(tooLongToStitch(firstRefused - 1), `${firstRefused - 1} segments may still stitch`).toBe(false)
    // And the numbers are the ones actually in play, so a reader can check them.
    expect(firstRefused).toBe(30)
  })

  it('⚠️ it is ONE-SIDED — never a promise that a call WILL play', () => {
    // Four other refusals are invisible from a segment count. A predicate read
    // as "this one is fine" would be a surface stating a conclusion it has no
    // basis for, which is this loop's whole subject.
    expect(tooLongToStitch(4)).toBe(false)
    expect(playbackRefusal('no audio journaled').known,
      'a small call can still be refused — the count proves nothing either way').toBe(true)
  })

  it('a missing or nonsense count never claims a refusal', () => {
    for (const n of [null, undefined, 0, 1, 2, -5, NaN]) {
      expect(tooLongToStitch(n as any), `count ${n} was read as too long`).toBe(false)
    }
  })

  it('the constants match the worker, or the arithmetic is about nothing', () => {
    // Pinned here as well as in the worker-gated describe below, so the two
    // numbers cannot drift apart silently when the submodule is absent.
    expect(SEGMENT_BYTES).toBe(1_440_000)
    expect(STITCH_BYTE_CAP).toBe(40_000_000)
  })
})

describe.skipIf(!present)('the map is keyed on the worker, not on my memory', () => {
  warnIfWorkerAbsent('voice-playback-refusal')

  /** Every `json({ error: "…" }, 4xx|5xx)` inside `voiceRecording` — read out of
   *  the worker source rather than listed here. The route's refusals are the
   *  domain of `playbackRefusal`, and a sixth one added upstream must fail a
   *  suite instead of quietly falling to the generic sentence. */
  function routeRefusals(): string[] {
    const src = code(readFileSync(workerFile('voice.ts'), 'utf8'))
    // Slice to the function: `json({error})` is used all over this file, and a
    // refusal from a DIFFERENT route is not this map's business. An innocent
    // sibling is enough to make a file-wide scan meaningless.
    const start = src.indexOf('export async function voiceRecording')
    expect(start, 'voiceRecording not found — this extractor is blind').toBeGreaterThan(-1)
    const end = src.indexOf('\nexport ', start + 10)
    const fn = src.slice(start, end > start ? end : undefined)
    const out: string[] = []
    const re = /json\(\{\s*error:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*,\s*(\d{3})\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fn)) !== null) out.push(m[1])
    return out
  }

  it('⚠️ EVERY refusal the route can give has a sentence for the person', () => {
    const refusals = routeRefusals()
    // The "did I read this" assertion: an extractor matching nothing would make
    // every expectation below pass on an empty list, forever.
    expect(refusals.length, 'extracted no refusal literals — this suite is blind')
      .toBeGreaterThanOrEqual(4)
    for (const reason of refusals) {
      const r = playbackRefusal(reason, null)
      expect(
        r.known,
        `/voice/recording refuses with "${reason}" and playbackRefusal does not ` +
        `recognise it — all three clients now say "${UNKNOWN_REFUSAL}" for a cause ` +
        `the route stated plainly`,
      ).toBe(true)
    }
  })

  it('⚠️ the two size constants are the WORKER\'s, read from its source', () => {
    const src = readFileSync(workerFile('voice.ts'), 'utf8')
    const seg = src.match(/const SEGMENT_BYTES = ([\d_]+);/)
    expect(seg, 'SEGMENT_BYTES not found in the worker — the prediction is unfounded').toBeTruthy()
    expect(Number(seg![1].replace(/_/g, '')), 'SEGMENT_BYTES drifted from lib/voice/playback.ts')
      .toBe(SEGMENT_BYTES)
    // The stitch guard is an inline literal in voiceRecording, not a named
    // constant — capture it from the comparison itself.
    const cap = src.match(/inPcm\.length \+ outPcm\.length > ([\d_]+)/)
    expect(cap, 'the 40MB stitch guard moved — tooLongToStitch predicts nothing').toBeTruthy()
    expect(Number(cap![1].replace(/_/g, '')), 'the stitch cap drifted from lib/voice/playback.ts')
      .toBe(STITCH_BYTE_CAP)
  })

  it('the refusals are still REFUSALS — statuses, not a 200 with an error field', () => {
    // If any of these became a 200, the player would try to play a JSON body and
    // the whole error path here would never run.
    const src = code(readFileSync(workerFile('voice.ts'), 'utf8'))
    const start = src.indexOf('export async function voiceRecording')
    const end = src.indexOf('\nexport ', start + 10)
    const fn = src.slice(start, end > start ? end : undefined)
    const statuses = Array.from(fn.matchAll(/json\(\{\s*error:[^}]*\}\s*,\s*(\d{3})\s*\)/g))
      .map((m) => Number(m[1]))
    expect(statuses.length, 'no refusal statuses extracted — blind').toBeGreaterThanOrEqual(4)
    for (const s of statuses) {
      expect(s, `voiceRecording answers ${s} for a refusal — a 2xx would be played as audio`)
        .toBeGreaterThanOrEqual(400)
    }
  })

  it('⚠️ the worker STILL sends no CORS header on a refusal — why the web proxy exists', () => {
    // The whole reason `/api/voice/recording-status/[id]` exists: the worker's
    // `json()` helper sets only Content-Type, so a cross-origin fetch from
    // /calls cannot read the body. If the worker ever grows a wildcard on that
    // helper, the proxy becomes removable — and this pin is where a reader finds
    // that out, rather than re-deriving it.
    const src = readFileSync(workerFile('voice.ts'), 'utf8')
    const helper = src.slice(src.indexOf('const json = ('), src.indexOf('function checkInternalKey'))
    expect(helper.length, 'the json helper moved — this pin reads nothing').toBeGreaterThan(40)
    expect(helper, 'the worker json() helper now sets CORS — the /calls proxy may be simplified')
      .not.toMatch(/Access-Control-Allow-Origin/)
  })
})

describe('all three surfaces have an error channel and render its sentence', () => {
  it('⚠️ web asks the same-origin route WHY, because <audio> cannot', () => {
    const c = code(webSrc)
    expect(c, 'the <audio> element has no onError — a refusal is silent again')
      .toMatch(/onError=\{\(\)\s*=>\s*playFailed\(s\.id\)\}/)
    expect(c, 'web never fetches the refusal reason')
      .toMatch(/\/api\/voice\/recording-status\//)
    expect(c, 'web never translates the refusal').toMatch(/refusalFromStatusAnswer\(/)
    // ⚠️ AND IT IS DRAWN. A field pin and a decode pin both pass while the
    // render is a no-op — measured in c45 on the Android badge.
    expect(c, 'web decodes the refusal and draws nothing').toMatch(/⚠️ \{playError\[s\.id\]\}/)
  })

  it('⚠️ iOS observes the item status, the only channel a load refusal uses', () => {
    const c = code(iosSrc)
    // ⚠️ `status`, not the failed-to-play-to-end notification: every refusal here
    // fails at LOAD, so the item never starts playing and that notification never
    // fires. A pin on the wrong channel would certify a fix that cannot work.
    expect(c, 'iOS never observes the player item status — a refusal goes unread')
      .toMatch(/observe\(\\\.status/)
    expect(c, 'iOS does not check for the failed state').toMatch(/item\.status == \.failed/)
    expect(c, 'iOS never translates the refusal').toMatch(/CallRecordingRefusal\.text\(/)
    expect(c, 'iOS decodes the refusal and draws nothing')
      .toMatch(/if let why = playError\[s\.id\]/)
    expect(c, 'the iOS badge does not render the reason it captured').toMatch(/Text\("⚠️ \\\(why\)"\)/)
  })

  it('⚠️ iOS stops claiming it is playing when the play failed', () => {
    // Half of what made this invisible: a pause glyph asserts "playing" over a
    // transport at 0:00. The row must not keep saying that.
    const c = code(iosSrc)
    const obs = c.slice(c.indexOf('observe(\\.status'), c.indexOf('elapsed = 0'))
    expect(obs.length, 'the observation block moved — this pin reads nothing').toBeGreaterThan(80)
    expect(obs, 'iOS leaves playingId set after a failed play — the pause glyph lies')
      .toMatch(/playingId = nil/)
  })

  it('⚠️ iOS invalidates the observation it installed', () => {
    // A cleanup step is the UNDO of its setup. A KVO observation writing @State
    // into a dismissed view is a leak, and `onDisappear` is where the sibling
    // time observer is already torn down.
    //
    // ⚠️ SCOPED TO *THIS VIEW'S* onDisappear. The first `.onDisappear {` in this
    // file belongs to the live-call view (`call.stop()`), and slicing from it ran
    // to EOF — so the pin was satisfied by the invalidate inside `toggle`, 120
    // lines further down, and a mutant deleting the teardown SURVIVED. Anchor on
    // the sibling teardown that is only in the recordings view, and bound the
    // slice to the block.
    const c = code(iosSrc)
    const at = c.indexOf('if let timeObserver { player?.removeTimeObserver(timeObserver) }')
    expect(at, "the recordings view's onDisappear moved — this pin reads nothing")
      .toBeGreaterThan(-1)
    const gone = c.slice(at, c.indexOf('}', c.indexOf('clearNowPlaying()', at)))
    expect(gone.length, 'the onDisappear slice is empty — the pin is vacuous').toBeGreaterThan(80)
    expect(gone, 'the status observation outlives the view that reads it')
      .toMatch(/failObserver\?\.invalidate\(\)/)
    // And on re-play, or each tap leaks another observation onto the same state.
    const toggle = c.slice(c.indexOf('private func toggle(_ s: CallSession)'))
    expect(toggle.slice(0, toggle.indexOf('elapsed = 0')),
      'a second play installs a second observation without dropping the first')
      .toMatch(/failObserver\?\.invalidate\(\)/)
  })

  it('⚠️ Android registers the error listener it was missing', () => {
    const c = code(andSrc)
    expect(c, 'MediaPlayer still has no error listener — prepareAsync fails silently')
      .toMatch(/setOnErrorListener/)
    expect(c, 'Android never translates the refusal').toMatch(/CallRecordingRefusal\.text\(/)
    expect(c, 'Android decodes the refusal and draws nothing')
      .toMatch(/val why = playError\[call\.id\]/)
    // ⚠️ SCOPED TO THE playError BLOCK. `"⚠️ $why"` is drawn TWICE in this file —
    // the outcome badge from c45 uses the identical literal — so a file-wide
    // match was satisfied by the other one and a mutant that emptied THIS draw
    // SURVIVED. The same no-op-render trap c45 measured, one file later.
    const block = c.slice(c.indexOf('val why = playError[call.id]'))
    expect(block.slice(0, block.indexOf('tooLong')),
      'the Android badge does not render the reason it captured').toMatch(/"⚠️ \$why"/)
  })

  it('⚠️ the Android listener is registered BEFORE prepareAsync', () => {
    // `prepareAsync` can report into the listener during the call. Registering
    // after it is a race that loses exactly the fast failures — and a 413 is
    // decided by the server, so it is one of the fast ones.
    const c = code(andSrc)
    const listener = c.indexOf('setOnErrorListener')
    const prepare = c.indexOf('player.prepareAsync()')
    expect(listener, 'no error listener found').toBeGreaterThan(-1)
    expect(prepare, 'no prepareAsync found').toBeGreaterThan(-1)
    expect(listener, 'the error listener is registered after prepareAsync — a fast refusal is lost')
      .toBeLessThan(prepare)
    // And the per-row clear must also precede it, or it erases the sentence the
    // listener just recorded.
    const clear = c.indexOf('playError = playError - call.id')
    expect(clear, 'no per-row clear found').toBeGreaterThan(-1)
    expect(clear, 'the clear runs after prepareAsync and erases a fresh refusal')
      .toBeLessThan(prepare)
  })

  it('⚠️ the Android listener returns true — false would report a failure as a finish', () => {
    // Returning false ALSO invokes the completion listener, which sets
    // `playingId = null` and looks exactly like a recording that played through.
    const c = code(andSrc)
    const start = c.indexOf('setOnErrorListener')
    const block = c.slice(start, start + 700)
    expect(block, 'the error listener does not return true — the failure reads as a completion')
      .toMatch(/\n\s*true\n/)
  })

  it('⚠️ all three warn BEFORE the tap when the count already rules it out', () => {
    expect(code(webSrc), 'web never predicts the size refusal').toMatch(/tooLongToStitch\(s\.segment_count\)/)
    expect(code(iosSrc), 'iOS never predicts the size refusal')
      .toMatch(/CallRecordingRefusal\.tooLong\(segmentCount: s\.segment_count\)/)
    expect(code(andSrc), 'Android never predicts the size refusal')
      .toMatch(/CallRecordingRefusal\.tooLong\(call\.segmentCount\)/)
  })

  it('⚠️ Android carries the count as a NUMBER, not the boolean the filter used', () => {
    // The finding in one line: the field was on the row all along and every
    // client reduced it to `> 0`. Android's data class is where that reduction
    // was structural — there was nowhere for the number to be read from.
    const d = andSrc.slice(andSrc.indexOf('internal data class CallRecording('))
    const decl = d.slice(0, d.indexOf('\n)'))
    expect(decl, 'CallRecording drops segmentCount — the refusal cannot be predicted')
      .toMatch(/val segmentCount: Long/)
    expect(code(andSrc), 'the count is never read off the row')
      .toMatch(/segmentCount = o\.optLong\("segment_count"\)/)
  })

  it('⚠️ the three translations agree, or one platform lies to its user', () => {
    for (const sentence of [
      'this call is still going — reload in a moment',
      'this call is too long to replay in one piece',
      "this call wasn't recorded",
      "this call's audio wasn't saved",
      'recordings are unavailable right now',
      UNKNOWN_REFUSAL,
    ]) {
      expect(iosSrc, `iOS is missing the shared sentence "${sentence}"`).toContain(`"${sentence}"`)
      expect(andSrc, `Android is missing the shared sentence "${sentence}"`).toContain(`"${sentence}"`)
    }
  })

  it('⚠️ each native pair is REACHABLE — a swap passes every toContain above', () => {
    // Both sentences stay present in the file when two are swapped, so the
    // agreement pin above cannot see it and two people are told two different,
    // confident, wrong things.
    for (const [reason, sentence] of [
      ['call still in progress', 'this call is still going — reload in a moment'],
      ['call too long to stitch', 'this call is too long to replay in one piece'],
      ['no replay journaled for this session', "this call wasn't recorded"],
      ['no audio journaled', "this call's audio wasn't saved"],
      ['media store not provisioned', 'recordings are unavailable right now'],
      // The 400 too: it shares the generic sentence, and a native map that
      // simply OMITS the key would fall through to the same words — passing a
      // sentence-only check while losing `known`, which is the rot signal.
      ['session id required', UNKNOWN_REFUSAL],
    ] as Array<[string, string]>) {
      expect(playbackRefusal(reason).text).toBe(sentence)
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // iOS `("needle", "sentence")`, Android `"needle" to "sentence"` — one
      // regex over both by allowing the separator to be `,` or ` to`.
      //
      // ⚠️ The value may be the shared CONSTANT rather than a repeated literal
      // (`unknown` on iOS, `UNKNOWN` on Android — which is the better code, and
      // a quoted-literal-only pin would have pushed toward duplicating the
      // string instead). Accept either, and name the constant per platform so a
      // pair mapped to some OTHER constant still fails.
      for (const [name, src, constName] of [
        ['iOS', iosSrc, 'unknown'], ['Android', andSrc, 'UNKNOWN'],
      ] as Array<[string, string, string]>) {
        const value = sentence === UNKNOWN_REFUSAL
          ? `(?:"${esc(sentence)}"|${constName})`
          : `"${esc(sentence)}"`
        const pair = new RegExp(`"${esc(reason)}"\\s*(?:,|to)\\s*${value}`)
        expect(src, `${name} maps "${reason}" to a different sentence`).toMatch(pair)
      }
    }
  })

  it('⚠️ the native twins agree on the size threshold, in behaviour not spelling', () => {
    // The two constants and the `- 2` must all three match, and a pin on the
    // literals alone passes while the arithmetic differs. Read the expression
    // out of each file and assert its parts.
    for (const [name, src, re] of [
      ['iOS', iosSrc, /return \(n - 2\) \* segmentBytes > stitchByteCap/],
      ['Android', andSrc, /return \(segmentCount - 2\) \* SEGMENT_BYTES > STITCH_BYTE_CAP/],
    ] as Array<[string, string, RegExp]>) {
      expect(code(src), `${name}'s size predicate is not the shared arithmetic`).toMatch(re)
    }
    for (const [name, src] of [['iOS', iosSrc], ['Android', andSrc]] as Array<[string, string]>) {
      expect(src, `${name} lost the segment size`).toMatch(/1_440_000/)
      expect(src, `${name} lost the stitch cap`).toMatch(/40_000_000/)
    }
  })
})

describe('the status proxy exists for the body, and guards what it reports on', () => {
  const routeSrc = read(STATUS_ROUTE)

  it('⚠️ it is owner-gated with the fail-closed helper', () => {
    // It reports on a private voice record. `ownsVoiceSession` fails CLOSED — a
    // row with a falsy stored owner is not the caller's — which is the exact bug
    // /api/voice/replay/[id] already paid for.
    const c = code(routeSrc)
    expect(c, 'the status route does not check ownership at all').toMatch(/ownsVoiceSession\(/)
    expect(c, 'the route does not require a session').toMatch(/getSession\(/)
    // Ownership BEFORE the probe, or it becomes an oracle for other people's calls.
    expect(c.indexOf('ownsVoiceSession'), 'the recording is probed before ownership is checked')
      .toBeLessThan(c.indexOf('/voice/recording/'))
  })

  it('⚠️ it probes with a Range header — it must not proxy a 40MB WAV', () => {
    const c = code(routeSrc)
    expect(c, 'the probe fetches the whole recording to learn whether it exists')
      .toMatch(/Range: 'bytes=0-1'/)
  })

  it('a working recording is reported as ok, with no invented cause', () => {
    const c = code(routeSrc)
    expect(c, '206 is not treated as success — a ranged probe answers 206, not 200')
      .toMatch(/probe\.status === 206/)
    expect(c, 'a successful probe still reports an error').toMatch(/ok: true[^}]*error: null/)
  })

  it('⚠️ it is deadlined above its own internal budget', () => {
    // The route gives the worker 20s because a cold call STITCHES before it can
    // answer. A client deadline at or below that turns the reason into silence —
    // which is the defect this whole cycle is about.
    const budget = Array.from(routeSrc.matchAll(/AbortSignal\.timeout\((\d+)_?(\d*)\)/g))
      .map((m) => Number(`${m[1]}${m[2]}`))
    expect(budget.length, 'the route declares no timeout — this pin is vacuous').toBeGreaterThan(0)
    const client = deadlineFor('/api/voice/recording-status/abc')
    expect(client, `client ${client}ms must outlive server ${Math.max(...budget)}ms`)
      .toBeGreaterThan(Math.max(...budget))
  })
})
