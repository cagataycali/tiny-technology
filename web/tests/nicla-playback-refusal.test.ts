// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * 🎧 "in ios app we will be able to listen all the speech + transcription directly."
 *
 * The transcripts screen had a Play button and no way to fail. `toggle(_:)` was:
 *
 *     let p = AVPlayer(url: url)
 *     endObserver = …addObserver(forName: .AVPlayerItemDidPlayToEndTime …)
 *     p.play()
 *
 * ⚠️ `.AVPlayerItemDidPlayToEndTime` IS THE ONE NOTIFICATION A REFUSAL CANNOT
 * FIRE. `/media/:key` declines two ways — 424 `media store not provisioned`, 404
 * `not found` — and an offline phone fails a remote asset outright. All three fail
 * the item at LOAD, so it never begins playing and never plays to its end. The row
 * was left reading "Stop" over a take that made no sound, with nothing on screen
 * saying why, and the ONLY way out was a second tap.
 *
 * ⚠️ WHAT MAKES THIS ITS OWN CLASS: this app has already learned the entire
 * lesson, twice, in the two files either side of this one.
 *
 *   1. `/voice/recording` → "iOS won't play call recordings". Fixed with
 *      `observe(\.status)` + `CallRecordingRefusal`, and
 *      `tests/voice-playback-refusal.test.ts` writes the rule down: *a media
 *      player handed a 413 with a JSON body has exactly one thing to say, which
 *      is nothing.*
 *   2. That fix's OTHER half — Range/Content-Length — later reached `/media/:key`
 *      too, precisely because NiclaRecorder uploads its takes there
 *      (`tests/media-range.test.ts`). So the second visit to this exact route
 *      carried the seekability fix across and left the error channel behind.
 *
 * A fix lands where the symptom was reported. The symptom was "won't play at all",
 * and the answer to "plays but can't say why" was already written in the file next
 * door.
 *
 * These pins are keyed on the WORKER's refusal literals, extracted from
 * `MediaGetCall.handle`, so a third refusal added upstream fails here instead of
 * quietly becoming the generic sentence.
 */

const ROOT = process.cwd()
const IOS = join(ROOT, 'ios/Tiny/Sources/NiclaRecorder.swift')
const CALLS = join(ROOT, 'ios/Tiny/Sources/VoiceCall.swift')

const read = (p: string) => readFileSync(p, 'utf8')

/** Comments stripped: a rule explained in prose must not satisfy an assertion.
 *  (Every fix in this file quotes the code it replaced, which is what makes it
 *  reviewable and what would otherwise make a whole-file scan pass on the
 *  documentation of the bug.) */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\/\/\/).*$/gm, '')

const iosSrc = read(IOS)
const ios = code(iosSrc)

/** The body of a Swift func/enum from its opening brace, brace-matched.
 *  Unbounded `slice(indexOf(…))` over a 2000-line file matches almost anything
 *  downstream — a `.not.toMatch` is only as scoped as its slice. */
const braceBody = (src: string, at: number) => {
  const open = src.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(open, i)
}

const toggleBody = () => {
  const at = ios.indexOf('private func toggle(_ t: NiclaTranscript)')
  expect(at, 'toggle(_ t: NiclaTranscript) not found — every pin below is blind')
    .toBeGreaterThan(-1)
  return braceBody(ios, at)
}

