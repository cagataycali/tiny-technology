/**
 * TinyLive — realtime video + audio from the tiny necklace (Nicla Vision),
 * the necklace's answer to GlassesLive: same floating PiP card, same
 * top-level toolbar button.
 *
 * Transport is LAN-direct (the relay caps envelopes at 8KB, so live media
 * never touches the cloud): firmware tiny_stream.py serves
 *   /stream  multipart MJPEG (QVGA)   /audio  PCM16 mono 16kHz
 * on port 8080. Expect ~13fps with the mic off and ~6 with it on, NOT the
 * "~20fps" this header used to claim: a second concurrent socket costs that
 * lwip stack most of its throughput, and audio's realtime 32 KB/s always wins,
 * so the firmware drops JPEG quality (50 -> 20) whenever /audio is attached.
 * Toggling the mic therefore changes both the frame rate AND the picture
 * quality on purpose — see hardware/README.md in strands-nicla.
 * Discovery: a cached IP is probed first (instant reconnect);
 * otherwise a relay `stream` invoke asks the device for its URLs. Phone and
 * necklace must share a WiFi. The device shows a blue LED while live.
 */
import AVFoundation
import Speech
import SwiftUI
import UIKit

/// Turning a relay reply's `payload` into a sentence a person can read.
///
/// Shared by every panel that talks to a device, because they all face the same
/// wire: a JSON envelope whose useful text hides under one of several keys, or
/// no envelope at all.
enum RelayReply {
    /// `.fragmentsAllowed` because a bare JSON string IS a legal payload here:
    /// the worker validates with JS `JSON.parse`, which accepts a top-level
    /// string, so a daemon may legitimately reply `"done"`. Without the option
    /// JSONSerialization throws on it and the user reads `"done"` complete with
    /// the quotes.
    static func text(_ payload: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(
            with: Data(payload.utf8), options: [.fragmentsAllowed]) else { return payload }
        if let s = obj as? String { return s }
        if let d = obj as? [String: Any] {
            for key in ["result", "text", "output", "error"] {
                if let v = d[key] as? String,
                   !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return v }
            }
        }
        return payload
    }
}

/// One poll of a relay reply mailbox — and who to blame when the wait runs out.
///
/// Both device panels poll `GET /api/devices/relay?inReplyTo=…` in a loop, and
/// both wrote the same `guard let … else { continue }`, which collapses three
/// different answers into one `nil`:
///
///   * a readable, still-empty mailbox — the device hasn't answered YET;
///   * a refusal, thrown as `ApiError.http`: 401 `login required` when the
///     session lapsed mid-poll, 424 when the worker itself had a problem;
///   * no response at all — the phone lost its network.
///
/// **Only the first says anything about the device**, and both loops ended on a
/// sentence that blames it anyway: "No frame in 19s — is the camera awake?" and
/// "<laptop> didn't answer in 30s — is `tiny mesh` still running there?" So a
/// phone that had quietly signed itself out sent its owner to a camera that was
/// awake and to a laptop whose daemon was running fine.
///
/// `FrameFailureTests` already states the rule this restores — "the server's and
/// the device's own words survive verbatim; re-wording them client-side is how
/// 'relay send failed' came to stand in for a 401" — and `FrameFailure` already
/// has the case for it, `.relayRefused`. The rule held on the SEND arm only,
/// five lines above the poll that ignored it.
///
/// Pure, and outside both panels, for `readFrameAnswer`'s reason: the defect
/// lived in a `guard` inside an async polling loop, which is precisely where no
/// test could reach it.
enum RelayPoll {
    /// What one read of the mailbox turned out to be.
    enum Read: Equatable {
        /// The device answered. The raw payload, for the caller to interpret —
        /// a frame, a status line, whatever it asked for.
        case answered(String)
        /// The mailbox was READ and is still empty. The only case that is
        /// evidence about the device, and so the only one that earns a timeout.
        case empty
        /// We could not read the mailbox at all. `reason` is already house copy
        /// (`LoadFailure.message`: the server's own words where it gave any, the
        /// status table otherwise); `status` is nil for a transport failure.
        case unreadable(reason: String, status: Int?)
    }

    /// What a poll RESPONSE means, as a pure decision.
    ///
    /// The reason wording is `LoadFailure.message`, not a fourth private copy of
    /// the same table: that helper exists because five sheets each guessed
    /// "Login required or network error", and it already separates a lapsed
    /// session from a dropped connection from an HTML error page served with a
    /// 200. A poll needs exactly that distinction.
    static func classify(_ result: Result<[String: Any], Error>) -> Read {
        switch result {
        case .success(let body):
            // `reply: null` is the route's own "nothing yet" (it answers
            // `{ ok: true, reply: data.reply ?? null }`), so a readable body
            // with no reply is the empty mailbox rather than a failure.
            //
            // A reply whose `payload` is not a string counts as empty too: the
            // wire guarantees a string (the route stringifies non-strings on
            // send, `sanitizeRelayPayload` on the worker side), so this arm is
            // unreachable rather than lossy.
            guard let reply = body["reply"] as? [String: Any],
                  let payload = reply["payload"] as? String else { return .empty }
            return .answered(payload)
        case .failure(let error):
            return .unreadable(reason: LoadFailure.message(error),
                               status: (error as? ApiError)?.status)
        }
    }

    /// One poll, classified. The only impure part, and deliberately the only
    /// thing in here a test cannot drive.
    static func read(inReplyTo query: String, token: String?) async -> Read {
        do {
            // Never from the cache: this GET's URL is constant for the whole
            // poll and its body is `{ reply: null }` until the device answers,
            // so a cached "not yet" would end the wait on a stale nothing. The
            // route sends no `Cache-Control`, so the caller has to say it —
            // `Api.getBody` states the same rule for the same reason.
            let body: [String: Any] = try await Api.get(
                "/api/devices/relay?inReplyTo=\(query)", token: token,
                cachePolicy: .reloadIgnoringLocalCacheData)
            return classify(.success(body))
        } catch {
            return classify(.failure(error))
        }
    }

    /// Is retrying pointless — i.e. does this refusal describe US rather than a
    /// moment?
    ///
    /// A 401 does not stop being a 401 two seconds later, and 403 is the
    /// worker's OWNERSHIP refusal ("re-auth won't help", per `ApiError`), so
    /// spending the rest of the budget on either is a spinner over a question
    /// already answered. 400 means we built the URL wrong and 404 means there is
    /// no such route on the build we're talking to.
    ///
    /// Everything else keeps its retries, which is the half worth protecting:
    /// nil is a transport blip, 424 is this route's "the worker had a problem"
    /// wrapper, and 5xx/429 are moments. Turning those into an early exit would
    /// re-break the thing `pollTries` exists for — a host that needs a few
    /// seconds to run an agent turn.
    static func isTerminal(status: Int?) -> Bool {
        guard let status else { return false }
        return status == 400 || status == 401 || status == 403 || status == 404
    }

