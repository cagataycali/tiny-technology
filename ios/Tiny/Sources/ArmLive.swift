/**
 * 🦾 ArmLive — the strands-arm (fomo-the-arm) as a live surface in this app.
 *
 * The arm is an ENDPOINT device: a robot at its own https API, enrolled on
 * tiny.technology with its address in the device row. Everything here reads that
 * address from the row — nothing is hardcoded, and with no arm row on the account
 * the whole feature stays hidden.
 *
 * Two credentials, two jobs:
 *  - the tiny session token finds the arm (GET /api/devices, like the Devices sheet)
 *  - the ARM's own control token (Keychain "arm.token", pasted once) authorizes
 *    POST /api/control/…, the snapshot and the photo. /api/state and the MJPEG
 *    stream are public on the dashboard, so the picture works before any paste.
 *
 * Patterns copied on purpose: EndpointPanel (scenePhase-gated polls, one fetch in
 * flight, freshness decides the badge), TinyLive (MJPEG via URLSessionDataDelegate,
 * SOI/EOI split). The UI lives in ArmLiveScreen.swift; this file is the model plus
 * the pure functions ArmLiveTests pins.
 */
import SwiftUI
import UIKit

// ── Pure core (unit-tested) ─────────────────────────────────────────────────

enum ArmCore {
    /// Which device row IS the arm. The live row says platform "strands-arm" and
    /// capabilities [chat, telemetry, camera, arm, look, pan_tilt, photo, guard];
    /// either half alone is enough, so a renamed platform or a trimmed capability
    /// list does not hide the arm.
    static func isArm(platform: String, capabilities: [String]) -> Bool {
        platform == "strands-arm" || capabilities.contains("arm")
    }

    struct Joint: Equatable {
        let id: Int
        let name: String
        let deg: Double
        let home: Double
        let torque: Bool
    }

    /// guard.look from /api/state — the LEGAL look range in degrees relative to
    /// home. The guard clamps and refuses beyond it; the pad never asks for more.
    struct LookRange: Equatable {
        var pan: ClosedRange<Double>
        var tilt: ClosedRange<Double>
        /// The dashboard's default (pan_tilt_range_deg 60) — used until a state
        /// arrives, never as a claim about the arm.
        static let fallback = LookRange(pan: -60...60, tilt: -60...60)
    }

    struct State: Equatable {
        var ok: Bool
        var pose: String
        var joints: [Joint]
        var look: LookRange
        var busy: Bool
        var transport: String?
        var stream: String?
        var tofMm: Double?
        var detect: String?
    }

    /// One sample of the head's look, in the guard's units (deg relative to home).
    struct Look: Equatable {
        var pan: Double
        var tilt: Double
    }

    /// Wrap-safe difference: servo degrees live on 0..360, home 179 and a reading
    /// of 357 are 2 deg apart on one side, not 178 on the other.
    static func wrap(_ deg: Double) -> Double {
        var d = deg.truncatingRemainder(dividingBy: 360)
        if d > 180 { d -= 360 }
        if d <= -180 { d += 360 }
        return d
    }

    /// Tolerant number, EndpointTelemetry's rule: numeric strings count, null/NaN drop.
    static func number(_ any: Any?) -> Double? { EndpointTelemetry.number(any) }

    private static func range(_ any: Any?) -> ClosedRange<Double>? {
        guard let arr = any as? [Any], arr.count == 2,
              let lo = number(arr[0]), let hi = number(arr[1]), lo <= hi else { return nil }
        return lo...hi
    }

