/**
 * VoiceCall — native speech-to-speech with a tiny (docs/voice-sessions-design.md),
 * the iOS twin of lib/voice/realtime.ts.
 *
 * Talks to the worker's VoiceSession Durable Object over a single WebSocket:
 *   - up:   mic PCM16 @ 24 kHz mono as binary frames (the DO does
 *           input_audio_buffer.append server-side; we send raw bytes)
 *   - down: assistant audio as binary PCM16 frames → scheduled gaplessly on an
 *           AVAudioPlayerNode; JSON control frames (transcripts, barge_in, error)
 *
 * The DO owns semantic VAD, tool routing, and journaling — the phone stays
 * dumb: capture, send, play, render transcript. Barge-in = flush local
 * playback the moment the server says the user started talking.
 *
 * v1 is BYO-OpenAI-key ONLY: POST /api/voice/session carries OpenAI-only
 * x-tiny-model-* headers from ModelConfigStore.voiceHeaders() — the dedicated
 * voice key (or the chat key iff chat is OpenAI), never a Bedrock/Anthropic chat
 * key; a 402 code:byok_required surfaces "add an OpenAI key" rather than a dead error.
 *
 * Concurrency: the audio tap fires on the render thread, so it can't touch
 * MainActor state. It yields Sendable MicFrames into an AsyncStream (the
 * VoiceAnalyzer idiom); a MainActor pump drains them onto the WebSocket.
 */
import Foundation
import AVFoundation
import MediaPlayer
import SwiftUI

/// One captured mic chunk: 24 kHz PCM16 bytes + a cheap RMS level for the meter.
private struct MicFrame: Sendable {
    let pcm: Data
    let level: Double
}

@MainActor
final class VoiceCall: NSObject, ObservableObject {
    enum Status: Equatable { case idle, connecting, live, ended, error }

    @Published var status: Status = .idle
    @Published var userTranscript = ""
    @Published var assistantTranscript = ""
    @Published var level: Double = 0        // mic input 0…1 for the orb
    @Published var errorText: String?
    @Published var byokRequired = false     // 402 → show the "add a key" prompt

    // ── Inline-chat integration (the call lives INSIDE ChatView) ────────────
    // ChatView wires these so transcription lands in the chat thread as real
    // messages and tool calls run on the device's existing executors. All
    // invoked on the MainActor from handleControl.
    var onUserTranscript: ((String) -> Void)?
    var onAssistantDelta: ((String) -> Void)?
    var onResponseStarted: (() -> Void)?
    var onResponseDone: (() -> Void)?
    var onBargeIn: (() -> Void)?
    /// (callId, toolName, args) — reply via sendToolResult(id:output:).
    var onToolCall: ((String, String, [String: Any]) -> Void)?
    /// Called by `stop()`: the call is over, so any device tool still waiting on
    /// the USER (the screenshot consent alert) has to be called off — its answer
    /// has nowhere to go now that the WS is closed, and a prompt left on screen
    /// is one an Allow would still act on. Lives on `stop()` rather than on its
    /// callers because there are four of them (End, hangup, tiny switch,
    /// onDisappear) and a missed one is a silent capture.
    var onEnded: (() -> Void)?

    private let sampleRate = 24_000.0
    private var ws: URLSessionWebSocketTask?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var micPump: Task<Void, Never>?
    /// Kept so the tap can be re-installed on an engine reconfigure (VPIO
    /// swaps the input format asynchronously right after start).
    private var micBuilder: AsyncStream<MicFrame>.Continuation?
    private var configObserver: (any NSObjectProtocol)?
    /// Float32 24 kHz mono — the format the player node renders.
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Start a call: ask the app for a session, open the WS, wire mic + playback.
    /// `context` is the client-built continuity block (memories + recent turns)
    /// so the voice agent starts knowing what the chat agent knows.
    func start(tiny: String, token: String?, context: String? = nil) {
        guard status == .idle || status == .ended || status == .error else { return }
        errorText = nil; byokRequired = false
        userTranscript = ""; assistantTranscript = ""
        status = .connecting
        Task {
            // 1. Mint the session (BYO-key gate lives server-side).
            let result = await Self.createSession(tiny: tiny, token: token, context: context)
            guard status == .connecting else { return } // hung up mid-connect
            switch result {
            case .byok:
                byokRequired = true
                errorText = "Voice needs your own OpenAI API key. Add one in Settings → Model, then call again."
                status = .error
                return
            case .failure(let msg):
                errorText = msg
                status = .error
                return
            case .success(let wsUrl):
                do {
                    try startAudio()
                } catch {
                    errorText = "Couldn't open the microphone. Check permission in Settings."
                    status = .error
                    stop()
                    return
                }
                connect(wsUrl)
            }
        }
    }

