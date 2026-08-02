/**
 * VoiceMode — web voice-mode parity, native edition. The web runs Whisper in
 * a worker with an energy VAD (lib/voice/vad.ts); iOS has the platform
 * equivalent built in: SFSpeechRecognizer (on-device when supported) over an
 * always-open AVAudioEngine tap.
 *
 * Semantics mirror the web exactly:
 *   - mic stays open, transcribing continuously (even while the agent works)
 *   - 3s of transcript silence → the utterance auto-sends to the agent
 *   - the transcript does NOT fill the composer — it shows in a strip and
 *     goes straight out
 *   - barge-in: user speech stops TTS playback (plus .voiceChat AEC keeps
 *     the phone's own voice out of the transcript)
 *
 * Recognition sessions restart after each utterance and on recognizer
 * errors (Apple caps request length ~1min); `pending` carries text across
 * restarts so nothing is lost mid-thought.
 */
import Speech
import AVFoundation

@MainActor
final class VoiceMode: NSObject, ObservableObject {
    static let shared = VoiceMode()

    @Published var active = false
    /// listening | hearing | denied
    @Published var status = "listening"
    /// Live transcript of the utterance in progress
    @Published var partial = ""
    /// Live mic amplitude 0…1 for the voice-strip level meter (web
    /// Chat.tsx:1992 `scaleX(min(1, rms*8))`). Fed from the audio tap on both
    /// recognition paths; 0 when not listening.
    @Published var level: Float = 0

    /// Set at toggle-on; receives each finished utterance
    var onUtterance: ((String) -> Void)?

    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var configObserver: (any NSObjectProtocol)?
    /// iOS 26 SpeechAnalyzer engine (type-erased: stored properties can't be
    /// @available-gated). Non-nil = analyzer mode; nil = SFSpeech fallback.
    private var analyzerEngine: Any?
    /// Text finalized by earlier recognition sessions of this utterance
    private var pending = ""
    /// Current session's partial
    private var current = ""
    private var lastChangeAt = Date()

    override private init() { super.init() }

    /// True from tap until start() resolves — a second tap during the async
    /// permission dance must not spin up a second engine
    private var starting = false

    func toggle(onUtterance: @escaping (String) -> Void) {
        if active { stop() }
        else if !starting { self.onUtterance = onUtterance; Task { await start() } }
    }

    private func start() async {
        starting = true
        defer { starting = false }
        // Reset to a neutral status first: it stays "denied" after a prior
        // denial, so a SECOND tap re-assigning "denied" wouldn't be a value
        // change and the view's .onChange(status) banner wouldn't re-fire (the
        // system permission dialog also won't reappear once denied). Flipping to
        // "listening" here makes any re-denial a real transition the UI catches.
        status = "listening"
        // Closure must be CREATED in a nonisolated context — in Swift 6,
        // @Sendable does NOT strip MainActor inheritance, and TCC invokes
        // the callback on a background queue (dispatch_assert_queue SIGTRAP)
        let speechAuth = await Self.requestSpeechAuth()
        guard speechAuth == .authorized else { status = "denied"; return }
        guard await AVAudioApplication.requestRecordPermission() else { status = "denied"; return }

        // iOS 26+: the SpeechAnalyzer path — the system's large on-device ASR
        // (no ~1min session cap, no roll dance). Only when the locale's model
        // is INSTALLED; shouldUse() otherwise starts the download and this
        // session runs the SFSpeech path below (next session upgrades).
        if #available(iOS 26.0, *), await VoiceAnalyzer.shouldUse() {
            active = true
            status = "listening"
            pending = ""; current = ""; partial = ""
            beginAnalyzerSession()
            watchSilence()
            return
        }

        recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
        guard recognizer?.isAvailable == true else { status = "denied"; return }

