/**
 * ArmLiveTests — the arm surface's pure logic (ArmCore + ArmManager.pick).
 *
 * Fixtures are the LIVE shapes read from https://arm.example.com on 2026-09-05
 * (/api/state, /api/telemetry) and the device row from /api/devices — trimmed,
 * not invented. Web/dashboard parity target: ~/strands-arm/dashboard/API.md.
 */
import Testing
import Foundation
import CoreGraphics
@testable import Tiny

@Suite struct ArmCoreTests {

    private func liveState() -> [String: Any] {
        [
            "t": 1757040000.1,
            "arm": [
                "port": "/dev/cu.usbmodem5AB01818061", "ok": true, "pose": "taught",
                "joints": [
                    ["id": 1, "name": "shoulder_pan", "deg": 179.6, "home": 179.0, "torque": false],
                    ["id": 2, "name": "shoulder_lift", "deg": 83.8, "home": 84.71, "torque": false],
                    ["id": 5, "name": "wrist_roll", "deg": 176.6, "home": 180.8, "torque": false],
                    ["id": 6, "name": "tilt", "deg": 95.4, "home": 178.71, "torque": false],
                ],
            ],
            "nicla": ["transport": "usb", "stream": NSNull(), "tof_mm": 55, "detect": NSNull()],
            "guard": ["pan_tilt_range_deg": 60, "look": ["pan": [-60.0, 60.0], "tilt": [-60.0, 60.0]],
                      "home": ["1": 179.0], "busy": false],
        ]
    }

    // ── discovery ──

    @Test func armPredicateAcceptsEitherHalf() {
        #expect(ArmCore.isArm(platform: "strands-arm", capabilities: []))
        #expect(ArmCore.isArm(platform: "", capabilities: ["chat", "arm"]))
        #expect(!ArmCore.isArm(platform: "bambu-x2d", capabilities: ["chat", "telemetry", "print", "cad"]))
        #expect(!ArmCore.isArm(platform: "nicla-vision", capabilities: ["camera", "mic"]))
    }

    @Test func pickFindsTheArmRowAndReadsItsUrl() {
        let rows: [[String: Any]] = [
            ["id": "f4a8", "name": "3D printer", "kind": "endpoint", "platform": "bambu-x2d",
             "url": "https://printer.example", "capabilities": "[\"chat\",\"telemetry\",\"print\",\"cad\"]"],
            ["id": "2b7f", "name": "cagatay-mac", "kind": "cli", "platform": "darwin-arm64", "capabilities": ["arm"]],
            ["id": "70e1", "name": "fomo-the-arm", "kind": "endpoint", "platform": "strands-arm",
             "url": "https://arm.example/", "capabilities": "[\"chat\",\"telemetry\",\"camera\",\"arm\",\"look\"]"],
        ]
        let arm = ArmManager.pick(rows)
        #expect(arm?.id == "70e1")
        #expect(arm?.name == "fomo-the-arm")
        // trailing slash trimmed so `url + "/api/state"` is one slash
        #expect(arm?.url == "https://arm.example")
    }

    @Test func pickIgnoresNonEndpointAndNonHttps() {
        // A CLI daemon that happens to advertise "arm" is not a robot at an address.
        #expect(ArmManager.pick([["id": "x", "kind": "cli", "platform": "strands-arm", "capabilities": ["arm"]]]) == nil)
        #expect(ArmManager.pick([["id": "x", "kind": "endpoint", "platform": "strands-arm", "url": "http://lan.local"]]) == nil)
        #expect(ArmManager.pick([]) == nil)
    }

    // ── state ──

    @Test func decodesTheLiveState() {
        let s = ArmCore.decodeState(liveState())
        #expect(s.ok)
        #expect(s.pose == "taught")
        #expect(s.joints.count == 4)
        #expect(s.joints[3].name == "tilt")
        #expect(s.look == ArmCore.LookRange(pan: -60...60, tilt: -60...60))
        #expect(s.transport == "usb")
        #expect(s.stream == nil)
        #expect(s.tofMm == 55)
        #expect(s.detect == nil)
        #expect(!s.busy)
    }

    @Test func decodeSurvivesAnEmptyDashboard() {
        let s = ArmCore.decodeState(["arm": ["ok": false]])
        #expect(!s.ok)
        #expect(s.joints.isEmpty)
        #expect(s.pose == "unknown")
        #expect(s.look == .fallback)
        #expect(ArmCore.currentLook(s) == nil)
    }

    @Test func lookRangeFallsBackToPanTiltRange() {
        let s = ArmCore.decodeState(["guard": ["pan_tilt_range_deg": 45]])
        #expect(s.look == ArmCore.LookRange(pan: -45...45, tilt: -45...45))
        // malformed look (lo > hi) keeps the fallback rather than an inverted range
        let bad = ArmCore.decodeState(["guard": ["look": ["pan": [10, -10]]]])
        #expect(bad.look.pan == (-60.0)...60.0)
    }