    #if DEBUG
    /// 📞 Screenshot harness (`--voice-call-harness`, DEBUG builds only): put the
    /// in-call strip into its LIVE state without a call.
    ///
    /// Why this exists rather than just placing a real call for the capture: a real
    /// call mints a session against the user's own OpenAI key (v1 is BYO-key), and
    /// its transcripts land in the user's actual chat thread as persisted messages.
    /// Spending someone's key and writing to their history to produce a store asset
    /// is the "never mutate the user's account for an asset" rule exactly.
    ///
    /// It is also HONEST, which a mock screen would not be: `callStrip` renders from
    /// nothing but `status` and `level`, so the pixels here are the shipping view at
    /// the shipping code path — same copy ("In call with … — recorded; type or talk"),
    /// same pulsing phone glyph, same 44×3 accent meter, same red End button. Nothing
    /// is drawn that a real call wouldn't draw.
    ///
    /// No WebSocket, no AVAudioEngine, no mic permission, no network at all — so it
    /// cannot half-open a session and leave a DO hanging.
    func startHarnessCall(level: Double = 0.62) {
        status = .live
        self.level = level
    }
    #endif

    func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        micBuilder?.finish(); micBuilder = nil
        micPump?.cancel(); micPump = nil
        if let ws { ws.cancel(with: .goingAway, reason: nil) }
        ws = nil
        player?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        player = nil; engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        level = 0
        if status != .error { status = .ended }
        // Last, after the WS is definitively down: nothing the user taps now can
        // reach the model, so stop asking them.
        onEnded?()
    }

    // ── Session mint (POST /api/voice/session) ────────────────────────────────

    private enum SessionResult { case success(URL), byok, failure(String) }

    /// nonisolated so the network call runs off the MainActor; returns a plain
    /// Sendable result. Reads the 402 body to distinguish "add a key" from a
    /// generic failure (Api.post would throw the body away).
    private static func createSession(tiny: String, token: String?, context: String? = nil) async -> SessionResult {
        var req = URLRequest(url: URL(string: Config.serverBase + "/api/voice/session")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Announce the native client (same header as Api.chat): the route keys
        // the voice TOOL ROSTER on this — without it the session gets the WEB
        // render_ui contract and loses screenshot/generate_image, tools this
        // device implements in runVoiceTool.
        req.setValue("tiny-ios", forHTTPHeaderField: "x-tiny-session")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // Voice is OpenAI-only — send the dedicated voice key (or the chat key iff
        // chat is itself on OpenAI), NEVER a Bedrock/Anthropic chat key.
        for (field, value) in ModelConfigStore.voiceHeaders() { req.setValue(value, forHTTPHeaderField: field) }
        var body: [String: Any] = ["tiny": tiny]
        if let context, !context.isEmpty { body["context"] = context }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 15

        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else {
            // Status 0 is the house code for "nothing answered" — and line 183
            // already asks the table, so writing the sentence here made this the
            // one copy free to drift (it had a period the table's line doesn't).
            return .failure(Api.friendlyHTTPError(0))
        }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if http.statusCode == 402 || (obj?["code"] as? String) == "byok_required" {
            return .byok
        }
        guard http.statusCode == 200,
              let urlStr = obj?["wsUrl"] as? String, let url = URL(string: urlStr) else {
            return .failure((obj?["error"] as? String) ?? Api.friendlyHTTPError(http.statusCode))
        }
        return .success(url)
    }

    // ── Audio engine (capture + playback share one engine, .voiceChat AEC) ─────

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        // .voiceChat = hardware echo cancellation so the tiny's own audio never
        // feeds back into the mic (which the server's VAD is listening to).
        try session.setCategory(.playAndRecord, mode: .voiceChat,
                                options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let eng = AVAudioEngine()
        engine = eng
        let input = eng.inputNode
        // The .voiceChat session mode alone does NOT echo-cancel AVAudioEngine's
        // raw input node — Apple's echo canceller only engages when the
        // voice-processing I/O unit is inserted on the node itself. Without it
        // the speaker output re-enters the mic, the server VAD hears the tiny
        // "speak", and barge-in cancels its own response (self-stopping loop).
        // Enabling on the input node also enables the paired output node, which
        // is what feeds the canceller its reference signal. Must happen BEFORE
        // reading the input format (voice processing changes it) and before the
        // engine starts. try? — if a device refuses, degrade to echo-prone
        // rather than failing the whole call.
        if !input.isVoiceProcessingEnabled {
            try? input.setVoiceProcessingEnabled(true)
        }
        let micFormat = input.outputFormat(forBus: 0)
        guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else {
            throw NSError(domain: "VoiceCall", code: 1)
        }

        // Playback graph: player → main mixer → output, at 24 kHz float.
        let node = AVAudioPlayerNode()
        player = node
        eng.attach(node)
        eng.connect(node, to: eng.mainMixerNode, format: playFormat)

        // Target upload format: 24 kHz PCM16 mono, matching the model's wire rate.
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: sampleRate, channels: 1, interleaved: true) else {
            throw NSError(domain: "VoiceCall", code: 2)
        }

        // Mic frames flow off the render thread through an AsyncStream; a
        // MainActor pump drains them onto the WebSocket + updates the meter.
        let (stream, builder) = AsyncStream<MicFrame>.makeStream()
        micBuilder = builder
        Self.installTap(on: input, micFormat: micFormat, targetFormat: targetFormat, builder: builder)
        micPump = Task { [weak self] in
            for await frame in stream {
                guard let self else { break }
                self.level = frame.level
                self.ws?.send(.data(frame.pcm)) { _ in }
            }
        }

        eng.prepare()
        try eng.start()
        node.play()

        // VPIO reconfigures the graph ASYNCHRONOUSLY right after start (the
        // input format swaps once the voice-processing unit settles) — the
        // engine stops and posts this notification, and a tap installed at
        // the OLD format silently never fires again (dead meter, mute mic
        // upstream, no error anywhere). Route changes (AirPods in/out) land
        // here too. Re-tap at the node's CURRENT format and restart.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.retap() }
        }
    }

    /// Reinstall the mic tap at the input node's current format and restart
    /// the engine after a configuration change (VPIO settle / route change).
    private func retap() {
        guard status == .live || status == .connecting,
              let eng = engine, let builder = micBuilder else { return }
        let input = eng.inputNode
        input.removeTap(onBus: 0)
        let micFormat = input.outputFormat(forBus: 0)
        guard micFormat.sampleRate > 0, micFormat.channelCount > 0,
              let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: sampleRate, channels: 1, interleaved: true) else { return }
        Self.installTap(on: input, micFormat: micFormat, targetFormat: targetFormat, builder: builder)
        if !eng.isRunning {
            eng.prepare()
            try? eng.start()
            player?.play()
        }
    }

    /// Created in a nonisolated context so the render thread may invoke it
    /// freely (Swift 6: @Sendable does NOT strip MainActor). One converter for
    /// the whole session — formats are fixed at tap time.
    private nonisolated static func installTap(on input: AVAudioInputNode,
                                               micFormat: AVAudioFormat,
                                               targetFormat: AVAudioFormat,
                                               builder: AsyncStream<MicFrame>.Continuation) {
        let converter = AVAudioConverter(from: micFormat, to: targetFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
            let level = rms(of: buffer)
            guard let converter,
                  let pcm = convertToPCM16(buffer, with: converter, to: targetFormat) else { return }
            builder.yield(MicFrame(pcm: pcm, level: level))
        }
    }

    private nonisolated static func rms(of buffer: AVAudioPCMBuffer) -> Double {
        guard let ch = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        var sum: Double = 0
        for i in 0..<n { let s = Double(ch[0][i]); sum += s * s }
        return min(1, (sum / Double(n)).squareRoot() * 4)
    }

    private nonisolated static func convertToPCM16(_ buffer: AVAudioPCMBuffer,
                                                   with converter: AVAudioConverter,
                                                   to format: AVAudioFormat) -> Data? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var served = false
        var convertError: NSError?
        converter.convert(to: out, error: &convertError) { _, status in
            if served { status.pointee = .noDataNow; return nil }
            served = true
            status.pointee = .haveData
            return buffer
        }
        guard convertError == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return nil }
        return Data(bytes: ch[0], count: Int(out.frameLength) * 2)
    }

    // ── WebSocket ──────────────────────────────────────────────────────────

    private func connect(_ url: URL) {
        let task = URLSession.shared.webSocketTask(with: url)
        ws = task
        task.resume()
        status = .live
        receive()
    }

    private func receive() {
        ws?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.status == .live else { return }
                switch result {
                case .failure:
                    if self.status == .live { self.status = .ended }
                    self.stop()
                case .success(let message):
                    switch message {
                    case .data(let data): self.playAudio(data)
                    case .string(let text): self.handleControl(text)
                    @unknown default: break
                    }
                    self.receive() // pump the next frame
                }
            }
        }
    }

    private func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "user_transcript":
            userTranscript = (obj["text"] as? String) ?? userTranscript
            if let t = obj["text"] as? String { onUserTranscript?(t) }
        case "response_started":
            // A fresh assistant turn began — clear the previous turn's text so
            // back-to-back replies (e.g. either side of a tool call, with no
            // user turn between) don't concatenate into one run-on line.
            assistantTranscript = ""
            onResponseStarted?()
        case "assistant_transcript":
            let delta = (obj["delta"] as? String) ?? ""
            assistantTranscript += delta
            if !delta.isEmpty { onAssistantDelta?(delta) }
        case "response_done":
            onResponseDone?() // ChatView finalizes the thread message + saves
        case "barge_in":
            flushPlayback()
            assistantTranscript = "" // the tiny got cut off; start its next turn fresh
            onBargeIn?()
        case "tool_call":
            // The model called a tool — the chat surface executes it with the
            // SAME device executors chat uses and replies sendToolResult.
            if let id = obj["id"] as? String, let name = obj["name"] as? String {
                onToolCall?(id, name, (obj["args"] as? [String: Any]) ?? [:])
            }
        case "error":
            errorText = (obj["error"] as? String) ?? "error"
        default: break
        }
    }

    // ── Inline-chat control frames (composer + tool bridge) ─────────────────

    /// A message TYPED in the composer mid-call joins the live conversation —
    /// the tiny hears it and answers in voice. Caller renders its own copy.
    func sendUserText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard status == .live, !t.isEmpty else { return }
        sendControl(["type": "user_text", "text": t])
    }

    /// Return a device-tool result to the model (answers an onToolCall).
    func sendToolResult(id: String, output: [String: Any]) {
        sendControl(["type": "tool_result", "id": id, "output": output])
    }

    /// Dismiss a dead call strip (error/BYOK) back to idle so the phone
    /// button offers a fresh call.
    func dismiss() {
        stop()
        status = .idle
        errorText = nil
        byokRequired = false
    }

    private func sendControl(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        ws?.send(.string(s)) { _ in }
    }

    // ── Playback ─────────────────────────────────────────────────────────────

    private func playAudio(_ data: Data) {
        guard let player, data.count >= 2 else { return }
        let count = data.count / 2
        guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(count)) else { return }
        buf.frameLength = AVAudioFrameCount(count)
        let dst = buf.floatChannelData![0]
        data.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<count { dst[i] = Float(src[i]) / 32768.0 }
        }
        player.scheduleBuffer(buf, completionHandler: nil)
        if !player.isPlaying { player.play() }
    }

    /// Barge-in: drop everything queued and reset the player for the next turn.
    private func flushPlayback() {
        player?.stop()
        player?.play()
    }
}

