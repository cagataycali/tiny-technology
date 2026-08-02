// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎙️ The Nicla Voice recorder's stop path, checked at the source level.
 *
 * A take is a real microphone, a real speech recognizer and a wall-clock sleep,
 * so it cannot be unit-tested in this suite. What CAN be pinned is the handful
 * of source-level properties whose violation is silent and expensive:
 *
 *   - the take must sleep in slices, not one uninterruptible sleep to the
 *     deadline, or Stop cannot work at all
 *   - the stored duration must be the MEASURED one, not the requested one —
 *     otherwise a take stopped after 4s is labelled 120s everywhere it appears
 *     (the list, the server row, the agent's context)
 *   - the early-stop flag must be cleared when a take CLAIMS the mic, not only
 *     when one ends: a stop landing just after a take finishes would otherwise
 *     sit set and kill the NEXT take on its first tick
 *   - stopEarly() must be a request, not a teardown, so the take's own tail
 *     (finalize container → transcribe → upload → store) still runs
 *
 * Source-shape assertions are usually a smell, but each of these failures is
 * invisible in review and only reproducible with a phone in hand.
 */
const SRC = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')

describe('NiclaRecorder — a take can be stopped early', () => {
  it('exposes stopEarly() and guards it on a take being in progress', () => {
    expect(SRC).toMatch(/func stopEarly\(\)/)
    // Without the guard, a stop with no take running leaves the flag set and
    // the next take dies immediately.
    const fn = SRC.slice(SRC.indexOf('func stopEarly()'))
    expect(fn.slice(0, 200)).toMatch(/guard isRecording else \{ return \}/)
  })

  it('sleeps in slices so the stop request is actually observed', () => {
    // The old shape — one sleep straight to the deadline — made the duration a
    // promise the user could not take back.
    expect(SRC).not.toMatch(/Task\.sleep\(nanoseconds: UInt64\(clamped\)/)
    // Re-anchored: the loop condition is no longer a bare deadline compare, it is
    // the extension rule (`while Self.shouldExtend(…)` — see
    // ios-wake-take-extends.test.ts). The invariant THIS test exists for is
    // unchanged and is what is pinned: the take ticks in short slices, and Stop is
    // consulted on every one of them.
    expect(SRC, 'the take no longer sleeps in slices — a Stop cannot be observed')
      .toMatch(/try\? await Task\.sleep\(for: \.milliseconds\(200\)\)/)
    expect(SRC, 'the loop condition no longer reads stopRequested at all')
      .toMatch(/lastGrowthAt: lastGrowthAt, stopRequested: stopRequested\) \{/)
    // And the rule honours it FIRST, ahead of the cap and the grace: a user's Stop
    // outranks a speaker who is still talking. (The rule's own cases live in Swift;
    // this is the one line that decides Stop cannot be outvoted.)
    expect(SRC, 'Stop is no longer the first thing the stop rule checks')
      .toMatch(/if stopRequested \{ return false \}/)
  })

  it('clears the stop flag where the mic is CLAIMED, not only after a take', () => {
    // Anchor on the STATEMENT, not the prose. A plain indexOf('isRecording =
    // true') matches the comment above it first (which quotes the old code), and
    // the assertion then reads the wrong region — it failed that way on the
    // first run.
    const claim = SRC.search(/^ +isRecording = true$/m)
    expect(claim).toBeGreaterThan(-1)
    const after = SRC.slice(claim, claim + 400)
    expect(after).toMatch(/stopRequested = false/)
  })

  it('stores the MEASURED duration, never the requested one', () => {
    // Re-anchored: the ceiling is `Self.maxSeconds`, not `clamped`. A take can now
    // outlast what was asked for (a wake take extends while words arrive), so
    // clamping to `clamped` would label a 40s extended take as 10s — the same lie
    // this test was written about, pointing the other way, and the worse direction
    // because the extra audio really is in the file.
    expect(SRC).toMatch(/let actualSeconds = max\(1, min\(Self\.maxSeconds,/)
    // Both the stored row and the value handed back to the agent/relay caller.
    expect(SRC).toMatch(/seconds: actualSeconds, label: label/)
    expect(SRC).toMatch(/audioUrl: entry\.audioUrl, seconds: actualSeconds/)
    // `clamped` must no longer be what a take reports.
    expect(SRC).not.toMatch(/seconds: clamped, label: label/)
  })

  it('a stopped take still finalizes, transcribes, uploads and stores', () => {
    // stopEarly() only sets a flag; everything after the sleep loop is the
    // take's own tail and must be reached on the stopped path too. Order is
    // what matters: break out of the loop BEFORE endAudio/finish/upload/store.
    const loop = SRC.indexOf('while Self.shouldExtend(')
    expect(loop, 'the take loop moved — re-anchor before trusting the steps below')
      .toBeGreaterThan(-1)
    const tail = SRC.slice(loop)
    for (const step of ['box.finish()', '/api/media', 'pruneAndSave()', 'postToServer(entry)']) {
      expect(tail).toContain(step)
    }
    // endAudio on the CURRENT request, not a captured `request`. A take
    // replaces its recognition request each time a task ends (one task hears
    // one utterance), so closing the FIRST one at teardown flushes a request
    // that has been dead for most of a two-minute memo — and leaves the live
    // one's tail unfinalized.
    expect(tail).toMatch(/slot\.current\?\.endAudio\(\)/)
    expect(tail).not.toMatch(/^\s*request\.endAudio\(\)/m)
  })

  it('the panel and the transcripts view both offer Stop while recording', () => {
    // A take that can be started from a screen with no Stop on it is the bug
    // this pair of controls exists to prevent.
    const panels = readFileSync(join(process.cwd(), 'ios/Tiny/Sources/Panels.swift'), 'utf8')
    expect(panels).toMatch(/NiclaRecorder\.shared\.stopEarly\(\)/)
    expect(SRC).toMatch(/rec\.stopEarly\(\)/)
  })
})
