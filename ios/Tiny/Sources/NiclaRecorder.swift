/**
 * 🎙️ NiclaRecorder — the Nicla Voice necklace's "voice recorder" half.
 *
 * The necklace itself can NEVER carry audio over BLE (64KB of RAM; a
 * 128-byte characteristic once broke every connection — see
 * NiclaVoiceGateway's header). So a wake event triggers THIS: the phone's
 * mic records a short clip while Apple's on-device speech recognition
 * transcribes it in the same pass — one engine, one tap, audio file +
 * transcript together (the GlassesListener shape, plus an AVAudioFile).
 *
 * Three callers:
 *   - NiclaVoiceGateway.handleWake (gated on Config.recordOnWake)
 *   - the relay envelope {type:"record", seconds, reason} — the worker's
 *     nicla_voice_record tool reaching this phone (Session.swift handles it
 *     in BOTH the foreground poller and backgroundBeat: relay envelopes are
 *     claim-on-poll, an unhandled type is consumed and destroyed)
 *   - the "Record now" button in VoiceDevicePanel
 *
 * After a take: audio saved under Documents/nicla-transcripts/ and uploaded
 * to /api/media (audio/mp4, 6MB cap ≈ 25min of 32kbps mono AAC — far above
 * the 120s clamp), transcript POSTed to /api/devices/transcript with the
 * NECKLACE's device token (attribution: the necklace heard it). If that
 * route isn't deployed yet, falls back to the `device_note` event kind —
 * already allowlisted — so transcripts join the agent's context either way.
 *
 * House crash rules obeyed: fresh AVAudioEngine per take, format guard
 * before installTap, tap + recognizer closures born in nonisolated statics
 * (the c9 rule), one mic — refuses to start while VoiceMode owns the input.
 */
import AVFoundation
import Speech
import SwiftUI

/// A take's outcome — Sendable so nonisolated callers (backgroundBeat) can
/// receive it across the MainActor boundary; [String: Any] cannot.
struct NiclaRecordResult: Sendable {
    let ok: Bool
    let transcript: String
    let transcriptId: String
    let audioUrl: String?
    let seconds: Int
    let error: String?

    static func failure(_ message: String) -> NiclaRecordResult {
        NiclaRecordResult(ok: false, transcript: "", transcriptId: "",
                          audioUrl: nil, seconds: 0, error: message)
    }
}

struct NiclaTranscript: Identifiable, Codable, Equatable {
    let id: String
    let at: Date
    let seconds: Int
    let label: String
    var text: String
    /// Local audio filename inside store dir (nil if the file write failed)
    var audioFile: String?
    /// Hosted /api/media URL (nil if upload failed or signed out)
    var audioUrl: String?
    /// True while `text` is the SERVER'S 200-CHAR PREVIEW rather than the take.
    ///
    /// The list endpoint returns `substr(text, 1, 200) AS preview` while the
    /// server keeps up to 16KB, and the memo button records 120 seconds — about
    /// 1700 characters of ordinary speech. So a refreshed row held ~12% of what
    /// was said and looked exactly like a complete short transcript: truncated
    /// text and short text are the same pixels. This flag is what lets the row
    /// know to fetch the rest, and it is why `text` is now `var`.
    ///
    /// Decodes to false for rows written by an older build — see the extension
    /// below, because the default value alone does NOT survive decoding.
    var isPreview: Bool = false
}

extension NiclaTranscript {
    /// Decode an index.json written before `isPreview` existed.
    ///
    /// ⚠️ A default value on a property does NOT make the synthesized `Decodable`
    /// init tolerate a missing key — it throws `.keyNotFound`. And `loadIndex()`
    /// turns any decode failure into `[]`, so adding this one field was a silent
    /// wipe of every transcript the user had ever recorded: first launch after the
    /// update would show "No transcripts yet", with the local audio files still
    /// sitting on disk unreferenced. `decodeIfPresent` is the fix.
    ///
    /// Declared in an EXTENSION so the memberwise `init(id:at:…isPreview:)` is
    /// still synthesized; writing this inside the struct would suppress it.
    /// Old rows default to `false`, not true — they are local takes, which always
    /// held the whole transcript, so marking them preview would send each one off
    /// to fetch a remainder that may not exist server-side.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decode(Date.self, forKey: .at)
        seconds = try c.decode(Int.self, forKey: .seconds)
        label = try c.decode(String.self, forKey: .label)
        text = try c.decode(String.self, forKey: .text)
        audioFile = try c.decodeIfPresent(String.self, forKey: .audioFile)
        audioUrl = try c.decodeIfPresent(String.self, forKey: .audioUrl)
        isPreview = try c.decodeIfPresent(Bool.self, forKey: .isPreview) ?? false
    }
}

