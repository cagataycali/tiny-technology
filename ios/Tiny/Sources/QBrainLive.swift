/**
 * 🧠 QBrainLive — the Arduino UNO Q (q-the-brain) as a live surface in this app.
 *
 * The board is an ENDPOINT device: a Linux SBC running its own FastAPI dashboard
 * at https://q.example.com, enrolled on tiny.technology with that address in the
 * device row. Everything here reads the address from the row — nothing is
 * hardcoded, and with no q-the-brain row on the account the feature stays hidden.
 *
 * Two credentials, two jobs (the ArmLive pattern):
 *  - the tiny session token finds the board (GET /api/devices, like the Devices sheet)
 *    AND is accepted by the board's gate (dashboard/auth.py verifies a tiny session
 *    upstream), so the phone usually never pastes anything;
 *  - the board's own owner token (Keychain "qbrain.token", ~/.q/token on the board)
 *    is the fallback when the session is refused.
 *
 * What the board serves (q-the-brain AGENTS.md contract):
 *   GET  /api/health          open — liveness, version, sim flag
 *   GET  /api/auth/me         {via, owner} on 200; 401 when the credential is refused
 *   GET  /api/state           host{hostname,model,uptime_s,load[],temp_c,mem{},disk{},wifi{}} mcu{} led{} tunnel{}
 *   GET  /api/events          SSE: `state` ticks + agent/led/mcu/auth events
 *   POST /api/led             {text} | {frame} | {clear:true}
 *   POST /api/chat            handled by the tiny agent via use_device, not from here
 *
 * The UI lives in QBrainLiveScreen.swift; this file is the model plus the pure
 * functions QBrainLiveTests pins. No camera, no servos: the UNO Q has neither today.
 */
import SwiftUI
import UIKit

// ── Pure core (unit-tested) ─────────────────────────────────────────────────

enum QBrainCore {
    /// Which device row IS the board. The enrolled row says platform "q-the-brain"
    /// with capabilities [telemetry, chat, led, mcu, shell]; `led` + `mcu` together
    /// are unique to it, so a renamed platform does not hide the board and a
    /// printer declaring `led` alone does not get mistaken for it.
    static func isBrain(platform: String, capabilities: [String]) -> Bool {
        platform == "q-the-brain" || (capabilities.contains("led") && capabilities.contains("mcu"))
    }

    struct Wifi: Equatable {
        var ssid: String?
        var rssiDbm: Double?
        var ip: String?
    }

    struct State: Equatable {
        /// "board" when the readings come from sysfs on the UNO Q, "fake" (the live
        /// dashboard's word; the earlier draft said "sim") when it answers from its
        /// simulator — dev on the Mac, or the q/ adapters not yet installed. The
        /// panel labels that honestly, never as the board.
        var source: String
        var hostname: String?
        var model: String?
        var uptimeS: Double?
        var load1: Double?
        var tempC: Double?
        var memUsedMb: Double?
        var memTotalMb: Double?
        var diskUsedGb: Double?
        var diskTotalGb: Double?
        var wifi: Wifi
        var mcuLink: Bool?
        var mcuVersion: String?
        /// "none" while nothing is flashed on the STM32 (live board 2026-09-09).
        var mcuSketch: String?
        var ledText: String?
        /// "off" | "text" | "frame" — what the matrix is doing (live contract).
        var ledMode: String?
        /// false when the dashboard accepted the text but the MCU did not draw it.
        var ledApplied: Bool?
        var ledError: String?
        /// The 13×8 (cols×rows) frame the dashboard believes is on the glass —
        /// rows of 0/1, drawn by the panel as a preview. nil until it arrives.
        var ledFrame: [[Int]]?
        var tunnelUp: Bool?
        var error: String?

        var isSim: Bool { source == "sim" || source == "fake" }
    }

    /// Tolerant number, EndpointTelemetry's rule: numeric strings count, null/NaN drop.
    static func number(_ any: Any?) -> Double? { EndpointTelemetry.number(any) }

