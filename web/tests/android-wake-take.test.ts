// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎙️ The wake word becomes the record button on Android too.
 *
 * The Nicla Voice cannot carry audio — nRF52832 + NDP120, 64KB of RAM, BLE only,
 * no audio characteristic at all — so what crosses the link is an EVENT. Android's
 * `handleWake` did the two things that event affords: a haptic on the phone, and a
 * `nicla_wake` line on the owner's event ring. Which means the necklace heard you
 * say its name, told you it had, and then **the words you actually came to say went
 * nowhere.** Nothing under `android/` mentioned `record_on_wake`, and no caller of
 * `PhoneRecorder.record` was a wake path (manual, memo, relay envelope — grep
 * verified). iOS shipped both halves; this ports them.
 *
 * The stop rule is the second half, and it is the reason this is not simply "start
 * a 10s take": `seconds` is a FLOOR. Someone who says the wake word and then talks
 * for thirty seconds kept the first ten, and nothing in the stored row said it had
 * been cut. So a take keeps running while words keep arriving, bounded twice —
 * `SILENCE_GRACE_MS` since the last NEW WORDS (not since the last audio: the level
 * meter can't tell speech from a fan), and an absolute hard cap, because a noisy
 * room produces words forever and a take that never ends never uploads, never
 * transcribes and never gives the microphone back.
 *
 * `PhoneRecorderTest` / `NiclaVoiceGatewayTest` (Kotlin) own the pure rules — the
 * grace boundary, the cap, Stop's precedence, the opt-in gate's two answers. This
 * suite owns what a JVM test cannot see: that `handleWake` actually CALLS the
 * recorder, that it is the ONLY caller that opts into extension, that the loop is
 * driven by the rule rather than by a fixed deadline, that growth is measured by
 * LENGTH, and that the user has an off switch.
 */

const ROOT = process.cwd()
const GW = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/NiclaVoiceGateway.kt')
const REC = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
const PANELS = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const CONFIG = join(ROOT, 'android/app/src/main/java/technology/tiny/app/Config.kt')
const FLEET = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt')
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

describe('a wake word records what the necklace cannot', () => {
  it('handleWake starts a take — the wire itself, which Android did not have', () => {
    // 🔴 THE GAP in one pin. Everything below is about the take's SHAPE; this is
    // about whether the words the user spoke reach the phone at all.
    const wake = body(stripped(GW), 'private fun handleWake(value: ByteArray)')
    expect(wake, 'a wake is an event again — the words after it go nowhere')
      .toMatch(/PhoneRecorder\.record\(/)
    // Off the gateway's own scope, not inline: `handleWake` runs on the BLE
    // callback's dispatcher, and a 40-second suspend there would stall every
    // other notify (status, the next wake) behind this one take. ⚠️ A bare
    // `toMatch(/scope.launch/)` is satisfied by the `forward(wake)` launch two
    // lines up, so the take's OWN block is what gets checked.
    const launched = braced(wake, wake.lastIndexOf('scope.launch'))
    expect(launched, 'the take blocks the BLE notify path instead of launching')
      .toMatch(/PhoneRecorder\.record\(/)
    expect(wake, 'the take runs blocking on the notify dispatcher')
      .not.toMatch(/runBlocking/)
    // And it is filed under the wake that caused it, not as an unexplained
    // recording: this is the line the user reads in Transcripts later.
    expect(wake, 'the wake take lost its attribution — a mystery recording appears')
      .toMatch(/wakeTakeLabel\(wake\)/)
  })

  it('the wake take is the ONE caller that opts into extension', () => {
    // ⚠️ The default is the contract, and this is where it is enforced rather than
    // documented. `nicla_voice_record` polls the relay for only `seconds + 25`, so a
    // take that extended to two minutes would answer an agent that had already given
    // up: the transcript stored, the caller told it timed out. The relay envelope,
    // the manual button and the memo button all have somebody waiting; the wake path
    // is the only one that does not.
    const gw = stripped(GW)
    const wake = body(gw, 'private fun handleWake(value: ByteArray)')
    expect(wake, 'the wake take stopped extending — a wake take is truncated again')
      .toMatch(/extendWhileSpeaking\s*=\s*true/)

    // Counted across the whole app, not spot-checked, so a NEW opted-in caller
    // shows up here as a failure rather than as silence. Also asserted against the
    // total number of record() call sites, so removing a caller cannot make this
    // pass by shrinking the denominator.
    const callers = [GW, PANELS, FLEET, SHEET].map(stripped).join('\n')
    const sites = callers.match(/PhoneRecorder\.record\(/g)?.length ?? 0
    const optIns = callers.match(/extendWhileSpeaking\s*=\s*true/g)?.length ?? 0
    expect(sites, 'a record() call site vanished — re-check which surfaces can record').toBe(4)
    expect(optIns, 'a budgeted caller now extends past its own poll window').toBe(1)
  })

  it('the DEFAULT is off — which is what makes "passes no flag" mean anything', () => {
    // ⚠️ The survivor that taught this pin: flipping the parameter's default to
    // `true` left every other pin green. The three budgeted callers pass no flag on
    // purpose, so the default IS their behaviour — and if it flipped, all three
    // would silently start extending past the window their caller is polling for,
    // while a suite counting `extendWhileSpeaking = true` call sites saw one.
    expect(stripped(REC), 'extension became the default — every budgeted take may now run to 2min')
      .toMatch(/extendWhileSpeaking: Boolean = false,/)
  })

  it('the budgeted callers pass no extension flag at all', () => {
    // Belt to the count above: these three are the ones with a deadline on the other
    // end. Read as their own call expressions so "somewhere else in this file opts
    // in" cannot satisfy it.
    const relay = body(stripped(FLEET), 'private suspend fun handleRecordEnvelope(')
    expect(relay, 'the relay envelope now extends — nicla_voice_record would time out')
      .not.toMatch(/extendWhileSpeaking/)
    expect(relay, 're-anchor: the relay no longer records here at all')
      .toMatch(/PhoneRecorder\.record\(/)
    const memo = stripped(SHEET)
    expect(memo.match(/PhoneRecorder\.record\([^)]*\)/)?.[0], 'the memo button extends')
      .not.toMatch(/extendWhileSpeaking/)
  })

  it('the take loop is driven by the RULE, not by a fixed deadline', () => {
    // ⚠️ A JVM test can prove `shouldExtend` answers correctly and still be blind to
    // a loop that never asks it. The old loop was `while (now < until)`, which is the
    // exact shape a mutation would restore: every pure test stays green and no take
    // ever extends. The loop condition is the only place that can be checked.
    const listen = body(stripped(REC), 'private suspend fun listen(')
    expect(listen, 'the loop stopped consulting the stop rule — takes are fixed-length again')
      .toMatch(/while\s*\(\s*shouldExtend\(/)
    // The cap has to be the caller's, not a constant re-derived here: hardCapSeconds
    // is the opt-in gate, and a `listen` that computed MAX_SECONDS itself would let
    // every take extend while the gate still read correctly.
    expect(listen, 'the hard cap is no longer the one the gate decided')
      .toMatch(/val hardCap = startedAt \+ capSeconds \* 1000L/)
    const rec = stripped(REC)
    expect(rec, 'record() stopped handing the gate\'s answer to the loop')
      .toMatch(/val cap = hardCapSeconds\(secs, extendWhileSpeaking\)/)
    expect(rec, 'the cap is computed and never used').toMatch(/listen\(app, secs, cap\)/)
  })

  it('growth is measured by LENGTH, and only growth restarts the grace', () => {
    // ⚠️ Not `text != seen`. A rolled recognition session replaces the live utterance
    // with a SHORTER re-reading of the same words (a fresh recognizer starts from its
    // first hypothesis again), and counting that as new speech would hold the
    // microphone open through silence — an inequality test makes the grace unreachable
    // and turns every extended take into a run to the hard cap.
    const listen = body(stripped(REC), 'private suspend fun listen(')
    expect(listen, 'growth is judged by inequality — a shorter re-reading reads as new speech')
      .toMatch(/if \(text\.length > seenChars\)/)
    const grew = body(listen, 'if (text.length > seenChars)')
    expect(grew, 'the grace clock is not restarted by new words').toMatch(/lastGrowth = /)
    expect(grew, 'the high-water mark never advances — every tick counts as growth')
      .toMatch(/seenChars = text\.length/)
  })

  it('an extended take reports the length it really ran', () => {
    // Bounded by the CAP, not by what was asked for. Clamped to `secs`, every
    // 40-second wake take would be filed, replied and stored as 10 — the same lie
    // the truncation itself used to tell, moved one step downstream.
    const rec = stripped(REC)
    expect(rec, 'the measured length is clamped back to the request — an extended take reads short')
      .toMatch(/actualSeconds\(android\.os\.SystemClock\.elapsedRealtime\(\) - startedAt, cap\)/)
  })

  it('the take clock is MONOTONIC — a wall-clock change cannot end a take', () => {
    // The grace is a duration, and `System.currentTimeMillis()` moves under an NTP
    // correction or a manual clock change. `statusAt` (c56) uses wall time on purpose
    // — it dates a reading a person reads — but a stop rule measuring "3s since the
    // last word" against a clock that can jump backwards would extend forever, or
    // forwards would cut the speaker off mid-sentence.
    const listen = body(stripped(REC), 'private suspend fun listen(')
    expect(listen, 'the take loop reads the wall clock — a clock change now ends takes')
      .not.toMatch(/System\.currentTimeMillis/)
    expect(listen, 're-anchor: the loop no longer reads a clock at all')
      .toMatch(/android\.os\.SystemClock\.elapsedRealtime\(\)/)
  })

  it('the user has an off switch, and it is on by default', () => {
    // A phone that turns its microphone on by itself must be refusable, and the
    // refusal has to be reachable — this is iOS's `cfg_record_on_wake`, same key so
    // an account's two phones read the same way. Default ON: recording is the
    // necklace's whole job, so this is the OFF switch, not an opt-in gate.
    const cfg = stripped(CONFIG)
    expect(cfg, 'the wake-record setting is gone — the mic cannot be refused')
      .toMatch(/getBoolean\("cfg_record_on_wake", true\)/)
    expect(cfg, 'the setting cannot be written — the toggle would not stick')
      .toMatch(/putBoolean\("cfg_record_on_wake", v\)/)

    // And it is actually CONSULTED. A flag the wake path never reads is a switch
    // that silently does nothing — the worst of the three possible bugs here.
    const wake = body(stripped(GW), 'private fun handleWake(value: ByteArray)')
    expect(wake, 'the wake take ignores the setting — the switch is decoration')
      .toMatch(/config\.recordOnWake/)
    // ⚠️ Gated BEFORE the coroutine, not inside it. Gating inside still refuses the
    // take, so an ordering pin on `record()` alone is satisfied by the wrong shape —
    // and the wrong shape launches a coroutine per wake all day and, worse, invites
    // a claim-then-return that reads as a recorder that starts and files nothing.
    // So the gate must precede the LAUNCH, and the launched block must not re-ask.
    const gated = wake.indexOf('config.recordOnWake')
    const launch = wake.lastIndexOf('scope.launch')
    expect(gated, 'the gate is not found before the take').toBeGreaterThan(-1)
    expect(gated, 'the gate moved inside the coroutine — a take is launched per wake regardless')
      .toBeLessThan(launch)
    expect(braced(wake, launch), 'the setting is re-checked inside the take instead of before it')
      .not.toMatch(/recordOnWake/)
  })

  it('the panel offers the switch beside the wakes it acts on', () => {
    // Not in Settings: this is where a person is standing when they wonder what
    // saying the wake word actually does, and iOS puts it in the same panel.
    const panel = body(stripped(PANELS), 'internal fun VoiceDevicePanel(')
    expect(panel, 'the wake-record toggle is unreachable from the Voice panel')
      .toMatch(/app\.config\.recordOnWake = on/)
    expect(panel, 'the toggle does not read the stored value — it would reset every open')
      .toMatch(/mutableStateOf\(app\.config\.recordOnWake\)/)
    expect(panel, 'nothing renders the switch').toMatch(/checked = recordOnWake/)
  })

  it('the label promises a FLOOR, and reads the seconds it is promising', () => {
    // ⚠️ "record 10s on wake" would promise exactly the truncation this closes. And
    // the number is interpolated from the gateway constant rather than typed, so the
    // sentence cannot drift from what handleWake actually asks for — a label
    // promising 10s over a 5s take is a lie that comparing two literals never sees.
    const panel = body(stripped(PANELS), 'internal fun VoiceDevicePanel(')
    const label = panel.match(/"record on wake[^"]*"/)?.[0] ?? ''
    expect(label, 'the wake toggle lost its label').toContain('record on wake')
    expect(label, 'the label promises a fixed length the take does not honour')
      .toContain('at least')
    expect(label, 'the seconds are hardcoded — the label can drift from the take')
      .toContain('NiclaVoiceGateway.WAKE_TAKE_SECONDS')
  })

  it('the floor the wake asks for is a named constant, used once', () => {
    // Shared between the take and its label, so there is exactly one number to
    // change and no way to change half of it.
    const gw = stripped(GW)
    expect(gw, 'the wake floor is inline again — the panel label can now disagree with it')
      .toMatch(/internal const val WAKE_TAKE_SECONDS = 10/)
    const wake = body(gw, 'private fun handleWake(value: ByteArray)')
    expect(wake, 'the wake take asks for a literal instead of the shared floor')
      .toMatch(/WAKE_TAKE_SECONDS/)
  })

  it('the stop rule and the gate are PURE — reachable from a test with no mic', () => {
    // iOS's own harness lesson, ported with the code: with the opt-in decision
    // inline in record(), a mutation that let EVERY take extend passed all 8 of its
    // tests. The decision was unreachable from a test, so it was unprotected. Both
    // must stay top-level members of the object with no TinyApp/Context parameter,
    // or the Kotlin pins above become unwritable.
    const rec = stripped(REC)
    expect(rec, 'the opt-in gate went back inline — the untestable shape')
      .toMatch(/fun hardCapSeconds\(requested: Int, extendWhileSpeaking: Boolean\): Int/)
    expect(rec, 'the stop rule is no longer a function of its inputs')
      .toMatch(/fun shouldExtend\(\s*nowMs: Long,\s*deadlineMs: Long,\s*hardCapMs: Long,\s*lastGrowthMs: Long,\s*stopRequested: Boolean,\s*\): Boolean/)
    const rule = body(rec, 'fun shouldExtend(')
    expect(rule, 'the stop rule reads a clock instead of taking one — untestable again')
      .not.toMatch(/elapsedRealtime|currentTimeMillis/)
    // Stop is checked FIRST, so it wins inside the floor too, where the take is
    // otherwise unconditionally allowed to continue.
    expect(rule.indexOf('stopRequested'), 'Stop no longer outranks the window')
      .toBeLessThan(rule.indexOf('hardCapMs'))
  })
})
