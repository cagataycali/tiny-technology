/**
 * 🎙️ speech.ts — local voice: the daemon speaks out loud and hears a reply.
 *
 * Nothing here opens the microphone or makes a sound: the recorder and the
 * recogniser live inside a JXA program, so what's tested is everything that
 * decides WHETHER audio leaves the machine, WHEN a capture stops, and WHAT the
 * agent is told when it fails. A suite that records the developer's room or
 * talks to them is a bug in the suite.
 *
 * The measured ground truth this suite encodes (from real probes on macOS 26.4):
 *   - a quiet room floors at ≈ -65 dBFS; digital silence (no Microphone grant)
 *     floors at -160 with dither peaks near -71 — so VAD is floor+margin AND an
 *     absolute clamp, or the second case reads as speech
 *   - `say "-hello"` exits "invalid option -- h" → text must go over stdin
 *   - SFSpeech error codes: 1110 no speech in the audio, -11800 unreadable
 *     path, -11828 not decodable audio
 *   - requiresOnDeviceRecognition defaults to FALSE, i.e. the default UPLOADS
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  sayCommand, speakTimeoutMs, vadPlan, vadInit, vadDecide,
  normalizeLocale, transcribeScript, listenScript, transcribeJxaFn,
  parseSpeechPayload, speechErrorMessage, formatListenResult,
  speak, listen, transcribeFile, __setSpeechRunnerForTest,
  hasSpeechOut, hasSpeechIn, hasLocalSpeech, speechModes,
  SPEAK_TEXT_MAX, SPEAK_RATE_MIN, SPEAK_RATE_MAX,
  LISTEN_MAX_SECONDS, LISTEN_DEFAULT_SECONDS, ABS_SPEECH_FLOOR_DB, POLL_MS,
} = await import('../dist/agent/speech.js')

const {
  runDesktop, desktopSenses, desktopSenseBlock, DESKTOP_DESCRIPTION, makeDesktopTool,
  hasDesktopSenses,
} = await import('../dist/agent/desktop.js')

const { labelOnlyCapabilities } = await import('../dist/agent/device-tools.js')

const none = () => false
const noPaths = () => false
const yesPaths = () => true

// ── say: the argv trap ───────────────────────────────────────────────────────

test('spoken text goes over STDIN, never argv — `say "-hello"` is an option error', () => {
  const cmd = sayCommand('-hello there, this is a diff line')
  assert.equal(cmd.bin, 'say')
  // Measured: `say -o out "-hello there"` exits 1 with "invalid option -- h".
  // The text must therefore never appear as an argv element.
  assert.ok(!cmd.args.some((a) => a.includes('hello')), 'text must not be in argv')
  assert.deepEqual(cmd.args.slice(-2), ['-f', '-'], 'must read the message from stdin')
  assert.equal(cmd.input, '-hello there, this is a diff line')
})

test('a voice name that looks like a flag is DROPPED, not passed through', () => {
  // A voice is the one field a model fills from user text, so it is the one that
  // can turn into an option. `-r 500` as a "voice" must not become a real flag.
  const cmd = sayCommand('hi', { voice: '-r 500' })
  assert.ok(!cmd.args.includes('-v'))
  assert.ok(!cmd.args.includes('-r'))
  // A legitimate voice still works, including the ones with spaces and accents.
  assert.deepEqual(sayCommand('hi', { voice: 'Samantha' }).args.slice(0, 2), ['-v', 'Samantha'])
  assert.deepEqual(sayCommand('hi', { voice: 'Yelda (Enhanced)' }).args.slice(0, 2), ['-v', 'Yelda (Enhanced)'])
  // Shell metacharacters are rejected even though args never reach a shell —
  // depth, because the arg list is one refactor away from a template string.
  assert.ok(!sayCommand('hi', { voice: 'a; rm -rf /' }).args.includes('-v'))
  assert.ok(!sayCommand('hi', { voice: 'a$(id)' }).args.includes('-v'))
})

test('an out-of-range rate is dropped rather than fatal — the sentence still gets said', () => {
  for (const bad of [0, -100, 5000, NaN, 'fast', null]) {
    assert.ok(!sayCommand('hi', { rate: bad }).args.includes('-r'), `rate ${bad} must be dropped`)
  }
  assert.deepEqual(sayCommand('hi', { rate: 220 }).args.slice(0, 2), ['-r', '220'])
  assert.ok(sayCommand('hi', { rate: SPEAK_RATE_MIN }).args.includes('-r'))
  assert.ok(sayCommand('hi', { rate: SPEAK_RATE_MAX }).args.includes('-r'))
})

test('spoken text is capped, and the cap is on the STDIN payload', () => {
  const long = 'a'.repeat(SPEAK_TEXT_MAX + 500)
  const cmd = sayCommand(long)
  assert.equal(cmd.input.length, SPEAK_TEXT_MAX)
})

test('the speak timeout SCALES with the text — a flat 15s cuts a paragraph off mid-sentence', () => {
  // 400 chars at the default 175wpm ≈ 27s of speech. desktop.ts's flat 15s
  // runner would kill it two thirds of the way through and report a failure for
  // something the person mostly heard.
  const long = speakTimeoutMs('x'.repeat(400))
  assert.ok(long > 15_000, `400 chars must get more than 15s, got ${long}`)
  assert.ok(speakTimeoutMs('hi') >= 10_000, 'a short line still gets startup room')
  // Faster speech finishes sooner, so its budget is smaller.
  assert.ok(speakTimeoutMs('x'.repeat(400), 400) < long)
  // A wedged synthesiser is still bounded.
  assert.ok(speakTimeoutMs('x'.repeat(SPEAK_TEXT_MAX), 80) <= 180_000)
})

// ── the on-device flag: the failure that is INVISIBLE ────────────────────────

test('transcription REQUIRES on-device recognition — the default would upload the audio', () => {
  const src = transcribeJxaFn()
  assert.match(src, /requiresOnDeviceRecognition\s*=\s*true/)
  // And it refuses when no local model exists rather than falling back: the
  // fallback is a silent upload of whatever the microphone heard.
  assert.match(src, /supportsOnDeviceRecognition/)
  assert.match(src, /no-local-model/)
  assert.ok(!/requiresOnDeviceRecognition\s*=\s*false/.test(src))
})

test('both scripts carry the on-device flag — listen must not be the lenient one', () => {
  for (const [name, src] of [
    ['transcribe', transcribeScript('/tmp/a.m4a')],
    ['listen', listenScript('/tmp/a.m4a', vadPlan())],
  ]) {
    assert.match(src, /requiresOnDeviceRecognition\s*=\s*true/, `${name} must stay on-device`)
    assert.match(src, /shouldReportPartialResults\s*=\s*false/, `${name} wants only the final text`)
  }
})

test('the async recogniser is AWAITED — an unpumped runloop returns empty every time', () => {
  // osascript exits the moment the script returns, so without the runloop pump
  // recognitionTaskWithRequest's handler is never called and every transcript
  // comes back empty — indistinguishable from "nobody said anything".
  assert.match(transcribeJxaFn(), /runUntilDate/)
  assert.match(transcribeJxaFn(), /while\s*\(!out\.done/)
})

test('the recording is deleted INSIDE the same program that made it', () => {
  const src = listenScript('/tmp/tiny_x.m4a', vadPlan())
  assert.match(src, /removeItemAtPathError/)
  // Every exit goes through finish(), so a refused mic or a silent room cannot
  // leave audio of the room behind.
  const returns = src.match(/finish\(/g) || []
  assert.ok(returns.length >= 4, `every exit path must delete the file, found ${returns.length}`)
})

test('a path with a quote cannot break out of the script literal', () => {
  const src = listenScript('/tmp/a"; $.NSApp.terminate(null); //.m4a', vadPlan())
  assert.ok(src.includes(JSON.stringify('/tmp/a"; $.NSApp.terminate(null); //.m4a')))
  assert.ok(!/var FILE = "\/tmp\/a";/.test(src))
})

test('the locale is gated — a bogus identifier would nil the recogniser', () => {
  assert.equal(normalizeLocale('en-US'), 'en-US')
  assert.equal(normalizeLocale('tr_TR'), 'tr-TR')
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('zh-Hans'), 'zh-Hans')
  for (const bad of ['', undefined, null, 'nonsense locale', '"; evil()', 'en-US; rm']) {
    assert.equal(normalizeLocale(bad), 'en-US', `${bad} must fall back`)
  }
})

// ── VAD: silence is not zero ─────────────────────────────────────────────────

/** Drive the real state machine over a dB trace. */
function runVad(trace, plan = vadPlan({ pollMs: 100, calibrateMs: 300, silenceMs: 500, patienceMs: 1000, seconds: 5 })) {
  const st = vadInit()
  let last = { stop: false, reason: '' }
  for (const db of trace) {
    last = vadDecide(st, db, plan, ABS_SPEECH_FLOOR_DB)
    if (last.stop) break
  }
  return { st, ...last }
}
const rep = (v, n) => Array.from({ length: n }, () => v)