    /// led.frame → rows of 0/1. Anything ragged or non-numeric is dropped whole:
    /// a half-frame preview would claim pixels the board never lit.
    static func frame(_ any: Any?) -> [[Int]]? {
        guard let rows = any as? [Any], !rows.isEmpty else { return nil }
        var out: [[Int]] = []
        for r in rows {
            guard let cells = r as? [Any], !cells.isEmpty else { return nil }
            var row: [Int] = []
            for c in cells {
                guard let n = number(c) else { return nil }
                row.append(n > 0 ? 1 : 0)
            }
            if let w = out.first?.count, w != row.count { return nil }
            out.append(row)
        }
        return out
    }

    private static func flag(_ any: Any?) -> Bool? {
        if let b = any as? Bool { return b }
        if let n = any as? Int { return n != 0 }
        return nil
    }

    /// /api/state → State. Every field optional: a dashboard mid-boot answers a
    /// bare `{source:"fake"}` and that must render as "no readings yet", not crash.
    ///
    /// The LIVE shape (q-the-brain dashboard/API.md, read from https://q.example.com
    /// on 2026-09-09) is FLAT at the top: `hostname, model, uptime_s, cpu_temp_c,
    /// load[], mem{}, disk{}, wifi{}, mcu{link,port,fw,last_seen},
    /// led{mode,rows,cols,frame,text}, tunnel{up,host}`. The flat /api/telemetry
    /// projection (`load1, mcu_link, mcu_fw, led_text …`) and the earlier nested
    /// `host{…}` draft decode through the same function, so whichever the board
    /// speaks, the panel reads it.
    static func decodeState(_ raw: [String: Any]) -> State {
        let host = raw["host"] as? [String: Any] ?? raw
        let mem = host["mem"] as? [String: Any] ?? [:]
        let disk = host["disk"] as? [String: Any] ?? [:]
        let wifi = host["wifi"] as? [String: Any] ?? [:]
        let mcu = raw["mcu"] as? [String: Any] ?? [:]
        let led = raw["led"] as? [String: Any] ?? [:]
        let tunnel = raw["tunnel"] as? [String: Any] ?? [:]
        let load = host["load"] as? [Any] ?? []
        let hasVitals = host["cpu_temp_c"] != nil || host["temp_c"] != nil || host["uptime_s"] != nil
        return State(
            source: raw["source"] as? String ?? (hasVitals ? "board" : "unknown"),
            hostname: host["hostname"] as? String,
            model: host["model"] as? String,
            uptimeS: number(host["uptime_s"]),
            load1: load.first.flatMap(number) ?? number(raw["load1"]),
            tempC: number(host["cpu_temp_c"]) ?? number(host["temp_c"]),
            memUsedMb: number(mem["used_mb"]) ?? number(raw["mem_used_mb"]),
            memTotalMb: number(mem["total_mb"]) ?? number(raw["mem_total_mb"]),
            diskUsedGb: number(disk["used_gb"]) ?? number(raw["disk_used_gb"]),
            diskTotalGb: number(disk["total_gb"]) ?? number(raw["disk_total_gb"]),
            wifi: Wifi(ssid: wifi["ssid"] as? String ?? raw["wifi_ssid"] as? String,
                       rssiDbm: number(wifi["rssi_dbm"]) ?? number(raw["wifi_rssi_dbm"]),
                       ip: wifi["ip"] as? String ?? raw["ip"] as? String),
            mcuLink: flag(mcu["link"]) ?? flag(raw["mcu_link"]),
            mcuVersion: mcu["fw"] as? String ?? mcu["version"] as? String ?? raw["mcu_fw"] as? String ?? raw["mcu_version"] as? String,
            mcuSketch: mcu["sketch"] as? String ?? raw["mcu_sketch"] as? String,
            ledText: led["text"] as? String ?? raw["led_text"] as? String,
            ledMode: led["mode"] as? String ?? raw["led_mode"] as? String,
            ledApplied: flag(led["applied"]) ?? flag(raw["led_applied"]),
            ledError: led["error"] as? String,
            ledFrame: frame(led["frame"]),
            tunnelUp: flag(tunnel["up"]) ?? flag(raw["tunnel_up"]),
            error: raw["error"] as? String)
    }

    /// True when the payload is board-shaped: either the nested `host` object or
    /// the flat telemetry keys. Used by EndpointPanel to route the Devices-sheet row.
    static func looksLikeBrain(_ t: [String: Any]) -> Bool {
        if let host = t["host"] as? [String: Any], host["temp_c"] != nil || host["uptime_s"] != nil { return true }
        if t["mcu_link"] != nil || t["mcu"] is [String: Any] { return true }
        return t["cpu_temp_c"] != nil && (t["led_text"] != nil || t["led"] != nil || t["hostname"] != nil)
    }

