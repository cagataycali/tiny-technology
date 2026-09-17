/**
 * 🤖 BodyLive — two robot BODIES as live surfaces in this app, one pattern:
 *
 *   SCOUT  (FrodoBots Earth Rover Mini+, platform "scout-the-rover", https://scout.example.com)
 *   REACHY (Pollen Reachy Mini,          platform "reachy-mini",      https://reachy.example.com)
 *
 * Both are ENDPOINT devices: their own FastAPI dashboards behind Cloudflare,
 * enrolled on tiny.technology with the address in the device row. Everything
 * here reads the address from the row (BodyManager.pick) — nothing hardcoded;
 * with no row on the account the feature stays hidden.
 *
 * Credentials: the tiny session token finds the rows (GET /api/devices). The
 * robots do NOT verify tiny sessions — each has its own service token which
 * the platform stores as the row's `secret` and never echoes. So the owner
 * pastes it once (Keychain "body.<kind>.token"), the ArmLive way. BOTH robots
 * gate their reads (Reachy: passkey session or bearer on /api/state, /api/stream;
 * Scout: bearer on everything but /api/health), so nothing shows before the paste.
 *
 * What the robots serve (docs/BODIES.md, verified 2026-09-17):
 *   SCOUT   GET  /api/health              open
 *           GET  /api/telemetry           gated — battery, signal_level, speed, voltage, current, lamp, orientation, gps…
 *           GET  /api/frame/front|rear    gated — JSON {"front_frame": "<base64 JPEG>"}  (no MJPEG: the panel polls)
 *           POST /api/control             gated — {linear, angular, duration}; server clamps ±1 / ≤3 s, then zeros
 *   REACHY  GET  /api/state               bearer — control_mode, head{pitch,yaw,roll,…}, antennas[right,left], body_yaw
 *           GET  /api/stream?token=       bearer — MJPEG boundary=reachyframe;  GET /api/snapshot.jpg fallback
 *           GET  /api/emotions            bearer — {names:[…]}
 *           POST /api/control/look        bearer — {pitch, yaw, roll, duration} degrees
 *           POST /api/control/antennas    bearer — {right, left, duration} degrees
 *           POST /api/control/express     bearer — {name}
 *           POST /api/control/say         bearer — {text}
 *           POST /api/control/stop|home   bearer
 *
 * SAFETY (the phone's own bounds, tighter than the servers'):
 *   Scout drive: |linear| ≤ 0.4, |angular| ≤ 0.6, duration ≤ 1.0 s — one tap, one bounded move.
 *   STOP is {0,0,0.05} and is never gated on anything but the token.
 *   Reachy look: |pitch|,|yaw| ≤ 25°, |roll| ≤ 15°, duration ≥ 0.6 s.
 *
 * The UI lives in BodyLiveScreen.swift; this file is the model plus the pure
 * functions BodyLiveTests pins.
 */
import SwiftUI
import UIKit

// ── Pure core (unit-tested) ─────────────────────────────────────────────────

enum BodyKind: String, CaseIterable {
    case scout, reachy

    var title: String { self == .scout ? "Scout" : "Reachy" }
    var symbol: String { self == .scout ? "car.side" : "face.smiling" }
    var tokenKey: String { "body.\(rawValue).token" }
}

enum BodyCore {
    // ── Discovery ──
    /// The enrolled rows say platform "scout-the-rover" / "reachy-mini". The capability
    /// pairs are each unique on this account (drive+camera = a rover; look+antennas =
    /// the Reachy head), so a renamed platform does not hide the robot and the arm
    /// (camera+move, no drive) is never mistaken for either.
    static func isScout(platform: String, capabilities: [String]) -> Bool {
        platform == "scout-the-rover" || (capabilities.contains("drive") && capabilities.contains("camera"))
    }
    static func isReachy(platform: String, capabilities: [String]) -> Bool {
        platform == "reachy-mini" || (capabilities.contains("look") && capabilities.contains("antennas"))
    }
    static func matches(_ kind: BodyKind, platform: String, capabilities: [String]) -> Bool {
        kind == .scout ? isScout(platform: platform, capabilities: capabilities)
                       : isReachy(platform: platform, capabilities: capabilities)
    }

