/**
 * Local speech — the daemon can SPEAK out loud and LISTEN to the room, with
 * nothing leaving the machine.
 *
 * The port note in docs/e2e-gaps-report-2026-07-25.md §3.2 said this needed
 * "whisper.cpp bindings + `say` spawn". Measured on this Mac, the bindings half
 * is wrong the same way c54's "30-line Swift Vision helper CLI" was: Apple's
 * Speech framework binds through the SAME JXA bridge computer.ts (CGEvent) and
 * vision.ts (VNRecognizeTextRequest) already use, and it transcribes on the
 * device. Probe, end to end, no dependencies added:
 *
 *   say -o /tmp/p.aiff "the daemon can hear you now testing one two three"
 *   → SFSpeechURLRecognitionRequest, requiresOnDeviceRecognition = true
 *   → "The demon can hear you now testing 123"
 *
 * So `npx tiny-tech` stays install-free: no whisper model to download, no
 * native module to compile per Node ABI, no helper binary to sign.
 *
 * WHY IT EARNS ITS PLACE NEXT TO notify: use_desktop exists for the channels
 * that don't go through the screen (docblock in desktop.ts). Both of the ones it
 * had are WRITE-only and silent — a notification is a card the person has to be
 * looking at a screen to read. Voice is the pair that works when they aren't:
 * the daemon can say a finished build out loud across the room, and it can be
 * ANSWERED. `listen` is the first input channel this daemon has that isn't a
 * screenshot or a network message.
 *
 * THREE THINGS MEASURED RATHER THAN ASSUMED — each one is why a function here
 * is pure and tested:
 *
 *  1. ON-DEVICE IS A FLAG, AND THE DEFAULT IS THE CLOUD.
 *     `requiresOnDeviceRecognition = false` (the default) ships the audio to
 *     Apple for transcription. That failure is INVISIBLE — it returns better
 *     text, faster. So the flag is asserted by a test on the generated script,
 *     and a Mac whose locale has no local model gets a REFUSAL, never a silent
 *     upload of the room's audio.
 *  2. SILENCE IS NOT ZERO. A quiet room on this Mac meters at about -65 dBFS,
 *     not -160: real capture always carries a noise floor. So voice activity is
 *     `floor + margin`, calibrated per call from the first frames — a fixed
 *     threshold is either deaf in a loud room or triggered by the fan in a quiet
 *     one. It is ALSO clamped by an absolute floor, because the inverse trap is
 *     worse: digital silence (a process with no Microphone grant) has a floor of
 *     -160, so `floor + margin` alone would classify the dither as speech and
 *     report "heard you" about a mic that was never open.
 *  3. `say` PARSES ITS MESSAGE ARGUMENT. `say "-hello there"` exits with
 *     "invalid option -- h" — a model reading a diff aloud would crash the tool
 *     on the first line starting with a dash. Text goes over stdin (`-f -`),
 *     never argv, which also sidesteps ARG_MAX on a long passage.
 *
 * PRIVACY: the recording is a temp file that exists for the length of one call
 * and is deleted in the same JXA program that made it, before the result comes
 * back — deliberately with no option to keep it. A background daemon that leaves
 * captures of the room on disk is a liability, not a feature.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const isMac = os.platform() === 'darwin'

/**
 * Does this path exist? Injectable so the platform matrix is testable without
 * a Mac — and a path check rather than `command -v`, because both binaries here
 * ship in-box on every macOS (`/usr/bin/say`, `/usr/bin/osascript`) and gating a
 * guaranteed tool on a shell probe is how a working sense reports itself missing
 * (the same reasoning desktop.ts's win32 paste branch spells out).
 */
export type PathProbe = (p: string) => boolean

const realProbe: PathProbe = (p) => {
  try { return fs.existsSync(p) } catch { return false }
}

// ── clamps, all with a reason ───────────────────────────────────────────────

/**
 * Cap on spoken text. `say` speaks about 3 words a second, so 1200 chars is
 * roughly 70 seconds of talking — past that the daemon is monologuing at
 * someone who cannot skim, skip, or scroll back. Truncation is REPORTED, so the
 * model can choose to notify instead of speaking a wall of text.
 */
