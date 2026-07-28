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

enum Notify {
    /// Ask once (no-op after the user decides). Called post-login and on
    /// bootstrap for already-enrolled devices that predate this build.
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

    /// App-icon badge = total unread DMs
    static func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}