test('a QUIET ROOM at -65 dB is not speech — the floor is measured, not assumed', () => {
  // The measured noise floor of this Mac's built-in mic in a silent room. A
  // naive "is it louder than -100?" check would call all of this speech.
  const r = runVad([...rep(-65, 3), ...rep(-64, 20)])
  assert.equal(r.st.heard, false)
  assert.equal(r.reason, 'nothing')
})

test('speech ABOVE the calibrated floor is heard, and the pause ends the capture', () => {
  const r = runVad([...rep(-65, 3), ...rep(-22, 10), ...rep(-64, 6)])
  assert.equal(r.st.heard, true)
  assert.equal(r.reason, 'silence')
})

test('DIGITAL silence (no mic grant, floor -160) must NOT read as speech', () => {
  // This is the trap the absolute clamp exists for. floor+margin alone gives a
  // threshold of -148, which the dither peaks at -71 clear easily — so the
  // daemon would report "I heard you" about a microphone that was never open.
  const r = runVad([...rep(-160, 3), ...rep(-71, 20)])
  assert.equal(r.st.heard, false, 'dither above a -160 floor is not a voice')
  assert.equal(r.reason, 'nothing')
  assert.equal(r.st.threshold, ABS_SPEECH_FLOOR_DB)
})

test('the absolute clamp does not make a LOUD room deaf — floor+margin still wins there', () => {
  // The clamp is a floor on the threshold, not a replacement: in a noisy room
  // (-30 dB floor) a -45 threshold would trigger on the room itself, so the
  // calibrated value must be the one used.
  const r = runVad([...rep(-30, 3), ...rep(-31, 20)])
  assert.ok(r.st.threshold > ABS_SPEECH_FLOOR_DB, `noisy room must raise the threshold, got ${r.st.threshold}`)
  assert.equal(r.st.heard, false, 'the room itself is not speech')
})