export const SPEAK_TEXT_MAX = 1200

/** `say -r` words-per-minute range. 175 is the system default; below 80 and
 * above 500 the synthesiser is either unbearable or unintelligible. */
export const SPEAK_RATE_MIN = 80
export const SPEAK_RATE_MAX = 500

/** Longest a single `listen` may hold the mic. A daemon that can be told to
 * record for an hour is a bug with a microphone attached. */
export const LISTEN_MAX_SECONDS = 30
export const LISTEN_DEFAULT_SECONDS = 12

/**
 * Absolute ceiling on the voice-activity threshold, in dBFS.
 *
 * Measured: a quiet room on this Mac's built-in mic floors at ≈ -65 dBFS, and
 * digital silence (no Microphone grant, or no input device) floors near -160
 * with dither peaks around -71. Speech at a laptop mic lands between -35 and
 * -10. -45 sits in the empty band between "room" and "someone talking", so it
 * is the value that makes an ungranted mic read as silent instead of as speech.
 */
export const ABS_SPEECH_FLOOR_DB = -45

/** Meter poll interval. 100ms is 10 decisions a second — fine enough to catch
 * the gap between sentences, coarse enough that the runloop isn't the load. */
export const POLL_MS = 100

// ── say (speak) ─────────────────────────────────────────────────────────────

/** A resolved command plus what to feed its stdin. Same shape as desktop.ts's
 * Cmd, extended with `input` because text must NOT travel in argv. */
export interface SpeechCmd { bin: string; args: string[]; input: string }

export interface SpeakOpts { voice?: string; rate?: number; outPath?: string }

/**
 * Build the `say` invocation.
 *
 * Pure because two of its rules are invisible when broken: text in argv works
 * for every string that doesn't start with a dash (measured trap #3), and a
 * voice name is attacker-adjacent input that must not be able to become a flag.
 * Both produce a tool that works in testing and fails on real content.
 */