    /// "2h 05m", "3d 4h", "41s" — never raw seconds, never "0h 0m".
    static func uptime(_ s: Double?) -> String? {
        guard let s, s >= 0 else { return nil }
        let sec = Int(s)
        if sec < 60 { return "\(sec)s" }
        let d = sec / 86_400, h = (sec % 86_400) / 3600, m = (sec % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return String(format: "%dh %02dm", h, m) }
        return "\(m)m"
    }

    /// Readings for the Devices sheet (EndpointTelemetry.Reading order = display
    /// order). Only what the payload actually carries; sim is labelled.
    static func readings(_ s: State) -> [TelemetryReading] {
        var out: [TelemetryReading] = []
        func add(_ label: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            out.append(TelemetryReading(label: label, value: value))
        }
        if s.isSim { add("source", "simulated") }
        if let t = s.tempC { add("soc", String(format: "%.1f°C", t)) }
        if let l = s.load1 { add("load", String(format: "%.2f", l)) }
        if let u = s.memUsedMb, let t = s.memTotalMb, t > 0 {
            add("memory", String(format: "%.0f / %.0f MB", u, t))
        }
        if let u = s.diskUsedGb, let t = s.diskTotalGb, t > 0 {
            add("disk", String(format: "%.1f / %.1f GB", u, t))
        }
        if let ssid = s.wifi.ssid {
            let rssi = s.wifi.rssiDbm.map { String(format: " · %.0f dBm", $0) } ?? ""
            add("wifi", ssid + rssi)
        }
        add("ip", s.wifi.ip)
        add("uptime", uptime(s.uptimeS))
        if let link = s.mcuLink {
            var mcu = link ? "linked" : "no link"
            if let fw = s.mcuVersion { mcu += " · \(fw)" }
            else if link, s.mcuSketch == "none" { mcu += " · no sketch" }
            add("mcu", mcu)
        }
        if let up = s.tunnelUp { add("tunnel", up ? "up" : "down") }
        if let text = s.ledText, !text.isEmpty { add("led", s.ledApplied == false ? "\(text) (not shown)" : text) }
        else if let mode = s.ledMode, mode != "off" { add("led", mode) }
        if let e = s.error { add("error", e) }
        return out
    }

