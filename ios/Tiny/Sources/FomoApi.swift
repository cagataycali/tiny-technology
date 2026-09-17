/**
 * 🦾 FomoApi — the fomo-the-arm dashboard's REAL API (https://fomo.example.com),
 * as measured on 2026-09-09, not strands-arm's dialect.
 *
 * Why this file exists: build 79 spoke strands-arm (POST /api/control/look,
 * POST /api/photo, GET /api/camera/snapshot?t=) and Fomo answered 405/404 with a
 * bare "Method Not Allowed"; its /api/state is also FLAT (joints{id:deg}), so the
 * old decoder saw "no arm". Everything below is keyed on the live JSON:
 *
 *   GET  /api/state            flat: ok, joints{"1".."6"}, names, home, torque, voltage, folded,
 *                              busy ("motion:happy 3/7"), gate, calibrated, windows, nicla{…}, rl{…}
 *   POST /api/control/move     {actions:[{look:{pan,tilt}} | {home:true} | {joint,to|by}], speed?}
 *   POST /api/control/pose     {name}          POST /api/control/motion {name, speed?, stay?}
 *   POST /api/control/stop     {}              POST /api/control/torque {on}
 *   GET  /api/motions          {name:{description, frames[], builtin, ok, why}}
 *   GET  /api/poses            {name:{rel_deg, description, builtin, ok, why}}
 *   GET  /api/rl/status        POST /api/rl/shadow {policy,seconds}|{stop}   POST /api/rl/live {seconds}|{stop}
 *   GET  /api/camera/snapshot  (auth) one JPEG, saved on the arm, X-Fomo-Path header = "take a photo"
 *   GET  /api/nicla/stream     MJPEG (public)
 *
 * Errors: FastAPI wraps a dict detail — 422/409/401 are `{"detail":{"error":"…"}}`,
 * a 405 is `{"detail":"Method Not Allowed"}`. `FomoCore.refusal` unwraps both so
 * the guard's own words reach the toast, never a bare status.
 *
 * `FomoCore` is pure (FomoApiTests pins it on the captured live JSON);
 * `FomoClient` does HTTP with an injectable URLSession (stub URLProtocol in tests).
 */
import Foundation

// ── Pure core ───────────────────────────────────────────────────────────────

enum FomoCore {
    struct Joint: Equatable, Identifiable {
        let id: Int
        let name: String
        let deg: Double
        let home: Double
        let torque: Bool
        /// Degrees relative to home, wrap-safe (servo degrees live on 0..360).
        var rel: Double { ArmCore.wrap(deg - home) }
    }

    struct Nicla: Equatable {
        var ok: Bool
        var ageS: Double?
        var rssi: Int?
        var tofMm: Double?
        var roll: Double?
        var pitch: Double?
        var mounted: Bool
        var fps: Double?
        var fw: String?
    }

    struct RL: Equatable {
        var running: Bool
        var policy: String?
        var policies: [String]
        var stage: Int
        var stageName: String
        var allowed: Bool
        var reason: String?
        var mode: String?
        var capDeg: Double?
        var ticks: Int
        var error: String?
    }

    /// "motion:happy 3/7" in `busy` → the gallery's progress. Web parity: useArm.motionProgress.
    struct MotionProgress: Equatable {
        let name: String
        let i: Int?
        let n: Int?
    }

    struct State: Equatable {
        var ok: Bool
        var error: String?
        var source: String
        var joints: [Joint]
        var voltage: Double?
        var folded: Bool?
        var busy: String?
        var gate: Bool
        var calibrated: Bool
        var ageS: Double?
        var look: ArmCore.LookRange
        /// The guard's calibrated EEPROM window per servo id, absolute servo degrees (slider bounds).
        var windows: [Int: ClosedRange<Double>] = [:]
        var nicla: Nicla?
        var rl: RL?
        var motion: MotionProgress? { busy.flatMap(FomoCore.motionProgress) }
        var torqueOn: Bool { !joints.isEmpty && joints.allSatisfy(\.torque) }
        var anyTorque: Bool { joints.contains { $0.torque } }
        /// pan (id 5) / tilt (id 6) relative to home — nil until both report.
        var currentLook: ArmCore.Look? {
            guard let p = joints.first(where: { $0.id == 5 }), let t = joints.first(where: { $0.id == 6 }) else { return nil }
            return ArmCore.Look(pan: p.rel, tilt: t.rel)
        }
    }