/// Everything the realtime tap + recognizer callbacks touch — mutation
/// behind one lock, zero main-actor state (the c9/RecorderBox pattern).
private final class TakeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var text = ""
    private(set) var wroteFrames: Int = 0

    init(file: AVAudioFile?) { self.file = file }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let f = file else { return }
        do {
            try f.write(from: buffer)
            wroteFrames += Int(buffer.frameLength)
        } catch {
            // A failed write poisons the container — stop writing, keep the
            // transcript half of the take alive.
            file = nil
        }
    }

    var transcript: String { lock.lock(); defer { lock.unlock() }; return text }

    /// Which task's words the live buffer currently belongs to.
    ///
    /// `cancel()` is asynchronous: the outgoing task's callback can fire AFTER
    /// the box has been banked and handed to its replacement. Unlike TinyLive —
    /// which throws its box away per restart and so cannot be hit by this — one
    /// box spans every task in the take, because the banked text is the take's
    /// only copy. Without a generation, a late callback writes the previous
    /// utterance back into the live buffer (fullText would then emit it twice,
    /// once banked and once live) and sets `ended` on a task that just started,
    /// tripping an immediate second restart.
    private var generation = 0
    var currentGeneration: Int { lock.lock(); defer { lock.unlock() }; return generation }

    func setText(_ t: String, gen: Int) {
        lock.lock()
        if gen == generation { text = t }
        lock.unlock()
    }

    // ── One task is not enough for a 120-second take ──────────────────────
    //
    // ONE SFSpeechRecognitionTask reports ONE utterance. After its first
    // sentence it stops producing results and, critically, keeps accepting
    // appended buffers without complaint — so a take of up to 120s (the memo
    // button passes exactly that) stored only its opening sentence while the
    // m4a beside it held the whole thing. Nothing looked broken: the reply said
    // ok and the text was a plausible short sentence.
    //
    // TinyLive already learned this against 125s of the board's real audio (one
    // task there transcribed NOTHING at all). Same shape here: bank a finished
    // task's words, start another, and read the accumulated text at the end.

    /// Utterances from tasks that have already ended.
    private var banked: [String] = []
    private var ended = false
    private var deliveredFinal = false

    /// The task is over — it errored or delivered its final result.
    ///
    /// Ignored from a superseded task: a cancelled predecessor reporting its own
    /// death must not mark the live task dead.
    func markEnded(reportedUtterance: Bool, gen: Int) {
        lock.lock()
        if gen == generation {
            ended = true
            if reportedUtterance { deliveredFinal = true }
        }
        lock.unlock()
    }
    var isEnded: Bool { lock.lock(); defer { lock.unlock() }; return ended }

    /// Ended by delivering a final result rather than erroring out.
    ///
    /// The two endings need opposite handling. A final result means everything
    /// heard was already reported, so replaying the tail audio into the next task
    /// re-transcribes accounted-for speech and manufactures duplicates. An error
    /// can strike mid-utterance with syllables that exist nowhere else.
    var deliveredUtterance: Bool {
        lock.lock(); defer { lock.unlock() }
        return deliveredFinal
    }

    /// Move the live task's words into the bank and arm the box for a new task.
    ///
    /// Dedupes against the whole bank, not just the last entry: a replayed tail
    /// makes the next task re-transcribe a sentence that may be two utterances
    /// back, and a segment reading the same sentence twice is worse than a
    /// clipped one — a model treats it as two things being said.
    /// Returns the generation the NEXT task must report under.
    @discardableResult
    func bank(_ raw: String? = nil) -> Int {
        lock.lock(); defer { lock.unlock() }
        let t = (raw ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
        text = ""
        ended = false
        deliveredFinal = false
        generation += 1        // anything the outgoing task says from here is stale
        guard !t.isEmpty else { return generation }
        let existing = banked.joined(separator: " ").lowercased()
        let incoming = t.lowercased()
        if existing.contains(incoming) { return generation }
        // A longer re-reading of the previous utterance replaces it.
        if let prev = banked.last, incoming.contains(prev.lowercased()) {
            banked[banked.count - 1] = t
            return generation
        }
        banked.append(t)
        return generation
    }

    /// Everything the take has heard: banked utterances plus the live task's.
    var fullText: String {
        lock.lock(); defer { lock.unlock() }
        let live = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return (banked + (live.isEmpty ? [] : [live])).joined(separator: " ")
    }

    /// Finalize the container. close() is EXPLICIT (iOS 18+) because relying
    /// on dealloc shipped a real bug: the first e2e clip uploaded 97KB of
    /// ftyp+AAC packets with NO moov atom — the bytes were read before the
    /// deferred finalization wrote the index, and the hosted file was
    /// unplayable everywhere while the reply said "ok". Measure the file,
    /// not the reply.
    func finish() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let wrote = wroteFrames > 0 && file != nil
        try? file?.close()
        file = nil
        return wrote
    }
}

@MainActor
final class NiclaRecorder: ObservableObject {
    static let shared = NiclaRecorder()

    @Published private(set) var isRecording = false
    @Published private(set) var level: Float = 0
    /// Newest first; capped — the durable copy is the server's transcript store.
    @Published private(set) var transcripts: [NiclaTranscript] = []
    @Published private(set) var lastError: String?
    /// What the take has heard SO FAR, republished on the loop's 200ms tick.
    ///
    /// The live recording card showed a level meter and no words, and its own
    /// comment claimed "partial recognition text is not shown anywhere else in
    /// this view" — true, and there was nothing to show it: the recognizer's
    /// partials went into TakeBox and no further. A meter proves the mic hears
    /// SOMETHING; only words prove it hears YOU, which is the thing a person
    /// recording a memo actually wants to know before trusting it with two
    /// minutes of speech. Empty until the first partial arrives.
    @Published private(set) var partial = ""

    private static let indexCap = 50

    /// Floor between recognizer restarts inside one take.
    ///
    /// Same value and same reason as TinyLive's: a task that ends without
    /// reporting anything is usually a quiet room ("No speech detected" after
    /// ~8s), and rebuilding a task per chunk of silence was measured at 316
    /// restarts in 125s — which destroyed recognition instead of restoring it. A
    /// task that DID report an utterance bypasses this floor entirely, because
    /// the speaker is very likely still talking.
    private static let minRestartSeconds: TimeInterval = 2

    /// How long a take waits for more words before it accepts that the speaker
    /// is done. Long enough to cross the pause between two sentences (measured
    /// around 1s in normal speech), short enough that the take doesn't sit on
    /// the microphone after the room goes quiet.
    /// `nonisolated` for the same reason shouldExtend is: a constant that inherits
    /// the class's @MainActor can't be read from the pure rule that needs it.
    nonisolated static let silenceGrace: TimeInterval = 3

    /// Absolute ceiling on one take, extensions included. Was inline in record()
    /// as the clamp on `seconds`; named because shouldExtend needs the same value
    /// — an extended take must never be able to outlast a take that asked for the
    /// maximum outright.
    nonisolated static let maxSeconds = 120

    /// Set by stopEarly() to end the take in progress before its deadline.
    /// Reset when a take CLAIMS the mic, not when one finishes: a stopEarly()
    /// that arrives just after a take ends would otherwise sit here set and kill
    /// the next take on its first tick.
    private var stopRequested = false

    private init() {
        transcripts = Self.loadIndex()
        Self.sweepOrphanAudio(rows: transcripts)
    }

    /// End the current take now, keeping everything it captured.
    ///
    /// record(seconds:) used to be a promise the user could not take back — the
    /// take slept out its full duration no matter what. That is fine for the
    /// agent's fixed-length "record 10s" call and wrong for a recorder a person
    /// operates: you stop talking, so the recording should stop, and the take
    /// should still transcribe, upload and store what it got. This is a request,
    /// not a teardown; the take itself finalizes the file and uploads, which is
    /// why the audio survives being stopped mid-sentence.
    func stopEarly() {
        guard isRecording else { return }
        stopRequested = true
    }