// ── Call surface ─────────────────────────────────────────────────────────────

/// Full-screen call view: a breathing orb that pulses with the mic level, the
/// live transcript, and an always-record banner (recording is the v1 default).
struct VoiceCallView: View {
    let tiny: String
    let accent: Color
    @ObservedObject var call: VoiceCall
    @EnvironmentObject private var session: TinySession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 28) {
                Spacer()

                Text(tiny)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                Text(statusLine)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
                    .monospaced()

                orb

                // Live transcript — what you said, what the tiny is saying.
                VStack(spacing: 10) {
                    if !call.userTranscript.isEmpty {
                        Text(call.userTranscript)
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.55))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if !call.assistantTranscript.isEmpty {
                        Text(call.assistantTranscript)
                            .font(.title3)
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 28)
                .frame(minHeight: 90, alignment: .top)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: call.assistantTranscript)

                if let err = call.errorText {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                    if call.byokRequired {
                        Button("Open model settings") {
                            if let u = URL(string: "\(Config.serverBase)/settings") { openURL(u) }
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(accent)
                    }
                }

                Spacer()

                // Always-record banner — recording is the v1 default (locked).
                Label("This call is recorded", systemImage: "record.circle")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.4))

                // Hang up.
                Button {
                    call.stop()
                    dismiss()
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(.white)
                        .frame(width: 66, height: 66)
                        .background(Color.red, in: Circle())
                }
                .accessibilityLabel("End call")
                .padding(.bottom, 24)
            }
        }
        .onAppear { call.start(tiny: tiny, token: session.token) }
        .onDisappear { call.stop() }
        .interactiveDismissDisabled(call.status == .live)
    }

    private var statusLine: String {
        switch call.status {
        case .idle, .connecting: return "connecting…"
        case .live: return "live"
        case .ended: return "call ended"
        case .error: return "couldn't connect"
        }
    }

    private var orb: some View {
        let scale = call.status == .live ? 1 + call.level * 0.5 : 1
        return Circle()
            .fill(
                RadialGradient(colors: [accent.opacity(0.9), accent.opacity(0.25)],
                               center: .center, startRadius: 8, endRadius: 90)
            )
            .frame(width: 150, height: 150)
            .scaleEffect(reduceMotion ? 1 : scale)
            .overlay(
                Image(systemName: call.status == .live ? "waveform" : "phone.arrow.up.right")
                    .font(.system(size: 34))
                    .foregroundStyle(.white)
            )
            .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: call.level)
            .shadow(color: accent.opacity(0.5), radius: 30)
    }
}