export function sayCommand(text: string, opts: SpeakOpts = {}): SpeechCmd {
  const body = String(text ?? '')
  const args: string[] = []
  // A voice or rate that can't be honoured is DROPPED, not fatal: the point of
  // the call is that the sentence gets said. `-` guard, because a voice name is
  // the one field a model fills from user text.
  const voice = String(opts.voice ?? '').trim()
  if (voice && !voice.startsWith('-') && /^[\p{L}\p{N} ()'’./-]+$/u.test(voice)) {
    args.push('-v', voice)
  }
  const rate = Number(opts.rate)
  if (Number.isFinite(rate) && rate >= SPEAK_RATE_MIN && rate <= SPEAK_RATE_MAX) {
    args.push('-r', String(Math.round(rate)))
  }
  const out = String(opts.outPath ?? '').trim()
  if (out) args.push('-o', out)
  // `-f -` = read the message from stdin. This is the whole reason the return
  // type carries `input`: the message must never be an argv element.
  args.push('-f', '-')
  return { bin: 'say', args, input: body.slice(0, SPEAK_TEXT_MAX) }
}

/**
 * How long to allow `say` before killing it.
 *
 * The desktop runner's flat 15s is wrong for speech: at ~14 characters a second
 * a 400-char paragraph takes 29s, so a fixed timeout kills the process
 * mid-sentence and the tool reports a failure for something the person HEARD
 * most of. Scaled, with a floor for startup and a ceiling that still bounds a
 * wedged synthesiser.
 */
export function speakTimeoutMs(text: string, rate?: number): number {
  const chars = String(text ?? '').slice(0, SPEAK_TEXT_MAX).length
  const wpm = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 175
  // ~5 chars a word → chars/5 words → seconds = words / (wpm/60)
  const speakSec = (chars / 5) / (wpm / 60)
  return Math.min(180_000, Math.max(10_000, Math.round(speakSec * 1000 * 1.5) + 8_000))
}

// ── voice activity detection ────────────────────────────────────────────────

export interface VadPlan {
  /** Frames spent measuring the room before any frame can count as speech. */
  calibrateFrames: number
  /** Consecutive below-threshold frames that end a capture, once speech began. */
  silenceFrames: number
  /** Frames to wait for speech to START before giving up on an empty room. */
  patienceFrames: number
  /** Hard stop. */
  maxFrames: number
  /** dB above the measured floor that counts as voice. */
  marginDb: number
  /** Seconds per frame — carried so the script and the message agree on time. */
  pollSec: number
}

export interface VadOpts {
  seconds?: number
  silenceMs?: number
  patienceMs?: number
  calibrateMs?: number
  marginDb?: number
  pollMs?: number
}

/**
 * Milliseconds → frame counts, in ONE place.
 *
 * Separate from the state machine because every one of these numbers is a
 * division that rounds, and a `Math.floor` on the silence window is the
 * difference between "stops when you stop talking" and "stops between two
 * words". Also clamps `seconds` — see LISTEN_MAX_SECONDS.
 */
export function vadPlan(opts: VadOpts = {}): VadPlan {
  const pollMs = clampNum(opts.pollMs, POLL_MS, 20, 1000)
  const seconds = clampNum(opts.seconds, LISTEN_DEFAULT_SECONDS, 1, LISTEN_MAX_SECONDS)
  const calibrateMs = clampNum(opts.calibrateMs, 400, pollMs, 3000)
  const silenceMs = clampNum(opts.silenceMs, 1200, 200, 10_000)
  const patienceMs = clampNum(opts.patienceMs, 4000, 500, 30_000)
  const calibrateFrames = Math.max(1, Math.round(calibrateMs / pollMs))
  const maxFrames = Math.max(calibrateFrames + 1, Math.round((seconds * 1000) / pollMs))
  return {
    calibrateFrames,
    // Ceil, not floor: a silence window that comes out SHORT cuts the person off
    // in the pause between two words, which reads as a broken microphone.
    silenceFrames: Math.max(1, Math.ceil(silenceMs / pollMs)),
    patienceFrames: Math.max(1, Math.round(patienceMs / pollMs)),
    maxFrames,
    marginDb: clampNum(opts.marginDb, 12, 3, 40),
    pollSec: pollMs / 1000,
  }
}

function clampNum(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export interface VadState {
  frames: number
  floorSamples: number[]
  floorDb: number | null
  threshold: number | null
  heard: boolean
  quiet: number
  peakDb: number
}

export function vadInit(): VadState {
  return { frames: 0, floorSamples: [], floorDb: null, threshold: null, heard: false, quiet: 0, peakDb: -160 }
}

/**
 * One metering frame → keep listening, or stop and why.
 *
 * ⚠️ THIS FUNCTION'S SOURCE IS EMBEDDED INTO THE JXA PROGRAM (see listenScript).
 * That is deliberate and it is the point: the recorder lives inside osascript,
 * so a VAD written here and re-written there would give a tested implementation
 * that never runs and an untested one that does. It must therefore stay
 * self-contained — no imports, no module-scope helpers, no TS-only runtime
 * behaviour — and it must keep working when `.toString()`d.
 *
 * Mutates `st` (a fold step) because that is what survives the round trip
 * through a string most simply.
 */
export function vadDecide(
  st: VadState,
  db: number,
  plan: VadPlan,
  absFloorDb: number,
): { stop: boolean; reason: '' | 'silence' | 'timeout' | 'nothing' } {
  st.frames++
  const level = Number.isFinite(db) ? db : -160
  if (level > st.peakDb) st.peakDb = level
  if (st.frames <= plan.calibrateFrames) {
    st.floorSamples.push(level)
    return { stop: false, reason: '' }
  }
  if (st.threshold === null) {
    const sorted = st.floorSamples.slice().sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    // Median, not mean: one door slam during calibration would drag a mean up
    // by 20 dB and leave the whole call deaf.
    const floor = sorted.length === 0 ? -160
      : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    st.floorDb = floor
    // The clamp is measured trap #2: without it, digital silence (floor -160)
    // yields a -148 threshold that its own dither clears, and the daemon claims
    // it heard someone in a room where the mic was never open.
    st.threshold = Math.max(floor + plan.marginDb, absFloorDb)
  }
  if (level >= st.threshold) {
    st.heard = true
    st.quiet = 0
  } else if (st.heard) {
    st.quiet++
  }
  if (st.heard && st.quiet >= plan.silenceFrames) return { stop: true, reason: 'silence' }
  if (!st.heard && st.frames >= plan.calibrateFrames + plan.patienceFrames) {
    return { stop: true, reason: 'nothing' }
  }
  if (st.frames >= plan.maxFrames) return { stop: true, reason: 'timeout' }
  return { stop: false, reason: '' }
}

// ── the JXA programs ────────────────────────────────────────────────────────

/**
 * Locale gate. The identifier goes into a JXA string literal, so it is escaped
 * anyway — this exists because an unsupported identifier makes
 * `initWithLocale:` return nil and the failure surfaces as "no recognizer",
 * which reads like a broken framework rather than a typo'd argument.
 */
export function normalizeLocale(locale?: string): string {
  const l = String(locale ?? '').trim().replace('_', '-')
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l) ? l : 'en-US'
}

/**
 * The transcription half, shared by `transcribe` (a file the user already has)
 * and `listen` (the file we just recorded) so there is one on-device flag to get
 * right rather than two.
 *
 * The runloop pump is not optional: `recognitionTaskWithRequest:resultHandler:`
 * is asynchronous, and osascript exits the moment the script returns — without
 * a pumped runloop the program ends before the handler is ever called and every
 * transcription comes back empty, which looks exactly like "nothing was said".
 */
export function transcribeJxaFn(): string {
  return `
function tinyTranscribe(p, localeId, timeoutSec) {
  var rec = $.SFSpeechRecognizer.alloc.initWithLocale($.NSLocale.localeWithLocaleIdentifier(localeId));
  if (!rec || rec.isNil()) return { ok: false, code: 'no-recognizer' };
  if (!rec.isAvailable) return { ok: false, code: 'unavailable' };
  // REFUSE rather than fall back. The default for this flag is false, which
  // uploads the audio to Apple — a "graceful degradation" here would silently
  // send the room to a server. See measured trap #1.
  if (!rec.supportsOnDeviceRecognition) return { ok: false, code: 'no-local-model' };
  var req = $.SFSpeechURLRecognitionRequest.alloc.initWithURL($.NSURL.fileURLWithPath(p));
  req.requiresOnDeviceRecognition = true;
  req.shouldReportPartialResults = false;
  var out = { done: false };
  rec.recognitionTaskWithRequestResultHandler(req, function (result, err) {
    if (err && !err.isNil()) { out.done = true; out.code = String(err.code); out.error = ObjC.unwrap(err.localizedDescription); return; }
    if (result && !result.isNil() && result.isFinal) {
      out.done = true;
      out.text = ObjC.unwrap(result.bestTranscription.formattedString);
    }
  });
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(timeoutSec);
  while (!out.done && $.NSDate.date.timeIntervalSinceDate(deadline) < 0) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
  if (!out.done) return { ok: false, code: 'timeout' };
  if (out.error) return { ok: false, code: out.code, error: out.error };
  return { ok: true, text: out.text || '' };
}
`
}

export function transcribeScript(filePath: string, locale?: string, timeoutSec = 60): string {
  return `ObjC.import('Speech'); ObjC.import('Foundation');
${transcribeJxaFn()}
JSON.stringify(tinyTranscribe(${JSON.stringify(filePath)}, ${JSON.stringify(normalizeLocale(locale))}, ${Number(timeoutSec) || 60}))
`
}

/**
 * Record with VAD, transcribe, delete — one program, so the audio never
 * outlives the call and there is no second spawn to leak a file if it dies.
 *
 * AAC/16kHz/mono: 16kHz is what the recogniser wants (speech is band-limited
 * anyway) and mono AAC keeps a 30s worst case near 60KB in a temp file that
 * gets removed regardless. `1633772320` is kAudioFormatMPEG4AAC ('aac ') —
 * measured working, and SFSpeechURLRecognitionRequest reads the result directly,
 * so there is no afconvert step.
 */
export function listenScript(filePath: string, plan: VadPlan, locale?: string, transcribeTimeoutSec = 60): string {
  return `ObjC.import('AVFoundation'); ObjC.import('Speech'); ObjC.import('Foundation');
${transcribeJxaFn()}
${vadDecide.toString()}
var PLAN = ${JSON.stringify(plan)};
var ABS_FLOOR = ${ABS_SPEECH_FLOOR_DB};
var FILE = ${JSON.stringify(filePath)};
var settings = $.NSMutableDictionary.alloc.init;
settings.setObjectForKey($.NSNumber.numberWithInt(1633772320), 'AVFormatIDKey');
settings.setObjectForKey($.NSNumber.numberWithDouble(16000), 'AVSampleRateKey');
settings.setObjectForKey($.NSNumber.numberWithInt(1), 'AVNumberOfChannelsKey');
var err = Ref();
var rec = $.AVAudioRecorder.alloc.initWithURLSettingsError($.NSURL.fileURLWithPath(FILE), settings, err);
function finish(o) {
  try { $.NSFileManager.defaultManager.removeItemAtPathError(FILE, $()); } catch (e) {}
  return JSON.stringify(o);
}
if (!rec || rec.isNil()) { finish({ ok: false, code: 'no-recorder' }) } else {
rec.meteringEnabled = true;
var started = rec.record;
if (!started) { finish({ ok: false, code: 'mic-refused' }) } else {
var st = { frames: 0, floorSamples: [], floorDb: null, threshold: null, heard: false, quiet: 0, peakDb: -160 };
var verdict = { stop: false, reason: '' };
while (!verdict.stop) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(PLAN.pollSec));
  rec.updateMeters;
  verdict = vadDecide(st, rec.averagePowerForChannel(0), PLAN, ABS_FLOOR);
}
rec.stop;
var meta = {
  reason: verdict.reason,
  frames: st.frames,
  seconds: Math.round(st.frames * PLAN.pollSec * 10) / 10,
  peakDb: Math.round(st.peakDb * 10) / 10,
  floorDb: st.floorDb === null ? null : Math.round(st.floorDb * 10) / 10,
  thresholdDb: st.threshold === null ? null : Math.round(st.threshold * 10) / 10,
  heard: st.heard
};
if (!st.heard) { finish(Object.assign({ ok: false, code: 'no-voice' }, meta)) } else {
  var t = tinyTranscribe(FILE, ${JSON.stringify(normalizeLocale(locale))}, ${Number(transcribeTimeoutSec) || 60});
  finish(Object.assign({}, meta, t));
}
}
}
`
}

// ── payload reading + messages ──────────────────────────────────────────────

export interface SpeechPayload {
  ok: boolean
  text?: string
  code?: string
  error?: string
  reason?: string
  seconds?: number
  peakDb?: number
  floorDb?: number | null
  thresholdDb?: number | null
  heard?: boolean
}

/** Tolerant reader — a JXA program that dies mid-write must degrade to a named
 * failure, not a thrown tool call that aborts the agent's whole turn. */
export function parseSpeechPayload(raw: string): SpeechPayload {
  let p: any
  try { p = JSON.parse(String(raw ?? '').trim()) } catch { return { ok: false, code: 'unparseable' } }
  // Array.isArray as well as the typeof: `typeof [] === 'object'`, so a bare
  // `[]` (what a JXA program that returned the wrong expression prints) would
  // otherwise pass the gate and come back as a well-formed ok:false with no
  // code — an unexplained failure instead of a named one.
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, code: 'unparseable' }
  const out: SpeechPayload = { ok: !!p.ok }
  if (typeof p.text === 'string') out.text = p.text
  if (p.code != null) out.code = String(p.code)
  if (typeof p.error === 'string') out.error = p.error
  if (typeof p.reason === 'string') out.reason = p.reason
  // `typeof === 'number'`, NOT Number(): `Number(null)` is 0 and 0 dBFS is the
  // LOUDEST possible reading, so a coercing check turns a missing metric into
  // "the room was at full scale" — and speechErrorMessage reads peakDb to decide
  // whether to blame the Microphone grant. A missing number must stay missing.
  for (const k of ['seconds', 'peakDb'] as const) {
    if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k]
  }
  for (const k of ['floorDb', 'thresholdDb'] as const) {
    if (p[k] === null) { out[k] = null; continue }
    if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k]
  }
  if (typeof p.heard === 'boolean') out.heard = p.heard
  return out
}

