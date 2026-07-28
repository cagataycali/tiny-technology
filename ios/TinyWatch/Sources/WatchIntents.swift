/**
 * WatchIntents — "Ask tiny" by Siri, wrist-local (App Intents in the watch
 * binary; no phone round-trip). Raise your wrist: "Ask tiny …" — the answer
 * comes back as a Siri dialog the watch reads aloud.
 */
import AppIntents
import WidgetKit
import WatchKit

struct AskTinyWatchIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask tiny"
    static let description = IntentDescription(
        "Ask your tiny anything from the watch.",
        categoryName: "Chat"
    )

    @Parameter(title: "Prompt", requestValueDialog: "What should I ask your tiny?")
    var prompt: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask tiny \(\.$prompt)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        guard let token = Keychain.get("tiny_token") else {
            return .result(value: "", dialog: "Open tiny on your iPhone first — the watch links automatically.")
        }
        // Continuity: Siri answers know your memories + recent turns too
        let continuity = await MainActor.run { Continuity.buildContext(Config.tinyName) }
        let answer = (try? await Api.chatOnce(
            token: token,
            message: "[Asked via Siri on Apple Watch — answer in 1-2 short sentences, no markdown] \(prompt)",
            tiny: Config.tinyName,
            extraSystem: continuity
        )) ?? ""
        let clean = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        // Write the exchange back to the turn log — this intent READS continuity
        // (above), so it must also FEED it, like the watch's other chatOnce paths
        // (BriefingIntent, FollowupIntent) and the main chat do. Without this a
        // Siri "Ask tiny …" is invisible to every later briefing/followup/ask:
        // continuity would be one-directional for wrist-Siri asks.
        if !clean.isEmpty {
            await MainActor.run { Continuity.appendTurn(Config.tinyName, q: prompt, a: clean) }
        }
        return .result(
            value: clean,
            dialog: IntentDialog(stringLiteral: clean.isEmpty ? "tiny didn't answer — try the app." : String(clean.prefix(300)))
        )
    }
}

struct TinyWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskTinyWatchIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
            ],
            shortTitle: "Ask tiny",
            systemImageName: "leaf"
        )
    }
}
