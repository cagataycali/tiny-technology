/**
 * BodyLiveTests — the robot bodies' pure logic (BodyCore + BodyManager.pick).
 *
 * Fixtures are the LIVE shapes read on 2026-09-17: Scout's /api/telemetry +
 * /api/frame/front (SDK /data, /v2/front through scout.example.com), the Reachy's
 * /api/state (reachy.example.com) and both device rows from /api/devices — trimmed,
 * not invented. Contract: docs/BODIES.md.
 */
import Testing
import Foundation
@testable import Tiny

@Suite struct BodyCoreTests {

    private func liveRows() -> [[String: Any]] {
        [
            ["id": "42bd3194-6be1-4ea1-828c-24f3a8d0f44c", "name": "fomo", "kind": "endpoint", "platform": "fomo-the-arm",
             "url": "https://fomo.example.com",
             "capabilities": "[\"chat\",\"telemetry\",\"camera\",\"arm\",\"move\",\"pose\",\"photo\",\"calibrate\",\"guard\",\"twin\",\"nicla\"]"],
            ["id": "03eb88d6-36d3-466a-9501-c8d02c16b084", "name": "q-the-brain", "kind": "endpoint", "platform": "q-the-brain",
             "url": "https://q.example.com", "capabilities": "[\"telemetry\",\"chat\",\"led\",\"mcu\",\"shell\"]"],
            ["id": "df7dd835-8114-4517-b694-f390b50a0d92", "name": "scout-the-rover", "kind": "endpoint", "platform": "scout-the-rover",
             "url": "https://scout.example.com/",
             "capabilities": "[\"chat\",\"telemetry\",\"camera\",\"drive\",\"stop\",\"photo\",\"lamp\",\"speak\"]"],
            ["id": "a6d198f8-59f1-4952-a225-388ccaa22f29", "name": "tiny-the-reachy", "kind": "endpoint", "platform": "reachy-mini",
             "url": "https://reachy.example.com",
             "capabilities": "[\"chat\",\"telemetry\",\"camera\",\"look\",\"antennas\",\"express\",\"say\",\"stop\",\"home\"]"],
            ["id": "x", "name": "laptop", "kind": "cli", "platform": "darwin-arm64", "capabilities": "[]"],
        ]
    }

    private func liveScout() -> [String: Any] {
        ["signature": "8333e9a2", "battery": 100, "signal_level": 2, "orientation": 359, "lamp": 0, "speed": 0,
         "gps_signal": 0, "latitude": 1000, "longitude": 1000, "vibration": 0, "hdop": 0, "altitude": 0,
         "fix_quality": 0, "power": 4, "current": 121, "voltage": 34, "network_state": 1]
    }

    private func liveReachy() -> [String: Any] {
        ["ok": true, "control_mode": "enabled",
         "head": ["x_mm": 2.59, "y_mm": -1.72, "z_mm": -2.1, "roll": 1.8, "pitch": -10.19, "yaw": -37.35],
         "head_rad": ["roll": 0.031, "pitch": -0.178, "yaw": -0.652],
         "body_yaw": -0.2636, "antennas": [25.05, 43.42], "doa": NSNull(),
         "camera": ["ok": true, "fps": 12], "daemon": ["ok": true]]
    }

    // ── discovery ──

    @Test func predicatesTellTheBodiesApart() {
        #expect(BodyCore.isScout(platform: "scout-the-rover", capabilities: []))
        #expect(BodyCore.isScout(platform: "renamed", capabilities: ["camera", "drive"]))
        #expect(!BodyCore.isScout(platform: "fomo-the-arm", capabilities: ["camera", "move", "arm"]))
        #expect(BodyCore.isReachy(platform: "reachy-mini", capabilities: []))
        #expect(BodyCore.isReachy(platform: "", capabilities: ["look", "antennas"]))
        #expect(!BodyCore.isReachy(platform: "fomo-the-arm", capabilities: ["camera", "arm", "look"]))
        #expect(!BodyCore.isReachy(platform: "scout-the-rover", capabilities: ["drive", "camera"]))
    }

