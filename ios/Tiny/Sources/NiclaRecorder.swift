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
 * NECKLACE's device token (attribution: the necklace heard it). If that POST
 * fails, falls back to the `device_note` event kind — already allowlisted —
 * so transcripts join the agent's context either way.
 *
 * ⚠️ The fallback is the EXCEPTION. This header said "if that route isn't
 * deployed yet" and three other files repeated it as production fact; probed
 * 2026-08-02, the POST answers 401 `unknown device` — the worker's device-auth
 * declining an unenrolled probe, which is unreachable unless the route is live.
 * It matters which rail a take rode: a `nicla_transcript` row carries a
 * fetchable id, a `device_note` carries a 300-char preview and nothing to
 * fetch, so "either way" is about the WORDS arriving, not about them being
 * equally useful to the agent.
 *
 * House crash rules obeyed: fresh AVAudioEngine per take, format guard
 * before installTap, tap + recognizer closures born in nonisolated statics
 * (the c9 rule), one mic — refuses to start while VoiceMode owns the input.
 */
import AVFoundation
import MediaPlayer
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
    /// Which microphone actually heard this take — `"bluetooth"` (the glasses or
    /// a paired headset) or `"phone"` (the built-in mic).
    ///
    /// ⚠️ CARRIED ON THE RESULT, NOT READ WHERE THE REPLY IS BUILT. The take
    /// deactivates its `AVAudioSession` before returning, and once it does the
    /// route reverts — so a `currentRoute` read at reply time would answer
    /// `"phone"` for every take, including the ones the glasses heard.
    /// `WearablesLive.listenOnce` can read it live because it still holds its
    /// session; a take has to remember. Android's `PhoneRecorder.Take.micRoute`
    /// carries it for the same reason.
    ///
    /// Nil on the failure paths: a take that never opened a microphone has no
    /// route, and naming one it never used would be worse than saying nothing.
    let micRoute: String?

    static func failure(_ message: String) -> NiclaRecordResult {
        NiclaRecordResult(ok: false, transcript: "", transcriptId: "",
                          audioUrl: nil, seconds: 0, error: message, micRoute: nil)
    }
}

struct NiclaTranscript: Identifiable, Codable, Equatable {
    /// The SERVER's transcript id once the row has been filed, the local UUID
    /// until then. `var`, because those are two different strings and the row
    /// has to end up holding the server's — see `adoptServerId(rows:local:server:)`.
    var id: String
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
    /// True when this row HAD local audio and `pruneAndSave` deleted it to stay
    /// under `liveAudioBudget`.
    ///
    /// Eviction sets `audioFile = nil` — the same value a text-only row and a row
    /// whose file write failed have always carried. So the three became one state:
    /// `playable()` went false and the Play button simply disappeared, leaving a
    /// row that looked like it had never been recorded. Same failure as the
    /// `isPreview` ellipsis above, one field over: absence and loss were the same
    /// pixels.
    ///
    /// It matters beyond the pixels, because `nicla_voice_transcripts` instructs
    /// the agent from this exact assumption — "a necklace-live row has no audio
    /// URL, but that does NOT mean the recording is gone … say 'open the tiny app
    /// to listen', never 'there is no audio'". For an evicted segment that advice
    /// sends the user to a row with no button on it. This flag is how the app can
    /// tell them what actually happened.
    ///
    /// Set only by `applyEvictions`, so the flag and the deletion cannot drift.
    var audioFreed: Bool = false
    /// True once the server has filed this row (`id` is the worker's id).
    ///
    /// `postToServer` is one-shot: it is awaited once, right after the take, and
    /// nothing ever tried again. So a memo recorded in the subway — or with the
    /// session signed out, or while the worker was mid-deploy — stayed on the
    /// phone forever and never joined the agent's context, which is the entire
    /// point of recording it. Nothing said so, either: an unfiled row lists,
    /// plays and shares exactly like a filed one, and `refreshFromServer` only
    /// ever pulls DOWN, so no later open could notice the row was missing
    /// upstream. The failure is silent on both ends.
    ///
    /// A row that fell through to the `device_note` event rail is NOT filed:
    /// that preview reaches one context block and is fetchable by nobody.
    ///
    /// Decodes to false for rows written by an older build, which is the honest
    /// answer — the phone never recorded whether those landed. It is NOT a
    /// licence to re-post them blind: a re-post mints a fresh server row, so
    /// doing that to a row that did land would duplicate it upstream. So the
    /// server gets to answer first: `mergeFetched` sets this true on every row it
    /// recognizes as one the server already holds, and `syncUnfiled` runs only
    /// from `refreshFromServer`, after that confirmation pass.
    var filed: Bool = false
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
        // Same reason as isPreview, and the same cost if it is ever written as a
        // plain `decode`: every row on the phone predates this key, so a throw
        // here is loadIndex() returning [] — the whole transcript history gone on
        // first launch after the update.
        audioFreed = try c.decodeIfPresent(Bool.self, forKey: .audioFreed) ?? false
        // Third field with this comment on it, same reason: `decodeIfPresent` is
        // not caution here, it is the migration. A plain `decode` throws
        // `.keyNotFound` on every row already on the phone and loadIndex() turns
        // that into [] — the whole history gone on first launch after the update.
        filed = try c.decodeIfPresent(Bool.self, forKey: .filed) ?? false
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

