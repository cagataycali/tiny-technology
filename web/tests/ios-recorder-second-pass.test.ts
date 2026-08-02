// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎙️ Live words during a take, and the second pass over the finished file.
 *
 * The rule the second pass has to obey — "longer wins, and only longer" — is a
 * pure function, and it is pinned properly in Swift (`NiclaSecondPassTests`,
 * seven cases, mutation-checked). This suite covers the half XCTest cannot
 * reach without a microphone: the WIRING. Every claim below is one whose
 * violation compiles, ships, and is invisible until someone records a real
 * memo on a real phone:
 *
 *   - `partial` must be republished from the take loop's existing 200ms tick,
 *     never from the recognition callback, which is nonisolated and fires on
 *     Speech's own thread as fast as it likes
 *   - it must publish `box.fullText`, NOT `box.transcript`. `transcript` is the
 *     CURRENT recognition task's value alone, and a long take rolls many tasks,
 *     so the card would appear to forget the sentence the user just watched it
 *     type. Both names exist on the box; they differ by one word here
 *   - it must be cleared when the mic claim is released, or a failed take
 *     leaves the previous take's words on screen looking like a live recording
 *   - the second pass must be gated on `hasAudio`, because the branch directly
 *     above it DELETES the file when there is no audio
 *   - and it must run after `box.finish()`, off the audio path — a second
 *     engine on the shared input node is the bug this codebase keeps relearning
 *   - `transcribeFile` must decide on `installedLocales` and must not call
 *     `shouldUse()`, whose side effect is starting a multi-hundred-MB download.
 *     A finished voice memo is not consent to fetch a model
 *
 * Source-shape assertions are usually a smell. These are here because each
 * failure is silent, and because a phone is the only other way to see them.
 */
const REC = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')
const ANALYZER = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/VoiceAnalyzer.swift'), 'utf8')

describe('the recorder actually reads its own sources', () => {
  it('read both files, not two empty strings', () => {
    // A slicer that silently returns "" passes every assertion below forever.
    expect(REC.length, 'NiclaRecorder.swift came back empty').toBeGreaterThan(20_000)
    expect(ANALYZER.length, 'VoiceAnalyzer.swift came back empty').toBeGreaterThan(5_000)
    expect(REC).toContain('final class NiclaRecorder')
    expect(ANALYZER).toContain('final class VoiceAnalyzer')
  })
})