    /// Pick between the live stitched transcript and the file's second pass.
    ///
    /// LONGER WINS, and only longer. The comparison is deliberately crude because
    /// of which failure it has to prevent: losing words the user really said. A
    /// second pass that returns nil (no model installed, unsupported locale,
    /// unreadable file), empty, or shorter than the live text is DISCARDED — the
    /// live text was heard by a task that was actually listening, and replacing it
    /// with less is a regression the user cannot detect or undo.
    ///
    /// Character count is a poor measure of transcription quality and a good
    /// detector of "half the take is missing", which is the actual problem: the
    /// live path stitches N SFSpeechRecognitionTasks and drops audio at every
    /// seam, so when the one-pass read of the same file is dramatically longer,
    /// the difference is words, not phrasing.
    /// `nonisolated` because it is a pure choice between two strings: it touches
    /// no recorder state, and hopping to the MainActor to compare two lengths
    /// would put the rule out of reach of a test that has no microphone.
    nonisolated static func betterTranscript(live: String, secondPass: String?) -> String {
        guard let full = secondPass?.trimmingCharacters(in: .whitespacesAndNewlines),
              !full.isEmpty, full.count > live.count else { return live }
        return full
    }

    /// Should a take that reached its deadline keep going?
    ///
    /// The wake word is the record button, and `handleWake` asks for 10 seconds.
    /// A person who says the wake word and then talks for thirty gets the first
    /// ten and silently loses the rest — the m4a ends, the transcript ends, and
    /// nothing in the result says it was cut. That is the wrong shape for a
    /// recorder: the take should end when the SPEAKER stops, not when a number a
    /// caller guessed runs out.
    ///
    /// So `seconds` becomes a floor rather than a promise, and the take keeps
    /// running while words are still arriving. Two bounds, because "extend while
    /// speaking" alone is an open microphone:
    ///
    ///   - `hardCap` is absolute. A noisy room can produce words forever, and a
    ///     take that never ends never uploads, never transcribes and never
    ///     releases the mic — a worse failure than a truncated one.
    ///   - `silenceGrace` since the last new words. Not "since the last audio":
    ///     level alone can't tell speech from a fan, and the point of the check
    ///     is whether the RECOGNIZER is still producing text.
    ///
    /// `nonisolated` and pure for the same reason as betterTranscript — this is
    /// the whole stop rule, and it has to be testable without a microphone.
    /// The ceiling a take is actually allowed to reach.
    ///
    /// Extracted from record() because it is the whole opt-in gate, and leaving it
    /// inline made it untestable — a mutation that let EVERY take extend passed the
    /// entire suite, which is precisely the regression that would break
    /// `nicla_voice_record` (it polls for `seconds + 25` and would be answered by a
    /// take that had run to two minutes).
    nonisolated static func hardCapSeconds(requested: Int, extendWhileSpeaking: Bool) -> Int {
        extendWhileSpeaking ? maxSeconds : requested
    }

    nonisolated static func shouldExtend(now: Date, deadline: Date, hardCap: Date,
                                         lastGrowthAt: Date, stopRequested: Bool) -> Bool {
        if stopRequested { return false }        // the user's Stop always wins
        if now >= hardCap { return false }
        if now < deadline { return true }        // still inside what was asked for
        return now.timeIntervalSince(lastGrowthAt) < silenceGrace
    }

    // ── The take ──────────────────────────────────────────────────────────

    /// One-shot: record `seconds` of phone mic audio while transcribing
    /// on-device. Returns a Sendable outcome every caller can relay.
    /// - Parameter extendWhileSpeaking: treat `seconds` as a FLOOR and keep
    ///   recording while words are still arriving (see shouldExtend). Off by
    ///   default, and that default is the contract: `nicla_voice_record` polls the
    ///   relay for only `seconds + 25`, so a take that extended to two minutes
    ///   would answer an agent that stopped listening — the transcript would be
    ///   stored but the caller would be told it timed out. The wake path has no
    ///   caller waiting on a budget, which is why it is the one that opts in.
    func record(seconds: Int, label: String, token: String?,
                extendWhileSpeaking: Bool = false) async -> NiclaRecordResult {
        let clamped = min(max(seconds, 5), Self.maxSeconds)
        guard !isRecording else { return .failure("already recording") }
        guard !VoiceMode.shared.active else {
            return .failure("voice mode is using the microphone — stop it first")
        }
        // Claim the mic SYNCHRONOUSLY, before the first await below.
        //
        // @MainActor gives mutual exclusion, not atomicity across suspension
        // points: every `await` yields the actor. The guard above and the old
        // `isRecording = true` (down past the permission requests and the
        // session setup) were separated by several awaits, so two wakes in one
        // burst BOTH passed the guard and raced to install a tap on the single
        // shared input node — two engines, two taps, one mic. The board really
        // does deliver bursts (8 back-to-back wake notifications measured on
        // hardware), so this was reachable, not theoretical, and it made a lie
        // of the gateway's "NiclaRecorder refuses to double-start" comment.
        isRecording = true
        // Clear any stale early-stop here, where the mic is claimed — see
        // stopRequested. A stop that lands between takes must not kill the next.
        stopRequested = false
        var claimed = true
        /// Give the claim back on a path that never reaches the take.
        func release() {
            guard claimed else { return }
            claimed = false
            isRecording = false
            level = 0
            // Cleared with the claim, so the next take never opens showing the
            // previous one's words — and so a failed take leaves nothing behind
            // that looks like a recording in progress.
            partial = ""
        }
        guard await Self.speechAuthorized(),
              await AVAudioApplication.requestRecordPermission() else {
            release()
            lastError = "microphone/speech permission not granted"
            return .failure("microphone/speech permission not granted on the phone")
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
            try audio.setActive(true)
        } catch {
            release()
            return .failure("mic session: \(error.localizedDescription)")
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable else {
            release()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return .failure("speech recognition unavailable on this phone")
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        // A take here is up to 10s of unprompted speech that a model reads later
        // — unlike the short command phrases elsewhere in the app, it needs
        // sentence boundaries to stay legible. Without this a wake-triggered
        // transcript arrives as one unpunctuated run-on.
        request.addsPunctuation = true

        // Fresh engine per take; format guard before installTap (an invalid
        // format is an uncatchable ObjC exception, not a Swift error).
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            release()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return .failure("the mic isn't ready (audio route mid-change) — try again in a second")
        }

        let id = UUID().uuidString
        let fileURL = Self.storeDir().appendingPathComponent("\(id).m4a")
        // AAC mono-ish at the tap's own rate/channels: the processing format
        // must MATCH the tap buffers exactly or write(from:) throws on frame 1.
        let file = try? AVAudioFile(
            forWriting: fileURL,
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVEncoderBitRateKey: 32_000,
            ],
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved)
        let box = TakeBox(file: file)

        let slot = RequestSlot(request)
        Self.installTap(on: input, format: format, feed: slot, box: box) { [weak self] lvl in
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                self.level = lvl
            }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            release()
            input.removeTap(onBus: 0)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return .failure("mic: \(error.localizedDescription)")
        }

