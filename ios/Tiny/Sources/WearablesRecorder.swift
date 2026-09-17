/**
 * 🎥 GlassesRecorder — the meta_record_video executor. TOGGLE semantics:
 * the agent's first call starts a recording (posts {recording:true} fast),
 * its second call stops it — the MP4 finalizes, uploads once to /api/media,
 * up to 4 sampled frames upload beside it, and {ok,url,frames,seconds}
 * posts to the mailbox the server tool is polling. If the ~28s auto-stop
 * fires first (the media store caps uploads at 6MB), the finished result
 * waits as `pending` and the second call simply collects it — but only for
 * `pendingTTL`, after which it is discarded and the agent is TOLD (a clip
 * from an hour ago is not an answer to a question asked now).
 *
 * Frame delivery is realtime and OFF-main: everything the video callback
 * touches lives in a lock-guarded RecorderBox, and the listener closure is
 * created in a nonisolated static helper — the c9 crash rule (a closure
 * born in a @MainActor class SIGTRAPs on AVFoundation's queues).
 *
 * Catalyst-free file like its siblings (no MWDAT slice there).
 */
import Foundation
import UIKit
import AVFoundation
import CoreMedia

#if canImport(MWDATCore) && canImport(MWDATCamera)
import MWDATCore
import MWDATCamera

/// Everything the realtime frame callback touches — @unchecked Sendable,
/// all mutation behind the lock, no main-actor state anywhere near it.
private final class RecorderBox: @unchecked Sendable {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let lock = NSLock()
    private var started = false
    private var firstPTS: CMTime?
    private var lastPTS: CMTime?
    private var lastSampleSec: Double = -100
    private(set) var frameJpegs: [Data] = []

    init(writer: AVAssetWriter, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor) {
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
    }

    /// Seconds of video written so far (0 before the first frame).
    var seconds: Double {
        lock.lock(); defer { lock.unlock() }
        guard let f = firstPTS, let l = lastPTS else { return 0 }
        return max(0, CMTimeGetSeconds(l) - CMTimeGetSeconds(f))
    }

    func append(_ frame: VideoFrame) {
        guard let pixels = CMSampleBufferGetImageBuffer(frame.sampleBuffer) else { return }
        let raw = CMSampleBufferGetPresentationTimeStamp(frame.sampleBuffer)
        lock.lock()
        // ⚠️ MONOTONIC pts is on US, not the source: Android measured a
        // looping source rewinding its timestamps — the muxed clip came out
        // with an overlapping timeline no player would open. AVAssetWriter
        // fares no better on a rewind. Rewind → one nominal frame step past
        // the last stamp (1/24s).
        let pts: CMTime
        if let last = lastPTS, CMTimeCompare(raw, last) <= 0 {
            pts = CMTimeAdd(last, CMTime(value: 1, timescale: 24))
        } else {
            pts = raw
        }
        if !started {
            started = true
            writer.startWriting()
            writer.startSession(atSourceTime: pts)
            firstPTS = pts
        }
        lastPTS = pts
        let appendable = input.isReadyForMoreMediaData
        // Sample a JPEG roughly every 8s (≤4 total) for the agent's eyes.
        let sec = CMTimeGetSeconds(pts)
        let wantSample = frameJpegs.count < 4 && sec - lastSampleSec >= 8
        if wantSample { lastSampleSec = sec }
        lock.unlock()

        if appendable { adaptor.append(pixels, withPresentationTime: pts) }
        if wantSample, let image = frame.makeUIImage(),
           let jpeg = image.jpegData(compressionQuality: 0.6) {
            lock.lock()
            if frameJpegs.count < 4 { frameJpegs.append(jpeg) }
            lock.unlock()
        }
    }
}

@MainActor
final class GlassesRecorder: ObservableObject {
    static let shared = GlassesRecorder()

    @Published private(set) var isRecording = false

    /// The 6MB media cap ⇒ ~28s at 1Mbps + headroom. Stated in the tool text.
    static let maxSeconds: Double = 28

