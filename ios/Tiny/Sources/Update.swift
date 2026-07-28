/**
 * Updater — OTA self-update off tiny.technology/ios. The app compares its
 * CFBundleVersion against the install manifest's bundle-version; when the
 * server is ahead, a banner offers the update and the itms-services URL
 * hands installation to iOS (works anywhere — no cable, no Mac, no Wi-Fi
 * pairing; the device just needs to be provisioned, which /ios enrollment
 * handles).
 *
 * Publishing side: ios/scripts/push-ota.sh bumps CURRENT_PROJECT_VERSION →
 * archive → export → public/ios/Tiny.ipa + manifest bump → git push
 * (Vercel serves it).
 */
import UIKit

@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()

    /// Remote build number when it's ahead of this binary (nil = current)
    @Published var available: String?

    private static let manifest = "https://tiny.technology/ios/manifest.plist"
    private static let install = URL(string: "itms-services://?action=download-manifest&url=https://tiny.technology/ios/manifest.plist")!

    private var lastCheck = Date.distantPast

    private init() {}

    /// Debounced check — call freely on foreground/launch
    func checkSoon() {
        guard Date().timeIntervalSince(lastCheck) > 15 * 60 else { return }
        lastCheck = Date()
        Task { await check() }
    }

    func check() async {
        // Mac Catalyst: the OTA pipeline IS an iOS install path — the banner's
        // itms-services URL hands off to an installer macOS doesn't have, and
        // every push-ota.sh bump would nag the Mac with an update it can't
        // apply. The Mac app ships via local Xcode builds, so stay silent.
        #if !targetEnvironment(macCatalyst)
        guard let url = URL(string: Self.manifest),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let items = plist["items"] as? [[String: Any]],
              let meta = items.first?["metadata"] as? [String: Any],
              let remote = meta["bundle-version"] as? String
        else { return }
        let local = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        applyCheck(remote: remote, local: local)
        #endif
    }

    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        a.compare(b, options: .numeric) == .orderedDescending
    }

    // The version we just handed to the iOS installer. The install dialog
    // backgrounds the app; foregrounding re-checks while the binary is
    // still old — without suppression the banner instantly reappears
    // mid-install (the bug the user hit on build 22).
    private var installingVersion: String?
    private var installingUntil = Date.distantPast

    /// Hands off to iOS — the system installer replaces the app in place.
    /// The tapped version is suppressed for 10 minutes: long enough for the
    /// swap, short enough that a failed/cancelled install re-offers.
    func installUpdate() {
        installingVersion = available
        installingUntil = Date().addingTimeInterval(10 * 60)
        available = nil
        lastCheck = .distantPast
        UIApplication.shared.open(Self.install)
    }

    fileprivate func applyCheck(remote: String, local: String) {
        let candidate = Self.isNewer(remote, than: local) ? remote : nil
        if let c = candidate, c == installingVersion, Date() < installingUntil {
            available = nil // install in flight — don't nag while iOS swaps
        } else {
            available = candidate
        }
    }
}
