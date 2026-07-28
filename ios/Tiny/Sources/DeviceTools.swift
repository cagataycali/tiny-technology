/**
 * DeviceTools — round-3 fire-and-forget device actions the agent can call
 * (copy_to_clipboard / set_brightness / play_sound). One generic dispatch
 * keeps Api.swift from growing a ChatEvent case per gadget.
 */
import UIKit
import AudioToolbox
import UserNotifications

@MainActor
final class DeviceTools {
    static let shared = DeviceTools()
    private var soundTask: Task<Void, Never>?

    private init() {}

    /// Handled tool names — Api.swift routes these through .deviceAction
    /// (names inlined there too: Api compiles into the watch target)
    static let names: Set<String> = ["copy_to_clipboard", "set_brightness", "play_sound", "schedule_alert", "cancel_alerts", "open_url"]

    func handle(name: String, argsJson: String) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        switch name {
        case "copy_to_clipboard":
            if let text = args["text"] as? String, !text.isEmpty {
                UIPasteboard.general.string = String(text.prefix(10_000))
            }
        case "set_brightness":
            if let level = (args["level"] as? NSNumber)?.doubleValue {
                screen?.brightness = CGFloat(max(0, min(level, 1)))
            }
        case "play_sound":
            playSound(kind: args["sound"] as? String ?? "alert",
                      seconds: (args["seconds"] as? NSNumber)?.doubleValue ?? 0)
        case "schedule_alert":
            if let title = args["title"] as? String,
               let mins = (args["in_minutes"] as? NSNumber)?.doubleValue {
                scheduleAlert(title: title, body: args["body"] as? String ?? "",
                              minutes: max(0.2, min(mins, 1440)))
            }
        case "cancel_alerts":
            Task {
                let center = UNUserNotificationCenter.current()
                let pending = await center.pendingNotificationRequests()
                let mine = pending.map(\.identifier).filter { $0.hasPrefix("agent-alert-") }
                center.removePendingNotificationRequests(withIdentifiers: mine)
            }
        case "open_url":
            if let raw = args["url"] as? String, let url = URL(string: raw),
               ["https", "http", "maps", "spotify", "music", "shortcuts"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
        default:
            break
        }
    }

    private var screen: UIScreen? {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen }
            .first
    }

    /// Local alarm — fires with sound even app-closed/locked (the reason
    /// this exists next to the server-side schedule tool)
    private func scheduleAlert(title: String, body: String, minutes: Double) {
        Task {
            await Notify.requestPermission()
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(80))
            if !body.isEmpty { content.body = String(body.prefix(200)) }
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: minutes * 60, repeats: false)
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "agent-alert-\(UUID().uuidString)",
                                      content: content, trigger: trigger))
        }
    }

    /// System sound ids (stable, long-documented by convention):
    /// tri-tone alert, alarm ringer, glass chime, keyboard tock
    private func playSound(kind: String, seconds: Double) {
        guard !Config.isQuietNow else { return } // quiet hours: no agent sounds
        let id: SystemSoundID
        switch kind {
        case "alarm": id = 1304
        case "chime": id = 1013
        case "tick":  id = 1057
        default:      id = 1007 // alert
        }
        soundTask?.cancel()
        AudioServicesPlaySystemSound(id)
        guard seconds > 1 else { return }
        let reps = Int(min(seconds, 30) / 1.5)
        soundTask = Task {
            for _ in 0..<reps {
                try? await Task.sleep(for: .seconds(1.5))
                if Task.isCancelled { break }
                AudioServicesPlaySystemSound(id)
            }
        }
    }
}