        // isRecording is already true (claimed above); the take now owns it.
        lastError = nil
        var task = Self.recognize(recognizer, request: request, box: box,
                                  gen: box.currentGeneration)
        var taskStartedAt = Date()

        // Sleep in slices so stopEarly() can end the take, instead of one
        // uninterruptible sleep to the deadline. 200ms is the granularity of
        // "Stop feels instant" without waking the actor often enough to matter
        // next to the audio tap already running. The same tick also watches for
        // a dead recognizer, which is why the loop cannot become one long sleep.
        let startedAt = Date()
        let deadline = startedAt.addingTimeInterval(Double(clamped))
        // `clamped` is a FLOOR, not a promise — see shouldExtend. The hard cap is
        // what actually bounds the take, and it is the same 120s ceiling record()
        // already clamps to, so an extended take can never outlast a take that
        // asked for the maximum.
        let hardCap = startedAt.addingTimeInterval(Double(
            Self.hardCapSeconds(requested: clamped, extendWhileSpeaking: extendWhileSpeaking)))
        var lastGrowthAt = startedAt
        var seenChars = 0
        while Self.shouldExtend(now: Date(), deadline: deadline, hardCap: hardCap,
                                lastGrowthAt: lastGrowthAt, stopRequested: stopRequested) {

            // ONE task reports ONE utterance, then goes silent while still
            // accepting buffers. On a take of up to 120s that meant everything
            // after the first sentence was dropped — silently, with a full-length
            // m4a beside it. Replace the task and keep its words.
            //
            // Rate-limited the way TinyLive's is: an ended task during a quiet
            // room is the common case ("No speech detected" after ~8s), and
            // rebuilding one per chunk of silence was measured at 316 restarts in
            // 125s, which destroyed recognition rather than restoring it. So
            // restart INSTANTLY when an utterance was reported (the speaker is
            // very likely still going) and otherwise wait out the floor.
            if box.isEnded,
               box.deliveredUtterance
                   || Date().timeIntervalSince(taskStartedAt) >= Self.minRestartSeconds {
                // Replay the tail only if the task died mid-utterance: after a
                // clean final result that audio is already transcribed, and
                // replaying it produces the same sentence twice.
                let owedReplay = !box.deliveredUtterance
                let gen = box.bank()   // banking bumps the generation
                slot.current?.endAudio()
                task.cancel()

                let next = SFSpeechAudioBufferRecognitionRequest()
                next.shouldReportPartialResults = true
                next.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
                next.addsPunctuation = true
                slot.swap(to: next, replay: owedReplay)
                task = Self.recognize(recognizer, request: next, box: box, gen: gen)
                taskStartedAt = Date()
            }

            // Republish on the tick the loop already runs, rather than from the
            // recognition callback: that callback is nonisolated and fires on
            // whatever thread Speech chooses, and hopping to the MainActor per
            // partial would post far more updates than a view can use. fullText,
            // not `transcript` — after a restart the live task holds only the
            // latest utterance, so the card would appear to forget the sentence
            // the user just watched it type.
            let text = box.fullText
            partial = text
            // Growth, measured on the text the recognizer has actually produced.
            // Length, not inequality: a task restart can REPLACE the live
            // utterance with a shorter re-reading of the same words, and treating
            // that as new speech would hold the mic open through silence.
            if text.count > seenChars {
                seenChars = text.count
                lastGrowthAt = Date()
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        // What the take REALLY captured. Storing `clamped` here would label a
        // 4-second stopped-early take as 60 seconds, which is a lie in the list,
        // in the agent's context, and in the duration the server keeps. Floor of
        // 1 so a stop within the first tick isn't recorded as a 0-second take.
        // Clamped to maxSeconds, NOT to `clamped`: now that a take can run past
        // what was asked for, using `clamped` as the ceiling would label a 40s
        // extended take as 10s — the same lie in the other direction, and the one
        // that matters more because the extra audio really is in the file.
        let actualSeconds = max(1, min(Self.maxSeconds, Int(Date().timeIntervalSince(startedAt).rounded())))
        stopRequested = false

        slot.current?.endAudio()      // the CURRENT request, not the first one
        // Give on-device recognition a beat to finalize the tail of the take.
        try? await Task.sleep(for: .milliseconds(700))
        task.cancel()
        engine.stop()
        input.removeTap(onBus: 0)
        release()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        // fullText, not transcript: `transcript` is only the LIVE task's value,
        // which after a restart is the last utterance alone. A 90s memo that
        // restarted four times would store its closing sentence and drop the rest.
        let live = box.fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAudio = box.finish()
        if !hasAudio { try? FileManager.default.removeItem(at: fileURL) }

        // ── Second pass: read the whole FILE with the large model ─────────────
        //
        // `live` is the stitched output of however many SFSpeechRecognitionTasks
        // this take needed, and every restart boundary is a seam where audio
        // arrived while no task was listening. The m4a beside it has all of the
        // audio, and on iOS 26 SpeechAnalyzer transcribes a file in one pass with
        // no session cap — the engine VoiceMode already uses live, applied here to
        // the recording instead of the microphone (so no second engine on the
        // shared input node).
        //
        // The choice itself lives in `betterTranscript` so it can be tested
        // without a microphone — see NiclaSecondPassTests.
        var secondPass: String?
        if hasAudio, #available(iOS 26.0, *) {
            secondPass = await VoiceAnalyzer.transcribeFile(at: fileURL)
        }
        let heard = Self.betterTranscript(live: live, secondPass: secondPass)
        if heard != live {
            // Left as a breadcrumb rather than a silent swap: when a transcript
            // looks wrong, the first question is which engine produced it.
            print("🎙️ second pass: \(live.count) → \(heard.count) chars (SpeechAnalyzer)")
        }

        var entry = NiclaTranscript(
            id: id, at: Date(), seconds: actualSeconds, label: label,
            text: heard.isEmpty ? "(silence)" : heard,
            audioFile: hasAudio ? "\(id).m4a" : nil, audioUrl: nil)

        // Upload the audio (best-effort; the transcript is the payload).
        // The moov check is the tripwire for the unfinalized-container bug:
        // an m4a without its index plays nowhere, and uploading one turns a
        // healthy "ok" reply into a lie about what's actually hosted.
        let bearer = token ?? Keychain.get("tiny_token")
        if hasAudio, let clip = try? Data(contentsOf: fileURL), !clip.isEmpty,
           clip.count <= 6 * 1024 * 1024,
           clip.range(of: Data("moov".utf8)) != nil {
            if let up: [String: Any] = try? await Api.post("/api/media", token: bearer, body: [
                "data": clip.base64EncodedString(),
                "contentType": "audio/mp4",
            ]), let url = up["url"] as? String {
                entry.audioUrl = url
            }
        }

        transcripts.insert(entry, at: 0)
        pruneAndSave()
        await postToServer(entry)

        return NiclaRecordResult(ok: true, transcript: heard, transcriptId: id,
                                 audioUrl: entry.audioUrl, seconds: actualSeconds, error: nil)
    }

