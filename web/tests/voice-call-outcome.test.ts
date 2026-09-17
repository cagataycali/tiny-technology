// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { callOutcome, UNKNOWN_OUTCOME } from '../lib/voice/outcome'

/**
 * 🔴 A recorded reason with no reader.
 *
 * `VoiceSession.teardown` writes why a call ended into `voice_sessions.error`,
 * and its own docstring says what for: "the row is what the person still has
 * tomorrow when they ask why." `VOICE_LIST_SQL` selects the column and
 * /api/voice/sessions passes the rows through verbatim — so the reason reached
 * all three clients, and all three dropped it one line before the render, at
 * the type boundary: web's `CallSession`, iOS's `CallSession`, Android's
 * `CallRecording` simply had no such field.
 *
 * What that cost: every one of those three list filters ADMITS
 * `status === "error"` rows. So a call the voice service dropped 20 seconds in
 * rendered `📞 tiny · Aug 2, 14:32 · 0:20` — pixel-for-pixel identical to a
 * 20-second call the person ended themselves. The one number on the row (the
 * duration) is what makes it indistinguishable: a short call and a call cut
 * short look the same when the only thing shown is how long it lasted.
 *
 * The second half is subtler and it is why this isn't a one-line render fix:
 * the recorded strings are `upstream closed: 1011 <reason>` and
 * `upstream error: <exception>` — worker-tail diagnostics. Painting one onto
 * someone's call list would be the same wrong-surface mistake pointing the
 * other way. The column stays diagnostic; `callOutcome` translates at the
 * surface, where the reader is known.
 *
 * ⚠️ THE LOAD-BEARING PIN IS `every reason the worker can record has a
 * sentence` — it reads the literals OUT OF `src/voice.ts` rather than listing
 * the five spellings I thought of. A map of translations is exactly the kind of
 * thing that passes forever while the thing it maps moves on: pinning my own
 * list would prove the list matches itself.
 */

const ROOT = process.cwd()
const WEB = join(ROOT, 'app/calls/page.tsx')
const IOS = join(ROOT, 'ios/Tiny/Sources/VoiceCall.swift')
const AND = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/CallRecordingsSheet.kt')

const read = (p: string) => readFileSync(p, 'utf8')