// ── Call recordings — past calls, replayable like podcast episodes ───────────

/// One row of GET /api/voice/sessions (worker VOICE_LIST_SQL columns).
struct CallSession: Identifiable, Decodable {
    let id: String
    let tiny_name: String?
    let status: String?
    let started_at: Double?
    let duration_ms: Double?
    let segment_count: Int?
}

/// 🔴 The body of GET /api/voice/sessions — `ok` included, and that is the fix.
///
/// The route answers exactly three ways: `200 {ok:true, sessions:[…]}`,
/// `401 {ok:false, error:"login required"}`, and `502 {ok:false, error:…}` when
/// the worker is unreachable or answers an error. This struct used to be
/// `{ let sessions: [CallSession]? }` — and an absent key satisfies an optional
/// property, so **both refusal bodies decoded successfully** with `sessions ==
/// nil`. The screen then read `[]` and drew "No calls yet": a confident
/// statement about the user's own recordings, made by a screen that never got an
/// answer. An expired session looked like a deleted archive.
///
/// `ok` is required, so a body that isn't the documented success shape can only
/// throw. (The status is caught upstream now — `Api.getData` throws on any
/// non-2xx — and this gate is the other half: an intermediary between the app
/// and the worker is exactly what pairs a 200 with a body that says otherwise.)
struct CallSessionsBody: Decodable {
    let ok: Bool
    let sessions: [CallSession]?
}