describe('NiclaRecorder — the take shows the words as they arrive', () => {
  it('publishes `partial` read-only, so only the recorder can set it', () => {
    expect(REC).toMatch(/@Published private\(set\) var partial = ""/)
  })

  it('republishes on the loop tick, not from the recognition callback', () => {
    // The callback is `nonisolated static func recognize` and it only ever
    // touches the lock-guarded box. If a `partial =` assignment ever appears
    // inside it, every partial becomes a MainActor hop from Speech's thread.
    const at = REC.indexOf('private nonisolated static func recognize(')
    expect(at, 'the recognition callback moved or was renamed').toBeGreaterThan(0)
    const callback = REC.slice(at, REC.indexOf('\n    }\n', at))
    expect(callback, 'the recognition callback is publishing partials itself')
      .not.toMatch(/partial\s*=/)

    // And the assignment IS on the loop's tick: the 200ms sleep is the very
    // next statement, which is what makes the update rate bounded.
    expect(REC).toMatch(/partial = box\.fullText\s*\n\s*try\? await Task\.sleep\(for: \.milliseconds\(200\)\)/)
  })

  it('publishes fullText, not the live task\'s transcript alone', () => {
    // Both properties exist on TakeBox, one word apart. `transcript` returns
    // only the latest utterance, so after a restart the card would blank back
    // to whatever sentence is in flight.
    expect(REC).toMatch(/var transcript: String \{/)
    expect(REC).toMatch(/var fullText: String \{/)
    expect(REC).toContain('partial = box.fullText')
    expect(REC, 'the card would forget every sentence before the current one')
      .not.toContain('partial = box.transcript')
  })

  it('clears `partial` when the mic claim is given back', () => {
    // release() runs on every path that never reaches the take. Without the
    // clear, a permission denial leaves the PREVIOUS take's words on screen.
    const at = REC.indexOf('func release() {')
    expect(at, 'release() moved or was renamed').toBeGreaterThan(0)
    const release = REC.slice(at, REC.indexOf('\n        }', at))
    expect(release, 'a failed take leaves the last take\'s words on screen')
      .toMatch(/partial = ""/)
  })
})

describe('NiclaTranscriptsView — the live card renders those words', () => {
  const card = REC.slice(REC.indexOf('if rec.isRecording {'))

  it('shows rec.partial, and only once there is something to show', () => {
    expect(card, 'the recording card never reads the partial it is published for')
      .toMatch(/if !rec\.partial\.isEmpty \{/)
    expect(card).toMatch(/Text\(rec\.partial\)/)
  })

  it('caps the height and tails to the bottom', () => {
    // Uncapped, a two-minute take pushes the Stop button off screen — the one
    // control the card exists to offer. And the newest words are the ones that
    // answer "is it hearing me right now", so the scroll pins to the bottom.
    expect(card).toMatch(/\.frame\(maxHeight: \d+\)/)
    expect(card).toMatch(/scrollTo\("tail", anchor: \.bottom\)/)
    expect(card).toMatch(/\.onChange\(of: rec\.partial\)/)
  })

  it('says which of two states it is in', () => {
    // Silence at second one is normal; silence at second thirty is alarming.
    // This line is the only place the app can tell them apart, so it is pinned
    // as the emitted CONDITIONAL, not as "both strings appear in the file".
    expect(card).toMatch(/rec\.partial\.isEmpty\s*\n?\s*\?\s*"Recording — tap Stop when you're done\."/)
    expect(card).toMatch(/:\s*"Transcribing on-device — tap Stop when you're done\."/)
  })
})

describe('the second pass over the finished file', () => {
  it('only runs when there IS a file, and only on iOS 26', () => {
    // The line above the gate deletes the m4a when the take captured nothing.
    // Without `hasAudio` the analyzer is handed a path that no longer exists —
    // it returns nil, so the bug is a silent wasted pass, not a crash.
    expect(REC).toMatch(/if !hasAudio \{ try\? FileManager\.default\.removeItem\(at: fileURL\) \}/)
    expect(REC).toMatch(/if hasAudio, #available\(iOS 26\.0, \*\) \{\s*\n\s*secondPass = await VoiceAnalyzer\.transcribeFile\(at: fileURL\)/)
  })

  it('runs after the container is finished, never beside the live engine', () => {
    // Ordering, not presence: two engines on the shared input node is the
    // failure this codebase keeps relearning. box.finish() closes the take's
    // audio path, and the analyzer may only open afterwards.
    const finish = REC.indexOf('let hasAudio = box.finish()')
    const pass = REC.indexOf('await VoiceAnalyzer.transcribeFile(at: fileURL)')
    expect(finish).toBeGreaterThan(0)
    expect(pass).toBeGreaterThan(0)
    expect(pass, 'the second pass starts before the take released the audio path')
      .toBeGreaterThan(finish)
  })

  it('feeds the choice through betterTranscript, which a test can reach', () => {
    // `nonisolated` is what lets NiclaSecondPassTests call it with no mic and
    // no MainActor. Dropping it does not change behaviour — it just puts the
    // whole rule back out of reach of every test.
    expect(REC).toMatch(/nonisolated static func betterTranscript\(live: String, secondPass: String\?\) -> String/)
    expect(REC).toContain('let heard = Self.betterTranscript(live: live, secondPass: secondPass)')
    // Strictly greater, and trimmed first. Both are pinned in Swift; pinned
    // again here because this is the line a careless refactor rewrites.
    expect(REC).toMatch(/!full\.isEmpty, full\.count > live\.count else \{ return live \}/)
    expect(REC).toMatch(/secondPass\?\.trimmingCharacters\(in: \.whitespacesAndNewlines\)/)
  })

  it('stores the live text, not the requested duration\'s worth of it', () => {
    // The take's own words come from fullText too — the same restart problem,
    // one scope up. A 90s memo that rolled four tasks would otherwise store
    // its closing sentence and drop everything before it.
    expect(REC).toMatch(/let live = box\.fullText\.trimmingCharacters\(in: \.whitespacesAndNewlines\)/)
  })
})

describe('VoiceAnalyzer.transcribeFile — the uncapped engine, used politely', () => {
  // Bounded at the next section marker. An unbounded slice runs to EOF and
  // picks up the live session's code, which is exactly what this suite is
  // trying to tell transcribeFile apart from.
  const from = ANALYZER.indexOf('static func transcribeFile(at url: URL) async -> String? {')
  const fn = ANALYZER.slice(from, ANALYZER.indexOf('\n    // ── ', from))
  // Comments stripped: the body EXPLAINS itself by naming the call it must not
  // make, so any "this string is absent" assertion has to read code only. A
  // pin that matches its own explaining comment passes forever.
  const code = fn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('exists, is bounded, and its comments were stripped', () => {
    expect(fn.length, 'transcribeFile is gone — the slice is empty').toBeGreaterThan(500)
    expect(fn, 'the slice ran past the function into the live session')
      .not.toContain('func start(')
    expect(code.length, 'the comment strip ate the body').toBeGreaterThan(600)
    expect(code, 'comments survived the strip — the absence pins below are void')
      .not.toContain('NOT shouldUse()')
  })

  it('decides on installedLocales and never calls shouldUse()', () => {
    // shouldUse() has a side effect: it kicks off the model download. That is
    // correct when choosing a LIVE session's engine and wrong here — a memo
    // finishing is not a reason to start a multi-hundred-MB fetch on cellular.
    expect(code).toMatch(/await SpeechTranscriber\.installedLocales/)
    expect(code, 'a finished memo is starting a model download').not.toContain('shouldUse(')
    // And the live path still has it, so this is a deliberate difference
    // between the two callers rather than the method having been deleted.
    expect(ANALYZER).toMatch(/static func shouldUse\(\) async -> Bool/)
  })

  it('asks for no volatile results — nobody is watching this run', () => {
    expect(fn).toMatch(/reportingOptions: \[\]/)
    expect(fn).toMatch(/finishAfterFile: true/)
  })

  it('starts collecting before it tells the analyzer to run', () => {
    // A short clip can finish and close the results stream before anything is
    // reading it, and the transcript comes back empty for a file full of
    // speech. Ordering is the entire fix, so ordering is what is pinned.
    const collector = fn.indexOf('let collector = Task {')
    const run = fn.indexOf('try await analyzer.analyzeSequence(from: file)')
    expect(collector).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(0)
    expect(collector, 'the analyzer runs before anything reads its results')
      .toBeLessThan(run)
  })

  it('returns nil on every failure, because nil means "keep the live text"', () => {
    // An empty string would win no comparison either, but nil is the contract
    // betterTranscript is written against, and `catch { return nil }` is what
    // keeps an unreadable file from blanking a transcript.
    expect(fn).toMatch(/guard let locale = await bestSupportedLocale\(\) else \{ return nil \}/)
    expect(fn).toMatch(/guard let file = try\? AVAudioFile\(forReading: url\) else \{ return nil \}/)
    expect(fn).toMatch(/return text\.isEmpty \? nil : text/)
    expect(fn).toMatch(/\} catch \{\s*\n\s*return nil\s*\n\s*\}/)
  })
})
