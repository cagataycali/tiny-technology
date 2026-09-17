// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎥 An auto-stopped clip does not wait forever.
 *
 * meta_record_video is the only TOGGLE tool in the fleet: the agent's first
 * call starts a recording, its second stops it. But the clip also stops ITSELF
 * at ~28s (the media store's 6MB cap), and that finished clip was parked in
 * `pending` with NO expiry on either phone — so the next meta_record_video
 * call, at any distance in time, collected it. Ask for a recording tomorrow
 * and you get yesterday's, described as if it were the moment you just asked
 * about. That is the P2.5 defect (a grant applied to a moment it was never
 * given for) transposed onto video, and it survived three cycles of consent
 * work because nothing here asks a human anything.
 *
 * Pinned across all three surfaces, because a fix in one is invisible in the
 * others: the two phones must expire on the SAME clock and say the SAME thing,
 * and the server must not swallow what they say — its START leg used to
 * overwrite the device's note with a literal, which would have made the
 * discard silent again at the last hop.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ios = read('ios/Tiny/Sources/WearablesRecorder.swift')
const android = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
const platform = read('lib/chat/tools/platform.ts')

/**
 * Slice a named region and PROVE it was found — an `indexOf` miss returns -1,
 * and `slice(-1)` hands back the last character, which is truthy and matches
 * nothing. Every vacuous pin in this loop has had that shape (c34 M1, c36 N10).
 */
const region = (src: string, from: string, to: string, label: string) => {
  const at = src.indexOf(from)
  expect(at, `${label}: could not find "${from}"`).toBeGreaterThan(-1)
  const end = src.indexOf(to, at + from.length)
  expect(end, `${label}: could not find the end anchor "${to}"`).toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('an auto-stopped clip expires instead of waiting forever', () => {
  it('iOS parks the clip WITH a timestamp, so it cannot be stored unstamped', () => {
    // The stamp lives in the same value as the parked artefact — two separate
    // fields would let a future assignment site park and forget the clock.
    // ⚠️ The PAIRING is the invariant, not the element type: c41 changed what is
    // parked (a `Parked` enum holding raw bytes, no longer an uploaded payload)
    // because an uploaded clip nobody collects can never be reclaimed. A single
    // un-paired field still fails.
    expect(ios, 'pending lost its timestamp — a bare payload cannot expire')
      .toMatch(/private var pending:\s*\(\w+:\s*\w+(?:\[[^\]]*\])?,\s*at:\s*Date\)\?/)
    const autoStop = region(ios, 'autoStopTask = Task', 'return ["ok": true, "recording": true]', 'iOS auto-stop')
    // The STAMP is the invariant, not the one-liner: c40 split the upload into a
    // local so a sign-out guard could sit between it and the park, and c41
    // replaced the uploaded payload with finalized bytes. Any shape is fine as
    // long as `Date()` goes in WITH the artefact — a park with no second tuple
    // element, or a fixed date, fails.
    expect(autoStop, 'the auto-stop parks a clip without stamping when it was parked')
      .toMatch(/self\.pending = \(\w+, Date\(\)\)/)
    // …and the auto-stop must FINALIZE (close the MP4), which is the half that
    // is genuinely forced at 28s.
    expect(autoStop, 'the auto-stop no longer finalizes the clip')
      .toContain('await self.finalizeClip()')
  })

  it('iOS refuses to collect a clip older than the TTL, and starts fresh instead', () => {
    const toggle = region(ios, 'func toggle(token: String?) async', 'private func start(', 'iOS toggle')
    expect(toggle, 'the TTL is not checked at collect time — a stale clip is still returned')
      .toMatch(/Date\(\)\.timeIntervalSince\(done\.at\)\s*<\s*Self\.pendingTTL/)
    // Expiry must FALL THROUGH to a new recording, not return an error and not
    // return the stale payload: the user asked for a recording either way.
    expect(toggle, 'an expired clip no longer starts a new recording')
      .toMatch(/await start\(token: token\)/)
    expect(toggle, 'the agent is not told the old clip was discarded')
      .toContain('Self.staleNote')
  })

  it('Android does the same, on the same clock', () => {
    // Paired with its stamp, same as iOS — the element type changed in c41
    // (`Parked`, holding un-uploaded bytes), the pairing did not.
    expect(android, 'Android pending lost its park timestamp')
      .toMatch(/private var pending:\s*Pair<\w+,\s*Long>\?/)
    const toggle = region(android, 'internal suspend fun toggle(', 'private suspend fun start(', 'Android toggle')
    expect(toggle, 'Android does not check the TTL at collect time')
      .toMatch(/System\.currentTimeMillis\(\)\s*-\s*parkedAt\s*<\s*PENDING_TTL_MS/)
    expect(toggle, 'Android does not start a new recording when the clip expired')
      .toMatch(/return start\(app\)/)
    expect(toggle, 'Android does not tell the agent the old clip was discarded')
      .toContain('STALE_NOTE')
    const auto = region(android, 'delay(MAX_SECONDS * 1000)', 'private fun encode(', 'Android auto-stop')
    expect(auto, 'Android parks a clip without stamping it')
      .toMatch(/pending = \w+\(\) to System\.currentTimeMillis\(\)/)
    expect(auto, 'the Android auto-stop no longer finalizes the clip').toContain('finalize()')
  })

  it('both phones expire on the SAME window, and it outlasts the recording itself', () => {
    const iosTtl = Number(ios.match(/static let pendingTTL: TimeInterval = (\d+)/)?.[1])
    const androidTtl = Number(android.match(/const val PENDING_TTL_MS = ([\d_]+)L/)?.[1]?.replace(/_/g, ''))
    expect(iosTtl, 'iOS pendingTTL unreadable').toBeGreaterThan(0)
    expect(androidTtl, 'Android PENDING_TTL_MS unreadable').toBeGreaterThan(0)
    expect(androidTtl, 'the phones expire an uncollected clip on different clocks')
      .toBe(iosTtl * 1000)

    // Lower bound that MATTERS: a clip must still be collectable after the
    // auto-stop that made it, plus a human composing the next message. A TTL
    // at or under maxSeconds would expire clips that just finished.
    const maxSeconds = Number(ios.match(/static let maxSeconds: Double = (\d+)/)?.[1])
    expect(maxSeconds, 'maxSeconds unreadable').toBeGreaterThan(0)
    expect(iosTtl, 'the TTL is short enough to expire a clip that just auto-stopped')
      .toBeGreaterThan(maxSeconds)
    expect(androidTtl, "Android's auto-stop is not the one the TTL was sized against")
      .toBeGreaterThan(Number(android.match(/const val MAX_SECONDS = (\d+)L/)?.[1]) * 1000)
  })

  it('the discard notice is identical on both phones — one wording, one meaning', () => {
    const iosNote = ios.match(/static let staleNote = "([^"]+)"/)?.[1]
    expect(iosNote, 'iOS staleNote unreadable').toBeTruthy()
    // Kotlin splits it across a `"…" + "…"` concatenation, so collapse the
    // pieces rather than matching one literal (a greedy match here ran past
    // the declaration and swallowed half the file).
    const androidDecl = region(android, 'const val STALE_NOTE', 'val isRecording', 'Android note')
    const androidNote = (androidDecl.match(/"[^"]*"/g) ?? []).map(s => s.slice(1, -1)).join('')
    expect(androidNote, 'Android STALE_NOTE unreadable').toBeTruthy()
    expect(androidNote, 'the phones describe a discarded clip differently').toBe(iosNote)

    // It must say the clip is GONE and that a new recording is running. "It
    // expired" alone would leave the agent thinking one more call collects it.
    expect(iosNote, 'the notice never says the old clip was discarded').toMatch(/discard/i)
    expect(iosNote, 'the notice never says a NEW recording started').toMatch(/new recording/i)
  })
})

describe('the server does not swallow what the phone said on a start', () => {
  it('the START leg carries the device note instead of overwriting it', () => {
    const startLeg = region(platform, '// START leg:', '// STOP leg:', 'record_video start leg')
    expect(startLeg, 'did not slice the start leg').toContain('p.recording')
    // The bug this pins: `note:` was a hardcoded literal, so a phone reporting
    // a discarded clip on the same payload would have been silently dropped.
    expect(startLeg, 'the start leg ignores the note the device posted')
      .toMatch(/p\.note/)
    expect(startLeg, 'the device note is not actually included in the returned note')
      .toMatch(/note:\s*carried\s*\?/)
    expect(startLeg, 'the "recording started" text was dropped instead of appended to')
      .toContain('Recording started on the glasses')
  })

  it('an empty or absent device note does not leave stray whitespace', () => {
    const startLeg = region(platform, '// START leg:', '// STOP leg:', 'record_video start leg')
    // `typeof … === 'string'` guards a non-string note; .trim() makes ""
    // falsy so the join is skipped rather than producing a leading blank line.
    expect(startLeg, 'a non-string device note is not guarded')
      .toMatch(/typeof p\.note === 'string'/)
    expect(startLeg, 'an empty note is not treated as absent').toMatch(/\.trim\(\)/)
  })
})