    /// `nonisolated` so `partitionForPrune` — a pure rule, testable without a disk
    /// — can read it. Internal for the same reason the tests read it: an assertion
    /// that hardcodes 50 stops testing the rule the day the number changes.
    nonisolated static let indexCap = 50

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

    /// The events ring's own cap on `detail` (worker events.ts emitEvent, the ONE
    /// writer). Named here because postToServer's fallback rail has to BUDGET
    /// against it: that rail files no transcript row, so anything the worker
    /// truncates is gone with no id to fetch the rest with.
    ///
    /// It was previously assumed to be 240 in a comment, while the emitted detail
    /// reached 269 chars with a short label and 335 with the 80-char label the
    /// worker's own TRANSCRIPT_LABEL_MAX allows. Over 300 the tail is cut — and
    /// the tail is the audio URL, the one part of the line that cannot be
    /// reconstructed from what survives.
    nonisolated static let noteDetailMax = 300

    /// Labels on the fallback rail are bounded well under the worker's 80 so the
    /// URL is never the thing a long label pushes out. Labels here are short by
    /// construction ("memo", "wake: hey tiny", "necklace-live"); an agent-supplied
    /// `reason` is the one that can run long, and it is the least valuable part
    /// of the line.
    nonisolated static let notePreviewLabelMax = 40

    /// The `device_note` line for the fallback rail, budgeted to survive the ring.
    ///
    /// This rail is the one with the LEAST slack and the only one whose loss is
    /// unrecoverable: it files no transcript row, so whatever the worker truncates
    /// is simply gone — there is no id to fetch the rest with. So the budget is
    /// spent here deliberately rather than hoped for:
    ///
    ///   - the audio URL is RESERVED first. It is the one part of the line that
    ///     cannot be reconstructed from what survives; a cut preview still reads
    ///     as words, a cut URL is a dead link or nothing at all.
    ///   - the label is bounded (notePreviewLabelMax). An agent-supplied `reason`
    ///     is the only label that runs long and the least valuable part of the line.
    ///   - the preview takes whatever is left, with a floor so a pathological
    ///     label/URL can never squeeze the actual speech out entirely.
    ///
    /// Previously this was `text.prefix(180)` plus the URL against a cap assumed to
    /// be 240: 269 chars with a short label, 335 with the 80-char label the worker
    /// allows, and at 335 emitEvent cut the tail — the URL — at write time.
    nonisolated static func noteDetail(label: String, text: String, audioUrl: String?) -> String {
        let bounded = String(label.prefix(notePreviewLabelMax))
        let tail = audioUrl.map { " \($0)" } ?? ""
        // Measured on the real thing, not counted by hand: the emoji and the
        // curly quotes are multi-byte, and `detail` is capped in CHARACTERS by
        // the worker's String.slice, so this must agree with it.
        let shell = "🎙️ \(bounded): “”" + tail
        let room = max(40, noteDetailMax - shell.count)
        return "🎙️ \(bounded): “\(String(text.prefix(room)))”" + tail
    }

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
        // Read the route BEFORE deactivating — one line earlier is the last moment
        // it is still a fact. See `NiclaRecordResult.micRoute`: after the line
        // below, `currentRoute` describes whatever the system falls back to, which
        // is the built-in mic, for a take the glasses may well have heard.
        let heardVia = MicRoute.current()
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
        // The FILED id, not the local one: a relay take's reply carries this back
        // as `transcriptId` for the agent to fetch with, and the local UUID names
        // no row the server can look up.
        let filed = await postToServer(entry)