    // ── Bounds ──
    static let scoutMaxLinear = 0.4
    static let scoutMaxAngular = 0.6
    static let scoutMaxDuration = 1.0
    static let reachyMaxPitch = 25.0
    static let reachyMaxYaw = 25.0
    static let reachyMaxRoll = 15.0
    static let reachyMinDuration = 0.6
    static let reachyMaxAntenna = 90.0

    private static func clamp(_ v: Double, _ lim: Double) -> Double { max(-lim, min(lim, v)) }

    /// One bounded drive command. NaN/inf become 0 so a broken slider stops the rover.
    static func scoutDrive(linear: Double, angular: Double, duration: Double = 0.6) -> [String: Any] {
        let l = linear.isFinite ? clamp(linear, scoutMaxLinear) : 0
        let a = angular.isFinite ? clamp(angular, scoutMaxAngular) : 0
        let d = duration.isFinite ? max(0.05, min(duration, scoutMaxDuration)) : 0.05
        return ["linear": l, "angular": a, "duration": d]
    }
    static var scoutStop: [String: Any] { ["linear": 0.0, "angular": 0.0, "duration": 0.05] }

    /// Head pose in degrees, clamped to a range that cannot strain the Stewart platform.
    static func reachyLook(pitch: Double, yaw: Double, roll: Double = 0, duration: Double = 0.8) -> [String: Any] {
        let p = pitch.isFinite ? clamp(pitch, reachyMaxPitch) : 0
        let y = yaw.isFinite ? clamp(yaw, reachyMaxYaw) : 0
        let r = roll.isFinite ? clamp(roll, reachyMaxRoll) : 0
        let d = duration.isFinite ? max(reachyMinDuration, min(duration, 5)) : reachyMinDuration
        return ["pitch": p, "yaw": y, "roll": r, "duration": d]
    }
    static func reachyAntennas(right: Double, left: Double, duration: Double = 0.5) -> [String: Any] {
        ["right": right.isFinite ? clamp(right, reachyMaxAntenna) : 0,
         "left": left.isFinite ? clamp(left, reachyMaxAntenna) : 0,
         "duration": max(0.3, min(duration.isFinite ? duration : 0.5, 3))]
    }
    /// Emotion names are the dashboard's own list; anything else is refused client-side.
    static func reachyExpress(_ name: String, allowed: [String]) -> [String: Any]? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return allowed.contains(n) ? ["name": n] : nil
    }
    /// Say: plain text, 1…200 chars. Longer speeches belong to the desktop dashboard.
    static func reachySay(_ text: String) -> [String: Any]? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return ["text": String(t.prefix(200))]
    }

    // ── Frames ──
    /// Scout's /api/frame/{view} answers JSON; the JPEG is base64 under "<view>_frame"
    /// (occasionally with a data: URL prefix or a bare "frame" key). nil when the
    /// rover is offline (`{"error": …}`) or the bytes are not a JPEG.
    static func scoutFrame(_ body: [String: Any], view: String = "front") -> Data? {
        var s = (body["\(view)_frame"] as? String) ?? (body["frame"] as? String) ?? (body["image"] as? String) ?? ""
        if let comma = s.firstIndex(of: ","), s.hasPrefix("data:") { s = String(s[s.index(after: comma)...]) }
        guard !s.isEmpty, let d = Data(base64Encoded: s, options: .ignoreUnknownCharacters),
              d.count > 4, d[d.startIndex] == 0xFF, d[d.startIndex + 1] == 0xD8 else { return nil }
        return d
    }
    /// Reachy's MJPEG: the arm's splitter (SOI..EOI) does the job unchanged.
    static func splitJPEGs(_ buf: Data) -> (frames: [Data], rest: Data) { ArmCore.splitJPEGs(buf) }

    // ── State ──
    static func number(_ any: Any?) -> Double? { EndpointTelemetry.number(any) }

    struct ScoutState: Equatable {
        var battery: Double?
        var signal: Double?
        var speed: Double?
        var voltage: Double?
        var current: Double?
        var lamp: Bool?
        var orientation: Double?
        var gpsFix: Bool?
        var error: String?
    }

    struct ReachyState: Equatable {
        var controlMode: String?
        var pitch: Double?
        var yaw: Double?
        var roll: Double?
        var antennaRight: Double?
        var antennaLeft: Double?
        var bodyYaw: Double?
        var cameraOk: Bool?
        var daemonOk: Bool?
        var error: String?
    }

    /// SDK /data shape (live 2026-09-17): flat numbers; `lamp` 0/1, `gps_signal` 0/1,
    /// latitude 1000 = no fix. An offline rover answers `{"error": …}`.
    static func decodeScout(_ raw: [String: Any]) -> ScoutState {
        ScoutState(battery: number(raw["battery"]),
                   signal: number(raw["signal_level"]),
                   speed: number(raw["speed"]),
                   voltage: number(raw["voltage"]),
                   current: number(raw["current"]),
                   lamp: number(raw["lamp"]).map { $0 > 0 },
                   orientation: number(raw["orientation"]),
                   gpsFix: number(raw["gps_signal"]).map { $0 > 0 } ?? number(raw["fix_quality"]).map { $0 > 0 },
                   error: raw["error"] as? String)
    }

    /// /api/state (and the /api/telemetry alias): head{} in DEGREES, antennas [right, left].
    static func decodeReachy(_ raw: [String: Any]) -> ReachyState {
        let head = raw["head"] as? [String: Any] ?? [:]
        let ant = raw["antennas"] as? [Any] ?? []
        let cam = raw["camera"] as? [String: Any]
        let daemon = raw["daemon"] as? [String: Any]
        return ReachyState(controlMode: raw["control_mode"] as? String,
                           pitch: number(head["pitch"]), yaw: number(head["yaw"]), roll: number(head["roll"]),
                           antennaRight: ant.count > 0 ? number(ant[0]) : nil,
                           antennaLeft: ant.count > 1 ? number(ant[1]) : nil,
                           bodyYaw: number(raw["body_yaw"]),
                           cameraOk: cam.flatMap { ($0["ok"] as? Bool) ?? ($0["enabled"] as? Bool) },
                           daemonOk: daemon.flatMap { ($0["ok"] as? Bool) ?? ($0["reachable"] as? Bool) },
                           error: raw["error"] as? String ?? (raw["last_error"] as? String))
    }

    // ── Devices-sheet projection (EndpointPanel.readings) ──
    /// Shape, not device row: the rover's SDK payload has battery + signal_level, which
    /// no printer/arm/board reports together.
    static func looksLikeScout(_ t: [String: Any]) -> Bool {
        t["battery"] != nil && t["signal_level"] != nil
    }
    /// The Reachy answers head{} with antennas[] — unique on this account.
    static func looksLikeReachy(_ t: [String: Any]) -> Bool {
        t["head"] is [String: Any] && t["antennas"] is [Any]
    }

    private static func deg(_ v: Double?) -> String? { v.map { "\(Int($0.rounded()))°" } }

    static func readings(_ s: ScoutState) -> [TelemetryReading] {
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            if let v = value, !v.isEmpty { out.append(TelemetryReading(label: label, value: v)) }
        }
        add("battery", s.battery.map { "\(Int($0.rounded())) %" })
        add("signal", s.signal.map { "\(Int($0.rounded()))/4" })
        add("speed", s.speed.map { String(format: "%.1f", $0) })
        add("voltage", s.voltage.map { String(format: "%.1f V", $0) })
        add("current", s.current.map { "\(Int($0.rounded())) mA" })
        add("heading", deg(s.orientation))
        add("lamp", s.lamp.map { $0 ? "on" : "off" })
        add("gps", s.gpsFix.map { $0 ? "fix" : "no fix" })
        add("error", s.error)
        return out
    }

    static func readings(_ s: ReachyState) -> [TelemetryReading] {
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            if let v = value, !v.isEmpty { out.append(TelemetryReading(label: label, value: v)) }
        }
        add("motors", s.controlMode)
        if let p = deg(s.pitch), let y = deg(s.yaw) { add("head", "pitch \(p) · yaw \(y)") }
        add("roll", deg(s.roll))
        if let r = deg(s.antennaRight), let l = deg(s.antennaLeft) { add("antennas", "R \(r) · L \(l)") }
        add("body", deg(s.bodyYaw))
        add("camera", s.cameraOk.map { $0 ? "streaming" : "off" })
        add("daemon", s.daemonOk.map { $0 ? "up" : "down" })
        add("error", s.error)
        return out
    }

    // ── Health / refusals ──
    typealias Health = QBrainCore.Health
    static func health(stateAt: Date?, now: Date = Date()) -> Health { QBrainCore.health(stateAt: stateAt, now: now) }

    /// One sentence per refusal, the dashboard's own words when it gives them.
    static func refusal(_ kind: BodyKind, status: Int, body: [String: Any]?) -> String {
        if let detail = body?["detail"] as? [String: Any], let e = detail["error"] as? String { return e }
        if let detail = body?["detail"] as? String { return detail }
        if let e = body?["error"] as? String { return e }
        switch status {
        case 0: return "\(kind.title) did not answer. Tunnel down or the robot is off."
        case 401, 403: return "\(kind.title) did not accept this token."
        case 422: return "\(kind.title) refused that command."
        case 429: return "Too fast — \(kind.title) takes 5 commands a second."
        case 502, 503: return "\(kind.title)'s dashboard is up but the robot is not."
        default: return "\(kind.title) answered \(status)."
        }
    }
}