/**
 * Failure code → a sentence that tells the agent what to DO.
 *
 * Every one of these is reachable and they need different reactions, which is
 * why they aren't collapsed into "speech failed": 'no-local-model' means never
 * try again on this Mac, 'no-voice' means try again (or ask louder), 1110 means
 * the FILE has no speech in it, and 'mic-refused' is a grant the user has to
 * give in System Settings — a retry can't fix it.
 *
 * Codes below are as measured on macOS 26.4:
 *   1110    kAFAssistantErrorDomain — "No speech detected"
 *   1101    local speech assets missing / dictation disabled
 *   -11800  AVFoundation, unknown — in practice a path that isn't there
 *   -11828  "Cannot Open" — a real file that isn't decodable audio
 */
export function speechErrorMessage(p: SpeechPayload): string {
  const code = String(p.code ?? '')
  switch (code) {
    case 'no-recognizer':
      return '🎙️ no speech recogniser for that language on this Mac — try locale "en-US"'
    case 'unavailable':
      return '🎙️ the speech recogniser is temporarily unavailable on this Mac'
    case 'no-local-model':
      return '🎙️ this Mac has no ON-DEVICE speech model for that language, and I will not upload audio to transcribe it — enable the language in System Settings → Keyboard → Dictation, or pass a locale that is installed'
    case 'no-recorder':
      return '🎙️ could not open an audio recorder on this machine'
    case 'mic-refused':
      return '🎙️ the microphone refused to start — grant Microphone access to the process running tiny (System Settings → Privacy & Security → Microphone)'
    case 'no-voice': {
      const quiet = p.peakDb !== undefined && p.peakDb < ABS_SPEECH_FLOOR_DB
      return `🎙️ listened ${p.seconds ?? '?'}s and heard no voice (peak ${p.peakDb ?? '?'} dB, floor ${p.floorDb ?? '?'} dB)${quiet ? ' — that is at the noise floor, so either nobody spoke or this process has no Microphone grant' : ''}`
    }
    case 'timeout':
      return '🎙️ the transcriber did not finish in time'
    case '1110':
      return '🎙️ no speech in that audio'
    case '1101':
      return '🎙️ the on-device speech model is not installed — enable Dictation in System Settings → Keyboard'
    case '-11800':
    case '-11829':
      return '🎙️ could not read that audio file (is the path right?)'
    case '-11828':
      return '🎙️ that file is not decodable audio'
    case 'unparseable':
      return '🎙️ the speech bridge returned nothing readable'
    default:
      return `🎙️ speech failed${code ? ` (${code})` : ''}${p.error ? `: ${p.error}` : ''}`
  }
}

