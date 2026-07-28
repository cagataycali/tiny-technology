/**
 * Intents — Siri / Shortcuts / Action-button surface (App Intents framework,
 * lives in the app binary — no extension target).
 *
 *   - AskTinyIntent: prompt → /api/chat (same chatOnce the relay uses),
 *     answer spoken/shown by Siri and returned to Shortcuts as text
 *   - FleetStatusIntent: /api/devices → "🟢 2 of 3 online: …"
 *   - SendTinyDmIntent: /api/messages → DM a login from a shortcut
 *
 * All run in the background (no app launch); creds come from the Keychain
 * (kSecAttrAccessibleAfterFirstUnlock — readable from background runs).
 * Siri's execution budget is short, so AskTiny asks the agent to be brief.
 */
import AppIntents

struct AskTinyIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask tiny"
    static let description = IntentDescription(
        "Ask your tiny anything — the answer comes back as text Siri can speak.",
        categoryName: "Chat"
    )

    @Parameter(title: "Prompt", requestValueDialog: "What should I ask your tiny?")
    var prompt: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask tiny \(\.$prompt)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        guard let token = Keychain.get("tiny_token") else {
            return .result(value: "", dialog: "Sign in to the tiny app first.")
        }
        // Steer for the channel: Siri speaks the reply and kills long runs
        let answer = (try? await Api.chatOnce(
            token: token,
            message: "[Asked via Siri/Shortcuts — answer in 1-3 plain sentences, no markdown] \(prompt)",
            tiny: Config.tinyName
        )) ?? ""
        let clean = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        return .result(
            value: clean,
            dialog: IntentDialog(stringLiteral: clean.isEmpty ? "tiny didn't answer — try the app." : String(clean.prefix(700)))
        )
    }
}

struct FleetStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Fleet status"
    static let description = IntentDescription(
        "Which of your tiny devices are online right now.",
        categoryName: "Fleet"
    )

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let token = Keychain.get("tiny_token") else {
            return .result(dialog: "Sign in to the tiny app first.")
        }
        guard let d: [String: Any] = try? await Api.get("/api/devices", token: token),
              let devices = d["devices"] as? [[String: Any]] else {
            return .result(dialog: "Couldn't reach your fleet — network or sign-in issue.")
        }
        let online = devices.filter { ($0["online"] as? Bool) ?? (($0["online"] as? Int) == 1) }
        if devices.isEmpty { return .result(dialog: "No devices enrolled yet. This phone enrolls when you sign in to the tiny app.") }
        if online.isEmpty { return .result(dialog: "All quiet — none of your \(devices.count) devices are online right now.") }
        let names = online.compactMap { $0["name"] as? String }.joined(separator: ", ")
        return .result(dialog: IntentDialog(stringLiteral: "🟢 \(online.count) of \(devices.count) online: \(names)"))
    }
}

struct SendTinyDmIntent: AppIntent {
    static let title: LocalizedStringResource = "Send tiny message"
    static let description = IntentDescription(
        "DM another tiny.technology user by their login.",
        categoryName: "Messages"
    )

    @Parameter(title: "To (login)", requestValueDialog: "Who should get it?")
    var to: String
    @Parameter(title: "Message", requestValueDialog: "What's the message?")
    var message: String

    static var parameterSummary: some ParameterSummary {
        Summary("Message \(\.$to): \(\.$message)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let token = Keychain.get("tiny_token") else {
            return .result(dialog: "Sign in to the tiny app first.")
        }
        let resp: [String: Any] = (try? await Api.post("/api/messages", token: token, body: [
            "to": to.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")),
            "message": String(message.prefix(2000)),
            "viaTiny": "ios-shortcut",
        ])) ?? [:]
        if (resp["ok"] as? Bool) == true {
            return .result(dialog: IntentDialog(stringLiteral: "💬 Sent to @\(to)."))
        }
        let err = (resp["error"] as? String) ?? "unknown error"
        return .result(dialog: IntentDialog(stringLiteral: "Couldn't send: \(err)"))
    }
}

/// Zero-setup phrases — these appear in Spotlight/Shortcuts the moment the
/// app installs, and Siri matches them by voice ("Ask tiny …").
struct TinyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskTinyIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
            ],
            shortTitle: "Ask tiny",
            systemImageName: "leaf"
        )
        AppShortcut(
            intent: FleetStatusIntent(),
            phrases: [
                "\(.applicationName) fleet status",
                "Is my \(.applicationName) fleet online",
            ],
            shortTitle: "Fleet status",
            systemImageName: "dot.radiowaves.left.and.right"
        )
        AppShortcut(
            intent: SendTinyDmIntent(),
            phrases: [
                "Send a \(.applicationName) message",
            ],
            shortTitle: "Send DM",
            systemImageName: "bubble.left.and.bubble.right"
        )
    }
}