    /// /api/state → State. Every field optional: a dashboard mid-boot answers
    /// `arm: {ok:false}` with no joints, and that must render as "no arm", not crash.
    static func decodeState(_ raw: [String: Any]) -> State {
        let arm = raw["arm"] as? [String: Any] ?? [:]
        let joints: [Joint] = (arm["joints"] as? [[String: Any]] ?? []).compactMap { j in
            guard let id = number(j["id"]), let deg = number(j["deg"]) else { return nil }
            return Joint(id: Int(id), name: j["name"] as? String ?? "j\(Int(id))", deg: deg,
                         home: number(j["home"]) ?? deg,
                         torque: (j["torque"] as? Bool) ?? ((j["torque"] as? Int) == 1))
        }
        let guardD = raw["guard"] as? [String: Any] ?? [:]
        var look = LookRange.fallback
        if let l = guardD["look"] as? [String: Any] {
            if let p = range(l["pan"]) { look.pan = p }
            if let t = range(l["tilt"]) { look.tilt = t }
        } else if let r = number(guardD["pan_tilt_range_deg"]), r > 0 {
            look = LookRange(pan: -r...r, tilt: -r...r)
        }
        let nicla = raw["nicla"] as? [String: Any] ?? [:]
        let detect = (nicla["detect"] as? [String: Any])?["label"] as? String
        return State(ok: (arm["ok"] as? Bool) ?? !joints.isEmpty,
                     pose: arm["pose"] as? String ?? "unknown",
                     joints: joints, look: look,
                     busy: (guardD["busy"] as? Bool) ?? false,
                     transport: nicla["transport"] as? String,
                     stream: nicla["stream"] as? String,
                     tofMm: number(nicla["tof_mm"]),
                     detect: detect)
    }

    /// Where the head is looking now, from the pan (id 5) and tilt (id 6) joints
    /// relative to their homes. nil until both joints have reported.
    static func currentLook(_ s: State) -> Look? {
        guard let pan = s.joints.first(where: { $0.id == 5 }),
              let tilt = s.joints.first(where: { $0.id == 6 }) else { return nil }
        return Look(pan: wrap(pan.deg - pan.home), tilt: wrap(tilt.deg - tilt.home))
    }

    /// Pad point → look target. The pad is the picture: centre = home, left edge
    /// = pan min, right edge = pan max, TOP edge = tilt max (up is positive, the
    /// way a camera operator reads a tilt), bottom = tilt min. Points outside the
    /// pad clamp to the edge; the result is rounded to 0.5 deg so a trembling
    /// thumb does not produce a stream of 0.01 deg goals.
    static func lookTarget(point: CGPoint, in size: CGSize, range: LookRange) -> Look {
        guard size.width > 0, size.height > 0 else { return Look(pan: 0, tilt: 0) }
        let fx = min(max(point.x / size.width, 0), 1)
        let fy = min(max(point.y / size.height, 0), 1)
        let pan = range.pan.lowerBound + Double(fx) * (range.pan.upperBound - range.pan.lowerBound)
        let tilt = range.tilt.upperBound - Double(fy) * (range.tilt.upperBound - range.tilt.lowerBound)
        return Look(pan: (pan * 2).rounded() / 2, tilt: (tilt * 2).rounded() / 2)
    }

    /// Inverse of `lookTarget`, for drawing the HUD dot.
    static func padPoint(for look: Look, in size: CGSize, range: LookRange) -> CGPoint {
        let pw = range.pan.upperBound - range.pan.lowerBound
        let th = range.tilt.upperBound - range.tilt.lowerBound
        let fx = pw > 0 ? (look.pan - range.pan.lowerBound) / pw : 0.5
        let fy = th > 0 ? (range.tilt.upperBound - look.tilt) / th : 0.5
        return CGPoint(x: size.width * CGFloat(min(max(fx, 0), 1)),
                       y: size.height * CGFloat(min(max(fy, 0), 1)))
    }

    /// The 5 Hz coalescing decision. A drag emits 60 points a second; the arm
    /// wants the LATEST target no more than every 200 ms. `last` nil = never sent.
    static let minSendInterval: TimeInterval = 0.2
    static func shouldSend(now: TimeInterval, last: TimeInterval?, minInterval: TimeInterval = minSendInterval) -> Bool {
        guard let last else { return true }
        return now - last >= minInterval
    }

    /// Is a look target worth sending at all? Sub-0.5 deg changes are noise.
    static func changed(_ a: Look?, _ b: Look) -> Bool {
        guard let a else { return true }
        return abs(a.pan - b.pan) >= 0.5 || abs(a.tilt - b.tilt) >= 0.5
    }

    /// A refused command, in one sentence. The guard answers 4xx with a JSON
    /// `{error}`; a 401 is the token, a 409 is another job, anything else is the
    /// guard's own words. Never silently dropped — the toast shows this.
    static func refusal(status: Int, body: [String: Any]?) -> String {
        // FastAPI wraps a dict detail: `{"detail":{"error":"…"}}` (Fomo's guard) —
        // FomoCore.errorText unwraps that, the flat `{error}` and a string detail.
        let why = FomoCore.errorText(body) ?? ""
        switch status {
        case 401, 403: return "Arm token rejected — paste it again."
        case 404: return "The arm has no such route (404)."
        case 405: return "The arm does not take this method here (405)."
        case 409: return why.isEmpty ? "Arm is busy with another job." : "Busy: \(why)"
        case 0: return "Arm not answering."
        default: return why.isEmpty ? "Refused (\(status))." : why
        }
    }

