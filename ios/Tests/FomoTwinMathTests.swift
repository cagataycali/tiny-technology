/**
 * FomoTwinMathTests — the servo-degree → joint-radian mapping must equal fomo-the-arm/docs/js/twin.js bit for bit.
 * Fixtures below were produced by running twin.js's own `wrap`/`qRad` (+ the clamp in `_setTargets`) in node:
 * ~/.tiny/q-the-brain-20260909/twin-ios/fix.js → fixtures.json (2026-09-10). Tuple: (joint, servo deg, raw rad, clamped rad).
 * "folded_live" is the arm's real /api/state at 00:45Z; "edges" are the calibrated window edges; "wrapneg" has wrap cases.
 */
import Testing
import Foundation
import simd
@testable import Tiny

private let fixtures: [(String, [(String, Double, Double, Double)])] = [
        ("folded_live", [
            ("shoulder_pan", 177.01, -0.052185344634630614, -0.052185344634630614),
            ("shoulder_lift", 84.11, -1.6735962197373624, -1.6735962197373624),
            ("elbow_flex", 262.27, 1.4358823756157344, 1.4358823756157344),
            ("wrist_flex", 256.29, 1.3315116863464733, 1.3315116863464733),
            ("wrist_roll", 188.09, 0.1411971364863418, 0.1411971364863418),
            ("tilt", 181.14, -0.019896753472735118, -0.019896753472735118),
        ]),
        ("upright", [
            ("shoulder_pan", 180, 0, 0),
            ("shoulder_lift", 180, 0, 0),
            ("elbow_flex", 180, 0, 0),
            ("wrist_flex", 180, 0, 0),
            ("wrist_roll", 180, 0, 0),
            ("tilt", 180, 0, 0),
        ]),
        ("edges", [
            ("shoulder_pan", 66.36, -1.983392161966356, -1.91986),
            ("shoulder_lift", 290.04, 1.9205603088945598, 1.74533),
            ("elbow_flex", 68.73, -1.9420278586940902, -1.69),
            ("wrist_flex", 359.9, 3.1398473243377985, 1.65806),
            ("wrist_roll", 27.82, -2.6560420556849706, -2.6560420556849706),
            ("tilt", 100.35, 1.3901547492134831, 1.3901547492134831),
        ]),
        ("wrapneg", [
            ("shoulder_pan", -10, 2.9670597283903604, 1.91986),
            ("shoulder_lift", 370, -2.9670597283903604, -1.74533),
            ("elbow_flex", 0.5, -3.132866007329821, -1.69),
            ("wrist_flex", 540, 0, 0),
            ("wrist_roll", 180.0001, 0.000001745329251556216, 0.000001745329251556216),
            ("tilt", 260.35, -1.4023720539774442, -1.4023720539774442),
        ]),
]

@Suite struct FomoTwinMathTests {
    @Test func matchesTwinJSForEveryFixture() {
        var checked = 0
        for (_, rows) in fixtures {
            for (name, deg, raw, q) in rows {
                let j = FomoTwinMath.joint(named: name)!
                #expect(abs(FomoTwinMath.qRaw(id: j.id, deg: deg) - raw) < 1e-12, "\(name) raw @\(deg)")
                #expect(abs(FomoTwinMath.q(id: j.id, deg: deg) - q) < 1e-12, "\(name) clamped @\(deg)")
                checked += 1
            }
        }
        #expect(checked == 24)
    }

    @Test func wrapIsTwinJSWrap() {
        #expect(FomoTwinMath.wrap(0) == 0)
        #expect(FomoTwinMath.wrap(180) == -180)     // JS: ((360 % 360) + 360) % 360 - 180 = -180
        #expect(FomoTwinMath.wrap(-180) == -180)
        #expect(FomoTwinMath.wrap(190) == -170)
        #expect(FomoTwinMath.wrap(-190) == 170)
        #expect(abs(FomoTwinMath.wrap(540.5) + 179.5) < 1e-9)   // 540.5 -> 0.5 past -180
    }