// ── Manager ─────────────────────────────────────────────────────────────────

struct BodyDevice: Equatable {
    let id: String
    let name: String
    /// The https origin from the device row — the ONLY place the address comes from.
    let url: String
    let kind: BodyKind
}

@MainActor
final class BodyManager: NSObject, ObservableObject {
    static let scout = BodyManager(kind: .scout)
    static let reachy = BodyManager(kind: .reachy)
    static func shared(_ kind: BodyKind) -> BodyManager { kind == .scout ? scout : reachy }

    let kind: BodyKind

    @Published private(set) var device: BodyDevice?
    @Published private(set) var scoutState: BodyCore.ScoutState?
    @Published private(set) var reachyState: BodyCore.ReachyState?
    @Published private(set) var stateAt: Date?
    @Published private(set) var hasToken: Bool
    @Published private(set) var tokenChecking = false
    /// Latest camera frame (JPEG bytes) and when it arrived; `streaming` = MJPEG flowing.
    @Published private(set) var frame: Data?
    @Published private(set) var frameAt: Date?
    @Published private(set) var streaming = false
    @Published private(set) var fps = 0.0
    @Published private(set) var busy = false
    @Published private(set) var emotions: [String] = []
    @Published var toast: String?
    @Published private(set) var open = false
    /// Set by the view from scenePhase. Polls skip (not exit) while false.
    var sceneActive = true

