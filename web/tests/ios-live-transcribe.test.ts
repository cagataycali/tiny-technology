// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🗣️ The Nicla Vision necklace's audio is transcribed, not just played.
 *
 * `firmware/tiny_stream.py` serves the board's microphone as `GET /audio`
 * (PCM16LE mono 16kHz) and TinyLive decoded it into an AVAudioPCMBuffer,
 * scheduled it on an AVAudioPlayerNode, and dropped the words on the floor.
 * The buffer is already the exact type SFSpeechAudioBufferRecognitionRequest
 * .append(_:) takes, so "listen to the necklace" and "read the necklace" were
 * the same work all along — the speech simply never reached the agent.
 *
 * A live stream + a real recognizer can't run in this suite, so what's pinned
 * here is the set of properties whose violation is silent, expensive, or a
 * privacy problem:
 *
 *   - the decoded buffer must reach a recognizer, not only the player
 *   - recognition must prefer ON-DEVICE: this is a continuously open mic in
 *     someone's home, and it must not become a stream of household audio to a
 *     server
 *   - segments must ROTATE: one SFSpeechRecognitionTask stops producing results
 *     after ~1 minute with no error, and the board streams for five
 *   - a failed/denied recognizer must turn the flag OFF, or the decode path
 *     re-enters and re-fails on every chunk, dozens of times a second
 *   - closing the card or muting must STORE the open segment, not discard up to
 *     45 seconds of speech
 *   - silence must not be stored, or a necklace on a table posts ~80 empty rows
 *     an hour into the agent's context
 */
const LIVE = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/TinyLive.swift'), 'utf8')
const REC = readFileSync(
  join(process.cwd(), 'ios/Tiny/Sources/NiclaRecorder.swift'), 'utf8')

/**
 * One method's body, bounded by its own closing brace.
 *
 * Replaces the `slice(at, at + 1400)` windows this suite used to use. A
 * fixed-length window does not break when the code it pins changes — it breaks
 * when the code merely GROWS, and it breaks by silently ending before the line
 * it was written to find. Four pins here failed that way at once when
 * finishSegment and storeHeard each gained a dozen lines above their targets,
 * and a "fix" that bumps the number just re-arms the same trap.
 *
 * `\n    }\n` is the method-level closer in both of these files (four-space
 * indent, nothing nested at that level), so it bounds the body without needing a
 * brace matcher. Throws rather than returning '' — an empty body would pass
 * every `.not.toMatch()` in this file forever.
 */
function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig)
  if (at < 0) throw new Error(`fnBody: "${sig}" not found — re-anchor this pin`)
  const end = src.indexOf('\n    }\n', at)
  if (end < 0) throw new Error(`fnBody: no method-level close after "${sig}"`)
  return src.slice(at, end)
}

