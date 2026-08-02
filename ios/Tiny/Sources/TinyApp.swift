/**
 * tiny — native iOS node of tiny.technology.
 *
 * The phone IS a device of the user's tiny identity: it logs in via the
 * CLI-token consent flow (tinyapp:// scheme), enrolls in the device
 * registry, heartbeats presence, polls the relay for envelopes from the
 * web agent, and chats with the same /api/chat loop as every surface.
 */
import SwiftUI
import UserNotifications

@main
struct TinyApp: App {
    @StateObject private var session = TinySession()
    @Environment(\.scenePhase) private var scenePhase
    // Owns only the shortcut-tap callbacks (Home-Screen quick actions); the
    // SwiftUI WindowGroup still creates and owns the window (QuickActions.swift).
    @UIApplicationDelegateAdaptor(TinyAppDelegate.self) private var appDelegate

    init() {
        // BGTaskScheduler demands registration before launch completes
        Background.register()
        // 🕶️ Meta glasses: the DAT SDK must be configured before any other
        // call (incl. the URL callback from the Meta AI app). Guarded — a
        // Catalyst build has no MWDAT module (Wearables.swift explains).
        #if canImport(MWDATCore) && canImport(MWDATCamera)
        WearablesManager.shared.configure()
        #endif
        // Foreground notification banners (new-DM alerts while the app is open)
        UNUserNotificationCenter.current().delegate = NotifyDelegate.shared
        // One-time migration: cfg_tiny_name used to live only in the app's
        // standard defaults, unreadable from widget-extension sandboxes.
        // Settings/Onboarding write to the group container now; carry the
        // existing value over so widget briefings chat as the right tiny.
        if let group = UserDefaults(suiteName: WidgetStore.suite),
           group.string(forKey: "cfg_tiny_name") == nil,
           let legacy = UserDefaults.standard.string(forKey: "cfg_tiny_name"), !legacy.isEmpty {
            group.set(legacy, forKey: "cfg_tiny_name")
        }
        // Keychain shared-access-group migration: with keychain-access-groups
        // in the entitlements, new writes default to the SHARED group (which
        // widget-extension intents can read — the ⚡ briefing / 💡 followup
        // buttons need the token). Legacy items sit in the bundle-id group;
        // a get (searches all groups) + set (rewrites into shared) moves them.
        for key in ["tiny_token", "tiny_device_id", "tiny_device_token"] {
            if let v = Keychain.get(key) { Keychain.set(key, v) }
        }
        #if DEBUG
        // Screenshot harness: `SIMCTL_CHILD_TINY_HARNESS_TOKEN=… simctl launch …
        // technology.tiny.app --session-harness` seeds the session token before
        // TinySession's first Keychain read, so simulator runs render the authed
        // UI for store captures. Debug-only; the token rides the env, never disk.
        if ProcessInfo.processInfo.arguments.contains("--session-harness"),
           let harnessToken = ProcessInfo.processInfo.environment["TINY_HARNESS_TOKEN"],
           !harnessToken.isEmpty {
            Keychain.set("tiny_token", harnessToken)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // Design harness: `simctl launch … technology.tiny.app --map-ambient-harness`
            // renders JUST the ambient map + wash + sample chat chrome, no auth —
            // the visual iteration loop for map-as-chat-background work.
            if ProcessInfo.processInfo.arguments.contains("--map-ambient-harness") {
                AmbientMapHarness()
                    .preferredColorScheme(.dark)
            } else {
                RootView()
                    .environmentObject(session)
                    .preferredColorScheme(.dark)
            }
            #else
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Fresh loops = instant heartbeat → 🟢 the moment we're back
                session.startDeviceLoops()
                // OTA: is tiny.technology/ios ahead of this binary?
                Updater.shared.checkSoon()
                // 🕶️ Returning from the Meta AI link handoff: re-read the
                // registration state in case the callback was missed.
                #if canImport(MWDATCore) && canImport(MWDATCamera)
                WearablesManager.shared.refresh()
                #endif
                // 🎙️ A registered Nicla Voice can't reach the internet on its
                // own (BLE-only nRF52832) — this phone IS its network. No-op
                // when none is paired, so a user without one never even sees
                // the Bluetooth prompt from here.
                NiclaVoiceGateway.shared.start()
            case .background:
                // The OS would suspend the 5s poll mid-request anyway; stop
                // cleanly and hand persistence to BGAppRefresh
                session.stopDeviceLoops()
                // 🎙️ The necklace's link deliberately SURVIVES backgrounding.
                //
                // This used to call NiclaVoiceGateway.stop(), on the reasoning
                // that claiming presence for a link the OS was about to suspend
                // would advertise a necklace no tool call could reach. That was
                // true when the app had no `bluetooth-central` background mode —
                // but it also meant the necklace went offline the instant the
                // phone was pocketed, which for a wearable is the normal case,
                // not an edge one. Measured before this change: the phone's own
                // heartbeat was 115s old (so the app was alive and polling in
                // the background) while the Voice's was 139 MINUTES old.
                //
                // With `bluetooth-central` declared, CoreBluetooth keeps
                // delivering notifications while backgrounded, so the honest
                // move is to hold the link and let the heartbeat keep telling
                // the truth. beat() is already gated on `connected`, so if iOS
                // does drop the link, presence stops on its own — no stale
                // claim, and wake events survive a pocketed phone.
                Background.schedule()
            default:
                break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: TinySession
    /// First-launch story (Onboarding.swift). Signed-in installs that predate
    /// it set the flag on first ChatView and never see the flow.
    @AppStorage("onboarded_v1") private var onboarded = false

    var body: some View {
        Group {
            if session.token != nil {
                AdaptiveRoot()
                    .onAppear { onboarded = true }
            } else if !onboarded {
                OnboardingView()
            } else {
                LoginView()
            }
        }
        // Proximity pairing mounts HERE, not on ChatView's modifier chain:
        // that chain's generic depth is at the Release demangler's limit —
        // one more modifier there SIGSEGVs at launch (measured, cycle-22).
        .modifier(ProximityPairing())
        // Root-level catch: registered from the first frame, so cold
        // launches (Control Center / widget taps) never drop the route.
        // ChatView consumes session.pendingRoute when it's ready.
        .onOpenURL { url in
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            // 🕶️ A DAT callback is identified by its metaWearablesAction
            // query item — the SDK sample's own dispatch rule — and it may
            // arrive with NO host at all, so this claim must run BEFORE the
            // host guard below (which silently swallowed the first real
            // link attempt: Meta AI succeeded, tiny never saw the reply).
            if URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true {
                Task { await WearablesManager.shared.handle(url: url) }
                return
            }
            #endif
            guard let host = url.host(), host != "auth" else { return }
            route(url, host: host)
        }
        .task { await session.bootstrap() }
    }

    /// The pre-glasses routing, verbatim: quick-action deep links
    /// (tinyapp://tiny?name=<slug>) carry the target tiny as a query param
    /// the bare route string can't hold; everything else is a route host.
    private func route(_ url: URL, host: String) {
        if host == "tiny",
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let slug = comps.queryItems?.first(where: { $0.name == "name" })?.value,
           !slug.isEmpty {
            session.pendingTiny = slug
            return
        }
        session.pendingRoute = host
    }
}
