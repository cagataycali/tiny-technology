/**
 * 🕶️ Glasses live HUD — the toolbar eyeglasses icon (visible when linked)
 * opens a floating picture-in-picture card that streams the glasses camera
 * LIVE, with an on-device transcript of what the glasses hear.
 *
 * How each piece maps to the hardware:
 *  - VIDEO: a DAT camera stream (videoFramePublisher → CMSampleBuffer-backed
 *    frames → UIImage) through the same shared WearablesManager session
 *    plumbing meta_take_photo uses.
 *  - AUDIO: the glasses are the phone's Bluetooth microphone at the SYSTEM
 *    level — so `.allowBluetooth` on the audio session makes Apple's
 *    on-device speech recognition transcribe what the GLASSES hear. The DAT
 *    SDK itself exposes no audio API (0.8.0).
 *  - ANGLE/IMU: NOT exposed by DAT 0.8.0 (no gyro/attitude API in the
 *    shipped swiftinterface) — stated here so nobody hunts for it.
 *
 * Catalyst-free file, like Wearables.swift (no MWDAT slice there).
 */
import SwiftUI
import UIKit
import Speech
import AVFoundation

#if canImport(MWDATCore) && canImport(MWDATCamera)
import MWDATCore
import MWDATCamera

@MainActor
final class GlassesLive: ObservableObject {
    static let shared = GlassesLive()

    @Published var frame: UIImage?
    @Published var stateText = "connecting…"
    @Published var running = false
    @Published var transcribing = false
    @Published var transcript = ""
    @Published var lastError: String?

    private var session: DeviceSession?
    private var stream: MWDATCamera.Stream?
    private var tokens: [AnyListenerToken] = []
    private var startTask: Task<Void, Never>?

    func start() {
        guard !running, startTask == nil else { return }
        lastError = nil
        stateText = "connecting…"
        startTask = Task { [weak self] in
            await self?.startInternal()
            self?.startTask = nil
        }
    }

    private func startInternal() async {
        do {
            guard try await WearablesManager.shared.ensureCameraPermission() else {
                throw WearablesCaptureError.cameraDenied
            }
            let session = try await WearablesManager.shared.openSession(timeout: 25)
            self.session = session
            guard let stream = try session.addStream(config: StreamConfiguration()) else {
                throw WearablesCaptureError.noStream
            }
            self.stream = stream
            tokens.append(stream.statePublisher.listen { [weak self] state in
                Task { @MainActor in self?.stateText = String(describing: state) }
            })
            tokens.append(stream.videoFramePublisher.listen { [weak self] videoFrame in
                // makeUIImage() runs off-main (frame delivery thread) — only
                // the publish hops to the main actor.
                let image = videoFrame.makeUIImage()
                Task { @MainActor in self?.frame = image }
            })
            tokens.append(stream.errorPublisher.listen { [weak self] error in
                Task { @MainActor in self?.lastError = error.localizedDescription }
            })
            stream.start()
            running = true
            // ⚠️ Deliberately NOT auto-starting the transcript here (c8): the
            // mic grab flips the audio route to the glasses' HFP profile the
            // instant the video stream is spinning up, and the tap-install
            // race crashed the app on the first real device run. The mic is
            // an explicit tap on the card — which is the better privacy
            // posture anyway.
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            stateText = "failed"
            stopStreamOnly()
        }
    }

    func stop() {
        stopTranscription()
        stopStreamOnly()
        running = false
        frame = nil
        transcript = ""
    }

    private func stopStreamOnly() {
        tokens.removeAll()
        stream?.stop()
        stream = nil
        session?.stop()
        session = nil
    }

    // ── Transcript: Apple on-device STT over the glasses' BT mic ──────────
    // One SFSpeech session, restarted on Apple's ~1min cap; the finalized
    // text accumulates in `transcript` so the strip reads continuously.

    private var audioEngine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalized = ""

    func toggleTranscription() {
        if transcribing { stopTranscription() } else { startTranscription() }
    }

    private func startTranscription() {
        Task { [weak self] in
            guard await Self.speechAuthorized(),
                  await AVAudioApplication.requestRecordPermission() else { return }
            self?.beginRecognition()
        }
    }