/** Success line for a transcription. Says how long it listened and why it
 * stopped, because "it cut me off" and "it waited for me" are the two
 * complaints a voice channel gets and only the numbers distinguish them. */
export function formatListenResult(p: SpeechPayload): string {
  const text = (p.text ?? '').trim()
  const why = p.reason === 'timeout' ? `hit the ${p.seconds ?? '?'}s limit`
    : p.reason === 'silence' ? 'stopped when you paused'
    : p.reason === 'nothing' ? 'heard nothing'
    : 'done'
  if (!text) return `🎙️ heard voice for ${p.seconds ?? '?'}s but the transcription was empty (${why})`
  return `🎙️ heard (${p.seconds ?? '?'}s, ${why}):\n${text}`
}

// ── exec seam ───────────────────────────────────────────────────────────────

export type SpeechRunner = (bin: string, args: string[], opts: { input?: string; timeoutMs: number }) => string

const realRun: SpeechRunner = (bin, args, opts) =>
  execFileSync(bin, args, {
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    ...(opts.input == null ? {} : { input: opts.input }),
  }).toString()

let run: SpeechRunner = realRun

/** Test seam: swap the process runner so tests never open the microphone or
 * speak out loud on a developer's machine. */
export function __setSpeechRunnerForTest(fn: SpeechRunner | null): void {
  run = fn || realRun
}

