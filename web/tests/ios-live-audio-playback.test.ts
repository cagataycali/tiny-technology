// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔊 A necklace-live row you can PLAY, and the disk budget that keeps it honest.
 *
 * "in ios app we will be able to listen all the speech + transcription directly"
 * — a live row used to have only the transcription half. TinyLive decoded the
 * Vision's `/audio` stream, DC-corrected it, normalized the gain, played it once
 * and dropped the buffer; `storeHeard` was called with `audioFile: nil`. The
 * words were in the list and in the agent's context, and the sound they came
 * from was unrecoverable.
 *
 * The rules themselves are pure functions and they are pinned properly in Swift:
 * `NiclaAudioEvictionTests` (7 cases) and `NiclaOrphanAudioTests` (6), all
 * mutation-checked. This suite covers what XCTest cannot reach without a
 * necklace, a microphone and a filesystem — the WIRING and the CROSS-FILE
 * invariants, every one of which can be violated in code that compiles, ships,
 * and looks right in review:
 *
 *   - a rule can be perfectly correct, fully unit-tested, and NEVER CALLED.
 *     `audioEvictions` and `orphanAudio` are both pure and both decorative if
 *     nothing invokes them; the disk fills either way
 *   - the file must be opened in `feedAudio`, NOT in `startSpeech()`, which
 *     reruns on every recognizer restart — several times per 45s segment. A file
 *     per restart leaves one playable fragment and a pile of orphans
 *   - it must write the SAME buffer the player and recognizer get. The raw stream
 *     is the mic's native ~-48 dBFS: a file that is technically audio and
 *     inaudible in practice
 *   - it must be closed BEFORE anything decides to keep it. An AVAudioFile still
 *     open has no moov atom, so the row's Play button fails — this app has
 *     already shipped 97KB of AAC packets with no index once
 *   - two files must resolve to ONE directory. `audioURL(for:)` resolves a row's
 *     `audioFile` against `NiclaRecorder.storeDir()`, so a segment written
 *     anywhere else is a Play button pointing at nothing
 *   - and the orphan sweep's age gate must outlast the longest thing that can
 *     still be open, or it deletes the file being written to — the writes keep
 *     succeeding into an unlinked inode and every log line still says ok
 *
 * Source-shape assertions are usually a smell. These are here because each
 * failure is silent, and a phone with a full disk is the other way to find them.
 */
const LIVE = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/TinyLive.swift'), 'utf8')
const REC = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')

/** One method body, bounded by its own closing brace. See ios-live-transcribe. */
function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig)
  if (at < 0) throw new Error(`fnBody: "${sig}" not found — re-anchor this pin`)
  const end = src.indexOf('\n    }\n', at)
  if (end < 0) throw new Error(`fnBody: no method-level close after "${sig}"`)
  return src.slice(at, end)
}

/**
 * A Swift integer constant by name, so an invariant can be CHECKED rather than
 * quoted. Handles a product (`96 * 1024 * 1024`), because the sources write byte
 * budgets that way and reading only the first factor turns 96MB into 96 — which
 * is how this helper failed on its first run.
 */
function constant(src: string, name: string): number {
  const m = src.match(new RegExp(`${name}[^=\\n]*= ([\\d_]+(?:\\s*\\*\\s*[\\d_]+)*)`))
  if (!m) throw new Error(`constant: ${name} not found`)
  return m[1].split('*').reduce((a, part) => a * Number(part.trim().replace(/_/g, '')), 1)
}

describe('the suite reads its own sources', () => {
  it('read both files, not two empty strings', () => {
    // A slicer that quietly returns '' passes every assertion below forever.
    expect(LIVE.length, 'TinyLive.swift came back empty').toBeGreaterThan(40_000)
    expect(REC.length, 'NiclaRecorder.swift came back empty').toBeGreaterThan(50_000)
    expect(LIVE).toContain('final class TinyLive')
    expect(REC).toContain('final class NiclaRecorder')
  })
})