    /// Who the budget running out is ABOUT.
    enum Verdict: Equatable {
        /// We read the mailbox and it stayed empty. Now the device may be blamed.
        case deviceSilent
        /// We never managed to read it, so we have no standing to say the device
        /// was silent — it may have answered into a mailbox we couldn't open.
        case couldNotAsk(String)
    }

    /// The verdict, from the state of the LAST attempt.
    ///
    /// - Parameter refusal: the final attempt's reason, or nil if the final
    ///   attempt read the mailbox. A successful read CLEARS it on purpose: an
    ///   early blip must not overrule what we could see at the end, and a
    ///   refusal at the end must not be papered over by an early success.
    static func verdict(refusal: String?) -> Verdict {
        guard let refusal else { return .deviceSilent }
        return .couldNotAsk(refusal)
    }
}

/// One segment's audio on disk, so a necklace-live row can be played back.
///
/// Same shape as NiclaRecorder.TakeBox's file half and for the same reason: a
/// write that throws POISONS the container, so the file handle is dropped on the
/// first failure and the transcript half of the segment survives. `frames` is
/// what tells finishSegment whether there is anything worth keeping — a file
/// that exists with no audio in it is an unplayable row with a Play button.
final class SegmentAudio {
    private var file: AVAudioFile?
    private(set) var frames = 0
    let url: URL
    let name: String

    /// AAC at the stream's own 16kHz mono, matching the m4a a phone-mic take
    /// writes — the transcripts list plays rows through one AVPlayer and one
    /// upload path, so a second container format would need a second of each.
    init?(dir: URL, format: AVAudioFormat) {
        name = "live-\(UUID().uuidString).m4a"
        url = dir.appendingPathComponent(name)
        guard let f = try? AVAudioFile(
            forWriting: url,
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVEncoderBitRateKey: 32_000,
            ],
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved)
        else { return nil }
        file = f
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        guard let f = file else { return }
        do {
            try f.write(from: buffer)
            frames += Int(buffer.frameLength)
        } catch {
            file = nil
        }
    }

    /// Close EXPLICITLY, and return whether the file is worth keeping.
    ///
    /// Not left to dealloc: the first e2e clip this app ever uploaded was 97KB of
    /// AAC packets with no moov atom, because the bytes were read before deferred
    /// finalization wrote the index — a file that was unplayable everywhere while
    /// every log line said ok.
    func finish() -> Bool {
        file = nil
        return frames > 0
    }
}

/// Recognition text written by the recognizer's callback, read by the actor.
///
/// The same reason NiclaRecorder has TakeBox: the recognitionTask closure is
/// born outside actor isolation and runs on whatever queue Speech feels like,
/// so it cannot touch @MainActor state. One lock, one string.
private final class LiveTextBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ""
    private var ended = false
    func set(_ t: String) { lock.lock(); value = t; lock.unlock() }
    var text: String { lock.lock(); defer { lock.unlock() }; return value }

    /// The task is over — it errored or delivered its final result.
    ///
    /// Measured on the real board: 8 seconds of an empty room ends the task with
    /// "No speech detected". Nothing else notices that, so every buffer appended
    /// afterwards was silently discarded until the next scheduled rotation —
    /// meaning someone who started talking 10 seconds into a segment would not
    /// be transcribed for another 35.
    func markEnded(reportedUtterance: Bool) {
        lock.lock()
        ended = true
        if reportedUtterance { deliveredFinal = true }
        lock.unlock()
    }
    var isEnded: Bool { lock.lock(); defer { lock.unlock() }; return ended }

    /// The task ended by delivering a final result, not by erroring out.
    ///
    /// This is the single most useful signal Speech gives, because it separates
    /// the two endings that need opposite handling. `isFinal` means it heard a
    /// whole utterance and stopped — the speaker is very likely still going, so
    /// the replacement task is needed THIS INSTANT. An error with no text ("No
    /// speech detected") means the room was quiet, and rebuilding a task per
    /// chunk of silence is what destroyed recognition when measured (316
    /// restarts in 125s, worse than never restarting at all).
    ///
    /// Inferring the same thing from audio energy was tried first and is
    /// strictly worse: a level gate cannot tell "still mid-sentence" from "the
    /// fridge is humming", and on a stream with a DC offset it cannot tell
    /// anything at all.
    var deliveredUtterance: Bool {
        lock.lock(); defer { lock.unlock() }; return deliveredFinal
    }
    private var deliveredFinal = false
}

@MainActor
final class TinyLive: NSObject, ObservableObject {
    static let shared = TinyLive()

    enum Mode { case lan, remote }

    @Published var frame: UIImage?
    @Published var stateText = "connecting…"
    @Published var lastError: String?
    @Published var audioOn = true
    @Published var running = false
    /// .lan = direct MJPEG (~20fps, home WiFi); .remote = relay frame polling
    /// (~1 frame / 3-6s from anywhere on the internet). Internet-first product:
    /// remote is the norm, LAN is the fast path when phone and necklace share
    /// a network.
    @Published var mode: Mode = .remote

    private var remoteDeviceId: String?
    private var token: String?
    /// Remote listen: a relay `record` invoke returns a hosted 2s WAV.
    @Published var remoteListening = false
    private var clipPlayer: AVPlayer?

    private var session: URLSession?
    private var videoTask: URLSessionDataTask?
    private var audioTask: URLSessionDataTask?
    private var videoBuf = Data()
    private var pcmRemainder = Data()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private lazy var audioFormat = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    private var engineReady = false

    // ---- live transcription of the necklace's own mic -------------------------

    /// Transcribe the necklace's audio on-device while it plays.
    ///
    /// The `/audio` stream was played and thrown away: the phone decoded PCM16
    /// into an AVAudioPCMBuffer, scheduled it on the player node, and nothing
    /// ever read the words. That buffer is already exactly what
    /// SFSpeechAudioBufferRecognitionRequest.append(_:) wants, so hearing the
    /// necklace and understanding it are the same work — the only reason the
    /// speech wasn't reaching the agent's context was that nobody asked.
    @Published var transcribeSpeech = true
    /// Running recognition text for the current segment (overlay strip).
    @Published private(set) var liveText = ""
    /// Why transcription is NOT running, in words. Silence here would look
    /// identical to "the necklace hasn't said anything yet".
    @Published private(set) var speechNote: String?