        return NiclaRecordResult(ok: true, transcript: heard, transcriptId: filed ?? id,
                                 audioUrl: entry.audioUrl, seconds: actualSeconds, error: nil,
                                 micRoute: heardVia)
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
    /// `device_note` event kind if that POST does not succeed (see the file
    /// header: the route IS deployed, so this rail means a real failure).
    ///
    /// - Returns: the id the server filed the transcript under, or nil if it never
    ///   landed there (no credentials, or the request fell through to the event
    ///   ring). Callers use it to address the row server-side; see adoptServerId.
    @discardableResult
    private func postToServer(_ t: NiclaTranscript, asVoiceNecklace: Bool = true) async -> String? {
        let phone = Keychain.get("tiny_device_id").flatMap { did in
            Keychain.get("tiny_device_token").map { (deviceId: did, token: $0) }
        }
        let creds = asVoiceNecklace
            ? (NiclaVoiceGateway.shared.credentials ?? phone)
            : phone
        guard let creds else { return nil }
        var body: [String: Any] = [
            "deviceId": creds.deviceId, "token": creds.token,
            "text": t.text, "label": t.label, "durationS": t.seconds,
        ]
        if let u = t.audioUrl { body["audioUrl"] = u }
        if let r = try? await Api.postRaw("/api/devices/transcript", body: body),
           r["ok"] as? Bool == true {
            // Take the server's id, don't just check `ok`. The row is already in
            // `transcripts` under a local UUID (both callers insert before posting),
            // and every server-facing use of `t.id` — the dedupe in
            // refreshFromServer, `?id=` in fetchFullText, the relay's transcriptId —
            // needs the id the worker actually filed it under. See adoptServerId.
            guard let sid = r["id"] as? String, !sid.isEmpty else { return nil }
            // One call, because taking the server's id and recording that the row
            // IS filed are one fact — see adoptFiling. Written separately here, the
            // `filed` half sat in a place no test could reach: a mutation that
            // deleted it left all 19 tests green, and the cost of losing it is a
            // second server row for every take.
            transcripts = Self.adoptFiling(rows: transcripts, local: t.id, server: sid)
            pruneAndSave()
            // Returned whether or not the rewrite happened: the row may have been
            // pruned out from under this call, but the transcript IS filed under
            // `sid` and that is what a waiting caller has to be told.
            return sid
        }
        // Fallback rail: a short preview on the event ring still lands in the next
        // chat turn's context block. The line is built by noteDetail so the budget
        // is testable without a microphone or a network — see NiclaNoteDetailTests.
        _ = try? await Api.postRaw("/api/devices/event", body: [
            "deviceId": creds.deviceId, "token": creds.token,
            "kind": "device_note",
            "detail": Self.noteDetail(label: t.label, text: t.text, audioUrl: t.audioUrl),
        ])
        // The event ring is not the transcript store — nothing here is fetchable by
        // id, so there is no filed id to report.
        return nil
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
    ///
    /// Matching is `mergeFetched`'s job, not a `Set` of ids: the phone's own rows
    /// carry local UUIDs and the server's copies carry the worker's, so id equality
    /// alone listed every synced take twice — with the duplicate being the shorter,
    /// unplayable one.
    func refreshFromServer() async {
        guard let list: [String: Any] = try? await Api.get(
            "/api/devices/transcript?limit=\(Self.serverListLimit)", token: Keychain.get("tiny_token")),
            let rows = list["transcripts"] as? [[String: Any]]
        else { return }
        let fetched: [NiclaTranscript] = rows.compactMap { r in
            guard let id = r["id"] as? String else { return nil }
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
        // NOT `guard !fetched.isEmpty`: an empty answer is exactly the state a
        // first-ever sync sees, and it used to return before the retry below could
        // run. mergeFetched on an empty list is a no-op, so this is safe to fall
        // through — and it is the case where every local row needs re-posting.
        if !fetched.isEmpty {
            transcripts = Self.mergeFetched(local: transcripts, fetched: fetched)
                .sorted { $0.at > $1.at }
            pruneAndSave()
        }
        await syncUnfiled(serverReturned: fetched.count)
    }

    /// How many rows `refreshFromServer` asks for. Named because `syncUnfiled`
    /// reasons about it: a FULL page means the server's answer was cut off, so a
    /// local row's absence from it proves nothing.
    static let serverListLimit = 50

    /// Re-post the transcripts that never reached the server.
    ///
    /// `postToServer` was one-shot — awaited once after the take, and if it failed
    /// nothing ever tried again. The row stayed on the phone, looking exactly like
    /// a synced one, and never entered the agent's context. Offline is the ordinary
    /// case for a wearable, not an edge case: a wake take fires while the phone is
    /// in a pocket on the subway, and `refreshFromServer` only ever pulls DOWN, so
    /// no later open could notice the gap.
    ///
    /// Ordering is the safety property here, not an optimization. This runs only
    /// from `refreshFromServer`, AFTER the merge, because a re-post mints a NEW
    /// server row: doing it before the server had a chance to say "I already have
    /// this take" would duplicate every row that predates the `filed` field.
    ///
    /// Two more guards on the same hazard:
    ///  - A full page (`serverReturned == serverListLimit`) means the answer was
    ///    truncated, so rows older than the oldest one returned may well be filed
    ///    and simply out of frame. Only rows NEWER than that watermark are retried.
    ///  - A row still inside the audio-upload/clock window `sameTake` uses is left
    ///    alone: its own POST may be in flight right now.
    private func syncUnfiled(serverReturned: Int) async {
        let oldestSeen = transcripts.filter(\.filed).map(\.at).min()
        let truncated = serverReturned >= Self.serverListLimit
        let due = Self.unfiled(rows: transcripts, now: Date(),
                               olderThan: truncated ? oldestSeen : nil)
        guard !due.isEmpty else { return }
        for t in due {
            // Sequential, not a task group: each POST mutates `transcripts` (id
            // adoption + the `filed` write), and the `asVoiceNecklace` decision
            // reads the gateway's live credentials. One at a time also keeps a
            // backlog of 50 from arriving at the worker as a burst.
            //
            // Re-read the row by id rather than posting the captured copy: an
            // earlier iteration may have pruned or rewritten it.
            guard let cur = transcripts.first(where: { $0.id == t.id }), !cur.filed else { continue }
            // asVoiceNecklace mirrors the producer: a necklace-heard segment is
            // signed by the phone (storeHeard's rule), everything else by the
            // necklace when its credentials are there. Deriving it from the label
            // rather than storing it keeps one rule in one place.
            await postToServer(cur, asVoiceNecklace: cur.label != Self.liveLabel)
        }
    }

    /// Which rows are due for a re-post. Pure, so the window and watermark rules
    /// are testable without a network.
    ///
    /// - Parameters:
    ///   - olderThan: when the server's page was truncated, the oldest row it
    ///     confirmed. Rows at or before it are skipped — their absence from a cut
    ///     -off answer is not evidence they are missing. nil means the answer was
    ///     complete, so absence IS evidence.
    nonisolated static func unfiled(
        rows: [NiclaTranscript], now: Date, olderThan: Date?
    ) -> [NiclaTranscript] {
        rows.filter { t in
            guard !t.filed else { return false }
            // Its own POST may still be running (a 6MB audio upload precedes it).
            guard now.timeIntervalSince(t.at) > postSettleSeconds else { return false }
            if let cut = olderThan, t.at <= cut { return false }
            return true
        }
    }

    /// How long after a take a row is assumed to have finished its own POST.
    ///
    /// This IS `mergeWindowAhead`, not a copy of it: that window exists for the
    /// same fact (the audio upload sits between `at` and the server's `created`,
    /// and a 6MB clip on a bad link is the slow case). Two constants spelling one
    /// measurement is how they drift, so there is only ever one number.
    nonisolated static var postSettleSeconds: TimeInterval { mergeWindowAhead }

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

    /// Prefix NiclaVoiceGateway files a wake-triggered take under. Shared for the
    /// same reason as `liveLabel`: the eviction rule keys off it.
    nonisolated static let wakeLabelPrefix = "wake: "

    /// Rewrite one row's local UUID to the id the server filed it under.
    ///
    /// The phone mints a UUID for every take and POSTs the take WITHOUT it: the
    /// worker does `const id = crypto.randomUUID()` and returns `{ok, id}`. That
    /// is the right call server-side — a client-chosen primary key lets one device
    /// overwrite another's row — but it means each transcript has two ids, and the
    /// phone was throwing the server's away (`r["ok"] as? Bool == true` and no
    /// more). Two things broke, from the one cause:
    ///
    ///  1. `refreshFromServer()` dedupes on `Set(transcripts.map(\.id))`, so a row
    ///     the phone recorded ITSELF could never match its own server copy. Every
    ///     synced take came back as a second row on the next refresh — and since
    ///     `.task` runs that on every open of the list, it was routine, not rare.
    ///     The twin is the worse copy, too: merged rows carry `audioFile: nil` and
    ///     a 200-char preview, so the duplicate showed up shorter and unplayable
    ///     next to the original.
    ///  2. `fetchFullText` and the relay's `transcriptId` both address the server
    ///     by `t.id`. Under the local UUID, `?id=` matched no row — the agent was
    ///     handed a fetchable-looking id that resolved to nothing, and a truncated
    ///     row could never pull its own remainder.
    ///
    /// Returns the rewritten array, or nil if nothing needed changing — so the
    /// caller can skip a save. Deliberately narrow: it rewrites the row whose id is
    /// `local` and refuses if `server` is empty or already present under a
    /// different row, because colliding two rows onto one id would make one of them
    /// unreachable by `firstIndex(where:)`.
    nonisolated static func adoptServerId(
        rows: [NiclaTranscript], local: String, server: String
    ) -> [NiclaTranscript]? {
        guard !server.isEmpty, server != local else { return nil }
        guard let i = rows.firstIndex(where: { $0.id == local }) else { return nil }
        guard !rows.contains(where: { $0.id == server }) else { return nil }
        var out = rows
        out[i].id = server
        return out
    }

    /// A successful POST, applied to the index: take the server's id AND record
    /// that the row is filed.
    ///
    /// These are one fact — "the worker has this take, under `server`" — and they
    /// were two statements in `postToServer`, where the `filed` half was reachable
    /// by no test at all: deleting it left the whole suite green while costing a
    /// duplicate server row per take. Same reason `applyEvictions` exists: the
    /// mutation and the reason for it belong in one place that can be checked.
    ///
    /// `adoptServerId` refuses in several cases (a `server` id already present, a
    /// `local` row that was pruned mid-flight), and `filed` must be set anyway
    /// wherever the row can be found — the POST did land regardless of whether the
    /// rename was possible. Returns the rows unchanged when neither id matches
    /// anything, which is the pruned-out case.
    nonisolated static func adoptFiling(
        rows: [NiclaTranscript], local: String, server: String
    ) -> [NiclaTranscript] {
        var out = adoptServerId(rows: rows, local: local, server: server) ?? rows
        // `local` FIRST, and the order is the whole correctness of this function.
        // After a successful rename no row carries `local` any more, so it falls
        // through to `server` — the renamed row. When the rename was REFUSED
        // (`server` already sits on another row) the local row is still there and is
        // the one whose POST landed; marking the other row instead leaves this one
        // unfiled forever, re-posted on every refresh. Checking `server` first did
        // exactly that, and the test for the refused path is what caught it.
        if let i = out.firstIndex(where: { $0.id == local }) ?? out.firstIndex(where: { $0.id == server }) {
            out[i].filed = true
        }
        return out
    }

    /// Merge server rows into local ones, matching by CONTENT when the ids differ.
    ///
    /// Id adoption at POST time (above) keeps new takes from double-listing, but it
    /// cannot help the rows already on a phone: every transcript recorded before it
    /// sits in index.json under a local UUID, and the server's copy carries a
    /// different one. Deduping on id alone, those all come back as a second row the
    /// first time the list is opened. So the id is the fast path, not the only one.
    ///
    /// A server row is judged the SAME TAKE as a local row when the label matches,
    /// the duration matches to the second, and the local text starts with what the
    /// server sent (the list route returns `substr(text, 1, 200)`, so the server's
    /// copy is a prefix of the local one by construction) — inside a time window,
    /// since `created` is stamped when the POST lands and `at` when the take ended,
    /// and the audio upload sits between them.
    ///
    /// Local rows win the merge, as before: only they know the downloaded audio file
    /// and the untruncated text. All the server contributes is its id, which is the
    /// one thing the local row was missing.
    ///
    /// Each local row absorbs at most one server row. Two takes that are identical
    /// in label, duration and first 200 characters within the window — two silent
    /// 10s memos, say — could have their ids swapped between them; the rows are
    /// interchangeable in content and duration, so nothing the user or the agent
    /// reads back changes. Listing one take twice is the failure worth avoiding.
    nonisolated static func mergeFetched(
        local: [NiclaTranscript], fetched: [NiclaTranscript]
    ) -> [NiclaTranscript] {
        var rows = local
        var claimed = Set<Int>()
        var append: [NiclaTranscript] = []
        for f in fetched {
            // `filed`, on both branches below and here: the server is answering
            // with rows it holds, so a local row it matches is CONFIRMED upstream.
            // That confirmation is what `syncUnfiled` needs before it dares
            // re-post anything — every row already on a phone decodes `filed:
            // false`, and re-posting one that did land would duplicate it.
            if let i = rows.firstIndex(where: { $0.id == f.id }) {
                rows[i].filed = true
                continue
            }
            let candidates = rows.indices.filter { i in
                !claimed.contains(i) && sameTake(local: rows[i], server: f)
            }
            // Closest in time, so a run of look-alike takes pairs off in order
            // instead of every server row landing on the same local one.
            guard let i = candidates.min(by: {
                abs(rows[$0].at.timeIntervalSince(f.at)) < abs(rows[$1].at.timeIntervalSince(f.at))
            }) else {
                // A row that came FROM the server is filed by definition.
                var row = f
                row.filed = true
                append.append(row)
                continue
            }
            claimed.insert(i)
            rows[i].id = f.id
            rows[i].filed = true
        }
        return rows + append
    }

    /// Forward window for `mergeFetched`: `created` is stamped when the POST lands,
    /// `at` when the take ended, and the audio upload runs between them — a 6MB clip
    /// on a bad link is the slow case. Backward is clock skew between phone and
    /// worker, which is small but not zero.
    /// Not private: `postSettleSeconds` is this same number under the name the
    /// retry path needs, rather than a second copy of it.
    nonisolated static let mergeWindowAhead: TimeInterval = 300
    private nonisolated static let mergeWindowBehind: TimeInterval = 60

    private nonisolated static func sameTake(
        local: NiclaTranscript, server: NiclaTranscript
    ) -> Bool {
        guard local.label == server.label, local.seconds == server.seconds else { return false }
        // Never match on nothing: an empty server text would prefix-match every row.
        guard !server.text.isEmpty, local.text.hasPrefix(server.text) else { return false }
        let delta = server.at.timeIntervalSince(local.at)
        return delta >= -mergeWindowBehind && delta <= mergeWindowAhead
    }

    /// Audio the user did not ask for, take by take — the set the byte budget bounds.
    ///
    /// Two producers, and only one of them was recognized here. `necklace-live` is
    /// the obvious one. The other is a WAKE take: `Config.recordOnWake` defaults to
    /// TRUE, so saying the wake word records up to `maxSeconds` (120s, since wake
    /// takes pass `extendWhileSpeaking: true`) with nobody touching the phone. That
    /// is the same unbounded-growth shape the budget was written for — a necklace
    /// on a chest all day mints these on its own — and it was exempt.
    ///
    /// A hand-made take ("memo", "manual") stays exempt: the user pressed a button
    /// for it and may hold the only copy. So does a relay take, whose label is the
    /// agent's arbitrary `reason` string and cannot be classified from text at all;
    /// something was waiting on that recording, which makes it a deliberate ask
    /// rather than ambient capture. A `reason` that happens to start with "wake: "
    /// would be treated as automatic — it loses the file and keeps the words, which
    /// is the mild direction to be wrong in.
    nonisolated static func isAutomaticAudio(label: String) -> Bool {
        label == liveLabel || label.hasPrefix(wakeLabelPrefix)
    }

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
            // A hand-made or agent-asked take is never counted and never evicted, so
            // a phone full of automatic audio cannot push a memo off the disk.
            guard isAutomaticAudio(label: r.label) else { continue }
            if used + r.bytes <= budget {
                used += r.bytes
            } else {
                evict.insert(r.id)
            }
        }
        return evict
    }