    @Test func pickFindsEachBodyAndTrimsTheSlash() {
        let scout = BodyManager.pick(liveRows(), kind: .scout)
        #expect(scout?.id == "df7dd835-8114-4517-b694-f390b50a0d92")
        #expect(scout?.url == "https://scout.example.com")
        #expect(scout?.kind == .scout)
        let reachy = BodyManager.pick(liveRows(), kind: .reachy)
        #expect(reachy?.name == "tiny-the-reachy")
        #expect(reachy?.url == "https://reachy.example.com")
    }

    @Test func pickIgnoresNonEndpointAndHttpRows() {
        let rows: [[String: Any]] = [
            ["id": "a", "kind": "cli", "platform": "scout-the-rover", "url": "https://x.example", "capabilities": "[]"],
            ["id": "b", "kind": "endpoint", "platform": "reachy-mini", "url": "http://insecure.example", "capabilities": "[]"],
        ]
        #expect(BodyManager.pick(rows, kind: .scout) == nil)
        #expect(BodyManager.pick(rows, kind: .reachy) == nil)
    }

    // ── state ──

    @Test func decodeScoutLiveShape() {
        let s = BodyCore.decodeScout(liveScout())
        #expect(s.battery == 100)
        #expect(s.signal == 2)
        #expect(s.lamp == false)
        #expect(s.gpsFix == false)
        #expect(s.voltage == 34)
        #expect(s.error == nil)
        let r = BodyCore.readings(s)
        #expect(r.first?.label == "battery" && r.first?.value == "100 %")
        #expect(r.contains(TelemetryReading(label: "gps", value: "no fix")))
        #expect(!r.contains { $0.label == "error" })
    }

    @Test func decodeScoutOfflineRover() {
        let s = BodyCore.decodeScout(["error": "SDK unreachable"])
        #expect(s.battery == nil)
        #expect(BodyCore.readings(s) == [TelemetryReading(label: "error", value: "SDK unreachable")])
    }

    @Test func decodeReachyLiveShape() {
        let s = BodyCore.decodeReachy(liveReachy())
        #expect(s.controlMode == "enabled")
        #expect(s.pitch.map { abs($0 + 10.19) < 0.01 } == true)
        #expect(s.antennaRight.map { abs($0 - 25.05) < 0.01 } == true)
        #expect(s.antennaLeft.map { abs($0 - 43.42) < 0.01 } == true)
        #expect(s.cameraOk == true && s.daemonOk == true)
        let r = BodyCore.readings(s)
        #expect(r.contains(TelemetryReading(label: "head", value: "pitch -10° · yaw -37°")))
        #expect(r.contains(TelemetryReading(label: "antennas", value: "R 25° · L 43°")))
        #expect(r.contains(TelemetryReading(label: "camera", value: "streaming")))
    }

    @Test func endpointPanelRoutesBothShapes() {
        #expect(BodyCore.looksLikeScout(liveScout()))
        #expect(!BodyCore.looksLikeReachy(liveScout()))
        #expect(BodyCore.looksLikeReachy(liveReachy()))
        #expect(!BodyCore.looksLikeScout(liveReachy()))
        // Through EndpointTelemetry itself — the Devices sheet path.
        #expect(EndpointTelemetry.readings(liveScout()).first?.label == "battery")
        #expect(EndpointTelemetry.readings(liveReachy()).contains { $0.label == "antennas" })
        // A printer is still a printer.
        #expect(!BodyCore.looksLikeScout(["gcode_state": "IDLE", "battery": 3]))
    }

    // ── command bounds ──