        active = true
        status = "listening"
        pending = ""; current = ""; partial = ""
        beginSession()
        watchSilence()
    }

    func stop() {
        active = false
        partial = ""; pending = ""; current = ""; level = 0
        endAnalyzerSession()
        endSession()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ── SpeechAnalyzer session (iOS 26+, no cap → no rolling) ─────────────

    private func beginAnalyzerSession() {
        guard #available(iOS 26.0, *) else { return }
        // Same session config as beginSession: .voiceChat = hardware echo
        // cancellation so the phone's own TTS never becomes the utterance
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            status = "denied"
            stop()
            return
        }

        let va = VoiceAnalyzer()
        analyzerEngine = va
        Task { [weak self] in
            do {
                try await va.start(
                    onPartial: { [weak self] text in self?.analyzerHeard(text, final: false) },
                    onFinal: { [weak self] text in self?.analyzerHeard(text, final: true) },
                    onLevel: { [weak self] lvl in
                        Task { @MainActor in guard let self, self.active else { return }; self.level = lvl }
                    })
            } catch {
                // Analyzer refused (format/asset race) — degrade to the
                // battle-tested SFSpeech path instead of a dead mic.
                guard let self, self.active else { return }
                self.endAnalyzerSession()
                self.recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
                if self.recognizer?.isAvailable == true { self.beginSession() }
                else { self.status = "denied"; self.stop() }
            }
        }
    }

    private func endAnalyzerSession() {
        guard #available(iOS 26.0, *), let va = analyzerEngine as? VoiceAnalyzer else {
            analyzerEngine = nil
            return
        }
        va.stop()
        analyzerEngine = nil
    }

    /// Analyzer results → the same transcript state the SFSpeech path feeds:
    /// volatile hypotheses replace `current`; finalized text accumulates into
    /// `pending` (combined() = what the silence watcher will send).
    private func analyzerHeard(_ text: String, final: Bool) {
        guard active else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if final {
            guard !trimmed.isEmpty else { return }
            pending = pending.isEmpty ? trimmed : "\(pending) \(trimmed)"
            current = ""
        } else {
            guard trimmed != current else { return }
            current = trimmed
        }
        partial = combined()
        lastChangeAt = Date()
        status = "hearing"
        Speech.shared.stop() // barge-in
    }

    // ── Recognition session (restartable) ─────────────────────────────────

    private func beginSession() {
        // .voiceChat = hardware echo cancellation — the phone's own TTS
        // must not become the next utterance
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            // Session activation failed (interruption, phone call, etc.) —
            // proceeding would crash on installTap with a 0Hz format
            status = "denied"
            stop()
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true {
            req.requiresOnDeviceRecognition = true // web parity: audio stays on the phone
        }
        // What the silence watcher hands to `onUtterance` is not a preview — every
        // caller of `toggle(onUtterance:)` does `chat.send(text, token:)`, so this
        // text is a message the agent reads (NiclaRecorder states the same reason
        // for a wake take). This is also the FALLBACK rail for beginAnalyzerSession, and
        // two rails feeding one `chat.send` should not format differently.
        // Partials and punctuation coexist fine — TinyLive's live transcriber sets
        // both on one request.
        req.addsPunctuation = true
        request = req

        // Fresh engine per session — reusing one across stop/start cycles
        // leaves the input node in a state where installTap throws an
        // uncatchable NSException (the original mic-tap crash)
        let eng = AVAudioEngine()
        engine = eng
        let input = eng.inputNode
        // Real echo cancellation (same fix as VoiceCall.startAudio): the
        // .voiceChat session mode alone doesn't echo-cancel the raw input
        // node — without the VPIO unit the phone's own TTS becomes the next
        // utterance. Must precede the format read; try? degrades gracefully.
        if !input.isVoiceProcessingEnabled {
            try? input.setVoiceProcessingEnabled(true)
        }
        let format = input.outputFormat(forBus: 0)
        // installTap CRASHES (ObjC exception, not Swift-catchable) on an
        // invalid format — happens when the session isn't live yet
        guard format.sampleRate > 0, format.channelCount > 0 else {
            status = "denied"
            stop()
            return
        }
        Self.installTap(on: input, format: format, request: req) { [weak self] lvl in
            Task { @MainActor in guard let self, self.active else { return }; self.level = lvl }
        }
        eng.prepare()
        do {
            try eng.start()
        } catch {
            input.removeTap(onBus: 0)
            status = "denied"
            stop()
            return
        }
        current = ""
        lastChangeAt = Date()

        // VPIO settles ASYNCHRONOUSLY after start — the engine reconfigures,
        // the input format swaps, and a tap installed at the old format
        // silently never fires again (proven live on the VoiceCall engine).
        // Re-tap at the current format and restart. Route changes land here too.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.retap() }
        }

        // Method reference to a nonisolated func — the only Swift 6-safe way
        // to hand SFSpeech a callback it may fire on any queue
        task = recognizer?.recognitionTask(with: req, resultHandler: recognitionCallback)
    }

    /// Reinstall the mic tap after an engine configuration change (SFSpeech
    /// path only — the analyzer path owns its own engine and observer).
    private func retap() {
        guard active, analyzerEngine == nil, let eng = engine, let req = request else { return }
        let input = eng.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return }
        Self.installTap(on: input, format: format, request: req) { [weak self] lvl in
            Task { @MainActor in guard let self, self.active else { return }; self.level = lvl }
        }
        if !eng.isRunning {
            eng.prepare()
            try? eng.start()
        }
    }

    private func combined() -> String {
        (pending.isEmpty ? current : "\(pending) \(current)").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Restart recognition, carrying accumulated text into `pending`.
    /// Debounced: recognizer errors can arrive in bursts — restarting in a
    /// tight loop starves the audio session and hard-locks the app.
    private var lastRollAt = Date.distantPast
    private func rollSession() {
        guard active else { return }
        // Analyzer mode: restart the analyzer instead (fresh transcriber —
        // it must forget the utterance that just auto-sent). Never fall
        // through to beginSession(): two engines, one mic, no survivors.
        if analyzerEngine != nil {
            endAnalyzerSession()
            beginAnalyzerSession()
            return
        }
        let now = Date()
        if now.timeIntervalSince(lastRollAt) < 0.5 {
            // Too soon — schedule one deferred roll instead of thrashing
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(600))
                guard let self, self.active else { return }
                if Date().timeIntervalSince(self.lastRollAt) >= 0.5 { self.rollSession() }
            }
            return
        }
        lastRollAt = now
        pending = combined()
        endSession()
        beginSession()
    }

    private func endSession() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if let eng = engine {
            eng.inputNode.removeTap(onBus: 0)
            eng.stop()
        }
        engine = nil
    }

    // ── Nonisolated bridge layer ──────────────────────────────────────────
    // Closures created inside nonisolated members carry NO actor isolation,
    // so system frameworks may invoke them on any queue without tripping
    // Swift 6's dispatch_assert_queue runtime check.

    private nonisolated static func requestSpeechAuth() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
    }

    private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat, request: SFSpeechAudioBufferRecognitionRequest, onLevel: @escaping @Sendable (Float) -> Void) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
            onLevel(VoiceMode.rms(of: buffer))
        }
    }

    /// RMS amplitude of a PCM buffer, mapped to 0…1 the same way the web meter
    /// does (`min(1, rms*8)`, realtime.ts:146 / Chat.tsx:1992). Reads the
    /// float channel; silently returns 0 for a non-float or empty buffer.
    nonisolated static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        let samples = channel[0]
        var sum: Float = 0
        for i in 0..<n { let s = samples[i]; sum += s * s }
        let rms = (sum / Float(n)).squareRoot()
        return min(1, rms * 8)
    }

    /// Fires on SFSpeech's own queue — extract Sendables, hop to MainActor
    private nonisolated func recognitionCallback(result: SFSpeechRecognitionResult?, error: Error?) {
        let text = result?.bestTranscription.formattedString
        let final = result?.isFinal ?? false
        let failed = error != nil
        Task { @MainActor in
            guard self.active else { return }
            if let text, text != self.current {
                self.current = text
                self.partial = self.combined()
                self.lastChangeAt = Date()
                self.status = "hearing"
                Speech.shared.stop() // barge-in
            }
            if final || failed { self.rollSession() } // cap/error — keep listening
        }
    }

    // ── 3s-silence auto-send (web DEFAULT_VAD_CONFIG.utteranceSilenceMs) ───

    private func watchSilence() {
        Task { [weak self] in
            while let self, self.active {
                try? await Task.sleep(for: .milliseconds(400))
                guard self.active else { break }
                let text = self.combined()
                if !text.isEmpty, Date().timeIntervalSince(self.lastChangeAt) >= 3.0 {
                    self.pending = ""; self.current = ""; self.partial = ""
                    self.status = "listening"
                    self.onUtterance?(text)
                    self.rollSession() // fresh request → recognizer forgets the sent text
                }
            }
        }
    }
}