    /// Whether the row should say its recording was freed for space.
    ///
    /// Not simply `t.audioFreed`: eviction only ever deletes the LOCAL file, and an
    /// uploaded row still plays from `audioUrl`. Saying "freed" beside a working
    /// Play button would be a second wrong answer to the same question, so the tell
    /// is shown only when there is nothing left to play. `hasLocalAudio` is passed
    /// in rather than checked here because it needs the filesystem, and this rule
    /// should not.
    nonisolated static func showsAudioFreed(_ t: NiclaTranscript, hasLocalAudio: Bool) -> Bool {
        t.audioFreed && !hasLocalAudio && t.audioUrl == nil
    }

    /// Whether the row should say it hasn't reached the agent yet.
    ///
    /// Same class of defect as `showsAudioFreed`, one field over again: a row whose
    /// POST failed lists, plays and shares exactly like a synced one, so the user
    /// believes the agent can read a memo it has never seen. The retry is silent
    /// and eventual — this is the only thing on screen that says which rows it is
    /// still waiting on.
    ///
    /// Gated on the same settle window as the retry, so a take from four seconds
    /// ago does not flash "not synced" while its own POST is in flight. `now` is a
    /// parameter for testability, and because a view reading the clock itself
    /// cannot be checked without waiting.
    nonisolated static func showsUnsynced(_ t: NiclaTranscript, now: Date) -> Bool {
        !t.filed && now.timeIntervalSince(t.at) > postSettleSeconds
    }