test('one door slam during calibration must not deafen the whole call (median, not mean)', () => {
  // A mean over [-65,-65,-5] is -45, which would sit at/above real speech and
  // make the rest of the call deaf. The median is -65 and hears it.
  const plan = vadPlan({ pollMs: 100, calibrateMs: 300, silenceMs: 500, patienceMs: 1000, seconds: 5 })
  const st = vadInit()
  for (const db of [-65, -5, -65]) vadDecide(st, db, plan, ABS_SPEECH_FLOOR_DB)
  vadDecide(st, -30, plan, ABS_SPEECH_FLOOR_DB)
  assert.equal(st.floorDb, -65)
  assert.equal(st.heard, true, 'a slam in calibration must not raise the bar above real speech')
})

test('the calibration frames themselves can never count as speech', () => {
  // Someone already talking when listen starts sets a HIGH floor, which is a
  // real limitation — but it must not also be reported as a transcript, because
  // the audio of those frames is the person mid-word.
  const plan = vadPlan({ pollMs: 100, calibrateMs: 300, seconds: 5 })
  const st = vadInit()
  for (const db of [-10, -10, -10]) {
    const v = vadDecide(st, db, plan, ABS_SPEECH_FLOOR_DB)
    assert.equal(v.stop, false)
  }
  assert.equal(st.heard, false)
  assert.equal(st.threshold, null, 'the threshold is only computed after calibration')
})