    private var session: DeviceSession?
    private var stream: MWDATCamera.Stream?
    private var tokens: [AnyListenerToken] = []
    private var box: RecorderBox?
    private var fileURL: URL?
    private var autoStopTask: Task<Void, Never>?
    /// A finalized clip held in MEMORY, not yet uploaded. ≤6MB by the cap the
    /// finalizer enforces, plus ≤4 sampled JPEGs — the same bytes the upload
    /// would have read off disk, so the temp file is gone by the time this
    /// exists.
    struct Finished {
        let mp4: Data
        let frameJpegs: [Data]
        let seconds: Int
    }

    /// What the auto-stop parks for a call that may never come.
    ///
    /// ⚠️ `clip` is NOT uploaded. Finalizing is forced at `maxSeconds` (the MP4
    /// has to close), but uploading is not — and the START call was already
    /// answered, so at park time nobody has asked for these bytes. Uploading
    /// then meant a clip nobody ever collected sat in R2 forever: the worker has
    /// `MEDIA.put/head/get` and **no delete** (`worker/src/media.ts`),
    /// so there was no reclaim path even in principle. Now the bytes go up when
    /// (and only when) the second call collects them.
    /// `failure` is a finalize that produced nothing worth uploading — parked so
    /// the agent still learns what happened instead of silently getting a fresh
    /// recording.
    enum Parked {
        case clip(Finished)
        case failure([String: Any])
    }

    /// What the ~28s auto-stop left for the agent's second call — carrying WHEN
    /// it was parked, because it does not wait forever (`pendingTTL`). One value
    /// rather than two variables, so no assignment site can park without
    /// stamping.
    private var pending: (parked: Parked, at: Date)?

    /// Which sign-in this recorder is working for. `endSession()` bumps it.
    ///
    /// ⚠️ Load-bearing, and NOT redundant with `teardown()`: the auto-stop task
    /// nils its OWN handle before awaiting `stop()` (c39 — self-cancellation
    /// made the upload throw), so from that moment nothing can cancel it. A
    /// sign-out arriving while that upload is in flight would therefore clear
    /// `pending`, and then the finishing task would re-park the clip *after*
    /// the clear — the leak silently restored, with the drop still in the diff.
    /// This is Android's `active === this@Recording` check, which its mutex
    /// makes structural; on the MainActor the `await` is the seam instead.
    private var epoch = 0

    /// How long an auto-stopped clip stays collectable.
    ///
    /// ⚠️ NOT derived from the server's poll budget, deliberately: the START
    /// call was already answered, so NOBODY is polling for this clip. The
    /// deadline that matters is the USER'S, not a listener's. Without one, a
    /// clip that auto-stopped an hour ago answers the next meta_record_video
    /// call and the agent narrates a moment nobody asked about — the same rot
    /// as an expired consent grant, on video (see
    /// docs/remote-screenshot-consent-design-2026-08-02, P2.5).
    ///
    /// Bounded BELOW by `maxSeconds`: a clip must still be collectable after
    /// the auto-stop that produced it plus the reply the user is composing.
    /// Checked at COLLECT, with no timer — unlike consent, nothing is blocked
    /// waiting on it, so there is no listener to tell early (P2.7 needs a
    /// trigger only where someone is parked on the answer).
    static let pendingTTL: TimeInterval = 180

    /// Both phones say this, verbatim: an expired clip is DISCARDED and the
    /// call started a new recording — never described as the new one.
    static let staleNote = "⏱️ An earlier recording auto-stopped and expired uncollected, so it was discarded — this call started a NEW recording. Don't describe the old clip; call again to stop this one."

    /// Sign-out: drop everything this singleton is holding for the OUTGOING
    /// user. Two distinct leaks, both of them user data:
    ///
    /// 1. A clip parked by the auto-stop (`pending`) is a hosted video of the
    ///    previous user's surroundings, and `/media/:key` is public-but-
    ///    unguessable — so whoever signs in next could collect it with one
    ///    `meta_record_video` call and have the agent narrate it, inside the
    ///    TTL. The TTL bounds the window; it does not make the clip theirs.
    /// 2. A recording still ROLLING keeps the glasses streaming after its
    ///    owner signed out, and would upload under whatever token arrives
    ///    next (`Api.post` reads the token at call time) — so this stops the
    ///    stream and throws the bytes away rather than finishing the clip.
    ///    Nobody is owed a result: the turn that asked for it is gone.
    ///
    /// Same reasoning as the offline-queue drop in `TinySession.logout()`:
    /// sign-out is the earliest moment we know this must not be delivered.
    func endSession() {
        epoch += 1
        pending = nil
        teardown()
    }