// ── the three operations ────────────────────────────────────────────────────

export interface SpeakResult { spoken: string; truncated: boolean; outPath?: string }

/** Speak text aloud (or render it to a file when `outPath` is given). */
export function speak(text: string, opts: SpeakOpts = {}): SpeakResult {
  const body = String(text ?? '')
  const cmd = sayCommand(body, opts)
  run(cmd.bin, cmd.args, { input: cmd.input, timeoutMs: speakTimeoutMs(cmd.input, opts.rate) })
  return {
    spoken: cmd.input,
    truncated: body.length > cmd.input.length,
    ...(opts.outPath ? { outPath: opts.outPath } : {}),
  }
}

function osaJson(script: string, timeoutMs: number): SpeechPayload {
  let out: string
  try {
    out = run('osascript', ['-l', 'JavaScript', '-e', script], { timeoutMs })
  } catch (e: any) {
    return { ok: false, code: 'bridge', error: String(e?.stderr || e?.message || e).slice(0, 300) }
  }
  return parseSpeechPayload(out)
}

/** Transcribe an audio file that already exists, on-device. */
export function transcribeFile(filePath: string, opts: { locale?: string } = {}): SpeechPayload {
  if (!fs.existsSync(filePath)) return { ok: false, code: '-11800' }
  return osaJson(transcribeScript(filePath, opts.locale), 120_000)
}

