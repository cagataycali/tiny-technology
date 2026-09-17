/**
 * FomoApiTests — FomoCore (pure) + FomoClient (route/method/body/error mapping
 * through a stub URLProtocol). The state fixture is the LIVE /api/state of
 * https://fomo.example.com on 2026-09-09 22:56Z (urdf/poses trimmed, not invented).
 */
import Testing
import Foundation
@testable import Tiny

private let liveState = "{\"ok\": true, \"error\": null, \"port\": \"/dev/cu.usbmodem5AB01818061\", \"source\": \"bus\", \"joints\": {\"1\": 176.92, \"2\": 84.11, \"3\": 262.27, \"4\": 256.64, \"5\": 186.77, \"6\": 181.05}, \"t\": 1788994736.421978, \"age_s\": 0.07, \"torque\": {\"1\": false, \"2\": false, \"3\": false, \"4\": false, \"5\": false, \"6\": false}, \"voltage\": 5.6, \"names\": {\"1\": \"base\", \"2\": \"shoulder_lift\", \"3\": \"elbow\", \"4\": \"wrist_flex\", \"5\": \"pan\", \"6\": \"tilt\"}, \"folded\": true, \"busy\": null, \"home\": {\"1\": 176.66, \"2\": 83.85, \"3\": 262.35, \"4\": 256.46, \"5\": 187.82, \"6\": 180.35}, \"windows\": {\"1\": [66.36, 251.02], \"2\": [83.23, 290.04], \"3\": [68.73, 262.44], \"4\": [84.29, 284.85], \"5\": [27.819999999999993, 347.82], \"6\": [100.35, 260.35]}, \"calibrated\": true, \"gate\": true, \"nicla\": {\"ok\": true, \"url\": \"http://192.168.1.208:8080\", \"fw\": \"fomo_node 0.2\", \"rssi\": -37, \"tof_mm\": 134, \"age_s\": 2.9, \"mounted\": false, \"imu\": {\"roll\": 51.8, \"pitch\": 3.8}, \"stream\": {\"fps\": 0.0, \"open\": false}}, \"rl\": {\"running\": false, \"policy\": null, \"policies\": [\"frame\", \"track\"], \"stage\": {\"stage\": 0, \"name\": \"shadow\", \"allowed\": false, \"reason\": \"the arm waits for 'BENCH OK FOR RL ARM' in the RL-LIVE journal header\"}, \"mode\": null, \"cap_deg\": 5.0, \"ticks\": 0, \"error\": null}}"