    /// Split the index into what survives the `indexCap` and what is dropped.
    ///
    /// Two exemptions, and they are not the same kind of thing:
    ///
    ///  - A row with LOCAL AUDIO is kept because dropping it deletes the only
    ///    offline copy of a recording the user can still play (the original rule —
    ///    server rows sort by date and can push a real recording past the cap).
    ///  - A row that is NOT FILED is kept because the server has no copy at all:
    ///    dropping it destroys the words themselves and the last chance for them
    ///    to reach the agent. A filed row is re-fetchable forever, so dropping one
    ///    costs nothing.
    ///
    /// Both are bounded — `indexCap` is a floor on what is kept, not a ceiling, and
    /// the exempt sets are: local audio by `liveAudioBudget`, unfiled by
    /// `syncUnfiled` emptying it on the next successful refresh. A phone that is
    /// offline for a month grows past the cap on purpose; that is the point.
    ///
    /// Pure and static so both rules are testable without a disk — `hasLocalAudio`
    /// is injected for exactly that reason.
    nonisolated static func partitionForPrune(
        rows: [NiclaTranscript], hasLocalAudio: (NiclaTranscript) -> Bool
    ) -> (kept: [NiclaTranscript], dropped: [NiclaTranscript]) {
        var kept: [NiclaTranscript] = []
        var dropped: [NiclaTranscript] = []
        for t in rows {
            if kept.count < indexCap || hasLocalAudio(t) || !t.filed { kept.append(t) }
            else { dropped.append(t) }
        }
        return (kept, dropped)
    }