    private var pollTask: Task<Void, Never>?
    private var frameTask: Task<Void, Never>?
    private var streamSession: URLSession?
    private var streamTask: URLSessionDataTask?
    private var streamBuf = Data()
    private var streamRetryAt: Date = .distantPast
    private var fpsWindow: [Date] = []

    private init(kind: BodyKind) {
        self.kind = kind
        self.hasToken = Keychain.get(kind.tokenKey) != nil
        super.init()
    }

    var token: String? { Keychain.get(kind.tokenKey) }
    var health: BodyCore.Health { BodyCore.health(stateAt: stateAt) }
    var readings: [TelemetryReading] {
        switch kind {
        case .scout: return scoutState.map(BodyCore.readings) ?? []
        case .reachy: return reachyState.map(BodyCore.readings) ?? []
        }
    }

    // ── Discovery ───────────────────────────────────────────────────────────

    func discover(sessionToken: String?) async {
        guard let sessionToken else { device = nil; return }
        guard let d: [String: Any] = try? await Api.get("/api/devices", token: sessionToken),
              let rows = d["devices"] as? [[String: Any]] else { return }
        device = Self.pick(rows, kind: kind)
    }

    /// Wire rows → this body, or nil. Static so the test can feed the live shape.
    nonisolated static func pick(_ rows: [[String: Any]], kind: BodyKind) -> BodyDevice? {
        for r in rows {
            guard let id = r["id"] as? String, (r["kind"] as? String) == "endpoint",
                  let url = r["url"] as? String, url.hasPrefix("https://") else { continue }
            let caps = EndpointTelemetry.parseCapabilities(r["capabilities"])
            if BodyCore.matches(kind, platform: r["platform"] as? String ?? "", capabilities: caps) {
                return BodyDevice(id: id, name: r["name"] as? String ?? kind.title,
                                  url: url.hasSuffix("/") ? String(url.dropLast()) : url, kind: kind)
            }
        }
        return nil
    }

