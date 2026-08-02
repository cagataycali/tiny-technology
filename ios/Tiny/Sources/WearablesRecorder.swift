/**
 * 🎥 GlassesRecorder — the meta_record_video executor. TOGGLE semantics:
 * the agent's first call starts a recording (posts {recording:true} fast),
 * its second call stops it — the MP4 finalizes, uploads once to /api/media,
 * up to 4 sampled frames upload beside it, and {ok,url,frames,seconds}
 * posts to the mailbox the server tool is polling. If the ~28s auto-stop
 * fires first (the media store caps uploads at 6MB), the finished result
 * waits as `pending` and the second call simply collects it.
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
    /// Finished-by-auto-stop result waiting for the agent's second call.
    private var pending: [String: Any]?

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
            return done
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
            autoStopTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.maxSeconds * 1_000_000_000))
                guard let self, self.isRecording else { return }
                // ⚠️ Clear our own handle BEFORE calling stop(): stop()'s
                // first line cancels autoStopTask, and we ARE that task —
                // self-cancellation makes the URLSession upload throw
                // CancellationError and the auto-stopped clip surfaces as
                // "clip upload failed: cancelled" instead of the clip.
                // (Android had the same shape via scope.cancel(); both
                // measured, both fixed.)
                self.autoStopTask = nil
                self.pending = await self.stop(token: token)
            }
            return ["ok": true, "recording": true]
        } catch {
            teardown()
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return ["ok": false, "error": message]
        }
    }

    private func stop(token: String?) async -> [String: Any] {
        autoStopTask?.cancel(); autoStopTask = nil
        guard let box, let fileURL else {
            teardown()
            return ["ok": false, "error": "no recording in progress"]
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
        defer { try? FileManager.default.removeItem(at: fileURL) }

        guard box.writer.status == .completed,
              let clip = try? Data(contentsOf: fileURL), !clip.isEmpty else {
            return ["ok": false, "error": "the recording could not be finalized (no frames arrived?) — try again"]
        }
        guard clip.count <= 6 * 1024 * 1024 else {
            return ["ok": false, "error": "the clip came out over the 6MB upload cap — record a shorter one"]
        }
        do {
            let up: [String: Any] = try await Api.post("/api/media", token: token, body: [
                "data": clip.base64EncodedString(),
                "contentType": "video/mp4",
            ])
            guard let url = up["url"] as? String else {
                return ["ok": false, "error": (up["error"] as? String) ?? "clip upload failed"]
            }
            // Frames are best-effort — a clip with no stills is still a clip.
            var frames: [String] = []
            for jpeg in box.frameJpegs {
                if let fu: [String: Any] = try? await Api.post("/api/media", token: token, body: [
                    "data": jpeg.base64EncodedString(),
                    "contentType": "image/jpeg",
                ]), let u = fu["url"] as? String { frames.append(u) }
            }
            return ["ok": true, "url": url, "frames": frames, "seconds": seconds]
        } catch {
            return ["ok": false, "error": "clip upload failed: \(error.localizedDescription)"]
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
