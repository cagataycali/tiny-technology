/**
 * VoiceAnalyzer — the iOS 26 SpeechAnalyzer/SpeechTranscriber engine behind
 * VoiceMode (docs/on-device-genai-research-2026-07.md). Apple's new large
 * ASR (the same model behind system dictation/Voice Memos) transcribes
 * fully on-device with no ~1-minute session cap, so the SFSpeechRecognizer
 * roll-the-session dance disappears on this path. VoiceMode still owns the
 * UX (silence watcher, barge-in, auto-send); this class owns mic → format
 * conversion → analyzer → volatile/final results.
 *
 * Model assets are system-managed (AssetInventory): shouldUse() only says
 * yes when the locale's model is ALREADY installed — otherwise it kicks off
 * the download in the background and this session gracefully runs the old
 * SFSpeechRecognizer path. Next voice-mode session picks up the new engine.
 */
import Speech
import AVFoundation

@available(iOS 26.0, *)
@MainActor
final class VoiceAnalyzer {
    private var engine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var configObserver: (any NSObjectProtocol)?

    // ── Availability ───────────────────────────────────────────────────────

    /// Best supported locale for the user: exact BCP-47 match, else same
    /// language (en-TR device still transcribes with the en-US model).
    static func bestSupportedLocale() async -> Locale? {
        let current = Locale.current
        let supported = await SpeechTranscriber.supportedLocales
        if let exact = supported.first(where: { $0.identifier(.bcp47) == current.identifier(.bcp47) }) {
            return exact
        }
        let lang = current.language.languageCode?.identifier
        return supported.first { $0.language.languageCode?.identifier == lang }
    }

