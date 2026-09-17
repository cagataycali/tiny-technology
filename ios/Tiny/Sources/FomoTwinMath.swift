/*
 * FomoTwinMath — servo degrees → URDF joint radians, copied EXACTLY from fomo-the-arm/docs/js/twin.js
 * (the single source of truth):
 *
 *     URDF = { zero: 180, sign: {1:1, 2:1, 3:1, 4:1, 5:1, 6:-1}, joint: {1:'shoulder_pan', … 6:'tilt'} }
 *     wrap(d) = ((((d + 180) % 360) + 360) % 360) - 180
 *     qRad(id, deg) = sign[id] * wrap(deg - zero) * pi / 180        then clamp to the joint's [lower, upper]
 *     robot.rotation.x = -pi/2                                       (Z-up URDF data shown in a Y-up scene)
 *
 * The web drives the CHILD LINK of each joint about the joint axis (all [0,0,1] except tilt [0,-1,0]); the USDZ
 * Fomo serves (/models/arm.usdz) bakes the same tree, so RealityKit rotates `findEntity(named: child)` the same way.
 * Pure functions, no UI, unit-tested against fixtures produced by running twin.js's math in node
 * (~/.tiny/q-the-brain-20260909/twin-ios/fix.js).
 */

import Foundation
import simd

enum FomoTwinMath {
    static let zero: Double = 180

    /// One URDF joint the twin can move: Fomo servo id 1…6, URDF name, the link it spins, axis, limits (rad).
    struct Joint: Equatable, Identifiable {
        let id: Int          // servo id, as in /api/state joints{"1"…"6"}
        let name: String     // URDF joint name (== USDZ pivot Xform name)
        let child: String    // link Xform rotated about `axis` (identity at rest)
        let axis: SIMD3<Float>
        let lower: Double
        let upper: Double
        let sign: Double
        /// Fomo's servo name for this joint (names{} in /api/state): base, shoulder_lift, elbow, wrist_flex, pan, tilt.
        let servo: String
    }

    /// Defaults from /models/arm.json (2026-09-10). arm.json is still fetched at runtime and, when it parses, its
    /// axis/limits override these; the sign/zero never come from the server — they are twin.js's.
    static let joints: [Joint] = [
        Joint(id: 1, name: "shoulder_pan",  child: "shoulder_link",  axis: [0, 0, 1],  lower: -1.91986, upper: 1.91986, sign: 1,  servo: "base"),
        Joint(id: 2, name: "shoulder_lift", child: "upper_arm_link", axis: [0, 0, 1],  lower: -1.74533, upper: 1.74533, sign: 1,  servo: "shoulder_lift"),
        Joint(id: 3, name: "elbow_flex",    child: "lower_arm_link", axis: [0, 0, 1],  lower: -1.69,    upper: 1.69,    sign: 1,  servo: "elbow"),
        Joint(id: 4, name: "wrist_flex",    child: "wrist_link",     axis: [0, 0, 1],  lower: -1.65806, upper: 1.65806, sign: 1,  servo: "wrist_flex"),
        Joint(id: 5, name: "wrist_roll",    child: "head_yoke",      axis: [0, 0, 1],  lower: -2.74385, upper: 2.84121, sign: 1,  servo: "pan"),
        Joint(id: 6, name: "tilt",          child: "head_cradle",    axis: [0, -1, 0], lower: -1.5708,  upper: 1.5708,  sign: -1, servo: "tilt"),
    ]

    static func joint(id: Int) -> Joint? { joints.first { $0.id == id } }
    static func joint(named name: String) -> Joint? { joints.first { $0.name == name || $0.servo == name } }

    /// twin.js `wrap`: into [-180, 180).
    static func wrap(_ d: Double) -> Double {
        ((((d + 180).truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)) - 180
    }

    /// twin.js `qRad`: unclamped joint angle in radians for a servo reading in degrees.
    static func qRaw(id: Int, deg: Double) -> Double {
        (joint(id: id)?.sign ?? 1) * wrap(deg - zero) * .pi / 180
    }

    /// The angle the twin actually renders: qRad clamped to the joint's URDF limits (twin.js `_setTargets`).
    static func q(id: Int, deg: Double, limits: (Double, Double)? = nil) -> Double {
        let raw = qRaw(id: id, deg: deg)
        let j = joint(id: id)
        let lo = limits?.0 ?? j?.lower ?? -.pi, hi = limits?.1 ?? j?.upper ?? .pi
        return min(max(raw, lo), hi)
    }

    /// Inverse of qRaw for the ghost/servo UI: joint radians back to a servo reading in [0, 360).
    static func deg(id: Int, q: Double) -> Double {
        let sign = joint(id: id)?.sign ?? 1
        var d = zero + sign * q * 180 / .pi
        d = d.truncatingRemainder(dividingBy: 360); if d < 0 { d += 360 }
        return d
    }

    /// Angles for a whole reading `{servo id: deg}` keyed by URDF joint name, clamped.
    static func pose(_ degrees: [Int: Double]) -> [String: Double] {
        var out: [String: Double] = [:]
        for j in joints { if let d = degrees[j.id] { out[j.name] = q(id: j.id, deg: d) } }
        return out
    }

    /// The rotation RealityKit applies to a joint's child link (axis-angle about the joint axis).
    static func rotation(_ joint: Joint, q: Double) -> simd_quatf {
        simd_quatf(angle: Float(q), axis: simd_normalize(joint.axis))
    }

    /// twin.js `robot.rotation.x = -Math.PI / 2` applied to the root `arm` entity.
    static var rootRotation: simd_quatf { simd_quatf(angle: -.pi / 2, axis: [1, 0, 0]) }

    /// Servo slider window: the guard's calibrated EEPROM window from /api/state `windows{id:[lo,hi]}` when present,
    /// otherwise the URDF limits converted back to servo degrees (so a slider never asks for an impossible angle).
    static func window(id: Int, windows: [Int: ClosedRange<Double>]) -> ClosedRange<Double> {
        if let w = windows[id] { return w }
        guard let j = joint(id: id) else { return 0...360 }
        let a = deg(id: id, q: j.lower), b = deg(id: id, q: j.upper)
        return a <= b ? a...b : b...a
    }

    /// `joint` payload for POST /api/control/move actions: Fomo's servo name (not the URDF name).
    static func moveBody(joint: Joint, to deg: Double, speed: Double? = nil) -> [String: Any] {
        var body: [String: Any] = ["actions": [["joint": joint.servo, "to": (deg * 100).rounded() / 100]]]
        if let speed { body["speed"] = speed }
        return body
    }

    /// Parse /models/arm.json into joints (axis, limits, child) keeping twin.js's sign/zero and Fomo's servo names.
    static func joints(fromArmJSON raw: [String: Any]) -> [Joint]? {
        guard let list = raw["joints"] as? [[String: Any]], list.count == 6 else { return nil }
        var out: [Joint] = []
        for j in joints {
            guard let src = list.first(where: { $0["name"] as? String == j.name }),
                  let axis = src["axis"] as? [Any], axis.count == 3,
                  let child = src["child"] as? String,
                  let lo = EndpointTelemetry.number(src["lower"]), let hi = EndpointTelemetry.number(src["upper"]) else { return nil }
            let a = SIMD3<Float>(Float(EndpointTelemetry.number(axis[0]) ?? 0), Float(EndpointTelemetry.number(axis[1]) ?? 0),
                                 Float(EndpointTelemetry.number(axis[2]) ?? 0))
            out.append(Joint(id: j.id, name: j.name, child: child, axis: a, lower: lo, upper: hi, sign: j.sign, servo: j.servo))
        }
        return out
    }
}
