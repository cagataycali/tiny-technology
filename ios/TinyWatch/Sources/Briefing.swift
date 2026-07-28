/**
 * Briefing — W3 interactive complication intent. Compiled into BOTH the
 * watch app and TinyWatchWidgets (Button(intent:) needs the type in the
 * extension). Headless: runs the canned prompt, lands the answer in the
 * Last-answer complication, taps the wrist.
 */
import AppIntents
import WidgetKit
import WatchKit
import Foundation

/// W3 — one-tap briefing from the watch face (Button(intent:) in the
/// complication). Runs headless: no app launch, answer lands in the
/// Last-answer complication + a haptic announces it.
struct BriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "tiny briefing"
    static let description = IntentDescription(
        "Run your briefing prompt without opening the app.",
        categoryName: "Chat"
    )
    // Headless: the complication button must not bounce into the app
    static let openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        guard let token = Keychain.get("tiny_token") else { return .result() }
        let prompt = UserDefaults(suiteName: WidgetStore.suite)?.string(forKey: "watch_briefing_prompt")
            ?? "Give me a tiny briefing: anything new, plus one useful or interesting thing. 2 sentences max."
        let continuity = await MainActor.run { Continuity.buildContext(Config.tinyName) }
        let answer = (try? await Api.chatOnce(
            token: token,
            message: "[Briefing button on Apple Watch — answer in 1-2 short sentences, no markdown] \(prompt)",
            tiny: Config.tinyName,
            extraSystem: continuity
        )) ?? ""
        let clean = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return .result() }
        // Land it where the face already looks: the Last-answer complication
        var snap = WidgetStore.read()
        snap.lastQ = "briefing"
        snap.lastA = String(clean.prefix(120))
        snap.lastAt = Date()
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
        await MainActor.run {
            Continuity.appendTurn(Config.tinyName, q: prompt, a: clean)
            WKInterfaceDevice.current().play(.success)
        }
        return .result()
    }
}



/// W7 — the top followup chip as a face button. Asks the stored followup
/// headless; the answer replaces Last answer (and yields a fresh followup).
struct FollowupIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask followup"
    static let description = IntentDescription(
        "Ask tiny's suggested follow-up from the watch face.",
        categoryName: "Chat"
    )
    static let openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        var snap = WidgetStore.read()
        // Freshness guard mirrors FollowupView: the complication button only
        // shows a fresh chip, but this intent is ALSO reachable via Siri /
        // Shortcuts, where a stale (>30min) suggestion could otherwise be asked.
        guard let token = Keychain.get("tiny_token"),
              let q = snap.followup, !q.isEmpty,
              WatchCore.isFresh(followupAt: snap.followupAt) else { return .result() }
        let continuity = await MainActor.run { Continuity.buildContext(Config.tinyName) }
        let answer = (try? await Api.chatOnce(
            token: token,
            message: "[Followup tapped on Apple Watch face — answer in 1-2 short sentences, no markdown] \(q)",
            tiny: Config.tinyName,
            extraSystem: continuity
        )) ?? ""
        let clean = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return .result() }
        snap = WidgetStore.read()
        snap.lastQ = String(q.prefix(60))
        snap.lastA = String(clean.prefix(120))
        snap.lastAt = Date()
        snap.followup = nil   // consumed — the button decays until the next turn
        snap.followupAt = nil
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
        await MainActor.run {
            Continuity.appendTurn(Config.tinyName, q: q, a: clean)
            WKInterfaceDevice.current().play(.success)
        }
        return .result()
    }
}