    /// Store speech that was transcribed somewhere OTHER than a phone-mic take.
    ///
    /// TinyLive transcribes the Nicla Vision's `/audio` stream as it plays it:
    /// the words are the necklace's own microphone, not this phone's, so there
    /// is no take — but the transcript belongs in exactly the same two places
    /// (the list the user reads, and the context the agent reads).
    ///
    /// - Parameter audioFile: a file ALREADY written into storeDir(). Optional
    ///   because a segment whose audio failed to write must still store its words:
    ///   losing the recording is bad, losing the transcript with it is worse.
    ///   Text-only rows are also why `audioFile`/`audioUrl` are optional and why
    ///   `playable()` checks both.
    func storeHeard(text: String, label: String, seconds: Int, audioFile: String? = nil) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            // No words means no row, so nothing would ever reference the file.
            if let f = audioFile {
                try? FileManager.default.removeItem(at: Self.storeDir().appendingPathComponent(f))
            }
            return
        }
        let entry = NiclaTranscript(
            id: UUID().uuidString, at: Date(), seconds: max(1, seconds),
            label: label, text: clean, audioFile: audioFile, audioUrl: nil)
        transcripts.insert(entry, at: 0)
        pruneAndSave()
        // Attributed to the PHONE, not to the Voice necklace. The device token
        // is what resolves the owner server-side, so posting a Vision-heard
        // segment with the Voice's credential would file it under a board that
        // was not in the room. The Vision cannot post for itself (its token
        // lives on the board and it has no session), so the phone — whose
        // recognizer produced these words — is the honest signer.
        Task { await postToServer(entry, asVoiceNecklace: false) }
    }

    // ── Server join: the transcript reaches the agent's context ───────────

    /// POST to /api/devices/transcript as the NECKLACE (device-token auth);
    /// falls back to the phone's own device identity, and to the allowlisted
    /// `device_note` event kind while the transcript route isn't deployed.
    private func postToServer(_ t: NiclaTranscript, asVoiceNecklace: Bool = true) async {
        let phone = Keychain.get("tiny_device_id").flatMap { did in
            Keychain.get("tiny_device_token").map { (deviceId: did, token: $0) }
        }
        let creds = asVoiceNecklace
            ? (NiclaVoiceGateway.shared.credentials ?? phone)
            : phone
        guard let creds else { return }
        var body: [String: Any] = [
            "deviceId": creds.deviceId, "token": creds.token,
            "text": t.text, "label": t.label, "durationS": t.seconds,
        ]
        if let u = t.audioUrl { body["audioUrl"] = u }
        if let r = try? await Api.postRaw("/api/devices/transcript", body: body),
           r["ok"] as? Bool == true { return }
        // Fallback rail: a short preview on the event ring (detail ≤240 chars
        // worker-side) still lands in the next chat turn's context block.
        let preview = String(t.text.prefix(180))
        _ = try? await Api.postRaw("/api/devices/event", body: [
            "deviceId": creds.deviceId, "token": creds.token,
            "kind": "device_note",
            "detail": "🎙️ \(t.label): “\(preview)”" + (t.audioUrl.map { " \($0)" } ?? ""),
        ])
    }

    // ── Reading the durable copy back ─────────────────────────────────────

    /// Merge the server's transcripts into the local list.
    ///
    /// This class was WRITE-ONLY: every take was POSTed, and the view then
    /// listed from the local index — capped at 50, in Documents. So the header's
    /// claim that "the durable copy is the server's transcript store" was true
    /// of the data and false of the app, which could never see it. A reinstall,
    /// a second device, or simply the 51st recording lost transcripts the server
    /// still held.
    ///
    /// Local rows WIN on id collision: only they know about the downloaded audio
    /// file, and overwriting one with the server's preview would replace the
    /// full text with 200 chars and strip its offline playback.
    func refreshFromServer() async {
        guard let list: [String: Any] = try? await Api.get(
            "/api/devices/transcript?limit=50", token: Keychain.get("tiny_token")),
            let rows = list["transcripts"] as? [[String: Any]]
        else { return }
        let known = Set(transcripts.map(\.id))
        let fetched: [NiclaTranscript] = rows.compactMap { r in
            guard let id = r["id"] as? String, !known.contains(id) else { return nil }
            // The list endpoint returns `preview` — literally `substr(text, 1, 200)`
            // — so a row built from it is a STUB, and `isPreview` says so. The old
            // comment here said "a tap can fetch the full text by id later", which
            // was an intention, not a feature: nothing on either phone ever passed
            // ?id=, so the app's copy of a 120s memo was its first ~200 characters
            // with no sign the other 88% existed. `created` is unixepoch.
            let full = (r["text"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let created = (r["created"] as? Double) ?? Double(r["created"] as? Int ?? 0)
            return NiclaTranscript(
                id: id,
                at: Date(timeIntervalSince1970: created),
                seconds: (r["duration_s"] as? Int) ?? 0,
                label: (r["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "recording",
                text: full ?? (r["preview"] as? String) ?? "",
                audioFile: nil,
                audioUrl: (r["audio_url"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                // Trust the row's own `truncated` flag when the server sends one;
                // otherwise infer it — a preview is only short of the whole take
                // when it actually hit the 200-char cut.
                isPreview: full == nil
                    && ((r["truncated"] as? Bool)
                        ?? (((r["preview"] as? String)?.count ?? 0) >= Self.previewChars))
            )
        }
        guard !fetched.isEmpty else { return }
        transcripts = (transcripts + fetched).sorted { $0.at > $1.at }
        pruneAndSave()
    }

    /// Server-side `TRANSCRIPT_PREVIEW_CHARS`. A list row exactly this long is
    /// assumed cut rather than coincidentally that length; being wrong costs one
    /// redundant GET that rewrites the same text, so the cheap direction is to
    /// over-fetch, never to under-mark.
    static let previewChars = 200

    /// Pull ONE transcript's full text through the `?id=` branch and keep it.
    ///
    /// This is the consumer the read proxy never had. The chain was whole on every
    /// other link: the worker's `TranscriptGetCall` returns the stored text (up to
    /// a 16KB cap), `/api/devices/transcript?id=` proxies it under the caller's
    /// session, and the agent's own `nicla_voice_transcript` tool reads it — the
    /// AGENT could quote a memo back that the phone that recorded it could not
    /// show you.
    ///
    /// The result is written to the on-disk index, not just to view state: the
    /// index IS the app's cache, so a @State-only update would re-fetch on every
    /// tap and lose the text again at the next launch.
    @discardableResult
    func fetchFullText(_ t: NiclaTranscript) async -> String? {
        guard let res: [String: Any] = try? await Api.get(
            "/api/devices/transcript?id=\(t.id)", token: Keychain.get("tiny_token")),
            let row = res["transcript"] as? [String: Any],
            let full = row["text"] as? String, !full.isEmpty
        else { return nil }
        guard let i = transcripts.firstIndex(where: { $0.id == t.id }) else { return full }
        transcripts[i].text = full
        transcripts[i].isPreview = false
        pruneAndSave()
        return full
    }

    // ── Local persistence (Documents-JSON house pattern, Sessions.swift) ──

    /// Not private: TinyLive writes necklace-live segment audio into the SAME
    /// directory, because audioURL(for:) resolves a row's `audioFile` against it.
    /// A second directory would give those rows a Play button that resolves to
    /// nothing.
    static func storeDir() -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("nicla-transcripts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func audioURL(for t: NiclaTranscript) -> URL? {
        t.audioFile.map { storeDir().appendingPathComponent($0) }
    }

    private static func loadIndex() -> [NiclaTranscript] {
        let url = storeDir().appendingPathComponent("index.json")
        guard let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([NiclaTranscript].self, from: data) else { return [] }
        return list
    }

    /// Label TinyLive files its live segments under. Shared so the eviction rule
    /// and the writer cannot drift — a typo here would silently make live audio
    /// permanent, which is the exact failure the rule exists to prevent.
    nonisolated static let liveLabel = "necklace-live"

    /// Byte budget for AUTOMATIC audio: 6.2h of listening, MEASURED not computed.
    ///
    /// A 45s segment encoded exactly the way SegmentAudio encodes one (16kHz mono
    /// AAC, 32kbps requested, speech-like duty cycle) came out at 197KB — 36kbps
    /// on the wire, since the requested rate excludes container overhead. So 96MB
    /// is 497 segments, not the ~4h that dividing by 32kbps predicts.
    nonisolated static let liveAudioBudget = 96 * 1024 * 1024

    /// Which rows should lose their audio file, oldest automatic audio first.
    ///
    /// pruneAndSave's rule was "never evict a row that owns a local audio file",
    /// and it was right for what existed: takes are made by hand, a few a day, and
    /// a refresh must not destroy the only offline copy. Live segments break the
    /// assumption underneath it — the necklace files one every 45 seconds for as
    /// long as its card is open, so "keep them all" is unbounded disk growth on
    /// someone's phone.
    ///
    /// So the bound applies ONLY to automatic audio, and hand-made takes stay
    /// exempt. The text of an evicted row is untouched: what the necklace heard is
    /// small, durable, and the thing the agent reads — losing the recording is a
    /// tradeoff, losing the words with it would not be.
    ///
    /// - Parameter rows: newest first, `(id, label, bytes)`.
    /// - Returns: ids whose audio file should be deleted.
    nonisolated static func audioEvictions(
        rows: [(id: String, label: String, bytes: Int)], budget: Int
    ) -> Set<String> {
        var used = 0
        var evict: Set<String> = []
        // A row with no audio on disk (text-only, or a segment whose file failed to
        // write) is never evicted, and needs no guard to say so: `used` is only ever
        // advanced when it fits, so `used <= budget` holds and a 0-byte row's
        // `used + 0 <= budget` is always true. A `r.bytes > 0` filter here read as
        // load-bearing and could not be broken by any mutation.
        for r in rows {
            // A manual take is never counted and never evicted, so a phone full of
            // live segments cannot push a memo off the disk.
            guard r.label == liveLabel else { continue }
            if used + r.bytes <= budget {
                used += r.bytes
            } else {
                evict.insert(r.id)
            }
        }
        return evict
    }

    /// Files in storeDir() that no row claims, so they can be deleted at launch.
    ///
    /// audioEvictions bounds the audio rows POINT at. A segment file is opened
    /// before its row exists — TinyLive writes as it listens and only calls
    /// storeHeard when the segment closes — so a crash, a force-quit, or a jetsam
    /// kill mid-segment leaves a file nothing references. Those are invisible to
    /// every rule here (pruneAndSave walks `transcripts`, and an orphan is in no
    /// row's audioFile), which means the budget could be perfectly enforced while
    /// the directory still grew without limit. This is the other door.
    ///
    /// index.json is not audio and is what the rows were loaded from; anything
    /// else without a claim, and old enough that nothing can still be writing it,
    /// goes.
    ///
    /// The age gate is not caution, it is required for correctness. `shared` is
    /// lazily initialized, and the FIRST live segment is what triggers it — from
    /// storeHeard, after the file was written and before the row exists. Without
    /// the gate this sweep would delete the very segment that woke it, and could
    /// delete one still open (AVAudioFile would keep writing to an unlinked inode
    /// and the audio would vanish with every log still reading ok). A segment is
    /// at most `segmentSeconds` and a take at most `maxSeconds`, so minutes of
    /// slack costs one extra launch before an orphan is collected.
    nonisolated static let minOrphanAge: TimeInterval = 600

    nonisolated static func orphanAudio(
        files: [(name: String, age: TimeInterval)], rows: [String]
    ) -> [String] {
        let claimed = Set(rows)
        return files.filter {
            $0.name != "index.json" && !claimed.contains($0.name) && $0.age >= minOrphanAge
        }.map(\.name)
    }

    private static func sweepOrphanAudio(rows: [NiclaTranscript]) {
        let dir = storeDir()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        let now = Date()
        let files = names.map { n -> (name: String, age: TimeInterval) in
            var age: TimeInterval = 0
            if let attrs = try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(n).path),
               let m = attrs[.modificationDate] as? Date { age = now.timeIntervalSince(m) }
            return (n, age)
        }
        for f in orphanAudio(files: files, rows: rows.compactMap(\.audioFile)) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    private func pruneAndSave() {
        // Keep the newest `indexCap`, but NEVER evict a row that owns a local
        // audio file just because server rows outnumber it.
        //
        // Since refreshFromServer() merges by date, a server row can sort above
        // an older local recording and push it past the cap — and the old prune
        // deleted the dropped row's file. That would mean a refresh silently
        // destroying the only offline copy of audio the user can still play,
        // which is the opposite of what pulling the durable copy is for. Rows
        // with a file on disk are kept; only server-shaped rows (no local audio,
        // re-fetchable any time) are dropped to make room.
        let hasLocalAudio = { (t: NiclaTranscript) -> Bool in
            Self.audioURL(for: t).map { FileManager.default.fileExists(atPath: $0.path) } == true
        }
        var kept: [NiclaTranscript] = []
        var dropped: [NiclaTranscript] = []
        for t in transcripts {
            if kept.count < Self.indexCap || hasLocalAudio(t) { kept.append(t) } else { dropped.append(t) }
        }
        for d in dropped {
            if let url = Self.audioURL(for: d) { try? FileManager.default.removeItem(at: url) }
        }
        // Bound the AUTOMATIC audio, keeping the words. See audioEvictions: rows
        // are newest-first here, so this keeps the recent past playable and lets
        // the older segments become text-only rather than filling the disk.
        let sized = kept.map { t -> (id: String, label: String, bytes: Int) in
            var bytes = 0
            if let u = Self.audioURL(for: t),
               let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
               let n = attrs[.size] as? Int { bytes = n }
            return (t.id, t.label, bytes)
        }
        let evict = Self.audioEvictions(rows: sized, budget: Self.liveAudioBudget)
        if !evict.isEmpty {
            for i in kept.indices where evict.contains(kept[i].id) {
                if let u = Self.audioURL(for: kept[i]) { try? FileManager.default.removeItem(at: u) }
                kept[i].audioFile = nil
            }
        }
        transcripts = kept
        let url = Self.storeDir().appendingPathComponent("index.json")
        if let data = try? JSONEncoder().encode(transcripts) {
            try? data.write(to: url, options: .atomic)
        }
    }

    func delete(_ t: NiclaTranscript) {
        if let url = Self.audioURL(for: t) { try? FileManager.default.removeItem(at: url) }
        transcripts.removeAll { $0.id == t.id }
        pruneAndSave()
    }

    // ── Nonisolated bridge layer (closures born free of actor isolation) ──

    private nonisolated static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
    }

    private nonisolated static func installTap(
        on input: AVAudioInputNode, format: AVAudioFormat,
        feed: RequestSlot, box: TakeBox,
        onLevel: @escaping @Sendable (Float) -> Void
    ) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            // Through the SLOT, not a captured request: a take outlives its first
            // recognition task, and a tap wired to the original request would
            // keep feeding a dead one for the rest of a two-minute memo.
            feed.append(buffer)
            box.write(buffer)
            onLevel(VoiceMode.rms(of: buffer))
        }
    }

    /// `gen` stamps every callback with the task it came from, so a cancelled
    /// predecessor cannot write into its replacement's live buffer (see
    /// TakeBox.currentGeneration).
    private nonisolated static func recognize(
        _ recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest, box: TakeBox, gen: Int
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            if let text = result?.bestTranscription.formattedString {
                box.setText(text, gen: gen)
            }
            // A task ending is normal and frequent, not an error to report: it
            // fires after every utterance, and after ~8s of a quiet room with
            // "No speech detected". The take loop watches isEnded and replaces
            // the task; without this the box never learns the task is deaf.
            let final = result?.isFinal == true
            if final || error != nil {
                box.markEnded(reportedUtterance: final, gen: gen)
            }
        }
    }
}

/// The request the live tap appends to, swappable underneath it.
///
/// The tap is installed once per take and runs on a realtime audio thread, but
/// the recognition task it feeds is replaced several times during a long take
/// (one task reports one utterance). A captured request would go stale on the
/// first swap; this indirection is what lets the take restart recognition without
/// tearing down the engine, the file, or the level meter.
///
/// Also holds the preroll: ~2s of recent audio replayed into a replacement task
/// when the old one died MID-utterance, so the syllables it never reported are
/// not lost. Not replayed after a clean final result — that audio is already
/// accounted for, and replaying it manufactures duplicate text.
private final class RequestSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var preroll: [AVAudioPCMBuffer] = []
    private var held = 0
    /// 2s at 16kHz. Matches TinyLive's window, which was tuned against the
    /// board's real stream.
    private static let prerollFrames = 32_000

    init(_ r: SFSpeechAudioBufferRecognitionRequest?) { request = r }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        request?.append(buffer)
        preroll.append(buffer)
        held += Int(buffer.frameLength)
        while held > Self.prerollFrames, preroll.count > 1 {
            held -= Int(preroll.removeFirst().frameLength)
        }
        lock.unlock()
    }

    /// Install a new request, optionally replaying the preroll into it.
    func swap(to r: SFSpeechAudioBufferRecognitionRequest?, replay: Bool) {
        lock.lock()
        request = r
        if replay, let r {
            for b in preroll { r.append(b) }
        }
        lock.unlock()
    }

    var current: SFSpeechAudioBufferRecognitionRequest? {
        lock.lock(); defer { lock.unlock() }
        return request
    }
}

