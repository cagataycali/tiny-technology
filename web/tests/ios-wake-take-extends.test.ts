// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ⏱️ A wake take ends when the SPEAKER does, not when a guessed number runs out.
 *
 * The wake word is the record button, and the gateway asks for 10 seconds. Say the
 * wake word and then talk for thirty and you kept the first ten: the m4a ended, the
 * transcript ended, and nothing in the stored row said it had been cut. So `seconds`
 * became a FLOOR and the take now runs while words are still arriving.
 *
 * The stop rule itself (`shouldExtend`) is pure and is pinned properly in Swift —
 * `NiclaTakeExtensionTests`, nine cases. This suite covers the two things XCTest
 * cannot see, both of which fail silently:
 *
 *   1. **The WIRING.** `shouldExtend` can be perfectly correct, perfectly tested,
 *      and never called — the take loop would go back to `while Date() < deadline`
 *      and every Swift test would still be green. Same for the growth bookkeeping
 *      the rule reads: without `lastGrowthAt` moving inside the loop, the rule is
 *      handed a timestamp frozen at `startedAt` and every take ends at its floor.
 *
 *   2. **The CROSS-SURFACE contract.** `extendWhileSpeaking` defaults to `false`
 *      because `nicla_voice_record` polls the relay for only `seconds + 25`. A take
 *      that extended to two minutes would answer an agent that had already given up:
 *      the transcript gets stored and the caller is told it timed out. That coupling
 *      lives half in Swift and half in a TypeScript tool, so nothing in either
 *      language can check it alone — this file is the only place it exists.
 */