    private var recognizer: SFSpeechRecognizer?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechBox: LiveTextBox?
    /// The current segment's audio, written to disk so the row can be PLAYED.
    ///
    /// "in ios app we will be able to listen all the speech + transcription
    /// directly" — a necklace-live row had the transcription half and not the
    /// listening half: it stored text with `audioFile: nil`, so the list showed
    /// the words with no Play button and the audio was decoded, heard once, and
    /// dropped. Nothing else in the app could reach it afterwards.
    ///
    /// This is a THIRD consumer of the buffer feedAudio already built, not a
    /// second capture: the same DC-corrected, gain-normalized buffer that goes to
    /// the speaker and the recognizer. Writing the raw stream instead would store
    /// audio at the mic's native ~-48 dBFS, which is measurably inaudible — the
    /// level that transcribes to nothing at all.
    private var segmentAudio: SegmentAudio?
    private var segmentStartedAt: Date?
    private var lastTextPublish = Date.distantPast
    /// When the current TASK was created (not the segment) — what the restart
    /// rate limit measures against.
    private var lastTaskStart = Date.distantPast
    /// Utterances from finished tasks in the current segment, in order.
    private var bankedUtterances: [String] = []
    /// The last ~2s of decoded audio, replayed into a freshly started task.
    ///
    /// A task dies MID-utterance, and the buffers appended between its death and
    /// the restart are gone. Measured without this, every restarted sentence came
    /// back clipped ("The neck… And this sentence should be transcribed on"); with
    /// it, the same audio transcribes in full.
    private var preroll: [AVAudioPCMBuffer] = []
    /// ~2s at 16kHz — enough to cover a lost syllable, short enough that the
    /// overlap it creates is reliably trimmed by stitching.
    private static let prerollFrames = 32_000
    /// Decaying peak-hold of the loudest recent audio (~10s of memory), which is
    /// what the makeup gain is calibrated from. See applyGain for why this and
    /// not an RMS-chasing filter.
    private var speechPeak: Float = 0

    /// Current makeup gain (see applyGain). 1 on a stream that is already loud
    /// enough; the board's own acoustic level needs roughly 10×.
    private var gain: Float = 1
    /// -21 dBFS. A sweep of the SAME real capture through the SAME decode path
    /// transcribed cleanly from -15 to -27 dB, degraded by -30, returned the
    /// single word "Microphone" at -36, and returned nothing at the board's
    /// native -48. -21 sits in the middle of what works.
    private static let gainTargetRMS: Float = 0.0891
    /// Don't adapt on chunks quieter than this — an empty room would otherwise
    /// drive the gain to the ceiling and blast the first word that arrives.
    private static let gainNoiseGate: Float = 0.0008
    /// Bounded either side: 40× covers the measured -48 dBFS deficit with room to
    /// spare, and never below 1 because attenuating the necklace helps nobody.
    private static let gainMin: Float = 1
    private static let gainMax: Float = 40
    /// Peak ceiling. Speech has a crest factor near 4.3×, so a gain that is
    /// correct on average still clips the transients: measured on the board's own
    /// stream, an RMS-only AGC clipped 86% of one chunk's samples. 0.9 keeps a
    /// little headroom below full scale.
    private static let gainPeakCeiling: Float = 0.9

    /// A single SFSpeechRecognitionTask is only good for about a minute of
    /// audio; past that it stops returning results with no error. The necklace
    /// streams until its own 5-minute session cap, so segments are rotated well
    /// inside that limit — each finished segment becomes one transcript row.
    private static let segmentSeconds: TimeInterval = 45
    /// Floor between recognizer restarts. Speech ends a task after a few seconds
    /// of silence, and a quiet room would otherwise rebuild one per audio chunk.
    private static let minRestartSeconds: TimeInterval = 2
    /// Segments shorter than this in characters are dropped instead of stored.
    /// Rotation fires every 45s whether anyone spoke or not, so without a floor
    /// a necklace left on a table would post ~80 rows an hour of silence and
    /// recognizer noise into the agent's context.
    private static let minSegmentChars = 4

    private static let cachedURLKey = "tinyLive.streamBase"   // "http://ip:8080"

    // ---- lifecycle -----------------------------------------------------------

    func start(token: String?) {
        guard !running else { return }
        running = true
        self.token = token
        frame = nil
        lastError = nil
        stateText = "finding the necklace…"
        Task { await connect(token: token) }
    }

    func stop() {
        videoTask?.cancel(); videoTask = nil
        audioTask?.cancel(); audioTask = nil
        session?.invalidateAndCancel(); session = nil
        if engineReady { player.stop(); engine.stop(); engineReady = false }
        videoBuf = Data(); pcmRemainder = Data()
        running = false
        frame = nil
        // A new stream is a new room: carrying the last session's gain over means
        // the first seconds are mis-levelled from an estimate made somewhere else.
        gain = 1
        speechPeak = 0
        // Closing the card must not discard what the necklace already said —
        // the overlay is dismissed constantly and a segment is up to 45s of
        // speech. finishSegment() stores it (or drops it if it's silence).
        finishSegment()
    }

    func toggleAudio() {
        audioOn.toggle()
        if audioOn, let base = UserDefaults.standard.string(forKey: Self.cachedURLKey) {
            openAudio(base: base)
        } else {
            audioTask?.cancel(); audioTask = nil
            if engineReady { player.stop(); engine.stop(); engineReady = false }
            // Muting cuts the buffers off at the source (feedAudio returns on
            // !audioOn), so the open segment would otherwise hang unfinished
            // until the next unmute rotated it out.
            finishSegment()
        }
    }

    // ---- discovery -----------------------------------------------------------

    private func connect(token: String?) async {
        // Fast path: on the same WiFi a cached base answers in <2s → 20fps LAN.
        if let base = UserDefaults.standard.string(forKey: Self.cachedURLKey) {
            if await probe(base: base) {
                mode = .lan
                open(base: base); return
            }
            // Drop a base that no longer answers: DHCP hands the board a new
            // address across reboots, and a stale one would still be dialed by
            // toggleAudio() (which trusts this key without probing).
            UserDefaults.standard.removeObject(forKey: Self.cachedURLKey)
        }
        guard let token else {
            fail("Log in first — the live view goes through your tiny."); return
        }
        // Internet-first: the necklace is usually far away. Find its device id
        // and start remote frame polling immediately; if a LAN base turns up
        // AND answers, upgrade to the direct stream.
        stateText = "connecting through the cloud…"
        guard let found = await findDevice(token: token) else {
            fail("No nicla-vision device in your fleet — is it enrolled?"); return
        }
        let id = found.id
        // The board's OWN address, off its heartbeat — no discovery round trip.
        //
        // This is the fix for "says connecting through the cloud but i'm at the
        // same wifi". The only two ways this app could previously learn a LAN
        // base were the UserDefaults cache above (empty on a fresh install, and
        // dropped whenever a probe fails) and discoverViaRelay below — a `stream`
        // invoke through the relay, measured at 4-32s against the board's
        // single-threaded loop. So the opening was always cloud polling, while
        // the necklace served MJPEG at ~16 fps one hop away. The device row now
        // carries lan_url, refreshed every 30s and only reported while the board
        // is present, so the same-WiFi case needs no discovery at all.
        if let lan = found.lanURL, await probe(base: lan) {
            UserDefaults.standard.set(lan, forKey: Self.cachedURLKey)
            mode = .lan
            open(base: lan); return
        }
        remoteDeviceId = id
        mode = .remote
        Task { await remoteLoop(deviceId: id, token: token) }
        if let base = await discoverViaRelay(deviceId: id, token: token),
           await probe(base: base) {
            UserDefaults.standard.set(base, forKey: Self.cachedURLKey)
            guard running, mode == .remote else { return }
            mode = .lan
            open(base: base)   // remoteLoop sees the mode flip and stops
        }
    }