/**
 * Per-call counter, not just a timestamp: two listens started in the same
 * millisecond (a relay reply and a tray click) would otherwise share a path and
 * record over each other, and the second one's `finish()` would delete the
 * first's audio out from under its recogniser.
 */
let listenSeq = 0

/** Record from the mic until the speaker stops (or the cap), transcribe
 * on-device, and delete the recording. */
export function listen(opts: VadOpts & { locale?: string } = {}): SpeechPayload {
  const plan = vadPlan(opts)
  const file = path.join(os.tmpdir(), `tiny_listen_${process.pid}_${Date.now()}_${++listenSeq}.m4a`)
  // Budget = the whole capture + transcription + bridge startup. A flat timeout
  // would kill a legitimate 30s listen at its most useful moment.
  const budget = Math.round(plan.maxFrames * plan.pollSec * 1000) + 90_000
  const res = osaJson(listenScript(file, plan, opts.locale), budget)
  // The script deletes the file itself; this is the belt for the case where it
  // died before finish() ran — a crashed listen must not leave audio on disk.
  try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* nothing else to do */ }
  return res
}

// ── capability gates ────────────────────────────────────────────────────────

/** Can this machine speak out loud? */
export function hasSpeechOut(plat: string = os.platform(), probe: PathProbe = realProbe): boolean {
  return plat === 'darwin' && probe('/usr/bin/say')
}

/**
 * Can this machine transcribe locally?
 *
 * Gated on the bridge EXISTING, not on a live recogniser: instantiating
 * SFSpeechRecognizer costs a process spawn and can prompt, and a per-locale
 * model that isn't installed is reported by the call itself (see
 * 'no-local-model'). Same rule as hasVisionOcr.
 */
export function hasSpeechIn(plat: string = os.platform(), probe: PathProbe = realProbe): boolean {
  return plat === 'darwin' && probe('/usr/bin/osascript')
}

/** Either half — what makes the `voice` label appear at all. */
export function hasLocalSpeech(plat: string = os.platform(), probe: PathProbe = realProbe): boolean {
  return hasSpeechOut(plat, probe) || hasSpeechIn(plat, probe)
}

/**
 * Which voice halves resolved — for the `voice` label and the system prompt.
 * Same precedent as desktopSenses: the tool DESCRIPTION teaches both actions on
 * every machine, but a daemon that promises to say something out loud on a
 * machine with no synthesiser is the exact failure use_desktop's sense block
 * exists to prevent.
 */
export function speechModes(plat: string = os.platform(), probe: PathProbe = realProbe): string[] {
  const out: string[] = []
  if (hasSpeechOut(plat, probe)) out.push('speak')
  if (hasSpeechIn(plat, probe)) out.push('listen')
  return out
}

export { isMac as __isMac }
