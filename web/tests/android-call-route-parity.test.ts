// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a call comes OUT of the phone — parity with iOS `.defaultToSpeaker`.
 *
 * iOS says it in one option, on two rails: `.defaultToSpeaker`, paired with
 * `.allowBluetooth` every single time. The pair IS the intent — *hear it through
 * the headset when one is connected, otherwise out of the LOUD speaker* — and
 * neither half means anything alone.
 *
 * Android's default is the other one. `VoiceCall.kt` builds a
 * `USAGE_VOICE_COMMUNICATION` AudioTrack, which is correct (that usage pairs with
 * the VOICE_COMMUNICATION capture source and its echo canceller) and is also
 * exactly what routes playback to the **earpiece** — the 1-inch driver you hold
 * against your ear on a phone call. So the tiny answered a live voice call out of
 * the earpiece: audible at your face, nearly silent on a desk, which is where a
 * hands-free assistant call actually happens.
 *
 * ⚠️ NOTHING FAILED. Every frame arrived, the transcript rendered, the orb moved,
 * the duck quieted the user's music. `AudioDuck`'s own docblock had already
 * written the gap down without being able to close it — "Focus attributes set
 * ducking POLICY, not routing — `VoiceCall`'s own `AudioTrack` still declares
 * USAGE_VOICE_COMMUNICATION for its playback, and that is what routes" — which is
 * a comment naming an omission, i.e. a work item.
 *
 * ⚠️⚠️ THE ROSTER IS DERIVED FROM iOS, deliberately, exactly like
 * `android-audio-duck-parity.test.ts`. A roster derived from "Android rails that
 * play audio" would assert something different and wrong: `TinyLive`'s clip
 * playback and every `MediaPlayer` here use `USAGE_MEDIA`, which is already on the
 * loudspeaker, and their iOS twins set `.playback` with no `.defaultToSpeaker` at
 * all. They are at parity BY not routing. What must not drift is the set iOS
 * chose — so a third `.defaultToSpeaker` appearing on iOS turns this suite red
 * until Android's counterpart is named.
 */

const ROOT = process.cwd()
const ANDROID = 'android/app/src/main/java/technology/tiny/app'
const IOS = 'ios/Tiny/Sources'
const CALL_AUDIO = `${ANDROID}/voice/CallAudio.kt`

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
/** Kotlin/Swift line comments stripped: the prose here quotes the very defaults
 *  under test, so a raw scan finds `isSpeakerphoneOn` in the text explaining it. */
const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

/**
 * The iOS files that ask for the loudspeaker as the DEFAULT route.
 *
 * Read off the whole file rather than a line: `setCategory(...)` wraps onto a
 * second line in `VoiceCall.swift`, and the question here is which SUBSYSTEM
 * routes, each of these files being one subsystem.
 */
function iosSpeakerFiles(): string[] {
  return readdirSync(join(ROOT, IOS))
    .filter(n => n.endsWith('.swift'))
    .filter(n => read(`${IOS}/${n}`).includes('.defaultToSpeaker'))
    .sort()
}

/**
 * iOS subsystem → the Android counterpart, and how parity is reached there.
 *
 * `NOT_APPLICABLE` is a real verdict, not an escape hatch, and it carries its
 * reason — which for every one of them is the SAME reason, and it is a structural
 * difference between the platforms rather than a judgement call. iOS configures
 * one process-wide `AVAudioSession`, so a rail that only ever RECORDS still has to
 * name an output route, because the session it opens governs playback too; hence
 * `.defaultToSpeaker` appearing on capture-only rails. Android has no such
 * session: a rail that opens `AudioRecord`/`SpeechRecognizer` and never plays has
 * no output route to redirect, and `setCommunicationDevice` on its behalf would be
 * forcing a route for audio that does not exist.
 *
 * ⚠️ The verdict is therefore "does this rail PLAY?", and it is checked below
 * rather than trusted — a NOT_APPLICABLE that grows a player must not stay quiet.
 * (What iOS's *other* half of the pair does for these rails on this side is
 * `BtMic`, the `.allowBluetooth` counterpart, which IS ported and has its own
 * suite: `wearables-android.test.ts`.)
 */
const NOT_APPLICABLE = 'NOT_APPLICABLE'
const COUNTERPART: Record<string, { file: string; owner: string } | typeof NOT_APPLICABLE> = {
  'VoiceCall.swift': { file: `${ANDROID}/voice/VoiceCall.kt`, owner: 'voice-call' },
  // Dictation: Android's SpeechRecognizer captures inside Google's
  // recognition-service process and plays nothing.
  'Voice.swift': NOT_APPLICABLE,
  // The glasses' live mic and the necklace take: capture rails.
  'WearablesLive.swift': NOT_APPLICABLE,
  'NiclaRecorder.swift': NOT_APPLICABLE,
  // A DM voice note: records with AudioRecord, uploads, and never plays back
  // through a communication route.
  'DmMedia.swift': NOT_APPLICABLE,
}

