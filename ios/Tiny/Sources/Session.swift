/**
 * TinySession — auth + device lifecycle.
 *
 * Token: CLI-token flow (aud:'tiny-cli', 90d) via ASWebAuthenticationSession
 * on /auth/cli?scheme=tinyapp&state=… → tinyapp://auth?code&state →
 * POST /api/auth/cli/token. Stored in Keychain.
 *
 * Device: enrolled once via POST /api/devices (session token), device token
 * kept in Keychain; heartbeat every 30s while foregrounded + relay poll
 * every 5s — the phone shows 🟢 on /devices and answers use_device invokes.
 */
import Foundation
import AuthenticationServices
import UIKit
import WidgetKit

@MainActor
final class TinySession: NSObject, ObservableObject {
    @Published var token: String?
    @Published var user: (login: String, name: String)?
    @Published var deviceId: String?
    /// 🏅 This account's daily allowance and what its reputation earned it, off
    /// the same `/api/me` load that fetches the user — nil until it lands, and
    /// nil forever against a pre-c38 server (Settings then quotes no number,
    /// which is what it did before this existed). Read by SettingsView's
    /// free-tier footer; see Standing.swift.
    @Published var standing: Standing?
    @Published var relayActivity: String = ""
    /// What the web agent has asked this phone (newest first, session-scoped)
    @Published var relayLog: [RelayEvent] = []

    struct RelayEvent: Identifiable, Equatable {
        let id = UUID()
        let ts: Date
        let prompt: String
        var result: String
    }

    func logRelay(prompt: String, result: String) {
        relayLog.insert(RelayEvent(ts: Date(), prompt: String(prompt.prefix(200)),
                                   result: String(result.prefix(500))), at: 0)
        if relayLog.count > 50 { relayLog.removeLast(relayLog.count - 50) }
    }
    /// Total unread DMs — menu label + app-icon badge (30s heartbeat poll)
    @Published var unreadDms = 0
    /// Unread activity events — the ⚡ Activity menu badge. Counts ring entries
    /// (GET /api/events) newer than the persisted high-water mark, mirroring
    /// web ActivityHUD's SEEN_KEY model. Polled on the heartbeat; cleared when
    /// the Activity sheet opens (markEventsSeen).
    @Published var unreadEvents = 0
    /// High-water mark of the newest event id the user has seen (web's
    /// localStorage SEEN_KEY → here UserDefaults, survives relaunch).
    private static let eventsSeenKey = "cfg_events_seen_id"
    /// Deep-link route (tinyapp://<route>) caught at RootView before ChatView
    /// exists — cold launches from widgets/Control Center land here and
    /// ChatView consumes it on appear
    @Published var pendingRoute: String?
    /// Parameterized deep link (tinyapp://tiny?name=<slug>) from a Home-Screen
    /// quick action — carries the target slug the route string can't. ChatView
    /// consumes it into switchTiny (QuickActions.swift).
    @Published var pendingTiny: String?

    override init() {
        super.init()
        // Synchronous Keychain read: the FIRST body evaluation must already
        // know whether we're signed in, or a cold-launch deep link renders
        // LoginView for a frame and the route is lost
        token = Keychain.get("tiny_token")
        deviceId = Keychain.get("tiny_device_id")
    }

    static var apiUrl: String { Api.base }
    private var heartbeatTask: Task<Void, Never>?
    private var relayTask: Task<Void, Never>?

    func bootstrap() async {
        token = Keychain.get("tiny_token")
        deviceId = Keychain.get("tiny_device_id")
        // Watch link: (re)push creds so a freshly installed watch app links
        WatchBridge.shared.sync(token: token)
        if token != nil {
            await loadMe()
            startDeviceLoops()
            // requestPermission() is the ONLY place the "DM" category (with its
            // inline Reply action) is registered, and categories must be
            // (re)registered every launch (Notifications.swift:66). It must NOT
            // be gated on deviceId: refreshUnread() posts category:"DM" banners
            // and is reachable without a deviceId (pull-to-refresh, Messages
            // onDisappear) — so if a prior-launch enrollment failed (deviceId
            // nil) while notifications are authorized, gating here left the DM
            // category unregistered and the banner lost its Reply action. The
            // call is idempotent (asks at most once; no-op after any decision).
            await Notify.requestPermission()
        }
    }

    // ── Login (CLI-token consent flow, app-scheme variant) ────────────────