    @Test func tiltIsTheOnlyNegativeSignAndTheOnlyOffAxis() {
        for j in FomoTwinMath.joints {
            #expect(j.sign == (j.id == 6 ? -1 : 1))
            #expect(j.axis == (j.id == 6 ? SIMD3<Float>(0, -1, 0) : SIMD3<Float>(0, 0, 1)))
        }
        #expect(FomoTwinMath.joints.map(\.child) == ["shoulder_link", "upper_arm_link", "lower_arm_link", "wrist_link", "head_yoke", "head_cradle"])
        #expect(FomoTwinMath.joints.map(\.servo) == ["base", "shoulder_lift", "elbow", "wrist_flex", "pan", "tilt"])
    }

    @Test func degIsTheInverseOfQRawInsideOneTurn() {
        for j in FomoTwinMath.joints {
            for d in stride(from: 0.5, to: 360, by: 17.3) {
                let back = FomoTwinMath.deg(id: j.id, q: FomoTwinMath.qRaw(id: j.id, deg: d))
                #expect(abs(back - d) < 1e-9, "\(j.name) \(d) -> \(back)")
            }
        }
    }

    @Test func poseKeysByURDFNameAndClamps() {
        let p = FomoTwinMath.pose([1: 177.01, 2: 84.11, 3: 262.27, 4: 256.29, 5: 188.09, 6: 181.14])
        #expect(p.count == 6)
        #expect(abs(p["shoulder_lift"]! - -1.6735962197373624) < 1e-12)
        #expect(abs(p["tilt"]! - -0.019896753472735118) < 1e-12)
        // 0.5 on elbow wraps to -179.5 deg and clamps to -1.69; 359.9 on wrist_flex is +179.9 deg and clamps to +1.65806
        // (as in node: fixtures.json edges.wrist_flex.q); 0.1 on the base is -179.9 -> lower clamp. Nothing "wraps to -0.1".
        let e = FomoTwinMath.pose([3: 0.5, 4: 359.9, 1: 0.1])
        #expect(e["elbow_flex"] == -1.69)
        #expect(e["wrist_flex"] == 1.65806)
        #expect(e["shoulder_pan"] == -1.91986)
    }

    @Test func rootAndJointRotationsAreAxisAngle() {
        let r = FomoTwinMath.rootRotation
        #expect(abs(r.angle - .pi / 2) < 1e-6 && abs(r.axis.x + 1) < 1e-6)   // -pi/2 about +x == +pi/2 about -x
        let tilt = FomoTwinMath.joint(id: 6)!
        let q = FomoTwinMath.rotation(tilt, q: 0.5)
        #expect(abs(q.angle - 0.5) < 1e-6 && abs(q.axis.y + 1) < 1e-6)
    }

    @Test func windowPrefersGuardThenURDF() {
        let w = FomoTwinMath.window(id: 6, windows: [6: 100.35...260.35])
        #expect(w == 100.35...260.35)
        let u = FomoTwinMath.window(id: 6, windows: [:])        // tilt ±90° about 180, sign -1 flips the ends
        #expect(abs(u.lowerBound - 90) < 1e-3 && abs(u.upperBound - 270) < 1e-3)
        let p = FomoTwinMath.window(id: 1, windows: [:])        // ±1.91986 rad = ±110°
        #expect(abs(p.lowerBound - 70) < 0.01 && abs(p.upperBound - 290) < 0.01)
    }

    @Test func moveBodyUsesFomoServoNames() {
        let b = FomoTwinMath.moveBody(joint: FomoTwinMath.joint(id: 3)!, to: 200.456, speed: 30)
        let a = (b["actions"] as? [[String: Any]])?.first
        #expect(a?["joint"] as? String == "elbow")
        #expect(a?["to"] as? Double == 200.46)
        #expect(b["speed"] as? Double == 30)
    }

    @Test func parsesArmJSON() {
        let raw: [String: Any] = ["joints": FomoTwinMath.joints.map { j -> [String: Any] in
            ["name": j.name, "child": j.child, "axis": [Double(j.axis.x), Double(j.axis.y), Double(j.axis.z)], "lower": j.lower, "upper": j.upper] }]
        #expect(FomoTwinMath.joints(fromArmJSON: raw) == FomoTwinMath.joints)
        #expect(FomoTwinMath.joints(fromArmJSON: ["joints": []]) == nil)
    }
}
