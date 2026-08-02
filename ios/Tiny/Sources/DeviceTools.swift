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

    /// The open_url scheme allowlist (Android DeviceTools.kt parity). mailto:
    /// opens Mail's compose sheet and message:// opens the Mail app itself —
    /// "open the mail app on my iPhone" was the canonical confabulated success
    /// (use_device P4): the scheme was dropped here while the model claimed 📬.
    nonisolated static let openURLSchemes: Set<String> = ["https", "http", "maps", "spotify", "music", "shortcuts", "mailto", "message"]

    /// Pure allowlist verdict — shared by the open_url execution below and the
    /// relay reply's device-actions audit (DeviceActionAudit), so what RUNS and
    /// what is REPORTED to have run can never drift.
    nonisolated static func resolveOpenURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), openURLSchemes.contains(url.scheme ?? "") else { return nil }
        return url
    }

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
            // Foreground gate (use_device P4): iOS ignores open() from a
            // backgrounded process — the relay's Spotify fast-path already
            // gates on .active; this now matches instead of silently no-oping.
            // The relay audit (DeviceActionAudit) reports the same verdict.
            if let raw = args["url"] as? String, let url = Self.resolveOpenURL(raw),
               UIApplication.shared.applicationState == .active {
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

/**
 * DeviceActionAudit (use_device P4 — Android fleet/DeviceActionAudit.kt parity)
 *
 * A relay invoke ("open the mail app on my iPhone") proxies to the SERVER
 * agent; client-tool events from that stream act on this phone — but some are
 * silently impossible (scheme refused, app backgrounded, round-trip tools that
 * can't run on the relay path), and the proxied model, seeing no signal either
 * way, claims success: "Mail app opened 📬" over a no-op. The relay reply now
 * appends one factual line per attempted device action; the web-side agent
 * relays THAT instead of the model's optimism.
 */
enum DeviceActionAudit {
    static func toolLine(_ name: String, ran: Bool) -> String {
        ran ? "\(name): ran on the phone"
            : "\(name): NOT executed — this tool cannot run via the device relay on iOS"
    }

    /// Round-trip tools (generate_image / screenshot / meta_*) need the phone
    /// to hold the chat stream and post to the tool-result mailbox — the relay
    /// path drops them today (design P5 executes them; until then, say so).
    static func droppedLine(_ name: String) -> String {
        "\(name): NOT executed — not available when another surface drives this phone via use_device"
    }

    /// An action that was HANDED OFF, not completed: the phone showed the user a
    /// consent prompt and returned without waiting (a relay turn must never
    /// park on human reaction time — it would stall the envelope loop that
    /// carries this phone's pushes). The terminal truth arrives separately,
    /// through the tool-result mailbox the server callback is polling.
    ///
    /// So the tense is PRESENT and the claim is narrow: the prompt was shown.
    /// Saying "captured" here would be the exact confabulation this audit
    /// exists to prevent — at this instant nobody has tapped anything.
    /// (Android parity: DeviceActionAudit.dispatchedLine.)
    static func consentLine(_ name: String) -> String {
        "\(name): consent prompt shown on the phone — the user's answer and any result post to the chat's tool mailbox"
    }

    /// A remote round-trip tool refused for a runtime precondition, naming the
    /// precondition rather than the capability (the capability exists — this
    /// phone just can't satisfy it right now).
    static func backgroundedLine(_ name: String) -> String {
        "\(name): NOT executed — the app is backgrounded, so its consent prompt can't be shown and iOS has no foreground screen to capture; ask the user to open the tiny app first"
    }

    static func speakLine(spoke: Bool, quiet: Bool) -> String {
        spoke ? "speak: said aloud on the phone"
              : (quiet ? "speak: NOT spoken — quiet hours on the phone" : "speak: NOT spoken — empty text")
    }

    /// open_url has silent failure layers — name the exact one.
    static func openURLLine(argsJson: String, foreground: Bool) -> String {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        let raw = args["url"] as? String ?? ""
        if DeviceTools.resolveOpenURL(raw) == nil {
            return "open_url(\(raw)): NOT opened — scheme not allowlisted (allowed: \(DeviceTools.openURLSchemes.sorted().joined(separator: ", ")))"
        }
        if !foreground {
            return "open_url(\(raw)): NOT opened — the app is backgrounded and iOS blocks background app launches; ask the user to open the tiny app first"
        }
        return "open_url(\(raw)): opened on the phone"
    }

    /// The block appended to a relay reply ("" when no device actions ran).
    /// Bracketed so the web agent reads it as telemetry, not device prose;
    /// bounded so it can never crowd the answer out of the 8KB relay payload.
    static func render(_ lines: [String]) -> String {
        lines.isEmpty ? "" : "\n\n[device-actions: \(String(lines.joined(separator: "; ").prefix(400)))]"
    }

    /// Order-preserving collector the two relay reply paths share — the
    /// onEvent closure is @Sendable, so the lines live in an actor.
    actor Box {
        private var lines: [String] = []
        func add(_ line: String) { lines.append(line) }
        func render() -> String { DeviceActionAudit.render(lines) }
    }
}
