/**
 * WatchSettings — wrist-local preferences (W6).
 *
 * The watch is NOT a remote control for the phone's settings; it has its
 * own tiny set: the briefing prompt (what the ⚡ complication asks) and
 * whether spoken replies autoplay through the wrist speaker. UserDefaults-
 * backed — BriefingIntent reads watch_briefing_prompt directly.
 */
import SwiftUI

struct WatchSettingsView: View {
    // Group container: BriefingIntent/FollowupIntent run in the watch-widget
    // EXTENSION whose UserDefaults.standard is a different sandbox container —
    // standard-defaults writes were invisible there (custom prompt ignored).
    @AppStorage("watch_briefing_prompt", store: UserDefaults(suiteName: WidgetStore.suite)) private var briefingPrompt = ""
    @AppStorage("watch_auto_speak") private var autoSpeak = true
    @Environment(\.dismiss) private var dismiss

    private static let presets: [(label: String, prompt: String)] = [
        ("Daily brief", "Give me a tiny briefing: anything new, plus one useful or interesting thing. 2 sentences max."),
        ("Fleet check", "How is my device fleet? Anything offline or unusual? 2 sentences max."),
        ("Motivation", "One short, concrete piece of motivation for right now. 2 sentences max."),
        ("What's next", "Based on what you know about me, what should I focus on next? 2 sentences max."),
    ]

    var body: some View {
        Form {
            Section {
                ForEach(Self.presets, id: \.label) { preset in
                    Button {
                        briefingPrompt = preset.prompt
                    } label: {
                        HStack {
                            Text(preset.label).font(.footnote)
                            Spacer()
                            if briefingPrompt == preset.prompt || (briefingPrompt.isEmpty && preset.label == "Daily brief") {
                                Image(systemName: "checkmark")
                                    .font(.caption2)
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                }
                // Free-form: dictate/scribble a custom prompt
                TextFieldLink(prompt: Text("Custom prompt")) {
                    Label("Custom…", systemImage: "square.and.pencil")
                        .font(.footnote)
                } onSubmit: { text in
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { briefingPrompt = t }
                }
            } header: {
                Label("Briefing asks", systemImage: "bolt")
            } footer: {
                Text(briefingPrompt.isEmpty ? "Default: daily brief" : briefingPrompt)
                    .font(.system(size: 11))
            }

            Section {
                Toggle("Speak replies", isOn: $autoSpeak)
                    .font(.footnote)
            } footer: {
                Text("When tiny uses its speak tool, play it on the wrist.")
                    .font(.system(size: 11))
            }
        }
        .navigationTitle("Settings")
    }
}