    // ── Token ───────────────────────────────────────────────────────────────

    /// Validate against the robot, then keep it. Scout: GET /api/telemetry must answer 200.
    /// Reachy: POST /api/control/stop must answer 200 — the one gated call that moves nothing.
    func saveToken(_ raw: String) async -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, device != nil else { return false }
        tokenChecking = true
        defer { tokenChecking = false }
        let (status, body) = kind == .scout
            ? await request("/api/telemetry", token: t)
            : await request("/api/control/stop", method: "POST", token: t)
        guard status == 200 else {
            toast = BodyCore.refusal(kind, status: status == 0 ? 0 : (status == 200 ? 401 : status), body: body)
            TinyDesign.haptic(.rigid)
            return false
        }
        Keychain.set(kind.tokenKey, t)
        hasToken = true
        TinyDesign.haptic(.light)
        if kind == .reachy { Task { await loadEmotions() } }
        return true
    }

    func forgetToken() {
        Keychain.delete(kind.tokenKey)
        hasToken = false
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /// 🫀 Held by the top-bar strip (TopBarStrip.swift) while this body's row
    /// exists: the loops run so its tile is live BEFORE anyone taps it, and a
    /// screen's `stop()` on dismiss is a no-op — the strip owns the lifetime.
    private(set) var pinned = false
    func pin(_ on: Bool) {
        pinned = on
        if on { start() } else { stop() }
    }

    /// 👁 Cards/screens showing the picture at full rate (BodyPiPOverlay,
    /// BodyLiveScreen). At 0 only the top-bar tile is fed: Reachy's MJPEG is
    /// closed and a snapshot a second stands in; Scout's frame poll slows from
    /// 350 ms to 1 s (TOPBAR-PIP step 6).
    @Published private(set) var viewers = 0
    func retainViewer() { viewers += 1 }
    func releaseViewer() {
        viewers = max(0, viewers - 1)
        if viewers == 0, kind == .reachy { closeStream(); streaming = false }
    }
    static let idleSnapshotEvery: TimeInterval = 1
    static let scoutFrameEveryMs = 350
    static let scoutIdleFrameEveryMs = 1000

    func start() {
        guard !open, device != nil else { return }
        open = true
        pollTask = Task { [weak self] in await self?.pollLoop() }
        if kind == .scout { frameTask = Task { [weak self] in await self?.scoutFrameLoop() } }
        if kind == .reachy { Task { await self.loadEmotions() } }
    }

    func stop() {
        guard !pinned else { return }
        open = false
        pollTask?.cancel(); pollTask = nil
        frameTask?.cancel(); frameTask = nil
        closeStream()
        streaming = false
    }

    private var statePath: String { kind == .scout ? "/api/telemetry" : "/api/state" }

    /// 1 s state poll. Reachy also keeps its MJPEG open (snapshot when it is not flowing);
    /// Scout's frames come from scoutFrameLoop because its camera route is JSON.
    private func pollLoop() async {
        while !Task.isCancelled {
            if sceneActive, let device {
                if kind == .scout && !hasToken {
                    // Only /api/health is open; enough to say whether the tunnel is up.
                    let (status, _) = await request("/api/health", token: nil, base: device.url)
                    if status == 200 { stateAt = Date() }
                } else {
                    let (status, body) = await request(statePath, token: token, base: device.url)
                    if Task.isCancelled { return }
                    if status == 200, let body { apply(body) }
                    else if status == 401 || status == 403 { unauthorized() }
                }
                if kind == .reachy, viewers == 0 {
                    // Tile only: no MJPEG through the tunnel, one snapshot a second.
                    if streamTask != nil { closeStream() }
                    streaming = false
                    let due = frameAt.map { Date().timeIntervalSince($0) >= Self.idleSnapshotEvery - 0.05 } ?? true
                    if due { await snapshot() }
                } else if kind == .reachy {
                    let live = frameAt.map { Date().timeIntervalSince($0) < ArmCore.streamStaleAfter } ?? false
                    streaming = live && streamTask != nil
                    if streamTask == nil, Date() >= streamRetryAt { openStream() }
                    if !live { await snapshot() }
                }
            } else {
                closeStream()
            }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    /// Scout: ~3 fps of /api/frame/front while the panel is open and the token is known.
    private func scoutFrameLoop() async {
        while !Task.isCancelled {
            if sceneActive, hasToken, let device {
                let (status, body) = await request("/api/frame/front", token: token, base: device.url)
                if Task.isCancelled { return }
                if status == 200, let body, let jpeg = BodyCore.scoutFrame(body) { gotFrame(jpeg) }
                else if status == 401 || status == 403 { unauthorized() }
            }
            let every = viewers > 0 ? Self.scoutFrameEveryMs : Self.scoutIdleFrameEveryMs
            do { try await Task.sleep(for: .milliseconds(every)) } catch { return }
        }
    }

    private func apply(_ body: [String: Any]) {
        switch kind {
        case .scout: scoutState = BodyCore.decodeScout(body)
        case .reachy: reachyState = BodyCore.decodeReachy(body)
        }
        stateAt = Date()
    }

    private func gotFrame(_ jpeg: Data) {
        frame = jpeg
        let now = Date()
        frameAt = now
        fpsWindow.append(now)
        fpsWindow.removeAll { now.timeIntervalSince($0) > 2 }
        fps = Double(fpsWindow.count) / 2
    }

    /// 401/403 from the robot. Only complain when a token WAS saved and got refused;
    /// with no token yet the token field below is the whole message (Reachy gates
    /// even /api/state, so every first open lands here — build 89 lesson).
    private func unauthorized() {
        let had = Keychain.get(kind.tokenKey) != nil
        if had { Keychain.delete(kind.tokenKey) }
        hasToken = false
        if had, toast == nil { toast = "\(kind.title) did not accept the saved token. Paste it again." }
    }

    private func loadEmotions() async {
        guard let device else { return }
        let (status, body) = await request("/api/emotions", token: token, base: device.url)
        if status == 200, let names = body?["names"] as? [String] { emotions = names }
    }

    // ── Reachy camera: MJPEG + snapshot ─────────────────────────────────────

    private func openStream() {
        guard let device, let url = URL(string: device.url + "/api/stream") else { return }
        guard hasToken, let token else { return }
        streamRetryAt = Date().addingTimeInterval(10)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = .infinity
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        var req = URLRequest(url: url)
        req.setValue("multipart/x-mixed-replace", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        streamSession = session
        streamBuf = Data()
        let task = session.dataTask(with: req)
        streamTask = task
        task.resume()
    }

    private func closeStream() {
        streamTask?.cancel(); streamTask = nil
        streamSession?.invalidateAndCancel(); streamSession = nil
        streamBuf = Data()
    }

    fileprivate func feedStream(_ data: Data) {
        streamBuf.append(data)
        let (frames, rest) = BodyCore.splitJPEGs(streamBuf)
        streamBuf = rest
        if let last = frames.last { gotFrame(last) }
    }

    fileprivate func streamEnded(status: Int) {
        streamTask = nil
        streamSession?.invalidateAndCancel(); streamSession = nil
        streaming = false
    }

    private func snapshot() async {
        guard let device, hasToken, let token, let url = URL(string: device.url + "/api/snapshot.jpg") else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 6
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200, data.count > 4 else { return }
        gotFrame(data)
    }

    // ── Commands ────────────────────────────────────────────────────────────

    /// POST a gated command; the refusal lands in `toast`. Returns true on 2xx.
    @discardableResult
    private func command(_ path: String, _ body: [String: Any]?) async -> Bool {
        guard let device else { return false }
        guard hasToken, let token else { toast = "Paste \(kind.title)'s token first."; return false }
        busy = true
        defer { busy = false }
        let (status, resp) = await request(path, method: "POST", body: body, token: token, base: device.url)
        guard (200...299).contains(status) else {
            toast = BodyCore.refusal(kind, status: status, body: resp)
            TinyDesign.haptic(.rigid)
            if status == 401 || status == 403 { unauthorized() }
            return false
        }
        TinyDesign.haptic(.light)
        return true
    }

    // Scout
    func drive(linear: Double, angular: Double, duration: Double = 0.6) async {
        await command("/api/control", BodyCore.scoutDrive(linear: linear, angular: angular, duration: duration))
    }
    func stopRover() async { await command("/api/control", BodyCore.scoutStop) }
    func lamp(_ on: Bool) async { await command("/api/lamp", ["on": on]) }

    // Reachy
    func look(pitch: Double, yaw: Double, roll: Double = 0, duration: Double = 0.8) async {
        await command("/api/control/look", BodyCore.reachyLook(pitch: pitch, yaw: yaw, roll: roll, duration: duration))
    }
    func antennas(right: Double, left: Double) async {
        await command("/api/control/antennas", BodyCore.reachyAntennas(right: right, left: left))
    }
    func express(_ name: String) async {
        guard let body = BodyCore.reachyExpress(name, allowed: emotions) else { toast = "Unknown emotion."; return }
        await command("/api/control/express", body)
    }
    func say(_ text: String) async -> Bool {
        guard let body = BodyCore.reachySay(text) else { return false }
        return await command("/api/control/say", body)
    }
    func home() async { await command("/api/control/home", nil) }
    func stopHead() async { await command("/api/control/stop", nil) }

    /// The big red button — whichever body, the one command that must always work.
    func emergencyStop() async {
        switch kind {
        case .scout: await stopRover()
        case .reachy: await stopHead()
        }
    }

    // ── HTTP (absolute base from the device row, not Api.base) ──────────────

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                         token: String?, base: String? = nil) async -> (Int, [String: Any]?) {
        guard let base = base ?? device?.url, let url = URL(string: base + path) else { return (0, nil) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 8
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        } else if method == "POST" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else { return (0, nil) }
        return (http.statusCode, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

extension BodyManager: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                                didReceive response: URLResponse,
                                completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 { Task { @MainActor in self.streamEnded(status: status) } }
        completionHandler(status == 200 ? .allow : .cancel)
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor in
            if dataTask === self.streamTask { self.feedStream(data) }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            if task === self.streamTask { self.streamEnded(status: 0) }
        }
    }
}