    /// Hardware sample age plus time since request start, not HTTP success. A server
    /// can keep replying with old joints after losing its bus. Reject unknown,
    /// non-finite and future times rather than promoting them to live readings.
    /// Counting the entire round trip is conservative: slow replies cannot
    /// arrive with an old sample and buy another three seconds of "live".
    static func stateFresh(_ state: State?, requestStartedAt: Date?, now: Date = Date()) -> Bool {
        guard let state, state.ok, state.error == nil, !state.joints.isEmpty,
              ["bus", "sim"].contains(state.source),
              let age = state.ageS, age.isFinite, age >= 0,
              let requestStartedAt else { return false }
        let elapsed = now.timeIntervalSince(requestStartedAt)
        return elapsed.isFinite && elapsed >= 0 && age + elapsed < 3
    }

    static func twinStatus(_ state: State?, requestStartedAt: Date?, now: Date = Date()) -> String {
        guard stateFresh(state, requestStartedAt: requestStartedAt, now: now) else { return "twin · stale" }
        return state?.source == "sim" ? "twin · simulated" : "twin · live"
    }

    struct Motion: Equatable, Identifiable {
        var id: String { name }
        let name: String
        let description: String
        let frames: Int
        let builtin: Bool
        let ok: Bool
        let why: String?
    }

    struct Pose: Equatable, Identifiable {
        var id: String { name }
        let name: String
        let description: String
        let builtin: Bool
        let ok: Bool
        let why: String?
    }

    static func number(_ any: Any?) -> Double? { EndpointTelemetry.number(any) }
    private static func bool(_ any: Any?) -> Bool? {
        if let b = any as? Bool { return b }
        if let i = any as? Int { return i != 0 }
        return nil
    }

    /// Is this /api/state Fomo's flat shape (vs strands-arm's `arm:{joints:[…]}`)?
    static func isFomoState(_ raw: [String: Any]) -> Bool {
        raw["joints"] is [String: Any] || raw["names"] is [String: Any]
    }

    static func decodeState(_ raw: [String: Any]) -> State {
        let joints = raw["joints"] as? [String: Any] ?? [:]
        let names = raw["names"] as? [String: Any] ?? [:]
        let home = raw["home"] as? [String: Any] ?? [:]
        let torque = raw["torque"] as? [String: Any] ?? [:]
        let windows = raw["windows"] as? [String: Any] ?? [:]
        var out: [Joint] = []
        for (k, v) in joints {
            guard let id = Int(k), let deg = number(v) else { continue }
            out.append(Joint(id: id, name: names[k] as? String ?? "j\(id)", deg: deg,
                             home: number(home[k]) ?? deg, torque: bool(torque[k]) ?? false))
        }
        out.sort { $0.id < $1.id }
        // Legal look range = the guard's EEPROM window around home for pan (5) and tilt (6);
        // the ±60 fallback until both are known.
        var look = ArmCore.LookRange.fallback
        func range(_ id: String) -> ClosedRange<Double>? {
            guard let w = windows[id] as? [Any], w.count == 2, let lo = number(w[0]), let hi = number(w[1]),
                  let h = number(home[id]) else { return nil }
            let a = ArmCore.wrap(lo - h), b = ArmCore.wrap(hi - h)
            return a <= b ? a...b : b...a
        }
        if let p = range("5") { look.pan = p }
        if let t = range("6") { look.tilt = t }
        var absWindows: [Int: ClosedRange<Double>] = [:]
        for (k, v) in windows {
            guard let id = Int(k), let w = v as? [Any], w.count == 2, let lo = number(w[0]), let hi = number(w[1]) else { continue }
            absWindows[id] = lo <= hi ? lo...hi : hi...lo
        }

        var nicla: Nicla?
        if let n = raw["nicla"] as? [String: Any] {
            let imu = n["imu"] as? [String: Any] ?? [:]
            let stream = n["stream"] as? [String: Any] ?? [:]
            nicla = Nicla(ok: bool(n["ok"]) ?? false, ageS: number(n["age_s"]), rssi: number(n["rssi"]).map { Int($0) },
                          tofMm: number(n["tof_mm"]), roll: number(imu["roll"]), pitch: number(imu["pitch"]),
                          mounted: bool(n["mounted"]) ?? true, fps: number(stream["fps"]), fw: n["fw"] as? String)
        }
        var rl: RL?
        if let r = raw["rl"] as? [String: Any] {
            rl = decodeRL(r)
        }
        return State(ok: bool(raw["ok"]) ?? !out.isEmpty, error: raw["error"] as? String,
                     source: raw["source"] as? String ?? "none", joints: out,
                     voltage: number(raw["voltage"]), folded: bool(raw["folded"]), busy: raw["busy"] as? String,
                     gate: bool(raw["gate"]) ?? true, calibrated: bool(raw["calibrated"]) ?? false,
                     ageS: number(raw["age_s"]), look: look, windows: absWindows, nicla: nicla, rl: rl)
    }