    private func beginRecognition() {
        guard running, !transcribing else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            // .allowBluetooth is the load-bearing option: with the glasses
            // connected they ARE the phone's BT mic, so this transcribes what
            // the glasses hear, not the phone's own mic.
            try audio.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
            try audio.setActive(true)
        } catch {
            lastError = "mic session: \(error.localizedDescription)"
            return
        }
        recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        // Local STT, never the network, per the product ask — where the
        // locale's on-device model is missing this degrades to unavailable
        // rather than quietly uploading audio.
        req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request = req

        let engine = AVAudioEngine()
        audioEngine = engine
        let input = engine.inputNode
        // ⚠️ CRASH GUARD (c8): while the audio route flips to the glasses'
        // HFP profile, the input format can read 0 Hz / 0 ch for a beat —
        // and installTap with an invalid format throws an UNCATCHABLE ObjC
        // exception. Verify first; a not-ready route becomes a message and
        // a retry-tap, not a crash.
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            audioEngine = nil
            lastError = "The glasses mic isn't ready yet — tap the mic again in a second."
            return
        }
        // ⚠️ CRASH GUARD 2 (c9, crash-log-proven): the tap closure MUST be
        // created in a NONISOLATED context. Born inline here (a @MainActor
        // class), it inherits main-actor isolation, AVFAudio invokes it on
        // the realtime tap queue, and swift_task_checkIsolated SIGTRAPs —
        // dispatch_assert_queue_fail, the exact faulting frame from the
        // user's mic-tap crash. Same trap Voice.swift documents for TCC;
        // same fix: a nonisolated static helper owns the closure.
        Self.installMicTap(on: input, format: format, request: req)
        do { try engine.start() } catch {
            lastError = "mic: \(error.localizedDescription)"
            return
        }
        transcribing = true
        // Method reference to a nonisolated func — SFSpeech fires the handler
        // on its own queue; an inline closure here inherits MainActor and
        // SIGTRAPs exactly like the mic tap did (Voice.swift:248's rule).
        task = recognizer.recognitionTask(with: req, resultHandler: recognitionCallback)
    }

    /// Fires on SFSpeech's own queue — extract Sendables, hop to MainActor.
    private nonisolated func recognitionCallback(result: SFSpeechRecognitionResult?, error: Error?) {
        let text = result?.bestTranscription.formattedString
        let final = result?.isFinal ?? false
        let failed = error != nil
        Task { @MainActor in
            if let text {
                self.transcript = self.finalized.isEmpty ? text : "\(self.finalized) \(text)"
                if final { self.finalized = self.transcript }
            }
            // Apple caps a request at ~1min — roll a fresh session while the
            // HUD is up instead of going silent.
            if failed || final {
                guard self.transcribing else { return }
                self.teardownRecognition()
                self.beginRecognition()
            }
        }
    }

    private func teardownRecognition() {
        transcribing = false
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
    }

    private func stopTranscription() {
        teardownRecognition()
        finalized = ""
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Voice.swift:327's pattern verbatim — the closure is created HERE,
    /// nonisolated, so the audio queue can call it without an actor check.
    /// Internal: GlassesListener (meta_listen) reuses both helpers.
    nonisolated static func installMicTap(on input: AVAudioInputNode, format: AVAudioFormat, request: SFSpeechAudioBufferRecognitionRequest) {
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
    }

    nonisolated static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
        }
    }
}

// MARK: - meta_listen (one-shot)

/// Accumulates the recognizer's text off-main — @unchecked Sendable, every
/// touch behind the lock (the c9 rule's data half).
private final class ListenBox: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func set(_ t: String) { lock.lock(); text = t; lock.unlock() }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

/// 👂 The meta_listen executor: N seconds of the glasses mic (they are the
/// phone's Bluetooth input while connected) → Apple LOCAL STT → transcript
/// posted to the mailbox. Audio never leaves the phone. Every path posts.
@MainActor
final class GlassesListener {
    static let shared = GlassesListener()