    /// What the board can show on its 13×8 matrix: ASCII the font has, trimmed,
    /// capped at 64 so a pasted paragraph does not scroll for a minute.
    static let ledMaxLength = 64
    static func ledText(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 }) else { return nil }
        return String(t.prefix(ledMaxLength))
    }

    /// The health badge, from freshness of the last good state — the same rule
    /// EndpointPanel uses so "live" means the same thing on both surfaces.
    enum Health: Equatable { case live, stale, offline, unknown }
    static func health(stateAt: Date?, now: Date = Date()) -> Health {
        guard let stateAt else { return .unknown }
        let age = now.timeIntervalSince(stateAt)
        if age < 6 { return .live }
        if age < 30 { return .stale }
        return .offline
    }

    /// One SSE event: `event:` name (default "message") + joined `data:` lines.
    struct SSEEvent: Equatable {
        var event: String
        var data: String
    }

    /// Incremental SSE parser over a byte buffer. Returns complete events and the
    /// unconsumed tail; comments (`: keepalive`) and `retry:` are dropped. Both
    /// `\n\n` and `\r\n\r\n` terminate an event.
    static func parseSSE(_ buffer: inout Data) -> [SSEEvent] {
        guard let text = String(data: buffer, encoding: .utf8) else { return [] }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        var blocks = normalized.components(separatedBy: "\n\n")
        let tail = blocks.removeLast()
        buffer = Data(tail.utf8)
        var out: [SSEEvent] = []
        for block in blocks {
            var name = "message"
            var data: [String] = []
            for line in block.split(separator: "\n", omittingEmptySubsequences: true) {
                if line.hasPrefix(":") { continue }
                if line.hasPrefix("event:") { name = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                else if line.hasPrefix("data:") { data.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) }
            }
            if !data.isEmpty { out.append(SSEEvent(event: name, data: data.joined(separator: "\n"))) }
        }
        return out
    }

    /// The board's `state` tick arrives as `{id, type:"state", t, data:{…}}` on the
    /// default event, or as `event: state` with the state itself. Either way,
    /// hand back the state dictionary or nil for a non-state event.
    static func stateFromSSE(_ ev: SSEEvent) -> [String: Any]? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(ev.data.utf8)) as? [String: Any] else { return nil }
        if ev.event == "state" { return (obj["data"] as? [String: Any]) ?? obj }
        guard (obj["type"] as? String) == "state" else { return nil }
        return obj["data"] as? [String: Any]
    }

    /// POST /api/led answers 200 even when the matrix did not take the text: the
    /// live board says `{applied:false, error:"matrix not applied: rpc error 2:
    /// method q/matrix not available"}` while the MCU sketch is not flashed. nil
    /// = the text is on the glass; otherwise the sentence to show. Never call a
    /// 200 a success without reading `applied`.
    static func ledOutcome(status: Int, body: [String: Any]?) -> String? {
        guard (200...299).contains(status) else { return refusal(status: status, body: body) }
        if let applied = body?["applied"] as? Bool, !applied {
            return (body?["error"] as? String).map { "Not shown: \($0)" } ?? "Not shown: the matrix did not take it."
        }
        return nil
    }

    /// One sentence per refusal, the dashboard's own `detail.error` when it says why.
    static func refusal(status: Int, body: [String: Any]?) -> String {
        if let detail = body?["detail"] as? [String: Any], let e = detail["error"] as? String { return e }
        if let e = body?["error"] as? String { return e }
        switch status {
        case 0: return "The board did not answer. Tunnel down or the board is off."
        case 401, 403: return "The board did not accept this login."
        case 422: return "The board refused that text."
        case 503: return "The board is still starting."
        default: return "The board answered \(status)."
        }
    }
}

// ── Manager ─────────────────────────────────────────────────────────────────

struct QBrainDevice: Equatable {
    let id: String
    let name: String
    /// The https origin from the device row — the ONLY place the address comes from.
    let url: String
}

@MainActor
final class QBrainManager: NSObject, ObservableObject {
    static let shared = QBrainManager()
    static let tokenKey = "qbrain.token"

    @Published private(set) var device: QBrainDevice?
    @Published private(set) var state: QBrainCore.State?
    @Published private(set) var stateAt: Date?
    @Published private(set) var hasToken = Keychain.get(QBrainManager.tokenKey) != nil
    @Published private(set) var tokenChecking = false
    /// True while the SSE stream is delivering; false means the 2 s poll is the source.
    @Published private(set) var streaming = false
    @Published private(set) var ledBusy = false
    @Published var toast: String?
    @Published private(set) var open = false
    /// Set by the view from scenePhase. Polls skip (not exit) while false.
    var sceneActive = true

    private var pollTask: Task<Void, Never>?
    private var streamSession: URLSession?
    private var streamTask: URLSessionDataTask?
    private var streamBuf = Data()
    private var streamAt: Date?
    private var streamRetryAt: Date = .distantPast

    /// The board's key: a pasted owner token if there is one, else the tiny session.
    private var token: String? { Keychain.get(Self.tokenKey) ?? sessionToken }
    private var sessionToken: String?
    var health: QBrainCore.Health { QBrainCore.health(stateAt: stateAt) }

    // ── Discovery ───────────────────────────────────────────────────────────

    func discover(sessionToken: String?) async {
        self.sessionToken = sessionToken
        hasToken = Keychain.get(Self.tokenKey) != nil || sessionToken != nil
        guard let sessionToken else { device = nil; return }
        guard let d: [String: Any] = try? await Api.get("/api/devices", token: sessionToken),
              let rows = d["devices"] as? [[String: Any]] else { return }
        device = Self.pick(rows)
    }

    /// Wire rows → the board, or nil. Static so the test can feed the live shape.
    nonisolated static func pick(_ rows: [[String: Any]]) -> QBrainDevice? {
        for r in rows {
            guard let id = r["id"] as? String, (r["kind"] as? String) == "endpoint",
                  let url = r["url"] as? String, url.hasPrefix("https://") else { continue }
            let caps = EndpointTelemetry.parseCapabilities(r["capabilities"])
            if QBrainCore.isBrain(platform: r["platform"] as? String ?? "", capabilities: caps) {
                return QBrainDevice(id: id, name: r["name"] as? String ?? "q-the-brain",
                                    url: url.hasSuffix("/") ? String(url.dropLast()) : url)
            }
        }
        return nil
    }