const ROOT = process.cwd()
const REC = readFileSync(join(ROOT, 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')
const GATEWAY = readFileSync(join(ROOT, 'ios/Tiny/Sources/NiclaVoiceGateway.swift'), 'utf8')
// cwd is `web/`, so the iOS paths above resolve through the tracked `web/ios`
// symlink while this one is plain-relative. Both are checked non-empty below.
const TOOL = readFileSync(join(ROOT, 'lib/chat/tools/nicla-voice.ts'), 'utf8')

/** Comments stripped: every rule below is EXPLAINED in prose right beside itself,
 *  so a pin that reads the comment passes forever. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*(\/\/\/?|\*).*$/gm, '')

const REC_CODE = strip(REC)
const GATEWAY_CODE = strip(GATEWAY)

describe('the sources were really read', () => {
  it('three non-empty files, and the strip did not eat the code', () => {
    // A slicer or stripper that returns "" passes every `.not` pin here forever.
    expect(REC.length, 'NiclaRecorder.swift came back empty').toBeGreaterThan(20_000)
    expect(GATEWAY.length, 'NiclaVoiceGateway.swift came back empty').toBeGreaterThan(5_000)
    expect(TOOL.length, 'nicla-voice.ts came back empty').toBeGreaterThan(3_000)
    expect(REC_CODE).toContain('final class NiclaRecorder')
    expect(GATEWAY_CODE).toContain('final class NiclaVoiceGateway')
    // And the strip removed something — otherwise the prose satisfies the pins.
    expect(REC_CODE.length, 'nothing was stripped').toBeLessThan(REC.length - 2_000)
  })
})

describe('the stop rule is actually wired into the take loop', () => {
  it('the loop condition IS shouldExtend, not a bare deadline compare', () => {
    // 🔴 The silent regression: a correct, fully-tested rule that nobody calls.
    expect(REC_CODE, 'the take loop no longer consults shouldExtend — every take ends at its floor')
      .toMatch(/while Self\.shouldExtend\(now: Date\(\), deadline: deadline, hardCap: hardCap,\s*\n\s*lastGrowthAt: lastGrowthAt, stopRequested: stopRequested\) \{/)
    expect(REC_CODE, 'the loop went back to a bare deadline compare')
      .not.toMatch(/while Date\(\) < deadline/)
  })

  it('the hard cap handed to the rule comes from hardCapSeconds, not a literal', () => {
    // hardCapSeconds exists as a NAMED function for a reason recorded upstream:
    // with the opt-in gate inline in record(), a mutation that let EVERY take
    // extend passed the entire Swift suite. The decision was unreachable from a
    // test, so it was unprotected. Inlining it again re-opens that hole.
    expect(REC_CODE).toMatch(/nonisolated static func hardCapSeconds\(requested: Int, extendWhileSpeaking: Bool\) -> Int/)
    expect(REC_CODE, 'the loop computes its own ceiling — the gate is untestable again')
      .toMatch(/Self\.hardCapSeconds\(requested: clamped, extendWhileSpeaking: extendWhileSpeaking\)/)
  })

  it('growth is recorded inside the loop, or the rule reads a frozen timestamp', () => {
    // `lastGrowthAt` is the ONLY input that changes while the take runs. If it is
    // never advanced, `now - lastGrowthAt` grows without bound and the grace
    // expires the first tick past the deadline: the feature silently reverts.
    const loopAt = REC_CODE.indexOf('while Self.shouldExtend(')
    expect(loopAt, 'the take loop moved').toBeGreaterThan(-1)
    const loop = REC_CODE.slice(loopAt, REC_CODE.indexOf('\n        }\n', loopAt))
    expect(loop, 'nothing advances lastGrowthAt — every take ends at its floor')
      .toMatch(/lastGrowthAt = Date\(\)/)
    // ⚠️ And by LENGTH, not inequality. A recognizer restart can REPLACE the live
    // utterance with a shorter re-reading of the same words; counting that as new
    // speech holds the microphone open through silence.
    expect(loop, 'growth is measured by change, not length — a restart reads as new speech')
      .toMatch(/if text\.count > seenChars \{/)
    expect(loop, 'growth compares text to its previous value — a shorter re-read counts as speech')
      .not.toMatch(/text != |text !== |last != text/)
  })

  it('the stored duration is clamped to the ceiling, not to what was asked for', () => {
    // Now that a take can outlast its request, clamping to `clamped` would label a
    // 40s extended take as 10s. The old comment warns against the opposite lie
    // (a 4s take stored as 60); this direction matters more, because the extra
    // audio really is in the file and the row would disclaim it.
    expect(REC_CODE, 'an extended take is labelled with what was requested, not what it captured')
      .toMatch(/let actualSeconds = max\(1, min\(Self\.maxSeconds, Int\(Date\(\)\.timeIntervalSince\(startedAt\)\.rounded\(\)\)\)\)/)
  })
})

describe('only the path with nobody waiting on it may extend', () => {
  it('the default is false — the default IS the cross-surface contract', () => {
    expect(REC_CODE, 'extending became the default — every agent-issued take can now outlast its poll')
      .toMatch(/extendWhileSpeaking: Bool = false\) async -> NiclaRecordResult/)
  })

  it('exactly ONE caller in the whole app opts in, and it is the wake handler', () => {
    // ⚠️ A count, not a presence check. Any second opt-in site is a take that can
    // run to 120s while something waits `seconds + 25` for it — and the failure is
    // invisible from the phone: the transcript IS stored, so the recorder looks
    // fine and only the agent sees a timeout.
    const optIns = (strip(REC + '\n' + GATEWAY).match(/extendWhileSpeaking: true/g) ?? []).length
    expect(optIns, 'a second take now opts into extending — check its caller has no poll budget').toBe(1)
    // And it is the wake path specifically: recordOnWake, not the manual button
    // (which already asks for the 120s maximum with Stop available).
    const wakeAt = GATEWAY_CODE.indexOf('if Config.recordOnWake {')
    expect(wakeAt, 'the wake handler moved').toBeGreaterThan(-1)
    const wake = GATEWAY_CODE.slice(wakeAt, wakeAt + 600)
    expect(wake, 'the wake take no longer extends — thirty seconds of speech keeps ten')
      .toMatch(/extendWhileSpeaking: true/)
    expect(wake, 'the wake take stopped asking for a 10s floor').toMatch(/seconds: 10/)
  })

  it('the relay poll budget that forces that default still says +25', () => {
    // The other half of the coupling, in the other language. If this budget ever
    // grows to cover a 120s take, the Swift default becomes a free choice again —
    // and if it shrinks, the default matters more, not less.
    expect(TOOL, 'the poll budget moved — re-derive whether the Swift default is still right')
      .toMatch(/clampWait\(seconds \+ 25, budgetS\)/)
  })

  it('an extended take can never outlast a take that asked for the maximum', () => {
    // Both surfaces clamp to the same number, and the extension ceiling IS that
    // number. If the phone's cap ever exceeded what the tool accepts, an extended
    // take would be a duration the tool would have refused to request.
    expect(REC_CODE).toMatch(/nonisolated static let maxSeconds = 120/)
    expect(REC_CODE, 'record() no longer clamps to the same ceiling the loop honours')
      .toMatch(/let clamped = min\(max\(seconds, 5\), Self\.maxSeconds\)/)
    expect(TOOL, 'the tool and the phone disagree about the longest possible take')
      .toMatch(/Math\.max\(5, Math\.min\(120, Math\.round\(input\.seconds \?\? 10\)\)\)/)
    // The extension ceiling is the SAME constant, not a copy of the digits.
    expect(REC_CODE, 'the extension ceiling is a literal — it can drift from record()\'s clamp')
      .toMatch(/extendWhileSpeaking \? maxSeconds : requested/)
  })

  it('the grace is long enough to cross a pause between two sentences', () => {
    // ~1s is a normal pause. A grace at or below that ends the take between
    // "…done." and "Also —", which reads as the recorder cutting people off.
    const m = /nonisolated static let silenceGrace: TimeInterval = ([\d.]+)/.exec(REC_CODE)
    expect(m, 'silenceGrace is gone or is no longer nonisolated (the pure rule cannot read it)')
      .not.toBeNull()
    expect(Number(m![1]), 'the grace no longer clears a sentence pause').toBeGreaterThanOrEqual(2)
    // Read by the rule, not re-stated as a literal inside it.
    expect(REC_CODE).toMatch(/return now\.timeIntervalSince\(lastGrowthAt\) < silenceGrace/)
  })
})