    /// Pick the necklace to talk to — and it must be the LIVE one.
    ///
    /// A board that gets re-enrolled (a wiped flash loses the device token, and
    /// the API mints it exactly once) leaves its old row behind forever: an
    /// orphan that is permanently offline and can never be reprovisioned, only
    /// revoked. Taking the FIRST nicla-vision row therefore depends on registry
    /// ordering to stay correct — today /api/devices happens to sort newest
    /// first, so it works, but nothing in the contract promises that. Aiming at
    /// an orphan costs the whole session: remote polling burns its retries on a
    /// device that will never answer, and the relay `stream` discovery never
    /// returns a LAN base, so the fast path is never even tried — the live view
    /// fails while a healthy necklace on the same WiFi is serving MJPEG.
    /// Order explicitly instead: online first, then freshest heartbeat.
    ///
    /// Returns the LAN base too, when the row has one. The registry only reports
    /// `lan_url` while the board is actually present, because a stale address is
    /// worse than none: DHCP reassigns it, so dialing it would mean waiting out a
    /// timeout against whatever machine holds it now before falling back — slower
    /// than never having tried.
    struct FoundDevice { let id: String; let lanURL: String? }

    /// Split out from the fetch so the ordering and the lan_url extraction — the
    /// two things that decide whether the fast path is taken — are testable
    /// without a network. See TinyLiveLanBaseTests.
    nonisolated static func pickVision(from list: [[String: Any]]) -> FoundDevice? {
        let visions = list.filter { ($0["platform"] as? String) == "nicla-vision" }
        let seen = { (d: [String: Any]) -> Double in
            (d["last_seen"] as? Double) ?? Double(d["last_seen"] as? Int ?? 0)
        }
        guard let best = visions
            .sorted(by: { a, b in
                let (aOn, bOn) = (a["online"] as? Bool == true, b["online"] as? Bool == true)
                if aOn != bOn { return aOn }
                return seen(a) > seen(b)
            })
            .first, let id = best["id"] as? String
        else { return nil }
        // http:// and a host, or nothing. A malformed value must fall through to
        // discovery rather than becoming a URL the probe spends 3 attempts on.
        let lan = (best["lan_url"] as? String).flatMap { raw -> String? in
            guard raw.hasPrefix("http://"), let u = URL(string: raw), u.host != nil else { return nil }
            return raw
        }
        return FoundDevice(id: id, lanURL: lan)
    }

    private func findDevice(token: String?) async -> FoundDevice? {
        guard let devices: [String: Any] = try? await Api.get("/api/devices", token: token),
              let list = devices["devices"] as? [[String: Any]]
        else { return nil }
        return Self.pickVision(from: list)
    }

    // ---- remote mode: relay `frame` polling — works from anywhere ------------

    private func remoteLoop(deviceId: String, token: String?) async {
        var misses = 0
        while running, mode == .remote, misses < 4 {
            if let img = await remoteFrame(deviceId: deviceId, token: token) {
                frame = img
                stateText = "remote · updating every few seconds"
                misses = 0
            } else {
                misses += 1
            }
        }
        if running, mode == .remote {
            fail("Necklace not answering — is it powered and online?")
        }
    }