test('a speaker who never pauses stops at the CAP, and the reason says so', () => {
  const plan = vadPlan({ pollMs: 100, calibrateMs: 200, silenceMs: 500, patienceMs: 2000, seconds: 1 })
  const r = runVad([-65, -65, ...rep(-20, 200)], plan)
  assert.equal(r.reason, 'timeout')
  assert.equal(r.st.heard, true)
})

test('someone ALREADY talking when listen starts raises the floor — and is not transcribed', () => {
  // The honest limitation of calibrating from the first frames: continuous
  // speech from frame 0 becomes the floor, so nothing clears the threshold and
  // the call reports "no voice" instead of a half-word transcript. Better a
  // named miss than audio of a stranger mid-sentence coming back as the answer.
  const plan = vadPlan({ pollMs: 100, calibrateMs: 200, silenceMs: 500, patienceMs: 500, seconds: 2 })
  const r = runVad(rep(-20, 200), plan)
  assert.equal(r.st.heard, false)
  assert.equal(r.reason, 'nothing')
})

test('a NaN meter reading degrades to silence rather than poisoning the floor', () => {
  const plan = vadPlan({ pollMs: 100, calibrateMs: 300, silenceMs: 500, patienceMs: 1000, seconds: 5 })
  const st = vadInit()
  // 3 calibration frames, then one more — the threshold is only computed on the
  // first POST-calibration frame, so a 3-frame drive would assert on nulls.
  for (const db of [NaN, NaN, NaN, NaN]) vadDecide(st, db, plan, ABS_SPEECH_FLOOR_DB)
  assert.equal(st.floorDb, -160)
  // And with a -160 floor the clamp applies, so noise cannot fake a voice.
  assert.equal(st.threshold, ABS_SPEECH_FLOOR_DB)
  assert.equal(st.heard, false)
})

test('the silence window ROUNDS UP — a short one cuts the speaker off between words', () => {
  // 1200ms of silence at a 500ms poll must be 3 frames, not 2: floor(2.4)=2
  // would end the capture in the pause between two words.
  assert.equal(vadPlan({ silenceMs: 1200, pollMs: 500 }).silenceFrames, 3)
  assert.equal(vadPlan({ silenceMs: 1200, pollMs: 100 }).silenceFrames, 12)
})

test('listen length is CLAMPED — a daemon told to record for an hour is a bug with a mic', () => {
  assert.equal(vadPlan({ seconds: 3600 }).maxFrames, (LISTEN_MAX_SECONDS * 1000) / POLL_MS)
  assert.equal(vadPlan({ seconds: 0 }).maxFrames, 1000 / POLL_MS)
  assert.equal(vadPlan({}).maxFrames, (LISTEN_DEFAULT_SECONDS * 1000) / POLL_MS)
  assert.equal(vadPlan({ seconds: 'lots' }).maxFrames, (LISTEN_DEFAULT_SECONDS * 1000) / POLL_MS)
  // maxFrames can never land inside calibration, or the call would end before a
  // threshold exists and always answer "no voice".
  const p = vadPlan({ seconds: 1, calibrateMs: 3000, pollMs: 1000 })
  assert.ok(p.maxFrames > p.calibrateFrames)
})

test('the VAD that runs is the VAD that is tested — its source is embedded verbatim', () => {
  // The recorder lives inside osascript, so a VAD written twice would give one
  // tested implementation that never runs and one that does. This is the
  // assertion that keeps them the same function.
  const src = listenScript('/tmp/a.m4a', vadPlan())
  assert.ok(src.includes(vadDecide.toString()), 'listenScript must embed vadDecide itself')
  assert.match(src, /vadDecide\(st, rec\.averagePowerForChannel\(0\), PLAN, ABS_FLOOR\)/)
})