    func login() async {
        let state = Self.randomState()
        let url = URL(string: "\(Self.apiUrl)/auth/cli?scheme=tinyapp&state=\(state)")!

        do {
            let callback = try await webAuth(url: url, scheme: "tinyapp")
            guard let comps = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                  let code = comps.queryItems?.first(where: { $0.name == "code" })?.value,
                  let gotState = comps.queryItems?.first(where: { $0.name == "state" })?.value,
                  gotState == state else { return }

            var req = URLRequest(url: URL(string: "\(Self.apiUrl)/api/auth/cli/token")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "state": state])
            let (data, _) = try await URLSession.shared.data(for: req)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tok = obj["token"] as? String else { return }

            Keychain.set("tiny_token", tok)
            token = tok
            WatchBridge.shared.sync(token: tok)
            await loadMe()
            await enrollDeviceIfNeeded()
            startDeviceLoops()
            // Right after "this phone is now a device" is the one moment the
            // notification ask makes sense to a human
            await Notify.requestPermission()
        } catch { /* user cancelled — stay on login */ }
    }

    func logout() {
        stopDeviceLoops()
        Keychain.delete("tiny_token")
        Keychain.delete("tiny_device_id")
        Keychain.delete("tiny_device_token")
        token = nil; user = nil; deviceId = nil
        // 🏅 The prior user's allowance must not outlive their session: this is a
        // persistent @StateObject, so without the reset a sign-out leaves
        // Settings quoting THEIR earned window to whoever signs in next (and to
        // the signed-out state, where the window is shared and personal numbers
        // are meaningless). Same reasoning as the unread/widget scrubs below.
        standing = nil
        // Reset unread state: TinySession is a persistent @StateObject, so
        // without this a sign-out-then-in-as-another-user keeps unreadPrimed
        // (the next poll banners THEIR existing unread as "new") and leaves a
        // stale app-icon badge sitting over the logged-out state.
        unreadPrimed = false
        unreadDms = 0
        unreadByLogin = [:]
        // Events unread is a per-user high-water mark — reset the live count
        // (the persisted seen-id belongs to the prior user; a fresh sign-in
        // re-primes it against the new user's ring on the next poll).
        unreadEvents = 0
        Task { await Notify.setBadge(0) }
        // Scrub the app-group snapshot the home-screen widgets render from:
        // Last answer / Memories / Followup read WidgetStore directly and the
        // stopped loops won't overwrite it, so without this the prior user's
        // identity lingers on the home screen after sign-out (or bleeds into
        // the next user). Same tested scrub the watch runs on remote-logout —
        // keeps harmless fleet counts, wipes identity content.
        WidgetStore.write(WatchCore.loggedOut(WidgetStore.read(), now: Date()))
        WidgetCenter.shared.reloadAllTimelines()
        WatchBridge.shared.sync(token: nil)
        // Drop in-memory chat state that outlives this session. ChatModel is a
        // ChatView @StateObject this class can't reach, so it observes instead.
        //
        // The OFFLINE QUEUE is the reason this matters on a plain sign-out, not
        // only an account switch: `flushQueue` reads `session.token` at CALL
        // time, and nothing ever cleared the queue — so a message user A typed
        // while offline was sent under user B's token on the next reconnect.
        // Sign-out is the earliest point at which we know it must not be sent.
        //
        // Transcripts on disk are deliberately NOT deleted here: signing back
        // in as the SAME user should keep their history (the scrub in loadMe()
        // fires only on a real identity change, for exactly that reason).
        NotificationCenter.default.post(name: .tinySessionEnded, object: nil)
    }

    private func webAuth(url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            // @Sendable: without it the closure inherits @MainActor isolation —
            // fine on iOS (AS calls back on main) but Mac Catalyst delivers the
            // callback on a background queue and the runtime isolation check
            // traps. cont.resume is thread-safe from any queue.
            let sess = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { @Sendable cb, err in
                if let cb { cont.resume(returning: cb) }
                else { cont.resume(throwing: err ?? URLError(.userCancelledAuthentication)) }
            }
            sess.presentationContextProvider = self
            sess.prefersEphemeralWebBrowserSession = false
            sess.start()
        }
    }

    private func loadMe() async {
        guard let d: [String: Any] = try? await Api.get("/api/me", token: token),
              let u = d["user"] as? [String: Any] else { return }
        let login = u["login"] as? String ?? "?"
        user = (login, u["name"] as? String ?? "")
        // 🏅 Free rides along on the probe we already make. Set before the
        // identity-change guard below returns, so a malformed `user.login`
        // doesn't also cost us the allowance — the two fields fail
        // independently, and nil is a safe value for this one either way.
        standing = Standing.parse(d["standing"])
        // Cross-user identity leak: local continuity (turn log + memories) is
        // keyed by the device-level tiny name, not per-user, and never re-syncs
        // from the server. If a DIFFERENT account signs in on this device, wipe
        // it so the prior user's private turns/facts don't bleed into the new
        // user's buildContext. Scrub ONLY on a real change — same-user re-login
        // (e.g. after a token expiry) keeps their continuity, and a first login
        // (no anchor yet) just records the anchor. Mirrors the widget-snapshot
        // scrub that logout() already does via WatchCore.loggedOut.
        // Only a real login participates — a "?" fallback from a malformed
        // /api/me must neither be recorded as an anchor nor trigger a false
        // scrub against the prior real user.
        guard login != "?", !login.isEmpty else { return }
        let store = UserDefaults(suiteName: WidgetStore.suite) ?? .standard
        let key = "last_user_login"
        let prev = store.string(forKey: key)
        if let prev, !prev.isEmpty, prev != login {
            Continuity.scrubAllLocal()
            WidgetStore.write(WatchCore.loggedOut(WidgetStore.read(), now: Date()))
            WidgetCenter.shared.reloadAllTimelines()
        }
        store.set(login, forKey: key)
    }

    // ── Device node ───────────────────────────────────────────────────────

    private func enrollDeviceIfNeeded() async {
        guard Keychain.get("tiny_device_id") == nil else { return }
        // Device-aware name: the iPad must NOT enroll as "-iphone" or
        // use_device targeting ("tell my iPad…") can't tell devices apart.
        // (Wrong-named rows heal: revoke at /devices → self-re-enroll renames.)
        let model = UIDevice.current.model.lowercased().contains("ipad") ? "ipad" : "iphone"
        let name = "\(user?.login ?? "user")-\(model)"
        guard let d: [String: Any] = try? await Api.post("/api/devices", token: token, body: [
            "name": name, "platform": "ios-arm64", "kind": "daemon",
            "capabilities": Self.capabilities,
        ]),
        let id = d["device_id"] as? String, let devTok = d["device_token"] as? String else { return }
        Keychain.set("tiny_device_id", id)
        Keychain.set("tiny_device_token", devTok)
        deviceId = id
    }

    /// Revoked row self-heal: forget the dead creds, enroll a fresh device,
    /// restart the loops. Signed-in session token is all that's needed.
    private func reEnroll() async {
        guard token != nil else { return }
        Keychain.delete("tiny_device_id")
        Keychain.delete("tiny_device_token")
        deviceId = nil
        if user == nil { await loadMe() }
        await enrollDeviceIfNeeded()
        if Keychain.get("tiny_device_id") != nil {
            startDeviceLoops()
            await Notify.post(title: "Device re-enrolled",
                              body: "This phone's fleet registration was revoked — it re-joined automatically.")
        }
    }

    func startDeviceLoops() {
        stopDeviceLoops()
        guard let id = Keychain.get("tiny_device_id"),
              let devTok = Keychain.get("tiny_device_token") else { return }

        // Presence heartbeat (30s) — doubles as the DM unread poll (web
        // MessagesHUD polls too; same cadence class)
        heartbeatTask = Task {
            // First beat re-asserts capabilities (worker heartbeat COALESCEs
            // them) — enrollments that predate a capability self-heal
            var assertCaps = true
            var beat = 0
            // The Flipper link comes and goes, so its capability has to be
            // re-asserted on every transition — `assertCaps` alone fires once at
            // launch, which would leave the phone claiming a board it dropped an
            // hour ago (or hiding one it just picked up).
            var hadFlipper = FlipperGateway.shared.linked
            // "unknown device" = our row was revoked (e.g. cleaned up on
            // /devices). Two consecutive → the token is truly dead, not a
            // blip: drop creds and re-enroll, else the phone is silently
            // off the fleet forever.
            var unknownStreak = 0
            while !Task.isCancelled {
                var body: [String: Any] = ["deviceId": id, "token": devTok]
                let hasFlipper = FlipperGateway.shared.linked
                if hasFlipper != hadFlipper { assertCaps = true; hadFlipper = hasFlipper }
                if assertCaps { body["capabilities"] = Self.beatCapabilities; assertCaps = false }
                // The worker's "unknown device" reply rides a 401, which
                // Api.request throws BEFORE the body is readable — the old
                // `try? … ?? [:]` swallowed it and the self-heal never fired.
                // Any 401/404 here is device-auth death (the beat carries no
                // user JWT), so count it as a strike; other errors are
                // transient network and don't count.
                do {
                    let resp = try await Api.postRaw("/api/devices/heartbeat", body: body)
                    if (resp["error"] as? String)?.contains("unknown device") == true {
                        unknownStreak += 1
                    } else if resp["ok"] as? Bool == true {
                        unknownStreak = 0
                    }
                } catch ApiError.http(401, _), ApiError.http(404, _) {
                    unknownStreak += 1
                } catch { }
                if unknownStreak >= 2 {
                    await reEnroll()
                    return // reEnroll restarts fresh loops with new creds
                }
                await refreshUnread()
                await pollEventsUnread()
                // Fleet counts for the home/lock-screen widget — every 10th
                // beat (~5min) is fresh enough for a glance surface
                if beat % 10 == 0 { await refreshFleetWidget() }
                beat += 1
                // Low Power Mode: stretch the beat but stay inside the 60s
                // presence window so the device doesn't flicker offline
                try? await Task.sleep(for: .seconds(ProcessInfo.processInfo.isLowPowerModeEnabled ? 45 : 30))
            }
        }

        // Relay poll (5s): the web agent's use_device invoke lands here.
        // The phone answers with the SERVER agent (no local shell on iOS) —
        // it proxies the prompt through /api/chat as the user's tiny.
        relayTask = Task {
            while !Task.isCancelled {
                // Low Power Mode: 15s relay latency beats a dead battery
                try? await Task.sleep(for: .seconds(ProcessInfo.processInfo.isLowPowerModeEnabled ? 15 : 5))
                guard let d: [String: Any] = try? await Api.putJson("/api/devices/relay", body: ["deviceId": id, "token": devTok, "max": 3]),
                      let msgs = d["messages"] as? [[String: Any]], !msgs.isEmpty else { continue }
                for m in msgs {
                    guard let envId = m["id"] as? String,
                          let payloadStr = m["payload"] as? String,
                          let payload = try? JSONSerialization.jsonObject(with: Data(payloadStr.utf8)) as? [String: Any]
                    else { continue }

                    // 🔔 Push mirror. The worker turns EVERY web push (new DM,
                    // job result, tiny visit) into a {type:"notify"} relay
                    // envelope per fresh device (push.ts relayPushToDevices),
                    // because native apps have no web-push subscription — the
                    // relay poll IS the push rail on iOS.
                    //
                    // This loop used to `continue` on anything that wasn't an
                    // invoke. And the poll CLAIMS each envelope it returns
                    // (RELAY_MARK_SQL, compare-and-swap on delivered=0), so a
                    // skipped notify was not deferred — it was consumed and
                    // gone. Android has bannered these since day one
                    // (FleetManager.handleEnvelope → RelayNotifier); iOS
                    // silently ate them, which is why a job finishing while the
                    // app sat idle produced nothing on the phone.
                    if payload["type"] as? String == "notify" {
                        await Self.handleNotifyEnvelope(payload) { await self.refreshUnread() }
                        continue
                    }

                    // 🎙️ {type:"record"} — the worker's nicla_voice_record tool.
                    // Handled HERE and in backgroundBeat: the poll claims
                    // envelopes (CAS delivered=0→1), so an unhandled type is
                    // consumed and destroyed, not retried.
                    if payload["type"] as? String == "record" {
                        let secs = payload["seconds"] as? Int ?? 10
                        let reason = (payload["reason"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "web agent"
                        relayActivity = "🎙️ recording \(secs)s for the web agent…"
                        let res = await NiclaRecorder.shared.record(
                            seconds: secs, label: reason, token: token)
                        var reply: [String: Any]
                        if res.ok {
                            reply = ["result": res.transcript.isEmpty
                                ? "🎙️ recorded \(res.seconds)s — heard nothing (silence)"
                                : "🎙️ recorded \(res.seconds)s — “\(String(res.transcript.prefix(600)))”"]
                            reply["transcriptId"] = res.transcriptId
                            if let u = res.audioUrl { reply["audioUrl"] = u }
                        } else {
                            reply = ["result": "recording failed: \(res.error ?? "unknown")"]
                        }
                        _ = try? await Api.patchJson("/api/devices/relay", body: [
                            "deviceId": id, "token": devTok, "inReplyTo": envId,
                            "payload": reply,
                        ])
                        relayActivity = "✅ replied to web agent"
                        continue
                    }

                    // 🐬 {type:"flipper"} — a flipper_* tool routed to this phone
                    // because it holds the BLE link and no cable does. Same
                    // claim-on-poll rule as {type:"record"}, and it MUST stay
                    // above the invoke branch: a Flipper ask that fell through
                    // to /api/chat would hand the agent flipper_status again,
                    // which resolves this phone again.
                    if payload["type"] as? String == "flipper" {
                        relayActivity = "🐬 Flipper \(payload["action"] as? String ?? "status") for the web agent…"
                        let reply = await Self.handleFlipperEnvelope(payload)
                        _ = try? await Api.patchJson("/api/devices/relay", body: [
                            "deviceId": id, "token": devTok, "inReplyTo": envId,
                            "payload": reply,
                        ])
                        relayActivity = "✅ replied to web agent"
                        continue
                    }

                    guard payload["type"] as? String == "invoke",
                          let prompt = payload["prompt"] as? String else { continue }

                    relayActivity = "📡 web agent asked: \(prompt.prefix(60))…"
                    let answer: String
                    // ⚡ Status pings answer locally in <1s — proxying a
                    // "are you alive" through the full /api/chat agent ate
                    // 20-30s of the caller's 45s wait window
                    if prompt.range(of: "\\b(ping|alive|are you there|status|battery)\\b", options: [.regularExpression, .caseInsensitive]) != nil {
                        let dev = UIDevice.current
                        dev.isBatteryMonitoringEnabled = true
                        let battery = dev.batteryLevel >= 0 ? "\(Int(dev.batteryLevel * 100))%" : "unknown"
                        let charging = dev.batteryState == .charging || dev.batteryState == .full ? " ⚡" : ""
                        let thermal: String
                        switch ProcessInfo.processInfo.thermalState {
                        case .nominal: thermal = "nominal"
                        case .fair: thermal = "fair"
                        case .serious: thermal = "serious 🌡️"
                        case .critical: thermal = "CRITICAL 🌡️"
                        @unknown default: thermal = "unknown"
                        }
                        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled ? ", Low Power Mode" : ""
                        var storage = "unknown"
                        if let vals = try? URL(fileURLWithPath: NSHomeDirectory())
                            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
                           let free = vals.volumeAvailableCapacityForImportantUsage {
                            storage = String(format: "%.1f GB free", Double(free) / 1_000_000_000)
                        }
                        let up = ProcessInfo.processInfo.systemUptime
                        let uptime = up > 86_400 ? String(format: "%.1fd", up / 86_400) : String(format: "%.1fh", up / 3_600)
                        answer = "📱 \(dev.name) — alive. iOS \(dev.systemVersion), battery \(battery)\(charging)\(lowPower), thermal \(thermal), \(storage), up \(uptime), unread DMs: \(unreadDms)."
                    }
                    // 🗣️ Announce intent — the fleet can make this device talk:
                    // "tell my iPad to say dinner is ready". Local answer, no
                    // chat proxy; the shipped Speech engine does the voicing.
                    else if prompt.range(of: "\\b(say|announce)\\b", options: [.regularExpression, .caseInsensitive]) != nil {
                        let text = Self.announceText(from: prompt)
                        if text.isEmpty {
                            answer = "Nothing to say — put the message after 'say' (quotes work too)."
                        } else if Config.isQuietNow {
                            answer = "🤫 Quiet hours on \(await UIDevice.current.name) (10pm–8am) — staying silent. The message was: “\(text.prefix(120))”"
                        } else {
                            Speech.shared.speak(text, id: "relay-announce")
                            answer = "🗣️ \(await UIDevice.current.name) said it aloud: “\(text.prefix(120))”"
                        }
                    }
                    // 🎵 Spotify intent — a real device action, no chat proxy:
                    // open the search deep-link (foreground only; iOS forbids
                    // launching apps from a backgrounded process)
                    else if prompt.range(of: "spotify", options: .caseInsensitive) != nil,
                       let url = Media.searchURL(Media.musicQuery(from: prompt)) {
                        if UIApplication.shared.applicationState == .active {
                            await UIApplication.shared.open(url)
                            relayActivity = "🎵 opened Spotify for the web agent"
                            answer = "🎵 Opened Spotify on the phone: \(url.absoluteString)"
                        } else {
                            answer = "The tiny app isn't in the foreground on the phone, so it can't open Spotify right now. The search link: \(url.absoluteString)"
                        }
                    } else {
                        // Radio context the server can't see: prompts about
                        // nearby/bluetooth get a live BLE scan appended
                        var context = ""
                        if prompt.range(of: "bluetooth|nearby|ble\\b|around (me|us|the phone)|devices around", options: [.regularExpression, .caseInsensitive]) != nil {
                            relayActivity = "📡 scanning Bluetooth for the web agent…"
                            context = "\n\n[Live Bluetooth scan from this phone]\n" + (await Bluetooth.shared.scanSummary())
                        }
                        // Motion/steps questions get a live sensor snapshot
                        if prompt.range(of: "motion|moving|orientation|steps|shake|accel|still\\b|face (up|down)", options: [.regularExpression, .caseInsensitive]) != nil {
                            relayActivity = "📡 reading motion sensors for the web agent…"
                            context += "\n\n[Live motion snapshot from this phone]\n" + (await Motion.shared.snapshot())
                        }
                        // 📍 Where/speed questions get a live fix (same
                        // `### Location` grammar every client injects); the
                        // Motion/Bluetooth degrade contract — never blocks.
                        if prompt.range(of: "location|where\\b|coordinates|latitude|longitude|speed|heading|konum|nerede|hız", options: [.regularExpression, .caseInsensitive]) != nil {
                            relayActivity = "📍 reading location for the web agent…"
                            let block = await Geo.shared.current().map(Geo.contextBlock)
                            context += "\n\n[Live location from this phone]\n" +
                                (block?.isEmpty == false ? block! : "Location permission not granted on the phone.")
                        }
                        // Answer with phone context via the chat loop —
                        // continuity included, so the relay answer knows what
                        // the user has told their tiny on this phone. The
                        // device-actions audit (P4) rides the reply: truncate
                        // the answer FIRST so the audit survives a chatty one
                        // (6500 + ≤400 audit stays inside the 7000 reply cap).
                        let audit = DeviceActionAudit.Box()
                        let raw = (try? await Api.chatOnce(
                            token: token,
                            message: "[Executing on \(await UIDevice.current.name), iOS] \(prompt)\(context)",
                            extraSystem: Continuity.buildContext(Config.tinyName),
                            onEvent: { if let line = await Self.runDeviceEvent($0, token: self.token) { await audit.add(line) } }
                        )) ?? "device error"
                        answer = String(raw.prefix(6500)) + (await audit.render())
                    }
                    _ = try? await Api.patchJson("/api/devices/relay", body: [
                        "deviceId": id, "token": devTok, "inReplyTo": envId,
                        "payload": ["result": String(answer.prefix(7000))],
                    ])
                    logRelay(prompt: prompt, result: answer)
                    relayActivity = "✅ replied to web agent"
                    // The strip is a moment, not a status — fade it out
                    // unless another invoke replaced it meanwhile
                    Task { [weak self] in
                        try? await Task.sleep(for: .seconds(12))
                        if self?.relayActivity == "✅ replied to web agent" { self?.relayActivity = "" }
                    }
                }
            }
        }
    }

    func stopDeviceLoops() {
        heartbeatTask?.cancel(); heartbeatTask = nil
        relayTask?.cancel(); relayTask = nil
    }

    /// Unread DM total → menu label, app badge, and a banner when it grows.
    /// The FIRST poll after launch only primes the count — yesterday's
    /// unread messages are not "new", they don't deserve a banner.
    private var unreadPrimed = false
    private var unreadByLogin: [String: Int] = [:]
    func refreshUnread() async {
        guard token != nil else { return }
        guard let d: [String: Any] = try? await Api.get("/api/messages", token: token),
              let threads = d["threads"] as? [[String: Any]] else { return }
        let total = threads.reduce(0) { $0 + (($1["unread"] as? Int) ?? 0) }
        // Banner the thread whose count actually GREW since the last poll, not
        // just the first thread with any unread — otherwise two senders between
        // polls fire one banner that may credit the wrong @login. Compare
        // per-login against the prior snapshot.
        var next: [String: Int] = [:]
        var grew: [(login: String, body: String)] = []
        for t in threads {
            guard let login = t["login"] as? String else { continue }
            let u = (t["unread"] as? Int) ?? 0
            next[login] = u
            if unreadPrimed, u > (unreadByLogin[login] ?? 0) {
                grew.append((login, t["lastBody"] as? String ?? "New message"))
            }
        }
        if unreadPrimed {
            for g in grew {
                await Notify.post(title: "@\(g.login)", body: String(g.body.prefix(120)),
                                  category: "DM", userInfo: ["login": g.login])
            }
        }
        unreadByLogin = next
        unreadPrimed = true
        unreadDms = total
        await Notify.setBadge(total)
        publishWidgetSnapshot()
    }

    /// ⚡ Activity unread — count ring entries newer than the seen high-water
    /// mark. Mirrors web ActivityHUD: silent on failure and NEVER zeroes a
    /// live badge on a blip (only a successful, ok:true read updates it), so a
    /// transient outage can't wipe a real count. Piggybacks the heartbeat.
    func pollEventsUnread() async {
        guard token != nil,
              let d: [String: Any] = try? await Api.get("/api/events", token: token),
              (d["ok"] as? Bool) == true,
              let events = d["events"] as? [[String: Any]] else { return }
        let seen = UserDefaults.standard.integer(forKey: Self.eventsSeenKey)
        let unread = events.reduce(0) { acc, e in
            let id = (e["id"] as? NSNumber)?.intValue ?? (e["id"] as? Int) ?? 0
            return acc + (id > seen ? 1 : 0)
        }
        unreadEvents = unread
    }

    /// Opening the Activity sheet marks everything currently in the ring seen
    /// (web's markSeen: persist the max id, zero the badge).
    func markEventsSeen(maxId: Int) {
        if maxId > UserDefaults.standard.integer(forKey: Self.eventsSeenKey) {
            UserDefaults.standard.set(maxId, forKey: Self.eventsSeenKey)
        }
        unreadEvents = 0
    }

    // ── Widget bridge (app group) ─────────────────────────────────────────

    /// Fleet counts for TinyWidgets — cheap GET, called every ~5min.
    func refreshFleetWidget() async {
        guard token != nil,
              let d: [String: Any] = try? await Api.get("/api/devices", token: token),
              let devices = d["devices"] as? [[String: Any]] else { return }
        let online = devices.filter { ($0["online"] as? Bool) ?? (($0["online"] as? Int) == 1) }.count
        fleetOnline = online
        fleetTotal = devices.count
        publishWidgetSnapshot()
    }

    private var fleetOnline = 0
    private var fleetTotal = 0

    /// Write the app-group snapshot and poke WidgetKit — but only when the
    /// numbers actually moved (reloads are budgeted by the system).
    private func publishWidgetSnapshot() {
        var snap = FleetSnapshot(online: fleetOnline, total: fleetTotal,
                                 unread: unreadDms, login: user?.login ?? "",
                                 updated: Date())
        snap.accentHex = UserDefaults.standard.string(forKey: "cfg_accent_hex").flatMap { $0.isEmpty ? nil : $0 }
        let old = WidgetStore.read()
        // Preserve content fields other writers own (last exchange, memories,
        // followup) — a fleet-numbers refresh must not blank the widgets
        snap.lastQ = old.lastQ; snap.lastA = old.lastA; snap.lastAt = old.lastAt
        snap.memories = old.memories
        snap.followup = old.followup; snap.followupAt = old.followupAt
        if old.online == snap.online, old.total == snap.total, old.unread == snap.unread,
           old.accentHex == snap.accentHex,
           old.updated > Date(timeIntervalSinceNow: -20 * 60) {
            return
        }
        // Keep known-good fleet counts when only unread changed pre-fetch
        if snap.total == 0, old.total > 0 { snap.online = old.online; snap.total = old.total }
        WidgetStore.write(snap)
        WidgetCenter.shared.reloadAllTimelines()
        // Same numbers ride to the watch → complications refresh phone-side
        WatchBridge.shared.snapshot = snap
        WatchBridge.shared.sync(token: token)
    }

    /// Relay-side device-tool execution: the web agent's vibrate/flashlight/
    /// clipboard/speak calls act on THIS phone even though the answer is
    /// proxied through chatOnce (which otherwise only collects text).
    /// Returns one AUDIT line naming what actually happened (nil for
    /// non-action events) — the relay reply appends these so the web-side
    /// agent reports ground truth, not the proxied model's optimism
    /// (use_device P4; Android FleetManager parity).
    nonisolated static func runDeviceEvent(_ ev: Api.ChatEvent, token: String?) async -> String? {
        switch ev {
        case .vibrate(let pattern, let times, let intensity):
            await MainActor.run { Haptic.shared.play(pattern: pattern, times: times, intensity: intensity) }
            return DeviceActionAudit.toolLine("vibrate", ran: true)
        case .flashlight(let mode, let times, let seconds):
            await MainActor.run { Torch.shared.run(mode: mode, times: times, seconds: seconds) }
            return DeviceActionAudit.toolLine("flashlight", ran: true)
        case .deviceAction(let name, let argsJson):
            return await MainActor.run { () -> String? in
                DeviceTools.shared.handle(name: name, argsJson: argsJson)
                if name == "open_url" {
                    // The audit re-derives the exact silent-failure layer
                    // (scheme refused / backgrounded) the execution hit.
                    return DeviceActionAudit.openURLLine(
                        argsJson: argsJson,
                        foreground: UIApplication.shared.applicationState == .active)
                }
                return DeviceActionAudit.toolLine(name, ran: DeviceTools.names.contains(name))
            }
        case .speak(_, let text, let voice):
            return await MainActor.run { () -> String? in
                // Remote voice respects quiet hours; vibrate stays allowed
                let quiet = Config.isQuietNow
                if !quiet { Speech.shared.speak(text, id: "relay-speak", voice: voice) }
                return DeviceActionAudit.speakLine(spoke: !quiet, quiet: quiet)
            }
        // 🔁 ROUND-TRIP tools (use_device P5): the proxied turn's server
        // callback is blocked polling the tool-result mailbox — exactly like
        // main chat — so run the SAME executors (each posts an outcome on
        // EVERY path, success or honest failure) and "use my iPhone to …"
        // from the web gets the real thing. Returned images are discarded:
        // the server already received them via the mailbox and weaves them
        // into the proxied turn's text.
        case .generateImage(let id, let prompt, let style):
            _ = await ImageGen.shared.run(toolUseId: id, prompt: prompt, style: style, token: token)
            return DeviceActionAudit.toolLine("generate_image", ran: true)
        case .screenshot(let id, let reason):
            // 📸 Remote consent (docs/remote-screenshot-consent-design-2026-08-02).
            // The web agent asked THIS phone for its screen. Ask the human here
            // — but DISPATCH, never await: this runs inside the relay poll
            // loop's iteration, and that loop claims the {type:"notify"}
            // envelopes that are iOS's entire push transport. Parking it on an
            // unanswered alert would silently cost the user their pushes for as
            // long as the prompt sat there. So the alert's own buttons post the
            // outcome (allow → capture+upload, deny → {denied:true}) into the
            // tool-result mailbox the server callback is already polling for
            // 90s — the same fire-and-forget contract Android's consent
            // activity has always used.
            return await MainActor.run { () -> String? in
                // Backgrounded is not a promptable state and not a capturable
                // one: iOS won't present an alert for a background app, and
                // ReplayKit records the FOREGROUND app's UI — so there would be
                // nothing on screen to hand back even with consent. Fast honest
                // failure keeps the server's poll from stranding (G7).
                guard UIApplication.shared.applicationState == .active else {
                    Task { await postToolFailure(id, token: token,
                        error: "Screen capture needs the phone in the foreground — its consent prompt can't be shown from the background. Ask the user to open the tiny app first.") }
                    return DeviceActionAudit.backgroundedLine("screenshot")
                }
                let shown = Screenshot.shared.askRemoteConsent(
                    toolUseId: id, token: token, reason: reason, tiny: Config.tinyName)
                guard shown else {
                    // Active but no key window to present in (a scene mid-launch
                    // or mid-transition). Nobody will ever tap, so say so now.
                    Task { await postToolFailure(id, token: token,
                        error: "Screen capture couldn't ask for permission on the phone right now — no window was ready. Ask the user to open the tiny app and try again.") }
                    return DeviceActionAudit.droppedLine("screenshot")
                }
                return DeviceActionAudit.consentLine("screenshot")
            }
        case .metaTakePhoto(let id):
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            _ = await WearablesManager.shared.runPhotoTool(toolUseId: id, token: token)
            return DeviceActionAudit.toolLine("meta_take_photo", ran: true)
            #else
            await postToolFailure(id, token: token, error: "Meta glasses aren't supported on this device.")
            return DeviceActionAudit.droppedLine("meta_take_photo")
            #endif
        case .metaRecordVideo(let id):
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            await GlassesRecorder.shared.runTool(toolUseId: id, token: token)
            return DeviceActionAudit.toolLine("meta_record_video", ran: true)
            #else
            await postToolFailure(id, token: token, error: "Meta glasses aren't supported on this device.")
            return DeviceActionAudit.droppedLine("meta_record_video")
            #endif
        case .metaListen(let id, let seconds):
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            await GlassesListener.shared.runTool(toolUseId: id, seconds: seconds, token: token)
            return DeviceActionAudit.toolLine("meta_listen", ran: true)
            #else
            await postToolFailure(id, token: token, error: "Meta glasses aren't supported on this device.")
            return DeviceActionAudit.droppedLine("meta_listen")
            #endif
        case .metaGlassesStatus(let id):
            #if canImport(MWDATCore) && canImport(MWDATCamera)
            // Serialize INSIDE the MainActor hop — [String: Any] isn't
            // Sendable, so only the finished JSON string crosses isolation.
            let json = await MainActor.run { () -> String in
                let facts = WearablesManager.shared.statusFacts()
                return (try? JSONSerialization.data(withJSONObject: facts))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"ok":true}"#
            }
            _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
                "toolUseId": id, "payload": json,
            ]) as [String: Any]
            return DeviceActionAudit.toolLine("meta_glasses_status", ran: true)
            #else
            _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
                "toolUseId": id,
                "payload": #"{"ok":true,"linked":false,"note":"glasses unsupported on this device"}"#,
            ]) as [String: Any]
            return DeviceActionAudit.toolLine("meta_glasses_status", ran: true)
            #endif
        default:
            return nil
        }
    }

    /// Fast honest outcome for a round-trip tool the relay path can't run —
    /// the server callback polls the tool-result mailbox and, with nothing
    /// posted, strands for its full 90s (design G7). Posting within one poll
    /// tick turns that into an immediate, explainable error. Error strings
    /// are static literals here — no JSON escaping hazards.
    nonisolated private static func postToolFailure(_ toolUseId: String, token: String?, error: String) async {
        _ = try? await Api.post("/api/chat/tool-result", token: token, body: [
            "toolUseId": toolUseId,
            "payload": "{\"ok\":false,\"error\":\"\(error)\"}",
        ]) as [String: Any]
    }

    /// One background beat (BGAppRefresh window, ~30s): heartbeat + answer at
    /// most ONE pending invoke. nonisolated static — runs from the BG task
    /// with no UI state; creds come straight from the Keychain.
    /// What this phone can do — enrolls with it, re-asserts it on heartbeats.
    /// The model reads this from use_device action:'list' and reasons from it
    /// ("only advertises chat+bluetooth_scan+location, so it can't open apps"
    /// — the canonical mis-inference, use_device P4/P5). Capability = the
    /// software path exists; runtime preconditions (grants, glasses linked,
    /// foreground) are reported honestly at invoke time by the audit.
    ///   location  = live CoreLocation fix (grant-gated)  · record = Nicla recorder
    ///   speak     = on-device TTS (quiet-hours gated)
    ///   open_app  = open_url incl. mailto/message/maps/spotify (foreground-gated)
    ///   image_gen = on-device Image Playground (needs Apple Intelligence)
    ///   glasses   = meta_* bridges (honest "not linked" when absent)
    ///   screenshot = ReplayKit capture behind a per-capture consent prompt the
    ///     relay path now presents itself (foreground-gated; backgrounded says
    ///     so — docs/remote-screenshot-consent-design-2026-08-02.md)
    nonisolated static let capabilities = ["chat", "bluetooth_scan", "location", "record", "speak", "open_app", "image_gen", "glasses", "screenshot"]

    /// What to actually send on a beat: the static set, plus whatever is true
    /// only right now.
    ///
    /// `flipper_ble` is deliberately NOT the label a cabled host declares
    /// (`flipper`). They are different powers over the same board — the cable
    /// speaks the Flipper's text CLI and can capture IR; this phone speaks
    /// protobuf RPC over BLE and cannot. Sharing one label would also make
    /// `flipper_status` resolve THIS phone and send it a prompt-shaped `invoke`,
    /// which the relay loop below proxies straight back through /api/chat —
    /// where the same tool resolves the same phone again. One status check, an
    /// unbounded loop, no answer. See docs/flipper-ble-ios-design.md §4.1.
    nonisolated static var beatCapabilities: [String] {
        FlipperGateway.shared.linked ? capabilities + ["flipper_ble"] : capabilities
    }

    /// 🐬 {type:"flipper"} — the flipper_* tools reaching the board through this
    /// phone's BLE link instead of a USB cable.
    ///
    /// STRUCTURED on purpose: `action` + `args`, never a prompt. See
    /// `beatCapabilities` for what a prompt-shaped envelope would do to itself
    /// here. Shared by the foreground poll and `backgroundBeat()` because the
    /// relay poll CLAIMS envelopes (CAS delivered=0→1) — an envelope handled in
    /// only one loop is destroyed in the other, not deferred.
    nonisolated static func handleFlipperEnvelope(_ payload: [String: Any]) async -> [String: Any] {
        let fg = FlipperGateway.shared
        let action = (payload["action"] as? String ?? "status").lowercased()
        let args = payload["args"] as? [String: Any] ?? [:]
        let path = (args["path"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "/ext"

        guard fg.linked else {
            let paired = fg.unit != nil
            return ["result": paired
                ? "The Flipper is paired with this phone but not connected right now — it's out of range or its Bluetooth is off. Nothing can reach it until it's back."
                : "No Flipper is linked to this phone over Bluetooth. Pair it in the tiny app: Devices → this phone → Find my Flipper."]
        }

        await MainActor.run { fg.activity = "🐬 \(action) for the web agent…" }
        defer { Task { @MainActor in fg.activity = "" } }

        do {
            switch action {
            case "status", "info":
                return ["result": await fg.statusLine()]

            case "files", "ls", "list":
                let entries = try await fg.list(path)
                if entries.isEmpty { return ["result": "📁 \(path): (empty)"] }
                let lines = entries.map { e in
                    e.isDir ? "  📁 \(e.name)/" : "  📄 \(e.name) — \(e.size) bytes"
                }
                return ["result": String(("📁 \(path) (over Bluetooth from this phone):\n"
                    + lines.joined(separator: "\n")).prefix(6500))]

            case "read":
                let data = try await fg.read(path)
                let text = String(data: data, encoding: .utf8)
                if let t = text, !t.contains("\u{FFFD}") {
                    return ["result": String("📄 \(path) (\(data.count) bytes)\n\(t)".prefix(6500))]
                }
                // Not valid UTF-8 → hex, same rule the cable path uses, so a
                // .sub capture reads the same whichever transport fetched it.
                let hex = data.prefix(1024).map { String(format: "%02x", $0) }.joined()
                return ["result": String("📄 \(path) (\(data.count) bytes, binary)\n\(hex)".prefix(6500))]

            case "md5":
                return ["result": "\(path) — md5 \(try await fg.md5(path))"]

            case "alert", "beep", "find":
                try await fg.alert()
                return ["result": "🔔 The Flipper beeped, blinked and buzzed — over Bluetooth from this phone."]

            case "listen", "ir_rx", "subghz_rx", "rfid_read", "ikey_read":
                // Defence in depth: the backend already refuses to route a
                // capture here, and if that ever regresses this must still not
                // answer "nothing received" — which is exactly what a working
                // capture of a silent room looks like.
                return ["result": "Capturing IR, Sub-GHz, RFID or iButton is not possible over Bluetooth — the Flipper's radios are only reachable from its USB serial CLI, which has no receive command over BLE. This needs the Flipper plugged into a machine running the tiny CLI. What this phone CAN do over Bluetooth: status, browse and read the SD card, checksums, and make it beep."]

            default:
                return ["result": "Unknown Flipper action “\(action)”. Over Bluetooth this phone can do: status, files, read, md5, alert."]
            }
        } catch {
            return ["result": "Flipper error: \(error.localizedDescription)"]
        }
    }

    // ── Push mirror: {type:"notify"} relay envelopes ───────────────────────
    //
    // The worker has no web-push subscription for a native app, so it mirrors
    // every push as a relay envelope instead (push.ts relayPushToDevices +
    // buildNotifyEnvelope: {type, title, body, tag, url}). On iOS the relay poll
    // is therefore the ONLY push rail, and the poll CLAIMS what it returns — so
    // an envelope this loop ignores is destroyed, not retried.
    //
    // Routing is by the worker's push TAG, the one naming contract shared with
    // Android's RelayNotifier.classify. Kept byte-comparable to it on purpose:
    // two clients inventing their own routing from the same tags is how one of
    // them ends up double-bannering DMs.

    /// Where a notify envelope should go. `dmPoke` deliberately does NOT banner
    /// from the payload: `refreshUnread()` is the single DM banner path (it
    /// fires on unread GROWTH, per @login, with the inline-reply category), so
    /// bannering here as well would double every DM.
    enum NotifyRoute: Equatable {
        case dmPoke
        case banner
        /// A push with no readable title AND no body — nothing to show a user.
        case ignore
    }

    /// Pure tag→route decision. Mirrors Android RelayNotifier.classify.
    nonisolated static func classifyNotify(tag: String, url: String, title: String, body: String) -> NotifyRoute {
        // `?dm=` is checked as well as the tag because the DM push's url carries
        // it; a future tag rename must not turn DMs into generic banners.
        if tag.hasPrefix("dm-") || url.contains("?dm=") { return .dmPoke }
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .ignore }
        return .banner
    }

    /// Banner a notify envelope, or poke the DM poll. `onDmPoke` is injected so
    /// this is callable from a test without a live session.
    /// `onDmPoke` is `@Sendable`: the caller is a @MainActor session method and
    /// this helper is nonisolated, so the closure crosses an isolation boundary.
    nonisolated static func handleNotifyEnvelope(
        _ payload: [String: Any],
        onDmPoke: @Sendable () async -> Void
    ) async {
        let tag = payload["tag"] as? String ?? ""
        let url = payload["url"] as? String ?? ""
        let title = payload["title"] as? String ?? ""
        let body = payload["body"] as? String ?? ""
        switch classifyNotify(tag: tag, url: url, title: title, body: body) {
        case .dmPoke:
            await onDmPoke()
        case .ignore:
            break
        case .banner:
            // The worker already clamps title/body (buildNotifyEnvelope: 100 /
            // 400); clamp again because this is untrusted-shaped JSON off the
            // wire, and fall back to "tiny" so a body-only push still reads.
            // A redeem turn in the url (?q= — device-result and batch pushes)
            // rides the banner's userInfo, so a TAP lands on the fetched
            // result: Notify delegate → RedeemStash → the ask route (web ?q= /
            // Android c6de2bcc parity).
            let q = Notify.redeemQuery(from: url)
            await Notify.post(
                title: title.isEmpty ? "tiny" : String(title.prefix(100)),
                body: String(body.prefix(400)),
                userInfo: q.map { ["redeemQ": String($0.prefix(2000))] } ?? [:]
            )
        }
    }

    /// "say 'dinner is ready'" / "announce that dinner is ready" → the message.
    /// Quoted text wins; otherwise everything after the keyword (minus filler).
    nonisolated static func announceText(from prompt: String) -> String {
        // Any quoted span is the message verbatim — but quotes must be
        // MATCHED PAIRS: the old single character-class included the bare
        // apostrophe, so "say don't worry, it's fine" matched 't worry, it'
        // between the two contractions. Straight single quotes additionally
        // require word boundaries so apostrophes-in-words never open a span.
        let quotePatterns = [
            "\"([^\"]{1,300})\"",
            "“([^”]{1,300})”",
            "‘([^’]{1,300})’",
            "(?:^|(?<=\\s))'([^']{1,300})'(?=[\\s.,!?;:]|$)",
        ]
        for pattern in quotePatterns {
            if let r = prompt.range(of: pattern, options: .regularExpression) {
                return String(prompt[r].dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        guard let kw = prompt.range(of: "\\b(say|announce)\\b", options: [.regularExpression, .caseInsensitive]) else { return "" }
        var text = String(prompt[kw.upperBound...])
        for filler in ["that ", "aloud ", "out loud ", ": "] {
            while text.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix(filler) {
                text = String(text.trimmingCharacters(in: .whitespaces).dropFirst(filler.count))
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    nonisolated static func backgroundBeat() async {
        guard let id = Keychain.get("tiny_device_id"),
              let devTok = Keychain.get("tiny_device_token") else { return }
        let token = Keychain.get("tiny_token")
        _ = try? await Api.postRaw("/api/devices/heartbeat", body: ["deviceId": id, "token": devTok, "capabilities": capabilities])

        // Keep the app-icon badge + widget unread honest while backgrounded.
        // The foreground poll (refreshUnread) owns the per-login DM *banner*,
        // but it only runs when the app is open — so without this a DM that
        // arrives (or gets read on the web) between opens leaves a stale badge
        // sitting over the logged-out numbers until the next launch. A badge
        // sync is idempotent (setBadge is absolute, not incremental), so unlike
        // a banner it can't double-fire against the foreground baseline. A true
        // background *banner* needs APNs (server work, flagged in the backlog).
        if token != nil,
           let m: [String: Any] = try? await Api.get("/api/messages", token: token),
           let threads = m["threads"] as? [[String: Any]] {
            let total = threads.reduce(0) { $0 + (($1["unread"] as? Int) ?? 0) }
            await Notify.setBadge(total)
            var snap = WidgetStore.read()
            if snap.unread != total {
                snap.unread = total; snap.updated = Date()
                WidgetStore.write(snap)
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        guard let d: [String: Any] = try? await Api.putJson("/api/devices/relay", body: ["deviceId": id, "token": devTok, "max": 1]),
              let msgs = d["messages"] as? [[String: Any]] else { return }
        for m in msgs {
            guard !Task.isCancelled,
                  let envId = m["id"] as? String,
                  let payloadStr = m["payload"] as? String,
                  let payload = try? JSONSerialization.jsonObject(with: Data(payloadStr.utf8)) as? [String: Any]
            else { continue }
            // 🎙️ Same claim-on-poll rule as the foreground loop: a {type:
            // "record"} envelope consumed here must be executed here, or the
            // worker's recording ask silently dies with the claim.
            if payload["type"] as? String == "record" {
                let secs = payload["seconds"] as? Int ?? 10
                let reason = (payload["reason"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "web agent"
                let res = await NiclaRecorder.shared.record(seconds: secs, label: reason, token: token)
                var reply: [String: Any] = ["result": res.ok
                    ? (res.transcript.isEmpty ? "🎙️ recorded — heard nothing (silence)"
                                              : "🎙️ recorded — “\(String(res.transcript.prefix(600)))”")
                    : "recording failed: \(res.error ?? "unknown")"]
                reply["transcriptId"] = res.transcriptId
                if let u = res.audioUrl { reply["audioUrl"] = u }
                _ = try? await Api.patchJson("/api/devices/relay", body: [
                    "deviceId": id, "token": devTok, "inReplyTo": envId, "payload": reply,
                ])
                await Notify.post(title: "Recorded for your tiny",
                                  body: String(res.transcript.prefix(120)))
                continue
            }
            // 🐬 Same rule for the Flipper: this loop runs when the app is
            // backgrounded, which is the MOST likely state for a phone-held
            // Flipper link (board in a pocket, phone in the other one), so
            // this is not the redundant copy — it may be the only one that ever
            // sees the envelope.
            if payload["type"] as? String == "flipper" {
                let reply = await Self.handleFlipperEnvelope(payload)
                _ = try? await Api.patchJson("/api/devices/relay", body: [
                    "deviceId": id, "token": devTok, "inReplyTo": envId, "payload": reply,
                ])
                continue
            }
            guard payload["type"] as? String == "invoke",
                  let prompt = payload["prompt"] as? String else { continue }
            let name = await MainActor.run { UIDevice.current.name }
            // Same P4 audit as the foreground path — a background invoke is
            // MORE likely to hit the silent layers (open_url can't launch
            // apps at all back here), so honesty matters most on this rail.
            let audit = DeviceActionAudit.Box()
            let raw = (try? await Api.chatOnce(
                token: token,
                message: "[Executing on \(name), iOS, background] \(prompt)",
                extraSystem: Continuity.buildContext(Config.tinyName),
                onEvent: { if let line = await Self.runDeviceEvent($0, token: token) { await audit.add(line) } }
            )) ?? "device error"
            let answer = String(raw.prefix(6500)) + (await audit.render())
            _ = try? await Api.patchJson("/api/devices/relay", body: [
                "deviceId": id, "token": devTok, "inReplyTo": envId,
                "payload": ["result": String(answer.prefix(7000))],
            ])
            // The app was asleep when this happened — leave a trace
            await Notify.post(
                title: "Web agent reached your phone",
                body: String(prompt.prefix(120))
            )
        }
    }

    private static func randomState() -> String {
        let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        return String((0..<32).map { _ in chars.randomElement()! })
    }
}

extension TinySession: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // iOS asks on the main thread; Mac Catalyst may ask from a background
        // queue (same dry-run path that broke webAuth's callback), where a bare
        // assumeIsolated would trap — hop instead of assert.
        let anchor: @MainActor () -> ASPresentationAnchor = {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
        if Thread.isMainThread { return MainActor.assumeIsolated { anchor() } }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { anchor() } }
    }
}
