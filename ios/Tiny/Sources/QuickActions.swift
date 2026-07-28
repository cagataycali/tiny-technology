/**
 * QuickActions — dynamic Home-Screen quick actions (long-press the app icon).
 *
 * iOS parity for android's dynamic recent-tiny launcher shortcuts
 * (`tinyapp://tiny?name=<slug>`): each tiny you switch to is promoted in an
 * MRU list; the top few become long-press launcher shortcuts that deep-link
 * straight back into that tiny. The static App Shortcuts (Intents.swift:
 * ask/fleet/DM) can't express this parameterized, relevance-ranked half.
 *
 * A tap re-opens the app via the SAME `tinyapp://` scheme every other deep
 * link uses (RootView.onOpenURL → session.pendingRoute → ChatView.consumeRoute),
 * so there's one routing path for widgets, notifications, and quick actions.
 * The AppDelegate/SceneDelegate below exist ONLY to catch the tap — the scene
 * delegate deliberately creates no window, so SwiftUI's WindowGroup still owns
 * the UI; it just needs a home for the cold-launch (`willConnectTo`) and
 * warm-launch (`performActionFor`) shortcut callbacks the SwiftUI lifecycle
 * doesn't surface on its own.
 */
import SwiftUI
import UIKit

// ── MRU store ────────────────────────────────────────────────────────────

enum RecentTinys {
    /// Home-Screen quick actions cap at 4 useful rows before the OS elides them.
    static let max = 4
    private static let key = "recent_tinys"
    private static var store: UserDefaults { UserDefaults(suiteName: WidgetStore.suite) ?? .standard }

    /// Pure MRU promotion — move `name` to the front, dedup, cap. Extracted so
    /// TinyTests can cover the ordering/dedup/cap without touching UIKit.
    static func promote(_ name: String, into list: [String], max: Int = max) -> [String] {
        let clean = name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return list }
        var next = list.filter { $0 != clean }
        next.insert(clean, at: 0)
        return Array(next.prefix(max))
    }

    static func load() -> [String] { store.stringArray(forKey: key) ?? [] }

    /// Record a switched-to tiny and re-publish the launcher shortcuts. Always
    /// refreshes (even when the list is unchanged) so a cold start that lands
    /// on the resident tiny still populates the shortcuts.
    @MainActor static func record(_ name: String) {
        let current = load()
        let next = promote(name, into: current)
        if next != current { store.set(next, forKey: key) }
        QuickActions.refresh(next)
    }
}

// ── Shortcut items ───────────────────────────────────────────────────────

enum QuickActions {
    static let openTiny = "technology.tiny.open-tiny"

    @MainActor static func refresh(_ recents: [String] = RecentTinys.load()) {
        UIApplication.shared.shortcutItems = recents.prefix(RecentTinys.max).map { slug in
            UIApplicationShortcutItem(
                type: openTiny,
                localizedTitle: "/\(slug)",
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "leaf"),
                userInfo: ["name": slug as NSString]
            )
        }
    }
}

// ── Tap router ─────────────────────────────────────────────────────────────

/// Bridges a quick-action tap into the shared `tinyapp://` deep-link path so
/// the switch reuses ChatView.consumeRoute. Holds a cold-launch shortcut until
/// the scene is active (SwiftUI's onOpenURL is registered by then).
@MainActor final class QuickActionRouter {
    static let shared = QuickActionRouter()
    private var pending: UIApplicationShortcutItem?
    private init() {}

    func hold(_ shortcut: UIApplicationShortcutItem?) { pending = shortcut }

    func flushPending() {
        guard let s = pending else { return }
        pending = nil
        handle(s)
    }

    func handle(_ shortcut: UIApplicationShortcutItem) {
        guard shortcut.type == QuickActions.openTiny,
              let slug = shortcut.userInfo?["name"] as? String, !slug.isEmpty,
              var comps = URLComponents(string: "tinyapp://tiny") else { return }
        comps.queryItems = [URLQueryItem(name: "name", value: slug)]
        if let url = comps.url { UIApplication.shared.open(url) }
    }
}

// ── App / Scene delegates (tap plumbing only — no window ownership) ──────────

final class TinyAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = TinySceneDelegate.self
        return config
    }
}

final class TinySceneDelegate: UIResponder, UIWindowSceneDelegate {
    /// Left nil on purpose — SwiftUI's WindowGroup creates and owns the window.
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // Cold launch: stash the tapped shortcut; flush once we're active.
        QuickActionRouter.shared.hold(connectionOptions.shortcutItem)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        QuickActionRouter.shared.flushPending()
    }

    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        // Warm launch: app already running, route immediately.
        QuickActionRouter.shared.handle(shortcutItem)
        completionHandler(true)
    }
}