    /// True only when the model is installed and ready — a first run instead
    /// starts the (system-managed, shared-across-apps) download and returns
    /// false so VoiceMode falls back to SFSpeechRecognizer for this session.
    static func shouldUse() async -> Bool {
        guard let locale = await bestSupportedLocale() else { return false }
        let installed = await SpeechTranscriber.installedLocales
        if installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
            return true
        }
        Task.detached(priority: .utility) {
            try? await Self.installModel(for: locale)
        }
        return false
    }

    private static func installModel(for locale: Locale) async throws {
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults],
                                            attributeOptions: [])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    // ── Transcribing a FINISHED recording ──────────────────────────────────

    /// Transcribe an audio file end to end with the large on-device model.
    ///
    /// This is the recorder's second pass, and it exists because the live
    /// SFSpeechRecognizer path can only ever be an approximation of a long take.
    /// ONE SFSpeechRecognitionTask reports ONE utterance, so NiclaRecorder banks
    /// each task's words and starts another — and every one of those boundaries
    /// is a seam where audio arrives while no task is listening (the outgoing
    /// task's `endAudio()`, the cancel, the new request, the new task all take
    /// real time), plus a rate-limit floor that deliberately waits before
    /// restarting so a quiet room can't cause 300 restarts in two minutes. The
    /// stitched result is legible but lossy, and nothing about it says so.
    ///
    /// The take already writes the whole thing to an m4a. `analyzeSequence(from:)`
    /// reads that file with no session cap and no restarts at all: one pass, one
    /// transcript, every second of audio seen exactly once. It runs AFTER the
    /// take, off the audio path — no second engine on the shared input node,
    /// which is the bug this codebase keeps re-learning.
    ///
    /// Returns nil when the model isn't installed, the locale isn't supported, or
    /// the file won't open. Callers must treat nil as "keep the live text": a
    /// second pass that fails must never blank a transcript the user did record.
    static func transcribeFile(at url: URL) async -> String? {
        guard let locale = await bestSupportedLocale() else { return nil }
        // installedLocales, NOT shouldUse(): shouldUse() has the side effect of
        // kicking off a download, which is right when deciding a live session's
        // engine and wrong here — a missing model means "skip the second pass",
        // not "start a multi-hundred-MB download because a memo finished".
        let installed = await SpeechTranscriber.installedLocales
        guard installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
            return nil
        }
        guard let file = try? AVAudioFile(forReading: url) else { return nil }

        // No .volatileResults: nobody is watching this run, and volatile
        // hypotheses would just be discarded on the way to the final text.
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [],
                                            attributeOptions: [])
        do {
            let analyzer = try await SpeechAnalyzer(inputAudioFile: file,
                                                   modules: [transcriber],
                                                   finishAfterFile: true)
            // Order matters: begin collecting results BEFORE the analyzer is told
            // to run to the end of the file, or a short clip can finish and close
            // the stream before anything is reading it.
            let collector = Task { () -> String in
                var parts: [String] = []
                for try await result in transcriber.results where result.isFinal {
                    let piece = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !piece.isEmpty { parts.append(piece) }
                }
                return parts.joined(separator: " ")
            }
            _ = try await analyzer.analyzeSequence(from: file)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let text = try await collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            return nil
        }
    }

    // ── Session ────────────────────────────────────────────────────────────

    /// Start mic → analyzer → results. Callbacks fire on the MainActor.
    /// Volatile results REPLACE the current hypothesis; finalized results are
    /// settled text (VoiceMode accumulates them into `pending`).
    func start(onPartial: @escaping @MainActor (String) -> Void,
               onFinal: @escaping @MainActor (String) -> Void,
               onLevel: @escaping @Sendable (Float) -> Void) async throws {
        guard let locale = await Self.bestSupportedLocale() else {
            throw NSError(domain: "VoiceAnalyzer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "locale not supported"])
        }

        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults],
                                            attributeOptions: [])
        self.transcriber = transcriber
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "VoiceAnalyzer", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no compatible audio format"])
        }

        let (inputSequence, builder) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = builder

        // Results pump — volatile hypotheses flow to onPartial, finalized
        // text to onFinal. The sequence ends when the analyzer finishes.
        resultsTask = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard self != nil else { break }
                    let text = String(result.text.characters)
                    if result.isFinal { onFinal(text) } else { onPartial(text) }
                }
            } catch {
                // Analyzer errored mid-stream — VoiceMode's silence watcher
                // keeps running; a restart arrives via its roll path.
            }
        }

        // Fresh engine per session (VoiceMode's hard-won rule: reuse leaves
        // the input node in a state where installTap throws uncatchable)
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
        let micFormat = input.outputFormat(forBus: 0)
        guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else {
            throw NSError(domain: "VoiceAnalyzer", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "audio session not live"])
        }
        Self.installTap(on: input, micFormat: micFormat, analyzerFormat: analyzerFormat, builder: builder, onLevel: onLevel)
        eng.prepare()
        try eng.start()

        // VPIO settles ASYNCHRONOUSLY after start — the engine reconfigures,
        // the input format swaps, and a tap installed at the old format
        // silently never fires again (proven live on the VoiceCall engine).
        // Re-tap at the current format and restart. Route changes land here too.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.retap(analyzerFormat: analyzerFormat, onLevel: onLevel) }
        }

        try await analyzer.start(inputSequence: inputSequence)
    }

    /// Reinstall the mic tap after an engine configuration change.
    private func retap(analyzerFormat: AVAudioFormat, onLevel: @escaping @Sendable (Float) -> Void) {
        guard let eng = engine, let builder = inputBuilder else { return }
        let input = eng.inputNode
        input.removeTap(onBus: 0)
        let micFormat = input.outputFormat(forBus: 0)
        guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else { return }
        Self.installTap(on: input, micFormat: micFormat, analyzerFormat: analyzerFormat, builder: builder, onLevel: onLevel)
        if !eng.isRunning {
            eng.prepare()
            try? eng.start()
        }
    }

    func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        resultsTask?.cancel(); resultsTask = nil
        inputBuilder?.finish(); inputBuilder = nil
        if let eng = engine {
            eng.inputNode.removeTap(onBus: 0)
            eng.stop()
        }
        engine = nil
        if let analyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
        analyzer = nil
        transcriber = nil
    }

    // ── Nonisolated audio bridge (VoiceMode's pattern: closures created in
    //    nonisolated context so the audio thread can call them freely) ──────

    private nonisolated static func installTap(on input: AVAudioInputNode,
                                               micFormat: AVAudioFormat,
                                               analyzerFormat: AVAudioFormat,
                                               builder: AsyncStream<AnalyzerInput>.Continuation,
                                               onLevel: @escaping @Sendable (Float) -> Void) {
        // One converter for the whole session — formats are fixed at tap time
        let converter = AVAudioConverter(from: micFormat, to: analyzerFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
            onLevel(VoiceMode.rms(of: buffer)) // level meter reads the raw mic buffer (web parity)
            if micFormat == analyzerFormat {
                builder.yield(AnalyzerInput(buffer: buffer))
            } else if let converter,
                      let converted = Self.convert(buffer, with: converter, to: analyzerFormat) {
                builder.yield(AnalyzerInput(buffer: converted))
            }
        }
    }

    private nonisolated static func convert(_ buffer: AVAudioPCMBuffer,
                                            with converter: AVAudioConverter,
                                            to format: AVAudioFormat) -> AVAudioPCMBuffer? {
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
        return convertError == nil ? out : nil
    }
}