    // ── Token ───────────────────────────────────────────────────────────────

    /// Validate against GET /api/auth/me, then keep it. Unlike the arm, the board
    /// answers 401 for a bad credential and 200 `{via, owner}` for a good one.
    func saveToken(_ raw: String) async -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, device != nil else { return false }
        tokenChecking = true
        defer { tokenChecking = false }
        let (status, body) = await request("/api/auth/me", token: t)
        guard status == 200, body?["via"] != nil else {
            toast = QBrainCore.refusal(status: status == 200 ? 401 : status, body: body)
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
    }

    func stop() {
        guard !pinned else { return }
        open = false
        pollTask?.cancel(); pollTask = nil
        closeStream()
        streamAt = nil
        streaming = false
    }

    /// SSE when it flows, a 2 s poll of /api/state when it does not. The poll
    /// also runs the first tick so the screen fills before the stream connects.
    private func pollLoop() async {
        while !Task.isCancelled {
            if sceneActive, let device {
                let live = streamAt.map { Date().timeIntervalSince($0) < 20 } ?? false
                streaming = live && streamTask != nil
                if !live {
                    if streamTask == nil, Date() >= streamRetryAt, hasToken { openStream() }
                    let (status, body) = await request("/api/state", token: token, base: device.url)
                    if Task.isCancelled { return }
                    if status == 200, let body { apply(body) }
                    else if status == 401 || status == 403 { unauthorized() }
                }
            } else {
                closeStream()
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func apply(_ body: [String: Any]) {
        state = QBrainCore.decodeState(body)
        stateAt = Date()
    }

    private func unauthorized() {
        if Keychain.get(Self.tokenKey) != nil { Keychain.delete(Self.tokenKey) }
        hasToken = false
        closeStream()
        if toast == nil { toast = "The board did not accept this login. Paste the owner token." }
    }

    // ── SSE ─────────────────────────────────────────────────────────────────

    private func openStream() {
        guard let device, let token, let url = URL(string: device.url + "/api/events") else { return }
        streamRetryAt = Date().addingTimeInterval(10)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = .infinity
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
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
        if streamBuf.count > 262_144 { streamBuf = Data() }   // a runaway line never eats memory
        for ev in QBrainCore.parseSSE(&streamBuf) {
            streamAt = Date()
            if let st = QBrainCore.stateFromSSE(ev) { apply(st) }
        }
    }

    fileprivate func streamEnded(status: Int) {
        streamTask = nil
        streamSession?.invalidateAndCancel(); streamSession = nil
        streamAt = nil
        streaming = false
        if status == 401 || status == 403 { unauthorized() }
    }

    // ── LED matrix ──────────────────────────────────────────────────────────

    /// POST /api/led {text}. Returns true on 2xx; the refusal lands in `toast`.
    @discardableResult
    func sendLED(_ raw: String) async -> Bool {
        guard let device else { return false }
        guard let text = QBrainCore.ledText(raw) else { toast = "ASCII text only, up to \(QBrainCore.ledMaxLength) characters."; return false }
        guard hasToken else { toast = "Sign in first."; return false }
        ledBusy = true
        defer { ledBusy = false }
        let (status, body) = await request("/api/led", method: "POST", body: ["text": text], token: token, base: device.url)
        if let problem = QBrainCore.ledOutcome(status: status, body: body) {
            toast = problem
            TinyDesign.haptic(.rigid)
            if status == 401 || status == 403 { unauthorized() }
            return false
        }
        TinyDesign.haptic(.light)
        return true
    }

    @discardableResult
    func clearLED() async -> Bool {
        guard let device, hasToken else { return false }
        let (status, body) = await request("/api/led", method: "POST", body: ["clear": true], token: token, base: device.url)
        if let problem = QBrainCore.ledOutcome(status: status, body: body) { toast = problem; return false }
        return true
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
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else { return (0, nil) }
        return (http.statusCode, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

extension QBrainManager: URLSessionDataDelegate {
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
