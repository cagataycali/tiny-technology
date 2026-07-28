/**
 * Onboarding — first-launch flow (web parity in spirit: the web's modal asks
 * "How should your AI think?" once, then never nags; here the pitch is what
 * the PHONE adds — a fleet node, voice, notifications — before sign-in).
 *
 * Shown only when signed out AND the "onboarded_v1" flag is unset; existing
 * signed-in installs set the flag on first appearance of ChatView and never
 * see it. "Not now" skips straight to LoginView — same sign-in, less story.
 */
import SwiftUI
import AVFoundation

/// Narrator for the tour — one ~10s ElevenLabs clip per page, spoken in the
/// device language when we have it (public/onboarding-voice/, 14 languages),
/// English otherwise. Clips stream from the CDN; any failure stays silent —
/// the tour is fully readable without sound. `.ambient` is a LOCKED product
/// decision (user, 2026-07-25): a phone in silent mode starts the tour
/// silent — the ringer switch outranks the narration. Do NOT "fix" this to
/// `.playback`; flip the switch to hear it.
@MainActor
final class OnboardingNarrator: ObservableObject {
    @Published var muted = UserDefaults.standard.bool(forKey: "onboarding_voice_muted") {
        didSet {
            UserDefaults.standard.set(muted, forKey: "onboarding_voice_muted")
            if muted { player?.pause() } else if page >= 0 { play(page) }
        }
    }
    private var player: AVPlayer?
    private var page = -1

    /// Languages gen-onboarding-voice.mjs ships — keep in sync with the script
    /// (and Android's OnboardingNarrator.LANGS).
    private static let langs: Set<String> = ["en", "tr", "de", "fr", "es", "it", "pt",
                                             "nl", "ru", "ar", "hi", "ja", "ko", "zh"]
    private static var lang: String {
        let code = Locale.current.language.languageCode?.identifier ?? "en"
        return langs.contains(code) ? code : "en"
    }

    func play(_ page: Int) {
        self.page = page
        guard !muted else { return }
        try? AVAudioSession.sharedInstance().setCategory(.ambient)
        try? AVAudioSession.sharedInstance().setActive(true)
        guard let url = URL(string: "\(Config.serverBase)/onboarding-voice/\(Self.lang)/p\(page).mp3") else { return }
        player?.pause()
        player = AVPlayer(url: url)
        player?.play()
    }

