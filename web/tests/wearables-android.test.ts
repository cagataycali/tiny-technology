// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildVoiceTools } from '../lib/voice/tools'

/**
 * 🕶️ Meta Wearables integration — the Android half.
 *
 * Same shape as wearables-ios.test.ts: the SDK is wired by declaration
 * (gradle placeholders → manifest meta-data, a GitHub-Packages repo, pinned
 * artifacts), and each declaration must agree with an artifact elsewhere —
 * meta.md (what Meta issued), the iOS MWDAT dict (the other client), and the
 * public-repo rule (no token may ever be hardcoded).
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Every `.kt` under `dir`, recursively — so a roster can be DERIVED from what the
 * app actually contains rather than from a list someone remembered to extend.
 */
function kotlinSources(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${n}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...kotlinSources(rel))
    else if (n.endsWith('.kt')) out.push(rel)
  }
  return out.sort()
}

/**
 * Kotlin with its comments removed. Several pins below assert the ABSENCE of a
 * line, and the comments that replaced those lines quote them verbatim while
 * explaining why they went — so an unstripped scan finds the bug in its own
 * epitaph.
 */
const stripKt = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * A card file's COMPOSABLE half — everything above its top-level helpers.
 *
 * The helpers below a card are the pure seams its JVM tests drive, and they spell
 * the same arithmetic the composable is supposed to call. So a whole-file scan
 * can't tell "the card clamps its drag" from "a clamp exists in this file and
 * nothing calls it" — a mutant that inlined the maths and orphaned the helper
 * passed every pin until these two regions were read apart.
 */
const composableOf = (s: string) => {
  const i = s.indexOf('\ninternal fun ')
  return i < 0 ? s : s.slice(0, i)
}

const gradle = read('android/app/build.gradle.kts')
const settings = read('android/settings.gradle.kts')
const manifest = read('android/app/src/main/AndroidManifest.xml')
const catalog = read('android/gradle/libs.versions.toml')
const metaMd = read('meta.md')

const plistValue = (key: string) =>
  metaMd.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]

const placeholder = (name: string) =>
  gradle.match(new RegExp(`manifestPlaceholders\\["${name}"\\] =\\s*\\n?\\s*"([^"]+)"`))?.[1]

describe('DAT creds ↔ meta.md ↔ the iOS client (one identity, three artifacts)', () => {
  it('gradle placeholders carry the issued MetaAppID + ClientToken, verbatim', () => {
    expect(placeholder('mwdat_application_id')).toBe(plistValue('MetaAppID'))
    expect(placeholder('mwdat_client_token')).toBe(plistValue('ClientToken'))
  })

  it('iOS and Android declare the SAME app to Meta', () => {
    const ios = parseYaml(read('ios/project.yml')).targets.Tiny.info.properties.MWDAT
    expect(placeholder('mwdat_application_id')).toBe(String(ios.MetaAppID))
    expect(placeholder('mwdat_client_token')).toBe(ios.ClientToken)
  })

  it('the manifest wires both placeholders into the SDK meta-data keys', () => {
    for (const [key, ph] of [
      ['com.meta.wearable.mwdat.APPLICATION_ID', 'mwdat_application_id'],
      ['com.meta.wearable.mwdat.CLIENT_TOKEN', 'mwdat_client_token'],
    ]) {
      const entry = manifest.match(new RegExp(`android:name="${key}"\\s*\\n\\s*android:value="([^"]+)"`))?.[1]
      expect(entry).toBe(`\${${ph}}`)
    }
  })
})

describe('manifest declarations the SDK needs', () => {
  it('BLUETOOTH_CONNECT is declared (the API 31+ runtime half)', () => {
    expect(manifest).toContain('android.permission.BLUETOOTH_CONNECT')
  })

  it('a host-less tinyapp filter exists for the Meta AI callback', () => {
    // The routed filters all pin android:host; the SDK returns on an
    // SDK-chosen path, so exactly the bare-scheme form must exist too.
    expect(manifest).toMatch(/<data android:scheme="tinyapp" \/>/)
  })
})

describe('the glasses tools — Android executors ↔ server mounts', () => {
  it('every tool the route mounts for tiny-android has a ChatViewModel dispatch', () => {
    const route = read('app/api/chat/route.ts')
    const vm = read('android/app/src/main/java/technology/tiny/app/chat/ChatViewModel.kt')
    const mount = route.match(/tinySession === 'tiny-android' \? \[([^\]]+)\]/)?.[1] ?? ''
    // metaTakePhotoTool → "meta_take_photo" etc. — a mounted tool with no
    // executor strands every call to the 90s timeout.
    const names = mount.split(',').map((s) => s.trim())
      .map((s) => s.replace(/Tool$/, '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''))
    expect(names.length).toBeGreaterThanOrEqual(4)
    for (const name of names) expect(vm).toContain(`"${name}"`)
  })

  it('the recorder respects the 6MB cap and uploads video/mp4', () => {
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
    expect(rec).toMatch(/6 \* 1024 \* 1024/)
    expect(rec).toContain('.put("contentType", "video/mp4")')
  })

  it('the muxer never sees time run backwards (measured: mock loops its feed)', () => {
    // Trusting source pts produced a 697-frame clip crammed into a 7.7s
    // timeline that no player would open; rewinds must synthesize a nominal
    // frame step instead.
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
    expect(rec).toMatch(/raw > lastPtsUs\) raw else lastPtsUs \+ 41_666/)
  })

  it('stopAndUpload survives its own scope teardown (auto-stop clip loss)', () => {
    // The auto-stop path runs INSIDE the recording's scope; stopAndUpload
    // cancels that scope mid-teardown, so the upload MUST be NonCancellable
    // or every auto-stopped clip silently vanishes (found live on the Pixel).
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
    expect(rec).toMatch(/stopAndUpload\(app: TinyApp\): JSONObject =\s*\n\s*kotlinx\.coroutines\.withContext\(kotlinx\.coroutines\.NonCancellable\)/)
  })
})