    /// Remote ears: ask the necklace for a 2s clip, play the hosted WAV.
    func remoteListen() {
        guard !remoteListening, let id = remoteDeviceId else { return }
        remoteListening = true
        Task {
            defer { remoteListening = false }
            guard let sent: [String: Any] = try? await Api.post("/api/devices/relay", token: token, body: [
                "toDevice": id, "payload": ["type": "invoke", "prompt": "record"],
            ]), let msgId = sent["id"] as? String else { return }
            for _ in 0 ..< 12 {
                try? await Task.sleep(for: .seconds(3))
                guard let r: [String: Any] = try? await Api.get(
                    "/api/devices/relay?inReplyTo=\(msgId)", token: token),
                    let reply = r["reply"] as? [String: Any],
                    let payload = reply["payload"] as? String,
                    let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                    let text = obj["result"] as? String
                else { continue }
                if let range = text.range(of: #"https://\S+\.wav"#, options: .regularExpression),
                   let url = URL(string: String(text[range])) {
                    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                    clipPlayer = AVPlayer(url: url)
                    clipPlayer?.play()
                }
                return
            }
        }
    }

    /// Why a frame didn't arrive.
    ///
    /// `fetchFrame` collapses every one of these into `nil`, which is harmless
    /// for the streaming loop (it simply retries) and a dead end in a panel: the
    /// user taps, waits nineteen seconds, and is handed back the same "tap to
    /// peek" placeholder they started from — five different failures wearing one
    /// blank face, none of them distinguishable from not having tapped at all.
    enum FrameFailure: Error {
        /// tiny wouldn't take the request, or wouldn't let us collect the answer:
        /// signed out, device revoked, no network. Either END of the round trip —
        /// the poll arm reaches this too, because a mailbox we are not allowed to
        /// open tells us nothing about the board (see `RelayPoll`).
        case relayRefused(String)
        /// The board never answered inside the poll budget — and we could SEE
        /// that, having read the mailbox. `RelayPoll.verdict` is what keeps this
        /// case from standing in for "we couldn't ask".
        case noReply(seconds: Int)
        /// It DID answer, with words instead of an image — "camera busy",
        /// "no camera on this device". The most useful failure of the five, and
        /// the one the old code discarded most thoroughly.
        case deviceSaid(String)
        /// The frame's URL was unreachable, or the bytes weren't an image.
        case undecodable
        /// The caller asked us to stop (view disappeared, mode switched away).
        case cancelled

        var message: String {
            switch self {
            case .relayRefused(let why): return why
            case .noReply(let s): return "No frame in \(s)s — is the camera awake?"
            case .deviceSaid(let what): return what
            case .undecodable: return "The frame arrived but couldn't be decoded."
            case .cancelled: return ""
            }
        }
    }

    private static let framePollTries = 16
    private static let framePollEvery = 1.2   // the warm-sensor firmware answers in ~2-3s

    /// What a device's reply to a `frame` invoke turned out to be.
    enum FrameAnswer: Equatable {
        case imageURL(URL)
        /// It answered with prose, not a picture. STILL an answer.
        case words(String)
    }

    /// Read one reply payload. Pure, because the two bugs it fixes are both
    /// decisions about a string and neither was reachable by a test while they
    /// lived inside an async polling loop:
    ///
    ///   1. A payload carrying no `images` used to leave the loop as a bare
    ///      `nil`, so a board saying "no camera on this device" was reported to
    ///      the user as no frame having arrived.
    ///   2. A payload that is a bare JSON string — legal on this wire, since the
    ///      worker validates with JS `JSON.parse` and that accepts a top-level
    ///      string — failed the `[String: Any]` cast and hit `continue`, so an
    ///      answer that had already arrived burned the entire 19s poll budget
    ///      and was then reported as a timeout.
    ///
    /// Both collapse to: if the device said ANYTHING, stop polling and say what
    /// it said.
    /// No `.fragmentsAllowed` here on purpose: a bare-string payload can never
    /// carry an `images` array, so it lands in `.words` either way — and
    /// `RelayReply.text`, which does the unwrapping, passes the option itself.
    nonisolated static func readFrameAnswer(_ payload: String) -> FrameAnswer {
        guard let obj = try? JSONSerialization.jsonObject(
                with: Data(payload.utf8)) as? [String: Any],
              let images = obj["images"] as? [[String: Any]],
              let urlStr = images.first?["url"] as? String,
              let url = URL(string: urlStr), url.scheme != nil
        else { return .words(RelayReply.text(payload)) }
        return .imageURL(url)
    }

    /// One relay round-trip: invoke `frame`, await the reply, fetch the R2 URL.
    /// Static so the devices list's RelayCameraPanel shares the exact path.
    ///
    /// Returns the REASON on failure; `readFrameAnswer` above documents the two
    /// silent bugs that used to live in the polling arm.
    static func frameResult(deviceId: String, token: String?,
                            keepGoing: @escaping () -> Bool = { true }) async -> Result<UIImage, FrameFailure> {
        let sent: [String: Any]? = try? await Api.post("/api/devices/relay", token: token, body: [
            "toDevice": deviceId, "payload": ["type": "invoke", "prompt": "frame"],
        ])
        guard let msgId = sent?["id"] as? String, !msgId.isEmpty else {
            return .failure(.relayRefused((sent?["error"] as? String) ?? "Couldn't reach the relay."))
        }
        let query = msgId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? msgId
        /// The last attempt's reason, nil once an attempt reads the mailbox —
        /// see `RelayPoll.verdict`. This is what stops a lapsed session from
        /// being reported as a sleeping camera.
        var refusal: String?
        for _ in 0 ..< framePollTries {
            try? await Task.sleep(for: .seconds(framePollEvery))
            guard keepGoing() else { return .failure(.cancelled) }
            switch await RelayPoll.read(inReplyTo: query, token: token) {
            case .empty:
                refusal = nil
            case .unreadable(let why, let status):
                refusal = why
                // Retrying a 401 is 19s of spinner over a settled question.
                if RelayPoll.isTerminal(status: status) { return .failure(.relayRefused(why)) }
            case .answered(let payload):
                // Past here the device HAS answered. An answer without an image
                // is still an answer, so it must never fall through to a timeout.
                switch readFrameAnswer(payload) {
                case .words(let said):
                    return .failure(.deviceSaid(said))
                case .imageURL(let url):
                    guard let (data, _) = try? await URLSession.shared.data(from: url),
                          let img = UIImage(data: data)
                    else { return .failure(.undecodable) }
                    return .success(img)
                }
            }
        }
        switch RelayPoll.verdict(refusal: refusal) {
        case .deviceSilent:
            return .failure(.noReply(seconds: Int(Double(framePollTries) * framePollEvery)))
        case .couldNotAsk(let why):
            return .failure(.relayRefused(why))
        }
    }

    /// The streaming loop's view of the same call: it retries on its own
    /// schedule and has nowhere to show a sentence, so a reason is just a nil.
    static func fetchFrame(deviceId: String, token: String?,
                           keepGoing: @escaping () -> Bool = { true }) async -> UIImage? {
        try? await frameResult(deviceId: deviceId, token: token, keepGoing: keepGoing).get()
    }

    private func remoteFrame(deviceId: String, token: String?) async -> UIImage? {
        await Self.fetchFrame(deviceId: deviceId, token: token) { [weak self] in
            (self?.running ?? false) && self?.mode == .remote
        }
    }

    /// GET / on a cached base — the dial the whole LAN fast path hinges on.
    ///
    /// Retried, because the FIRST local-network dial after an install is the
    /// call that raises the iOS permission sheet — and that call fails while
    /// the sheet is still on screen. A single 2s shot therefore always lost the
    /// race on a fresh install, dropped the cached base, and pinned the session
    /// to cloud polling even though the necklace was one hop away. Three tries
    /// with a beat between them outlive the prompt; a genuinely absent board
    /// still costs well under the relay discovery it runs alongside.
    ///
    /// The 2s this used to allow per attempt was ALSO too tight, and the docstring
    /// asserting "answers in <2s when reachable" was simply untrue of the board.
    /// The necklace runs a single-threaded loop that polls its listener between
    /// blocking cloud calls, so accept latency includes whatever WAN round trip is
    /// in flight. Measured on the board: relay PUT 1.0-2.1s, heartbeat POST
    /// 0.9-1.2s, and the resulting dial latency ~1.2s median / ~3.3s p90 / ~5.4s
    /// worst over 24 trials — after the firmware fix that removed a hard ~4.8s
    /// floor. A 2s cutoff discards a board that is present and healthy, which is
    /// the "connecting through the cloud while on the same wifi" report.
    ///
    /// 6s covers the measured worst case with headroom. It costs nothing when the
    /// board is absent: URLSession fails a LAN dial to a dead host on connection
    /// refusal / ARP failure, not by burning the timeout. See
    /// strands-nicla/hardware/README.md for the measurements.
    private func probe(base: String) async -> Bool {
        guard let url = URL(string: base + "/") else { return false }
        for attempt in 0 ..< 3 {
            if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
            guard running else { return false }
            var req = URLRequest(url: url); req.timeoutInterval = 6
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["stream"] != nil {
                return true
            }
        }
        return false
    }

    /// Relay `stream` invoke → reply text contains "video http://ip:8080/stream".
    private func discoverViaRelay(deviceId: String, token: String?) async -> String? {
        guard let sent: [String: Any] = try? await Api.post("/api/devices/relay", token: token, body: [
            "toDevice": deviceId, "payload": ["type": "invoke", "prompt": "stream"],
        ]), let msgId = sent["id"] as? String else { return nil }
        for _ in 0 ..< 8 {
            try? await Task.sleep(for: .seconds(4))
            guard let r: [String: Any] = try? await Api.get(
                "/api/devices/relay?inReplyTo=\(msgId)", token: token),
                let reply = r["reply"] as? [String: Any],
                let payload = reply["payload"] as? String,
                let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                let text = obj["result"] as? String
            else { continue }
            if let range = text.range(of: #"http://[0-9.]+:\d+"#, options: .regularExpression) {
                return String(text[range])
            }
            return nil
        }
        return nil
    }

    // ---- streams ---------------------------------------------------------------

    private func open(base: String) {
        stateText = "connecting to \(base)…"
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = .infinity
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        session = s
        if let url = URL(string: base + "/stream") {
            videoTask = s.dataTask(with: url)
            videoTask?.resume()
        }
        if audioOn { openAudio(base: base) }
    }

    private func openAudio(base: String) {
        guard let s = session, let url = URL(string: base + "/audio") else { return }
        audioTask = s.dataTask(with: url)
        audioTask?.resume()
    }

    private func fail(_ why: String) {
        lastError = why
        stateText = why
        running = false
        // Keep what was already said. This is not a rare path — the board caps
        // every session at SESSION_MAX_S (300s, tiny_stream.py), so a listen that
        // runs to the cap ALWAYS ends here rather than through stop(), and the
        // segment in progress was silently discarded: up to 45s of speech and its
        // audio, on every long session. The pre-connect fail()s above have no
        // segment open, so finishSegment() returns immediately for them.
        finishSegment()
    }

    // ---- decoders ----------------------------------------------------------------

    fileprivate func feedVideo(_ data: Data) {
        videoBuf.append(data)
        // Scan for complete JPEGs (SOI..EOI); boundary text between parts is skipped
        while true {
            guard let soi = videoBuf.range(of: Data([0xFF, 0xD8])),
                  let eoi = videoBuf.range(of: Data([0xFF, 0xD9]), in: soi.lowerBound ..< videoBuf.endIndex)
            else { break }
            let jpeg = videoBuf.subdata(in: soi.lowerBound ..< eoi.upperBound)
            videoBuf.removeSubrange(videoBuf.startIndex ..< eoi.upperBound)
            if let img = UIImage(data: jpeg) {
                frame = img
                stateText = "live"
            }
        }
        if videoBuf.count > 512 * 1024 { videoBuf = Data() }  // runaway guard
    }

    fileprivate func feedAudio(_ data: Data) {
        guard audioOn else { return }
        if !engineReady {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: audioFormat)
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            guard (try? engine.start()) != nil else { return }
            player.play()
            engineReady = true
        }
        pcmRemainder.append(data)
        let sampleCount = pcmRemainder.count / 2
        guard sampleCount > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: AVAudioFrameCount(sampleCount))
        else { return }
        buf.frameLength = AVAudioFrameCount(sampleCount)
        // Decode, and remove the mic's DC offset in the same pass. The board's
        // PDM path sits ~500-800 counts above zero and DRIFTS, so a fixed
        // correction would be wrong within seconds; the running mean of each
        // chunk tracks it. Left in, the offset is a fat sub-20Hz tone under
        // everything — inaudible, but it is 40% of the "quiet" spectrum measured
        // on the board and it eats the headroom the gain below needs.
        var mean: Float = 0
        pcmRemainder.withUnsafeBytes { raw in
            let int16 = raw.bindMemory(to: Int16.self)
            let out = buf.floatChannelData![0]
            var sum: Float = 0
            for i in 0 ..< sampleCount {
                let v = Float(Int16(littleEndian: int16[i])) / 32768.0
                out[i] = v
                sum += v
            }
            mean = sum / Float(sampleCount)
            for i in 0 ..< sampleCount { out[i] -= mean }
        }
        pcmRemainder.removeFirst(sampleCount * 2)
        // Normalize before anyone consumes it — the speaker AND the recognizer.
        //
        // This is not polish, it is the difference between working and not. The
        // necklace's mic delivers about -48 dBFS: measured on real speech played
        // across the room, that transcribes to NOTHING, while the identical
        // capture amplified to -21 dBFS returns "Testing the microphone from
        // across the room". A level sweep put the usable window at -15 to -30 dB
        // and total failure at the native level.
        //
        // DC removal above is a prerequisite, not a nicety: with the board's ~886
        // count offset left in, a chunk's RMS is dominated by the constant (0.024
        // vs 0.0004 of actual signal) and every level measurement reads the same
        // number whether someone is speaking or not.
        applyGain(to: buf)
        player.scheduleBuffer(buf)