test('vadDecide stays self-contained — it must survive being stringified into JXA', () => {
  const src = vadDecide.toString()
  // No module-scope helper, no import, no TS-only construct: any of those become
  // a ReferenceError inside osascript, which surfaces as a bridge failure.
  for (const forbidden of ['clampNum(', 'require(', 'import ', 'ABS_SPEECH_FLOOR_DB', 'POLL_MS']) {
    assert.ok(!src.includes(forbidden), `vadDecide must not reference ${forbidden}`)
  }
})

// ── payloads and messages ────────────────────────────────────────────────────

test('the payload reader tolerates garbage instead of throwing out of the tool call', () => {
  for (const bad of ['', 'not json', '{', 'null', '[]', undefined]) {
    const p = parseSpeechPayload(bad)
    assert.equal(p.ok, false)
    assert.equal(p.code, 'unparseable')
  }
})

test('the payload reader keeps numbers as numbers and nulls as null', () => {
  const p = parseSpeechPayload(JSON.stringify({
    ok: true, text: 'hello', reason: 'silence', seconds: 2.4, peakDb: -18.2, floorDb: null, thresholdDb: -45, heard: true,
  }))
  assert.deepEqual(p, { ok: true, text: 'hello', reason: 'silence', seconds: 2.4, peakDb: -18.2, floorDb: null, thresholdDb: -45, heard: true })
  // A missing metric stays MISSING rather than becoming 0: `Number(null)` is 0,
  // and "0 dB" is the loudest possible reading — the opposite of "unknown".
  const q = parseSpeechPayload(JSON.stringify({ ok: false, code: 'no-voice', peakDb: null }))
  assert.equal(q.peakDb, undefined)
})

test('an error code the framework returned survives as a STRING (JXA gives 1110 as text)', () => {
  const p = parseSpeechPayload(JSON.stringify({ ok: false, code: 1110, error: 'No speech detected' }))
  assert.equal(p.code, '1110')
  assert.match(speechErrorMessage(p), /no speech in that audio/i)
})

test('each failure gets a message that says what to DO — they need different reactions', () => {
  const msg = (code, extra = {}) => speechErrorMessage({ ok: false, code, ...extra })
  // Never try again on this Mac, and say why we refused rather than uploading.
  assert.match(msg('no-local-model'), /will not upload/i)
  assert.match(msg('no-local-model'), /Dictation/)
  // A grant the user must give; a retry cannot fix it.
  assert.match(msg('mic-refused'), /Privacy & Security/)
  // Measured codes, each distinct from "speech failed".
  assert.match(msg('1110'), /no speech/i)
  assert.match(msg('-11828'), /not decodable/i)
  assert.match(msg('-11800'), /could not read that audio file/i)
  assert.match(msg('1101'), /not installed/i)
  // An unknown code still carries the raw detail rather than swallowing it.
  assert.match(msg('99', { error: 'kaboom' }), /99/)
  assert.match(msg('99', { error: 'kaboom' }), /kaboom/)
})

test('"no voice" distinguishes a quiet room from a microphone that was never open', () => {
  const room = speechErrorMessage({ ok: false, code: 'no-voice', seconds: 4, peakDb: -38, floorDb: -65 })
  assert.match(room, /heard no voice/)
  assert.ok(!/Microphone grant/.test(room), 'a real mic reading must not blame permissions')

  const dead = speechErrorMessage({ ok: false, code: 'no-voice', seconds: 4, peakDb: -71, floorDb: -160 })
  assert.match(dead, /noise floor/)
  assert.match(dead, /Microphone grant/)
})

test('a successful listen reports how long it heard and WHY it stopped', () => {
  assert.match(formatListenResult({ ok: true, text: 'turn the lights off', seconds: 2.6, reason: 'silence' }),
    /stopped when you paused/)
  // "It cut me off" and "it waited forever" are the two complaints a voice
  // channel gets, and only these words distinguish them.
  assert.match(formatListenResult({ ok: true, text: 'and then I said', seconds: 30, reason: 'timeout' }), /30s limit/)
  // Voice detected but an empty transcript is its own answer, not a lie.
  assert.match(formatListenResult({ ok: true, text: '   ', seconds: 3, reason: 'silence' }), /transcription was empty/)
})

// ── the runner seam: nothing here speaks or records ───────────────────────────

