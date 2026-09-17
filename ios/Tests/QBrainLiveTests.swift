/**
 * QBrainLiveTests — the UNO Q surface's pure logic (QBrainCore + QBrainManager.pick).
 *
 * Fixtures are the LIVE shapes read from https://q.example.com on 2026-09-09
 * (/api/state, /api/telemetry, /api/events) with the fleet's real enrolment row
 * — trimmed, not invented. Contract: q-the-brain dashboard/API.md.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct QBrainCoreTests {

    /// GET /api/state as https://q.example.com answered on 2026-09-09 (tiny session
    /// bearer, `source: fake` because the q/ adapters were not installed yet).
    private func liveState() -> [String: Any] {
        [
            "t": 1788983036.032, "source": "fake", "hostname": "uno-q", "model": "Arduino SA,Imola (fake)",
            "uptime_s": 3679, "cpu_temp_c": 44.5, "load": [0.25, 0.31, 0.28],
            "mem": ["total_mb": 3789, "used_mb": 872], "disk": ["total_gb": 9.8, "used_gb": 6.8],
            "wifi": ["ssid": "Home_WiFi", "rssi_dbm": -60, "ip": "192.168.1.210"],
            "mcu": ["link": true, "port": "/dev/ttyHS1", "fw": "fake-0.1", "last_seen": 1788983036.032],
            "led": ["mode": "off", "rows": 8, "cols": 13, "frame": [[0, 0, 0]], "text": NSNull()],
            "tunnel": ["up": true, "host": "q.example.com"],
            "docker": ["available": true, "running": 0],
        ]
    }

    /// The same board, once it reads sysfs — `source: board`, the matrix showing text.
    private func boardState() -> [String: Any] {
        var s = liveState()
        s["source"] = "board"; s["model"] = "Arduino SA,Imola"
        s["mcu"] = ["link": true, "port": "/dev/ttyHS1", "fw": "0.1", "last_seen": 1788983036.0, "sketch": "q", "resets": 0]
        s["led"] = ["mode": "text", "rows": 8, "cols": 13, "frame": [[0, 1, 0], [1, 1, 1]], "text": "hi", "applied": true]
        s["uptime_s"] = 7505; s["cpu_temp_c"] = 47.5; s["load"] = [0.41, 0.31, 0.28]
        s["mem"] = ["total_mb": 3789, "used_mb": 912]; s["wifi"] = ["ssid": "Home_WiFi", "rssi_dbm": -58, "ip": "192.168.1.210"]
        return s
    }

    /// GET /api/telemetry, live 2026-09-09.
    private func flatTelemetry() -> [String: Any] {
        ["t": 1788983036.179, "source": "fake", "hostname": "uno-q", "uptime_s": 41, "load1": 0.25,
         "cpu_temp_c": 44.5, "mem_used_mb": 872, "mem_total_mb": 3789, "disk_used_gb": 6.8, "disk_total_gb": 9.8,
         "wifi_ssid": "Home_WiFi", "wifi_rssi_dbm": -60, "ip": "192.168.1.210",
         "mcu_link": true, "mcu_fw": "fake-0.1", "led_mode": "off", "led_text": NSNull(), "tunnel_up": false]
    }

    /// The earlier nested draft (dashboard/sim.py before the merge) — still decodes.
    private func nestedDraft() -> [String: Any] {
        ["t": 1.0, "source": "sim",
         "host": ["hostname": "uno-q", "uptime_s": 60, "temp_c": 46.0, "load": [0.3], "wifi": ["ip": "192.168.1.210"]],
         "mcu": ["link": false, "version": "sim-0.1"], "led": ["text": "hi"], "tunnel": ["up": true]]
    }

    // ── discovery ──

    @Test func brainPredicate() {
        #expect(QBrainCore.isBrain(platform: "q-the-brain", capabilities: []))
        #expect(QBrainCore.isBrain(platform: "", capabilities: ["telemetry", "chat", "led", "mcu", "shell"]))
        // `led` alone is not the board (a lamp could say that); the arm and the printer never match.
        #expect(!QBrainCore.isBrain(platform: "sticky", capabilities: ["led", "chat"]))
        #expect(!QBrainCore.isBrain(platform: "fomo-the-arm", capabilities: ["chat", "telemetry", "camera", "arm"]))
        #expect(!QBrainCore.isBrain(platform: "bambu-x2d", capabilities: ["chat", "telemetry", "print", "cad"]))
    }

    @Test func pickFindsTheEnrolledRowAndNothingElse() {
        let rows: [[String: Any]] = [
            ["id": "42bd3194", "name": "fomo", "kind": "endpoint", "platform": "fomo-the-arm",
             "url": "https://fomo.example.com", "capabilities": "[\"chat\",\"telemetry\",\"camera\",\"arm\"]"],
            ["id": "dev_q", "name": "q-the-brain", "kind": "endpoint", "platform": "q-the-brain",
             "url": "https://q.example.com/", "capabilities": "[\"telemetry\",\"chat\",\"led\",\"mcu\",\"shell\"]"],
            ["id": "dev_mac", "name": "studio-mac", "kind": "cli", "platform": "darwin-arm64"],
        ]
        let d = QBrainManager.pick(rows)
        #expect(d == QBrainDevice(id: "dev_q", name: "q-the-brain", url: "https://q.example.com"))
        // A daemon named uno-q (the tiny-tech enrolment ON the board) is not the endpoint.
        #expect(QBrainManager.pick([["id": "d1", "name": "uno-q", "kind": "daemon", "platform": "linux-arm64",
                                     "capabilities": "[\"led\",\"mcu\"]"]]) == nil)
        // http:// never qualifies, whatever the row says.
        #expect(QBrainManager.pick([["id": "d2", "name": "q", "kind": "endpoint", "platform": "q-the-brain",
                                     "url": "http://192.168.1.210:8095"]]) == nil)
    }

    // ── decode ──

    @Test func decodesTheLiveFlatStateShape() {
        let s = QBrainCore.decodeState(boardState())
        #expect(s.source == "board" && !s.isSim)
        #expect(s.hostname == "uno-q" && s.model == "Arduino SA,Imola")
        #expect(s.uptimeS == 7505 && s.load1 == 0.41 && s.tempC == 47.5)
        #expect(s.memUsedMb == 912 && s.memTotalMb == 3789)
        #expect(s.diskUsedGb == 6.8 && s.diskTotalGb == 9.8)
        #expect(s.wifi == QBrainCore.Wifi(ssid: "Home_WiFi", rssiDbm: -58, ip: "192.168.1.210"))
        #expect(s.mcuLink == true && s.mcuVersion == "0.1")
        #expect(s.ledText == "hi" && s.ledMode == "text" && s.ledApplied == true && s.tunnelUp == true && s.error == nil)
        #expect(s.ledFrame == [[0, 1, 0], [1, 1, 1]] && s.mcuSketch == "q")
        // The fake source is labelled, the matrix off, no text.
        let f = QBrainCore.decodeState(liveState())
        #expect(f.isSim && f.tempC == 44.5 && f.mcuVersion == "fake-0.1" && f.ledText == nil && f.ledMode == "off")
    }

    @Test func decodesTheFlatTelemetryShapeToo() {
        let s = QBrainCore.decodeState(flatTelemetry())
        #expect(s.isSim)
        #expect(s.tempC == 44.5 && s.load1 == 0.25 && s.uptimeS == 41)
        #expect(s.wifi.ssid == "Home_WiFi" && s.wifi.ip == "192.168.1.210")
        #expect(s.mcuLink == true && s.mcuVersion == "fake-0.1")
        #expect(s.ledText == nil && s.ledMode == "off" && s.tunnelUp == false)
    }

    @Test func decodesTheOlderNestedDraft() {
        let s = QBrainCore.decodeState(nestedDraft())
        #expect(s.isSim && s.tempC == 46.0 && s.uptimeS == 60 && s.load1 == 0.3)
        #expect(s.wifi.ip == "192.168.1.210" && s.mcuLink == false && s.mcuVersion == "sim-0.1")
        #expect(s.ledText == "hi" && s.tunnelUp == true)
    }

    @Test func midBootStateDoesNotCrashOrInvent() {
        let s = QBrainCore.decodeState(["source": "fake", "error": "board read failed: no sysfs"])
        #expect(s.isSim && s.tempC == nil && s.mcuLink == nil && s.wifi.ssid == nil)
        #expect(s.error == "board read failed: no sysfs")
        let empty = QBrainCore.decodeState([:])
        #expect(empty.source == "unknown" && QBrainCore.readings(empty).isEmpty)
    }

    @Test func shapeDetectionRoutesOnlyBoardPayloads() {
        #expect(QBrainCore.looksLikeBrain(liveState()))
        #expect(QBrainCore.looksLikeBrain(flatTelemetry()))
        #expect(QBrainCore.looksLikeBrain(nestedDraft()))
        #expect(!QBrainCore.looksLikeBrain(["gcode_state": "IDLE", "nozzle_temper": 32]))
        #expect(!QBrainCore.looksLikeBrain(["pose": "folded", "joints_deg": ["1": 179.0], "tof_mm": 55]))
        #expect(!QBrainCore.looksLikeBrain([:]))
    }

    // ── readings ──

    @Test func readingsAreOrderedAndHonest() {
        let r = QBrainCore.readings(QBrainCore.decodeState(boardState()))
        #expect(r.map(\.label) == ["soc", "load", "memory", "disk", "wifi", "ip", "uptime", "mcu", "tunnel", "led"])
        #expect(r.first?.value == "47.5°C")
        #expect(r.first(where: { $0.label == "memory" })?.value == "912 / 3789 MB")
        #expect(r.first(where: { $0.label == "wifi" })?.value == "Home_WiFi · -58 dBm")
        #expect(r.first(where: { $0.label == "uptime" })?.value == "2h 05m")
        #expect(r.first(where: { $0.label == "mcu" })?.value == "linked · 0.1")
        // Sim is labelled first, so nobody reads a simulator as the board.
        let sim = QBrainCore.readings(QBrainCore.decodeState(flatTelemetry()))
        #expect(sim.first == TelemetryReading(label: "source", value: "simulated"))
        #expect(sim.first(where: { $0.label == "tunnel" })?.value == "down")
        #expect(sim.first(where: { $0.label == "uptime" })?.value == "41s")
        #expect(!sim.contains(where: { $0.label == "led" }))   // mode "off" with no text is not a reading
    }

    @Test func endpointPanelRoutesBoardTelemetryToTheBrainProjection() {
        let r = EndpointTelemetry.readings(flatTelemetry())
        #expect(r.contains(TelemetryReading(label: "soc", value: "44.5°C")))
        #expect(!r.contains(where: { $0.label == "state" }))   // no printer projection leaks in
    }

    @Test func uptimeFormats() {
        #expect(QBrainCore.uptime(nil) == nil)
        #expect(QBrainCore.uptime(-1) == nil)
        #expect(QBrainCore.uptime(59) == "59s")
        #expect(QBrainCore.uptime(600) == "10m")
        #expect(QBrainCore.uptime(3660) == "1h 01m")
        #expect(QBrainCore.uptime(90_000) == "1d 1h")
    }

    // ── LED ──

    @Test func ledTextIsAsciiTrimmedAndCapped() {
        #expect(QBrainCore.ledText("  hello  ") == "hello")
        #expect(QBrainCore.ledText("") == nil)
        #expect(QBrainCore.ledText("   ") == nil)
        #expect(QBrainCore.ledText("héllo") == nil)
        #expect(QBrainCore.ledText("🧠") == nil)
        #expect(QBrainCore.ledText("a\tb") == nil)
        #expect(QBrainCore.ledText(String(repeating: "x", count: 100))?.count == QBrainCore.ledMaxLength)
    }

    /// /api/state on 2026-09-09 19:55Z after BOARD's deploy: real sysfs, MCU linked
    /// through arduino-router but nothing flashed, text queued and not applied.
    @Test func realBoardWithNoSketchIsLabelledHonestly() {
        var raw = liveState()
        raw["source"] = "board"; raw["cpu_temp_c"] = 42.3
        raw["mcu"] = ["link": true, "port": "/dev/ttyHS1", "fw": NSNull(), "last_seen": 1788983753.7, "sketch": "none",
                      "resets": 0, "source": "board", "socket": "/var/run/arduino-router.sock"]
        raw["led"] = ["mode": "text", "rows": 8, "cols": 13, "text": "hi", "applied": false, "t": 1788983727.1,
                      "error": "matrix not applied: rpc error 2: method q/matrix not available",
                      "rgb": ["red": 0, "green": 0, "blue": 0],
                      "frame": Array(repeating: Array(repeating: 0, count: 13), count: 8)]
        let s = QBrainCore.decodeState(raw)
        #expect(!s.isSim && s.tempC == 42.3)
        #expect(s.mcuLink == true && s.mcuVersion == nil && s.mcuSketch == "none")
        #expect(s.ledApplied == false && s.ledError?.contains("q/matrix") == true)
        #expect(s.ledFrame?.count == 8 && s.ledFrame?.first?.count == 13)
        let r = QBrainCore.readings(s)
        #expect(r.first(where: { $0.label == "mcu" })?.value == "linked · no sketch")
        #expect(r.first(where: { $0.label == "led" })?.value == "hi (not shown)")
    }

    @Test func frameDropsRaggedOrNonNumericWhole() {
        #expect(QBrainCore.frame([[0, 1], [1, 0]]) == [[0, 1], [1, 0]])
        #expect(QBrainCore.frame([[0, 5], [1, "1"]]) == [[0, 1], [1, 1]])   // >0 lights, numeric strings count
        #expect(QBrainCore.frame([[0, 1], [1]]) == nil)                     // ragged
        #expect(QBrainCore.frame([[0, "x"]]) == nil)                        // non-numeric
        #expect(QBrainCore.frame([]) == nil)
        #expect(QBrainCore.frame(NSNull()) == nil)
        #expect(QBrainCore.frame("...") == nil)
    }

    @Test func ledOutcomeReadsAppliedNotJustTheStatus() {
        // Live 2026-09-09: 200 with applied:false while the MCU sketch is not flashed.
        let notApplied: [String: Any] = ["mode": "text", "rows": 8, "cols": 13, "text": "tiny", "applied": false,
                                         "error": "matrix not applied: rpc error 2: method q/matrix not available"]
        #expect(QBrainCore.ledOutcome(status: 200, body: notApplied)
                == "Not shown: matrix not applied: rpc error 2: method q/matrix not available")
        #expect(QBrainCore.ledOutcome(status: 200, body: ["mode": "text", "text": "hi", "applied": true]) == nil)
        #expect(QBrainCore.ledOutcome(status: 200, body: ["mode": "text", "text": "hi"]) == nil)   // older shape, no flag
        #expect(QBrainCore.ledOutcome(status: 200, body: ["applied": false]) == "Not shown: the matrix did not take it.")
        #expect(QBrainCore.ledOutcome(status: 401, body: ["detail": ["error": "sign in required"]]) == "sign in required")
        #expect(QBrainCore.ledOutcome(status: 0, body: nil)?.contains("did not answer") == true)
    }

    // ── health ──

    @Test func healthFollowsFreshness() {
        let now = Date()
        #expect(QBrainCore.health(stateAt: nil, now: now) == .unknown)
        #expect(QBrainCore.health(stateAt: now.addingTimeInterval(-1), now: now) == .live)
        #expect(QBrainCore.health(stateAt: now.addingTimeInterval(-10), now: now) == .stale)
        #expect(QBrainCore.health(stateAt: now.addingTimeInterval(-60), now: now) == .offline)
    }

    // ── SSE ──

    @Test func sseParserSplitsEventsAndKeepsTheTail() {
        var buf = Data(": hello\nretry: 3000\n\ndata: {\"id\":0,\"type\":\"state\",\"t\":1,\"data\":{\"source\":\"board\",\"host\":{\"temp_c\":47.5}}}\n\n: keepalive\n\nevent: led\ndata: {\"via\":\"token\",\"text\":\"hi\"}\n\ndata: {\"partial".utf8)
        let evs = QBrainCore.parseSSE(&buf)
        #expect(evs.count == 2)
        #expect(evs[0].event == "message")
        #expect(evs[1] == QBrainCore.SSEEvent(event: "led", data: "{\"via\":\"token\",\"text\":\"hi\"}"))
        #expect(String(data: buf, encoding: .utf8) == "data: {\"partial")

        // The tail completes on the next chunk.
        buf.append(Data("\"}\r\n\r\n".utf8))
        let more = QBrainCore.parseSSE(&buf)
        #expect(more.count == 1 && more[0].data == "{\"partial\"}")
        #expect(buf.isEmpty)
    }

    @Test func stateFromSSEAcceptsBothEnvelopes() {
        let wrapped = QBrainCore.SSEEvent(event: "message", data: "{\"id\":3,\"type\":\"state\",\"t\":1,\"data\":{\"source\":\"board\",\"host\":{\"temp_c\":48}}}")
        #expect(QBrainCore.decodeState(QBrainCore.stateFromSSE(wrapped) ?? [:]).tempC == 48)
        let named = QBrainCore.SSEEvent(event: "state", data: "{\"source\":\"fake\",\"cpu_temp_c\":46}")
        #expect(QBrainCore.decodeState(QBrainCore.stateFromSSE(named) ?? [:]).tempC == 46)
        let led = QBrainCore.SSEEvent(event: "message", data: "{\"type\":\"led\",\"data\":{\"text\":\"hi\"}}")
        #expect(QBrainCore.stateFromSSE(led) == nil)
        #expect(QBrainCore.stateFromSSE(QBrainCore.SSEEvent(event: "message", data: "not json")) == nil)
    }

    // ── refusals ──

    @Test func refusalPrefersTheBoardsOwnWords() {
        #expect(QBrainCore.refusal(status: 422, body: ["detail": ["error": "send {text} or {frame} or {clear:true}"]])
                == "send {text} or {frame} or {clear:true}")
        #expect(QBrainCore.refusal(status: 401, body: ["detail": ["error": "sign in required", "login": "/api/auth/login"]])
                == "sign in required")
        #expect(QBrainCore.refusal(status: 0, body: nil).contains("did not answer"))
        #expect(QBrainCore.refusal(status: 401, body: nil).contains("did not accept"))
        #expect(QBrainCore.refusal(status: 503, body: nil).contains("starting"))
    }
}
