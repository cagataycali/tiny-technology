/**
 * Speech — real speech for the agent's `speak` tool (web parity: the web
 * plays Kokoro TTS; here AVSpeechSynthesizer is the native, zero-download
 * equivalent). One utterance at a time; `speakingId` drives the speech
 * cards' play/stop state, mirroring lib/voice/tts.ts's store on the web.
 */
import AVFoundation

@MainActor
final class Speech: NSObject, ObservableObject {
    static let shared = Speech()

    /// The speech-card id currently playing (nil = silent)
    @Published var speakingId: String?

    private let synth = AVSpeechSynthesizer()
    // didCancel from a superseded utterance arrives async — identity check
    // keeps it from clearing the utterance that replaced it
    private var currentUtterance: ObjectIdentifier?

    override private init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ text: String, id: String, voice: String? = nil) {
        halt()
        let clean = Self.scrub(text)
        guard !clean.isEmpty else { return }
        // Duck other audio (music et al.) instead of killing it. When voice
        // mode holds the session (.playAndRecord + AEC), leave it alone —
        // switching to .playback would kill the live mic tap.
        if !VoiceMode.shared.active {
            try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        let utterance = AVSpeechUtterance(string: clean)
        // Voice resolution, best-first:
        //   1. the user's explicit pick (Settings → Voice) always wins
        //   2. the agent's Kokoro voice id, mapped to the best installed
        //      neural voice of the same accent+gender (web parity: the
        //      agent chose bm_george for a reason)
        //   3. the best neural voice for the user's locale — premium >
        //      enhanced > compact, never the novelty/eloquence bundles
        //      (the "robotic default" this upgrade retires)
        if let picked = UserDefaults.standard.string(forKey: "cfg_voice_id"),
           !picked.isEmpty, let v = AVSpeechSynthesisVoice(identifier: picked) {
            utterance.voice = v
        } else if let mapped = Self.mapKokoroVoice(voice) {
            utterance.voice = mapped
        } else {
            let lang = Locale.preferredLanguages.first ?? "en-US"
            utterance.voice = Self.bestVoice(language: lang) ?? AVSpeechSynthesisVoice(language: lang)
        }
        currentUtterance = ObjectIdentifier(utterance)
        speakingId = id
        synth.speak(utterance)
    }

    // ── Voice quality (on-device genAI pass: "proper speech generation") ──

    /// Best installed voice for a language: premium > enhanced > compact,
    /// filtering out the accessibility/novelty bundles that made the old
    /// default sound robotic. Premium/enhanced neural voices appear here
    /// automatically once the user downloads them in iOS Settings.
    static func bestVoice(language: String, gender: AVSpeechSynthesisVoiceGender? = nil) -> AVSpeechSynthesisVoice? {
        let prefix = String(language.prefix(2))
        var candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix(prefix) &&
            !$0.identifier.contains("speech.synthesis.voice") && // novelty (Fred, Bells…)
            !$0.identifier.contains(".eloquence.")               // accessibility set
        }
        // Exact region beats same-language-different-accent (en-GB ask
        // shouldn't come back en-US when a GB voice exists)
        if candidates.contains(where: { $0.language == language }) {
            candidates = candidates.filter { $0.language == language }
        }
        if let gender, candidates.contains(where: { $0.gender == gender }) {
            candidates = candidates.filter { $0.gender == gender }
        }
        let rank: (AVSpeechSynthesisVoice) -> Int = {
            switch $0.quality {
            case .premium: return 0
            case .enhanced: return 1
            default: return 2
            }
        }
        return candidates.min { rank($0) < rank($1) }
    }

    /// Kokoro voice id (the speak tool's vocabulary: af_heart, am_puck,
    /// bf_emma, bm_george…) → accent + gender → best installed match.
    /// First letter: a = US English, b = UK English. Second: f/m.
    static func mapKokoroVoice(_ id: String?) -> AVSpeechSynthesisVoice? {
        guard let id, id.count >= 2 else { return nil }
        let accent = id.hasPrefix("b") ? "en-GB" : "en-US"
        let gender: AVSpeechSynthesisVoiceGender? =
            id.dropFirst().hasPrefix("f") ? .female :
            id.dropFirst().hasPrefix("m") ? .male : nil
        return bestVoice(language: accent, gender: gender)
    }

    /// Stop speaking WITHOUT releasing the audio session — used by speak()
    /// before it replaces the current utterance, so a back-to-back speak
    /// doesn't unduck then re-duck background audio (an audible blip).
    private func halt() {
        currentUtterance = nil
        speakingId = nil
        synth.stopSpeaking(at: .immediate)
    }

    func stop() {
        halt()
        deactivateSession()
    }

    /// Release the ducking session so background audio (music/podcast) returns
    /// to full volume. speak() ducks with .duckOthers but AVAudioSession keeps
    /// other audio quieted until we deactivate — without this a single speak
    /// left the user's music permanently lowered until voice mode ran or the
    /// app died. Voice mode owns its own .playAndRecord session, so never tear
    /// that down here (it deactivates on its own exit, Voice.swift:80).
    private func deactivateSession() {
        guard !VoiceMode.shared.active else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Settings preview — speak a sample with an explicit voice (or default)
    func preview(_ text: String, voiceId: String?) {
        stop()
        // Same session guard as speak(): voice mode is an inline overlay, not a
        // modal, so the user can open Settings and tap Preview while voice mode
        // still holds .playAndRecord (+ AEC). Switching to .playback there would
        // kill the live mic tap — leave the session alone; the sample still
        // plays through the active playAndRecord output.
        if !VoiceMode.shared.active {
            try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        let utterance = AVSpeechUtterance(string: text)
        if let voiceId, let v = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = v
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")
        }
        currentUtterance = ObjectIdentifier(utterance)
        speakingId = "settings-preview"
        synth.speak(utterance)
    }

    func toggle(_ text: String, id: String, voice: String? = nil) {
        if speakingId == id { stop() } else { speak(text, id: id, voice: voice) }
    }

    /// speak-tool autoplay — respects the Settings toggle (manual ▶ taps
    /// go through speak()/toggle() and always play)
    func autoplay(_ text: String, id: String, voice: String? = nil) {
        guard Config.autoSpeak else { return }
        speak(text, id: id, voice: voice)
    }

    private func utteranceEnded(_ uid: ObjectIdentifier) {
        // A superseded utterance's didFinish/didCancel arrives after its
        // replacement already started — the identity check keeps it from
        // unducking mid-speech (the replacement owns the session now).
        guard currentUtterance == uid else { return }
        currentUtterance = nil
        speakingId = nil
        // Natural end / cancel of the LIVE utterance: release the duck so
        // background audio returns to full volume.
        deactivateSession()
    }

    /// The ear doesn't want markdown — same scrub as the web's tts.ts
    static func scrub(_ text: String) -> String {
        var t = text
        t = t.replacingOccurrences(of: "```[\\s\\S]*?```", with: " code block omitted ", options: .regularExpression)
        t = t.replacingOccurrences(of: "`([^`]+)`", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "[*_#>|]", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return String(t.trimmingCharacters(in: .whitespacesAndNewlines).prefix(3000))
    }
}

extension Speech: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let uid = ObjectIdentifier(utterance)
        Task { @MainActor in Speech.shared.utteranceEnded(uid) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let uid = ObjectIdentifier(utterance)
        Task { @MainActor in Speech.shared.utteranceEnded(uid) }
    }
}