    // ── Camera liveness ─────────────────────────────────────────────────────

    enum CameraBadge: Equatable {
        case live, snapshot, none
        var label: String {
            switch self {
            case .live: return "live"
            case .snapshot: return "snapshot"
            case .none: return "no camera"
            }
        }
    }

    /// MJPEG frames older than this mean the stream stalled → snapshot polling.
    static let streamStaleAfter: TimeInterval = 3
    /// Snapshot polls at 1 Hz; two missed is a dead camera, not a slow one.
    static let snapshotStaleAfter: TimeInterval = 4

    /// Freshness decides the word (EndpointPanel's rule), never the last outcome.
    static func badge(streamAt: Date?, snapshotAt: Date?, now: Date = Date()) -> CameraBadge {
        if let s = streamAt, now.timeIntervalSince(s) < streamStaleAfter { return .live }
        if let p = snapshotAt, now.timeIntervalSince(p) < snapshotStaleAfter { return .snapshot }
        return .none
    }

    /// Split a growing MJPEG buffer into complete JPEGs (SOI..EOI). Returns the
    /// frames found and the leftover bytes. Boundary text between parts is skipped;
    /// a buffer past 512 KB with no frame is garbage and is dropped.
    static func splitJPEGs(_ buf: Data) -> (frames: [Data], rest: Data) {
        var buf = buf
        var out: [Data] = []
        while let soi = buf.range(of: Data([0xFF, 0xD8])),
              let eoi = buf.range(of: Data([0xFF, 0xD9]), in: soi.lowerBound ..< buf.endIndex) {
            out.append(buf.subdata(in: soi.lowerBound ..< eoi.upperBound))
            buf.removeSubrange(buf.startIndex ..< eoi.upperBound)
        }
        if out.isEmpty, buf.count > 512 * 1024 { buf = Data() }
        return (out, buf)
    }

    // ── Telemetry projection (Devices sheet) ────────────────────────────────

    /// Does this endpoint telemetry come from an arm? Printers have gcode_state;
    /// the arm has joints_deg. Keyed on the shape, not the device row, because
    /// EndpointTelemetry.readings only sees the payload.
    static func isArmTelemetry(_ t: [String: Any]) -> Bool {
        t["joints_deg"] is [String: Any] || (t["pose"] is String && t["look"] != nil)
    }

    /// The arm's /api/telemetry as readings: pose, where the head looks, distance,
    /// camera source, detection. Absent fields drop out (EndpointPanel's rule).
    static func readings(_ t: [String: Any]) -> [TelemetryReading] {
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            if let v = value, !v.isEmpty { out.append(TelemetryReading(label: label, value: v)) }
        }
        if let pose = t["pose"] as? String, !pose.isEmpty {
            let torque = (t["torque"] as? Bool) == true
            add("pose", torque ? "\(pose) · torque on" : pose)
        }
        if let j = t["joints_deg"] as? [String: Any] {
            // The head's two servos, as absolute degrees: without the homes the
            // flat telemetry cannot say "relative", so it does not pretend to.
            if let pan = number(j["wrist_roll"] ?? j["pan"]), let tilt = number(j["tilt"]) {
                add("head", "pan \(Int(pan.rounded()))° · tilt \(Int(tilt.rounded()))°")
            }
            add("joints", "\(j.count)")
        }
        if let mm = number(t["tof_mm"]), mm > 0 { add("distance", "\(Int(mm.rounded())) mm") }
        if let cam = t["camera"] as? String, !cam.isEmpty { add("camera", cam) }
        else if t["camera"] is Bool { add("camera", (t["camera"] as? Bool) == true ? "on" : "off") }
        if let d = t["detect"] as? [String: Any], let label = d["label"] as? String { add("sees", label) }
        if let rssi = number(t["rssi"]) { add("wi-fi", "\(Int(rssi)) dBm") }
        if (t["agent_busy"] as? Bool) == true { add("agent", "thinking") }
        return out
    }
}

// ── Manager ─────────────────────────────────────────────────────────────────