describe('the error channel the screen never had', () => {
  it('⚠️ observes the item STATUS — the only channel a load refusal uses', () => {
    // A pin on the wrong channel would certify a fix that cannot work: this is
    // the distinction the sibling suite spells out for VoiceCall.
    expect(ios, 'the player item status is never observed — a refusal goes unread')
      .toMatch(/observe\(\\\.status/)
    expect(ios, 'the failed state is never checked').toMatch(/item\.status == \.failed/)
  })

  it('⚠️ the observation is installed BEFORE play() — a fast refusal is decided by the server', () => {
    // A 424 needs no bytes to decide. Installing the observation after `play()`
    // is a race that loses exactly the fastest failures.
    const t = toggleBody()
    const obs = t.indexOf('observe(\\.status')
    const play = t.indexOf('p.play()')
    expect(obs, 'no status observation inside toggle').toBeGreaterThan(-1)
    expect(play, 'no play() inside toggle').toBeGreaterThan(-1)
    expect(obs, 'the observation is installed after play() — a server refusal is lost')
      .toBeLessThan(play)
  })

  it('⚠️ the per-row error is cleared BEFORE the observation, not after', () => {
    // Clearing after would erase the sentence the observation just recorded —
    // the mistake the Android twin was pinned against in the sibling suite.
    const t = toggleBody()
    const clear = t.indexOf('playError[t.id] = nil')
    const obs = t.indexOf('observe(\\.status')
    expect(clear, 'the stale reason from a previous attempt is never cleared').toBeGreaterThan(-1)
    expect(clear, 'the clear runs after the observation and erases a fresh refusal')
      .toBeLessThan(obs)
  })

  it('⚠️ it stops claiming the row is playing', () => {
    // Half of what made this invisible: a "Stop" button asserts "playing" over a
    // transport frozen at 0:00.
    const t = toggleBody()
    const obs = t.slice(t.indexOf('observe(\\.status'), t.indexOf('endObserver ='))
    expect(obs.length, 'the observation block moved — this pin reads nothing').toBeGreaterThan(80)
    expect(obs, 'a failed play leaves playingId set — the Stop button lies')
      .toMatch(/stopPlayback\(\)/)
  })

  it('⚠️ the captured reason is DRAWN', () => {
    // A field pin and a decode pin both pass while the render is a no-op. The
    // whole finding is a surface that knew something and showed nothing.
    expect(ios, 'the refusal is captured and never rendered')
      .toMatch(/if let why = playError\[t\.id\]/)
    expect(ios, 'the row does not render the reason it captured')
      .toMatch(/Text\("⚠️ \\\(why\)"\)/)
  })

  it('⚠️ the observation is invalidated where it was installed, and on teardown', () => {
    // A KVO observation writing @State into a dismissed view is a leak, and a
    // second play would stack another one on the same row.
    const stop = braceBody(ios, ios.indexOf('private func stopPlayback()'))
    expect(stop, 'the status observation outlives the playback that installed it')
      .toMatch(/failObserver\?\.invalidate\(\)/)
    // onDisappear already calls stopPlayback(), which is the single teardown —
    // pinned so a future edit cannot make it a partial one.
    expect(ios, 'the view no longer tears playback down on disappear')
      .toMatch(/\.onDisappear \{ stopPlayback\(\) \}/)
    // And a second play must not stack: toggle() routes through stopPlayback()
    // before installing anything.
    const t = toggleBody()
    expect(t.indexOf('stopPlayback()'), 'a second play installs a second observation')
      .toBeLessThan(t.indexOf('observe(\\.status'))
  })
})

describe('offline is named, and only where it is the cause', () => {
  it('the rule reads the reachability monitor rather than guessing', () => {
    expect(ios, 'the refusal never consults reachability').toMatch(/online: net\.online/)
    expect(ios, 'the view does not observe the reachability store')
      .toMatch(/@ObservedObject private var net = Net\.shared/)
  })

  it('⚠️ `remote` is PASSED, never inferred from the error', () => {
    // A missing local file and a 404 produce descriptions nothing can reliably
    // tell apart, and an m4a on this disk plays with the radio off. Only the
    // scope that chose the URL knows which it handed over.
    const t = toggleBody()
    expect(t, 'the local/remote distinction is not carried to the refusal rule')
      .toMatch(/let remote = local == nil/)
    expect(t, 'the refusal rule is called without saying whether the asset was remote')
      .toMatch(/remote: remote/)
  })

  it('the offline sentence points at the server, not at playback', () => {
    const decl = iosSrc.slice(iosSrc.indexOf('static let offline'))
    expect(decl.slice(0, 200), 'the offline sentence stopped naming where the audio is')
      .toMatch(/on the server/)
  })
})

describe('listening, not just starting', () => {
  it('a playing take can be scrubbed', () => {
    // A 120-second memo could only be played from the beginning: to re-hear one
    // sentence you listened to the whole thing again. That is the difference
    // between "the audio is here" and "you can listen to it".
    expect(ios, 'there is no transport — a take can only be started')
      .toMatch(/Slider\(value: \$elapsed, in: 0 \.\.\. total\)/)
    expect(ios, 'the slider never seeks the player').toMatch(/player\?\.seek\(to: CMTime\(seconds: elapsed/)
    expect(ios, 'no periodic observer, so the transport never moves')
      .toMatch(/addPeriodicTimeObserver/)
  })

  it('⚠️ a scrub is not fought by the ticker', () => {
    // Without the guard the thumb jumps out from under the finger twice a second.
    expect(ios, 'the transport tick overwrites the position mid-scrub')
      .toMatch(/guard !scrubbing else \{ return \}/)
  })

  it('⚠️ the ASSET\'s duration wins once known', () => {
    // `total` starts from the row's own `seconds` so the transport draws on the
    // first tick, but a remote m4a's real length can differ from what the take
    // recorded — and a slider whose end is wrong seeks to the wrong place.
    expect(ios, 'the transport never refines its length from the asset')
      .toMatch(/if let d = p\.currentItem\?\.duration\.seconds, d\.isFinite, d > 0 \{ total = d \}/)
  })

  it('the periodic observer is removed, on the same path as everything else', () => {
    // `addPeriodicTimeObserver` retains its block until removed; leaking one
    // keeps the player alive writing @State into a dismissed view.
    const stop = braceBody(ios, ios.indexOf('private func stopPlayback()'))
    expect(stop, 'the periodic time observer is never removed')
      .toMatch(/player\?\.removeTimeObserver\(timeObserver\)/)
  })

  it('the button and the transport speak clock time, not raw seconds', () => {
    // "Play 118s" is a number the reader has to divide. Every other recording
    // surface in this app already says 1:58 (VoiceCall's clock, Android's
    // sizeLine).
    expect(ios, 'the Play button reports raw seconds again')
      .toMatch(/Play \\\(clock\(Double\(t\.seconds\)\)\)/)
    const clockFn = braceBody(ios, ios.indexOf('private func clock(_ t: Double)'))
    expect(clockFn, 'the clock helper no longer zero-pads — 1:5 is not a duration')
      .toMatch(/%02d/)
  })

  it('⚠️ the lock screen names the take, and can pause it', () => {
    // The app runs the `audio` background mode, so a playing take continues when
    // the phone locks. Without these it is a mystery sound with no pause button:
    // the person is hearing a recording of their own room and nothing says which.
    expect(ios, 'no remote command targets — a locked phone cannot pause the take')
      .toMatch(/MPRemoteCommandCenter\.shared\(\)/)
    expect(ios, 'the lock screen cannot seek').toMatch(/changePlaybackPositionCommand/)
    expect(ios, 'the now-playing entry is never populated').toMatch(/nowPlayingInfo = info/)
    // The WORDS, not the label: "wake: hey tiny" names the trigger and tells you
    // nothing about which of six takes this is.
    expect(ios, 'the lock screen titles the take by its trigger instead of its words')
      .toMatch(/MPMediaItemPropertyTitle: String\(t\.text\.prefix\(\d+\)\)/)
    // And cleared on stop, or a finished take sits on the lock screen forever.
    const stop = braceBody(ios, ios.indexOf('private func stopPlayback()'))
    expect(stop, 'the now-playing entry outlives the playback').toMatch(/clearNowPlaying\(\)/)
  })

  it('⚠️ the remote-command handlers hop to the MainActor', () => {
    // The command centre invokes them on its own queue, and player/elapsed are
    // MainActor view state — the c9 rule this app pays for in SIGTRAPs.
    const install = braceBody(ios, ios.indexOf('private func installRemoteCommands()'))
    const targets = install.match(/addTarget \{/g) || []
    expect(targets.length, 'no remote command targets registered').toBeGreaterThanOrEqual(3)
    const hops = install.match(/Task \{ @MainActor in/g) || []
    expect(hops.length, 'a remote command touches view state off the main actor')
      .toBeGreaterThanOrEqual(targets.length)
  })
})

describe('the two screens agree, or one of them lies', () => {
  it('the generic sentence is the SAME constant, not a matching copy', () => {
    // Two screens telling a person two different things about the same outcome is
    // how "couldn't play" stops being trusted. A duplicated literal would pass a
    // toContain pin on both files while drifting on the next edit.
    expect(ios, 'the transcripts screen keeps its own copy of the generic sentence')
      .toMatch(/static let unknown = CallRecordingRefusal\.unknown/)
    expect(code(read(CALLS)), 'the call screen no longer defines the shared sentence')
      .toMatch(/static let unknown = "couldn't play this recording"/)
  })

  it('⚠️ neither map falls through for a refusal the other covers', () => {
    // `media store not provisioned` is the ONE refusal both routes can give (R2
    // is unbound for both), so both must say the same thing about it — the
    // cross-platform agreement pin, applied across screens instead of phones.
    const sentence = 'recordings are unavailable right now'
    expect(iosSrc, 'the transcripts map lost the shared R2-outage sentence')
      .toContain(`"${sentence}"`)
    expect(read(CALLS), 'the calls map lost the shared R2-outage sentence')
      .toContain(`"${sentence}"`)
    // Reachable, not merely present: a swap keeps both strings in the file.
    expect(iosSrc, 'the transcripts map points the R2 refusal at a different sentence')
      .toMatch(new RegExp(`"media store not provisioned",\\s*"${sentence}"`))
  })
})

describe.skipIf(!present)('the map is keyed on the worker, not on my memory', () => {
  warnIfWorkerAbsent('nicla-playback-refusal')

  let mediaSrc = ''
  beforeAll(() => {
    mediaSrc = readFileSync(workerFile('media.ts'), 'utf8')
  })

  /** Every `json({ error: "…" }, 4xx)` inside `MediaGetCall.handle` — read out of
   *  the worker rather than listed here. `json({error})` appears all over that
   *  file and a refusal from the UPLOAD route is not this map's business, so the
   *  scan is sliced to the GET handler. */
  const routeRefusals = () => {
    const src = code(mediaSrc)
    const cls = src.indexOf('export class MediaGetCall')
    expect(cls, 'MediaGetCall not found — this extractor is blind').toBeGreaterThan(-1)
    const end = src.indexOf('\nexport ', cls + 10)
    const body = src.slice(cls, end > cls ? end : undefined)
    const out: string[] = []
    const re = /json\(\{\s*error:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*,\s*(\d{3})\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) out.push(m[1])
    return [...new Set(out)]
  }

  it('⚠️ EVERY refusal /media/:key can give has a sentence in the app', () => {
    const refusals = routeRefusals()
    // The did-I-read-anything assertion: an extractor matching nothing makes
    // every expectation below pass on an empty list, forever.
    expect(refusals.length, 'extracted no refusal literals — this suite is blind')
      .toBeGreaterThanOrEqual(2)
    const map = iosSrc.slice(iosSrc.indexOf('private static let refusals'))
    const table = map.slice(0, map.indexOf('\n    ]'))
    for (const reason of refusals) {
      expect(
        table,
        `/media/:key refuses with "${reason}" and NiclaPlaybackRefusal does not ` +
        `recognise it — the row now says "couldn't play this recording" for a ` +
        `cause the route stated plainly`,
      ).toContain(`"${reason}"`)
    }
  })

  it('the refusals are still REFUSALS — statuses, not a 200 with an error field', () => {
    // A 2xx would be handed to the decoder as audio and the whole error path
    // above would never run.
    const src = code(mediaSrc)
    const cls = src.indexOf('export class MediaGetCall')
    const end = src.indexOf('\nexport ', cls + 10)
    const body = src.slice(cls, end > cls ? end : undefined)
    const statuses = Array.from(body.matchAll(/json\(\{\s*error:[^}]*\}\s*,\s*(\d{3})\s*\)/g))
      .map((m) => Number(m[1]))
    expect(statuses.length, 'no refusal statuses extracted — blind').toBeGreaterThanOrEqual(2)
    for (const s of statuses) {
      expect(s, `MediaGetCall answers ${s} for a refusal — a 2xx would be played as audio`)
        .toBeGreaterThanOrEqual(400)
    }
  })

  it('the premise holds: this route is what a remote take plays from', () => {
    // If uploads stopped landing in MEDIA, this whole map would be about a route
    // the transcripts screen never touches.
    expect(mediaSrc, 'the media store no longer serves audio/mp4 — takes go elsewhere now')
      .toMatch(/"audio\/mp4":\s*"m4a"/)
    expect(iosSrc, 'the recorder no longer uploads takes to /api/media')
      .toMatch(/Api\.post\("\/api\/media"/)
  })
})