    func stop() {
        player?.pause()
        player = nil
        page = -1
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// SwiftUI recreation of the brand mark (public/logo.svg, scripts/gen-logo.mjs):
/// the meta-agent — a breathing neon core with tinys orbiting it. Every color
/// derives from one accent, so any surface can render the mark in the live
/// theme color (pass chat.accent and the brand re-tints with the tiny).
struct NeonMark: View {
    var size: CGFloat = 150
    /// brand green by default — the accent the whole palette derives from
    var accent: Color = Color(red: 0, green: 1, blue: 8.0 / 15.0)

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false
    @State private var spin = false

    /// dot at logo-space offset (SVG viewBox 0 0 120 120, center 60)
    private func dot(_ x: CGFloat, _ y: CGFloat, r: CGFloat, _ color: Color, _ opacity: Double = 1) -> some View {
        Circle()
            .fill(color)
            .opacity(opacity)
            .frame(width: size * r * 2 / 120, height: size * r * 2 / 120)
            .offset(x: size * (x - 60) / 120, y: size * (y - 60) / 120)
    }

    var body: some View {
        ZStack {
            // breathing halo
            Circle()
                .fill(RadialGradient(
                    gradient: Gradient(stops: [
                        .init(color: accent.opacity(0.85), location: 0),
                        .init(color: accent.opacity(0.22), location: 0.55),
                        .init(color: accent.opacity(0), location: 1),
                    ]),
                    center: .center, startRadius: 0, endRadius: size * 34 / 120))
                .scaleEffect(breathe ? 38.0 / 34.0 : 30.0 / 34.0)
                .opacity(breathe ? 1 : 0.7)
            // orbiting tinys
            ZStack {
                dot(60, 18, r: 4, accent)
                dot(102, 60, r: 3, accent, 0.8)
                // 51% white over accent = the SVG palette's light orbit dot
                Circle()
                    .fill(accent)
                    .overlay(Color.white.opacity(0.49).clipShape(Circle()))
                    .frame(width: size * 3.4 * 2 / 120, height: size * 3.4 * 2 / 120)
                    .offset(y: size * 42 / 120)
            }
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(spin ? .linear(duration: 14).repeatForever(autoreverses: false) : .default, value: spin)
            ZStack {
                dot(24, 44, r: 2.6, accent, 0.7)
                dot(96, 88, r: 2.6, accent, 0.7)
            }
            .rotationEffect(.degrees(spin ? -360 : 0))
            .animation(spin ? .linear(duration: 20).repeatForever(autoreverses: false) : .default, value: spin)
            // core: white-hot center → accent → darkened rim (the SVG's
            // 3-stop radial, composed as accent gradient + black falloff)
            Circle()
                .fill(RadialGradient(colors: [.white, accent],
                                     center: .init(x: 0.5, y: 0.45),
                                     startRadius: 0, endRadius: size * 16.5 / 120))
                .overlay(
                    Circle().fill(RadialGradient(
                        gradient: Gradient(stops: [
                            .init(color: .clear, location: 0.45),
                            .init(color: .black.opacity(0.3), location: 1),
                        ]),
                        center: .init(x: 0.5, y: 0.45),
                        startRadius: 0, endRadius: size * 16.5 / 120))
                )
                .frame(width: size * 30 / 120, height: size * 30 / 120)
                .scaleEffect(breathe ? 16.0 / 15.0 : 14.0 / 15.0)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear {
            // reduce-motion users get the static rest frame
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) { breathe = true }
            spin = true
        }
    }
}

struct OnboardingView: View {
    /// Settings → "Replay the tour": same pages, but exits dismiss the sheet
    /// instead of flipping the onboarded flag / offering sign-in
    var preview = false

    @EnvironmentObject var session: TinySession
    @Environment(\.dismiss) private var dismiss
    @AppStorage("onboarded_v1") private var onboarded = false
    // Group container: widget-extension intents must read this too
    @AppStorage("cfg_tiny_name", store: UserDefaults(suiteName: WidgetStore.suite)) private var tinyName = ""
    @AppStorage("cfg_auto_speak") private var autoSpeak = true
    @State private var step = 0
    @State private var busy = false
    @StateObject private var narrator = OnboardingNarrator()

    private let last = 4

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                TabView(selection: $step) {
                    welcome.tag(0)
                    fleet.tag(1)
                    voice.tag(2)
                    everywhere.tag(3)
                    makeYours.tag(4)
                }
                .tabViewStyle(.page(indexDisplayMode: .always))
                .indexViewStyle(.page(backgroundDisplayMode: .always))

                controls
                    .padding(.horizontal, 24)
                    .padding(.bottom, 28)
            }

            // Narration mute — the voiceover starts on its own, so the way
            // out must be one obvious tap (persisted for replays too).
            Button {
                narrator.muted.toggle()
            } label: {
                Image(systemName: narrator.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(.top, 14)
            .padding(.trailing, 16)
            .accessibilityLabel(narrator.muted ? "Unmute tour narration" : "Mute tour narration")
        }
        .background(Color.black)
        .onAppear { narrator.play(step) }
        .onChange(of: step) { _, s in narrator.play(s) }
        .onDisappear { narrator.stop() }
    }

    // ── Pages ─────────────────────────────────────────────────────────────

    private func page<Content: View>(_ emoji: String, _ title: String, _ sub: String,
                                     @ViewBuilder extra: @escaping () -> Content = { EmptyView() }) -> some View {
        // Scrollable so a dense page (the "everywhere" page has 7 rows) doesn't
        // clip on an iPhone SE or at large Dynamic Type — the TabView page has
        // no scroll escape of its own. minHeight == the page height keeps the
        // Spacers centering the content when it fits, yet lets it scroll when
        // it overflows.
        GeometryReader { geo in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 18) {
                    Spacer(minLength: 0)
                    Text(emoji).font(.system(size: 56))
                    Text(title)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .multilineTextAlignment(.center)
                    Text(sub)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    extra()
                    Spacer(minLength: 20)
                }
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
        }
    }

