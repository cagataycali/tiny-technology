/**
 * WatchBridge — phone side of the watch link. Pushes the session token to
 * the paired watch over WatchConnectivity applicationContext (delivered
 * even if the watch app is closed; latest context wins). The watch stores
 * it in its own Keychain, so it keeps working off-wrist-distance later.
 */
import WatchConnectivity

@MainActor
final class WatchBridge: NSObject {
    static let shared = WatchBridge()
    override private init() { super.init() }

    private var activated = false

    /// Idempotent: activate once, then (re)push current creds.
    func sync(token: String?) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if !activated {
            session.delegate = self
            session.activate()
            activated = true
            // push happens in activationDidComplete
            pendingToken = token
            return
        }
        push(token: token)
    }

    private var pendingToken: String?
    /// Latest fleet/unread numbers — piggybacked on every context push so
    /// watch complications stay fresh without the watch app opening
    var snapshot: FleetSnapshot?

    fileprivate func push(token: String?) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        // Logout: send ONLY the flag. Piggybacking the snapshot/memories/accent
        // here re-delivers the prior user's identity — the watch's apply()
        // scrubs it, but applyMemories()/absorbSnapshot() run right after and
        // re-apply it (memories reappear, last exchange passes the newer-than
        // check against the just-blanked lastAt). Don't ship it in the first
        // place: latest context wins, so this fully replaces the prior one.
        guard let token else {
            try? session.updateApplicationContext(["loggedOut": true])
            return
        }
        var ctx: [String: Any] = ["token": token]
        if let s = snapshot {
            var payload: [String: Any] = ["online": s.online, "total": s.total, "unread": s.unread,
                                          "updated": s.updated.timeIntervalSince1970]
            // R4: phone conversations light up the watch face too
            if let q = s.lastQ { payload["lastQ"] = q }
            if let a = s.lastA { payload["lastA"] = a }
            if let at = s.lastAt { payload["lastAt"] = at.timeIntervalSince1970 }
            if let f = s.followup { payload["followup"] = f }
            if let fat = s.followupAt { payload["followupAt"] = fat.timeIntervalSince1970 }
            ctx["snap"] = payload
        }
        // Theme accent rides along (set by ChatModel.loadTheme; "" = default)
        if let hex = UserDefaults.standard.string(forKey: "cfg_accent_hex"), !hex.isEmpty {
            ctx["accent"] = hex
        }
        // 🧠 Memories ride along — the wrist gets the phone's identity
        // (JSON string: applicationContext only carries plist scalars)
        if let mems = Continuity.memoriesJson(Config.tinyName) {
            ctx["memories"] = mems
        }
        try? session.updateApplicationContext(ctx)
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            let b = WatchBridge.shared
            b.push(token: b.pendingToken ?? Keychain.get("tiny_token"))
            b.pendingToken = nil
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