describe('the live HUD (iOS GlassesLiveOverlay parity)', () => {
  const live = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesLive.kt')
  const card = read('android/app/src/main/java/technology/tiny/app/ui/GlassesLiveCard.kt')
  const main = read('android/app/src/main/java/technology/tiny/app/MainActivity.kt')
  const listener = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesListener.kt')

  it('MainActivity carries the 🕶 toggle, gated on the linked state', () => {
    expect(main).toContain('GlassesLiveCard(app)')
    expect(main).toContain('if (glassesLinked)')
    expect(main).toMatch(/RegistrationState\.REGISTERED/)
  })

  it('the HUD is display-only — no frame or transcript ever uploads from it', () => {
    for (const source of [live, card]) {
      expect(source).not.toContain('/api/media')
      expect(source).not.toContain('postJson')
    }
  })

  it('the transcript rides the ONE recognizer recipe meta_listen owns', () => {
    // EXTRA_PREFER_OFFLINE (the on-device promise) must stay single-sourced
    // in WearablesListenerBridge — the HUD calls its helpers, it does not
    // build a second, divergent recognizer.
    expect(live).toContain('WearablesListenerBridge.newRecognizer')
    expect(live).toContain('WearablesListenerBridge.once')
    expect(live).not.toContain('EXTRA_PREFER_OFFLINE')
    expect(listener).toContain('EXTRA_PREFER_OFFLINE')
  })

  it('recognition claims the GLASSES mic when connected (iOS .allowBluetooth parity)', () => {
    // Android never auto-routes SpeechRecognizer to a BT headset — without
    // BtMic both listen surfaces transcribe the PHONE mic and call it "what
    // the glasses heard". Both must acquire AND release.
    //
    // ⚠️ The PROPERTY, not the call's spelling. This read `'BtMic.acquire(app)'`
    // verbatim and went red the moment the link gained an owner argument — a pin
    // quoting an implementation LINE reds on a correct refactor and, worse, would
    // have fossilised the ownerless signature that let one rail's release cut
    // another's link (c64's lesson, c66's bug).
    for (const owner of ['WearablesListener.kt', 'WearablesLive.kt']) {
      const src = read(`android/app/src/main/java/technology/tiny/app/fleet/${owner}`)
      expect(src).toMatch(/BtMic\.acquire\(/)
      expect(src).toMatch(/BtMic\.release\(/)
    }
    // …and the payload names which microphone actually heard it.
    expect(listener).toContain('"micRoute"')
  })

  it('EVERY rail that opens this phone\'s mic routes to the glasses', () => {
    // ⚠️ DERIVED, not listed. iOS sets `.allowBluetooth` on four audio sessions;
    // Android had BtMic on two, so `nicla_voice_record` (a take with NOBODY
    // WATCHING — no screen shows which mic is live) and voice mode both heard the
    // phone in the user's pocket while the glasses sat on their face. A listed
    // roster is what let that sit: it named the two rails that were already right.
    //
    // The roster is every file that builds an ACTION_RECOGNIZE_SPEECH request, minus
    // the ones that provably read something other than this phone's microphone.
    const SRC = 'android/app/src/main/java/technology/tiny/app'
    const files = kotlinSources(SRC).filter(f =>
      read(f).includes('Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)'))
    expect(files.length).toBeGreaterThanOrEqual(4) // vacuity floor
    for (const f of files) {
      const src = read(f)
      // EXTRA_AUDIO_SOURCE = the request reads a caller-supplied stream (the
      // necklace's pipe, a voice-note file), so no microphone is opened at all and
      // a BT route would be meaningless. The only legitimate exemption, and it is
      // stated as a property of the request rather than as a filename.
      if (src.includes('RecognizerIntent.EXTRA_AUDIO_SOURCE')) continue
      expect(
        src,
        `${f} opens this phone's microphone but never calls BtMic — with the ` +
        `glasses worn it transcribes the phone's own mic, and nothing reports that`,
      ).toMatch(/BtMic\.acquire\(/)
      expect(
        src,
        `${f} raises the SCO link and never drops it — the headset holds the ` +
        `phone's audio in call mode until the process dies`,
      ).toMatch(/BtMic\.release\(/)
    }
  })

  it('a rail that can hear the GLASSES says which mic heard it', () => {
    // ⚠️ THE OTHER HALF OF ROUTING, and c66 shipped without it. Two rails gained
    // the SCO link and neither told anyone: a take made through a headset on the
    // user's face and one made through the phone in their pocket produced
    // byte-identical replies. The words arrive either way — only the ROOM differs,
    // and no other field in the answer can reveal it. Routing without reporting
    // just moves the lie: the transcript is now right and the story about it wrong.
    //
    // DERIVED from the acquirers, so a fifth rail cannot arrive silent: whoever
    // asks BtMic for the link is a rail whose audio may come from either mic.
    //
    // The obligation lands on the ones that ANSWER — a rail that builds a reply
    // envelope has somewhere to put the fact, and an envelope without it is the
    // gap. VoiceMode and the live HUD acquire the link too and are exempt for a
    // structural reason, not a convenient one: their transcript becomes the user's
    // own chat message / on-screen text, with no envelope and no reader to mislead.
    // That exemption is DERIVED as well, so the day either grows an envelope this
    // pin starts demanding a route from it.
    const SRC = 'android/app/src/main/java/technology/tiny/app'
    const acquirers = kotlinSources(SRC).filter(f => read(f).includes('BtMic.acquire('))
    expect(acquirers.length).toBeGreaterThanOrEqual(4) // vacuity floor
    const answering = acquirers.filter(f => read(f).includes('JSONObject'))
    expect(answering.length).toBeGreaterThanOrEqual(2) // vacuity floor
    for (const f of answering) {
      const src = read(f)
      // A rail reports the route by NAMING it (the two words the agent compares)
      // or by handing it to something that does — PhoneRecorder's `route()` and
      // its `micRoute` field, the listener's own `"micRoute"` payload key.
      expect(
        src,
        `${f} answers a tool call that could have been heard through the glasses OR ` +
        `the phone and never says which — the transcript's room is unknowable from its reply`,
      ).toMatch(/micRoute|MicRoute/)
    }
  })

  it('the take carries its route out, because the link is DOWN by reply time', () => {
    // ⚠️ A TIMING BUG THAT READS AS CORRECT CODE. `reply()` runs after the take's
    // `finally` has lowered the SCO link, so a `BtMic.active` read there answers
    // "no" for every take — including the ones the glasses heard. The route has to
    // be captured while it is still a fact and travel on the Take. Same trap on
    // iOS, where the audio session is deactivated before the result is built.
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
    const replyAt = rec.indexOf('fun reply(take: Take)')
    expect(replyAt).toBeGreaterThan(0)
    // The reply reads the FIELD, never the live link.
    const replyBody = rec.slice(replyAt, rec.indexOf('\n    /**', replyAt))
    expect(replyBody).toMatch(/take\.micRoute/)
    expect(
      replyBody,
      'reply() runs after the link came down — a live read here reports "phone" always',
    ).not.toMatch(/BtMic\./)
    // …and the capture side reads it BEFORE its release, not after.
    const listenAt = rec.indexOf('private suspend fun listen(')
    const readAt = rec.indexOf('route(BtMic.active)', listenAt)
    const releaseAt = rec.indexOf('BtMic.release(', listenAt)
    expect(readAt).toBeGreaterThan(listenAt)
    expect(
      readAt,
      'the route is read after the link was dropped — it can only answer "phone"',
    ).toBeLessThan(releaseAt)
    // Unknown stays unknown: an absent route must not become a claim about the
    // built-in mic, on either the phone or the worker side.
    expect(rec).toMatch(/val micRoute: String\? = null/)
    const tool = read('lib/chat/tools/nicla-voice.ts')
    expect(tool).toMatch(/p\.micRoute === 'bluetooth' \|\| p\.micRoute === 'phone'/)
    expect(
      tool,
      "the tool must not default an unknown route — that reports the phone's mic for a take it never measured",
    ).not.toMatch(/micRoute[^\n]*\?\?\s*'phone'/)
  })

  it('the BT link is OWNED, so one rail\'s release cannot cut another\'s', () => {
    // The bug this cycle's port would otherwise have introduced, and it is silent:
    // under a single `claimed` boolean the first rail to FINISH tore the link down
    // under a rail still recording, which then heard the phone's built-in mic while
    // `active` read false. A set, not a counter — a `finally` that runs twice must
    // not drop a link another rail holds.
    const bt = read('android/app/src/main/java/technology/tiny/app/fleet/BtMic.kt')
    expect(bt).toMatch(/private val holders = mutableSetOf<String>\(\)/)
    expect(bt).toMatch(/fun acquire\(context: Context, owner: String\)/)
    expect(bt).toMatch(/fun release\(context: Context, owner: String\)/)
    // Releasing a name that isn't a holder changes nothing (MicClaim's guard).
    expect(bt).toMatch(/if \(owner !in holders\) return/)
    // …and the link only drops when the LAST holder leaves. Both non-LAST cases
    // must be treated alike: NOT_A_HOLDER (a rail that never had the link) and
    // STILL_HELD (a rail that had it and isn't last out) both mean "touch nothing".
    expect(bt).toMatch(/if \(dropHolder\(owner\) != Drop\.LAST\) return/)
    // A second rail arriving while the link is already up must be RECORDED, not
    // just told "yes" — an unrecorded holder is the original bug wearing the new
    // signature: the first rail's release sees an empty set and cuts the link.
    expect(bt).toMatch(/if \(joinIfUp\(owner\)\) return true/)
    // ⚠️ …and a rail may be recorded ONLY once the link is genuinely up. Recording
    // before that (an earlier draft added then removed on failure) lets a
    // concurrent rail read a non-empty set, believe the link is up, skip raising
    // SCO — and hear the phone while reporting bluetooth.
    expect(bt).toMatch(/isBluetoothScoOn = true\s*\n\s*noteHolder\(owner\)/)
    expect(bt, 'joinIfUp must record NOTHING when the link is down')
      .toMatch(/fun joinIfUp\(owner: String\): Boolean = synchronized\(this\) \{\s*\n\s*if \(holders\.isEmpty\(\)\) return false/)
    // The arithmetic itself is EXECUTED, not read: BtMicTest drives the four-rail
    // overlap, the double teardown and the never-acquired release on the JVM. A
    // source pin cannot tell a set from a counter — that test can, so it must exist.
    const jvm = read('android/app/src/test/java/technology/tiny/app/fleet/BtMicTest.kt')
    expect(jvm).toMatch(/Drop\.STILL_HELD/)
    expect(jvm).toMatch(/Drop\.NOT_A_HOLDER/)
    expect(jvm).toMatch(/runs TWICE cannot drop another rail/)
    // `active` is what `micRoute` reports to the agent, so it must be DERIVED from
    // the holder set — a constant here makes every transcript claim the phone mic.
    expect(bt).toMatch(/val active:[^\n]*holders\.isNotEmpty\(\)/)
    // Every rail names itself with a constant, not a literal typed at two sites —
    // a typo'd release leaves the headset in call mode for the life of the process.
    for (const f of [
      'fleet/WearablesListener.kt', 'fleet/WearablesLive.kt',
      'fleet/PhoneRecorder.kt', 'chat/VoiceMode.kt',
    ]) {
      const src = read(`android/app/src/main/java/technology/tiny/app/${f}`)
      expect(src, `${f} passes a BtMic owner literal instead of a named constant`)
        .toMatch(/(private const val|private val) BT_OWNER = "/)
      expect(src).toMatch(/BtMic\.acquire\([^)]*BT_OWNER\)/)
      expect(src).toMatch(/BtMic\.release\([^)]*BT_OWNER\)/)
    }
  })

  it('voice mode brackets the MODE, not each rolled session', () => {
    // ⚠️ WHERE the acquire sits is the whole property, and getting it wrong is
    // invisible in every log. VoiceMode ROLLS a new recognizer on every final and
    // every error — several per minute — so an acquire inside `startSession()`
    // would raise and drop the SCO link on each roll, and each raise costs ~800ms
    // of DEAF microphone: the user's next sentence lands in the gap and simply
    // never appears. The link must come up once in `start()` and go down in
    // `stop()`, which is the only exit; every roll happens underneath it.
    const vm = read('android/app/src/main/java/technology/tiny/app/chat/VoiceMode.kt')
    const at = (needle: string) => {
      const i = vm.indexOf(needle)
      expect(i, `VoiceMode.kt no longer declares ${needle.trim()} — this window reads nothing`).toBeGreaterThan(0)
      return i
    }
    const start = at('\n    fun start()')
    const stop = at('\n    fun stop()')
    const roll = at('\n    private fun startSession()')
    expect(vm.slice(start, stop), 'the SCO link must be raised for the MODE, in start()')
      .toMatch(/BtMic\.acquire\(/)
    expect(vm.slice(stop, roll), 'stop() is the only exit — the release belongs there or the headset holds the phone in call mode')
      .toMatch(/BtMic\.release\(/)
    // ⚠️ ORDER + NON-VACUITY, or the negative assertion below is free. A window
    // that collapses to "" contains no `BtMic.` and passes while the acquire sits
    // in the roll — measured: a mutant that did exactly this SURVIVED this test.
    expect(start).toBeLessThan(stop)
    expect(stop).toBeLessThan(roll)
    expect(vm.slice(roll), 'the roll window reads nothing — it must hold the recognizer it builds')
      .toContain('Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)')
    expect(vm.slice(roll), 'a rolled session must not touch the link: each raise is ~800ms of deaf mic')
      .not.toMatch(/BtMic\./)
  })

  it('meta_listen rides the HUD when it already owns the mic (one-mic rule)', () => {
    // Two SpeechRecognizers on one input is a fight nobody wins — the
    // listener must diff the HUD transcript instead of starting its own.
    expect(listener).toMatch(/GlassesLive\.running\.value && GlassesLive\.transcribing\.value/)
  })

  it('the mic never auto-starts with the stream (privacy posture from iOS c8)', () => {
    // Inside the live core, toggleTranscription exists ONLY as its own
    // declaration — no internal path (start included) ever calls it; the
    // card's explicit mic tap is the sole caller.
    const mentions = live.match(/toggleTranscription/g) ?? []
    expect(mentions.length).toBe(1)
    expect(live).toContain('fun toggleTranscription')
    expect(card).toContain('micAsk.launch(Manifest.permission.RECORD_AUDIO)')
  })

  it('each floating live card is draggable on BOTH phones, or on neither', () => {
    // ⚠️ THE ODD RAIL OUT, and the harm is not cosmetic. A live card's presence IS
    // its stream's lifetime (`DisposableEffect` → start/stop), so an immovable
    // 236dp card parked over the chat made "let me read what's underneath" and
    // "keep the live view" mutually exclusive: the only way to uncover the chat
    // was to close the card, which tears the glasses session down and costs the
    // whole session budget (~17s of device wait + stream start) to rebuild.
    //
    // Stated as a PAIRING, in both directions — a card that gains drag on one
    // phone and not the other reds here, and so does one that LOSES it. Not
    // "every card must drag": iOS's necklace overlay doesn't either, and this pin
    // must not conjure a feature nobody asked for. It asserts the two clients
    // agree, card by card.
    const pairs = [
      { droid: 'ui/GlassesLiveCard.kt', ios: 'WearablesLive.swift', view: 'GlassesLiveOverlay' },
      { droid: 'ui/TinyLiveCard.kt', ios: 'TinyLive.swift', view: 'TinyLiveOverlay' },
    ]
    let draggable = 0
    for (const p of pairs) {
      const droid = composableOf(stripKt(read(`android/app/src/main/java/technology/tiny/app/${p.droid}`)))
      const swift = read(`ios/Tiny/Sources/${p.ios}`)
      expect(swift, `${p.ios} no longer declares ${p.view} — this pin reads the wrong file`)
        .toContain(`struct ${p.view}: View`)
      const iosDrags = /DragGesture\(/.test(swift)
      // On Android the gesture is only half of it: a drag that nothing RENDERS is
      // a no-op, so both the recogniser and the offset it feeds must be present.
      //
      // ⚠️ The CALL, `detectDragGestures {` — measured: reading the bare name
      // passed on a card whose whole gesture had been deleted, because the leftover
      // `import …gestures.detectDragGestures` still matched. An import is not a
      // gesture, and the composable region is where a gesture has to be.
      const droidDrags = /detectDragGestures\s*\{/.test(droid) && /\.offset \{/.test(droid)
      expect(
        droidDrags,
        `${p.droid} and ${p.ios}'s ${p.view} disagree about dragging (android=${droidDrags}, ios=${iosDrags}) — ` +
        `whichever card is pinned in its corner can only be moved off the chat by CLOSING it, ` +
        `and closing it stops the device stream`,
      ).toBe(iosDrags)
      if (iosDrags) draggable++
    }
    expect(draggable, 'no pair drags at all — this pin would pass on two dead files').toBe(1)
  })

  it('a dragged card can never carry its own close button off screen', () => {
    // The clamp is the reason PORTED, not an omission copied: iOS's overlay has no
    // bound, and a card flung past the edge takes the ✕ with it — while closing is
    // the only way to stop the glasses camera. So an unbounded drag leaves a user
    // with a running stream and no visible way to end it.
    const src = stripKt(card)
    // ⚠️ Read the two halves SEPARATELY. Measured: a mutant that inlined the same
    // arithmetic into the gesture — leaving `clampToBox` sitting there, correct and
    // uncalled — passed every pin below, because each one was matching the
    // DECLARATION. The seam is the property: the maths has to live where a JVM test
    // can drive it, and the card has to be the thing that calls it.
    const at = src.indexOf('\ninternal fun clampToBox(')
    expect(at, 'GlassesLiveCard.kt no longer declares clampToBox — the clamp lost its testable seam')
      .toBeGreaterThan(0)
    const drag = composableOf(src)
    const clamp = src.slice(at)
    expect(drag, 'the drag no longer calls clampToBox — whatever bounds it now is untestable')
      .toMatch(/clampToBox\(/)
    // The travel limits come from the LAYOUT, not from a hardcoded screen size —
    // a foldable, a split-screen window and a landscape phone all differ.
    expect(drag).toMatch(/BoxWithConstraints/)
    expect(drag).toMatch(/constraints\.hasBoundedWidth/)
    expect(drag).toMatch(/constraints\.hasBoundedHeight/)
    // ⚠️ AND THE CRASH: coerceIn(min, max) THROWS when min > max, so a card wider
    // than its box (landscape, freeform window, cover display) would take the chat
    // screen down on the first drag. The naive range must not appear.
    // (Read from the STRIPPED source: the comment above the clamp quotes the
    // naive line verbatim while explaining why it isn't there.)
    expect(
      clamp,
      'the clamp range is built without a maxOf floor — coerceIn throws when the card is bigger than its box',
    ).not.toMatch(/coerceIn\(\s*boxW - cardW/)
    expect(clamp).toMatch(/coerceIn\(-maxOf\(0f, boxW - cardW\)/)
    expect(clamp).toMatch(/coerceIn\(0f, maxOf\(0f, boxH - cardH\)\)/)
  })

  it('the clamp arithmetic is EXECUTED, not just read', () => {
    // A source pin cannot tell a working clamp from a plausible one, and the
    // inverted-range crash in particular only shows up when the numbers run.
    const jvm = read('android/app/src/test/java/technology/tiny/app/ui/GlassesCardDragTest.kt')
    expect(jvm).toContain('clampToBox(')
    for (const name of [
      'a card too big for its box does not crash',
      'no edge may cross the box it roams',
      'accumulated deltas land where a finger would leave it',
    ]) expect(jvm, `the drag test no longer covers: ${name}`).toContain(name)
  })
})

describe('glasses tools on VOICE calls — Android executes them locally', () => {
  const main = read('android/app/src/main/java/technology/tiny/app/MainActivity.kt')

  it('every meta_* tool the voice roster advertises has a runVoiceTool branch', () => {
    // Derived from the LIVE roster, not a hardcoded list: a future meta_*
    // voice tool with no local branch would fall through to the server
    // proxy, which cannot reach the glasses — every call would fail.
    const advertised = buildVoiceTools('tiny-android')
      .map((t) => t.name)
      .filter((n) => n.startsWith('meta_'))
    expect(advertised.length).toBeGreaterThanOrEqual(3)
    for (const name of advertised) expect(main).toContain(`"${name}"`)
  })

  it('the branch answers up the WS (a dropped tool_result stalls the turn)', () => {
    expect(main).toMatch(/meta_take_photo[\s\S]{0,1500}?liveCall\.sendToolResult/)
  })
})

describe('deep context — the agent reads the SAME facts from either phone', () => {
  const androidBridge = read('android/app/src/main/java/technology/tiny/app/fleet/Wearables.kt')
  const iosBridge = read('ios/Tiny/Sources/Wearables.swift')

  it('the agent-facing context phrases are identical (one model, two narrators)', () => {
    for (const phrase of [
      'linked to this phone, but none nearby right now',
      'what the user is LOOKING AT (their first-person camera)',
      'asleep/folded/out of range',
      'The user has the live glasses feed OPEN on their phone right now.',
      'Heard through the glasses moments ago (on-device transcript):',
    ]) {
      expect(androidBridge).toContain(phrase)
      expect(iosBridge).toContain(phrase)
    }
  })

  it('statusFacts carries the iOS keys: devices[], readyForCapture, liveHudOpen, recording', () => {
    for (const key of ['"readyForCapture"', '"liveHudOpen"', '"recording"', '"hasDisplay"']) {
      expect(androidBridge).toContain(key)
      expect(iosBridge).toContain(key)
    }
  })

  it('capture-readiness reads a LONG-LIVED selector (a newborn one knows nothing)', () => {
    // iOS c6: an AutoDeviceSelector discovers the active device by observing;
    // constructing one at ask-time always reads "not ready".
    expect(androidBridge).toMatch(/selector = AutoDeviceSelector\(\)/)
    expect(androidBridge).toMatch(/selector\?\.activeDevice\(\) != null/)
  })

  it('every capture rail OPENS its session with that same selector', () => {
    // 🔴 The defect this replaces: the assertions above were both satisfied by
    // the STATUS path alone, so they stayed green while all three capture rails
    // (photo, video, live HUD) each did `createSession(AutoDeviceSelector())`.
    // Measured in DAT 0.8.0's bytecode: `DeviceSelectorBase.<init>` builds its
    // state as `stateIn(…, Eagerly, null)` — initial value null, filled in later
    // off an IO dispatcher — and `WearablesImpl.createSession(DeviceSelector)`
    // returns NO_ELIGIBLE_DEVICE the instant `activeDevice()` is null. Every
    // capture therefore failed BY CONSTRUCTION, while readyForCapture() read the
    // long-lived selector two lines away and reported "ready" in the same
    // status payload. ASSIGNING the field was never the invariant — USING it is.
    const bridge = stripKt(androidBridge)
    expect(bridge.match(/AutoDeviceSelector\(\)/g)?.length, 'a second selector is being constructed')
      .toBe(1)
    expect(bridge, 'openSession no longer reads the long-lived selector').toMatch(/val live = selector \?:/)
    expect(bridge).toMatch(/Wearables\.createSession\(sel\)/)

    // The other two rails come through that one door and nowhere else.
    for (const rail of ['WearablesLive.kt', 'WearablesRecorder.kt']) {
      const code = stripKt(read(`android/app/src/main/java/technology/tiny/app/fleet/${rail}`))
      expect(code, `${rail} opens a session of its own again`).not.toMatch(/createSession\(/)
      expect(code, `${rail} does not go through WearablesBridge.openSession`)
        .toMatch(/WearablesBridge\.openSession\(/)
    }
  })

  it('the walk to a started session waits, retries ONCE, and cleans up (iOS parity)', () => {
    const bridge = stripKt(androidBridge)
    // Same two numbers as iOS, from the same measurement: the observer may not
    // have been handed its first value yet, and the SDK can answer
    // NO_ELIGIBLE_DEVICE once more while the link settles.
    expect(bridge).toMatch(/ACTIVE_DEVICE_WAIT_MS = 15_000L/)
    expect(bridge).toMatch(/SESSION_RETRY_DELAY_MS = 2_000L/)
    expect(iosBridge).toMatch(/waitForActiveDevice\(selector, seconds: 15\)/)
    expect(iosBridge).toMatch(/Task\.sleep\(nanoseconds: 2_000_000_000\)/)

    // A started session nobody holds makes the NEXT ask fail with
    // SESSION_ALREADY_EXISTS, so a failed start stops it before throwing.
    expect(bridge).toMatch(/catch \(t: Throwable\) \{\s*runCatching \{ session\.stop\(\) \}/)

    // Only NO_ELIGIBLE_DEVICE is retried; every other error keeps its own
    // description, because "not reachable" is the wrong answer to a thermal
    // shutdown — and both phones say the reachable one the same way.
    expect(bridge).toMatch(/retryableSessionError\(error\)/)
    for (const src of [androidBridge, iosBridge]) {
      expect(src).toContain('The glasses are linked but not reachable right now')
    }
  })

  it('a camera the user is already using answers with the HOLDER, not the SDK', () => {
    // Measured in DAT 0.8.0 (WearablesImpl.createSession): one session per
    // device, and any state but STOPPED answers SESSION_ALREADY_EXISTS — the
    // entry is inserted at createSession in state IDLE, so the window is the
    // whole walk to STARTED plus the holder's life. The live HUD holds it for
    // as long as its card is on screen, and there is no public accessor for a
    // session already open, so the ask is dead until the USER lets go.
    const bridge = stripKt(androidBridge)

    // The branch exists, and is reached from the failure path — not merely
    // declared. attemptSession is where the SDK's answer arrives.
    expect(bridge, 'SESSION_ALREADY_EXISTS is not handled at the failure site')
      .toMatch(/error == DeviceSessionError\.SESSION_ALREADY_EXISTS\)\s*\{[\s\S]{0,240}?cameraBusyMessage\(/)

    // It reads who holds it from state that already exists. A flag we SET
    // ourselves could be left on by a rail that died — then the camera reads
    // as busy forever, which is worse than the SDK's sentence.
    expect(bridge, 'the holder is claimed rather than derived')
      .toMatch(/cameraBusyMessage\(GlassesLive\.running\.value, GlassesRecorderBridge\.isRecording\)/)

    // Every branch names the glasses and ends with something to DO. Read off
    // the Kotlin rather than restated here, so the pin cannot drift from it.
    const fn = bridge.slice(bridge.indexOf('fun cameraBusyMessage('))
    const body = fn.slice(0, fn.indexOf('\n    }'))
    // One arm per `->`, with its literals rejoined — each sentence is written
    // as a concatenation, so matching literal-by-literal reads half an answer.
    const arms = body.split('->').slice(1)
      .map((seg) => (seg.match(/"[^"]*"/g) ?? []).join('').replace(/"/g, ''))
    expect(arms.length, 'the three holders collapsed into fewer answers').toBeGreaterThanOrEqual(3)
    for (const arm of arms) {
      expect(arm, `no remedy in ${arm}`).toMatch(/ask again|finish/)
      expect(arm, `SDK vocabulary leaked into ${arm}`).not.toMatch(/session/i)
    }
    expect(body, 'the live card is not named as the thing to close')
      .toContain('close the live card')

    // And the message the SDK would have given is gone from this path.
    expect(bridge).not.toMatch(/SESSION_ALREADY_EXISTS[\s\S]{0,200}?"session: \$\{error\.description\}"/)

    // EXECUTED, not just read: the arms are pinned in a JVM test too.
    const jvm = read('android/app/src/test/java/technology/tiny/app/fleet/WearablesSessionTest.kt')
    for (const title of [
      'the live feed holding the camera says so, and says how to get it back',
      'a recording in progress is not blamed on the live feed',
      'every holder gets a remedy, and none leaks SDK vocabulary',
    ]) {
      expect(jvm, `JVM coverage gone: ${title}`).toContain(title)
    }
  })

  it('BOTH phones name the holder — the same three answers, word for word', () => {
    // A pairing, not a one-sided pin: iOS had the identical gap (measured —
    // DeviceSessionError is a DatError, hence LocalizedError, so it too
    // answered with the SDK's true-but-unusable sentence), and after the port
    // the two clients must not drift. Either side losing an arm fails here.
    const ios = iosBridge
    expect(ios, 'iOS has no cameraBusy case to carry the reason')
      .toMatch(/case cameraBusy\(String\)/)
    expect(ios, 'the iOS reason never reaches errorDescription, so nothing renders it')
      .toMatch(/case \.cameraBusy\(let reason\): return reason/)

    // Mapped at BOTH createSession attempts, via the one helper. Mapping only
    // the first leaves the retry throwing the raw SDK error — the same bug,
    // reachable whenever eligibility flickers on the first try.
    expect(ios).toMatch(/catch DeviceSessionError\.sessionAlreadyExists \{[\s\S]{0,200}?cameraBusyMessage\(/)
    expect(
      ios.match(/createSessionNamingTheHolder\(wearables, selector\)/g)?.length,
      'only one of the two createSession attempts maps the busy camera',
    ).toBe(2)
    expect(ios, 'the holder is claimed rather than derived on iOS')
      .toMatch(/liveOpen: GlassesLive\.shared\.running,\s*recording: GlassesRecorder\.shared\.isRecording/)

    // The three sentences themselves, read off BOTH sources and compared. Not
    // restated here: a literal in this file would drift from both of them.
    const armsOf = (src: string, at: string, end: string) => {
      const fn = src.slice(src.indexOf(at))
      return (fn.slice(0, fn.indexOf(end)).match(/"[^"]{20,}"/g) ?? [])
        .map((s) => s.replace(/"/g, '').trim())
    }
    const kt = armsOf(stripKt(androidBridge), 'fun cameraBusyMessage(', '\n    }')
    const sw = armsOf(ios, 'static func cameraBusyMessage(', '\n    }')
    // Each platform writes them as two concatenated halves; join and compare
    // the whole sentences, so a reworded second half cannot hide.
    const join = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ')
    expect(sw.length, 'iOS lost an arm').toBe(kt.length)
    expect(join(sw), 'the two phones word the busy camera differently').toBe(join(kt))

    // EXECUTED on both sides: Kotlin JVM tests and Swift Testing, same titles.
    const swiftTests = read('ios/Tests/TinyTests.swift')
    expect(swiftTests, 'the Swift suite for this does not exist')
      .toContain('struct GlassesCameraBusyTests')
    for (const title of [
      'the live feed holding the camera says so, and says how to get it back',
      'a recording in progress is not blamed on the live feed',
      'every holder gets a remedy, and none leaks SDK vocabulary',
    ]) {
      expect(swiftTests, `Swift coverage gone: ${title}`).toContain(title)
    }
    // The one iOS-only property: a reason that never renders is a measurement
    // carried all the way to the user and then dropped.
    expect(swiftTests).toContain('the reason survives into what the agent and the card actually render')
  })
})

describe('the glasses-camera grant — Android ASKS for it, like iOS', () => {
  const SRC = 'android/app/src/main/java/technology/tiny/app'
  const androidBridge = read(`${SRC}/fleet/Wearables.kt`)
  const iosBridge = read('ios/Tiny/Sources/Wearables.swift')
  const consent = read(`${SRC}/fleet/GlassesCameraConsentActivity.kt`)

  /** Calls, not declarations — the definition sits in the same file as one caller. */
  const calls = (src: string, fn: string) =>
    new RegExp(`(?<!fun )\\b${fn}\\(`).test(stripKt(src))

  it('EVERY rail that opens a session asks first (derived from the rails)', () => {
    // 🔴 The gap: DAT 0.8.0 exposes the camera grant ONLY as
    // Wearables.RequestPermissionContract, an ActivityResultContract — there is no
    // `requestPermission` on the core object at all (measured with javap). So all
    // three Android rails could only CHECK, and every ungranted capture answered
    // "grant it in settings → meta glasses": a button on a phone the user wasn't
    // holding, in an app they weren't looking at, for a photo they'd just asked for
    // from web chat or mid-voice-call. iOS asks inline at all three.
    //
    // DERIVED from who opens a session, so a fourth rail cannot arrive silent.
    const rails = kotlinSources(SRC).filter((f) => calls(read(f), 'openSession'))
    expect(rails.length, 'no rail opens a session — this pin reads nothing').toBeGreaterThanOrEqual(3)
    for (const f of rails) {
      expect(
        calls(read(f), 'ensureCameraPermission'),
        `${f} opens a glasses session without ensuring the camera grant — an ungranted ` +
        `user gets a dead end instead of the prompt that would fix it`,
      ).toBe(true)
      // …and none of them still hands back the dead end as its own answer.
      expect(stripKt(read(f)), `${f} still answers with the settings dead-end`)
        .not.toMatch(/grant it (in|via) [^\n]*settings/)
    }
  })

  it('the ask is a real ask on both phones (contract here, requestPermission there)', () => {
    expect(stripKt(androidBridge)).toMatch(/GlassesCameraAsk\.refusal\(GlassesCameraAsk\.request\(/)
    expect(consent).toMatch(/registerForActivityResult\(Wearables\.RequestPermissionContract\(\)\)/)
    // iOS's shape, for the record: check, then request.
    expect(iosBridge).toMatch(/requestPermission\(\.camera\)/)
    for (const ios of ['Wearables.swift', 'WearablesRecorder.swift', 'WearablesLive.swift']) {
      expect(read(`ios/Tiny/Sources/${ios}`)).toMatch(/ensureCameraPermission\(\)/)
    }
  })

  it('the activity is declared, and NOT no-history (it awaits another app)', () => {
    const tag = manifest.match(/<activity[^>]*GlassesCameraConsentActivity[^>]*\/>/s)?.[0]
    expect(tag, 'the consent activity is not in the manifest — launching it throws').toBeTruthy()
    expect(tag!).toContain('android:exported="false"')
    expect(tag!).toContain('Theme.Translucent.NoTitleBar')
    // ⚠️ The one attribute NOT copied from ScreenshotConsentActivity: this activity
    // waits on a result from an activity in ANOTHER app (Meta AI), and a no-history
    // activity can be finished the moment that screen covers it — taking the result
    // callback with it, so a granted permission would read as "no answer" forever.
    expect(tag!, 'noHistory can destroy this activity before Meta AI answers it')
      .not.toContain('android:noHistory')
  })

  it('an unanswered prompt is never narrated as a refusal', () => {
    // ⚠️⚠️ MEASURED in mwdat-core 0.8.0: `RequestPermissionContract.parseResult`
    // returns success(Denied) for EVERYTHING that isn't a grant — a null intent, a
    // RESULT_CANCELED, a missing extra. "Declined", "backed out" and "dismissed"
    // arrive as ONE value, so no wording may pick one. Same invariant platform.ts
    // already holds for `screenshot`, and for the same reason: the model must not
    // tell someone they ignored a prompt they may never have seen.
    expect(consent).toMatch(/may have been declined/)
    expect(read('lib/chat/tools/platform.ts')).toMatch(/Do NOT tell the user they ignored a prompt/)
    // Executed, not just read — a source pin cannot prove a mapping.
    const jvm = read('android/app/src/test/java/technology/tiny/app/fleet/GlassesCameraAskTest.kt')
    expect(jvm).toMatch(/a refusal never claims the user said no/)
    expect(jvm).toMatch(/a late answer is not handed to the next ask/)
  })

  it('the ask window leaves room for the capture that follows it', () => {
    // Android's one deliberate divergence from iOS, whose await is UNBOUNDED: the
    // prompt lives in ANOTHER app here, so an unanswered one would hold the rail
    // until the server's own poll expired with nothing to tell the user. The window
    // plus the session walk must therefore fit INSIDE that poll — and the poll is
    // read from the tool that does it, not copied as a number.
    const platform = read('lib/chat/tools/platform.ts')
    const photoAt = platform.indexOf('export const makeMetaTakePhotoTool')
    expect(photoAt).toBeGreaterThan(0)
    const poll = platform.slice(photoAt).match(/for \(let i = 0; i < (\d+); i\+\+\) \{\s*\n\s*await new Promise\(r => setTimeout\(r, (\d+)\)\)/)
    expect(poll, 'meta_take_photo no longer polls in the shape this arithmetic assumes').toBeTruthy()
    const pollMs = Number(poll![1]) * Number(poll![2])

    const ms = (src: string, name: string) =>
      Number(src.match(new RegExp(`${name} = ([\\d_]+)L`))![1].replace(/_/g, ''))
    const walk = ms(androidBridge, 'ACTIVE_DEVICE_WAIT_MS') +
      ms(androidBridge, 'SESSION_RETRY_DELAY_MS') +
      ms(androidBridge, 'SESSION_START_TIMEOUT_MS')
    const window = ms(consent, 'ASK_WINDOW_MS')
    expect(window).toBeGreaterThan(0)
    expect(
      window + walk,
      `a ${window}ms ask plus a ${walk}ms session walk overruns the ${pollMs}ms poll — ` +
      `the user grants the camera and the tool has already given up`,
    ).toBeLessThan(pollMs)
  })
})

describe('the glasses still is CAPPED before it is uploaded (iOS parity)', () => {
  const SRC = 'android/app/src/main/java/technology/tiny/app'
  const androidBridge = read(`${SRC}/fleet/Wearables.kt`)
  const screenshot = read(`${SRC}/tools/Screenshot.kt`)
  const iosBridge = read('ios/Tiny/Sources/Wearables.swift')

  const num = (src: string, re: RegExp, what: string) => {
    const m = src.match(re)
    expect(m, `could not read ${what} — this pin is measuring nothing`).toBeTruthy()
    return Number(m![1])
  }

  it('every Android rail that JPEGs an image for upload caps its long side', () => {
    // 🔴 The gap: fleet/Wearables.kt was the ONLY one that didn't. It compressed the
    // glasses still at q90 with no downscale and shipped it base64'd inside a JSON
    // body — while the other three rails all capped (Screenshot 1600, chat/Attachments
    // 1568, ui/DmMedia 1568), and so did iOS's own glasses rail, whose comment reads
    // "Cap the long side like Screenshot".
    //
    // DERIVED from who compresses, so a fifth rail cannot arrive uncapped.
    const encoders = kotlinSources(SRC).filter((f) =>
      stripKt(read(f)).includes('CompressFormat.JPEG'))
    expect(encoders.length, 'nothing compresses a JPEG — this pin reads nothing')
      .toBeGreaterThanOrEqual(4)
    for (const f of encoders) {
      expect(
        stripKt(read(f)),
        `${f} encodes a JPEG with no long-side cap — an uncapped sensor frame is ` +
        `megabytes of base64 at a 6MB gate`,
      ).toMatch(/MAX_SIDE|MAX_DIM|maxSide/)
    }
  })

  it('there is exactly ONE place the glasses photo is compressed', () => {
    // Both PhotoData branches (Bitmap and HEIC) used to compress separately, which
    // is how one of them could have been capped and the other not. One encoder means
    // the cap cannot be half-applied.
    const sites = stripKt(androidBridge).match(/\.compress\(/g) ?? []
    expect(sites.length, `${sites.length} compress sites in the glasses bridge`).toBe(1)
    expect(stripKt(androidBridge)).toMatch(/is PhotoData\.Bitmap -> encode\(/)
  })

  it('the cap is the SAME number the phone\'s own screenshot rail uses', () => {
    // Read from Screenshot.kt, not copied: the two rails hand the same model the
    // same kind of image, and a silent drift between them is a silent quality
    // difference in the answers the user reads.
    const shotSide = num(screenshot, /encode\(bitmap, maxSide = (\d+), quality = (\d+)\)/, "Screenshot's cap")
    const shotQuality = Number(screenshot.match(/encode\(bitmap, maxSide = \d+, quality = (\d+)\)/)![1])
    expect(num(androidBridge, /PHOTO_MAX_SIDE = (\d+)/, "the glasses cap")).toBe(shotSide)
    expect(num(androidBridge, /PHOTO_QUALITY = (\d+)/, "the glasses quality")).toBe(shotQuality)
  })

  it('and the same one iOS caps the glasses photo at', () => {
    const iosSide = num(iosBridge, /jpeg\(image, maxSide: (\d+), quality: ([\d.]+)\)/, "iOS's glasses cap")
    const iosQuality = Number(iosBridge.match(/jpeg\(image, maxSide: \d+, quality: ([\d.]+)\)/)![1])
    expect(num(androidBridge, /PHOTO_MAX_SIDE = (\d+)/, 'the glasses cap')).toBe(iosSide)
    expect(num(androidBridge, /PHOTO_QUALITY = (\d+)/, 'the glasses quality')).toBe(iosQuality * 100)
  })

  it('the capped side fits under the worker\'s own upload gate', () => {
    // ⚠️ Not cosmetic: /media/upload gates at MEDIA_MAX_BYTES DECODED and answers
    // 400 "data must be valid base64 ≤6MB" — a string photoPayload hands the user
    // verbatim as the reason their photo failed. A 12MP still at q90 can reach it.
    const gate = num(
      read('worker/src/media.ts'),
      /MEDIA_MAX_BYTES = (\d+) \* 1024 \* 1024/,
      "the worker's upload gate",
    ) * 1024 * 1024
    const side = num(androidBridge, /PHOTO_MAX_SIDE = (\d+)/, 'the glasses cap')
    // Pessimistic 1 byte/pixel — a q80 JPEG is an order of magnitude under this.
    expect(side * side, `a ${side}px still could still overrun a ${gate}-byte gate`)
      .toBeLessThan(gate)
  })

  it('the scaling math is EXECUTED, not just read', () => {
    // ⚠️⚠️ The measurement behind the whole fix, recorded where the next reader of
    // this rail will look: javap on mwdat-camera 0.8.0 shows
    // StreamConfiguration.videoQuality is read only by StreamImpl.start and
    // StreamImpl.createVideoFormat — the VIDEO rail — and StreamImpl.capturePhoto
    // reads none of it. So the VideoQuality.LOW this app opens its stream with does
    // NOT shrink the photo, and "the stream is low-res already" is not a defence.
    expect(androidBridge).toMatch(/capturePhoto` reads none of it|capturePhoto\` reads none of it/)
    const jvm = read('android/app/src/test/java/technology/tiny/app/fleet/GlassesPhotoEncodeTest.kt')
    expect(jvm).toMatch(/a sensor-size glasses still is capped to the long side/)
    expect(jvm).toMatch(/a photo already inside the cap is left untouched/)
    expect(jvm).toMatch(/an extreme frame never scales a side to zero pixels/)
  })
})

describe('the Android-measured fixes, ported back to iOS', () => {
  const iosRec = read('ios/Tiny/Sources/WearablesRecorder.swift')
  const iosLive = read('ios/Tiny/Sources/WearablesLive.swift')

  it('iOS auto-stop clears its own handle BEFORE stop (self-cancellation)', () => {
    // stop()'s first line cancels autoStopTask; the auto-stop task IS that
    // task — without the nil-first ordering the upload throws
    // CancellationError and the clip surfaces as an error.
    //
    // ⚠️ ORDERING is the invariant, not the exact assignment text — three times
    // now this pin has failed on correct work (a park timestamp in c39, an epoch
    // guard in c40, the finalize/upload split in c41). So: the nil must come
    // first, and the only thing allowed between it and the stop/finalize call is
    // comments. A swap still fails, and so does anything executable slipping in
    // BEFORE it — which is where a re-introduced cancel would go.
    expect(iosRec).toMatch(
      /self\.autoStopTask = nil\n(?:\s*\/\/[^\n]*\n)*\s*(?:let \w+ = )?await self\.(?:stop\(token: token\)|finalizeClip\(\))/,
    )
    // …and the park still happens after that call, not before it.
    const nilAt = iosRec.indexOf('self.autoStopTask = nil')
    const stopAt = iosRec.search(/await self\.(?:stop\(token: token\)|finalizeClip\(\))/)
    const parkAt = iosRec.indexOf('self.pending = (')
    expect(nilAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(nilAt)
    expect(parkAt).toBeGreaterThan(stopAt)
  })

  it('the iOS muxer never sees time run backwards either', () => {
    expect(iosRec).toContain('CMTimeCompare(raw, last) <= 0')
  })

  it('both phones speak ONE tap-event language, and both streams feed it', () => {
    const androidEvents = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesEvents.kt')
    for (const phrase of [
      'the user TAPPED the glasses capture button (stream paused)',
      'the user TAPPED the glasses capture button again (stream resumed)',
    ]) {
      expect(iosLive).toContain(phrase)
      expect(androidEvents).toContain(phrase)
    }
    expect(read('ios/Tiny/Sources/Wearables.swift')).toContain('Recent glasses events')
    expect(iosRec).toContain('listenState(stream)')
  })

  it('micRoute honesty ships from BOTH phones, on BOTH listen branches', () => {
    // Each platform has two paths: its own recognizer session AND riding the
    // HUD's live transcriber — a branch without micRoute quietly reverts to
    // claiming glasses audio it can't vouch for.
    expect((iosLive.match(/"micRoute"/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const androidListener = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesListener.kt')
    expect((androidListener.match(/"micRoute"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(androidListener).toContain('BtMic.active')
  })

  it('BOTH phones spell the route the same two ways, from ONE place each', () => {
    // The agent compares this field across rails by string equality, so the
    // spelling IS the contract — "bt"/"headset"/"BLUETOOTH" would each be a
    // different fact to the reader, and each would look correct in its own file.
    // iOS single-sources it in `MicRoute` (Speech.swift, outside the MWDAT gate so
    // the take rail — which is not gated on the SDK — can reach it); Android in
    // `PhoneRecorder.route`.
    const ios = read('ios/Tiny/Sources/Speech.swift')
    expect(ios).toMatch(/enum MicRoute/)
    expect(ios).toMatch(/bt \? "bluetooth" : "phone"/)
    // …and the glasses rail must READ that one rather than keep its own copy.
    expect(iosLive).toMatch(/MicRoute\.current\(\)/)
    expect(
      iosLive.slice(iosLive.indexOf('private static func micRoute()')),
      'a second currentRoute read here is a second spelling waiting to drift',
    ).not.toMatch(/portType == \.bluetoothHFP/)
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt')
    expect(rec).toMatch(/fun route\(viaBluetooth: Boolean\): String = if \(viaBluetooth\) "bluetooth" else "phone"/)
    // Executed, not just read — a source pin cannot prove a spelling, so
    // PhoneRecorderTest asserts both words on the JVM.
    const jvm = read('android/app/src/test/java/technology/tiny/app/fleet/PhoneRecorderTest.kt')
    expect(jvm).toMatch(/route\(viaBluetooth = true\)/)
    expect(jvm).toMatch(/the route follows the LINK, not the rail that raised it/)
  })

  it('the iOS take reads its route BEFORE it deactivates the session', () => {
    // Same timing trap as Android's `finally`: `setActive(false)` hands the route
    // back to whatever the system falls back to — the built-in mic. One line later
    // and every take through the glasses reports "phone", with nothing to show it.
    const niclaRec = read('ios/Tiny/Sources/NiclaRecorder.swift')
    const readAt = niclaRec.indexOf('MicRoute.current()')
    expect(readAt).toBeGreaterThan(-1)
    // Against the deactivation that FOLLOWS the read, not the first in the file —
    // the early-return failure paths deactivate too, and they have no route to
    // read. If the read ever slid below its own teardown there would be no
    // deactivation left after it, and this lookup returns -1.
    const deactivateAt = niclaRec.indexOf('setActive(false', readAt)
    expect(
      deactivateAt,
      'no session deactivation follows the route read — the take reads a route the system already re-pointed at the built-in mic',
    ).toBeGreaterThan(-1)
    // …and nothing but comments between them, so a future line cannot be inserted
    // in the one gap where the answer is still true.
    expect(niclaRec.slice(readAt, deactivateAt)).toMatch(
      /^MicRoute\.current\(\)\n(?:\s*\/\/[^\n]*\n)*\s*try\? AVAudioSession\.sharedInstance\(\)\.$/,
    )
    // Carried on the result, and absent stays absent rather than becoming a claim.
    expect(niclaRec).toMatch(/let micRoute: String\?/)
    expect(niclaRec).toMatch(/micRoute: nil/) // the failure path knows nothing
  })

  it('the captured route survives the trip to the agent, on either app state', () => {
    // A take answers over the relay, and there are two writers: the foreground
    // poller and the background beat. A field on only one makes the reply depend on
    // whether the app happened to be backgrounded — the two-rail split again.
    const session = read('ios/Tiny/Sources/Session.swift')
    expect((session.match(/reply\["micRoute"\] = r/g) ?? []).length).toBe(2)
    // And the worker-side tool passes it up under the name the model was told.
    const tool = read('lib/chat/tools/nicla-voice.ts')
    expect(tool).toMatch(/mic_route: micRoute/)
    expect(tool).toMatch(/mic_route.*says which one actually heard this take/s)
    expect(
      tool,
      "the description still promises the phone's own mic — the claim c67 came to fix",
    ).not.toMatch(/records[^.]*through its own mic/)
  })
})

describe('tap events — derived, because DAT 0.8.0 ships no button API', () => {
  const events = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesEvents.kt')
  const bridge = read('android/app/src/main/java/technology/tiny/app/fleet/Wearables.kt')

  it('the tap rule is single-sourced: STREAMING↔PAUSED on an active stream', () => {
    expect(events).toMatch(/from == StreamState\.STREAMING && to == StreamState\.PAUSED/)
    expect(events).toMatch(/from == StreamState\.PAUSED && to == StreamState\.STREAMING/)
  })

  it('EVERY stream owner feeds the rule — the live HUD and the recorder', () => {
    // A stream that pauses without recording the transition silently eats
    // the user's tap; each owner must wire its state flow through.
    for (const owner of ['WearablesLive.kt', 'WearablesRecorder.kt']) {
      expect(read(`android/app/src/main/java/technology/tiny/app/fleet/${owner}`))
        .toContain('GlassesEvents.onStreamTransition')
    }
  })

  it('the agent can actually see the taps: context line AND status tool', () => {
    expect(bridge).toMatch(/GlassesEvents\.recent\(\)/)
    expect(bridge).toContain('Recent glasses events')
    expect(bridge).toContain('recentEvents')
  })
})

describe('the SDK dependency', () => {
  it('is pinned in the version catalog', () => {
    expect(catalog).toMatch(/^mwdat = "0\.8\.0"$/m)
    for (const artifact of ['mwdat-core', 'mwdat-camera', 'mwdat-mockdevice']) {
      expect(catalog).toContain(`name = "${artifact}", version.ref = "mwdat"`)
    }
  })

  it('the release build ships ARM only — the SDK adds ~18MB of emulator ABIs', () => {
    expect(gradle).toMatch(/abiFilters \+= listOf\("arm64-v8a", "armeabi-v7a"\)/)
  })

  it('core+camera ship; the mock device rides DEBUG builds only', () => {
    expect(gradle).toMatch(/^\s*implementation\(libs\.mwdat\.core\)/m)
    expect(gradle).toMatch(/^\s*implementation\(libs\.mwdat\.camera\)/m)
    expect(gradle).toMatch(/^\s*debugImplementation\(libs\.mwdat\.mockdevice\)/m)
    expect(gradle).not.toMatch(/^\s*implementation\(libs\.mwdat\.mockdevice\)/m)
  })

  it('the GitHub Packages repo is scoped to the SDK group and reads its token from the env', () => {
    expect(settings).toContain('maven.pkg.github.com/facebook/meta-wearables-dat-android')
    expect(settings).toContain('includeGroup("com.meta.wearable")')
    expect(settings).toContain('System.getenv("GITHUB_TOKEN")')
  })

  it('no token is hardcoded anywhere in the gradle wiring (public-repo rule)', () => {
    // GitHub token shapes: classic ghp_…, fine-grained github_pat_…, and the
    // older 40-hex form. This tree is destined to be ported to a public repo.
    for (const source of [settings, gradle, catalog]) {
      expect(source).not.toMatch(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}/)
    }
  })
})