private func obj(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

// ── Pure core ───────────────────────────────────────────────────────────────

@Suite struct FomoCoreTests {
    @Test func decodesTheLiveFlatState() {
        let raw = obj(liveState)
        #expect(FomoCore.isFomoState(raw))
        let s = FomoCore.decodeState(raw)
        #expect(s.ok)
        #expect(s.source == "bus")
        #expect(s.joints.count == 6)
        #expect(s.joints.map(\.id) == [1, 2, 3, 4, 5, 6])
        #expect(s.joints[0].name == "base")
        #expect(s.joints[4].name == "pan" && s.joints[5].name == "tilt")
        #expect(s.joints[1].deg == 84.11 && s.joints[1].home == 83.85)
        #expect(s.voltage == 5.6)
        #expect(s.folded == true)
        #expect(s.busy == nil && s.motion == nil)
        #expect(s.gate && s.calibrated)
        #expect(!s.anyTorque && !s.torqueOn)
        // look = pan/tilt relative to home, wrap-safe
        let look = s.currentLook
        #expect(look != nil)
        #expect(abs((look?.pan ?? 99) - (-1.05)) < 0.001)
        #expect(abs((look?.tilt ?? 99) - 0.70) < 0.001)
        // legal range = the guard's head window around home (±160 pan, ±80 tilt)
        #expect(abs(s.look.pan.lowerBound + 160) < 0.01 && abs(s.look.pan.upperBound - 160) < 0.01)
        #expect(abs(s.look.tilt.lowerBound + 80) < 0.01 && abs(s.look.tilt.upperBound - 80) < 0.01)
        // nicla
        #expect(s.nicla?.ok == true)
        #expect(s.nicla?.tofMm == 134)
        #expect(s.nicla?.roll == 51.8 && s.nicla?.pitch == 3.8)
        #expect(s.nicla?.rssi == -37)
        #expect(s.nicla?.mounted == false)
        #expect(s.nicla?.ageS == 2.9)
        // rl
        #expect(s.rl?.running == false)
        #expect(s.rl?.policies == ["frame", "track"])
        #expect(s.rl?.stage == 0 && s.rl?.stageName == "shadow" && s.rl?.allowed == false)
        #expect(s.rl?.reason?.contains("BENCH OK FOR RL ARM") == true)
        #expect(s.rl?.capDeg == 5.0)
    }

    @Test func twinFreshnessUsesHardwareAgePlusElapsedTime() {
        let now = Date(timeIntervalSince1970: 1000)
        var state = FomoCore.decodeState(obj(liveState))
        state.ageS = 2
        #expect(FomoCore.stateFresh(state, requestStartedAt: now, now: now))
        #expect(!FomoCore.stateFresh(state, requestStartedAt: now.addingTimeInterval(-1), now: now))
        state.ageS = 0
        #expect(!FomoCore.stateFresh(state, requestStartedAt: now.addingTimeInterval(-3), now: now))
        #expect(!FomoCore.stateFresh(state, requestStartedAt: now.addingTimeInterval(1), now: now))
        #expect(!FomoCore.stateFresh(state, requestStartedAt: nil, now: now))
        #expect(!FomoCore.stateFresh(nil, requestStartedAt: now, now: now))
        for age: Double? in [nil, -1, 3, 86400, .infinity, .nan] {
            state.ageS = age
            #expect(!FomoCore.stateFresh(state, requestStartedAt: now, now: now))
        }
    }

    @Test func twinFreshnessCountsSlowResponseTimeAgainstTheSample() {
        let started = Date(timeIntervalSince1970: 1000)
        var state = FomoCore.decodeState(obj(liveState))
        state.ageS = 0.1
        #expect(!FomoCore.stateFresh(state, requestStartedAt: started,
                                    now: started.addingTimeInterval(4)))
    }

    @Test func disconnectedOrUnknownHardwareCannotLookLiveOnSuccessfulHTTP() {
        let now = Date(timeIntervalSince1970: 1000)
        let original = FomoCore.decodeState(obj(liveState))
        for fault in ["offline", "error", "none", "unknown", "empty"] {
            var state = original
            if fault == "offline" { state.ok = false }
            if fault == "error" { state.error = "bus lost: Device not configured" }
            if fault == "none" { state.source = "none" }
            if fault == "unknown" { state.source = "future-transport" }
            if fault == "empty" { state.joints = [] }
            #expect(!FomoCore.stateFresh(state, requestStartedAt: now, now: now))
            #expect(FomoCore.twinStatus(state, requestStartedAt: now, now: now) == "twin · stale")
        }
    }

    @Test func simulatedTwinIsNeverLabelledLiveHardware() {
        let now = Date(timeIntervalSince1970: 1000)
        var state = FomoCore.decodeState(obj(liveState))
        #expect(FomoCore.twinStatus(state, requestStartedAt: now, now: now) == "twin · live")
        state.source = "sim"
        #expect(FomoCore.twinStatus(state, requestStartedAt: now, now: now) == "twin · simulated")
        #expect(FomoCore.twinStatus(state, requestStartedAt: now, now: now.addingTimeInterval(4)) == "twin · stale")
    }

    @Test func strandsArmShapeIsNotFomo() {
        let raw = obj(#"{"arm":{"ok":true,"joints":[{"id":5,"deg":180}]},"guard":{}}"#)
        #expect(!FomoCore.isFomoState(raw))
    }

    @Test func midBootStateIsHonest() {
        let s = FomoCore.decodeState(obj(#"{"ok":false,"error":"no adapter","source":"none","joints":{},"names":{}}"#))
        #expect(!s.ok && s.error == "no adapter" && s.joints.isEmpty && s.currentLook == nil)
        #expect(s.look == .fallback)
    }

    @Test func torqueAndMotionProgress() {
        var raw = obj(liveState)
        raw["torque"] = ["1": true, "2": true, "3": true, "4": true, "5": true, "6": true]
        raw["busy"] = "motion:happy 3/7"
        let s = FomoCore.decodeState(raw)
        #expect(s.torqueOn && s.anyTorque)
        #expect(s.motion == FomoCore.MotionProgress(name: "happy", i: 3, n: 7))
        #expect(FomoCore.motionProgress("motion:wave") == FomoCore.MotionProgress(name: "wave", i: nil, n: nil))
        #expect(FomoCore.motionProgress("pose home") == nil)
        #expect(FomoCore.motionProgress("motion:") == nil)
    }

    @Test func decodesMotionsAndPoses() {
        let m = FomoCore.decodeMotions(obj(#"{"wave":{"description":"a wave","frames":[{},{},{}],"builtin":true,"ok":true,"why":null},"approve":{"description":"a nod","frames":[{}],"builtin":true,"ok":false,"why":"tilt out of window"}}"#))
        #expect(m.map(\.name) == ["approve", "wave"])
        #expect(m[1].frames == 3 && m[1].ok)
        #expect(m[0].ok == false && m[0].why == "tilt out of window")
        let p = FomoCore.decodePoses(obj(#"{"up":{"rel_deg":{},"description":"","builtin":true,"ok":true,"why":null},"home":{"rel_deg":{},"description":"folded","builtin":true,"ok":true,"why":null},"attention":{"rel_deg":{},"builtin":true,"ok":true}}"#))
        #expect(p.map(\.name) == ["home", "attention", "up"])
    }

    @Test func refusalUnwrapsFastAPIDetail() {
        // 422 guard words — the live shape
        let b422 = obj(#"{"detail":{"error":"\"no motion 'nope'; known: approve, deny\""}}"#)
        #expect(FomoCore.refusal(status: 422, method: "POST", path: "/api/control/motion", body: b422).contains("no motion 'nope'"))
        // 401 the gate
        let b401 = obj(#"{"detail":{"error":"token required","login":"/api/auth/login"}}"#)
        #expect(FomoCore.refusal(status: 401, method: "POST", path: "/api/control/stop", body: b401) == "token required")
        // 405 — the owner's report: never a bare "Method Not Allowed"
        let b405 = obj(#"{"detail":"Method Not Allowed"}"#)
        let r = FomoCore.refusal(status: 405, method: "POST", path: "/api/control/look", body: b405)
        #expect(r == "Fomo does not take POST /api/control/look (405).")
        #expect(FomoCore.refusal(status: 409, method: "POST", path: "/x", body: obj(#"{"detail":{"error":"busy: motion:wave"}}"#)) == "busy: motion:wave")
        #expect(FomoCore.refusal(status: 409, method: "POST", path: "/x", body: nil) == "Fomo is busy with another job.")
        #expect(FomoCore.refusal(status: 0, method: "GET", path: "/api/state", body: nil) == "Fomo is not answering.")
        #expect(FomoCore.refusal(status: 503, method: "POST", path: "/x", body: obj(#"{"detail":{"error":"arm not attached"}}"#)) == "arm not attached")
        // strands-arm style flat {error} still works
        #expect(FomoCore.refusal(status: 422, method: "POST", path: "/x", body: obj(#"{"error":"rule 3 head window"}"#)) == "rule 3 head window")
    }

    @Test func bodiesMatchTheWebDash() {
        let l = FomoCore.lookBody(pan: 40, tilt: nil)
        let acts = l["actions"] as? [[String: Any]]
        #expect(acts?.count == 1)
        let look = acts?.first?["look"] as? [String: Any]
        #expect(look?["pan"] as? Double == 40 && look?["tilt"] == nil)
        #expect(l["speed"] == nil)
        let h = FomoCore.homeBody(speed: 30)
        #expect((h["actions"] as? [[String: Any]])?.first?["home"] as? Bool == true)
        #expect(h["speed"] as? Double == 30)
    }
}

// ── Client through a stub transport ─────────────────────────────────────────

/// Records every request and answers from a script keyed on "METHOD /path".
final class FomoStubProtocol: URLProtocol {
    nonisolated(unsafe) static var script: [String: (Int, Data, [String: String])] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.seen.append(request)
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let (status, data, headers) = Self.script[key] ?? (404, Data(#"{"detail":"Not Found"}"#.utf8), [:])
        Self.lock.unlock()
        var h = ["Content-Type": "application/json"]
        h.merge(headers) { _, b in b }
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func reset() { lock.lock(); script = [:]; seen = []; lock.unlock() }
    static var last: URLRequest? { lock.lock(); defer { lock.unlock() }; return seen.last }
    static func body(_ r: URLRequest?) -> [String: Any]? {
        guard let r else { return nil }
        let data = r.httpBody ?? r.httpBodyStream.map { s -> Data in
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            return d
        }
        return data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
    }
}

private func stubClient(token: String? = "tok") -> FomoClient {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [FomoStubProtocol.self]
    return FomoClient(base: URL(string: "https://fomo.example")!, session: URLSession(configuration: cfg), token: { token })
}

@Suite(.serialized) struct FomoClientTests {
    @Test func stateHitsTheFlatRouteWithBearer() async throws {
        FomoStubProtocol.reset()
        FomoStubProtocol.script["GET /api/state"] = (200, Data(liveState.utf8), [:])
        let s = try await stubClient().state()
        #expect(s.joints.count == 6 && s.voltage == 5.6)
        let r = FomoStubProtocol.last
        #expect(r?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(r?.url?.absoluteString == "https://fomo.example/api/state")
    }

    @Test func lookIsAMoveWithLookAction() async throws {
        FomoStubProtocol.reset()
        FomoStubProtocol.script["POST /api/control/move"] = (200, Data(#"{"ok":true}"#.utf8), [:])
        try await stubClient().look(pan: 12.5, tilt: -4)
        let r = FomoStubProtocol.last
        #expect(r?.httpMethod == "POST" && r?.url?.path == "/api/control/move")
        let look = ((FomoStubProtocol.body(r)?["actions"] as? [[String: Any]])?.first?["look"]) as? [String: Any]
        #expect(look?["pan"] as? Double == 12.5 && look?["tilt"] as? Double == -4)
    }

    @Test func homeMotionPoseTorqueStopRoutes() async throws {
        FomoStubProtocol.reset()
        for k in ["POST /api/control/move", "POST /api/control/motion", "POST /api/control/pose", "POST /api/control/torque", "POST /api/control/stop"] {
            FomoStubProtocol.script[k] = (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        let c = stubClient()
        try await c.home()
        #expect((FomoStubProtocol.body(FomoStubProtocol.last)?["actions"] as? [[String: Any]])?.first?["home"] as? Bool == true)
        try await c.motion("wave", stay: true)
        #expect(FomoStubProtocol.last?.url?.path == "/api/control/motion")
        #expect(FomoStubProtocol.body(FomoStubProtocol.last)?["name"] as? String == "wave")
        #expect(FomoStubProtocol.body(FomoStubProtocol.last)?["stay"] as? Bool == true)
        try await c.pose("attention")
        #expect(FomoStubProtocol.last?.url?.path == "/api/control/pose")
        try await c.torque(false)
        #expect(FomoStubProtocol.body(FomoStubProtocol.last)?["on"] as? Bool == false)
        try await c.stop()
        #expect(FomoStubProtocol.last?.url?.path == "/api/control/stop" && FomoStubProtocol.last?.httpMethod == "POST")
        #expect(FomoStubProtocol.seen.count == 5)
    }

    @Test func refusalsCarryTheServersWords() async {
        FomoStubProtocol.reset()
        FomoStubProtocol.script["POST /api/control/motion"] = (422, Data(#"{"detail":{"error":"wave unplayable: tilt 95 outside window"}}"#.utf8), [:])
        do { try await stubClient().motion("wave"); Issue.record("expected a throw") }
        catch let e as FomoError { #expect(e.status == 422 && e.message == "wave unplayable: tilt 95 outside window") }
        catch { Issue.record("wrong error \(error)") }
        // the old dialect on Fomo → 405 with a sentence, not "Method Not Allowed"
        FomoStubProtocol.script["POST /api/control/look"] = (405, Data(#"{"detail":"Method Not Allowed"}"#.utf8), [:])
        let c = stubClient()
        do { try await c.rlLive(seconds: 10); Issue.record("expected a throw") }
        catch let e as FomoError { #expect(e.status == 404 && e.message == "Fomo has no /api/rl/live (404).") }
        catch { Issue.record("wrong error \(error)") }
        // 401 without a token
        FomoStubProtocol.script["POST /api/control/stop"] = (401, Data(#"{"detail":{"error":"token required","login":"/api/auth/login"}}"#.utf8), [:])
        do { try await stubClient(token: nil).stop(); Issue.record("expected a throw") }
        catch let e as FomoError { #expect(e.status == 401 && e.message == "token required") }
        catch { Issue.record("wrong error \(error)") }
        #expect(FomoStubProtocol.seen.last?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func photoIsTheAuthedSnapshotRoute() async throws {
        FomoStubProtocol.reset()
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9])
        FomoStubProtocol.script["GET /api/camera/snapshot"] = (200, jpeg, ["Content-Type": "image/jpeg", "X-Fomo-Path": "/Users/x/.fomo/photos/a.jpg"])
        let (data, path) = try await stubClient().takePhoto()
        #expect(data == jpeg && path == "/Users/x/.fomo/photos/a.jpg")
        #expect(FomoStubProtocol.last?.httpMethod == "GET")
        #expect(FomoStubProtocol.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        FomoStubProtocol.script["GET /api/camera/snapshot"] = (503, Data(#"{"detail":{"error":"no camera source"}}"#.utf8), [:])
        do { _ = try await stubClient().takePhoto(); Issue.record("expected a throw") }
        catch let e as FomoError { #expect(e.status == 503 && e.message == "no camera source") }
        catch { Issue.record("wrong error \(error)") }
    }

    @Test func rlRoutesAndAgentURL() async throws {
        FomoStubProtocol.reset()
        FomoStubProtocol.script["GET /api/rl/status"] = (200, Data(#"{"running":true,"policy":"frame","policies":["frame","track"],"stage":{"stage":0,"name":"shadow","allowed":false,"reason":"r"},"ticks":12}"#.utf8), [:])
        FomoStubProtocol.script["POST /api/rl/shadow"] = (200, Data(#"{"running":false,"policies":[],"stage":{}}"#.utf8), [:])
        let c = stubClient()
        let st = try await c.rlStatus()
        #expect(st.running && st.policy == "frame" && st.ticks == 12)
        _ = try await c.rlShadow(policy: "track", seconds: 20)
        let b = FomoStubProtocol.body(FomoStubProtocol.last)
        #expect(b?["policy"] as? String == "track" && b?["seconds"] as? Double == 20)
        _ = try await c.rlStop()
        #expect(FomoStubProtocol.body(FomoStubProtocol.last)?["stop"] as? Bool == true)
        #expect(c.agentURL?.absoluteString == "wss://fomo.example/ws/agent?token=tok")
        #expect(c.streamURL.absoluteString == "https://fomo.example/api/nicla/stream")
        #expect(stubClient(token: nil).agentURL?.absoluteString == "wss://fomo.example/ws/agent")
    }

    @Test func chatFallbackShape() async throws {
        FomoStubProtocol.reset()
        FomoStubProtocol.script["POST /api/chat"] = (200, Data(#"{"result":"nodded","tools":["motion"],"errors":[]}"#.utf8), [:])
        let r = try await stubClient().chat("nod")
        #expect(r.result == "nodded" && r.tools == ["motion"] && r.errors.isEmpty)
        #expect(FomoStubProtocol.body(FomoStubProtocol.last)?["prompt"] as? String == "nod")
    }
}

// ── PiP layout prefs (pure) ─────────────────────────────────────────────────

@Suite struct FomoPiPTests {
    @Test func nearestCornerIsTheSnapDecision() {
        let s = CGSize(width: 400, height: 800)
        #expect(FomoPiPCorner.nearest(to: CGPoint(x: 10, y: 10), in: s) == .topLeading)
        #expect(FomoPiPCorner.nearest(to: CGPoint(x: 390, y: 10), in: s) == .topTrailing)
        #expect(FomoPiPCorner.nearest(to: CGPoint(x: 10, y: 790), in: s) == .bottomLeading)
        #expect(FomoPiPCorner.nearest(to: CGPoint(x: 390, y: 790), in: s) == .bottomTrailing)
        #expect(FomoPiPCorner.nearest(to: CGPoint(x: 199, y: 401), in: s) == .bottomLeading)
        #expect(FomoPiPCorner.topTrailing.isTop && !FomoPiPCorner.topTrailing.isLeading)
        #expect(FomoPiPCorner.bottomLeading.isLeading && !FomoPiPCorner.bottomLeading.isTop)
    }

    @Test func sizesAndPrefsRoundTrip() {
        #expect(FomoPiPSize.thumb.picture(in: 402) == CGSize(width: 236, height: 177))
        let half = FomoPiPSize.half.picture(in: 402)
        #expect(half.width == 386 && half.height == 217)
        #expect(FomoPiPSize.thumb.next == .half && FomoPiPSize.half.next == .thumb)
        let d = UserDefaults.standard
        let c0 = d.string(forKey: FomoPiPPrefs.cornerKey), s0 = d.string(forKey: FomoPiPPrefs.sizeKey), o0 = d.object(forKey: FomoPiPPrefs.openKey)
        defer {
            d.set(c0, forKey: FomoPiPPrefs.cornerKey); d.set(s0, forKey: FomoPiPPrefs.sizeKey)
            if let o0 { d.set(o0, forKey: FomoPiPPrefs.openKey) } else { d.removeObject(forKey: FomoPiPPrefs.openKey) }
        }
        d.removeObject(forKey: FomoPiPPrefs.cornerKey); d.removeObject(forKey: FomoPiPPrefs.sizeKey); d.removeObject(forKey: FomoPiPPrefs.openKey)
        #expect(FomoPiPPrefs.corner == .topTrailing && FomoPiPPrefs.size == .thumb && FomoPiPPrefs.open == false)
        FomoPiPPrefs.corner = .bottomLeading; FomoPiPPrefs.size = .half; FomoPiPPrefs.open = true
        #expect(FomoPiPPrefs.corner == .bottomLeading && FomoPiPPrefs.size == .half && FomoPiPPrefs.open)
        d.set("garbage", forKey: FomoPiPPrefs.cornerKey)
        #expect(FomoPiPPrefs.corner == .topTrailing)
    }
}
