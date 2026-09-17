// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideClipboardWrite, CLIPBOARD_MAX } from '../lib/chat/clipboard-write'

/**
 * 📋 One clipboard rule, three clients — and it started as three different wrong answers.
 *
 * `copy_to_clipboard` is the widest sink the agent is handed: it is the only tool whose
 * value the USER then pastes into another program, so a wrong value is spent somewhere
 * none of this code will ever see. Web worked that out and wrote the rule down
 * (`lib/chat/clipboard-write.ts`, four defects, 21 pins). Neither phone read it.
 *
 * The three answers to `{"text": {"a": 1}}`, each measured rather than assumed:
 *
 *   - **web** coerced it — `String({a:1})` is `"[object Object]"` on the clipboard;
 *   - **iOS** refused it — `args["text"] as? String` is nil, so the write is skipped;
 *   - **Android** coerced it DIFFERENTLY — `JSONObject.optString` calls
 *     `Object.toString()` (verified in the shipping `json-20240303.jar` bytecode, offset
 *     21, not in `android.jar`, whose `org.json` is stubs that throw), so the literal
 *     `{"a":1}` reached the clipboard.
 *
 * ⚠️ And the defect that COSTS something is the blank one. `optString("text")` returns
 * `""` for an absent key; the old Android arm skipped the write on empty — but
 * `handleUnsafe` fell through to `Outcome.RAN`, so `DeviceActionAudit` told the proxied
 * web agent the copy happened, and the live-voice rail SPOKE it. On web the same shape is
 * worse than a no-op: `writeText("")` is a write, so whatever the user had — a wallet
 * address mid-paste, a password out of a manager — was silently erased.
 *
 * The unit of this suite is what no single-client test can see: that the rule is ONE rule.
 * Each client's own behaviour is executed where it can be — `tests/clipboard-write.test.ts`
 * (web, this module), `ClipboardWriteTest` + `ClipboardAuditTest` (Android, 16 JVM tests) —
 * so what is pinned here is agreement, and the SHAPE of the enforcement in the two clients
 * this tree cannot execute.
 *
 * ⚠️ Comments are stripped before every source scan: the Kotlin and Swift docblocks quote
 * the old `optString` / `prefix(10_000)` idioms verbatim while explaining their removal,
 * so a raw-file scan finds the defect in the prose about the fix.
 *
 * ⚠️⚠️ **THE iOS GAP THIS SUITE ONCE ONLY FLAGGED IS NOW CLOSED, and the pins below are
 * what changed with it.** `DeviceTools.swift`'s arm was
 * `if let text = args["text"] as? String, !text.isEmpty` — so a `text` of `" "` passed and
 * wrote a single space over whatever the user had, and the switch fell through to `.ran`,
 * so `DeviceActionAudit.outcomeLine` said "ran on the phone" and `voiceResult` answered
 * `ok: true`, which the tiny SPOKE. iOS was right on two rules (it refused non-strings via
 * `as? String`, and it capped) and wrong on the destructive one — and silently right on the
 * two, which audits identically to being wrong. The rule now lives in `enum Clipboard`
 * (`Clipboard.decide`), both rails re-run it (`clipboardLine` / `clipboardResult`), and the
 * chat rail carries web's fourth rule as a quoting transcript line. `ClipboardWriteTests`
 * (Swift, 14 tests) executes the verdicts; what is pinned here is that all three clients
 * hold ONE rule and that the iOS wiring is present — the two things no single-client suite
 * can see.
 *
 * ⚠️ While that gap was open this file deliberately did NOT assert the defective arm as
 * correct, because **a suite that pins a defect VOTES for it** and the fixer would have had
 * to delete a green test. Keep that discipline for the next flagged gap.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
// Kotlin `//`, KDoc `*` continuation lines, and Swift `///` all go.
const strip = (s: string) =>
  s
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '')
    .replace(/^\s*\/\*\*?.*$/gm, '')

const kt = (p: string) => raw(`android/app/src/main/java/technology/tiny/app/${p}`)
const deviceTools = () => strip(kt('tools/DeviceTools.kt'))
const audit = () => strip(kt('fleet/DeviceActionAudit.kt'))
/** iOS keeps the rule, the arm and BOTH audit rails in one file. */
const swift = () => strip(raw('ios/Tiny/Sources/DeviceTools.swift'))