    /// The CHAT executor: toggle + post to the mailbox the server tool polls.
    func runTool(toolUseId: String, token: String?) async {
        let payload = await toggle(token: token)
        await postResult(toolUseId, token: token, payload: payload)
    }

    /// The shared core (voice answers over its own WS, not the mailbox):
    /// start ↔ stop, or collect a clip the auto-stop already finished.
    func toggle(token: String?) async -> [String: Any] {
        if let done = pending {
            pending = nil
            // ⚠️ Collect only while it is still THIS conversation's clip. A
            // stale one is dropped and we fall through to START — and the
            // agent is told so explicitly, because otherwise it receives a
            // fresh {recording:true} and has no way to know a clip it once
            // asked for was thrown away.
            if Date().timeIntervalSince(done.at) < Self.pendingTTL {
                switch done.parked {
                // THE UPLOAD HAPPENS HERE, not at park time: this is the first
                // moment anyone has actually asked for the bytes. An expired
                // clip therefore never reaches R2 at all — which is the only
                // reclaim story available, since the worker cannot delete.
                case .clip(let clip): return await upload(clip, token: token)
                case .failure(let payload): return payload
                }
            }
            var fresh = await start(token: token)
            fresh["note"] = Self.staleNote
            return fresh
        }
        if isRecording { return await stop(token: token) }
        return await start(token: token)
    }