    private var welcome: some View {
        VStack(spacing: 18) {
            Spacer()
            NeonMark()
            Text("tiny")
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .foregroundStyle(.green)
            Text("Your own AI — free, forever.\nCreate it, chat with it, grow it.\nThis app puts your tiny in your pocket.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
            Spacer(minLength: 20)
        }
    }

    private var fleet: some View {
        page("📡", "Your phone becomes a node",
             "Sign in and this iPhone joins your fleet. Your web agent can reach it from anywhere — ask what's around and the phone answers with a live Bluetooth scan, battery, unread messages.") {
            Text("Manage every device at tiny.technology/devices — revoke this one anytime.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var voice: some View {
        page("🎙️", "Talk to it",
             "Voice mode keeps the mic open and transcribes on-device — pause 3 seconds and your thought sends itself. Replies can speak through the phone.") {
            Toggle(isOn: $autoSpeak) {
                Text("Speak replies aloud")
                    .font(.subheadline)
            }
            .tint(.green)
            .padding(.horizontal, 48)
            .padding(.top, 8)
        }
    }

    private var everywhere: some View {
        page("🧩", "It's everywhere",
             "tiny lives beyond this app — put it wherever your thumb already goes.") {
            VStack(alignment: .leading, spacing: 10) {
                discoveryRow("mic.fill", "Control Center & Action button",
                             "one press — mic open, speak, sent")
                discoveryRow("square.grid.2x2", "Home & lock-screen widgets",
                             "fleet + unread at a glance, tap to ask")
                discoveryRow("applewatch", "Apple Watch",
                             "dictate from your wrist; face shows the fleet")
                discoveryRow("waveform", "Siri & Shortcuts",
                             "\"Ask tiny …\" works anywhere Siri does")
                discoveryRow("paperclip", "Drag & drop (iPad)",
                             "drop photos, PDFs, links straight onto the chat")
                discoveryRow("keyboard", "Hardware keyboard",
                             "⌘K universe · ⌘N new · hold ⌘ for the full map")
                discoveryRow("square.stack.3d.up", "Sessions",
                             "save a conversation by name, reload it anytime")
            }
            .padding(.horizontal, 36)
            .padding(.top, 6)
        }
    }

    private func discoveryRow(_ icon: String, _ title: String, _ sub: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(.green)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.footnote.weight(.semibold))
                Text(sub).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var makeYours: some View {
        page("🌱", "Make it yours",
             "Which tiny does this app chat with? Leave it empty for the original — change anytime in ⚙️ Settings.") {
            TextField("tiny", text: $tinyName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: 220)
                .padding(.top, 8)
        }
    }

    // ── Controls ──────────────────────────────────────────────────────────

    @ViewBuilder
    private var controls: some View {
        if step < last {
            VStack(spacing: 12) {
                Button {
                    withAnimation { step += 1 }
                } label: {
                    Text("Continue")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.green)
                        .foregroundStyle(.black)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                Button("Skip") { finish() }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else if preview {
            Button {
                dismiss()
            } label: {
                Text("Done")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.green)
                    .foregroundStyle(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        } else {
            VStack(spacing: 12) {
                Button {
                    busy = true
                    Task {
                        await session.login()
                        // token != nil flips RootView to ChatView, which
                        // marks onboarded; cancelled login just re-enables
                        busy = false
                    }
                } label: {
                    HStack {
                        if busy { ProgressView().tint(.black) }
                        Text(busy ? "Authorizing…" : "Sign in with tiny.technology")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.green)
                    .foregroundStyle(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(busy)
                Text("GitHub login in a secure browser sheet.\nNo passwords touch this app.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                Button("Not now") { finish() }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func finish() {
        if preview { dismiss() } else { onboarded = true }
    }
}