struct ArmDevice: Equatable {
    let id: String
    let name: String
    /// The https origin from the device row — the ONLY place the arm's address
    /// comes from.
    let url: String
}

@MainActor
final class ArmManager: NSObject, ObservableObject {
    static let shared = ArmManager()
    static let tokenKey = "arm.token"

    @Published private(set) var device: ArmDevice?
    @Published private(set) var state: ArmCore.State?
    @Published private(set) var stateAt: Date?
    @Published private(set) var frame: UIImage?
    @Published private(set) var badge: ArmCore.CameraBadge = .none
    @Published private(set) var hasToken = Keychain.get(ArmManager.tokenKey) != nil
    @Published private(set) var tokenChecking = false
    /// The last look target the pad asked for; the HUD draws current vs this.
    @Published private(set) var target: ArmCore.Look?
    @Published var toast: String?
    @Published private(set) var lastPhoto: UIImage?
    @Published private(set) var photoBusy = false
    @Published private(set) var open = false
    /// Set by the view from scenePhase. Polls skip (not exit) while false.
    var sceneActive = true

    private var pollTask: Task<Void, Never>?
    private var cameraTask: Task<Void, Never>?
    private var fakeFrameTask: Task<Void, Never>?
    private var streamSession: URLSession?
    private var streamTask: URLSessionDataTask?
    private var streamBuf = Data()
    private var streamAt: Date?
    private var snapshotAt: Date?
    private var snapshotInFlight = false

    /// 👁 Cards/screens showing the picture at full rate (FomoPiPOverlay,
    /// FomoScreen). At 0 only the top-bar tile is fed: the MJPEG stream is
    /// closed and one snapshot a second stands in — three tunnelled MJPEG
    /// streams for three 52-pt tiles was the wrong trade (TOPBAR-PIP step 6).
    @Published private(set) var viewers = 0
    func retainViewer() { viewers += 1 }
    func releaseViewer() {
        viewers = max(0, viewers - 1)
        if viewers == 0 { closeStream() }
    }
    /// Idle cadence for a body nobody is looking at: one snapshot per second.
    static let idleSnapshotEvery: TimeInterval = 1
    private var streamRetryAt: Date = .distantPast
    private var lastSentAt: TimeInterval?
    private var lastSent: ArmCore.Look?
    private var pending: ArmCore.Look?
    private var flushTask: Task<Void, Never>?

    /// The arm's key: a pasted arm token if there is one, else the owner's own
    /// tiny.technology session. The dash verifies the session against
    /// /api/me and accepts the owner login (strands_arm/dashboard/auth.py), so
    /// the phone never has to paste anything.
    private var token: String? { Keychain.get(Self.tokenKey) ?? sessionToken }
    private var sessionToken: String?
    var currentLook: ArmCore.Look? { state.flatMap(ArmCore.currentLook) }
    var lookRange: ArmCore.LookRange { state?.look ?? .fallback }

    // ── Discovery ───────────────────────────────────────────────────────────

    /// Find the arm in the account's device list. Cheap, called from the toolbar
    /// view's `.task`; with no session there is nothing to find.
    func discover(sessionToken: String?) async {
        self.sessionToken = sessionToken
        hasToken = Keychain.get(Self.tokenKey) != nil || sessionToken != nil
        guard let sessionToken else { device = nil; return }
        guard let d: [String: Any] = try? await Api.get("/api/devices", token: sessionToken),
              let rows = d["devices"] as? [[String: Any]] else { return }
        device = Self.pick(rows)
    }

    /// Wire rows → the arm, or nil. Static so the test can feed the live shape.
    nonisolated static func pick(_ rows: [[String: Any]]) -> ArmDevice? {
        for r in rows {
            guard let id = r["id"] as? String, (r["kind"] as? String) == "endpoint",
                  let url = r["url"] as? String, url.hasPrefix("https://") else { continue }
            let caps = EndpointTelemetry.parseCapabilities(r["capabilities"])
            if ArmCore.isArm(platform: r["platform"] as? String ?? "", capabilities: caps) {
                return ArmDevice(id: id, name: r["name"] as? String ?? "arm",
                                 url: url.hasSuffix("/") ? String(url.dropLast()) : url)
            }
        }
        return nil
    }

    // ── Token ───────────────────────────────────────────────────────────────