/** Comments stripped: a rule explained in prose must not satisfy an assertion. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

const webSrc = read(WEB)
const iosSrc = read(IOS)
const andSrc = read(AND)

describe('call outcome: a reason nobody renders', () => {
  it('an ordinary hangup says nothing — the badge is not decoration', () => {
    expect(callOutcome('ended', null)).toBeNull()
    expect(callOutcome('ended', '')).toBeNull()
    // ⚠️ Whitespace is not a reason. The column is written by five different
    // arms; `"upstream closed: "` with an empty code/reason trims to a bare
    // prefix, and a row of blanks must not raise a warning badge on a call
    // that ended fine.
    expect(callOutcome('ended', '   ')).toBeNull()
  })

  it('a dropped call no longer reads like a short one', () => {
    // The exact shape the upstream close listener records.
    const out = callOutcome('ended', 'upstream closed: 1011 going away')
    expect(out, 'an upstream close records a reason and the row shows nothing').not.toBeNull()
    expect(out!.known).toBe(true)
    expect(out!.text).toBe('the voice service closed the connection')
    // ⚠️ The diagnostic tail must NOT reach the person: the close code and the
    // upstream's own words are for the worker tail.
    expect(out!.text, 'the close code leaked to the call list').not.toMatch(/1011/)
    expect(out!.text).not.toMatch(/going away/)
  })

  it('an upstream exception message never reaches the person', () => {
    const out = callOutcome('error', 'upstream error: TypeError: undefined is not a function')
    expect(out!.text).toBe('the voice service dropped')
    expect(out!.text, 'an arbitrary exception string was painted into the UI')
      .not.toMatch(/TypeError|undefined/)
  })

  it('the three arms that measured their own cause say what they measured', () => {
    expect(callOutcome('ended', 'the client went silent')!.text)
      .toBe('we stopped hearing this device')
    expect(callOutcome('ended', 'the call hit the maximum length')!.text)
      .toBe('the call hit the maximum length')
    expect(callOutcome('error', 'the client socket errored')!.text)
      .toBe("this device's connection dropped")
  })

  it('⚠️ an UNRECOGNISED reason still says the call broke, and names no cause', () => {
    // A new teardown arm upstream, or a reason from a build this map predates.
    const out = callOutcome('ended', 'the flux capacitor desynced')
    expect(out, 'an unknown reason fell back to silence — the reason lost its reader again')
      .not.toBeNull()
    expect(out!.known, 'an unrecognised reason was reported as understood').toBe(false)
    expect(out!.text).toBe(UNKNOWN_OUTCOME)
    // It must not echo the reason it did not understand: that is the raw
    // diagnostic, and this function's whole job is to not show one.
    expect(out!.text).not.toMatch(/flux/)
  })

  it("⚠️ an error row from BEFORE the reason was wired is not treated as clean", () => {
    // Every error row written before `6a24d5d` has status='error', error=NULL.
    // The status alone is more than the row said yesterday.
    const out = callOutcome('error', null)
    expect(out, 'a legacy error row still renders as an ordinary call').not.toBeNull()
    expect(out!.known).toBe(false)
    expect(out!.text).toBe(UNKNOWN_OUTCOME)
  })

  it('a live row is not given an outcome (only finished calls list)', () => {
    expect(callOutcome('live', null)).toBeNull()
    expect(callOutcome('created', null)).toBeNull()
    expect(callOutcome(undefined, undefined)).toBeNull()
  })
})

describe.skipIf(!present)('the map is keyed on the worker, not on my memory', () => {
  warnIfWorkerAbsent('voice-call-outcome')

  /** Every string literal `teardown(status, reason)` can be called with — read
   *  out of the worker source. The 2nd argument, when there is one. */
  function recordedReasons(): string[] {
    const src = code(readFileSync(workerFile('voice.ts'), 'utf8'))
    const out: string[] = []
    const re = /teardown\(\s*"(?:ended|error)"\s*,\s*"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) out.push(m[1])
    return out
  }

  /** The `const why = \`…\`` template arms — recorded reasons built at runtime,
   *  where only the literal PREFIX is knowable from source. */
  function reasonPrefixes(): string[] {
    const src = code(readFileSync(workerFile('voice.ts'), 'utf8'))
    const out: string[] = []
    const re = /const why = `([^$`]+)\$\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) out.push(m[1])
    return out
  }

  it('⚠️ EVERY reason the worker can record has a sentence for the person', () => {
    const literals = recordedReasons()
    // The "did I read this" assertion: an extractor that matches nothing would
    // make every expectation below pass on an empty list, forever.
    expect(literals.length, 'extracted no teardown reason literals — this suite is blind')
      .toBeGreaterThanOrEqual(3)
    for (const reason of literals) {
      const out = callOutcome('ended', reason)
      expect(out, `teardown records "${reason}" and no surface can say it`).not.toBeNull()
      expect(
        out!.known,
        `the worker records "${reason}" but callOutcome does not recognise it — ` +
        `a teardown arm was added upstream and the three clients now show ` +
        `"${UNKNOWN_OUTCOME}" for a cause that IS known`,
      ).toBe(true)
    }
  })

  it('⚠️ every TEMPLATE reason is recognised by its prefix, WHATEVER the tail', () => {
    const prefixes = reasonPrefixes()
    expect(prefixes.length, 'extracted no `const why = `…${` prefixes — suite is blind')
      .toBeGreaterThanOrEqual(2)
    // ⚠️ SEVERAL tails, deliberately. A single sample tail lets the map be
    // narrowed to that one value and still pass — measured: a mutant changing
    // `/^upstream closed:/` to `/^upstream closed: 1011/` SURVIVED a version of
    // this pin that only ever tried `1011`. The worker interpolates
    // `${e?.code ?? "?"}` and an arbitrary `e.reason`, so the code is not
    // knowable here — and `"?"` is what it writes when there is no code at all,
    // which is exactly the case a code-specific pattern would drop.
    const tails = ['1011 going away', '1006 ', '? ', '4999 policy violation', '']
    for (const p of prefixes) {
      for (const tail of tails) {
        const out = callOutcome('ended', `${p}${tail}`.trim())
        expect(out, `the worker records "${p}${tail}" and nothing can say it`).not.toBeNull()
        expect(
          out!.known,
          `the worker records "${p}…" with tail "${tail}" and callOutcome falls ` +
          `through to "${UNKNOWN_OUTCOME}" — the pattern is keyed to a tail, not the prefix`,
        ).toBe(true)
        expect(out!.text, `the tail of "${p}${tail}" reached the person`)
          .not.toMatch(/1011|1006|4999|going away|policy/)
      }
    }
  })

  it('the LIST query still ships the column all three clients now decode', () => {
    const src = readFileSync(workerFile('voice.ts'), 'utf8')
    const list = src.slice(src.indexOf('VOICE_LIST_SQL = '))
    const stmt = list.slice(0, list.indexOf('`;'))
    expect(stmt, 'VOICE_LIST_SQL stopped selecting error — three renders go dark')
      .toMatch(/\berror\b/)
  })

  it('the reason stays DIAGNOSTIC in the column — the translation is ours', () => {
    // If the worker ever starts recording the person's sentence directly, this
    // module becomes a second, competing author of the same words.
    const src = code(readFileSync(workerFile('voice.ts'), 'utf8'))
    expect(src, 'the worker now writes the UI sentence itself — two authors of one string')
      .not.toMatch(/the voice service closed the connection"\s*\)/)
  })
})