    @Test func scoutDriveIsClamped() {
        let d = BodyCore.scoutDrive(linear: 5, angular: -9, duration: 30)
        #expect(d["linear"] as? Double == BodyCore.scoutMaxLinear)
        #expect(d["angular"] as? Double == -BodyCore.scoutMaxAngular)
        #expect(d["duration"] as? Double == BodyCore.scoutMaxDuration)
        let nan = BodyCore.scoutDrive(linear: .nan, angular: .infinity, duration: .nan)
        #expect(nan["linear"] as? Double == 0 && nan["angular"] as? Double == 0)
        #expect(nan["duration"] as? Double == 0.05)
        let stop = BodyCore.scoutStop
        #expect(stop["linear"] as? Double == 0 && stop["angular"] as? Double == 0)
        #expect((stop["duration"] as? Double ?? 1) <= 0.05)
    }

    @Test func reachyLookIsClamped() {
        let l = BodyCore.reachyLook(pitch: 80, yaw: -80, roll: 50, duration: 0.1)
        #expect(l["pitch"] as? Double == 25 && l["yaw"] as? Double == -25 && l["roll"] as? Double == 15)
        #expect(l["duration"] as? Double == BodyCore.reachyMinDuration)
        let ok = BodyCore.reachyLook(pitch: 10, yaw: -20)
        #expect(ok["pitch"] as? Double == 10 && ok["yaw"] as? Double == -20 && ok["duration"] as? Double == 0.8)
        let a = BodyCore.reachyAntennas(right: 400, left: -400)
        #expect(a["right"] as? Double == 90 && a["left"] as? Double == -90)
    }

    @Test func reachyExpressAndSayRefuseJunk() {
        let names = ["cheerful1", "curious1"]
        #expect(BodyCore.reachyExpress(" curious1 ", allowed: names)?["name"] as? String == "curious1")
        #expect(BodyCore.reachyExpress("happy", allowed: names) == nil)
        #expect(BodyCore.reachySay("   ") == nil)
        #expect((BodyCore.reachySay(String(repeating: "a", count: 500))?["text"] as? String)?.count == 200)
    }

    // ── frames ──

    private var tinyJPEG: Data { Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0xFF, 0xD9]) }

    @Test func scoutFrameDecodesBase64AndDataURL() {
        let b64 = tinyJPEG.base64EncodedString()
        #expect(BodyCore.scoutFrame(["front_frame": b64]) == tinyJPEG)
        #expect(BodyCore.scoutFrame(["frame": "data:image/jpeg;base64," + b64]) == tinyJPEG)
        #expect(BodyCore.scoutFrame(["rear_frame": b64], view: "rear") == tinyJPEG)
        #expect(BodyCore.scoutFrame(["error": "rover offline"]) == nil)
        #expect(BodyCore.scoutFrame(["front_frame": Data("not a jpeg".utf8).base64EncodedString()]) == nil)
    }

    @Test func mjpegSplitterHandlesReachyBoundary() {
        var buf = Data("--reachyframe\r\nContent-Type: image/jpeg\r\nContent-Length: 10\r\n\r\n".utf8)
        buf.append(tinyJPEG)
        buf.append(Data("\r\n--reachyframe\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
        buf.append(tinyJPEG.prefix(6))                       // half a frame still in flight
        let (frames, rest) = BodyCore.splitJPEGs(buf)
        #expect(frames == [tinyJPEG])
        #expect(rest.suffix(6) == tinyJPEG.prefix(6))
    }

    // ── refusals ──

    @Test func refusalUsesTheDashboardsWords() {
        #expect(BodyCore.refusal(.reachy, status: 401, body: ["detail": ["error": "control requires auth"]]) == "control requires auth")
        #expect(BodyCore.refusal(.scout, status: 401, body: ["detail": "authentication required"]) == "authentication required")
        #expect(BodyCore.refusal(.scout, status: 0, body: nil).contains("did not answer"))
        #expect(BodyCore.refusal(.reachy, status: 429, body: nil).contains("5 commands"))
    }

    @Test func tokenKeysAreDistinct() {
        #expect(BodyKind.scout.tokenKey != BodyKind.reachy.tokenKey)
        #expect(BodyKind.scout.tokenKey.hasPrefix("body."))
    }
}