        // Same buffer, second consumer: hear it AND read it. Note there is no
        // microphone here — buffer-based recognition needs speech authorization
        // only, so the audio session stays .playback and this never fights
        // VoiceMode or NiclaRecorder for the phone's mic.
        guard transcribeSpeech else { return }
        let now = Date()

        // Third consumer: keep it, so the row can be played later. Opened here
        // rather than in startSpeech() because startSpeech() runs again on every
        // recognizer restart — several times per segment — and a file per restart
        // would leave one playable fragment and a directory of orphans.
        if segmentAudio == nil {
            segmentAudio = SegmentAudio(dir: NiclaRecorder.storeDir(), format: audioFormat)
        }
        segmentAudio?.write(buf)

        // Keep the recent past so a restart can replay it (see `preroll`).
        preroll.append(buf)
        var held = preroll.reduce(0) { $0 + Int($1.frameLength) }
        while held > Self.prerollFrames, preroll.count > 1 {
            held -= Int(preroll.removeFirst().frameLength)
        }

        // A task that has ENDED still accepts buffers and does nothing with them.
        // It ends on its own after ONE utterance, or with "No speech detected" in
        // a quiet room — both measured against 125s of the board's real /audio,
        // where a single task transcribed literally nothing. Nothing else notices,
        // so every word after the first sentence was dropped on the floor.
        //
        // Restart urgency comes from the recognizer, not from audio energy. A task
        // that delivered a final result reported an utterance and quit while the
        // speaker is very likely still going, so its replacement is needed NOW. A
        // task that errored with nothing heard was listening to an empty room, and
        // rebuilding one per chunk of silence measured 316 restarts in 125s and
        // destroyed recognition outright — so that case waits out the rate limit.
        //
        // An energy gate was tried here first and removed: it cannot distinguish
        // "mid-sentence" from "the room is noisy", and it was silently inert on
        // this stream anyway, because the board's DC offset made every chunk
        // measure the same level.
        if let box = speechBox, box.isEnded,
           box.deliveredUtterance || now.timeIntervalSince(lastTaskStart) >= Self.minRestartSeconds {
            restartTask()
        }
        if speechRequest == nil { startSpeech() }
        speechRequest?.append(buf)
        // Publishing on every chunk would invalidate the overlay ~30×/second for
        // text that changes far slower than that. 4/second reads as live and
        // costs SwiftUI nothing.
        if now.timeIntervalSince(lastTextPublish) >= 0.25 {
            lastTextPublish = now
            let t = segmentText()
            if t != liveText { liveText = t }
        }
        if let started = segmentStartedAt, now.timeIntervalSince(started) >= Self.segmentSeconds {
            rotateSegment()
        }
    }

    // ---- speech segments -----------------------------------------------------

    /// Turn transcription on/off for the stream in progress.
    func toggleTranscribe() {
        transcribeSpeech.toggle()
        if transcribeSpeech {
            speechNote = nil
        } else {
            finishSegment()   // keep whatever was already said
        }
    }

    private func startSpeech() {
        guard let recog = recognizer ?? SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
              recog.isAvailable else {
            // Turn it OFF, don't just note it: leaving the flag set means every
            // audio chunk re-enters startSpeech() and re-fails, 30× a second.
            transcribeSpeech = false
            speechNote = "Speech recognition isn't available on this phone."
            return
        }
        recognizer = recog
        // Authorization is asynchronous and this is called from the decode path,
        // so a first stream may transcribe nothing while the prompt is up. The
        // next chunk after the user allows it starts a task normally.
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in }
            speechNote = "Allow speech recognition to read the necklace's audio."
            return
        default:
            transcribeSpeech = false
            speechNote = "Speech recognition is denied for tiny in Settings."
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // On-device where the phone supports it: this is a continuously open
        // microphone in someone's home, and it must not become a stream of
        // household audio to a server.
        req.requiresOnDeviceRecognition = recog.supportsOnDeviceRecognition
        req.addsPunctuation = true
        let box = LiveTextBox()
        speechBox = box
        speechRequest = req
        speechTask = Self.recognize(recog, request: req, box: box)
        let now = Date()
        if segmentStartedAt == nil { segmentStartedAt = now }
        lastTaskStart = now
        speechNote = nil
    }

    /// Everything heard in this segment: the utterances already banked from
    /// finished tasks, plus whatever the live task has so far.
    ///
    /// A task is banked rather than stored because ONE SFSpeechRecognitionTask
    /// reports ONE utterance: after its first sentence it goes quiet, and 125s of
    /// speech fed to a single task transcribed to nothing at all. So a segment is
    /// necessarily several tasks stitched together — and stitching is why a
    /// restart does not become its own transcript row.
    private func segmentText() -> String {
        let live = speechBox?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (bankedUtterances + (live.isEmpty ? [] : [live]))
            .joined(separator: " ")
    }

    /// One task ended — keep its words and open the next, WITHOUT ending the
    /// segment. The user is mid-conversation; only the recognizer restarted.
    private func restartTask() {
        // Whether the outgoing task is OWED a replay depends on how it ended. A
        // final result means it already reported everything it heard, so replaying
        // its audio re-transcribes accounted-for speech and manufactures the
        // duplicate the stitcher then has to guess at. An error can strike
        // mid-utterance with syllables never reported, and those exist only here.
        let owedReplay = !(speechBox?.deliveredUtterance ?? false)
        bank(speechBox?.text ?? "")
        speechRequest?.endAudio()
        speechTask?.cancel()
        speechTask = nil
        speechRequest = nil
        speechBox = nil
        guard transcribeSpeech, running else { return }
        startSpeech()
        if owedReplay {
            for b in preroll { speechRequest?.append(b) }
        }
    }

    /// Add a finished utterance to the segment, trimming the overlap the preroll
    /// creates.
    ///
    /// Replaying ~2s of audio means the new task legitimately re-transcribes the
    /// tail of the previous utterance. Without trimming, a stored segment read
    /// "…transcribed on device The necklace is listening, and the sentence should
    /// be transcribed on device" — the same sentence twice, which is worse than a
    /// clipped one because the agent treats it as two things being said.
    private func bank(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        guard let prev = bankedUtterances.last else { bankedUtterances.append(t); return }
        if prev == t { return }
        // Compare against the WHOLE segment, not only the last utterance: a burst
        // of restarts replays overlapping windows of the same sentence, so the
        // duplicate is often two or three utterances back.
        let segment = Self.normalizedWords(bankedUtterances.joined(separator: " "))
            .joined(separator: " ")
        let incoming = Self.normalizedWords(t).joined(separator: " ")
        guard !incoming.isEmpty else { return }
        // A re-transcription of the same audio: keep the longer reading, which is
        // the more complete one.
        if segment.contains(incoming) { return }
        if incoming.contains(Self.normalizedWords(prev).joined(separator: " ")) {
            bankedUtterances[bankedUtterances.count - 1] = t
            return
        }
        if let seam = Self.bestSeam(prev, t) {
            // Drop the dying task's trailing guess, if any (see bestSeam).
            if seam.junk > 0 {
                let kept = prev.split(separator: " ").dropLast(seam.junk).joined(separator: " ")
                if kept.isEmpty {
                    bankedUtterances.removeLast()
                } else {
                    bankedUtterances[bankedUtterances.count - 1] = kept
                }
            }
            let rest = t.split(separator: " ").dropFirst(seam.overlap).joined(separator: " ")
            if !rest.isEmpty { bankedUtterances.append(rest) }
        } else {
            bankedUtterances.append(t)
        }
    }

    /// Close the current segment and immediately open the next, so a long
    /// stream keeps transcribing past one task's usable lifetime.
    private func rotateSegment() {
        finishSegment()
        guard transcribeSpeech, running else { return }
        startSpeech()
    }

    /// End the segment in progress and store it if anyone actually spoke.
    private func finishSegment() {
        // Nothing open AND nothing banked = nothing to do. Checking only the
        // request would throw away utterances banked by restartTask() when the
        // segment ends with a dead task, which is the common case: the last thing
        // a stream does is fall quiet.
        guard speechRequest != nil || !bankedUtterances.isEmpty || segmentAudio != nil else { return }
        let text = segmentText()
        let seconds = segmentStartedAt.map { Int(Date().timeIntervalSince($0).rounded()) } ?? 0
        speechRequest?.endAudio()
        speechTask?.cancel()
        speechTask = nil
        speechRequest = nil
        speechBox = nil
        bankedUtterances = []
        segmentStartedAt = nil
        preroll = []
        liveText = ""
        // Close the file before deciding anything: an AVAudioFile still open has
        // no moov atom on disk, so a row pointing at it would have a Play button
        // that fails. Take the audio ONLY if the transcript is also worth keeping
        // — a discarded segment must not leak its file, and 45 seconds of an empty
        // room is not something to store every 45 seconds forever.
        let audio = segmentAudio
        segmentAudio = nil
        let keptAudio = audio?.finish() == true
        guard text.count >= Self.minSegmentChars else {
            if let u = audio?.url { try? FileManager.default.removeItem(at: u) }
            return
        }
        // Same rail as a phone-mic take: it lands in the transcripts list and in
        // the agent's context. Labelled by its source so the model can tell the
        // necklace's own microphone from a take the phone recorded.
        // The label is the shared constant, not a literal: the eviction rule keys
        // off it, so a typo here would silently make live audio permanent.
        NiclaRecorder.shared.storeHeard(
            text: text, label: NiclaRecorder.liveLabel, seconds: max(1, seconds),
            audioFile: keptAudio ? audio?.name : nil)
    }
}