function withRunner(fn) {
  const calls = []
  __setSpeechRunnerForTest((bin, args, opts) => {
    calls.push({ bin, args, opts })
    return typeof fn === 'function' ? fn(bin, args, opts) : (fn ?? '')
  })
  return calls
}
after(() => __setSpeechRunnerForTest(null))

test('speak reports truncation, so the model can notify instead of monologuing', () => {
  withRunner('')
  const r = speak('x'.repeat(SPEAK_TEXT_MAX + 10))
  assert.equal(r.truncated, true)
  assert.equal(r.spoken.length, SPEAK_TEXT_MAX)
  assert.equal(speak('short').truncated, false)
})

test('listen never leaves a recording path in the result — the audio is not an artifact', () => {
  const calls = withRunner(JSON.stringify({ ok: true, text: 'hi', reason: 'silence', seconds: 1.2 }))
  const p = listen({ seconds: 3 })
  assert.equal(p.ok, true)
  assert.equal(p.text, 'hi')
  assert.ok(!('path' in p) && !('file' in p), 'no way to ask for the audio back')
  // The temp path is per-process AND per-call, so two concurrent listens (a
  // relay reply and a tray click) cannot record over each other — the second
  // one's own cleanup would otherwise delete the first's audio mid-transcribe.
  const filePath = (c) => /var FILE = "([^"]+)"/.exec(c.args.at(-1))?.[1]
  assert.ok(filePath(calls[0]), 'the script must name a recording path')
  listen({ seconds: 3 })
  assert.notEqual(filePath(calls[0]), filePath(calls[1]))
})

test("listen's process budget covers the whole capture — a flat timeout kills a long one", () => {
  const calls = withRunner(JSON.stringify({ ok: true, text: 'hi' }))
  listen({ seconds: LISTEN_MAX_SECONDS })
  assert.ok(calls[0].opts.timeoutMs > LISTEN_MAX_SECONDS * 1000,
    `budget ${calls[0].opts.timeoutMs} must exceed the ${LISTEN_MAX_SECONDS}s capture`)
})

test('a bridge crash becomes a named failure, not a thrown turn', () => {
  withRunner(() => { const e = new Error('osascript died'); e.stderr = 'execution error'; throw e })
  const p = listen({ seconds: 2 })
  assert.equal(p.ok, false)
  assert.equal(p.code, 'bridge')
  assert.match(speechErrorMessage(p), /speech failed/)
})

test('transcribe checks the path BEFORE spawning a bridge for a file that is not there', () => {
  const calls = withRunner('{}')
  const p = transcribeFile('/tmp/definitely-not-here-9f3a.m4a')
  assert.equal(p.ok, false)
  assert.equal(calls.length, 0, 'no spawn for a missing file')
  assert.match(speechErrorMessage(p), /could not read that audio file/)
})

// ── capability gates ─────────────────────────────────────────────────────────

test('voice is macOS-only, and each half is probed separately', () => {
  assert.equal(hasSpeechOut('darwin', yesPaths), true)
  assert.equal(hasSpeechOut('linux', yesPaths), false)
  assert.equal(hasSpeechIn('win32', yesPaths), false)
  assert.equal(hasSpeechOut('darwin', noPaths), false)
  assert.equal(hasLocalSpeech('darwin', (p) => p.endsWith('osascript')), true)
  assert.equal(hasLocalSpeech('linux', yesPaths), false)
  assert.deepEqual(speechModes('darwin', yesPaths), ['speak', 'listen'])
  assert.deepEqual(speechModes('linux', yesPaths), [])
  assert.deepEqual(speechModes('darwin', (p) => p.endsWith('say')), ['speak'])
})

test('this machine really can do both (the probe that proves the suite is not vacuous)', () => {
  // Every other test here runs the platform matrix through injected probes. If
  // the real gates were broken, all of them would still pass — so one assertion
  // has to ask the actual machine. Skipped off macOS rather than asserted false.
  if (process.platform !== 'darwin') return
  assert.equal(hasSpeechOut(), true)
  assert.equal(hasSpeechIn(), true)
})

// ── use_desktop wiring ───────────────────────────────────────────────────────