/** The Android file each NOT_APPLICABLE verdict is a claim about. */
const CAPTURE_ONLY: Record<string, string> = {
  'Voice.swift': `${ANDROID}/chat/VoiceMode.kt`,
  'WearablesLive.swift': `${ANDROID}/fleet/WearablesLive.kt`,
  'NiclaRecorder.swift': `${ANDROID}/fleet/PhoneRecorder.kt`,
  'DmMedia.swift': `${ANDROID}/ui/DmMedia.kt`,
}

const IOS_SPEAKER = iosSpeakerFiles()
const ROUTED = IOS_SPEAKER.filter(f => COUNTERPART[f] && COUNTERPART[f] !== NOT_APPLICABLE)
const EXCUSED = IOS_SPEAKER.filter(f => COUNTERPART[f] === NOT_APPLICABLE && CAPTURE_ONLY[f])

describe('Android call routing — parity with iOS .defaultToSpeaker', () => {
  it('finds the iOS speaker-routing rails at all (an empty roster proves nothing)', () => {
    // Without this the suite passes vacuously the day the option is spelled
    // differently or the directory moves: green, pinning nothing.
    expect(IOS_SPEAKER.length, 'no iOS rail asks for .defaultToSpeaker — re-anchor')
      .toBeGreaterThanOrEqual(2)
  })

  it('every iOS speaker-routing rail has a recorded Android verdict', () => {
    // A NEW `.defaultToSpeaker` on iOS lands here rather than silently on the
    // floor. This is the whole reason the roster is derived: the defect was iOS
    // routing two rails and Android routing none, and nothing said so.
    const unmapped = IOS_SPEAKER.filter(f => !COUNTERPART[f])
    expect(
      unmapped,
      `iOS routes to the loudspeaker in ${unmapped.join(', ')} and this suite has no ` +
      `Android verdict recorded for it. Either port the routing (CallAudio.route + ` +
      `restore with a fresh owner name) or mark it NOT_APPLICABLE with a comment ` +
      `saying why that rail has no output route of its own.`,
    ).toEqual([])
  })

  it.each(ROUTED.map(f => [f, COUNTERPART[f] as { file: string; owner: string }] as const))(
    '%s → its Android counterpart routes the call', (swift, { file, owner }) => {
      const src = code(read(file))
      expect(
        src,
        `${file} is the Android counterpart of iOS ${swift}, which sets ` +
        `.defaultToSpeaker, but it never calls CallAudio.route — the call plays out ` +
        `of the EARPIECE, which on a desk is nearly silent.`,
      ).toMatch(/CallAudio\.route\(/)
      // ⚠️ And the UNDO. A forced route outliving the call sends the next thing the
      // phone plays in call mode out of the loudspeaker.
      expect(
        src,
        `${file} routes the call but never restores it — the forced speaker would ` +
        `outlive the call.`,
      ).toMatch(/CallAudio\.restore\(/)
      // ⚠️ The owner name, compared BETWEEN the halves — not merely present in the
      // file. A restore under a different name than the route is the silent form of
      // the same bug: the guard finds no such holder and restores nothing, ever.
      // And "the file mentions the name somewhere" is no evidence at all here,
      // because `DUCK_OWNER` next door is the same string; a mutation that swaps
      // restore's argument for a literal passes that weaker check untouched.
      const argOf = (call: string) =>
        src.match(new RegExp(`CallAudio\\.${call}\\(([^)]*)\\)`))?.[1].split(',').pop()?.trim()
      const routeArg = argOf('route')
      const restoreArg = argOf('restore')
      expect(routeArg, `no owner argument found on ${file}'s CallAudio.route`).toBeTruthy()
      expect(
        restoreArg,
        `${file} routes as ${routeArg} and restores as ${restoreArg} — a mismatched ` +
        `route/restore pair never hands routing back, and nothing anywhere fails.`,
      ).toBe(routeArg)
      // …and whatever that argument is, it must resolve to the recorded owner: the
      // literal itself, or a constant bound to it.
      const resolves = routeArg === `"${owner}"` ||
        new RegExp(`val ${routeArg}\\s*=\\s*"${owner}"`).test(src)
      expect(
        resolves,
        `${file}'s routing owner is ${routeArg}, which is not the owner name ` +
        `"${owner}" recorded in this suite's roster — one of the two is stale.`,
      ).toBe(true)
    },
  )

  it('every NOT_APPLICABLE verdict names an Android file that exists', () => {
    // An excuse pointing at a moved or renamed file is an excuse nothing checks.
    const missing = EXCUSED.filter(f => { try { read(CAPTURE_ONLY[f]); return false } catch { return true } })
    expect(missing, `the NOT_APPLICABLE verdict for ${missing.join(', ')} names an ` +
      `Android file that no longer exists — re-anchor or re-decide`).toEqual([])
    // …and every excused rail is actually excused BY the roster, not silently absent.
    const unexplained = IOS_SPEAKER.filter(f => COUNTERPART[f] === NOT_APPLICABLE && !CAPTURE_ONLY[f])
    expect(unexplained, `${unexplained.join(', ')} is marked NOT_APPLICABLE with no ` +
      `Android file recorded to check the claim against`).toEqual([])
  })

  it.each(EXCUSED.map(f => [f, CAPTURE_ONLY[f]] as const))(
    '%s is excused because its Android rail PLAYS nothing', (_swift, file) => {
      // ⚠️ The verdict is verified, not trusted. A capture-only rail that grows an
      // AudioTrack or a MediaPlayer has an output route from that moment on — and
      // if it declares USAGE_VOICE_COMMUNICATION it inherits the exact earpiece
      // default this whole suite exists to catch. Without this pin the roster's
      // escape hatch is the one place the bug can come back unnoticed.
      const src = code(read(file))
      for (const player of ['AudioTrack.Builder', 'MediaPlayer(']) {
        expect(
          src,
          `${file} is recorded as capture-only (that is why its iOS twin's ` +
          `.defaultToSpeaker needs no counterpart), but it now builds a ${player} — ` +
          `it has an output route. Decide its routing and give it a CallAudio owner, ` +
          `or say here why its playback is not a communication route.`,
        ).not.toContain(player)
      }
    },
  )

  it('the route is undone on the ONE funnel every ending goes through', () => {
    // The duck learned this the hard way and recorded it: `stop()` is the single
    // exit (the user hanging up, a WS failure, onClosing, dispose(), dismiss(),
    // and start()'s own mic-open failure). Restoring at any one other site leaves
    // the route forced after every other ending.
    const src = code(read(`${ANDROID}/voice/VoiceCall.kt`))
    const stopAt = src.indexOf('fun stop()')
    expect(stopAt, 'VoiceCall.stop() is gone — re-anchor').toBeGreaterThan(-1)
    const restoreAt = src.indexOf('CallAudio.restore(')
    expect(restoreAt, 'the restore is not inside stop()').toBeGreaterThan(stopAt)
    // Exactly one restore site: a second one elsewhere is the "restore at each
    // ending" mistake the duck's comment warns about.
    expect(src.split('CallAudio.restore(').length - 1, 'more than one restore site').toBe(1)
    expect(src.split('CallAudio.route(').length - 1, 'more than one route site').toBe(1)
  })

  it('a connected headset KEEPS the call — the regression worse than the bug', () => {
    // ⚠️ The property that makes this port safe rather than harmful, and the one
    // thing here that is decided in Kotlin: `.defaultToSpeaker` changes a DEFAULT
    // and never outranked a connected headset — iOS asks for `.allowBluetooth` in
    // the same breath, every time. Forcing the speaker unconditionally would shout
    // a private call into the room while the user wears the glasses, undoing
    // BtMic's whole purpose on the surface where privacy matters most. Executed by
    // `CallAudioTest` on the JVM; pinned here so the SHAPE cannot be flattened
    // into an unconditional force.
    const src = code(read(CALL_AUDIO))
    expect(src, 'the route decision is gone — re-anchor').toMatch(/fun chooseRoute\(/)
    expect(src, 'LEAVE_ALONE is gone: nothing protects a connected headset')
      .toMatch(/LEAVE_ALONE/)
    // The headset roster must be a SET the decision reads, not a bare `||` chain
    // that a later edit can quietly shorten.
    const headsets = src.slice(src.indexOf('HEADSETS'))
    for (const kind of [
      'TYPE_BLUETOOTH_SCO', 'TYPE_BLE_HEADSET', 'TYPE_WIRED_HEADSET',
      'TYPE_WIRED_HEADPHONES', 'TYPE_USB_HEADSET',
    ]) {
      expect(headsets, `${kind} dropped from the headset roster — a call would be ` +
        `forced out loud over it`).toContain(kind)
    }
    // …and the speaker itself must NOT be in that roster, or the decision inverts
    // and every call quietly returns to the earpiece.
    const roster = headsets.slice(0, headsets.indexOf(')'))
    expect(roster, 'TYPE_BUILTIN_SPEAKER is in the HEADSET roster — the decision inverts')
      .not.toContain('TYPE_BUILTIN_SPEAKER')
  })

  it('the modern knob is scoped to this app, and the legacy one is version-gated', () => {
    const src = code(read(CALL_AUDIO))
    // setCommunicationDevice scopes to the calling app's own communication use
    // cases — which is exactly one voice call. (Its narrowness is precisely why
    // BtMic cannot use it: routing ANOTHER process's capture needs device-wide
    // SCO. Both facts are recorded, in both files.)
    expect(src).toMatch(/setCommunicationDevice\(/)
    expect(src, 'nothing hands routing back to the OS').toMatch(/clearCommunicationDevice\(/)
    // The pre-31 fallback exists (minSdk is 29) and is gated, not called blind.
    expect(src).toMatch(/isSpeakerphoneOn/)
    expect(src, 'the deprecated knob is not version-gated').toMatch(/SDK_INT >= 31/)
  })

  it('the decision and the owner guard are RUN, not just read', () => {
    // ⚠️ A TEST FILE IS A PARITY SURFACE TOO — this loop learned that when three
    // mutants survived a cycle for the single reason that nothing read the Kotlin
    // test. Every property above is read off source text, which cannot tell whether
    // `chooseRoute` actually returns SPEAKER for a bare phone; only `CallAudioTest`
    // can, and if its @Test annotations are dropped or the file is deleted the
    // gradle task still exits 0 with fewer tests and nothing anywhere goes red.
    const src = read('android/app/src/test/java/technology/tiny/app/voice/CallAudioTest.kt')
    const tests = src.split('@Test').length - 1
    expect(tests, 'CallAudioTest has lost its @Test annotations — the routing ' +
      'decision is no longer executed anywhere').toBeGreaterThanOrEqual(8)
    // ⚠️ …and the count above is NOT the gate, because a floor can never be one:
    // the day a test is added the floor is slack again, and dropping a single
    // `@Test` then passes it. What actually kills a silenced test is this — a
    // backtick-named function with no annotation still compiles, still reads like a
    // test in review, and never runs. `--tests` even exits 0 over it.
    const orphans = src.split('\n')
      .filter(l => /^\s*(?:private\s+)?fun\s+`/.test(l) && !l.includes('@Test'))
      .map(l => l.trim())
    expect(orphans, `these look like tests but carry no @Test, so they never run: ` +
      `${orphans.join(' | ')}`).toEqual([])
    // The three properties that cannot be proven by reading Kotlin: the bare-phone
    // redirect, the headset veto, and the owner guard on the undo.
    for (const [call, why] of [
      ['chooseRoute(', 'the route decision is never executed'],
      ['release(', 'the owner guard on the undo is never executed — inside restore() ' +
        'it needs a live AudioManager, so nothing but this test can reach it'],
    ] as const) {
      expect(src, `${why}: CallAudioTest never calls ${call}`).toContain(call)
    }
    expect(src, 'no test covers the headset veto').toContain('LEAVE_ALONE')
    expect(src, 'no test covers the bare-phone redirect').toContain('Route.SPEAKER')
  })

  it('route() takes ownership through claim(), not beside it', () => {
    // ⚠️ The one property of `route()` that NO test can execute: everything past its
    // first line needs a live AudioManager, so on this machine the body is
    // unreachable and only its shape can be checked. `claim` exists precisely to
    // move the decide-and-record pairing somewhere runnable — and calling
    // `chooseRoute` here instead puts it back, silently. The forced route would then
    // be held by nobody, `restore` would decline to undo it for the life of the
    // process, and the loudspeaker would outlive the call.
    const src = code(read(CALL_AUDIO))
    const body = src.slice(src.indexOf('fun route('), src.indexOf('fun restore('))
    expect(body, 'route() is gone — re-anchor').toBeTruthy()
    expect(
      body,
      `route() must call claim(), which decides AND records the holder in one step. ` +
      `Calling chooseRoute() directly here leaves the route forced with no owner, ` +
      `and nothing on a device or in a test would report it.`,
    ).toMatch(/claim\(available, owner\)/)
    expect(
      body,
      `route() calls chooseRoute() directly — that is the pairing undone at the ` +
      `call site; go through claim().`,
    ).not.toMatch(/chooseRoute\(/)
  })

  it('the routing is best-effort: a refusal never fails the call', () => {
    // BtMic's rule, for BtMic's reason. A quiet call is a poor call; a call that
    // will not start is no call. Every live AudioManager touch is wrapped.
    const src = code(read(CALL_AUDIO))
    const guards = src.split('runCatching').length - 1
    expect(guards, 'an unguarded AudioManager call can throw into the call setup')
      .toBeGreaterThanOrEqual(3)
  })
})