    private func start(token: String?) async -> [String: Any] {
        do {
            guard try await WearablesManager.shared.ensureCameraPermission() else {
                throw WearablesCaptureError.cameraDenied
            }
            let session = try await WearablesManager.shared.openSession(timeout: 25)
            self.session = session
            guard let stream = try session.addStream(
                config: StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 24)
            ) else { throw WearablesCaptureError.noStream }
            self.stream = stream

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("glasses-\(UUID().uuidString).mp4")
            fileURL = url
            let size = StreamingResolution.low.videoFrameSize
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width),
                AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_000_000],
            ])
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
            let box = RecorderBox(writer: writer, input: input, adaptor: adaptor)
            self.box = box

            tokens.append(Self.listenFrames(stream, into: box))
            // A recording is an active stream too — a capture-button tap
            // mid-clip must reach the agent's context (GlassesEvents).
            tokens.append(Self.listenState(stream))
            stream.start()
            isRecording = true

            // Auto-stop: the clip must fit the 6MB media cap.
            let epoch = self.epoch
            autoStopTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.maxSeconds * 1_000_000_000))
                guard let self, self.isRecording, self.epoch == epoch else { return }
                // ⚠️ Clear our own handle BEFORE calling stop(): stop()'s
                // first line cancels autoStopTask, and we ARE that task —
                // self-cancellation makes the URLSession upload throw
                // CancellationError and the auto-stopped clip surfaces as
                // "clip upload failed: cancelled" instead of the clip.
                // (Android had the same shape via scope.cancel(); both
                // measured, both fixed.)
                self.autoStopTask = nil
                // FINALIZE only — no upload. Nobody asked for these bytes yet
                // (the START call was answered long ago), and R2 has no delete,
                // so a speculative upload is permanent. They ride memory until
                // the second call collects them.
                let parked = await self.finalizeClip()
                // The sign-out seam: finalizing awaits `finishWriting()`, and
                // endSession() can run in that gap — parking here would restore
                // the leak it just cleared. Now it costs nothing to refuse: the
                // bytes were never uploaded, so dropping them is complete.
                guard self.epoch == epoch else { return }
                // Stamped at PARK time, not at collect: the clock the TTL
                // measures is how long the clip has been sitting unclaimed.
                self.pending = (parked, Date())
            }
            return ["ok": true, "recording": true]
        } catch {
            teardown()
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return ["ok": false, "error": message]
        }
    }

    /// Stop + finalize, NO network. Split out of `stop()` so the auto-stop can
    /// park real bytes without uploading them: the MP4 must close at
    /// `maxSeconds`, but nobody has asked for the clip yet, and an upload
    /// nobody collects is unreclaimable (the worker has no MEDIA.delete).
    private func finalizeClip() async -> Parked {
        autoStopTask?.cancel(); autoStopTask = nil
        guard let box, let fileURL else {
            teardown()
            return .failure(["ok": false, "error": "no recording in progress"])
        }
        isRecording = false
        tokens.removeAll()
        stream?.stop(); stream = nil
        session?.stop(); session = nil
        self.box = nil
        self.fileURL = nil

        let seconds = Int(box.seconds.rounded())
        box.input.markAsFinished()
        await box.writer.finishWriting()
        // The temp file dies here either way — the bytes we keep are in memory,
        // so a parked clip never depends on a file surviving in the cache dir.
        defer { try? FileManager.default.removeItem(at: fileURL) }

        guard box.writer.status == .completed,
              let clip = try? Data(contentsOf: fileURL), !clip.isEmpty else {
            return .failure(["ok": false, "error": "the recording could not be finalized (no frames arrived?) — try again"])
        }
        guard clip.count <= 6 * 1024 * 1024 else {
            return .failure(["ok": false, "error": "the clip came out over the 6MB upload cap — record a shorter one"])
        }
        return .clip(Finished(mp4: clip, frameJpegs: box.frameJpegs, seconds: seconds))
    }

    /// The upload half — runs when someone is actually waiting for the URL.
    private func upload(_ done: Finished, token: String?) async -> [String: Any] {
        do {
            let up: [String: Any] = try await Api.post("/api/media", token: token, body: [
                "data": done.mp4.base64EncodedString(),
                "contentType": "video/mp4",
            ])
            guard let url = up["url"] as? String else {
                return ["ok": false, "error": (up["error"] as? String) ?? "clip upload failed"]
            }
            // Frames are best-effort — a clip with no stills is still a clip.
            var frames: [String] = []
            for jpeg in done.frameJpegs {
                if let fu: [String: Any] = try await Api.post("/api/media", token: token, body: [
                    "data": jpeg.base64EncodedString(),
                    "contentType": "image/jpeg",
                ]) as [String: Any]?, let u = fu["url"] as? String { frames.append(u) }
            }
            return ["ok": true, "url": url, "frames": frames, "seconds": done.seconds]
        } catch {
            return ["ok": false, "error": "clip upload failed: \(error.localizedDescription)"]
        }
    }

    private func stop(token: String?) async -> [String: Any] {
        switch await finalizeClip() {
        case .failure(let payload): return payload
        case .clip(let done): return await upload(done, token: token)
        }
    }

    private func teardown() {
        autoStopTask?.cancel(); autoStopTask = nil
        tokens.removeAll()
        stream?.stop(); stream = nil
        session?.stop(); session = nil
        box = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        isRecording = false
    }

    /// c9 rule: the frame listener is born HERE, nonisolated — AVF delivers
    /// on its own queue and a MainActor-inherited closure SIGTRAPs.
    private nonisolated static func listenFrames(_ stream: MWDATCamera.Stream, into box: RecorderBox) -> AnyListenerToken {
        stream.videoFramePublisher.listen { frame in
            box.append(frame)
        }
    }

    /// Same birth rule for the state listener — it only feeds the lock-only
    /// tap detector, no actor state anywhere near it.
    private nonisolated static func listenState(_ stream: MWDATCamera.Stream) -> AnyListenerToken {
        let cell = StreamStateCell()
        return stream.statePublisher.listen { state in
            let (prev, new) = cell.swap(state)
            GlassesEvents.shared.onStreamTransition(from: prev, to: new)
        }
    }

    private func postResult(_ toolUseId: String, token: String?, payload: [String: Any]) async {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
            "toolUseId": toolUseId, "payload": json,
        ]) as [String: Any]
    }
}
#endif