    @Test func currentLookIsRelativeAndWrapSafe() {
        let s = ArmCore.decodeState(liveState())
        let look = ArmCore.currentLook(s)
        #expect(look != nil)
        #expect(abs((look?.pan ?? 0) - (176.6 - 180.8)) < 0.001)
        #expect(abs((look?.tilt ?? 0) - (95.4 - 178.71)) < 0.001)
        // servo at 357.2 with home 179 was the pre-rezero bench: 178.2 apart, not -181.8
        #expect(ArmCore.wrap(357.2 - 179.0) == 178.2)
        #expect(ArmCore.wrap(2.0 - 358.0) == 4.0)
        #expect(ArmCore.wrap(-190) == 170)
    }

    // ── pad ──

    @Test func padCentreIsHomeAndEdgesAreTheGuardRange() {
        let r = ArmCore.LookRange(pan: -60...60, tilt: -30...30)
        let size = CGSize(width: 300, height: 200)
        #expect(ArmCore.lookTarget(point: CGPoint(x: 150, y: 100), in: size, range: r) == ArmCore.Look(pan: 0, tilt: 0))
        #expect(ArmCore.lookTarget(point: CGPoint(x: 0, y: 0), in: size, range: r) == ArmCore.Look(pan: -60, tilt: 30))
        #expect(ArmCore.lookTarget(point: CGPoint(x: 300, y: 200), in: size, range: r) == ArmCore.Look(pan: 60, tilt: -30))
        // outside the pad clamps to the edge — the guard is never asked past its range
        #expect(ArmCore.lookTarget(point: CGPoint(x: -50, y: 900), in: size, range: r) == ArmCore.Look(pan: -60, tilt: -30))
    }

    @Test func padTargetRoundsToHalfDegrees() {
        let r = ArmCore.LookRange(pan: -60...60, tilt: -60...60)
        let t = ArmCore.lookTarget(point: CGPoint(x: 101, y: 57), in: CGSize(width: 300, height: 300), range: r)
        #expect(t.pan * 2 == (t.pan * 2).rounded())
        #expect(t.tilt * 2 == (t.tilt * 2).rounded())
    }

    @Test func padPointInvertsLookTarget() {
        let r = ArmCore.LookRange(pan: -60...60, tilt: -60...60)
        let size = CGSize(width: 240, height: 180)
        let look = ArmCore.Look(pan: 30, tilt: -15)
        let p = ArmCore.padPoint(for: look, in: size, range: r)
        #expect(ArmCore.lookTarget(point: p, in: size, range: r) == look)
    }

    @Test func zeroSizePadIsHome() {
        #expect(ArmCore.lookTarget(point: CGPoint(x: 5, y: 5), in: .zero, range: .fallback) == ArmCore.Look(pan: 0, tilt: 0))
    }

    // ── coalescing ──

    @Test func fiveHertzCoalescing() {
        #expect(ArmCore.shouldSend(now: 100, last: nil))
        #expect(!ArmCore.shouldSend(now: 100.1, last: 100))
        #expect(!ArmCore.shouldSend(now: 100.199, last: 100))
        #expect(ArmCore.shouldSend(now: 100.2, last: 100))
        #expect(ArmCore.shouldSend(now: 105, last: 100))
    }

    @Test func subHalfDegreeChangesAreNoise() {
        let a = ArmCore.Look(pan: 10, tilt: 5)
        #expect(ArmCore.changed(nil, a))
        #expect(!ArmCore.changed(a, ArmCore.Look(pan: 10.2, tilt: 5.1)))
        #expect(ArmCore.changed(a, ArmCore.Look(pan: 10.5, tilt: 5)))
        #expect(ArmCore.changed(a, ArmCore.Look(pan: 10, tilt: 4.5)))
    }

    // ── refusals ──

    @Test func refusalsAreNeverEmpty() {
        #expect(ArmCore.refusal(status: 401, body: nil) == "Arm token rejected — paste it again.")
        #expect(ArmCore.refusal(status: 409, body: ["error": "calibrate running"]) == "Busy: calibrate running")
        #expect(ArmCore.refusal(status: 409, body: nil) == "Arm is busy with another job.")
        #expect(ArmCore.refusal(status: 400, body: ["error": "tilt 75 outside look range"]) == "tilt 75 outside look range")
        #expect(ArmCore.refusal(status: 422, body: ["detail": "pan must be a number"]) == "pan must be a number")
        #expect(ArmCore.refusal(status: 500, body: [:]) == "Refused (500).")
        #expect(ArmCore.refusal(status: 0, body: nil) == "Arm not answering.")
        // Fomo's FastAPI envelope (2026-09-09): the guard's words, never "Refused (422)"
        #expect(ArmCore.refusal(status: 422, body: ["detail": ["error": "rule 3 head window: pan 170"]]) == "rule 3 head window: pan 170")
        #expect(ArmCore.refusal(status: 405, body: ["detail": "Method Not Allowed"]) == "The arm does not take this method here (405).")
        #expect(ArmCore.refusal(status: 404, body: ["detail": ["error": "no such route"]]) == "The arm has no such route (404).")
    }