    static func decodeRL(_ r: [String: Any]) -> RL {
        let stage = r["stage"] as? [String: Any] ?? [:]
        return RL(running: bool(r["running"]) ?? false, policy: r["policy"] as? String,
                  policies: (r["policies"] as? [Any])?.compactMap { $0 as? String } ?? [],
                  stage: Int(number(stage["stage"]) ?? 0), stageName: stage["name"] as? String ?? "shadow",
                  allowed: bool(stage["allowed"]) ?? false, reason: stage["reason"] as? String,
                  mode: r["mode"] as? String, capDeg: number(r["cap_deg"]),
                  ticks: Int(number(r["ticks"]) ?? 0), error: r["error"] as? String)
    }

    static func decodeMotions(_ raw: [String: Any]) -> [Motion] {
        raw.compactMap { name, v in
            guard let m = v as? [String: Any] else { return nil }
            return Motion(name: name, description: m["description"] as? String ?? "",
                          frames: (m["frames"] as? [Any])?.count ?? 0, builtin: bool(m["builtin"]) ?? false,
                          ok: bool(m["ok"]) ?? true, why: m["why"] as? String)
        }.sorted { $0.name < $1.name }
    }

    static func decodePoses(_ raw: [String: Any]) -> [Pose] {
        raw.compactMap { name, v in
            guard let p = v as? [String: Any] else { return nil }
            return Pose(name: name, description: p["description"] as? String ?? "", builtin: bool(p["builtin"]) ?? false,
                        ok: bool(p["ok"]) ?? true, why: p["why"] as? String)
        }.sorted { ($0.name == "home" ? 0 : 1, $0.name) < ($1.name == "home" ? 0 : 1, $1.name) }
    }

    static func motionProgress(_ busy: String) -> MotionProgress? {
        guard busy.hasPrefix("motion:") else { return nil }
        let rest = busy.dropFirst("motion:".count)
        let parts = rest.split(separator: " ", maxSplits: 1).map(String.init)
        guard let name = parts.first, !name.isEmpty else { return nil }
        var i: Int?, n: Int?
        if parts.count == 2 {
            let f = parts[1].split(separator: "/")
            if f.count == 2 { i = Int(f[0]); n = Int(f[1]) }
        }
        return MotionProgress(name: name, i: i, n: n)
    }