/// Every finished call streams as ONE stitched WAV from the worker
/// (/voice/recording/:id — built on first listen, then R2-cached). The list
/// is session-authed; playback URLs are the same public-but-unguessable
/// posture the replay assets already use. Playback is .playback deliberately:
/// tapping an episode is an explicit listen, podcast semantics — unlike the
/// onboarding narrator's LOCKED .ambient autoplay rule.
struct CallRecordingsView: View {
    @EnvironmentObject private var session: TinySession
    @Environment(\.dismiss) private var dismiss
    @State private var sessions: [CallSession] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var playingId: String?
    @State private var player: AVPlayer?
    // Podcast transport: elapsed/total for the playing row's scrubber, fed by
    // a periodic time observer; `scrubbing` parks observer updates so the
    // thumb doesn't fight the user's finger mid-drag.
    @State private var elapsed: Double = 0
    @State private var total: Double = 0
    @State private var scrubbing = false
    @State private var timeObserver: Any?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorText {
                    // The house failure state (Activity, Jobs, Memory, the graph,
                    // My Devices): the reason, and something to do about it. Grey
                    // body text with no control was a dead end — and the caption
                    // now ends in "try again" often enough that not offering the
                    // button was a promise the screen didn't keep. The glyph is
                    // this screen's own subject crossed out, NOT a cause: a
                    // wifi.slash over "Session expired" blames the wrong thing.
                    ContentUnavailableView {
                        Label("Couldn't load calls", systemImage: "waveform.slash")
                    } description: {
                        Text(errorText)
                    } actions: {
                        Button("Retry") { loading = true; Task { await load() } }
                    }
                } else if sessions.isEmpty {
                    ContentUnavailableView("No calls yet", systemImage: "phone.arrow.up.right",
                                           description: Text("Finished voice calls appear here — replay them like podcast episodes."))
                } else {
                    List(sessions) { s in row(s) }
                        .listStyle(.plain)
                }
            }
            .navigationTitle("Call recordings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
        .onDisappear {
            if let timeObserver { player?.removeTimeObserver(timeObserver) }
            timeObserver = nil
            player?.pause()
            player = nil
            playingId = nil
            clearNowPlaying()
        }
    }

    private func row(_ s: CallSession) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                Button {
                    toggle(s)
                } label: {
                    Image(systemName: playingId == s.id ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.green)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playingId == s.id ? "Pause call with \(s.tiny_name ?? "tiny")" : "Play call with \(s.tiny_name ?? "tiny")")
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.tiny_name ?? "tiny")
                        .font(.subheadline.weight(.semibold))
                    HStack(spacing: 6) {
                        if let t = s.started_at {
                            Text(Date(timeIntervalSince1970: t), format: .dateTime.month().day().hour().minute())
                        }
                        if let d = s.duration_ms, d > 0 {
                            Text("· \(Int(d / 60000)):\(String(format: "%02d", Int(d / 1000) % 60))")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                // Share the episode — the same public-but-unguessable WAV URL
                // the player streams (recipients need no account, like /media).
                if let shareURL = URL(string: "https://plugin.tiny.technology/voice/recording/\(s.id)") {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Share call with \(s.tiny_name ?? "tiny")")
                }
            }
            // Transport for the playing episode — scrub anywhere in the call.
            if playingId == s.id, total > 0 {
                HStack(spacing: 8) {
                    Text(clock(elapsed))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Slider(value: $elapsed, in: 0...total) { editing in
                        scrubbing = editing
                        if !editing {
                            player?.seek(to: CMTime(seconds: elapsed, preferredTimescale: 600))
                        }
                    }
                    .tint(.green)
                    .accessibilityLabel("Playback position")
                    Text(clock(total))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func clock(_ t: Double) -> String {
        "\(Int(t) / 60):\(String(format: "%02d", Int(t) % 60))"
    }

    private func toggle(_ s: CallSession) {
        if playingId == s.id {
            player?.pause()
            playingId = nil
            clearNowPlaying()
            return
        }
        guard let url = URL(string: "https://plugin.tiny.technology/voice/recording/\(s.id)") else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        if let timeObserver { player?.removeTimeObserver(timeObserver); self.timeObserver = nil }
        player?.pause()
        let p = AVPlayer(url: url)
        player = p
        elapsed = 0
        total = (s.duration_ms ?? 0) / 1000
        // Half-second transport ticks — skipped mid-scrub so the thumb stays
        // under the finger; duration refines once the asset loads (stitched
        // WAV can outrun duration_ms when the tiny talked past the hangup).
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
                                                 queue: .main) { t in
            Task { @MainActor in
                guard !scrubbing else { return }
                elapsed = t.seconds
                if let d = p.currentItem?.duration.seconds, d.isFinite, d > 0 { total = d }
                updateNowPlaying(s)
            }
        }
        p.play()
        playingId = s.id
        installRemoteCommands()
        updateNowPlaying(s)
    }

    // ── Lock-screen / control-center transport (podcast semantics) ─────────
    // The app already runs the `audio` background mode for live calls, so a
    // playing recording continues when the phone locks — these commands make
    // it CONTROLLABLE there instead of a mystery sound.

    private func installRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.removeTarget(nil); c.pauseCommand.removeTarget(nil)
        c.changePlaybackPositionCommand.removeTarget(nil)
        // Handlers hop to the MainActor — the command center invokes them on
        // its own queue, and player/elapsed are view (MainActor) state.
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

    private func updateNowPlaying(_ s: CallSession) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: s.tiny_name ?? "tiny",
            MPMediaItemPropertyArtist: "tiny call recording",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0,
        ]
        if total > 0 { info[MPMediaItemPropertyPlaybackDuration] = total }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// The rows a response body yields — or a throw the caption can name.
    ///
    /// Separated from `load` so every answer this route can give is checkable
    /// without a network: the whole defect was that two of the three decoded
    /// into an empty list instead of an error.
    static func rows(from data: Data) throws -> [CallSession] {
        let body = try JSONDecoder().decode(CallSessionsBody.self, from: data)
        guard body.ok, let list = body.sessions else { throw ApiError.badResponse }
        // Only finished calls stitch (live ones 409); hide sub-2s pocket dials
        // and zero-segment rows (no audio ever journaled — e.g. calls that
        // died in an upstream outage; their stitch 404s, the row is dead).
        return list.filter {
            ($0.status == "ended" || $0.status == "error")
                && ($0.duration_ms ?? 0) > 2000
                && ($0.segment_count ?? 0) > 0
        }
    }

    private func load() async {
        defer { loading = false }
        guard let token = session.token else {
            errorText = "Sign in to see your call recordings."
            return
        }
        // ⚠️ `Api.getData`, not a bare `URLSession`: reaching past the house
        // client is what threw the status away, and a screen with no status can
        // only guess at a cause. `LoadFailure` reads the thrown error; it names
        // ONE reason, from the same table the rest of the app uses.
        do {
            sessions = try Self.rows(from: try await Api.getData("/api/voice/sessions", token: token))
            errorText = nil
        } catch {
            errorText = LoadFailure.message(error)
        }
    }
}