    /// Mark the rows `audioEvictions` chose: clear `audioFile`, remember the loss.
    ///
    /// Split out of `pruneAndSave` so the bookkeeping is testable without a disk.
    /// The two writes belong together — the whole defect was that eviction cleared
    /// `audioFile` and recorded nothing, making a freed recording indistinguishable
    /// from a row that never had one. Doing them in one place is what keeps a
    /// future edit from separating them again.
    ///
    /// A row whose `audioFile` is ALREADY nil is not marked. Eviction picks by id
    /// from a sized list, and a text-only row measures 0 bytes, so it can be handed
    /// an id that owns no file (`used + 0 <= budget` keeps that from happening
    /// today, but the guard costs nothing and this function should be true on its
    /// own terms): nothing was freed, so claiming otherwise would tell the user
    /// their words used to have audio.
    nonisolated static func applyEvictions(
        rows: [NiclaTranscript], evict: Set<String>
    ) -> [NiclaTranscript] {
        var out = rows
        for i in out.indices where evict.contains(out[i].id) {
            guard out[i].audioFile != nil else { continue }
            out[i].audioFile = nil
            out[i].audioFreed = true
        }
        return out
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
        let (kept0, dropped) = Self.partitionForPrune(
            rows: transcripts, hasLocalAudio: hasLocalAudio)
        var kept = kept0
        // Dropping a row the server never received destroys the only copy of those
        // words, so say so rather than doing it quietly — a silent cap reads as
        // "everything is synced" when it is the opposite.
        let lostUnsynced = dropped.filter { !$0.filed }.count
        if lostUnsynced > 0 {
            print("🎙️ pruned \(lostUnsynced) transcript(s) that never reached the server")
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
            }
            // Deleting the file and recording WHY are one step — see applyEvictions.
            kept = Self.applyEvictions(rows: kept, evict: evict)
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

/// 🔇 Why a take won't play, in the language of the person who tapped Play.
///
/// ⚠️ THIRD TIME THIS APP HAS PAID FOR THE SAME MISSING CHANNEL. `/voice/recording`
/// learned it ("iOS won't play call recordings") and `CallRecordingRefusal` +
/// `observe(\.status)` were the fix; `tests/voice-playback-refusal.test.ts` even
/// states the rule. The Range half of that lesson later reached `/media/:key`
/// too, because NiclaRecorder uploads every take there — and the ERROR half did
/// not. So this screen kept the original defect verbatim: `AVPlayer(url:)` with
/// one `.AVPlayerItemDidPlayToEndTime` observer, which is the notification a
/// refusal CANNOT fire (the item never begins playing, it fails at LOAD). The
/// result was a row whose button read "Stop" forever, over a take that never
/// made a sound, with nothing on screen saying why.
///
/// Keyed on `media.ts`'s own literals — `MediaGetCall.handle` refuses exactly two
/// ways (424 `media store not provisioned`, 404 `not found`) — and pinned against
/// the worker source by `tests/nicla-playback-refusal.test.ts`, so a third
/// refusal added upstream fails a suite instead of quietly becoming `unknown`.
///
/// Shares `CallRecordingRefusal`'s sentence for "we don't know", because that IS
/// the same fact, and the cross-platform pin asserts all three clients agree on it.
enum NiclaPlaybackRefusal {
    /// The generic answer for a refusal we can't read — and for a player error
    /// with no readable body, which is the normal `AVPlayer` case.
    static let unknown = CallRecordingRefusal.unknown

    /// ⚠️ REMOTE-ONLY, and that is the whole point of the `remote` flag below.
    /// An offline phone plays a local m4a perfectly well, so blaming the network
    /// for a local failure would be a confident wrong answer — the exact class of
    /// defect this enum exists to remove.
    static let offline = "you're offline — this take's audio is on the server"

    private static let refusals: [(String, String)] = [
        // 424: R2 isn't bound to the worker. Same sentence as the call route's
        // identical refusal, deliberately: it is the same outage.
        ("media store not provisioned", "recordings are unavailable right now"),
        // 404: the key is malformed, or the object isn't there. The words survive
        // (they're in this list), so say what was lost rather than "couldn't play".
        ("not found", "this recording is no longer on the server"),
    ]

    /// What to say when a take won't play. ALWAYS a sentence.
    ///
    /// - Parameters:
    ///   - error: `AVPlayerItem.error?.localizedDescription`, which EMBEDS the
    ///     origin's body rather than equalling it — hence `contains` below.
    ///   - online: `Net.shared.online`.
    ///   - remote: whether this row played from `audioUrl` rather than a local
    ///     file. Never inferred from the error: a missing local file and a 404
    ///     produce descriptions nothing can reliably tell apart.
    static func text(_ error: String?, online: Bool, remote: Bool) -> String {
        // First, because an offline failure's description ("The Internet
        // connection appears to be offline.") matches none of the needles and
        // would otherwise land on the generic line while the cause was both
        // knowable and fixable.
        if remote && !online { return offline }
        let reason = (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty else { return unknown }
        for (needle, sentence) in refusals where reason.contains(needle) { return sentence }
        return unknown
    }
}

struct NiclaTranscriptsView: View {
    @ObservedObject private var rec = NiclaRecorder.shared
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var net = Net.shared
    @State private var player: AVPlayer?
    @State private var playingId: String?
    /// End-of-playback observer, torn down in stopPlayback() so a second play
    /// does not stack another one on the same notification.
    @State private var endObserver: NSObjectProtocol?
    /// ⚠️ THE ERROR CHANNEL, missing until now. A refusal from /media/:key fails
    /// the item at LOAD, so `.AVPlayerItemDidPlayToEndTime` never fires and the
    /// row sat reading "Stop" over silence. `observe(\.status)` is the only
    /// channel a load failure uses — see NiclaPlaybackRefusal.
    @State private var failObserver: NSKeyValueObservation?
    /// Why a row's playback failed, by id. Rendered under the row; cleared when
    /// that row is played again.
    @State private var playError: [String: String] = [:]
    /// Transport for the row that is playing, so a 90-second memo can be scrubbed
    /// instead of only started. `total` starts from the row's own `seconds` and is
    /// refined from the asset once it loads — a remote m4a's real duration can
    /// differ from what the take recorded.
    @State private var elapsed: Double = 0
    @State private var total: Double = 0
    @State private var scrubbing = false
    @State private var timeObserver: Any?
    /// The row currently playing, so the lock screen can name it. Held rather
    /// than looked up: `pruneAndSave` can drop a row mid-playback.
    @State private var nowPlaying: NiclaTranscript?
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
                                            Label(playingId == t.id ? "Stop" : "Play \(clock(Double(t.seconds)))",
                                                  systemImage: playingId == t.id ? "stop.circle.fill" : "play.circle")
                                        }
                                        .font(.caption)
                                    // hasLocalAudio: false is not an assumption —
                                    // reaching this branch means playable(t) was
                                    // false, which is exactly "no local file and no
                                    // audioUrl".
                                    } else if NiclaRecorder.showsAudioFreed(t, hasLocalAudio: false) {
                                        // The words are still here; the audio was
                                        // deleted to stay under the disk budget.
                                        // Without this the row is identical to one
                                        // that was never recorded — no button, no
                                        // trace — and the agent is meanwhile telling
                                        // the user to open the app and listen.
                                        Label("audio freed for space", systemImage: "externaldrive.badge.minus")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    ShareLink(item: "\(t.label) — \(t.text)") {
                                        Label("Share", systemImage: "square.and.arrow.up")
                                    }
                                    .font(.caption)
                                    if t.audioUrl != nil {
                                        Label("uploaded", systemImage: "checkmark.icloud")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    // The words are safe on this phone but the
                                    // agent cannot read them yet. Without this the
                                    // row is identical to a synced one, and the
                                    // user has no way to know the agent is missing
                                    // it — the retry runs on the next refresh.
                                    if NiclaRecorder.showsUnsynced(t, now: .now) {
                                        Label("not synced yet", systemImage: "arrow.triangle.2.circlepath")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                // ▶️ Scrub the take that is playing. A 120-second
                                // memo could only be started from the beginning:
                                // to re-hear one sentence you listened to the
                                // whole thing again, which is the difference
                                // between "the audio is here" and "you can
                                // listen to it".
                                if playingId == t.id, total > 0 {
                                    HStack(spacing: 8) {
                                        Text(clock(elapsed))
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                        Slider(value: $elapsed, in: 0 ... total) { editing in
                                            scrubbing = editing
                                            if !editing {
                                                player?.seek(to: CMTime(seconds: elapsed,
                                                                        preferredTimescale: 600))
                                            }
                                        }
                                        .tint(.green)
                                        .accessibilityLabel("Playback position")
                                        Text(clock(total))
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                // ⚠️ The captured reason, DRAWN. A row that
                                // recorded why it failed and rendered nothing is
                                // the same silence with more code in it.
                                if let why = playError[t.id] {
                                    Text("⚠️ \(why)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
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

    /// "1:58" — the take's length, and the transport's two ends.
    ///
    /// Seconds alone ("Play 118s") is a number the reader has to divide; every
    /// other recording surface in this app already speaks clock time (VoiceCall's
    /// `clock`, Android's `sizeLine`).
    private func clock(_ t: Double) -> String {
        let s = max(0, Int(t))
        return "\(s / 60):\(String(format: "%02d", s % 60))"
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
        nowPlaying = t
        playError[t.id] = nil
        elapsed = 0
        // From the row, so the transport is drawn on the first tick instead of
        // appearing a moment later — refined below once the asset reports.
        total = Double(t.seconds)
        // ⚠️ THE CHANNEL A REFUSAL ACTUALLY USES. `/media/:key` answers 424 (R2
        // unbound) and 404 (gone, or a malformed key) with a JSON body, and an
        // offline phone fails a remote play outright. All of those fail the item
        // at LOAD, so the end-of-play notification below CANNOT fire — the row
        // kept reading "Stop" over silence with nothing to say. `remote:` is
        // passed rather than derived: only this scope knows whether the URL we
        // handed the player was a file or the server.
        let remote = local == nil
        failObserver = p.currentItem?.observe(\.status, options: [.new]) { item, _ in
            guard item.status == .failed else { return }
            let described = (item.error as NSError?)?.localizedDescription
            Task { @MainActor in
                playError[t.id] = NiclaPlaybackRefusal.text(described, online: net.online,
                                                            remote: remote)
                // Stop claiming it is playing. A "Stop" button over a transport
                // frozen at 0:00 is half of what made this invisible.
                if playingId == t.id { stopPlayback() }
            }
        }
        // Reset the row when the clip ends on its own. Without this nothing ever
        // clears playingId except another tap, so a finished clip left the button
        // reading "Stop" forever and the audio session held active — and the next
        // row's Play looked like it did nothing, because toggle() saw a stale id.
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
        ) { _ in
            Task { @MainActor in stopPlayback() }
        }
        // Half-second transport ticks, skipped mid-scrub so the thumb stays under
        // the finger. The asset's own duration wins once it loads: a remote m4a's
        // real length can differ from the seconds the take recorded, and a slider
        // whose end is wrong seeks to the wrong place.
        timeObserver = p.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { time in
            Task { @MainActor in
                guard !scrubbing else { return }
                elapsed = time.seconds
                if let d = p.currentItem?.duration.seconds, d.isFinite, d > 0 { total = d }
                updateNowPlaying()
            }
        }
        p.play()
        installRemoteCommands()
        updateNowPlaying()
    }

    private func stopPlayback() {
        if let o = endObserver {
            NotificationCenter.default.removeObserver(o)
            endObserver = nil
        }
        // The undo of its own setup: a KVO observation writing @State into a
        // dismissed view is a leak, and a second play would stack another one on
        // the same row.
        failObserver?.invalidate()
        failObserver = nil
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        player?.pause()
        player = nil
        playingId = nil
        nowPlaying = nil
        elapsed = 0
        total = 0
        scrubbing = false
        clearNowPlaying()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ── Lock screen / control centre (the CallRecordingsView idiom) ────────
    //
    // The app already runs the `audio` background mode, so a playing take keeps
    // going when the phone locks. Without these it is a mystery sound with no
    // pause button and no name: the person is listening to a recording of their
    // own room and the lock screen says nothing about which one.

    private func installRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.removeTarget(nil)
        c.pauseCommand.removeTarget(nil)
        c.changePlaybackPositionCommand.removeTarget(nil)
        // The command centre invokes these on its own queue, and player/elapsed
        // are MainActor view state — hop, never touch them here.
        c.playCommand.addTarget { _ in
            Task { @MainActor in player?.play() }
            return .success
        }
        c.pauseCommand.addTarget { _ in
            Task { @MainActor in player?.pause() }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let pos = e.positionTime
            Task { @MainActor in player?.seek(to: CMTime(seconds: pos, preferredTimescale: 600)) }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let t = nowPlaying else { return }
        // The words, not the label: "wake: hey tiny" names the trigger and tells
        // you nothing about which of six takes this is. The transcript's opening
        // clause is what a person recognises their own recording by.
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: String(t.text.prefix(60)),
            MPMediaItemPropertyArtist: t.label,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0,
        ]
        if total > 0 { info[MPMediaItemPropertyPlaybackDuration] = total }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