    /// The server's words, unwrapped from FastAPI's envelope. Never a bare status.
    static func errorText(_ body: [String: Any]?) -> String? {
        guard let body else { return nil }
        if let e = body["error"] as? String, !e.isEmpty { return e.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let d = body["detail"] as? [String: Any] {
            if let e = d["error"] as? String, !e.isEmpty { return e.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let m = d["message"] as? String, !m.isEmpty { return m }
        }
        if let d = body["detail"] as? String, !d.isEmpty { return d }
        if let arr = body["detail"] as? [[String: Any]], let first = arr.first, let msg = first["msg"] as? String { return msg }
        return nil
    }

    static func refusal(status: Int, method: String, path: String, body: [String: Any]?) -> String {
        let why = errorText(body) ?? ""
        switch status {
        case 0: return "Fomo is not answering."
        case 401, 403: return why.isEmpty ? "Fomo did not accept this login." : why
        case 404: return "Fomo has no \(path) (404)."
        case 405: return "Fomo does not take \(method) \(path) (405)."
        case 409: return why.isEmpty ? "Fomo is busy with another job." : why
        case 503: return why.isEmpty ? "Fomo's arm is not attached (503)." : why
        default: return why.isEmpty ? "Refused (\(status))." : why
        }
    }

    // ── Request bodies (web-dash parity: dashboard/frontend/src/lib.ts) ─────

    static func lookBody(pan: Double?, tilt: Double?, speed: Double? = nil) -> [String: Any] {
        var look: [String: Any] = [:]
        if let pan { look["pan"] = pan }
        if let tilt { look["tilt"] = tilt }
        var b: [String: Any] = ["actions": [["look": look]]]
        if let speed { b["speed"] = speed }
        return b
    }

    static func homeBody(speed: Double? = nil) -> [String: Any] {
        var b: [String: Any] = ["actions": [["home": true]]]
        if let speed { b["speed"] = speed }
        return b
    }

    /// Look sends coalesce to ≤ 10 Hz (the web dash's pad rate).
    static let minLookInterval: TimeInterval = 0.1
}

// ── Client ──────────────────────────────────────────────────────────────────

struct FomoError: Error, Equatable {
    let status: Int
    let message: String
}

/// One arm, one origin. `token` is read per request so a fresh tiny session
/// (or a pasted arm token) is picked up without rebuilding the client.
final class FomoClient: @unchecked Sendable {
    let base: URL
    let token: @Sendable () -> String?
    let session: URLSession

    init(base: URL, session: URLSession = .shared, token: @escaping @Sendable () -> String?) {
        self.base = base
        self.session = session
        self.token = token
    }

    convenience init?(baseString: String, session: URLSession = .shared, token: @escaping @Sendable () -> String?) {
        guard let u = URL(string: baseString) else { return nil }
        self.init(base: u, session: session, token: token)
    }

    /// The MJPEG URL (public route; the stream reader opens it itself).
    var streamURL: URL { base.appendingPathComponent("api/nicla/stream") }
    /// The agent socket: wss on an https origin, token in the query (web parity).
    var agentURL: URL? {
        guard var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        let insecure = c.scheme == "http"
        c.scheme = insecure ? "ws" : "wss"
        c.path = "/ws/agent"
        if let t = token() { c.queryItems = [URLQueryItem(name: "token", value: t)] }
        return c.url
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    func state() async throws -> FomoCore.State {
        FomoCore.decodeState(try await json("GET", "/api/state"))
    }

    func motions() async throws -> [FomoCore.Motion] { FomoCore.decodeMotions(try await json("GET", "/api/motions")) }
    func poses() async throws -> [FomoCore.Pose] { FomoCore.decodePoses(try await json("GET", "/api/poses")) }
    func rlStatus() async throws -> FomoCore.RL { FomoCore.decodeRL(try await json("GET", "/api/rl/status")) }

    // ── Control (every refusal surfaces as FomoError with the guard's words) ─

    @discardableResult
    func look(pan: Double?, tilt: Double?, speed: Double? = nil) async throws -> [String: Any] {
        try await json("POST", "/api/control/move", body: FomoCore.lookBody(pan: pan, tilt: tilt, speed: speed))
    }
    /// Generic move: `actions` exactly as the web dash sends them (look / home / {joint,to|by|rel}).
    @discardableResult
    func move(_ body: [String: Any]) async throws -> [String: Any] {
        try await json("POST", "/api/control/move", body: body)
    }
    /// Torque for some servos: Fomo echoes the ids it actually switched (today the HTTP layer may apply all).
    @discardableResult
    func torque(_ on: Bool, ids: [Int]) async throws -> [String: Any] {
        try await json("POST", "/api/control/torque", body: ["on": on, "ids": ids])
    }
    @discardableResult
    func home(speed: Double? = nil) async throws -> [String: Any] {
        try await json("POST", "/api/control/move", body: FomoCore.homeBody(speed: speed))
    }
    @discardableResult
    func pose(_ name: String, speed: Double? = nil) async throws -> [String: Any] {
        var b: [String: Any] = ["name": name]
        if let speed { b["speed"] = speed }
        return try await json("POST", "/api/control/pose", body: b)
    }
    @discardableResult
    func motion(_ name: String, speed: Double? = nil, stay: Bool? = nil) async throws -> [String: Any] {
        var b: [String: Any] = ["name": name]
        if let speed { b["speed"] = speed }
        if let stay { b["stay"] = stay }
        return try await json("POST", "/api/control/motion", body: b)
    }
    @discardableResult
    func stop() async throws -> [String: Any] { try await json("POST", "/api/control/stop", body: [:]) }
    @discardableResult
    func torque(_ on: Bool) async throws -> [String: Any] { try await json("POST", "/api/control/torque", body: ["on": on]) }

    @discardableResult
    func rlShadow(policy: String, seconds: Double) async throws -> FomoCore.RL {
        FomoCore.decodeRL(try await json("POST", "/api/rl/shadow", body: ["policy": policy, "seconds": seconds]))
    }
    @discardableResult
    func rlLive(seconds: Double) async throws -> FomoCore.RL {
        FomoCore.decodeRL(try await json("POST", "/api/rl/live", body: ["seconds": seconds]))
    }
    @discardableResult
    func rlStop() async throws -> FomoCore.RL {
        FomoCore.decodeRL(try await json("POST", "/api/rl/shadow", body: ["stop": true]))
    }

    /// "Take a photo": the endpoint route saves a JPEG under the arm's photos dir
    /// and returns it. Returns the bytes and the arm-side path (X-Fomo-Path).
    func takePhoto() async throws -> (Data, String?) {
        let (status, data, http) = try await raw("GET", "/api/camera/snapshot")
        guard status == 200, let data, !data.isEmpty else {
            throw FomoError(status: status, message: FomoCore.refusal(status: status, method: "GET", path: "/api/camera/snapshot",
                                                                      body: Self.jsonObject(data)))
        }
        return (data, http?.value(forHTTPHeaderField: "X-Fomo-Path"))
    }

    /// One frame for the snapshot fallback (public route, cache-busted by the header).
    func snapshot() async throws -> Data {
        let (status, data, _) = try await raw("GET", "/api/camera/snapshot.jpg?source=auto")
        guard status == 200, let data, !data.isEmpty else {
            throw FomoError(status: status, message: FomoCore.refusal(status: status, method: "GET", path: "/api/camera/snapshot.jpg",
                                                                      body: Self.jsonObject(data)))
        }
        return data
    }

    /// Single-shot agent turn (fallback when /ws/agent is unavailable).
    func chat(_ prompt: String) async throws -> (result: String, tools: [String], errors: [String]) {
        let j = try await json("POST", "/api/chat", body: ["prompt": prompt], timeout: 90)
        return (j["result"] as? String ?? "(no reply)",
                (j["tools"] as? [Any])?.compactMap { $0 as? String } ?? [],
                (j["errors"] as? [Any])?.compactMap { $0 as? String } ?? [])
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    func request(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 8) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    private func raw(_ method: String, _ path: String, body: [String: Any]? = nil,
                     timeout: TimeInterval = 8) async throws -> (Int, Data?, HTTPURLResponse?) {
        do {
            let (data, resp) = try await session.data(for: request(method, path, body: body, timeout: timeout))
            let http = resp as? HTTPURLResponse
            return (http?.statusCode ?? 0, data, http)
        } catch {
            throw FomoError(status: 0, message: FomoCore.refusal(status: 0, method: method, path: path, body: nil))
        }
    }

    private func json(_ method: String, _ path: String, body: [String: Any]? = nil,
                      timeout: TimeInterval = 8) async throws -> [String: Any] {
        let (status, data, _) = try await raw(method, path, body: body, timeout: timeout)
        let obj = Self.jsonObject(data)
        guard (200...299).contains(status) else {
            throw FomoError(status: status, message: FomoCore.refusal(status: status, method: method, path: path, body: obj))
        }
        return obj ?? [:]
    }

    static func jsonObject(_ data: Data?) -> [String: Any]? {
        guard let data, !data.isEmpty else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