// ── Transcripts UI (CallRecordingsView's shape, local-first) ──────────────

struct NiclaTranscriptsView: View {
    @ObservedObject private var rec = NiclaRecorder.shared
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var playingId: String?
    /// End-of-playback observer, torn down in stopPlayback() so a second play
    /// does not stack another one on the same notification.
    @State private var endObserver: NSObjectProtocol?
    /// Surfaced, not swallowed: record() explains every refusal in words
    /// ("voice mode is using the microphone — stop it first"), and a Record
    /// button that silently does nothing is the worst version of that.
    @State private var recordError: String?
    /// Ids with a full-text GET in flight, so a row shows a spinner instead of a
    /// second "Read in full" — and so scrolling a preview row off and back on
    /// cannot start the same fetch twice.
    @State private var hydrating: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                if rec.isRecording {
                    // A live take is the most important thing on screen while it
                    // runs. The meter proves the mic is moving; only WORDS prove
                    // it is hearing you, which is why rec.partial is rendered
                    // below it rather than kept inside the recognizer.
                    VStack(spacing: 10) {
                        Image(systemName: "waveform")
                            .font(.system(size: 34)).foregroundStyle(.red)
                            .symbolEffect(.variableColor.iterative)
                        HStack(spacing: 3) {
                            ForEach(0 ..< 14, id: \.self) { i in
                                Capsule()
                                    .fill(Double(rec.level) * 14 > Double(i) ? Color.red : Color.secondary.opacity(0.25))
                                    .frame(width: 4, height: 8 + CGFloat(i % 5) * 5)
                            }
                        }
                        .animation(.easeOut(duration: 0.15), value: rec.level)
                        // Live words, tailing. A long take would otherwise push
                        // the Stop button off-screen, and the newest words are
                        // the ones that answer "is it hearing me RIGHT NOW" —
                        // so the scroll pins to the bottom on every change.
                        if !rec.partial.isEmpty {
                            ScrollViewReader { sv in
                                ScrollView {
                                    Text(rec.partial)
                                        .font(.callout)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .id("tail")
                                }
                                .frame(maxHeight: 160)
                                .onChange(of: rec.partial) { _, _ in
                                    withAnimation(.easeOut(duration: 0.15)) {
                                        sv.scrollTo("tail", anchor: .bottom)
                                    }
                                }
                            }
                            .padding(.horizontal, 4)
                        }
                        // Two different states, said differently: silence during a
                        // take is normal at the start and alarming after 10 seconds,
                        // and this line is the only place the app can say which.
                        Text(rec.partial.isEmpty
                             ? "Recording — tap Stop when you're done."
                             : "Transcribing on-device — tap Stop when you're done.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button {
                            rec.stopEarly()
                        } label: {
                            Label("Stop and save", systemImage: "stop.circle.fill")
                        }
                        .buttonStyle(.borderedProminent).tint(.red)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if rec.transcripts.isEmpty {
                    ContentUnavailableView {
                        Label("No transcripts yet", systemImage: "waveform.badge.mic")
                    } description: {
                        Text("Tap Record, or say the necklace's wake word. The phone captures the audio and transcribes it on-device — it lands here and in your tiny's context.")
                    } actions: {
                        Button("Check for recordings") { Task { await rec.refreshFromServer() } }
                    }
                } else {
                    List {
                        ForEach(rec.transcripts) { t in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(spacing: 6) {
                                    Image(systemName: "waveform.badge.mic").foregroundStyle(.green)
                                    Text(t.label).font(.caption).bold()
                                    Spacer()
                                    Text(t.at.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                // The ellipsis is the whole tell. A 200-char cut and
                                // a genuinely short memo are the same pixels, so
                                // without it the row reads as the complete take.
                                Text(t.isPreview ? t.text + "…" : t.text).font(.callout)
                                HStack(spacing: 14) {
                                    if t.isPreview {
                                        if hydrating.contains(t.id) {
                                            ProgressView().controlSize(.mini)
                                        } else {
                                            // Retry rail: the row hydrates itself on
                                            // appear, so this is what's left when
                                            // that GET failed — offline, or a signed
                                            // -out session. Tapping is the only way
                                            // back to the rest of the words.
                                            Button { hydrate(t) } label: {
                                                Label("Read in full", systemImage: "text.quote")
                                            }
                                            .font(.caption)
                                        }
                                    }
                                    if playable(t) {
                                        Button {
                                            toggle(t)
                                        } label: {
                                            Label(playingId == t.id ? "Stop" : "Play \(t.seconds)s",
                                                  systemImage: playingId == t.id ? "stop.circle.fill" : "play.circle")
                                        }
                                        .font(.caption)
                                    }
                                    ShareLink(item: "\(t.label) — \(t.text)") {
                                        Label("Share", systemImage: "square.and.arrow.up")
                                    }
                                    .font(.caption)
                                    if t.audioUrl != nil {
                                        Label("uploaded", systemImage: "checkmark.icloud")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .padding(.vertical, 2)
                            // Hydrate as the row scrolls into view rather than
                            // pre-fetching all 50 on open: one GET per transcript
                            // the user actually looks at, and the button below is
                            // then only ever a retry.
                            .onAppear { if t.isPreview { hydrate(t) } }
                        }
                        .onDelete { idx in
                            for i in idx { rec.delete(rec.transcripts[i]) }
                        }
                    }
                }
            }
            .navigationTitle("Transcripts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                // Record from the screen where the recordings live. This view was
                // read-only, so the ONLY way to start a take by hand was the
                // Voice device panel — a different screen, and one that shows
                // nothing at all unless a necklace is paired to this phone. The
                // phone's mic and Apple's on-device recognition are what actually
                // do the work here, so a take never needed the board present.
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        if rec.isRecording {
                            rec.stopEarly()
                        } else {
                            Task {
                                let r = await rec.record(seconds: 120, label: "memo", token: nil)
                                if !r.ok { recordError = r.error ?? "Recording failed." }
                            }
                        }
                    } label: {
                        Label(rec.isRecording ? "Stop" : "Record",
                              systemImage: rec.isRecording ? "stop.circle.fill" : "mic.circle")
                    }
                    .tint(rec.isRecording ? .red : nil)
                }
            }
            // Pull the durable copy on open, and on demand: takes made while
            // this phone was elsewhere (a wake the necklace relayed through
            // another device, or a nicla_voice_record the agent commanded) exist
            // only on the server until something asks for them.
            .task { await rec.refreshFromServer() }
            .refreshable { await rec.refreshFromServer() }
            .onDisappear { stopPlayback() }
            .alert("Couldn't record", isPresented: .constant(recordError != nil)) {
                Button("OK") { recordError = nil }
            } message: {
                Text(recordError ?? "")
            }
        }
    }

    /// Fetch the rest of a preview row's text, at most once at a time per id.
    private func hydrate(_ t: NiclaTranscript) {
        guard !hydrating.contains(t.id) else { return }
        hydrating.insert(t.id)
        Task {
            await rec.fetchFullText(t)
            // Cleared on failure too: a stuck spinner would leave the row with no
            // way to try again, which is worse than showing the button once more.
            hydrating.remove(t.id)
        }
    }

    private func playable(_ t: NiclaTranscript) -> Bool {
        NiclaRecorder.audioURL(for: t).map { FileManager.default.fileExists(atPath: $0.path) } == true
            || t.audioUrl != nil
    }

    private func toggle(_ t: NiclaTranscript) {
        if playingId == t.id { stopPlayback(); return }
        stopPlayback()
        let local = NiclaRecorder.audioURL(for: t)
            .flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
        guard let url = local ?? t.audioUrl.flatMap(URL.init(string:)) else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        let p = AVPlayer(url: url)
        player = p
        playingId = t.id
        // Reset the row when the clip ends on its own. Without this nothing ever
        // clears playingId except another tap, so a finished clip left the button
        // reading "Stop" forever and the audio session held active — and the next
        // row's Play looked like it did nothing, because toggle() saw a stale id.
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
        ) { _ in
            Task { @MainActor in stopPlayback() }
        }
        p.play()
    }

    private func stopPlayback() {
        if let o = endObserver {
            NotificationCenter.default.removeObserver(o)
            endObserver = nil
        }
        player?.pause()
        player = nil
        playingId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
