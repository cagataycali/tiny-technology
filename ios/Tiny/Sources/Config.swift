/**
 * Config — user-adjustable app settings (menu → Settings), UserDefaults-
 * backed so SettingsView's @AppStorage and non-UI code read the same keys.
 *
 * tinyName un-hardcodes which tiny the app talks to (x-tiny-name header);
 * autoSpeak gates the speak tool's autoplay; serverBase points dev builds
 * at a local next dev instance.
 */
import Foundation

enum Config {
    static let defaultServer = "https://tiny.technology"

    /// Which tiny this app chats as — the x-tiny-name header everywhere.
    /// Reads the app-group container FIRST: widget/watch-widget intents run
    /// in extension sandboxes where UserDefaults.standard is a DIFFERENT
    /// container — group-first is what lets briefings chat as the configured
    /// tiny. Standard is the pre-group legacy location (migrated at launch).
    static var tinyName: String {
        let group = UserDefaults(suiteName: WidgetStore.suite)?.string(forKey: "cfg_tiny_name")
        let raw = ((group?.isEmpty == false ? group : nil)
            ?? UserDefaults.standard.string(forKey: "cfg_tiny_name"))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? "tiny" : raw
    }

    /// Quiet hours (22:00–08:00 local, default ON): REMOTE audible actions —
    /// relay announce/speak, agent sounds — stay silent while the user likely
    /// sleeps. Vibration and silent tools still work; in-person chat unaffected.
    static var quietHoursEnabled: Bool {
        UserDefaults.standard.object(forKey: "cfg_quiet_hours") as? Bool ?? true
    }

    static var isQuietNow: Bool {
        guard quietHoursEnabled else { return false }
        let hour = Calendar.current.component(.hour, from: Date())
        return hour >= 22 || hour < 8
    }

    /// speak tool autoplay (cards always render; this only gates the audio)
    static var autoSpeak: Bool {
        UserDefaults.standard.object(forKey: "cfg_auto_speak") as? Bool ?? true
    }

    /// 📍 Share live location with the tiny (web tiny-geo-context / Android
    /// cfg_location_context parity): each send folds a `### Location` block
    /// into the hidden context. Off by default; the Settings toggle runs the
    /// permission ask — an ON flag without a grant still injects nothing.
    static var locationContext: Bool {
        UserDefaults.standard.object(forKey: "cfg_location_context") as? Bool ?? false
    }

    /// API origin — override for local dev; falls back on anything malformed
    static var serverBase: String {
        var raw = UserDefaults.standard.string(forKey: "cfg_server")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        while raw.hasSuffix("/") { raw.removeLast() }
        guard raw.hasPrefix("http://") || raw.hasPrefix("https://"),
              URL(string: raw) != nil else { return defaultServer }
        return raw
    }
}