test('use_desktop teaches speak/listen/transcribe and accepts their args', () => {
  for (const a of ['speak', 'listen', 'transcribe']) {
    assert.ok(DESKTOP_DESCRIPTION.includes(a), `description must teach ${a}`)
  }
  // The description must say the recording is deleted: a user reading what the
  // daemon can do needs that answer before they let it listen.
  assert.match(DESKTOP_DESCRIPTION, /deleted/)
  const schema = makeDesktopTool()._inputSchema
  const parsed = schema.parse({ action: 'listen', seconds: 5, locale: 'tr-TR' })
  assert.equal(parsed.seconds, 5)
  assert.equal(schema.parse({ action: 'speak', text: 'hi', voice: 'Samantha', rate: 200 }).rate, 200)
  assert.throws(() => schema.parse({ action: 'shout', text: 'hi' }))
})

test('speak with no text is a named mistake, not a silent no-op', async () => {
  withRunner('')
  assert.match(await runDesktop({ action: 'speak' }), /need text/)
  assert.match(await runDesktop({ action: 'transcribe' }), /need target/)
})

test('speak reads either text or body — a model that fills the notify field still gets heard', async () => {
  if (process.platform !== 'darwin') return
  withRunner('')
  assert.match(await runDesktop({ action: 'speak', body: 'build is green' }), /said aloud/)
})

test('the sense list and prompt block carry voice — the agent must not promise a mouth it lacks', () => {
  const mac = desktopSenses('darwin', {}, none, yesPaths)
  // `see` rides along on every machine where use_desktop registered at all
  // (showing a file needs no binary — see.ts measureHeader), and `convert` rides
  // on sips, which yesPaths posits along with every other in-box binary.
  assert.deepEqual(mac, ['notify', 'copy', 'paste', 'open', 'speak', 'listen', 'see', 'convert'])
  const block = desktopSenseBlock(mac)
  assert.match(block, /speak out loud AND hear a spoken reply/)

  // Linux: no voice at all. The block must forbid offering it, because "I'll
  // read it out to you" is exactly the promise this line exists to stop.
  const linux = desktopSenseBlock(desktopSenses('linux', {}, (b) => b === 'xclip', yesPaths))
  assert.match(linux, /no voice and no microphone/)
  assert.ok(!/hear a spoken reply/.test(linux))

  // The asymmetric case is real (a Mac with Dictation's local model absent):
  // a mouth with no ears must not ask questions aloud.
  const speakOnly = desktopSenseBlock(['notify', 'speak'])
  assert.match(speakOnly, /cannot hear a reply/)
  const listenOnly = desktopSenseBlock(['listen'])
  assert.match(listenOnly, /no voice/)
})

test('a machine whose ONLY channel is the speakers still registers use_desktop', () => {
  // Hypothetical on macOS, but the principle is the gate: if voice is the only
  // way to reach the person, the tool that owns the speakers must exist.
  assert.equal(hasDesktopSenses('linux', {}, none, yesPaths), false)
  assert.equal(hasDesktopSenses('darwin', {}, none, noPaths), true, 'osascript notify still resolves')
})

test('device-tools labels voice separately from desktop, like ocr next to computer', () => {
  // ⚠️ Was a grep of device-tools.ts' source, which was the only lever while the
  //    decision was inlined in makeDeviceTools(). It is a pure function now, so
  //    this asserts the RULE: voice needs a local synthesiser or speech model AND
  //    the tool its actions live on. device-tools.test.mjs owns the full matrix.
  const f = (over) => ({
    computer: false, desktop: false, windowControl: false, visionOcr: false, localSpeech: false, ...over,
  })
  assert.ok(labelOnlyCapabilities(f({ desktop: true, localSpeech: true })).includes('voice'))
  // Separate from `desktop`: a clipboard is not a mouth.
  assert.ok(!labelOnlyCapabilities(f({ desktop: true })).includes('voice'))
  // And a synthesiser with no use_desktop is a promise nothing can keep.
  assert.ok(!labelOnlyCapabilities(f({ localSpeech: true, computer: true })).includes('voice'))
})