describe('SegmentAudio — the segment is kept, not just heard', () => {
  it('exists, and writes AAC at the stream\'s own rate', () => {
    expect(LIVE).toMatch(/final class SegmentAudio \{/)
    const init_ = fnBody(LIVE, 'init?(dir: URL, format: AVAudioFormat)')
    expect(init_).toMatch(/AVFormatIDKey: kAudioFormatMPEG4AAC/)
    // The format is the STREAM's, not a hardcoded rate: resampling to write a
    // file would be a second conversion of audio that is already correct.
    expect(init_).toMatch(/AVSampleRateKey: format\.sampleRate/)
    expect(init_).toMatch(/AVNumberOfChannelsKey: format\.channelCount/)
    // Same container the transcripts list already plays and uploads. A second
    // format would need a second player and a second upload path.
    expect(LIVE).toMatch(/name = "live-\\\(UUID\(\)\.uuidString\)\.m4a"/)
  })

  it('drops the handle on the FIRST write failure instead of retrying', () => {
    // Same shape as NiclaRecorder.TakeBox's file half and for the same reason: a
    // throwing write poisons the container, so every later write produces bytes
    // that make the file less playable, not more.
    const write = fnBody(LIVE, 'func write(_ buffer: AVAudioPCMBuffer)')
    expect(write).toMatch(/guard let f = file else \{ return \}/)
    expect(write).toMatch(/catch \{\s*\n\s*file = nil\s*\n\s*\}/)
    // frames only advances on a write that SUCCEEDED — that is what makes
    // finish()'s answer mean "there is audio in there".
    expect(write).toMatch(/try f\.write\(from: buffer\)\s*\n\s*frames \+= Int\(buffer\.frameLength\)/)
  })

  it('closes explicitly and reports whether the file is worth keeping', () => {
    // NOT left to dealloc. The first e2e clip this app uploaded was 97KB of AAC
    // packets with no moov atom, because the bytes were read before deferred
    // finalization wrote the index: unplayable everywhere, with every log ok.
    const finish = fnBody(LIVE, 'func finish() -> Bool')
    expect(finish).toMatch(/file = nil/)
    expect(finish, 'finish() no longer reports whether any audio was written')
      .toMatch(/return frames > 0/)
  })
})

describe('the wiring — where the file is opened, and with what', () => {
  it('opens in feedAudio, not in startSpeech which reruns per restart', () => {
    // THE bug of this feature. startSpeech() runs again on every recognizer
    // restart (several times per 45s segment), so opening there gives one
    // playable fragment plus a directory of orphans — and each orphan is
    // invisible to the eviction rule, because no row ever pointed at it.
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'),
                            LIVE.indexOf('// ---- speech segments'))
    expect(feed.length, 'the feedAudio slice is empty — re-anchor').toBeGreaterThan(2_000)
    expect(feed).toMatch(/if segmentAudio == nil \{\s*\n\s*segmentAudio = SegmentAudio\(/)

    const start = fnBody(LIVE, 'private func startSpeech()')
    expect(start, 'a file is opened per recognizer restart — fragments and orphans')
      .not.toMatch(/SegmentAudio\(/)
    // And app-wide there is exactly ONE place that opens one.
    const opens = LIVE.split('SegmentAudio(dir:').length - 1
    expect(opens, 'more than one site opens a segment file').toBe(1)
  })

  it('writes the SAME buffer the player and the recognizer get', () => {
    // A third consumer of the buffer feedAudio already built, not a second
    // capture. The raw stream is the mic's native ~-48 dBFS — measurably
    // inaudible, and the level that transcribes to nothing at all — so the
    // write has to come after the DC correction and gain normalization, which
    // is what producing `buf` means here.
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'),
                            LIVE.indexOf('// ---- speech segments'))
    const play = feed.indexOf('player.scheduleBuffer(buf)')
    const write = feed.indexOf('segmentAudio?.write(buf)')
    const recog = feed.indexOf('speechRequest?.append(buf)')
    expect(play, 'the player no longer takes buf').toBeGreaterThan(-1)
    expect(write, 'the segment file no longer takes buf').toBeGreaterThan(-1)
    expect(recog, 'the recognizer no longer takes buf').toBeGreaterThan(-1)
    // All three take `buf`; the write is downstream of the corrected buffer.
    expect(write, 'the file is written before the buffer is corrected and played')
      .toBeGreaterThan(play)
    expect(feed, 'the segment file is being fed a second decode of the same bytes')
      .not.toMatch(/segmentAudio\?\.write\((?!buf\))/)
  })

  it('writes into the ONE directory a row\'s audioFile resolves against', () => {
    // audioURL(for:) resolves `audioFile` against storeDir(). A segment written
    // anywhere else gives its row a Play button that resolves to nothing.
    expect(LIVE).toMatch(/SegmentAudio\(dir: NiclaRecorder\.storeDir\(\), format: audioFormat\)/)
    // Which is why storeDir() is not private any more — that is load-bearing,
    // not an accident of refactoring.
    expect(REC, 'storeDir() went private again — TinyLive cannot reach it')
      .toMatch(/\n    static func storeDir\(\) -> URL \{/)
    expect(fnBody(REC, 'static func audioURL(for t: NiclaTranscript)'))
      .toMatch(/storeDir\(\)/)
  })

  it('closes the file BEFORE deciding whether to keep the segment', () => {
    // Ordering, not presence. An AVAudioFile still open has no moov atom on
    // disk, so a row created for it would have a Play button that fails.
    const fin = fnBody(LIVE, 'private func finishSegment()')
    const detach = fin.indexOf('let audio = segmentAudio')
    const close = fin.indexOf('audio?.finish() == true')
    const decide = fin.indexOf('guard text.count >= Self.minSegmentChars')
    const store = fin.indexOf('NiclaRecorder.shared.storeHeard(')
    for (const [n, i] of [['detach', detach], ['close', close], ['decide', decide], ['store', store]] as const) {
      expect(i, `${n} is missing from finishSegment — re-anchor`).toBeGreaterThan(-1)
    }
    expect(close, 'the file is still open when the row is decided').toBeLessThan(decide)
    expect(decide, 'a row is stored before the keep/discard decision').toBeLessThan(store)
    // Detached from the actor's state first, so a segment starting while this one
    // finalizes cannot have its file closed out from under it.
    expect(detach).toBeLessThan(close)
    expect(fin).toMatch(/segmentAudio = nil/)
    // The row gets the name ONLY if there was audio in it — an empty file with a
    // Play button is worse than no Play button.
    expect(fin).toMatch(/audioFile: keptAudio \? audio\?\.name : nil/)
  })
})

describe('the budget is enforced, not merely correct', () => {
  it('pruneAndSave actually calls audioEvictions, newest-first', () => {
    // The rule is pure and Swift-tested. If nothing calls it the disk fills
    // anyway, and every one of those unit tests still passes.
    const prune = fnBody(REC, 'private func pruneAndSave()')
    expect(prune, 'audioEvictions is never called — the rule is decoration')
      .toMatch(/Self\.audioEvictions\(rows: sized, budget: Self\.liveAudioBudget\)/)
    // It is fed the KEPT rows with real on-disk sizes, not the row's own claim
    // about itself — a stale `seconds` field would not bound anything.
    expect(prune).toMatch(/attributesOfItem\(atPath: u\.path\)/)
    expect(prune).toMatch(/attrs\[\.size\] as\? Int/)
  })

  it('eviction takes the FILE and leaves the WORDS', () => {
    // What the necklace heard is small, durable, and the thing the agent reads.
    // Losing the recording is a tradeoff; losing the transcript with it is not.
    const prune = fnBody(REC, 'private func pruneAndSave()')
    expect(prune).toMatch(/kept\[i\]\.audioFile = nil/)
    expect(prune, 'eviction is deleting the row, not just its audio')
      .not.toMatch(/kept\.remove\(at: i\)/)
    expect(prune).toMatch(/removeItem\(at: u\)/)
  })

  it('the sweep runs at load, and only ever sees rows it just loaded', () => {
    // Same failure mode as above, other door: orphanAudio is pure and tested and
    // would be decoration if init never called it.
    const init_ = fnBody(REC, 'private init()')
    expect(init_).toMatch(/transcripts = Self\.loadIndex\(\)/)
    expect(init_, 'the orphan sweep is never called — orphans accumulate forever')
      .toMatch(/Self\.sweepOrphanAudio\(rows: transcripts\)/)
    // Fed the CLAIMED filenames. Handing it anything else (ids, labels) would
    // make every file look unclaimed and delete the entire archive's audio.
    expect(fnBody(REC, 'private static func sweepOrphanAudio('))
      .toMatch(/orphanAudio\(files: files, rows: rows\.compactMap\(\\\.audioFile\)\)/)
  })

  it('the age gate outlasts the longest thing that can still be open', () => {
    // Derived, not quoted. The gate exists because `shared` is lazily
    // initialized and the FIRST live segment triggers that init from storeHeard —
    // file already written, row not yet inserted. Too short a gate deletes the
    // segment that woke the sweep, or unlinks a file AVAudioFile is still writing
    // to, where the writes keep succeeding into a dead inode.
    const gate = constant(REC, 'minOrphanAge: TimeInterval')
    const segment = constant(LIVE, 'segmentSeconds: TimeInterval')
    const take = constant(REC, 'maxSeconds')
    expect(gate, 'the gate is shorter than a live segment — the sweep eats open files')
      .toBeGreaterThan(segment)
    expect(gate, 'the gate is shorter than a full take — a 120s memo can be swept mid-write')
      .toBeGreaterThan(take)
    // Slack, not a coincidence: being wrong the other way costs one extra launch
    // before an orphan is collected, which is the cheap direction.
    expect(gate).toBeGreaterThanOrEqual(2 * Math.max(segment, take))
    // And the rule reads the constant rather than repeating the number.
    expect(fnBody(REC, 'nonisolated static func orphanAudio('))
      .toMatch(/\$0\.age >= minOrphanAge/)
  })

  it('index.json is excluded — collecting it would erase every transcript', () => {
    // The one mutation here that would be SILENT: the rows are still in memory,
    // so nothing looks wrong until the next launch loads an empty archive.
    const rule = fnBody(REC, 'nonisolated static func orphanAudio(')
    expect(rule).toMatch(/\$0\.name != "index\.json"/)
    // The same name the index is actually written under, not a near-miss.
    expect(fnBody(REC, 'private func pruneAndSave()'))
      .toMatch(/appendingPathComponent\("index\.json"\)/)
  })

  it('a hand-made take is neither counted nor evicted', () => {
    // A phone full of live segments must not push a memo the user recorded
    // deliberately off the disk. The label is the only thing that tells them
    // apart, which is why it is a shared constant — see ios-live-transcribe.
    const rule = fnBody(REC, 'nonisolated static func audioEvictions(')
    expect(rule).toMatch(/guard r\.label == liveLabel else \{ continue \}/)
    expect(REC).toMatch(/nonisolated static let liveLabel = "necklace-live"/)
    // The budget is a measured number, and big enough to be a real archive
    // rather than a token — 96MB is ~497 segments at the 36kbps AAC actually
    // produces on the wire.
    expect(constant(REC, 'liveAudioBudget')).toBeGreaterThanOrEqual(64 * 1024 * 1024)
  })
})