describe('TinyLive — the necklace audio stream is transcribed on-device', () => {
  it('feeds the SAME decoded buffer to the recognizer as to the player', () => {
    expect(LIVE).toMatch(/^import Speech$/m)
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'))
    const body = feed.slice(0, feed.indexOf('\n    }\n'))
    // The buffer that plays is `buf`; the recognizer must get that one, not a
    // second decode of the same bytes.
    expect(body).toMatch(/player\.scheduleBuffer\(buf\)/)
    expect(body).toMatch(/speechRequest\?\.append\(buf\)/)
  })

  it('prefers on-device recognition and asks for punctuation', () => {
    const start = LIVE.slice(LIVE.indexOf('private func startSpeech()'))
    expect(start).toMatch(/requiresOnDeviceRecognition = recog\.supportsOnDeviceRecognition/)
    expect(start).toMatch(/addsPunctuation = true/)
  })

  it('rotates segments so a long stream keeps transcribing', () => {
    // A single task goes quiet after roughly a minute; the device caps a session
    // at five. Without rotation the last four minutes transcribe to nothing.
    expect(LIVE).toMatch(/segmentSeconds: TimeInterval = \d+/)
    const secs = Number(LIVE.match(/segmentSeconds: TimeInterval = (\d+)/)![1])
    expect(secs).toBeGreaterThan(0)
    expect(secs).toBeLessThan(60)
    expect(LIVE).toMatch(/private func rotateSegment\(\)/)
    // Rotation = close the old one, then open a new one.
    const rot = LIVE.slice(LIVE.indexOf('private func rotateSegment()'))
    expect(rot.slice(0, 300)).toMatch(/finishSegment\(\)[\s\S]*startSpeech\(\)/)
  })

  it('restarts a DEAD task without ending the segment', () => {
    // Measured against 125s of the board's real /audio: one
    // SFSpeechRecognitionTask reports exactly ONE utterance, and a single task fed
    // the whole stream transcribed NOTHING AT ALL. So a task ending is normal and
    // frequent — it must be replaced mid-segment, and its words banked, or every
    // sentence after the first is lost. A restart is NOT a new transcript row: 5
    // spoken bursts became 9 fragmented rows when restarts stored themselves.
    expect(LIVE).toMatch(/private func restartTask\(\)/)
    const r = LIVE.slice(LIVE.indexOf('private func restartTask()'))
    const body = r.slice(0, r.indexOf('\n    /// Add a finished utterance'))
    expect(body).toMatch(/bank\(speechBox\?\.text \?\? ""\)/)
    expect(body).toMatch(/startSpeech\(\)/)
    // Crucially it must NOT store a row — that's finishSegment's job alone.
    expect(body).not.toMatch(/storeHeard/)
    expect(body).not.toMatch(/segmentStartedAt = nil/)
  })

  it('restarts urgently only for a task that REPORTED an utterance', () => {
    // Both halves were measured. Unthrottled: 316 restarts in 125s, which
    // destroyed recognition instead of restoring it. Throttled unconditionally:
    // the restart lands mid-sentence and the sentence comes back clipped.
    //
    // The recognizer itself says which case applies, so this must not be guessed
    // from audio energy. isFinal = an utterance was reported and the speaker is
    // probably still going -> restart now. An error with no text ("No speech
    // detected") = an empty room -> wait out the rate limit. Measured on the
    // board's stream, EVERY ending during silence was the error kind, and
    // treating those as urgent is what produced the 316 restarts.
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'))
    const body = feed.slice(0, feed.indexOf('\n    // ---- speech segments'))
    expect(body).toMatch(
      /box\.deliveredUtterance \|\| now\.timeIntervalSince\(lastTaskStart\) >= Self\.minRestartSeconds/)
    expect(LIVE).toMatch(/minRestartSeconds: TimeInterval = \d+/)
    // The distinction has to survive the actor hop, so the box carries it.
    expect(LIVE).toMatch(/func markEnded\(reportedUtterance: Bool\)/)
    const rz = LIVE.slice(LIVE.indexOf('nonisolated static func recognize('))
    expect(rz.slice(0, 1600)).toMatch(/let final = result\?\.isFinal == true/)
    expect(rz.slice(0, 1600)).toMatch(/box\.markEnded\(reportedUtterance: final\)/)
    // An energy gate here was measured to be inert AND wrong; it must stay gone.
    expect(body).not.toMatch(/noiseFloor/)
  })

  it('replays the preroll only for a task that died mid-utterance', () => {
    // A task that delivered a final result already reported everything it heard,
    // so replaying its audio re-transcribes accounted-for speech and manufactures
    // the duplicate the stitcher then has to guess at. Only an ERROR ending can
    // strike with syllables unreported.
    const r = LIVE.slice(LIVE.indexOf('private func restartTask()'))
    const body = r.slice(0, 1400)
    expect(body).toMatch(/let owedReplay = !\(speechBox\?\.deliveredUtterance \?\? false\)/)
    // Captured BEFORE the box is torn down, or it always reads false.
    expect(body.indexOf('owedReplay')).toBeLessThan(body.indexOf('speechBox = nil'))
    expect(body).toMatch(/if owedReplay \{\s*\n\s*for b in preroll \{ speechRequest\?\.append\(b\) \}/)
  })

  it('the makeup gain is calibrated from a peak-hold, not per-chunk RMS', () => {
    // Measured on the board's real stream, both ways. A per-chunk RMS normalizer
    // hands a quiet room a huge gain and loud speech a small one, flattening the
    // contrast the recognizer needs: on audio already at -25.7 dBFS it wound the
    // gain to 26x, overshot the -21 target by 12 dB, and clipped 86% of one
    // chunk's samples. A decaying peak-hold never calibrates on room noise, so
    // it is a no-op on audio that is already loud enough (measured: median gain
    // 1.00x) and lifts ~10x on the board's own -40 dBFS acoustic level.
    const g = LIVE.slice(LIVE.indexOf('private func applyGain(to buf:'))
    const body = g.slice(0, g.indexOf('\n    }\n'))
    expect(body).toMatch(/speechPeak = max\(speechPeak \* 0\.9\d, rms\)/)
    expect(body).toMatch(/gain = min\(max\(Self\.gainTargetRMS \/ speechPeak/)
    // A PEAK ceiling on top of the RMS target: speech has a ~4.3x crest factor,
    // so a gain that is right on average still destroys the transients. Clamped
    // before the samples are written, because reacting to observed clipping is
    // too late — Speech already has the damaged audio.
    expect(body).toMatch(/min\(gain, Self\.gainPeakCeiling \/ peak\)/)
    expect(body).not.toMatch(/clipped/)
    expect(LIVE).toMatch(/gainPeakCeiling: Float = 0\.9/)
    // A new stream is a new room; the estimate must not carry over.
    const stop = LIVE.slice(LIVE.indexOf('func stop()'))
    expect(stop.slice(0, 900)).toMatch(/speechPeak = 0/)
  })

  it('removes the DC offset before anything measures a level', () => {
    // The board sits ~886 counts above zero and drifts. With the offset left in,
    // a chunk's RMS is dominated by the constant (0.024 vs 0.0004 of actual
    // signal) and every level reads the same whether or not anyone is speaking —
    // which silently disabled a level gate for an entire investigation.
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'))
    const body = feed.slice(0, 4000)
    expect(body).toMatch(/mean = sum \/ Float\(sampleCount\)/)
    expect(body).toMatch(/out\[i\] -= mean/)
    // And it happens before the gain, which is calibrated from those levels.
    expect(body.indexOf('out[i] -= mean')).toBeLessThan(body.indexOf('applyGain(to: buf)'))
  })

  it('replays a preroll into the new task so no syllable is lost', () => {
    // A task dies MID-utterance; the buffers appended between its death and the
    // restart exist nowhere else. Without this, restarted speech came back as
    // "The neck… And this sentence should be transcribed on".
    expect(LIVE).toMatch(/prerollFrames = [\d_]+/)
    const r = LIVE.slice(LIVE.indexOf('private func restartTask()'))
    expect(r.slice(0, 1200)).toMatch(/for b in preroll \{ speechRequest\?\.append\(b\) \}/)
    // The ring is bounded by FRAMES, not by chunk count: chunk size is whatever
    // the network hands over, so counting chunks would not bound the memory.
    const feed = LIVE.slice(LIVE.indexOf('fileprivate func feedAudio'))
    expect(feed.slice(0, 4000)).toMatch(/while held > Self\.prerollFrames/)
  })

  it('trims the overlap the preroll creates instead of storing it twice', () => {
    // Replaying 2s of audio means the new task legitimately re-transcribes the
    // tail of the old utterance. Measured without trimming, one segment held the
    // same sentence twice — worse than a clipped one, because the agent reads it
    // as two separate things being said.
    const bank = LIVE.slice(LIVE.indexOf('private func bank(_ raw: String)'))
    const body = bank.slice(0, bank.indexOf('\n    /// Close the current segment'))
    expect(body).toMatch(/segment\.contains\(incoming\)/)      // keep the longer reading
    expect(body).toMatch(/incoming\.contains\(Self\.normalizedWords\(prev\)/)
    expect(body).toMatch(/dropFirst\(seam\.overlap\)/)
    // Compared against the WHOLE segment, not just the last utterance: a burst of
    // restarts replays overlapping windows of one sentence, so the duplicate is
    // often two or three utterances back.
    expect(body).toMatch(/bankedUtterances\.joined\(separator: " "\)/)
    // Case/punctuation-insensitive: the recognizer re-punctuates the same audio
    // differently between tasks, so an exact compare finds no overlap at all.
    const nw = LIVE.slice(LIVE.indexOf('nonisolated static func normalizedWords('))
    expect(nw.slice(0, 500)).toMatch(/lowercased\(\)\.trimmingCharacters\(in: \.punctuationCharacters\)/)
  })

  it('the seam tolerates the dying task\'s trailing wrong guess', () => {
    // A task that dies mid-utterance ends on a PARTIAL guess at audio it never
    // finished hearing: "…is listening, and the" where the speaker said "…and
    // this sentence should be transcribed". Requiring an exact word-suffix match
    // let that single wrong word defeat the whole trim — a real four-word overlap
    // scored zero and the entire replayed window was banked verbatim. Measured,
    // that turned five spoken sentences into 450 characters of sliding
    // two-to-three word fragments.
    expect(LIVE).toMatch(/nonisolated static func bestSeam\(/)
    const seam = LIVE.slice(LIVE.indexOf('nonisolated static func bestSeam('))
    const body = seam.slice(0, seam.indexOf('\n    }\n'))
    expect(body).toMatch(/for junk in 0 \.\.\. 3 where junk < aw\.count/)
    // Two words minimum: one common word ("the", "and") matches by coincidence
    // constantly, and trimming on that deletes real speech.
    expect(body).toMatch(/while n >= 2/)
    // The junk words are dropped from what was already banked, not just skipped.
    const bank = LIVE.slice(LIVE.indexOf('private func bank(_ raw: String)'))
    expect(bank.slice(0, 1800)).toMatch(/dropLast\(seam\.junk\)/)
  })

  it('turns transcription OFF when the recognizer cannot be used', () => {
    // The decode path calls startSpeech() whenever speechRequest is nil, so a
    // failure that only sets a note would re-fail on every audio chunk.
    const start = LIVE.slice(LIVE.indexOf('private func startSpeech()'))
    const body = start.slice(0, start.indexOf('\n    /// Close the current segment'))
    const unavailable = body.slice(0, body.indexOf('recognizer = recog'))
    expect(unavailable).toMatch(/transcribeSpeech = false/)
    // Denied is also terminal until the user changes Settings.
    expect(body).toMatch(/default:\s*\n\s*transcribeSpeech = false/)
    // notDetermined is NOT terminal — it returns to retry after authorization.
    expect(body).toMatch(/case \.notDetermined:/)
    expect(body).toMatch(/requestAuthorization/)
  })

  it('stores the open segment when the card closes or audio is muted', () => {
    for (const fn of ['func stop()', 'func toggleAudio()']) {
      const at = LIVE.indexOf(fn)
      expect(at).toBeGreaterThan(-1)
      const body = LIVE.slice(at, at + 900)
      expect(body).toMatch(/finishSegment\(\)/)
    }
  })

  it('drops silence instead of posting empty rows to the agent context', () => {
    expect(LIVE).toMatch(/minSegmentChars = \d+/)
    const fin = fnBody(LIVE, 'private func finishSegment()')
    // Re-anchored: the guard is no longer a one-liner. A short segment now has to
    // delete its own audio on the way out, so the `else` opens a block — but the
    // THRESHOLD is the claim, and the early return is still what enforces it.
    expect(fin).toMatch(/guard text\.count >= Self\.minSegmentChars else \{/)
    expect(fin, 'a segment too short to store is leaking its audio file')
      .toMatch(/text\.count >= Self\.minSegmentChars else \{\s*\n\s*if let u = audio\?\.url \{ try\? FileManager\.default\.removeItem\(at: u\) \}\s*\n\s*return\s*\n\s*\}/)
  })

  it('finishSegment stores banked words even when the live task is dead', () => {
    // The LAST thing a stream does is fall quiet, so the common case is a segment
    // ending with speechRequest already nil. Guarding on the request alone would
    // discard every utterance restartTask() banked — which is most of them.
    const body = fnBody(LIVE, 'private func finishSegment()')
    // Re-anchored with a third arm: a segment can now have written an audio file
    // and banked nothing (an empty room still records), and that file has to be
    // closed and deleted rather than left open and orphaned. Returning early on
    // `segmentAudio != nil` is what reaches the cleanup below.
    expect(body).toMatch(
      /guard speechRequest != nil \|\| !bankedUtterances\.isEmpty \|\| segmentAudio != nil else \{ return \}/)
    expect(body).toMatch(/let text = segmentText\(\)/)
    // And it must reset the segment's accumulators, or the next segment inherits
    // the last one's words and stores them a second time.
    expect(body).toMatch(/bankedUtterances = \[\]/)
    expect(body).toMatch(/preroll = \[\]/)
  })

  it('a finished segment goes down the same rail as a phone-mic take', () => {
    // The user reads it in the transcripts list; the agent reads it in context.
    // Anything less means the necklace's speech is heard and then forgotten.
    const fin = fnBody(LIVE, 'private func finishSegment()')
    expect(fin).toMatch(/NiclaRecorder\.shared\.storeHeard\(/)
    // Re-anchored, and STRONGER than the literal it replaces. The label is now a
    // shared constant because the eviction rule keys off it: a typo in either
    // place would exempt live audio from its own disk budget, silently, with
    // every row still playing. So both halves of the indirection are pinned —
    // the call site referring to the constant, and the constant's own value,
    // which is the string the agent's tool descriptions promise.
    expect(fin, 'the label went back to a literal — the budget can now drift from the writer')
      .toMatch(/label: NiclaRecorder\.liveLabel/)
    expect(REC).toMatch(/liveLabel = "necklace-live"/)

    const body = fnBody(REC, 'func storeHeard(')
    expect(body).toMatch(/transcripts\.insert\(entry, at: 0\)/)   // the list
    expect(body).toMatch(/pruneAndSave\(\)/)                       // survives relaunch
    expect(body).toMatch(/postToServer\(entry/)                    // the agent
    // Re-anchored: a segment row now CAN own a local file (that is the whole
    // point of the arc), so the old `audioFile: nil` literal is gone. The claim
    // underneath it was "whatever the caller passes is what gets stored, and the
    // row is honest about having no audio" — so what is pinned is the pass-through
    // plus the default that keeps every other caller text-only.
    expect(body).toMatch(/audioFile: audioFile, audioUrl: nil/)
    expect(REC).toMatch(/func storeHeard\(text: String, label: String, seconds: Int, audioFile: String\? = nil\)/)
    // And it must refuse empty text on its own, not trust its one caller —
    // now also deleting the file it was handed, since no row will reference it.
    expect(body).toMatch(/guard !clean\.isEmpty else \{/)
    expect(body, 'empty words now leak the segment file they were handed')
      .toMatch(/if let f = audioFile \{/)
  })

  it('a Vision-heard segment is signed by the PHONE, not the Voice necklace', () => {
    // The device token resolves the owner AND the attribution server-side.
    // postToServer defaults to the Voice's credential because a phone-mic take
    // is the necklace hearing you; a Vision audio segment is a different board
    // entirely, and filing it under the Voice would put words in the mouth of
    // hardware that was not in the room.
    expect(fnBody(REC, 'func storeHeard(')).toMatch(/postToServer\(entry, asVoiceNecklace: false\)/)
    const body = fnBody(REC, 'private func postToServer(')
    expect(body).toMatch(/asVoiceNecklace: Bool = true/)
    // The false branch must NOT be able to fall back to the gateway credential.
    expect(body).toMatch(/\? \(NiclaVoiceGateway\.shared\.credentials \?\? phone\)\s*\n\s*: phone/)
  })

  it('a 120s TAKE also survives its recognizer dying', () => {
    // The same defect TinyLive was fixed for, in the other file, unguarded.
    //
    // NiclaRecorder.record() creates ONE SFSpeechRecognitionTask and runs a take
    // of up to 120 seconds through it (the memo button passes exactly 120). Its
    // callback did `box.setText(text)` — an OVERWRITE with the current task's
    // transcription. One task reports ONE utterance, so after the first sentence
    // the task goes quiet while the tap keeps appending buffers happily: a
    // two-minute voice memo stored only its opening sentence, and the m4a beside
    // it held the whole two minutes, so nothing looked broken. The reply said ok
    // and the text was a plausible short sentence.
    //
    // This is the recorder the user calls "a really good voice recorder", and the
    // transcript is the half that reaches the agent's context.
    //
    // Pinned as banking + restart, the properties TinyLive proved on real audio:
    // an ended task's words are KEPT, a fresh task takes over, and the tail is
    // replayed only when the old task died mid-utterance (replaying after a clean
    // final re-transcribes accounted-for speech and manufactures duplicates).
    const rec = REC.slice(REC.indexOf('func record(seconds:'))
    const body = rec.slice(0, rec.indexOf('\n    /// Store speech that was'))
    // A take must not be one immortal task: something has to notice it ended.
    expect(REC).toMatch(/func markEnded\(reportedUtterance: Bool/)
    expect(REC).toMatch(/var deliveredUtterance: Bool/)
    // …and the take loop must act on it, not just record it: bank the words,
    // then actually stand a replacement task up behind the running tap. Pinned
    // as the mechanism rather than a helper name — what matters is that a new
    // task exists and the tap is rewired to it, however that is spelled.
    expect(body).toMatch(/box\.isEnded/)
    expect(body).toMatch(/box\.bank\(\)/)
    expect(body).toMatch(/slot\.swap\(to:/)
    expect(body).toMatch(/task = Self\.recognize\(/)
    // Replay the preroll ONLY when the old task died mid-utterance. After a
    // clean final result that audio is already transcribed, so replaying it
    // makes the next task report the same sentence again.
    expect(body).toMatch(/replay: owedReplay|replay: !box\.deliveredUtterance/)
    // Banking, not overwriting: the accumulated text has to outlive the task
    // that heard it. `bank` may clear the LIVE buffer (`text = ""`) — that is
    // how the box is armed for the next task; what it must never do is drop
    // what it was handed, so pin the append.
    expect(REC).toMatch(/func bank\(/)
    const bankFn = REC.slice(REC.indexOf('func bank('))
    expect(bankFn.slice(0, bankFn.indexOf('\n    }'))).toMatch(/banked\.append\(t\)/)
    // The final transcript must read the BANKED text, not one task's last value.
    expect(body).toMatch(/box\.fullText|box\.banked/)
    // One box spans every task in the take (unlike TinyLive, which drops its box
    // per restart), so a callback must say WHICH task it speaks for. cancel() is
    // async: without this, the outgoing task writes its already-banked utterance
    // back into the live buffer — fullText emits it twice — and marks the
    // just-started task ended, tripping an immediate second restart.
    expect(REC).toMatch(/gen == generation/)
    expect(REC).toMatch(/func setText\(_ t: String, gen: Int\)/)
    expect(REC).toMatch(/markEnded\(reportedUtterance: Bool, gen: Int\)/)
    expect(body).toMatch(/gen: gen|gen: box\.currentGeneration/)
  })

  it('recognizer callbacks stay off the actor (the c9 rule)', () => {
    // A recognitionTask closure runs on Speech's own queue. Capturing
    // @MainActor state there is the crash this codebase has hit before, which
    // is why NiclaRecorder has TakeBox and this has LiveTextBox.
    expect(LIVE).toMatch(/final class LiveTextBox: @unchecked Sendable/)
    expect(LIVE).toMatch(/nonisolated static func recognize\(/)
    const rz = LIVE.slice(LIVE.indexOf('nonisolated static func recognize('))
    expect(rz.slice(0, 400)).toMatch(/box\.set\(text\)/)
  })

  it('the overlay shows the words and can switch transcription off', () => {
    expect(LIVE).toMatch(/func toggleTranscribe\(\)/)
    const ui = LIVE.slice(LIVE.indexOf('struct TinyLiveOverlay'))
    expect(ui).toMatch(/live\.toggleTranscribe\(\)/)
    // The note explains a refusal in words; without it "not transcribing" looks
    // exactly like "the necklace hasn't said anything yet".
    expect(ui).toMatch(/live\.speechNote/)
    expect(ui).toMatch(/live\.liveText/)
  })

  it('the LAN probe outlasts the board\'s real accept latency', () => {
    // The user's report: "connecting through the cloud but I'm on the same
    // wifi". The board was healthy — 144 frames in 15s at ~16 fps while the
    // complaint was live. What failed was the DIAL.
    //
    // The necklace runs a single-threaded loop that polls its listener between
    // blocking cloud calls, so accept latency includes whatever WAN round trip
    // is in flight. Measured ON the board: relay PUT 1.0-2.1s, heartbeat POST
    // 0.9-1.2s. Resulting dial latency over 24 trials: ~1.2s median, ~3.3s p90,
    // ~5.4s worst — and that is AFTER the firmware fix that removed a hard ~4.8s
    // floor (strands-nicla firmware/tiny_node.py `_nap`/`take_client`).
    //
    // So a 2s cutoff throws away a board that is present and answering, drops
    // the cached base, and pins the session to cloud frame polling. The timeout
    // has to cover the p90 at least; 6s covers the worst case measured.
    const probe = LIVE.slice(LIVE.indexOf('private func probe(base: String)'))
    const body = probe.slice(0, probe.indexOf('\n    }'))
    const m = body.match(/timeoutInterval = (\d+(?:\.\d+)?)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(5)
    // Still retried: the first LAN dial after an install is the one that raises
    // the iOS permission sheet, and it fails while the sheet is on screen.
    expect(body).toMatch(/for attempt in 0 \.\.< 3/)
  })
})
