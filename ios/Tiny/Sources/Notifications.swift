/**
 * Notify — local notifications so the phone-as-fleet-node is visible even
 * when the app isn't: a BGAppRefresh wake that answers a web-agent invoke
 * leaves a notification behind ("the web agent reached your phone").
 *
 * Local-only this pass. Remote APNs push (waking the relay on demand,
 * true always-on presence) needs server-side work — flagged in the
 * backlog, not built blind from here.
 */
import UserNotifications
import UIKit

/// 💻/🤖 Trusted tap→redeem stash (Android c6de2bcc ask?q= parity, with an
/// iOS twist: notification taps route via self-opened tinyapp:// URLs, and
/// onOpenURL cannot tell our own open from a Safari link's — so the redeem
/// text must NEVER ride the URL. The notification delegate — the only trusted
/// origin — stashes it here; the ask route consumes it one-shot. A hostile web
/// page's tinyapp://ask finds an empty stash and just focuses the composer,
/// exactly today's behavior.
enum RedeemStash {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var value: (text: String, at: Date)?

    static func stash(_ text: String) {
        lock.lock(); value = (text, Date()); lock.unlock()
    }

    /// One-shot take, fresh (≤60s) only — a stale stash (app killed between
    /// tap and consume) must not auto-send on some later manual tinyapp://ask.
    static func take() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let v = value else { return nil }
        value = nil
        return Date().timeIntervalSince(v.at) <= 60 ? v.text : nil
    }
}

/// Foreground presentation: without a delegate iOS silently swallows
/// notifications while the app is open — new-DM banners should show anyway.
final class NotifyDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = NotifyDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// Inline reply from a DM banner — sends without opening the app.
    /// A plain TAP on a DM banner routes into the Messages sheet (the
    /// existing tinyapp:// deep-link path does the navigation).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // 💻/🤖 A "finished" banner (relay notify carrying a redeem turn):
        // stash the trusted text, then route through the PLAIN ask deep link —
        // the URL carries no payload by design (see RedeemStash).
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let q = response.notification.request.content.userInfo["redeemQ"] as? String, !q.isEmpty {
            RedeemStash.stash(q)
            await MainActor.run {
                if let url = URL(string: "tinyapp://ask") { UIApplication.shared.open(url) }
            }
            return
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           response.notification.request.content.categoryIdentifier == "DM" {
            await MainActor.run {
                if let url = URL(string: "tinyapp://messages") { UIApplication.shared.open(url) }
            }
            return
        }
        guard response.actionIdentifier == "DM_REPLY",
              let input = response as? UNTextInputNotificationResponse,
              let login = response.notification.request.content.userInfo["login"] as? String else { return }
        let text = input.userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let token = Keychain.get("tiny_token") else { return }
        // A silently-eaten reply is worse from a banner than from the composer:
        // there's no draft to preserve and no UI on screen, so the user walks
        // away believing they answered. On failure, leave a notification so they
        // know to reopen and resend (the DM itself is still in the thread view).
        do {
            let resp: [String: Any] = try await Api.post("/api/messages", token: token, body: [
                "to": login,
                "message": String(text.prefix(2000)),
                "viaTiny": "ios-notification",
            ])
            if (resp["ok"] as? Bool) == false {
                await Notify.post(title: "Reply didn't send",
                                  body: (resp["error"] as? String) ?? "Open tiny to try again.",
                                  category: "DM", userInfo: ["login": login])
            }
        } catch {
            await Notify.post(title: "Reply didn't send",
                              body: "Couldn't reach tiny — open the app to resend to @\(login).",
                              category: "DM", userInfo: ["login": login])
        }
    }
}

/// A `--…-harness` / `--…-test` launch is a build being photographed, not a
/// person using the app: `simctl` has no way to answer a system modal, so any
/// permission dialog that fires lands ON TOP of the screen being captured and
/// stays there for the rest of the run. Two of these ask without a tap —
/// bootstrap's notification ask on every `--session-harness` run, and
/// AmbientMapHarness's `.onAppear` location ask — which means the runs that
/// CANNOT answer a dialog are the only ones that raise it unprompted.
///
/// The store captures look clean only because those simulators answered these
/// prompts on some earlier launch; erase a device, or add a new one, and every
/// shot grows an alert again.
///
/// Matched by shape, not by a list: `--devices-sheet-harness` was a day old
/// when this was written and nobody thought about the alert, so a fixed list
/// would already have been one short.
enum HarnessRun {
    static func isFlag(_ argument: String) -> Bool {
        argument.hasPrefix("--") && (argument.hasSuffix("-harness") || argument.hasSuffix("-test"))
    }

    /// DEBUG-only on purpose: a shipping build must never skip a permission ask
    /// because of a string in argv. Same rule as TinyApp's token seeding.
    static func suppressesSystemPrompts(arguments: [String]) -> Bool {
        #if DEBUG
        return arguments.contains(where: isFlag)
        #else
        return false
        #endif
    }
}

enum Notify {
    /// Ask once (no-op after the user decides). Called post-login and on
    /// bootstrap for already-enrolled devices that predate this build.
    /// Registers categories always; asks only when a human could answer.
    static func requestPermission() async {
        let center = UNUserNotificationCenter.current()
        // Categories are cheap and must be (re)registered every launch —
        // DM banners carry an inline Reply field
        let reply = UNTextInputNotificationAction(
            identifier: "DM_REPLY", title: "Reply", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "DM", actions: [reply], intentIdentifiers: []),
        ])
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        // Categories are registered above either way — it's the ASK that a
        // capture run must not do, since nothing can dismiss it. See HarnessRun.
        guard !HarnessRun.suppressesSystemPrompts(arguments: ProcessInfo.processInfo.arguments)
        else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    /// Fire-and-forget local notification (skips silently when denied)
    static func post(title: String, body: String, category: String? = nil, userInfo: [String: String] = [:]) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
           || settings.authorizationStatus == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let category { content.categoryIdentifier = category }
        if !userInfo.isEmpty { content.userInfo = userInfo }
        try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    /// The auto-send text a push url carries (`/?q=<urlencoded turn>`) — the
    /// worker's device-result and batch pushes are self-redeeming on the web;
    /// this is the native half (Session.handleNotifyEnvelope → banner userInfo).
    static func redeemQuery(from url: String) -> String? {
        guard let q = URLComponents(string: url)?.queryItems?
                .first(where: { $0.name == "q" })?.value,
              !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return q
    }

    /// App-icon badge = total unread DMs
    static func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}