extension TinyLive {
    /// Born nonisolated so the recognizer's callback never captures the actor
    /// (the house c9 rule — same shape as NiclaRecorder.recognize).
    fileprivate nonisolated static func recognize(
        _ recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest, box: LiveTextBox
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            if let text = result?.bestTranscription.formattedString { box.set(text) }
            // A quiet room ends the task with "No speech detected" (kSFSpeech…
            // error 1110) — verified against 8s of real /audio from the board.
            // Record it so the decode path can start a fresh task instead of
            // appending into a dead one, and record WHICH ending it was: only a
            // final result means an utterance was reported and the speaker is
            // probably still talking. Measured, every ending on a quiet stream
            // was an error with no text, and treating those as urgent is what
            // produced hundreds of useless restarts.
            let final = result?.isFinal == true
            if error != nil || final { box.markEnded(reportedUtterance: final) }
        }
    }

    /// Bring a chunk up to a level speech recognition can actually read.
    ///
    /// MAKEUP gain from a decaying peak-hold, deliberately not an RMS-chasing
    /// AGC. Both were built and measured against the board's real stream:
    ///
    /// - A per-chunk RMS normalizer asks "is THIS chunk at the target?", so it
    ///   hands a quiet room a huge gain and loud speech a small one. That flattens
    ///   the very speech/silence contrast a recognizer relies on, and on audio
    ///   that was already loud enough it wound the gain to 26×, overshot the
    ///   target by 12 dB and clipped 86% of one chunk's samples. Distorted speech
    ///   made the recognizer emit sliding 2–3 word guesses instead of sentences.
    /// - A peak-hold asks "how loud is the loudest thing I have heard lately?".
    ///   Room noise never becomes the peak, so the estimate tracks actual speech;
    ///   the whole segment gets ONE slowly-moving multiplier, which preserves the
    ///   contrast and only moves the absolute level.
    ///
    /// The practical effect: this is a no-op (1×) on a stream already inside the
    /// -15…-30 dBFS window Apple's recognizer can read, and lifts roughly 10× on
    /// the board's own acoustic level, which measured -40 dBFS and transcribed to
    /// nothing at all before this existed.
    private func applyGain(to buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
        let n = Int(buf.frameLength)
        var sum: Float = 0
        var peak: Float = 0
        for i in 0 ..< n {
            sum += ch[i] * ch[i]
            peak = max(peak, abs(ch[i]))
        }
        let rms = (sum / Float(n)).squareRoot()
        // 0.98 per chunk ≈ 10s of memory: long enough to hold through a pause in
        // a sentence, short enough to follow someone walking away from the board.
        speechPeak = max(speechPeak * 0.98, rms)
        if speechPeak > Self.gainNoiseGate {
            gain = min(max(Self.gainTargetRMS / speechPeak, Self.gainMin), Self.gainMax)
        }
        // Clamp THIS chunk against its own peak before writing. Reacting after
        // the fact — shrink the gain once clipping is observed — is too late,
        // because the damaged samples have already been handed to Speech.
        let safe = peak > 0 ? min(gain, Self.gainPeakCeiling / peak) : gain
        guard safe != 1 else { return }
        for i in 0 ..< n { ch[i] *= safe }
    }

    /// Words, lowercased and stripped of punctuation. The recognizer re-punctuates
    /// and re-capitalizes the same audio differently between tasks, so an exact
    /// comparison finds no overlap at all and lets every duplicate through.
    fileprivate nonisolated static func normalizedWords(_ s: String) -> [String] {
        s.split(whereSeparator: { $0 == " " || $0.isNewline })
            .map { $0.lowercased().trimmingCharacters(in: .punctuationCharacters) }
            .filter { !$0.isEmpty }
    }

    /// Where two consecutive utterances join, tolerating a few junk words at the
    /// end of the first.
    ///
    /// A dying task's final words are a PARTIAL guess at audio it never finished
    /// hearing — "…is listening, and the" where the speaker said "…and this
    /// sentence should be transcribed". Requiring an exact suffix match let that
    /// one wrong word defeat the entire trim: a real four-word overlap scored
    /// zero, and the whole replayed window was banked verbatim. Measured, that is
    /// what turned five spoken sentences into 450 characters of sliding
    /// two-to-three word fragments.
    ///
    /// So: try dropping up to three trailing words from `a` and take the first
    /// alignment that matches. Two words minimum, because a single common word
    /// ("the", "and") matches by coincidence constantly.
    fileprivate nonisolated static func bestSeam(
        _ a: String, _ b: String
    ) -> (junk: Int, overlap: Int)? {
        let aw = normalizedWords(a), bw = normalizedWords(b)
        for junk in 0 ... 3 where junk < aw.count {
            let head = Array(aw.prefix(aw.count - junk))
            var n = min(head.count, bw.count)
            while n >= 2 {
                if Array(head.suffix(n)) == Array(bw.prefix(n)) {
                    return (junk, n)
                }
                n -= 1
            }
        }
        return nil
    }
}