describe('all three surfaces decode the reason and none renders it raw', () => {
  it('web decodes `error` and renders the translation', () => {
    const t = webSrc.slice(webSrc.indexOf('type CallSession = {'))
    const decl = t.slice(0, t.indexOf('};'))
    expect(decl, 'web CallSession drops error — the row cannot say why').toMatch(/\berror\?/)
    const c = code(webSrc)
    expect(c, 'web never calls callOutcome').toMatch(/callOutcome\(s\.status,\s*s\.error\)/)
    // ⚠️ The raw column must not be rendered. `{s.error}` in JSX is the shape
    // to ban — and `s.error` as an ARGUMENT is fine, hence the brace anchor.
    expect(c, 'web paints the raw worker diagnostic into the row')
      .not.toMatch(/\{\s*s\.error\s*\}/)
  })

  it('iOS decodes `error` and renders the translation', () => {
    const s = iosSrc.slice(iosSrc.indexOf('struct CallSession: Identifiable, Decodable {'))
    const decl = s.slice(0, s.indexOf('\n}'))
    expect(decl, 'iOS CallSession drops error — the row cannot say why')
      .toMatch(/let error: String\?/)
    const c = code(iosSrc)
    expect(c, 'iOS never calls CallOutcome').toMatch(/CallOutcome\.text\(status: s\.status, error: s\.error\)/)
    expect(c, 'iOS interpolates the raw worker diagnostic into a Text')
      .not.toMatch(/Text\("[^"]*\\\(s\.error/)
  })

  it('Android carries the translated reason and never the raw one', () => {
    const d = andSrc.slice(andSrc.indexOf('internal data class CallRecording('))
    const decl = d.slice(0, d.indexOf('\n)'))
    expect(decl, 'CallRecording drops the reason — the row cannot say why')
      .toMatch(/val outcome: String\?/)
    const c = code(andSrc)
    expect(c, 'Android never calls CallOutcome').toMatch(/CallOutcome\.text\(status, o\.optString\("error"\)\)/)
    // The data class holds the TRANSLATION, so a raw read anywhere else in the
    // sheet would be a second, untranslated path to the same string.
    const reads = (c.match(/optString\("error"\)/g) || []).length
    expect(reads, 'the raw reason is read in more than one place — one of them is untranslated')
      .toBe(1)
    // ⚠️ AND IT IS RENDERED. Carrying the field is half the fix; the defect was
    // a value that arrived and had no reader. Measured: a mutant replacing the
    // render with `(null as String?)?.let` SURVIVED until this line existed —
    // the decode pin above passed while the badge drew nothing, which is the
    // original bug wearing the fix's clothes.
    expect(c, 'Android carries the outcome and never draws it — a field with no reader')
      .toMatch(/call\.outcome\?\.let\s*\{/)
    expect(c, 'the Android badge does not render the reason it captured')
      .toMatch(/"⚠️ \$why"/)
  })

  it('⚠️ the three translations agree, or one platform lies to its user', () => {
    // Same call, three phones, three different explanations is worse than one.
    // The sentences live in three files by necessity (no shared runtime), so
    // the agreement has to be asserted rather than assumed.
    for (const sentence of [
      'the voice service closed the connection',
      'the voice service dropped',
      "this device's connection dropped",
      'we stopped hearing this device',
      'the call hit the maximum length',
      UNKNOWN_OUTCOME,
    ]) {
      // Kotlin/Swift string literals use the same double quotes; iOS's
      // apostrophe needs no escape in either.
      expect(iosSrc, `iOS is missing the shared sentence "${sentence}"`).toContain(`"${sentence}"`)
      expect(andSrc, `Android is missing the shared sentence "${sentence}"`).toContain(`"${sentence}"`)
    }
  })

  it('⚠️ each translation is reachable — a sentence with no key is dead text', () => {
    // The previous pin proves the WORDS are present in all three. This one
    // proves they are wired: a sentence pasted into a comment, or a map entry
    // whose key nobody records, satisfies `toContain` and renders never.
    for (const [reason, sentence] of [
      ['upstream closed: 1011 x', 'the voice service closed the connection'],
      ['upstream error: boom', 'the voice service dropped'],
      ['the client socket errored', "this device's connection dropped"],
      ['the client went silent', 'we stopped hearing this device'],
      ['the call hit the maximum length', 'the call hit the maximum length'],
    ] as Array<[string, string]>) {
      expect(callOutcome('ended', reason)!.text).toBe(sentence)
      // The same key must sit next to the same sentence in both native maps —
      // a swapped pair passes both `toContain` checks and tells two people two
      // different, confident, wrong things.
      const iosPair = new RegExp(`"${reason.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*",\\s*"${sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
      expect(iosSrc, `iOS maps "${reason}" to a different sentence`).toMatch(iosPair)
      expect(andSrc, `Android maps "${reason}" to a different sentence`).toMatch(iosPair)
    }
  })
})

describe('the badge appears exactly where the duration misleads', () => {
  it('the row keeps its filters — the badge is additive, not a new gate', () => {
    // ⚠️ A row admitted for its `status === "error"` is precisely the row this
    // badge exists for. Tightening the filter to hide error rows would "fix"
    // the confusion by deleting the call from the person's archive.
    const c = code(webSrc)
    expect(c).toMatch(/s\.status === "ended" \|\| s\.status === "error"/)
    expect(code(iosSrc)).toMatch(/\$0\.status == "ended" \|\| \$0\.status == "error"/)
    expect(code(andSrc)).toMatch(/status == "ended" \|\| status == "error"/)
  })

  it('the badge sits with the duration it corrects, not in a detail view', () => {
    // The whole finding is that the DURATION is what misleads: 0:20 reads as a
    // short call. A reason parked behind a tap would leave the misreading in
    // place on the surface everyone actually looks at.
    const c = code(webSrc)
    const rowStart = c.indexOf('{s.duration_ms ? ` · ${clock(s.duration_ms)}` : ""}')
    expect(rowStart, 'the duration line moved — this pin no longer reads the row').toBeGreaterThan(-1)
    const nearby = c.slice(rowStart, rowStart + 500)
    expect(nearby, 'the web badge is not next to the duration it corrects')
      .toMatch(/callOutcome/)
  })
})