    // ── camera ──

    @Test func badgeFollowsFreshnessNotOutcome() {
        let now = Date()
        #expect(ArmCore.badge(streamAt: now.addingTimeInterval(-1), snapshotAt: nil, now: now) == .live)
        // stream stalled 3 s ago, snapshot fresh → snapshot, honestly
        #expect(ArmCore.badge(streamAt: now.addingTimeInterval(-3), snapshotAt: now.addingTimeInterval(-1), now: now) == .snapshot)
        #expect(ArmCore.badge(streamAt: nil, snapshotAt: now.addingTimeInterval(-4), now: now) == .none)
        #expect(ArmCore.badge(streamAt: nil, snapshotAt: nil, now: now) == .none)
        #expect(ArmCore.CameraBadge.none.label == "no camera")
        #expect(ArmCore.CameraBadge.live.label == "live")
    }

    @Test func splitsMJPEGPartsAndKeepsTheTail() {
        let jpeg1 = Data([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9])
        let jpeg2 = Data([0xFF, 0xD8, 0x03, 0xFF, 0xD9])
        var buf = Data("--frame\r\nContent-Type: image/jpeg\r\n\r\n".utf8)
        buf += jpeg1
        buf += Data("\r\n--frame\r\n\r\n".utf8)
        buf += jpeg2
        buf += Data([0xFF, 0xD8, 0x09])  // a frame still arriving
        let (frames, rest) = ArmCore.splitJPEGs(buf)
        #expect(frames == [jpeg1, jpeg2])
        #expect(rest == Data([0xFF, 0xD8, 0x09]))
    }

    @Test func runawayBufferWithoutAFrameIsDropped() {
        let junk = Data(repeating: 0x00, count: 600 * 1024)
        let (frames, rest) = ArmCore.splitJPEGs(junk)
        #expect(frames.isEmpty)
        #expect(rest.isEmpty)
    }

    // ── telemetry projection ──

    private func liveTelemetry() -> [String: Any] {
        [
            "pose": "taught",
            "joints_deg": ["shoulder_pan": 179.6, "shoulder_lift": 83.8, "elbow_flex": 262.4,
                           "wrist_flex": 256.1, "wrist_roll": 176.6, "tilt": 95.4],
            "torque": false, "job": NSNull(), "bus": true, "camera": "usb", "tof_mm": 55,
            "rssi": NSNull(), "detect": NSNull(),
            "look": ["pan": [-60.0, 60.0], "tilt": [-60.0, 60.0]],
            "agent_busy": false, "t": 1788630923.9,
        ]
    }

    @Test func armTelemetryIsRecognisedByShape() {
        #expect(ArmCore.isArmTelemetry(liveTelemetry()))
        #expect(!ArmCore.isArmTelemetry(["gcode_state": "RUNNING", "progress": 62]))
        #expect(!ArmCore.isArmTelemetry([:]))
    }

    @Test func armReadingsFromTheLivePayload() {
        let r = ArmCore.readings(liveTelemetry())
        let byLabel = Dictionary(uniqueKeysWithValues: r.map { ($0.label, $0.value) })
        #expect(r.first?.label == "pose")
        #expect(byLabel["pose"] == "taught")
        #expect(byLabel["head"] == "pan 177° · tilt 95°")
        #expect(byLabel["joints"] == "6")
        #expect(byLabel["distance"] == "55 mm")
        #expect(byLabel["camera"] == "usb")
        // null rssi / detect / agent idle → no row, never "nil dBm"
        #expect(byLabel["wi-fi"] == nil)
        #expect(byLabel["sees"] == nil)
        #expect(byLabel["agent"] == nil)
    }

    @Test func armReadingsShowTorqueDetectionAndThinking() {
        var t = liveTelemetry()
        t["torque"] = true
        t["detect"] = ["label": "face", "cx": 0.5, "cy": 0.4]
        t["rssi"] = -52
        t["agent_busy"] = true
        let byLabel = Dictionary(uniqueKeysWithValues: ArmCore.readings(t).map { ($0.label, $0.value) })
        #expect(byLabel["pose"] == "taught · torque on")
        #expect(byLabel["sees"] == "face")
        #expect(byLabel["wi-fi"] == "-52 dBm")
        #expect(byLabel["agent"] == "thinking")
    }

    @Test func armReadingsEmptyPayloadIsEmpty() {
        #expect(ArmCore.readings([:]).isEmpty)
    }
}
