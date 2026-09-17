// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔉 Every rail iOS ducks background audio on, Android ducks too — through ONE
 * focus holder.
 *
 * iOS says this on the audio session, and it says it exactly three times:
 * `.duckOthers` on `Speech.swift` (TTS), `Voice.swift` (dictation) and
 * `VoiceCall.swift` (the live S2S call). Android has no session to describe — the
 * counterpart is `requestAudioFocus` — and it had exactly ONE requester, in
 * `chat/Speech.kt`. So the two rails that open the MICROPHONE ran with the user's
 * music at full volume: dictating a message and holding a voice call both competed
 * with a podcast the phone was still playing, and the recognizer transcribed it.
 *
 * ⚠️ THE ROSTER IS DERIVED FROM iOS, not listed here, and that direction is the
 * point. A roster derived from "every Android rail that opens a mic" would be a
 * DIFFERENT and wrong claim: `NiclaRecorder`/`WearablesLive`/`DmMedia` set
 * `.allowBluetooth` WITHOUT `.duckOthers` on iOS, deliberately — a necklace take
 * or a voice note is not the phone taking over the user's audio. Those rails are at
 * parity precisely BY not ducking. What must not drift is the set iOS chose, so
 * that is what gets enumerated, and a fourth `.duckOthers` appearing on iOS turns
 * this suite red until Android's counterpart is named.
 *
 * The second half is the invariant that makes three holders safe at all. Audio
 * focus is per-request-OBJECT and the OS hands it to the newest requester: a second
 * `AudioFocusRequest` inside this same process steals focus from the first and
 * fires its listener with `LOSS_TRANSIENT`, which is the arm `Speech` halts on.
 * Two request objects would mean voice mode opening its mic cuts off the tiny's own
 * reply mid-sentence, and each rail stealing back from the other. Hence: exactly
 * one `AudioFocusRequest.Builder` in the whole app, in `AudioDuck`.
 */

const ROOT = process.cwd()
const ANDROID = 'android/app/src/main/java/technology/tiny/app'
const IOS = 'ios/Tiny/Sources'
const DUCK = `${ANDROID}/chat/AudioDuck.kt`

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Every `.kt` under the app's source root, recursively. */
function kotlinFiles(dir = ANDROID): string[] {
  const out: string[] = []
  let names: string[]
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names.sort()) {
    const rel = join(dir, n)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...kotlinFiles(rel))
    else if (n.endsWith('.kt')) out.push(rel)
  }
  return out
}

/**
 * The iOS files that ask the session to duck other audio.
 *
 * Read off `setCategory(..., options: [... .duckOthers ...])`, which can wrap onto
 * a second line (`VoiceCall.swift:207-208` does) — so the match is against the
 * whole file, not a line. That is enough here because the question is which
 * SUBSYSTEM ducks, and each of these files is one subsystem.
 */
function iosDuckingFiles(): string[] {
  return readdirSync(join(ROOT, IOS))
    .filter(n => n.endsWith('.swift'))
    .filter(n => read(`${IOS}/${n}`).includes('.duckOthers'))
    .sort()
}

/**
 * iOS subsystem → the Android class that is its counterpart, and the owner name
 * that class registers with.
 *
 * Owners are DISTINCT on purpose. Voice mode's TTS speaks a reply while its
 * recognizer is still rolling — two genuine, overlapping holders. If TTS and the
 * mic shared a name, `Speech.stop()` (which `VoiceMode.heard()` calls on every
 * barge-in) would drop the mic's duck too and the music would swell back the
 * instant the user started talking.
 */
const COUNTERPART: Record<string, { file: string; owner: string }> = {
  'Speech.swift': { file: `${ANDROID}/chat/Speech.kt`, owner: 'tts' },
  'Voice.swift': { file: `${ANDROID}/chat/VoiceMode.kt`, owner: 'voice-mode-mic' },
  'VoiceCall.swift': { file: `${ANDROID}/voice/VoiceCall.kt`, owner: 'voice-call' },
}

const IOS_DUCKS = iosDuckingFiles()