// ── Per-tiny call-voice picker (owner-only) ────────────────────────────────────

/// The OpenAI Realtime voices a tiny can speak with on a live call. Mirrors the
/// worker allowlist (upsert.ts normalizeVoice); `marin` is the server default.
private let kRealtimeVoices = ["alloy", "ash", "ballad", "coral", "echo",
                               "sage", "shimmer", "verse", "marin", "cedar"]

/// Owner-only sheet to set the tiny's live-call voice. This is a PER-TINY
/// SERVER field (docs/voice-sessions-design.md, locked design) — everyone who
/// calls this tiny hears the chosen voice, not a per-device override. Writes
/// via ChatModel.saveVoice → /api/control (worker /upsert), owner-gated.
struct VoicePickerSheet: View {
    @ObservedObject var chat: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?

    /// The active selection, defaulting to the server default when unset.
    private var current: String { chat.voice.isEmpty ? "marin" : chat.voice }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(kRealtimeVoices, id: \.self) { v in
                        Button {
                            Task { await pick(v) }
                        } label: {
                            HStack {
                                Text(v.capitalized)
                                    .foregroundStyle(.primary)
                                if v == "marin" {
                                    Text("default")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if v == current {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(chat.accent)
                                }
                            }
                        }
                        .disabled(saving)
                    }
                } header: {
                    Text("Call voice")
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("The voice \(chat.tiny) speaks with on a live call (📞). This is set on the tiny itself — everyone who calls \(chat.tiny) hears it. The on-device \"Spoken replies\" voice in Settings is separate.")
                    }
                }
            }
            .navigationTitle("Call voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if saving { ProgressView() } else { Button("Done") { dismiss() } }
                }
            }
        }
    }

    private func pick(_ v: String) async {
        guard !saving, v != current else { return }
        saving = true; error = nil
        let ok = await chat.saveVoice(v)
        saving = false
        if !ok { error = "Couldn't save — try again." }
    }
}