const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return src.slice(a, b)
}

/** Android's pure decision, region-split so a pin can't be satisfied elsewhere. */
const decide = () =>
  between(deviceTools(), 'internal fun decideClipboardWrite(', '\n}\n', 'decideClipboardWrite')

/** iOS's, same discipline: a pin on the rule must not be satisfied by the arm. */
const swiftDecide = () =>
  between(swift(), 'static func decide(_ raw: Any?) -> Write {', '\n    }\n', 'Clipboard.decide')

/** iOS's clipboard ARM — the region between the case label and the next one. */
const swiftArm = () =>
  between(swift(), 'case "copy_to_clipboard":', 'case "set_brightness":', 'the iOS clipboard arm')

describe('📋 the clipboard rule is one rule, not three', () => {
  it('reads the files it means to read', () => {
    // ⚠️ Every assertion below is a scan over a stripped source string. A `strip`
    // that over-matches, or a path that moved, returns "" — and "" satisfies every
    // `.not.toMatch` in this file forever while looking green.
    expect(deviceTools().length, 'the Kotlin device tools read empty — re-anchor the path').toBeGreaterThan(10_000)
    expect(audit().length, 'the Kotlin audit read empty').toBeGreaterThan(2_500)
    expect(swift().length, 'the Swift device tools read empty').toBeGreaterThan(8_000)
    // …and the regions the pins actually target, which is where a rename hides.
    expect(decide().length, 'decideClipboardWrite sliced to nothing').toBeGreaterThan(400)
    expect(swiftDecide().length, 'Clipboard.decide sliced to nothing').toBeGreaterThan(400)
  })

  it('every client enforces the same cap, and it is the one the model is told', () => {
    // The zod `.max(10_000)` is only DESCRIBED to the model — `buildVoiceTools`
    // forwards inputSchema as advisory JSON Schema and each executor reads the
    // frame's args directly. So the number lives in four places and this is the
    // pin that keeps them equal.
    expect(CLIPBOARD_MAX, 'web changed the cap alone').toBe(10_000)
    expect(deviceTools(), 'Android lost the shared constant — a literal here drifts silently')
      .toMatch(/const val CLIPBOARD_MAX = 10_000/)
    expect(raw('lib/chat/tools/client-side.ts'), "the tool schema's cap moved away from the clients")
      .toMatch(/\.max\(10_?000\)/)
    // iOS used to enforce it as a bare `prefix(10_000)` inside the arm — the
    // fourth copy of one number, with nothing tying it to the other three.
    expect(swift(), 'iOS lost the shared constant — a literal in the arm drifts silently')
      .toMatch(/static let max = 10_000/)
    expect(swiftArm(), 'the cap is back to a literal in the arm, where it can drift alone')
      .not.toMatch(/prefix\(10_000\)/)
  })

  it('a blank text is REFUSED on every client, because the write is destructive', () => {
    // Web: executed here.
    for (const blank of ['', ' ', '\n\t ']) {
      const d = decideClipboardWrite(blank)
      expect(d.ok, `web allowed a blank write (${JSON.stringify(blank)})`).toBe(false)
    }
    // Android: refused in the pure decision, and it must be BLANK-ness (trimmed),
    // not emptiness — " " is just as destructive as "".
    expect(decide(), 'Android checks isEmpty again — a space still erases the clipboard')
      .toMatch(/raw\.isBlank\(\) -> ClipboardWrite\.Refused/)
    expect(decide(), 'Android is back to writing whatever it was handed')
      .not.toMatch(/isNotEmpty\(\)/)
    // iOS: the defect this suite once only flagged. `!text.isEmpty` let " " through
    // and a single space erased the clipboard, so the test must be BLANKNESS —
    // and the old guard must be gone from the arm, not merely joined by a new one.
    expect(swiftDecide(), 'iOS checks emptiness again — a space still erases the clipboard')
      .toMatch(/trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/)
    expect(swiftDecide(), 'the blank case no longer refuses').toMatch(/return \.refused/)
    expect(swiftArm(), 'the arm guards on isEmpty again — the blank-write defect is back')
      .not.toMatch(/!text\.isEmpty/)
    expect(swiftArm(), 'the arm reads text off args directly instead of asking the rule')
      .not.toMatch(/args\["text"\] as\? String/)
  })

  it('the raw argument is read as Any, so a non-string cannot be coerced', () => {
    // ⚠️ This is the pin on the actual defect: reading it as a String FIRST is
    // what coerces, so the type check has to happen on the raw JSON value.
    expect(decide(), 'the decision takes a String again — the coercion is back upstream of it')
      .toMatch(/decideClipboardWrite\(raw: Any\?\)/)
    expect(decide(), 'the type refusal is gone').toMatch(/raw !is String -> ClipboardWrite\.Refused/)
    // JSONObject.NULL is a real object whose toString() is "null" — the shape that
    // otherwise puts four characters on a user's clipboard.
    expect(decide(), 'JSON null is no longer distinguished — it copies the word "null"')
      .toMatch(/JSONObject\.NULL/)
    // And the call site must not undo it. `optString` here is the whole bug.
    const arm = between(deviceTools(), '"copy_to_clipboard" ->', '"set_brightness"', 'the clipboard arm')
    expect(arm, 'the arm reads optString again — non-strings are coerced before the check sees them')
      .not.toMatch(/optString/)
    expect(arm, 'the arm stopped consulting the shared decision')
      .toMatch(/decideClipboardWrite\(input\.opt\("text"\)\)/)
    // Web agrees, executed:
    for (const bad of [{ a: 1 }, 42, true, ['a', 'b'], null, undefined]) {
      expect(decideClipboardWrite(bad).ok, `web coerced ${JSON.stringify(bad)}`).toBe(false)
    }
    // iOS: same shape — the decision takes the raw `Any?`, and JSON null is
    // distinguished from an absent key (NSNull's description is the word "null").
    expect(swift(), 'the iOS decision takes a String again — the coercion moves upstream of it')
      .toMatch(/static func decide\(_ raw: Any\?\) -> Write/)
    expect(swiftDecide(), 'the iOS type refusal is gone').toMatch(/guard let text = value as\? String else/)
    expect(swiftDecide(), 'iOS no longer distinguishes a JSON null — it copies the word "null"')
      .toMatch(/NSNull/)
  })

  it('nothing is written unless the decision allowed it', () => {
    // The one line that makes the refusal real: the system clipboard is touched
    // inside the Allowed branch, and it writes `write.text` — the CAPPED string,
    // never the raw argument.
    const arm = between(deviceTools(), '"copy_to_clipboard" ->', '"set_brightness"', 'the clipboard arm')
    expect(arm, 'the write escaped the Allowed branch').toMatch(/if \(write is ClipboardWrite\.Allowed\)/)
    expect(arm, 'the raw text is written instead of the capped text — the cap is a claim again')
      .toMatch(/newPlainText\("tiny", write\.text\)/)
    // iOS: the pasteboard is touched only inside `.allowed`, and it is handed the
    // BOUND value from the pattern match — never the raw argument, or the cap is a
    // claim again on the client where it used to be the only rule enforced.
    expect(swiftArm(), 'the iOS write escaped the allowed branch')
      .toMatch(/if case \.allowed\(let text, _\) = Clipboard\.decide\(args\["text"\]\)/)
    expect(swiftArm(), 'iOS writes something other than the decision’s capped text')
      .toMatch(/UIPasteboard\.general\.string = text\b/)
  })

  it('a refused write is never reported as a copy, on either reporting rail', () => {
    /**
     * ⚠️ THE REGRESSION THIS EXISTS TO STOP. `Outcome` cannot carry this fact: the
     * arm runs either way, so it returns RAN, and RAN renders as "ran on the phone".
     * Both reporting surfaces therefore have to re-run the decision — exactly as
     * this file's open_url line re-runs `resolveOpenUrl`.
     */
    const a = audit()
    expect(a, 'the relay audit lost its clipboard line — a refusal reads as "ran on the phone" again')
      .toMatch(/fun clipboardLine\(raw: Any\?\)/)
    expect(a, 'the live-voice rail lost its clipboard result — a refusal is spoken as a copy')
      .toMatch(/fun clipboardResult\(raw: Any\?\)/)
    // Both must go through the SHARED decision, not re-implement the rule. A second
    // copy of it is how the audit comes to describe something the write didn't do.
    for (const fn of ['clipboardLine', 'clipboardResult']) {
      const body = between(a, `fun ${fn}(raw: Any?)`, '\n    }', `${fn}`)
      expect(body, `${fn} decides for itself instead of re-running the write's decision`)
        .toMatch(/decideClipboardWrite\(raw\)/)
    }
    // And a refusal is ok:false on the voice rail — unlike a quiet-hours mute, which
    // is the phone obeying the user. Anchored on the Refused arm specifically.
    const voice = between(a, 'fun clipboardResult(raw: Any?)', '\n    }', 'clipboardResult')
    expect(voice, 'a refused clipboard write comes back as success and is spoken as one')
      .toMatch(/Refused ->\s*\n\s*org\.json\.JSONObject\(\)\.put\("ok", false\)/)

    // ── iOS, where the same two rails vouched for the blank write ──
    const s = swift()
    expect(s, 'iOS lost its relay clipboard line — a refusal reads as "ran on the phone" again')
      .toMatch(/static func clipboardLine\(argsJson: String\) -> String/)
    expect(s, 'iOS lost its live-voice clipboard result — a refusal is spoken as a copy')
      .toMatch(/static func clipboardResult\(argsJson: String\) -> \[String: Any\]/)
    for (const fn of ['clipboardLine', 'clipboardResult']) {
      const body = between(s, `static func ${fn}(argsJson: String)`, '\n    }\n', fn)
      expect(body, `iOS ${fn} decides for itself instead of re-running the write's decision`)
        .toMatch(/Clipboard\.decide\(Clipboard\.rawText\(argsJson: argsJson\)\)/)
    }
    // A refusal is ok:false on the voice rail, same as Android — unlike a
    // quiet-hours mute, which is the phone obeying the user.
    const iosVoice = between(s, 'static func clipboardResult(argsJson: String)', '\n    }\n', 'clipboardResult')
    expect(iosVoice, 'a refused iOS clipboard write comes back as success and is spoken as one')
      .toMatch(/case \.refused\(let error\):\s*\n\s*return \["ok": false, "error": error\]/)

    // ⚠️ And the CALL SITES must actually take the new rail. A perfect audit
    // function nobody calls is the `DevicesFooter`/`Capacity` defect class — the
    // one thing a Swift test cannot see, which is the whole reason for this file.
    const session = strip(raw('ios/Tiny/Sources/Session.swift'))
    expect(session, 'the relay rail still audits the clipboard through outcomeLine — .ran either way')
      .toMatch(/name == "copy_to_clipboard"[\s\S]{0,400}?DeviceActionAudit\.clipboardLine\(argsJson: argsJson\)/)
    const views = strip(raw('ios/Tiny/Sources/Views.swift'))
    expect(views, 'the live-voice rail still answers voiceResult for the clipboard')
      .toMatch(/name == "copy_to_clipboard"\s*\n?\s*\?\s*DeviceActionAudit\.clipboardResult\(argsJson: json\)/)
  })

  it('the two phones and the web agree on the truncation NOTE, word for word', () => {
    // The model reads this. A truncated write that does not say so leaves the agent
    // describing the whole string as copied — so the sentence is shared, not
    // paraphrased per client.
    const note = `copied, but truncated to the first ${CLIPBOARD_MAX} characters`
    const web = decideClipboardWrite('x'.repeat(CLIPBOARD_MAX + 1))
    expect(web.ok && web.truncated, 'web stopped truncating').toBe(true)
    expect(raw('lib/chat/clipboard-write.ts'), 'web reworded the truncation note').toContain(
      'truncated to the first ${CLIPBOARD_MAX} characters',
    )
    expect(deviceTools(), 'Android reworded the truncation note — the two agents now disagree')
      .toContain('copied, but truncated to the first $CLIPBOARD_MAX characters')
    expect(swift(), 'iOS reworded the truncation note — the agents now disagree')
      .toContain('copied, but truncated to the first \\(Clipboard.max) characters')
    // …and the plain case, which is the sentence the model reads on every successful
    // copy. All three say it identically.
    for (const [client, src] of [['Android', deviceTools()], ['iOS', swift()], ['web', raw('lib/chat/clipboard-write.ts')]] as const) {
      expect(src, `${client} reworded the plain confirmation note`).toContain("copied to the user's clipboard")
    }
    expect(note.length, 'sanity: the note is a real sentence').toBeGreaterThan(20)
  })

  it("the user is SHOWN what landed, because the risk is substitution", () => {
    // Web's fourth rule, which had been web-only: a confirmation that QUOTES the
    // value. "Copied!" cannot surface a tiny swapping its own wallet address over
    // the one the user meant; the value can. Every client whose chat rail has
    // somewhere to put it now owes this.
    expect(deviceTools(), 'Android lost the quoting confirmation').toMatch(
      /internal fun clipboardConfirmToast\(text: String, truncated: Boolean\)/,
    )
    expect(deviceTools(), 'the toast stopped quoting the preview — a substituted value is invisible again')
      .toMatch(/clipboardPreview\(text\)/)
    const chat = strip(kt('chat/ChatViewModel.kt'))
    const armIdx = chat.indexOf('"copy_to_clipboard" ->')
    expect(armIdx, 'the chat rail no longer special-cases the clipboard — no toast is shown')
      .toBeGreaterThan(-1)
    const chatArm = chat.slice(armIdx, armIdx + 1400)
    expect(chatArm, 'the confirmation toast is gone from the chat rail')
      .toMatch(/clipboardConfirmToast\(write\.text, write\.truncated\)/)
    // A refusal is toasted too: the user watched a copy be asked for, and silence
    // reads as success.
    expect(chatArm, 'a refused copy is silent on screen, which reads as success')
      .toMatch(/Nothing copied/)

    // iOS puts it in the TRANSCRIPT rather than a toast: ChatView's modifier chain
    // is at the release demangler's limit, and a line of transcript outlives a
    // toast anyway. Same two branches, same quoting requirement.
    expect(swift(), 'iOS lost the quoting confirmation')
      .toMatch(/static func confirmToast\(text: String, truncated: Bool\)/)
    expect(swift(), 'the iOS confirmation stopped quoting the preview — a substitution is invisible again')
      .toMatch(/preview\(text\)/)
    const chatNote = between(swift(), 'static func chatNote(argsJson: String)', '\n    }\n', 'chatNote')
    expect(chatNote, 'the iOS chat line no longer quotes what landed')
      .toMatch(/confirmToast\(text: text, truncated: truncated\)/)
    expect(chatNote, 'a refused copy is silent in the iOS transcript, which reads as success')
      .toMatch(/Nothing copied/)
    // …and the chat rail must CALL it, under a condition that can be TRUE.
    //
    // ⚠️ An arm-reading pin proves an arm is read, never that it is REACHED: a
    // pin on `Clipboard.chatNote(…)` alone survives `if false { … }` with the
    // call still sitting there in the source. The guard is pinned with it, so
    // the mutant that severs the rail has nowhere to hide.
    const views = strip(raw('ios/Tiny/Sources/Views.swift'))
    expect(views, 'the iOS chat rail computes no confirmation — the user sees nothing at all')
      .toMatch(/if name == "copy_to_clipboard" \{[\s\S]{0,300}?Clipboard\.chatNote\(argsJson: argsJson\)/)
    // …and it must reach the transcript, not just be computed.
    expect(views, 'the confirmation is computed and never rendered')
      .toMatch(/Clipboard\.chatNote\(argsJson: argsJson\)[\s\S]{0,200}?reply\.text \+=/)
  })

  it('the Swift suite RUNS the verdicts no source scan can reach', () => {
    // ⚠️ Everything above is a scan. It cannot tell whether `decide(" ")` refuses
    // or allows, whether the cap cuts at 10_000 or 9_999, or whether the two rails
    // agree — only ClipboardWriteTests can, and if its @Test attributes are
    // dropped that suite still passes with fewer tests and nothing goes red.
    const src = raw('ios/Tests/TinyTests.swift')
    const at = src.indexOf('@Suite struct ClipboardWriteTests {')
    expect(at, 'ClipboardWriteTests is gone — the verdicts are unexecuted').toBeGreaterThan(-1)
    const end = src.indexOf('\n@Suite ', at)
    const suite = src.slice(at, end > at ? end : undefined)
    expect(suite.length, 'ClipboardWriteTests is gutted — re-anchor').toBeGreaterThan(4_000)

    // A `func` inside the suite with no @Test above it still compiles, still reads
    // like a test, and never runs. A @Test COUNT would go slack the day one is added.
    const lines = suite.split('\n')
    const orphans = lines
      .map((l, i) => ({ l, prev: lines[i - 1] ?? '' }))
      .filter(({ l }) => /^\s+func\s+\w+\(\)/.test(l))
      .filter(({ prev }) => !prev.includes('@Test'))
      .map(({ l }) => l.trim())
    expect(orphans, `these look like tests but carry no @Test, so they never run: ${orphans.join(' | ')}`)
      .toEqual([])

    // The specific properties: the destructive input, the cap boundary, and both rails.
    expect(suite, 'nothing runs the " " case — THE defect').toMatch(/for blank in \[/)
    expect(suite, 'nothing runs the cap boundary').toMatch(/Clipboard\.max \+ 1/)
    expect(suite, 'nothing runs the relay rail').toMatch(/DeviceActionAudit\.clipboardLine\(argsJson:/)
    expect(suite, 'nothing runs the voice rail').toMatch(/DeviceActionAudit\.clipboardResult\(argsJson:/)
    expect(suite, 'nothing checks that the two rails agree').toMatch(/the rails disagree about/)
  })

  it('the preview is bounded and single-line on both clients that have one', () => {
    // A toast is one line: a multi-line preview clips mid-height or shoves the UI
    // around. And truncation is MARKED, so "…" means something.
    expect(deviceTools(), 'Android lost the preview collapse/bound')
      .toMatch(/internal fun clipboardPreview\(text: String, max: Int = 48\)/)
    const prev = between(deviceTools(), 'internal fun clipboardPreview(', '\n}\n', 'clipboardPreview')
    expect(prev, 'newlines survive into the toast').toMatch(/Regex\("\\\\s\+"\), " "/)
    expect(prev, 'over-long previews are no longer marked with an ellipsis').toContain('…')
    // Web's, executed, as the reference the Kotlin mirrors.
    expect(raw('lib/chat/clipboard-write.ts')).toContain("replace(/\\s+/g, ' ')")
    // iOS's, same bound and same ellipsis. The default is part of the contract:
    // three clients quoting the same value at three lengths is a parity gap the
    // user sees.
    expect(swift(), 'iOS lost the preview collapse/bound')
      .toMatch(/static func preview\(_ text: String, max: Int = 48\)/)
    const iosPrev = between(swift(), 'static func preview(_ text: String', '\n    }\n', 'Clipboard.preview')
    expect(iosPrev, 'newlines survive into the iOS confirmation').toMatch(/isWhitespace/)
    expect(iosPrev, 'over-long iOS previews are no longer marked with an ellipsis').toContain('…')
  })
})