    /// Validate against GET /api/auth/me, then keep it. The route answers 200
    /// `{required, ok}` even for a bad token — `ok` is the verdict, not the status.
    func saveToken(_ raw: String) async -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, device != nil else { return false }
        tokenChecking = true
        defer { tokenChecking = false }
        let (status, body) = await request("/api/auth/me", token: t)
        let ok = (body?["ok"] as? Bool) == true || (body?["required"] as? Bool) == false
        guard status == 200, ok else {
            toast = ArmCore.refusal(status: status == 200 ? 401 : status, body: body)
            TinyDesign.haptic(.rigid)
            return false
        }
        Keychain.set(Self.tokenKey, t)
        hasToken = true
        TinyDesign.haptic(.light)
        return true
    }

    func forgetToken() {
        Keychain.delete(Self.tokenKey)
        hasToken = sessionToken != nil
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

    func start() {
        guard !open, device != nil else { return }
        open = true
        pollTask = Task { [weak self] in await self?.pollLoop() }
        cameraTask = Task { [weak self] in await self?.cameraLoop() }
        if UITestFlags.fakeArmFrames {
            fakeFrameTask = Task { [weak self] in await self?.fakeFrameLoop() }
        }
    }

    /// TinyUITests only (UITestFlags.fakeArmFrames): a 10 fps synthetic
    /// "camera" — same publishes as feedStream (frame + badge per frame).
    private func fakeFrameLoop() async {
        var i = 0
        let size = CGSize(width: 92, height: 60)
        while !Task.isCancelled {
            i += 1
            let hue = CGFloat(i % 20) / 20
            let img = UIGraphicsImageRenderer(size: size).image { ctx in
                UIColor(hue: hue, saturation: 0.6, brightness: 0.8, alpha: 1).setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
            }
            frame = img
            streamAt = Date()
            badge = .live
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
    }

    func stop() {
        guard !pinned else { return }
        open = false
        pollTask?.cancel(); pollTask = nil
        cameraTask?.cancel(); cameraTask = nil
        fakeFrameTask?.cancel(); fakeFrameTask = nil
        flushTask?.cancel(); flushTask = nil
        closeStream()
        streamAt = nil; snapshotAt = nil
        badge = .none
        pending = nil; target = nil
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            if sceneActive, let device {
                let (status, body) = await request("/api/state", token: nil, base: device.url)
                if Task.isCancelled { return }
                if status == 200, let body {
                    state = ArmCore.decodeState(body)
                    stateAt = Date()
                }
            }
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
        }
    }

    // ── Camera: MJPEG first, snapshot when it stalls ────────────────────────

    private func cameraLoop() async {
        while !Task.isCancelled {
            if sceneActive, viewers == 0, fakeFrameTask == nil {
                // Tile only: no stream, one snapshot a second.
                if streamTask != nil { closeStream() }
                let due = snapshotAt.map { Date().timeIntervalSince($0) >= Self.idleSnapshotEvery - 0.05 } ?? true
                if hasToken, !snapshotInFlight, due { await tickSnapshot() }
            } else if sceneActive {
                let live = ArmCore.badge(streamAt: streamAt, snapshotAt: nil) == .live
                if !live {
                    // Stream down or never up: retry it every 10 s, and poll one
                    // snapshot per second meanwhile (token-gated, so only with one).
                    if streamTask == nil, Date() >= streamRetryAt { openStream() }
                    if hasToken, !snapshotInFlight { await tickSnapshot() }
                }
            } else {
                closeStream()
            }
            badge = ArmCore.badge(streamAt: streamAt, snapshotAt: snapshotAt)
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    private func openStream() {
        guard let device, let url = URL(string: device.url + "/api/nicla/stream") else { return }
        streamRetryAt = Date().addingTimeInterval(10)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = .infinity
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        streamSession = s
        streamBuf = Data()
        streamTask = s.dataTask(with: url)
        streamTask?.resume()
    }

    private func closeStream() {
        streamTask?.cancel(); streamTask = nil
        streamSession?.invalidateAndCancel(); streamSession = nil
        streamBuf = Data()
    }

    fileprivate func feedStream(_ data: Data) {
        streamBuf.append(data)
        let (frames, rest) = ArmCore.splitJPEGs(streamBuf)
        streamBuf = rest
        if let last = frames.last, let img = UIImage(data: last) {
            frame = img
            streamAt = Date()
            badge = .live
        }
    }

    fileprivate func streamEnded() {
        streamTask = nil
        streamSession?.invalidateAndCancel(); streamSession = nil
    }

    private func tickSnapshot() async {
        guard let device else { return }
        snapshotInFlight = true
        defer { snapshotInFlight = false }
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let (status, data, _) = await requestData("/api/camera/snapshot?t=\(stamp)", token: token, base: device.url)
        if status == 200, let data, let img = UIImage(data: data) {
            frame = img
            snapshotAt = Date()
        }
    }

    // ── Control ─────────────────────────────────────────────────────────────

    /// Pad drag: remember the latest target, send at most every 200 ms. Nothing
    /// extra happens on release — the last coalesced goal is the release.
    func requestLook(_ look: ArmCore.Look) {
        let r = lookRange
        let clamped = ArmCore.Look(pan: min(max(look.pan, r.pan.lowerBound), r.pan.upperBound),
                                   tilt: min(max(look.tilt, r.tilt.lowerBound), r.tilt.upperBound))
        target = clamped
        guard ArmCore.changed(lastSent, clamped) else { return }
        pending = clamped
        let now = Date().timeIntervalSince1970
        if ArmCore.shouldSend(now: now, last: lastSentAt) {
            flushLook()
        } else if flushTask == nil {
            let wait = ArmCore.minSendInterval - (now - (lastSentAt ?? now))
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(max(wait, 0.02) * 1000)))
                await MainActor.run { self?.flushTask = nil; self?.flushLook() }
            }
        }
    }

    private func flushLook() {
        guard let look = pending else { return }
        pending = nil
        lastSentAt = Date().timeIntervalSince1970
        lastSent = look
        Task { await control("/api/control/look", body: ["pan": look.pan, "tilt": look.tilt], quiet: true) }
    }

    /// STOP: always allowed by the guard, one tap, no confirm.
    func stopArm() { Task { await control("/api/control/stop", body: [:]) } }
    func home() { Task { await control("/api/control/home", body: [:]) } }

    func photo() async {
        guard let device, !photoBusy else { return }
        photoBusy = true
        defer { photoBusy = false }
        let (status, body) = await request("/api/photo", method: "POST", token: token, base: device.url)
        guard status == 200, let rel = body?["url"] as? String else {
            toast = ArmCore.refusal(status: status, body: body)
            TinyDesign.haptic(.rigid)
            return
        }
        let (s2, data, _) = await requestData(rel, token: token, base: device.url)
        if s2 == 200, let data, let img = UIImage(data: data) {
            lastPhoto = img
            TinyDesign.haptic(.light)
        } else {
            toast = "Photo taken but could not be fetched (\(s2))."
        }
    }

    @discardableResult
    private func control(_ path: String, body: [String: Any], quiet: Bool = false) async -> Bool {
        guard let device else { return false }
        guard hasToken else { toast = "Paste the arm token first."; return false }
        let (status, resp) = await request(path, method: "POST", body: body, token: token, base: device.url)
        if (200...299).contains(status) {
            if !quiet { TinyDesign.haptic(.light) }
            return true
        }
        toast = ArmCore.refusal(status: status, body: resp)
        TinyDesign.haptic(.rigid)
        if status == 401 || status == 403 {
            if Keychain.get(Self.tokenKey) != nil { Keychain.delete(Self.tokenKey) }
            hasToken = false
            toast = "The arm did not accept this login. Paste the arm token."
        }
        return false
    }

    // ── HTTP (absolute base from the device row, not Api.base) ──────────────

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                         token: String?, base: String? = nil) async -> (Int, [String: Any]?) {
        let (status, data, _) = await requestData(path, method: method, body: body, token: token, base: base)
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        return (status, json)
    }

    private func requestData(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                             token: String?, base: String? = nil) async -> (Int, Data?, String) {
        guard let base = base ?? device?.url, let url = URL(string: base + path) else { return (0, nil, "") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 8
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else { return (0, nil, "") }
        return (http.statusCode, data, http.value(forHTTPHeaderField: "Content-Type") ?? "")
    }
}

extension ArmManager: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                                didReceive response: URLResponse,
                                completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        // A JSON 503 ("no LAN node") is not a stream: drop it now so the snapshot
        // path takes over this second instead of after a 3 s stall.
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(status == 200 ? .allow : .cancel)
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor in
            if dataTask === self.streamTask { self.feedStream(data) }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            if task === self.streamTask { self.streamEnded() }
        }
    }
}