describe('Android audio ducking — parity with iOS .duckOthers', () => {
  it('finds the iOS ducking rails at all (an empty roster proves nothing)', () => {
    // Without this the suite passes vacuously the day `.duckOthers` is spelled
    // differently or the directory moves: green, pinning nothing.
    expect(IOS_DUCKS.length).toBeGreaterThanOrEqual(3)
  })

  it('every iOS ducking rail has a named Android counterpart', () => {
    // A NEW `.duckOthers` on iOS lands here, not silently on the floor. This is the
    // whole reason the roster is derived: the class of bug this fixes was three iOS
    // rails against one Android requester, and nothing said so.
    const unmapped = IOS_DUCKS.filter(f => !COUNTERPART[f])
    expect(
      unmapped,
      `iOS ducks background audio in ${unmapped.join(', ')} and this suite has no ` +
      `Android counterpart recorded for it. Either port the duck (AudioDuck.acquire ` +
      `+ release with a fresh owner name) or add it here with a comment saying why ` +
      `that rail deliberately differs.`,
    ).toEqual([])
  })

  it.each(IOS_DUCKS.filter(f => COUNTERPART[f]).map(f => [f, COUNTERPART[f]] as const))(
    '%s → its Android counterpart takes the duck', (swift, { file, owner }) => {
      const src = read(file)
      expect(
        src,
        `${file} is the Android counterpart of iOS ${swift}, which sets .duckOthers, ` +
        `but it never calls AudioDuck.acquire — the user's music plays at full ` +
        `volume through this rail.`,
      ).toMatch(/AudioDuck\.acquire\(/)
      // ⚠️ And the UNDO. An acquire with no release is worse than no duck at all:
      // the music stays quiet for the life of the process.
      expect(
        src,
        `${file} acquires the duck but never releases it — background audio would ` +
        `stay quieted after this rail finishes.`,
      ).toMatch(/AudioDuck\.release\(/)
      // The owner name, both halves. A release under a DIFFERENT name than the
      // acquire is the silent form of the same bug: dropHolder finds no such
      // holder, returns NOT_A_HOLDER, and abandons nothing — forever.
      expect(
        src,
        `${file} must register with the owner name "${owner}" — a mismatched ` +
        `acquire/release pair never unducks.`,
      ).toContain(`"${owner}"`)
    },
  )

  it('a loss halts the rail: every holder passes a real halt action', () => {
    // `acquire`'s second argument is what a phone call arriving mid-sentence
    // triggers. A rail that passes an empty lambda holds the duck through the call
    // and keeps talking over it — the failure iOS gets for free from
    // AVAudioSession interruptions and Android must ask for.
    for (const swift of IOS_DUCKS) {
      const mapped = COUNTERPART[swift]
      if (!mapped) continue
      const src = read(mapped.file)
      const at = src.indexOf('AudioDuck.acquire(')
      const call = src.slice(at, at + 200)
      expect(
        call,
        `${mapped.file}'s AudioDuck.acquire passes no halt action — a phone call ` +
        `would not stop this rail.`,
      ).toMatch(/\{\s*stop\(\)\s*\}/)
    }
  })
})

describe('one focus request for the whole app', () => {
  it('AudioDuck is the only place that builds an AudioFocusRequest', () => {
    // ⚠️ THE INVARIANT THAT MAKES THREE HOLDERS SAFE. A second request object in
    // this process steals focus from the first and fires its LOSS_TRANSIENT
    // listener — which is exactly what Speech halts on. `chat/Speech.kt` used to
    // build its own, correctly, while it was the app's SOLE requester; the moment
    // the mic rails ask too, that same code becomes the bug.
    const builders = kotlinFiles().filter(f => read(f).includes('AudioFocusRequest.Builder'))
    expect(
      builders,
      `Only ${DUCK} may build an AudioFocusRequest. A second one steals focus from ` +
      `the first inside this same app and halts it — join AudioDuck by name instead.`,
    ).toEqual([DUCK])
  })

  it('no rail requests or abandons focus behind AudioDuck\'s back', () => {
    const direct = kotlinFiles().filter(f => {
      if (f === DUCK) return false
      const src = read(f)
      return /\.requestAudioFocus\(|\.abandonAudioFocusRequest\(/.test(src)
    })
    expect(
      direct,
      `${direct.join(', ')} calls the AudioManager focus API directly. The holder ` +
      `count in AudioDuck is what keeps one rail from unducking while another still ` +
      `speaks; a direct call is invisible to it.`,
    ).toEqual([])
  })

  it('the duck is taken before the mic opens, and released in the one teardown funnel', () => {
    // Order, on the rail where it is audible. VOICE_COMMUNICATION's echo canceller
    // suppresses our OWN playback, not the user's music, so ducking after
    // startRecording() leaves a window where the podcast is in the captured audio.
    const call = read(`${ANDROID}/voice/VoiceCall.kt`)
    const acquiredAt = call.indexOf('AudioDuck.acquire(')
    const recordingAt = call.indexOf('rec.startRecording()')
    expect(acquiredAt).toBeGreaterThan(-1)
    expect(recordingAt).toBeGreaterThan(-1)
    expect(
      acquiredAt,
      `VoiceCall must duck BEFORE rec.startRecording() — otherwise the first frames ` +
      `captured contain the user's music.`,
    ).toBeLessThan(recordingAt)
    // And the release sits in stop(), the funnel every ending goes through (hang-up,
    // WS failure, onClosing, dispose, dismiss, and start()'s own mic-open failure).
    // Anywhere else and the other endings leave the phone silent.
    const stopAt = call.indexOf('    fun stop() {')
    const disposeAt = call.indexOf('    fun dispose() {')
    const releasedAt = call.indexOf('AudioDuck.release(')
    expect(stopAt).toBeGreaterThan(-1)
    expect(disposeAt).toBeGreaterThan(stopAt)
    expect(
      releasedAt > stopAt && releasedAt < disposeAt,
      `VoiceCall.release must live inside stop() — the single teardown funnel. ` +
      `Releasing anywhere else leaves the duck held for every other way a call ends.`,
    ).toBe(true)
  })

  it('VoiceMode releases the duck in stop(), its only exit', () => {
    // This class ROLLS a recognizer several times a minute. The duck brackets the
    // MODE, not the session — ducking per session would swell the music back in
    // every gap between rolls — so `stop()` is the only place it can come off.
    const vm = read(`${ANDROID}/chat/VoiceMode.kt`)
    const stopAt = vm.indexOf('    fun stop() {')
    const startSessionAt = vm.indexOf('    private fun startSession() {')
    const releasedAt = vm.indexOf('AudioDuck.release(')
    expect(stopAt).toBeGreaterThan(-1)
    expect(startSessionAt).toBeGreaterThan(stopAt)
    expect(
      releasedAt > stopAt && releasedAt < startSessionAt,
      `VoiceMode must release the duck in stop() — its only exit. Per-session ` +
      `release would unduck in the gap between every roll.`,
    ).toBe(true)
    // ⚠️ Acquired in start(), NOT in startSession(), for the same reason.
    const acquiredAt = vm.indexOf('AudioDuck.acquire(')
    const startAt = vm.indexOf('    fun start() {')
    expect(
      acquiredAt > startAt && acquiredAt < stopAt,
      `VoiceMode must duck in start(), not per rolled session.`,
    ).toBe(true)
  })
})