    /// The CHAT executor: listen + post to the mailbox the server tool polls.
    func runTool(toolUseId: String, seconds: Int, token: String?) async {
        let payload = await listen(seconds: seconds)
        await postResult(toolUseId, token: token, payload: payload)
    }

    /// The shared core (voice answers over its own WS, not the mailbox).
    func listen(seconds: Int) async -> [String: Any] {
        let clamped = min(max(seconds, 3), 30)
        // The HUD's transcriber already owns the mic? Ride it — two taps on
        // one input node is a fight nobody wins.
        if GlassesLive.shared.running, GlassesLive.shared.transcribing {
            let before = GlassesLive.shared.transcript
            try? await Task.sleep(nanoseconds: UInt64(clamped) * 1_000_000_000)
            let after = GlassesLive.shared.transcript
            let heard = after.hasPrefix(before) ? String(after.dropFirst(before.count)) : after
            return ["ok": true, "transcript": heard.trimmingCharacters(in: .whitespacesAndNewlines)]
        }
        return await listenOnce(seconds: clamped)
    }

    private func listenOnce(seconds: Int) async -> [String: Any] {
        guard await GlassesLive.speechAuthorized(),
              await AVAudioApplication.requestRecordPermission() else {
            return ["ok": false, "error": "microphone/speech permission not granted on the phone"]
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
            try audio.setActive(true)
        } catch {
            return ["ok": false, "error": "mic session: \(error.localizedDescription)"]
        }
        defer { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }

        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable else {
            return ["ok": false, "error": "speech recognition unavailable on this phone"]
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            return ["ok": false, "error": "the glasses mic isn't ready (audio route mid-change) — try again in a second"]
        }
        GlassesLive.installMicTap(on: input, format: format, request: request)
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            return ["ok": false, "error": "mic: \(error.localizedDescription)"]
        }

        let box = ListenBox()
        let task = Self.recognize(recognizer, request: request, into: box)
        try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
        task.cancel()
        request.endAudio()
        engine.stop()
        input.removeTap(onBus: 0)

        let heard = box.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if heard.isEmpty {
            return ["ok": true, "transcript": "", "note": "heard nothing — silence, or the glasses weren't the active mic route"]
        }
        return ["ok": true, "transcript": heard]
    }

    /// c9 rule: the recognizer callback is born HERE, nonisolated.
    private nonisolated static func recognize(_ recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest, into box: ListenBox) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, _ in
            if let text = result?.bestTranscription.formattedString { box.set(text) }
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

/// The floating PiP card: draggable, top-trailing by default, live video +
/// state + transcript strip + mic/close controls.
struct GlassesLiveOverlay: View {
    @Binding var shown: Bool
    @ObservedObject private var live = GlassesLive.shared
    @State private var dragOffset: CGSize = .zero
    @State private var restingOffset: CGSize = .zero

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
                        Image(systemName: "eyeglasses").font(.title2).foregroundStyle(.secondary)
                        Text(live.lastError ?? live.stateText)
                            .font(.caption2).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).padding(.horizontal, 8)
                    }
                }
            }
            .frame(width: 236, height: 177) // glasses stream is 4:3
            .clipped()

            HStack(spacing: 12) {
                Button {
                    live.toggleTranscription()
                } label: {
                    Image(systemName: live.transcribing ? "mic.fill" : "mic.slash")
                        .foregroundStyle(live.transcribing ? .green : .secondary)
                }
                Text(live.transcript.isEmpty
                     ? (live.transcribing ? "listening through the glasses…" : "mic off")
                     : live.transcript)
                    .font(.caption2)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(live.transcript.isEmpty ? .secondary : .primary)
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
        .offset(x: restingOffset.width + dragOffset.width,
                y: restingOffset.height + dragOffset.height)
        .gesture(
            DragGesture()
                .onChanged { dragOffset = $0.translation }
                .onEnded { value in
                    restingOffset.width += value.translation.width
                    restingOffset.height += value.translation.height
                    dragOffset = .zero
                }
        )
        .padding(.top, 8)
        .padding(.trailing, 12)
        .onAppear { live.start() }
        .onDisappear { live.stop() }
    }
}
#endif