extension TinyLive: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor in
            if dataTask === self.videoTask { self.feedVideo(data) }
            else if dataTask === self.audioTask { self.feedAudio(data) }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let why = error?.localizedDescription
        Task { @MainActor in
            if task === self.videoTask {
                self.fail(why ?? "stream ended (device caps sessions at 5 min)")
            }
        }
    }
}

/// Floating PiP card — GlassesLiveOverlay's sibling for the necklace.
struct TinyLiveOverlay: View {
    @Binding var shown: Bool
    @EnvironmentObject var session: TinySession
    @ObservedObject private var live = TinyLive.shared

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                if let frame = live.frame {
                    Image(uiImage: frame)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Rectangle().fill(.black.opacity(0.85))
                    VStack(spacing: 6) {
                        Text("💎").font(.title2)
                        Text(live.lastError ?? live.stateText)
                            .font(.caption2).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).padding(.horizontal, 8)
                    }
                }
            }
            .frame(width: 236, height: 177) // QVGA is 4:3
            .clipped()
            .overlay(alignment: .bottom) {
                // Subtitles for the necklace. Shown over the frame rather than
                // in the control row because it grows: the point is to read what
                // is being said right now, and the text is also being stored.
                if let line = live.speechNote ?? (live.liveText.isEmpty ? nil : live.liveText) {
                    Text(line)
                        .font(.caption2)
                        .foregroundStyle(.white)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(.black.opacity(0.55))
                }
            }

            HStack(spacing: 12) {
                if live.mode == .lan {   // LAN: continuous PCM audio toggle
                    Button {
                        live.toggleAudio()
                    } label: {
                        Image(systemName: live.audioOn ? "speaker.wave.2.fill" : "speaker.slash")
                            .foregroundStyle(live.audioOn ? .green : .secondary)
                    }
                    Button {
                        live.toggleTranscribe()
                    } label: {
                        Image(systemName: live.transcribeSpeech ? "captions.bubble.fill" : "captions.bubble")
                            .foregroundStyle(live.transcribeSpeech ? .green : .secondary)
                    }
                    .accessibilityLabel(live.transcribeSpeech ? "Stop transcribing" : "Transcribe speech")
                } else {                 // remote: on-demand 2s clip via relay
                    Button {
                        live.remoteListen()
                    } label: {
                        if live.remoteListening {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "ear").foregroundStyle(.secondary)
                        }
                    }
                }
                Text(live.running
                     ? (live.mode == .lan ? "tiny necklace · live" : "tiny necklace · remote")
                     : "tiny necklace")
                    .font(.caption2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(.secondary)
                Button {
                    shown = false
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(radius: 12)
        .padding(.top, 8)
        .padding(.trailing, 8)
        .onAppear { live.start(token: session.token) }
        .onDisappear { live.stop() }
    }
}
